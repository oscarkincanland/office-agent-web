/**
 * 运行预算与重复失败门禁（E02）——纯逻辑，无 IO，可单测。
 *
 * 设计约束（对应计划 8-E02）：
 *  - 模型回合、工具次数、有效运行时长、连续失败、重复无进展、输出预算统一在这里评估；
 *  - 等待用户 / 审批 / 用户接管时间不计入有效执行时长（noteWaiting）；
 *  - 工具参数用“完整规范化指纹”（键排序 + 稳定序列化 + sha1），不用截断前缀；
 *  - 文件 read 的版本变化与合理轮询单独处理，不误伤；
 *  - 软预算 = 一次显式暂停/继续选择（continue 即显式加预算）；硬预算 = 停止新的任务工具。
 *
 * 说明：本模块只负责“判断”，执行层（Pi 扩展的 tool_call 拦截 / 回合循环）负责消费结论。
 * 默认值保留 25/45 轮作为兼容基线；其余阈值可由设置/任务配置覆盖。
 */
import crypto from "node:crypto";

export const TURN_BUDGET_SOFT = 25;
export const TURN_BUDGET_HARD = 45;
export const TOOL_BUDGET_SOFT = 80;
export const TOOL_BUDGET_HARD = 160;
export const EFFECTIVE_MS_SOFT = 45 * 60 * 1000;
export const EFFECTIVE_MS_HARD = 90 * 60 * 1000;
/** 同一参数指纹连续出现多少次视为“重复无进展”（read 类另行处理）。 */
export const REPEAT_LIMIT = 2;
/** 连续失败（同一指纹）达到多少次即停止该操作。 */
export const FAILURE_LIMIT = 2;
/** read 类工具的合理轮询上限（超过才视为无进展）。 */
export const READ_POLL_LIMIT = 5;

const READ_TOOLS = new Set(["read", "grep", "find", "ls", "glob", "kb_read", "kb_search", "context_read"]);

/** 稳定序列化：对象键排序，数组保序，循环引用标 [Circular]。 */
export function stableStringify(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key], seen)}`).join(",")}}`;
}

/** 完整规范化参数指纹（sha1，长度固定），不是截断前缀。 */
export function fingerprintArgs(args) {
  return crypto.createHash("sha1").update(stableStringify(args ?? null)).digest("hex");
}

/** read 类工具提取版本令牌：显式 version/revision/mtime 字段优先，其次整参指纹。 */
export function readVersionToken(args) {
  if (!args || typeof args !== "object") return "";
  for (const key of ["version", "revision", "mtime", "mtimeMs", "hash"]) {
    if (args[key] !== undefined && args[key] !== null) return String(args[key]);
  }
  return "";
}

function defaults(limits = {}) {
  return {
    turnSoft: limits.turnSoft ?? TURN_BUDGET_SOFT,
    turnHard: limits.turnHard ?? TURN_BUDGET_HARD,
    toolSoft: limits.toolSoft ?? TOOL_BUDGET_SOFT,
    toolHard: limits.toolHard ?? TOOL_BUDGET_HARD,
    effectiveSoftMs: limits.effectiveSoftMs ?? EFFECTIVE_MS_SOFT,
    effectiveHardMs: limits.effectiveHardMs ?? EFFECTIVE_MS_HARD,
    repeatLimit: limits.repeatLimit ?? REPEAT_LIMIT,
    failureLimit: limits.failureLimit ?? FAILURE_LIMIT,
    readPollLimit: limits.readPollLimit ?? READ_POLL_LIMIT,
  };
}

/** 新建一次运行的预算状态。 */
export function createRunBudget({ runId = null, limits = {} } = {}) {
  return {
    runId,
    limits: defaults(limits),
    turns: 0,
    toolCalls: 0,
    toolFailures: 0,
    effectiveMs: 0,
    waitingMs: 0,
    softNoticeTurn: null,
    softNoticeTool: null,
    hardStopped: false,
    budgetBonus: { turns: 0, tools: 0 },
    lastCall: null, // { key, tool, ok, versionToken, count, failCount }
    lastToolError: null,
  };
}

