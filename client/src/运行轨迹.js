// 运行轨迹归约：把原始事件流（SSE 实时事件或 Run.events 历史）归约为
// 可渲染的执行轨迹。实时流与历史恢复共用同一归约器，保证两侧展示一致。
//
// 归约产物：
//   - tools：按 toolCallId 聚合的工具记录（start/output/end 合成一条）
//   - files：本轮文件变更（去重）
//   - errors：模型/工具错误
//   - completion：完成语义（显式 task_completed 优先，否则按 run_finished 推断）
//   - phase：准备 → 执行 → 整理产物 → 完成/失败/取消

export const COMPLETION_LABELS = Object.freeze({
  success: "已完成",
  partial: "部分完成",
  blocked: "受阻",
  failed: "失败",
  cancelled: "已取消",
});

export const PHASE_LABELS = Object.freeze({
  idle: "等待",
  planning: "计划",
  executing: "执行",
  verifying: "验证",
  delivering: "交付",
  done: "完成",
  failed: "失败",
  cancelled: "已取消",
  // 兼容旧数据/旧事件（preparing 曾用于 run_admitting 阶段）
  preparing: "计划",
  finishing: "交付",
});

export function completionLabel(status) {
  return COMPLETION_LABELS[status] || "已结束";
}

export function createRunTrace(runId = null) {
  return {
    runId,
    phase: "idle",
    phases: [],
    tools: [],
    files: [],
    errors: [],
    todos: [],
    // 进度叙事：模型回合数、周期进度小结（steer）与耗时，供「执行过程」头行展示
    turns: 0,
    notes: [],
    durationMs: null,
    verification: null,
    completion: null,
    startedAt: null,
    endedAt: null,
  };
}

function eventKey(event) {
  if (event?.key) return String(event.key);
  const at = event?.at || "";
  const seq = event?.seq ?? event?.id ?? "";
  return `${event?.type || "?"}|${at}|${seq}|${event?.data?.toolCallId || ""}`;
}

function setPhase(trace, phase, at) {
  if (trace.phase === phase) return;
  trace.phase = phase;
  trace.phases.push({ phase, at: at || new Date().toISOString() });
}

/** 阶段只能前进（计划 → 执行 → 验证 → 交付）：后到的早期事件不把阶段拉回去。 */
export const PHASE_ORDER = Object.freeze(["idle", "planning", "executing", "verifying", "delivering", "done"]);
function advancePhase(trace, phase, at) {
  const current = PHASE_ORDER.indexOf(trace.phase === "preparing" ? "planning" : trace.phase === "finishing" ? "delivering" : trace.phase);
  const next = PHASE_ORDER.indexOf(phase);
  if (next < 0) return;
  if (current >= 0 && current >= next) return;
  setPhase(trace, phase, at);
}

function findTool(trace, data) {
  const toolCallId = data?.toolCallId ? String(data.toolCallId) : "";
  if (toolCallId) {
    const byId = trace.tools.find((tool) => tool.toolCallId === toolCallId);
    if (byId) return byId;
  }
  if (data?.name) {
    for (let i = trace.tools.length - 1; i >= 0; i -= 1) {
      const tool = trace.tools[i];
      if (tool.name === data.name && !tool.toolCallId) return tool;
    }
  }
  return null;
}

