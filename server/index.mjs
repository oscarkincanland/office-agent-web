import express from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { listWorkspace, filePath, safeName, WORKSPACE_DIR, CLIENT_DIST, OFFICECLI, AGENT_DIR, getWorkspace, setWorkspace, resolvePath, PROJECT_DIR } from "./workspace.mjs";
import { runOfficecli, view, get, set, batch, renderHtml, startWatch, stopWatch, stopAllWatches } from "./office.mjs";
import { agentManager } from "./agent.mjs";
import * as kb from "./kb.mjs";
import * as tpl from "./tpl.mjs";

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
  // 尝试 officecli（Windows），失败则用 xlsx 包原生读取（macOS/Linux）
  try {
    const { get } = await import("./office.mjs");
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
      throw new Error("无法枚举工作表");
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
  } catch (officeErr) {
    // officecli 不可用，使用 xlsx 包原生读取
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.readFile(file);
      const sheets = wb.SheetNames;
      const grids = {};
      for (const name of sheets) {
        const ws = wb.Sheets[name];
        const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        const rows = {};
        data.forEach((row, ri) => {
          const cells = {};
          row.forEach((val, ci) => {
            const col = String.fromCharCode(65 + ci);
            cells[`${col}${ri + 1}`] = { text: String(val) };
          });
          rows[ri + 1] = { cells };
        });
        grids[name] = { rows };
      }
      return { sheets, grids };
    } catch (xlsxErr) {
      throw new Error(`officecli: ${officeErr.message} | xlsx: ${xlsxErr.message}`);
    }
  }
}

// ---------- REST ----------
app.get("/api/status", (_req, res) => {
  res.json({ ok: true, officecli: path.basename(OFFICECLI) });
});

// ---------- 知识库（本地索引 + IMA 云端） ----------
app.get("/api/kb/status", async (_req, res) => {
  await kb.scan();
  res.json(kb.status());
});

app.post("/api/kb/roots", async (req, res) => {
  const r = kb.addRoot(req.body?.path);
  if (!r.ok) return res.status(400).json(r);
  await kb.scan(true);
  res.json({ ok: true, roots: r.roots, fileCount: kb.status().fileCount });
});

app.delete("/api/kb/roots", async (req, res) => {
  const r = kb.removeRoot(req.body?.path);
  await kb.scan(true);
  res.json(r);
});

app.get("/api/kb/tree", async (req, res) => {
  await kb.scan();
  const rootIdx = parseInt(req.query.root, 10);
  res.json({ tree: kb.getTree(isNaN(rootIdx) ? 0 : rootIdx) });
});

app.get("/api/kb/search", async (req, res) => {
  await kb.scan();
  const rootIdx = parseInt(req.query.root, 10);
  res.json({
    results: kb.search(req.query.q || "", isNaN(rootIdx) ? null : rootIdx, parseInt(req.query.limit, 10) || 30),
  });
});

app.get("/api/kb/graph", async (req, res) => {
  await kb.scan();
  const rootIdx = parseInt(req.query.root, 10);
  const include = (req.query.include || "links").split(",").filter(Boolean);
  res.json(kb.getGraph({ rootIdx: isNaN(rootIdx) ? null : rootIdx, include, maxNodes: parseInt(req.query.max, 10) || 800 }));
});

app.get("/api/kb/doc", async (req, res) => {
  await kb.scan();
  const rootIdx = parseInt(req.query.root, 10);
  const doc = kb.getDoc(req.query.path || "", isNaN(rootIdx) ? null : rootIdx);
  if (!doc) return res.status(404).json({ error: "not found" });
  res.json(doc);
});

// IMA 云端知识库（凭证未配置时返回 configured:false）
app.get("/api/kb/ima/status", async (_req, res) => res.json(await kb.imaStatus()));
app.get("/api/kb/ima/bases", async (_req, res) => res.json(await kb.imaListBases()));
app.get("/api/kb/ima/search", async (req, res) => res.json(await kb.imaSearch(req.query.q || "", req.query.kb || "")));
app.get("/api/kb/ima/doc", async (req, res) => res.json(await kb.imaDoc(req.query.media_id || "")));

