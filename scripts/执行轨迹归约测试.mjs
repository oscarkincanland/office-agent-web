#!/usr/bin/env node
/**
 * 执行轨迹归约测试（阶段二）：
 * 校验工具聚合、幂等去重、孤儿 tool_end 恢复与完成语义。
 * 用法: node scripts/执行轨迹归约测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import {
  completionLabel,
  createRunTrace,
  reduceRunTrace,
  runTraceSummaryText,
  summarizeRunTrace,
} from "../client/src/运行轨迹.js";
import { inferCompletion, normalizeCompletion } from "../server/运行轨迹.mjs";

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

const at = (n) => new Date(Date.UTC(2026, 8, 17, 10, 0, n)).toISOString();

function ev(type, data = {}, second = 0) {
  return { type, at: at(second), data };
}

// ---------- 1. 工具聚合 ----------
console.log("\n▶ 工具聚合");

test("start/output/end 合成一条工具记录", () => {
  const trace = reduceRunTrace([
    ev("run_admitted", { runId: "run_1" }, 0),
    ev("tool_start", { toolCallId: "t1", name: "read", input: "a.md" }, 1),
    ev("tool_output", { toolCallId: "t1", output: "第一段" }, 2),
    ev("tool_output", { toolCallId: "t1", output: "第二段" }, 3),
    ev("tool_end", { toolCallId: "t1", name: "read", result: "ok" }, 4),
  ]);
  assert.equal(trace.tools.length, 1);
  const tool = trace.tools[0];
  assert.equal(tool.name, "read");
  assert.equal(tool.status, "done");
  assert.equal(tool.output, "第一段第二段");
  assert.equal(tool.duration, 3);
  assert.equal(tool.startMissing, false);
});

test("多个工具并行不互相覆盖", () => {
  const trace = reduceRunTrace([
    ev("tool_start", { toolCallId: "a", name: "read" }, 0),
    ev("tool_start", { toolCallId: "b", name: "bash", input: "ls" }, 1),
    ev("tool_end", { toolCallId: "a", name: "read" }, 2),
    ev("tool_end", { toolCallId: "b", name: "bash", isError: true }, 3),
  ]);
  assert.equal(trace.tools.length, 2);
  assert.equal(trace.tools.find((tool) => tool.toolCallId === "a").isError, false);
  assert.equal(trace.tools.find((tool) => tool.toolCallId === "b").isError, true);
  const stats = summarizeRunTrace(trace);
  assert.equal(stats.toolOk, 1);
  assert.equal(stats.toolFailed, 1);
});

test("孤儿 tool_end 创建恢复记录", () => {
  const trace = reduceRunTrace([
    ev("tool_end", { toolCallId: "lost", name: "write", result: "已写入" }, 0),
  ]);
  assert.equal(trace.tools.length, 1);
  assert.equal(trace.tools[0].startMissing, true);
  assert.equal(trace.tools[0].status, "done");
});

test("重复回放幂等（重连不产生重复工具）", () => {
  const events = [
    ev("tool_start", { toolCallId: "t1", name: "read" }, 0),
    ev("tool_end", { toolCallId: "t1", name: "read" }, 1),
  ];
  const trace = reduceRunTrace([...events, ...events]);
  assert.equal(trace.tools.length, 1);
});

// ---------- 2. 文件与错误 ----------
console.log("\n▶ 文件与错误");

test("file_changed 跨事件去重合并", () => {
  const trace = reduceRunTrace([
    ev("file_changed", { files: ["a.md", "b.md"] }, 0),
    ev("file_changed", { files: ["b.md", "c.md"] }, 1),
  ]);
  assert.deepEqual(trace.files, ["a.md", "b.md", "c.md"]);
});

test("agent_error 与 officecli_failed 记入错误", () => {
  const trace = reduceRunTrace([
    ev("agent_error", { message: "模型超时" }, 0),
    ev("officecli_failed", { message: "命令失败" }, 1),
  ]);
  assert.equal(trace.errors.length, 2);
});

// ---------- 3. 完成语义 ----------
console.log("\n▶ 完成语义");

test("显式 task_completed 优先于 run_finished 推断", () => {
  const trace = reduceRunTrace([
    ev("task_completed", { status: "partial", summary: "完成一半", incomplete: ["第三步"] }, 0),
    ev("run_finished", { status: "completed" }, 1),
  ]);
  assert.equal(trace.completion.status, "partial");
  assert.equal(trace.completion.source, "explicit");
  assert.deepEqual(trace.completion.incomplete, ["第三步"]);
  assert.equal(trace.phase, "done");
});

test("无显式声明时 run_finished 推断为 inferred", () => {
  const success = reduceRunTrace([ev("run_finished", { status: "completed" }, 0)]);
  assert.equal(success.completion.status, "success");
  assert.equal(success.completion.source, "inferred");
  const failedRun = reduceRunTrace([ev("run_finished", { status: "failed" }, 0)]);
  assert.equal(failedRun.completion.status, "failed");
  assert.equal(failedRun.phase, "failed");
});

test("run_finished 携带服务端 completion 时直接采用", () => {
  const trace = reduceRunTrace([
    ev("run_finished", { status: "completed", completion: { status: "blocked", source: "explicit", summary: "缺数据", blockers: ["数据源不可用"] } }, 0),
  ]);
  assert.equal(trace.completion.status, "blocked");
});

test("折叠摘要包含工具统计与完成状态", () => {
  const trace = reduceRunTrace([
    ev("tool_start", { toolCallId: "t1", name: "read" }, 0),
    ev("tool_end", { toolCallId: "t1", name: "read" }, 1),
    ev("tool_start", { toolCallId: "t2", name: "write" }, 2),
    ev("tool_end", { toolCallId: "t2", name: "write", isError: true }, 3),
    ev("file_changed", { files: ["out.md"] }, 4),
    ev("task_completed", { status: "partial", summary: "部分完成" }, 5),
  ]);
  const text = runTraceSummaryText(trace);
  assert.match(text, /已调用 2 个工具/);
  assert.match(text, /1 成功/);
  assert.match(text, /1 失败/);
  assert.match(text, /1 个文件变更/);
  assert.match(text, /部分完成/);
  assert.equal(completionLabel("blocked"), "受阻");
});

// ---------- 4. 服务端完成模块 ----------
console.log("\n▶ 服务端完成模块");

test("normalizeCompletion 校验状态与摘要", () => {
  assert.equal(normalizeCompletion({ status: "nope", summary: "x" }), null);
  assert.equal(normalizeCompletion({ status: "success", summary: "  " }), null);
  const value = normalizeCompletion({ status: "success", summary: "已生成报告", verification: "read 回读通过" });
  assert.equal(value.status, "success");
  assert.equal(value.source, "explicit");
  assert.equal(value.verification, "read 回读通过");
});

test("inferCompletion 区分失败/取消/部分完成", () => {
  assert.equal(inferCompletion({ runStatus: "completed" }).status, "success");
  assert.equal(inferCompletion({ runStatus: "failed" }).status, "failed");
  assert.equal(inferCompletion({ runStatus: "cancelled" }).status, "cancelled");
  assert.equal(inferCompletion({ runStatus: "completed", validations: [{ status: "failed" }] }).status, "partial");
});

console.log(failed ? "\n执行轨迹归约：失败" : "\n执行轨迹归约：通过");
process.exit(failed ? 1 : 0);
