import { reduceRunTrace, summarizeRunTrace, verificationLabel } from "./运行轨迹.js";
import { flowEventLabel } from "./事件展示.js";

/**
 * 运行展示投影（W1/A01）
 *
 * 目标：实时对话、历史恢复、任务中心、文件改动面板共用同一份「一轮任务」视图，
 * 避免每个组件各自拼装状态、产物与文件清单（当前结果卡/产物面板重复展示即源于此）。
 *
 * 约定：
 *   - 纯函数，无副作用、无 React 依赖，可在测试与 Node 环境直接调用；
 *   - 权威数据优先：Run 快照（run.completion / finalText）胜过事件推断；
 *     空事件不得清除已有权威数据；
 *   - 生命周期（queued/running/…/completed）与目标达成（outcome.status）分开；
 *   - 非终态事件不得宣告完成；状态缺失显示 unknown（“状态待同步”），不默认 completed；
 *   - 只投影明确的交付文件为 deliverables，内部/缓存/临时文件归 internal。
 */

/** 生命周期（与“目标是否达成”分开）。 */
export const LIFECYCLE_LABELS = Object.freeze({
  queued: "排队中",
  running: "执行中",
  waiting_user: "等待回答",
  waiting_approval: "等待审批",
  finalizing: "收尾中",
  completed: "运行结束",
  failed: "失败",
  cancelled: "已取消",
  unknown: "状态待同步",
});

export const TERMINAL_LIFECYCLES = Object.freeze(["completed", "failed", "cancelled"]);

export function isTerminalLifecycle(lifecycle) {
  return TERMINAL_LIFECYCLES.includes(String(lifecycle || ""));
}

export function lifecycleLabel(lifecycle) {
  return LIFECYCLE_LABELS[String(lifecycle || "unknown")] || LIFECYCLE_LABELS.unknown;
}

/** 原始 status / 事件 → 生命周期。缺失或未知状态返回 unknown，绝不默认 completed。 */
export function normalizeLifecycle(status) {
  const value = String(status || "").trim().toLowerCase();
  if (!value || value === "idle") return "unknown";
  if (["queued", "pending", "admitting", "admitted"].includes(value)) return value === "admitting" ? "running" : "queued";
  if (["running", "recovering", "recovery", "in_progress", "active"].includes(value)) return "running";
  if (value === "waiting_user") return "waiting_user";
  if (["waiting_approval", "waiting_approval_user"].includes(value)) return "waiting_approval";
  if (["finalizing", "cancel_requested", "cancelling", "canceling"].includes(value)) return "finalizing";
  if (["completed", "success", "done", "finished"].includes(value)) return "completed";
  if (["failed", "error"].includes(value)) return "failed";
  if (["cancelled", "canceled", "aborted", "interrupted"].includes(value)) return "cancelled";
  return "unknown";
}

/* ------------------------------ 文件变更分类 ------------------------------ */

// 内部/缓存/临时：不进主交付列表（与服务端 runs.mjs 的噪音规则保持一致的语义）
const INTERNAL_PATH_PATTERNS = [
  /(^|\/)\.oaw(\/|$)/i,
  /(^|\/)(node_modules|__pycache__|\.venv|venv|\.git|\.cache|\.pytest_cache|dist-info|\.turbo|\.parcel-cache)(\/|$)/i,
  /(^|\/)\./,                       // 隐藏文件与目录（含 .agent-context.*）
  /(^|\/)\._/,                      // macOS AppleDouble
  /(^|\/)~\$/,                      // Office 锁文件
  /\.(tmp|temp|log|bak|old|orig|pyc|pyo|swp|swo)$/i,
];

export function isInternalChangePath(relativePath) {
  const value = String(relativePath || "").replace(/\\/g, "/");
  if (!value) return true;
  return INTERNAL_PATH_PATTERNS.some((pattern) => pattern.test(value));
}

function normalizeChangeType(status) {
  const value = String(status || "").trim().toLowerCase();
  if (["added", "created", "new"].includes(value)) return "added";
  if (["deleted", "removed"].includes(value)) return "deleted";
  if (value === "renamed") return "renamed";
  if (["modified", "changed", "updated"].includes(value)) return "modified";
  return "unclassified";
}

/**
 * 产物/变更 → FileChange。
 * source: artifact（服务端已按前后 hash 确认）| suspected（仅 mtime 线索）| incomplete
 */
