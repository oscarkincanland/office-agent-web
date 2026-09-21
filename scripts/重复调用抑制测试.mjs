#!/usr/bin/env node
/**
 * P2 通道重试与重复调用抑制测试。
 *
 * 1) 重复调用抑制：同一 Run 内同工具+同参数第 3 次触发一次提醒（steer + 事件），
 *    之后的重复不再提醒；换参数或换 Run 重新计数。
 * 2) 错误分类：Connection error / 503 / 超时 归为可重试，401/无效密钥归为不可重试，
 *    空 400 仍可被识别（保留原有安全重放语义）。
 *
 * 用法：node scripts/重复调用抑制测试.mjs
 */
import assert from "node:assert/strict";

const { noteRepeatedToolCall, classifyAgentError, isEmptyBadRequestError } = await import("../server/agent.mjs");

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

const makeHarness = () => {
  const events = [];
  const steered = [];
  const entry = { activeRunId: "run_test_1" };
  const session = { steer: (text) => { steered.push(text); return Promise.resolve(); } };
  const emit = (type, data) => events.push({ type, data });
  return { entry, session, emit, events, steered };
};

test("同参数第 3 次触发一次提醒，之后不再提醒", () => {
  const h = makeHarness();
  const ev = { toolName: "bash", args: { command: "ls F:\\龙港数据" } };
  noteRepeatedToolCall(h.entry, h.session, ev, h.emit);
  noteRepeatedToolCall(h.entry, h.session, ev, h.emit);
  assert.equal(h.events.length, 0, "前两次不应提醒");
  noteRepeatedToolCall(h.entry, h.session, ev, h.emit);
  assert.equal(h.events.filter((e) => e.type === "tool_repeat_warning").length, 1, "第 3 次应提醒一次");
  assert.equal(h.steered.length, 1, "第 3 次应 steer 一次");
  assert.match(h.steered[0], /同一操作已第 3 次/, "提醒文案要包含次数");
  noteRepeatedToolCall(h.entry, h.session, ev, h.emit);
  noteRepeatedToolCall(h.entry, h.session, ev, h.emit);
  assert.equal(h.events.filter((e) => e.type === "tool_repeat_warning").length, 1, "后续重复不再提醒");
});

test("换参数重新计数、换 Run 清空计数", () => {
  const h = makeHarness();
  const base = { toolName: "officecli", args: { args: "query a.docx comment --json" } };
  for (let i = 0; i < 3; i += 1) noteRepeatedToolCall(h.entry, h.session, base, h.emit);
  assert.equal(h.events.length, 1, "第一组重复应提醒一次");
  const other = { toolName: "officecli", args: { args: "query b.docx comment --json" } };
  for (let i = 0; i < 3; i += 1) noteRepeatedToolCall(h.entry, h.session, other, h.emit);
  assert.equal(h.events.length, 2, "换参数后应重新计数并提醒");
  h.entry.activeRunId = "run_test_2";
  for (let i = 0; i < 3; i += 1) noteRepeatedToolCall(h.entry, h.session, base, h.emit);
  assert.equal(h.events.length, 3, "换 Run 后应重新计数并提醒");
});

test("错误分类：网络类可重试、鉴权类不可重试", () => {
  assert.equal(classifyAgentError(new Error("Connection error.")).retryable, true, "Connection error 应可重试");
  assert.equal(classifyAgentError(new Error("503 Service Unavailable")).retryable, true, "503 应可重试");
  assert.equal(classifyAgentError(new Error("模型连接超过 45 秒没有响应，已自动中止")).retryable, true, "首事件超时应可重试（走模型切换）");
  assert.equal(classifyAgentError(new Error("401: {\"message\":\"Invalid API Key\"}")).retryable, false, "无效密钥不可重试");
  assert.equal(classifyAgentError(new Error("invalid request: context length exceeded")).retryable, false, "请求类错误不可重试");
});

test("空 400 仍被识别为可安全重放", () => {
  const error = new Error("400 status code (no body)");
  assert.equal(isEmptyBadRequestError(error), true, "空 400 应可识别");
  assert.equal(classifyAgentError(error).retryable, true, "空 400 应可重试");
});

console.log(failed ? "\nP2 测试：存在失败" : "\nP2 测试：全部通过");
process.exit(failed);
