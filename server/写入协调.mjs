import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { normalizeWorkspace, isInside } from "./workspace.mjs";
import { atomicWriteFile, atomicWriteJson, ensureDirectory, readJsonFile } from "./持久化工具.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const RUNS_DIR = process.env.OAW_RUNS_DIR || path.join(ROOT, ".oaw", "runs");
const LOCK_DIR = process.env.OAW_WRITE_LOCK_DIR || path.join(ROOT, ".oaw", "locks");
const locks = new Map();

export class WriteConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "WriteConflictError";
    this.code = "WRITE_CONFLICT";
    this.details = details;
  }
}

function safeRunId(runId) {
  const value = String(runId || "").trim();
  if (!value || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("活动 Run 标识无效");
  return value;
}

function now() { return new Date().toISOString(); }

function lockKey(target) {
  const resolved = path.resolve(target);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function lockFileFor(key) {
  return path.join(LOCK_DIR, `${crypto.createHash("sha1").update(key).digest("hex")}.lock`);
}

function processAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  if (Number(pid) === process.pid) return true;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function readLockFile(file) {
  return readJsonFile(file, null);
}

function overlapping(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return left === right || isInside(left, right) || isInside(right, left);
}

function findExternalOverlap(target) {
  for (const record of locks.values()) {
    if (overlapping(record.target, target)) return record;
  }
  ensureDirectory(LOCK_DIR);
  for (const name of fs.readdirSync(LOCK_DIR).filter((item) => item.endsWith(".lock"))) {
    const file = path.join(LOCK_DIR, name);
    const record = readLockFile(file);
    if (!record || !overlapping(record.target, target)) continue;
    if (removeStaleLock(file, record)) continue;
    return { ...record, lockFile: file };
  }
  return null;
}

function removeStaleLock(file, record) {
  if (record && processAlive(Number(record.pid))) return false;
  try { fs.rmSync(file, { force: true }); return true; } catch { return false; }
}

export function reclaimStaleWriteLocks() {
  ensureDirectory(LOCK_DIR);
  let reclaimed = 0;
  for (const name of fs.readdirSync(LOCK_DIR).filter((item) => item.endsWith(".lock"))) {
    const file = path.join(LOCK_DIR, name);
    const record = readLockFile(file);
    if (removeStaleLock(file, record)) reclaimed += 1;
  }
  return reclaimed;
}

function nearestExistingPath(target) {
  let cursor = target;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return cursor;
    cursor = parent;
  }
  return cursor;
}

function validateTarget(workspace, targetPath, { allowWorkspaceRoot = true } = {}) {
  const root = normalizeWorkspace(workspace);
  if (!root) {
    const error = new Error("工作区不存在或不是文件夹");
    error.code = "WORKSPACE_INVALID";
    throw error;
  }
  const target = path.resolve(String(targetPath || ""));
  if (!isInside(root, target) || (!allowWorkspaceRoot && target === root)) {
    const error = new Error(`写入路径必须位于当前工作区内：${target}`);
    error.code = "WRITE_SCOPE_ERROR";
    throw error;
  }
  const probe = nearestExistingPath(target);
  let realProbe;
  try { realProbe = fs.realpathSync(probe); } catch { realProbe = probe; }
  if (!isInside(root, realProbe)) {
    const error = new Error(`写入路径解析后超出当前工作区：${target}`);
    error.code = "WRITE_SCOPE_ERROR";
    throw error;
  }
  return { root, target, relative: path.relative(root, target).replace(/\\/g, "/") };
}

export function isProtectedMemoryTarget(workspace, targetPath) {
  try {
    const { relative } = validateTarget(workspace, targetPath, { allowWorkspaceRoot: true });
    const normalized = relative.toLowerCase();
    return normalized === "agents.md" || normalized === "memory" || normalized.startsWith("memory/");
  } catch {
    return false;
  }
}

function stageInfo(runId) {
  const id = safeRunId(runId);
  const runDir = ensureDirectory(path.join(RUNS_DIR, id));
  return {
    id,
    runDir,
    stagingDir: ensureDirectory(path.join(runDir, "staging")),
    manifestFile: path.join(runDir, "写入清单.json"),
  };
}

function loadManifest(runId) {
  const info = stageInfo(runId);
  const value = readJsonFile(info.manifestFile, { version: 1, runId: info.id, files: [] });
  return { info, manifest: value && Array.isArray(value.files) ? value : { version: 1, runId: info.id, files: [] } };
}

function saveManifest(info, manifest) {
  atomicWriteJson(info.manifestFile, manifest);
}

export function ensureRunStaging(runId, workspace) {
  const info = stageInfo(runId);
  const root = normalizeWorkspace(workspace);
  return { runId: info.id, workspace: root, directory: info.stagingDir, manifest: info.manifestFile };
}

export function acquireWriteLock({ workspace, targetPath, runId, threadId = null, kind = "file" } = {}) {
  const target = validateTarget(workspace, targetPath).target;
  const key = lockKey(target);
  const owner = String(runId || "").trim();
  if (!owner) {
    const error = new Error("写入操作必须绑定活动 Run");
    error.code = "RUN_REQUIRED";
    throw error;
  }
  const current = locks.get(key);
  if (current) {
    if (current.runId === owner) {
      current.references += 1;
      return { key, runId: owner, reentrant: true };
    }
    throw new WriteConflictError(`文件正在被其他任务修改：${path.relative(current.workspace, target).replace(/\\/g, "/") || "."}`, {
      target,
      workspace: current.workspace,
      ownerRunId: current.runId,
      ownerThreadId: current.threadId,
      ownerKind: current.kind,
      lockedAt: current.lockedAt,
    });
  }

  const overlap = findExternalOverlap(target);
  if (overlap && overlap.runId !== owner) {
    throw new WriteConflictError(`写入范围与其他任务冲突：${overlap.target}`, {
      target,
      workspace: overlap.workspace,
      ownerRunId: overlap.runId,
      ownerThreadId: overlap.threadId,
      ownerKind: overlap.kind,
      lockedAt: overlap.lockedAt,
    });
  }

  ensureDirectory(LOCK_DIR);
  const file = lockFileFor(key);
  const existing = readLockFile(file);
  if (existing) {
    if (removeStaleLock(file, existing)) {
      // 继续尝试创建新的锁文件。
    } else {
      throw new WriteConflictError(`文件正在被其他进程修改：${target}`, {
        target,
        workspace: existing.workspace,
        ownerRunId: existing.runId,
        ownerThreadId: existing.threadId,
        ownerKind: existing.kind,
        lockedAt: existing.lockedAt,
      });
    }
  }

  const record = {
    target,
    workspace: path.resolve(workspace),
    runId: owner,
    threadId: threadId || null,
    kind,
    pid: process.pid,
    lockedAt: now(),
    references: 1,
  };
  let fd;
  try {
    fd = fs.openSync(file, "wx");
    fs.writeFileSync(fd, JSON.stringify(record) + "\n", "utf8");
    try { fs.fsyncSync(fd); } catch {}
    locks.set(key, { ...record, lockFile: file });
    return { key, runId: owner, reentrant: false };
  } catch (error) {
    if (error?.code === "EEXIST") {
      const latest = readLockFile(file);
      throw new WriteConflictError(`文件正在被其他进程修改：${target}`, { target, ...latest });
    }
    throw error;
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); } catch {}
  }
}