/** 记录一个模型回合（回合数 +1）。 */
export function noteTurn(state) {
  state.turns += 1;
  return state.turns;
}

/** 记录等待时间（用户回答/审批/接管）：计入 waitingMs，不计入有效执行时长。 */
export function noteWaiting(state, ms) {
  const value = Number(ms);
  if (Number.isFinite(value) && value > 0) state.waitingMs += value;
  return state.waitingMs;
}

/** 记录有效执行时间（模型/工具实际在跑的时间）。 */
export function noteEffective(state, ms) {
  const value = Number(ms);
  if (Number.isFinite(value) && value > 0) state.effectiveMs += value;
  return state.effectiveMs;
}

/** 用户显式“继续”即授权增加预算（软预算暂停后的动作）。 */
export function grantBudget(state, { turns = 0, tools = 0 } = {}) {
  state.budgetBonus.turns += Math.max(0, Number(turns) || 0);
  state.budgetBonus.tools += Math.max(0, Number(tools) || 0);
  state.hardStopped = false;
  state.softNoticeTurn = null;
  state.softNoticeTool = null;
  return state.budgetBonus;
}

/**
 * 工具执行前门禁。执行层必须在工具真正运行前调用。
 * @returns {{allow: boolean, code: string|null, reason: string, level: "soft"|"hard"|null}}
 */
export function evaluateToolGate(state, { toolName = "", args = null } = {}) {
  const limits = state.limits;
  const toolLimitSoft = limits.toolSoft + state.budgetBonus.tools;
  const toolLimitHard = limits.toolHard + state.budgetBonus.tools;

  // 硬预算：停止新的任务工具（执行层负责让当前写入安全收尾）。
  if (state.toolCalls >= toolLimitHard || state.hardStopped) {
    return { allow: false, code: "TOOL_BUDGET_HARD", level: "hard", reason: `工具调用已达硬预算（${state.toolCalls}/${toolLimitHard}），停止新的任务工具，仅允许安全收尾` };
  }
  if (state.effectiveMs >= limits.effectiveHardMs) {
    return { allow: false, code: "TIME_BUDGET_HARD", level: "hard", reason: `有效执行时长已达硬预算（${Math.round(state.effectiveMs / 1000)}s/${Math.round(limits.effectiveHardMs / 1000)}s）` };
  }

  const key = fingerprintArgs({ tool: toolName, args });
  const previous = state.lastCall;
  const isRead = READ_TOOLS.has(String(toolName));
  const versionToken = isRead ? readVersionToken(args) : "";

  // 连续失败门禁：同一指纹连续失败达到阈值 → 停止该操作（计划：同样错误连续两次且没有状态改变）。
  if (previous && previous.key === key && previous.ok === false && previous.failCount >= limits.failureLimit) {
    return { allow: false, code: "REPEAT_FAILURE", level: "hard", reason: `同一操作已连续失败 ${previous.failCount} 次且参数未变，停止该操作：${toolName}` };
  }

  // 重复无进展：同指纹连续出现超过阈值。read 类允许“版本变化”与“合理轮询”。
  if (previous && previous.key === key) {
    if (isRead) {
      const versionChanged = versionToken && previous.versionToken && versionToken !== previous.versionToken;
      const sameVersionPolling = previous.count < limits.readPollLimit;
      if (versionChanged || sameVersionPolling) {
        return { allow: true, code: null, level: null, reason: "" };
      }
      return { allow: false, code: "REPEAT_NO_PROGRESS", level: "soft", reason: `同一读取已轮询 ${previous.count} 次且内容版本未变，请复用已有结果或说明为何需要重读` };
    }
    if (previous.count >= limits.repeatLimit) {
      return { allow: false, code: "REPEAT_NO_PROGRESS", level: "soft", reason: `同一操作与参数已连续出现 ${previous.count} 次且无状态变化，请改用不同参数或说明原因` };
    }
  }

  const level = state.toolCalls >= toolLimitSoft ? "soft" : null;
  return { allow: true, code: null, level, reason: level ? `工具调用接近软预算（${state.toolCalls}/${toolLimitSoft}）` : "" };
}

