import express from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { listWorkspace, filePath, safeName, WORKSPACE_DIR, CLIENT_DIST, OFFICECLI, AGENT_DIR, getWorkspace, setWorkspace, resolvePath } from "./workspace.mjs";
import { runOfficecli, view, get, set, batch, renderHtml, startWatch, stopWatch, stopAllWatches } from "./office.mjs";
import { agentManager } from "./agent.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: "60mb" }));

// ---------- helpers ----------
const COL_RE = /([A-Z]+)(\d+)$/;
function colToIndex(col) {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function indexToCol(i) {
  let s = "";
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - r) / 26);
  }
  return s;
}

function sheetToGrid(children) {
  const rows = {};
  for (const row of children || []) {
    if (row.type !== "row") continue;
    const m = row.path.match(/row\[(\d+)\]/);
    const ri = m ? parseInt(m[1], 10) : null;
    if (!ri) continue;
    rows[ri] = { cells: {} };
    for (const cell of row.children || []) {
      if (cell.type !== "cell") continue;
      const ref = cell.path.match(COL_RE);
      if (!ref) continue;
      const ci = colToIndex(ref[1]);
      rows[ri].cells[ci] = { text: cell.text ?? "" };
    }
  }
  return rows;
}

async function readWorkbook(file) {
  // 枚举 sheets：depth 1 不够则递增重试
  let info = await get(file, "/", 1);
  const sheetNodes = [];
  const collect = (results) => {
    for (const r of results || []) {
      if (r.type === "sheet") sheetNodes.push(r);
      if (r.children) {
        for (const c of r.children) {
          if (c.type === "sheet") sheetNodes.push(c);
        }
      }
    }
  };
  collect(info.json?.data?.results || []);
  if (sheetNodes.length === 0) {
    info = await get(file, "/", 2);
    collect(info.json?.data?.results || []);
  }
  if (sheetNodes.length === 0) {
    throw new Error("无法枚举工作表（文件可能损坏或格式不支持）");
  }
  const sheets = [];
  const grids = {};
  for (const s of sheetNodes) {
    const name = s.preview || s.path.split("/").pop();
    if (!sheets.some((x) => x.name === name)) {
      sheets.push({ name, path: s.path });
    }
  }
  for (const s of sheets) {
    const r = await get(file, s.name, 3);
    const res = r.json?.data?.results?.[0];
    grids[s.name] = sheetToGrid(res?.children || []);
  }
  return { sheets: sheets.map((s) => s.name), grids };
}

// ---------- REST ----------
app.get("/api/status", (_req, res) => {
  res.json({ ok: true, officecli: path.basename(OFFICECLI) });
});

app.get("/api/files", (req, res) => {
  const dir = req.query.dir || "";
  // 只允许相对路径，防止越界
  if (dir && (dir.includes("..") || dir.startsWith("/") || /^[a-zA-Z]:/.test(dir))) {
    return res.status(400).json({ error: "invalid dir" });
  }
  const target = dir ? path.join(getWorkspace(), dir) : getWorkspace();
  res.json({ files: listWorkspace(target), dir });
});

app.post("/api/files/upload", async (req, res) => {
  const { name, base64 } = req.body || {};
  const safe = safeName(name);
  if (!safe || !base64) return res.status(400).json({ error: "invalid upload" });
  const buf = Buffer.from(base64, "base64");
  if (!/\.(docx|xlsx|pptx)$/i.test(safe)) return res.status(400).json({ error: "only docx/xlsx/pptx allowed" });
  fs.writeFileSync(path.join(WORKSPACE_DIR, safe), buf);
  res.json({ ok: true, file: safe });
});

app.post("/api/files/delete", async (req, res) => {
  const p = resolvePath(req.body?.name);
  if (!p) return res.status(404).json({ error: "not found" });
  fs.unlinkSync(p);
  res.json({ ok: true });
});

