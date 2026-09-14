import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PROJECT_DIR } from "./workspace.mjs";
import { atomicWriteJson } from "./持久化工具.mjs";

// 工具级审批策略：参考 opencode 的 permission 模型（allow / ask / deny 三值，
// 通配符匹配、最后匹配生效）。规则可持久化到 .oaw/permissions.json，
// 用户在前端选择"总是允许"后会追加一条 allow 规则覆盖默认 ask。

const PERMISSIONS_FILE = path.join(PROJECT_DIR, ".oaw", "permissions.json");
const PENDING_APPROVALS_FILE = path.join(PROJECT_DIR, ".oaw", "pending-approvals.json");
const APPROVAL_TIMEOUT_MS = 300000; // 5 分钟，超时视为拒绝（比 ask_user 更保守）

export const APPROVAL_ACTIONS = Object.freeze(["allow", "ask", "deny"]);

// 默认规则：catch-all allow 在前，具体 ask/deny 在后（最后匹配生效）。
const DEFAULT_RULES = [
  { tool: "*", pattern: "*", action: "allow" },
  // Office 写入类命令默认先问，避免 Agent 未经确认就改文档
  { tool: "officecli", pattern: "set *", action: "ask" },
  { tool: "officecli", pattern: "batch *", action: "ask" },
  { tool: "officecli", pattern: "add *", action: "ask" },
  { tool: "officecli", pattern: "remove *", action: "ask" },
  { tool: "officecli", pattern: "move *", action: "ask" },
  { tool: "officecli", pattern: "swap *", action: "ask" },
  { tool: "officecli", pattern: "delete *", action: "ask" },
  { tool: "officecli", pattern: "create *", action: "ask" },
  { tool: "officecli", pattern: "import *", action: "ask" },
  { tool: "officecli", pattern: "save *", action: "ask" },
  { tool: "officecli", pattern: "open *", action: "ask" },
  { tool: "officecli", pattern: "close *", action: "ask" },
  // bash 删除/破坏类命令默认先问
  { tool: "bash", pattern: "del *", action: "ask" },
  { tool: "bash", pattern: "rm *", action: "ask" },
  { tool: "bash", pattern: "rmdir *", action: "ask" },
  { tool: "bash", pattern: "rd *", action: "ask" },
  { tool: "bash", pattern: "remove-item *", action: "ask" },
  { tool: "bash", pattern: "format *", action: "ask" },
  // 地图样式/数据修改默认先问
  { tool: "map_edit", pattern: "*", action: "ask" },
  { tool: "map_import", pattern: "*", action: "ask" },
  // 敏感文件禁止写入
  { tool: "write", pattern: "*.env", action: "deny" },
  { tool: "write", pattern: "*.env.*", action: "deny" },
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** opencode 风格通配符：* 匹配任意字符，? 匹配单个字符。 */
export function wildcardToRegExp(pattern) {
  const escaped = escapeRegExp(String(pattern || ""));
  return new RegExp(`^${escaped.replace(/\\\*/g, ".*").replace(/\\\?/g, ".")}$`, "i");
}

function readPermissionConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PERMISSIONS_FILE, "utf8"));
    return {
      rules: Array.isArray(parsed.rules) ? parsed.rules : [],
      mode: parsed.mode === "auto" ? "auto" : "ask",
    };
  } catch {
    return { rules: [], mode: "ask" };
  }
}

function readUserRules() {
  return readPermissionConfig().rules;
}

function readPendingApprovals() {
  try { return JSON.parse(fs.readFileSync(PENDING_APPROVALS_FILE, "utf8")); } catch { return []; }
}

function savePendingApprovals(items) {
  fs.mkdirSync(path.dirname(PENDING_APPROVALS_FILE), { recursive: true });
  atomicWriteJson(PENDING_APPROVALS_FILE, items.slice(-200));
}

/** 按 工具×输入 匹配规则，返回 action（allow/ask/deny）；最后匹配的规则生效。 */
export function matchToolAction(tool, input) {
  const toolName = String(tool || "").trim().toLowerCase();
  const inputText = String(input || "").trim();
  const rules = [...DEFAULT_RULES, ...readUserRules()];
  let matched = "allow";
  for (const rule of rules) {
    if (!rule || !APPROVAL_ACTIONS.includes(rule.action)) continue;
    const ruleTool = String(rule.tool || "*").trim().toLowerCase();
    if (ruleTool !== "*" && ruleTool !== toolName) continue;
    if (wildcardToRegExp(rule.pattern || "*").test(inputText || "*")) {
      matched = rule.action;
    }
  }
  // 自动批准只放行默认的 ask；显式 deny 永远不能被自动批准绕过。
  return readPermissionConfig().mode === "auto" && matched === "ask" ? "allow" : matched;
}

export function getApprovalMode() {
  return readPermissionConfig().mode;
}

export function setApprovalMode(mode = "ask") {
  const nextMode = mode === "auto" ? "auto" : "ask";
  const config = readPermissionConfig();
  fs.mkdirSync(path.dirname(PERMISSIONS_FILE), { recursive: true });
  atomicWriteJson(PERMISSIONS_FILE, { rules: config.rules, mode: nextMode, updatedAt: new Date().toISOString() });
  return { ok: true, mode: nextMode };
}

