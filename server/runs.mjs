import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { getWorkspace } from "./workspace.mjs";
import { appendEvent } from "./事件存储.mjs";
import { atomicWriteJson, ensureDirectory } from "./持久化工具.mjs";
import {
  discardStagedRun,
  ensureRunStaging,
  publishStagedRun,
  reclaimStaleWriteLocks,
  releaseRunLocks,
  withWriteLock,
} from "./写入协调.mjs";

const PROJECT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const RUNS_DIR = process.env.OAW_RUNS_DIR || path.join(PROJECT_DIR, ".oaw", "runs");
const MAX_FILES = 1200;
const MAX_BLOB_BYTES = 4 * 1024 * 1024;
const MAX_BLOB_TOTAL = 80 * 1024 * 1024;
const ACTIVE_RUN_STATUSES = new Set(["running", "queued", "waiting_user", "recovering", "cancel_requested"]);

function ensureDir(dir) {
  return ensureDirectory(dir);
}

function safeJsonWrite(file, value) {
  ensureDir(path.dirname(file));
  atomicWriteJson(file, value);
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
  run.updatedAt = new Date().toISOString();
  safeJsonWrite(runFile(run.id), run);
  return run;
}

function stepTitleForTool(name) {
  const labels = {
    read: "读取资料",
    grep: "检索项目内容",
    find: "查找文件",
    ls: "检查工作区",
    officecli: "处理 Office 文档",
    map_read: "读取地图项目",
    map_edit: "修改地图样式",
    map_import: "导入地图数据",
    map_analyze: "生成地图分析",
    map_save_analysis: "保存地图分析",
    map_clear_analysis: "清理地图分析",
    kb_search: "检索知识库",
    kb_read: "读取知识内容",
    context_read: "读取上下文",
    memory_update: "整理记忆建议",
  };
  return labels[name] || (name ? `执行 ${name}` : "执行 Agent 任务");
}

function ensureStep(run, stepId, name, status = "pending") {
  run.steps = Array.isArray(run.steps) ? run.steps : [];
  let step = run.steps.find((item) => item.id === stepId);
  if (!step) {
    step = {
      id: stepId || `${run.id}:event-${run.steps.length + 1}`,
      index: run.steps.length,
      name: name || "执行 Agent 任务",
      status,
      attempts: 0,
      startedAt: null,
      finishedAt: null,
      error: null,
    };
    run.steps.push(step);
  }
  return step;
}

function updateStepFromEvent(run, type, data = {}) {
  const toolName = data.name || data.toolName;
  const toolCallId = data.toolCallId || data.id || "";
  const stepId = data.stepId || (toolName ? `${run.id}:tool:${toolCallId || toolName}` : null);
  if (type === "step_started" || type === "tool_start") {
    const step = ensureStep(run, stepId, data.name ? stepTitleForTool(data.name) : data.name, "running");
    step.status = "running";
    step.startedAt ||= new Date().toISOString();
    step.attempts = Number(step.attempts || 0) + 1;
    run.currentStepId = step.id;
  } else if (type === "step_finished" || type === "tool_end") {
    const step = ensureStep(run, stepId, data.name ? stepTitleForTool(data.name) : data.name, "completed");
    step.status = data.isError ? "failed" : (data.status || "completed");
    step.error = data.isError ? String(data.error || data.result || "工具执行失败").slice(0, 500) : null;
    step.finishedAt = new Date().toISOString();
  } else if (type === "agent_error") {
    const step = run.currentStepId ? ensureStep(run, run.currentStepId) : ensureStep(run, null, "执行 Agent 任务", "failed");
    step.status = "failed";
    step.error = String(data.message || "Agent 执行失败").slice(0, 500);
    step.finishedAt = new Date().toISOString();
  }
}