export function releaseWriteLock(token) {
  if (!token?.key) return false;
  const record = locks.get(token.key);
  if (!record || record.runId !== token.runId) return false;
  record.references = Math.max(0, Number(record.references || 1) - 1);
  if (record.references > 0) return true;
  locks.delete(token.key);
  try { fs.rmSync(record.lockFile, { force: true }); } catch {}
  return true;
}

export function releaseRunLocks(runId) {
  const owner = String(runId || "");
  if (!owner) return 0;
  let released = 0;
  for (const [key, record] of locks) {
    if (record.runId !== owner) continue;
    locks.delete(key);
    try { fs.rmSync(record.lockFile, { force: true }); } catch {}
    released += 1;
  }
  return released;
}

export function holdWorkspaceWriteLock({ workspace, runId, threadId = null, kind = "workspace" } = {}) {
  const root = normalizeWorkspace(workspace);
  return acquireWriteLock({ workspace: root, targetPath: root, runId, threadId, kind });
}

export function withWriteLock(options, callback) {
  const token = acquireWriteLock(options);
  try {
    return callback();
  } finally {
    releaseWriteLock(token);
  }
}

function emitWriteEvent(onEvent, type, data) {
  try { onEvent?.(type, data); } catch {}
}

function eventData({ runId, workspace, target, relative, kind, threadId }) {
  return { runId, workspace, path: relative, target, kind, threadId: threadId || null };
}