export function applyRunTraceEvent(trace, event) {
  const type = String(event?.type || "");
  const data = event?.data || {};
  const at = event?.at || new Date().toISOString();
  switch (type) {
    case "run_admitting":
    case "run_admitted":
      if (!trace.startedAt) trace.startedAt = at;
      setPhase(trace, "planning", at);
      break;
    case "turn_started":
      // 模型回合计数：进度行用它表达"第 N 轮"，跨实时流与历史回放一致
      trace.turns = Number(trace.turns || 0) + 1;
      break;
    case "steer": {
      // 周期进度播报与轮次预算提醒：作为进度时间线上的里程碑保留
      const source = String(data.source || "user");
      if (source === "turn-progress" || source.startsWith("turn-budget")) {
        trace.notes.push({
          id: `${source}:${data.turnCount ?? trace.turns}:${String(data.message || "").slice(0, 40)}`,
          source,
          message: String(data.message || "").slice(0, 300),
          turnCount: Number(data.turnCount || trace.turns || 0),
          at,
        });
      }
      break;
    }
    case "capability_plan":
    case "mode_policy":
      if (!trace.startedAt) trace.startedAt = at;
      advancePhase(trace, "planning", at);
      break;
    case "tool_start": {
      if (!trace.startedAt) trace.startedAt = at;
      advancePhase(trace, "executing", at);
      const existing = findTool(trace, data);
      if (existing) {
        if (existing.status !== "done") existing.status = "running";
        if (!existing.startAt) existing.startAt = at;
        break;
      }
      trace.tools.push({
        id: data.toolCallId || `${data.name || "tool"}:${trace.tools.length}`,
        toolCallId: data.toolCallId ? String(data.toolCallId) : null,
        name: data.name || "tool",
        input: data.input || "",
        output: "",
        result: "",
        isError: false,
        status: "running",
        startAt: at,
        endAt: null,
        duration: null,
        startMissing: false,
      });
      break;
    }
    case "tool_output": {
      const tool = findTool(trace, data);
      if (!tool) break;
      const chunk = String(data.output ?? data.text ?? "");
      if (!chunk) break;
      tool.output = data.replace ? chunk : (tool.output || "") + chunk;
      break;
    }
    case "tool_end": {
      let tool = findTool(trace, data);
      if (!tool) {
        // start 事件已被历史淘汰或重连丢失：创建带恢复标记的记录，
        // 保证工具数量与实际执行一致。
        tool = {
          id: data.toolCallId || `${data.name || "tool"}:${trace.tools.length}`,
          toolCallId: data.toolCallId ? String(data.toolCallId) : null,
          name: data.name || "tool",
          input: "",
          output: "",
          result: "",
          isError: false,
          status: "running",
          startAt: null,
          endAt: null,
          duration: null,
          startMissing: true,
        };
        trace.tools.push(tool);
      }
      tool.status = "done";
      tool.isError = !!data.isError;
      if (data.result !== undefined && data.result !== null) tool.result = String(data.result).slice(0, 4000);
      tool.endAt = at;
      if (tool.startAt) {
        const ms = new Date(at).getTime() - new Date(tool.startAt).getTime();
        if (Number.isFinite(ms) && ms >= 0) tool.duration = Number((ms / 1000).toFixed(1));
      }
      break;
    }
    case "file_changed": {
      const files = Array.isArray(data.files) ? data.files : [];
      for (const file of files) {
        const value = String(file || "").replace(/\\/g, "/");
        if (value && !trace.files.includes(value)) trace.files.push(value);
      }
      break;
    }
    case "officecli_failed":
      trace.errors.push({ message: String(data.message || "Office CLI 失败").slice(0, 300), at, type });
      break;
    case "agent_error":
      trace.errors.push({ message: String(data.message || "模型调用失败").slice(0, 300), at, type });
      break;
    case "todo_updated": {
      advancePhase(trace, "planning", at);
      // 计划进度：最后一次完整快照即当前计划（服务端每次提交完整清单）
      const items = Array.isArray(data.items) ? data.items : [];
      trace.todos = items.map((item, index) => ({
        id: String(item?.id || `t${index + 1}`),
        title: String(item?.title || "").slice(0, 120),
        status: String(item?.status || "planned"),
      }));
      break;
    }
    case "task_completed":
      if (data.status) {
        trace.completion = {
          status: String(data.status),
          source: data.source || "explicit",
          summary: String(data.summary || ""),
          incomplete: Array.isArray(data.incomplete) ? data.incomplete : [],
          blockers: Array.isArray(data.blockers) ? data.blockers : [],
          verification: data.verification || null,
          at,
        };
      }
      break;
    case "artifacts_validated":
      trace.verification = data.status || trace.verification || "not_checked";
      advancePhase(trace, "verifying", at);
      break;
    case "artifact_staged":
    case "artifact_materialized":
    case "artifact_published":
      advancePhase(trace, "delivering", at);
      break;
    case "agent_end":
      if (!trace.completion) advancePhase(trace, "delivering", at);
      // 服务端 agent_end 带上本轮轮次/工具/耗时；旧服务端没有该字段时保留本地统计
      if (Number(data.turns) > 0) trace.turns = Math.max(Number(trace.turns || 0), Number(data.turns));
      if (Number(data.durationMs) > 0) trace.durationMs = Number(data.durationMs);
      break;
    case "run_finished": {
      trace.endedAt = at;
      if (!(Number(trace.durationMs) > 0) && trace.startedAt) {
        const ms = new Date(at).getTime() - new Date(trace.startedAt).getTime();
        if (Number.isFinite(ms) && ms > 0) trace.durationMs = ms;
      }
      const status = String(data.status || "completed");
      // 验收状态：发布前预检 + 显式校验的结果，未检查时如实显示
      trace.verification = data.verificationStatus || trace.verification || "not_checked";
      // 服务端 run_finished 携带的 completion 是权威结果（显式或推断），优先采用；
      // 旧服务端没有该字段时才本地推断。
      if (data.completion && typeof data.completion === "object" && data.completion.status) {
        trace.completion = { ...data.completion, at };
      } else if (!trace.completion) {
        trace.completion = {
          status: status === "completed" ? "success" : status === "cancelled" || status === "aborted" ? "cancelled" : "failed",
          source: "inferred",
          summary: String(data.summary || ""),
          incomplete: [],
          blockers: [],
          verification: data.verificationStatus && data.verificationStatus !== "not_checked" ? data.verificationStatus : null,
          at,
        };
      }
      const phase = trace.completion.status === "failed"
        ? "failed"
        : trace.completion.status === "cancelled"
          ? "cancelled"
          : "done";
      setPhase(trace, phase, at);
      break;
    }
    default:
      break;
  }
  return trace;
}