/** 追加用户规则并持久化（"总是允许"）。 */
export function addUserRule(tool, pattern, action) {
  if (!APPROVAL_ACTIONS.includes(action)) return { ok: false, error: `invalid action: ${action}` };
  const config = readPermissionConfig();
  const rules = config.rules;
  const clean = { tool: String(tool || "*").trim().toLowerCase(), pattern: String(pattern || "*"), action };
  rules.push(clean);
  fs.mkdirSync(path.dirname(PERMISSIONS_FILE), { recursive: true });
  atomicWriteJson(PERMISSIONS_FILE, { rules, mode: config.mode, updatedAt: new Date().toISOString() });
  return { ok: true, rule: clean, rules };
}

export function listPermissionRules() {
  const config = readPermissionConfig();
  return { mode: config.mode, defaults: DEFAULT_RULES, user: config.rules };
}

// 等待中的审批：approvalId -> { resolve, reject, item, timer }
const pendingApprovals = new Map();

function persistPendingApproval(item) {
  const items = readPendingApprovals().filter((x) => x.id !== item.id);
  items.push(item);
  savePendingApprovals(items);
}

function updatePersistedApproval(id, patch) {
  const items = readPendingApprovals();
  const item = items.find((x) => x.id === id);
  if (item) { Object.assign(item, patch, { resolvedAt: new Date().toISOString() }); savePendingApprovals(items); }
}

/**
 * 工具执行前调用：返回前为 allow（继续执行）或抛错（deny/超时/被拒绝）。
 * ask 时挂起等待用户在前端审批（允许一次 / 总是允许 / 拒绝），
 * 等待项持久化到 .oaw/pending-approvals.json，服务重启后仍可恢复。
 */
export function requireToolApproval({ entry, tool, input, runId, threadId, workspace, emit }) {
  const action = matchToolAction(tool, input);
  if (action === "allow") return Promise.resolve();
  if (action === "deny") {
    const error = new Error(`工具调用被权限策略拒绝（${tool}）：${String(input || "").slice(0, 200)}`);
    error.code = "APPROVAL_DENIED";
    error.action = "deny";
    return Promise.reject(error);
  }
  const approvalId = `approval_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const item = {
    id: approvalId,
    tool,
    input: String(input || "").slice(0, 600),
    runId: runId || entry?.activeRunId || null,
    threadId: threadId || entry?.threadId || null,
    clientId: entry?.clientId || null,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(approvalId);
      updatePersistedApproval(approvalId, { status: "expired", decision: "expired" });
      const error = new Error(`工具审批等待超过 ${Math.round(APPROVAL_TIMEOUT_MS / 60000)} 分钟未获批准，已取消本次操作`);
      error.code = "APPROVAL_TIMEOUT";
      reject(error);
    }, APPROVAL_TIMEOUT_MS);
    const settled = (decision) => {
      clearTimeout(timer);
      pendingApprovals.delete(approvalId);
      updatePersistedApproval(approvalId, { status: decision === "allow" ? "approved" : "rejected", decision });
      try {
        emit?.("tool_approval_resolved", { id: approvalId, tool, input: item.input, runId: item.runId, decision });
      } catch {}
      if (decision === "allow") {
        resolve();
      } else {
        const error = new Error(`工具调用被用户拒绝（${tool}）：${String(input || "").slice(0, 200)}`);
        error.code = "APPROVAL_DENIED";
        error.action = "deny";
        reject(error);
      }
    };
    pendingApprovals.set(approvalId, { resolve: settled, reject: settled, item, timer });
    persistPendingApproval(item);
    try {
      emit?.("tool_approval_request", {
        id: approvalId,
        tool,
        input: item.input,
        runId: item.runId,
        threadId: item.threadId,
        workspace: workspace || entry?.workspace || null,
        action,
      });
    } catch {}
  });
}

/** 前端提交审批决定。decision: allow（允许一次）/ always（总是允许）/ deny（拒绝）。 */
export function resolveToolApproval(id, decision = "allow") {
  const pending = pendingApprovals.get(String(id || ""));
  const decisionNorm = String(decision || "allow").toLowerCase();
  const allow = decisionNorm === "allow" || decisionNorm === "always";
  if (decisionNorm === "always" && pending?.item) {
    const { tool, input } = pending.item;
    const pattern = input.split(/\s+/)[0] ? `${input.split(/\s+/)[0]} *` : "*";
    addUserRule(tool, pattern, "allow");
  }
  if (!pending) {
    const items = readPendingApprovals();
    const item = items.find((x) => x.id === id && x.status === "pending");
    if (item) {
      item.status = allow ? "approved" : "rejected";
      item.decision = allow ? "allow" : "deny";
      item.resolvedAt = new Date().toISOString();
      savePendingApprovals(items);
      return { ok: true, recovered: true, id, decision: allow ? "allow" : "deny" };
    }
    return { ok: false, error: "approval not found or already resolved" };
  }
  pending.resolve(allow ? "allow" : "deny");
  return { ok: true, id, decision: allow ? "allow" : "deny", always: decisionNorm === "always" };
}

export function listPendingApprovals() {
  return readPendingApprovals().filter((x) => x.status === "pending");
}
