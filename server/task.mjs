import crypto from "node:crypto";

const OFFICE_EXTENSIONS = /\.(?:docx|xlsx|pptx|xls|doc)$/i;
const DOCUMENT_EXTENSIONS = /\.(?:docx|xlsx|pptx|xls|doc|pdf|csv|json|md|markdown|txt|html|htm)$/i;

/**
 * 工作台保留四种后端模式值。office 是历史兼容值，前端主入口展示
 * Chat / Work / Review；Office CLI 作为 Work 或 Review 的受控能力使用。
 */
export const TASK_MODES = Object.freeze(["chat", "office", "agent", "review"]);

// Chat 只读能力：只做查询、读取、分析总结，不落盘。
// 地图的只读四件套也在此列——查询数据集、生成临时可视化、清除临时结果、
// 列出可用数据。写操作（map_edit / map_import / map_save_analysis）只在 Work，
// 用户明确要求"新增图层"时切到 Work 模式执行。
const READ_ONLY_TOOLS = Object.freeze([
  "read", "grep", "find", "ls", "ask_user", "kb_search", "kb_read", "context_read", "skills_search", "skills_read",
  "web_search", "web_fetch",
  "map_read", "map_analyze", "map_clear_analysis", "map_datasets",
]);
// Office 模式专注文档处理，不暴露地图工具（地图能力只在 Chat 与 Work 出现）。
const OFFICE_TOOLS = Object.freeze([
  ...READ_ONLY_TOOLS.filter((name) => !name.startsWith("map_")), "officecli",
]);
// Review 只依赖本地材料与规范库，不应因为通用 Agent 的工具集合而
// 暴露联网搜索能力；否则审查依据不可追溯，也会产生无关事件。
const REVIEW_TOOLS = Object.freeze([
  "read", "grep", "find", "ls", "ask_user", "kb_search", "kb_read", "context_read", "skills_search", "skills_read",
  "officecli", "write", "edit", "review_copy", "review_source_apply", "todo", "complete_task",
]);
const AGENT_TOOLS = Object.freeze([
  ...OFFICE_TOOLS,
  "bash", "write", "edit",
  // Work 模式持有全部地图工具（含只读四件套与三个写工具）。
  "map_read", "map_analyze", "map_clear_analysis", "map_datasets",
  "map_edit", "map_import", "map_save_analysis",
  "memory_update", "todo", "complete_task",
  "browser_open", "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_scroll", "browser_screenshot", "browser_tabs", "browser_back", "browser_close",
]);

export function normalizeTaskMode(mode) {
  const value = String(mode || "").trim().toLowerCase();
  return TASK_MODES.includes(value) ? value : "agent";
}

export function modeLabel(mode) {
  return {
    chat: "Chat",
    office: "Office",
    agent: "Agent",
    review: "Review",
  }[normalizeTaskMode(mode)];
}

export function modeDescription(mode) {
  return {
    chat: "只读检索知识库、Skills 和工作区资料，不修改文件",
    office: "通过 Office CLI 精准编辑 Office 文档，不开放通用脚本写入",
    agent: "可调用完整工具链，执行分析、修改并生成工作产物",
    review: "依据知识库规范审查材料，生成报告和副本；确认后才写回原文",
  }[normalizeTaskMode(mode)];
}

export function toolPolicyForMode(mode) {
  const normalized = normalizeTaskMode(mode);
  const tools = normalized === "chat"
    ? READ_ONLY_TOOLS
    : normalized === "office"
      ? OFFICE_TOOLS
      : normalized === "review"
        ? REVIEW_TOOLS
      : AGENT_TOOLS;
  return {
    mode: normalized,
    label: modeLabel(normalized),
    description: modeDescription(normalized),
    tools: [...tools],
  };
}

function containsAny(text, words) {
  return words.some((word) => text.includes(String(word).toLowerCase()));
}

