#!/usr/bin/env node
/**
 * SSE 事件协议回归测试（阶段一）：
 * 校验通道代际游标、历史截断通知和高频增量淘汰策略。
 * 用法: node scripts/SSE事件协议回归测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHANNEL_HISTORY_LIMIT,
  PROTOCOL_VERSION,
  createStreamId,
  isHistoryTruncated,
  pushChannelEvent,
  resolveReplayCursor,
} from "../server/事件协议.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
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

// ---------- 1. 通道代际 ----------
console.log("\n▶ 通道代际与游标");

test("streamId 唯一且可区分代际", () => {
  const list = new Set(Array.from({ length: 50 }, () => createStreamId()));
  assert.equal(list.size, 50);
  for (const id of list) assert.match(id, /^stream_[0-9a-z]+_[0-9a-f]{8}$/);
});

test("相同代际时保留请求游标", () => {
  assert.equal(resolveReplayCursor({ clientStreamId: "stream_a", channelStreamId: "stream_a", lastId: 42, channelSeq: 50 }), 42);
});

test("代际变化时游标清零（Runtime 重建核心场景）", () => {
  assert.equal(resolveReplayCursor({ clientStreamId: "stream_old", channelStreamId: "stream_new", lastId: 300, channelSeq: 5 }), 0);
});

test("未携带代际但游标超过当前序号时清零（旧客户端兜底）", () => {
  assert.equal(resolveReplayCursor({ clientStreamId: "", channelStreamId: "stream_a", lastId: 300, channelSeq: 5 }), 0);
});

test("未携带代际且游标在序号范围内时保留", () => {
  assert.equal(resolveReplayCursor({ clientStreamId: "", channelStreamId: "stream_a", lastId: 10, channelSeq: 30 }), 10);
});

// ---------- 2. 历史截断 ----------
console.log("\n▶ 历史截断通知");

test("游标早于历史最早序号时判定截断", () => {
  assert.equal(isHistoryTruncated({ lastId: 5, earliestId: 100 }), true);
});

test("游标与历史衔接时不判定截断", () => {
  assert.equal(isHistoryTruncated({ lastId: 99, earliestId: 100 }), false);
  assert.equal(isHistoryTruncated({ lastId: 200, earliestId: 100 }), false);
});

test("零游标（全新连接）不判定截断", () => {
  assert.equal(isHistoryTruncated({ lastId: 0, earliestId: 100 }), false);
});

// ---------- 3. 高频增量淘汰策略 ----------
console.log("\n▶ 生命周期事件保护");

test("溢出时优先淘汰 token 增量，工具边界保留", () => {
  const channel = { history: [], seq: 0, historyLimit: 10 };
  const push = (type, data = {}) => {
    const event = { id: ++channel.seq, type, at: new Date().toISOString(), streamId: "s", data };
    pushChannelEvent(channel, event);
    return event;
  };
  push("tool_start", { name: "read" });
  for (let i = 0; i < 30; i += 1) push("token", { text: "x" });
  push("tool_end", { name: "read" });
  push("assistant_final", { text: "完成" });
  push("run_finished", { status: "completed" });

  assert.equal(channel.history.length, 10);
  const types = channel.history.map((item) => item.type);
  assert.ok(types.includes("tool_start"), "tool_start 不应被淘汰");
  assert.ok(types.includes("tool_end"), "tool_end 不应被淘汰");
  assert.ok(types.includes("assistant_final"), "assistant_final 不应被淘汰");
  assert.ok(types.includes("run_finished"), "run_finished 不应被淘汰");
});

test("全部为生命周期事件时退回 FIFO 且不超限", () => {
  const channel = { history: [], seq: 0, historyLimit: 5 };
  for (let i = 0; i < 8; i += 1) {
    pushChannelEvent(channel, { id: ++channel.seq, type: "turn_started", at: new Date().toISOString(), data: {} });
  }
  assert.equal(channel.history.length, 5);
  assert.equal(channel.history[0].id, 4);
});

test("默认上限为 4000 且与协议版本一致", () => {
  assert.equal(CHANNEL_HISTORY_LIMIT, 4000);
  assert.equal(PROTOCOL_VERSION, 2);
});

// ---------- 4. 服务端接入点检查 ----------
console.log("\n▶ 服务端接入点");

const serverSource = fs.readFileSync(path.join(ROOT, "server", "index.mjs"), "utf8");
const agentSource = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
const chatSource = fs.readFileSync(path.join(ROOT, "client", "src", "components", "ChatPanel.jsx"), "utf8");

test("SSE 握手携带代际与截断信息", () => {
  assert.match(serverSource, /streamId: channelStreamId/);
  assert.match(serverSource, /earliest: earliestId/);
  assert.match(serverSource, /latest: latestId/);
  assert.match(serverSource, /truncated: historyTruncated/);
  assert.match(serverSource, /resolveReplayCursor\(/);
  assert.match(serverSource, /isHistoryTruncated\(/);
});

test("截断时发送 stream_resync", () => {
  assert.match(serverSource, /type: "stream_resync"/);
});

test("通道创建携带 streamId 并保护生命周期事件", () => {
  assert.match(agentSource, /streamId: createStreamId\(\)/);
  assert.ok(agentSource.split("pushChannelEvent(").length >= 3, "emit 与 emitChannelSafe 都应使用受保护写入");
});

test("前端按代际保存游标并在处理成功后提交", () => {
  assert.match(chatSource, /streamIdsRef/);
  assert.match(chatSource, /eventHandlerRef\.current\?\.\(payload\);\r?\n\s*if \(eventId > eventCursorRef\.current\)/);
});

test("前端处理 stream_resync 与 runtime_init_failed 终态", () => {
  assert.match(chatSource, /case "stream_resync":/);
  assert.doesNotMatch(chatSource, /setStatusMsg\(/);
  assert.match(chatSource, /case "runtime_init_failed":[\s\S]{0,600}setBusy\(false\)/);
});

console.log(failed ? "\nSSE 事件协议回归：失败" : "\nSSE 事件协议回归：通过");
process.exit(failed ? 1 : 0);
