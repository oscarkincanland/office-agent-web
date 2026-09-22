#!/usr/bin/env node
/**
 * 进度播报测试（v0.11.8）：
 * 1) 前端归约器：模型回合计数、进度播报里程碑、agent_end 轮次/工具/耗时；
 * 2) 进度行文案与耗时格式化；
 * 3) 服务端接线：周期播报常量、turn-progress 事件源、系统提示语言约束是否在位。
 *
 * 用法: node scripts/进度播报测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRunTrace,
  formatDuration,
  reduceRunTrace,
  runTraceProgressText,
  summarizeRunTrace,
} from "../client/src/运行轨迹.js";
import {
  TURN_BUDGET_HARD,
  TURN_BUDGET_SOFT,
  turnBudgetPolicy,
  turnNoticeKind,
  turnNoticeText,
} from "../server/轮次预算.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); failed = 1; }
function test(name, fn) {
  try {
    fn();
    ok(name);
  } catch (e) {
    fail(`${name}: ${e.message}`);
  }
}

const at = (n) => new Date(Date.UTC(2026, 8, 22, 10, 0, n)).toISOString();
const ev = (type, data = {}, second = 0) => ({ type, at: at(second), data });

// ---------- 1. 回合计数与进度里程碑 ----------
console.log("\n▶ 回合计数与进度里程碑");

test("turn_started 累计模型回合数", () => {
  const trace = reduceRunTrace([
    ev("run_admitted", { runId: "run_p" }, 0),
    ev("turn_started", { turnIndex: 0 }, 1),
    ev("turn_started", { turnIndex: 1 }, 2),
    ev("turn_started", { turnIndex: 2 }, 3),
  ]);
  assert.equal(trace.turns, 3);
  assert.equal(summarizeRunTrace(trace).turns, 3);
});

test("周期进度播报记录为里程碑，普通插话不记录", () => {
  const trace = reduceRunTrace([
    ev("turn_started", {}, 0),
    ev("steer", { source: "turn-progress", message: "请给一段进度小结", turnCount: 6 }, 1),
    ev("turn_started", {}, 2),
    ev("steer", { source: "user", text: "换成表格" }, 3),
  ]);
  assert.equal(trace.notes.length, 1);
  assert.equal(trace.notes[0].source, "turn-progress");
  assert.equal(trace.notes[0].turnCount, 6);
  assert.equal(summarizeRunTrace(trace).noteCount, 1);
});

test("轮次预算提醒同样进入里程碑（含硬预算）", () => {
  const trace = reduceRunTrace([
    ev("steer", { source: "turn-budget", message: "阶段结论", turnCount: 25 }, 0),
    ev("steer", { source: "turn-budget-hard", message: "立即收尾", turnCount: 45 }, 1),
  ]);
  assert.equal(trace.notes.length, 2);
  assert.equal(trace.notes[1].source, "turn-budget-hard");
});

test("重复回放同一条 steer 不产生重复里程碑（幂等）", () => {
  const steer = ev("steer", { source: "turn-progress", message: "小结", turnCount: 6 }, 5);
  const trace = reduceRunTrace([steer, steer]);
  assert.equal(trace.notes.length, 1);
});

// ---------- 2. agent_end 与进度行文案 ----------
console.log("\n▶ 进度行文案");

test("agent_end 携带轮次/工具/耗时", () => {
  const trace = reduceRunTrace([
    ev("run_admitted", {}, 0),
    ev("agent_end", { turns: 12, tools: 9, durationMs: 192000 }, 1),
  ]);
  assert.equal(trace.turns, 12);
  assert.equal(trace.durationMs, 192000);
});

test("进度行包含轮次、工具、待办与用时", () => {
  const trace = reduceRunTrace([
    ev("run_admitted", { runId: "run_p" }, 0),
    ev("turn_started", {}, 1),
    ev("turn_started", {}, 2),
    ev("tool_start", { toolCallId: "t1", name: "read" }, 3),
    ev("tool_end", { toolCallId: "t1", name: "read" }, 4),
    ev("todo_updated", { items: [{ id: "a", title: "读材料", status: "completed" }, { id: "b", title: "写报告", status: "planned" }] }, 5),
    ev("agent_end", { turns: 2, tools: 1, durationMs: 125000 }, 6),
  ]);
  const text = runTraceProgressText(trace, { running: false });
  assert.match(text, /第 2 轮/);
  assert.match(text, /工具 1/);
  assert.match(text, /待办 1\/2/);
  assert.match(text, /用时 2 分 5 秒/);
});

test("运行中按 startedAt 实时计算用时", () => {
  const trace = reduceRunTrace([ev("run_admitted", {}, 0), ev("turn_started", {}, 1)]);
  const startedAt = new Date(trace.startedAt).getTime();
  const text = runTraceProgressText(trace, { running: true, now: startedAt + 65000 });
  assert.match(text, /用时 1 分 5 秒/);
});

test("耗时格式化覆盖秒/分/小时", () => {
  assert.equal(formatDuration(45000), "45 秒");
  assert.equal(formatDuration(120000), "2 分");
  assert.equal(formatDuration(192000), "3 分 12 秒");
  assert.equal(formatDuration(3720000), "1 小时 2 分");
});

test("空轨迹不产生噪音文案", () => {
  const trace = createRunTrace("run_empty");
  assert.equal(runTraceProgressText(trace), "");
});

// ---------- 3. 服务端接线 ----------
console.log("\n▶ 服务端接线");

const agentSource = fs.readFileSync(path.join(ROOT, "server/agent.mjs"), "utf8");
const budgetSource = fs.readFileSync(path.join(ROOT, "server/轮次预算.mjs"), "utf8");
const sidebarSource = fs.readFileSync(path.join(ROOT, "client/src/components/SessionSidebar.jsx"), "utf8");
const chatSource = fs.readFileSync(path.join(ROOT, "client/src/components/ChatPanel.jsx"), "utf8");

test("周期播报间隔可配置且默认 6 轮", () => {
  assert.match(budgetSource, /OAW_TURN_PROGRESS_INTERVAL \|\| "6"/);
  assert.match(budgetSource, /interval > 0 && turn >= minTurns && turn % interval === 0/);
  assert.match(agentSource, /turnNoticeKind\(entry\.turnCount\)/);
});

test("周期播报通过 steer 下发并要求写进正文", () => {
  assert.match(agentSource, /source: noticeKind/);
  assert.match(budgetSource, /请先在正文里给用户一段 2-3 行的进度小结/);
});

test("轮次预算 25/45 仍然保留（来自统一策略模块）", () => {
  assert.equal(TURN_BUDGET_SOFT, 25);
  assert.equal(TURN_BUDGET_HARD, 45);
  assert.match(agentSource, /from "\.\/轮次预算\.mjs"/);
});

test("提醒判定顺序：周期播报不顶掉 25/45 关键点", () => {
  const seq = [];
  for (let turn = 1; turn <= 50; turn += 1) {
    const kind = turnNoticeKind(turn);
    if (kind) seq.push(`${turn}:${kind}`);
  }
  assert.deepEqual(seq, [
    "6:turn-progress",
    "12:turn-progress",
    "18:turn-progress",
    "24:turn-progress",
    "25:turn-budget",
    "30:turn-progress",
    "36:turn-progress",
    "42:turn-progress",
    "45:turn-budget-hard",
    "48:turn-progress",
  ]);
});

test("间隔设为 0 时只保留 25/45 关键点", () => {
  const seq = [];
  for (let turn = 1; turn <= 50; turn += 1) {
    const kind = turnNoticeKind(turn, { interval: 0 });
    if (kind) seq.push(`${turn}:${kind}`);
  }
  assert.deepEqual(seq, ["25:turn-budget", "45:turn-budget-hard"]);
});

test("自定义间隔与最小回合数生效", () => {
  assert.equal(turnNoticeKind(4, { interval: 4, minTurns: 4 }), "turn-progress");
  assert.equal(turnNoticeKind(3, { interval: 4, minTurns: 4 }), null);
  assert.equal(turnNoticeKind(0), null);
});

test("提醒文案包含轮次数与行为要求", () => {
  assert.match(turnNoticeText("turn-progress", 12), /本轮已经进行 12 个模型回合/);
  assert.match(turnNoticeText("turn-progress", 12), /不要在小结里调用工具/);
  assert.match(turnNoticeText("turn-budget", 25), /ask_user/);
  assert.match(turnNoticeText("turn-budget-hard", 45), /complete_task/);
  assert.equal(turnNoticeText("unknown", 1), "");
});

test("轮次策略快照可读", () => {
  const policy = turnBudgetPolicy();
  assert.equal(typeof policy.interval, "number");
  assert.equal(policy.soft, 25);
  assert.equal(policy.hard, 45);
  assert.equal(typeof policy.enabled, "boolean");
});

test("取消后的 Run 不再注入进度提醒、也不再继续 ask_user 后续执行", () => {
  assert.match(agentSource, /isRunStopping/);
  assert.match(agentSource, /!this\.isRunStopping\(entry\.clientId\)/);
  assert.match(agentSource, /本轮任务已被用户取消，请立即停止执行/);
  assert.match(agentSource, /\["cancel_requested", "cancelled", "aborted"\]\.includes\(status\)/);
});

test("系统指令要求中文表达与进度可见", () => {
  assert.match(agentSource, /表达语言（重要）/);
  assert.match(agentSource, /内部推理（thinking \/ reasoning）一律使用与用户相同的语言/);
  assert.match(agentSource, /进度可见（重要）/);
});

test("前端不再把 steer 文案读成 data.text", () => {
  assert.match(chatSource, /data\.message \|\| data\.text/);
  assert.match(chatSource, /pushSystemNote/);
  assert.doesNotMatch(chatSource, /pushSystem\(`⟳ 插入新指令: \$\{\(data\.text \|\| ""\)\.slice/);
});

test("压缩与文件变更走系统提示聚合而不是气泡", () => {
  assert.match(chatSource, /key: "compact"/);
  assert.match(chatSource, /key: "file_changed"/);
  assert.doesNotMatch(chatSource, /pushSystem\(`文件已更新:/);
});

test("运行中的会话名使用跑马灯文本", () => {
  assert.match(sidebarSource, /跑马灯文本/);
  assert.match(sidebarSource, /RUNNING_SESSION_STATUSES/);
});

if (failed) {
  console.error("\n进度播报测试：存在失败项");
  process.exitCode = 1;
} else {
  console.log("\n进度播报测试：全部通过");
}
