/**
 * 事件注册表：事件流的唯一事实来源。
 *
 * 背景：此前"是否算生命周期事件"（server/事件协议.mjs，决定通道历史里能否被增量挤出）
 * 与"是否落盘"（server/事件存储.mjs，决定能否跨会话回放）是两张手写清单，实测出现
 * 19 种事件"声明了但没落盘"、9 种事件"落盘但不受保护"的错位，重连回放无法重建回合
 * 边界、审批、模型回退等语义。
 *
 * 现在两处都从这张表派生：
 *   lifecycle: true  → 写入通道历史时不允许被 token/tool_output 等增量挤出；
 *   persist:   true  → 写入 .oaw/events/事件流.jsonl，可在恢复会话时回放。
 *
 * 约定（由 scripts/事件注册表测试.mjs 强制）：
 *   1. persist 的事件必须同时 lifecycle（能落盘的就值得保护）；
 *   2. 代码里 emit/recordRunEvent/appendEvent/writeEvent 用到的事件类型必须登记，
 *      否则测试失败——新增事件不会再"只在一处处理"。
 */

/** @type {Array<{type:string, lifecycle:boolean, persist:boolean, note:string}>} */
const REGISTRY = [
  // ---- 运行生命周期 ----
  { type: "run_admitting", lifecycle: true, persist: true, note: "Run 建档中" },
  { type: "run_admitted", lifecycle: true, persist: true, note: "Run 建档完成（前端锚点）" },
  { type: "run_started", lifecycle: true, persist: true, note: "Run 开始" },
  { type: "prompt", lifecycle: true, persist: true, note: "用户输入进模型" },
  { type: "capability_plan", lifecycle: true, persist: true, note: "本轮能力计划" },
  { type: "mode_policy", lifecycle: true, persist: true, note: "模式工具策略快照" },
  { type: "thinking_level", lifecycle: true, persist: true, note: "思考深度设置" },
  { type: "run_checkpoint_updated", lifecycle: true, persist: true, note: "恢复检查点更新" },
  { type: "run_cancel_requested", lifecycle: true, persist: true, note: "收到取消请求" },
  { type: "run_recovered", lifecycle: true, persist: true, note: "服务重启后标记恢复" },
  { type: "run_recovery_started", lifecycle: true, persist: true, note: "用户选择继续该 Run" },
  { type: "run_finished", lifecycle: true, persist: true, note: "Run 终态（权威完成语义）" },
  { type: "aborted", lifecycle: true, persist: true, note: "回合被中断" },

  // ---- 回合 / 消息边界 ----
  { type: "agent_started", lifecycle: true, persist: true, note: "Agent 回合开始" },
  { type: "agent_turn_end", lifecycle: true, persist: true, note: "Agent 回合收尾统计" },
  { type: "turn_started", lifecycle: true, persist: true, note: "模型回合开始" },
  { type: "turn_ended", lifecycle: true, persist: true, note: "模型回合结束" },
  { type: "message_start", lifecycle: true, persist: true, note: "助手消息开始" },
  { type: "message_end", lifecycle: true, persist: true, note: "助手消息结束" },

  // ---- 工具与写入 ----
  { type: "tool_start", lifecycle: true, persist: true, note: "工具调用开始" },
  { type: "tool_end", lifecycle: true, persist: true, note: "工具调用结束" },
  { type: "tool_call_progress", lifecycle: true, persist: false, note: "工具分段进度（高频）" },
  { type: "tool_repeat_warning", lifecycle: true, persist: true, note: "同参数重复调用提醒" },
  { type: "completion_nudge", lifecycle: true, persist: true, note: "收尾强制完成声明提醒" },
  { type: "write_started", lifecycle: true, persist: true, note: "写入开始（含锁）" },
  { type: "write_locked", lifecycle: true, persist: false, note: "写入已加锁（与 write_started 恒成对，不落盘省冗余）" },
  { type: "write_rejected", lifecycle: true, persist: true, note: "写入被拒（含失败码）" },
  { type: "write_cleaned", lifecycle: true, persist: true, note: "临时产物清理" },
  { type: "artifact_staged", lifecycle: true, persist: true, note: "产物暂存" },
  { type: "artifact_materialized", lifecycle: true, persist: true, note: "产物落盘发布" },
  { type: "artifact_published", lifecycle: true, persist: true, note: "产物固定/发布" },
  { type: "artifact_rolled_back", lifecycle: true, persist: true, note: "产物回滚" },
  { type: "file_changed", lifecycle: true, persist: true, note: "工作区文件变更" },

  // ---- 审批 / 提问 ----
  { type: "ask_user", lifecycle: true, persist: true, note: "向用户提问" },
  { type: "tool_approval_request", lifecycle: true, persist: true, note: "工具审批请求" },
  { type: "tool_approval_resolved", lifecycle: true, persist: true, note: "工具审批结果" },

  // ---- 通道与重试 ----
  { type: "model_request_started", lifecycle: true, persist: true, note: "向模型发起请求（回合锚点）" },
  { type: "agent_retry", lifecycle: true, persist: true, note: "模型重试" },
  { type: "agent_retry_end", lifecycle: true, persist: true, note: "模型重试结束" },
  { type: "agent_model_fallback", lifecycle: true, persist: true, note: "通道切换到备用模型" },
  { type: "agent_model_fallback_failed", lifecycle: true, persist: true, note: "通道切换失败" },
  { type: "agent_queued", lifecycle: true, persist: true, note: "任务排队" },
  { type: "agent_queue_update", lifecycle: true, persist: true, note: "队列状态更新" },
  { type: "steer", lifecycle: true, persist: true, note: "运行中插话/系统提醒" },

  // ---- 上下文与错误 ----
  { type: "context_compacting", lifecycle: true, persist: true, note: "开始压缩上下文" },
  { type: "context_compacted", lifecycle: true, persist: true, note: "压缩完成" },
  { type: "context_compact_warning", lifecycle: true, persist: true, note: "压缩告警" },
  { type: "agent_error", lifecycle: true, persist: true, note: "模型/Agent 错误" },
  { type: "runtime_error", lifecycle: true, persist: true, note: "运行环境错误" },
  { type: "runtime_health", lifecycle: true, persist: true, note: "运行健康快照" },
  { type: "officecli_failed", lifecycle: true, persist: true, note: "Office CLI 失败" },
  { type: "review_write_blocked", lifecycle: true, persist: true, note: "Review 原文写回被保护拦截" },

  // ---- 完成语义与总结 ----
  { type: "task_completed", lifecycle: true, persist: true, note: "显式完成声明" },
  { type: "agent_summary", lifecycle: true, persist: true, note: "本轮总结" },
  { type: "assistant_final", lifecycle: true, persist: true, note: "最终回答文本" },
  { type: "agent_end", lifecycle: true, persist: true, note: "Agent 收尾" },
  { type: "todo_updated", lifecycle: true, persist: true, note: "待办更新" },
  { type: "step_updated", lifecycle: true, persist: true, note: "步骤状态更新" },
  { type: "stats", lifecycle: true, persist: false, note: "用量统计（每回合一次，不落盘）" },

  // ---- Review 证据链 ----
  { type: "map_action", lifecycle: true, persist: false, note: "地图分析/样式动作（前端实时更新，不落盘）" },
  { type: "review_material_classified", lifecycle: true, persist: true, note: "审查材料识别" },
  { type: "review_source_search_started", lifecycle: true, persist: true, note: "规范检索开始" },
  { type: "review_source_search_result", lifecycle: true, persist: true, note: "规范候选返回" },
  { type: "review_source_read_started", lifecycle: true, persist: true, note: "规范读取开始" },
  { type: "review_source_read", lifecycle: true, persist: true, note: "规范全文读取成功" },
  { type: "review_source_applied", lifecycle: true, persist: true, note: "规范被采用" },
  { type: "review_source_unused", lifecycle: true, persist: true, note: "规范读过未采用" },
  { type: "review_waiting_confirmation", lifecycle: true, persist: true, note: "等待写回确认" },
  { type: "review_confirmed", lifecycle: true, persist: true, note: "用户确认写回" },
  { type: "review_confirmation_rejected", lifecycle: true, persist: true, note: "用户拒绝写回" },

  // ---- 记忆治理 ----
  { type: "memory_proposal", lifecycle: true, persist: true, note: "记忆建议提交（UI 事件）" },
  { type: "memory_proposal_updated", lifecycle: true, persist: true, note: "记忆建议内容更新" },
  { type: "memory_proposal_resolved", lifecycle: true, persist: true, note: "记忆建议审核完成" },
  { type: "memory_proposal_created", lifecycle: true, persist: true, note: "记忆建议创建" },
  { type: "memory_proposal_edited", lifecycle: true, persist: true, note: "记忆建议编辑" },
  { type: "memory_proposal_approved", lifecycle: true, persist: true, note: "记忆建议通过" },
  { type: "memory_proposal_rejected", lifecycle: true, persist: true, note: "记忆建议拒绝" },
  { type: "memory_proposal_merged", lifecycle: true, persist: true, note: "记忆建议合并" },
  { type: "memory_proposal_failed", lifecycle: true, persist: true, note: "记忆建议失败" },
  { type: "memory_written", lifecycle: true, persist: true, note: "记忆写入" },
  { type: "memory_file_edited", lifecycle: true, persist: true, note: "记忆文件编辑" },
  { type: "memory_initialized", lifecycle: true, persist: true, note: "记忆初始化" },

  // ---- 高频增量（只走实时 SSE，可优先淘汰）----
  { type: "token", lifecycle: false, persist: false, note: "回答流式文本" },
  { type: "thinking", lifecycle: false, persist: false, note: "思考流" },
  { type: "tool_output", lifecycle: false, persist: false, note: "工具输出流" },
  { type: "text_boundary", lifecycle: false, persist: false, note: "文本段落边界（打字机）" },
  { type: "thinking_boundary", lifecycle: false, persist: false, note: "思考段落边界" },
];

