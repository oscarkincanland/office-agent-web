import { execFile } from "node:child_process";
import path from "node:path";

/**
 * 本机原生能力（macOS / Windows / Linux）：
 *   - 文件 / 文件夹选择器（macOS 用 osascript 的 choose file / choose folder；Windows 用 PowerShell 对话框；Linux 尝试 zenity）
 *   - 用默认应用打开文件
 *   - 在文件管理器中显示（macOS Finder / Windows 资源管理器 / Linux 文件管理器）
 *
 * 安全约定：
 *   1. 全程使用 execFile + 参数数组，**不经过 shell**，文件名里的引号/分号/空格都不会被解释；
 *   2. 只接受绝对路径（绝对路径不可能被当成命令行选项）；
 *   3. 调用方（server/index.mjs）在执行前用工作区白名单校验路径。
 */

const PICKER_TIMEOUT_MS = Number(process.env.OAW_NATIVE_PICKER_TIMEOUT_MS) || 10 * 60 * 1000;
const ACTION_TIMEOUT_MS = 15 * 1000;

export function nativePlatform() {
  return process.platform;
}

/** 本机能力与界面用词（前端据此显示“Finder / 资源管理器”等平台化措辞）。 */
export function nativeCapabilities() {
  const platform = process.platform;
  if (platform === "darwin") {
    return { platform, picker: true, pickerKind: "osascript", open: true, reveal: true, fileManagerName: "Finder", pickVerb: "从 Finder 选择文件" };
  }
  if (platform === "win32") {
    return { platform, picker: true, pickerKind: "powershell", open: true, reveal: true, fileManagerName: "资源管理器", pickVerb: "从资源管理器选择文件" };
  }
  return { platform, picker: platform === "linux", pickerKind: platform === "linux" ? "zenity" : "none", open: platform === "linux", reveal: platform === "linux", fileManagerName: "文件管理器", pickVerb: "从文件管理器选择文件" };
}

/* ------------------------------ 纯函数（可单测） ------------------------------ */

/** AppleScript 字符串字面量转义。 */
export function appleScriptString(value) {
  return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 扩展名归一化：接受 "docx" / ".docx" / "*.docx"，去重并保留顺序。 */
export function normalizeExtensions(extensions) {
  const list = Array.isArray(extensions) ? extensions : [];
  const out = [];
  for (const item of list) {
    const ext = String(item || "").trim().replace(/^\*?\.?/, "").toLowerCase();
    if (!ext || !/^[a-z0-9]+$/.test(ext)) continue;
    if (!out.includes(ext)) out.push(ext);
  }
  return out;
}

/** 生成 `choose file` 的 -e 参数（不含 osascript 本体）。 */
export function buildPickFilesScript({ prompt = "选择要打开的文件", multiple = false, extensions = [] } = {}) {
  const exts = normalizeExtensions(extensions);
  const typeClause = exts.length ? ` of type {${exts.map((ext) => appleScriptString(ext)).join(", ")}}` : "";
  const promptPart = ` with prompt ${appleScriptString(prompt)}`;
  if (!multiple) {
    return ["-e", `set theChoice to choose file${promptPart}${typeClause}`, "-e", "return POSIX path of theChoice"];
  }
  return [
    "-e", `set theChoices to choose file${promptPart}${typeClause} with multiple selections allowed`,
    "-e", "set theOutput to \"\"",
    "-e", "repeat with theFile in theChoices",
    "-e", "set theOutput to theOutput & (POSIX path of theFile) & linefeed",
    "-e", "end repeat",
    "-e", "return theOutput",
  ];
}

/** 生成 `choose folder` 的 -e 参数。 */
export function buildPickFolderScript({ prompt = "选择文件夹" } = {}) {
  return ["-e", `return POSIX path of (choose folder with prompt ${appleScriptString(prompt)})`];
}

/** 解析 osascript 输出：逐行 POSIX 路径（自动跳过空行）。 */
export function parseAppleScriptOutput(stdout) {
  return String(stdout || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** 用户点了取消（AppleScript 错误码 -128 / User canceled）。 */
export function isAppleScriptCancel(error) {
  const text = `${error?.stderr || ""} ${error?.message || ""}`;
  return /-128\b|User canceled|用户已取消|\/-1743\b/.test(text);
}

/** 生成 Windows OpenFileDialog 的 PowerShell 脚本（同样用 TopMost owner 保证窗口在前台）。 */
export function buildWindowsPickFilesScript({ prompt = "选择要打开的文件", multiple = false, extensions = [] } = {}) {
  const exts = normalizeExtensions(extensions);
  const filter = exts.length
    ? `${exts.join("/")} (${exts.map((ext) => `*.${ext}`).join(";")})|${exts.map((ext) => `*.${ext}`).join(";")}|所有文件 (*.*)|*.*`
    : "所有文件 (*.*)|*.*";
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "$owner.ShowInTaskbar = $false",
    "$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized",
    "$owner.Show()",
    "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
    `$dialog.Title = ${JSON.stringify(prompt)}`,
    `$dialog.Filter = ${JSON.stringify(filter)}`,
    `$dialog.Multiselect = $(${multiple ? "true" : "false"})`,
    "$result = $dialog.ShowDialog($owner)",
    "$owner.Close()",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $dialog.FileNames | ForEach-Object { Write-Output $_ } }",
  ].join("; ");
}

/**
 * 生成 Windows 文件夹选择器的 PowerShell 脚本。
 *
 * FolderBrowserDialog 没有 owner 时常常出现在浏览器窗口**后面**，用户看不到就以为
 * "选择文件夹失效了"。这里用一个 TopMost 的隐藏窗体当 owner，把对话框强制带到前台。
 */
export function buildWindowsPickFolderScript({ prompt = "选择文件夹" } = {}) {
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "$owner.ShowInTaskbar = $false",
    "$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized",
    "$owner.Show()",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    `$dialog.Description = ${JSON.stringify(prompt)}`,
    "$dialog.ShowNewFolderButton = $true",
    "$result = $dialog.ShowDialog($owner)",
    "$owner.Close()",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $dialog.SelectedPath }",
  ].join("; ");
}

function nativeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/* ------------------------------ 命令执行 ------------------------------ */

/**
 * 正在等待用户操作的选择器进程。系统对话框是独立进程，用户点「取消等待」或再点一次
 * 「选择文件夹」时必须能把它收掉——否则桌面上会留下没人管的弹窗，用户以为界面卡死。
 */
let activePicker = null;

/** 收掉正在等待的选择器进程；返回是否真的收掉了。 */
export function cancelActivePicker() {
  const current = activePicker;
  activePicker = null;
  if (!current) return false;
  current.cancelled = true;
  try { current.child.kill(); } catch {}
  return true;
}

export function activePickerInfo() {
  if (!activePicker) return null;
  return { kind: activePicker.kind, startedAt: activePicker.startedAt, pid: activePicker.child?.pid || null };
}

/**
 * 运行一个"等待用户操作"的选择器进程（仍走 execFile + 参数数组，不经 shell）。
 * execFile 返回的子进程句柄让我们可以主动收掉对话框：用户点「取消等待」或再点一次
 * 「选择文件夹」时，桌面上不该留下没人管的弹窗。
 */
function runPicker(file, args, { timeout = PICKER_TIMEOUT_MS, kind = "" } = {}) {
  // 新的选择请求先收掉上一个：重复点击不应该在桌面上堆出多个对话框。
  cancelActivePicker();
  return new Promise((resolve, reject) => {
    let entry = null;
    const child = execFile(file, args, { timeout: Math.max(5000, timeout), maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: false }, (error, stdout, stderr) => {
      if (activePicker === entry) activePicker = null;
      if (entry?.cancelled) return reject(nativeError("已取消等待系统选择器", "PICKER_CANCELLED"));
      if (error?.killed) return reject(nativeError("选择器等待超时", "PICKER_TIMEOUT"));
      if (error) {
        error.stderr = stderr;
        return reject(error);
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
    entry = { child, kind, startedAt: Date.now(), cancelled: false };
    activePicker = entry;
  });
}

function run(file, args, { timeout = ACTION_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

/** 原生文件选择器；返回绝对路径数组。用户取消时 canceled=true。 */
export async function pickFiles({ prompt = "选择要打开的文件", multiple = false, extensions = [] } = {}) {
  const capability = nativeCapabilities();
  if (!capability.picker) throw nativeError("当前平台没有可用的原生文件选择器", "PICKER_UNSUPPORTED");
  try {
    if (capability.pickerKind === "osascript") {
      const { stdout } = await runPicker("osascript", buildPickFilesScript({ prompt, multiple, extensions }), { kind: "files" });
      const paths = parseAppleScriptOutput(stdout);
      return paths.length ? { canceled: false, paths } : { canceled: true, paths: [] };
    }
    if (capability.pickerKind === "powershell") {
      const { stdout } = await runPicker("powershell.exe", ["-NoProfile", "-STA", "-Command", buildWindowsPickFilesScript({ prompt, multiple, extensions })], { kind: "files" });
      const paths = parseAppleScriptOutput(stdout);
      return paths.length ? { canceled: false, paths } : { canceled: true, paths: [] };
    }
    // Linux：zenity（未安装则明确报错，不静默失败）
    const args = ["--file-selection", "--separator", "\n", `--title=${prompt}`];
    if (multiple) args.push("--multiple");
    for (const ext of normalizeExtensions(extensions)) args.push(`--file-filter=${ext} | *.${ext}`);
    const { stdout } = await runPicker("zenity", args, { kind: "files" });
    const paths = parseAppleScriptOutput(stdout);
    return paths.length ? { canceled: false, paths } : { canceled: true, paths: [] };
  } catch (error) {
    if (error?.code === "PICKER_CANCELLED" || isAppleScriptCancel(error)) return { canceled: true, paths: [] };
    if (error?.code === "ENOENT") throw nativeError(`未找到系统选择器（${capability.pickerKind}）`, "PICKER_UNAVAILABLE");
    if (error?.killed) throw nativeError("选择器等待超时", "PICKER_TIMEOUT");
    throw nativeError(`选择器执行失败：${error?.message || error}`, "PICKER_FAILED");
  }
}

/** 原生文件夹选择器；返回单个绝对路径。 */
export async function pickFolder({ prompt = "选择文件夹" } = {}) {
  const capability = nativeCapabilities();
  if (!capability.picker) throw nativeError("当前平台没有可用的原生文件夹选择器", "PICKER_UNSUPPORTED");
  try {
    if (capability.pickerKind === "osascript") {
      const { stdout } = await runPicker("osascript", buildPickFolderScript({ prompt }), { kind: "folder" });
      const paths = parseAppleScriptOutput(stdout);
      return paths.length ? { canceled: false, path: paths[0] } : { canceled: true, path: "" };
    }
    if (capability.pickerKind === "powershell") {
      const { stdout } = await runPicker("powershell.exe", ["-NoProfile", "-STA", "-Command", buildWindowsPickFolderScript({ prompt })], { kind: "folder" });
      const paths = parseAppleScriptOutput(stdout);
      return paths.length ? { canceled: false, path: paths[0] } : { canceled: true, path: "" };
    }
    const { stdout } = await runPicker("zenity", ["--file-selection", "--directory", `--title=${prompt}`], { kind: "folder" });
    const paths = parseAppleScriptOutput(stdout);
    return paths.length ? { canceled: false, path: paths[0] } : { canceled: true, path: "" };
  } catch (error) {
    if (error?.code === "PICKER_CANCELLED" || isAppleScriptCancel(error)) return { canceled: true, path: "" };
    if (error?.code === "ENOENT") throw nativeError(`未找到系统选择器（${capability.pickerKind}）`, "PICKER_UNAVAILABLE");
    if (error?.killed) throw nativeError("选择器等待超时", "PICKER_TIMEOUT");
    throw nativeError(`选择器执行失败：${error?.message || error}`, "PICKER_FAILED");
  }
}

/** 用系统默认应用打开文件（只接受绝对路径）。 */
export async function openWithDefaultApp(absPath) {
  const target = String(absPath || "");
  if (!path.isAbsolute(target)) throw nativeError("需要绝对路径", "PATH_NOT_ABSOLUTE");
  try {
    if (process.platform === "darwin") await run("open", [target]);
    else if (process.platform === "win32") await run("cmd", ["/c", "start", "", target]);
    else await run("xdg-open", [target]);
    return { ok: true, path: target };
  } catch (error) {
    throw nativeError(`打开失败：${error?.message || error}`, "OPEN_FAILED");
  }
}

/** 在文件管理器中显示（macOS 选中该文件）。 */
export async function revealInFileManager(absPath) {
  const target = String(absPath || "");
  if (!path.isAbsolute(target)) throw nativeError("需要绝对路径", "PATH_NOT_ABSOLUTE");
  try {
    if (process.platform === "darwin") await run("open", ["-R", target]);
    else if (process.platform === "win32") await run("explorer", [`/select,${target}`]);
    else await run("xdg-open", [path.dirname(target)]);
    return { ok: true, path: target };
  } catch (error) {
    throw nativeError(`在文件管理器中显示失败：${error?.message || error}`, "REVEAL_FAILED");
  }
}
