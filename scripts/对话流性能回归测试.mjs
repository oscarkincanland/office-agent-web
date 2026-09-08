#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planTaskCapabilities } from "../server/task.mjs";
import { beginRun, finishRun, getRun, runsDir } from "../server/runs.mjs";
import { 计算展示字符数 } from "../client/src/components/流式文本队列.js";
import { bashTimeoutPolicy, isGlobalSearchCommand, normalizeBashOptions } from "../server/命令安全策略.mjs";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "规聚对话流-"));
let runId = null;

try {
  // UI 的模式说明不可混入用户输入；普通 Agent 任务不应因此误触发 Office 或 Skills。
  const plan = planTaskCapabilities({ text: "测试一下", task: { mode: "agent" } });
  assert.equal(plan.routing.officecli, "not_needed");
  assert.equal(plan.routing.skills, "available_on_demand");
  assert.equal(isGlobalSearchCommand('find / -name "梳理总结"'), true);
  assert.equal(isGlobalSearchCommand('find . -name "梳理总结"'), false);
  assert.equal(normalizeBashOptions({}).timeout, bashTimeoutPolicy.defaultSeconds);
  assert.equal(normalizeBashOptions({ timeout: 999 }).timeout, bashTimeoutPolicy.maxSeconds);

  // 正常逐字显示，同时要能在短时间内追上没有 token 的 assistant_final。
  assert.equal(计算展示字符数({ remaining: 30, elapsedMs: 20, reducedMotion: true }), 30);
  assert.ok(计算展示字符数({ remaining: 30, elapsedMs: 20 }) >= 1);
  assert.ok(计算展示字符数({ remaining: 800, elapsedMs: 16 }) >= 20);

  // Chat 仍记录 Run，但不得为只读问答扫描、复制或追踪整个工作区。
  fs.writeFileSync(path.join(workspace, "大文件样本.txt"), "x".repeat(1024 * 1024), "utf8");
  const run = beginRun({
    clientId: "chat-flow-test",
    threadId: "chat-flow-thread",
    cwd: workspace,
    task: { mode: "chat", goal: "只读问答" },
    snapshotMode: "none",
  });
  runId = run.id;
  assert.equal(run.snapshotMode, "none");
  assert.equal(run.before.size, 0);
  assert.deepEqual(run.before.files, {});

  fs.writeFileSync(path.join(workspace, "不应作为聊天产物.txt"), "仅用于验证", "utf8");
  const completed = finishRun(run.id, { status: "completed", summary: "聊天回归" });
  assert.equal(completed.status, "completed");
  assert.equal(completed.artifacts.length, 0);
  assert.equal(getRun(run.id).snapshotMode, "none");

  console.log("对话流性能回归：通过");
} finally {
  if (runId) {
    fs.rmSync(path.join(runsDir(), runId), { recursive: true, force: true });
    fs.rmSync(path.join(runsDir(), `${runId}.json`), { force: true });
  }
  fs.rmSync(workspace, { recursive: true, force: true });
}