export function beginRun({ clientId, threadId, sessionId = null, cwd = getWorkspace(), task = null, references = [], workflow = null, projectId = null, capabilityPlan = null } = {}) {
  const id = `run_${crypto.randomUUID()}`;
  const staging = ensureRunStaging(id, cwd);
  const before = snapshotWorkspace(cwd);
  copyBeforeBlobs(id, before);
  const run = {
    id,
    version: 1,
    status: "running",
    clientId: clientId || null,
    threadId: threadId || null,
    sessionId,
    projectId: projectId || null,
    cwd: before.root,
    task: task || null,
    capabilityPlan: capabilityPlan || task?.capabilityPlan || null,
    workflow: workflow ? { id: workflow.id, name: workflow.name, valid: workflow.valid, missing: workflow.missing || [] } : null,
    steps: Array.isArray(workflow?.steps) ? workflow.steps.map((name, index) => ({ id: `${workflow.id}:step-${index + 1}`, index, name, status: index === 0 ? "ready" : "pending", attempts: 0, startedAt: null, finishedAt: null, error: null })) : [],
    references: references || [],
    events: [{ seq: 1, type: "run_started", data: {}, at: new Date().toISOString() }],
    before,
    artifacts: [],
    staging: { directory: path.relative(PROJECT_DIR, staging.directory).replace(/\\/g, "/"), status: "open", files: [] },
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null,
  };
  if (!run.steps.length) {
    run.steps.push({ id: `${id}:main`, index: 0, name: "执行 Agent 任务", status: "running", attempts: 1, startedAt: run.startedAt, finishedAt: null, error: null });
    run.currentStepId = `${id}:main`;
  }
  const saved = saveRun(run);
  appendEvent({ clientId: run.clientId, threadId: run.threadId, runId: run.id, type: "run_started", data: { status: run.status, task: run.task, projectId: run.projectId } });
  return saved;
}

export function updateRunStep(id, stepId, patch = {}) {
  const run = loadRun(id);
  if (!run || !Array.isArray(run.steps)) return null;
  const step = run.steps.find((item) => item.id === stepId || String(item.index) === String(stepId));
  if (!step) return null;
  const nextStatus = patch.status || step.status;
  Object.assign(step, patch, { status: nextStatus });
  if (nextStatus === "running") { step.startedAt ||= new Date().toISOString(); step.attempts = Number(step.attempts || 0) + 1; }
  if (["completed", "failed", "skipped"].includes(nextStatus)) step.finishedAt = new Date().toISOString();
  run.events = Array.isArray(run.events) ? run.events : [];
  const seq = Number(run.eventSeq || run.events.length || 0) + 1;
  run.eventSeq = seq;
  run.events.push({ seq, type: "step_updated", data: { stepId: step.id, status: step.status }, at: new Date().toISOString() });
  const saved = saveRun(run);
  appendEvent({ clientId: run.clientId, threadId: run.threadId, runId: run.id, type: "step_updated", data: { stepId: step.id, status: step.status } });
  return saved;
}

export function recordRunEvent(id, type, data = {}) {
  const run = loadRun(id);
  if (!run) return null;
  run.events = Array.isArray(run.events) ? run.events : [];
  updateStepFromEvent(run, type, data);
  const seq = Number(run.eventSeq || run.events[run.events.length - 1]?.seq || run.events.length || 0) + 1;
  run.eventSeq = seq;
  if (run.events.length < 800) run.events.push({ seq, type, data, at: new Date().toISOString() });
  const saved = saveRun(run);
  appendEvent({ clientId: run.clientId, threadId: run.threadId, runId: run.id, type, data });
  return saved;
}

