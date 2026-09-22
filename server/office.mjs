import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { OFFICECLI, WORKSPACE_DIR } from "./workspace.mjs";
import { officeLimiter } from "./Pi运行时管理.mjs";

const FILE_ARGUMENT_COMMANDS = new Set([
  "view", "get", "set", "batch", "query", "watch", "open", "close", "save", "validate", "refresh", "dump",
  "create", "add", "remove", "move", "swap", "delete", "import", "export",
]);

function createOfficeCliError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

/**
 * Office CLI 的文件参数必须相对当前工作区，避免 WSL/Windows 绝对路径混用，
 * 也避免 Agent 越过当前工作区访问其它目录。
 */
export function validateOfficecliArgs(args, cwd = WORKSPACE_DIR) {
  if (!Array.isArray(args) || !args.length) {
    throw createOfficeCliError("Office CLI 命令不能为空", "OFFICECLI_ARGS_INVALID");
  }
  const command = String(args[0] || "").trim().toLowerCase();
  const file = FILE_ARGUMENT_COMMANDS.has(command) ? String(args[1] || "").trim() : "";
  if (!file) return { command, file: null, path: null };
  const root = path.resolve(cwd);
  const target = path.resolve(root, file);
  // 模型有时会直接复述上下文里的绝对路径。只要它仍在当前工作区内，
  // 归一化为相对路径后再交给 Office CLI；越出工作区的路径继续拒绝。
  if (path.isAbsolute(file)) {
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw createOfficeCliError("Office CLI 文件路径超出当前工作区范围", "OFFICE_PATH_SCOPE_ERROR", { command, file });
    }
    return { command, file: path.relative(root, target), path: target, absolute: true };
  }
  if (file.split(/[\\/]/).includes("..")) {
    throw createOfficeCliError("Office CLI 文件路径必须是当前工作区内的相对路径", "OFFICE_PATH_SCOPE_ERROR", { command, file });
  }
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw createOfficeCliError("Office CLI 文件路径超出当前工作区范围", "OFFICE_PATH_SCOPE_ERROR", { command, file });
  }
  return { command, file, path: target, absolute: false };
}

/** Office CLI 子进程环境：默认放宽大工作簿的元素上限（供应商默认 300 万会拒开大表）。 */
function officecliEnv() {
  const env = { ...process.env };
  if (!env.OFFICECLI_MAX_DOM_ELEMENTS) env.OFFICECLI_MAX_DOM_ELEMENTS = "8000000";
  return env;
}

/** 是否"文件被其他进程占用"（OfficeCLI 会以 io_error + being used by another process 报出）。 */
export function isOfficeSharingViolation(result) {
  const text = `${result?.stderr || ""}\n${result?.stdout || ""}\n${result?.text || ""}`;
  return /being used by another process|sharing violation|正在被另一个进程使用/i.test(text);
}

const MUTATING_COMMANDS = new Set(["set", "batch", "add", "remove", "move", "swap", "delete", "create", "import", "save"]);

/**
 * Run an officecli command inside the workspace directory.
 * Returns { code, stdout, stderr, json } — `json` is parsed when --json was used
 * or when output starts with {/[.
 */
export function runOfficecli(args, { cwd = WORKSPACE_DIR, timeoutMs = 120000, executable = OFFICECLI } = {}) {
  const command = Array.isArray(args) ? args.map(String) : [];
  return runOfficecliOnce(command, { cwd, timeoutMs, executable }).then(async (result) => {
    // 文件被 WPS/Word/Excel 打开时写入会失败：自动 close 释放句柄后重试一次，
    // 仍失败则标记 lockBlocked，由上层提示用户关闭文档（而不是让模型反复重试）。
    const file = MUTATING_COMMANDS.has(command[0]?.toLowerCase()) ? command[1] : "";
    if (result.code === 0 || !file || !isOfficeSharingViolation(result)) return result;
    try { await runOfficecliOnce(["close", file], { cwd, timeoutMs: 20000, executable }); } catch {}
    const retry = await runOfficecliOnce(command, { cwd, timeoutMs, executable });
    retry.lockRecoveryAttempted = true;
    if (!isOfficeSharingViolation(retry)) return retry;
    retry.lockBlocked = true;
    return retry;
  });
}

function runOfficecliOnce(command, { cwd = WORKSPACE_DIR, timeoutMs = 120000, executable = OFFICECLI } = {}) {
  return officeLimiter.run(() => new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, command, { cwd, windowsHide: true, env: officecliEnv() });
    } catch (error) {
      reject(createOfficeCliError(`Office CLI 启动失败：${error?.message || error}`, "OFFICECLI_START_FAILED", { executable, cwd, args: command }));
      return;
    }
    let out = "";
    let err = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch {}
      if (!settled) {
        settled = true;
        reject(createOfficeCliError(`Office CLI 超时（${timeoutMs}ms）：${command.join(" ")}`, "OFFICECLI_TIMEOUT", { executable, cwd, args: command, timeoutMs }));
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const detail = e?.code === "ENOENT" ? `officecli not found: ${e.message}` : e.message;
      reject(createOfficeCliError(`Office CLI 启动失败（${executable}）：${detail}`, "OFFICECLI_START_FAILED", { executable, cwd, args: command }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      let json = null;
      const text = out.trim();
      if (text && (text.startsWith("{") || text.startsWith("["))) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      resolve({ code, stdout: out, stderr: err, text, json, command, executable, cwd, timedOut });
    });
  }), { cwd, args: Array.isArray(command) ? command.slice(0, 8) : [] });
}

