import React, { useEffect, useRef, useState, useCallback, useMemo, forwardRef, useImperativeHandle } from "react";
import { fileToBase64, listModels, setAgentModel, compactAgentContext, getApprovalMode, setApprovalMode as saveApprovalMode, deleteSession, deleteSessions, renameSession, forkSession, approveMemoryProposal, rejectMemoryProposal, rollbackRun, getRun, listRuns } from "../api.js";
import MarkdownBody from "./MarkdownBody.jsx";
import Icon, { ProviderIcon } from "./Icon.jsx";
import Logo from "./Logo.jsx";
import ChatTimeline from "./ChatTimeline.jsx";
import AgentBrainGraph from "./AgentBrainGraph.jsx";
import { 提取消息展示文本, 计算展示字符数 } from "./流式文本队列.js";
import { completionLabel, reduceRunTrace, runTraceSummaryText, summarizeRunTrace } from "../运行轨迹.js";
import { SessionList } from "./SessionSidebar.jsx";
import { loadSettings } from "./SettingsPanel.jsx";

// 错误边界包装器
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ChatPanel error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="chat-error-boundary">
          <div className="error-content">
            <div className="error-icon"><Icon name="warning" size={32} /></div>
            <div className="error-text">组件出错，请刷新页面</div>
            <button className="btn" onClick={() => window.location.reload()}>
              刷新页面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

let msgSeq = 0;
const newId = () => `m${++msgSeq}`;
const MODEL_KEY = "oaw_model";
const MODE_KEY = "oaw_chat_mode";
const THINKING_KEY = "oaw_thinking_level";
const APPROVAL_MODE_KEY = "oaw_approval_mode";
const EXECUTION_FLOW_HIDDEN_KEY = "oaw_execution_flow_hidden";
const DEFAULT_CONTEXT_WINDOW = 128000;
const PI_COMPACTION_RESERVE_TOKENS = 16384;
const LIVE_RUN_STATUSES = new Set(["running", "queued", "waiting_user", "recovering", "cancel_requested", "finishing"]);
const MAX_VISIBLE_MESSAGES = 120;
const MESSAGE_PAGE_SIZE = 80;
const COMPOSER_COMMANDS = [
  { insert: "/compact", label: "压缩上下文", hint: "保留摘要并缩短当前 Pi 会话" },
  { insert: "/new", label: "新建会话", hint: "在当前项目下创建独立会话" },
  { insert: "/chat", label: "切换到 Chat", hint: "只读检索知识库、Skills 和工作区资料" },
  { insert: "/agent", label: "切换到 Agent", hint: "执行任务、调用工具并生成产物" },
  { insert: "/review", label: "切换到 Review", hint: "按规范审查材料，先生成报告和副本" },
  { insert: "/help", label: "查看输入帮助", hint: "显示 /、@、& 的使用方式" },
];
const THINKING_OPTIONS = [
  { id: "low", label: "低", shortLabel: "快速", desc: "响应更快，适合简单任务" },
  { id: "medium", label: "标准", shortLabel: "标准", desc: "速度与质量平衡" },
  { id: "high", label: "高", shortLabel: "深度", desc: "适合复杂分析" },
  { id: "max", label: "最大", shortLabel: "最大", desc: "使用模型允许的最高档位" },
];
const MODEL_PROVIDER_META = {
  anthropic: { label: "Anthropic", icon: "anthropic" },
  deepseek: { label: "DeepSeek", icon: "deepseek" },
  gemini: { label: "Google", icon: "gemini" },
  google: { label: "Google", icon: "gemini" },
  minimax: { label: "MiniMax", icon: "minimax" },
  "minimax-cn": { label: "MiniMax", icon: "minimax" },
  openai: { label: "OpenAI", icon: "openai" },
  "openai-codex": { label: "OpenAI", icon: "openai" },
  qwen: { label: "Qwen", icon: "qwen" },
  alibaba: { label: "Qwen", icon: "qwen" },
  "opencode-go": { label: "OpenCode Go", icon: "opencode" },
  "xiaomi-token-plan-cn": { label: "MiMo", icon: "xiaomi" },
};

function modelProvider(model) {
  return String(model?.provider || model?.id || "custom").split("/")[0].toLowerCase() || "custom";
}

function modelProviderMeta(model) {
  const provider = modelProvider(model);
  return MODEL_PROVIDER_META[provider] || { label: provider === "custom" ? "自定义供应商" : provider, icon: "custom" };
}

function modelDisplayName(model) {
  if (!model) return "按 Pi 配置";
  return model.name || String(model.id || "").split("/").slice(1).join("/") || model.id;
}

function eventMessageText(value, fallback = "") {
  if (typeof value === "string") return value.trim() || fallback;
  if (value && typeof value === "object") {
    for (const key of ["message", "error", "detail", "text"]) {
      const nested = eventMessageText(value[key], "");
      if (nested) return nested;
    }
    try { return JSON.stringify(value); } catch { return fallback; }
  }
  return value == null ? fallback : String(value);
}

function ModelProviderMark({ model, size = 18 }) {
  const provider = modelProvider(model);
  const meta = modelProviderMeta(model);
  return <span className={`model-provider-mark provider-${provider}`} style={{ width: size, height: size }} aria-hidden="true"><ProviderIcon provider={meta.icon} size={Math.max(11, size - 4)} /></span>;
}

const MODE_META = {
  chat: {
    label: "Chat",
    shortLabel: "Chat",
    icon: "search",
    title: "Chat：只读检索知识库、Skills 和工作区资料，不修改文件",
    hint: "只读检索",
    prefix: "[模式: Chat] 只进行知识库、Skills 和工作区资料检索；不要修改文件、执行脚本或生成产物。若用户要求修改，请转为 Agent 任务。\n",
  },
  agent: {
    label: "Work",
    shortLabel: "Work",
    icon: "tool",
    title: "Work：调用工具执行分析、编辑并生成工作产物，实际权限由运行环境决定",
    hint: "执行与产出",
    prefix: "[模式: Work] 可以调用完整 skills 和工具执行分析、修改并生成新文件（文档/HTML/PPT 等），Office CLI 会按任务需要自动选择；实际写入和联网能力以运行环境预检结果为准。\n",
  },
  review: {
    label: "Review",
    shortLabel: "Review",
    icon: "shield",
    title: "Review：依据实际读取的规范生成审查报告与批注副本，确认后才写回原文",
    hint: "审查与副本",
    prefix: "[模式: Review] 先识别材料并读取规范库中的实际依据，生成审查报告和批注副本；用户明确确认前不得修改原文件。\n",
  },
};

// 中心对话区只保留能解释“任务进行到哪一步”的 SSE 事件；高频 token/thinking
// 仍由消息流渲染，避免把每个 token 都变成一条 UI 记录。运行期间展开，完成后
// 自动收成一行，用户仍可点击核对模型请求、工具调用、写入和收尾是否完整。
const FLOW_EVENT_TYPES = new Set([
"runtime_connecting", "runtime_init_failed", "tool_approval_request", "tool_approval_resolved",
  "run_admitting", "run_admitted", "model_request_started", "agent_started",
  "turn_started", "turn_ended", "tool_start", "tool_end", "ask_user", "agent_retry",
  "agent_retry_end", "agent_model_fallback", "agent_model_fallback_failed",
  "context_compacting", "context_compacted", "context_compact_warning",
  "agent_turn_end", "agent_error", "file_changed", "agent_summary",
  "assistant_final", "agent_end", "run_finished", "aborted", "write_rejected",
  "write_started", "write_locked", "artifact_staged", "artifact_materialized", "write_cleaned",
  "capability_plan", "mode_policy", "thinking_level", "agent_queued", "agent_queue_update", "steer", "todo_updated", "officecli_failed", "task_completed",
  "review_material_classified", "review_source_search_started", "review_source_search_result", "review_source_read_started", "review_source_read", "review_source_applied", "review_source_unused", "review_waiting_confirmation", "review_confirmed", "review_confirmation_rejected", "review_write_blocked",
]);

// 恢复 Pi JSONL 时可能同时存在空 assistant 占位、SSE 重试留下的重复消息，
// 以及同一条最终回复被 assistant_final/run_finished 各写入一次。历史层只做
// 相邻同内容去重，保留原始顺序和真正被工具/用户消息隔开的重复提问。
function historyMessageFingerprint(message) {
  const blocks = Array.isArray(message?.blocks) ? message.blocks : [];
  const compact = (value) => String(value || "").replace(/\s+/g, " ").trim();
  return JSON.stringify({
    role: message?.role || "",
    text: compact(message?.text),
    images: (message?.images || []).map((item) => typeof item === "string" ? item.slice(0, 80) : item?.name || "image"),
    blocks: blocks.map((block) => ({
      type: block?.type || "",
      text: compact(block?.text),
      name: block?.name || "",
      input: compact(block?.input),
      output: compact(block?.output || block?.result),
      question: compact(block?.question),
      answer: compact(block?.answer),
    })),
    runId: message?.role === "system" ? message?.runId || "" : "",
    summary: Boolean(message?.summary),
  });
}

function historyMessageScore(message) {
  const blocks = Array.isArray(message?.blocks) ? message.blocks : [];
  return String(message?.text || "").length
    + (message?.images?.length || 0) * 100
    + blocks.reduce((sum, block) => sum + String(block?.text || block?.output || block?.result || "").length + 40, 0);
}

export function normalizeHistoryMessages(items) {
  if (!Array.isArray(items)) return [];
  const result = [];
  const assistantFingerprints = new Set();
  for (const message of items) {
    if (!message || !message.role) continue;
    const blocks = Array.isArray(message.blocks) ? message.blocks : [];
    const meaningful = Boolean(
      String(message.text || "").trim()
      || (message.images || []).length
      || blocks.length
      || message.memoryProposal
      || message.summary,
    );
    // Pi 的 assistant 空消息只是占位符，恢复时不应占据一条对话记录。
    if (message.role === "assistant" && !meaningful && !message.errorText) continue;
    const previous = result[result.length - 1];
    const fingerprint = historyMessageFingerprint(message);
    // 一次用户提问可能因恢复/重试生成两条相同 assistant 结论，系统提示夹在
    // 中间时不再是“相邻”重复；直到下一条用户消息前，仅合并相同 assistant 结果。
    if (message.role === "assistant" && assistantFingerprints.has(fingerprint)) continue;
    // 运行总结在实时 SSE 和历史 Run 列表中各有一份；同一 run 只保留一个，
    // 避免恢复会话后“本轮结论”挤在一起或重复出现。
    if (message.role === "system" && message.summary && message.runId) {
      const existingIndex = result.findIndex((item) => item.role === "system" && item.summary && item.runId === message.runId);
      if (existingIndex >= 0) {
        if (historyMessageScore(message) > historyMessageScore(result[existingIndex])) result[existingIndex] = message;
        continue;
      }
    }
    if (previous && historyMessageFingerprint(previous) === fingerprint) {
      if (historyMessageScore(message) > historyMessageScore(previous)) result[result.length - 1] = message;
      continue;
    }
    result.push(message);
    if (message.role === "user") assistantFingerprints.clear();
    if (message.role === "assistant") assistantFingerprints.add(fingerprint);
  }
  return result;
}

function flowEventLabel(event) {
  const data = event?.data || {};
  const tool = data.name || data.toolName || "工具";
  const toolLabels = {
    read: "读取文件", write: "写入文件", edit: "编辑文件", bash: "执行命令",
    officecli: "执行 Office CLI", find: "查找文件", grep: "搜索内容", ls: "列出文件",
    ask_user: "等待用户回答",
  };
  const toolLabel = toolLabels[String(tool).toLowerCase()] || tool;
  switch (event?.type) {
    case "runtime_connecting": return "正在准备会话运行时";
    case "run_admitting": return "准备任务";
    case "stream_waiting": return "正在接收事件流";
    case "run_admitted": return "任务已受理";
    case "model_request_started": return "请求模型";
    case "agent_started": return "模型已开始处理";
    case "turn_started": return "开始生成回合";
    case "turn_ended": return "生成段结束";
    case "write_started": return "准备写入";
    case "write_locked": return "写入已锁定";
    case "artifact_staged": return "产物已暂存";
    case "artifact_materialized": return "产物已发布";
    case "write_cleaned": return "清理暂存产物";
    case "steer": return "插入新指令";
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
    case "run_finished": return data.status === "completed" ? "任务完成" : `任务${data.status || "结束"}`;
    case "task_completed": return `任务${completionLabel(data.status)}${data.summary ? `：${String(data.summary).slice(0, 50)}` : ""}`;
    case "aborted": return "任务已中断";
    case "capability_plan": return "能力准备完成";
    case "mode_policy": return `模式：${MODE_META[normalizeUiMode(data.mode)]?.label || "Chat"}`;
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

function flowEventTone(event) {
  if (["agent_error", "agent_model_fallback_failed", "write_rejected", "officecli_failed", "review_write_blocked", "review_confirmation_rejected"].includes(event?.type) || event?.data?.isError) return "error";
  if (event?.type === "task_completed") return event?.data?.status === "failed" ? "error" : event?.data?.status === "success" ? "success" : "running";
  if (["run_finished", "agent_end", "assistant_final", "tool_end", "agent_retry_end", "context_compacted", "review_source_read", "review_source_applied", "review_confirmed"].includes(event?.type)) return "success";
  return "running";
}

function appendExecutionFlowEvent(previous, event) {
  if (previous.some((item) => item.key === event.key)) return previous;
  const sameRun = (item) => event.data?.runId ? item.data?.runId === event.data.runId : !item.data?.runId;
  const mergeIndex = [...previous].reverse().findIndex((item) => sameRun(item) && item.type === event.type && ["file_changed", "agent_summary", "agent_queue_update"].includes(event.type));
  if (mergeIndex >= 0) {
    const index = previous.length - 1 - mergeIndex;
    const current = previous[index];
    if (event.type === "file_changed") {
      const files = [...new Set([...(current.data?.files || []), ...(event.data?.files || [])])];
      return previous.map((item, itemIndex) => itemIndex === index ? { ...event, key: current.key, data: { ...current.data, ...event.data, files } } : item);
    }
    return previous.map((item, itemIndex) => itemIndex === index ? { ...current, ...event, key: current.key } : item);
  }
  return [...previous, event].slice(-300);
}

function usageDetails(usage) {
  const input = Number(usage?.inputTokens ?? usage?.input ?? 0) || 0;
  const output = Number(usage?.outputTokens ?? usage?.output ?? 0) || 0;
  const cacheRead = Number(usage?.cacheReadTokens ?? usage?.cacheRead ?? usage?.cache_read ?? 0) || 0;
  const cacheWrite = Number(usage?.cacheWriteTokens ?? usage?.cacheWrite ?? usage?.cache_write ?? 0) || 0;
  const context = Number(usage?.contextTokens ?? usage?.context ?? 0) || input + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, context };
}

function formatTokenCount(value) {
  const count = Number(value) || 0;
  return count >= 1000 ? `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k` : String(count);
}

// Office 是历史任务/会话的兼容值；用户入口使用 Chat / Work / Review。
function normalizeUiMode(mode) {
  return mode === "review" ? "review" : mode === "office" || mode === "agent" ? "agent" : "chat";
}

function referenceMarker(reference) {
  if (!reference?.target) return "";
  if (reference.kind === "session") return reference.source || "&会话[" + reference.target + "]";
  const kind = reference.kind === "knowledge_dir" ? "知识库目录" : reference.kind === "knowledge" ? "知识库" : reference.kind === "template_dir" ? "模板目录" : reference.kind === "template" ? "模板" : reference.kind === "session" ? "会话" : "文件";
  return reference.source || `@${kind}[${reference.target}]`;
}

function loadEmbeddedMessages(threadId, embedded) {
  if (!embedded || !threadId) return [];
  try {
    const cached = JSON.parse(localStorage.getItem(`oaw_embedded_messages_${threadId}`) || "[]");
    return normalizeHistoryMessages(cached);
  } catch {
    return [];
  }
}

function formatMsgTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const p = (n) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return sameYear ? `${p(d.getMonth() + 1)}/${p(d.getDate())} ${hm}` : `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${hm}`;
}

// blocks 辅助：追加/合并文本块、思考块
function appendTextBlock(blocks, text) {
  const arr = [...blocks];
  const last = arr[arr.length - 1];
  if (last && last.type === "text") {
    last.text = (last.text || "") + text;
    return arr;
  }
  arr.push({ type: "text", text });
  return arr;
}
function appendThinkingBlock(blocks, text) {
  const arr = [...blocks];
  const last = arr[arr.length - 1];
  if (last && last.type === "thinking") {
    last.text = (last.text || "") + text;
    return arr;
  }
  arr.push({ type: "thinking", text, startTime: Date.now() });
  return arr;
}

function referenceId(kind, target) {
  let hash = 0;
  for (const ch of `${kind}:${target}`) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return `ref_${Math.abs(hash).toString(36)}`;
}

function parseReferenceMarkers(text = "") {
  const refs = [];
  const seen = new Set();
  const add = (kind, target, source) => {
    const value = String(target || "").trim();
    if (!value) return;
    const id = referenceId(kind, value);
    if (seen.has(id)) return;
    seen.add(id);
    refs.push({ id, kind, target: value, source });
  };
  for (const m of String(text).matchAll(/@知识库目录\[([^\]]+)\]/g)) add("knowledge_dir", m[1], m[0]);
  for (const m of String(text).matchAll(/@知识库\[([^\]]+)\]/g)) add("knowledge", m[1], m[0]);
  for (const m of String(text).matchAll(/@模板目录\[([^\]]+)\]/g)) add("template_dir", m[1], m[0]);
  for (const m of String(text).matchAll(/@模板\[([^\]]+)\]/g)) add("template", m[1], m[0]);
  for (const m of String(text).matchAll(/@文件\[([^\]]+)\]/g)) add("file", m[1], m[0]);
  for (const m of String(text).matchAll(/&会话\[([^\]]+)\]/g)) add("session", m[1], m[0]);
  for (const m of String(text).matchAll(/(^|[\s(])@([^\s@，。！？\]}]+)/g)) {
    const target = m[2].replace(/[),;。！？]+$/, "");
    if (/^(?:文件|知识库|模板|模板目录)\[/.test(target)) continue;
    if (target.includes("/") || target.includes("\\") || /\.(docx|xlsx|pptx|pdf|csv|json|md|markdown|txt|html|htm)$/i.test(target)) add("file", target, `@${target}`);
  }
  return refs;
}

