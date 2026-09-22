#!/usr/bin/env node
/**
 * 事件流归档测试（P2-11）。
 *
 * 在临时目录里用很小的归档阈值跑一遍：追加事件 → 自动切片归档 → 校验
 * 索引区间、序号连续性、内存窗口仍能读到最近事件。
 *
 * 用法：node scripts/事件流归档测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-events-test-"));
process.env.OAW_EVENT_DIR = dir;
// 归档阈值有 256KB 下限（避免病态小切片），这里按 256KB 跑
process.env.OAW_EVENT_ROTATE_BYTES = "262144";

const store = await import("../server/事件存储.mjs");

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

const payload = "x".repeat(2000); // 每条事件约 2.1KB，约 125 条触发一次 256KB 归档
const appended = [];
for (let i = 0; i < 160; i += 1) {
  const event = store.appendEvent({ clientId: "archive-test", threadId: "t1", runId: "run_archive", type: "prompt", data: { index: i, payload } });
  assert.ok(event, `第 ${i} 条事件应写入成功`);
  appended.push(event);
}

const archives = fs.readdirSync(dir).filter((name) => /^事件流-\d+\.jsonl$/.test(name)).sort();
const index = JSON.parse(fs.readFileSync(path.join(dir, "事件流索引.json"), "utf8"));
const info = store.eventStoreInfo();

test("活动文件超阈值后自动切片归档", () => {
  assert.ok(archives.length >= 1, `应产生归档文件，实际 ${archives.length} 个`);
  assert.ok(fs.existsSync(path.join(dir, "事件流.jsonl")), "活动文件应继续存在");
});

test("索引记录了归档区间与条数", () => {
  assert.equal(index.files.length, archives.length, "索引条数应与归档文件数一致");
  const first = index.files[0];
  assert.ok(first.count > 0, "归档条数应大于 0");
  assert.ok(Number.isFinite(first.fromSeq) && Number.isFinite(first.toSeq), "应记录 seq 区间");
  assert.ok(first.toSeq >= first.fromSeq, "区间应有序");
  assert.ok(first.fromAt && first.toAt, "应记录时间区间");
});

test("序号跨归档连续且不重复", () => {
  const seqs = appended.map((item) => item.seq);
  const unique = new Set(seqs);
  assert.equal(unique.size, seqs.length, "seq 不应重复");
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "seq 应单调递增");
  assert.equal(seqs[seqs.length - 1] - seqs[0] + 1, seqs.length, "seq 应连续（无空洞）");
});

test("内存窗口仍能读到最近事件", () => {
  const latest = appended[appended.length - 1].seq;
  const listed = store.listEvents({ runId: "run_archive", limit: 20 });
  assert.ok(listed.events.length > 0, "应能列出最近事件");
  assert.equal(listed.latest, latest, "latest 应等于最后一条事件的 seq");
  assert.ok(listed.events.every((item) => item.seq <= latest), "列出的 seq 不应超过 latest");
});

test("强制归档可用且信息可读", () => {
  const rotated = store.rotateEventLog({ force: true });
  assert.ok(rotated && rotated.count > 0, "强制归档应返回归档信息");
  const after = store.eventStoreInfo();
  assert.ok(after.archives >= archives.length, "归档数应增加");
  assert.ok(after.earliest > 0, "归档后仍应有可读的 earliest");
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? "\n事件流归档测试：存在失败" : "\n事件流归档测试：全部通过");
process.exitCode = failed ? 1 : 0;
