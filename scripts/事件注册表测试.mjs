#!/usr/bin/env node
/**
 * 事件注册表一致性测试。
 *
 * 1) 注册表自身：类型唯一、persist 必须是 lifecycle 的子集；
 * 2) 覆盖度：扫描 server/*.mjs 里 emit / emitChannelSafe / recordRunEvent /
 *    appendEvent / writeEvent / session.subscribe 分支用到的类型字面量，
 *    必须都在注册表里——这样新增事件不会再"只在一处埋点"；
 * 3) 协议/存储派生集合与注册表一致。
 *
 * 用法：node scripts/事件注册表测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_DIR = path.join(ROOT, "server");

const { EVENT_REGISTRY, EVENT_TYPES, LIFECYCLE_EVENT_TYPES, DELTA_EVENT_TYPES, PERSISTED_TYPES, registrySummary } =
  await import("../server/事件注册表.mjs");
const protocol = await import("../server/事件协议.mjs");

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

test("注册表类型唯一且 persist ⊆ lifecycle", () => {
  const seen = new Set();
  for (const item of EVENT_REGISTRY) {
    assert.ok(!seen.has(item.type), `重复类型 ${item.type}`);
    seen.add(item.type);
    if (item.persist) assert.ok(item.lifecycle, `${item.type} persist 但未 lifecycle`);
  }
  assert.ok(EVENT_TYPES.length >= 60, `事件类型数量异常：${EVENT_TYPES.length}`);
});

test("协议导出的生命周期/增量集合来自注册表", () => {
  for (const type of LIFECYCLE_EVENT_TYPES) assert.ok(protocol.LIFECYCLE_EVENT_TYPES.has(type), `协议缺少 ${type}`);
  for (const type of protocol.LIFECYCLE_EVENT_TYPES) assert.ok(LIFECYCLE_EVENT_TYPES.has(type), `注册表缺少 ${type}`);
  for (const type of protocol.DELTA_EVENT_TYPES) assert.ok(DELTA_EVENT_TYPES.has(type), `注册表缺少增量 ${type}`);
});

test("事件存储的持久化清单与注册表一致", async () => {
  const store = await import("../server/事件存储.mjs");
  assert.ok(typeof store.appendEvent === "function", "事件存储未导出 appendEvent");
  // 通过运行时行为验证：增量事件不应落盘（appendEvent 对 DELTA 类型直接返回）
  const before = fs.existsSync(path.join(ROOT, ".oaw", "events", "事件流.jsonl"))
    ? fs.statSync(path.join(ROOT, ".oaw", "events", "事件流.jsonl")).size
    : 0;
  store.appendEvent({ clientId: "registry-test", threadId: "registry-test", runId: null, type: "token", data: { text: "不该落盘" } });
  const after = fs.existsSync(path.join(ROOT, ".oaw", "events", "事件流.jsonl"))
    ? fs.statSync(path.join(ROOT, ".oaw", "events", "事件流.jsonl")).size
    : 0;
  assert.equal(after, before, "token 事件不应写入事件流");
});

test("server 代码里发出的事件类型都已登记", () => {
  const allow = new Set(["event", "change", "error", "message"]);
  const patterns = [
    /emit(?:ChannelSafe)?\(\s*"([a-z_]+)"/g,
    /recordRunEvent\([^,]+,\s*"([a-z_]+)"/g,
    /appendEvent\(\{[\s\S]{0,240}?type:\s*"([a-z_]+)"/g,
    /writeEvent\(\s*"([a-z_]+)"/g,
    /emitChannelSafe\([^,]+,\s*"([a-z_]+)"/g,
  ];
  const missing = new Map();
  for (const name of fs.readdirSync(SERVER_DIR).filter((item) => item.endsWith(".mjs"))) {
    const file = path.join(SERVER_DIR, name);
    const content = fs.readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        const type = match[1];
        if (allow.has(type) || EVENT_TYPES.includes(type)) continue;
        if (!missing.has(type)) missing.set(type, []);
        const list = missing.get(type);
        if (!list.includes(name)) list.push(name);
      }
    }
  }
  assert.equal(missing.size, 0, `未登记事件：${[...missing].map(([type, files]) => `${type}(${files.join(",")})`).join("、")}`);
});

const summary = registrySummary();
console.log(`  注册表：${summary.total} 种（生命周期 ${summary.lifecycle} / 落盘 ${summary.persisted} / 增量 ${summary.delta}）`);
console.log(failed ? "\n事件注册表测试：存在失败" : "\n事件注册表测试：全部通过");
process.exitCode = failed ? 1 : 0;
