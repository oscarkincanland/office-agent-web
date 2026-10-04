import { reduceRunTrace, summarizeRunTrace, verificationLabel } from "./运行轨迹.js";
import { flowEventLabel, phaseForEvent } from "./事件展示.js";

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
    changeId: input.changeId || null,
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

/* ------------------------------ 工作阶段与时间线（W7/E01、E03） ------------------------------ */

/** 工作阶段：与生命周期分开；允许“验证 → 再执行”的回退（失败重试），只有生命周期终态不可倒退。 */
export const WORK_PHASE_ORDER = Object.freeze(["idle", "planning", "executing", "verifying", "delivering"]);

function workPhaseOfEvent(event) {
  const phase = phaseForEvent(event);
  if (!phase) return null;
  if (phase === "done" || phase === "finishing") return "delivering";
  if (phase === "preparing") return "planning";
  return WORK_PHASE_ORDER.includes(phase) ? phase : null;
}

/**
 * 从事件序列推导工作阶段轨迹：
 *   - 前进即推进；「验证 → 执行」视为一次重试（attempt+1）；
 *   - 其余回退忽略（后到的早期事件不把阶段拉回去）。
 */
export function deriveWorkPhase(events = []) {
  let phase = "idle";
  const attempts = { planning: 0, executing: 0, verifying: 0, delivering: 0 };
  const trail = [];
  for (const event of events) {
    const next = workPhaseOfEvent(event);
    if (!next || next === phase) continue;
    const from = WORK_PHASE_ORDER.indexOf(phase);
    const to = WORK_PHASE_ORDER.indexOf(next);
    const retry = phase === "verifying" && next === "executing";
    if (!(to > from || retry)) continue;
    phase = next;
    attempts[next] = (attempts[next] || 0) + 1;
    trail.push({ phase: next, at: event?.at || event?.timestamp || null, attempt: attempts[next], retry });
  }
  return { phase, attempts, trail, retries: trail.filter((item) => item.retry).length };
}

function eventTime(event) {
  return event?.at || event?.timestamp || event?.createdAt || null;
}

