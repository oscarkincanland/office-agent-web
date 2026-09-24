/**
 * 事件展示注册表：把"事件类型 → 文案 / 语气 / 阶段 / 是否只作阶段标记"集中到一处。
 *
 * 背景：此前 ChatPanel 里各写一份（flowEventLabel 80+ case、flowEventTone、
 * FLOW_EVENT_TYPES、ExecutionFlow 的 STAGE_ONLY_EVENTS），新增事件容易只更新一处，
 * 事件流里也看不出"计划 → 执行 → 验证 → 交付"的阶段推进。
 *
 * 约定：新增事件先在 EVENT_UI 登记（未登记的类型按兜底文案渲染），
 * 阶段推进由 phaseForEvent 驱动，ExecutionFlow 按阶段变化插入分组标题。
 */

/** 任务阶段：与 运行轨迹.js 的 trace.phase 保持一致 */
export const PHASE_LABELS = Object.freeze({
  idle: "等待",
  planning: "计划",
  executing: "执行",
  verifying: "验证",
  delivering: "交付",
  done: "完成",
  failed: "失败",
  cancelled: "已取消",
});

export const PHASE_ORDER = Object.freeze(["idle", "planning", "executing", "verifying", "delivering", "done"]);

const TOOL_LABELS = Object.freeze({
  read: "读取文件", write: "写入文件", edit: "编辑文件", bash: "执行命令",
  officecli: "执行 Office CLI", find: "查找文件", grep: "搜索内容", ls: "列出文件",
  ask_user: "等待用户回答",
});

/** 只作为阶段标记、不逐条刷屏的事件（ExecutionFlow 合并为一行） */
export const STAGE_ONLY_EVENTS = new Set([
  "runtime_connecting", "run_admitting", "run_admitted", "model_request_started", "agent_started",
  "turn_started", "turn_ended", "agent_turn_end", "mode_policy", "thinking_level", "capability_plan",
  "agent_end", "assistant_final",
]);

/**
 * 事件展示登记表：phase = 该事件把本轮推进到的阶段（用于分组与折叠摘要）。
 * 未登记的类型走兜底：不推进阶段、文案用事件名。
 */
export const EVENT_UI = Object.freeze({
  // 计划
  runtime_connecting: { phase: "planning" },
  run_admitting: { phase: "planning" },
  run_admitted: { phase: "planning" },
  capability_plan: { phase: "planning" },
  mode_policy: { phase: "planning" },
  thinking_level: { phase: "planning" },
  todo_updated: { phase: "planning" },
  model_request_started: { phase: "planning" },
  agent_started: { phase: "planning" },
  turn_started: { phase: "planning" },
  // 执行
  tool_start: { phase: "executing" },
  tool_end: { phase: "executing" },
  write_started: { phase: "executing" },
  write_locked: { phase: "executing" },
  write_rejected: { phase: "executing" },
  officecli_failed: { phase: "executing" },
  file_changed: { phase: "executing" },
  ask_user: { phase: "executing" },
  tool_approval_request: { phase: "executing" },
  tool_approval_resolved: { phase: "executing" },
  agent_retry: { phase: "executing" },
  agent_retry_end: { phase: "executing" },
  agent_model_fallback: { phase: "executing" },
  agent_model_fallback_failed: { phase: "executing" },
  context_compacting: { phase: "executing" },
  context_compacted: { phase: "executing" },
  context_compact_warning: { phase: "executing" },
  agent_error: { phase: "executing" },
  steer: { phase: "executing" },
  agent_queued: { phase: "executing" },
  agent_queue_update: { phase: "executing" },
  tool_repeat_warning: { phase: "executing" },
  completion_nudge: { phase: "executing" },
  // 验证
  artifacts_validated: { phase: "verifying" },
  // 交付
  artifact_staged: { phase: "delivering" },
  artifact_materialized: { phase: "delivering" },
  artifact_published: { phase: "delivering" },
  write_cleaned: { phase: "delivering" },
  // 收尾
  agent_turn_end: { phase: "done" },
  agent_summary: { phase: "done" },
  assistant_final: { phase: "done" },
  agent_end: { phase: "done" },
  task_completed: { phase: "done" },
  run_finished: { phase: "done" },
  aborted: { phase: "done" },
});

/** 进入执行流的全部事件类型（含未登记但需要展示的 Review / 审批类） */
const FLOW_EXTRAS = [
  "stream_waiting", "stream_resync",
  "review_material_classified", "review_source_search_started", "review_source_search_result",
  "review_source_read_started", "review_source_read", "review_source_applied", "review_source_unused",
  "review_waiting_confirmation", "review_confirmed", "review_confirmation_rejected", "review_write_blocked",
];

export const FLOW_EVENT_TYPES = new Set([...Object.keys(EVENT_UI), ...FLOW_EXTRAS]);

