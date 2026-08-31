import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { appendEvent } from "./事件存储.mjs";
import { getRun } from "./runs.mjs";
import { normalizeWorkspace } from "./workspace.mjs";
import { atomicWriteFile, atomicWriteJson, ensureDirectory } from "./持久化工具.mjs";
import { acquireWriteLock, releaseWriteLock } from "./写入协调.mjs";

const PROJECT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PROPOSALS_FILE = process.env.OAW_MEMORY_PROPOSALS_FILE || path.join(PROJECT_DIR, ".oaw", "memory-proposals.json");
const MAX_PROPOSALS = 300;
const MAX_CONTENT = 1200;
const MAX_HISTORY = 60;

export const MEMORY_CATEGORIES = Object.freeze({
  project_fact: "项目事实",
  work_rule: "工作规则",
  user_preference: "用户偏好",
  lesson: "经验教训",
  resource_index: "资料索引",
});

const CATEGORY_BY_LABEL = new Map(Object.entries(MEMORY_CATEGORIES).map(([key, label]) => [label, key]));

function now() { return new Date().toISOString(); }

function cleanText(value, max = MAX_CONTENT) {
  return String(value ?? "").trim().slice(0, max);
}

function categoryFrom(value) {
  const raw = cleanText(value, 80);
  if (MEMORY_CATEGORIES[raw]) return raw;
  if (CATEGORY_BY_LABEL.has(raw)) return CATEGORY_BY_LABEL.get(raw);
  if (/项目信息|项目事实|project/i.test(raw)) return "project_fact";
  if (/规则|准则|工作规则|rule/i.test(raw)) return "work_rule";
  if (/偏好|preference/i.test(raw)) return "user_preference";
  if (/资料|索引|resource/i.test(raw)) return "resource_index";
  if (/经验|教训|lesson/i.test(raw)) return "lesson";
  const error = new Error(`不支持的记忆分类：${raw || "（空）"}`);
  error.code = "MEMORY_CATEGORY_INVALID";
  throw error;
}

function labelFor(category) {
  return MEMORY_CATEGORIES[categoryFrom(category)];
}

function requireWorkspace(workspace) {
  const root = normalizeWorkspace(workspace);
  if (!root) {
    const error = new Error("记忆所属工作区不存在或不是文件夹");
    error.code = "MEMORY_WORKSPACE_INVALID";
    throw error;
  }
  return root;
}

function proposalsFile() {
  ensureDirectory(path.dirname(PROPOSALS_FILE));
  return PROPOSALS_FILE;
}

