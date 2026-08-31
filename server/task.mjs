import crypto from "node:crypto";

const OFFICE_EXTENSIONS = /\.(?:docx|xlsx|pptx|xls|doc)$/i;
const DOCUMENT_EXTENSIONS = /\.(?:docx|xlsx|pptx|xls|doc|pdf|csv|json|md|markdown|txt|html|htm)$/i;

/**
 * 工作台保留三种后端模式值。office 是历史兼容值，前端主入口只展示
 * Chat / Agent；Office CLI 作为 Agent 内部能力按任务需要自动路由。
 */
export const TASK_MODES = Object.freeze(["chat", "office", "agent"]);

const READ_ONLY_TOOLS = Object.freeze([
  "read", "grep", "find", "ls", "ask_user", "kb_search", "kb_read", "context_read", "skills_search", "skills_read",
]);
const OFFICE_TOOLS = Object.freeze([
  ...READ_ONLY_TOOLS, "officecli",
]);
const AGENT_TOOLS = Object.freeze([
  ...OFFICE_TOOLS,
  "bash", "write", "edit",
  "map_read", "map_edit", "map_import", "map_analyze", "map_save_analysis", "map_clear_analysis",
  "memory_update",
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
  }[normalizeTaskMode(mode)];
}

export function modeDescription(mode) {
  return {
    chat: "只读检索知识库、Skills 和工作区资料，不修改文件",
    office: "通过 Office CLI 精准编辑 Office 文档，不开放通用脚本写入",
    agent: "可调用完整工具链，执行分析、修改并生成工作产物",
  }[normalizeTaskMode(mode)];
}

export function toolPolicyForMode(mode) {
  const normalized = normalizeTaskMode(mode);
  const tools = normalized === "chat"
    ? READ_ONLY_TOOLS
    : normalized === "office"
      ? OFFICE_TOOLS
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
        : { id: "agent", label: "Agent 对话", status: "ready", required: true, reason: "处理本轮任务并保持会话上下文" },
  ];
  if (document) capabilities.push({ id: "document", label: "文档读取", status: "planned", required: true, reason: "本轮存在文档、文件引用或附件" });
  if (knowledge) capabilities.push({ id: "knowledge", label: "知识库检索", status: "planned", required: false, reason: "本轮出现知识库引用或检索意图" });
  // Chat 只负责检索与解释，即使用户提到 docx/xlsx，也不能触发 Office CLI
  // 预检或写入路由；Office CLI 仅作为 Office 兼容模式或 Agent 内部能力使用。
  if (office && mode !== "chat") capabilities.push({ id: "officecli", label: "Office CLI", status: "preferred", required: Boolean(output), reason: "本轮涉及 Office 文件或 Office 编辑意图" });
  if (map) capabilities.push({ id: "map", label: "地图工具", status: "planned", required: false, reason: "本轮出现地图、图层或空间分析意图" });
  if (workflow) capabilities.push({ id: "skills", label: "Skills / 工作流", status: "planned", required: Boolean(task.workflowId), reason: task.workflowId ? `工作流 ${task.workflowId} 声明了技能依赖` : "本轮出现工作流或技能意图" });
  return {
    version: 1,
    mode,
    capabilities,
    routing: {
      officecli: office && mode !== "chat" ? "preferred" : "not_needed",
      documentRead: document ? "enabled" : "not_needed",
      knowledge: knowledge ? "enabled" : "not_needed",
      map: map ? "enabled" : "not_needed",
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
    agentProfile: input.agentProfile || "通用 Agent",
    projectSettings: input.projectSettings || null,
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
    "## 任务封装（TaskEnvelope）",
    `- 任务 ID: ${task.id}`,
    `- 目标: ${task.goal || "（未提供）"}`,
    `- 模式: ${task.modeLabel || modeLabel(task.mode)}（${task.modeDescription || modeDescription(task.mode)}）`,
    task.workflowId ? `- 工作流: ${task.workflowId}` : "",
    task.agentProfile ? `- Agent Profile: ${task.agentProfile}` : "",
    task.recoveryOf ? `- 恢复来源: ${task.recoveryOf}（${task.recoveryAction === "retry" ? "重试" : "继续"}）` : "",
    task.currentFile ? `- 当前文件: ${task.currentFile}` : "",
    task.references?.length ? `- 引用数: ${task.references.length}` : "- 引用数: 0",
    task.capabilityPlan?.capabilities?.length ? `- 本轮能力: ${task.capabilityPlan.capabilities.map((item) => item.label).join("、")}` : "",
    task.mode === "chat"
      ? "- 输出要求：回答检索结果并明确列出来源；不修改文件、不执行脚本、不写入长期记忆。"
      : "- 输出要求：完成后明确列出读取来源、修改文件、产物、假设和下一步。",
  ].filter(Boolean).join("\n");
}