export function normalizeFileChange(input = {}, { runId = null } = {}) {
  const relativePath = String(input.relativePath || input.path || "").replace(/\\/g, "/");
  const changeType = normalizeChangeType(input.changeType || input.status);
  const internal = isInternalChangePath(relativePath);
  const acceptance = input.acceptance || null;
  const accepted = ["passed", "warning", "manual_review"].includes(String(acceptance?.status || input.acceptanceStatus || ""));
  const published = Boolean(input.publication) || String(input.publicationStatus || "") === "published";
  const role = internal ? "internal"
    : (accepted || published) ? "deliverable"
      : "unclassified";
  return {
    runId: input.runId || runId || null,
    workspaceId: input.workspaceId || null,
    cwd: input.cwd || null,
    relativePath,
    changeType,
    before: input.before ? { hash: input.before.hash || null, size: input.before.size ?? null, reversible: Boolean(input.before.reversible) } : null,
    after: input.after ? { hash: input.after.hash || null, size: input.after.size ?? null } : (input.size != null ? { hash: null, size: input.size } : null),
    source: input.source || "artifact",
    confidence: input.confidence || "confirmed",
    toolCallId: input.toolCallId || null,
    role,
    acceptanceStatus: acceptance?.status || input.acceptanceStatus || null,
    publishedAt: input.publishedAt || null,
  };
}

/* ------------------------------ 事件辅助 ------------------------------ */

function eventRunId(event) {
  return event?.runId || event?.data?.runId || null;
}

/** 只保留属于本 Run 的事件：其他 Run 的迟到事件不得改变本 Run 的视图。 */
function belongsToRun(event, runId) {
  if (!runId) return true;
  const value = eventRunId(event);
  return !value || String(value) === String(runId);
}

function lastEventOfType(events, types) {
  const wanted = new Set(Array.isArray(types) ? types : [types]);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (wanted.has(String(events[i]?.type || ""))) return events[i];
  }
  return null;
}

/** 等待原因：待审批 / 待回答（隐藏过程时也必须能找到需要行动的位置）。 */
function waitingReasonOf(events) {
  const approvals = new Map();
  let pendingAsk = null;
  for (const event of events) {
    const data = event?.data || {};
    if (event?.type === "tool_approval_request" && data.id) approvals.set(String(data.id), data);
    if (event?.type === "tool_approval_resolved" && data.id) approvals.delete(String(data.id));
    if (event?.type === "ask_user") pendingAsk = data;
    if (event?.type === "ask_answered" || event?.type === "ask_user_answered") pendingAsk = null;
  }
  if (approvals.size) {
    const first = [...approvals.values()][0];
    return { kind: "approval", text: `等待你批准：${first.tool || first.target || "工具"}`, approvalId: first.id || null };
  }
  if (pendingAsk) return { kind: "ask", text: "等待你回答", question: pendingAsk.question || "" };
  return null;
}

/* ------------------------------ 主投影 ------------------------------ */

/**
 * @param {object} run   Run 快照（服务端 Run JSON / 列表摘要 / 旧 RunSummary 消息）
 * @param {Array} events 该 Run 的事件（实时通道或历史 Run.events）
 * @returns {object} RunView
 */
