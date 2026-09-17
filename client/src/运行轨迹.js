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
  preparing: "准备",
  executing: "执行",
  finishing: "整理产物",
  done: "完成",
  failed: "失败",
  cancelled: "已取消",
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
      setPhase(trace, "preparing", at);
      break;
    case "tool_start": {
      if (!trace.startedAt) trace.startedAt = at;
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
    case "agent_end":
      if (!trace.completion) setPhase(trace, "finishing", at);
      break;
    case "run_finished": {
      trace.endedAt = at;
      const status = String(data.status || "completed");
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

/** 折叠态聚合统计：工具数量、成功/失败/执行中、文件与错误计数。 */
export function summarizeRunTrace(trace) {
  const tools = trace?.tools || [];
  const ok = tools.filter((tool) => tool.status === "done" && !tool.isError).length;
  const failed = tools.filter((tool) => tool.status === "done" && tool.isError).length;
  const running = tools.filter((tool) => tool.status !== "done").length;
  return {
    toolTotal: tools.length,
    toolOk: ok,
    toolFailed: failed,
    toolRunning: running,
    fileCount: (trace?.files || []).length,
    errorCount: (trace?.errors || []).length,
    completion: trace?.completion || null,
    phase: trace?.phase || "idle",
  };
}

/** 折叠态一行摘要，例如：已调用 6 个工具 · 5 成功 · 1 执行中 · 2 个文件变更 */
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
  if (stats.fileCount) parts.push(`${stats.fileCount} 个文件变更`);
  if (stats.errorCount) parts.push(`${stats.errorCount} 次错误`);
  if (stats.completion) parts.push(completionLabel(stats.completion.status));
  return parts.join(" · ");
}