export default forwardRef(function ChatPanel({ clientId, threadId, workspace = "", project = null, mapProject = null, frozen = false, onFileChanged, onMapAction, currentDoc, mapContext, models: modelsProp, defaultModel, selectedModel = "", onModelChange, onAgentEnd, onRunFinished, historyMessages, historyThreadId = null, historyWindow = null, onNewSession, onOpenFile, referenceFiles = [], sessions = [], unreadByThread = {}, onSelectSession, onSessionChange, onRefreshSessions = () => {}, onDeleteSession, onBatchDeleteSession, onForkSession, onPinSession, onFreezeSession, embedded = false, forcedMode = null, initialReferences = [], contextText = "", panelTitle = "Open Plan", onPromoteToAgent, onModeChange, onPhaseChange }, ref) {
  const [messages, setMessages] = useState(() => loadEmbeddedMessages(threadId, embedded));
  const [messageWindowSize, setMessageWindowSize] = useState(MAX_VISIBLE_MESSAGES);
  const [input, setInput] = useState("");
  const [references, setReferences] = useState([]);
  const [histOpen, setHistOpen] = useState(false); // 会话历史抽屉（默认隐藏，点击展开）
  const [images, setImages] = useState([]);
  const [attachments, setAttachments] = useState([]); // 非图片附件
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [connected, setConnected] = useState(false);
  const [models, setModels] = useState(modelsProp || []);
  const [model, setModel] = useState("");
  const [modelVision, setModelVision] = useState(false);
  const [modelMsg, setModelMsg] = useState("");
  const [modelCounts, setModelCounts] = useState({ available: 0, configured: 0 });
  const [compacting, setCompacting] = useState(false);
  const [approvalMode, setApprovalModeState] = useState(() => localStorage.getItem(APPROVAL_MODE_KEY) === "auto" ? "auto" : "ask");
  const [approvalModeSaving, setApprovalModeSaving] = useState(false);
  const [editMode, setEditMode] = useState(() => {
    const saved = localStorage.getItem(MODE_KEY);
    return forcedMode ? normalizeUiMode(forcedMode) : normalizeUiMode(saved);
  }); // Chat 只读检索 / Agent 完整执行与产出
  const [lastPrompt, setLastPrompt] = useState(null);
  const [effort, setEffort] = useState(() => {
    const saved = localStorage.getItem(THINKING_KEY);
    return THINKING_OPTIONS.some((item) => item.id === saved) ? saved : "low";
  }); // Pi 标准推理档位：low/medium/high/max
  const [modelOpen, setModelOpen] = useState(false); // 模型选择浮层
  const [modelQ, setModelQ] = useState(""); // 模型搜索
  const [agentPhase, setAgentPhaseState] = useState("");
  const agentPhaseRef = useRef("");
  const setAgentPhase = useCallback((next) => {
    const value = typeof next === "function" ? next(agentPhaseRef.current) : next;
    if (Object.is(agentPhaseRef.current, value)) return;
    agentPhaseRef.current = value;
    setAgentPhaseState(value);
  }, []);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [runState, setRunState] = useState({ status: "idle", runId: null, artifacts: [], references: [], task: null, mode: "chat" });
  const [todoItems, setTodoItems] = useState([]);
  const [executionEvents, setExecutionEvents] = useState([]);
  const executionEventsRef = useRef([]);
  const executionEventQueueRef = useRef([]);
  const executionEventTimerRef = useRef(null);
  const replaceExecutionEvents = useCallback((nextOrUpdater) => {
    if (executionEventTimerRef.current) {
      clearTimeout(executionEventTimerRef.current);
      executionEventTimerRef.current = null;
    }
    executionEventQueueRef.current = [];
    const next = typeof nextOrUpdater === "function" ? nextOrUpdater(executionEventsRef.current) : nextOrUpdater;
    executionEventsRef.current = next || [];
    setExecutionEvents(executionEventsRef.current);
  }, []);
  const enqueueExecutionEvent = useCallback((event) => {
    executionEventQueueRef.current.push(event);
    if (executionEventTimerRef.current) return;
    executionEventTimerRef.current = window.setTimeout(() => {
      executionEventTimerRef.current = null;
      let next = executionEventsRef.current;
      for (const item of executionEventQueueRef.current.splice(0)) next = appendExecutionFlowEvent(next, item);
      replaceExecutionEvents(next);
    }, 80);
  }, [replaceExecutionEvents]);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState([]); // 当前任务完成后顺序执行
  const [injectedContext, setInjectedContext] = useState([]); // 等待下一轮发送的上下文片段
  const [busyInputMode, setBusyInputMode] = useState("queue"); // "queue" | "context"
  const [composerMenu, setComposerMenu] = useState(null);
  const [composerIndex, setComposerIndex] = useState(0);

  useEffect(() => { onModeChange?.(normalizeUiMode(editMode)); }, [editMode, onModeChange]);
  useEffect(() => { onPhaseChange?.(busy ? (agentPhase || "正在处理") : ""); }, [agentPhase, busy, onPhaseChange]);
  const bodyRef = useRef(null);
  const followLatestRef = useRef(true);
  const assistantIdRef = useRef(null);
  // agent_end 可能先于 run_finished 到达；保留本轮最后一个气泡，
  // 让服务端补发的权威全文继续写入原气泡，避免出现两条结论。
  const lastAssistantIdRef = useRef(null);
  const fileInputRef = useRef(null);
  const attInputRef = useRef(null);
  // streaming 累积缓冲（性能优化：避免每 token setState）
  const streamBufRef = useRef(null);
  const rafRef = useRef(null);
  const toolOutputQueueRef = useRef(new Map());
  const toolOutputRafRef = useRef(null);
  const textRevealRef = useRef(null);
  // 保留已经真正展示到消息气泡中的文本。agent_end 清理动画状态后，
  // run_finished 仍可能补发同一份最终全文，不能因此重新追加一遍。
  const displayedTextRef = useRef(new Map());
  const textRevealRafRef = useRef(null);
  const streamingMsgIdRef = useRef(null);
  const stoppingRef = useRef(false);
  const agentErrorRef = useRef(false);
  const queueRef = useRef([]);
  // 组件挂载状态追踪，防止卸载后更新状态
  const mountedRef = useRef(true);
  // SSE 重连可能重放同一事件；按运行/文件/摘要去重，避免对话栏污染。
  const systemEventKeysRef = useRef(new Set());
  // 每个 SSE 事件都有单调递增的 channel id；重连从游标之后回放，避免旧事件污染当前回合。
  const eventCursorRef = useRef(0);
  const eventCursorsRef = useRef(new Map());
  // SSE 通道代际：Runtime/会话重建后服务端序号从 1 重新开始，游标必须按代际隔离
  const streamIdsRef = useRef(new Map());
  const activeRunIdRef = useRef(null);
  const runtimeConnectingEventRef = useRef(null);
  // 发送请求后立即标记运行态，不能等 React 的 busy 状态提交；
  // 否则首批 run_admitted/model_request_started 事件会被误当成历史事件丢弃。
  const runInProgressRef = useRef(false);
  const agentEventAtRef = useRef(0);
  const streamReadyRef = useRef(null);
  const handshakeDoneRef = useRef(false);
  // SSE 连接会在切换会话时重建。旧 EventSource 即使已经 close，浏览器仍可能
  // 把队列中的最后一条消息回调出来；用代际号挡住旧连接，避免旧会话污染新会话。
  const streamGenerationRef = useRef(0);
  const eventHandlerRef = useRef(null);
  const reconciledRunIdsRef = useRef(new Set());
  // ChatPanel 本身持续挂载时，按 thread 保存界面状态，切换子对话不会把原对话的流式内容丢掉。
  const threadCacheRef = useRef(new Map());
  const previousThreadRef = useRef(threadId);

  const currentMode = MODE_META[normalizeUiMode(editMode)] || MODE_META.chat;
  const selectedModelInfo = models.find((item) => item.id === model) || null;
  const selectedProviderMeta = modelProviderMeta(selectedModelInfo);
  const selectedEffort = THINKING_OPTIONS.find((item) => item.id === effort) || THINKING_OPTIONS[0];
  const selectedEffortIndex = Math.max(0, THINKING_OPTIONS.findIndex((item) => item.id === selectedEffort.id));
  const selectedContextWindow = Number(selectedModelInfo?.contextWindow) || DEFAULT_CONTEXT_WINDOW;
  const selectedUsage = usageDetails(runState.usage);
  const selectedContextRatio = Math.min(1, selectedUsage.context / selectedContextWindow);
  // 已知模型由 Pi 按 contextWindow 自动压缩；服务端快照存在时优先显示
  // 运行时实际策略，避免前端继续把旧的 78% 固定线展示成真实阈值。
  const selectedCompactThreshold = Number(runState.usage?.compactThreshold) > 0
    ? Number(runState.usage.compactThreshold)
    : Math.max(0, selectedContextWindow - PI_COMPACTION_RESERVE_TOKENS);
  const selectedCompactionMode = runState.usage?.compactionMode || "pi-native";
  const modelGroups = useMemo(() => {
    const query = modelQ.trim().toLowerCase();
    const groups = new Map();
    for (const item of models) {
      const searchable = `${item.id || ""} ${item.name || ""} ${item.provider || ""}`.toLowerCase();
      if (query && !searchable.includes(query)) continue;
      const provider = modelProvider(item);
      if (!groups.has(provider)) groups.set(provider, []);
      groups.get(provider).push(item);
    }
    return [...groups.entries()];
  }, [models, modelQ]);

  const composerItems = useMemo(() => {
    if (!composerMenu) return [];
    const query = composerMenu.query.toLowerCase();
    if (composerMenu.symbol === "/") {
      return COMPOSER_COMMANDS.filter((item) => !query || (item.insert + " " + item.label + " " + item.hint).toLowerCase().includes(query));
    }
    if (composerMenu.symbol === "@") {
      return [...new Set(referenceFiles.map((file) => String(file || "").trim()).filter(Boolean))]
        .filter((file) => !query || file.toLowerCase().includes(query))
        .slice(0, 12)
        .map((file) => ({ insert: "@" + file, label: file, hint: "引用当前工作区文件" }));
    }
    return sessions
      .filter((session) => !query || String(session.title || "").concat(" ", session.label || "", " ", session.id).toLowerCase().includes(query))
      .slice(0, 12)
      .map((session) => ({ insert: "&会话[" + session.id + "]", label: session.title || session.label || "未命名会话", hint: "引用这段历史会话", session }));
  }, [composerMenu, referenceFiles, sessions]);

  useEffect(() => {
    if (composerItems.length === 0) setComposerIndex(0);
    else setComposerIndex((index) => Math.min(index, composerItems.length - 1));
  }, [composerItems]);

  const composerTrigger = (value) => {
    const match = String(value || "").match(/(?:^|\s)([\/@&])([^\s]*)$/);
    if (!match) return null;
    return { symbol: match[1], query: match[2] || "", start: value.length - match[0].length + (match[0].startsWith(" ") ? 1 : 0) };
  };

  const insertComposerItem = (item) => {
    if (!composerMenu || !item) return;
    setInput((value) => value.slice(0, composerMenu.start) + item.insert + " " + value.slice(value.length));
    setComposerMenu(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  useEffect(() => {
    if (!embedded || lastPrompt || !messages.length) return;
    const lastUser = [...messages].reverse().find((item) => item?.role === "user" && item?.text);
    if (lastUser) setLastPrompt({ text: lastUser.text, references: lastUser.references || [], contextText });
  }, [contextText, embedded, lastPrompt, messages]);

  useEffect(() => {
    if (forcedMode) setEditMode(normalizeUiMode(forcedMode));
  }, [forcedMode]);

  useEffect(() => {
    let cancelled = false;
    getApprovalMode().then((result) => {
      if (cancelled || !["ask", "auto"].includes(result?.mode)) return;
      setApprovalModeState(result.mode);
      localStorage.setItem(APPROVAL_MODE_KEY, result.mode);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const changeApprovalMode = useCallback(async (nextMode) => {
    if (approvalModeSaving || !["ask", "auto"].includes(nextMode)) return;
    const previous = approvalMode;
    setApprovalModeState(nextMode);
    localStorage.setItem(APPROVAL_MODE_KEY, nextMode);
    setApprovalModeSaving(true);
    try {
      await saveApprovalMode(nextMode);
    } catch (error) {
      setApprovalModeState(previous);
      localStorage.setItem(APPROVAL_MODE_KEY, previous);
      const approvalEndpointMissing = /(?:HTTP\s+404|api endpoint not found|cannot\s+(?:patch|post|get)\s+.*approval)/i.test(String(error.message || ""));
      setModelMsg(approvalEndpointMissing
        ? "审批接口不存在：服务端未重启或前后端版本不一致，请重启规聚服务"
        : `审批模式切换失败：${error.message}`);
    } finally {
      setApprovalModeSaving(false);
    }
  }, [approvalMode, approvalModeSaving]);

  useEffect(() => {
    const mode = normalizeUiMode(editMode);
    if (MODE_META[mode] && !forcedMode) localStorage.setItem(MODE_KEY, mode);
  }, [editMode, forcedMode]);

  const initialReferenceKey = initialReferences.map((r) => `${r.id || ""}:${r.kind || ""}:${r.target || ""}`).join("|");
  useEffect(() => {
    setReferences(initialReferences.filter((item) => item?.target));
  }, [initialReferenceKey]);

  useEffect(() => {
    if (!embedded || !threadId) return;
    try {
      localStorage.setItem(`oaw_embedded_messages_${threadId}`, JSON.stringify(messages.slice(-80)));
    } catch {}
  }, [embedded, messages, threadId]);

  useEffect(() => {
    const found = parseReferenceMarkers(input);
    if (!found.length) return;
    setReferences((prev) => {
      const merged = [...found, ...prev.filter((r) => input.includes(r.source || `@${r.target}`))];
      return merged.filter((r, i, arr) => arr.findIndex((x) => x.id === r.id) === i);
    });
  }, [input]);

  // 组件卸载时标记
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // 清理定时器和动画帧
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (textRevealRafRef.current) {
        cancelAnimationFrame(textRevealRafRef.current);
        textRevealRafRef.current = null;
      }
      if (toolOutputRafRef.current) {
        cancelAnimationFrame(toolOutputRafRef.current);
        toolOutputRafRef.current = null;
      }
      toolOutputQueueRef.current.clear();
      textRevealRef.current = null;
    };
  }, []);

  // 加载历史会话消息（点击历史列表时触发）
  useEffect(() => {
    // 另一线程的历史不能替换当前线程的消息：切换线程时会先收到新的
    // historyMessages，而 threadId 在恢复完成后才更新，中间渲染必须忽略。
    if (historyThreadId && historyThreadId !== threadId) return;
    if (historyMessages) {
      followLatestRef.current = true;
      const normalizedHistory = normalizeHistoryMessages(historyMessages);
      setMessages(normalizedHistory);
      const latestRun = [...normalizedHistory].reverse().find((item) => item?.runId && item?.runStatus);
      const isLiveRun = Boolean(latestRun && LIVE_RUN_STATUSES.has(latestRun.runStatus));
      const latestAssistant = [...normalizedHistory].reverse().find((item) => item?.role === "assistant");
      for (const message of normalizedHistory) {
        if (message?.role === "assistant" && message?.id) {
          displayedTextRef.current.set(message.id, 提取消息展示文本(message));
        }
      }
      setMessageWindowSize(MAX_VISIBLE_MESSAGES);
      setBusy(isLiveRun);
      setRunState({
        status: latestRun?.runStatus || "idle",
        runId: latestRun?.runId || null,
        artifacts: latestRun?.artifacts || [],
        references: latestRun?.references || [],
        task: latestRun?.task || null,
        mode: normalizeUiMode(latestRun?.task?.mode),
      });
      setTodoItems([]);
      const historyFlowEvents = (latestRun?.events || [])
        .filter((event) => FLOW_EVENT_TYPES.has(event?.type))
        .map((event, eventIndex) => ({
          ...event,
          key: event.key || `history:${latestRun.runId}:${event.seq || eventIndex}`,
          data: event.data || {},
          at: event.at || new Date().toISOString(),
        }))
        .reduce((items, event) => appendExecutionFlowEvent(items, event), []);
      replaceExecutionEvents(historyFlowEvents);
      // 已完成历史只用于展示，不能成为 SSE 的当前运行锚点；否则下一轮
      // 的 run_finished/token 会被旧 runId 过滤掉。
      activeRunIdRef.current = isLiveRun ? latestRun.runId : null;
      runInProgressRef.current = isLiveRun;
      if (latestRun?.task?.mode) setEditMode(normalizeUiMode(latestRun.task.mode));
      stoppingRef.current = false;
      setStopping(false);
      assistantIdRef.current = isLiveRun ? latestAssistant?.id || null : null;
      lastAssistantIdRef.current = latestAssistant?.id || null;
      streamBufRef.current = null;
      streamingMsgIdRef.current = assistantIdRef.current;
      if (textRevealRafRef.current) cancelAnimationFrame(textRevealRafRef.current);
      textRevealRafRef.current = null;
      textRevealRef.current = null;
      systemEventKeysRef.current.clear();
      queueRef.current = [];
      setQueuedMessages([]);
      setInjectedContext([]);
      setAgentPhase("");
      agentEventAtRef.current = 0;
      agentErrorRef.current = false;
    }
  }, [historyMessages]);

  // 切换子对话时只切换本地视图，不销毁其它会话的消息/运行状态。
  // 后端 SSE 会随 thread 重连；旧 thread 的任务继续由任务中心跟踪。
  useEffect(() => {
    const previous = previousThreadRef.current;
    if (previous === threadId) return;
    followLatestRef.current = true;
    runtimeConnectingEventRef.current = null;
    const hydratingHistory = Boolean(historyMessages && historyThreadId === threadId);
    const hydratedMessages = hydratingHistory ? normalizeHistoryMessages(historyMessages) : [];
    const hydratedRun = [...hydratedMessages].reverse().find((item) => item?.runId && item?.runStatus);
    const hydratedIsLive = Boolean(hydratedRun && LIVE_RUN_STATUSES.has(hydratedRun.runStatus));
    const hydratedAssistant = [...hydratedMessages].reverse().find((item) => item?.role === "assistant");
    threadCacheRef.current.set(previous, {
      messages,
      runState,
      todoItems,
      busy,
      editMode,
    });
    const cached = threadCacheRef.current.get(threadId);
    if (!hydratingHistory) {
      setMessages(cached?.messages || []);
      setMessageWindowSize(MAX_VISIBLE_MESSAGES);
      setRunState(cached?.runState ? { ...cached.runState, mode: normalizeUiMode(cached.runState.mode) } : { status: "idle", runId: null, artifacts: [], references: [], task: null, mode: normalizeUiMode(editMode) });
      setTodoItems(cached?.todoItems || []);
      replaceExecutionEvents([]);
      activeRunIdRef.current = cached?.runState && LIVE_RUN_STATUSES.has(cached.runState.status)
        ? cached.runState.runId || null
        : null;
      if (cached?.editMode) setEditMode(normalizeUiMode(cached.editMode));
      setBusy(Boolean(cached?.busy));
    }
    setStopping(false);
    stoppingRef.current = false;
    assistantIdRef.current = hydratedIsLive ? hydratedAssistant?.id || null : null;
    lastAssistantIdRef.current = hydratingHistory ? hydratedAssistant?.id || null : null;
    streamBufRef.current = null;
    streamingMsgIdRef.current = assistantIdRef.current;
    if (textRevealRafRef.current) cancelAnimationFrame(textRevealRafRef.current);
    textRevealRafRef.current = null;
    textRevealRef.current = null;
    if (hydratingHistory) activeRunIdRef.current = hydratedIsLive ? hydratedRun?.runId || null : null;
    runInProgressRef.current = hydratingHistory ? hydratedIsLive : Boolean(cached?.busy);
    queueRef.current = [];
    setQueuedMessages([]);
    setInjectedContext([]);
    setReferences([]);
    setImages([]);
    setAttachments([]);
    setInput("");
    if (!hydratingHistory) {
      setLastPrompt(null);
      setAgentPhase("");
      agentEventAtRef.current = 0;
    }
    agentErrorRef.current = false;
    systemEventKeysRef.current.clear();
    previousThreadRef.current = threadId;
  }, [historyMessages, historyThreadId, threadId]);

  // 新建会话：清空消息
  const handleNewSession = useCallback(() => {
    setMessages([]);
    setMessageWindowSize(MAX_VISIBLE_MESSAGES);
    setBusy(false);
    stoppingRef.current = false;
    setStopping(false);
    assistantIdRef.current = null;
    lastAssistantIdRef.current = null;
    streamBufRef.current = null;
    streamingMsgIdRef.current = null;
    if (textRevealRafRef.current) cancelAnimationFrame(textRevealRafRef.current);
    textRevealRafRef.current = null;
    textRevealRef.current = null;
    setInput("");
    setLastPrompt(null);
    setAgentPhase("");
    agentEventAtRef.current = 0;
    agentErrorRef.current = false;
    setReferences([]);
    setImages([]);
    setAttachments([]);
    queueRef.current = [];
    setQueuedMessages([]);
    setInjectedContext([]);
    setRunState({ status: "idle", runId: null, artifacts: [], references: [], task: null, mode: normalizeUiMode(editMode) });
    setTodoItems([]);
    replaceExecutionEvents([]);
    activeRunIdRef.current = null;
    runInProgressRef.current = false;
    systemEventKeysRef.current.clear();
    if (onNewSession) onNewSession();
  }, [onNewSession, replaceExecutionEvents]);

  // 暴露插入文本方法（供 @ 按钮调用）
  useImperativeHandle(ref, () => ({
    setMode(mode) {
      if (forcedMode) return false;
      const nextMode = normalizeUiMode(mode);
      setEditMode(nextMode);
      setRunState((state) => ({ ...state, mode: nextMode }));
      return true;
    },
    insertText(text) {
      const found = parseReferenceMarkers(text);
      if (found.length) setReferences((prev) => [...prev, ...found.filter((r) => !prev.some((p) => p.id === r.id))]);
      setInput((v) => {
        const sep = v && !v.endsWith(" ") ? " " : "";
        return v + sep + text;
      });
    },
    insertContext(text) {
      const value = String(text || "").trim();
      if (!value) return;
      setInput((v) => {
        const prefix = v && !v.endsWith("\n") ? "\n\n" : "";
        return `${v}${prefix}[选区上下文]\n${value}\n[/选区上下文]`;
      });
      setModelMsg("已加入选区上下文，请补充指令后发送");
      window.setTimeout(() => setModelMsg(""), 2600);
    },
    startAgentTask(payload = {}) {
      const taskText = String(payload.text || "").trim();
      const nextReferences = Array.isArray(payload.references) ? payload.references.filter((item) => item?.target) : [];
      const markers = nextReferences.map(referenceMarker).filter(Boolean);
      const skillMarkers = (Array.isArray(payload.skills) ? payload.skills : []).map((name) => `@技能[${String(name).trim()}]`).filter((name) => name !== "@技能[]");
      const workflowMarker = payload.workflowId ? `@工作流[${payload.workflowId}]` : "";
      const prompt = [taskText, ...markers, ...skillMarkers, workflowMarker].filter(Boolean).join(" ");
      if (!prompt) return;
      setEditMode("agent");
      setReferences(nextReferences);
      setInjectedContext(payload.contextText ? [{ text: String(payload.contextText) }] : []);
      setInput(prompt);
      setRunState((state) => ({ ...state, mode: "agent" }));
      setModelMsg("已转为 Agent 任务，请确认后发送");
      window.setTimeout(() => setModelMsg(""), 3200);
    },
    focusRun() {
      const el = bodyRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    },
  }));

  // 流式刷新调度：合并同一帧内的多次文本追加
  const patch = useCallback((id, fn) => {
    if (!mountedRef.current) return;
    setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));
  }, []);

  const flushToolOutput = useCallback(() => {
    if (toolOutputRafRef.current) {
      cancelAnimationFrame(toolOutputRafRef.current);
      toolOutputRafRef.current = null;
    }
    const updates = [...toolOutputQueueRef.current.values()];
    toolOutputQueueRef.current.clear();
    if (!updates.length || !mountedRef.current) return;
    setMessages((current) => {
      const byMessage = new Map();
      for (const update of updates) {
        if (!byMessage.has(update.messageId)) byMessage.set(update.messageId, []);
        byMessage.get(update.messageId).push(update);
      }
      let changed = false;
      const next = [...current];
      for (const [messageId, edits] of byMessage) {
        const messageIndex = next.findIndex((item) => item.id === messageId);
        if (messageIndex < 0) continue;
        const blocks = [...(next[messageIndex].blocks || [])];
        let messageChanged = false;
        for (const edit of edits) {
          let blockIndex = edit.toolCallId
            ? blocks.findIndex((block) => block.type === "tool" && block.id === edit.toolCallId)
            : -1;
          if (!edit.toolCallId) {
            for (let index = blocks.length - 1; index >= 0; index -= 1) {
              const block = blocks[index];
              if (block.type === "tool" && !block.done && (!edit.name || block.name === edit.name)) {
                blockIndex = index;
                break;
              }
            }
          }
          if (blockIndex < 0) continue;
          const block = blocks[blockIndex];
          const output = edit.replace ? edit.output : `${block.output || ""}${edit.output}`;
          if (output === block.output) continue;
          blocks[blockIndex] = { ...block, output };
          messageChanged = true;
        }
        if (messageChanged) {
          next[messageIndex] = { ...next[messageIndex], blocks };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, []);

  const queueToolOutput = useCallback((messageId, data = {}) => {
    if (!messageId) return;
    const toolCallId = data.toolCallId || null;
    const name = data.name || "";
    const key = `${messageId}:${toolCallId || name || "last"}`;
    const previous = toolOutputQueueRef.current.get(key);
    const output = String(data.output || "");
    toolOutputQueueRef.current.set(key, {
      messageId,
      toolCallId,
      name,
      output: data.replace ? output : `${previous?.output || ""}${output}`,
      replace: Boolean(data.replace || previous?.replace),
    });
    if (!toolOutputRafRef.current) toolOutputRafRef.current = requestAnimationFrame(flushToolOutput);
  }, [flushToolOutput]);

  const rememberDisplayedText = useCallback((id, text) => {
    if (!id) return;
    displayedTextRef.current.set(id, String(text || ""));
    if (displayedTextRef.current.size > 600) {
      const oldest = displayedTextRef.current.keys().next().value;
      if (oldest) displayedTextRef.current.delete(oldest);
    }
  }, []);

  const cancelTextReveal = useCallback(({ preserveText = false } = {}) => {
    const active = textRevealRef.current;
    if (textRevealRafRef.current) cancelAnimationFrame(textRevealRafRef.current);
    textRevealRafRef.current = null;
    textRevealRef.current = null;
    // 已经拿到但尚未显示的字符不能因为下一轮输入而丢失。
    if (preserveText && active?.pending && active?.id) {
      const displayed = displayedTextRef.current.get(active.id) || "";
      rememberDisplayedText(active.id, displayed + active.pending);
      patch(active.id, (m) => ({
        ...m,
        blocks: appendTextBlock([...(m.blocks || [])], active.pending),
        status: active.completeWhenDrained ? (agentErrorRef.current ? "error" : "done") : m.status,
      }));
    }
  }, [patch, rememberDisplayedText]);

  const enqueueTextReveal = useCallback((id, value, { authoritative = false } = {}) => {
    const text = String(value || "");
    if (!id || !text) return;
    let state = textRevealRef.current;
    if (!state || state.id !== id) {
      if (textRevealRafRef.current) cancelAnimationFrame(textRevealRafRef.current);
      state = { id, fullText: displayedTextRef.current.get(id) || "", pending: "", lastAt: performance.now(), completeWhenDrained: false };
      textRevealRef.current = state;
      textRevealRafRef.current = null;
    }

    if (authoritative) {
      const displayed = displayedTextRef.current.get(id) || "";
      if (text === displayed || text === state.fullText) return;
      if (text.startsWith(state.fullText)) {
        state.pending += text.slice(state.fullText.length);
      } else if (text.startsWith(displayed)) {
        // 动画状态可能已经在 agent_end 后清理，但消息气泡已经显示了前缀。
        // 只排队缺失后缀，不能把最终全文再次追加到气泡末尾。
        state.pending = text.slice(displayed.length);
      } else if (displayed && text.includes(displayed)) {
        // 权威全文包含已显示文本：只追加缺失后缀，绝不能先清空已显示内容。
        // 多回合场景下权威全文不是累积文本的前缀，按包含关系判断即可。
        state.pending += text.slice(text.indexOf(displayed) + displayed.length);
      } else if (!state.fullText) {
        // 气泡还没有任何已显示文本：允许从权威全文清空重播。
        // 断线重连或缺失 token 时宁可从最终文本重放，也不能保留截断回复。
        state.pending = text;
        rememberDisplayedText(id, "");
        patch(id, (m) => {
          const blocks = [...(m.blocks || [])];
          const textIndex = blocks.map((block) => block.type).lastIndexOf("text");
          if (textIndex >= 0) blocks[textIndex] = { ...blocks[textIndex], text: "" };
          else blocks.push({ type: "text", text: "" });
          return { ...m, blocks };
        });
      }
      // 已有已显示文本但权威全文不包含它（多回合累积）：保留已显示内容、不追加、不清空。
      state.fullText = text;
    } else {
      state.fullText += text;
      state.pending += text;
    }

    const reveal = (now) => {
      const active = textRevealRef.current;
      if (!active || active.id !== id) return;
      const elapsedMs = Math.max(1, now - active.lastAt);
      if (elapsedMs < 32 && active.pending.length < 24) {
        textRevealRafRef.current = requestAnimationFrame(reveal);
        return;
      }
      active.lastAt = now;
      const reducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      const count = 计算展示字符数({ remaining: active.pending.length, elapsedMs, reducedMotion });
      if (count) {
        const chunk = active.pending.slice(0, count);
        active.pending = active.pending.slice(count);
        rememberDisplayedText(id, (displayedTextRef.current.get(id) || "") + chunk);
        patch(id, (m) => {
          const blocks = appendTextBlock([...(m.blocks || [])], chunk);
          return { ...m, blocks };
        });
      }
      if (active.pending.length) {
        textRevealRafRef.current = requestAnimationFrame(reveal);
      } else {
        textRevealRafRef.current = null;
        if (active.completeWhenDrained) {
          patch(id, (m) => ({ ...m, status: agentErrorRef.current ? "error" : "done" }));
          textRevealRef.current = null;
        }
      }
    };
    if (!textRevealRafRef.current) textRevealRafRef.current = requestAnimationFrame(reveal);
  }, [patch, rememberDisplayedText]);

  const finishTextReveal = useCallback((id) => {
    const state = textRevealRef.current;
    if (!id || !state || state.id !== id || !state.pending.length) {
      if (id) patch(id, (m) => ({ ...m, status: agentErrorRef.current ? "error" : "done" }));
      return;
    }
    state.completeWhenDrained = true;
  }, [patch]);

  const scheduleFlush = useCallback((type, data) => {
    if (!streamBufRef.current) return;
    const buf = streamBufRef.current;
    if (type === "token") buf.text += data.text;
    else if (type === "thinking") buf.thinking += data.text;
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const id = streamingMsgIdRef.current;
        if (id && streamBufRef.current) {
          const { text, thinking } = streamBufRef.current;
          if (text || thinking) {
            patch(id, (m) => {
              let blocks = [...(m.blocks || [])];
              if (text) blocks = appendTextBlock(blocks, text);
              if (thinking) blocks = appendThinkingBlock(blocks, thinking);
              return { ...m, blocks };
            });
          }
          // 清空已刷新的增量
          streamBufRef.current.text = "";
          streamBufRef.current.thinking = "";
        }
      });
    }
  }, [patch]);

  // 同步外部 models
  useEffect(() => { if (modelsProp?.length) setModels(modelsProp); }, [modelsProp]);

  // 初始化模型：等待真实列表后再选择，避免 App 首次传入空数组时选中失效模型。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let d = { models: modelsProp || [], default: defaultModel || "" };
      if (!modelsProp?.length) {
        try { d = await listModels(); } catch {}
      }
      if (cancelled) return;
      const nextModels = d.models || [];
      setModels(nextModels);
      if (d.counts) setModelCounts(d.counts);
      const saved = localStorage.getItem(MODEL_KEY);
      const preferred = saved || d.default || "";
      const cur = nextModels.some((m) => m.id === preferred) ? preferred : (nextModels[0]?.id || "");
      setModel(cur);
      applyModel(cur, nextModels);
      onModelChange?.(cur);
      // 初始化只读取本地偏好，不主动触发 provider 初始化。真正发送时由服务端
      // 在同一个 admission 链路同步模型，避免页面加载/切换会话与 Agent 运行竞态。
    })();
    return () => { cancelled = true; };
  }, [modelsProp, defaultModel, clientId, threadId, onModelChange]);

  // 设置面板与输入框共用同一个当前模型；真正切换仍沿用原有 Pi/Agent API。
  useEffect(() => {
    if (!selectedModel || selectedModel === model || !models.some((item) => item.id === selectedModel)) return;
    void changeModel(selectedModel);
  }, [selectedModel, model, models]);

  function applyModel(id, list) {
    const m = (list || models).find((x) => x.id === id);
    setModelVision(!!m?.vision);
    localStorage.setItem(MODEL_KEY, id);
  }

  const changeModel = async (id) => {
    setModel(id);
    applyModel(id);
    onModelChange?.(id);
    setModelMsg("切换中...");
    try {
      const result = await setAgentModel(clientId, id, threadId);
      if (result?.model && result.model !== id) {
        setModel(result.model);
        applyModel(result.model);
        onModelChange?.(result.model);
        setModelMsg(`连接失败，已切换到 ${result.model}`);
      } else setModelMsg("ok");
    }
    catch (e) { setModelMsg("失败: " + e.message); }
    setTimeout(() => setModelMsg(""), 2500);
  };

  // SSE 连接
  useEffect(() => {
    const generation = streamGenerationRef.current + 1;
    streamGenerationRef.current = generation;
    let es = null;
    let reconnectTimer = null;
    let stopped = false;
    let retryDelay = 500;
    let connectionSerial = 0;
    let watchdogTimer = null;

    const streamKey = `${clientId}::${threadId || ""}`;
    const isCurrentGeneration = () => (
      !stopped && mountedRef.current && generation === streamGenerationRef.current
    );
    const resetReady = () => {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      streamReadyRef.current = { promise, resolve, streamKey, generation };
    };
    handshakeDoneRef.current = false;
    eventCursorRef.current = eventCursorsRef.current.get(streamKey) || 0;
    resetReady();
    const markReady = (value) => {
      if (streamReadyRef.current?.generation === generation && streamReadyRef.current?.streamKey === streamKey) {
        streamReadyRef.current.resolve?.(value);
      }
    };

    const scheduleReconnect = (source) => {
      if (!isCurrentGeneration() || !source || source !== es) return;
      setConnected(false);
      markReady(false);
      source.close();
      es = null;
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, retryDelay);
      retryDelay = Math.min(5000, retryDelay * 2);
    };
    
    const connect = () => {
      if (!isCurrentGeneration()) return;
      resetReady();
      const serial = ++connectionSerial;
      let lastSignalAt = Date.now();
      
      const workspaceQuery = workspace ? `&cwd=${encodeURIComponent(workspace)}` : "";
      const cursorQuery = eventCursorRef.current ? `&after=${eventCursorRef.current}` : "";
      // 携带已知代际 ID：服务端据此判断游标是否属于旧通道并清零，
      // 否则 Runtime 重建后新通道的前 N 个事件会被旧游标整段过滤。
      const knownStreamId = streamIdsRef.current.get(streamKey) || "";
      const streamQuery = knownStreamId ? `&stream=${encodeURIComponent(knownStreamId)}` : "";
      const nextSource = new EventSource(`/api/agent/stream?client=${encodeURIComponent(clientId)}&thread=${encodeURIComponent(threadId || "")}${workspaceQuery}${cursorQuery}${streamQuery}`);
      es = nextSource;
      
      nextSource.onopen = () => {
        // 仅表示 HTTP/SSE 通道打开；Agent 是否已就绪由服务端 connected 握手确认。
        // 运行时冷启动可能需要几十秒；不能在 Pi 还在初始化时 5 秒就反复重建连接。
        window.setTimeout(() => {
          if (isCurrentGeneration() && serial === connectionSerial && es === nextSource && !handshakeDoneRef.current) {
            scheduleReconnect(nextSource);
          }
        }, 50000);
      };
      handshakeDoneRef.current = false;

      nextSource.addEventListener("heartbeat", () => {
        if (!isCurrentGeneration() || serial !== connectionSerial || es !== nextSource) return;
        // 心跳只证明 SSE 通道仍存活；“Agent 已连接”由 connected 握手确认，
        // 避免 Runtime 还在初始化时提前显示为已连接。
        lastSignalAt = Date.now();
      });
      
      nextSource.onmessage = (e) => {
        if (!isCurrentGeneration() || serial !== connectionSerial || es !== nextSource) return;
        lastSignalAt = Date.now();
        const eventId = Number(e.lastEventId || 0);
        try { 
          const payload = JSON.parse(e.data);
          if (payload?.type === "connected") {
            handshakeDoneRef.current = true;
            const connectedStreamId = String(payload?.data?.streamId || "");
            const previousStreamId = streamIdsRef.current.get(streamKey) || "";
            // 代际变化：Runtime/会话重建后服务端序号从 1 重新开始，
            // 旧游标必须废弃，否则新通道事件会被整段过滤。
            if (connectedStreamId && previousStreamId && connectedStreamId !== previousStreamId) {
              eventCursorRef.current = 0;
              eventCursorsRef.current.delete(streamKey);
            }
            if (connectedStreamId) streamIdsRef.current.set(streamKey, connectedStreamId);
            const connectedCursor = Number(payload?.data?.cursor || 0);
            if (connectedCursor > eventCursorRef.current) {
              eventCursorRef.current = connectedCursor;
              eventCursorsRef.current.set(streamKey, connectedCursor);
            }
            // 只有应用层握手成功后才清除退避；HTTP onopen 过早重置会让
            // Runtime 初始化失败时进入 500ms 高频重连循环。
            retryDelay = 500;
            markReady(true);
          }
          // 事件处理成功后才提交应用层游标：单条事件处理器异常时游标不前进，
          // 重连后该事件会被重新回放，而不是被静默跳过。
          eventHandlerRef.current?.(payload);
          if (eventId > eventCursorRef.current) {
            eventCursorRef.current = eventId;
            eventCursorsRef.current.set(streamKey, eventId);
          }
        } catch (err) {
          console.error("SSE message parse error:", err);
        }
      };
      
      nextSource.onerror = () => {
        if (isCurrentGeneration() && serial === connectionSerial && es === nextSource) {
          scheduleReconnect(nextSource);
        }
      };
      watchdogTimer = setInterval(() => {
        // 某些代理/浏览器会保持 TCP 为 open，却不再触发 EventSource.onerror；
        // 服务端 heartbeat 正常时不会触发这里，静默超过 20 秒才强制重连。
        if (isCurrentGeneration() && Date.now() - lastSignalAt > 20000) scheduleReconnect(nextSource);
      }, 5000);
    };
    
    connect();
    // 发送后长时间无事件（半开连接/重连失败）时强制重连，用服务端回放补齐内容
    const onForceReconnect = () => {
      if (es && !stopped && mountedRef.current) scheduleReconnect(es);
    };
    window.addEventListener("oaw:force-reconnect", onForceReconnect);
    
    return () => {
      stopped = true;
      connectionSerial += 1;
      window.removeEventListener("oaw:force-reconnect", onForceReconnect);
      if (es) es.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      markReady(false);
      if (streamReadyRef.current?.generation === generation && streamReadyRef.current?.streamKey === streamKey) {
        streamReadyRef.current = null;
      }
    };
  }, [clientId, threadId, workspace]);

  // 恢复/切换会话后拉取服务端保存的上下文用量，避免刷新后一直显示 0
  useEffect(() => {
    let cancelled = false;
    if (!clientId) return undefined;
    (async () => {
      try {
        const res = await fetch(`/api/agent/runtime?client=${encodeURIComponent(clientId)}&thread=${encodeURIComponent(threadId || "")}`);
        const data = await res.json().catch(() => ({}));
        if (cancelled || !data?.usage) return;
        const snapshot = data.usage;
        const snapshotUsage = snapshot.usage
          ? { ...snapshot.usage }
          : Number(snapshot.estimatedContextTokens) > 0
            ? { context: Number(snapshot.estimatedContextTokens) }
            : null;
        if (snapshotUsage) {
          snapshotUsage.contextWindow = snapshot.contextWindow;
          snapshotUsage.compactThreshold = snapshot.compactThreshold;
          snapshotUsage.compactionMode = snapshot.compactionMode;
          snapshotUsage.compactThresholdSource = snapshot.compactThresholdSource;
          setRunState((s) => (s.usage ? s : { ...s, usage: snapshotUsage }));
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [clientId, threadId]);

  // Run 的 steps 是 Todo 的唯一事实来源。对话事件只负责实时刷新，
  // 这里在拿到 runId 后立即拉取，并在执行期间短轮询，避免 Todo 只存在于任务中心。
  // 同时覆盖“后端已完成但 SSE 终结事件丢失”的情况：用当前 thread 找回 Run，
  // 再注入一个幂等的 run_finished，让输入框和状态栏恢复可用。
  useEffect(() => {
    const runId = runState.runId;
    const activeStatuses = ["running", "queued", "waiting_user", "recovering", "cancel_requested", "finishing"];
    const shouldReconcile = busy || activeStatuses.includes(runState.status);
    if (!runId && !shouldReconcile) {
      setTodoItems([]);
      return undefined;
    }
    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        let run = null;
        if (runId) {
          run = (await getRun(runId))?.run || null;
        } else {
          const result = await listRuns(threadId, 12, { cwd: workspace });
          run = (result?.runs || [])
            .filter((item) => item?.clientId === clientId && activeStatuses.includes(item.status))
            .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))[0] || null;
        }
        if (cancelled || !run) return;
        const nextTodos = run.todoVersion === 1 && Array.isArray(run.todos)
          ? run.todos
          : (Array.isArray(run.steps) ? run.steps : []);
        setTodoItems(nextTodos);
        const terminal = ["completed", "failed", "cancelled", "aborted"].includes(run.status);
        // 只有活动 Run 才能成为 SSE 过滤锚点；历史终态 Run 只用于展示，
        // 否则切回历史会话后，下一轮新 Run 的事件会被旧 ID 丢弃。
        if (!terminal && !activeRunIdRef.current && run.id) activeRunIdRef.current = run.id;
        if (terminal && activeRunIdRef.current === run.id) activeRunIdRef.current = null;
        if (run.id && run.id !== runState.runId) {
          setRunState((state) => ({ ...state, runId: run.id, status: run.status, task: run.task || state.task, artifacts: run.artifacts || state.artifacts, references: run.references || state.references }));
        }
        if (terminal && !reconciledRunIdsRef.current.has(run.id)) {
          reconciledRunIdsRef.current.add(run.id);
          eventHandlerRef.current?.({
            id: `reconcile-${run.id}`,
            type: "run_finished",
            at: run.finishedAt || run.updatedAt || new Date().toISOString(),
            data: {
              runId: run.id,
              status: run.status,
              artifacts: run.artifacts || [],
              references: run.references || [],
              verificationStatus: run.verificationStatus || "not_checked",
              finalText: [...(run.events || [])].reverse().find((item) => item?.type === "assistant_final" && String(item?.data?.text || "").trim())?.data?.text || "",
              recovered: true,
            },
          });
        }
      } catch {} finally {
        inFlight = false;
      }
    };
    void refresh();
    // stream_resync 等场景要求立即对账一次，不等下一个轮询周期
    const onForceReconcile = () => { void refresh(); };
    window.addEventListener("oaw:force-reconcile", onForceReconcile);
    const timer = shouldReconcile ? window.setInterval(refresh, 900) : null;
    return () => {
      cancelled = true;
      window.removeEventListener("oaw:force-reconcile", onForceReconcile);
      if (timer) window.clearInterval(timer);
    };
  }, [clientId, threadId, workspace, runState.runId, runState.status, busy]);

  const acceptSystemEvent = useCallback((key) => {
    const value = String(key || "");
    if (!value) return true;
    if (systemEventKeysRef.current.has(value)) return false;
    systemEventKeysRef.current.add(value);
    // 限制长期运行的浏览器标签页内存增长。
    if (systemEventKeysRef.current.size > 600) {
      const first = systemEventKeysRef.current.values().next().value;
      if (first) systemEventKeysRef.current.delete(first);
    }
    return true;
  }, []);

  function handleEvent(ev) {
    const envelope = ev?.event || ev || {};
    const { type, data = {} } = envelope;
    const eventRunId = data?.runId || null;
    // 重连会回放历史事件。已知当前 Run 时，旧 Run 的事件不能污染当前对话。
    if (eventRunId && activeRunIdRef.current && eventRunId !== activeRunIdRef.current) return;
    // 断线重连可能从 capability_plan 之后开始回放；run_admitted 也可以作为
    // 当前 Run 的锚点，否则后续 tool_start/token 会被误判为旧事件而丢弃。
    const runInProgress = runInProgressRef.current || busy || LIVE_RUN_STATUSES.has(runState.status);
    if (eventRunId && !activeRunIdRef.current && runInProgress && ["capability_plan", "run_admitted", "model_request_started"].includes(type)) {
      activeRunIdRef.current = eventRunId;
    }
    // 本地还没有锚点但事件带 runId（恢复/切换会话/重连回放/fetch 响应前到达）：
    // 首个带 runId 的事件即视为当前运行锚点并接受，避免运行中的事件被误丢。
    if (eventRunId && !activeRunIdRef.current && !["connected", "capability_plan", "run_finished"].includes(type)) {
      activeRunIdRef.current = eventRunId;
    }
    if (type !== "connected") agentEventAtRef.current = Date.now();
    if (FLOW_EVENT_TYPES.has(type) && (runInProgress || eventRunId === activeRunIdRef.current)) {
      const sequence = Number(envelope.id || envelope.seq || 0);
      const eventKey = sequence ? `seq:${sequence}` : `${type}:${eventRunId || "current"}:${envelope.at || Date.now()}`;
      enqueueExecutionEvent({ key: eventKey, type, data, at: envelope.at || new Date().toISOString() });
    }
    let aid = assistantIdRef.current;
    // 刷新、断线重连或切换回正在执行的子对话时，历史事件可能先于本地气泡到达。
    // 只在本轮仍处于运行态时恢复气泡，避免把已完成历史重复渲染一遍。
    const ensureAssistant = (force = false) => {
      if (assistantIdRef.current) {
        lastAssistantIdRef.current = assistantIdRef.current;
        return assistantIdRef.current;
      }
      if (!force && !busy && !LIVE_RUN_STATUSES.has(runState.status)) return null;
      const recoveredId = newId();
      assistantIdRef.current = recoveredId;
      lastAssistantIdRef.current = recoveredId;
      streamingMsgIdRef.current = recoveredId;
      streamBufRef.current = { text: "", thinking: "" };
      setMessages((ms) => ms.some((message) => message.id === recoveredId)
        ? ms
        : [...ms, { id: recoveredId, role: "assistant", blocks: [], status: "streaming", images: [], createdAt: Date.now() }]);
      aid = recoveredId;
      return recoveredId;
    };
    // 追加/更新 block 的辅助函数
    const appendToBlock = (type, field, text, makeNew) => {
      if (!aid) return;
      patch(aid, (m) => {
        const blocks = [...(m.blocks || [])];
        const last = blocks[blocks.length - 1];
        if (last && last.type === type) {
          last[field] = (last[field] || "") + text;
          return { ...m, blocks };
        }
        blocks.push(makeNew(text));
        return { ...m, blocks };
      });
    };
    switch (type) {
case "runtime_connecting":
        {
          const at = envelope.at || new Date().toISOString();
          const sequence = Number(envelope.id || envelope.seq || 0);
          runtimeConnectingEventRef.current = {
            key: sequence ? `seq:${sequence}` : `${type}:${eventRunId || "current"}:${at}`,
            type,
            data,
            at,
          };
        }
        setConnected(false);
        setAgentPhase("准备会话运行时");
        break;
      case "runtime_init_failed":
        // 运行时初始化失败是终态：必须同时解除 busy 与运行锚点，
        // 否则界面会停留在“准备会话运行时”，输入框无法恢复。
        setConnected(false);
        setAgentPhase(data?.message || "会话运行时初始化失败");
        setModelMsg(data?.message || "会话运行时初始化失败，请重试或检查模型配置");
        window.setTimeout(() => setModelMsg(""), 4200);
        setBusy(false);
        runInProgressRef.current = false;
        setRunState((s) => (s.status === "failed" ? s : { ...s, status: "failed" }));
        break;
      case "stream_resync":
        // 游标与当前历史窗口已不连续（高频增量被淘汰）。触发 Run 对账，
        // 用服务端 Run 终态与最终文本重建状态，而不是依赖已丢失的事件。
        setAgentPhase("事件流已重同步");
        if (runInProgressRef.current || busy) {
          window.dispatchEvent(new CustomEvent("oaw:force-reconcile"));
        }
        break;
      case "connected":
        runtimeConnectingEventRef.current = null;
        setConnected(true);
        if (data.model && data.model !== model) {
          setModel(data.model);
          applyModel(data.model);
          if (data.modelFallbackFrom) {
            setModelMsg(`旧模型连接失败，已恢复到 ${data.model}`);
            window.setTimeout(() => setModelMsg(""), 3600);
          }
        }
        break;
      case "run_admitting":
        setAgentPhase("准备任务");
        break;
      case "run_admitted":
        setAgentPhase("任务已受理");
        if (data.runId) setRunState((s) => ({ ...s, runId: data.runId }));
        break;
      case "model_request_started":
        setAgentPhase("正在请求模型");
        break;
      case "agent_started":
        setAgentPhase("模型已开始处理");
        ensureAssistant();
        break;
      case "turn_started":
        setAgentPhase("模型正在生成");
        break;
      // 文本 token：节流合并到 blocks
      case "token":
        setAgentPhase("生成回复");
        if (!aid) aid = ensureAssistant();
        if (aid) enqueueTextReveal(aid, data.text);
        break;
      // 思考过程：节流合并到 blocks
      case "thinking":
        setAgentPhase("模型思考");
        if (!aid) aid = ensureAssistant();
        if (aid) scheduleFlush("thinking", data);
        break;
      // 工具调用开始：推入新 tool block（按 toolCallId 去重，重放不产生重复卡片）
      case "tool_start":
        flushToolOutput();
        setAgentPhase(`调用工具：${data.name || "处理中"}`);
        if (!aid) aid = ensureAssistant();
        if (aid) {
          if (streamBufRef.current) flushNow(aid);
          patch(aid, (m) => {
            const blocks = m.blocks || [];
            if (data.toolCallId && blocks.some((block) => block.type === "tool" && (block.id === data.toolCallId || block.toolCallId === data.toolCallId))) {
              return m;
            }
            return {
              ...m,
              blocks: [...blocks, {
                type: "tool",
                id: data.toolCallId || newId(),
                toolCallId: data.toolCallId || null,
                name: data.name,
                input: data.input || "",
                output: "",
                done: false,
                isError: false,
                expanded: false,
                startTime: Date.now(),
                duration: null,
              }],
            };
          });
        }
        break;
      // 工具输出流：更新最后一个 tool block
      case "tool_output":
        if (!aid) aid = ensureAssistant();
        if (aid) queueToolOutput(aid, data);
        break;
      // 工具结束：标记完成；找不到对应 start（历史被截断/重连丢失）时创建恢复卡片
      case "tool_end":
        flushToolOutput();
        if (!aid) aid = ensureAssistant();
        if (aid) patch(aid, (m) => {
          const blocks = [...(m.blocks || [])];
          const tool = data.toolCallId
            ? blocks.find((block) => block.type === "tool" && (block.id === data.toolCallId || block.toolCallId === data.toolCallId))
            : [...blocks].reverse().find((block) => block.type === "tool" && (!data.name || block.name === data.name));
          if (tool) {
            tool.done = true;
            tool.isError = !!data.isError;
            if (data.result) tool.result = data.result;
            if (tool.startTime) tool.duration = ((Date.now() - tool.startTime) / 1000).toFixed(1);
          } else if (data.toolCallId || data.name) {
            // tool_start 已被历史淘汰或重连丢失：创建带恢复标记的工具卡，
            // 保证界面工具数量与实际执行一致，而不是静默丢弃。
            blocks.push({
              type: "tool",
              id: data.toolCallId || newId(),
              toolCallId: data.toolCallId || null,
              name: data.name || "tool",
              input: "",
              output: "",
              result: data.result || "",
              done: true,
              isError: !!data.isError,
              startMissing: true,
              expanded: false,
              startTime: null,
              duration: null,
            });
          }
          return { ...m, blocks };
        });
        break;
      // agent 主动提问（ask_user 工具）：追加问题卡片，用户回答后 agent 继续
      case "ask_user":
        if (!aid) aid = ensureAssistant();
        if (aid) {
          if (streamBufRef.current) flushNow(aid);
          setBusy(true);
          setAgentPhase("等待你的回答");
          setRunState((s) => ({ ...s, status: "waiting_user", runId: data.runId || s.runId || null }));
          const askId = data.askId || `${data.runId || "ask"}:${data.question || ""}`;
          patch(aid, (m) => m.blocks?.some((block) => block.type === "ask" && block.id === askId)
            ? m
            : ({
              ...m,
              blocks: [...(m.blocks || []), {
                type: "ask",
                id: askId,
                question: data.question || "",
                options: data.options || [],
                answer: "",
              }],
            }));
}
        break;
      // 工具审批请求（opencode 式 allow/ask/deny）：追加审批卡片，用户批准后 agent 继续
      case "tool_approval_request":
        if (!aid) aid = ensureAssistant();
        if (aid) {
          if (streamBufRef.current) flushNow(aid);
          setBusy(true);
          setAgentPhase("等待你的审批");
          setRunState((s) => ({ ...s, status: "waiting_user", runId: data.runId || s.runId || null }));
          const approvalId = data.id || `${data.runId || "approval"}:${data.tool}:${data.input || ""}`;
          patch(aid, (m) => m.blocks?.some((block) => block.type === "approval" && block.id === approvalId)
            ? m
            : ({
              ...m,
              blocks: [...(m.blocks || []), {
                type: "approval",
                id: approvalId,
                tool: data.tool || "",
                input: data.input || "",
                decision: "",
              }],
            }));
        }
        break;
      case "tool_approval_resolved":
        if (aid) {
          const approvalId = data.id || `${data.runId || "approval"}:${data.tool}:${data.input || ""}`;
          patch(aid, (m) => {
            const blocks = [...(m.blocks || [])];
            const block = blocks.find((b) => b.type === "approval" && b.id === approvalId);
            if (!block) return m;
            block.decision = data.decision === "allow" ? "allow" : "deny";
            return { ...m, blocks };
          });
          setAgentPhase(data.decision === "allow" ? "审批已通过，继续执行" : "操作已被拒绝");
        }
        break;
      // 消息开始/结束
      case "message_start":
        if (data.role === "assistant") setAgentPhase("模型已开始生成");
        if (data.role === "assistant") aid = ensureAssistant();
        break;
      case "message_end":
        break;
      case "text_boundary":
        if (data.phase === "start") setAgentPhase("模型已开始生成");
        break;
      case "thinking_boundary":
        if (data.phase === "start") setAgentPhase("模型思考");
        break;
      case "tool_call_progress":
        if (data.name) setAgentPhase(`准备工具：${data.name}`);
        break;
      case "agent_queue_update":
        setAgentPhase(data.steering ? "正在调整当前任务" : "正在等待后续任务");
        break;
      case "agent_turn_end":
        if (!agentErrorRef.current) setAgentPhase("整理回复");
        break;
      case "stats":
        setRunState((s) => ({
          ...s,
          usage: data.tokens
            ? {
              ...data.tokens,
              contextWindow: s.usage?.contextWindow,
              compactThreshold: s.usage?.compactThreshold,
              compactionMode: s.usage?.compactionMode,
              compactThresholdSource: s.usage?.compactThresholdSource,
            }
            : null,
          cost: data.cost ?? null,
        }));
        break;
      case "agent_retry":
        // Pi 结算失败后，工作台可能会在同一请求内重放一次。失败回合
        // 已经发出 agent_end 并清空了 assistant 引用，这里重新建立一个
        // 流式气泡，避免恢复后的 token 被丢弃。
        agentErrorRef.current = false;
        cancelTextReveal();
        stoppingRef.current = false;
        setStopping(false);
        setBusy(true);
        setRunState((s) => ({ ...s, status: "running" }));
        if (!assistantIdRef.current) {
          const retryAid = newId();
          assistantIdRef.current = retryAid;
          lastAssistantIdRef.current = retryAid;
          streamingMsgIdRef.current = retryAid;
          streamBufRef.current = { text: "", thinking: "" };
          setMessages((ms) => [...ms, {
            id: retryAid, role: "assistant", blocks: [],
            status: "streaming", images: [], createdAt: Date.now(),
          }]);
        } else {
          patch(assistantIdRef.current, (m) => ({ ...m, status: "streaming", errorText: "" }));
        }
        setAgentPhase(`模型连接重试${data.attempt && data.maxAttempts ? `（${data.attempt}/${data.maxAttempts}）` : ""}`);
        pushSystem(`模型连接异常，正在重试${data.attempt && data.maxAttempts ? `（${data.attempt}/${data.maxAttempts}）` : ""}：${data.message || "请稍候"}`, `agent_retry:${data.source || "agent"}:${data.attempt || "retry"}:${data.message || "retry"}`);
        break;
      case "agent_retry_end":
        if (data.success) {
          setAgentPhase("模型连接已恢复");
          pushSystem("模型连接已恢复，继续执行当前任务。", `agent_retry_end:${data.attempt || "ok"}`);
        }
        break;
      case "agent_model_fallback":
        if (data.to) {
          setModel(data.to);
          applyModel(data.to);
          setAgentPhase("切换备用模型");
          pushSystem(data.message || `模型连接失败，已切换到 ${data.to}`, `agent_model_fallback:${data.from || "unknown"}:${data.to}`);
        }
        break;
      case "agent_model_fallback_failed":
        pushSystem(`备用模型切换失败：${data.message || "请在设置中检查模型授权"}`, `agent_model_fallback_failed:${data.from || "unknown"}`);
        break;
      case "todo_updated":
        setTodoItems(Array.isArray(data.todos) ? data.todos : []);
        setRunState((s) => ({
          ...s,
          runId: data.runId || s.runId,
          todoProgress: data.todoProgress || s.todoProgress,
        }));
        break;
      case "thinking_level":
        setRunState((s) => ({ ...s, thinkingLevel: data.effective || null }));
        break;
      case "agent_queued":
        setAgentPhase(`任务排队${data.position ? `（第 ${data.position} 项）` : ""}`);
        setRunState((s) => ({ ...s, status: "queued", runId: data.runId || s.runId || null }));
        break;
      case "capability_plan":
        {
          const plan = data.plan || {};
          if (data.runId) activeRunIdRef.current = data.runId;
          setAgentPhase("准备执行");
          setRunState((s) => ({ ...s, capabilityPlan: plan }));
        }
        break;
      case "mode_policy":
        {
          const mode = normalizeUiMode(data.mode);
          setEditMode(forcedMode ? normalizeUiMode(forcedMode) : mode);
          setRunState((s) => ({ ...s, mode, modePolicy: data }));
        }
        break;
      case "assistant_final":
        if (!aid) aid = ensureAssistant();
        if (aid && data.text) enqueueTextReveal(aid, data.text, { authoritative: true });
        break;
      case "context_compacted":
        setRunState((s) => {
          const estimated = Number(data.estimatedTokensAfter || 0);
          return {
            ...s,
            usage: estimated > 0
              ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, context: estimated }
              : null,
          };
        });
        pushSystem(`${data.automatic ? "上下文达到预算，已自动压缩" : "上下文已压缩"}${data.tokensBefore ? `（压缩前约 ${Number(data.tokensBefore).toLocaleString()} tokens）` : ""}。`, `context_compacted:${envelope.id || data.runId || envelope.at || "session"}`);
        break;
      case "context_compacting":
        pushSystem("当前会话上下文较长，正在压缩重复过程信息…", `context_compacting:${envelope.id || data.runId || envelope.at || "session"}`);
        break;
      case "context_compact_warning":
        pushSystem(`自动压缩未完成：${data.message || "将继续使用当前上下文"}`, `context_compact_warning:${envelope.id || data.runId || envelope.at || "session"}`);
        break;
      case "agent_end": {
        const endedWithError = agentErrorRef.current;
        flushToolOutput();
        if (streamBufRef.current) flushNow(aid);
        if (aid) finishTextReveal(aid);
        assistantIdRef.current = null;
        streamBufRef.current = null;
        streamingMsgIdRef.current = null;
        // agent_end 只表示 Pi 当前回合结束；工作区快照、产物发布和
        // run_finished 仍可能在后台收尾。保持 busy 到权威终结事件，
        // 避免下一条排队消息抢先启动后又被旧 run_finished 清掉状态。
        setBusy(true);
        runInProgressRef.current = true;
        stoppingRef.current = false;
        setStopping(false);
        setAgentPhase(endedWithError ? "模型调用失败" : "");
        setRunState((s) => ({ ...s, status: endedWithError ? "failed" : "finishing" }));
        if (!endedWithError && onAgentEnd) onAgentEnd();
        break;
      }
      case "agent_error":
        flushToolOutput();
        agentErrorRef.current = true;
        cancelTextReveal({ preserveText: true });
        const errorMessage = eventMessageText(data.message, data.category === "quota" ? "当前模型额度不足" : "模型调用失败");
        const errorText = data.category === "quota"
          ? `模型额度不足：${errorMessage}`
          : data.retryable === false
            ? `模型调用失败：${errorMessage}`
            : `模型调用失败：${errorMessage}。可检查模型配置或网络后重试`;
        if (aid) patch(aid, (m) => ({ ...m, status: "error", errorText }));
        assistantIdRef.current = null;
        streamBufRef.current = null;
        streamingMsgIdRef.current = null;
        // 有 runId 时等待 run_finished 统一收尾；若只是 Runtime 握手错误
        // 没有关联 Run，才立即恢复输入框。
        const errorRunId = data.runId || runState.runId;
        setBusy(Boolean(errorRunId));
        runInProgressRef.current = Boolean(errorRunId);
        stoppingRef.current = false;
        setStopping(false);
        setAgentPhase(data.category === "quota" ? "模型额度不足" : "模型调用失败");
        setRunState((s) => ({ ...s, status: "failed", runId: data.runId || s.runId || null }));
        break;
      case "steer":
        pushSystem(`⟳ 插入新指令: ${(data.text || "").slice(0, 60)}...`, `steer:${data.text || ""}`);
        break;
      case "aborted":
        flushToolOutput();
        finalizeStopped();
        break;
      case "file_changed":
        {
          const files = Array.isArray(data.files) ? data.files.filter(Boolean) : [];
          const runKey = data.runId || runState.runId || "unknown";
          pushSystem(`文件已更新: ${files.join(", ")}`, `file_changed:${runKey}:${files.join("|")}`);
        }
        if (data.files?.length) onFileChanged(data.files);
        break;
      case "map_action":
        if (data && acceptSystemEvent(`map_action:${data.id || "analysis"}:${data.updatedAt || JSON.stringify(data.stats || {})}`)) {
          if (data.action === "clear_analysis") {
            pushSystem("已清除地图临时分析结果");
          } else {
            pushSystem(`地图分析已生成：${data.title || data.analysis || "分析结果"}${data.source === "demo" ? "（演示数据）" : ""}`);
          }
          onMapAction?.(data);
        }
        break;
      case "agent_summary":
        // 对话结束总结条
        {
          const key = `agent_summary:${data.runId || "unknown"}:${(data.products || []).join("|")}:${data.summary || ""}`;
          if (!acceptSystemEvent(key)) break;
        }
        upsertRunSummary({ ...data, status: data.status || "completed" });
        break;
      case "run_finished":
        flushToolOutput();
        // SSE 可能只保留了终结事件，或 agent_end 先清理了本地气泡。
        // 服务端从 Pi 的 assistant_final 事件带回权威全文，在这里补齐回复。
        // 断线重连回放时旧 run 的 run_finished 会穿透 runId 过滤：只允许把
        // 权威全文注入当前活跃 run 的气泡，跨 run 的旧文本一律丢弃。
        // 无本地锚点且本地不在运行（恢复/重连）时，也允许用权威全文兜底补齐。
        const knownRunId = activeRunIdRef.current || runState.runId || null;
        const finalTextAllowed = data.runId && knownRunId
          ? data.runId === knownRunId
          : (!data.runId && !runInProgressRef.current && !busy);
        if (data.finalText && finalTextAllowed) {
          if (!aid) aid = assistantIdRef.current || lastAssistantIdRef.current || ensureAssistant(true);
          if (aid) enqueueTextReveal(aid, data.finalText, { authoritative: true });
        }
        if (data.runId && activeRunIdRef.current === data.runId) activeRunIdRef.current = null;
        {
          const finalStatus = data.status || "completed";
          setRunState((s) => ({
            ...s,
            status: finalStatus,
            runId: data.runId || s.runId || null,
            artifacts: Array.isArray(data.artifacts) && data.artifacts.length ? data.artifacts : s.artifacts,
            references: data.references || s.references || [],
            verificationStatus: data.verificationStatus || s.verificationStatus || "not_checked",
          }));
          if (!["running", "queued", "waiting_user", "recovering", "cancel_requested"].includes(finalStatus)) {
            setBusy(false);
            runInProgressRef.current = false;
            setStopping(false);
            setAgentPhase("");
            if (finalStatus === "failed") agentErrorRef.current = true;
            if (aid) finishTextReveal(aid);
          }
        }
        upsertRunSummary(data);
        // run_finished 才是本轮产物完整可用的时点；交给 App 自动打开首个产物。
        onRunFinished?.(data);
        if (data.runId && !["cancelled", "aborted"].includes(data.status)) flushQueued(true);
        break;
      case "memory_proposal":
        if (data.proposal && acceptSystemEvent(`memory_proposal:${data.proposal.id || JSON.stringify(data.proposal)}`)) {
          setMessages((ms) => [...ms, { id: newId(), role: "system", text: "Agent 提出了一条长期记忆建议，请确认后写入。", memoryProposal: data.proposal, status: "done", createdAt: Date.now() }]);
        }
        break;
      case "memory_proposal_resolved":
        setMessages((ms) => ms.map((m) => m.memoryProposal?.id === data.proposal?.id ? { ...m, memoryProposal: data.proposal, text: "长期记忆建议已写入。" } : m));
        break;
      default:
        break;
    }
  }

  // SSE 回调始终转发到最新的处理器，避免切换会话或模型后仍使用旧闭包。
  eventHandlerRef.current = handleEvent;

  // 立即刷新流式缓冲（工具边界、agent_end 前调用）
  const flushNow = useCallback((id) => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    const buf = streamBufRef.current;
    if (id && buf && (buf.text || buf.thinking)) {
      const { text, thinking } = buf;
      patch(id, (m) => {
        let blocks = [...(m.blocks || [])];
        if (text) blocks = appendTextBlock(blocks, text);
        if (thinking) blocks = appendThinkingBlock(blocks, thinking);
        return { ...m, blocks };
      });
      buf.text = "";
      buf.thinking = "";
    }
  }, [patch]);

  const pushSystem = useCallback((text, key = text) => {
    if (!mountedRef.current) return;
    if (!acceptSystemEvent(key)) return;
    setMessages((ms) => [...ms, { id: newId(), role: "system", text, status: "done", createdAt: Date.now() }]);
  }, [acceptSystemEvent]);

  const upsertRunSummary = useCallback((data = {}) => {
    const runId = data.runId || null;
    if (!runId) return;
    const status = data.status || "completed";
    const statusText = status === "failed" ? "失败" : status === "cancelled" ? "已取消" : status === "aborted" ? "已中断" : status === "running" ? "执行中" : "完成";
    const summaryText = String(data.summary || `本轮任务${statusText}`).trim();
    const incomingArtifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
    const incomingProducts = Array.isArray(data.products) ? data.products : [];
    const artifacts = incomingArtifacts.length ? incomingArtifacts : null;
    const products = incomingProducts.length
      ? data.products
      : (artifacts || []).map((item) => item?.path).filter(Boolean);
    setMessages((messages) => {
      const index = messages.findIndex((item) => item.summary && item.runId === runId);
      const previous = index >= 0 ? messages[index] : null;
      const nextArtifacts = artifacts || previous?.artifacts || [];
      const nextProducts = products.length ? products : (previous?.products || []);
      const next = {
        ...(previous || {}),
        id: previous?.id || newId(),
        role: "system",
        text: summaryText,
        products: nextProducts,
        artifacts: nextArtifacts,
        runId,
        runStatus: status,
        references: data.references || previous?.references || [],
        task: data.task || previous?.task || null,
        workspace: data.workspace || previous?.workspace || workspace || "",
        runMode: data.task?.mode || previous?.runMode || runState.mode || "agent",
        eventCount: Number(data.eventCount || previous?.eventCount || 0),
        // 完成语义：显式 complete_task 或服务端推断结果，随 run_finished 一起到达
        completion: data.completion || previous?.completion || null,
        reviewSources: Array.isArray(data.reviewSources) ? data.reviewSources : (previous?.reviewSources || []),
        status: "done",
        summary: true,
        createdAt: previous?.createdAt || Date.now(),
        expanded: true,
      };
      if (index < 0) return [...messages, next];
      return messages.map((item, itemIndex) => itemIndex === index ? next : item);
    });
  }, [runState.mode]);

  // 脑图点击工具节点：在消息流中展开对应工具卡（工具卡默认折叠）
  const focusTool = useCallback((toolId) => {
    const value = String(toolId || "");
    if (!value) return;
    setMessages((list) => list.map((message) => {
      if (!Array.isArray(message.blocks)) return message;
      let changed = false;
      const blocks = message.blocks.map((block) => {
        if (block.type === "tool" && (block.id === value || block.toolCallId === value)) {
          if (block.expanded) return block;
          changed = true;
          return { ...block, expanded: true };
        }
        return block;
      });
      return changed ? { ...message, blocks } : message;
    }));
  }, []);

  const finalizeStopped = useCallback(() => {
    const id = assistantIdRef.current;
    cancelTextReveal({ preserveText: true });
    if (id) patch(id, (m) => ({ ...m, status: "done", stopped: true }));
    assistantIdRef.current = null;
    streamBufRef.current = null;
    streamingMsgIdRef.current = null;
    activeRunIdRef.current = null;
    stoppingRef.current = false;
    setStopping(false);
    setBusy(false);
    runInProgressRef.current = false;
    setRunState((s) => ({ ...s, status: "aborted" }));
  }, [cancelTextReveal, patch]);

  const send = async (overrideText, options = {}) => {
    if (frozen) {
      setModelMsg("当前会话已冻结，可查看历史或新建分支；如需继续请先解冻。");
      window.setTimeout(() => setModelMsg(""), 3200);
      return;
    }
    if (stoppingRef.current) return;
    const source = options.payload || {};
    const sourceImages = source.images || images;
    const sourceAttachments = source.attachments || attachments;
    const sourceReferences = source.references || references;
    const rawText = String(source.rawText ?? overrideText ?? input).trim();
    if (!rawText && sourceImages.length === 0 && sourceAttachments.length === 0) return;
    if (!options.payload && /^\/(?:compact|new|chat|agent|review|help)$/i.test(rawText)) {
      const command = rawText.toLowerCase();
      setInput("");
      setComposerMenu(null);
      if (command === "/compact") return compactContext();
      if (command === "/new") { onNewSession?.(workspace); return; }
      if (["/chat", "/agent", "/review"].includes(command)) {
        const mode = command.slice(1);
        setEditMode(mode);
        pushSystem("已切换到 " + (mode === "chat" ? "Chat（只读检索）" : mode === "review" ? "Review（审查与安全副本）" : "Work（执行与产出）") + "。");
        return;
      }
      pushSystem("输入帮助：/compact 压缩上下文；/new 新建会话；/chat、/agent 或 /review 切换模式；@ 选择文件；& 选择历史会话。", "composer-help");
      return;
    }
    const text = rawText || (sourceImages.length ? "（图片消息）" : "（附件消息）");
    followLatestRef.current = true;
    const contextNotes = source.contextNotes || injectedContext;
    const contextImages = contextNotes.flatMap((note) => note.images || []);
    const contextAttachments = contextNotes.flatMap((note) => note.attachments || []);
    const allImages = [...contextImages, ...sourceImages];
    const allAttachments = [...contextAttachments, ...sourceAttachments];
    const imgs = allImages.map((i) => ({ mediaType: i.mediaType, data: i.data }));
    const atts = allAttachments.map((a) => ({ name: a.name, mediaType: a.mediaType, data: a.data }));
    const sendReferences = [...sourceReferences, ...parseReferenceMarkers(text)].filter((r, i, arr) => arr.findIndex((x) => x.id === r.id) === i);

    // 当前任务执行中：默认排队，另一种选择是只保存为下一轮上下文，不再隐式 steer 打断当前回复。
    if (busy && !options.force) {
      if (busyInputMode === "context") {
        setInjectedContext((prev) => [...prev, { text, images: sourceImages, attachments: sourceAttachments }]);
        setInput("");
        setImages([]);
        setAttachments([]);
        pushSystem("已加入待注入上下文，不会打断当前任务。", `context:${Date.now()}:${text.slice(0, 40)}`);
        return;
      }
      if (busyInputMode === "queue") {
        const messageId = newId();
        const item = {
          messageId,
          rawText,
          images: sourceImages,
          attachments: sourceAttachments,
          references: sourceReferences,
          contextNotes,
          currentDoc,
          editMode,
          effort,
        };
        const nextQueue = [...queueRef.current, item];
        queueRef.current = nextQueue;
        setQueuedMessages(nextQueue);
        setMessages((ms) => [...ms, {
          id: messageId, role: "user", text,
          images: sourceImages.map((i) => i.dataUrl).filter(Boolean),
          attachments: sourceAttachments.map((a) => a.name),
          references: sendReferences,
          status: "queued", queued: true, currentDoc,
          createdAt: Date.now(),
        }]);
        setInput("");
        setImages([]);
        setAttachments([]);
        setInjectedContext([]);
        pushSystem(`已排队第 ${nextQueue.length} 条，当前任务完成后自动执行。`, `queue:${messageId}`);
        return;
      }
      // busyInputMode === "steer"：立即插入新指令（服务端 streamingBehavior=steer 打断当前回合）
      pushSystem("正在插入新指令，当前回合将被打断…", `steer_send:${Date.now()}:${rawText.slice(0, 40)}`);
    }

    // 注入当前文件上下文
    const selectedCurrentDoc = source.currentDoc ?? currentDoc;
    const selectedEditMode = normalizeUiMode(forcedMode || source.editMode || editMode);
    const selectedEffort = source.effort ?? effort;
    if (selectedEditMode === "review" && !selectedCurrentDoc && !sendReferences.some((item) => item?.kind === "file") && !allAttachments.length) {
      setModelMsg("Review 需要先打开、@ 引用或上传一份材料");
      window.setTimeout(() => setModelMsg(""), 3200);
      return;
    }
    const contextPrefix = selectedCurrentDoc ? `[当前打开文件: ${selectedCurrentDoc}]\n` : "";
    const mapContextPrefix = mapProject
      ? `[当前地图项目: ${mapProject}${mapContext?.center ? `；视图中心 ${mapContext.center[0]},${mapContext.center[1]}；缩放 ${mapContext.zoom}；可视范围 ${mapContext.bounds?.join(",") || "未知"}` : ""}]\n`
      : mapContext?.center
        ? `[当前地图视图: 中心 ${mapContext.center[0]},${mapContext.center[1]}；缩放 ${mapContext.zoom}；可视范围 ${mapContext.bounds?.join(",") || "未知"}]\n`
        : "";
    const contextPrefixText = [
      contextText ? `## 当前检索上下文\n${contextText}` : "",
      contextNotes.length ? `## 已注入上下文\n${contextNotes.map((note) => note.text).join("\n\n")}` : "",
    ].filter(Boolean).join("\n\n");
    const contextPrefixWithSpacing = contextPrefixText ? `${contextPrefixText}\n\n` : "";
    const attachPrefix = allAttachments.length > 0
      ? `[已上传附件: ${allAttachments.map((a) => a.name).join(", ")}，文件已保存到工作区，可读取处理]\n`
      : "";
    // 能力规划必须只基于用户的原始意图、显式引用和结构化 task 字段。
    // 不能把“Agent 可以使用 Skills / Office CLI”之类的 UI 说明混入 text，
    // 否则普通输入也会被关键词规划器误判为 Office / Skills 任务。
    const fullText = contextPrefix + mapContextPrefix + contextPrefixWithSpacing + attachPrefix + (rawText || text);

    if (!mountedRef.current) return;

    const queuedMessageId = source.messageId;
    if (queuedMessageId) {
      patch(queuedMessageId, (m) => ({ ...m, status: "done", queued: false, references: sendReferences }));
    } else {
      setMessages((ms) => [...ms, {
        id: newId(), role: "user", text,
        images: sourceImages.map((i) => i.dataUrl).filter(Boolean),
        attachments: sourceAttachments.map((a) => a.name),
        references: sendReferences,
        status: "done", currentDoc: selectedCurrentDoc,
        createdAt: Date.now(),
      }]);
    }
    setLastPrompt({ text: rawText || text, references: sendReferences, contextText, skills: source.skills || [] });
    const aid = newId();
    cancelTextReveal({ preserveText: true });
    lastAssistantIdRef.current = null;
    assistantIdRef.current = aid;
    lastAssistantIdRef.current = aid;
    streamingMsgIdRef.current = aid;
    streamBufRef.current = { text: "", thinking: "" };
    setMessages((ms) => [...ms, {
      id: aid, role: "assistant", blocks: [],
      status: "streaming", images: [],
      createdAt: Date.now(),
    }]);
    setInput("");
    setImages([]);
    setAttachments([]);
    setInjectedContext([]);
    setBusy(true);
    runInProgressRef.current = true;
    agentErrorRef.current = false;
    activeRunIdRef.current = null;
    agentEventAtRef.current = 0;
    replaceExecutionEvents(runtimeConnectingEventRef.current ? [runtimeConnectingEventRef.current] : []);
    setAgentPhase("准备会话运行时");
    setRunState({ status: "running", runId: null, artifacts: [], references: sendReferences, mode: selectedEditMode });
    try {
      // prompt 是异步 admission；确保本轮 run_admitting/capability_plan/首个 token 不会在
      // EventSource 尚未完成握手时丢失。服务端 channel.history 会按游标回放，
      // 等待只是给握手一个短窗口；SSE 断线时 3 秒后照常发送，事件由重连回放补齐。
      const currentStreamKey = `${clientId}::${threadId || ""}`;
      const streamReady = streamReadyRef.current?.streamKey === currentStreamKey
        ? streamReadyRef.current.promise
        : null;
      if (streamReady) {
        await Promise.race([
          streamReady,
          new Promise((resolve) => window.setTimeout(resolve, 3000)),
        ]);
      }
      const res = await fetch("/api/agent/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client: clientId,
          thread: threadId,
          text: fullText,
          images: imgs,
          attachments: atts,
          references: sendReferences,
          model,
           effort: selectedEffort,
           task: {
             goal: text,
            mode: selectedEditMode,
             workspace,
             projectId: project?.id || null,
             mapProject: mapProject || null,
             currentFile: selectedCurrentDoc || null,
            references: sendReferences,
            workflowId: text.match(/@工作流\[([^\]]+)\]/)?.[1] || null,
          },
        }),
      });
      if (!mountedRef.current) return;
      const d = await res.json().catch(() => ({}));
      if (d.model && d.model !== model) {
        setModel(d.model);
        applyModel(d.model);
        if (d.modelFallbackFrom) {
          setModelMsg(`旧模型连接失败，已恢复到 ${d.model}`);
          window.setTimeout(() => setModelMsg(""), 3600);
        }
      }
      // 上报 pi 会话 id（App 持久化，刷新后恢复当前对话）
      if (d.sessionId) onSessionChange?.(d.sessionId);
      if (d.accepted) {
        if (d.queued) setAgentPhase(`已排队（第 ${d.queuePosition || 1} 项）`);
        else if (!agentEventAtRef.current) {
          setAgentPhase("已接收，等待模型首个事件");
          // 10 秒内没有收到任何 SSE 事件（半开连接/重连失败）：强制重连拉取回放
          const sentAt = agentEventAtRef.current;
          window.setTimeout(() => {
            if (mountedRef.current && agentEventAtRef.current === sentAt && runInProgressRef.current) {
              window.dispatchEvent(new CustomEvent("oaw:force-reconnect"));
            }
          }, 10000);
        }
      }
      if (d.runId) {
        activeRunIdRef.current = d.runId;
        patch(aid, (m) => ({ ...m, runId: d.runId, task: d.task || null, references: d.task?.references || sendReferences }));
        setRunState((s) => ({ ...s, runId: d.runId, references: d.task?.references || sendReferences, task: d.task || s.task }));
      }
      if (!res.ok) {
        patch(aid, (m) => ({ ...m, status: "error", errorText: d.error || "请求失败" }));
        assistantIdRef.current = null;
        lastAssistantIdRef.current = null;
        if (mountedRef.current) setBusy(false);
        setAgentPhase("请求失败");
        setRunState((s) => ({ ...s, status: "failed" }));
      }
    } catch (e) {
      if (!mountedRef.current) return;
      patch(aid, (m) => ({ ...m, status: "error", errorText: "请求未完成：" + e.message }));
      assistantIdRef.current = null;
      lastAssistantIdRef.current = null;
      if (mountedRef.current) setBusy(false);
      setAgentPhase("网络请求失败");
    }
  };

  // 中止当前 agent 运行
  const stop = async () => {
    if (!busy || stoppingRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    try {
      const res = await fetch("/api/agent/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: clientId, thread: threadId }),
      });
      if (!res.ok) throw new Error(`请求失败（${res.status}）`);
      // SSE 正常会收到 aborted；断线时也要让输入框恢复可用。
      window.setTimeout(() => {
        if (stoppingRef.current) finalizeStopped();
      }, 1200);
    } catch (e) {
      stoppingRef.current = false;
      setStopping(false);
      pushSystem(`中断失败：${e.message || "网络错误"}`);
    }
  };

  // 当前回合结束后只启动一条队列消息，避免多个请求同时争抢同一个 Pi 会话。
  const flushQueued = (force = false) => {
    if (stoppingRef.current || (!force && busy) || !queueRef.current.length) return;
    const [next, ...rest] = queueRef.current;
    queueRef.current = rest;
    setQueuedMessages(rest);
    // agent_end 事件先于服务端 prompt finally 到达，留出收尾时间再发下一条，避免被误判为 steer。
    window.setTimeout(() => send(undefined, { force: true, payload: next }), 450);
  };

  const handleMemoryApprove = async (id) => {
    try {
      const d = await approveMemoryProposal(id);
      if (d.proposal) setMessages((ms) => ms.map((m) => m.memoryProposal?.id === id ? { ...m, memoryProposal: d.proposal, text: "长期记忆建议已写入。" } : m));
    } catch (e) {
      setMessages((ms) => ms.map((m) => m.memoryProposal?.id === id ? { ...m, text: `记忆写入失败：${e.message}` } : m));
    }
  };

  const handleRollbackRun = async (runId, paths) => {
    if (!runId || !window.confirm("确认回滚本轮产物？这会恢复修改前的文件内容。")) return;
    try {
      await rollbackRun(runId, paths);
      pushSystem("已回滚本轮可恢复的文件变更。");
      onFileChanged?.(paths || []);
    } catch (e) { pushSystem(`回滚失败：${e.message}`); }
  };

  const handleFiles = async (list) => {
    const addedImgs = [];
    const addedAtts = [];
    const ALLOWED_EXT = /\.(docx|xlsx|pptx|md|markdown|txt|pdf|html|htm|csv|json)$/i;
    for (const f of Array.from(list).slice(0, 6)) {
      if (f.type.startsWith("image/")) {
        try {
          const { mediaType, data } = await fileToBase64(f);
          addedImgs.push({ mediaType, data, dataUrl: `data:${mediaType};base64,${data}`, name: f.name });
        } catch {}
      } else if (ALLOWED_EXT.test(f.name)) {
        try {
          const { mediaType, data } = await fileToBase64(f);
          addedAtts.push({ mediaType, data, dataUrl: `data:${mediaType};base64,${data}`, name: f.name });
        } catch {}
      }
    }
    if (addedImgs.length) setImages((im) => [...im, ...addedImgs]);
    if (addedAtts.length) setAttachments((at) => [...at, ...addedAtts]);
    const count = addedImgs.length + addedAtts.length;
    if (count) {
      setModelMsg(`已加入上下文 ${count} 个文件`);
      setTimeout(() => setModelMsg(""), 2200);
    }
  };

  const handleClipboardPaste = (e) => {
    const files = Array.from(e.clipboardData?.items || [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    handleFiles(files);
  };

  const compactContext = async () => {
    if (busy || compacting) return;
    setCompacting(true);
    setModelMsg("正在压缩上下文…");
    try {
      const result = await compactAgentContext(clientId, threadId);
      setRunState((state) => ({ ...state, usage: null }));
      const before = result.tokensBefore ? `，压缩前约 ${result.tokensBefore.toLocaleString()} tokens` : "";
      setModelMsg(`压缩完成${before}`);
    } catch (e) {
      setModelMsg(`压缩失败：${e.message}`);
    } finally {
      setCompacting(false);
      setTimeout(() => setModelMsg(""), 2800);
    }
  };

  const handleMemoryReject = async (id) => {
    const reason = window.prompt("拒绝原因（可选）", "用户拒绝该记忆建议");
    if (reason === null) return;
    try {
      const d = await rejectMemoryProposal(id, reason);
      if (d.proposal) setMessages((ms) => ms.map((m) => m.memoryProposal?.id === id ? { ...m, memoryProposal: d.proposal, text: "长期记忆建议已拒绝。" } : m));
    } catch (e) {
      setMessages((ms) => ms.map((m) => m.memoryProposal?.id === id ? { ...m, text: `记忆拒绝失败：${e.message}` } : m));
    }
  };

  const injectMapContext = () => {
    if (!mapContext?.center) return;
    const text = `当前地图视图：中心 ${mapContext.center[0]},${mapContext.center[1]}，缩放 ${mapContext.zoom}，可视范围 ${mapContext.bounds?.join(",") || "未知"}。`;
    setInjectedContext((prev) => [...prev, { text }]);
    pushSystem("已将当前地图视图加入待注入上下文。", `map_context:${mapContext.updatedAt || text}`);
  };

  // 消息列表把这些操作作为稳定回调传入 memo 子项；否则每个 SSE 事件都会
  // 生成一组新函数，抵消长历史消息的 memo 优化。
  const handleMessageAskAnswered = useCallback((messageId, blockId, answer) => {
    patch(messageId, (msg) => ({ ...msg, blocks: (msg.blocks || []).map((block) => block.id === blockId ? { ...block, answer } : block) }));
    setBusy(true);
    setAgentPhase("继续执行");
    setRunState((state) => ({ ...state, status: "running" }));
  }, [patch, setAgentPhase]);

  const handleMessageToggleTool = useCallback((messageId, toolId) => {
    patch(messageId, (msg) => {
      const blocks = (msg.blocks || []).map((block, index) => {
        if (block.type === "tool" && (block.id === toolId || (block.id === undefined && index === toolId))) {
          return { ...block, expanded: !block.expanded };
        }
        return block;
      });
      return { ...msg, blocks };
    });
  }, [patch]);

  const resendRef = useRef(null);
  resendRef.current = send;
  const handleMessageResend = useCallback((text) => resendRef.current?.(text), []);

  // 滚动：用户向上滑动查看历史时暂停自动滚动；在底部才自动滚到最新
  const scrollTimerRef = useRef(null);
  const textareaRef = useRef(null);
  const updateScrollFollowState = () => {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    followLatestRef.current = atBottom;
    setShowScrollToBottom(!atBottom && el.scrollHeight > el.clientHeight + 80);
  };
  const scrollToLatest = () => {
    const el = bodyRef.current;
    if (!el) return;
    followLatestRef.current = true;
    setShowScrollToBottom(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };
  useEffect(() => {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      const el = bodyRef.current;
      if (!el || !followLatestRef.current) return;
      // 用用户滚动时记录的跟随意图，而不是在流式内容增高后重新判断距离。
      // 否则回复变长就会让滚动距离超过阈值，后续 token 留在视口外。
      el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    }, 60);
   return () => { if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current); };
  }, [messages]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const maxHeight = 190;
    textarea.style.height = "0px";
    const nextHeight = Math.min(maxHeight, Math.max(70, textarea.scrollHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [input]);

  const hint = currentDoc || "未打开文件";
  const hasDraft = Boolean(input.trim() || images.length || attachments.length);
  const visibleStart = Math.max(0, messages.length - messageWindowSize);
  const visibleMessages = messages.slice(visibleStart);
  const hiddenMessageCount = visibleStart;
  const showExecutionFlow = executionEvents.length > 0 || busy;

  return (
    <ErrorBoundary>
      <div className={`chat${embedded ? " chat-embedded" : ""}`}>
        {/* 会话历史抽屉（对话栏一侧，可折叠隐藏） */}
        <div className={`chat-hist ${histOpen ? "open" : ""}`}>
          <div className="chat-hist-head" onClick={() => setHistOpen((v) => !v)}>
            <span className="chat-hist-chevron">{histOpen ? "▾" : "▸"}</span>
            <Icon name="history" size={12} />
            <span className="chat-hist-title">{historyLoading ? "切换中…" : "历史"}</span>
            <span className="chat-hist-count">{sessions.length}</span>
            <button
              className="btn-xs chat-hist-refresh"
              onClick={(e) => { e.stopPropagation(); onRefreshSessions(); }}
              title="刷新会话"
            ><Icon name="refresh" size={11} /></button>
          </div>
          {histOpen && (
            <div className="chat-hist-list">
              <SessionList
                sessions={sessions}
                unreadByThread={unreadByThread}
                onSelect={async (s) => {
                  if (!onSelectSession || historyLoading) return;
                  setHistoryLoading(true);
                  try { await onSelectSession(s); setHistOpen(false); }
                  finally { setHistoryLoading(false); }
                }}
                onDelete={async (id) => { try { if (onDeleteSession) await onDeleteSession(id); else await deleteSession(id); onRefreshSessions(); } catch (e) { alert("删除失败: " + e.message); } }}
                onBatchDelete={onBatchDeleteSession || (async (ids) => { const result = await deleteSessions(ids); onRefreshSessions(); return result; })}
                onRename={async (id, label) => { try { await renameSession(id, label); onRefreshSessions(); } catch (e) { alert("重命名失败: " + e.message); } }}
                onFork={onForkSession || (async (id) => { try { await forkSession(id); onRefreshSessions(); } catch (e) { alert("创建分支失败: " + e.message); } })}
                onPin={onPinSession}
                onFreeze={onFreezeSession}
              />
            </div>
          )}
        </div>
        <div className="chat-head">
          <span className="chat-title"><Logo size={16} /> {panelTitle}</span>
          <span className={`chat-mode-badge mode-${editMode}`} title={currentMode.title}>
            <Icon name={currentMode.icon} size={11} /> {currentMode.label}
          </span>
          {onPromoteToAgent && lastPrompt && editMode === "chat" && (
            <button
              className="btn-xs chat-promote-btn"
              onClick={() => onPromoteToAgent(lastPrompt)}
              title="保留本轮问题与引用，转到 Agent 执行"
            >转为 Agent</button>
          )}
          {project?.type && <span className="chat-project-badge" title={`项目分类：${project.type}`}>
            {project.type}
          </span>}
          <span className={`conn ${connected ? "on" : ""}`}>{connected ? "已连接" : "连接中..."}</span>
          <span className="doc-hint" title={hint}>{hint}</span>
        </div>
        <div className="task-status-bar" role="status" aria-live="polite">
          <span className={`task-status-dot ${runState.status}`} />
          <span>{frozen ? "会话已冻结" : runState.status === "running" ? (agentPhase || "任务执行中") : runState.status === "finishing" ? "整理产物" : runState.status === "recovering" ? "等待恢复" : runState.status === "cancel_requested" ? "正在取消" : runState.status === "cancelled" ? "任务已取消" : runState.status === "aborted" ? "任务已中断" : runState.status === "failed" ? "任务失败" : runState.status === "completed" ? "任务已完成" : "待命"}</span>
          <span className="task-status-meta task-mode-meta">{MODE_META[normalizeUiMode(runState.mode || editMode)]?.label || currentMode.label}</span>
          {runState.thinkingLevel && <span className="task-status-meta">推理 {runState.thinkingLevel === "low" ? "快速" : runState.thinkingLevel === "high" ? "深度" : runState.thinkingLevel}</span>}
           {selectedUsage.context > 0 && <span className="task-status-meta" title={`当前上下文约 ${Number(selectedUsage.context).toLocaleString()} tokens`}>上下文 {Math.round(Number(selectedUsage.context) / 1000)}k</span>}
          {runState.runId && <code title={runState.runId}>{runState.runId.slice(0, 18)}</code>}
          {runState.references?.length > 0 && <span className="task-status-meta">引用 {runState.references.length}</span>}
          {runState.artifacts?.length > 0 && <span className="task-status-meta">产物 {runState.artifacts.length}</span>}
          {runState.verificationStatus && runState.verificationStatus !== "not_checked" && <span className={`task-status-meta verification-${runState.verificationStatus}`}>产物校验 {runState.verificationStatus === "passed" ? "通过" : runState.verificationStatus === "warning" ? "有提示" : "失败"}</span>}
        </div>
        {(editMode === "agent" || editMode === "review") && (
          <details className="agent-capability-preview" title="本轮 Agent 启动前能力预览">
            <summary><span>{editMode === "review" ? "Review" : "Work"}</span><span>能力已就绪 · 点击查看配置</span></summary>
            <div className="agent-capability-details">
              <span>Profile：{project?.settings?.agentProfile || project?.agentProfile || "通用 Agent"}</span>
              <span>模型：{model || defaultModel || "按 Pi 配置"}</span>
              <span>Skills：{project?.settings?.skills?.length ? `${project.settings.skills.length} 项` : "按任务加载"}</span>
              <span>Office CLI：{editMode === "review" ? "读取材料/副本批注" : "自动判断"}</span>
              <span>写入：{editMode === "review" ? "确认前保护原文" : "受运行环境权限控制"}</span>
            </div>
          </details>
        )}

        <div className="chat-stream-shell">
          <div className="chat-topbar">
            {showExecutionFlow && <ExecutionFlow events={executionEvents} running={busy} onFocusTool={focusTool} />}
            <div className="chat-top-controls" aria-label="会话控制">
              <ContextUsageRing
                usage={runState.usage}
                contextWindow={selectedContextWindow}
                contextTokens={selectedUsage.context}
                compactThreshold={selectedCompactThreshold}
                compactionMode={selectedCompactionMode}
                model={selectedModelInfo}
                compacting={compacting}
                busy={busy}
                onCompact={compactContext}
              />
              <ApprovalModeControl mode={approvalMode} saving={approvalModeSaving} onChange={changeApprovalMode} />
            </div>
          </div>
          <div className="chat-body" ref={bodyRef} onScroll={updateScrollFollowState}>
          {messages.length === 0 && (
            <div className="chat-empty">
              <div>发送消息给 agent</div>
              <div className="hint">
                示例: 「把标题改成红色加粗」<br />
                「在 test-data.xlsx 的 B3 填 88」<br />
                粘贴图片可辅助说明（需选择 [V] 模型）
              </div>
            </div>
          )}
          {hiddenMessageCount > 0 && (
            <button className="chat-load-older" type="button" onClick={() => setMessageWindowSize((size) => size + MESSAGE_PAGE_SIZE)}>
              加载更早的 {Math.min(MESSAGE_PAGE_SIZE, hiddenMessageCount)} 条消息（前面还有 {hiddenMessageCount} 条）
            </button>
          )}
          {historyWindow?.hasMore && (
            <div className="chat-history-window-note" role="status">
              历史较长，当前先加载最近 {historyWindow.end - historyWindow.start} 条以保持切换流畅；模型仍使用完整 Pi 会话上下文。
            </div>
          )}
           {visibleMessages.map((m, i) => (
            <React.Fragment key={m.id}>
              <MemoMessage m={m} index={visibleStart + i} prevRole={visibleMessages[i - 1]?.role} model={model} agentPhase={agentPhase} clientId={clientId} threadId={threadId} onOpenFile={onOpenFile} onMemoryApprove={handleMemoryApprove} onMemoryReject={handleMemoryReject} onRollbackRun={handleRollbackRun} onAskAnswered={handleMessageAskAnswered} onResend={handleMessageResend} onToggleTool={handleMessageToggleTool} />
            </React.Fragment>
           ))}
          </div>
          {showScrollToBottom && (
            <button type="button" className="chat-scroll-latest" onClick={scrollToLatest} title="回到底部" aria-label="回到底部">
              <Icon name="chevronDown" size={13} />
              <span>回到底部</span>
            </button>
          )}
          {/* 会话消息目录栏：收纳在聊天滚动区右侧，靠近滚动条；悬停显示摘要 */}
          {loadSettings().showTimeline !== false && <ChatTimeline messages={visibleMessages} containerRef={bodyRef} />}
        </div>

        {images.length > 0 && !modelVision && (
          <div className="vision-hint">当前模型可能不支持图片，建议切换 [V] 模型</div>
        )}
        {images.length > 0 && (
          <div className="img-preview-row">
            {images.map((img, i) => (
              <div className="img-chip" key={i}>
                <img src={img.dataUrl} alt={img.name} />
                <button onClick={() => setImages((im) => im.filter((_, j) => j !== i))}>x</button>
              </div>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="att-preview-row">
            {attachments.map((att, i) => (
              <div className="att-chip" key={i} title={att.name}>
                <Icon name="file" size={13} />
                <span className="att-name">{att.name}</span>
                <button className="att-remove" onClick={() => setAttachments((at) => at.filter((_, j) => j !== i))}>
                  <Icon name="x" size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        {references.length > 0 && (
          <div className="reference-bar" aria-label="本轮引用">
            <span className="reference-bar-label">引用</span>
            {references.map((ref) => (
              <span className="reference-chip" key={ref.id} title={ref.target}>
                <span className="reference-chip-kind">{ref.kind === "session" ? "&" : "@"}</span>{ref.target}
                <button type="button" onClick={() => setReferences((prev) => prev.filter((r) => r.id !== ref.id))} aria-label={`移除引用 ${ref.target}`}>×</button>
              </span>
            ))}
          </div>
        )}
        {(queuedMessages.length > 0 || injectedContext.length > 0) && (
          <div className="chat-pending-bar" aria-live="polite">
            {queuedMessages.length > 0 && <span><Icon name="list" size={12} /> 待执行 {queuedMessages.length} 条</span>}
            {injectedContext.length > 0 && <span><Icon name="layers" size={12} /> 待注入上下文 {injectedContext.length} 条</span>}
            {queuedMessages.length > 0 && !busy && <button type="button" onClick={() => flushQueued()} title="继续执行队列">继续队列</button>}
            {queuedMessages.length > 0 && <button type="button" onClick={() => { queueRef.current = []; setQueuedMessages([]); }} title="清空待执行消息">清空</button>}
          </div>
        )}
        <div className="chat-input">
          {todoItems.length > 0 && <TaskProgressCard tasks={todoItems} running={busy} />}
          {busy && (
            <div className="busy-input-mode" role="group" aria-label="当前任务中的新输入处理方式">
              <span>当前任务中新输入：</span>
              <button type="button" className={busyInputMode === "steer" ? "active" : ""} onClick={() => setBusyInputMode("steer")} title="打断当前回合，立即执行新指令">立即执行</button>
              <button type="button" className={busyInputMode === "queue" ? "active" : ""} onClick={() => setBusyInputMode("queue")}>排队执行</button>
              <button type="button" className={busyInputMode === "context" ? "active" : ""} onClick={() => setBusyInputMode("context")}>注入上下文</button>
              <small>{busyInputMode === "steer" ? "打断当前回合，插入新指令" : busyInputMode === "queue" ? "本轮完成后自动开始" : "保存到下一轮，不打断当前任务"}</small>
            </div>
          )}
          <div className="chat-input-row">
            {composerMenu && composerItems.length > 0 && (
              <div className="composer-suggestions" role="listbox" aria-label="输入建议">
                {composerItems.map((item, index) => (
                  <button
                    key={item.insert}
                    type="button"
                    role="option"
                    aria-selected={index === composerIndex}
                    className={index === composerIndex ? "active" : ""}
                    onMouseDown={(e) => { e.preventDefault(); insertComposerItem(item); }}
                  >
                    <span className="composer-suggestion-main">{item.insert}</span>
                    <span className="composer-suggestion-label">{item.label}</span>
                    <small>{item.hint}</small>
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={input}
              disabled={frozen}
              placeholder={frozen ? "会话已冻结，可新建分支继续分析" : busy ? "输入后可排队执行，或仅注入下一轮上下文…" : "输入消息…  @ 引用文件，/ 调用 Skill，# 使用能力，& 引用会话"}
              onKeyDown={(e) => {
                if (composerMenu && composerItems.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                  e.preventDefault();
                  setComposerIndex((index) => (index + (e.key === "ArrowDown" ? 1 : -1) + composerItems.length) % composerItems.length);
                  return;
                }
                if (composerMenu && composerItems.length && e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  insertComposerItem(composerItems[composerIndex]);
                  return;
                }
                if (composerMenu && e.key === "Escape") {
                  e.preventDefault();
                  setComposerMenu(null);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              onCompositionEnd={() => {}}
              onPaste={(e) => {
                handleClipboardPaste(e);
              }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
              onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer?.files || []); }}
              onChange={(e) => {
                const value = e.target.value;
                setInput(value);
                setComposerMenu(composerTrigger(value));
              }}
            />
            <div className="input-send">
              {busy ? (
                <>
                  {hasDraft && <button className="btn primary pending-send-btn" onClick={() => send()} title={busyInputMode === "steer" ? "打断当前回合立即执行（Enter）" : busyInputMode === "queue" ? "排队执行（Enter）" : "注入上下文（Enter）"}>
                    <Icon name={busyInputMode === "steer" ? "send" : busyInputMode === "queue" ? "list" : "layers"} size={13} />
                    <span>{busyInputMode === "steer" ? "立即" : busyInputMode === "queue" ? "排队" : "注入"}</span>
                  </button>}
                  <button className="btn danger stop-btn" onClick={stop} disabled={stopping} title={stopping ? "正在中断当前回复" : "中断当前回复"} aria-label={stopping ? "正在中断当前回复" : "中断当前回复"}>
                    <Icon name={stopping ? "loading" : "stop"} size={14} className={stopping ? "icon-loading" : ""} />
                    <span>{stopping ? "中断中" : "中断"}</span>
                  </button>
                </>
              ) : (
                <button className="btn primary send-btn" onClick={() => send()} disabled={frozen} title={frozen ? "会话已冻结" : "发送 (Enter)"}><Icon name="send" size={14} /></button>
              )}
            </div>
          </div>
          {/* 工具栏按“上下文 / Agent 设置 / 会话”分组；Chat / Work 已移到顶栏 */}
          <div className="chat-toolbar">
            <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
            <input ref={attInputRef} type="file" accept=".docx,.xlsx,.pptx,.md,.markdown,.txt,.pdf,.html,.htm,.csv,.json" multiple hidden onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
            <div className="chat-toolbar-group toolbar-context-group" title="上下文工具">
              <span className="chat-toolbar-label">上下文</span>
              <button className="ct-btn" title="上传图片" onClick={() => fileInputRef.current?.click()}>
                <Icon name="image" size={14} />
              </button>
              <button className="ct-btn" title="上传附件（docx/xlsx/pdf/md/txt 等）" onClick={() => attInputRef.current?.click()}>
                <Icon name="link" size={14} />
              </button>
              {mapContext?.center && <button className="ct-btn" title="将当前地图视图加入下一轮上下文" onClick={injectMapContext}>
                <Icon name="locate" size={14} />
              </button>}
              <button className={`ct-btn ct-context-btn ${compacting ? "active" : ""}`} title={busy ? "当前任务完成后才能压缩上下文" : "压缩当前 Pi 会话上下文，保留任务摘要"} onClick={compactContext} disabled={busy || compacting}>
                <Icon name={compacting ? "loading" : "layers"} size={14} />
                <span>压缩</span>
              </button>
            </div>
            <span className="ct-sep" />
            {/* 模型与思考程度：一个 Proma 式统一入口，底层仍使用 Pi 配置 */}
            <div className="chat-toolbar-group toolbar-agent-group" title="Agent 设置：模型与思考程度">
              <span className="chat-toolbar-label">Agent</span>
              <div className="ct-popwrap model-control-wrap">
                <button className={`model-control-trigger ${modelOpen ? "active" : ""}`} onClick={() => setModelOpen((value) => !value)} title={model ? `模型：${modelDisplayName(selectedModelInfo)}，思考：${selectedEffort.shortLabel}` : "选择模型与思考程度"}>
                  <ModelProviderMark model={selectedModelInfo} size={18} />
                  <span className="model-control-current">
                    <strong>{modelDisplayName(selectedModelInfo)}</strong>
                    <small>{selectedEffort.shortLabel}</small>
                  </span>
                  <Icon name="chevronDown" size={11} />
                </button>
                {modelOpen && (
                  <div className="ct-pop model-control-pop">
                    <div className="model-control-head">
                      <div><ModelProviderMark model={selectedModelInfo} size={22} /><span><strong>{selectedProviderMeta.label}</strong><small>{model || "按 Pi 配置"}</small></span></div>
                      <span className="model-control-status">{selectedModelInfo?.available === false ? "不可用" : "可用"}</span>
                    </div>
                    <input
                      className="ct-pop-search"
                      placeholder="搜索模型…"
                      value={modelQ}
                      onChange={(e) => setModelQ(e.target.value)}
                      autoFocus
                    />
                    <div className="ct-pop-list model-control-list">
                      <button type="button" className="ct-pop-refresh" onClick={async (e) => { e.stopPropagation(); setModelMsg("扫描中…"); try { const d = await fetch("/api/models/refresh", { method: "POST" }).then((x) => x.json()); if (d.ok) { setModels(d.models || []); if (d.counts) setModelCounts(d.counts); setModelMsg(`可用 ${d.counts?.available ?? d.count ?? 0} / 配置 ${d.counts?.configured ?? "?"}`); } else setModelMsg("扫描失败: " + (d.error || "")); } catch (err) { setModelMsg("扫描失败: " + err.message); } setTimeout(() => setModelMsg(""), 2500); }} title="重新扫描 Pi 模型目录与可用模型">
                        <Icon name="refresh" size={11} /> 重新扫描模型 <small>可用 {modelCounts.available || "—"}</small>
                      </button>
                      {modelGroups.map(([provider, providerModels]) => (
                        <div className="model-provider-group" key={provider}>
                          <div className="model-provider-heading"><span><ModelProviderMark model={providerModels[0]} size={15} /> {modelProviderMeta(providerModels[0]).label}</span><small>{providerModels.length}</small></div>
                          {providerModels.map((m) => (
                            <button
                              type="button"
                              key={m.id}
                              className={`ct-pop-item model-option ${model === m.id ? "active" : ""} ${m.available === false ? "disabled" : ""}`}
                              onClick={() => { if (m.available === false) return; changeModel(m.id); setModelOpen(false); }}
                              title={m.id}
                              disabled={m.available === false}
                            >
                              <ModelProviderMark model={m} size={17} />
                              <span><strong>{modelDisplayName(m)}</strong><small>{m.vision ? "支持图片" : "文本"} · {m.id}</small></span>
                              {model === m.id && <Icon name="check" size={12} />}
                            </button>
                          ))}
                        </div>
                      ))}
                      {!modelGroups.length && <div className="ct-pop-empty">没有匹配的模型</div>}
                    </div>
                    <div className="model-thinking-control">
                      <div className="model-thinking-head"><span><Icon name="info" size={12} /> 思考深度</span><strong>{selectedEffort.label}</strong></div>
                      <input
                        type="range"
                        min="0"
                        max={THINKING_OPTIONS.length - 1}
                        step="1"
                        value={selectedEffortIndex}
                        aria-label="思考深度"
                        aria-valuetext={`${selectedEffort.label}（${selectedEffort.desc}）`}
                        onChange={(e) => { const next = THINKING_OPTIONS[Number(e.target.value)] || THINKING_OPTIONS[0]; setEffort(next.id); localStorage.setItem(THINKING_KEY, next.id); }}
                      />
<div className="model-thinking-scale">{THINKING_OPTIONS.map((item) => <span key={item.id} className={item.id === effort ? "active" : ""}>{item.label}</span>)}</div>
                      <small className="model-thinking-desc">{selectedEffort.desc}</small>
                      <small className="model-thinking-hint">高/最大档位会让模型首响应明显变慢，适合复杂任务；简单问答建议用低/标准</small>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <span className="chat-toolbar-spacer" />
            <div className="chat-toolbar-group toolbar-session-group">
              <button className="ct-btn" onClick={handleNewSession} title="新建会话">
                <Icon name="plus" size={14} />
              </button>
            </div>
            {modelMsg && <span className="model-msg">{modelMsg}</span>}
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
});

// ========== 超大消息保护：>100KB 转点击展开，避免 markdown 渲染卡死 ==========
const MAX_MARKDOWN_CHARS = 100000;

function SafeMarkdown({ text }) {
  const [showRaw, setShowRaw] = useState(false);
  if (!text) return null;
  if (text.length <= MAX_MARKDOWN_CHARS) return <MarkdownBody>{text}</MarkdownBody>;
  if (!showRaw) {
    return (
      <button className="large-msg-reveal" onClick={() => setShowRaw(true)}>
        ⚠ 内容过长（{(text.length / 1024).toFixed(0)} KB），点击查看全文
      </button>
    );
  }
  return <pre className="large-msg-raw">{text}</pre>;
}

function RunSummary({ m, onOpenFile, onRollbackRun }) {
  const statusLabel = m.runStatus === "failed" ? "失败" : m.runStatus === "cancelled" ? "已取消" : m.runStatus === "running" ? "执行中" : "已完成";
  const modeLabel = m.runMode === "chat" ? "Chat" : m.runMode === "review" ? "Review" : m.runMode === "office" ? "Office" : "Work";
  const time = m.createdAt ? formatMsgTime(m.createdAt) : "";
  const title = String(m.conclusion || m.text || m.task?.text || m.task?.goal || "本轮任务")
    .replace(/^\s*#{1,6}\s*/, "")
    .trim() || "本轮任务";
  // 每一轮结束后直接展示结论和产物；用户仍可点击标题收起，
  // 但恢复历史时不再把所有轮次默认藏在“查看本轮”里。
  const [open, setOpen] = useState(m.expanded !== false);
  // 历史 Run 的工具聚合：从 run.events 归约，不必依赖实时事件流
  const trace = useMemo(() => (Array.isArray(m.events) && m.events.length ? reduceRunTrace(m.events, m.runId) : null), [m.events, m.runId]);
  const traceSummary = trace ? runTraceSummaryText(trace) : "";
  const completion = m.completion || trace?.completion || null;
  const reviewSources = useMemo(() => {
    const sourceMap = new Map((Array.isArray(m.reviewSources) ? m.reviewSources : []).map((item) => [item.sourceId, { ...item }]));
    for (const event of Array.isArray(m.events) ? m.events : []) {
      const data = event?.data || {};
      if (event?.type === "review_source_read" && data.sourceId) sourceMap.set(data.sourceId, { ...(sourceMap.get(data.sourceId) || {}), ...data });
      if (["review_source_applied", "review_source_unused"].includes(event?.type) && data.sourceId) {
        sourceMap.set(data.sourceId, { ...(sourceMap.get(data.sourceId) || {}), ...data, status: event.type === "review_source_applied" ? "applied" : "read-not-applied" });
      }
    }
    return [...sourceMap.values()].filter((item) => item.sourceId);
  }, [m.events, m.reviewSources]);
  const [toolsOpen, setToolsOpen] = useState(false);
  return (
    <div className="msg system summary-msg">
      <div className="bubble run-summary-bubble">
        <div className="run-summary-header">
          <span className={`run-summary-dot ${m.runStatus || "done"}`} />
          <strong>任务轮次 {m.runIndex ? `${m.runIndex}/${m.runCount || m.runIndex}` : ""}</strong>
          <span className="run-summary-title" title={title}>{title}</span>
          <span className="run-summary-meta">
            {modeLabel} · {statusLabel}
            {completion && (
              <span
                className={`flow-completion ${completion.status}`}
                title={completion.source === "inferred" ? "由回合结束推断（模型未显式声明完成状态）" : `模型显式声明${completion.summary ? `：${completion.summary}` : ""}`}
              >
                {completionLabel(completion.status)}{completion.source === "inferred" ? "（推断）" : ""}
              </span>
            )}
            {traceSummary ? ` · ${traceSummary}` : (m.eventCount ? ` · 过程 ${m.eventCount} 事件` : "")}{time ? ` · ${time}` : ""}
          </span>
        </div>
        <details className="run-summary-details" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
          <summary>查看本轮对话与产物</summary>
          {m.text && m.text.trim() !== title && <div className="run-summary-content">{m.text}</div>}
          {m.products?.length > 0 && (
            <div className="file-change-summary">
              <span className="file-change-label"><Icon name="folder" size={11} /> 本轮产物（{m.products.length}）</span>
              {m.workspace && <small className="summary-workspace" title={m.workspace}>工作区：{m.workspace}</small>}
              <div className="summary-products">
                {m.products.map((p) => (
                  <span key={p} className="summary-product clickable" onClick={() => onOpenFile?.(p)} title={`点击打开 ${p}`}>
                    <Icon name="file" size={11} /> {p}
                  </span>
                ))}
              </div>
            </div>
          )}
          {m.artifacts?.length > 0 && (
            <div className="run-artifacts">
              {m.artifacts.map((a) => <div key={a.path} className="run-artifact-row"><span>{a.status === "added" ? "新增" : a.status === "deleted" ? "删除" : "修改"}</span> <code>{a.path}</code>{a.before?.reversible && <span className="artifact-reversible">可回滚</span>}</div>)}
              {m.runId && m.artifacts.some((a) => a.before?.reversible) && <button className="btn-xs" onClick={() => onRollbackRun?.(m.runId, m.artifacts.map((a) => a.path))}>回滚本轮</button>}
            </div>
          )}
          {trace?.tools?.length > 0 && (
            <div className="run-trace-tools">
              <button type="button" className="run-trace-tools-toggle" onClick={() => setToolsOpen((value) => !value)} aria-expanded={toolsOpen}>
                <span className="file-change-label"><Icon name="flow" size={11} /> 本轮工具（{trace.tools.length}）</span>
                <span className="run-trace-tools-chevron">{toolsOpen ? "▾" : "▸"}</span>
              </button>
              {toolsOpen && <div className="run-trace-tool-list">
                {trace.tools.map((tool) => (
                  <span
                    key={tool.id}
                    className={`run-trace-tool ${tool.status !== "done" ? "running" : tool.isError ? "error" : "ok"}`}
                    title={tool.result || tool.output || tool.input || ""}
                  >
                    {tool.name}{tool.startMissing ? "（已恢复）" : ""}
                  </span>
                ))}
              </div>}
            </div>
          )}
          {m.runMode === "review" && reviewSources.length > 0 && (
            <div className="review-source-summary">
              <div className="file-change-label"><Icon name="shield" size={11} /> 规范依据（已读取 {reviewSources.length}）</div>
              <div className="review-source-list">
                {reviewSources.map((source) => (
                  <div className="review-source-row" key={source.sourceId}>
                    <strong>{source.sourceId}</strong>
                    <span title={`${source.relPath || ""}${source.rootName ? ` @ ${source.rootName}` : ""}`}>{source.title || source.relPath}</span>
                    <em className={`review-source-status ${source.status || "read"}`}>{source.status === "applied" ? "已采用" : source.status === "read-not-applied" ? "未采用" : source.status === "failed" ? "读取失败" : "已读取"}</em>
                  </div>
                ))}
              </div>
            </div>
          )}
        </details>
      </div>
    </div>
  );
}

// ========== 消息组件（Proma 风格：头部 + 无气泡长文 AI / 淡色气泡用户） ==========
function Message({ m, model, agentPhase, onToggleTool, onOpenFile, onMemoryApprove, onMemoryReject, onRollbackRun, onAskAnswered, onResend, index, prevRole, clientId, threadId }) {
  if (m.role === "system") {
    if (m.summary) return <RunSummary m={m} onOpenFile={onOpenFile} onRollbackRun={onRollbackRun} />;
    return (
      <div className="msg system">
        <div className="bubble">
          {m.text}
          {m.memoryProposal && (
            <div className="memory-proposal-card" role="note">
              <div><strong>{m.memoryProposal.section}</strong>：{m.memoryProposal.content}</div>
              {m.memoryProposal.status === "pending" ? (
                <><button className="btn-xs primary" onClick={() => onMemoryApprove?.(m.memoryProposal.id)}>确认写入记忆</button><button className="btn-xs" onClick={() => onMemoryReject?.(m.memoryProposal.id)}>拒绝</button></>
              ) : <span className="memory-proposal-state">{m.memoryProposal.status === "approved" ? "✓ 已写入" : "未写入"}</span>}
            </div>
          )}
        </div>
      </div>
    );
  }
  const isUser = m.role === "user";
  const blocks = m.blocks || [];
  const streaming = m.status === "streaming";
  // 相邻同角色消息精简头部（连续 AI 回复/连续用户消息不再重复显示作者与时间）
  const hideHeader = prevRole === m.role;
  const hasContent = blocks.length > 0 || m.images?.length > 0;
  const [copied, setCopied] = useState(false);
  const [waitSec, setWaitSec] = useState(0);

  // 等待首个内容块：显示"正在思考..." + 耗时计时
  useEffect(() => {
    if (!streaming || hasContent) return;
    setWaitSec(0);
    const t = setInterval(() => setWaitSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [streaming, hasContent]);

  const copyText = async () => {
    try {
      const allText = blocks.map((b) => b.type === "text" ? b.text : b.type === "tool" ? (b.name + " " + (b.input || "")) : "").join("\n");
      await navigator.clipboard.writeText(allText || m.text || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const actionsVisible = (hasContent || m.errorText || m.stopped) && !streaming;

  return (
    <div className={`msg ${isUser ? "user" : "assistant"} ${m.status || ""}`} data-msg-index={index}>
      <div className={`avatar ${isUser ? "user-avatar" : "agent-avatar"}`}>
        <Icon name={isUser ? "user" : "robot"} size={14} />
      </div>
      <div className="msg-main">
        {/* 消息头：作者 + 时间（相邻同角色消息省略，减少重复气泡头部） */}
        {!hideHeader && (
        <div className="msg-header">
          <span className="msg-author">{isUser ? "You" : (model || "Agent")}</span>
          <span className="msg-time">{formatMsgTime(m.createdAt || Date.now())}</span>
          {!isUser && streaming && <span className="msg-streaming-badge"><StreamingDot /> 生成中</span>}
          {!isUser && m.status === "error" && <span className="msg-error-badge">生成失败</span>}
          {!isUser && m.stopped && <span className="msg-stopped-badge">已停止生成</span>}
        </div>
        )}
        {isUser ? (
          <div className="bubble user-bubble">
            {m.images?.length > 0 && (
              <div className="msg-images">{m.images.map((src, i) => <img key={i} src={src} alt="" />)}</div>
            )}
            {m.currentDoc && <div className="msg-context">当前文件: {m.currentDoc}</div>}
            {m.references?.length > 0 && <ReferenceChips references={m.references} onOpenFile={onOpenFile} />}
            {m.text && <div className="msg-text">{m.text}</div>}
          </div>
        ) : (
          <>
            {m.images?.length > 0 && (
              <div className="msg-images assistant-images">{m.images.map((src, i) => <img key={i} src={src} alt="Agent 附图" />)}</div>
            )}
            {/* 独立条目流（pi-web BlockView 模型）：思考/工具调用/文本按原始顺序各自成条目，不包裹分组框 */}
            <div className="msg-blocks">
              {blocks.map((b, i) => {
                if (b.type === "thinking") return <ThinkingBlock key={i} text={b.text} startTime={b.startTime} streaming={streaming} />;
                if (b.type === "tool") return <ToolCard key={b.id || i} tool={b} onToggle={() => onToggleTool?.(m.id, b.id || i)} />;
                if (b.type === "ask") return <AskBlock key={b.id || i} block={b} clientId={clientId} threadId={threadId} onAnswered={(blockId, answer) => onAskAnswered?.(m.id, blockId, answer)} />;
                if (b.type === "approval") return <ApprovalBlock key={b.id || i} block={b} />;
                if (b.type === "text") return (
                  <div className="flow-markdown" key={i}>
                    {streaming
                      ? <div className="flow-stream-text" aria-live="polite">{b.text}</div>
                      : <SafeMarkdown text={b.text} />}
                  </div>
                );
                return null;
              })}
            </div>
            {m.references?.length > 0 && <ReferenceChips references={m.references} onOpenFile={onOpenFile} />}
            {/* 流式等待首块：思考中 + 耗时 */}
            {streaming && !hasContent && (
              <div className="bubble loading-bubble">
                <LoadingDots label={agentPhase || "正在思考"} seconds={waitSec} />
              </div>
            )}
            {/* 流式收尾：呼吸脉冲圆点 */}
            {streaming && hasContent && <StreamingDot />}
            {/* 已停止 / 错误标记 */}
            {m.status === "error" && <div className="err-badge" title={m.errorText}>{m.errorText || "处理失败，请重试"}</div>}
          </>
        )}
        {/* 操作条：常显微透明，hover 加深（Proma MessageActions 风格） */}
        {actionsVisible && (
          <div className="msg-actions">
            <button className="msg-action" onClick={copyText} title="复制">
              {copied ? <Icon name="check" size={12} /> : <Icon name="copy" size={12} />}
              <span>{copied ? "已复制" : "复制"}</span>
            </button>
            {isUser && (
              <button className="msg-action" onClick={() => onResend && onResend(m.text)} title="重新发送">
                <Icon name="refresh" size={12} />
                <span>重发</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// 流式消息变化时只重新计算被 patch 的那一条；长会话的历史 Markdown、工具卡
// 不应随每个 token 一起重新渲染。操作回调保持稳定，工作区/线程真正变化时
// 则仍由 onOpenFile、threadId 等关键属性触发必要更新。
const MemoMessage = React.memo(Message, (previous, next) => {
  const phaseChangedWhileWaiting = (previous.m?.status === "streaming" || next.m?.status === "streaming")
    && previous.agentPhase !== next.agentPhase;
  return previous.m === next.m
    && previous.model === next.model
    && previous.index === next.index
    && previous.prevRole === next.prevRole
    && previous.clientId === next.clientId
    && previous.threadId === next.threadId
    && previous.onOpenFile === next.onOpenFile
    && !phaseChangedWhileWaiting;
});

function ReferenceChips({ references = [], onOpenFile }) {
  if (!references.length) return null;
  return (
    <div className="msg-references" aria-label="本轮引用">
      {references.map((r) => {
        const label = r.metadata?.name || r.metadata?.relativePath || r.target;
        const canOpen = r.kind === "file" && !!onOpenFile && r.status !== "missing";
        const content = <><Icon name="file" size={10} /> @{label}</>;
        return canOpen ? (
          <button type="button" className={`msg-reference-chip ${r.status || ""}`} key={r.id} onClick={() => onOpenFile(r.metadata?.relativePath || r.target)} title={`打开引用：${label}`}>{content}</button>
        ) : (
          <span className={`msg-reference-chip ${r.status || ""}`} key={r.id} title={r.message || label}>{content}</span>
        );
      })}
    </div>
  );
}

// ========== 流式指示器：呼吸脉冲圆点（Proma StreamingIndicator） ==========
function StreamingDot() {
  return <span className="streaming-dot" title="生成中" />;
}

// ========== 等待指示器：弹跳点 + 耗时（Proma MessageLoading） ==========
function LoadingDots({ label, seconds }) {
  return (
    <span className="loading-dots">
      <span className="ldot" /><span className="ldot" /><span className="ldot" />
      <span className="loading-label">{label}…</span>
      {seconds > 0 && <span className="loading-elapsed">{seconds}s</span>}
    </span>
  );
}

// ========== 思考过程块（默认展开，固定高度，超出内容内部滚动） ==========
function ThinkingBlock({ text, startTime, streaming }) {
  const [expanded, setExpanded] = useState(true);
  const [duration, setDuration] = useState(null);

  // 流式结束时：计算耗时
  useEffect(() => {
    if (streaming) return;
    if (startTime) setDuration(((Date.now() - startTime) / 1000).toFixed(1));
  }, [streaming, startTime]);

  return (
    <div className={`thinking-block ${expanded ? "expanded" : ""}`} onClick={() => setExpanded((v) => !v)}>
      <div className="thinking-header">
        <span className="thinking-icon">{expanded ? "▾" : "▸"}</span>
        <span className="thinking-label"><Icon name="info" size={11} /> 思考</span>
        {streaming && <span className="thinking-status">思考中…</span>}
        {!streaming && duration && <span className="thinking-status">思考了 {duration}s</span>}
        {!streaming && !duration && <span className="thinking-status">{text.length} 字</span>}
      </div>
      {expanded && <div className="thinking-text">{text}</div>}
    </div>
  );
}

// ========== 主动提问卡片（ask_user：agent 遇不明确处询问用户） ==========
function AskBlock({ block, clientId, threadId, onAnswered }) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const submit = async (text) => {
    const answer = (text || "").trim();
    if (!answer || sending) return;
    setSending(true);
    setError("");
    try {
      const res = await fetch("/api/agent/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: clientId, thread: threadId, answer }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || `回答失败（${res.status}）`);
      onAnswered?.(block.id, answer);
      setInput("");
    } catch (e) {
      setError(e.message || "回答失败，请重试");
    }
    setSending(false);
  };

  return (
    <div className={`ask-block ${block.answer ? "answered" : ""}`}>
      <div className="ask-head">
        <Icon name="comment" size={12} />
        <span className="ask-title">需要你确认</span>
        {block.answer && <span className="ask-status">✓ 已回答</span>}
      </div>
      <div className="ask-question">{block.question}</div>
      {block.answer ? (
        <div className="ask-answer">你的回答：{block.answer}</div>
      ) : (
        <>
          {block.options?.length > 0 && (
            <div className="ask-options">
              {block.options.map((opt, i) => (
                <button key={i} className="ask-opt" onClick={() => submit(opt)}>{opt}</button>
              ))}
            </div>
          )}
          <div className="ask-input-row">
            <input
              className="ask-input"
              placeholder="输入你的回答…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(input); } }}
            />
            <button className="btn primary ask-submit" onClick={() => submit(input)} disabled={sending}>
              {sending ? "…" : "发送"}
            </button>
          </div>
          {error && <div className="ask-error" role="alert">{error}</div>}
        </>
      )}
    </div>
  );
}

// ========== 工具审批卡片（opencode 式：允许一次 / 总是允许 / 拒绝） ==========
function ApprovalBlock({ block }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const toolNames = {
    officecli: "Office CLI", bash: "命令", write: "写入文件", map_edit: "地图样式编辑", map_import: "地图数据导入",
  };
  const toolLabel = toolNames[String(block.tool).toLowerCase()] || block.tool || "工具";

  const decide = async (decision) => {
    if (sending || block.decision) return;
    setSending(true);
    setError("");
    try {
      const res = await fetch("/api/agent/approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: block.id, decision }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || `审批提交失败（${res.status}）`);
    } catch (e) {
      setError(e.message || "审批提交失败，请重试");
    }
    setSending(false);
  };

  return (
    <div className={`approval-block ${block.decision ? "resolved" : ""}`}>
      <div className="approval-head">
        <Icon name="shield" size={12} />
        <span className="approval-title">需要审批：{toolLabel}</span>
        {block.decision === "allow" && <span className="approval-status">✓ 已允许</span>}
        {block.decision === "deny" && <span className="approval-status denied">✕ 已拒绝</span>}
      </div>
      <div className="approval-command">{block.input}</div>
      {!block.decision && (
        <>
          <div className="approval-actions">
            <button className="btn primary approval-allow" onClick={() => decide("allow")} disabled={sending}>允许一次</button>
            <button className="btn approval-always" onClick={() => decide("always")} disabled={sending}>总是允许</button>
            <button className="btn approval-deny" onClick={() => decide("deny")} disabled={sending}>拒绝</button>
          </div>
          {error && <div className="ask-error" role="alert">{error}</div>}
        </>
      )}
    </div>
  );
}

// ========== Proma 风格上下文用量圈 ==========
function ContextUsageRing({ usage, contextWindow, contextTokens, compactThreshold, compactionMode, model, compacting, busy, onCompact }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const percentage = Math.min(100, Math.round((contextTokens / Math.max(1, contextWindow)) * 100));
  const hasThreshold = Number(compactThreshold) > 0;
  const thresholdPercentage = hasThreshold ? Math.min(100, Math.round((compactThreshold / Math.max(1, contextWindow)) * 100)) : null;
  const tone = percentage >= 85 ? "danger" : percentage >= 60 ? "warning" : "ok";
  const radius = 14;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (circumference * percentage) / 100;
  const details = usageDetails(usage);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!wrapRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div className={`context-ring-wrap ${open ? "open" : ""}`} ref={wrapRef}>
      <button
        type="button"
        className={`context-ring-button ${tone}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={`上下文 ${formatTokenCount(contextTokens)} / ${formatTokenCount(contextWindow)} tokens`}
      >
        <span className="context-ring-svg" aria-hidden="true">
          <svg viewBox="0 0 36 36">
            <circle className="context-ring-track" cx="18" cy="18" r={radius} />
            <circle className="context-ring-progress" cx="18" cy="18" r={radius} style={{ strokeDasharray: circumference, strokeDashoffset: offset }} />
          </svg>
          <strong>{percentage}%</strong>
        </span>
        <span className="context-ring-label"><b>上下文</b><small>{formatTokenCount(contextTokens)}</small></span>
      </button>
      {open && (
        <div className="context-ring-pop" role="dialog" aria-label="上下文用量">
          <div className="context-ring-pop-head">
            <span><strong>上下文记录</strong><small>{modelDisplayName(model)}</small></span>
            <span className={`context-ring-percent ${tone}`}>{percentage}%</span>
          </div>
          <div className="context-ring-meter"><i style={{ width: `${percentage}%` }} /></div>
          <div className="context-ring-stats">
            <span>当前 <b>{contextTokens.toLocaleString()}</b></span>
            <span>上限 <b>{contextWindow.toLocaleString()}</b></span>
            <span>压缩机制 <b>{compactionMode === "pi-native" ? "Pi 自动" : compactionMode === "app-fallback" ? "未知模型兜底" : "手动"}</b></span>
            <span>压缩线 <b>{hasThreshold ? `${thresholdPercentage}%` : "关闭"}</b></span>
          </div>
          <div className="context-ring-breakdown">
            <span>输入 {details.input.toLocaleString()}</span>
            <span>缓存读 {details.cacheRead.toLocaleString()}</span>
            <span>缓存写 {details.cacheWrite.toLocaleString()}</span>
            <span>输出 {details.output.toLocaleString()}</span>
          </div>
          <button type="button" className="context-ring-compact" onClick={onCompact} disabled={busy || compacting}>
            <Icon name={compacting ? "loading" : "layers"} size={12} className={compacting ? "icon-loading" : ""} />
            {compacting ? "压缩中…" : busy ? "任务完成后可压缩" : "压缩上下文"}
          </button>
        </div>
      )}
    </div>
  );
}

// ========== Codex 风格审批模式按钮 ==========
function ApprovalModeControl({ mode, saving, onChange }) {
  const automatic = mode === "auto";
  return (
    <button
      type="button"
      className={`approval-mode-control ${automatic ? "auto" : "ask"}`}
      onClick={() => onChange(automatic ? "ask" : "auto")}
      disabled={saving}
      aria-pressed={automatic}
      title={automatic ? "自动批准 ask 工具操作；deny 规则仍然生效。点击切回每次询问" : "工具写入或危险操作需要逐次询问。点击启用自动批准"}
    >
      <Icon name={automatic ? "check" : "shield"} size={13} />
      <span>{automatic ? "自动批准" : "每次询问"}</span>
      <i className="approval-mode-dot" />
    </button>
  );
}

// ========== SSE 执行流（顶部可折叠/隐藏，独立于消息气泡） ==========
function ExecutionFlow({ events = [], running = false, onFocusTool }) {
  // 默认折叠，避免几十条启动/工具事件把正文和输入框顶出视口
  const [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState(() => localStorage.getItem(EXECUTION_FLOW_HIDDEN_KEY) === "true");
  const wasRunningRef = useRef(running);
  // 纯阶段状态事件（准备/受理/请求模型/回合切换等）合并为一行，不逐条刷屏
  const STAGE_ONLY_EVENTS = new Set(["runtime_connecting", "run_admitting", "run_admitted", "model_request_started", "agent_started", "turn_started", "turn_ended", "agent_turn_end", "mode_policy", "thinking_level", "capability_plan", "agent_end", "assistant_final"]);
  const contentEvents = events.filter((event) => !STAGE_ONLY_EVENTS.has(event.type));
  const latest = contentEvents[contentEvents.length - 1] || events[events.length - 1];
  const visibleEvents = contentEvents.length > 0
    ? contentEvents
    : (running ? [{ key: "local:stream_waiting", type: "stream_waiting", data: {}, at: new Date().toISOString() }] : []);
  // 归约为执行轨迹：工具按 toolCallId 聚合，折叠态展示聚合统计而不是最后一条事件
  const runTrace = useMemo(() => reduceRunTrace(contentEvents), [contentEvents]);
  const traceStats = summarizeRunTrace(runTrace);
  const traceSummary = runTraceSummaryText(runTrace);
  const completion = traceStats.completion;
  useEffect(() => {
    // 收到终结事件后自动回到一行摘要
    if (wasRunningRef.current && !running) setExpanded(false);
    wasRunningRef.current = running;
  }, [running]);
  if (!visibleEvents.length) return null;
  if (hidden) {
    return (
      <div className="execution-flow execution-flow-hidden">
        <button type="button" onClick={() => { setHidden(false); localStorage.setItem(EXECUTION_FLOW_HIDDEN_KEY, "false"); }}>
          <Icon name="eye" size={12} /> 显示执行流 <span>{events.length ? `${events.length} 个事件` : "等待首个事件"}</span>
        </button>
      </div>
    );
  }
  return (
    <div className={`execution-flow ${expanded ? "expanded" : ""} ${running ? "live" : ""}`}>
      <div className="execution-flow-head">
        <button type="button" className="execution-flow-toggle" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          <span className="execution-flow-chevron">{expanded ? "▾" : "▸"}</span>
          <Icon name="flow" size={12} />
          <strong>执行过程</strong>
          <span className="execution-flow-count">{contentEvents.length ? `${contentEvents.length} 个事件` : "等待首个事件"}</span>
          <span className="execution-flow-current">{traceSummary || flowEventLabel(latest || visibleEvents[0])}</span>
          {completion && (
            <span
              className={`flow-completion ${completion.status}`}
              title={completion.source === "inferred" ? "由回合结束推断（模型未显式声明完成状态）" : `模型显式声明${completion.summary ? `：${completion.summary}` : ""}`}
            >
              {completionLabel(completion.status)}
            </span>
          )}
          {running && <span className="execution-flow-live"><i /> SSE 实时</span>}
        </button>
        <button type="button" className="execution-flow-hide" onClick={() => { setHidden(true); localStorage.setItem(EXECUTION_FLOW_HIDDEN_KEY, "true"); }} title="隐藏执行流" aria-label="隐藏执行流"><Icon name="eyeOff" size={12} /></button>
      </div>
      {expanded && (
        <>
          {/* 脑回路执行图：工具按类别聚合，点击可在消息流中定位工具卡 */}
          <AgentBrainGraph trace={runTrace} running={running} onFocusTool={onFocusTool} />
          <div className="execution-flow-list">
          {visibleEvents.map((event) => {
            const data = event.data || {};
            const detail = data.message || (event.type === "tool_start" ? data.name : event.type === "file_changed" ? (data.files || []).join(", ") : "");
            const label = flowEventLabel(event);
            const showDetail = detail && String(detail).trim() !== String(label).trim();
            return (
              <div className={`execution-flow-item ${flowEventTone(event)}`} key={event.key}>
                <span className="execution-flow-dot" />
                <span className="execution-flow-label">{label}</span>
                {showDetail && <span className="execution-flow-detail" title={detail}>{String(detail).slice(0, 100)}</span>}
                <time>{new Date(event.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
              </div>
            );
          })}
          </div>
        </>
      )}
    </div>
  );
}

// ========== 输入框上方任务入口：点击查看，离开后自动收起 ==========
function TaskProgressCard({ tasks, running = false }) {
  const [open, setOpen] = useState(false);
  const cardRef = useRef(null);
  const closeTimerRef = useRef(null);
  const done = tasks.filter((t) => t.done || ["completed", "skipped"].includes(t.status)).length;
  const failed = tasks.filter((t) => t.status === "failed").length;

  useEffect(() => {
    if (!running) setOpen(false);
  }, [running]);
  useEffect(() => () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const handleOutsidePointer = (event) => {
      if (!cardRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", handleOutsidePointer);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer);
  }, [open]);
  const keepOpen = () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  };
  const scheduleClose = () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 350);
  };

  return (
    <div className={`task-card ${open ? "open" : ""}`} ref={cardRef} onMouseEnter={keepOpen} onMouseLeave={scheduleClose}>
      <button type="button" className="task-head" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label="查看任务进度">
        <span className="task-chevron">{open ? "▾" : "▸"}</span>
        <Icon name="list" size={12} />
        <span className="task-title">任务</span>
        <span className="task-progress">{done}/{tasks.length} 完成{failed ? ` · ${failed} 失败` : ""}</span>
      </button>
      {open && (
        <div className="task-body">
          <div className="task-bar">
            <div className="task-bar-fill" style={{ width: `${(done / tasks.length) * 100}%` }} />
          </div>
          {tasks.map((t, i) => (
            <div key={t.id || i} className={`task-item ${t.done || ["completed", "skipped"].includes(t.status) ? "done" : ""} ${t.status === "failed" ? "failed" : ""}`}>
              <span className="task-status">{t.status === "failed" ? <Icon name="warning" size={11} /> : (t.done || ["completed", "skipped"].includes(t.status) ? <Icon name="check" size={11} /> : <span className="task-pending-dot" />)}</span>
              <span className="task-text">{t.title || t.name || t.text || "执行 Agent 任务"}</span>
              {t.note && <small title={t.note}>{t.note}</small>}
              {t.status === "running" || t.status === "in_progress" ? <small>进行中</small> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ========== 工具语义短语（Proma tool-phrase：完成态/流式态短语） ==========
function toolPhrase(name, input, done) {
  let arg = "";
  try {
    const obj = typeof input === "object" ? input : JSON.parse(input || "{}");
    arg = obj.args || obj.file_path || obj.filePath || obj.path || obj.pattern || obj.query || obj.cwd || "";
  } catch {}
  arg = String(arg || "").trim();
  const tail = arg ? ` ${arg.slice(0, 60)}` : "";
  const loading = done ? "" : "正在";
  switch (name) {
    case "read": return `${loading}读取文件${tail}`;
    case "write": return `${loading}写入文件${tail}`;
    case "edit": return `${loading}编辑文件${tail}`;
    case "bash": return `执行命令${tail}`;
    case "officecli": return `操作 Office 文档${tail}`;
    case "todo": return `${loading}更新任务清单`;
    case "grep": return `${loading}搜索内容${tail}`;
    case "kb_search": return `${loading}搜索知识库${tail}`;
    case "kb_read": return `${loading}读取知识库${tail}`;
    case "skills_search": return `${loading}搜索 Skills${tail}`;
    case "skills_read": return `${loading}读取 Skill 说明${tail}`;
    case "find": case "ls": return `${loading}查看文件列表${tail}`;
    case "glob": return `${loading}查找文件${tail}`;
    case "webSearch": return `${loading}联网搜索${tail}`;
    case "webFetch": return `${loading}抓取网页${tail}`;
    case "TaskCreate": return `创建任务${tail}`;
    case "TaskUpdate": return `更新任务${tail}`;
    default: return `${loading}调用 ${name}${tail}`;
  }
}

// ========== 工具调用行（Proma ToolUseBlock：状态图标 + 语义短语 + 展开详情） ==========
function ToolCard({ tool, onToggle }) {
  const { name, input, output, done, isError, expanded, duration } = tool;
  // 命令预览：bash/officecli 等命令行工具显示 $ 前缀
  // 注意：JSON.stringify(undefined) 返回 undefined，历史会话中 tool.input 可能缺失
  let inputStr = typeof input === "string" ? input : (input != null ? JSON.stringify(input, null, 2) : "");
  try {
    if (typeof input === "object" && input?.args) {
      inputStr = typeof input.args === "string" ? input.args : JSON.stringify(input.args);
    }
  } catch {}
  const isCmd = name === "bash" || name === "officecli" || name === "find" || name === "grep" || name === "ls" || name === "cat";
  const fullInput = inputStr.replace(/\s+/g, " ").trim();
  const cmdPreview = isCmd ? `${fullInput.slice(0, 96)}${fullInput.length > 96 ? "…" : ""}` : fullInput.slice(0, 80);
  const outputPreview = output?.length > 300 ? output.slice(0, 300) + "..." : output;

  return (
    <div className={`tool-card ${done ? (isError ? "error" : "success") : "pending"}`} onClick={onToggle}>
      <div className="tool-header">
        <span className={`tool-icon ${done ? (isError ? "err" : "ok") : "run"}`}>
          {done ? (isError ? <Icon name="x" size={12} /> : <Icon name="check" size={12} />) : <Icon name="loading" size={12} className="icon-loading" />}
        </span>
        <span className="tool-phrase" title={inputStr}>{toolPhrase(name, input, done)}</span>
        {tool.startMissing && <span className="tool-recovered" title="开始事件已丢失，状态由结束事件恢复">已恢复</span>}
        {isCmd && <code className="cmd-code" title={fullInput}>$ {cmdPreview}</code>}
        {duration && <span className="tool-duration">{duration}s</span>}
        <span className={`tool-chevron ${expanded ? "open" : ""}`}>{expanded ? "▾" : "▸"}</span>
      </div>
      {expanded && (
        <div className="tool-detail">
          {/* 输入参数 */}
          {inputStr && (
            <div className="tool-section">
              <div className="tool-section-label">输入</div>
              <pre className={`tool-code ${isCmd ? "cmd" : ""}`}>{inputStr}</pre>
            </div>
          )}
          {/* 配对结果（按 toolCallId 配对，pi PairedResult 风格） */}
          {(output || tool.result) && (
            <div className="tool-section">
              <div className="tool-section-label">{done ? "结果" : "输出"}</div>
              <pre className={`tool-code ${isError ? "err" : ""}`}>{expanded ? (output || tool.result) : outputPreview}</pre>
            </div>
          )}
          {done && !output && !tool.result && (
            <div className="tool-section">
              <div className="tool-section-label">结果</div>
              <pre className="tool-code empty">(no output)</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
