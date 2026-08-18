import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { getWorkspace } from "./workspace.mjs";

const PROJECT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const RUNS_DIR = path.join(PROJECT_DIR, ".oaw", "runs");
const MAX_FILES = 1200;
const MAX_BLOB_BYTES = 4 * 1024 * 1024;
const MAX_BLOB_TOTAL = 80 * 1024 * 1024;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeJsonWrite(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function runFile(id) {
  return path.join(RUNS_DIR, `${String(id).replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

function hashFile(file) {
  const h = crypto.createHash("sha1");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    let n = 0;
    do {
      n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n) h.update(buf.subarray(0, n));
    } while (n);
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

function walk(dir, root, out, budget) {
  if (out.size >= MAX_FILES || budget.remaining <= 0) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (out.size >= MAX_FILES || budget.remaining <= 0) break;
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "tiles") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, root, out, budget);
      continue;
    }
    try {
      const st = fs.statSync(full);
      const rel = path.relative(root, full).replace(/\\/g, "/");
      const item = { path: rel, size: st.size, mtime: st.mtimeMs, hash: null, reversible: false };
      if (st.size <= 16 * 1024 * 1024 && budget.remaining > st.size) {
        item.hash = hashFile(full);
        budget.remaining -= st.size;
      } else {
        item.hash = `${st.size}:${st.mtimeMs}`;
      }
      out.files[rel] = item;
      out.size += 1;
    } catch {}
  }
}

export function snapshotWorkspace(root = getWorkspace()) {
  const out = { root: path.resolve(root), capturedAt: new Date().toISOString(), files: {}, size: 0 };
  walk(out.root, out.root, out, { remaining: 120 * 1024 * 1024 });
  return out;
}

function copyBeforeBlobs(runId, snapshot) {
  const dir = ensureDir(path.join(RUNS_DIR, runId, "before"));
  let remaining = MAX_BLOB_TOTAL;
  for (const item of Object.values(snapshot.files)) {
    if (remaining <= 0 || item.size > MAX_BLOB_BYTES) continue;
    const source = path.join(snapshot.root, item.path);
    const target = path.join(dir, item.path);
    try {
      ensureDir(path.dirname(target));
      fs.copyFileSync(source, target);
      item.reversible = true;
      remaining -= item.size;
    } catch {}
  }
}

function loadRun(id) {
  try { return JSON.parse(fs.readFileSync(runFile(id), "utf8")); } catch { return null; }
}

function saveRun(run) {
  safeJsonWrite(runFile(run.id), run);
  return run;
}

export function beginRun({ clientId, threadId, sessionId = null, cwd = getWorkspace(), task = null, references = [] } = {}) {
  const id = `run_${crypto.randomUUID()}`;
  const before = snapshotWorkspace(cwd);
  copyBeforeBlobs(id, before);
  const run = {
    id,
    version: 1,
    status: "running",
    clientId: clientId || null,
    threadId: threadId || null,
    sessionId,
    cwd: before.root,
    task: task || null,
    references: references || [],
    events: [{ type: "run_started", at: new Date().toISOString() }],
    before,
    artifacts: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  return saveRun(run);
}

export function recordRunEvent(id, type, data = {}) {
  const run = loadRun(id);
  if (!run) return null;
  run.events = Array.isArray(run.events) ? run.events : [];
  if (run.events.length < 800) run.events.push({ type, data, at: new Date().toISOString() });
  return saveRun(run);
}

function changedFiles(before, after) {
  const a = before?.files || {};
  const b = after?.files || {};
  const paths = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...paths].sort().flatMap((rel) => {
    const oldItem = a[rel];
    const newItem = b[rel];
    if (!oldItem && newItem) return [{ path: rel, status: "added", before: null, after: newItem }];
    if (oldItem && !newItem) return [{ path: rel, status: "deleted", before: oldItem, after: null }];
    if (oldItem.hash !== newItem.hash || oldItem.size !== newItem.size) return [{ path: rel, status: "modified", before: oldItem, after: newItem }];
    return [];
  });
}

function copyAfterBlobs(run, artifacts, after) {
  const dir = ensureDir(path.join(RUNS_DIR, run.id, "after"));
  for (const artifact of artifacts) {
    if (!artifact.after || artifact.after.size > MAX_BLOB_BYTES) continue;
    const source = path.join(after.root, artifact.path);
    const target = path.join(dir, artifact.path);
    try {
      ensureDir(path.dirname(target));
      fs.copyFileSync(source, target);
      artifact.after.reversible = true;
    } catch {}
  }
}

export function finishRun(id, { status = "completed", error = null, summary = "", sessionId = null } = {}) {
  const run = loadRun(id);
  if (!run) return null;
  const after = snapshotWorkspace(run.cwd);
  const artifacts = changedFiles(run.before, after);
  copyAfterBlobs(run, artifacts, after);
  run.after = after;
  run.artifacts = artifacts;
  run.status = status;
  run.error = error;
  if (sessionId) run.sessionId = sessionId;
  run.summary = summary || (artifacts.length ? `本轮处理 ${artifacts.length} 个文件` : "本轮未产生文件变更");
  run.finishedAt = new Date().toISOString();
  run.events = Array.isArray(run.events) ? run.events : [];
  run.events.push({ type: "run_finished", data: { status, artifacts: artifacts.length }, at: run.finishedAt });
  return saveRun(run);
}

export function getRun(id) {
  const run = loadRun(id);
  if (!run) return null;
  const { before, after, ...publicRun } = run;
  return { ...publicRun, workspaceSnapshot: { beforeFiles: Object.keys(before?.files || {}).length, afterFiles: Object.keys(after?.files || {}).length } };
}

export function listRuns({ threadId = "", limit = 50 } = {}) {
  ensureDir(RUNS_DIR);
  return fs.readdirSync(RUNS_DIR).filter((n) => n.endsWith(".json")).map((n) => loadRun(path.basename(n, ".json"))).filter(Boolean).filter((r) => !threadId || r.threadId === threadId).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, Math.max(1, Math.min(200, limit))).map(getRun);
}

export function rollbackRun(id, paths = []) {
  const run = loadRun(id);
  if (!run || run.status === "running") return { ok: false, error: "run not finished" };
  const wanted = new Set(Array.isArray(paths) && paths.length ? paths : run.artifacts.map((a) => a.path));
  const beforeDir = path.join(RUNS_DIR, run.id, "before");
  const root = path.resolve(run.cwd);
  const restored = [];
  for (const artifact of run.artifacts) {
    if (!wanted.has(artifact.path)) continue;
    const target = path.resolve(root, artifact.path);
    if (target !== root && !target.startsWith(root + path.sep)) continue;
    const source = path.join(beforeDir, artifact.path);
    try {
      if (artifact.status === "added") fs.rmSync(target, { force: true });
      else if (fs.existsSync(source)) { ensureDir(path.dirname(target)); fs.copyFileSync(source, target); }
      else continue;
      restored.push(artifact.path);
    } catch {}
  }
  return { ok: true, restored };
}

export function runsDir() { return RUNS_DIR; }
