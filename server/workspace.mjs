import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    _currentWorkspace = d;
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

export function listWorkspace(dir) {
  const target = dir || _currentWorkspace;
  if (!fs.existsSync(target)) return [];
  const items = fs.readdirSync(target, { withFileTypes: true });
  const files = items
    .filter((e) => e.isFile() && !e.name.startsWith("~$") && !e.name.startsWith(".") && /\.(docx|xlsx|pptx|md|markdown|txt|html|htm)$/i.test(e.name))
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
  const n = String(rel || "").replace(/^\\/g, "").replace(/^\//g, "");
  if (!n || n.includes("..")) return null;
  const p = path.join(_currentWorkspace, n);
  return fs.existsSync(p) ? p : null;
}

export function filePath(name) {
  const n = safeName(name);
  if (!n) return null;
  const p = path.join(_currentWorkspace, n);
  return fs.existsSync(p) ? p : null;
}