function changedFiles(before, after) {
  const a = before?.files || {};
  const b = after?.files || {};
  const deleted = [];
  const added = [];
  for (const rel of Object.keys(a)) if (!b[rel]) deleted.push({ path: rel, status: "deleted", before: a[rel], after: null });
  for (const rel of Object.keys(b)) if (!a[rel]) added.push({ path: rel, status: "added", before: null, after: b[rel] });
  const renames = [];
  for (const oldItem of deleted) {
    const match = added.find((item) => item.after?.hash && item.after.hash === oldItem.before?.hash && !renames.some((r) => r.from === oldItem.path || r.to === item.path));
    if (match) renames.push({ from: oldItem.path, to: match.path });
  }
  const paths = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed = [...paths].sort().flatMap((rel) => {
    const oldItem = a[rel];
    const newItem = b[rel];
    if (!oldItem && newItem) return [{ path: rel, status: "added", before: null, after: newItem }];
    if (oldItem && !newItem) return [{ path: rel, status: "deleted", before: oldItem, after: null }];
    if (oldItem.hash !== newItem.hash || oldItem.size !== newItem.size) return [{ path: rel, status: "modified", before: oldItem, after: newItem }];
    return [];
  });
  for (const rename of renames) {
    const oldItem = a[rename.from];
    const newItem = b[rename.to];
    changed.push({ path: rename.to, status: "renamed", from: rename.from, before: oldItem, after: newItem });
  }
  return changed.filter((item) => !renames.some((r) => (item.status === "deleted" && item.path === r.from) || (item.status === "added" && item.path === r.to))).sort((x, y) => x.path.localeCompare(y.path));
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

export function finishRun(id, { status = "completed", error = null, summary = "", sessionId = null, validations = [] } = {}) {
  const run = loadRun(id);
  if (!run) return null;
  const persistWriteEvent = (type, data) => appendEvent({
    clientId: run.clientId,
    threadId: run.threadId,
    runId: run.id,
    type,
    data,
  });
  let finalStatus = status;
  let finalError = error;
  const validationList = Array.isArray(validations) ? validations : [];
  if (finalStatus === "completed" && validationList.some((item) => item?.status === "failed")) {
    finalStatus = "failed";
    finalError ||= "产物校验失败，未发布临时产物";
  }
  if (finalStatus === "completed") {
    try {
      const staged = publishStagedRun(run.id, run.cwd, { threadId: run.threadId, onEvent: persistWriteEvent });
      run.staging = { ...(run.staging || {}), status: "published", files: staged };
    } catch (publishError) {
      finalStatus = "failed";
      finalError = `临时产物发布失败：${publishError?.message || publishError}`;
      discardStagedRun(run.id, { reason: "publish_failed", onEvent: persistWriteEvent });
      run.staging = { ...(run.staging || {}), status: "discarded", files: [] };
    }
  } else {
    discardStagedRun(run.id, { reason: finalStatus || "run_not_completed", onEvent: persistWriteEvent });
    run.staging = { ...(run.staging || {}), status: "discarded", files: [] };
  }
  try {
    const after = snapshotWorkspace(run.cwd);
    const artifacts = changedFiles(run.before, after);
    copyAfterBlobs(run, artifacts, after);
    run.after = after;
    run.artifacts = artifacts;
    run.status = finalStatus;
    run.error = finalError;
    if (sessionId) run.sessionId = sessionId;
    const validationMap = new Map(validationList.map((item) => [String(item?.path || "").replace(/\\/g, "/"), item]));
    for (const artifact of artifacts) {
      artifact.artifactId = `artifact_${crypto.randomUUID()}`;
      artifact.runId = run.id;
      artifact.sessionId = run.sessionId || null;
      artifact.projectId = run.projectId || null;
      artifact.validation = validationMap.get(String(artifact.path || "").replace(/\\/g, "/")) || null;
      artifact.verificationStatus = artifact.validation?.status || "not_checked";
    }
    run.validations = validationList;
    run.verificationStatus = run.validations.some((item) => item.status === "failed")
      ? "failed"
      : run.validations.some((item) => item.status === "warning")
        ? "warning"
        : run.validations.length
          ? "passed"
          : "not_checked";
    const verificationNote = run.verificationStatus === "failed" ? "，产物校验发现问题" : run.verificationStatus === "warning" ? "，产物校验有提示" : "";
    run.summary = summary || (artifacts.length ? `本轮处理 ${artifacts.length} 个文件${verificationNote}` : "本轮未产生文件变更");
    run.finishedAt = new Date().toISOString();
    run.events = Array.isArray(run.events) ? run.events : [];
    run.steps = Array.isArray(run.steps) ? run.steps : [];
    for (const step of run.steps) {
      if (step.status === "running" || step.status === "ready") {
        step.status = finalStatus === "completed" ? "completed" : (finalStatus === "cancelled" ? "cancelled" : "failed");
        step.finishedAt = run.finishedAt;
      }
    }
    const seq = Number(run.eventSeq || run.events[run.events.length - 1]?.seq || run.events.length || 0) + 1;
    run.eventSeq = seq;
    run.events.push({ seq, type: "run_finished", data: { status: finalStatus, artifacts: artifacts.length, verificationStatus: run.verificationStatus }, at: run.finishedAt });
    const saved = saveRun(run);
    appendEvent({ clientId: run.clientId, threadId: run.threadId, runId: run.id, type: "run_finished", data: { status: finalStatus, artifacts: artifacts.length, verificationStatus: run.verificationStatus } });
    return saved;
  } finally {
    releaseRunLocks(run.id);
  }
}

/**
 * 服务重启后，磁盘上仍为活动态的 Run 不可能继续持有旧进程内存，
 * 先标记为 recovering，交给任务中心显式继续，避免假装仍在执行。
 */
export function recoverActiveRuns({ onlyIds = null } = {}) {
  ensureDir(RUNS_DIR);
  reclaimStaleWriteLocks();
  const allowList = Array.isArray(onlyIds) ? new Set(onlyIds.map(String)) : null;
  const recovered = [];
  for (const name of fs.readdirSync(RUNS_DIR).filter((item) => item.endsWith(".json"))) {
    const run = loadRun(path.basename(name, ".json"));
    if (!run || !ACTIVE_RUN_STATUSES.has(run.status) || run.status === "recovering") continue;
    if (allowList && !allowList.has(run.id)) continue;
    run.status = "recovering";
    run.recovery = { required: true, reason: "服务重启后需要用户确认继续", detectedAt: new Date().toISOString() };
    run.events = Array.isArray(run.events) ? run.events : [];
    const seq = Number(run.eventSeq || run.events.length || 0) + 1;
    run.eventSeq = seq;
    run.events.push({ seq, type: "run_recovered", data: { status: "recovering" }, at: run.recovery.detectedAt });
    saveRun(run);
    appendEvent({ clientId: run.clientId, threadId: run.threadId, runId: run.id, type: "run_recovered", data: { status: "recovering", reason: run.recovery.reason } });
    recovered.push(run.id);
  }
  return recovered;
}

export function requestRunCancellation(id, reason = "用户请求中断") {
  const run = loadRun(id);
  if (!run) return null;
  if (!ACTIVE_RUN_STATUSES.has(run.status)) return getRun(id);
  if (run.status !== "cancel_requested") {
    run.status = "cancel_requested";
    run.cancelRequestedAt = new Date().toISOString();
    run.cancelReason = String(reason || "用户请求中断");
    run.events = Array.isArray(run.events) ? run.events : [];
    const seq = Number(run.eventSeq || run.events.length || 0) + 1;
    run.eventSeq = seq;
    run.events.push({ seq, type: "run_cancel_requested", data: { reason: run.cancelReason }, at: run.cancelRequestedAt });
    saveRun(run);
    appendEvent({ clientId: run.clientId, threadId: run.threadId, runId: run.id, type: "run_cancel_requested", data: { reason: run.cancelReason, status: run.status } });
  }
  return getRun(id);
}

export function getRun(id) {
  const run = loadRun(id);
  if (!run) return null;
  const { before, after, ...publicRun } = run;
  const steps = Array.isArray(publicRun.steps) ? publicRun.steps : [];
  const completed = steps.filter((step) => ["completed", "skipped"].includes(step.status)).length;
  return {
    ...publicRun,
    actions: {
      canCancel: ["running", "queued", "waiting_user", "recovering"].includes(publicRun.status),
      canResume: ["recovering", "failed", "cancelled", "aborted"].includes(publicRun.status),
      canRetry: ["failed", "cancelled", "aborted"].includes(publicRun.status),
    },
    progress: { completed, total: steps.length, running: steps.filter((step) => step.status === "running").length },
    currentStep: steps.find((step) => step.id === publicRun.currentStepId) || steps.find((step) => step.status === "running") || null,
    workspaceSnapshot: { beforeFiles: Object.keys(before?.files || {}).length, afterFiles: Object.keys(after?.files || {}).length },
  };
}

export function listRuns({ threadId = "", sessionId = "", cwd = "", projectId = "", status = "", mode = "", query = "", limit = 50 } = {}) {
  ensureDir(RUNS_DIR);
  const textQuery = String(query || "").trim().toLowerCase();
  return fs.readdirSync(RUNS_DIR)
    .filter((n) => n.endsWith(".json"))
    .map((n) => loadRun(path.basename(n, ".json")))
    .filter(Boolean)
    .filter((r) => (!threadId || r.threadId === threadId) && (!sessionId || r.sessionId === sessionId) && (!cwd || path.resolve(r.cwd || "") === path.resolve(cwd)))
    .filter((r) => (!projectId || r.projectId === projectId) && (!status || status === "all" || r.status === status))
    .filter((r) => (!mode || mode === "all" || r.task?.mode === mode))
    .filter((r) => !textQuery || [r.error, r.summary, r.task?.goal, r.currentStep?.error, ...(r.steps || []).map((step) => step.error)].filter(Boolean).join(" ").toLowerCase().includes(textQuery))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, Math.max(1, Math.min(200, limit)))
    .map((run) => getRun(run.id))
    .filter(Boolean);
}

