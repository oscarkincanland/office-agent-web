import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, ensureDirectory, readJsonFile } from "./持久化工具.mjs";
import { redactProxyUrl, resolvePiNetworkSettings } from "./Pi网络代理.mjs";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WINDOWS_APP_DATA = process.platform === "win32"
  ? (process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"))
  : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"));
const EXPLICIT_DATA_DIR = String(process.env.OAW_DATA_DIR || "").trim();
const EXPLICIT_PI_AGENT_DIR = String(process.env.PI_AGENT_DIR || "").trim();
const EXPLICIT_LOCAL_PI_AGENT_DIR = String(process.env.OAW_LOCAL_PI_AGENT_DIR || "").trim();

export const APP_DATA_DIR = path.resolve(EXPLICIT_DATA_DIR || path.join(WINDOWS_APP_DATA, "规聚"));
const PROJECT_FALLBACK_DIR = path.join(PROJECT_DIR, ".oaw", "规聚");

function canWriteDirectory(dir) {
  const target = path.resolve(dir);
  const probe = path.join(target, `.规聚写入-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  let fd;
  try {
    fs.mkdirSync(target, { recursive: true });
    fd = fs.openSync(probe, "wx");
    fs.closeSync(fd);
    fd = undefined;
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    try { if (fd !== undefined) fs.closeSync(fd); } catch {}
    try { fs.rmSync(probe, { force: true }); } catch {}
    return false;
  }
}

function hasFallbackConfig(dir) {
  try {
    return fs.readdirSync(path.resolve(dir)).some((name) => ["模型配置.json", "模型目录缓存.json", "凭据.json", "运行设置.json", "网络代理.json"].includes(name));
  } catch {
    return false;
  }
}

function resolveAgentDirectory() {
  if (EXPLICIT_PI_AGENT_DIR) return path.resolve(EXPLICIT_PI_AGENT_DIR);
  if (EXPLICIT_DATA_DIR) return APP_DATA_DIR;
  // 受控宿主或 Windows 受保护目录可能允许读取 AppData，却禁止创建临时文件。
  // 规聚必须仍能保存导入快照，因此自动切到项目内运行数据目录；普通安装仍优先使用 AppData。
  if (hasFallbackConfig(PROJECT_FALLBACK_DIR)) return PROJECT_FALLBACK_DIR;
  return canWriteDirectory(APP_DATA_DIR) ? APP_DATA_DIR : PROJECT_FALLBACK_DIR;
}

export const AGENT_DIR = resolveAgentDirectory();
export const AGENT_DIR_USES_PROJECT_FALLBACK = !EXPLICIT_DATA_DIR && !EXPLICIT_PI_AGENT_DIR && AGENT_DIR !== APP_DATA_DIR;
export const LOCAL_PI_AGENT_DIR = path.resolve(EXPLICIT_LOCAL_PI_AGENT_DIR || EXPLICIT_PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
export const USING_PI_AGENT_OVERRIDE = Boolean(EXPLICIT_PI_AGENT_DIR);

const APP_FILE_NAMES = Object.freeze({
  models: "模型配置.json",
  modelsStore: "模型目录缓存.json",
  auth: "凭据.json",
  settings: "运行设置.json",
  network: "网络代理.json",
  migration: "会话迁移记录.json",
});

const PI_FILE_NAMES = Object.freeze({
  models: "models.json",
  modelsStore: "models-store.json",
  auth: "auth.json",
  settings: "settings.json",
  network: "network-settings.json",
  migration: "session-migration.json",
});

const NETWORK_KEYS = new Set(["mode", "proxyUrl", "httpProxy", "httpsProxy", "noProxy", "connectTimeoutMs", "timeoutMs", "bodyTimeoutMs"]);
const MAX_SESSION_DEPTH = 4;
const MAX_SESSION_FILES = 200;

function resolvedDirectory(dir = AGENT_DIR) {
  return path.resolve(String(dir || AGENT_DIR));
}

function isDefaultOverrideDirectory(dir) {
  return USING_PI_AGENT_OVERRIDE && resolvedDirectory(dir) === AGENT_DIR;
}

/**
 * 获取 Pi 配置路径。Open Plan 默认使用中文文件名；显式 PI_AGENT_DIR
 * 仅用于兼容旧 Pi 配置和测试覆盖，因此使用 Pi 原生英文文件名。
 */
export function getPiConfigPaths(dir = AGENT_DIR, { standardNames } = {}) {
  const dataDir = resolvedDirectory(dir);
  const names = standardNames === undefined ? isDefaultOverrideDirectory(dataDir) ? PI_FILE_NAMES : APP_FILE_NAMES : standardNames ? PI_FILE_NAMES : APP_FILE_NAMES;
  return {
    dataDir,
    modelsPath: path.join(dataDir, names.models),
    modelsStorePath: path.join(dataDir, names.modelsStore),
    authPath: path.join(dataDir, names.auth),
    settingsPath: path.join(dataDir, names.settings),
    networkPath: path.join(dataDir, names.network),
    migrationPath: path.join(dataDir, names.migration),
  };
}

export const PI_CONFIG_PATHS = Object.freeze(getPiConfigPaths());

export function ensureConfigDirectory(dir = AGENT_DIR) {
  return ensureDirectory(resolvedDirectory(dir));
}

function fileStatus(file) {
  try {
    const stat = fs.statSync(file);
    return { status: stat.isFile() ? "present" : "not_file", exists: true, isFile: stat.isFile() };
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "missing" : "unreadable", exists: false, isFile: false };
  }
}

function directoryStatus(dir) {
  try {
    const stat = fs.statSync(dir);
    return { status: stat.isDirectory() ? "present" : "not_directory", exists: true, isDirectory: stat.isDirectory() };
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "missing" : "unreadable", exists: false, isDirectory: false };
  }
}

function parseObject(file) {
  const state = fileStatus(file);
  if (!state.isFile) return { ...state, value: null };
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "invalid", exists: true, isFile: true, value: null };
    return { status: "present", exists: true, isFile: true, value };
  } catch {
    return { status: "invalid", exists: true, isFile: true, value: null };
  }
}

function configSource(paths = PI_CONFIG_PATHS) {
  const files = [paths.modelsPath, paths.modelsStorePath, paths.authPath, paths.settingsPath].map((file) => fileStatus(file));
  if (USING_PI_AGENT_OVERRIDE) return "environment-override";
  return files.some((item) => item.isFile) ? "open-plan" : "not-configured";
}

function maskSecret(value) {
  const text = String(value ?? "");
  if (!text) return null;
  if (text.length <= 4) return "****";
  return `${text.slice(0, 2)}${"*".repeat(Math.min(12, Math.max(4, text.length - 4)))}${text.slice(-2)}`;
}

function credentialPreview(value) {
  if (!value || typeof value !== "object") return { set: false, type: null, masked: null };
  const masked = value.key || value.access || value.refresh || value.token || value.secret;
  return { set: Boolean(masked), type: value.type || null, masked: maskSecret(masked) };
}

function previewCredentials(authValue) {
  return Object.fromEntries(Object.entries(authValue && typeof authValue === "object" ? authValue : {}).map(([provider, value]) => [provider, credentialPreview(value)]));
}

function publicNetworkSettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  const resolved = resolvePiNetworkSettings(settings || {});
  const savedProxy = String(source.proxyUrl || source.httpsProxy || source.httpProxy || "").trim();
  const activeProxy = resolved.mode === "manual" ? resolved.proxyUrl : resolved.httpsProxy || resolved.httpProxy;
  return {
    mode: resolved.mode,
    proxy: redactProxyUrl(savedProxy || activeProxy),
    hasProxy: Boolean(savedProxy || activeProxy),
    proxyUrl: redactProxyUrl(resolved.proxyUrl),
    httpProxy: redactProxyUrl(resolved.httpProxy),
    httpsProxy: redactProxyUrl(resolved.httpsProxy),
    noProxy: resolved.noProxy,
    connectTimeoutMs: resolved.connectTimeoutMs,
    timeoutMs: resolved.timeoutMs,
    bodyTimeoutMs: resolved.bodyTimeoutMs,
  };
}

function safeNetworkInput(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const next = Object.fromEntries(Object.entries(source).filter(([key]) => NETWORK_KEYS.has(key)));
  if (Array.isArray(next.noProxy)) next.noProxy = next.noProxy.map((item) => String(item || "").trim()).filter(Boolean).join(",");
  return next;
}

/** 返回不含凭据明文的配置状态。 */
export function getConfigStatus({ dir = AGENT_DIR } = {}) {
  const paths = getPiConfigPaths(dir);
  const auth = fileStatus(paths.authPath);
  const models = fileStatus(paths.modelsPath);
  const modelsStore = fileStatus(paths.modelsStorePath);
  const settings = fileStatus(paths.settingsPath);
  const credentials = auth.isFile ? previewCredentials(readJsonFile(paths.authPath, {})) : {};
  const credentialCount = Object.values(credentials).filter((item) => item.set).length;
  const modelsConfigured = models.isFile || modelsStore.isFile;
  return {
    source: configSource(paths),
    dataDir: paths.dataDir,
    storage: {
      fallback: AGENT_DIR_USES_PROJECT_FALLBACK,
      requestedDir: APP_DATA_DIR,
      message: AGENT_DIR_USES_PROJECT_FALLBACK ? "默认 AppData 不可写，已使用项目内运行数据目录" : null,
    },
    configured: modelsConfigured || settings.isFile || credentialCount > 0,
    modelsConfigured,
    credentialCount,
    files: { models, modelsStore, auth, settings, network: fileStatus(paths.networkPath), migration: fileStatus(paths.migrationPath) },
    credentials: { fileExists: auth.isFile, providers: credentials },
    paths: { models: paths.modelsPath, modelsStore: paths.modelsStorePath, auth: paths.authPath, settings: paths.settingsPath, network: paths.networkPath, migration: paths.migrationPath },
  };
}

/** 只检测本地 Pi 目录，不读取或复制凭据明文。 */
export function detectLocalPi({ sourceDir = LOCAL_PI_AGENT_DIR } = {}) {
  const paths = getPiConfigPaths(sourceDir, { standardNames: true });
  const auth = fileStatus(paths.authPath);
  const sessions = directoryStatus(path.join(paths.dataDir, "sessions"));
  const files = {
    models: fileStatus(paths.modelsPath),
    modelsStore: fileStatus(paths.modelsStorePath),
    auth,
    settings: fileStatus(paths.settingsPath),
    network: fileStatus(paths.networkPath),
    sessions,
  };
  return { available: Object.values(files).some((item) => item.isFile || item.isDirectory), sourceDir: paths.dataDir, files };
}

function summarizeModels(modelsValue, storeValue) {
  const providerNames = new Set([
    ...Object.keys(modelsValue?.providers || {}),
    ...Object.keys(storeValue || {}),
  ]);
  let modelCount = 0;
  for (const provider of Object.values(modelsValue?.providers || {})) modelCount += Array.isArray(provider?.models) ? provider.models.length : 0;
  for (const provider of Object.values(storeValue || {})) modelCount += Array.isArray(provider?.models) ? provider.models.length : 0;
  return { providerCount: providerNames.size, modelCount, providers: [...providerNames].sort() };
}

function publicRuntimeSettings(settingsValue) {
  const settings = settingsValue && typeof settingsValue === "object" ? settingsValue : {};
  return {
    defaultProvider: String(settings.defaultProvider || "") || null,
    defaultModel: String(settings.defaultModel || "") || null,
    defaultThinkingLevel: String(settings.defaultThinkingLevel || "") || null,
  };
}

/** 预览旧 Pi 配置，模型数据可查看，凭据只返回供应商、类型和掩码。 */
export function previewLocalPiConfig({ sourceDir = LOCAL_PI_AGENT_DIR } = {}) {
  const paths = getPiConfigPaths(sourceDir, { standardNames: true });
  const models = parseObject(paths.modelsPath);
  const modelsStore = parseObject(paths.modelsStorePath);
  const auth = parseObject(paths.authPath);
  const settings = parseObject(paths.settingsPath);
  const credentialMap = previewCredentials(auth.value);
  const providers = Object.entries(credentialMap).map(([provider, value]) => ({ provider, ...value }));
  const sessionDir = path.join(paths.dataDir, "sessions");
  const sessionState = directoryStatus(sessionDir);
  const sessionCount = sessionState.isDirectory ? sessionFiles(sessionDir, MAX_SESSION_DEPTH, MAX_SESSION_FILES).length : 0;
  const detected = detectLocalPi({ sourceDir });
  return {
    available: detected.available,
    sourceDir: paths.dataDir,
    files: {
      models: { status: models.status },
      modelsStore: { status: modelsStore.status },
      auth: { status: auth.status, providers: credentialMap },
      settings: { status: settings.status },
      sessions: { status: sessionState.status },
    },
    credentials: credentialMap,
    credentialCount: providers.filter((item) => item.set).length,
    providers,
    models: summarizeModels(models.value, modelsStore.value),
    settings: publicRuntimeSettings(settings.value),
    sessions: { status: sessionState.status, count: sessionCount },
    sessionCount,
  };
}

function importSnapshot(sourcePath, targetPath) {
  const parsed = parseObject(sourcePath);
  if (parsed.status !== "present") return { status: parsed.status, copied: false };
  atomicWriteJson(targetPath, parsed.value);
  return { status: "imported", copied: true };
}

/**
 * 显式导入本地 Pi 配置。每份文件先解析，再以原子写入方式复制快照；
 * 不建立软链接，也不监听源目录。只有本函数被调用时才会复制凭据。
 */
export function importLocalPiConfig({ sourceDir = LOCAL_PI_AGENT_DIR, targetDir = AGENT_DIR, includeModels = true, includeSettings = true, includeCredentials = true } = {}) {
  const source = getPiConfigPaths(sourceDir, { standardNames: true });
  const target = getPiConfigPaths(targetDir);
  if (source.dataDir === target.dataDir) return { ok: false, error: "源目录和目标目录不能相同" };
  ensureConfigDirectory(target.dataDir);
  const files = {
    models: includeModels ? importSnapshot(source.modelsPath, target.modelsPath) : { status: "skipped", copied: false },
    modelsStore: includeModels ? importSnapshot(source.modelsStorePath, target.modelsStorePath) : { status: "skipped", copied: false },
    settings: includeSettings ? importSnapshot(source.settingsPath, target.settingsPath) : { status: "skipped", copied: false },
  };
  const authSource = parseObject(source.authPath);
  const authProviders = includeCredentials && authSource.status === "present" ? previewCredentials(authSource.value) : {};
  files.auth = !includeCredentials
    ? { status: "skipped", copied: false }
    : authSource.status !== "present"
      ? { status: authSource.status, copied: false }
      : (atomicWriteJson(target.authPath, authSource.value), { status: "imported", copied: true });
  const migration = {
    version: 1,
    at: new Date().toISOString(),
    files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, { status: value.status, copied: value.copied }])),
    providers: Object.entries(authProviders).map(([provider, value]) => ({ provider, type: value.type, masked: value.masked, set: value.set })),
  };
  atomicWriteJson(target.migrationPath, migration);
  return {
    ok: true,
    files: migration.files,
    imported: Object.entries(migration.files).filter(([, value]) => value.copied).map(([name]) => name),
    providers: migration.providers,
    migration: { status: "recorded", at: migration.at },
  };
}

export function readCredentials({ dir = AGENT_DIR } = {}) {
  return readJsonFile(getPiConfigPaths(dir).authPath, {});
}

export function writeCredentials(value, { dir = AGENT_DIR } = {}) {
  ensureConfigDirectory(dir);
  const auth = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return atomicWriteJson(getPiConfigPaths(dir).authPath, auth);
}

export function readModelsConfig({ dir = AGENT_DIR } = {}) {
  return readJsonFile(getPiConfigPaths(dir).modelsPath, {});
}

export function writeModelsConfig(value, { dir = AGENT_DIR } = {}) {
  const config = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  ensureConfigDirectory(dir);
  return atomicWriteJson(getPiConfigPaths(dir).modelsPath, config);
}

export function readModelsStore({ dir = AGENT_DIR } = {}) {
  return readJsonFile(getPiConfigPaths(dir).modelsStorePath, {});
}

export function readRuntimeSettings({ dir = AGENT_DIR } = {}) {
  return readJsonFile(getPiConfigPaths(dir).settingsPath, {});
}

/** 返回脱敏网络设置；运行时内部使用 loadNetworkSettings 取得真实代理地址。 */
export function readNetworkSettings({ dir = AGENT_DIR } = {}) {
  return publicNetworkSettings(readJsonFile(getPiConfigPaths(dir).networkPath, {}));
}

export function loadNetworkSettings({ dir = AGENT_DIR } = {}) {
  return resolvePiNetworkSettings(readJsonFile(getPiConfigPaths(dir).networkPath, {}));
}

export function saveNetworkSettings(value, { dir = AGENT_DIR, preserveProxy = false } = {}) {
  const paths = getPiConfigPaths(dir);
  const existing = readJsonFile(paths.networkPath, {});
  const next = safeNetworkInput(value);
  if (preserveProxy && !next.proxyUrl && !next.httpProxy && !next.httpsProxy) {
    if (existing.proxyUrl) next.proxyUrl = existing.proxyUrl;
    if (existing.httpProxy) next.httpProxy = existing.httpProxy;
    if (existing.httpsProxy) next.httpsProxy = existing.httpsProxy;
  }
  ensureConfigDirectory(dir);
  atomicWriteJson(paths.networkPath, next);
  return publicNetworkSettings(next);
}

function isValidJsonl(file) {
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.trim());
    return lines.length > 0 && lines.every((line) => {
      try { JSON.parse(line); return true; } catch { return false; }
    });
  } catch {
    return false;
  }
}

function sessionFiles(sourceDir, maxDepth, maxFiles) {
  const output = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || output.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (output.length >= maxFiles) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) output.push(fullPath);
    }
  };
  walk(sourceDir, 0);
  return output;
}

/** 将旧 Pi 会话显式导入调用方提供的项目 .规聚会话目录。 */
export function importLocalPiSessions({ sourceDir = path.join(LOCAL_PI_AGENT_DIR, "sessions"), targetDir, maxDepth = MAX_SESSION_DEPTH, maxFiles = MAX_SESSION_FILES } = {}) {
  if (!targetDir) return { ok: false, error: "targetDir required", files: [] };
  const source = path.resolve(String(sourceDir));
  const target = path.resolve(String(targetDir));
  ensureDirectory(target);
  const files = [];
  const depthLimit = Math.min(MAX_SESSION_DEPTH, Math.max(0, Number(maxDepth) || MAX_SESSION_DEPTH));
  const fileLimit = Math.min(MAX_SESSION_FILES, Math.max(1, Number(maxFiles) || MAX_SESSION_FILES));
  for (const sourcePath of sessionFiles(source, depthLimit, fileLimit)) {
    const name = path.basename(sourcePath);
    const targetPath = path.join(target, name);
    if (!isValidJsonl(sourcePath)) {
      files.push({ name, status: "invalid" });
      continue;
    }
    if (fs.existsSync(targetPath)) {
      files.push({ name, status: "exists_skipped" });
      continue;
    }
    try {
      fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
      files.push({ name, status: "imported" });
    } catch (error) {
      files.push({ name, status: error?.code === "EEXIST" ? "exists_skipped" : "skipped" });
    }
  }
  return { ok: true, sourceDir: source, targetDir: target, files, imported: files.filter((item) => item.status === "imported").length };
}

export function importLocalPiSessionFile(sourcePath, targetDir) {
  const source = path.resolve(String(sourcePath || ""));
  const target = path.resolve(String(targetDir || ""));
  if (!source || !target || !source.toLowerCase().endsWith(".jsonl")) throw new Error("会话文件必须是 JSONL 文件");
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error("会话文件不存在或不是文件");
  if (!isValidJsonl(source)) throw new Error("会话文件不是有效 JSONL");
  ensureDirectory(target);
  const targetPath = path.join(target, path.basename(source));
  if (fs.existsSync(targetPath)) {
    if (fs.statSync(targetPath).isFile()) return targetPath;
    throw new Error("目标会话路径已存在但不是文件");
  }
  fs.copyFileSync(source, targetPath, fs.constants.COPYFILE_EXCL);
  return targetPath;
}

export function maskCredential(value) {
  return maskSecret(value);
}