export function projectRunView(run = {}, events = [], { now = Date.now() } = {}) {
  const source = run && typeof run === "object" ? run : {};
  const runId = source.runId || source.id || null;
  const allEvents = (Array.isArray(events) ? events : []).filter((event) => belongsToRun(event, runId));
  const trace = reduceRunTrace(allEvents, runId);
  const stats = summarizeRunTrace(trace);

  // 生命周期：快照 status 优先；快照缺失时用事件推断（但绝不默认 completed）
  let lifecycle = normalizeLifecycle(source.status || source.lifecycle || "");
  const waiting = waitingReasonOf(allEvents);
  if (!isTerminalLifecycle(lifecycle)) {
    if (waiting?.kind === "approval") lifecycle = "waiting_approval";
    else if (waiting?.kind === "ask") lifecycle = "waiting_user";
  }
  if (lifecycle === "unknown" && allEvents.length) {
    const ended = lastEventOfType(allEvents, ["run_finished", "agent_end"]);
    if (ended) {
      const status = String(ended?.data?.status || "");
      lifecycle = normalizeLifecycle(status || (ended.type === "run_finished" ? "completed" : "unknown"));
    }
  }
  const terminal = isTerminalLifecycle(lifecycle);

  // 目标达成（outcome）：快照 completion 权威；否则事件推断；非终态不得宣告完成
  const eventCompletion = trace.completion || null;
  const snapshotCompletion = source.completion || null;
  let outcome = snapshotCompletion || eventCompletion || null;
  if (outcome && !terminal && !source.completion) {
    // 只有事件推断的完成声明、且运行未终态时，不把它当成最终目标达成
    outcome = { ...outcome, provisional: true };
  }

  // 最终回答（answer）：只认权威终稿，重连时替换同一条，不追加第二份
  const finalText = String(source.finalText || "").trim();
  const finalMessageId = source.finalMessageId || null;
  const finalTextVersion = Number(source.finalTextVersion || 0) || 0;
  const answerEvent = lastEventOfType(allEvents, "assistant_final");
  const eventText = String(answerEvent?.data?.text || "").trim();
  const eventMessageId = answerEvent?.data?.messageId || null;
  const answer = finalText
    ? { messageId: finalMessageId, version: finalTextVersion, text: finalText, source: "run" }
    : (eventText ? { messageId: eventMessageId, version: 0, text: eventText, source: "event" } : null);

  // 文件改动：Run 快照的 artifacts 为权威；事件里的 file_changed 只作疑似线索
  const artifactChanges = (Array.isArray(source.artifacts) ? source.artifacts : [])
    .map((artifact) => normalizeFileChange({ ...artifact, source: "artifact", confidence: "confirmed" }, { runId }));
  const knownPaths = new Set(artifactChanges.map((change) => change.relativePath));
  const suspected = [];
  for (const event of allEvents) {
    if (event?.type !== "file_changed") continue;
    for (const file of Array.isArray(event?.data?.files) ? event.data.files : []) {
      const relativePath = String(file || "").replace(/\\/g, "/");
      if (!relativePath || knownPaths.has(relativePath)) continue;
      knownPaths.add(relativePath);
      suspected.push(normalizeFileChange({ path: relativePath, status: "modified", source: "event", confidence: "suspected" }, { runId }));
    }
  }
  const changes = [...artifactChanges, ...suspected];
  const deliverables = changes.filter((change) => change.role === "deliverable");

  // 记忆建议：只给待审核入口，不插进主回答
  const memoryProposalIds = [...new Set(allEvents
    .filter((event) => event?.type === "memory_proposal" && event?.data?.id)
    .map((event) => String(event.data.id)))];

  // 当前动作：最近一条“有内容”的事件标签（阶段类事件不参与）
  const latestEvent = (() => {
    for (let i = allEvents.length - 1; i >= 0; i -= 1) {
      const type = String(allEvents[i]?.type || "");
      if (!type || type === "stats" || type === "token" || type === "heartbeat") continue;
      return allEvents[i];
    }
    return null;
  })();
  let currentAction = latestEvent ? String(flowEventLabel(latestEvent) || "") : "";

  return {
    runId,
    lifecycle,
    lifecycleLabel: lifecycleLabel(lifecycle),
    terminal,
    outcome,
    answer,
    progress: {
      phase: stats.phase || "idle",
      currentAction,
      waitingReason: waiting ? waiting.text : null,
      waitingKind: waiting ? waiting.kind : null,
      turns: stats.turns,
      toolTotal: stats.toolTotal,
      toolFailed: stats.toolFailed,
      durationMs: stats.durationMs,
      startedAt: stats.startedAt,
      endedAt: trace.endedAt || null,
    },
    trace: {
      tools: trace.tools || [],
      notes: trace.notes || [],
      errors: trace.errors || [],
      files: trace.files || [],
      todos: trace.todos || [],
    },
    changes,
    deliverables,
    verification: {
      status: source.verificationStatus || trace.verification || "not_checked",
      label: verificationLabel(source.verificationStatus || trace.verification || "not_checked"),
      checks: Array.isArray(source.validations) ? source.validations : [],
      source: source.verificationStatus ? "run" : (trace.verification ? "event" : "none"),
    },
    memoryProposalIds,
    // 调试用：投影输入规模，便于排查“事件很多但没变化”
    meta: { eventCount: allEvents.length, changeCount: changes.length, deliverableCount: deliverables.length, now },
  };
}

/**
 * 旧数据适配器（A02 第 3 条 / A01“旧事件适配器”）：
 * 历史里的 RunSummary 系统消息（m.summary === true）没有 Run 快照，但有 text/completion/artifacts/products/events。
 * 这里把它折成 Run 快照形状，喂给同一个投影，避免为历史再写一套展示逻辑。
 */
export function adaptLegacyRunSummary(message = {}) {
  const artifacts = Array.isArray(message.artifacts) && message.artifacts.length
    ? message.artifacts
    : (Array.isArray(message.products) ? message.products : []).map((product) => (typeof product === "string" ? { path: product, status: "modified" } : product));
  return {
    runId: message.runId || null,
    status: message.runStatus || null,
    completion: message.completion || null,
    verificationStatus: message.verification?.status || message.verificationStatus || null,
    finalText: message.finalText || message.text || "",
    artifacts,
    cwd: message.workspace || null,
    productPaths: Array.isArray(message.products) ? message.products : [],
  };
}

/** 便捷入口：直接投影一条旧 RunSummary 消息。 */
export function projectLegacyRunSummary(message = {}, events = [], options = {}) {
  return projectRunView(adaptLegacyRunSummary(message), Array.isArray(events) && events.length ? events : (message.events || []), options);
}