/** 根据输入和引用生成可解释的本轮能力计划，供 Run、前端和 Pi prompt 共用。 */
export function planTaskCapabilities({ text = "", task = {}, references = [], attachments = [] } = {}) {
  const mode = normalizeTaskMode(task.mode);
  const source = String(text || "").toLowerCase();
  const refList = Array.isArray(references) ? references : [];
  const attachmentNames = (Array.isArray(attachments) ? attachments : []).map((item) => String(item?.name || item || ""));
  const refTargets = refList.map((item) => String(item?.target || "")).join(" ");
  const files = [String(task.currentFile || ""), refTargets, ...attachmentNames].join(" ");
  const document = DOCUMENT_EXTENSIONS.test(files) || refList.some((item) => item.kind === "file" || item.kind === "template");
  const office = OFFICE_EXTENSIONS.test(files) || containsAny(source, ["officecli", "word", "excel", "ppt", "docx", "xlsx", "pptx", "表格", "文档排版", "修改文档"]);
  const knowledge = refList.some((item) => ["knowledge", "knowledge_dir"].includes(item.kind)) || containsAny(source, ["知识库", "知识库搜索", "知识检索", "参考资料"]);
  const map = containsAny(source, ["地图", "图层", "geojson", "等时圈", "热力图", "od图", "空间分析"]) || /(?:^|[\\/])maps(?:[\\/]|$)/i.test(files);
  const workflow = Boolean(task.workflowId) || /@工作流\[|@技能\[|工作流|skill|workflow/i.test(String(text || ""));
  const output = containsAny(source, ["生成", "创建", "导出", "写入", "制作", "修改", "编辑", "排版"]);
  const capabilities = [
    mode === "chat"
      ? { id: "chat", label: "Chat 检索", status: "ready", required: true, reason: "只读检索知识库、Skills 和工作区资料" }
      : mode === "office"
        ? { id: "office", label: "Office 对话", status: "ready", required: true, reason: "通过 Office CLI 精准处理 Office 文档" }
        : mode === "review"
          ? { id: "review", label: "Review 审查", status: "ready", required: true, reason: "依据规范生成审查报告和安全副本" }
        : { id: "agent", label: "Agent 对话", status: "ready", required: true, reason: "处理本轮任务并保持会话上下文" },
  ];
  if (document) capabilities.push({ id: "document", label: "文档读取", status: "planned", required: true, reason: "本轮存在文档、文件引用或附件" });
  if (knowledge) capabilities.push({ id: "knowledge", label: "知识库检索", status: "planned", required: false, reason: "本轮出现知识库引用或检索意图" });
  // Chat 只负责检索与解释，即使用户提到 docx/xlsx，也不能触发 Office CLI
  // 预检或写入路由；Office CLI 仅作为 Office 兼容模式或 Agent 内部能力使用。
  if (office && mode !== "chat") capabilities.push({ id: "officecli", label: "Office CLI", status: "preferred", required: Boolean(output), reason: "本轮涉及 Office 文件或 Office 编辑意图" });
  if (mode === "review") capabilities.push({ id: "reviewEvidence", label: "规范依据台账", status: "required", required: true, reason: "每条审查结论必须绑定实际读取的规范文件" });
  // 地图能力只在 Chat（只读）与 Work（可写）声明；Office 专注文档、Review 依赖本地材料，
  // 两者的工具白名单里都没有地图工具，声明了就成了"说得到做不到"（X1 的同类问题）。
  const mapAvailable = map && (mode === "chat" || mode === "agent");
  if (mapAvailable) {
    const mapWritable = mode !== "chat" && mode !== "review";
    capabilities.push({
      id: "map",
      label: "地图工具",
      status: "ready",
      required: false,
      reason: mapWritable
        ? "地图查询、分析与图层写入（写操作需审批）"
        : "地图只读查询与临时可视化（不落盘；保存图层需切到 Work 模式）",
    });
  }
  if (workflow) capabilities.push({ id: "skills", label: "Skills / 工作流", status: "planned", required: Boolean(task.workflowId), reason: task.workflowId ? `工作流 ${task.workflowId} 声明了技能依赖` : "本轮出现工作流或技能意图" });
  return {
    version: 1,
    mode,
    capabilities,
    routing: {
      officecli: office && mode !== "chat" ? "preferred" : "not_needed",
      documentRead: document ? "enabled" : "not_needed",
      knowledge: knowledge ? "enabled" : "not_needed",
      // read_only / read_write：让前端与提示词都能区分"能不能落盘"。
      // 仅当上面真的声明了地图能力时才启用（与 capabilities 严格一致）。
      map: mapAvailable ? (mode === "chat" ? "read_only" : "read_write") : "not_needed",
      skills: workflow ? "preflight" : "available_on_demand",
    },
    output: { expected: mode !== "chat" && output, saveToWorkspace: mode !== "chat" && task.output?.saveToWorkspace !== false },
  };
}

export function createTaskEnvelope(input = {}) {
  const references = Array.isArray(input.references) ? input.references : [];
  const mode = normalizeTaskMode(input.mode);
  return {
    version: 1,
    id: input.id || `task_${crypto.randomUUID()}`,
    goal: String(input.goal || input.text || "").trim(),
    mode,
    modeLabel: modeLabel(input.mode),
    modeDescription: modeDescription(input.mode),
    workflowId: input.workflowId || null,
    recoveryOf: input.recoveryOf || null,
    recoveryAction: input.recoveryAction || null,
    projectId: input.projectId || null,
    mapProject: input.mapProject || null,
    agentProfile: input.agentProfile || "通用 Agent",
    projectSettings: input.projectSettings || null,
    profilePolicy: input.profilePolicy || input.projectSettings?.profilePolicy || null,
    workspaceId: input.workspaceId || null,
    threadId: input.threadId || null,
    currentFile: input.currentFile || null,
    references: references.map((r) => ({ id: r.id, kind: r.kind, target: r.target, status: r.status })),
    capabilityPlan: input.capabilityPlan || null,
    constraints: Array.isArray(input.constraints) ? input.constraints : [],
    output: {
      format: input.output?.format || "markdown",
      saveToWorkspace: mode !== "chat" && input.output?.saveToWorkspace !== false,
      requireSources: input.output?.requireSources !== false,
    },
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

export function taskSummary(task) {
  if (!task) return "";
  return [
    "当前任务",
    `目标：${task.goal || "（未提供）"}`,
    `模式：${task.modeLabel || modeLabel(task.mode)}`,
    task.workflowId ? `工作流：${task.workflowId}` : "",
    task.currentFile ? `当前文件：${task.currentFile}` : "",
    task.mapProject ? `当前地图项目：${task.mapProject}` : "",
    mapCapabilityHint(task),
    task.references?.length ? `引用：${task.references.length} 项` : "",
    task.mode === "chat" ? "边界：只读检索，不修改文件。" : "边界：按任务执行工具，面向用户直接给出结论；过程与产物详情留在任务记录中，按需说明。",
  ].filter(Boolean).join("\n");
}

/**
 * 地图能力边界（阶段 3）：只在"本轮确实涉及地图"时注入，避免每轮都占用上下文。
 * 目的是让模型知道当前模式能做什么、不能做什么——而不是等到失败后才发现权限不足。
 */
function mapCapabilityHint(task = {}) {
  const plan = task.capabilityPlan;
  const routing = plan?.routing?.map;
  if (routing !== "read_only" && routing !== "read_write") return "";
  if (routing === "read_write") {
    return "地图能力：可查询数据集与图层、生成临时可视化，并可将结果保存为正式图层（写操作需用户审批）。";
  }
  return [
    "地图能力（只读）：可查询数据集与图层、生成临时可视化（如热力图 / OD 流向 / 等时圈）、清除临时结果。",
    "不可执行：新增、修改、删除图层，或把分析结果保存为正式图层——这些需要用户切换到 Work 模式。",
    "当用户要求写操作时，明确说明需要切到 Work 模式，不要尝试绕过，也不要假装已完成。",
  ].join("\n");
}