export function stageWrite({ runId, workspace, targetPath, content, threadId = null, kind = "agent", onEvent } = {}) {
  const { root, target, relative } = validateTarget(workspace, targetPath, { allowWorkspaceRoot: false });
  if (!relative) throw new Error("不能把工作区根目录作为文件写入目标");
  if (isProtectedMemoryTarget(root, target) && !["attachment", "memory_approval"].includes(kind)) {
    const error = new Error("长期记忆必须通过 memory_update 建议并经用户审核，不能使用普通文件写入工具");
    error.code = "MEMORY_WRITE_REQUIRES_PROPOSAL";
    throw error;
  }
  const info = stageInfo(runId);
  const data = eventData({ runId: safeRunId(runId), workspace: root, target, relative, kind, threadId });
  let token;
  try {
    token = acquireWriteLock({ workspace: root, targetPath: target, runId, threadId, kind });
    emitWriteEvent(onEvent, "write_started", data);
    emitWriteEvent(onEvent, "write_locked", data);
    const stagedPath = path.resolve(info.stagingDir, relative);
    if (!isInside(info.stagingDir, stagedPath)) throw new Error("临时产物路径非法");
    atomicWriteFile(stagedPath, content, "utf8");
    const { manifest } = loadManifest(runId);
    const previous = manifest.files.find((item) => item.path === relative);
    const entry = {
      path: relative,
      stagedPath: path.relative(info.runDir, stagedPath).replace(/\\/g, "/"),
      status: fs.existsSync(target) ? "modified" : "added",
      kind,
      runId: safeRunId(runId),
      threadId: threadId || null,
      stagedAt: now(),
      writes: Number(previous?.writes || 0) + 1,
      size: Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content), "utf8"),
    };
    manifest.files = [...manifest.files.filter((item) => item.path !== relative), entry];
    manifest.updatedAt = now();
    saveManifest(info, manifest);
    emitWriteEvent(onEvent, "artifact_staged", { ...data, stagedPath: entry.stagedPath, status: entry.status, size: entry.size });
    return { ok: true, ...entry, target };
  } catch (error) {
    emitWriteEvent(onEvent, "write_rejected", { ...data, code: error?.code || "WRITE_FAILED", message: String(error?.message || error) });
    throw error;
  } finally {
    // Run 结束前故意不释放锁，避免同一 Run 的临时产物和其他 Run 交错发布。
    void token;
  }
}

function stagedPathFor(runId, workspace, targetPath) {
  const { root, target, relative } = validateTarget(workspace, targetPath, { allowWorkspaceRoot: false });
  const { info, manifest } = loadManifest(runId);
  const entry = manifest.files.find((item) => item.path === relative);
  const stagedPath = entry ? path.resolve(info.runDir, entry.stagedPath) : null;
  if (stagedPath && isInside(info.stagingDir, stagedPath) && fs.existsSync(stagedPath)) return { root, target, relative, stagedPath, entry };
  return { root, target, relative, stagedPath: null, entry: null };
}

export function resolveReadablePath({ runId, workspace, targetPath } = {}) {
  const raw = path.resolve(String(targetPath || ""));
  try {
    const result = stagedPathFor(runId, workspace, raw);
    return result.stagedPath || result.target;
  } catch {
    // Pi 的 read 允许读取工作区上级的 AGENTS.md；这类只读路径不纳入 staging。
    return raw;
  }
}

export function stagedAccess({ runId, workspace, targetPath } = {}) {
  const readable = resolveReadablePath({ runId, workspace, targetPath });
  fs.accessSync(readable, fs.constants.R_OK);
  return readable;
}