// ---------- 模版库 ----------
app.get("/api/templates", (req, res) => {
  const cat = req.query.category;
  const cats = tpl.getCategories();
  const items = tpl.getTemplatesByCategory(cat);
  res.json({ categories: cats, items, total: items.length });
});

app.get("/api/templates/content", (req, res) => {
  const relPath = req.query.path || "";
  if (!relPath) return res.status(400).json({ error: "path required" });
  const c = tpl.getTemplateContent(relPath);
  if (!c) return res.status(404).json({ error: "not found" });
  res.json(c);
});

app.post("/api/templates/refresh", (_req, res) => {
  tpl.refresh();
  res.json({ ok: true, total: tpl.getTemplates().length });
});

// 模板文件下载路由
const TPL_ROOT = path.resolve(__dirname, "..", ".."); // F:\Claude code本地文件
app.get(/^\/api\/templates\/files\/(.+)$/, (req, res) => {
  const relPath = req.params[0]; // 正则捕获组
  if (!relPath || relPath.includes("..") || relPath.startsWith("/") || /^[A-Z]:/i.test(relPath)) {
    return res.status(400).json({ error: "invalid path" });
  }
  const abs = path.join(TPL_ROOT, relPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return res.status(404).json({ error: "file not found" });
  }
  res.sendFile(abs);
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
  if (!/\.(docx|xlsx|pptx|md|markdown|txt|html|htm)$/i.test(safe)) return res.status(400).json({ error: "不支持的格式" });
  fs.writeFileSync(path.join(WORKSPACE_DIR, safe), buf);
  res.json({ ok: true, file: safe });
});

app.post("/api/files/delete", async (req, res) => {
  const p = resolvePath(req.body?.name);
  if (!p) return res.status(404).json({ error: "not found" });
  fs.unlinkSync(p);
  res.json({ ok: true });
});

