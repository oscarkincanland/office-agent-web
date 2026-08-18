import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_DIR = path.resolve(__dirname, "..");
export const WORKSPACE_DIR = path.join(PROJECT_DIR, "office-workspace");
export const CLIENT_DIST = path.join(PROJECT_DIR, "client", "dist");

// OfficeCLI 二进制解析优先级：
//   1. 环境变量 OFFICECLI_BIN（显式指定）
//   2. 项目内置 bin/officecli（node scripts/install-officecli.mjs 安装）
//   3. 系统 PATH 中的 officecli
//   4. Windows 默认安装路径（officecli.ai 官方安装脚本）
function resolveOfficecli() {
  if (process.env.OFFICECLI_BIN) return process.env.OFFICECLI_BIN;
  const bundled = path.join(PROJECT_DIR, "bin", process.platform === "win32" ? "officecli.exe" : "officecli");
  if (fs.existsSync(bundled)) return bundled;
  const onPath = process.platform === "win32" ? null : (() => { try { return requireResolveInPath("officecli"); } catch { return null; } })();
  if (onPath) return onPath;
  return path.join(process.env.LOCALAPPDATA || "C:\\Users\\admin\\AppData\\Local", "OfficeCLI", "officecli.exe");
}

function requireResolveInPath(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const d of dirs) {
    try {
      const p = path.join(d, name);
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

export const OFFICECLI = resolveOfficecli();

export const AGENT_DIR =
  process.env.PI_AGENT_DIR ||
  (process.platform === "win32"
    ? "C:\\Users\\admin\\.pi\\agent"
    : path.join(os.homedir(), ".pi", "agent"));

fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

const ROOTS_STATE_FILE = path.join(PROJECT_DIR, ".file-roots.json");
const SUPPORTED_EXTENSIONS = /\.(docx|xlsx|pptx|pdf|csv|json|md|markdown|txt|html|htm)$/i;

// 当前工作区（可切换），默认项目内的 office-workspace；切换后持久化，重启恢复
let _currentWorkspace = WORKSPACE_DIR;
const WS_STATE_FILE = path.join(PROJECT_DIR, ".workspace-state.json");
try {
  const saved = JSON.parse(fs.readFileSync(WS_STATE_FILE, "utf8"));
  if (saved && saved.workspace && fs.existsSync(saved.workspace) && fs.statSync(saved.workspace).isDirectory()) {
    _currentWorkspace = saved.workspace;
  }
} catch {}

export function getWorkspace() {
  return _currentWorkspace;
}

export function setWorkspace(dir) {
  const d = String(dir || "").trim();
  if (!d) return false;
  try {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    const real = fs.realpathSync(d);
    if (!fs.statSync(real).isDirectory()) return false;
    _currentWorkspace = real;
    try { fs.writeFileSync(WS_STATE_FILE, JSON.stringify({ workspace: d }, null, 2), "utf8"); } catch {}
    return true;
  } catch {
    return false;
  }
}

export function safeName(name) {
  const base = path.basename(String(name || ""));
  if (!base || base.includes("..") || /[\\/:*?"<>|]/.test(base)) return null;
  return base;
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function readFileRoots() {
  try {
    const roots = JSON.parse(fs.readFileSync(ROOTS_STATE_FILE, "utf8"));
    return Array.isArray(roots) ? roots.filter((r) => r?.id && r?.path && fs.existsSync(r.path)) : [];
  } catch {
    return [];
  }
}

export function listFileRoots() {
  return readFileRoots().map((r) => ({ ...r, path: fs.realpathSync(r.path) }));
}

export function addFileRoot(dir, label = "") {
  const raw = String(dir || "").trim();
  if (!raw) return { ok: false, error: "path required" };
  try {
    const real = fs.realpathSync(raw);
    if (!fs.statSync(real).isDirectory()) return { ok: false, error: "不是文件夹" };
    const roots = readFileRoots();
    const existing = roots.find((r) => r.path === real);
    if (existing) return { ok: true, root: { ...existing, path: real }, roots: listFileRoots() };
    const id = crypto.createHash("sha1").update(real).digest("hex").slice(0, 12);
    const root = { id, path: real, label: String(label || path.basename(real) || real), created: new Date().toISOString() };
    fs.writeFileSync(ROOTS_STATE_FILE, JSON.stringify([...roots, root], null, 2) + "\n", "utf8");
    return { ok: true, root, roots: listFileRoots() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function removeFileRoot(id) {
  const roots = readFileRoots();
  const next = roots.filter((r) => r.id !== String(id || ""));
  if (next.length === roots.length) return { ok: false, error: "root not found" };
  fs.writeFileSync(ROOTS_STATE_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
  return { ok: true, roots: listFileRoots() };
}

export function resolveExternalPath(rootId, rel = "") {
  const root = listFileRoots().find((r) => r.id === String(rootId || ""));
  if (!root) return null;
  const clean = String(rel || "").replace(/^[/\\]+/, "");
  if (!clean || clean.includes("\0") || clean.split(/[\\/]/).includes("..") || path.isAbsolute(clean)) return null;
  const target = path.resolve(root.path, clean);
  if (!isInside(root.path, target) || !fs.existsSync(target)) return null;
  const real = fs.realpathSync(target);
  return isInside(root.path, real) ? real : null;
}

export function listWorkspace(dir) {
  const target = dir || _currentWorkspace;
  if (!fs.existsSync(target)) return [];
  const items = fs.readdirSync(target, { withFileTypes: true });
  const files = items
    .filter((e) => e.isFile() && !e.name.startsWith("~$") && !e.name.startsWith(".") && SUPPORTED_EXTENSIONS.test(e.name))
    .map((e) => {
      const st = fs.statSync(path.join(target, e.name));
      return { name: e.name, size: st.size, mtime: st.mtimeMs, ext: path.extname(e.name).slice(1).toLowerCase(), isDir: false };
    });
  const dirs = items
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => {
      const st = fs.statSync(path.join(target, e.name));
      return { name: e.name, size: 0, mtime: st.mtimeMs, ext: "folder", isDir: true };
    });
  return [...dirs, ...files].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// 解析相对路径（支持子目录），返回绝对路径
export function resolvePath(rel) {
  const raw = String(rel || "").trim();
  if (!raw || raw.includes("\0") || raw.split(/[\\/]/).includes("..") || path.isAbsolute(raw) || raw.startsWith("\\\\") || raw.startsWith("//") || /^[a-zA-Z]:[\\/]/.test(raw)) return null;
  const n = raw.replace(/^\\/g, "").replace(/^\//g, "");
  const p = path.resolve(_currentWorkspace, n);
  if (!isInside(_currentWorkspace, p) || !fs.existsSync(p)) return null;
  try {
    const real = fs.realpathSync(p);
    return isInside(fs.realpathSync(_currentWorkspace), real) ? real : null;
  } catch {
    return null;
  }
}

export function filePath(name) {
  return resolvePath(name);
}

export { SUPPORTED_EXTENSIONS };
