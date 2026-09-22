import express from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { listWorkspace, searchWorkspace, filePath, safeName, WORKSPACE_DIR, CLIENT_DIST, OFFICECLI, AGENT_DIR, getWorkspace, setWorkspace, normalizeWorkspace, resolvePath, PROJECT_DIR, listFileRoots, addFileRoot, removeFileRoot, resolveExternalPath, getHiddenWorkspaces, hideWorkspace } from "./workspace.mjs";
import { runOfficecli, checkOfficecli, view, get, set, batch, renderHtml, queryComments, startWatch, stopWatch, stopAllWatches } from "./office.mjs";
import { getApprovalMode, listPendingApprovals, listPermissionRules, resolveToolApproval, setApprovalMode } from "./审批策略.mjs";
import { agentManager, classifyAgentError, getCredentialErrors, listAuth, setApiKey, removeApiKey } from "./agent.mjs";
import * as kb from "./kb.mjs";
import * as tpl from "./tpl.mjs";
import * as map from "./map.mjs";
import * as cambodiaOD from "./柬埔寨OD.mjs";
import { createDemoAnalysis } from "./地图演示.mjs";
import * as mapAnalysis from "./map-analysis.mjs";
import { parseReferences, resolveReferences, readReference, contextSummary } from "./context.mjs";
import { beginRun, recordRunEvent, updateRunStep, finishRun, getRun, listRuns, rollbackRun, recoverActiveRuns, requestRunCancellation, filterRunChanges } from "./runs.mjs";
import { appendEvent, eventStoreInfo, getReadCursor, listEvents, markReadCursor, subscribeEvents } from "./事件存储.mjs";
import { createTaskEnvelope, normalizeTaskMode, planTaskCapabilities } from "./task.mjs";
import { validateArtifactFile, validateArtifacts } from "./产物验证.mjs";
import { listPublishedArtifacts, publishArtifact, inspectRunAcceptance, confirmArtifactAcceptance, rollbackPublishedArtifact } from "./成果管理.mjs";
import { atomicWriteFile, atomicWriteJson, ensureDirectory } from "./持久化工具.mjs";
import { getWorkflow, listWorkflows, workflowIdFromText } from "./workflows.mjs";
import { listConnectors, getConnector, beginConnectorAuth, setConnectorStatus } from "./connectors.mjs";
import * as projectManager from "./项目管理.mjs";
import { listAgents, createAgent, updateAgent, deleteAgent } from "./智能体管理.mjs";
import { listStagedFilesForValidation, stageWrite, writeWorkspaceFile, withWriteLockAsync } from "./写入协调.mjs";
import { evaluateWorkspaceWrite, runRuntimeEvaluation } from "./运行评测.mjs";
import { normalizeOfficeFailure, normalizeWorkspaceWriteError, workspaceWriteHttpStatus } from "./文件权限错误.mjs";
import { PROTOCOL_VERSION, isHistoryTruncated, resolveReplayCursor, pushChannelEvent, CHANNEL_HISTORY_LIMIT } from "./事件协议.mjs";
import * as searchModule from "./联网搜索.mjs";
import * as browserModule from "./内置浏览器.mjs";
import { inferCompletion } from "./运行轨迹.mjs";
import { PI_PACKAGE_VERSION, piRuntimeManager } from "./Pi运行时管理.mjs";
import { createPiNetworkAdapter } from "./Pi网络代理.mjs";
import {
  getConfigStatus,
  importLocalPiConfig,
  importLocalPiSessions,
  loadNetworkSettings,
  previewLocalPiConfig,
  readModelsStore,
  readModelsConfig,
  writeModelsConfig,
  readNetworkSettings,
  readRuntimeSettings,
  saveNetworkSettings,
} from "./Pi配置管理.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const app = express();
const HOST = process.env.HOST || "127.0.0.1";
const PORT = process.env.PORT || 3002;
const API_TOKEN = String(process.env.OAW_API_TOKEN || "").trim();
const AGENT_DIAGNOSTIC_LOG = path.join(process.env.TEMP || PROJECT_DIR, "open-plan-agent连接诊断.log");
const SERVICE_STARTED_AT = new Date().toISOString();

// 服务进程的 Windows 身份。从 Codex/沙箱环境启动时会继承 CodexSandboxOffline 等
// 受限账户，对工作区外目录（如 E 盘）写入会被 OS 以 EPERM 拒绝；暴露给 /api/status
// 便于前端和排查日志直接判断"服务进程身份"而非误归因于 Office CLI。
function serviceIdentity() {
  try { return os.userInfo().username || String(process.env.USERNAME || "").trim() || "unknown"; } catch { return String(process.env.USERNAME || "").trim() || "unknown"; }
}

const SERVICE_IDENTITY = serviceIdentity();
const IS_SANDBOX_IDENTITY = /sandbox|CodexSandbox/i.test(SERVICE_IDENTITY);
if (IS_SANDBOX_IDENTITY) {
  console.warn(`[identity] 警告：当前服务以受限身份 "${SERVICE_IDENTITY}" 运行（通常是 Codex 沙箱账户）。该身份可能无法写入工作区之外的目录（如 E 盘），如遇 EPERM/Access denied 请改用普通终端启动服务。`);
}

// Runtime 冷启动（首次创建 Pi 会话）在极端情况下可能长时间不完成，此前只会让
// 前端永远停在“正在准备会话运行时”。这里给初始化加超时：超时后取消等待并抛出
// RUNTIME_INIT_TIMEOUT（后台创建任务仍在继续，重试会复用或重新尝试）。
const RUNTIME_INIT_TIMEOUT_MS = 45000;

async function ensureRuntimeWithTimeout(key, options = {}) {
  let timer = null;
  const operation = agentManager.ensureRuntime(key, options);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`会话运行时初始化超过 ${Math.round(RUNTIME_INIT_TIMEOUT_MS / 1000)} 秒未完成，已自动取消等待；可重试或检查模型配置与网络`);
      error.code = "RUNTIME_INIT_TIMEOUT";
      error.retryable = true;
      reject(error);
    }, RUNTIME_INIT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const recoveredRunIds = recoverActiveRuns();
if (recoveredRunIds.length) console.warn(`[runs] 已将 ${recoveredRunIds.length} 个中断前活动 Run 标记为 recovering，等待用户继续。`);

function validateStagedArtifacts(runId) {
  return listStagedFilesForValidation(runId).map((item) => validateArtifactFile(item.file, item.root, item.path));
}

app.use(express.json({ limit: "256mb" }));

function recordAgentDiagnostic(req, details = {}) {
  const info = details.error ? classifyAgentError(details.error) : details;
  const record = {
    time: new Date().toISOString(),
    requestId: req?.requestId || null,
    clientId: details.client || null,
    threadId: details.thread || null,
    runId: details.runId || null,
    model: details.model || null,
    providerStatus: info.status || null,
    errorCode: info.code || null,
    errorCategory: info.category || null,
    causeCode: info.causeCode || null,
    retryable: Boolean(info.retryable),
    message: info.message || "模型连接失败",
  };
  try { fs.appendFileSync(AGENT_DIAGNOSTIC_LOG, JSON.stringify(record) + "\n", "utf8"); } catch {}
  console.error("[agent] prompt failed", record);
  return record;
}

function readRecentAgentDiagnostics({ client = "", thread = "", runId = "", limit = 20 } = {}) {
  let lines = [];
  try { lines = fs.readFileSync(AGENT_DIAGNOSTIC_LOG, "utf8").split(/\r?\n/).filter(Boolean); } catch { return []; }
  const max = Math.max(1, Math.min(50, Number.parseInt(String(limit), 10) || 20));
  const matches = [];
  for (let index = lines.length - 1; index >= 0 && matches.length < max; index -= 1) {
    try {
      const item = JSON.parse(lines[index]);
      if (client && item.clientId !== client) continue;
      if (thread && item.threadId !== thread) continue;
      if (runId && item.runId !== runId) continue;
      matches.push(item);
    } catch {}
  }
  return matches;
}

function agentFailureHint(item = {}) {
  const code = String(item.errorCode || item.code || "");
  const category = String(item.errorCategory || "");
  const status = String(item.providerStatus || "");
  const causeCode = String(item.causeCode || "");
  const message = String(item.message || "");
  if (/^(401|403)$/.test(status) || code === "AUTH_ERROR" || category === "auth" || /(?:invalid.?api.?key|authentication|unauthori[sz]ed|forbidden|permission denied)/i.test(message)) {
    return "凭据已失效：请重新保存 API Key";
  }
  if (["HOST_NETWORK_RESTRICTED", "NETWORK_UNREACHABLE", "MODEL_TIMEOUT", "MODEL_STREAM_TIMEOUT", "MODEL_PROBE_TIMEOUT"].includes(code)
    || ["HOST_NETWORK_RESTRICTED", "NETWORK_UNREACHABLE", "MODEL_TIMEOUT", "MODEL_STREAM_TIMEOUT"].includes(category)
    || causeCode === "ETIMEDOUT"
    || /(?:timed?.?out|timeout|connection.?refused|getaddrinfo|ENOTFOUND|ETIMEDOUT)/i.test(message)) {
    return "模型请求超时：请检查网络或代理设置（设置→模型与连接→模型网络）";
  }
  return "";
}

// ---------- request boundary / local API authentication ----------
// The app is intended to run locally. Keep the default listener on loopback and
// make authentication opt-in so existing local workflows remain compatible.
function tokenMatches(candidate) {
  if (!API_TOKEN || !candidate) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(API_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readCookie(req, name) {
  const raw = req.get("cookie") || "";
  const pair = raw.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : "";
}

function setAuthCookie(res) {
  if (!API_TOKEN) return;
  res.setHeader("Set-Cookie", `oaw_token=${encodeURIComponent(API_TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
}

app.use((req, res, next) => {
  const requestId = req.get("x-request-id") || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  // Opening the UI as /?token=... bootstraps a same-origin HttpOnly cookie,
  // which also works for direct fetch() calls and EventSource streams.
  if (API_TOKEN && tokenMatches(req.query?.token)) setAuthCookie(res);

  if (!API_TOKEN || !req.path.startsWith("/api/") || req.path === "/api/status") return next();

  const authorization = req.get("authorization") || "";
  const bearer = authorization.replace(/^Bearer\s+/i, "");
  const supplied = bearer || req.get("x-oaw-token") || readCookie(req, "oaw_token") || req.query?.token;
  if (!tokenMatches(supplied)) {
    return res.status(401).json({ error: "unauthorized", message: "需要有效的 OAW_API_TOKEN", requestId });
  }
  next();
});

// ---------- helpers ----------
const COL_RE = /([A-Z]+)(\d+)$/;
function colToIndex(col) {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function sheetToGrid(children) {
  const rows = {};
  for (const row of children || []) {
    if (row.type !== "row") continue;
    const m = String(row.path || "").match(/row\[(\d+)\]/);
    const ri = m ? parseInt(m[1], 10) : null;
    if (!ri) continue;
    rows[ri] = { cells: {} };
    for (const cell of nodeChildren(row)) {
      if (cell.type !== "cell") continue;
      const ref = String(cell.path || "").match(COL_RE);
      if (!ref) continue;
      const ci = colToIndex(ref[1]);
      rows[ri].cells[ci] = { text: cell.text ?? "" };
    }
  }
  return rows;
}

function officeResults(response) {
  const data = response?.json?.data || {};
  return Array.isArray(data.results) ? data.results : Array.isArray(data.Results) ? data.Results : [];
}

function nodeChildren(node) {
  return Array.isArray(node?.children) ? node.children : Array.isArray(node?.Children) ? node.Children : [];
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
        if (r.type === "sheet" && r.path) sheetNodes.push(r);
        collect(nodeChildren(r));
      }
    };
    collect(officeResults(info));
    if (sheetNodes.length === 0) {
      info = await get(file, "/", 2);
      collect(officeResults(info));
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
      // 使用 Office CLI 返回的 DOM 路径，而不是工作表显示名；名称含空格、斜杠
      // 或非 ASCII 字符时，显示名不一定能作为查询路径。
      const r = await get(file, s.path || `/${s.name}`, 3);
      const results = officeResults(r);
      const res = results.find((item) => item.type === "sheet") || results[0];
      grids[s.name] = sheetToGrid(nodeChildren(res));
    }
    return { sheets: sheets.map((s) => s.name), grids };
  } catch (officeErr) {
    // officecli 不可用，使用 xlsx 包原生读取
    try {
      // xlsx 是 CommonJS 包：动态 import 后需要用 .default 取导出对象
      const xlsxModule = await import("xlsx");
      const XLSX = xlsxModule.default || xlsxModule;
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
            cells[ci + 1] = { text: String(val) };
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
app.get("/api/status", (req, res) => {
  if (API_TOKEN && tokenMatches(req.query?.token)) setAuthCookie(res);
  res.json({
    ok: true,
    officecli: path.basename(OFFICECLI),
    version: pkg.version,
    piPackageVersion: PI_PACKAGE_VERSION,
    host: HOST,
    authRequired: Boolean(API_TOKEN),
    service: {
      pid: process.pid,
      startedAt: SERVICE_STARTED_AT,
      uptimeSec: Math.round(process.uptime()),
      identity: SERVICE_IDENTITY,
      sandboxIdentity: IS_SANDBOX_IDENTITY,
    },
  });
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
  const dir = req.query.dir || "";
  res.json(kb.getTreeLevel(isNaN(rootIdx) ? 0 : rootIdx, dir));
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

// 红头会议通知生成（docx 库生成 → 写工作区）
app.post("/api/templates/generate-notice", async (req, res) => {
  try {
    const { generateNotice } = await import("./notice.mjs");
    const r = await generateNotice(req.body || {});
    res.json({ ok: true, name: r.name });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---------- 文档 ↔ 知识库联动 ----------
// docx → md 入知识库（工作区注册为 kb 根）
app.post("/api/kb/ingest", async (req, res) => {
  try {
    const r = await kb.ingestDocx(req.body?.name);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// kb 文档 → docx 写工作区
app.post("/api/kb/export-docx", async (req, res) => {
  try {
    const rootIdx = parseInt(req.body?.rootIdx, 10);
    const r = await kb.exportDocx(req.body?.relPath, isNaN(rootIdx) ? null : rootIdx);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- HTML 标注持久化（跟随当前工作区） ----------
function annotationsPath(fileName) {
  const safe = path.basename(String(fileName || ""));
  if (!safe || safe.includes("..")) return null;
  return path.join(getWorkspace(), ".annotations", safe + ".json");
}

app.get(/^\/api\/doc\/([^\/]+)\/annotations$/, (_req, res) => {
  const fileName = decodeURIComponent(_req.params[0]);
  const p = annotationsPath(fileName);
  if (!p || !fs.existsSync(p)) return res.json({ annotations: [] });
  try {
    res.json({ annotations: JSON.parse(fs.readFileSync(p, "utf8")) });
  } catch {
    res.json({ annotations: [] });
  }
});

app.post(/^\/api\/doc\/([^\/]+)\/annotations$/, (req, res) => {
  const fileName = decodeURIComponent(req.params[0]);
  const p = annotationsPath(fileName);
  if (!p) return res.status(400).json({ error: "invalid name" });
  try {
    const list = Array.isArray(req.body?.annotations) ? req.body.annotations : [];
    const result = writeWorkspaceFile({ workspace: getWorkspace(), targetPath: p, content: JSON.stringify(list, null, 2), kind: "ui_annotations" });
    res.json({ ...result, count: list.length });
  } catch (e) {
    respondWorkspaceFileError(req, res, e);
  }
});

// 模板文件流（HTML 首页 iframe 渲染；相对资源基于 templates/ 解析）
app.get(/^\/api\/templates\/file\/(.+)$/, (req, res) => {
  const raw = decodeURIComponent(req.params[0]);
  // 兼容绝对路径 relPath（tpl 扫描结果）：截取 templates/ 之后的部分
  const marker = "templates/";
  const idx = raw.indexOf(marker);
  const relPath = idx >= 0 ? raw.slice(idx) : raw;
  if (!relPath || relPath.includes("..") || relPath.startsWith("/")) {
    return res.status(400).json({ error: "invalid path" });
  }
  // 模板可能位于项目根 templates/ 或工作目录（_报告模板 等），双根尝试
  const TPL_ROOT = path.resolve(__dirname, "..", ".."); // F:\Claude code本地文件（工作目录）
  const candidates = [path.join(PROJECT_DIR, relPath), path.join(TPL_ROOT, relPath)];
  const abs = candidates.find((p) => p.startsWith(path.join(PROJECT_DIR, "templates")) || p.startsWith(path.join(TPL_ROOT, "_")));
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return res.status(404).json({ error: "file not found" });
  }
  const ext = path.extname(abs).toLowerCase();
  const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".json": "application/json" }[ext] || "application/octet-stream";
  res.setHeader("Content-Type", mime);
  res.sendFile(abs);
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

// ---------- 地图（GIS 项目：浙江交通地图） ----------
// style.json 动态响应：矢量瓦片 URL 相对路径 → 绝对 URL
// （MapLibre 在 Web Worker 中加载矢量瓦片，Worker 无法解析 /api/... 相对路径）
// 必须注册在任何 /api/map/data 静态挂载之前，否则被 express.static 抢先返回原文件
app.get(/^\/api\/map\/data\/([^/]+)\/style\.json$/, (req, res) => {
  const name = req.params[0];
  const p = path.join(map.STATIC_ROOT, name, "style.json");
  if (!fs.existsSync(p)) return res.status(404).json({ error: "style not found" });
  try {
    const style = map.hydrateBasemapSources(JSON.parse(fs.readFileSync(p, "utf8")));
    const origin = `${req.protocol}://${req.get("host")}`;
    for (const s of Object.values(style.sources || {})) {
      if (Array.isArray(s.tiles)) {
        s.tiles = s.tiles.map((t) => (typeof t === "string" && t.startsWith("/") ? origin + t : t));
      }
    }
    res.json(style);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 静态文件（style.json / 矢量瓦片 / 图层数据）
app.use("/api/map/data", express.static(map.STATIC_ROOT));
// 缺失的地图资源必须明确返回 404，不能继续落入 SPA 首页回退。
app.use("/api/map/data", (_req, res) => res.status(404).json({ error: "map data not found" }));

app.get("/api/map/projects", (_req, res) => {
  res.json({ projects: map.listProjects() });
});

// 创建独立地图项目：基础路网可引用已有项目，业务图层和配置单独保存。
app.post("/api/map/projects", (req, res) => {
  try {
    const created = map.createProject({
      project: req.body?.project,
      name: req.body?.name,
      baseProject: req.body?.baseProject || map.DEFAULT_PROJECT,
    });
    res.status(201).json({ ok: true, project: created.config?.project, config: created.config, style: created.style, files: created.files || [] });
  } catch (e) {
    const status = ["MAP_PROJECT_INVALID", "MAP_PROJECT_EXISTS", "MAP_BASE_PROJECT_NOT_FOUND"].includes(e?.code) ? 409 : 500;
    res.status(status).json({ ok: false, error: e.message, code: e.code || "MAP_PROJECT_CREATE_FAILED" });
  }
});

app.get("/api/map/project", (req, res) => {
  const p = map.getProject(req.query.name || map.DEFAULT_PROJECT);
  if (!p) return res.status(404).json({ error: "project not found" });
  res.json(p);
});

// 地图项目生命周期管理：复制 / 重命名 / 归档 / 删除（默认项目受保护）
app.post("/api/map/projects/duplicate", (req, res) => {
  try {
    const created = map.duplicateProject({ project: req.body?.project, name: req.body?.name });
    res.status(201).json({ ok: true, project: created?.config?.project, config: created?.config });
  } catch (e) {
    const status = ["MAP_PROJECT_INVALID", "MAP_PROJECT_EXISTS", "MAP_PROJECT_NOT_FOUND"].includes(e?.code) ? 409 : 500;
    res.status(status).json({ ok: false, error: e.message, code: e.code || "MAP_PROJECT_DUPLICATE_FAILED" });
  }
});

app.post("/api/map/projects/rename", (req, res) => {
  try {
    const renamed = map.renameProject({ project: req.body?.project, name: req.body?.name });
    res.json({ ok: true, project: renamed?.config?.project, config: renamed?.config });
  } catch (e) {
    const status = ["MAP_PROJECT_INVALID", "MAP_PROJECT_EXISTS", "MAP_PROJECT_NOT_FOUND"].includes(e?.code) ? 409 : e?.code === "MAP_PROJECT_PROTECTED" ? 403 : 500;
    res.status(status).json({ ok: false, error: e.message, code: e.code || "MAP_PROJECT_RENAME_FAILED" });
  }
});

app.post("/api/map/projects/archive", (req, res) => {
  const config = map.archiveProject(req.body?.project, req.body?.archived !== false);
  if (!config) return res.status(404).json({ ok: false, error: "project not found" });
  res.json({ ok: true, config });
});

app.post("/api/map/projects/delete", (req, res) => {
  try {
    const result = map.deleteProject(req.body?.project);
    res.json({ ok: true, ...result });
  } catch (e) {
    const status = e?.code === "MAP_PROJECT_PROTECTED" ? 403 : e?.code === "MAP_PROJECT_NOT_FOUND" ? 404 : 500;
    res.status(status).json({ ok: false, error: e.message, code: e.code || "MAP_PROJECT_DELETE_FAILED" });
  }
});

app.post("/api/map/style", (req, res) => {
  const { name, style } = req.body || {};
  const r = map.saveStyle(name || map.DEFAULT_PROJECT, style);
  if (!r) return res.status(400).json({ error: "invalid style" });
  res.json({ ok: true });
});

app.post("/api/map/config", (req, res) => {
  const { name, config } = req.body || {};
  const r = map.saveConfig(name || map.DEFAULT_PROJECT, config);
  if (!r) return res.status(400).json({ error: "invalid config" });
  res.json({ ok: true });
});

app.post("/api/map/import", async (req, res) => {
  const { name, layerId, geojson } = req.body || {};
  if (!geojson) return res.status(400).json({ error: "geojson required" });
  try {
    const r = await map.importLayer(name || map.DEFAULT_PROJECT, layerId, geojson);
    if (!r) return res.status(400).json({ error: "import failed" });
    res.json(r);
  } catch (e) {
    const clientError = /没有可导入|无效坐标|坐标不在|没有有效几何/.test(String(e.message || ""));
    res.status(clientError ? 400 : 500).json({ error: e.message });
  }
});

app.post("/api/map/import-batch", async (req, res) => {
  const { name, items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "items required" });
  try {
    const r = await map.importBatch(name || map.DEFAULT_PROJECT, items);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 从数据目录一键生成路网图层（prepare-map-data + 瓦片重建）
app.post("/api/map/prepare", async (req, res) => {
  const { srcDir } = req.body || {};
  const ws = getWorkspace();
  const src = srcDir ? path.resolve(ws, String(srcDir)) : path.join(PROJECT_DIR, "data");
  if (!src.startsWith(ws) && !src.startsWith(PROJECT_DIR)) return res.status(400).json({ error: "invalid dir" });
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    return res.status(400).json({ error: "目录不存在: " + (srcDir || "data") + "（请先把矢量数据放入该目录）" });
  }
  const { execFile } = await import("node:child_process");
  const run = (script, args) => new Promise((resolve) => {
    execFile("node", [script, ...args], { cwd: PROJECT_DIR, timeout: 300000 }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, out: (stdout || "") + (stderr || "") });
    });
  });
  const p1 = await run("scripts/prepare-map-data.mjs", [src]);
  const p2 = await run("scripts/build-vector-tiles.mjs", ["--force"]);
  res.json({ ok: p1.code === 0 && p2.code === 0, prepare: p1.out.slice(-800), tiles: p2.out.slice(-500) });
});

app.post("/api/map/rebuild", (req, res) => {
  const { name, layerIds } = req.body || {};
  const r = map.rebuildTiles(name || map.DEFAULT_PROJECT, Array.isArray(layerIds) ? layerIds : null);
  if (!r) return res.status(400).json({ error: "rebuild failed" });
  res.json({ ok: true, layers: r });
});

app.post("/api/map/layer/delete", (req, res) => {
  const { name, layerId } = req.body || {};
  const r = map.deleteLayer(name || map.DEFAULT_PROJECT, layerId);
  res.json(r);
});

app.get("/api/map/layer", (req, res) => {
  const g = map.getLayer(req.query.name || map.DEFAULT_PROJECT, req.query.layer);
  if (!g) return res.status(404).json({ error: "layer not found" });
  res.json(g);
});

app.post("/api/map/isochrone", async (req, res) => {
  const { location, mode, range, rangeType } = req.body || {};
  if (!location) return res.status(400).json({ error: "location required (lng,lat)" });
  const r = await map.isochrone({ location, mode, range, rangeType });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ ok: true, center: r.center, cost: r.cost, polygons: r.polygons });
});

