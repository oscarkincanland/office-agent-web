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
const TODO_STATUS_ALIASES = Object.freeze({
  pending: "planned",
  todo: "planned",
  ready: "planned",
  planned: "planned",
  running: "in_progress",
  active: "in_progress",
  in_progress: "in_progress",
  "in-progress": "in_progress",
  completed: "completed",
  complete: "completed",
  done: "completed",
  skipped: "skipped",
  blocked: "blocked",
  failed: "failed",
});
const TODO_STATUSES = new Set(["planned", "in_progress", "completed", "skipped", "blocked", "failed"]);
const MAX_TODO_ITEMS = 12;
const MAX_TODO_TITLE = 300;
const MAX_TODO_NOTE = 500;

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

// Run JSON 解析缓存：按 mtime+size 指纹失效。
// 会话列表、任务中心、线程切换都会高频遍历 400+ 个 Run 文件，
// 无缓存时每次全量 JSON.parse（含 before/after 快照）需要数秒。
const RUN_CACHE_LIMIT = 500;
const runCache = new Map();

function loadRun(id) {
  const file = runFile(id);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    runCache.delete(id);
    return null;
  }
  const fingerprint = `${stat.mtimeMs}:${stat.size}`;
  const cached = runCache.get(id);
  if (cached?.fingerprint === fingerprint) return cached.data;
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  runCache.set(id, { fingerprint, data });
  while (runCache.size > RUN_CACHE_LIMIT) {
    const oldest = runCache.keys().next().value;
    if (oldest === undefined) break;
    runCache.delete(oldest);
  }
  return data;
}

function saveRun(run) {
  run.updatedAt = new Date().toISOString();
  safeJsonWrite(runFile(run.id), run);
  // 写后失效缓存：下次读取以磁盘为准，避免缓存与持久化状态分叉
  runCache.delete(run.id);
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
    todo: "更新任务清单",
  };
  return labels[name] || (name ? `执行 ${name}` : "执行 Agent 任务");
}

function normalizeTodoStatus(value, done = false) {
  if (done === true) return "completed";
  const normalized = TODO_STATUS_ALIASES[String(value || "").trim().toLowerCase()];
  return normalized && TODO_STATUSES.has(normalized) ? normalized : "planned";
}

function todoIdFor(title, index) {
  const digest = crypto.createHash("sha1").update(`${index}:${title}`).digest("hex").slice(0, 10);
  return `todo-${index + 1}-${digest}`;
}

export function normalizeTodoItems(items = []) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  return items.slice(0, MAX_TODO_ITEMS).flatMap((item, index) => {
    const title = String(item?.title ?? item?.name ?? item?.text ?? "").trim().slice(0, MAX_TODO_TITLE);
    if (!title) return [];
    let id = String(item?.id || "").trim().replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || todoIdFor(title, index);
    while (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    const dependsOn = Array.isArray(item?.dependsOn)
      ? [...new Set(item.dependsOn.map((value) => String(value || "").trim()).filter(Boolean))].slice(0, 8)
      : [];
    return [{
      id,
      index,
      title,
      status: normalizeTodoStatus(item?.status, item?.done),
      note: String(item?.note ?? item?.details ?? "").trim().slice(0, MAX_TODO_NOTE),
      dependsOn,
    }];
  });
}

function todoSignature(items = []) {
  return JSON.stringify(normalizeTodoItems(items).map(({ id, title, status, note, dependsOn }) => ({ id, title, status, note, dependsOn })));
}

/**
 * 持久化 Agent 的结构化 Todo。Todo 是“计划事实”，和 steps 的底层工具执行事实分开。
 * 事件只在这里写入一次；调用方可以再通过会话 SSE 把同一快照推给前端。
 */
