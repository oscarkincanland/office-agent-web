#!/usr/bin/env node
/**
 * 运行预算与重复失败门禁测试（E02）。
 * 只测纯逻辑（server/运行预算.mjs），不依赖 Pi 运行时；执行层接线由后续扩展负责。
 *
 * 用法: node scripts/运行预算测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRunBudget,
  noteTurn,
  noteWaiting,
  noteEffective,
  noteToolResult,
  evaluateToolGate,
  evaluateTurnGate,
  grantBudget,
  fingerprintArgs,
  stableStringify,
  budgetSnapshot,
} from "../server/运行预算.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed = 1;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}

console.log("\n▶ 指纹与规范化");
test("参数指纹与键序无关、与值有关", () => {
  const a = fingerprintArgs({ path: "/x/a.docx", options: { depth: 3, mode: "text" } });
  const b = fingerprintArgs({ options: { mode: "text", depth: 3 }, path: "/x/a.docx" });
  const c = fingerprintArgs({ options: { mode: "text", depth: 4 }, path: "/x/a.docx" });
  assert.equal(a, b, "键序不同不应改变指纹");
  assert.notEqual(a, c, "参数值变化必须改变指纹");
  assert.equal(a.length, 40, "指纹应为完整 sha1，不是截断前缀");
});
test("稳定序列化处理循环引用", () => {
  const obj = { name: "x" };
  obj.self = obj;
  assert.match(stableStringify(obj), /Circular/);
});

console.log("\n▶ 回合预算");
test("第 25 回合触发软预算且只提醒一次", () => {
  const s = createRunBudget();
  for (let i = 0; i < 24; i += 1) noteTurn(s);
  assert.equal(evaluateTurnGate(s).level, null, "24 回合不应触发");
  noteTurn(s);
  const soft = evaluateTurnGate(s);
  assert.equal(soft.level, "soft");
  assert.equal(soft.code, "TURN_BUDGET_SOFT");
  assert.equal(evaluateTurnGate(s).level, null, "同一回合不重复提醒");
});
test("第 45 回合触发硬预算", () => {
  const s = createRunBudget();
  for (let i = 0; i < 45; i += 1) noteTurn(s);
  const hard = evaluateTurnGate(s);
  assert.equal(hard.level, "hard");
  assert.equal(hard.code, "TURN_BUDGET_HARD");
});
test("显式继续（grantBudget）提高上限并解除硬停", () => {
  const s = createRunBudget();
  for (let i = 0; i < 45; i += 1) noteTurn(s);
  assert.equal(evaluateTurnGate(s).level, "hard");
  grantBudget(s, { turns: 30, tools: 40 });
  const after = evaluateTurnGate(s);
  assert.notEqual(after.level, "hard", "加预算后不应再是硬预算");
  assert.equal(after.level, null, "新的软预算阈值（55）尚未到达");
  for (let i = 0; i < 10; i += 1) noteTurn(s);
  assert.equal(evaluateTurnGate(s).level, "soft", "到达新的软预算阈值（55）时应再次提醒");
});

console.log("\n▶ 工具门禁");
test("工具次数达硬预算时停止新工具", () => {
  const s = createRunBudget({ limits: { toolHard: 3 } });
  for (let i = 0; i < 3; i += 1) noteToolResult(s, { toolName: "read", args: { path: `/f${i}` }, ok: true });
  const gate = evaluateToolGate(s, { toolName: "write", args: { path: "/f9" } });
  assert.equal(gate.allow, false);
  assert.equal(gate.code, "TOOL_BUDGET_HARD");
  assert.equal(gate.level, "hard");
});
test("同一操作连续失败两次后停止该操作", () => {
  const s = createRunBudget();
  const args = { path: "/x/a.docx", command: "view" };
  noteToolResult(s, { toolName: "bash", args, ok: false, error: "boom" });
  const gate1 = evaluateToolGate(s, { toolName: "bash", args });
  assert.equal(gate1.allow, true, "第一次失败后仍允许（给一次修正机会）");
  noteToolResult(s, { toolName: "bash", args, ok: false, error: "boom" });
  const gate2 = evaluateToolGate(s, { toolName: "bash", args });
  assert.equal(gate2.allow, false);
  assert.equal(gate2.code, "REPEAT_FAILURE");
});
test("非 read 的重复无进展在阈值后拦截", () => {
  const s = createRunBudget({ limits: { repeatLimit: 2 } });
  const args = { path: "/x", content: "same" };
  noteToolResult(s, { toolName: "write", args, ok: true });
  assert.equal(evaluateToolGate(s, { toolName: "write", args }).allow, true, "第 2 次允许");
  noteToolResult(s, { toolName: "write", args, ok: true });
  const gate = evaluateToolGate(s, { toolName: "write", args });
  assert.equal(gate.allow, false);
  assert.equal(gate.code, "REPEAT_NO_PROGRESS");
});
test("read 允许合理轮询，超过上限才拦截；版本变化立即放行", () => {
  const s = createRunBudget({ limits: { readPollLimit: 3 } });
  const args = { path: "/x/a.md", version: "v1" };
  for (let i = 0; i < 3; i += 1) {
    assert.equal(evaluateToolGate(s, { toolName: "read", args }).allow, true, `第 ${i + 1} 次轮询应允许`);
    noteToolResult(s, { toolName: "read", args, ok: true });
  }
  const blocked = evaluateToolGate(s, { toolName: "read", args });
  assert.equal(blocked.allow, false, "超过轮询上限应拦截");
  assert.equal(blocked.code, "REPEAT_NO_PROGRESS");
  const changed = evaluateToolGate(s, { toolName: "read", args: { ...args, version: "v2" } });
  assert.equal(changed.allow, true, "版本变化必须放行");
});
test("不同参数的 read 不受影响", () => {
  const s = createRunBudget();
  noteToolResult(s, { toolName: "read", args: { path: "/a", version: "1" }, ok: true });
  assert.equal(evaluateToolGate(s, { toolName: "read", args: { path: "/b", version: "1" } }).allow, true);
});

console.log("\n▶ 有效时长");
test("等待用户/审批的时间不计入有效执行时长", () => {
  const s = createRunBudget();
  noteEffective(s, 5000);
  noteWaiting(s, 60000);
  noteWaiting(s, 120000);
  assert.equal(s.effectiveMs, 5000, "有效时长只含实际执行");
  assert.equal(s.waitingMs, 180000, "等待时长单独记录");
  const snap = budgetSnapshot(s);
  assert.equal(snap.waitingMs, 180000);
});
test("有效时长达到硬预算时工具与回合都被拦", () => {
  const s = createRunBudget({ limits: { effectiveHardMs: 1000 } });
  noteEffective(s, 1200);
  assert.equal(evaluateToolGate(s, { toolName: "write", args: { path: "/x" } }).code, "TIME_BUDGET_HARD");
  assert.equal(evaluateTurnGate(s).code, "TIME_BUDGET_HARD");
});

console.log("\n▶ 静态契约");
test("预算模块不依赖 IO，执行层接线待扩展", () => {
  const source = fs.readFileSync(path.join(ROOT, "server/运行预算.mjs"), "utf8");
  assert.doesNotMatch(source, /from "node:fs"|require\("fs"\)/, "纯逻辑模块不应读写文件");
  assert.match(source, /evaluateToolGate/, "必须提供工具执行前门禁");
  assert.match(source, /fingerprintArgs/, "必须用完整规范化指纹");
  assert.match(source, /noteWaiting/, "必须区分等待时长");
});

console.log(failed ? "\n✗ 运行预算测试未通过\n" : "\n✓ 运行预算测试全部通过\n");
process.exit(failed ? 1 : 0);