// 路径规划（默认 OSRM 开源，可选高德）
app.post("/api/map/route", async (req, res) => {
  const { from, to, mode, provider } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: "from/to required (lng,lat)" });
  const r = await map.route({ from, to, mode, provider });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ ok: true, provider: r.provider, distance: r.distance, duration: r.duration, geometry: r.geometry });
});

// 地图分析演示与数据适配器（结果只在内存中生成，明确标记 source=demo）
app.get("/api/map/demo-analysis", (req, res) => {
  try {
    res.json(mapAnalysis.createDemoAnalysis({ analysis: req.query.analysis, region: req.query.region, project: req.query.project, count: req.query.count }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/demo/cambodia-od", (req, res) => {
  try { res.json(mapAnalysis.getCambodiaOD({ minFlow: req.query.minFlow })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/m3/bus-routes", (_req, res) => {
  try { res.json(mapAnalysis.getXinchangBus("routes")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/m3/station-heatmap", (_req, res) => {
  try { res.json(mapAnalysis.getXinchangBus("stations")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/m3/od-lines", (_req, res) => {
  try { res.json(mapAnalysis.getXinchangBus("od")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/m3/network-stats", (_req, res) => {
  try { res.json(mapAnalysis.getXinchangBus("stats")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/files", (req, res) => {
  const dir = req.query.dir || "";
  // 只允许相对路径，防止越界
  if (dir && (dir.includes("..") || dir.startsWith("/") || /^[a-zA-Z]:/.test(dir))) {
    return res.status(400).json({ error: "invalid dir" });
  }
  const target = dir ? resolvePath(dir) : getWorkspace();
  if (dir && (!target || !fs.statSync(target).isDirectory())) return res.status(404).json({ error: "directory not found" });
  const files = listWorkspace(target).map((item) => {
    if (item.isDir) return item;
    const p = path.join(target, item.name);
    try {
      const st = fs.statSync(p);
      return { ...item, mime: mimeForExt(item.ext), mtime: st.mtimeMs, version: `${st.size}:${st.mtimeMs}` };
    } catch { return item; }
  });
  res.json({ files, dir, workspace: getWorkspace() });
});

app.get("/api/files/search", (req, res) => {
  const query = String(req.query.q || "").trim();
  const limit = Math.max(1, Math.min(500, Number.parseInt(String(req.query.limit || "200"), 10) || 200));
  if (!query) return res.json({ files: [], query: "", workspace: getWorkspace() });
  try {
    res.json({ files: searchWorkspace(query, { limit }), query, workspace: getWorkspace() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function mimeForExt(ext) {
  return ({
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    pdf: "application/pdf", csv: "text/csv", json: "application/json",
    md: "text/markdown", markdown: "text/markdown", txt: "text/plain", html: "text/html", htm: "text/html",
  })[String(ext || "").toLowerCase()] || "application/octet-stream";
}

// ---------- structured references / external file roots ----------
app.post("/api/context/resolve", (req, res) => {
  try {
    const { references, text, workspace, cwd } = req.body || {};
    const currentWorkspace = normalizeWorkspace(workspace || cwd || getWorkspace()) || getWorkspace();
    const resolved = resolveReferences(references, text, currentWorkspace);
    const publicRefs = resolved.map((ref) => {
      const metadata = ref.metadata ? { ...ref.metadata } : ref.metadata;
      if (metadata?.path) delete metadata.path;
      if (Array.isArray(metadata?.files)) metadata.files = metadata.files.map((item) => { const next = { ...item }; delete next.path; return next; });
      return { ...ref, metadata };
    });
    res.json({ ok: true, references: publicRefs, summary: contextSummary(publicRefs), requestId: req.requestId });
  } catch (e) {
    res.status(400).json({ error: e.message, requestId: req.requestId });
  }
});

app.post("/api/context/read", async (req, res) => {
  try {
    const { reference, references, refId, query, range, workspace, cwd } = req.body || {};
    const ref = reference || (Array.isArray(references) ? references.find((r) => r?.id === refId) : null);
    if (!ref) return res.status(400).json({ error: "reference or refId required", requestId: req.requestId });
    const currentWorkspace = normalizeWorkspace(workspace || cwd || getWorkspace()) || getWorkspace();
    const result = await readReference(ref, query, range, currentWorkspace);
    if (result.status !== "resolved") return res.status(404).json({ ...result, requestId: req.requestId });
    const metadata = result.metadata ? { ...result.metadata } : result.metadata;
    if (metadata?.path) delete metadata.path;
    res.json({ ...result, metadata, requestId: req.requestId });
  } catch (e) {
    res.status(500).json({ error: e.message, requestId: req.requestId });
  }
});

app.get("/api/file-roots", (_req, res) => res.json({ roots: listFileRoots() }));
app.post("/api/file-roots", (req, res) => {
  const result = addFileRoot(req.body?.path, req.body?.label);
  res.status(result.ok ? 200 : 400).json(result);
});
app.delete("/api/file-roots/:id", (req, res) => {
  const result = removeFileRoot(req.params.id);
  res.status(result.ok ? 200 : 404).json(result);
});

function respondWorkspaceFileError(req, res, error) {
  const normalized = normalizeWorkspaceWriteError(error);
  return res.status(workspaceWriteHttpStatus(normalized)).json({
    ok: false,
    code: normalized.code || "WORKSPACE_FILE_OPERATION_FAILED",
    error: normalized.message,
    requestId: req.requestId,
  });
}

function requireWorkspaceWriteForTask(capabilityPlan, workspace) {
  const reviewNeedsWorkspace = capabilityPlan?.mode === "review";
  if (
    (!reviewNeedsWorkspace && !capabilityPlan?.output?.expected) ||
    capabilityPlan.output.saveToWorkspace === false
  ) {
    return null;
  }
  const writeAccess = evaluateWorkspaceWrite(workspace);
  capabilityPlan.workspaceWrite = writeAccess;
  if (writeAccess.status === "passed") return writeAccess;
  const failure = normalizeWorkspaceWriteError(Object.assign(new Error(writeAccess.message), { code: writeAccess.details?.code || undefined }));
  if (!["WORKSPACE_PERMISSION_DENIED", "OFFICE_DOCUMENT_LOCKED"].includes(failure.code)) failure.code = "WORKSPACE_WRITE_UNAVAILABLE";
  failure.writeAccess = writeAccess;
  throw failure;
}

// OfficeCLI 会为打开过的文档保留常驻进程并持有文件句柄，导致随后 UI 的删除/覆盖
// 上传出现 EBUSY。遇到文档锁定时先执行 `officecli close` 释放句柄，再重试一次。
async function withOfficecliReleaseRetry(workspace, fileName, operation) {
  try {
    return await operation();
  } catch (error) {
    const normalized = normalizeWorkspaceWriteError(error);
    if (normalized.code !== "OFFICE_DOCUMENT_LOCKED") throw normalized;
    try { await runOfficecli(["close", fileName], { cwd: workspace, timeoutMs: 15000 }); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 400));
    return await operation();
  }
}

app.post("/api/files/upload", async (req, res) => {
  const { name, base64 } = req.body || {};
  const safe = safeName(name);
  if (!safe || !base64) return res.status(400).json({ error: "invalid upload" });
  const buf = Buffer.from(base64, "base64");
  if (!/\.(docx|xlsx|xls|pptx|pdf|csv|json|md|markdown|txt|html|htm)$/i.test(safe)) return res.status(400).json({ error: "不支持的格式" });
  try {
    const workspace = getWorkspace();
    const result = await withOfficecliReleaseRetry(workspace, safe, () =>
      writeWorkspaceFile({ workspace, targetPath: path.join(workspace, safe), content: buf, kind: "ui_upload" }));
    res.json({ ...result, file: safe });
  } catch (error) {
    respondWorkspaceFileError(req, res, error);
  }
});

app.post("/api/files/delete", async (req, res) => {
  const p = resolvePath(req.body?.name);
  if (!p) return res.status(404).json({ error: "not found" });
  try {
    const workspace = getWorkspace();
    const rel = path.relative(workspace, p);
    await withOfficecliReleaseRetry(workspace, rel, () =>
      withWriteLockAsync({ workspace, targetPath: p, runId: `ui_${crypto.randomUUID()}`, kind: "ui_delete" }, () => fs.unlinkSync(p)));
    res.json({ ok: true, file: rel.replace(/\\/g, "/") });
  } catch (error) {
    respondWorkspaceFileError(req, res, error);
  }
});

// 原始文件流（供前端 docx-preview/pptxviewjs 渲染，正则路由避免吞参数）
app.get(/^\/api\/doc\/(.+)\/raw$/, (req, res) => {
  const fileName = decodeURIComponent(req.params[0]);
  const requestedCwd = normalizeWorkspace(String(req.query.cwd || "")) || undefined;
  const p = resolvePath(fileName, requestedCwd);
  if (!p) return res.status(404).json({ error: "not found" });
  const ext = path.extname(p).slice(1).toLowerCase();
  const mimeMap = { docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", pdf: "application/pdf" };
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Content-Type", mimeMap[ext] || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(fileName)}"`);
    res.sendFile(p);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// docx → 纯文本（供 agent 在无 officecli 环境读取 docx 内容）
app.get(/^\/api\/doc\/(.+)\/text$/, async (req, res) => {
  const fileName = decodeURIComponent(req.params[0]);
  const p = resolvePath(fileName);
  if (!p || !/\.docx$/i.test(p)) return res.status(404).json({ error: "not found" });
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(fs.readFileSync(p));
    const xml = await zip.file("word/document.xml")?.async("string");
    if (!xml) return res.status(400).json({ error: "no document.xml" });
    const paras = [];
    for (const m of xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
      const text = [...m[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((t) => t[1]).join("").trim();
      if (text) paras.push(text);
    }
    res.json({ name: fileName, text: paras.join("\n") });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// open document
app.get(/^\/api\/doc\/(.+)$/, async (req, res, next) => {
  const fileName = decodeURIComponent(req.params[0]);
  if (/(?:^|\/)(?:raw|text|html|comments|watch)(?:\/stop)?$/.test(fileName)) return next();
  // 支持按调用方指定的工作区解析（产物可能属于其他工作区，不能只看全局当前工作区）
  const requestedCwd = normalizeWorkspace(String(req.query.cwd || "")) || undefined;
  const p = resolvePath(fileName, requestedCwd);
  if (!p) return res.status(404).json({ error: "not found" });
  const ext = path.extname(p).slice(1).toLowerCase();
  const cwdQuery = requestedCwd ? `?cwd=${encodeURIComponent(requestedCwd)}` : "";
  // 记录当前工作文件（前端传 client 参数）
  const client = req.query.client;
  const thread = req.query.thread;
  if (client) {
    try { agentManager.setCurrentFile(agentKey(client, thread), fileName); } catch {}
  }
  try {
    if (ext === "xlsx" || ext === "xls") {
      const wb = await readWorkbook(p);
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.json({ kind: "xlsx", name: fileName, ...wb });
    } else if (["md", "markdown", "txt", "csv", "json"].includes(ext)) {
      const content = fs.readFileSync(p, "utf8");
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.json({ kind: "text", name: fileName, content, ext });
    } else if (ext === "html" || ext === "htm") {
      const content = fs.readFileSync(p, "utf8");
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.json({ kind: "htmlfile", name: fileName, content });
    } else if (ext === "pdf") {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.json({ kind: "pdf", name: fileName, ext, url: `/api/doc/${encodeURIComponent(fileName)}/raw${cwdQuery}` });
    } else {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.json({ kind: "html", name: fileName, ext, url: `/api/doc/${encodeURIComponent(fileName)}/html${cwdQuery}` });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// OfficeCLI 只能渲染 docx/xlsx/pptx。老式 .doc/.wps 或渲染失败时返回占位页，
// 避免 iframe 一片空白让用户以为"预览坏了"。
function previewUnsupportedPage(fileName, ext, detail) {
  const safeName = String(fileName || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const tips = {
    doc: "老式 .doc 二进制格式不被预览引擎支持。请用 WPS/Word 打开后另存为 .docx，即可在规聚中正常预览。",
    wps: "WPS 专有格式不被预览引擎支持。请用 WPS 打开后另存为 .docx。",
  }[String(ext || "").toLowerCase()] || "该格式暂不支持内嵌预览。";
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${safeName}</title>
<style>body{margin:0;font:14px/1.7 -apple-system,"Microsoft YaHei",sans-serif;background:#f5f6f8;color:#2b2f36;display:flex;align-items:center;justify-content:center;height:100vh}
.card{max-width:520px;background:#fff;border:1px solid #e3e6eb;border-radius:12px;padding:28px 32px;box-shadow:0 6px 20px rgba(15,23,42,.06)}
h1{font-size:16px;margin:0 0 10px}.ext{display:inline-block;font-size:12px;color:#7a8291;border:1px solid #e3e6eb;border-radius:6px;padding:1px 6px;margin-left:6px}
p{margin:8px 0;color:#4b5563}.file{font-weight:600;color:#111827;word-break:break-all}
.err{margin-top:12px;font-size:12px;color:#9aa1ad}</style></head>
<body><div class="card"><h1>无法内嵌预览<span class="ext">.${String(ext || "").toLowerCase()}</span></h1>
<p class="file">${safeName}</p><p>${tips}</p>
<p>也可以让 Agent 直接读取或转换该文件（例如另存为 .docx 后再预览）。</p>
${detail ? `<div class="err">渲染引擎信息：${String(detail).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}</div>` : ""}
</div></body></html>`;
}

// rendered html for docx/pptx (iframe target)
app.get(/^\/api\/doc\/(.+)\/html$/, async (req, res) => {
  const fileName = decodeURIComponent(req.params[0]);
  const requestedCwd = normalizeWorkspace(String(req.query.cwd || "")) || undefined;
  const p = resolvePath(fileName, requestedCwd);
  if (!p) return res.status(404).send("not found");
  try {
    const html = await renderHtml(p);
    // 老式 .doc/.wps 会被渲染成空字符串；直接 send("") 就是一片空白。
    if (!html || !String(html).trim()) return res.send(previewUnsupportedPage(fileName, path.extname(p).slice(1).toLowerCase()));
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.send(html);
  } catch (e) {
    res.status(500).send(previewUnsupportedPage(fileName, path.extname(p).slice(1).toLowerCase(), e.message));
  }
});

// watch 模式：启动/获取某文件的实时预览地址（docx/pptx）
// 获取批注列表：docx/pptx 用 officecli；md/txt 从 agent 会话提取修订记录
app.get(/^\/api\/doc\/(.+)\/comments$/, async (req, res) => {
  const fileName = decodeURIComponent(req.params[0]);
  const p = resolvePath(fileName);
  if (!p) return res.status(404).json({ error: "not found" });
  res.setHeader("Cache-Control", "no-store, max-age=0");
  const ext = path.extname(p).slice(1).toLowerCase();
  try {
    if (ext === "md" || ext === "markdown" || ext === "txt") {
      // 从 agent 会话中提取与该文件相关的修改指令（模拟批注/修订记录）
      const comments = [];
      for (const f of listSessionFiles()) {
        try {
          const text = readSessionTextCached(f);
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
    const r = await queryComments(p);
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

app.get(/^\/api\/doc\/(.+)\/watch$/, async (req, res) => {
  const fileName = decodeURIComponent(req.params[0]);
  const p = resolvePath(fileName);
  if (!p) return res.status(404).json({ error: "not found" });
  try {
    const entry = await startWatch(p);
    if (entry.error) return res.status(500).json({ ok: false, error: entry.error });
    res.json({ ok: true, url: `http://localhost:${entry.port}`, port: entry.port });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 停止某文件的 watch
app.post(/^\/api\/doc\/(.+)\/watch\/stop$/, (req, res) => {
  const fileName = decodeURIComponent(req.params[0]);
  const p = resolvePath(fileName);
  if (p) stopWatch(p);
  res.json({ ok: true });
});

// apply xlsx cell edits (batch)
app.post(/^\/api\/doc\/(.+)\/cells$/, async (req, res) => {
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
    const r = await withWriteLockAsync({ workspace: getWorkspace(), targetPath: p, runId: `ui_${crypto.randomUUID()}`, kind: "office_ui" }, () => batch(p, commands));
    if (r.json?.error || (r.code != null && Number(r.code) !== 0) || r.json?.data?.results?.some((item) => item.error)) {
      return respondWorkspaceFileError(req, res, normalizeOfficeFailure(new Error(r.stderr || r.text || r.json?.error || "Excel 单元格保存失败"), commands, r));
    }
    res.json({ ok: !r.json?.error, result: r.json || r.text });
  } catch (e) {
    respondWorkspaceFileError(req, res, e);
  }
});

// generic officecli passthrough (toolbar actions, future use)
app.post("/api/office", async (req, res) => {
  const { args } = req.body || {};
  if (!Array.isArray(args)) return res.status(400).json({ error: "args required" });
  const normalizedArgs = args.map(String);
  const allowedCommands = new Set(["view", "get", "set", "batch", "query", "watch", "close"]);
  if (!allowedCommands.has(normalizedArgs[0])) {
    return res.status(400).json({ error: "unsupported office command", allowed: [...allowedCommands] });
  }
// 只校验文件参数（args[1]）：DOM 路径如 /、/body/p[1] 在 Windows 上会被
  // path.isAbsolute 误判为绝对路径，不能对整个 args 做绝对路径检查。
  const fileArg = normalizedArgs[1] || "";
  if (fileArg && (path.isAbsolute(fileArg) || fileArg.split(/[\\/]/).includes(".."))) {
    return res.status(400).json({ error: "office paths must stay inside the workspace" });
  }
  const mutating = new Set(["set", "batch"]).has(normalizedArgs[0]);
  const workspace = getWorkspace();
  const targetPath = mutating ? resolvePath(normalizedArgs[1], workspace) : null;
  if (mutating && !targetPath) return res.status(400).json({ ok: false, code: "WRITE_SCOPE_ERROR", error: "Office 文件必须是当前工作区内的现有文件" });
  try {
    const execute = () => runOfficecli(normalizedArgs, { cwd: workspace });
    const r = mutating
      ? await withWriteLockAsync({ workspace, targetPath, runId: `ui_${crypto.randomUUID()}`, kind: "office_ui" }, execute)
      : await execute();
    if (Number(r.code) !== 0) {
      const officeError = new Error(r.stderr || r.text || `Office CLI 退出码 ${r.code}`);
      officeError.exitCode = r.code;
      return respondWorkspaceFileError(req, res, normalizeOfficeFailure(officeError, normalizedArgs, r));
    }
    res.json({ ok: true, code: r.code, stdout: r.stdout, stderr: r.stderr, json: r.json, requestId: req.requestId });
  } catch (e) {
    if (e?.code === "OFFICECLI_TIMEOUT") return res.status(504).json({ ok: false, code: e.code, error: e.message, requestId: req.requestId });
    respondWorkspaceFileError(req, res, e);
  }
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
    const r = await withWriteLockAsync({ workspace: getWorkspace(), targetPath: p, runId: `ui_${crypto.randomUUID()}`, kind: "office_ui" }, () => batch(p, normalized));
    if (r.json?.error || (r.code != null && Number(r.code) !== 0) || r.json?.data?.results?.some((x) => x.error)) {
      return respondWorkspaceFileError(req, res, normalizeOfficeFailure(new Error(r.stderr || r.text || r.json?.error || "编辑失败"), normalized, r));
    }
    res.json({ ok: true, result: r.json || r.text });
  } catch (e) {
    respondWorkspaceFileError(req, res, e);
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
    const result = writeWorkspaceFile({ workspace: getWorkspace(), targetPath: p, content: buf, kind: "ui_docx_save" });
    res.json({ ...result, size: buf.length });
  } catch (e) {
    respondWorkspaceFileError(req, res, e);
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
function agentKey(client, thread) {
  const c = String(client || "").trim();
  const t = String(thread || "").trim();
  return t ? `${c}::${t}` : c;
}

const MODEL_CONFIG_APIS = new Set(["openai-completions", "anthropic-messages", "openai-codex-responses"]);

function validateModelConfigInput(input = {}) {
  const provider = String(input.provider || "").trim();
  const baseUrl = String(input.baseUrl || "").trim().replace(/\/+$/, "");
  const api = String(input.api || "openai-completions").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(provider)) throw new Error("供应商 ID 需为 2-64 位英文、数字、点、下划线或短横线");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("接口地址必须以 http:// 或 https:// 开头");
  if (!MODEL_CONFIG_APIS.has(api)) throw new Error("不支持的供应商协议");
  const models = Array.isArray(input.models) ? input.models : [];
  if (!models.length) throw new Error("至少配置一个模型");
  const normalizedModels = models.slice(0, 100).map((item) => {
    const id = String(item?.id || "").trim();
    if (!/^[^/\\\s]{1,160}$/.test(id)) throw new Error("模型 ID 不能为空，且不能包含斜线或空格");
    const contextWindow = Number(item?.contextWindow);
    return {
      id,
      name: String(item?.name || id).trim().slice(0, 160) || id,
      ...(contextWindow > 0 ? { contextWindow: Math.floor(contextWindow) } : {}),
      reasoning: item?.reasoning !== false,
      input: item?.vision === true ? ["text", "image"] : ["text"],
      enabled: item?.enabled !== false,
    };
  });
  return {
    provider,
    name: String(input.name || provider).trim().slice(0, 160) || provider,
    api,
    baseUrl,
    enabled: input.enabled !== false,
    models: normalizedModels,
    apiKey: String(input.apiKey || "").trim(),
    clearApiKey: input.clearApiKey === true,
  };
}

function publicModelConfigs() {
  const config = readModelsConfig() || {};
  const auth = listAuth() || {};
  const credentialErrors = getCredentialErrors();
  return Object.entries(config.providers || {}).map(([provider, value]) => ({
    provider,
    name: value?.name || provider,
    api: value?.api || "openai-completions",
    baseUrl: value?.baseUrl || "",
    enabled: value?.enabled !== false,
    keyConfigured: Boolean(auth[provider]?.key || auth[provider]?.token || auth[provider]?.secret),
    authError: credentialErrors[provider]?.message || null,
    models: (Array.isArray(value?.models) ? value.models : []).map((model) => ({
      id: model.id,
      name: model.name || model.id,
      contextWindow: Number(model.contextWindow || model.contextLength || 0) || null,
      reasoning: model.reasoning !== false,
      vision: Array.isArray(model.input) && model.input.includes("image"),
      enabled: model.enabled !== false,
    })),
  }));
}

app.get("/api/models", async (_req, res) => {
  try {
    const catalog = await agentManager.listModelCatalog();
    const models = catalog.models;
    // enrich vision flags from models-store.json (input includes "image")
    const store = loadModelsStore();
    for (const m of models) {
      const provCfg = store[m.provider];
      const cfg = provCfg?.models?.find((x) => x.id === String(m.id).slice(String(m.id).indexOf("/") + 1));
      if (cfg) m.vision = (cfg.input || []).includes("image") || !!m.vision;
    }
    res.json({ ...catalog, models, default: loadSettingsDefault() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/agent/model-configs", (_req, res) => {
  res.json({ configs: publicModelConfigs() });
});

app.post("/api/agent/model-configs", async (req, res) => {
  try {
    const input = validateModelConfigInput(req.body || {});
    // 模型未填上下文窗口时，从 Pi 目录按同名模型自动补全，让压缩阈值按真实窗口计算
    if (input.models.some((model) => !model.contextWindow)) {
      try {
        const catalog = await agentManager.listModelCatalog();
        const known = new Map((catalog.models || []).map((m) => [String(m.id).split("/").pop(), Number(m.contextWindow || m.contextLength || 0)]));
        for (const model of input.models) {
          if (!model.contextWindow && known.has(String(model.id).split("/").pop())) {
            const window = known.get(String(model.id).split("/").pop());
            if (window > 0) model.contextWindow = window;
          }
        }
      } catch {}
    }
    const config = readModelsConfig() || {};
    const providers = config.providers && typeof config.providers === "object" ? config.providers : {};
    const previous = providers[input.provider] && typeof providers[input.provider] === "object" ? providers[input.provider] : {};
    writeModelsConfig({
      ...config,
      providers: {
        ...providers,
        [input.provider]: {
          ...previous,
          name: input.name,
          api: input.api,
          baseUrl: input.baseUrl,
          enabled: input.enabled,
          models: input.models.map(({ id, name, contextWindow, reasoning, input: modelInput, enabled }) => ({ id, name, api: input.api, baseUrl: input.baseUrl, ...(contextWindow ? { contextWindow } : {}), reasoning, input: modelInput, enabled })),
        },
      },
    });
    if (input.apiKey) await setApiKey(input.provider, input.apiKey);
    else if (input.clearApiKey) await removeApiKey(input.provider);
    piRuntimeManager.resetModelRuntime();
    res.json({ ok: true, config: publicModelConfigs().find((item) => item.provider === input.provider) || null });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message, code: "MODEL_CONFIG_INVALID" });
  }
});

app.delete("/api/agent/model-configs/:provider", async (req, res) => {
  const provider = String(req.params.provider || "").trim();
  const config = readModelsConfig() || {};
  const providers = config.providers && typeof config.providers === "object" ? { ...config.providers } : {};
  if (!providers[provider]) return res.status(404).json({ ok: false, error: "供应商不存在" });
  delete providers[provider];
  writeModelsConfig({ ...config, providers });
  await removeApiKey(provider);
  piRuntimeManager.resetModelRuntime();
  res.json({ ok: true, provider });
});

// 从供应商接口地址拉取模型列表（OpenAI 兼容 GET /models），供前端一键导入
app.post("/api/agent/model-configs/fetch-models", async (req, res) => {
  const { provider, baseUrl, apiKey } = req.body || {};
  let url = String(baseUrl || "").trim().replace(/\/+$/, "");
  let key = String(apiKey || "").trim();
  if (!url && provider) {
    const config = readModelsConfig() || {};
    const entry = config.providers?.[provider];
    url = String(entry?.baseUrl || "").trim().replace(/\/+$/, "");
    const auth = listAuth() || {};
    key = String(auth[provider]?.key || auth[provider]?.apiKey || auth[provider]?.token || "").trim();
  }
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: "接口地址必须以 http:// 或 https:// 开头", code: "MODELS_FETCH_INVALID_URL" });
  if (!key) return res.status(400).json({ ok: false, error: "缺少 API Key：请先保存凭据，或临时填写 Key", code: "MODELS_FETCH_NO_KEY" });
  const adapter = createPiNetworkAdapter();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await adapter.fetch(`${url}/models`, {
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const message = String(error?.oawNetwork?.message || error?.message || error).slice(0, 300);
      const code = error?.oawNetwork?.code || "MODELS_FETCH_NETWORK";
      return res.status(502).json({ ok: false, error: message, code });
    }
    clearTimeout(timer);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = String(body?.error?.message || body?.message || body?.detail || `HTTP ${response.status}`).slice(0, 300);
      return res.status(502).json({
        ok: false,
        error: `接口返回 ${response.status}：${message}`,
        code: response.status === 401 || response.status === 403 ? "MODELS_FETCH_AUTH" : "MODELS_FETCH_FAILED",
      });
    }
    const ids = Array.isArray(body?.data) ? body.data.map((item) => String(item?.id || "").trim()).filter(Boolean) : [];
    if (!ids.length) return res.status(422).json({ ok: false, error: "接口未返回模型列表（响应缺少 data[]）", code: "MODELS_FETCH_EMPTY" });
    res.json({ ok: true, models: [...new Set(ids)], count: [...new Set(ids)].length, fetchedAt: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error).slice(0, 300), code: "MODELS_FETCH_UNEXPECTED" });
  } finally {
    adapter.close();
  }
});

// 重新扫描模型（重置 ModelRuntime 缓存，重新读取 models.json）
app.post("/api/models/refresh", async (_req, res) => {
  try {
    const models = await agentManager.refreshModels();
    const catalog = await agentManager.listModelCatalog();
    res.json({ ok: true, ...catalog, models, count: models.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/agent/model", async (req, res) => {
  const { client, thread, model } = req.body || {};
  if (!client || !model) return res.status(400).json({ error: "client and model required" });
  try {
    res.json(await agentManager.setModel(agentKey(client, thread), model));
  } catch (e) {
    recordAgentDiagnostic(req, { client, thread, model: String(model), error: e });
    res.status(500).json({ error: e.message });
  }
});

// 保存 OpenAI/Anthropic 兼容的自定义供应商模型配置；API Key 仍单独存入凭据文件。
app.post("/api/agent/custom-provider", (req, res) => {
  const provider = String(req.body?.provider || "").trim();
  const baseUrl = String(req.body?.baseUrl || "").trim().replace(/\/+$/, "");
  const api = String(req.body?.api || "openai-completions").trim();
  const modelId = String(req.body?.modelId || "").trim();
  const modelName = String(req.body?.modelName || modelId).trim() || modelId;
  const allowedApis = new Set(["openai-completions", "anthropic-messages", "openai-codex-responses"]);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(provider)) return res.status(400).json({ ok: false, error: "供应商 ID 需为 2-64 位英文、数字、点、下划线或短横线", code: "CUSTOM_PROVIDER_INVALID" });
  if (!/^https?:\/\//i.test(baseUrl)) return res.status(400).json({ ok: false, error: "接口地址必须以 http:// 或 https:// 开头", code: "CUSTOM_BASE_URL_INVALID" });
  if (!allowedApis.has(api)) return res.status(400).json({ ok: false, error: "暂只支持 OpenAI Completions、Anthropic Messages 或 OpenAI Responses", code: "CUSTOM_API_INVALID" });
  if (!/^[^/\\\s]{1,160}$/.test(modelId)) return res.status(400).json({ ok: false, error: "模型 ID 不能为空，且不能包含斜线或空格", code: "CUSTOM_MODEL_INVALID" });
  try {
    const config = readModelsConfig() || {};
    const providers = config.providers && typeof config.providers === "object" ? config.providers : {};
    const previous = providers[provider] && typeof providers[provider] === "object" ? providers[provider] : {};
    const previousModels = Array.isArray(previous.models) ? previous.models : [];
    const previousModel = previousModels.find((item) => item?.id === modelId) || {};
    const model = {
      ...previousModel,
      id: modelId,
      name: modelName.slice(0, 160),
      api,
      baseUrl,
      reasoning: req.body?.reasoning !== false,
      ...(req.body?.vision === true ? { input: ["text", "image"] } : { input: ["text"] }),
      ...(Number(req.body?.contextWindow) > 0 ? { contextWindow: Math.floor(Number(req.body.contextWindow)) } : {}),
    };
    // 凭据只允许进入 auth.json；即使更新旧模型，也清理历史上可能残留的密钥字段。
    delete model.apiKey;
    delete model.api_key;
    const nextProvider = { ...previous, api, baseUrl, models: [...previousModels.filter((item) => item?.id !== modelId), model] };
    delete nextProvider.apiKey;
    writeModelsConfig({ ...config, providers: { ...providers, [provider]: nextProvider } });
    piRuntimeManager.resetModelRuntime();
    res.json({ ok: true, provider, model: `${provider}/${modelId}`, modelName: model.name, api, baseUrl });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message, code: "CUSTOM_PROVIDER_SAVE_FAILED" });
  }
});

// 使用 Pi 的真实 ModelRuntime 做最小请求探测，不改写用户会话和工作区文件。
app.post("/api/agent/model/probe", async (req, res) => {
  const { model, timeoutMs } = req.body || {};
  if (!model) return res.status(400).json({ ok: false, error: "model required", code: "MODEL_REQUIRED" });
  const startedAt = Date.now();
  try {
    res.json(await agentManager.probeModel(model, { timeoutMs }));
  } catch (error) {
    const diagnostic = recordAgentDiagnostic(req, { model: String(model), error });
    res.json({
      ok: false,
      model: String(model),
      latencyMs: Date.now() - startedAt,
      diagnostic: {
        code: diagnostic.errorCode,
        status: diagnostic.providerStatus,
        category: diagnostic.errorCategory || null,
        retryable: diagnostic.retryable,
        message: diagnostic.message,
      },
    });
  }
});

// ---------- Pi Runtime 管理（只返回脱敏快照） ----------
app.get("/api/agent/runtimes", (_req, res) => {
  res.json(agentManager.listRuntimes());
});

app.get("/api/agent/runtime", (req, res) => {
  const client = String(req.query.client || "").trim();
  if (!client) return res.status(400).json({ error: "client required" });
  const key = agentKey(client, req.query.thread);
  res.json({ runtime: agentManager.runtimeHealth(key), usage: agentManager.usageSnapshot(key) });
});

app.get("/api/agent/diagnostics", async (req, res) => {
  const client = String(req.query.client || "").trim();
  const thread = String(req.query.thread || "").trim();
  const runtime = client ? agentManager.runtimeHealth(agentKey(client, thread)) : null;
  const runtimeList = agentManager.listRuntimes();
  const auth = listAuth();
  let catalog = null;
  let catalogError = null;
  try {
    const value = await agentManager.listModelCatalog();
    const selected = runtime?.model?.provider && runtime?.model?.id
      ? `${runtime.model.provider}/${runtime.model.id}`
      : loadSettingsDefault();
    const selectedCatalog = value.models.find((item) => item.id === selected) || null;
    catalog = {
      selected,
      selectedInCatalog: Boolean(selectedCatalog),
      selectedAvailable: selectedCatalog?.available ?? null,
      counts: value.counts,
      source: value.source,
    };
  } catch (error) {
    catalogError = String(error?.message || error);
  }
  const selectedProvider = runtime?.model?.provider || String(loadSettingsDefault()).split("/")[0] || null;
  const authProviders = Object.fromEntries(
    Object.entries(auth).map(([provider, value]) => [provider, { type: value?.type || "unknown", set: Boolean(value) }])
  );
  res.json({
    ok: true,
    service: { version: pkg.version, pid: process.pid },
    requestId: req.requestId,
    model: { ... (catalog || { selected: loadSettingsDefault(), selectedInCatalog: null, selectedAvailable: null }), authProvider: selectedProvider, authConfigured: Boolean(selectedProvider && auth[selectedProvider]), catalogError },
    runtime,
    scheduler: runtimeList.scheduler,
    recentFailures: readRecentAgentDiagnostics({ client, thread, runId: req.query.runId, limit: req.query.limit }).map((item) => ({ ...item, hint: agentFailureHint(item) })),
    authProviders,
    authErrors: getCredentialErrors(),
    network: piRuntimeManager.networkDiagnostics(),
  });
});

app.post("/api/agent/runtime/health", (req, res) => {
  const { client, thread } = req.body || {};
  if (!client) return res.status(400).json({ error: "client required" });
  res.json({ runtime: agentManager.runtimeHealth(agentKey(client, thread)) });
});

app.get("/api/agent/evaluations", async (req, res) => {
  const client = String(req.query.client || "").trim();
  const thread = String(req.query.thread || "").trim();
  const workspace = normalizeWorkspace(req.query.cwd || getWorkspace()) || getWorkspace();
  const runtime = client ? agentManager.runtimeHealth(agentKey(client, thread)) : null;
  res.json(await runRuntimeEvaluation({ workspace, runtime, probeOffice: String(req.query.probeOffice || "") === "true" }));
});

app.post("/api/agent/runtime/restart", async (req, res) => {
  const { client, thread, sessionId, cwd } = req.body || {};
  if (!client || !thread || !sessionId) return res.status(400).json({ error: "client, thread and sessionId required" });
  const found = findSessionFile(sessionId);
  if (!found) return res.status(404).json({ error: "session not found", code: "SESSION_NOT_FOUND" });
  try {
    const workspace = normalizeWorkspace(cwd || getWorkspace()) || getWorkspace();
    const result = await agentManager.restartRuntime(agentKey(client, thread), { threadId: thread, sessionPath: found.fullPath, cwd: workspace });
    annotateSessionThread(result.sessionId, thread);
    res.json(result);
  } catch (error) {
    res.status(409).json({ error: error.message, code: error.code || "RUNTIME_RESTART_FAILED" });
  }
});

// ---------- agent API Key（模型登录/密钥配置，auth.json） ----------
function maskKey(key) {
  const k = String(key || "");
  return k.length <= 8 ? "****" : k.slice(0, 3) + "****" + k.slice(-4);
}

app.get("/api/agent/auth", (_req, res) => {
  const auth = listAuth();
  res.json({
    providers: Object.fromEntries(
      Object.entries(auth).map(([p, v]) => [p, { type: v.type, masked: maskKey(v.key), set: true }])
    ),
    authErrors: getCredentialErrors(),
  });
});

app.post("/api/agent/auth", async (req, res) => {
  const { provider, key } = req.body || {};
  if (!provider || !key) return res.status(400).json({ error: "provider and key required" });
  try {
    res.json(await setApiKey(provider, key));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/agent/auth/remove", async (req, res) => {
  const { provider } = req.body || {};
  if (!provider) return res.status(400).json({ error: "provider required" });
  res.json(await removeApiKey(provider));
});

// ---------- sessions ----------
// 新会话和显式导入的旧会话都只存放在项目目录；常态运行不扫描本地 Pi 会话。
const SESSIONS_DIR = path.join(PROJECT_DIR, ".规聚会话");
const SESSION_READ_DIRS = [SESSIONS_DIR];
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
const SESSION_TEXT_CACHE_LIMIT = 400;
const sessionTextCache = new Map();
const sessionIdIndex = new Map();
// 会话头部（首行 64KB）与元数据（标题/归属/标记）的指纹缓存：
// 会话列表热调用只需要 stat 比对指纹，不再全量读取 200+ 个 JSONL。
// 元数据同时持久化到磁盘（.oaw/sessions-meta.json），服务重启后无需冷扫描。
const SESSION_HEADER_BYTES = 65536;
const SESSION_HEAD_SCAN_BYTES = 512 * 1024;
const SESSION_CACHE_LIMIT = 800;
const SESSION_META_STORE = path.join(PROJECT_DIR, ".oaw", "sessions-meta.json");
const sessionHeaderCache = new Map();
const sessionMetaCache = new Map();
const persistedSessionMeta = new Map();
let sessionMetaStoreLoaded = false;
let sessionMetaDirty = false;
let sessionMetaFlushTimer = null;

function loadPersistedSessionMeta() {
  if (sessionMetaStoreLoaded) return;
  sessionMetaStoreLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_META_STORE, "utf8"));
    for (const [key, value] of Object.entries(raw?.entries || {})) {
      if (value?.fingerprint && value?.meta) persistedSessionMeta.set(key, value);
    }
  } catch {}
}

function scheduleSessionMetaFlush() {
  sessionMetaDirty = true;
  if (sessionMetaFlushTimer) return;
  sessionMetaFlushTimer = setTimeout(() => {
    sessionMetaFlushTimer = null;
    if (!sessionMetaDirty) return;
    sessionMetaDirty = false;
    try {
      const alive = new Set(listSessionFiles().map((file) => file.fullPath));
      const entries = {};
      for (const [key, value] of sessionMetaCache.entries()) {
        if (alive.has(key)) entries[key] = { fingerprint: value.fingerprint, meta: value.meta };
      }
      fs.mkdirSync(path.dirname(SESSION_META_STORE), { recursive: true });
      atomicWriteJson(SESSION_META_STORE, { version: 1, savedAt: new Date().toISOString(), entries });
    } catch {}
  }, 1500);
}

// ---------- 规聚独立 Pi 配置 ----------
app.get("/api/agent/config-status", (_req, res) => {
  try {
    res.json(getConfigStatus());
  } catch (error) {
    res.status(500).json({ error: error.message, code: "CONFIG_STATUS_FAILED" });
  }
});

// ---------- 联网搜索配置 ----------
app.get("/api/search/settings", (_req, res) => {
  try {
    res.json({ ok: true, backends: searchModule.SEARCH_BACKENDS, settings: searchModule.publicSearchSettings() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/search/settings", (req, res) => {
  try {
    const settings = searchModule.saveSearchSettings(req.body || {});
    res.json({ ok: true, settings });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/search/test", async (req, res) => {
  try {
    const result = await searchModule.testSearchBackend(req.body?.backend || "");
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

// ---------- 内置浏览器（画面流 / 用户接管） ----------
app.get("/api/browser/state", (req, res) => {
  const client = String(req.query.client || "");
  const thread = String(req.query.thread || "");
  const key = browserModule.browserSessionKey(client, thread);
  const session = browserModule.getBrowserSession(key);
  res.json({ ok: true, state: session ? session.stateView() : { active: false, url: "", title: "", loading: false, hasFrame: false } });
});

app.post("/api/browser/open", async (req, res) => {
  const { client, thread, url } = req.body || {};
  if (!client) return res.status(400).json({ ok: false, error: "client required" });
  const key = browserModule.browserSessionKey(client, thread);
  try {
    const state = await browserModule.browserOpen(key, String(url || "").trim() || "https://cn.bing.com");
    res.json({ ok: true, state });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error), code: error?.code || null });
  }
});

app.get("/api/browser/stream", (req, res) => {
  const client = String(req.query.client || "");
  const thread = String(req.query.thread || "");
  const withFrames = req.query.frames !== "0";
  if (!client) return res.status(400).end();
  const key = browserModule.browserSessionKey(client, thread);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  let closed = false;
  let unsubscribe = () => {};
  let heartbeat = null;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
  };
  const write = (payload) => {
    if (closed) return;
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { cleanup(); }
  };
  heartbeat = setInterval(() => {
    if (closed) return;
    try { res.write(`event: heartbeat\ndata: {"at":"${new Date().toISOString()}"}\n\n`); } catch { cleanup(); }
  }, 15000);
  const session = browserModule.getBrowserSession(key);
  write({ type: "state", data: session ? session.stateView() : { active: false, url: "", title: "", loading: false, hasFrame: false } });
  if (session?.state?.active) session.refreshTabs().catch(() => {});
  if (withFrames && session?.frame?.data) write({ type: "frame", data: {
    data: session.frame.data,
    at: session.frame.at,
    width: session.frame.width || session.state.viewport?.width || null,
    height: session.frame.height || session.state.viewport?.height || null,
  } });
  unsubscribe = browserModule.subscribeBrowser(key, (type, data) => {
    if (type === "frame" && !withFrames) return;
    write({ type, data });
  });
  req.on("close", cleanup);
});

app.post("/api/browser/input", async (req, res) => {
  const { client, thread, ...payload } = req.body || {};
  const key = browserModule.browserSessionKey(client, thread);
  try {
    const result = await browserModule.browserUserInput(key, payload);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error), code: error?.code || null });
  }
});

app.post("/api/browser/close", async (req, res) => {
  const { client, thread, force, reason } = req.body || {};
  const key = browserModule.browserSessionKey(client, thread);
  try {
    const result = await browserModule.browserClose(key, { force: force === true, reason: reason || "" });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/api/agent/import-preview", (_req, res) => {
  try {
    res.json(previewLocalPiConfig());
  } catch (error) {
    res.status(500).json({ error: error.message, code: "IMPORT_PREVIEW_FAILED" });
  }
});

app.post("/api/agent/import-config", async (req, res) => {
  try {
    const preview = previewLocalPiConfig();
    if (!preview.available) return res.status(404).json({ ok: false, error: "未检测到可导入的本地 Pi 配置", code: "LOCAL_PI_NOT_FOUND" });
    const enabled = (name, fallback = true) => req.body?.[name] === undefined ? fallback : req.body[name] === true;
    const result = importLocalPiConfig({
      includeModels: enabled("includeModels"),
      includeSettings: enabled("includeSettings"),
      includeCredentials: enabled("includeCredentials"),
    });
    if (!result.ok) return res.status(409).json(result);
    const sessions = enabled("includeSessions") ? importLocalPiSessions({ targetDir: SESSIONS_DIR }) : { ok: true, imported: 0, files: [] };
    sessionTextCache.clear();
    sessionIdIndex.clear();
    piRuntimeManager.resetModelRuntime();
    res.json({ ...result, sessions, status: getConfigStatus() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message, code: "PI_IMPORT_FAILED" });
  }
});

app.get("/api/agent/network-settings", (_req, res) => {
  try {
    res.json(readNetworkSettings());
  } catch (error) {
    res.status(500).json({ error: error.message, code: "NETWORK_SETTINGS_READ_FAILED" });
  }
});

app.patch("/api/agent/network-settings", (req, res) => {
  try {
    const mode = String(req.body?.mode || "").trim().toLowerCase();
    if (!["direct", "system", "manual"].includes(mode)) return res.status(400).json({ error: "连接方式必须是 direct、system 或 manual", code: "NETWORK_MODE_INVALID" });
    const current = readNetworkSettings();
    const keepExistingProxy = req.body?.keepExistingProxy === true;
    if (mode === "manual" && !String(req.body?.proxyUrl || "").trim() && !(keepExistingProxy && current.hasProxy)) {
      return res.status(400).json({ error: "手动代理模式需要填写代理地址", code: "PROXY_REQUIRED" });
    }
    const saved = saveNetworkSettings(req.body || {}, { preserveProxy: keepExistingProxy });
    const runtime = piRuntimeManager.updateNetworkSettings(loadNetworkSettings());
    res.json({ ...saved, runtime });
  } catch (error) {
    res.status(500).json({ error: error.message, code: "NETWORK_SETTINGS_SAVE_FAILED" });
  }
});

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
const SKILL_ROOTS = [
  path.join(AGENT_DIR, "skills"),
  path.join(process.env.USERPROFILE || os.homedir(), ".agents", "skills"),
  path.join(process.env.USERPROFILE || os.homedir(), ".claude", "skills"),
  path.join(PROJECT_DIR, ".agents", "skills"),
  path.join(PROJECT_DIR, ".pi", "skills"),
  path.join(PROJECT_DIR, ".claude", "skills"),
  // 用户实际工作根目录的 .claude skills（F:\Claude code本地文件\.claude\skills）
  "F:\\Claude code本地文件\\.claude\\skills",
];
// scanSkills 在每次 prompt admission 都会被调用；技能目录内容在会话期间基本不变，
// 用根目录 mtime 签名 + 短 TTL 缓存，避免每轮读取数百个 SKILL.md 拖慢首字节。
const SKILLS_CACHE_TTL_MS = 30000;
let skillsCache = { signature: "", results: null, expiresAt: 0 };

function skillsRootSignature() {
  let sig = "";
  for (const root of SKILL_ROOTS) {
    try { sig += `${root}:${fs.statSync(root).mtimeMs};`; } catch { sig += `${root}:missing;`; }
  }
  return sig;
}

function scanSkills() {
  const nowMs = Date.now();
  const signature = skillsRootSignature();
  if (skillsCache.results && skillsCache.signature === signature && nowMs < skillsCache.expiresAt) {
    return skillsCache.results;
  }
  const out = [];
  const seen = new Set();
  for (const root of SKILL_ROOTS) {
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
  const sorted = out.sort((a, b) => a.name.localeCompare(b.name));
  skillsCache = { signature, results: sorted, expiresAt: nowMs + SKILLS_CACHE_TTL_MS };
  return sorted;
}

function preflightSkill(name, skills = scanSkills()) {
  const cleanName = String(name || "").trim();
  const skill = skills.find((item) => item.name === cleanName);
  if (!skill) return { name: cleanName, ok: false, status: "missing", message: "未找到该 skill" };
  const skillFile = path.join(skill.path, "SKILL.md");
  const checks = { directory: false, file: false, readable: false, nonEmpty: false };
  try {
    checks.directory = fs.statSync(skill.path).isDirectory();
    checks.file = fs.statSync(skillFile).isFile();
    if (checks.file) {
      const content = fs.readFileSync(skillFile, "utf8");
      checks.readable = true;
      checks.nonEmpty = Boolean(content.trim());
    }
  } catch {}
  const ok = checks.directory && checks.file && checks.readable && checks.nonEmpty;
  return { name: cleanName, ok, status: ok ? "ready" : "invalid", path: skill.path, checks, message: ok ? "SKILL.md 可读取" : "SKILL.md 不存在、不可读取或为空" };
}

function preflightSkills({ workflowId = null, requestedSkills = [], skills = scanSkills() } = {}) {
  const workflow = workflowId ? getWorkflow(workflowId, skills) : null;
  const requested = Array.isArray(requestedSkills) ? requestedSkills : [];
  const names = [...new Set([...(workflow?.skills || []), ...requested].map((name) => String(typeof name === "object" ? name?.name : name || "").trim()).filter(Boolean))];
  const checks = names.map((name) => preflightSkill(name, skills));
  const workflowMissing = workflowId && !workflow ? [`工作流不存在：${workflowId}`] : (workflow?.missing || []);
  const ok = !workflowMissing.length && checks.every((item) => item.ok);
  return {
    ok,
    workflow: workflow ? { id: workflow.id, name: workflow.name, valid: workflow.valid } : (workflowId ? { id: workflowId, valid: false } : null),
    required: names,
    checks,
    missing: [...new Set([...workflowMissing, ...checks.filter((item) => !item.ok).map((item) => item.name)])],
    message: ok ? "Skills 预检通过" : `Skills 预检未通过：${[...new Set([...workflowMissing, ...checks.filter((item) => !item.ok).map((item) => item.name)])].join("、")}`,
  };
}

// GET /api/skills - 列出所有 skills
app.get("/api/skills", (_req, res) => {
  res.json({ skills: scanSkills() });
});

// POST /api/skills/preflight - 在 Agent 调用前检查工作流依赖和 SKILL.md 可读性
app.post("/api/skills/preflight", (req, res) => {
  const result = preflightSkills({ workflowId: req.body?.workflowId || null, requestedSkills: req.body?.skills || [] });
  res.status(result.ok ? 200 : 409).json(result);
});

// 声明式工作流注册表：返回技能依赖、可用性和执行步骤，供前端与 Agent 共用。
app.get("/api/workflows", (_req, res) => {
  res.json({ workflows: listWorkflows(scanSkills()) });
});

app.get("/api/workflows/:id/validate", (req, res) => {
  const workflow = getWorkflow(req.params.id, scanSkills());
  if (!workflow) return res.status(404).json({ ok: false, error: "workflow not found" });
  res.json({ ok: workflow.valid, workflow, message: workflow.valid ? "工作流依赖完整" : `缺少技能：${workflow.missing.join(", ")}` });
});

// 智能体广场：内置 Agent 保留只读，自定义 Agent 写入项目 .oaw 配置并可再次编辑。
app.get("/api/agents", (_req, res) => {
  res.json({ agents: listAgents() });
});

app.post("/api/agents", (req, res) => {
  const result = createAgent(req.body || {});
  res.status(result.ok ? 201 : 400).json(result);
});

app.patch("/api/agents/:id", (req, res) => {
  const result = updateAgent(req.params.id, req.body || {});
  res.status(result.ok ? 200 : 400).json(result);
});

app.delete("/api/agents/:id", (req, res) => {
  const result = deleteAgent(req.params.id);
  res.status(result.ok ? 200 : 400).json(result);
});

// ---------- 外部文件连接器 ----------
app.get("/api/connectors", (_req, res) => res.json({ connectors: listConnectors() }));
app.get("/api/connectors/:id", (req, res) => {
  const connector = getConnector(req.params.id);
  if (!connector) return res.status(404).json({ error: "connector not found" });
  res.json({ connector });
});
app.post("/api/connectors/:id/auth/start", (req, res) => {
  const result = beginConnectorAuth(req.params.id, req.body?.redirectUri);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});
app.post("/api/connectors/:id/status", (req, res) => {
  const result = setConnectorStatus(req.params.id, req.body || {});
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
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

function sessionBaseName(fileName) {
  return String(fileName || "").replace(/\.(?:jsonl|json)$/i, "");
}

// 递归扫描规聚项目会话目录；旧 Pi 会话只有显式导入后才会进入这里。
function listSessionFiles() {
  const candidates = [];
  function walk(dir, depth, storeDir) {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1, storeDir);
      } else if (e.isFile() && /\.jsonl$/i.test(e.name)) {
        try {
          const st = fs.statSync(full);
          candidates.push({ fileName: e.name, fullPath: full, storeDir, mtime: st.mtimeMs, size: st.size });
        } catch {}
      }
    }
  }
  for (const dir of SESSION_READ_DIRS) walk(dir, 0, dir);
  // 同一个会话迁移后可能同时存在于新旧目录；按 session id 去重，
  // 但保留旧目录中不同子目录下同名的独立会话。
  sessionIdIndex.clear();
  const preferred = candidates.sort((a, b) => {
    const aCurrent = a.storeDir === SESSIONS_DIR ? 1 : 0;
    const bCurrent = b.storeDir === SESSIONS_DIR ? 1 : 0;
    return bCurrent - aCurrent || b.mtime - a.mtime;
  });
  const seenIds = new Set();
  const out = [];
  for (const f of preferred) {
    let identity = `file:${f.fullPath}`;
    try {
      const h = readSessionHeaderCached(f);
      const sessionId = h?.id || h?.sessionId;
      if (sessionId) {
        identity = `id:${sessionId}`;
        f.sessionId = sessionId;
        if (!sessionIdIndex.has(sessionId)) sessionIdIndex.set(sessionId, f);
      }
    } catch {}
    if (seenIds.has(identity)) continue;
    seenIds.add(identity);
    out.push(f);
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function readSessionTextCached(foundOrPath) {
  const fullPath = typeof foundOrPath === "string" ? foundOrPath : foundOrPath?.fullPath;
  if (!fullPath) return "";
  let stat;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    sessionTextCache.delete(fullPath);
    return "";
  }
  const fingerprint = `${stat.mtimeMs}:${stat.size}`;
  const cached = sessionTextCache.get(fullPath);
  if (cached?.fingerprint === fingerprint) return cached.text;
  const text = fs.readFileSync(fullPath, "utf8");
  sessionTextCache.set(fullPath, { fingerprint, text });
  while (sessionTextCache.size > SESSION_TEXT_CACHE_LIMIT) {
    const oldest = sessionTextCache.keys().next().value;
    if (oldest === undefined) break;
    sessionTextCache.delete(oldest);
  }
  return text;
}

// 只读文件开头的前 N 字节（会话头部很小，无需为拿 header 全量读文件）
function readFileHead(fullPath, stat, maxBytes) {
  const size = Math.min(maxBytes, stat.size);
  if (size <= 0) return "";
  const buffer = Buffer.alloc(size);
  let fd = null;
  try {
    fd = fs.openSync(fullPath, "r");
    const read = fs.readSync(fd, buffer, 0, size, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function readSessionHeaderCached(foundOrPath) {
  const fullPath = typeof foundOrPath === "string" ? foundOrPath : foundOrPath?.fullPath;
  if (!fullPath) return null;
  let stat;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    sessionHeaderCache.delete(fullPath);
    return null;
  }
  const fingerprint = `${stat.mtimeMs}:${stat.size}`;
  const cached = sessionHeaderCache.get(fullPath);
  if (cached?.fingerprint === fingerprint) return cached.header;
  let header = null;
  try {
    const head = readFileHead(fullPath, stat, SESSION_HEADER_BYTES);
    const firstLine = head.indexOf("\n") >= 0 ? head.slice(0, head.indexOf("\n")) : head;
    header = JSON.parse(firstLine) || null;
  } catch {}
  sessionHeaderCache.set(fullPath, { fingerprint, header });
  while (sessionHeaderCache.size > SESSION_CACHE_LIMIT) {
    const oldest = sessionHeaderCache.keys().next().value;
    if (oldest === undefined) break;
    sessionHeaderCache.delete(oldest);
  }
  return header;
}

/**
 * 会话元数据（归属、标题、标记）：按 mtime+size 指纹缓存。
 * 只有文件变化时才重新扫描；标题扫描最多读取前 2MB，避免大文件全量解析。
 */
function sessionMetaFor(f) {
  loadPersistedSessionMeta();
  let stat;
  try {
    stat = fs.statSync(f.fullPath);
  } catch {
    sessionMetaCache.delete(f.fullPath);
    return null;
  }
  const fingerprint = `${stat.mtimeMs}:${stat.size}`;
  const cached = sessionMetaCache.get(f.fullPath);
  if (cached?.fingerprint === fingerprint) return cached.meta;
  // 服务重启后优先使用磁盘缓存：指纹一致则完全跳过文件解析
  const persisted = persistedSessionMeta.get(f.fullPath);
  if (persisted?.fingerprint === fingerprint) {
    sessionMetaCache.set(f.fullPath, persisted);
    return persisted.meta;
  }
  const header = readSessionHeaderCached(f) || {};
  const needsDeepScan = stat.size > SESSION_HEAD_SCAN_BYTES;
  let meta = null;
  try {
    const headText = readFileHead(f.fullPath, stat, Math.min(stat.size, SESSION_HEAD_SCAN_BYTES));
    meta = buildSessionMeta(f, header, headText, { truncated: needsDeepScan });
    // 标题区通常在文件前部；只有截断扫描未发现用户消息的大文件才回退全文读取
    if (needsDeepScan && !meta.foundUserMessage) {
      meta = buildSessionMeta(f, header, readSessionTextCached(f), { truncated: false });
    }
  } catch {
    meta = meta || buildSessionMeta(f, header, "", { truncated: false });
  }
  sessionMetaCache.set(f.fullPath, { fingerprint, meta });
  while (sessionMetaCache.size > SESSION_CACHE_LIMIT) {
    const oldest = sessionMetaCache.keys().next().value;
    if (oldest === undefined) break;
    sessionMetaCache.delete(oldest);
  }
  scheduleSessionMetaFlush();
  return meta;
}

function buildSessionMeta(f, h, text, { truncated = false } = {}) {
  const cwd = h.cwd || "";
  const isProjectSession = path.resolve(f.storeDir) === path.resolve(SESSIONS_DIR);
  const cwdLower = cwd.toLowerCase();
  const isOpenPlan = isProjectSession || cwdLower.includes("open plan") || cwdLower.includes("open-plan") || cwd.includes(PROJECT_DIR) || cwd === path.dirname(PROJECT_DIR);
  let title = "";
  let hasUserMessage = false;
  if (isOpenPlan && text) {
    let from = text.indexOf("\n");
    from = from >= 0 ? from + 1 : text.length;
    while (from < text.length) {
      let to = text.indexOf("\n", from);
      if (to === -1) to = text.length;
      const line = text.slice(from, to);
      from = to + 1;
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message?.role === "user") {
          const raw = messageText(entry);
          if (isSystemHintMessage(raw)) continue;
          hasUserMessage = true;
          const cleaned = cleanSessionTitle(raw);
          if (cleaned) { title = cleaned; break; }
        }
      } catch {}
    }
  }
  const foundUserMessage = hasUserMessage;
  // 截断扫描窗口内未找到时不轻易判定“没有用户消息”，避免长会话被隐藏
  if (truncated && !hasUserMessage) hasUserMessage = true;
  return {
    id: h.id || h.sessionId || sessionBaseName(f.fileName),
    threadId: h.threadId || null,
    cwd,
    isOaw: isOpenPlan,
    isProjectSession,
    label: h.label ? String(h.label).trim() : "",
    pinned: Boolean(h.pinned),
    frozen: Boolean(h.frozen),
    freezeReason: h.freezeReason || "",
    contextSnapshot: h.contextSnapshot || null,
    parentSessionId: h.parentSessionId || null,
    branchSourceMessageId: h.branchSourceMessageId || null,
    branchPurpose: h.branchPurpose || "",
    created: h.created || "",
    title,
    hasUserMessage,
    foundUserMessage,
  };
}

// 根据 id 查找对应的会话文件（先按文件名匹配，再按首行 session id 匹配）
function findSessionFile(id) {
  const files = listSessionFiles();
  const byName = files.find((f) => f.fileName === id + ".jsonl" || f.fileName === id + ".json" || f.fileName.startsWith(id));
  if (byName) return byName;
  const indexed = sessionIdIndex.get(String(id));
  if (indexed && files.some((f) => f.fullPath === indexed.fullPath)) return indexed;
  for (const f of files) {
    try {
      const text = readSessionTextCached(f);
      const firstLine = text.split(/\r?\n/)[0];
      if (!firstLine) continue;
      const h = JSON.parse(firstLine);
      if (h && (h.id === id || h.sessionId === id)) return f;
    } catch {}
  }
  return null;
}

function materializeWritableSession(found) {
  if (!found || found.storeDir === SESSIONS_DIR) return found;
  const target = path.join(SESSIONS_DIR, found.fileName);
  try {
    fs.copyFileSync(found.fullPath, target);
    return { ...found, fullPath: target, storeDir: SESSIONS_DIR };
  } catch (e) {
    throw new Error(`无法将旧 Pi 会话迁移到项目内可写目录：${e.message}`);
  }
}

function readSessionHeader(found) {
  if (!found?.fullPath) return {};
  try {
    const firstLine = readSessionTextCached(found).split(/\r?\n/)[0];
    return firstLine ? JSON.parse(firstLine) : {};
  } catch {
    return {};
  }
}

function updateSessionHeader(id, patch = {}) {
  const found = findSessionFile(id);
  if (!found) return { ok: false, status: 404, error: "not found" };
  try {
    const writable = materializeWritableSession(found);
    const lines = fs.readFileSync(writable.fullPath, "utf8").split(/\r?\n/);
    if (!lines[0]) return { ok: false, status: 400, error: "empty file" };
    const header = JSON.parse(lines[0]);
    const next = { ...header, ...patch, updatedAt: new Date().toISOString() };
    lines[0] = JSON.stringify(next);
    atomicWriteFile(writable.fullPath, lines.join("\n"), "utf8");
    sessionTextCache.delete(writable.fullPath);
    return { ok: true, header: next };
  } catch (error) {
    return { ok: false, status: 500, error: error.message };
  }
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

function annotateSessionThread(sessionId, threadId) {
  if (!sessionId || !threadId) return;
  const found = findSessionFile(sessionId);
  if (!found) return;
  const header = readSessionHeader(found);
  if (header.threadId === threadId) return;
  updateSessionHeader(sessionId, { threadId });
}

// ---------- 任务执行（run）与产物清单 ----------
app.get("/api/runs", (req, res) => {
  const rawCwd = String(req.query.cwd || "");
  const cwd = rawCwd ? (normalizeWorkspace(rawCwd) || "__invalid_workspace__") : "";
  const includeEvents = ["all", "none", "latest"].includes(String(req.query.includeEvents || ""))
    ? String(req.query.includeEvents)
    : "latest";
  res.json({ runs: listRuns({
    threadId: String(req.query.thread || ""),
    sessionId: String(req.query.session || ""),
    cwd,
    projectId: String(req.query.projectId || ""),
    status: String(req.query.status || ""),
    mode: String(req.query.mode || ""),
    query: String(req.query.query || ""),
    limit: parseInt(req.query.limit, 10) || 50,
    includeEvents,
  }) });
});

// 根级持久事件流：跨所有 thread 订阅当前 client 的可恢复状态事件。
app.get("/api/agent/events", (req, res) => {
  const clientId = String(req.query.client || "").trim();
  if (!clientId) return res.status(400).end();
  const threadId = String(req.query.thread || "").trim();
  const queryCursor = Number(req.query.after || 0) || 0;
  const headerCursor = Number(req.headers["last-event-id"] || 0) || 0;
  const after = Math.max(queryCursor, headerCursor);
  const replayLimit = Math.max(1, Math.min(2000, Number(req.query.limit || 2000) || 2000));
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let lastSent = after;
  const matches = (event) => event.clientId === clientId && (!threadId || event.threadId === threadId);
  const send = (event) => {
    if (!event || !matches(event) || Number(event.seq) <= lastSent) return;
    lastSent = Number(event.seq);
    try { res.write(`id: ${event.seq}\ndata: ${JSON.stringify({ event })}\n\n`); } catch {}
  };
  const unsubscribe = subscribeEvents(send);
  const replay = listEvents({ after, clientId, threadId, limit: replayLimit });
  for (const event of replay.events) send(event);
  try { res.write(`event: open\ndata: ${JSON.stringify({ cursor: lastSent, latest: replay.latest, earliest: replay.earliest, truncated: replay.truncated })}\n\n`); } catch {}
  req.on("close", unsubscribe);
});

app.get("/api/agent/events/state", (req, res) => {
  const clientId = String(req.query.client || "").trim();
  if (!clientId) return res.status(400).json({ error: "client required" });
  res.json({ ...eventStoreInfo(), readCursor: getReadCursor(clientId) });
});

app.post("/api/agent/events/read", (req, res) => {
  const { client, seq } = req.body || {};
  if (!client) return res.status(400).json({ error: "client and seq required" });
  res.json(markReadCursor(String(client), seq));
});

app.get("/api/runs/:id", (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "run not found" });
  res.json({ run });
});

app.post("/api/runs/:id/cancel", async (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "run not found" });
  if (!run.actions?.canCancel) return res.status(409).json({ error: `任务当前状态不可取消：${run.status}`, run });
  const pending = requestRunCancellation(run.id, String(req.body?.reason || "用户请求取消"));
  const key = agentKey(run.clientId, run.threadId);
  const live = agentManager.sessions?.get(key);
  try {
    if (live?.busy) {
      await agentManager.abort(key);
    } else {
      finishRun(run.id, { status: "cancelled", sessionId: run.sessionId, error: "任务在恢复前被取消", summary: "任务已取消" });
    }
    res.json({ ok: true, run: getRun(run.id), previous: pending });
  } catch (error) {
    res.status(409).json({ error: error.message, run: getRun(run.id) });
  }
});

app.post("/api/runs/:id/rollback", (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ error: "rollback requires confirm=true" });
  const result = rollbackRun(req.params.id, req.body?.paths);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.post("/api/runs/:id/steps/:stepId", (req, res) => {
  const run = updateRunStep(req.params.id, req.params.stepId, req.body || {});
  if (!run) return res.status(404).json({ error: "run or step not found" });
  res.json({ ok: true, run: getRun(req.params.id) });
});

app.get("/api/artifacts", (req, res) => {
  const cwd = req.query.cwd ? (normalizeWorkspace(req.query.cwd) || "__invalid_workspace__") : "";
  res.json({ artifacts: listPublishedArtifacts({ cwd, projectId: String(req.query.projectId || ""), limit: parseInt(req.query.limit, 10) || 200 }) });
});

app.post("/api/runs/:id/artifacts/:artifactId/publish", async (req, res) => {
  const result = await publishArtifact(req.params.id, req.params.artifactId, { rules: req.body?.rules || {}, operator: req.body?.operator });
  if (!result.ok) return res.status(result.status || 400).json(result);
  res.json(result);
});

app.post("/api/runs/:id/artifacts/:artifactId/accept", async (req, res) => {
  const result = await confirmArtifactAcceptance(req.params.id, req.params.artifactId, {
    note: req.body?.note,
    operator: req.body?.operator,
    rules: req.body?.rules || {},
  });
  if (!result.ok) return res.status(result.status || 400).json(result);
  res.json(result);
});

app.post("/api/artifacts/:publicationId/rollback", (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ error: "rollback requires confirm=true" });
  const result = rollbackPublishedArtifact(req.params.publicationId, { operator: req.body?.operator });
  if (!result.ok) return res.status(result.status || 400).json(result);
  res.json(result);
});

app.get("/api/runs/:id/acceptance", async (req, res) => {
  let rules = {};
  try { rules = req.query.rules ? JSON.parse(String(req.query.rules)) : {}; } catch { return res.status(400).json({ error: "rules 参数不是有效 JSON" }); }
  const result = await inspectRunAcceptance(req.params.id, rules);
  if (!result.ok) return res.status(result.status || 400).json(result);
  res.json(result);
});

// ---------- 项目管理：兼容现有 workspace，并为会话/Run 提供统一归属 ----------
app.get("/api/projects", (req, res) => {
  try {
    // 只自动登记当前工作区。历史 Pi 会话可能指向临时目录或用户目录，不能把它们批量污染项目列表。
    projectManager.ensureProjectForWorkspace(getWorkspace());
    const runs = listRuns({ limit: 200 });
    const proposals = agentManager.memoryProposals();
    const sessions = listSessionFiles().map((file) => {
      const header = readSessionHeader(file);
      return { cwd: header.cwd || "", projectId: header.projectId || "", id: header.id || header.sessionId || "" };
    }).filter((item) => item.id);
    const projectFilters = {
      type: String(req.query.type || ""),
      status: String(req.query.status || ""),
      pinned: req.query.pinned === undefined ? null : req.query.pinned === "true",
      sort: String(req.query.sort || "recent"),
    };
    const projects = projectManager.listProjects(projectFilters).map((project) => ({
      ...project,
      sessionCount: sessions.filter((session) => session.projectId === project.id || session.cwd === project.rootPath).length,
      runCount: runs.filter((run) => run.cwd === project.rootPath).length,
      artifactCount: runs.filter((run) => run.cwd === project.rootPath).reduce((count, run) => count + (run.artifacts?.length || 0), 0),
      unresolvedRunCount: runs.filter((run) => run.cwd === project.rootPath && ["running", "queued", "waiting_user", "recovering", "cancel_requested"].includes(run.status)).length,
      pendingMemoryCount: proposals.filter((item) => item.workspace === project.rootPath && item.status === "pending").length,
      approvedMemoryCount: proposals.filter((item) => item.workspace === project.rootPath && item.status === "approved").length,
      lastMemoryAt: proposals.filter((item) => item.workspace === project.rootPath).map((item) => item.approvedAt || item.createdAt).sort().pop() || null,
    }));
    res.json({ projects, types: projectManager.listProjectTypes(), statuses: projectManager.listProjectStatuses(), profiles: projectManager.listProjectProfiles(), defaultSettings: projectManager.defaultProjectSettings() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/projects", (req, res) => {
  const result = projectManager.createProject(req.body || {});
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.patch("/api/projects/:id", (req, res) => {
  const result = projectManager.updateProject(req.params.id, req.body || {});
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

app.get("/api/projects/:id/settings", (req, res) => {
  const project = projectManager.getProject(req.params.id);
  if (!project) return res.status(404).json({ ok: false, error: "project not found" });
  res.json({ ok: true, projectId: project.id, settings: projectManager.getProjectSettings(project.id) });
});

app.patch("/api/projects/:id/settings", (req, res) => {
  const result = projectManager.updateProjectSettings(req.params.id, req.body || {});
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

app.post("/api/projects/:id/archive", (req, res) => {
  const result = projectManager.archiveProject(req.params.id, req.body?.archived !== false);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

app.post("/api/projects/:id/pin", (req, res) => {
  const result = projectManager.updateProject(req.params.id, { pinned: req.body?.pinned !== false });
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

app.post("/api/sessions/:id/fork", (req, res) => {
  const found = findSessionFile(req.params.id);
  if (!found) return res.status(404).json({ error: "not found" });
  try {
    const source = readSessionTextCached(found);
    const lines = source.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return res.status(400).json({ error: "empty session" });
    const header = JSON.parse(lines[0]);
    const id = crypto.randomUUID();
    const label = String(req.body?.label || `${header.label || "会话"}（分支）`).trim();
    const nextHeader = {
      ...header,
      id,
      sessionId: id,
      threadId: id,
      parentSessionId: header.sessionId || header.id || req.params.id,
      branchSourceMessageId: String(req.body?.sourceMessageId || "") || null,
      branchPurpose: String(req.body?.purpose || "") || "从历史会话创建的独立分支",
      created: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      label,
      pinned: false,
      frozen: false,
    };
    lines[0] = JSON.stringify(nextHeader);
    const fileName = `${id}.jsonl`;
    atomicWriteFile(path.join(SESSIONS_DIR, fileName), lines.join("\n") + "\n", "utf8");
    res.json({ ok: true, id, fileName, parentSessionId: nextHeader.parentSessionId, cwd: nextHeader.cwd, threadId: id, label, projectId: nextHeader.projectId || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

let workspacesCache = null;
const WORKSPACES_CACHE_MS = 5000;

function invalidateWorkspacesCache() {
  workspacesCache = null;
}

// GET /api/workspaces - 列出已知工作区目录
app.get("/api/workspaces", (_req, res) => {
  if (workspacesCache && Date.now() - workspacesCache.createdAt < WORKSPACES_CACHE_MS) {
    return res.json({ workspaces: workspacesCache.workspaces });
  }
  const hidden = new Set(getHiddenWorkspaces().map((p) => fs.existsSync(p) ? fs.realpathSync(p) : p));
  const workspaces = [{ name: "默认工作区", path: WORKSPACE_DIR }];
  // 从会话历史里收集其他 cwd（存在 office 文件的工作区）
  const canonical = (value) => {
    try { return fs.realpathSync(value).toLowerCase(); } catch { return path.resolve(value).toLowerCase(); }
  };
  const seen = new Set([canonical(WORKSPACE_DIR)]);
  for (const f of listSessionFiles()) {
    try {
      const first = readSessionTextCached(f).split(/\r?\n/)[0];
      const h = JSON.parse(first);
      const key = h.cwd ? canonical(h.cwd) : "";
      if (h.cwd && !seen.has(key)) {
        seen.add(key);
        // 只收录看起来是办公工作区的目录（有 docx/xlsx/pptx）
        let hasOffice = false;
        try {
          hasOffice = fs.readdirSync(h.cwd).some((f2) => /\.(docx|xlsx|pptx)$/i.test(f2));
        } catch {}
        if (hasOffice) workspaces.push({ name: h.cwd.split(/[\\\/]/).pop() || h.cwd, path: h.cwd });
      }
    } catch {}
  }
  // 过滤用户已删除（隐藏）的工作区路径
  const filtered = workspaces.filter((w) => {
    const rp = fs.existsSync(w.path) ? fs.realpathSync(w.path) : w.path;
    return !hidden.has(rp);
  });
  const unique = [];
  const uniqueKeys = new Set();
  for (const workspace of filtered) {
    const key = canonical(workspace.path);
    if (uniqueKeys.has(key)) continue;
    uniqueKeys.add(key);
    unique.push(workspace);
  }
  workspacesCache = { createdAt: Date.now(), workspaces: unique };
  res.json({ workspaces: unique });
});

// POST /api/workspace/delete - 从下拉列表中移除工作区路径（隐藏，不破坏会话历史）
app.post("/api/workspace/delete", (req, res) => {
  const { path: dir } = req.body || {};
  if (!dir) return res.status(400).json({ error: "path required" });
  hideWorkspace(dir);
  // 若删除的是当前工作区，则回退到默认工作区
  let workspace = getWorkspace();
  if (workspace === dir || (fs.existsSync(dir) && fs.existsSync(workspace) && fs.realpathSync(workspace) === fs.realpathSync(dir))) {
    setWorkspace(WORKSPACE_DIR);
    workspace = getWorkspace();
  }
  invalidateWorkspacesCache();
  res.json({ ok: true, workspace });
});

// POST /api/workspace/switch - 切换当前工作区
app.post("/api/workspace/switch", (req, res) => {
  const { path: dir } = req.body || {};
  if (!dir) return res.status(400).json({ error: "path required" });
  const workspace = normalizeWorkspace(dir);
  if (!workspace) return res.status(400).json({ error: "路径不存在或不是可访问的文件夹", code: "WORKSPACE_INVALID" });
  const write = evaluateWorkspaceWrite(workspace);
  if (write.status !== "passed") {
    return res.status(403).json({
      error: `无法将此目录用作可写工作区：${write.message || "当前服务进程没有写权限"}`,
      code: write.code || "WORKSPACE_WRITE_UNAVAILABLE",
      workspace,
      writeAccess: write,
    });
  }
  if (!setWorkspace(workspace)) return res.status(400).json({ error: "工作区切换失败", code: "WORKSPACE_SWITCH_FAILED" });
  res.json({ ok: true, workspace: getWorkspace(), files: listWorkspace() });
});

// POST /api/workspace/pick - 调用 Windows 原生文件夹选择器，再复用同一套可写探针。
app.post("/api/workspace/pick", async (_req, res) => {
  if (process.platform !== "win32") {
    return res.status(501).json({ error: "当前平台没有可用的原生文件夹选择器", code: "FOLDER_PICKER_UNAVAILABLE" });
  }
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const pickerScript = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = '选择 Open Plan 可写工作区'",
      "$dialog.ShowNewFolderButton = $true",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $dialog.SelectedPath }",
    ].join("; ");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-Command", pickerScript], {
      windowsHide: false,
      timeout: 120000,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
    });
    const selected = String(stdout || "").replace(/^\uFEFF/, "").trim();
    if (!selected) return res.json({ ok: false, canceled: true });
    const workspace = normalizeWorkspace(selected);
    if (!workspace) return res.json({ ok: false, workspace: selected, code: "WORKSPACE_INVALID", error: "路径不存在或不是可访问的文件夹" });
    const write = evaluateWorkspaceWrite(workspace);
    if (write.status !== "passed") {
      return res.json({ ok: false, workspace, code: write.code || "WORKSPACE_WRITE_UNAVAILABLE", error: write.message || "当前服务进程没有写权限", writeAccess: write });
    }
    res.json({ ok: true, workspace, writeAccess: write });
  } catch (error) {
    const code = error?.killed ? "FOLDER_PICKER_TIMEOUT" : "FOLDER_PICKER_FAILED";
    res.status(500).json({ error: `文件夹选择器启动失败：${error?.message || error}`, code });
  }
});

// POST /api/workspace/validate - 验证自定义路径是否可作为工作区
app.post("/api/workspace/validate", async (req, res) => {
  const { path: dir } = req.body || {};
  if (!dir) return res.status(400).json({ error: "path required" });
  const workspace = normalizeWorkspace(dir);
  if (!workspace) return res.json({ ok: false, code: "WORKSPACE_INVALID", workspace: String(dir), error: "路径不存在或不是可访问的文件夹" });
  const write = evaluateWorkspaceWrite(workspace);
  const officecli = await checkOfficecli();
  const checks = [
    write,
    {
      id: "officecli",
      label: "Office CLI",
      status: officecli.available ? "passed" : "failed",
      message: officecli.available ? `Office CLI 可运行：${officecli.version || officecli.path}` : (officecli.message || "Office CLI 不可用"),
      details: { path: officecli.path, version: officecli.version || null, code: officecli.code ?? null },
    },
  ];
  res.json({
    ok: write.status === "passed",
    workspace,
    writeAccess: write,
    officecli: checks[1],
    checks,
    note: "探针以当前服务进程身份执行；Office CLI 可运行不代表目标工作区允许保存。",
  });
});

// 清洗会话标题：去掉前端注入的前缀标记（[当前打开文件]/[模式]/[已上传附件]），按句子智能截断
function cleanSessionTitle(raw) {
  let t = String(raw || "").trim();
  // 兼容旧版本把任务目标直接写成“## 当前任务目标：...”的会话首条消息。
  // 这类标题是内部封装，不应污染项目列表和会话历史。
  const inlineTaskGoal = t.match(/^#{1,6}\s*当前任务目标\s*[:：]\s*([^\n]+)/i);
  if (inlineTaskGoal?.[1]) t = inlineTaskGoal[1].trim();
  // 新版 agent 会把用户原始指令包在 TaskEnvelope 中；优先取“目标”字段，
  // 否则整段动态上下文会被误判为系统提示，历史列表就只剩“空会话”。
  const envelopeGoal = t.match(/^\s*#{1,6}\s*当前任务(?:\s+|\n)+(?:目标|任务目标)\s*[:：]\s*([\s\S]*?)(?=(?:\s+|\n)-?\s*(?:模式|引用数|输出要求|本轮结构化引用|动态上下文)\s*[:：]|$)/i);
  if (envelopeGoal?.[1]) t = envelopeGoal[1].trim();
  const goal = t.match(/(?:^|\n)\s*-?\s*(?:目标|任务目标)\s*[:：]\s*([\s\S]*?)(?=\n\s*-?\s*(?:模式|引用数|输出要求|本轮结构化引用|动态上下文)\s*[:：]|$)/i);
  if (goal?.[1]) t = goal[1].trim();
  t = t.replace(/^##\s*任务封装\s*/i, "").trim();
  t = t.replace(/^#{1,6}\s*当前任务目标\s*[:：]?\s*/i, "").trim();
  // 动态上下文可能包含整份 AGENTS.md；只保留模式标记之后的用户指令。
  t = t.replace(/^\[动态上下文\][\s\S]*?\[模式:\s*[^\]]*\]\s*/i, "");
  t = t.replace(/^\[当前打开文件:[^\]]*\]\s*/g, "");
  t = t.replace(/^\[当前工作文件:[^\]]*\]\s*/g, "");
  t = t.replace(/^\[模式:\s*[^\]]*\]\s*/g, "");
  t = t.replace(/^\[已上传附件:[^\]]*\]\s*/g, "");
  t = t.replace(/\n\s*##\s*本轮结构化引用[\s\S]*$/i, "");
  t = t.replace(/\n\s*\[动态上下文\][\s\S]*$/i, "");
  t = t.replace(/@(?:知识库|模板|文件)\[[^\]]*\]/g, " ");
  t = t.replace(/@[^\s@，。！？]+\.(?:docx|xlsx|pptx|pdf|md|txt|html?)\b/gi, " ");
  t = t.replace(/你可以调用所有 skills 和工具生成新文件（文档\/HTML\/PPT等），产物保存到当前工作区。?/g, " ");
  t = t.replace(/优先用 officecli 工具对当前文档做精准文本\/样式修改，不要创建新文件。?/g, " ");
  t = t.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").replace(/^[,，:：;；、\s]+/, "").trim();
  if (t.length <= 50) return t;
  // 按句子边界截断
  const m = t.match(/^.{0,48}[。！？.!?]/);
  if (m) return m[0];
  return t.slice(0, 50) + "…";
}

// 判断消息是否为前端注入的系统提示（模式说明/上下文标记），此类消息不适合做会话标题
const SYSTEM_HINTS = ["[动态上下文]", "[当前工作文件:", "[当前打开文件:", "[模式:", "[当前文档:", "优先用 officecli 工具对当前文档做精准文本"];
function isSystemHintMessage(raw) {
  const t = String(raw || "").trim();
  if (!t) return true;
  // 只要消息中还包含实际任务，就不能因为它同时带有上下文前缀而跳过。
  const cleaned = cleanSessionTitle(t);
  if (!cleaned) return true;
  const startsHint = SYSTEM_HINTS.some((h) => t.startsWith(h));
  return startsHint && /^(?:优先用 officecli|你可以调用所有 skills|当前工作区|Office 文档一律)/i.test(cleaned);
}

function messageText(entry) {
  const c = entry?.message?.content;
  if (typeof c === "string") return c.trim();
  if (!Array.isArray(c)) return "";
  return c.filter((b) => b?.type === "text" || b?.type === "input_text").map((b) => b.text || b.content || "").join("\n").trim();
}

function isBootstrapSessionTitle(title) {
  return /^"?[a-z]:\\.*\\\.venv\\Scripts\\activate(?:\.bat)?"?$/i.test(String(title || "").trim());
}

// GET /api/sessions - 列出所有会话（解析每个 JSONL 的 header 第一行）
// 支持 ?file=xxx 过滤：只返回提到指定文件的会话
app.get("/api/sessions", (req, res) => {
  const fileFilter = String(req.query.file || "").trim();
  const projectFilter = String(req.query.projectId || "").trim();
  const modeFilter = String(req.query.mode || "").trim();
  const runStatusFilter = String(req.query.runStatus || "").trim();
  const pinnedFilter = req.query.pinned === undefined ? null : req.query.pinned === "true";
  const frozenFilter = req.query.frozen === undefined ? null : req.query.frozen === "true";
  try {
    const files = listSessionFiles();
    const recentRuns = listRuns({ limit: 200 });
    // 每个会话只取最新一条 Run；避免 N×M 查找
    const latestRunBySession = new Map();
    for (const run of recentRuns) {
      if (run.sessionId && !latestRunBySession.has(run.sessionId)) latestRunBySession.set(run.sessionId, run);
    }
    // 同一 cwd 的项目查询按请求记忆化
    const projectByCwd = new Map();
    const projectForCwd = (cwd) => {
      const key = cwd || "_";
      if (projectByCwd.has(key)) return projectByCwd.get(key);
      const value = projectManager.getProjectForWorkspace(cwd || getWorkspace());
      projectByCwd.set(key, value);
      return value;
    };
    const sessions = [];
    for (const f of files) {
      try {
        // 元数据按 mtime+size 指纹缓存：未变化文件不重新读取解析
        const meta = sessionMetaFor(f);
        if (!meta || !meta.isOaw) continue;
        // 按文件过滤：会话内容（用户消息/工具参数）提到该文件才保留（按需全量读取）
        if (fileFilter && !readSessionTextCached(f).includes(fileFilter)) continue;
        let title = meta.label || meta.title;
        // 项目内会话即使尚未发送首条消息也保留，前端才能显示“准备中/运行中”的会话，
        // 也不会因为切换页面而把用户刚创建的对话丢掉。
        if (!meta.hasUserMessage && !meta.label && !meta.isProjectSession) continue;
        if (isBootstrapSessionTitle(title)) continue;
        const id = meta.id;
        const latestRun = latestRunBySession.get(id);
        const project = projectManager.getProject(meta.projectId) || projectForCwd(meta.cwd);
        if (projectFilter && project?.id !== projectFilter) continue;
        if (modeFilter && (latestRun?.task?.mode || "") !== modeFilter) continue;
        if (runStatusFilter && (latestRun?.status || "idle") !== runStatusFilter) continue;
        if (pinnedFilter !== null && meta.pinned !== pinnedFilter) continue;
        if (frozenFilter !== null && meta.frozen !== frozenFilter) continue;
        sessions.push({
          id,
          threadId: meta.threadId || latestRun?.threadId || id,
          projectId: project?.id || null,
          projectName: project?.name || "",
          projectType: project?.type || "",
          projectStatus: project?.status || "",
          cwd: meta.cwd,
          created: meta.created,
          modified: f.mtime,
          label: meta.label,
          pinned: meta.pinned,
          frozen: meta.frozen,
          freezeReason: meta.freezeReason,
          contextSnapshot: meta.contextSnapshot,
          parentSessionId: meta.parentSessionId,
          branchSourceMessageId: meta.branchSourceMessageId,
          branchPurpose: meta.branchPurpose,
          fileName: f.fileName,
          title,
          runStatus: latestRun?.status || "idle",
          runId: latestRun?.id || null,
          mode: latestRun?.task?.mode || "",
          lastRunAt: latestRun?.finishedAt || latestRun?.startedAt || null,
          artifactCount: latestRun?.artifacts?.length || 0,
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
    const { cwd, projectId, label, frozen = false } = req.body || {};
    const workspace = normalizeWorkspace(cwd || getWorkspace()) || getWorkspace();
    const project = projectManager.getProject(projectId) || projectManager.getProjectForWorkspace(workspace);
    const id = crypto.randomUUID();
    const created = new Date().toISOString();
    const header = {
      type: "header",
      id,
      sessionId: id,
      threadId: id,
      cwd: workspace,
      projectId: project?.id || null,
      created,
      updatedAt: created,
      label: String(label || "").trim(),
      pinned: false,
      frozen: Boolean(frozen),
    };
    const fileName = id + ".jsonl";
    atomicWriteFile(path.join(SESSIONS_DIR, fileName), JSON.stringify(header) + "\n", "utf8");
    res.json({ id, fileName, cwd: header.cwd, projectId: header.projectId, created, status: "idle", pinned: false, frozen: header.frozen });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function compactSessionEntryForChat(entry) {
  if (!entry || entry.type !== "message" || !entry.message) return entry;
  const message = { ...entry.message };
  const compactText = (value, limit = 12000) => {
    const text = String(value ?? "");
    return text.length > limit ? `${text.slice(0, limit)}\n…[历史输出已折叠]` : text;
  };
  if (Array.isArray(message.content)) {
    message.content = message.content.map((block) => {
      if (!block || typeof block !== "object") return block;
      if (block.type === "image" || block.type === "input_image") {
        return { type: "text", text: "[历史图片已省略，可重新打开原会话查看]" };
      }
      if (block.type === "text" || block.type === "input_text") {
        return { ...block, text: compactText(block.text || block.content || "") };
      }
      if (block.type === "toolCall" || block.type === "tool_call") {
        const input = typeof block.input === "string" ? compactText(block.input) : block.input;
        return input === block.input ? block : { ...block, input };
      }
      return block;
    });
  } else if (typeof message.content === "string") {
    message.content = compactText(message.content);
  }
  if (message.role === "toolResult" || message.role === "tool_result") {
    message.content = Array.isArray(message.content)
      ? message.content.filter((block) => block?.type === "text").map((block) => ({ ...block, text: compactText(block.text || block.content || "") }))
      : compactText(message.content || message.output || "");
  }
  return { ...entry, message };
}

// GET /api/sessions/:id - 获取会话详情（含 entries、fork 树、leafId）
app.get("/api/sessions/:id", (req, res) => {
  const found = findSessionFile(req.params.id);
  if (!found) return res.status(404).json({ error: "not found" });
  try {
    const text = readSessionTextCached(found);
    const all = parseJsonl(text);
    const header = all.find((e) => e && e.type === "header") || all[0] || {};
    const entries = all.filter((e) => e !== header);
    const chatView = String(req.query.view || "") === "chat";
    // Chat 视图只服务前端展示，不承担 Pi 会话恢复。恢复仍使用磁盘上的完整
    // JSONL；这里按尾部窗口返回，避免切换一个长会话时把整份工具输出一次性
    // 传到浏览器并触发大批量 JSON/Markdown 解析。
    const chatLimit = chatView
      ? Math.max(80, Math.min(600, Number.parseInt(req.query.limit, 10) || 360))
      : entries.length;
    const requestedBefore = chatView ? Number.parseInt(req.query.before, 10) : NaN;
    const historyEnd = Number.isFinite(requestedBefore)
      ? Math.max(0, Math.min(entries.length, requestedBefore))
      : entries.length;
    const historyStart = chatView ? Math.max(0, historyEnd - chatLimit) : 0;
    const chatEntries = chatView ? entries.slice(historyStart, historyEnd) : entries;
    const responseEntries = chatView ? chatEntries.map(compactSessionEntryForChat) : entries;

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
      entries: responseEntries,
      // Chat 页面不使用 fork tree；不要把几千个节点再复制一份进响应。
      tree: chatView ? {} : tree,
      leafId,
      info: {
        id: header.sessionId || header.id || sessionBaseName(found.fileName),
        cwd: header.cwd || "",
        projectId: header.projectId || projectManager.getProjectForWorkspace(header.cwd || getWorkspace())?.id || null,
        created: header.created || "",
        label: header.label || "",
        pinned: Boolean(header.pinned),
        frozen: Boolean(header.frozen),
        freezeReason: header.freezeReason || "",
        contextSnapshot: header.contextSnapshot || null,
        parentSessionId: header.parentSessionId || null,
        branchSourceMessageId: header.branchSourceMessageId || null,
        branchPurpose: header.branchPurpose || "",
        fileName: found.fileName,
        modified: found.mtime,
        chatView,
        historyTotal: chatView ? entries.length : undefined,
        historyStart: chatView ? historyStart : undefined,
        historyEnd: chatView ? historyEnd : undefined,
        historyHasMore: chatView ? historyStart > 0 : false,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sessions/batch-delete - 批量删除会话历史（运行中的会话跳过）
app.post("/api/sessions/batch-delete", (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean))].slice(0, 200);
  if (!ids.length) return res.status(400).json({ error: "ids required" });
  const activeSessionIds = new Set(listRuns({ limit: 500 })
    .filter((run) => ["running", "queued", "waiting_user", "recovering", "cancel_requested"].includes(run?.status))
    .map((run) => String(run.sessionId || ""))
    .filter(Boolean));
  const deleted = [];
  const skipped = [];
  const missing = [];
  for (const id of ids) {
    if (activeSessionIds.has(id)) {
      skipped.push({ id, reason: "会话正在运行" });
      continue;
    }
    const found = findSessionFile(id);
    if (!found) {
      missing.push(id);
      continue;
    }
    try {
      fs.unlinkSync(found.fullPath);
      sessionTextCache.delete(found.fullPath);
      deleted.push(id);
    } catch (error) {
      skipped.push({ id, reason: error.message || "删除失败" });
    }
  }
  res.json({ ok: true, deleted, skipped, missing });
});

// DELETE /api/sessions/:id - 删除会话文件
app.delete("/api/sessions/:id", (req, res) => {
  const found = findSessionFile(req.params.id);
  if (!found) return res.status(404).json({ error: "not found" });
  try {
    fs.unlinkSync(found.fullPath);
    sessionTextCache.delete(found.fullPath);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sessions/:id/rename - 重命名会话（修改 header.label）
app.post("/api/sessions/:id/rename", (req, res) => {
  const result = updateSessionHeader(req.params.id, { label: String(req.body?.label || "").trim() });
  if (!result.ok) return res.status(result.status || 400).json(result);
  res.json({ ok: true, label: result.header.label });
});

app.post("/api/sessions/:id/pin", (req, res) => {
  const result = updateSessionHeader(req.params.id, { pinned: req.body?.pinned !== false });
  if (!result.ok) return res.status(result.status || 400).json(result);
  res.json({ ok: true, sessionId: req.params.id, pinned: Boolean(result.header.pinned) });
});

app.post("/api/sessions/:id/freeze", (req, res) => {
  const frozen = req.body?.frozen !== false;
  const found = findSessionFile(req.params.id);
  const header = readSessionHeader(found);
  const capturedAt = new Date().toISOString();
  const result = updateSessionHeader(req.params.id, {
    frozen,
    freezeReason: frozen ? String(req.body?.reason || "用户冻结会话") : "",
    contextSnapshot: frozen
      ? (req.body?.snapshot || { capturedAt, workspace: header.cwd || "", projectId: header.projectId || null, source: "session-freeze" })
      : (header.contextSnapshot || null),
  });
  if (!result.ok) return res.status(result.status || 400).json(result);
  res.json({ ok: true, sessionId: req.params.id, frozen: Boolean(result.header.frozen), freezeReason: result.header.freezeReason || "", contextSnapshot: result.header.contextSnapshot || null });
});

// 中止当前 agent 运行
app.post("/api/agent/abort", async (req, res) => {
  const { client, thread } = req.body || {};
  if (!client) return res.status(400).json({ error: "client required" });
  try {
    const key = agentKey(client, thread);
    const live = agentManager.sessions?.get(key);
    if (live?.activeRunId) requestRunCancellation(live.activeRunId, "用户在对话栏请求中断");
    res.json(await agentManager.abort(key));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 手动压缩当前会话上下文（对应 Pi SDK 的 session.compact）
app.post("/api/agent/compact", async (req, res) => {
  const { client, thread, instructions } = req.body || {};
  if (!client) return res.status(400).json({ error: "client required" });
  try {
    res.json(await agentManager.compact(agentKey(client, thread), instructions));
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.get("/api/agent/pending", (req, res) => {
  const client = String(req.query.client || "");
  const thread = String(req.query.thread || "");
  res.json({ questions: agentManager.pendingQuestions(client && thread ? agentKey(client, thread) : "") });
});

// 回答 agent 的提问（ask_user 工具：用户回答后 agent 继续）
app.post("/api/agent/answer", (req, res) => {
  const { client, thread, answer } = req.body || {};
  if (!client || !answer) return res.status(400).json({ error: "client and answer required" });
  const result = agentManager.submitAnswer(agentKey(client, thread), String(answer).slice(0, 2000));
  if (!result.ok) return res.status(404).json({ error: "no pending question" });
  res.json(result);
});

// ---------- 工具审批（参考 opencode 的 allow/ask/deny 三值模型） ----------
app.get("/api/agent/approvals", (_req, res) => {
  res.json({ approvals: listPendingApprovals() });
});

app.get("/api/agent/permissions", (_req, res) => {
  res.json(listPermissionRules());
});

app.get("/api/agent/approval-mode", (_req, res) => {
  res.json({ mode: getApprovalMode() });
});

app.patch("/api/agent/approval-mode", (req, res) => {
  const mode = String(req.body?.mode || "ask");
  if (!["ask", "auto"].includes(mode)) return res.status(400).json({ error: "mode must be ask or auto" });
  res.json(setApprovalMode(mode));
});

// 提交工具审批决定：allow（允许一次）/ always（总是允许）/ deny（拒绝）
app.post("/api/agent/approval", (req, res) => {
  const { id, decision } = req.body || {};
  if (!id || !["allow", "always", "deny"].includes(String(decision || ""))) {
    return res.status(400).json({ error: "id and decision (allow/always/deny) required" });
  }
  const result = resolveToolApproval(id, decision);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

/**
 * 后台执行已被接收的 Agent Run。
 * HTTP 只负责完成 admission；模型、工具和产物状态统一通过 SSE 回传，
 * 这样供应商慢或断开时不会把浏览器的 prompt 请求长期挂住。
 */
function getRunFinalText(run) {
  return [...(run?.events || [])]
    .reverse()
    .find((item) => item?.type === "assistant_final" && String(item?.data?.text || "").trim())
    ?.data?.text || "";
}

// 其他 run 的暂存清单路径（产物统计时排除，避免并行任务相互污染）
function otherRunsStagedPaths(currentRunId) {
  const paths = new Set();
  const runsDir = path.join(PROJECT_DIR, ".oaw", "runs");
  let names = [];
  try { names = fs.readdirSync(runsDir); } catch { return paths; }
  for (const name of names) {
    if (name === currentRunId) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(runsDir, name, "写入清单.json"), "utf8"));
      if (Array.isArray(manifest.files)) {
        for (const entry of manifest.files) {
          if (typeof entry?.path === "string") paths.add(entry.path.replace(/\\/g, "/"));
        }
      }
    } catch {}
  }
  return paths;
}

// 完成语义：显式 complete_task 优先；否则按 Run 终态推断（source:"inferred"），
// 前端据此区分“回答结束”与“任务真正完成”。
function resolveRunCompletion(entry, runStatus, { artifacts = 0, validations = [], runId = null } = {}) {
  const pending = entry?.pendingCompletion && typeof entry.pendingCompletion === "object" ? entry.pendingCompletion : null;
  // 完成声明必须属于当前 Run：同一会话上一轮的声明不能串到本轮（否则会误报 success）。
  const explicit = pending && (!runId || !pending.runId || pending.runId === runId) ? pending : null;
  return explicit || inferCompletion({ runStatus, artifacts, validations });
}

async function executeAgentRun({ entry, key, client, thread, normalizedText, images, effort, resolved, task, workflow, run, before, runWorkspace, effectiveModel, capabilityPlan, preflight, requestId }) {
  const tracksWorkspace = run?.snapshotMode !== "none";
  try {
    await agentManager.promptWithContext(key, normalizedText, images, effort, resolved, { runId: run.id, task, workflow });
  } catch (e) {
    const currentModel = entry?.session?.model;
    const diagnostic = recordAgentDiagnostic({ requestId }, {
      client,
      thread,
      runId: run?.id || null,
      model: effectiveModel || (currentModel?.provider && currentModel?.id ? `${currentModel.provider}/${currentModel.id}` : null),
      error: e,
    });
    if (entry) emitChannel(entry, "agent_error", { message: diagnostic.message, code: diagnostic.errorCode || e?.code || null, category: diagnostic.errorCategory || null, providerStatus: diagnostic.providerStatus || null, runId: run?.id || null, requestId, retryable: diagnostic.retryable });
    // 失败前已生成的权威文本也写入 run 记录，供前端断线兜底渲染
    if (run && entry?.lastFinalText) recordRunEvent(run.id, "assistant_final", { text: entry.lastFinalText });
// 出错也检测产物（agent 可能已部分写入文件）
    const stagedElsewhere = otherRunsStagedPaths(run?.id || "");
    const changed = filterRunChanges(run, (tracksWorkspace ? await waitForFlush(before, runWorkspace) : [])
      .filter((p) => !stagedElsewhere.has(String(p).replace(/\\/g, "/"))));
    const validations = validateArtifacts(changed, runWorkspace);
    const stagedValidations = run ? validateStagedArtifacts(run.id) : [];
    if (changed.length && entry) {
      emitChannel(entry, "file_changed", { files: changed, runId: run?.id || null });
      emitChannel(entry, "agent_summary", {
        products: changed,
        summary: `对话异常结束，仍处理了 ${changed.length} 个文件：${changed.join(", ")}`,
        runId: run?.id || null,
        artifacts: [],
      });
    }
    const runtimeHealth = entry ? agentManager.runtimeHealth(key) : null;
    if (runtimeHealth) recordRunEvent(run.id, "runtime_error", { code: diagnostic.errorCode || e?.code || null, message: diagnostic.message, runtime: runtimeHealth });
    const cancelled = getRun(run.id)?.status === "cancel_requested";
    const failureCompletion = resolveRunCompletion(entry, cancelled ? "cancelled" : "failed", { artifacts: changed.length, validations: [...validations, ...stagedValidations], runId: run.id });
    const failed = finishRun(run.id, {
      status: cancelled ? "cancelled" : "failed",
      sessionId: entry?.session?.sessionId || null,
      error: cancelled ? "用户请求取消" : e.message,
      summary: cancelled ? "任务已取消" : "Agent 执行失败",
      validations: [...validations, ...stagedValidations],
      completion: failureCompletion,
    });
    if (entry) emitChannel(entry, "run_finished", { runId: run.id, task, artifacts: failed?.artifacts || [], references: resolved, reviewSources: entry.reviewSources || [], status: failed?.status || (cancelled ? "cancelled" : "failed"), verificationStatus: failed?.verificationStatus || "not_checked", completion: failed?.completion || failureCompletion, finalText: getRunFinalText(getRun(run.id)) });
    return;
  }

// officecli keeps files in a resident process — disk writes flush asynchronously.
  // Poll until the workspace snapshot stabilizes, then diff.
  // 把最终权威文本写入 run 记录（assistant_final），前端 run_finished 用它兜底渲染
  if (run && entry?.lastFinalText) recordRunEvent(run.id, "assistant_final", { text: entry.lastFinalText });
  const stagedElsewhere = otherRunsStagedPaths(run?.id || "");
  const changed = filterRunChanges(run, (tracksWorkspace ? await waitForFlush(before, runWorkspace) : [])
    .filter((p) => !stagedElsewhere.has(String(p).replace(/\\/g, "/"))));
  const validations = validateArtifacts(changed, runWorkspace);
  const stagedValidations = run ? validateStagedArtifacts(run.id) : [];
  const allValidations = [...validations, ...stagedValidations];
  const publishableStagedValidations = stagedValidations.filter((item) => item.status !== "failed");
  const verificationNote = allValidations.some((item) => item.status === "failed") ? "，但产物校验发现问题" : allValidations.some((item) => item.status === "warning") ? "，产物校验有提示" : "";
  const cancelled = run && getRun(run.id)?.status === "cancel_requested";
  const finalStatus = cancelled ? "cancelled" : "completed";
  const publishPaths = publishableStagedValidations.map((item) => item.path).filter(Boolean);
  const publishedCount = changed.length + publishableStagedValidations.length;
  const completed = run ? finishRun(run.id, { status: finalStatus, sessionId: entry?.session?.sessionId || null, summary: cancelled ? "任务已取消" : (publishedCount ? `本轮对话完成，共处理 ${publishedCount} 个文件${verificationNote}` : "本轮对话完成，未检测到文件变更"), validations: allValidations, publishPaths: run ? publishPaths : null, completion: resolveRunCompletion(entry, finalStatus, { artifacts: publishedCount, validations: allValidations }) }) : null;
  if (entry) {
    const productPaths = [...changed, ...publishableStagedValidations.map((item) => item.path).filter(Boolean)];
    if (productPaths.length) {
      emitChannel(entry, "file_changed", { files: productPaths, runId: run?.id || null });
      emitChannel(entry, "agent_summary", {
        products: productPaths,
        summary: `本轮对话完成，共处理 ${productPaths.length} 个文件：${productPaths.join(", ")}`,
        runId: run?.id || null,
        artifacts: completed?.artifacts || [],
        references: resolved,
      });
    }
    if (run) emitChannel(entry, "run_finished", { runId: run.id, task, artifacts: completed?.artifacts || [], references: resolved, reviewSources: entry.reviewSources || [], status: completed?.status || finalStatus, verificationStatus: completed?.verificationStatus || "not_checked", completion: completed?.completion || resolveRunCompletion(entry, finalStatus, { artifacts: publishedCount, validations: allValidations }), finalText: getRunFinalText(getRun(run.id)) });
  }
}

app.post("/api/agent/prompt", async (req, res) => {
  const admissionStartedAt = new Date().toISOString();
  const { client, thread, text, images, attachments, references, effort, model: requestedModel, task: taskInput } = req.body || {};
  const hasImages = Array.isArray(images) && images.some((img) => img?.data);
  const hasAttachments = Array.isArray(attachments) && attachments.some((att) => att?.data);
  if (!client || (!String(text || "").trim() && !hasImages && !hasAttachments)) {
    return res.status(400).json({ error: "text, image, or attachment required" });
  }
  const normalizedText = String(text || "").trim() || (hasImages ? "[图片消息]" : "[附件消息]");
  const key = agentKey(client, thread);
  const requestedWorkspace = normalizeWorkspace(taskInput?.workspace || taskInput?.cwd || getWorkspace()) || getWorkspace();
  const initialWritePlan = planTaskCapabilities({ text: normalizedText, task: taskInput || {}, attachments });
  let writeAccessPreflight = null;
  try {
    writeAccessPreflight = requireWorkspaceWriteForTask(initialWritePlan, requestedWorkspace);
  } catch (error) {
    return res.status(workspaceWriteHttpStatus(error)).json({
      error: error.message,
      code: error.code || "WORKSPACE_WRITE_UNAVAILABLE",
      writeAccess: error.writeAccess || null,
      requestId: req.requestId,
    });
  }
  const initialProject = projectManager.getProjectForWorkspace(requestedWorkspace);
  const initialProjectSettings = initialProject?.settings || projectManager.defaultProjectSettings();
  const initialModel = String(requestedModel || initialProjectSettings.defaultModel || "").trim();
  let entry;
  try {
    entry = await ensureRuntimeWithTimeout(key, { threadId: thread, cwd: requestedWorkspace, modelSpec: initialModel });
  } catch (e) {
    const diagnostic = recordAgentDiagnostic(req, { client, thread, error: e });
    return res.status(500).json({ error: diagnostic.message, requestId: req.requestId, retryable: diagnostic.retryable });
  }
  emitChannel(entry, "run_admitting", { requestId: req.requestId, startedAt: admissionStartedAt });
  const runWorkspace = entry.workspace || requestedWorkspace;
  const project = projectManager.getProjectForWorkspace(runWorkspace) || initialProject;
  const projectSettings = project?.settings || initialProjectSettings;
  // ensureRuntime 可能刚刚从失效 provider 恢复到 Pi 全局默认模型；本轮沿用恢复后的模型，
  // 避免下面的 setModel 又把会话切回刚刚失败的旧模型。
  const effectiveModel = String(entry.modelFallbackSpec || requestedModel || projectSettings.defaultModel || "").trim();
  const sessionHeader = readSessionHeader(findSessionFile(entry.session?.sessionId || ""));
  if (sessionHeader.frozen) {
    return res.status(409).json({ error: "当前会话已冻结，请先解冻后再继续执行", code: "SESSION_FROZEN", sessionId: entry.session?.sessionId || null });
  }
  const projectSkills = Array.isArray(projectSettings.skills) ? projectSettings.skills : [];
  if (effectiveModel) {
    try {
      const current = entry.session?.model;
      const currentSpec = current?.provider && current?.id ? `${current.provider}/${current.id}` : "";
      // ChatPanel 每次发送都会带当前模型；同模型无需再次 setModel，避免重复
      // 触发 Pi 的 provider/model 初始化，把首字节延迟叠加到每一轮。
      if (currentSpec !== effectiveModel) await agentManager.setModel(key, effectiveModel);
    } catch (e) {
      const diagnostic = recordAgentDiagnostic(req, { client, thread, model: effectiveModel, error: e });
      return res.status(409).json({ error: `模型同步失败：${diagnostic.message}`, requestId: req.requestId, retryable: diagnostic.retryable });
    }
  }
  let before = [];
  let run = null;
  let resolved = [];
  let task = null;
  let capabilityPlan = null;
  let preflight = null;
  try {
    resolved = resolveReferences(references, normalizedText, runWorkspace);
    const requestedMode = normalizeTaskMode(taskInput?.mode);
    const workflowId = requestedMode === "chat" ? null : (taskInput?.workflowId || workflowIdFromText(normalizedText));
    const mentionedSkills = [...normalizedText.matchAll(/@技能\[([^\]]+)\]/g)].map((match) => match[1].trim()).filter(Boolean);
    // Chat 允许搜索/阅读 Skills，但不把项目默认 Skills 作为执行依赖，避免只读问答
    // 因历史配置缺失而被 Agent 预检拦截。
    const requestedSkills = requestedMode === "chat"
      ? []
      : [...new Set([...projectSkills, ...(Array.isArray(taskInput?.skills) ? taskInput.skills : []), ...mentionedSkills])];
    // 普通 Agent 问答不需要在 admission 阶段扫描所有 SKILL.md；只有显式工作流/技能
    // 依赖才加载技能目录，避免首次对话把本地扫描延迟叠加到模型首事件之前。
    const skills = (workflowId || requestedSkills.length) ? scanSkills() : [];
    const workflow = workflowId ? getWorkflow(workflowId, skills) : null;
    preflight = requestedMode === "chat"
      ? { ok: true, workflow: null, required: [], checks: [], missing: [], message: "Chat 不执行 Skills 依赖预检" }
      : preflightSkills({ workflowId, requestedSkills, skills });
    const effectiveTaskInput = {
      ...(taskInput || {}),
      projectId: project?.id || taskInput?.projectId || null,
      agentProfile: projectSettings.agentProfile,
      projectSettings,
      profilePolicy: projectSettings.profilePolicy,
      skills: requestedSkills,
      workflowId,
    };
    capabilityPlan = planTaskCapabilities({ text: normalizedText, task: effectiveTaskInput, references: resolved, attachments });
    if (writeAccessPreflight) capabilityPlan.workspaceWrite = writeAccessPreflight;
    if (capabilityPlan.routing.officecli === "preferred") {
      capabilityPlan.officecli = await checkOfficecli();
      if (!capabilityPlan.officecli.available) {
        const error = new Error(`Office CLI 预检失败：${capabilityPlan.officecli.message}`);
        error.code = "OFFICE_PREFLIGHT_FAILED";
        throw error;
      }
    }
    if ((workflowId || requestedSkills.length) && !preflight.ok) {
      const error = new Error(preflight.message);
      error.code = "SKILL_PREFLIGHT_FAILED";
      throw error;
    }
    task = createTaskEnvelope({
      ...effectiveTaskInput,
      text: normalizedText,
      threadId: thread || null,
      currentFile: taskInput?.currentFile || null,
      references: resolved,
      workflowId,
      capabilityPlan,
      constraints: [
        ...(taskInput?.constraints || []),
        ...(workflow && !workflow.valid ? [`工作流缺少技能：${workflow.missing.join(", ")}`] : []),
      ],
    });
    // Chat 没有上传文件时是严格只读模式，不需要为每轮问答扫描工作区。
    // 用户明确上传的附件需要在成功后发布为可追溯文件，因此保留完整快照。
    const tracksWorkspace = task.mode !== "chat" || Boolean(attachments?.length);
    before = tracksWorkspace ? snapshotWorkspace(runWorkspace) : [];
    const runtimeSnapshot = agentManager.runtimeSnapshot(key, {
      profile: task.agentProfile,
      taskMode: task.mode,
      capabilityPlanVersion: capabilityPlan?.version || null,
    });
    run = beginRun({
      clientId: client,
      threadId: thread || null,
      sessionId: entry.session?.sessionId || null,
      cwd: runWorkspace,
      task,
      references: resolved,
      workflow,
      projectId: project?.id || null,
      capabilityPlan,
      runtimeSnapshot,
      snapshotMode: tracksWorkspace ? "full" : "none",
    });
    // 上传附件先进入当前 Run 的暂存区；Agent 可以通过 staging overlay 读取，成功后才发布到工作区。
    if (Array.isArray(attachments) && attachments.length) {
      for (const att of attachments) {
        const safe = safeName(att.name);
        if (!safe) continue;
        stageWrite({
          runId: run.id,
          workspace: runWorkspace,
          targetPath: path.join(runWorkspace, safe),
          content: Buffer.from(att.data, "base64"),
          threadId: thread || null,
          kind: "attachment",
          onEvent: (type, data) => emitChannel(entry, type, data),
        });
      }
    }
    recordRunEvent(run.id, "prompt", { text: normalizedText.slice(0, 4000), workflowId, referenceCount: resolved.length });
    recordRunEvent(run.id, "capability_plan", { plan: capabilityPlan, preflight });
    if (runtimeSnapshot) recordRunEvent(run.id, "runtime_health", runtimeSnapshot);
    emitChannel(entry, "capability_plan", { plan: capabilityPlan, preflight, runId: run.id });
    emitChannel(entry, "run_admitted", {
      runId: run.id,
      requestId: req.requestId,
      startedAt: admissionStartedAt,
      admittedAt: new Date().toISOString(),
      snapshotMode: tracksWorkspace ? "full" : "none",
    });
    // 先启动入队，再返回 admission 响应。executeAgentRun 在现有 entry 上
    // 会同步登记 queuedCount，避免响应里的 queued/queuePosition 与真实状态错位。
    const execution = executeAgentRun({
      entry,
      key,
      client,
      thread,
      normalizedText,
      images,
      effort,
      resolved,
      task,
      workflow,
      run,
      before,
      runWorkspace,
      effectiveModel,
      capabilityPlan,
      preflight,
      requestId: req.requestId,
    });
    execution.catch((error) => {
      console.error("[agent] 后台 Run 收尾失败", error);
    });
    // 参考 pi-web：先返回“已接收”，最终模型/工具/产物状态由 SSE 事件驱动。
    res.json({
      ok: true,
      accepted: true,
      queued: Boolean(entry.busy || entry.compacting || entry.queuedCount > 1),
      queuePosition: Math.max(1, entry.queuedCount || 1),
      changed: [],
      runId: run?.id || null,
      artifacts: [],
      validations: [],
      verificationStatus: "pending",
      status: "accepted",
      task,
      sessionId: entry?.session?.sessionId || null,
      model: effectiveModel || (entry.session?.model?.provider && entry.session?.model?.id ? `${entry.session.model.provider}/${entry.session.model.id}` : null),
      modelFallbackFrom: entry.modelFallbackFrom || null,
      thread: thread || null,
    });
    return;
  } catch (e) {
    if (e?.code === "SKILL_PREFLIGHT_FAILED" || e?.code === "OFFICE_PREFLIGHT_FAILED") {
      emitChannel(entry, "agent_error", { message: e.message, code: e.code, preflight });
      res.status(409).json({ error: e.message, code: e.code, preflight, capabilityPlan, requestId: req.requestId });
      return;
    }
    if (["WORKSPACE_PERMISSION_DENIED", "WORKSPACE_WRITE_UNAVAILABLE", "OFFICE_DOCUMENT_LOCKED"].includes(e?.code)) {
      emitChannel(entry, "agent_error", { message: e.message, code: e.code, writeAccess: e.writeAccess || null });
      res.status(workspaceWriteHttpStatus(e)).json({ error: e.message, code: e.code, writeAccess: e.writeAccess || null, requestId: req.requestId });
      return;
    }
    const currentModel = entry?.session?.model;
    const diagnostic = recordAgentDiagnostic(req, {
      client,
      thread,
      runId: run?.id || null,
      model: effectiveModel || (currentModel?.provider && currentModel?.id ? `${currentModel.provider}/${currentModel.id}` : null),
      error: e,
    });
    if (entry) emitChannel(entry, "agent_error", { message: diagnostic.message, code: diagnostic.errorCode || e?.code || null, category: diagnostic.errorCategory || null, providerStatus: diagnostic.providerStatus || null, requestId: req.requestId, retryable: diagnostic.retryable });
    // 出错也检测产物（agent 可能已部分写入文件）
    const changed = run ? filterRunChanges(run, await waitForFlush(before, runWorkspace)) : await waitForFlush(before, runWorkspace);
    const validations = validateArtifacts(changed, runWorkspace);
    const stagedValidations = run ? validateStagedArtifacts(run.id) : [];
    if (changed.length) {
      if (entry) {
        emitChannel(entry, "file_changed", { files: changed, runId: run?.id || null });
        emitChannel(entry, "agent_summary", {
          products: changed,
          summary: `对话异常结束，仍处理了 ${changed.length} 个文件：${changed.join(", ")}`,
          runId: run?.id || null,
          artifacts: [],
        });
      }
    }
    if (run) {
      const runtimeHealth = entry ? agentManager.runtimeHealth(key) : null;
      if (runtimeHealth) recordRunEvent(run.id, "runtime_error", { code: diagnostic.errorCode, message: diagnostic.message, runtime: runtimeHealth });
      const cancelled = getRun(run.id)?.status === "cancel_requested";
      const failureCompletion = resolveRunCompletion(entry, cancelled ? "cancelled" : "failed", { artifacts: changed.length, validations: [...validations, ...stagedValidations], runId: run.id });
      const failed = finishRun(run.id, { status: cancelled ? "cancelled" : "failed", sessionId: entry?.session?.sessionId || null, error: cancelled ? "用户请求取消" : e.message, summary: cancelled ? "任务已取消" : "Agent 执行失败", validations: [...validations, ...stagedValidations], completion: failureCompletion });
      if (entry) emitChannel(entry, "run_finished", { runId: run.id, task, artifacts: failed?.artifacts || [], references: resolved, reviewSources: entry.reviewSources || [], status: failed?.status || (cancelled ? "cancelled" : "failed"), verificationStatus: failed?.verificationStatus || "not_checked", completion: failed?.completion || failureCompletion, finalText: getRunFinalText(getRun(run.id)) });
    }
    res.status(500).json({ error: diagnostic.message, requestId: req.requestId, retryable: diagnostic.retryable });
    return;
  }
});

app.post("/api/projects/classify", (req, res) => {
  try {
    res.json(projectManager.classifyProjects({ apply: req.body?.apply === true }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const CONTINUABLE_RUN_STATUSES = new Set(["recovering", "failed", "cancelled", "aborted"]);

function continuationPrompt(task, action) {
  const goal = String(task?.goal || "").trim();
  if (action === "retry") {
    return `请重新执行原任务，遇到上次失败原因时先检查并修正，再完成任务。原任务目标：${goal}`;
  }
  return `请从原任务上次中断的位置继续执行，先检查已经完成的步骤和当前文件状态，不要重复已经成功且无必要重复的副作用操作。原任务目标：${goal}`;
}

async function ensureContinuationAgent(run) {
  const key = agentKey(run.clientId, run.threadId);
  const live = agentManager.sessions?.get(key);
  if (live?.busy) throw new Error("对应对话正在执行其他任务，请等待或先取消当前任务");
  const sessionId = run.sessionId || run.threadId;
  const found = sessionId ? findSessionFile(sessionId) : null;
  // 当前内存会话如果就是该 Run 的 Pi 会话，直接复用；否则优先恢复磁盘会话。
  if (live && (!found || live.session?.sessionId === run.sessionId)) return { key, entry: live };
  if (found) {
    const entry = await agentManager.resumeThread(key, run.threadId, found.fullPath, run.cwd || getWorkspace());
    annotateSessionThread(entry.sessionId, run.threadId);
    return { key, entry };
  }
  return { key, entry: await agentManager.getOrCreate(key, { threadId: run.threadId, cwd: run.cwd || getWorkspace() }) };
}

async function executeContinuation({ key, entry, run, task, references, workflow }) {
  const before = snapshotWorkspace(entry.workspace || run.cwd || getWorkspace());
  try {
    await agentManager.promptWithContext(key, continuationPrompt(task, task.recoveryAction), [], undefined, references, { runId: run.id, task, workflow });
    if (entry?.lastFinalText) recordRunEvent(run.id, "assistant_final", { text: entry.lastFinalText });
    const changed = filterRunChanges(run, await waitForFlush(before, entry.workspace || run.cwd || getWorkspace()));
    const validations = validateArtifacts(changed, entry.workspace || run.cwd || getWorkspace());
    const stagedValidations = validateStagedArtifacts(run.id);
    const allValidations = [...validations, ...stagedValidations];
    const publishableStagedValidations = stagedValidations.filter((item) => item.status !== "failed");
    const cancelled = getRun(run.id)?.status === "cancel_requested";
    const status = cancelled ? "cancelled" : "completed";
    const publishPaths = stagedValidations.filter((item) => item.status !== "failed").map((item) => item.path).filter(Boolean);
    const finished = finishRun(run.id, {
      status,
      sessionId: entry.session?.sessionId || run.sessionId,
      summary: status === "cancelled" ? "恢复任务已取消" : (changed.length ? `恢复任务完成，共处理 ${changed.length} 个文件` : "恢复任务完成，未检测到文件变更"),
      validations: allValidations,
      publishPaths,
      completion: resolveRunCompletion(entry, status, { artifacts: changed.length + publishableStagedValidations.length, validations: allValidations, runId: run.id }),
    });
    const productPaths = [...changed, ...publishableStagedValidations.map((item) => item.path).filter(Boolean)];
    if (productPaths.length) {
      emitChannel(entry, "file_changed", { files: productPaths, runId: run.id });
      emitChannel(entry, "agent_summary", {
        products: productPaths,
        summary: `恢复任务完成，共处理 ${productPaths.length} 个文件：${productPaths.join(", ")}`,
        runId: run.id,
        artifacts: finished?.artifacts || [],
        references,
      });
    }
    emitChannel(entry, "run_finished", { runId: run.id, task, artifacts: finished?.artifacts || [], references, reviewSources: entry.reviewSources || [], status: finished?.status || status, verificationStatus: finished?.verificationStatus || "not_checked", completion: finished?.completion || null, finalText: getRunFinalText(getRun(run.id)) });
    return finished;
  } catch (error) {
    const cancelled = getRun(run.id)?.status === "cancel_requested";
    const message = classifyAgentError(error).message;
    emitChannel(entry, "agent_error", { message, runId: run.id, retryable: !cancelled });
    const finished = finishRun(run.id, {
      status: cancelled ? "cancelled" : "failed",
      sessionId: entry.session?.sessionId || run.sessionId,
      error: message,
      summary: cancelled ? "恢复任务已取消" : "恢复任务失败",
      completion: resolveRunCompletion(entry, cancelled ? "cancelled" : "failed", { runId: run.id }),
    });
    emitChannel(entry, "run_finished", { runId: run.id, task, artifacts: finished?.artifacts || [], references, reviewSources: entry.reviewSources || [], status: finished?.status || "failed", verificationStatus: finished?.verificationStatus || "not_checked", completion: finished?.completion || null, finalText: getRunFinalText(getRun(run.id)) });
    return finished;
    return finished;
  }
}

async function startContinuation(sourceRun, action) {
  if (!CONTINUABLE_RUN_STATUSES.has(sourceRun.status)) throw new Error(`任务当前状态不可${action === "retry" ? "重试" : "继续"}：${sourceRun.status}`);
  if (!sourceRun.task?.goal) throw new Error("原任务缺少可恢复的目标文本");
  const { key, entry } = await ensureContinuationAgent(sourceRun);
  const oldTask = sourceRun.task;
  const goal = String(oldTask.goal || "").trim();
  const references = resolveReferences(oldTask.references || sourceRun.references || [], goal, entry.workspace || sourceRun.cwd || getWorkspace());
  const workflowId = oldTask.workflowId || null;
  const skills = scanSkills();
  const workflow = workflowId ? getWorkflow(workflowId, skills) : null;
  const preflight = preflightSkills({ workflowId, requestedSkills: [], skills });
  if ((workflowId || oldTask.workflowId) && !preflight.ok) {
    const error = new Error(preflight.message);
    error.code = "SKILL_PREFLIGHT_FAILED";
    throw error;
  }
  const capabilityPlan = planTaskCapabilities({ text: goal, task: { ...oldTask, mode: oldTask.mode, workflowId }, references });
  requireWorkspaceWriteForTask(capabilityPlan, entry.workspace || sourceRun.cwd || getWorkspace());
  if (capabilityPlan.routing.officecli === "preferred") {
    capabilityPlan.officecli = await checkOfficecli();
    if (!capabilityPlan.officecli.available) {
      const error = new Error(`Office CLI 预检失败：${capabilityPlan.officecli.message}`);
      error.code = "OFFICE_PREFLIGHT_FAILED";
      throw error;
    }
  }
  const task = createTaskEnvelope({
    ...oldTask,
    id: undefined,
    goal,
    text: goal,
    threadId: sourceRun.threadId,
    references,
    workflowId,
    capabilityPlan,
    recoveryOf: sourceRun.id,
    recoveryAction: action,
    constraints: [...(oldTask.constraints || []), `${action === "retry" ? "重试" : "继续"}自 Run ${sourceRun.id}`],
  });
  const project = projectManager.getProjectForWorkspace(entry.workspace || sourceRun.cwd || getWorkspace());
  const run = beginRun({
    clientId: sourceRun.clientId,
    threadId: sourceRun.threadId,
    sessionId: entry.session?.sessionId || sourceRun.sessionId,
    cwd: entry.workspace || sourceRun.cwd || getWorkspace(),
    task,
    references,
    workflow,
    projectId: project?.id || sourceRun.projectId || null,
    capabilityPlan,
    runtimeSnapshot: agentManager.runtimeSnapshot(key, {
      profile: task.agentProfile,
      taskMode: task.mode,
      capabilityPlanVersion: capabilityPlan?.version || null,
    }),
    recoveryChain: [{ sourceRunId: sourceRun.id, action }],
  });
  recordRunEvent(run.id, "run_recovery_started", { sourceRunId: sourceRun.id, action, preflight });
  void executeContinuation({ key, entry, run, task: { ...task, recoveryAction: action }, references, workflow });
  return run;
}

async function handleContinuation(req, res, action) {
  const sourceRun = getRun(req.params.id);
  if (!sourceRun) return res.status(404).json({ error: "run not found" });
  const allowed = action === "retry" ? sourceRun.actions?.canRetry : sourceRun.actions?.canResume;
  if (!allowed) return res.status(409).json({ error: `任务当前状态不可${action === "retry" ? "重试" : "继续"}：${sourceRun.status}`, run: sourceRun });
  try {
    const run = await startContinuation(sourceRun, action);
    res.status(202).json({ ok: true, run: getRun(run.id), sourceRunId: sourceRun.id });
  } catch (error) {
    const status = ["SKILL_PREFLIGHT_FAILED", "OFFICE_PREFLIGHT_FAILED"].includes(error?.code) ? 409 : 500;
    res.status(status).json({ error: error.message, code: error.code || "RUN_RECOVERY_FAILED", sourceRunId: sourceRun.id });
  }
}

app.post("/api/runs/:id/resume", (req, res) => handleContinuation(req, res, "resume"));
app.post("/api/runs/:id/retry", (req, res) => handleContinuation(req, res, "retry"));

app.post("/api/agent/new", async (req, res) => {
  const { client, thread, cwd, projectId, label } = req.body || {};
  if (!client || !thread) return res.status(400).json({ error: "client and thread required" });
  try {
    const workspace = normalizeWorkspace(cwd || getWorkspace()) || getWorkspace();
    const result = await agentManager.newThread(agentKey(client, thread), thread, workspace);
    annotateSessionThread(result.sessionId, thread);
    const project = projectManager.getProject(projectId) || projectManager.getProjectForWorkspace(workspace);
    updateSessionHeader(result.sessionId, { projectId: project?.id || null, label: String(label || "").trim() });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/agent/resume", async (req, res) => {
  const { client, thread, sessionId, cwd } = req.body || {};
  if (!client || !thread || !sessionId) return res.status(400).json({ error: "client, thread and sessionId required" });
  const found = findSessionFile(sessionId);
  if (!found) return res.status(404).json({ error: "session not found" });
  try {
    const workspace = normalizeWorkspace(cwd || getWorkspace()) || getWorkspace();
    // 会话的工作区归属在创建时固定：禁止用 B 工作区恢复 A 工作区的历史，
    // 否则会串工具根目录、记忆与产物归属。
    const header = readSessionHeader(found);
    const sessionWorkspace = normalizeWorkspace(header?.cwd || "");
    if (sessionWorkspace && workspace && sessionWorkspace !== workspace) {
      return res.status(409).json({
        error: `该会话属于工作区「${sessionWorkspace}」，不能在「${workspace}」恢复；请先切换回原工作区。`,
        code: "SESSION_WORKSPACE_MISMATCH",
      });
    }
    const result = await agentManager.resumeThread(agentKey(client, thread), thread, found.fullPath, workspace);
    annotateSessionThread(result.sessionId, thread);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SSE stream per client
app.get("/api/agent/stream", async (req, res) => {
  const client = String(req.query.client || "");
  const thread = String(req.query.thread || "");
  if (!client) return res.status(400).end();
  const workspace = normalizeWorkspace(req.query.cwd || getWorkspace()) || getWorkspace();
  const project = projectManager.getProjectForWorkspace(workspace);
  const defaultModel = String(project?.settings?.defaultModel || "").trim();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // 先刷新响应头，避免 Pi Runtime 初始化或失效会话恢复较慢时，
  // 浏览器一直收不到 SSE 握手而停在“连接中”。Runtime 就绪状态仍由
  // 后面的 connected 事件确认。
  res.flushHeaders?.();
  let closed = false;
  let heartbeat = null;
  let entry = null;
  let onEvent = null;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (entry && onEvent) entry.channel.emitter.off("event", onEvent);
  };
  req.on("close", cleanup);
  const write = (chunk) => {
    if (closed) return false;
    try {
      res.write(chunk);
      return true;
    } catch {
      cleanup();
      return false;
    }
  };
  write(`data: ${JSON.stringify({
    type: "runtime_connecting",
    at: new Date().toISOString(),
    data: { client, thread },
  })}\n\n`);
  // Runtime 冷启动/恢复期间也要持续刷新代理和 EventSource 的存活时间。
  // 5 秒粒度比默认 15 秒更适合浏览器切换会话后的半开连接检测；
  // 前端会把它当作传输层心跳，不会提前标记 Agent 已握手。
  heartbeat = setInterval(() => {
    write(`event: heartbeat\ndata: ${JSON.stringify({ type: "heartbeat", at: new Date().toISOString() })}\n\n`);
  }, 5000);

try {
    entry = await ensureRuntimeWithTimeout(agentKey(client, thread), { threadId: thread, cwd: workspace, modelSpec: defaultModel });
    if (closed) return;
  // EventSource 新建连接时不会把上一次对象的 Last-Event-ID 带过来，
  // 因此前端同时通过 query 传递游标；两者取最大值，避免重连重复消费历史事件。
  const queryCursor = parseInt(req.query.after || "0", 10) || 0;
  const headerCursor = parseInt(req.headers["last-event-id"] || "0", 10) || 0;
  const requestedCursor = Math.max(queryCursor, headerCursor);
  // 通道代际：Runtime/会话重建会生成新的 streamId，其序号从 1 重新开始。
  // 旧代际游标若继续使用，新通道前 N 个事件会在 send() 里被整段过滤，
  // 造成“只看到最后一个工具/正文丢失”。代际不一致时游标清零。
  const channelStreamId = entry.channel.streamId || "";
  const clientStreamId = String(req.query.stream || "");
  const lastId = resolveReplayCursor({
    clientStreamId,
    channelStreamId,
    lastId: requestedCursor,
    channelSeq: Number(entry.channel.seq || 0),
  });
  const earliestId = entry.channel.history.length ? Number(entry.channel.history[0].id || 0) : 0;
  const latestId = Number(entry.channel.seq || 0);
  // 游标之后的事件如果已经被增量淘汰策略丢弃，回放将不完整，需要明确告知前端重同步。
  const historyTruncated = isHistoryTruncated({ lastId, earliestId });
  // 监听和历史回放之间存在一个竞态窗口：实时事件可能先发出，随后又被
  // history 回放一次。以同一条 SSE 连接的最大已发送 id 做幂等门闩，
  // 保证断线重连只补缺失事件，不重复追加 Token/工具输出。
  let lastSentId = lastId;
  const send = (ev) => {
    if (!ev || closed || Number(ev.id || 0) <= lastSentId) return;
    if (!write(`id: ${ev.id}\ndata: ${JSON.stringify({ id: ev.id, protocolVersion: PROTOCOL_VERSION, streamId: ev.streamId || channelStreamId, type: ev.type, at: ev.at || null, data: ev.data })}\n\n`)) return;
    lastSentId = Number(ev.id || lastSentId);
  };
  // 先挂实时监听，再回放历史。回放前没有 await，但注册顺序仍然很关键：
  // 如果先回放、后监听，另一条请求在这段窗口内产生的事件会被永久漏掉，
  // 前端只能靠刷新重新读取历史才能“恢复”。
  onEvent = (ev) => send(ev);
  entry.channel.emitter.on("event", onEvent);
  // 参考 pi-web：连接建立后发送可被客户端确认的应用层握手，
  // 不把浏览器 EventSource 的 onopen 当作 Agent 已就绪。
  const connectedModel = entry.modelFallbackSpec || (entry.session?.model?.provider && entry.session?.model?.id ? `${entry.session.model.provider}/${entry.session.model.id}` : null);
  write(`data: ${JSON.stringify({
    type: "connected",
    at: new Date().toISOString(),
    data: {
      client,
      thread,
      protocolVersion: PROTOCOL_VERSION,
      streamId: channelStreamId,
      sessionId: entry.session?.sessionId || null,
      model: connectedModel,
      modelFallbackFrom: entry.modelFallbackFrom || null,
      // connected 只能确认客户端请求的游标；历史事件尚未逐条写入响应。
      // 若这里提前宣称最新 seq，回放中途断线会让重连跳过未真正送达的事件。
      cursor: lastSentId,
      earliest: earliestId,
      latest: latestId,
      truncated: historyTruncated,
      serverAt: new Date().toISOString(),
    },
  })}\n\n`);
  if (historyTruncated) {
    // 明确告知：游标与当前历史窗口已不连续。前端据此触发 Run 对账，
    // 用服务端 Run 终态和最终文本重建，而不是依赖已被淘汰的事件。
    write(`data: ${JSON.stringify({
      type: "stream_resync",
      at: new Date().toISOString(),
      data: { client, thread, streamId: channelStreamId, cursor: lastId, earliest: earliestId, latest: latestId },
    })}\n\n`);
  }
  // 首次连接（无游标）只回放最近 300 条：聊天正文由会话 JSONL 恢复，
  // 全量回放（可达数千条 token/thinking 事件）会明显拖慢刷新。
  const replayHistory = lastId === 0 && entry.channel.history.length > 300
    ? entry.channel.history.slice(-300)
    : entry.channel.history;
  for (const ev of replayHistory) if (ev.id > lastId) send(ev);
  write(`event: open\ndata: ${JSON.stringify({ historyId: entry.channel.seq, streamId: channelStreamId })}\n\n`);
} catch (error) {
    if (error?.code === "RUNTIME_INIT_TIMEOUT") {
      if (!closed) {
        write(`data: ${JSON.stringify({
          type: "runtime_init_failed",
          at: new Date().toISOString(),
          data: { client, thread, code: error?.code, retryable: error?.retryable !== false, message: String(error?.message || error).slice(0, 500) },
        })}\n\n`);
        try { res.end(); } catch {}
      }
      cleanup();
      return;
    }
    if (!closed) {
      const diagnostic = classifyAgentError(error);
      write(`data: ${JSON.stringify({
        type: "agent_error",
        at: new Date().toISOString(),
        data: {
          code: diagnostic.code || "RUNTIME_CONNECT_FAILED",
          message: diagnostic.message || "Agent Runtime 连接失败",
          retryable: Boolean(diagnostic.retryable),
          client,
          thread,
        },
      })}\n\n`);
      try { res.end(); } catch {}
    }
    cleanup();
  }
});

function loadModelsStore() {
  return readModelsStore();
}
function loadSettingsDefault() {
  const settings = readRuntimeSettings();
  return (settings.defaultProvider ? settings.defaultProvider + "/" : "") + (settings.defaultModel || "");
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
  const raw = String(rel || "").replace(/\\/g, "/").trim();
  if (!raw || path.isAbsolute(raw) || raw.split("/").includes("..")) return null;
  if (raw === "AGENTS.md") return getAgentsMd();
  const base = path.resolve(getMemoryDir());
  const target = path.resolve(base, raw);
  return target === base || !target.startsWith(base + path.sep) ? null : target;
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
    ensureDirectory(memDir);
    if (!fs.existsSync(agentsMd)) {
      atomicWriteFile(agentsMd, `# AGENTS.md\n\n## 项目说明\n\n在此添加项目指令和上下文信息。\n\n## 工作偏好\n\n在此添加工作偏好。\n`, "utf8");
    }
    if (!fs.existsSync(memMd)) {
      atomicWriteFile(memMd, `# 记忆索引\n\n这是一个长期记忆文件，记录跨会话的上下文信息。\n\n## 项目信息\n\n## 工作规则\n\n## 用户偏好\n\n## 经验教训\n\n`, "utf8");
    }
    appendEvent({ type: "memory_initialized", data: { workspace: ws } });
    startMemoryWatcher();
    res.json({ ok: true, files: listMemoryFiles() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/memory/proposals", (req, res) => {
  const threadId = req.query.thread ? agentKey(String(req.query.client || ""), String(req.query.thread)) : "";
  const workspace = req.query.workspace ? normalizeWorkspace(req.query.workspace) : "";
  const status = String(req.query.status || "").trim();
  const proposals = agentManager.memoryProposals(threadId, {
    workspace,
    projectId: String(req.query.projectId || "").trim(),
    category: String(req.query.category || "").trim(),
    status,
  });
  res.json({ proposals });
});

function sendMemoryResult(res, result) {
  if (!result?.ok) return res.status(result?.status || 400).json(result);
  res.json(result);
}

app.post("/api/memory/proposals/:id/approve", (req, res) => {
  sendMemoryResult(res, agentManager.approveMemoryProposal(req.params.id, {
    content: req.body?.content,
    category: req.body?.category,
    section: req.body?.section,
    reviewer: req.body?.reviewer || "user",
  }));
});

app.patch("/api/memory/proposals/:id", (req, res) => {
  sendMemoryResult(res, agentManager.editMemoryProposal(req.params.id, {
    content: req.body?.content,
    category: req.body?.category,
    section: req.body?.section,
  }));
});

app.post("/api/memory/proposals/:id/reject", (req, res) => {
  sendMemoryResult(res, agentManager.rejectMemoryProposal(req.params.id, req.body?.reason));
});

app.get("/api/memory/proposals/:id/history", (req, res) => {
  sendMemoryResult(res, agentManager.memoryProposalHistory(req.params.id));
});

app.post("/api/memory/proposals/:id/merge", (req, res) => {
  sendMemoryResult(res, agentManager.mergeMemoryProposals(req.params.id, req.body?.sourceIds));
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
    ensureDirectory(path.dirname(fp));
    atomicWriteFile(fp, req.body?.content || "", "utf8");
    appendEvent({ clientId: String(req.body?.client || "") || null, threadId: String(req.body?.thread || "") || null, type: "memory_file_edited", data: { workspace: getWorkspace(), path: req.params[0], source: "memory-panel" } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- 地图项目（MapLibre 可视化） ----------
import * as mapSvc from "./map.mjs";

// 底图服务设置（Key 不回传明文，只回传是否已配置）
app.get("/api/map/settings", (_req, res) => {
  const s = mapSvc.loadMapSettings();
  res.json({
    basemaps: {
      tiandituKey: !!s.basemaps?.tiandituKey,
      maptilerKey: !!s.basemaps?.maptilerKey,
      geoapifyKey: !!s.basemaps?.geoapifyKey,
      esriToken: !!s.basemaps?.esriToken,
    },
  });
});

// 保存底图服务 Key → 重建所有项目 style.json 的底图部分
app.post("/api/map/settings", (req, res) => {
  try {
    const s = mapSvc.saveMapSettings(req.body?.basemaps || {});
    const projects = mapSvc.listProjects();
    for (const p of projects) mapSvc.rebuildBasemapStyle(p.project);
    res.json({
      ok: true,
      basemaps: {
        tiandituKey: !!s.basemaps?.tiandituKey,
        maptilerKey: !!s.basemaps?.maptilerKey,
        geoapifyKey: !!s.basemaps?.geoapifyKey,
        esriToken: !!s.basemaps?.esriToken,
      },
      projects: projects.map((p) => p.project),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// ---------- M2 宏观交通分析 API ----------

function sendMapAnalysis(res, loader) {
  try {
    const payload = loader();
    if (payload?.error === "项目不存在") return res.status(404).json(payload);
    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// 路网流量带宽图
app.get("/api/map/traffic-bandwidth", (req, res) => {
  const name = req.query.project || "zhejiang-map";
  sendMapAnalysis(res, () => map.getTrafficBandwidth(name));
});

// OD 期望线数据
app.get("/api/map/od-lines", (req, res) => {
  const name = req.query.project || "zhejiang-map";
  sendMapAnalysis(res, () => map.getODLines(name));
});

// 多时距等时圈
app.post("/api/map/multi-isochrone", async (req, res) => {
  try {
    const { location, mode, ranges, rangeType } = req.body || {};
    res.json(await map.multiIsochrone({ location, mode, ranges, rangeType }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 区域交换量桑基图
app.get("/api/map/exchange-sankey", (req, res) => {
  const name = req.query.project || "zhejiang-map";
  sendMapAnalysis(res, () => map.getExchangeSankey(name));
});

// 路网结构统计
app.get("/api/map/road-structure", (req, res) => {
  const name = req.query.project || "zhejiang-map";
  sendMapAnalysis(res, () => map.getRoadStructure(name));
});

// 柬埔寨暹粒 OD 演示数据（来源路径可通过 CAMBODIA_OD_FILE 覆盖）
app.get("/api/demo/cambodia-od", (req, res) => {
  const payload = cambodiaOD.getCambodiaOD({ minFlow: req.query.minFlow });
  if (payload.error) return res.status(404).json(payload);
  res.json(payload);
});

// 不依赖 Agent 的地图演示入口，供工具栏按钮和验收流程直接调用。
app.get("/api/map/demo-analysis", (req, res) => {
  const analysis = ["heatmap", "od", "isochrone"].includes(req.query.analysis) ? req.query.analysis : "heatmap";
  const payload = createDemoAnalysis({ analysis, region: String(req.query.region || "义乌市"), project: String(req.query.project || "zhejiang-map"), count: Number(req.query.count || 36) });
  res.json(payload);
});

// ---------- M3 新昌公交分析 ----------
import * as m3 from "./m3-xinchang.mjs";

app.get("/api/m3/bus-routes", (_req, res) => {
  try { res.json(m3.getBusRoutes()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/m3/station-heatmap", (_req, res) => {
  try { res.json(m3.getStationHeatmap()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/m3/od-lines", (_req, res) => {
  try { res.json(m3.getBusODLines()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/m3/network-stats", (_req, res) => {
  try { res.json(m3.getBusNetworkStats()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- static ----------
const dist = CLIENT_DIST;
// 未知 API 必须返回 JSON 404，避免前端把 index.html 当作接口响应解析。
app.use("/api", (_req, res) => res.status(404).json({ error: "api endpoint not found" }));
if (fs.existsSync(path.join(dist, "index.html"))) {

// ---------- M3 公交数据分析 API ----------

// 公交线路数据
app.get("/api/bus/routes", (req, res) => {
  res.json(map.getBusRoutes());
});

// 公交站点数据
app.get("/api/bus/stops", (req, res) => {
  res.json(map.getBusStops());
});

// 公交 OD 数据
app.get("/api/bus/od", (req, res) => {
  const period = req.query.period || "all";
  res.json(map.getBusOD(period));
});

// 公交线网统计
app.get("/api/bus/stats", (req, res) => {
  res.json(map.getBusStats());
});

  app.use(express.static(dist, {
    setHeaders: (res, filePath) => {
      // index.html 负责引用当前构建的资源；不缓存它，避免前端继续运行旧的
      // SSE 事件过滤逻辑。带 hash 的 assets 仍由 Vite 自己长期缓存。
      if (path.basename(filePath).toLowerCase() === "index.html") {
        res.setHeader("Cache-Control", "no-store, max-age=0");
      }
    },
  }));
  // 构建产物缺失时返回明确 404，避免旧缓存请求拿到 index.html。
  app.use("/assets", (_req, res) => res.status(404).json({ error: "asset not found" }));
  app.get("/*splat", (_req, res) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.sendFile(path.join(dist, "index.html"));
  });
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
function snapshotWorkspace(workspace = getWorkspace()) {
  const ws = normalizeWorkspace(workspace) || getWorkspace();
  return walkWorkspaceSnapshot(ws, ws);
}

const SNAPSHOT_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".venv", ".oaw", ".cache", "coverage", ".next", ".idea", ".vscode"]);
const SNAPSHOT_SKIP_EXT = /\.(tmp|temp|swp|swo|bak|log|lock|part|crdownload|msi|exe|dll|pyc)$/i;
const SNAPSHOT_MAX_FILES = 30000;
const SNAPSHOT_MAX_DEPTH = 10;

// 递归快照工作区内的文件（目录 mtime 会在任何写入时变化，不能当作产物）。
function walkWorkspaceSnapshot(dir, root, depth = 0, count = { n: 0 }) {
  const out = [];
  if (depth > SNAPSHOT_MAX_DEPTH || count.n >= SNAPSHOT_MAX_FILES) return out;
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of items) {
    if (count.n >= SNAPSHOT_MAX_FILES) break;
    if (e.name.startsWith(".") || e.name.startsWith("~$")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SNAPSHOT_SKIP_DIRS.has(e.name)) continue;
      out.push(...walkWorkspaceSnapshot(p, root, depth + 1, count));
    } else {
      if (SNAPSHOT_SKIP_EXT.test(e.name)) continue;
      try {
        const st = fs.statSync(p);
        out.push(`${path.relative(root, p).replace(/\\/g, "/")}|${st.mtimeMs}|${st.size}`);
        count.n += 1;
      } catch {}
    }
  }
  return out;
}
function diffWorkspace(before, after) {
  const b = new Set(before);
  return after.filter((x) => !b.has(x)).map((x) => x.split("|")[0]);
}
async function waitForFlush(before, workspace = getWorkspace()) {
  let last = before;
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const snap = snapshotWorkspace(workspace);
    if (JSON.stringify(snap) === JSON.stringify(last)) break;
    last = snap;
  }
  return diffWorkspace(before, last);
}
function emitChannel(entry, type, data) {
  const id = ++entry.channel.seq;
  const at = new Date().toISOString();
  const workspace = ["agent_summary", "run_finished"].includes(type)
    ? { workspace: data?.workspace ?? entry.workspace ?? null }
    : {};
  const eventData = data && typeof data === "object" && !Array.isArray(data)
    ? { ...data, ...workspace, runId: data.runId ?? entry.activeRunId ?? null }
    : { value: data, ...workspace, runId: entry.activeRunId ?? null };
  const ev = { id, type, at, streamId: entry.channel.streamId || null, protocolVersion: PROTOCOL_VERSION, data: eventData };
  // 与 agent.mjs 的受保护写入一致：高频事件不挤掉工具边界与终态
  if (!entry.channel.historyLimit) entry.channel.historyLimit = CHANNEL_HISTORY_LIMIT;
  pushChannelEvent(entry.channel, ev);
  entry.channel.emitter.emit("event", ev);
  // capability_plan/run_finished 已由 recordRunEvent/finishRun 写入 Store，
  // 其余由 HTTP 层补发的摘要/错误/文件事件在这里进入根级事件流。
  if (! ["capability_plan", "run_finished"].includes(type)) {
    appendEvent({ clientId: entry.clientId, threadId: entry.threadId, runId: eventData.runId, type, data: eventData });
  }
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


// ---------- M3 公交数据分析 API ----------

// 公交线路数据
app.get("/api/bus/routes", (req, res) => {
  res.json(map.getBusRoutes());
});

// 公交站点数据
app.get("/api/bus/stops", (req, res) => {
  res.json(map.getBusStops());
});

// 公交 OD 数据
app.get("/api/bus/od", (req, res) => {
  const period = req.query.period || "all";
  res.json(map.getBusOD(period));
});

// 公交线网统计
app.get("/api/bus/stats", (req, res) => {
  res.json(map.getBusStats());
});

if (!API_TOKEN && !["127.0.0.1", "localhost", "::1"].includes(String(HOST))) {
  console.warn("[security] HOST is not loopback and OAW_API_TOKEN is not set; API requests are unauthenticated.");
}

let httpServer = null;
let shuttingDown = false;

function recordProcessFault(kind, error) {
  const message = String(error?.message || error || "未知服务异常");
  const record = {
    time: new Date().toISOString(),
    requestId: null,
    clientId: null,
    threadId: null,
    runId: null,
    model: null,
    providerStatus: null,
    errorCode: error?.code ? String(error.code) : "SERVICE_PROCESS_FAULT",
    errorCategory: "service",
    causeCode: error?.cause?.code ? String(error.cause.code) : null,
    retryable: false,
    message: message.slice(0, 1200),
    processFault: kind,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
  };
  try { fs.appendFileSync(AGENT_DIAGNOSTIC_LOG, JSON.stringify(record) + "\n", "utf8"); } catch {}
  console.error(`[service] ${kind}:`, error?.stack || error);
}

async function shutdownService(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.warn(`[service] 正在关闭（${reason}）...`);
  try { await agentManager.disposeAll(); } catch (error) { recordProcessFault("shutdown_dispose_failed", error); }
  try { stopAllWatches(); } catch (error) { recordProcessFault("shutdown_watch_failed", error); }
  if (memoryWatcher) { try { memoryWatcher.close(); } catch (error) { recordProcessFault("shutdown_memory_watch_failed", error); } }
  if (httpServer) {
    await new Promise((resolve) => {
      try { httpServer.close(() => resolve()); } catch { resolve(); }
    });
  }
  process.exit(exitCode);
}

// 未捕获异常后继续复用同一个 Node 进程是不安全的：Pi 会话、SSE 订阅或文件锁
// 可能已经处于不一致状态。记录后退出，由启动脚本的监督循环拉起干净进程。
process.on("uncaughtException", (error) => {
  recordProcessFault("uncaught_exception", error);
  void shutdownService("uncaught_exception", 1);
});
// 未处理拒绝通常来自单个 provider/SSE 请求，不能让整个本地工作台退出；先留痕，
// 由具体 Agent/HTTP 链路完成有限重试和错误收敛。
process.on("unhandledRejection", (reason) => {
  recordProcessFault("unhandled_rejection", reason);
});

httpServer = app.listen(PORT, HOST, () => {
  console.log(`Open Plan（规聚）running at http://${HOST}:${PORT}`);
  console.log(`workspace: ${WORKSPACE_DIR}`);
  if (API_TOKEN) console.log("API authentication enabled (use /?token=<OAW_API_TOKEN> for the browser UI).");
  // 预热共享 ModelRuntime（模型目录/凭据/供应商缓存为全局单例）：
  // 让第一个会话的冷启动成本在服务启动时先行承担，用户首条消息不再等待目录加载。
  void agentManager.modelRuntime().catch((error) => {
    console.warn(`[prewarm] ModelRuntime 预热失败（将在会话创建时重试）：${String(error?.message || error).slice(0, 300)}`);
  });
});
// SSE 连接由 15 秒 heartbeat 保活；关闭 Node 默认的请求/Socket 空闲超时，
// 避免长文档任务超过默认时限后断流，而 Agent 实际仍在继续执行。
httpServer.requestTimeout = 0;
httpServer.timeout = 0;
httpServer.keepAliveTimeout = 65000;
httpServer.on("error", (error) => {
  console.error(`[server] 监听 ${HOST}:${PORT} 失败：`, error?.stack || error);
  if (error?.code === "EADDRINUSE") {
    console.error(`[server] ${HOST}:${PORT} 已被其他 Open Plan 实例占用；本重复实例将退出，请使用现有服务。`);
    setImmediate(() => process.exit(1));
  }
});

process.on("SIGINT", () => { void shutdownService("SIGINT", 0); });
process.on("SIGTERM", () => { void shutdownService("SIGTERM", 0); });

// ---------- M3 公交数据分析 API ----------

// 公交线路数据
app.get("/api/bus/routes", (req, res) => {
  res.json(map.getBusRoutes());
});

// 公交站点数据
app.get("/api/bus/stops", (req, res) => {
  res.json(map.getBusStops());
});

// 公交 OD 数据
app.get("/api/bus/od", (req, res) => {
  const period = req.query.period || "all";
  res.json(map.getBusOD(period));
});

// 公交线网统计
app.get("/api/bus/stats", (req, res) => {
  res.json(map.getBusStats());
});
