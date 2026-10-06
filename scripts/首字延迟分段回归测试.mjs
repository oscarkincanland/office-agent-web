#!/usr/bin/env node
/**
 * 首字延迟分段计时回归（验收计划 §3.5）。
 *
 * 这里测的是“测量本身是否可信”，不是模型有多快：
 * 1. 缺某一段必须留 null，不能用 0 伪装成“极快”（否则 P95 好看得离谱）；
 * 2. 客户端上报与 Run 终态是两个独立信号，先后顺序都要落到同一条样本；
 * 3. token→DOM 必须能被单独量出来，否则“前端渲染慢”与“模型慢”永远分不开；
 * 4. 白名单外的字段不能混进聚合统计。
 */
import assert from "node:assert/strict";
import {
  markRunTiming,
  attachRunTimingMeta,
  finishRunTiming,
  mergeClientTiming,
  latencySummary,
  recentLatencySamples,
  STAGE_KEYS,
} from "../server/首字延迟.mjs";

// 1. 样本先后顺序：客户端先到、终态后到
markRunTiming("run_order_a", "serverReceivedAt", 1000);
markRunTiming("run_order_a", "admissionReadyAt", 1200);
attachRunTimingMeta("run_order_a", { model: "M3", mode: "chat" });
markRunTiming("run_order_a", "sdkRequestDispatchedAt", 1300);
markRunTiming("run_order_a", "firstProviderEventAt", 9000);
markRunTiming("run_order_a", "firstTextDeltaAt", 9500);
assert.deepEqual(mergeClientTiming("run_order_a", { clientSubmitAt: 900, firstEventAt: 9600, firstDomTextAt: 9650 }), { merged: true, finalized: false });
const sampleA = finishRunTiming("run_order_a");
assert.ok(sampleA, "客户端先到时，终态仍应结算出一条样本");
assert.equal(sampleA.serverReceivedToAdmissionReadyMs, 200, "服务端准备耗时应可单独读出");
assert.equal(sampleA.sdkDispatchToFirstProviderEventMs, 7700, "SDK 派发到首个 provider 事件应独立于传输延迟");
assert.equal(sampleA.tokenToDomMs, 150, "token→DOM 渲染耗时必须可单独量出");
assert.equal(sampleA.model, "M3");

// 2. 样本先后顺序：终态先到、客户端后到（页面刷新/关闭导致上报更晚）
markRunTiming("run_order_b", "serverReceivedAt", 1000);
finishRunTiming("run_order_b");
assert.deepEqual(mergeClientTiming("run_order_b", { clientSubmitAt: 950, firstDomTextAt: 2000 }), { merged: true, finalized: true });
const sampleB = recentLatencySamples(50).find((item) => item.runId === "run_order_b");
assert.equal(sampleB.submitToFirstDomTextMs, 1050, "迟到的客户端样本必须回填到已结算的样本上");

// 3. 缺失的阶段留 null，而不是 0
markRunTiming("run_sparse", "serverReceivedAt", 1000);
finishRunTiming("run_sparse");
const sparse = recentLatencySamples(50).find((item) => item.runId === "run_sparse");
assert.equal(sparse.tokenToDomMs, null, "没有对应阶段时必须留 null");
assert.notEqual(sparse.tokenToDomMs, 0, "缺失阶段不得伪装成 0ms");

// 4. 白名单：非阶段字段一律丢弃
const rejected = mergeClientTiming("run_sparse", { clientSubmitAt: 900, evilField: 1, __proto__: { polluted: true } });
assert.equal(rejected.merged, true);
const sparseAfter = recentLatencySamples(50).find((item) => item.runId === "run_sparse");
assert.equal(sparseAfter.evilField, undefined, "白名单外的字段不得进入样本");
assert.equal({}.polluted, undefined, "上报不得污染 Object 原型");
assert.ok(STAGE_KEYS.includes("firstDomTextAt") && STAGE_KEYS.includes("clientSubmitAt"));

// 5. 聚合：count 为 0 时 p50/p95 必须是 null
const summary = latencySummary();
assert.ok(summary.sampleCount >= 3, `应至少累计 3 条样本，实际 ${summary.sampleCount}`);
assert.equal(summary.stages.tokenToDomMs.count, 1, "只有 run_order_a 同时有 token 与 DOM 两个时刻，才能量出 token→DOM");
assert.ok(summary.stages.tokenToDomMs.p95 >= summary.stages.tokenToDomMs.p50);
assert.ok(summary.models["M3"] >= 1, "聚合应按模型分桶");
assert.ok(summary.stages.firstEventAt.count >= 1);

// 6. 分位数口径：空数组不得返回 0
const fresh = await import("../server/首字延迟.mjs");
assert.equal(fresh.percentile([], 95), null, "空样本的 P95 必须是 null");

console.log("首字延迟分段计时回归：通过");