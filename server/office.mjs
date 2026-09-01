import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { OFFICECLI, WORKSPACE_DIR } from "./workspace.mjs";
import { officeLimiter } from "./Pi运行时管理.mjs";

/**
 * Run an officecli command inside the workspace directory.
 * Returns { code, stdout, stderr, json } — `json` is parsed when --json was used
 * or when output starts with {/[.
 */
export function runOfficecli(args, { cwd = WORKSPACE_DIR, timeoutMs = 120000, executable = OFFICECLI } = {}) {
  return officeLimiter.run(() => new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`officecli timeout: ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`officecli not found at ${executable}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let json = null;
      const text = out.trim();
      if (text && (text.startsWith("{") || text.startsWith("["))) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      resolve({ code, stdout: out, stderr: err, text, json });
    });
  }), { cwd, args: Array.isArray(args) ? args.slice(0, 8) : [] });
}

export async function checkOfficecli(timeoutMs = 8000, executable = OFFICECLI) {
  if (path.isAbsolute(executable) && !fs.existsSync(executable)) {
    return { available: false, path: executable, code: null, message: `Office CLI 文件不存在：${executable}` };
  }
  try {
    const result = await runOfficecli(["--help"], { timeoutMs, executable });
    return { available: result.code === 0, path: executable, code: result.code, message: result.code === 0 ? "Office CLI 可用" : (result.stderr || result.text || "Office CLI 返回异常").trim().slice(0, 500) };
  } catch (error) {
    return { available: false, path: executable, code: null, message: String(error?.message || error || "Office CLI 不可用").slice(0, 500) };
  }
}

/** L1 read: view document in a mode. */
export async function view(file, mode, extra = []) {
  return runOfficecli(["view", file, mode, ...extra]);
}

/** L1 read: get node JSON. */
export async function get(file, path = "/", depth = 2) {
  return runOfficecli(["get", file, path, "--depth", String(depth), "--json"]);
}

/** L2 edit: set properties / find-replace. */
export async function set(file, path = "/", props = []) {
  const args = ["set", file, path];
  for (const p of props) args.push("--prop", p);
  return runOfficecli([...args, "--json"]);
}

/** L2 batch edit: array of {command, path, props|parent|type|...} */
export async function batch(file, commands) {
  const args = ["batch", file, "--commands", JSON.stringify(commands), "--json"];
  return runOfficecli(args);
}

/** Render docx/pptx to self-contained HTML (stdout). */
export async function renderHtml(file) {
  const r = await runOfficecli(["view", file, "html"]);
  return r.stdout;
}

// ---------- watch 模式管理 ----------
// 按文件维护 watch 进程，提供实时预览 URL。agent 修改文件后 watch 自动刷新。
const watchProcs = new Map(); // file -> { child, port }
const PORT_RANGE = { start: 26315, end: 26400 };
let nextPort = PORT_RANGE.start;

/** 启动（或复用）某文件的 watch 进程，返回 { url, port }。 */
export function startWatch(file) {
  if (watchProcs.has(file)) return watchProcs.get(file);
  // 找空闲端口
  let port = nextPort++;
  if (port > PORT_RANGE.end) port = PORT_RANGE.start;
  const child = spawn(OFFICECLI, ["watch", file, "--port", String(port)], {
    cwd: path.dirname(file),
    windowsHide: true,
  });
  const entry = { child, port, file, ready: false };
  watchProcs.set(file, entry);
  child.on("exit", () => {
    watchProcs.delete(file);
  });
  // 等待 ready
  return new Promise((resolve) => {
    let out = "";
    const onData = (d) => {
      out += d;
      if (!entry.ready && /http:\/\/localhost:\d+/i.test(out)) {
        entry.ready = true;
        resolve(entry);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    setTimeout(() => {
      if (!entry.ready) {
        entry.ready = true;
        resolve(entry);
      }
    }, 5000);
  });
}

/** 停止某文件的 watch 进程。 */
export function stopWatch(file) {
  const entry = watchProcs.get(file);
  if (entry) {
    try { entry.child.kill(); } catch {}
    watchProcs.delete(file);
  }
}

/** 停止所有 watch 进程（服务关闭时调用）。 */
export function stopAllWatches() {
  for (const [file, entry] of watchProcs) {
    try { entry.child.kill(); } catch {}
  }
  watchProcs.clear();
}

/** Read xlsx sheet as structured JSON. */
export async function sheetJson(file, sheet = null) {
  const target = sheet ? `/${sheet}` : "/";
  const r = await runOfficecli(["get", file, target, "--depth", "3", "--json"]);
  return r;
}

/** Workbook structure: sheets + dimensions. */
export async function workbookInfo(file) {
  const r = await runOfficecli(["get", file, "/", "--depth", "1", "--json"]);
  return r;
}