export function updateRunTodo(id, items = [], { source = "agent" } = {}) {
  const run = loadRun(id);
  if (!run) return null;
  const next = normalizeTodoItems(items);
  if (todoSignature(run.todos || []) === todoSignature(next) && run.todoVersion === 1) return getRun(id);
  const updatedAt = new Date().toISOString();
  run.todoVersion = 1;
  run.todos = next;
  run.todoUpdatedAt = updatedAt;
  run.events = Array.isArray(run.events) ? run.events : [];
  const data = { source: String(source || "agent"), todos: next };
  const seq = Number(run.eventSeq || run.events[run.events.length - 1]?.seq || run.events.length || 0) + 1;
  run.eventSeq = seq;
  run.events.push({ seq, type: "todo_updated", data, at: updatedAt });
  const saved = saveRun(run);
  appendEvent({ clientId: run.clientId, threadId: run.threadId, runId: run.id, type: "todo_updated", data });
  return getRun(saved.id);
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
    const existing = run.steps?.find((item) => item.id === stepId);
    const step = ensureStep(run, stepId, data.name ? stepTitleForTool(data.name) : data.name, "running");
    const wasRunning = existing?.status === "running";
    step.status = "running";
    step.startedAt ||= new Date().toISOString();
    if (!wasRunning) step.attempts = Number(step.attempts || 0) + 1;
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

function normalizeTrackedPath(run, value) {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  if (!raw || raw === ".") return ".";
  if (path.isAbsolute(raw)) {
    const relative = path.relative(run.cwd, raw).replace(/\\/g, "/");
    if (relative && !relative.startsWith("../") && relative !== "..") return relative;
    return ".";
  }
  return raw.replace(/^\.\//, "").replace(/\/+$/, "") || ".";
}

// 临时/调试类噪音文件：不进入工作产物列表（agent 执行过程中的脚本、日志、缓存等）
const NOISE_ARTIFACT_PATTERNS = [
  /(^|\/)(node_modules|__pycache__|\.venv|venv|\.git|\.oaw|\.cache|\.pytest_cache|dist-info)(\/|$)/i,
  /(^|\/)\./,                                   // 隐藏文件与目录（含 .agent-context.md）
  /(^|\/)_agent_write_test\./i,                 // 写入探针测试文件
  /_log\d*\.(txt|json|md|log)$/i,               // 调试日志
  /(^|\/)(tmp|temp|test)_[^/]*\.(py|js|mjs|cjs|ts|sh|bat|ps1|txt|log|json)$/i,
  /(^|\/)debug[^/]*\.(py|js|mjs|txt|log|json)$/i,
  /\.(tmp|temp|log|bak|old|orig|pyc|pyo|swp|swo)$/i,
];
// 根目录/任意目录的前导下划线脚本类临时文件：_head.py、_jscheck.txt、_mapdata_run.txt
const SCRATCH_SCRIPT_BASENAME = /^_[^/]*\.(py|js|mjs|cjs|ts|sh|bat|ps1|txt|log|json)$/i;

/** 临时/调试文件判定：用于产物列表过滤，避免糟糕的中间文件混入“工作产物”。 */
export function isNoiseArtifactPath(relativePath) {
  const value = String(relativePath || "").replace(/\\/g, "/").trim();
  if (!value) return false;
  for (const pattern of NOISE_ARTIFACT_PATTERNS) {
    if (pattern.test(value)) return true;
  }
  const basename = value.split("/").pop() || "";
  return SCRATCH_SCRIPT_BASENAME.test(basename);
}

function trackedPathMatches(tracked, candidate) {
  if (tracked === ".") return true;
  return candidate === tracked || candidate.startsWith(`${tracked}/`);
}

/**
 * 只保留本 Run 明确触碰过的文件。
 * 工作区快照仍用于发现 Office CLI/Bash 的直接写入，但并行 Run 的文件不能
 * 因为恰好在同一时间发布而被错误归入当前产物。
 */
export function filterRunChanges(run, changes = []) {
  if (!run || !Array.isArray(changes)) return [];
  const tracked = [...new Set((run.touchedPaths || []).map((value) => normalizeTrackedPath(run, value)).filter(Boolean))];
  return changes.filter((item) => {
    // 兼容两种输入：字符串路径（waitForFlush/diffWorkspace）与对象（changedFiles）
    const pathValue = typeof item === "string" ? item : item?.path;
    if (isNoiseArtifactPath(pathValue)) return false;
    if (typeof item === "string") {
      if (!tracked.length) return true;
      const candidate = normalizeTrackedPath(run, item);
      return tracked.some((prefix) => trackedPathMatches(prefix, candidate));
    }
    if (!tracked.length) return true;
    const candidates = [item?.path, item?.from].map((value) => normalizeTrackedPath(run, value)).filter(Boolean);
    return candidates.some((candidate) => tracked.some((prefix) => trackedPathMatches(prefix, candidate)));
  });
}

export function beginRun({ clientId, threadId, sessionId = null, cwd = getWorkspace(), task = null, references = [], workflow = null, projectId = null, capabilityPlan = null, runtimeSnapshot = null, recoveryChain = [], snapshotMode = "full" } = {}) {
  const id = `run_${crypto.randomUUID()}`;
  const staging = ensureRunStaging(id, cwd);
  const normalizedSnapshotMode = snapshotMode === "none" ? "none" : "full";
  // Chat 是只读边界，不应为每轮问答扫描并复制整个工作区。仍保留 Run、事件和
  // 会话追溯记录；真正可能写文件的 Agent / Office Run 继续使用完整可回滚快照。
  const before = normalizedSnapshotMode === "none"
    ? { root: path.resolve(cwd), capturedAt: new Date().toISOString(), files: {}, size: 0 }
    : snapshotWorkspace(cwd);
  if (normalizedSnapshotMode === "full") copyBeforeBlobs(id, before);
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
    runtime: runtimeSnapshot || null,
    recoveryChain: Array.isArray(recoveryChain) ? recoveryChain : [],
    checkpoint: {
      version: 1,
      type: "jsonl_reopen",
      status: sessionId ? "available" : "unavailable",
      native: false,
      sessionId: sessionId || null,
      note: "当前使用 JSONL 会话重开 + 恢复提示词；Pi token 级 checkpoint 尚未接入。",
      updatedAt: new Date().toISOString(),
    },
    workflow: workflow ? { id: workflow.id, name: workflow.name, valid: workflow.valid, missing: workflow.missing || [] } : null,
    todoVersion: 1,
    todos: [],
    steps: Array.isArray(workflow?.steps) ? workflow.steps.map((name, index) => ({ id: `${workflow.id}:step-${index + 1}`, index, name, status: index === 0 ? "ready" : "pending", attempts: 0, startedAt: null, finishedAt: null, error: null })) : [],
    references: references || [],
    // 由 write_started/artifact_staged 事件记录本 Run 的写入边界。
    // 没有触碰文件时保持空数组，兼容只读 Agent 和旧 Run。
    touchedPaths: [],
    events: [{ seq: 1, type: "run_started", data: {}, at: new Date().toISOString() }],
    before,
    artifacts: [],
    snapshotMode: normalizedSnapshotMode,
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
  if (["write_started", "artifact_staged", "artifact_materialized"].includes(type) && data && typeof data === "object" && data.path) {
    run.touchedPaths = Array.isArray(run.touchedPaths) ? run.touchedPaths : [];
    const trackedPath = normalizeTrackedPath(run, data.path);
    if (!run.touchedPaths.includes(trackedPath)) run.touchedPaths.push(trackedPath);
  }
  updateStepFromEvent(run, type, data);
  if (type === "runtime_health" && data && typeof data === "object") {
    run.runtimeHealth = data;
    run.runtime = { ...(run.runtime || {}), ...data };
  }
  if (type === "runtime_error" && data && typeof data === "object") {
    run.runtimeHealth = { status: "failed", ...data };
    if (data.runtime && typeof data.runtime === "object") run.runtime = { ...(run.runtime || {}), ...data.runtime };
    run.recovery = { required: true, reason: data.message || "Pi Runtime 异常", detectedAt: new Date().toISOString() };
  }
  const seq = Number(run.eventSeq || run.events[run.events.length - 1]?.seq || run.events.length || 0) + 1;
  run.eventSeq = seq;
  if (run.events.length < 800) run.events.push({ seq, type, data, at: new Date().toISOString() });
  const saved = saveRun(run);
  appendEvent({ clientId: run.clientId, threadId: run.threadId, runId: run.id, type, data });
  return saved;
}

/** 幂等更新 Run 检查点；相同状态重复上报不会追加重复事件。 */
export function updateRunCheckpoint(id, patch = {}) {
  const run = loadRun(id);
  if (!run) return null;
  const next = { ...(run.checkpoint || {}), ...(patch || {}) };
  const comparable = (value) => JSON.stringify(value);
  if (comparable(next) === comparable(run.checkpoint || {})) return getRun(id);
  next.updatedAt = new Date().toISOString();
  run.checkpoint = next;
  run.events = Array.isArray(run.events) ? run.events : [];
  const seq = Number(run.eventSeq || run.events.length || 0) + 1;
  run.eventSeq = seq;
  run.events.push({ seq, type: "run_checkpoint_updated", data: next, at: next.updatedAt });
  const saved = saveRun(run);
  appendEvent({ clientId: run.clientId, threadId: run.threadId, runId: run.id, type: "run_checkpoint_updated", data: next });
  return getRun(saved.id);
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

export function finishRun(id, { status = "completed", error = null, summary = "", sessionId = null, validations = [], publishPaths = null, completion = null } = {}) {
  const run = loadRun(id);
  if (!run) return null;
  // 并发收尾（例如 SSE 重放、后台异常兜底、取消请求同时到达）只能落一次终态。
  // 否则第二次会重复发布/丢失产物并再次追加 run_finished，前端恢复时就会出现两条结论。
  if (["completed", "failed", "cancelled", "aborted"].includes(run.status) && run.finishedAt) return run;
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
  const effectivePublishPaths = publishPaths ?? (validationList.some((item) => item?.status === "failed")
    ? validationList.filter((item) => item?.status !== "failed").map((item) => item?.path).filter(Boolean)
    : null);
  // 混合场景跳过失败文件继续发布；但如果所有待发布文件都校验失败，
  // 没有任何可发布内容，Run 必须落为失败而不是伪装完成。
  const hasFailedValidation = validationList.some((item) => item?.status === "failed");
  const hasPublishable = !hasFailedValidation || (Array.isArray(effectivePublishPaths) && effectivePublishPaths.length > 0);
  if (finalStatus === "completed" && hasFailedValidation && !hasPublishable) {
    finalStatus = "failed";
    finalError ||= "产物校验失败，未发布临时产物";
  }
  if (finalStatus === "completed") {
    try {
      const staged = publishStagedRun(run.id, run.cwd, { threadId: run.threadId, onEvent: persistWriteEvent, paths: effectivePublishPaths });
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
    const shouldTrackWorkspace = run.snapshotMode !== "none";
    const after = shouldTrackWorkspace
      ? snapshotWorkspace(run.cwd)
      : { root: path.resolve(run.cwd), capturedAt: new Date().toISOString(), files: {}, size: 0 };
    const artifacts = shouldTrackWorkspace ? filterRunChanges(run, changedFiles(run.before, after)) : [];
    if (shouldTrackWorkspace) copyAfterBlobs(run, artifacts, after);
    run.after = after;
    run.artifacts = artifacts;
    run.status = finalStatus;
    run.error = finalError;
    if (sessionId) run.sessionId = sessionId;
    run.checkpoint = {
      ...(run.checkpoint || {}),
      status: sessionId || run.sessionId ? "available" : "unavailable",
      sessionId: sessionId || run.sessionId || null,
      updatedAt: new Date().toISOString(),
    };
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
    // 完成语义：显式声明（complete_task）优先；否则由上层传入的兼容推断结果。
    if (completion && typeof completion === "object") run.completion = completion;
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
    run.events.push({ seq, type: "run_finished", data: { status: finalStatus, artifacts: artifacts.length, verificationStatus: run.verificationStatus, completion: run.completion || null }, at: run.finishedAt });
    const saved = saveRun(run);
    appendEvent({ clientId: run.clientId, threadId: run.threadId, runId: run.id, type: "run_finished", data: { status: finalStatus, artifacts: artifacts.length, verificationStatus: run.verificationStatus, completion: run.completion || null } });
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
  return publicRunView(run);
}

// 把已加载的 Run 投影为对外公开结构（去掉体积很大的 before/after 快照）。
// listRuns 直接复用该方法，避免对同一文件二次 loadRun。
function publicRunView(run) {
  const { before, after, ...publicRun } = run;
  const steps = Array.isArray(publicRun.steps) ? publicRun.steps : [];
  const completed = steps.filter((step) => ["completed", "skipped"].includes(step.status)).length;
  const todos = Array.isArray(publicRun.todos) ? publicRun.todos : [];
  const todoCompleted = todos.filter((item) => ["completed", "skipped"].includes(item.status)).length;
  return {
    ...publicRun,
    actions: {
      canCancel: ["running", "queued", "waiting_user", "recovering"].includes(publicRun.status),
      canResume: ["recovering", "failed", "cancelled", "aborted"].includes(publicRun.status),
      canRetry: ["failed", "cancelled", "aborted"].includes(publicRun.status),
    },
    progress: { completed, total: steps.length, running: steps.filter((step) => step.status === "running").length },
    todoProgress: { completed: todoCompleted, total: todos.length, running: todos.filter((item) => item.status === "in_progress").length, blocked: todos.filter((item) => item.status === "blocked").length, failed: todos.filter((item) => item.status === "failed").length },
    currentStep: steps.find((step) => step.id === publicRun.currentStepId) || steps.find((step) => step.status === "running") || null,
    workspaceSnapshot: { beforeFiles: Object.keys(before?.files || {}).length, afterFiles: Object.keys(after?.files || {}).length },
  };
}

function sameRunWorkspace(a, b) {
  const left = path.resolve(String(a || ""));
  const right = path.resolve(String(b || ""));
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function listRuns({ threadId = "", sessionId = "", cwd = "", projectId = "", status = "", mode = "", query = "", limit = 50 } = {}) {
  ensureDir(RUNS_DIR);
  const textQuery = String(query || "").trim().toLowerCase();
  return fs.readdirSync(RUNS_DIR)
    .filter((n) => n.endsWith(".json"))
    .map((n) => loadRun(path.basename(n, ".json")))
    .filter(Boolean)
    .filter((r) => (!threadId || r.threadId === threadId) && (!sessionId || r.sessionId === sessionId) && (!cwd || sameRunWorkspace(r.cwd, cwd)))
    // 当前项目同时按 ID 和工作区查询；老 Run 可能还没有 projectId，
    // 但只要其工作区相同仍应出现在任务中心，避免升级后历史任务消失。
    .filter((r) => (!projectId || r.projectId === projectId || (cwd && !r.projectId && sameRunWorkspace(r.cwd, cwd))) && (!status || status === "all" || r.status === status))
    .filter((r) => (!mode || mode === "all" || r.task?.mode === mode))
    .filter((r) => !textQuery || [r.error, r.summary, r.task?.goal, r.currentStep?.error, ...(r.steps || []).map((step) => step.error), ...(r.todos || []).map((item) => `${item.title} ${item.note || ""}`)].filter(Boolean).join(" ").toLowerCase().includes(textQuery))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, Math.max(1, Math.min(200, limit)))
    .map((run) => publicRunView(run))
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