/** 工具执行后记录结果（执行层在拿到结果后调用）。 */
export function noteToolResult(state, { toolName = "", args = null, ok = true, error = "" } = {}) {
  state.toolCalls += 1;
  if (!ok) state.toolFailures += 1;
  const key = fingerprintArgs({ tool: toolName, args });
  const previous = state.lastCall;
  const isRead = READ_TOOLS.has(String(toolName));
  const versionToken = isRead ? readVersionToken(args) : "";
  if (previous && previous.key === key) {
    previous.count += 1;
    previous.failCount = ok ? 0 : previous.failCount + 1;
    previous.ok = ok;
    previous.versionToken = versionToken || previous.versionToken;
  } else {
    state.lastCall = { key, tool: toolName, ok, versionToken, count: 1, failCount: ok ? 0 : 1 };
  }
  if (!ok) state.lastToolError = { tool: toolName, error: String(error || "").slice(0, 300), at: Date.now() };
  else state.lastToolError = null;
  return state;
}

/**
 * 下一模型回合前的预算评估。
 * @returns {{level: "soft"|"hard"|null, code: string|null, reason: string}}
 */
export function evaluateTurnGate(state) {
  const limits = state.limits;
  const turnLimitSoft = limits.turnSoft + state.budgetBonus.turns;
  const turnLimitHard = limits.turnHard + state.budgetBonus.turns;
  if (state.turns >= turnLimitHard) {
    return { level: "hard", code: "TURN_BUDGET_HARD", reason: `模型回合已达硬预算（${state.turns}/${turnLimitHard}），进入受限收尾（最多一个收尾回合，不得再改文件）` };
  }
  if (state.effectiveMs >= limits.effectiveHardMs) {
    return { level: "hard", code: "TIME_BUDGET_HARD", reason: `有效执行时长已达硬预算，进入受限收尾` };
  }
  if (state.toolCalls >= limits.toolHard + state.budgetBonus.tools) {
    return { level: "hard", code: "TOOL_BUDGET_HARD", reason: `工具次数已达硬预算，进入受限收尾` };
  }
  if (state.turns === turnLimitSoft && state.softNoticeTurn !== state.turns) {
    state.softNoticeTurn = state.turns;
    return { level: "soft", code: "TURN_BUDGET_SOFT", reason: `已完成 ${state.turns} 个模型回合（软预算），请给出阶段结论并询问用户是否继续；继续即显式增加预算` };
  }
  if (state.toolCalls >= limits.toolSoft + state.budgetBonus.tools && state.softNoticeTool === null) {
    state.softNoticeTool = state.toolCalls;
    return { level: "soft", code: "TOOL_BUDGET_SOFT", reason: `工具调用已达软预算（${state.toolCalls}），请收束任务或请求继续` };
  }
  return { level: null, code: null, reason: "" };
}

/** 诊断快照（供任务中心/日志展示，不参与判断）。 */
export function budgetSnapshot(state) {
  return {
    runId: state.runId,
    turns: state.turns,
    toolCalls: state.toolCalls,
    toolFailures: state.toolFailures,
    effectiveMs: state.effectiveMs,
    waitingMs: state.waitingMs,
    hardStopped: state.hardStopped,
    bonus: { ...state.budgetBonus },
    lastCall: state.lastCall ? { tool: state.lastCall.tool, count: state.lastCall.count, failCount: state.lastCall.failCount, ok: state.lastCall.ok } : null,
  };
}