/** 结构化时间线（E03）：首事件 / 首个模型事件 / 首可见文本 / 模型结束 / 验证结束 / 终态。 */
export function deriveTimeline(events = [], run = {}) {
  const firstOf = (types) => {
    for (const event of events) if (types.includes(String(event?.type || ""))) return eventTime(event);
    return null;
  };
  const lastOf = (types) => {
    for (let i = events.length - 1; i >= 0; i -= 1) if (types.includes(String(events[i]?.type || ""))) return eventTime(events[i]);
    return null;
  };
  const admitted = firstOf(["run_admitted", "run_admitting", "run_started"]);
  const firstModelEvent = firstOf(["model_request_started", "thinking", "message_start", "token"]);
  const firstVisibleText = firstOf(["token", "assistant_final"]);
  const modelEnd = lastOf(["agent_end", "turn_ended"]);
  const verificationEnd = lastOf(["artifacts_validated"]);
  const finished = run.finishedAt || lastOf(["run_finished"]) || null;
  const ms = (from, to) => (from && to ? Math.max(0, new Date(to).getTime() - new Date(from).getTime()) : null);
  return {
    admitted,
    firstModelEvent,
    firstVisibleText,
    modelEnd,
    verificationEnd,
    finished,
    // 分延迟：首事件延迟 / 模型执行 / 后台收尾
    latencyToFirstEventMs: ms(admitted, firstModelEvent),
    modelDurationMs: ms(firstModelEvent, modelEnd),
    tailLatencyMs: ms(modelEnd, finished),
  };
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
  const workPhase = deriveWorkPhase(allEvents);
  const timeline = deriveTimeline(allEvents, source);
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
      workPhase: workPhase.phase,
      attempts: workPhase.attempts,
      retries: workPhase.retries,
      phaseTrail: workPhase.trail,
      timeline,
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

/**
 * 合并同一 Run 的实时摘要与终态事件。
 * agent_summary 通常先到，run_finished 随后补齐状态、结论和产物；
 * 这里集中处理旧消息复用，避免事件处理器依赖 setState updater 内部变量。
 */
export function upsertRunSummaryMessage(messages = [], data = {}, {
  id = null,
  workspace = "",
  runMode = "agent",
  createdAt = Date.now(),
} = {}) {
  const list = associateRunMessages(Array.isArray(messages) ? messages : []);
  const runId = data?.runId || null;
  if (!runId) return list;

  const index = list.findIndex((item) => item?.summary && item.runId === runId);
  const previous = index >= 0 ? list[index] : null;
  const status = data.status || previous?.runStatus || "";
  const statusText = status === "failed" ? "失败"
    : status === "cancelled" ? "已取消"
      : status === "aborted" ? "已中断"
        : status === "running" ? "执行中"
          : status === "completed" ? "完成"
            : "状态待同步";
  const summaryText = String(data.summary || data.completion?.summary || previous?.text || `本轮任务${statusText}`).trim();
  const incomingArtifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
  const artifacts = incomingArtifacts.length ? incomingArtifacts : null;
  const incomingProducts = Array.isArray(data.products) ? data.products : [];
  const products = incomingProducts.length
    ? incomingProducts
    : (artifacts || []).map((item) => item?.path).filter(Boolean);
  const nextArtifacts = artifacts || previous?.artifacts || [];
  const nextProducts = products.length ? products : (previous?.products || []);
  const next = {
    ...(previous || {}),
    id: previous?.id || id || `run-summary:${runId}`,
    role: "system",
    text: summaryText,
    products: nextProducts,
    artifacts: nextArtifacts,
    runId,
    runStatus: status || "unknown",
    references: data.references || previous?.references || [],
    task: data.task || previous?.task || null,
    workspace: data.workspace || previous?.workspace || workspace || "",
    runMode: data.task?.mode || previous?.runMode || runMode || "agent",
    eventCount: Number(data.eventCount || previous?.eventCount || 0),
    events: Array.isArray(data.events) ? data.events : (previous?.events || []),
    finalText: String(data.finalText || previous?.finalText || ""),
    completion: data.completion || previous?.completion || null,
    reviewSources: Array.isArray(data.reviewSources) ? data.reviewSources : (previous?.reviewSources || []),
    status: "done",
    summary: true,
    createdAt: previous?.createdAt || createdAt,
    expanded: false,
    // 只有“本轮刚刚结束”才做文件改动高亮；历史回放与重连补齐不重播动画。
    flashFiles: data.fresh === true || previous?.flashFiles === true,
  };
  if (index < 0) return associateRunMessages([...list, next]);
  return associateRunMessages(list.map((item, itemIndex) => itemIndex === index ? next : item));
}

/**
 * 把同一轮里的 assistant 过程消息及系统进度提醒关联到 runId，
 * 让界面能将它们和 SSE/结论合并到同一个过程面板；真实用户消息仍是分组边界。
 */
export function associateRunMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) return list;
  let next = list;
  let changed = false;
  for (let summaryIndex = 0; summaryIndex < list.length; summaryIndex += 1) {
    const summary = list[summaryIndex];
    const runId = String(summary?.role === "system" && summary.summary ? summary.runId || "" : "");
    if (!runId) continue;
    let start = summaryIndex - 1;
    for (; start >= 0; start -= 1) {
      const item = list[start];
      if (item?.role === "system" && item.summary) break;
      const internalReminder = item?.role === "user" && /^\s*(?:\[系统提醒\]|系统提醒[：:])/.test(String(item.text || ""));
      if (item?.role === "user" && !internalReminder) break;
    }
    for (let index = start + 1; index < summaryIndex; index += 1) {
      const item = (changed ? next : list)[index];
      const internalProcess = item?.role === "user" && /^\s*(?:\[系统提醒\]|系统提醒[：:])/.test(String(item.text || ""));
      if ((!internalProcess && item?.role !== "assistant") || (item.runId && item.runId !== runId)) continue;
      if (item.runId === runId && Boolean(item.internalProcess) === internalProcess) continue;
      if (!changed) { next = [...list]; changed = true; }
      next[index] = { ...item, runId, ...(internalProcess ? { internalProcess: true } : {}) };
    }
  }
  return changed ? next : list;
}
