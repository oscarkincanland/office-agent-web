/**
 * 轮次预算与周期进度播报（唯一事实来源）。
 *
 * 背景：长任务此前只在第 25 轮才有一次阶段结论，24 轮以内的任务完全没有"做到哪了"
 * 的表达；超长任务则一路跑到 50+ 轮。这里把三条规则集中到一处，供运行时代码与测试共用：
 *   1. 每 N 轮（默认 6，`OAW_TURN_PROGRESS_INTERVAL=0` 关闭）提醒一次进度小结；
 *   2. 第 25 轮（软预算）要求阶段结论并询问用户是否继续；
 *   3. 第 45 轮（硬预算）要求立即收尾并显式声明完成状态。
 */

export const TURN_BUDGET_SOFT = 25;
export const TURN_BUDGET_HARD = 45;
/** 周期进度播报间隔（0 = 关闭）。 */
export const TURN_PROGRESS_INTERVAL = Math.max(0, Number.parseInt(process.env.OAW_TURN_PROGRESS_INTERVAL || "6", 10) || 0);
/** 少于该回合数不播报，避免短任务被无谓打断（可用 OAW_TURN_PROGRESS_MIN_TURNS 调整）。 */
export const TURN_PROGRESS_MIN_TURNS = Math.max(1, Number.parseInt(process.env.OAW_TURN_PROGRESS_MIN_TURNS || "6", 10) || 6);

/**
 * 当前回合需要注入哪一类提醒。
 * @param {number} turnCount 已完成的模型回合数（从 1 开始）
 * @returns {"turn-budget"|"turn-budget-hard"|"turn-progress"|null}
 */
export function turnNoticeKind(turnCount, {
  interval = TURN_PROGRESS_INTERVAL,
  soft = TURN_BUDGET_SOFT,
  hard = TURN_BUDGET_HARD,
  minTurns = TURN_PROGRESS_MIN_TURNS,
} = {}) {
  const turn = Number(turnCount || 0);
  if (!Number.isFinite(turn) || turn <= 0) return null;
  // 关键点优先：25/45 轮是明确的收尾节点，不能被周期播报顶掉
  if (turn === soft) return "turn-budget";
  if (turn === hard) return "turn-budget-hard";
  if (interval > 0 && turn >= minTurns && turn % interval === 0) return "turn-progress";
  return null;
}

/** 各提醒的正文；与事件里的 steer message 保持一致，避免两处文案漂移。 */
export function turnNoticeText(kind, turnCount, { interval = TURN_PROGRESS_INTERVAL } = {}) {
  const turn = Number(turnCount || 0);
  switch (kind) {
    case "turn-progress":
      return `[系统提醒] 本轮已经进行 ${turn} 个模型回合。请先在正文里给用户一段 2-3 行的进度小结：已经完成了什么、当前正在做什么、下一步准备做什么。写完小结后再继续，不要在小结里调用工具。`;
    case "turn-budget":
      return `[系统提醒] 本轮已经进行 ${turn} 个模型回合。请先给出一段阶段结论（已完成什么、还差什么、下一步计划），并用 ask_user 询问用户是否继续，不要无汇报地继续扩大范围。`;
    case "turn-budget-hard":
      return `[系统提醒] 本轮已经进行 ${turn} 个模型回合，已明显超出常规预算。请立即收尾：总结当前结果、把未完成项写入 complete_task 的 incomplete，并调用 complete_task 结束本轮，剩余工作交给用户决定是否新开一轮。`;
    default:
      return "";
  }
}

/** 进度播报开关与间隔的可读描述（供运行时快照/诊断展示）。 */
export function turnBudgetPolicy() {
  return {
    interval: TURN_PROGRESS_INTERVAL,
    minTurns: TURN_PROGRESS_MIN_TURNS,
    soft: TURN_BUDGET_SOFT,
    hard: TURN_BUDGET_HARD,
    enabled: TURN_PROGRESS_INTERVAL > 0,
  };
}