/** 事件 → 阶段（未登记的事件返回 null，不推进阶段） */
export function phaseForEvent(event) {
  const type = String(event?.type || "");
  if (type === "run_finished") {
    const status = String(event?.data?.status || "completed");
    return status === "failed" ? "failed" : status === "cancelled" || status === "aborted" ? "cancelled" : "done";
  }
  return EVENT_UI[type]?.phase || null;
}

function eventMessageText(message, fallback) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

const MODE_LABELS = Object.freeze({ chat: "Chat", agent: "Work", office: "Office", review: "Review" });

/** 事件 → 展示文案 */
export function flowEventLabel(event) {
  const data = event?.data || {};
  const tool = data.name || data.toolName || "工具";
  const toolLabel = TOOL_LABELS[String(tool).toLowerCase()] || tool;
  switch (event?.type) {
    case "runtime_connecting": return "正在准备会话运行时";
    case "run_admitting": return "准备任务";
    case "stream_waiting": return "正在接收事件流";
    case "stream_resync": return "事件流已重新同步";
    case "run_admitted": return "任务已受理";
    case "model_request_started": return "请求模型";
    case "agent_started": return "模型已开始处理";
    case "turn_started": return "开始生成回合";
    case "turn_ended": return "生成段结束";
    case "write_started": return "准备写入";
    case "write_locked": return "写入已锁定";
    case "artifact_staged": return "产物已暂存";
    case "artifact_materialized": return "产物已发布";
    case "artifact_published": return "产物已固定";
    case "write_cleaned": return "清理暂存产物";
    case "artifacts_validated": {
      const failed = Number(data.failed || 0);
      const checked = Number(data.checked || 0);
      return data.status === "failed" ? `产物验收失败（${failed}/${checked}）` : `产物验收通过（${checked} 项）`;
    }
    case "steer": {
      const source = String(data.source || "user");
      if (source === "turn-progress") return `进度播报提醒（第 ${data.turnCount || "?"} 轮）`;
      if (source === "turn-budget-hard") return "轮次预算用尽提醒";
      if (source === "turn-budget") return "阶段结论提醒";
      return "插入新指令";
    }
    case "tool_repeat_warning": return `重复调用提醒：${data.name || "工具"} 第 ${data.count || 3} 次`;
    case "completion_nudge": return "补充完成状态";
    case "tool_start": return `调用 ${toolLabel}`;
    case "tool_end": return `${toolLabel}${data.isError ? "失败" : "完成"}`;
    case "todo_updated": return `任务清单已更新${data.todoProgress ? `（${data.todoProgress.completed || 0}/${data.todoProgress.total || 0}）` : ""}`;
    case "officecli_failed": return `Office CLI 失败${data.message ? `：${String(data.message).slice(0, 60)}` : ""}`;
    case "ask_user": return "等待用户回答";
    case "tool_approval_request": return `等待审批：${toolLabel}`;
    case "tool_approval_resolved": return data.decision === "allow" ? "审批已通过" : "审批已拒绝";
    case "agent_retry": return "模型连接重试";
    case "agent_retry_end": return data.success ? "模型连接已恢复" : "模型重试结束";
    case "agent_model_fallback": return `切换备用模型${data.to ? `：${data.to}` : ""}`;
    case "agent_model_fallback_failed": return "备用模型切换失败";
    case "context_compacting": return "压缩上下文";
    case "context_compacted": return "上下文压缩完成";
    case "context_compact_warning": return "上下文压缩有提示";
    case "agent_turn_end": return "模型收尾";
    case "agent_error": return eventMessageText(data.message, data.category === "quota" ? "模型额度不足" : "模型调用失败");
    case "write_rejected": return data.message || "工具操作被拦截";
    case "file_changed": return `文件已更新${data.files?.length ? `（${data.files.length}）` : ""}`;
    case "agent_summary": return "生成任务总结";
    case "assistant_final": return "收到最终回复";
    case "agent_end": return "Agent 处理结束";
    case "run_finished": return runConclusion(event).label;
    case "task_completed": return `任务${completionLabelSafe(data.status)}${data.summary ? `：${String(data.summary).slice(0, 50)}` : ""}`;
    case "aborted": return "任务已中断";
    case "capability_plan": return "能力准备完成";
    case "mode_policy": return `模式：${MODE_LABELS[String(data.mode || "").toLowerCase()] || "Chat"}`;
    case "review_material_classified": return `材料识别：${data.materialType || "待判断"}`;
    case "review_source_search_started": return "搜索审查规范";
    case "review_source_search_result": return `找到规范候选${Array.isArray(data.candidates) ? `（${data.candidates.length}）` : ""}`;
    case "review_source_read_started": return `读取规范${data.sourceId ? ` ${data.sourceId}` : ""}`;
    case "review_source_read": return data.status === "failed" ? "规范读取失败" : `已读取规范 ${data.sourceId || ""}`;
    case "review_source_applied": return `采用规范 ${data.sourceId || ""}`;
    case "review_source_unused": return `规范未采用 ${data.sourceId || ""}`;
    case "review_waiting_confirmation": return "等待确认后写回原文";
    case "review_confirmed": return "已确认写回原文";
    case "review_confirmation_rejected": return "已拒绝写回原文";
    case "review_write_blocked": return "原文写回已保护";
    case "thinking_level": return `思考深度：${data.effective || data.requested || "默认"}`;
    case "agent_queued": return `任务已排队${data.position ? `（第 ${data.position} 项）` : ""}`;
    case "agent_queue_update": return data.steering ? "正在调整任务" : "等待后续任务";
    default: return event?.type || "事件";
  }
}