/** 持久化成果验收，保留旧版 validations/verificationStatus 供历史客户端兼容。 */
export function updateRunAcceptance(id, acceptance) {
  const run = loadRun(id);
  if (!run) return null;
  run.acceptance = acceptance || null;
  run.acceptanceStatus = acceptance?.status || "not_checked";
  run.acceptanceReadyToPublish = Boolean(acceptance?.readyToPublish);
  const byPath = new Map((acceptance?.artifacts || []).map((item) => [String(item.path || "").replace(/\\/g, "/"), item]));
  for (const artifact of run.artifacts || []) {
    const result = byPath.get(String(artifact.path || "").replace(/\\/g, "/"));
    if (!result) continue;
    artifact.acceptance = result;
    artifact.acceptanceStatus = result.status;
  }
  return saveRun(run);
}

export function rollbackRun(id, paths = []) {
  const run = loadRun(id);
  if (!run || run.status === "running") return { ok: false, error: "run not finished" };
  let lock;
  try {
    lock = withWriteLock({ workspace: run.cwd, targetPath: run.cwd, runId: `rollback_${run.id}`, threadId: run.threadId, kind: "rollback" }, () => rollbackRunUnlocked(run, paths));
    return lock;
  } catch (error) {
    return { ok: false, code: error?.code || "ROLLBACK_FAILED", error: error?.message || String(error) };
  }
}

function rollbackRunUnlocked(run, paths = []) {
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
      else if (artifact.status === "renamed") {
        fs.rmSync(target, { force: true });
        const oldTarget = path.resolve(root, artifact.from || "");
        const oldSource = path.join(beforeDir, artifact.from || "");
        if (oldTarget !== root && oldTarget.startsWith(root + path.sep) && fs.existsSync(oldSource)) { ensureDir(path.dirname(oldTarget)); fs.copyFileSync(oldSource, oldTarget); }
      }
      else if (fs.existsSync(source)) { ensureDir(path.dirname(target)); fs.copyFileSync(source, target); }
      else continue;
      restored.push(artifact.path);
    } catch {}
  }
  return { ok: true, restored };
}

export function runsDir() { return RUNS_DIR; }