/** 从事件数组重建运行轨迹；重复事件按 key 幂等去重（重连回放安全）。 */
export function reduceRunTrace(events = [], runId = null) {
  const trace = createRunTrace(runId);
  const seen = new Set();
  for (const event of events) {
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    applyRunTraceEvent(trace, event);
  }
  return trace;
}

/** 折叠态聚合统计：工具数量、成功/失败/执行中、文件与错误计数、计划进度与验收。 */
export function summarizeRunTrace(trace) {
  const tools = trace?.tools || [];
  const ok = tools.filter((tool) => tool.status === "done" && !tool.isError).length;
  const failed = tools.filter((tool) => tool.status === "done" && tool.isError).length;
  const running = tools.filter((tool) => tool.status !== "done").length;
  const todos = trace?.todos || [];
  const todoDone = todos.filter((todo) => todo.status === "completed").length;
  const todoUnfinished = todos.filter((todo) => !["completed", "skipped"].includes(todo.status)).length;
  return {
    toolTotal: tools.length,
    toolOk: ok,
    toolFailed: failed,
    toolRunning: running,
    fileCount: (trace?.files || []).length,
    errorCount: (trace?.errors || []).length,
    todoTotal: todos.length,
    todoDone,
    todoUnfinished,
    turns: Number(trace?.turns || 0),
    noteCount: (trace?.notes || []).length,
    durationMs: Number(trace?.durationMs || 0),
    startedAt: trace?.startedAt || null,
    verification: trace?.verification || "not_checked",
    completion: trace?.completion || null,
    phase: trace?.phase || "idle",
  };
}

/** 耗时文案：45 秒 / 3 分 12 秒 / 1 小时 2 分 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

/**
 * 运行中进度行：阶段 · 第 N 轮 · 工具 M · 待办 x/y · 用时。
 * 与折叠摘要互补——摘要讲"做了什么"，进度行讲"现在到哪一步"。
 */
export function runTraceProgressText(trace, { now = Date.now(), running = false } = {}) {
  const stats = summarizeRunTrace(trace);
  const parts = [];
  if (stats.turns) parts.push(`第 ${stats.turns} 轮`);
  if (stats.toolTotal) parts.push(`工具 ${stats.toolTotal}`);
  if (stats.todoTotal) parts.push(`待办 ${stats.todoDone}/${stats.todoTotal}`);
  const startedAt = stats.startedAt ? new Date(stats.startedAt).getTime() : 0;
  const elapsed = running && startedAt ? now - startedAt : stats.durationMs;
  if (elapsed > 0) parts.push(`用时 ${formatDuration(elapsed)}`);
  if (stats.noteCount) parts.push(`进度小结 ${stats.noteCount} 次`);
  return parts.join(" · ");
}

/** 验收状态文案：与产物验证（发布前预检、显式校验）保持一致。 */
export function verificationLabel(status) {
  return {
    passed: "验收通过",
    warning: "验收有提示",
    failed: "验收失败",
    not_checked: "未验收",
  }[String(status || "not_checked")] || "未验收";
}

/** 折叠态一行摘要，例如：已调用 6 个工具 · 5 成功 · 待办 3/4 · 验收通过 · 2 个文件变更 */
export function runTraceSummaryText(trace) {
  const stats = summarizeRunTrace(trace);
  const parts = [];
  if (stats.toolTotal) {
    parts.push(`已调用 ${stats.toolTotal} 个工具`);
    const details = [];
    if (stats.toolOk) details.push(`${stats.toolOk} 成功`);
    if (stats.toolFailed) details.push(`${stats.toolFailed} 失败`);
    if (stats.toolRunning) details.push(`${stats.toolRunning} 执行中`);
    if (details.length) parts.push(details.join(" · "));
  }
  if (stats.todoTotal) {
    parts.push(`待办 ${stats.todoDone}/${stats.todoTotal}${stats.todoUnfinished ? `（未完成 ${stats.todoUnfinished}）` : ""}`);
  }
  if (stats.fileCount) parts.push(`${stats.fileCount} 个文件变更`);
  if (stats.errorCount) parts.push(`${stats.errorCount} 次错误`);
  // 验收只在有产物或明确校验过时展示，避免每个纯问答回合都写"未验收"
  if (stats.fileCount || stats.verification !== "not_checked") parts.push(verificationLabel(stats.verification));
  if (stats.completion) parts.push(completionLabel(stats.completion.status));
  return parts.join(" · ");
}