/** 完成状态 → 中文（避免与 运行轨迹.js 形成循环依赖，这里做一次轻量查表） */
function completionLabelSafe(status) {
  return { success: "已完成", partial: "部分完成", blocked: "受阻", failed: "失败", cancelled: "已取消" }[String(status || "")] || "已结束";
}

/** 事件 → 语气（error / success / running），用于执行流配色 */
export function flowEventTone(event) {
  const type = String(event?.type || "");
  if (["agent_error", "agent_model_fallback_failed", "write_rejected", "officecli_failed", "review_write_blocked", "review_confirmation_rejected", "stream_resync"].includes(type) || event?.data?.isError) return "error";
  if (type === "artifacts_validated") return event?.data?.status === "failed" ? "error" : "success";
  if (type === "run_finished") return runConclusion(event).tone;
  if (type === "task_completed") return event?.data?.status === "failed" ? "error" : event?.data?.status === "success" ? "success" : "warning";
  if (["agent_end", "assistant_final", "tool_end", "agent_retry_end", "context_compacted", "review_source_read", "review_source_applied", "review_confirmed"].includes(type)) return "success";
  return "running";
}

/**
 * 运行终态（Run 生命周期层）→ { status, label, tone }。
 * 唯一权威来源是 run_finished 的 status 与 completion；失败/取消/部分完成不得显示成功色。
 * 供执行流文案与配色共用，避免各写一份。
 */
export function runConclusion(event) {
  const data = event?.data || {};
  const runStatus = String(data.status || "completed");
  const completion = data.completion && typeof data.completion === "object" ? data.completion : null;
  if (runStatus === "cancelled" || runStatus === "aborted") return { status: "cancelled", label: "已取消", tone: "warning" };
  if (runStatus === "failed") return { status: "failed", label: "运行失败", tone: "error" };
  const resolved = String(completion?.status || "success");
  if (resolved === "failed") return { status: "failed", label: "运行失败", tone: "error" };
  if (resolved === "partial" || resolved === "blocked") {
    return { status: resolved, label: resolved === "partial" ? "部分完成" : "受阻", tone: "warning" };
  }
  if (resolved === "cancelled") return { status: "cancelled", label: "已取消", tone: "warning" };
  // success：Run 生命周期文案是“运行结束”，不与“任务达成”混为一谈
  return { status: "success", label: "运行结束", tone: "success" };
}

/**
 * 工具语义图标（P3）：工具能力类别 → 图标名。未知工具一律回退通用图标，
 * 由 tool.name / 事件类型决定，不根据输入的自然语言猜类别。
 * 语义图标与状态图标（运行中/成功/失败）并列，颜色之外保留文字与可访问名。
 */
const TOOL_IDENTITY_RULES = [
  [/^(browser_|browserOpen|browserClick|browserType|browserScroll|browserScreenshot|browserTabs)/i, "globe"],
  [/^(web_search|web_fetch|webSearch|webFetch)$/i, "search"],
  [/^(grep|find|ls|glob)$/i, "search"],
  [/^(kb_search|kb_read|memory_update|skills_search|skills_read)$/i, "book"],
  [/^(read|context_read)$/i, "file"],
  [/^(map_read|map_edit|map_import|map_analyze|map_save_analysis|map_clear_analysis)$/i, "map"],
  [/^(write|edit|review_source_apply)$/i, "edit"],
  [/^officecli$/i, "doc"],
  [/^(bash|terminal|shell)$/i, "terminal"],
  [/^(todo|taskcreate|taskupdate)$/i, "list"],
  [/^(tool_approval|approval|review_copy)/i, "shield"],
  [/^(ask_user)$/i, "comment"],
  [/^(complete_task)$/i, "check"],
];

/** 工具名 → { icon, category }；category 仅用于说明与测试，渲染用 icon。 */
export function toolIdentity(name) {
  const value = String(name || "").trim();
  if (!value) return { icon: "tool", category: "generic" };
  if (value === "__thinking__") return { icon: "brain", category: "thinking" };
  for (const [pattern, icon] of TOOL_IDENTITY_RULES) {
    if (pattern.test(value)) return { icon, category: icon };
  }
  return { icon: "tool", category: "generic" };
}
