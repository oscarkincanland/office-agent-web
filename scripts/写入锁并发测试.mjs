#!/usr/bin/env node
/**
 * 写锁并发测试：验证 P1 修复——工作区级锁"用完即放" + 冲突时短退避等待。
 *
 * 场景：Run A 持有工作区锁时，Run B 的写入不再立刻失败，而是等到 A 释放后继续；
 *      超过等待窗口才按 WRITE_CONFLICT 报错。
 *
 * 用法：node scripts/写入锁并发测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-lock-test-"));
process.env.OAW_WRITE_LOCK_DIR = path.join(workspace, ".locks");
const { acquireWriteLock, acquireWriteLockWithRetry, releaseWriteLock } = await import("../server/写入协调.mjs");

let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

await test("A 持锁时 B 等待，A 释放后 B 立即拿到锁", async () => {
  const tokenA = acquireWriteLock({ workspace, targetPath: workspace, runId: "run_A", kind: "bash" });
  const startedAt = Date.now();
  const waiting = acquireWriteLockWithRetry({ workspace, targetPath: workspace, runId: "run_B", kind: "bash" }, { timeoutMs: 5000, intervalMs: 100 });
  setTimeout(() => releaseWriteLock(tokenA), 600);
  const tokenB = await waiting;
  const waited = Date.now() - startedAt;
  assert.ok(tokenB?.key, "B 应该拿到锁");
  assert.ok(waited >= 500, `B 应该等待过（实测 ${waited}ms）`);
  releaseWriteLock(tokenB);
});

await test("等待窗口内无人释放时按 WRITE_CONFLICT 报错", async () => {
  const tokenA = acquireWriteLock({ workspace, targetPath: workspace, runId: "run_C", kind: "officecli" });
  const startedAt = Date.now();
  let message = "";
  try {
    await acquireWriteLockWithRetry({ workspace, targetPath: workspace, runId: "run_D", kind: "officecli" }, { timeoutMs: 800, intervalMs: 100 });
  } catch (error) {
    message = `${error.code}: ${error.message}`;
  }
  const waited = Date.now() - startedAt;
  releaseWriteLock(tokenA);
  assert.match(message, /WRITE_CONFLICT/, `应报 WRITE_CONFLICT，实际 ${message || "无错误"}`);
  assert.ok(waited >= 700, `应在窗口后才失败（实测 ${waited}ms）`);
});

await test("同 Run 重入仍然计数正确", async () => {
  const first = acquireWriteLock({ workspace, targetPath: workspace, runId: "run_E", kind: "bash" });
  const second = acquireWriteLock({ workspace, targetPath: workspace, runId: "run_E", kind: "bash" });
  assert.equal(second.reentrant, true);
  releaseWriteLock(second);
  releaseWriteLock(first);
  const after = acquireWriteLock({ workspace, targetPath: workspace, runId: "run_F", kind: "bash" });
  releaseWriteLock(after);
});

fs.rmSync(workspace, { recursive: true, force: true });
console.log(failed ? "\n写锁并发测试：存在失败" : "\n写锁并发测试：全部通过");
process.exit(failed);