// 原始文件流（供前端 docx-preview/pptxviewjs 渲染，正则路由避免吞参数）
app.get(/^\/api\/doc\/([^\/]+)\/raw$/, (req, res) => {
  const fileName = decodeURIComponent(req.params[0]);
  const p = resolvePath(fileName);
  if (!p) return res.status(404).json({ error: "not found" });
  const ext = path.extname(p).slice(1).toLowerCase();
  const mimeMap = { docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", pdf: "application/pdf" };
  try {
    res.setHeader("Content-Type", mimeMap[ext] || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(fileName)}"`);
    res.sendFile(p);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// open document
app.get(/^\/api\/doc\/([^\/]+)$/, async (req, res) => {
  const fileName = decodeURIComponent(req.params[0]);
  const p = resolvePath(fileName);
  if (!p) return res.status(404).json({ error: "not found" });
  const ext = path.extname(p).slice(1).toLowerCase();
  // 记录当前工作文件（前端传 client 参数）
  const client = req.query.client;
  if (client) {
    try { agentManager.setCurrentFile(client, fileName); } catch {}
  }
  try {
    if (ext === "xlsx") {
      const wb = await readWorkbook(p);
      res.json({ kind: "xlsx", name: fileName, ...wb });
    } else if (ext === "md" || ext === "markdown" || ext === "txt") {
      const content = fs.readFileSync(p, "utf8");
      res.json({ kind: "text", name: fileName, content, ext });
    } else if (ext === "html" || ext === "htm") {
      const content = fs.readFileSync(p, "utf8");
      res.json({ kind: "htmlfile", name: fileName, content });
    } else {
      res.json({ kind: "html", name: fileName, ext, url: `/api/doc/${encodeURIComponent(fileName)}/html` });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// rendered html for docx/pptx (iframe target)
app.get(/^\/api\/doc\/([^\/]+)\/html$/, async (req, res) => {
  const fileName = decodeURIComponent(req.params[0]);
  const p = resolvePath(fileName);
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
// 获取批注列表：docx/pptx 用 officecli；md/txt 从 agent 会话提取修订记录
app.get(/^\/api\/doc\/([^\/]+)\/comments$/, async (req, res) => {
  const fileName = decodeURIComponent(req.params[0]);
  const p = resolvePath(fileName);
  if (!p) return res.status(404).json({ error: "not found" });
  const ext = path.extname(p).slice(1).toLowerCase();
  try {
    if (ext === "md" || ext === "markdown" || ext === "txt") {
      // 从 agent 会话中提取与该文件相关的修改指令（模拟批注/修订记录）
      const comments = [];
      for (const f of listSessionFiles()) {
        try {
          const text = fs.readFileSync(f.fullPath, "utf8");
          if (!text.includes(fileName)) continue;
          for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (entry.type === "message" && entry.message?.role === "user") {
                const c = entry.message.content;
                let t = "";
                if (typeof c === "string") t = c;
                else if (Array.isArray(c)) t = c.filter((b) => b.type === "text").map((b) => b.text).join(" ");
                if (t.includes(fileName)) {
                  comments.push({
                    path: fileName,
                    author: "用户",
                    text: t.slice(0, 200),
                    date: entry.timestamp || entry.time || new Date(f.mtime).toISOString(),
                  });
                }
              }
            } catch {}
          }
        } catch {}
      }
      // 去重 + 最新 20 条
      const seen = new Set();
      const unique = comments.filter((c) => { if (seen.has(c.text)) return false; seen.add(c.text); return true; });
      return res.json({ comments: unique.slice(0, 20) });
    }
    const r = await runOfficecli(["query", p, "comment", "--json"]);
    const results = r.json?.data?.results || [];
    const comments = results.map((c) => ({
      path: c.path,
      author: c.format?.author || c.author || "",
      text: c.text || c.preview || "",
      date: c.format?.date || c.date || "",
    }));
    res.json({ comments });
  } catch (e) {
    res.json({ comments: [] });
  }
});

app.get(/^\/api\/doc\/([^\/]+)\/watch$/, async (req, res) => {
  const fileName = decodeURIComponent(req.params[0]);
  const p = resolvePath(fileName);
  if (!p) return res.status(404).json({ error: "not found" });
  try {
    const entry = await startWatch(p);
    res.json({ ok: true, url: `http://localhost:${entry.port}`, port: entry.port });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 停止某文件的 watch
app.post(/^\/api\/doc\/([^\/]+)\/watch\/stop$/, (req, res) => {
  const fileName = decodeURIComponent(req.params[0]);
  const p = resolvePath(fileName);
  if (p) stopWatch(p);
  res.json({ ok: true });
});

// apply xlsx cell edits (batch)
app.post(/^\/api\/doc\/([^\/]+)\/cells$/, async (req, res) => {
  const fileName = decodeURIComponent(req.params[0]);
  const p = resolvePath(fileName);
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

// docx 富文本编辑代理（供前端编辑工具栏调用）
// body: { file, commands: [{command:"set", path:"/body/p[2]/r[1]", props:{bold:true}}, ...] }
// file 相对工作区解析；使用 batch 一次提交多命令
app.post("/api/doc/edit", async (req, res) => {
  const { file, commands, open, save } = req.body || {};
  if (!file || !Array.isArray(commands) || !commands.length) {
    return res.status(400).json({ error: "file and commands required" });
  }
  const p = resolvePath(file);
  if (!p) return res.status(404).json({ error: "file not found" });
  try {
    // 标准化 props：boolean 值转字符串（officecli 需要 "true"/"false"）
    const normalized = commands.map((c) => {
      const item = { ...c };
      if (item.props) {
        const props = {};
        for (const [k, v] of Object.entries(item.props)) {
          props[k] = typeof v === "boolean" ? String(v) : String(v);
        }
        item.props = props;
      }
      return item;
    });
    const r = await batch(p, normalized);
    if (r.json?.error || (r.code !== 0 && r.json?.data?.results?.some((x) => x.error))) {
      return res.status(500).json({ error: r.stderr || r.text || "编辑失败" });
    }
    res.json({ ok: true, result: r.json || r.text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 保存前端编辑后的 docx（base64 内容直接写回文件）
app.post(/^\/api\/doc\/([^\/]+)\/raw-save$/, (req, res) => {
  const fileName = decodeURIComponent(req.params[0]);
  const p = resolvePath(fileName);
  if (!p) return res.status(404).json({ error: "not found" });
  const { base64 } = req.body || {};
  if (!base64) return res.status(400).json({ error: "base64 required" });
  try {
    const buf = Buffer.from(base64, "base64");
    // 校验是合法的 zip/docx（PK 头）
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      return res.status(400).json({ error: "不是有效的 docx 文件" });
    }
    fs.writeFileSync(p, buf);
    res.json({ ok: true, size: buf.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 获取 docx 标题大纲（供目录导航栏；前端优先用渲染后 DOM 提取，此接口为兜底）
app.get(/^\/api\/doc\/([^\/]+)\/outline$/, async (req, res) => {
  const fileName = decodeURIComponent(req.params[0]);
  const p = resolvePath(fileName);
  if (!p) return res.status(404).json({ error: "not found" });
  try {
    // 遍历文档段落，按样式名启发式识别标题（Heading* / 常见标题样式 / 短文本+大字号）
    const r = await runOfficecli(["get", p, "/", "--depth", "3", "--json"]);
    const results = r.json?.data?.results || [];
    const outline = [];
    const walk = (nodes) => {
      for (const n of nodes || []) {
        if (n.type === "p" || n.type === "paragraph") {
          const style = String(n.style || n.format?.style || "");
          const text = (n.text || n.preview || "").trim();
          if (text && (style.startsWith("Heading") || /标题|Heading/.test(style))) {
            const m = style.match(/(\d)/);
            outline.push({ level: m ? Math.min(6, parseInt(m[1], 10)) : 1, text: text.slice(0, 120), path: n.path || "" });
          }
        }
        if (n.children) walk(n.children);
      }
    };
    walk(results);
    res.json({ outline });
  } catch (e) {
    res.json({ outline: [] });
  }
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

// ---------- skills ----------
// 交通规划工程师工作台：按技能用途分类
const SKILL_CATEGORIES = [
  { id: "traffic", label: "交通规划", keywords: ["交通", "规划", "公交", "OD", "traffic", "transport", "出行", "客流", "公路", "物流", "枢纽"] },
  { id: "doc", label: "文档报告", keywords: ["报告", "论文", "公文", "规划报告", "work report", "撰写", "公文", "汇报", "研究报告", "论文"] },
  { id: "chart", label: "图表可视化", keywords: ["图表", "chart", "图", "可视化", "地图", "infographic", "ECharts", "diagram", "dashboard"] },
  { id: "image", label: "图像生成", keywords: ["图像", "image", "配图", "封面", "图片", "生成图片", "illustrat", "poster", "封面图"] },
  { id: "media", label: "媒体内容", keywords: ["视频", "音频", "配音", "TTS", "字幕", "脚本", "slide", "PPT", "抖音", "小红书"] },
  { id: "office", label: "Office办公", keywords: ["office", "officecli", "Excel", "Word", "PPTX", "docx", "xlsx", "表格"] },
  { id: "dev", label: "开发工具", keywords: ["代码", "开发", "debug", "test", "git", "部署", "browser", "agent", "skill", "workflow", "playwright"] },
  { id: "research", label: "搜索研究", keywords: ["搜索", "搜索", "文献", "research", "调研", "知识库", "论文"] },
  { id: "other", label: "其他", keywords: [] },
];

function classifySkill(name, desc = "") {
  const text = `${name} ${desc}`.toLowerCase();
  for (const cat of SKILL_CATEGORIES) {
    if (cat.keywords.some((k) => text.includes(k.toLowerCase()))) return cat.id;
  }
  return "other";
}

// 扫描用户所有 skills 目录（含 .pi/agent/skills、.agents/skills、项目 .agents/skills）
function scanSkills() {
  const roots = [
    path.join(AGENT_DIR, "skills"),
    path.join(process.env.USERPROFILE || "C:\\Users\\admin", ".agents", "skills"),
    path.join(process.env.USERPROFILE || "C:\\Users\\admin", ".claude", "skills"),
    path.join(PROJECT_DIR, ".agents", "skills"),
    path.join(PROJECT_DIR, ".pi", "skills"),
    path.join(PROJECT_DIR, ".claude", "skills"),
    // 用户实际工作根目录的 .claude skills（F:\Claude code本地文件\.claude\skills）
    "F:\\Claude code本地文件\\.claude\\skills",
  ];
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const skillDir = path.join(root, e.name);
      const skillFile = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      // 解析 frontmatter 里的 description
      let desc = "";
      try {
        const content = fs.readFileSync(skillFile, "utf8");
        const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
        if (m) {
          const dm = m[1].match(/description:\s*["']?([^"'\n]+)/);
          if (dm) desc = dm[1].trim();
        }
      } catch {}
      out.push({
        name: e.name,
        description: desc,
        path: skillDir,
        source: root.includes(".agents") ? "agents" : root.includes(".pi") ? "pi" : "pi-agent",
        category: classifySkill(e.name, desc),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// GET /api/skills - 列出所有 skills
app.get("/api/skills", (_req, res) => {
  res.json({ skills: scanSkills() });
});

// POST /api/skills/export - 导出 skill（返回 base64 内容）
app.post("/api/skills/export", (req, res) => {
  const { name } = req.body || {};
  const skills = scanSkills();
  const skill = skills.find((s) => s.name === name);
  if (!skill) return res.status(404).json({ error: "skill not found" });
  try {
    const skillFile = path.join(skill.path, "SKILL.md");
    const content = fs.readFileSync(skillFile, "utf8");
    // 附带同目录的其他辅助文件（脚本等）
    const extra = {};
    for (const e of fs.readdirSync(skill.path, { withFileTypes: true })) {
      if (e.isFile() && e.name !== "SKILL.md") {
        extra[e.name] = fs.readFileSync(path.join(skill.path, e.name), "base64");
      }
    }
    res.json({
      ok: true,
      skill: {
        name: skill.name,
        description: skill.description,
        content: Buffer.from(content).toString("base64"),
        extra,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/skills/import - 导入 skill 到用户 skills 目录
app.post("/api/skills/import", (req, res) => {
  const { name, description, content, extra } = req.body || {};
  if (!name || !content) return res.status(400).json({ error: "name and content required" });
  // 安全校验：只允许合法 skill 名
  if (!/^[a-z0-9-]+$/.test(name)) return res.status(400).json({ error: "invalid skill name (小写字母/数字/连字符)" });
  const targetDir = path.join(AGENT_DIR, "skills", name);
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    // 写入 SKILL.md（带 frontmatter）
    const body = Buffer.from(content, "base64").toString("utf8");
    let skillContent = body;
    if (!body.startsWith("---")) {
      skillContent = `---\nname: ${name}\ndescription: ${description || name}\n---\n\n` + body;
    }
    fs.writeFileSync(path.join(targetDir, "SKILL.md"), skillContent, "utf8");
    // 写入辅助文件
    for (const [fname, b64] of Object.entries(extra || {})) {
      if (/[\\/:*?"<>|]/.test(fname)) continue;
      fs.writeFileSync(path.join(targetDir, fname), Buffer.from(b64, "base64"));
    }
    res.json({ ok: true, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
      if (h && (h.id === id || h.sessionId === id)) return f;
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

// 清洗会话标题：去掉前端注入的前缀标记（[当前打开文件]/[模式]/[已上传附件]），按句子智能截断
function cleanSessionTitle(raw) {
  let t = String(raw || "").trim();
  t = t.replace(/^\[当前打开文件:[^\]]*\]\s*/g, "");
  t = t.replace(/^\[模式:\s*[^\]]*\]\s*/g, "");
  t = t.replace(/^\[已上传附件:[^\]]*\]\s*/g, "");
  t = t.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  if (t.length <= 50) return t;
  // 按句子边界截断
  const m = t.match(/^.{0,48}[。！？.!?]/);
  if (m) return m[0];
  return t.slice(0, 50) + "…";
}

// GET /api/sessions - 列出所有会话（解析每个 JSONL 的 header 第一行）
// 支持 ?file=xxx 过滤：只返回提到指定文件的会话
app.get("/api/sessions", (req, res) => {
  const fileFilter = String(req.query.file || "").trim();
  try {
    const files = listSessionFiles();
    const sessions = [];
    for (const f of files) {
      try {
        const text = fs.readFileSync(f.fullPath, "utf8");
        const firstLine = text.split(/\r?\n/)[0];
        if (!firstLine) continue;
        const h = JSON.parse(firstLine);
        // 只显示 office agent 的会话（cwd 匹配项目相关目录或 pi 会话存储目录），过滤 pi TUI 等其他会话
        const cwd = h.cwd || "";
        const isOaw = cwd.includes("office-agent-web") || cwd.includes(PROJECT_DIR) || cwd === path.dirname(PROJECT_DIR) || cwd === SESSIONS_DIR;
        if (!isOaw) continue;
        // 按文件过滤：会话内容（用户消息/工具参数）提到该文件才保留
        if (fileFilter && !text.includes(fileFilter)) continue;
        // 提取第一条用户消息作为标题（清洗前端注入前缀）
        let title = "";
        for (const line of text.split(/\r?\n/).slice(1)) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type === "message" && entry.message?.role === "user") {
              const c = entry.message.content;
              let raw = "";
              if (typeof c === "string") raw = c.trim();
              else if (Array.isArray(c)) {
                raw = c.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
              }
              const cleaned = cleanSessionTitle(raw);
              if (cleaned) { title = cleaned; break; }
            }
          } catch {}
        }
        // 若首条用户消息清洗后为空（纯前缀/空），退回 label 或会话 id 前段
        if (!title) title = h.label || "";
        sessions.push({
          id: h.id || h.sessionId || path.basename(f.fileName, ".jsonl"),
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
  const { client, text, images, attachments, effort } = req.body || {};
  if (!client || !text) return res.status(400).json({ error: "client and text required" });
  const before = snapshotWorkspace();
  // 保存上传的附件到工作区（agent 可读取）
  if (Array.isArray(attachments) && attachments.length) {
    for (const att of attachments) {
      try {
        const safe = safeName(att.name);
        if (!safe) continue;
        fs.writeFileSync(path.join(getWorkspace(), safe), Buffer.from(att.data, "base64"));
      } catch {}
    }
  }
  try {
    await agentManager.prompt(client, text, images, effort);
  } catch (e) {
    const entry = agentManager.sessions.get(client);
    if (entry) emitChannel(entry, "agent_error", { message: e.message });
    // 出错也检测产物（agent 可能已部分写入文件）
    const changed = await waitForFlush(before);
    if (changed.length) {
      if (entry) {
        emitChannel(entry, "file_changed", { files: changed });
        emitChannel(entry, "agent_summary", {
          products: changed,
          summary: `对话异常结束，仍处理了 ${changed.length} 个文件：${changed.join(", ")}`,
        });
      }
    }
    res.status(500).json({ error: e.message });
    return;
  }
  // officecli keeps files in a resident process — disk writes flush asynchronously.
  // Poll until the workspace snapshot stabilizes, then diff.
  const changed = await waitForFlush(before);
  if (changed.length) {
    const entry = agentManager.sessions.get(client);
    if (entry) {
      emitChannel(entry, "file_changed", { files: changed });
      // 对话结束总结：产物清单
      emitChannel(entry, "agent_summary", {
        products: changed,
        summary: `本轮对话完成，共处理 ${changed.length} 个文件：${changed.join(", ")}`,
      });
    }
  }
  // 返回 pi 会话 id，供前端持久化（刷新后恢复当前对话）
  const entry = agentManager.sessions.get(client);
  res.json({ ok: true, changed, sessionId: entry?.session?.sessionId || null });
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

// ---------- 记忆系统 API（Proma WorkspaceMemory 风格） ----------
import { EventEmitter } from "node:events";
const memoryEmitter = new EventEmitter();
let memoryWatcher = null;

function getMemoryDir() { return path.join(getWorkspace(), "memory"); }
function getAgentsMd() { return path.join(getWorkspace(), "AGENTS.md"); }

function ensureMemoryDir() {
  const dir = getMemoryDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listMemoryFiles() {
  const dir = getMemoryDir();
  const agentsMd = getAgentsMd();
  const files = [];
  if (fs.existsSync(agentsMd)) {
    const st = fs.statSync(agentsMd);
    files.push({ name: "AGENTS.md", rel: "AGENTS.md", size: st.size, mtime: st.mtimeMs, type: "agents" });
  }
  if (fs.existsSync(dir)) {
    const walk = (d, prefix = "") => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isFile() && /\.(md|txt)$/i.test(e.name) && !e.name.startsWith(".")) {
          const fp = path.join(d, e.name);
          const st = fs.statSync(fp);
          files.push({ name: e.name, rel, size: st.size, mtime: st.mtimeMs, type: "memory" });
        } else if (e.isDirectory() && !e.name.startsWith(".")) {
          walk(path.join(d, e.name), rel);
        }
      }
    };
    walk(dir);
  }
  return files.sort((a, b) => {
    if (a.rel === "AGENTS.md") return -1;
    if (b.rel === "AGENTS.md") return 1;
    if (a.rel === "MEMORY.md") return -1;
    if (b.rel === "MEMORY.md") return 1;
    return a.name.localeCompare(b.name);
  });
}

function resolveMemoryPath(rel) {
  if (!rel || rel.includes("..")) return null;
  if (rel === "AGENTS.md") return getAgentsMd();
  return path.join(getMemoryDir(), rel);
}

function startMemoryWatcher() {
  if (memoryWatcher) return;
  const dir = getMemoryDir();
  if (!fs.existsSync(dir)) return;
  try {
    memoryWatcher = fs.watch(dir, { recursive: false }, (eventType, filename) => {
      if (!filename) return;
      const filePath = path.join(dir, filename);
      let content = null;
      try { content = fs.readFileSync(filePath, "utf8").slice(0, 2000); } catch {}
      memoryEmitter.emit("change", { file: filename, event: eventType, preview: content, time: Date.now() });
    });
    memoryWatcher.on("error", (err) => {
      if (err.code === "EMFILE") {
        try { memoryWatcher.close(); } catch {}
        memoryWatcher = null;
      }
    });
  } catch (err) {
    memoryWatcher = null;
  }
}

app.get("/api/memory", (_req, res) => {
  try {
    const files = listMemoryFiles();
    res.json({ files, memoryDir: getMemoryDir() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/memory/stream", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  startMemoryWatcher();
  const onChange = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  memoryEmitter.on("change", onChange);
  req.on("close", () => memoryEmitter.off("change", onChange));
});

app.post("/api/memory/init", (_req, res) => {
  try {
    const ws = getWorkspace();
    const agentsMd = path.join(ws, "AGENTS.md");
    const memDir = path.join(ws, "memory");
    const memMd = path.join(memDir, "MEMORY.md");
    if (!fs.existsSync(agentsMd)) {
      fs.writeFileSync(agentsMd, `# AGENTS.md\n\n## 项目说明\n\n在此添加项目指令和上下文信息。\n\n## 工作偏好\n\n在此添加工作偏好。\n`, "utf8");
    }
    fs.mkdirSync(memDir, { recursive: true });
    if (!fs.existsSync(memMd)) {
      fs.writeFileSync(memMd, `# 记忆索引\n\n这是一个长期记忆文件，记录跨会话的上下文信息。\n\n## 项目信息\n\n## 用户偏好\n\n## 经验教训\n\n`, "utf8");
    }
    startMemoryWatcher();
    res.json({ ok: true, files: listMemoryFiles() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get(/^\/api\/memory\/([^/]+)$/, (req, res) => {
  const fp = resolveMemoryPath(req.params[0]);
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: "not found" });
  try { res.json({ content: fs.readFileSync(fp, "utf8"), path: req.params[0] }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post(/^\/api\/memory\/([^/]+)$/, (req, res) => {
  const fp = resolveMemoryPath(req.params[0]);
  if (!fp) return res.status(400).json({ error: "invalid path" });
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, req.body?.content || "", "utf8");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- 地图项目（MapLibre 可视化） ----------
import * as mapSvc from "./map.mjs";

// 静态资源：/api/map/data/{project}/style.json|tiles/...|layers/...
app.use("/api/map/data", express.static(mapSvc.STATIC_ROOT, { fallthrough: true, maxAge: 0 }));

// 项目列表
app.get("/api/map/projects", (_req, res) => {
  res.json({ projects: mapSvc.listProjects() });
});

// 项目详情（config + style + 图层文件清单）
app.get("/api/map/project/:name", (req, res) => {
  const p = mapSvc.getProject(req.params.name);
  if (!p) return res.status(404).json({ error: "project not found" });
  res.json(p);
});

// 保存样式（agent/前端可写回 style.json）
app.post("/api/map/project/:name/style", (req, res) => {
  const ok = mapSvc.saveStyle(req.params.name, req.body?.style);
  if (!ok) return res.status(400).json({ error: "invalid style" });
  res.json({ ok: true });
});

// 保存配置（图层显隐/顺序/中心点）
app.post("/api/map/project/:name/config", (req, res) => {
  const ok = mapSvc.saveConfig(req.params.name, req.body?.config);
  if (!ok) return res.status(400).json({ error: "invalid config" });
  res.json({ ok: true });
});

// 导入矢量图层（body: { layerId, geojson }）→ 存 layers/ + 重建瓦片
app.post("/api/map/project/:name/import", async (req, res) => {
  const { layerId, geojson } = req.body || {};
  if (!layerId || !geojson) return res.status(400).json({ error: "layerId and geojson required" });
  try {
    const r = await mapSvc.importLayer(req.params.name, layerId, geojson);
    if (!r) return res.status(400).json({ error: "import failed" });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 重建全部瓦片
app.post("/api/map/project/:name/rebuild-tiles", (req, res) => {
  try {
    const r = mapSvc.rebuildTiles(req.params.name);
    res.json({ ok: true, results: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 获取图层 GeoJSON（属性表/要素定位）
app.get("/api/map/project/:name/layer/:layerId", (req, res) => {
  const g = mapSvc.getLayer(req.params.name, req.params.layerId);
  if (!g) return res.status(404).json({ error: "layer not found" });
  res.json(g);
});

// 删除图层（数据 + 瓦片 + style + config）
app.delete("/api/map/project/:name/layer/:layerId", (req, res) => {
  try {
    const r = mapSvc.deleteLayer(req.params.name, req.params.layerId);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 等时圈分析（高德 Web 服务，需 AMAP_KEY）
app.post("/api/map/project/:name/isochrone", async (req, res) => {
  try {
    const r = await mapSvc.isochrone(req.body || {});
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- static ----------
const dist = CLIENT_DIST;
if (fs.existsSync(path.join(dist, "index.html"))) {
  app.use(express.static(dist));
  app.get("/*splat", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

// ---------- helpers for file change detection ----------
function walkSnapshot(dir, root) {
  const out = [];
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of items) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...walkSnapshot(p, root));
    } else {
      try {
        const st = fs.statSync(p);
        out.push(`${path.relative(root, p)}|${st.mtimeMs}|${st.size}`);
      } catch {}
    }
  }
  return out;
}
function snapshotWorkspace() {
  const top = listWorkspace().map((f) => `${f.name}|${f.mtime}|${f.size}`);
  // 地图项目位于工作区子目录，递归快照以便检测 layers/tiles/style 变化
  const mapRoot = path.join(WORKSPACE_DIR, "maps");
  const maps = fs.existsSync(mapRoot) ? walkSnapshot(mapRoot, WORKSPACE_DIR) : [];
  return [...top, ...maps];
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

// 在文件管理器中打开文件/文件夹
app.post("/api/open-in-explorer", async (req, res) => {
  const { path: filePath } = req.body || {};
  if (!filePath) return res.status(400).json({ error: "path required" });
  
  const { exec } = await import("child_process");
  const { statSync } = await import("fs");
  const path = await import("path");
  
  const fullPath = resolvePath(filePath);
  
  if (!fullPath) {
    return res.status(404).json({ error: "file not found" });
  }
  
  // Windows: 使用 explorer 打开文件夹或选中文件
  const isWindows = process.platform === "win32";
  let cmd;
  
  try {
    if (isWindows) {
      const stat = statSync(fullPath, { throwOnError: false });
      if (stat && stat.isDirectory()) {
        cmd = `explorer "${fullPath}"`;
      } else {
        // 选中文件 - 使用 explorer /select 命令
        const dir = path.dirname(fullPath);
        const file = path.basename(fullPath);
        cmd = `cmd /c explorer /select,"${fullPath}"`;
      }
    } else if (process.platform === "darwin") {
      cmd = `open "${fullPath}"`;
    } else {
      cmd = `xdg-open "${path.dirname(fullPath)}"`;
    }
    
    exec(cmd, (err) => {
      if (err) {
        console.error("打开文件管理器失败:", err);
        // 即使失败也返回成功，因为explorer可能已经打开
        res.json({ ok: true, warning: err.message });
      } else {
        res.json({ ok: true });
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Open Plan（规聚）running at http://localhost:${PORT}`);
  console.log(`workspace: ${WORKSPACE_DIR}`);
});

process.on("SIGINT", async () => {
  await agentManager.disposeAll();
  stopAllWatches();
  if (memoryWatcher) { try { memoryWatcher.close(); } catch {} }
  process.exit(0);
});
