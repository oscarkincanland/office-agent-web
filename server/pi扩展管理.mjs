import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { APP_DATA_DIR } from "./Pi配置管理.mjs";
import { atomicWriteJson, ensureDirectory, readJsonFile } from "./持久化工具.mjs";

const CONFIG_FILE = path.join(APP_DATA_DIR, "集成", "pi-extensions.json");

function readConfig() {
  const value = readJsonFile(CONFIG_FILE, { version: 1, extensions: [] });
  return { version: 1, extensions: Array.isArray(value?.extensions) ? value.extensions : [] };
}

function saveConfig(config) {
  ensureDirectory(path.dirname(CONFIG_FILE));
  atomicWriteJson(CONFIG_FILE, { ...config, updatedAt: new Date().toISOString() });
}

function inspectPath(target) {
  try {
    const realPath = fs.realpathSync(path.resolve(target));
    const stat = fs.statSync(realPath);
    if (!stat.isDirectory() && !stat.isFile()) return { exists: false, realPath: null, files: [] };
    const files = [];
    const walk = (dir, depth = 0) => {
      if (depth > 3 || files.length >= 100) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file, depth + 1);
        else if (/\.(?:[cm]?[jt]s|tsx?)$/i.test(entry.name)) files.push(path.relative(realPath, file).replace(/\\/g, "/"));
      }
    };
    if (stat.isDirectory()) walk(realPath);
    else files.push(path.basename(realPath));
    return { exists: true, realPath, files };
  } catch {
    return { exists: false, realPath: null, files: [] };
  }
}

function publicExtension(extension) {
  const inspected = inspectPath(extension.path);
  return {
    id: extension.id,
    name: extension.name,
    path: extension.path,
    enabled: Boolean(extension.enabled),
    exists: inspected.exists,
    files: inspected.files,
    lastCheck: extension.lastCheck || null,
    requiresNewSession: true,
  };
}

function makeId(name) {
  const slug = String(name || "pi-extension").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "pi-extension";
  return `${slug}-${crypto.randomBytes(3).toString("hex")}`;
}

export function listPiExtensions() {
  return readConfig().extensions.map(publicExtension);
}

export function addPiExtension(input = {}) {
  const name = String(input.name || "").trim().slice(0, 80);
  const target = String(input.path || "").trim();
  if (!target) throw new Error("请填写 Pi 扩展文件或目录路径");
  if (target.length > 4000) throw new Error("Pi 扩展路径过长");
  const inspected = inspectPath(target);
  if (!inspected.exists) throw new Error("找不到该文件或目录，请检查路径");
  const config = readConfig();
  if (config.extensions.some((item) => path.resolve(item.path) === inspected.realPath)) throw new Error("这个 Pi 扩展路径已经登记");
  const extension = {
    id: makeId(name || path.basename(inspected.realPath)),
    name: name || path.basename(inspected.realPath),
    path: inspected.realPath,
    enabled: false,
    lastCheck: { ok: true, at: new Date().toISOString(), files: inspected.files.length },
  };
  config.extensions.push(extension);
  saveConfig(config);
  return publicExtension(extension);
}

export function updatePiExtension(id, patch = {}) {
  const config = readConfig();
  const extension = config.extensions.find((item) => item.id === id);
  if (!extension) return null;
  if (patch.name !== undefined) extension.name = String(patch.name || "").trim().slice(0, 80) || extension.name;
  if (patch.enabled !== undefined) {
    const inspected = inspectPath(extension.path);
    if (patch.enabled && !inspected.exists) throw new Error("扩展路径当前不可用，修正路径后再启用");
    extension.enabled = Boolean(patch.enabled);
  }
  extension.lastCheck = { ok: inspectPath(extension.path).exists, at: new Date().toISOString() };
  saveConfig(config);
  return publicExtension(extension);
}

export function checkPiExtension(id) {
  const config = readConfig();
  const extension = config.extensions.find((item) => item.id === id);
  if (!extension) return null;
  const inspected = inspectPath(extension.path);
  extension.lastCheck = {
    ok: inspected.exists,
    at: new Date().toISOString(),
    files: inspected.files.length,
    message: inspected.exists
      ? (inspected.files.length ? `路径有效，发现 ${inspected.files.length} 个 JS/TS 文件；本检查未执行扩展代码。` : "路径有效，但未发现 JS/TS 文件。")
      : "路径不存在或不可读取。",
  };
  saveConfig(config);
  return publicExtension(extension);
}

export function deletePiExtension(id) {
  const config = readConfig();
  const next = config.extensions.filter((item) => item.id !== id);
  if (next.length === config.extensions.length) return false;
  config.extensions = next;
  saveConfig(config);
  return true;
}

export function enabledPiExtensionPaths() {
  return readConfig().extensions
    .filter((item) => item.enabled && inspectPath(item.path).exists)
    .map((item) => inspectPath(item.path).realPath);
}

export function enabledPiExtensionEntries() {
  return readConfig().extensions.filter((item) => item.enabled && inspectPath(item.path).exists).map(publicExtension);
}