const byType = new Map();
for (const item of REGISTRY) {
  if (byType.has(item.type)) throw new Error(`事件注册表存在重复类型：${item.type}`);
  if (item.persist && !item.lifecycle) throw new Error(`事件 ${item.type} 标记了 persist 但未标记 lifecycle（约定：能落盘的就值得保护）`);
  byType.set(item.type, Object.freeze({ ...item }));
}

/** 全部已登记事件类型 */
export const EVENT_REGISTRY = Object.freeze([...byType.values()]);
export const EVENT_TYPES = Object.freeze([...byType.keys()]);
/** 生命周期事件：通道历史中不被增量挤出 */
export const LIFECYCLE_EVENT_TYPES = new Set(EVENT_REGISTRY.filter((item) => item.lifecycle).map((item) => item.type));
/** 高频增量：不落盘、可优先淘汰 */
export const DELTA_EVENT_TYPES = new Set(EVENT_REGISTRY.filter((item) => !item.lifecycle && !item.persist).map((item) => item.type));
/** 需要写入 .oaw/events 事件流的事件 */
export const PERSISTED_TYPES = new Set(EVENT_REGISTRY.filter((item) => item.persist).map((item) => item.type));

export function eventSpec(type) {
  return byType.get(String(type || "")) || null;
}

export function isRegisteredEvent(type) {
  return byType.has(String(type || ""));
}

export function registrySummary() {
  return {
    total: EVENT_REGISTRY.length,
    lifecycle: LIFECYCLE_EVENT_TYPES.size,
    persisted: PERSISTED_TYPES.size,
    delta: DELTA_EVENT_TYPES.size,
  };
}