// open document
app.get("/api/doc/:file", async (req, res) => {
  const p = resolvePath(req.params.file);
  if (!p) return res.status(404).json({ error: "not found" });
  const ext = path.extname(p).slice(1).toLowerCase();
  // 记录当前工作文件（前端传 client 参数）
  const client = req.query.client;
  if (client) {
    try { agentManager.setCurrentFile(client, req.params.file); } catch {}
  }
  try {
    if (ext === "xlsx") {
      const wb = await readWorkbook(p);
      res.json({ kind: "xlsx", name: req.params.file, ...wb });
    } else if (ext === "md" || ext === "markdown" || ext === "txt") {
      const content = fs.readFileSync(p, "utf8");
      res.json({ kind: "text", name: req.params.file, content, ext });
    } else {
      res.json({ kind: "html", name: req.params.file, url: `/api/doc/${encodeURIComponent(req.params.file)}/html` });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// rendered html for docx/pptx (iframe target)
app.get("/api/doc/:file/html", async (req, res) => {
  const p = resolvePath(req.params.file);
  if (!p) return res.status(404).send("not found");
  try {
    const html = await renderHtml(p);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.send(html);
  } catch (e) {
    res.status(500).send("render failed: " + e.message);
  }
});

// watch 模式：启动/获取某文件的实时预览地址（docx/pptx）
app.get("/api/doc/:file/watch", async (req, res) => {
  const p = resolvePath(req.params.file);
  if (!p) return res.status(404).json({ error: "not found" });
  try {
    const entry = await startWatch(p);
    res.json({ ok: true, url: `http://localhost:${entry.port}`, port: entry.port });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 停止某文件的 watch
app.post("/api/doc/:file/watch/stop", (req, res) => {
  const p = resolvePath(req.params.file);
  if (p) stopWatch(p);
  res.json({ ok: true });
});

// apply xlsx cell edits (batch)
app.post("/api/doc/:file/cells", async (req, res) => {
  const p = resolvePath(req.params.file);
  if (!p) return res.status(404).json({ error: "not found" });
  const { sheet, cells } = req.body || {};
  if (!sheet || !Array.isArray(cells) || !cells.length) return res.status(400).json({ error: "bad payload" });
  const commands = cells.map((c) => {
    const ref = String(c.ref || "").match(COL_RE);
    if (!ref) return null;
    return { command: "set", path: `/${sheet}/${ref[0]}`, props: { value: String(c.value ?? "") } };
  }).filter(Boolean);
  try {
    const r = await batch(p, commands);
    res.json({ ok: !r.json?.error, result: r.json || r.text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// generic officecli passthrough (toolbar actions, future use)
app.post("/api/office", async (req, res) => {
  const { args } = req.body || {};
  if (!Array.isArray(args)) return res.status(400).json({ error: "args required" });
  const r = await runOfficecli(args.map(String));
  res.json({ code: r.code, stdout: r.stdout, stderr: r.stderr, json: r.json });
});

// ---------- agent ----------
app.get("/api/models", async (_req, res) => {
  try {
    const models = await agentManager.listModels();
    // enrich vision flags from models-store.json (input includes "image")
    const store = loadModelsStore();
    for (const m of models) {
      const provCfg = store[m.provider];
      const cfg = provCfg?.models?.find((x) => x.id === m.id.split("/")[1]);
      if (cfg) m.vision = (cfg.input || []).includes("image") || !!m.vision;
    }
    res.json({ models, default: loadSettingsDefault() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/agent/model", async (req, res) => {
  const { client, model } = req.body || {};
  if (!client || !model) return res.status(400).json({ error: "client and model required" });
  try {
    res.json(await agentManager.setModel(client, model));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- sessions ----------
// 会话 JSONL 文件存放在 AGENT_DIR/sessions/ 目录下，遵循 pi SDK SessionManager 格式
const SESSIONS_DIR = path.join(AGENT_DIR, "sessions");
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// 递归扫描 sessions 目录（含 cwd 分组子目录）下所有 .jsonl 文件
function listSessionFiles() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  const out = [];
  function walk(dir, depth) {
    if (depth > 4) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        const st = fs.statSync(full);
        out.push({ fileName: e.name, fullPath: full, mtime: st.mtimeMs });
      }
    }
  }
  walk(SESSIONS_DIR, 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}

// 根据 id 查找对应的 .jsonl 文件（先按文件名匹配，再按 header.sessionId 匹配）
function findSessionFile(id) {
  const files = listSessionFiles();
  const byName = files.find((f) => f.fileName === id + ".jsonl" || f.fileName.startsWith(id));
  if (byName) return byName;
  for (const f of files) {
    try {
      const text = fs.readFileSync(f.fullPath, "utf8");
      const firstLine = text.split(/\r?\n/)[0];
      if (!firstLine) continue;
      const h = JSON.parse(firstLine);
      if (h && h.sessionId === id) return f;
    } catch {}
  }
  return null;
}

// 解析 JSONL 文件所有行（每行一个 JSON 对象，跳过空行和解析失败的行）
function parseJsonl(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {}
  }
  return out;
}

// GET /api/workspaces - 列出已知工作区目录
app.get("/api/workspaces", (_req, res) => {
  const workspaces = [{ name: "默认工作区", path: WORKSPACE_DIR }];
  // 从会话历史里收集其他 cwd（存在 office 文件的工作区）
  const seen = new Set([WORKSPACE_DIR]);
  for (const f of listSessionFiles()) {
    try {
      const first = fs.readFileSync(f.fullPath, "utf8").split(/\r?\n/)[0];
      const h = JSON.parse(first);
      if (h.cwd && !seen.has(h.cwd)) {
        seen.add(h.cwd);
        // 只收录看起来是办公工作区的目录（有 docx/xlsx/pptx）
        let hasOffice = false;
        try {
          hasOffice = fs.readdirSync(h.cwd).some((f2) => /\.(docx|xlsx|pptx)$/i.test(f2));
        } catch {}
        if (hasOffice) workspaces.push({ name: h.cwd.split(/[\\\/]/).pop() || h.cwd, path: h.cwd });
      }
    } catch {}
  }
  res.json({ workspaces });
});

// POST /api/workspace/switch - 切换当前工作区
app.post("/api/workspace/switch", (req, res) => {
  const { path: dir } = req.body || {};
  if (!dir) return res.status(400).json({ error: "path required" });
  if (!setWorkspace(dir)) return res.status(400).json({ error: "无效目录" });
  res.json({ ok: true, workspace: getWorkspace(), files: listWorkspace() });
});

// POST /api/workspace/validate - 验证自定义路径是否可作为工作区
app.post("/api/workspace/validate", (req, res) => {
  const { path: dir } = req.body || {};
  if (!dir) return res.status(400).json({ error: "path required" });
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return res.json({ ok: false, error: "不是文件夹" });
    // 可写检查：尝试创建临时文件
    const probe = path.join(dir, ".oaw-probe-" + Date.now());
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /api/sessions - 列出所有会话（解析每个 JSONL 的 header 第一行）
app.get("/api/sessions", (_req, res) => {
  try {
    const files = listSessionFiles();
    const sessions = [];
    for (const f of files) {
      try {
        const text = fs.readFileSync(f.fullPath, "utf8");
        const firstLine = text.split(/\r?\n/)[0];
        if (!firstLine) continue;
        const h = JSON.parse(firstLine);
        // 只显示 office agent 的会话（cwd 属于本项目或当前工作区），过滤 pi TUI 等其他会话
        const cwd = h.cwd || "";
        const isOaw = cwd.includes("office-agent-web") || cwd === getWorkspace();
        if (!isOaw) continue;
        // 提取第一条用户消息作为标题
        let title = "";
        for (const line of text.split(/\r?\n/).slice(1)) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type === "message" && entry.message?.role === "user") {
              const c = entry.message.content;
              if (typeof c === "string") title = c.trim();
              else if (Array.isArray(c)) {
                title = c.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
              }
              if (title) break;
            }
          } catch {}
        }
        if (title.length > 50) title = title.slice(0, 50) + "…";
        sessions.push({
          id: h.sessionId || path.basename(f.fileName, ".jsonl"),
          cwd: h.cwd || "",
          created: h.created || "",
          modified: f.mtime,
          label: h.label || "",
          parentSessionId: h.parentSessionId || null,
          fileName: f.fileName,
          title,
        });
      } catch {}
    }
    res.json({ sessions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sessions - 创建新会话（写入空 header 的 JSONL 文件）
app.post("/api/sessions", (req, res) => {
  try {
    const { cwd } = req.body || {};
    const id = crypto.randomUUID();
    const created = new Date().toISOString();
    const header = {
      type: "header",
      sessionId: id,
      cwd: cwd || process.cwd(),
      created,
      label: "",
    };
    const fileName = id + ".jsonl";
    fs.writeFileSync(path.join(SESSIONS_DIR, fileName), JSON.stringify(header) + "\n");
    res.json({ id, fileName, cwd: header.cwd, created });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sessions/:id - 获取会话详情（含 entries、fork 树、leafId）
app.get("/api/sessions/:id", (req, res) => {
  const found = findSessionFile(req.params.id);
  if (!found) return res.status(404).json({ error: "not found" });
  try {
    const text = fs.readFileSync(found.fullPath, "utf8");
    const all = parseJsonl(text);
    const header = all.find((e) => e && e.type === "header") || all[0] || {};
    const entries = all.filter((e) => e !== header);

    // 按 parentId 组织 fork 层级（key 为 parentId，value 为子节点 id 数组）
    const tree = {};
    for (const e of entries) {
      const pid = (e && e.parentId) || null;
      if (!tree[pid]) tree[pid] = [];
      tree[pid].push(e.id);
    }

    // 找 leafId：没有任何子节点的 entry（最深的分支末端）
    let leafId = null;
    for (const e of entries) {
      const kids = tree[e.id];
      if (!kids || kids.length === 0) {
        leafId = e.id;
        break;
      }
    }

    res.json({
      entries,
      tree,
      leafId,
      info: {
        id: header.sessionId || path.basename(found.fileName, ".jsonl"),
        cwd: header.cwd || "",
        created: header.created || "",
        label: header.label || "",
        parentSessionId: header.parentSessionId || null,
        fileName: found.fileName,
        modified: found.mtime,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/sessions/:id - 删除会话文件
app.delete("/api/sessions/:id", (req, res) => {
  const found = findSessionFile(req.params.id);
  if (!found) return res.status(404).json({ error: "not found" });
  try {
    fs.unlinkSync(found.fullPath);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sessions/:id/rename - 重命名会话（修改 header.label）
app.post("/api/sessions/:id/rename", (req, res) => {
  const found = findSessionFile(req.params.id);
  if (!found) return res.status(404).json({ error: "not found" });
  try {
    const { label } = req.body || {};
    const text = fs.readFileSync(found.fullPath, "utf8");
    const lines = text.split(/\r?\n/);
    if (!lines[0]) return res.status(400).json({ error: "empty file" });
    const header = JSON.parse(lines[0]);
    header.label = String(label || "");
    lines[0] = JSON.stringify(header);
    fs.writeFileSync(found.fullPath, lines.join("\n"));
    res.json({ ok: true, label: header.label });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 中止当前 agent 运行
app.post("/api/agent/abort", async (req, res) => {
  const { client } = req.body || {};
  if (!client) return res.status(400).json({ error: "client required" });
  try {
    res.json(await agentManager.abort(client));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/agent/prompt", async (req, res) => {
  const { client, text, images } = req.body || {};
  if (!client || !text) return res.status(400).json({ error: "client and text required" });
  const before = snapshotWorkspace();
  try {
    await agentManager.prompt(client, text, images);
    // officecli keeps files in a resident process — disk writes flush asynchronously.
    // Poll until the workspace snapshot stabilizes, then diff.
    const changed = await waitForFlush(before);
    if (changed.length) {
      const entry = agentManager.sessions.get(client);
      if (entry) emitChannel(entry, "file_changed", { files: changed });
    }
    res.json({ ok: true, changed });
  } catch (e) {
    const entry = agentManager.sessions.get(client);
    if (entry) emitChannel(entry, "agent_error", { message: e.message });
    res.status(500).json({ error: e.message });
  }
});

// SSE stream per client
app.get("/api/agent/stream", async (req, res) => {
  const client = String(req.query.client || "");
  if (!client) return res.status(400).end();
  const entry = await agentManager.getOrCreate(client);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (ev) => {
    res.write(`id: ${ev.id}\ndata: ${JSON.stringify({ type: ev.type, data: ev.data })}\n\n`);
  };
  const lastId = parseInt(req.headers["last-event-id"] || "0", 10) || 0;
  for (const ev of entry.channel.history) if (ev.id > lastId) send(ev);
  res.write(`event: open\ndata: ${JSON.stringify({ historyId: entry.channel.seq })}\n\n`);

  const onEvent = (ev) => send(ev);
  entry.channel.emitter.on("event", onEvent);
  req.on("close", () => entry.channel.emitter.off("event", onEvent));
});

function loadModelsStore() {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE || "C:\\Users\\admin", ".pi", "agent", "models-store.json"), "utf8"));
  } catch {
    return {};
  }
}
function loadSettingsDefault() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE || "C:\\Users\\admin", ".pi", "agent", "settings.json"), "utf8"));
    return (s.defaultProvider ? s.defaultProvider + "/" : "") + (s.defaultModel || "");
  } catch {
    return "";
  }
}

// ---------- static ----------
const dist = CLIENT_DIST;
if (fs.existsSync(path.join(dist, "index.html"))) {
  app.use(express.static(dist));
  app.get("/*splat", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

// ---------- helpers for file change detection ----------
function snapshotWorkspace() {
  return listWorkspace().map((f) => `${f.name}|${f.mtime}|${f.size}`);
}
function diffWorkspace(before, after) {
  const b = new Set(before);
  return after.filter((x) => !b.has(x)).map((x) => x.split("|")[0]);
}
async function waitForFlush(before) {
  let last = before;
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const snap = snapshotWorkspace();
    if (JSON.stringify(snap) === JSON.stringify(last)) break;
    last = snap;
  }
  return diffWorkspace(before, last);
}
function emitChannel(entry, type, data) {
  const id = ++entry.channel.seq;
  const ev = { id, type, data };
  entry.channel.history.push(ev);
  if (entry.channel.history.length > 2000) entry.channel.history.shift();
  entry.channel.emitter.emit("event", ev);
}

app.listen(PORT, () => {
  console.log(`office-agent-web running at http://localhost:${PORT}`);
  console.log(`workspace: ${WORKSPACE_DIR}`);
});

process.on("SIGINT", async () => {
  await agentManager.disposeAll();
  stopAllWatches();
  process.exit(0);
});