export function ensureStagedDirectory({ runId, workspace, targetPath, kind = "write" } = {}) {
  const { root, relative } = validateTarget(workspace, targetPath, { allowWorkspaceRoot: true });
  if (isProtectedMemoryTarget(root, path.resolve(root, targetPath)) && !["attachment", "memory_approval"].includes(kind)) {
    const error = new Error("长期记忆目录不能通过普通文件工具创建");
    error.code = "MEMORY_WRITE_REQUIRES_PROPOSAL";
    throw error;
  }
  const info = stageInfo(runId);
  const directory = path.resolve(info.stagingDir, relative);
  if (!isInside(info.stagingDir, directory)) throw new Error("临时目录路径非法");
  ensureDirectory(directory);
  return { root, directory };
}

export function listStagedFiles(runId) {
  return loadManifest(runId).manifest.files || [];
}

export function listStagedFilesForValidation(runId) {
  const { info, manifest } = loadManifest(runId);
  return (manifest.files || []).map((entry) => ({
    ...entry,
    file: path.resolve(info.runDir, entry.stagedPath || ""),
    root: info.stagingDir,
  }));
}

export function publishStagedRun(runId, workspace, { onEvent, threadId = null } = {}) {
  const { root } = validateTarget(workspace, workspace);
  const { info, manifest } = loadManifest(runId);
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const checked = files.map((entry) => {
    const target = validateTarget(root, path.resolve(root, entry.path), { allowWorkspaceRoot: false }).target;
    const stagedPath = path.resolve(info.runDir, entry.stagedPath || "");
    if (!isInside(info.stagingDir, stagedPath) || !fs.existsSync(stagedPath) || !fs.statSync(stagedPath).isFile()) throw new Error(`临时产物不存在：${entry.path}`);
    if (fs.existsSync(target) && !fs.statSync(target).isFile()) throw new Error(`正式目标不是文件：${entry.path}`);
    return { ...entry, target, stagedPath };
  });
  const fileLocks = [];
  const backups = [];
  const backupDir = path.join(info.runDir, "发布备份");
  try {
    for (const entry of checked) {
      fileLocks.push(acquireWriteLock({ workspace: root, targetPath: entry.target, runId, threadId, kind: "artifact_publish" }));
      const backupPath = path.resolve(backupDir, entry.path);
      if (!isInside(backupDir, backupPath)) throw new Error(`发布备份路径非法：${entry.path}`);
      const existed = fs.existsSync(entry.target);
      if (existed) {
        ensureDirectory(path.dirname(backupPath));
        fs.copyFileSync(entry.target, backupPath);
      }
      backups.push({ target: entry.target, backupPath, existed });
      const content = fs.readFileSync(entry.stagedPath);
      atomicWriteFile(entry.target, content);
      entry.publishedAt = now();
      emitWriteEvent(onEvent, "artifact_materialized", { runId: safeRunId(runId), path: entry.path, kind: entry.kind, size: content.length });
    }
  } catch (error) {
    for (const backup of backups.reverse()) {
      try {
        if (backup.existed) atomicWriteFile(backup.target, fs.readFileSync(backup.backupPath));
        else fs.rmSync(backup.target, { force: true });
      } catch {}
    }
    throw error;
  } finally {
    for (const lock of fileLocks.reverse()) releaseWriteLock(lock);
    try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
  }
  const next = { ...manifest, files: checked.map(({ target: _target, stagedPath: _stagedPath, ...entry }) => ({ ...entry, status: "published" })), status: "published", publishedAt: now(), updatedAt: now() };
  saveManifest(info, next);
  return next.files;
}

export function discardStagedRun(runId, { onEvent, reason = "run_not_completed" } = {}) {
  const { info, manifest } = loadManifest(runId);
  const count = Array.isArray(manifest.files) ? manifest.files.length : 0;
  try { fs.rmSync(info.stagingDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(info.manifestFile, { force: true }); } catch {}
  emitWriteEvent(onEvent, "write_cleaned", { runId: safeRunId(runId), count, reason });
  return { ok: true, count, reason };
}

export function writeCoordinatorInfo() {
  return { lockDir: LOCK_DIR, activeLocks: locks.size, stagedRunsDir: RUNS_DIR };
}

reclaimStaleWriteLocks();