function readStoredProposals() {
  try {
    const value = JSON.parse(fs.readFileSync(proposalsFile(), "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveStoredProposals(items) {
  atomicWriteJson(proposalsFile(), items.slice(-MAX_PROPOSALS));
}

function normalizeProposal(item) {
  const category = categoryFrom(item.category || item.section || "经验教训");
  const workspace = item.workspace ? normalizeWorkspace(item.workspace) || item.workspace : null;
  const threadKey = item.threadKey || item.threadId || null;
  return {
    ...item,
    version: Number(item.version) || 1,
    category,
    section: labelFor(category),
    workspace,
    threadKey,
    content: cleanText(item.content),
    status: String(item.status || "pending"),
    source: item.source || { type: "agent", runId: item.runId || null, threadId: item.threadId || null },
    history: Array.isArray(item.history) ? item.history.slice(-MAX_HISTORY) : [],
  };
}

function eventDetails(proposal) {
  return {
    id: proposal.id,
    category: proposal.category,
    section: proposal.section,
    workspace: proposal.workspace,
    projectId: proposal.projectId || null,
    runId: proposal.runId || null,
    threadId: proposal.threadId || null,
    status: proposal.status,
    version: proposal.version,
  };
}

function appendHistory(proposal, action, details = {}) {
  proposal.version = Number(proposal.version || 0) + 1;
  proposal.updatedAt = now();
  proposal.history = [...(Array.isArray(proposal.history) ? proposal.history : []), {
    version: proposal.version,
    action,
    at: proposal.updatedAt,
    ...details,
  }].slice(-MAX_HISTORY);
}

function findStoredProposal(items, id) {
  const proposal = items.find((item) => item.id === String(id || ""));
  return proposal ? normalizeProposal(proposal) : null;
}

function conflict(message, details = {}) {
  const error = new Error(message);
  error.code = "MEMORY_PROPOSAL_CONFLICT";
  error.details = details;
  return error;
}

export function listMemoryProposals({ threadKey = "", workspace = "", projectId = "", category = "", status = "" } = {}) {
  const normalizedWorkspace = workspace ? normalizeWorkspace(workspace) || String(workspace) : "";
  const normalizedCategory = category ? categoryFrom(category) : "";
  return readStoredProposals().map(normalizeProposal).filter((proposal) =>
    (!threadKey || proposal.threadKey === threadKey || proposal.threadId === threadKey) &&
    (!normalizedWorkspace || proposal.workspace === normalizedWorkspace) &&
    (!projectId || proposal.projectId === projectId) &&
    (!normalizedCategory || proposal.category === normalizedCategory) &&
    (!status || status === "all" || proposal.status === status)
  );
}

export function createMemoryProposal({ clientId = null, threadId = null, threadKey = null, workspace, projectId = null, runId = null, category, section, content, source = {} } = {}) {
  const root = requireWorkspace(workspace);
  const body = cleanText(content);
  if (!body) {
    const error = new Error("记忆建议内容不能为空");
    error.code = "MEMORY_CONTENT_EMPTY";
    throw error;
  }
  const run = runId ? getRun(runId) : null;
  const normalizedCategory = categoryFrom(category || section || "经验教训");
  const createdAt = now();
  const proposal = {
    id: `memory_${crypto.randomUUID()}`,
    version: 1,
    clientId: clientId || null,
    threadId: threadId || null,
    threadKey: threadKey || threadId || null,
    workspace: root,
    projectId: projectId || run?.projectId || null,
    runId: runId || null,
    category: normalizedCategory,
    section: labelFor(normalizedCategory),
    content: body,
    status: "pending",
    source: {
      type: source.type || "agent",
      label: source.label || "Agent 建议",
      runId: runId || null,
      threadId: threadId || null,
      clientId: clientId || null,
      ...source,
    },
    createdAt,
    updatedAt: createdAt,
    history: [{ version: 1, action: "created", at: createdAt, content: body }],
  };
  const items = readStoredProposals();
  items.push(proposal);
  saveStoredProposals(items);
  appendEvent({ clientId, threadId, runId, type: "memory_proposal_created", data: eventDetails(proposal) });
  return proposal;
}

export function editMemoryProposal(id, { content, category, section } = {}) {
  const items = readStoredProposals();
  const index = items.findIndex((item) => item.id === String(id || ""));
  if (index < 0) return { ok: false, status: 404, error: "proposal not found" };
  const proposal = normalizeProposal(items[index]);
  if (proposal.status !== "pending") return { ok: false, status: 409, code: "MEMORY_PROPOSAL_CONFLICT", error: "只有待审核建议可以编辑" };
  const nextContent = content === undefined ? proposal.content : cleanText(content);
  if (!nextContent) return { ok: false, status: 400, code: "MEMORY_CONTENT_EMPTY", error: "记忆建议内容不能为空" };
  const nextCategory = category || section ? categoryFrom(category || section) : proposal.category;
  const previous = { content: proposal.content, category: proposal.category };
  proposal.content = nextContent;
  proposal.category = nextCategory;
  proposal.section = labelFor(nextCategory);
  appendHistory(proposal, "edited", { previous, content: nextContent, category: nextCategory });
  items[index] = proposal;
  saveStoredProposals(items);
  appendEvent({ clientId: proposal.clientId, threadId: proposal.threadId, runId: proposal.runId, type: "memory_proposal_edited", data: eventDetails(proposal) });
  return { ok: true, proposal };
}

export function rejectMemoryProposal(id, reason = "用户拒绝该记忆建议") {
  const items = readStoredProposals();
  const index = items.findIndex((item) => item.id === String(id || ""));
  if (index < 0) return { ok: false, status: 404, error: "proposal not found" };
  const proposal = normalizeProposal(items[index]);
  if (proposal.status !== "pending") return { ok: false, status: 409, code: "MEMORY_PROPOSAL_CONFLICT", error: "只有待审核建议可以拒绝" };
  proposal.status = "rejected";
  proposal.rejectionReason = cleanText(reason, 300) || "用户拒绝该记忆建议";
  proposal.rejectedAt = now();
  appendHistory(proposal, "rejected", { reason: proposal.rejectionReason });
  items[index] = proposal;
  saveStoredProposals(items);
  appendEvent({ clientId: proposal.clientId, threadId: proposal.threadId, runId: proposal.runId, type: "memory_proposal_rejected", data: { ...eventDetails(proposal), reason: proposal.rejectionReason } });
  return { ok: true, proposal };
}

function memoryFile(workspace) {
  return path.join(requireWorkspace(workspace), "memory", "MEMORY.md");
}

export function writeMemoryEntry({ workspace, category, content, runId = null, threadId = null, clientId = null, proposalId = null } = {}) {
  const root = requireWorkspace(workspace);
  const normalizedCategory = categoryFrom(category || "经验教训");
  const body = cleanText(content);
  if (!body) return { ok: false, code: "MEMORY_CONTENT_EMPTY", error: "记忆内容不能为空" };
  const target = memoryFile(root);
  const lock = acquireWriteLock({
    workspace: root,
    targetPath: target,
    runId: runId || `memory_approval_${crypto.randomUUID()}`,
    threadId,
    kind: "memory_approval",
  });
  try {
    ensureDirectory(path.dirname(target));
    let text = "";
    try { text = fs.readFileSync(target, "utf8"); } catch {}
    const title = `## ${labelFor(normalizedCategory)}`;
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((line) => line.trim() === title);
    const entry = `- ${body.replace(/\s+/g, " ")}`;
    let duplicate = false;
    if (start >= 0) {
      let end = start + 1;
      while (end < lines.length && !/^##\s+/.test(lines[end])) end += 1;
      duplicate = lines.slice(start + 1, end).some((line) => line.trim() === entry);
      if (!duplicate) lines.splice(end, 0, entry);
    } else {
      const base = lines.join("\n").trim();
      text = base ? `${base}\n\n${title}\n${entry}\n` : `# 记忆索引\n\n${title}\n${entry}\n`;
    }
    if (start >= 0 && !duplicate) text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    if (!duplicate) atomicWriteFile(target, text, "utf8");
    appendEvent({ clientId, threadId, runId, type: "memory_written", data: { proposalId, category: normalizedCategory, section: labelFor(normalizedCategory), workspace: root, duplicate } });
    return { ok: true, duplicate, category: normalizedCategory, section: labelFor(normalizedCategory), file: "memory/MEMORY.md" };
  } finally {
    releaseWriteLock(lock);
  }
}

export function approveMemoryProposal(id, { content, category, section, reviewer = "user" } = {}) {
  const edited = content !== undefined || category !== undefined || section !== undefined
    ? editMemoryProposal(id, { content, category, section })
    : { ok: true };
  if (!edited.ok) return edited;
  const items = readStoredProposals();
  const index = items.findIndex((item) => item.id === String(id || ""));
  if (index < 0) return { ok: false, status: 404, error: "proposal not found" };
  const proposal = normalizeProposal(items[index]);
  if (proposal.status === "approved") return { ok: true, proposal };
  if (proposal.status !== "pending") return { ok: false, status: 409, code: "MEMORY_PROPOSAL_CONFLICT", error: "只有待审核建议可以批准" };
  const result = writeMemoryEntry({
    workspace: proposal.workspace,
    category: proposal.category,
    content: proposal.content,
    runId: proposal.runId,
    threadId: proposal.threadId,
    clientId: proposal.clientId,
    proposalId: proposal.id,
  });
  if (!result.ok) {
    proposal.status = "failed";
    proposal.error = result.error;
    appendHistory(proposal, "failed", { error: result.error });
    items[index] = proposal;
    saveStoredProposals(items);
    appendEvent({ clientId: proposal.clientId, threadId: proposal.threadId, runId: proposal.runId, type: "memory_proposal_failed", data: { ...eventDetails(proposal), error: result.error } });
    return { ok: false, status: 500, code: result.code || "MEMORY_WRITE_FAILED", error: result.error, proposal };
  }
  proposal.status = "approved";
  proposal.reviewer = reviewer;
  proposal.approvedAt = now();
  appendHistory(proposal, "approved", { reviewer, duplicate: result.duplicate });
  items[index] = proposal;
  saveStoredProposals(items);
  appendEvent({ clientId: proposal.clientId, threadId: proposal.threadId, runId: proposal.runId, type: "memory_proposal_approved", data: { ...eventDetails(proposal), duplicate: result.duplicate } });
  return { ok: true, proposal, write: result };
}

export function mergeMemoryProposals(targetId, sourceIds = []) {
  const ids = [...new Set((Array.isArray(sourceIds) ? sourceIds : []).map(String).filter(Boolean))].filter((id) => id !== String(targetId || ""));
  const items = readStoredProposals();
  const targetIndex = items.findIndex((item) => item.id === String(targetId || ""));
  if (targetIndex < 0) return { ok: false, status: 404, error: "target proposal not found" };
  const target = normalizeProposal(items[targetIndex]);
  if (target.status !== "pending") return { ok: false, status: 409, code: "MEMORY_PROPOSAL_CONFLICT", error: "只有待审核建议可以合并" };
  const sources = ids.map((id) => ({ id, index: items.findIndex((item) => item.id === id) })).filter((item) => item.index >= 0).map((item) => ({ ...item, proposal: normalizeProposal(items[item.index]) }));
  if (!sources.length) return { ok: false, status: 400, error: "至少选择一条待合并建议" };
  if (sources.some(({ proposal }) => proposal.status !== "pending" || proposal.workspace !== target.workspace || proposal.category !== target.category)) {
    return { ok: false, status: 409, code: "MEMORY_PROPOSAL_CONFLICT", error: "只能合并同一工作区、同一分类下的待审核建议" };
  }
  const contents = [...new Set([target.content, ...sources.map(({ proposal }) => proposal.content)])];
  target.content = contents.join("；").slice(0, MAX_CONTENT);
  appendHistory(target, "merged", { sourceIds: sources.map(({ id }) => id), content: target.content });
  items[targetIndex] = target;
  for (const { index, id } of sources) {
    const source = normalizeProposal(items[index]);
    source.status = "merged";
    source.mergedInto = target.id;
    appendHistory(source, "merged_into", { targetId: target.id });
    items[index] = source;
  }
  saveStoredProposals(items);
  appendEvent({ clientId: target.clientId, threadId: target.threadId, runId: target.runId, type: "memory_proposal_merged", data: { ...eventDetails(target), sourceIds: sources.map(({ id }) => id) } });
  return { ok: true, proposal: target, merged: sources.map(({ id }) => id) };
}

export function getMemoryProposalHistory(id) {
  const proposal = findStoredProposal(readStoredProposals(), id);
  if (!proposal) return { ok: false, status: 404, error: "proposal not found" };
  return { ok: true, id: proposal.id, history: proposal.history, proposal };
}

export function memoryProposalStoreInfo() {
  return { file: PROPOSALS_FILE, count: readStoredProposals().length, categories: MEMORY_CATEGORIES };
}