// Office CLI 探测缓存：成功 60 秒内复用，失败 15 秒内复用。
// 每次 prompt admission 都可能触发 checkOfficecli()，避免反复 spawn officecli.exe。
// 缓存按可执行文件路径区分，显式注入其他路径（如测试里的缺失 CLI）不会命中缓存。
const OFFICECLI_PROBE_CACHE_TTL_MS = 60000;
const OFFICECLI_PROBE_FAIL_TTL_MS = 15000;
let officecliProbeCache = null; // { key, result, expiresAt }

export async function checkOfficecli(timeoutMs = 8000, executable = OFFICECLI) {
  const now = Date.now();
  const key = String(executable || "");
  if (officecliProbeCache && officecliProbeCache.key === key && now < officecliProbeCache.expiresAt) {
    return officecliProbeCache.result;
  }
  const probe = async () => {
    if (path.isAbsolute(executable) && !fs.existsSync(executable)) {
      return { available: false, path: executable, code: null, message: `Office CLI 文件不存在：${executable}` };
    }
    try {
      let result = await runOfficecli(["--version"], { timeoutMs, executable });
      // 兼容较早版本：如果没有 --version，但 --help 可用，仍应允许只读/编辑链路启动。
      if (result.code !== 0) {
        const fallback = await runOfficecli(["--help"], { timeoutMs, executable });
        if (fallback.code === 0) result = { ...fallback, version: null };
      }
      const version = Object.prototype.hasOwnProperty.call(result, "version")
        ? result.version
        : (result.code === 0 ? (result.stdout || result.text || "").trim().split(/\r?\n/)[0].slice(0, 120) : null);
      return {
        available: result.code === 0,
        path: executable,
        code: result.code,
        version: version || null,
        message: result.code === 0 ? "Office CLI 可用" : (result.stderr || result.text || "Office CLI 返回异常").trim().slice(0, 500),
      };
    } catch (error) {
      return { available: false, path: executable, code: null, message: String(error?.message || error || "Office CLI 不可用").slice(0, 500) };
    }
  };
  const result = await probe();
  const ttl = result.available ? OFFICECLI_PROBE_CACHE_TTL_MS : OFFICECLI_PROBE_FAIL_TTL_MS;
  officecliProbeCache = { key, result, expiresAt: now + ttl };
  return result;
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

/**
 * 只读预览也可能被 OfficeCLI/底层 Office 进程短暂打开并加锁。
 * 预览统一操作临时副本，避免和 Agent 的 set/add/批注写入争用正式文档。
 */
async function withPreviewCopy(file, operation) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "规聚预览-"));
  const previewFile = path.join(dir, path.basename(file));
  try {
    await fs.promises.copyFile(file, previewFile);
    return await operation(previewFile, dir);
  } finally {
    try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch {}
  }
}

/** Render docx/pptx to self-contained HTML (stdout). */
export async function renderHtml(file) {
  return withPreviewCopy(file, async (previewFile, cwd) => {
    const r = await runOfficecli(["view", previewFile, "html"], { cwd });
    return r.stdout;
  });
}

/** Read Office comments without letting the preview process open the source file. */
export async function queryComments(file) {
  return withPreviewCopy(file, async (previewFile, cwd) => {
    return runOfficecli(["query", previewFile, "comment", "--json"], { cwd });
  });
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
  // watch 进程常驻，不能直接持有正式文档；用临时副本承载预览，并把后续
  // 修改同步过去。这样预览关闭/重启不会阻塞 Agent 的 OfficeCLI 写入。
  const previewDir = fs.mkdtempSync(path.join(os.tmpdir(), "规聚预览-"));
  const previewFile = path.join(previewDir, path.basename(file));
  try {
    fs.copyFileSync(file, previewFile);
  } catch (error) {
    try { fs.rmSync(previewDir, { recursive: true, force: true }); } catch {}
    throw error;
  }
  const child = spawn(OFFICECLI, ["watch", previewFile, "--port", String(port)], {
    cwd: previewDir,
    windowsHide: true,
  });
  const entry = { child, port, file, previewFile, previewDir, ready: false };
  watchProcs.set(file, entry);
  child.on("exit", () => {
    fs.unwatchFile(file, entry.syncPreview);
    watchProcs.delete(file);
    setTimeout(() => { try { fs.rmSync(previewDir, { recursive: true, force: true }); } catch {} }, 200);
  });
  entry.syncPreview = () => {
    const next = `${previewFile}.${Date.now()}.tmp`;
    try {
      fs.copyFileSync(file, next);
      fs.renameSync(next, previewFile);
    } catch {
      try { fs.rmSync(next, { force: true }); } catch {}
    }
  };
  fs.watchFile(file, { interval: 800 }, entry.syncPreview);
  // 等待 ready
  return new Promise((resolve) => {
    let out = "";
    child.on("error", (error) => {
      entry.error = error?.message || "OfficeCLI watch 启动失败";
      if (!entry.ready) {
        entry.ready = true;
        resolve(entry);
      }
    });
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
    fs.unwatchFile(file, entry.syncPreview);
    watchProcs.delete(file);
    try { fs.rmSync(entry.previewDir, { recursive: true, force: true }); } catch {}
  }
}

/** 停止所有 watch 进程（服务关闭时调用）。 */
export function stopAllWatches() {
  for (const [file, entry] of watchProcs) {
    try { entry.child.kill(); } catch {}
    fs.unwatchFile(file, entry.syncPreview);
    try { fs.rmSync(entry.previewDir, { recursive: true, force: true }); } catch {}
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
