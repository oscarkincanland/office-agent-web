import crypto from "node:crypto";

export function createTaskEnvelope(input = {}) {
  const references = Array.isArray(input.references) ? input.references : [];
  return {
    version: 1,
    id: input.id || `task_${crypto.randomUUID()}`,
    goal: String(input.goal || input.text || "").trim(),
    mode: input.mode || "agent",
    workflowId: input.workflowId || null,
    workspaceId: input.workspaceId || null,
    threadId: input.threadId || null,
    currentFile: input.currentFile || null,
    references: references.map((r) => ({ id: r.id, kind: r.kind, target: r.target, status: r.status })),
    constraints: Array.isArray(input.constraints) ? input.constraints : [],
    output: {
      format: input.output?.format || "markdown",
      saveToWorkspace: input.output?.saveToWorkspace !== false,
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
    `- 模式: ${task.mode}`,
    task.workflowId ? `- 工作流: ${task.workflowId}` : "",
    task.currentFile ? `- 当前文件: ${task.currentFile}` : "",
    task.references?.length ? `- 引用数: ${task.references.length}` : "- 引用数: 0",
    "- 输出要求：完成后明确列出读取来源、修改文件、产物、假设和下一步。",
  ].filter(Boolean).join("\n");
}
