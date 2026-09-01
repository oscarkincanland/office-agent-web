import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncLimiter, PiRuntimeManager, runtimeCapabilities } from "../server/Pi运行时管理.mjs";
import { runRuntimeEvaluation } from "../server/运行评测.mjs";
import { beginRun, finishRun, getRun, recordRunEvent, updateRunCheckpoint } from "../server/runs.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "规聚阶段六-"));

try {
  const limiter = new AsyncLimiter(1, "test");
  let active = 0;
  let peak = 0;
  const task = async (delay) => limiter.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
  });
  await Promise.all([task(12), task(8), task(4)]);
  assert.equal(peak, 1, "并发闸门应限制同时执行数量");
  assert.equal(limiter.snapshot().active, 0, "任务结束后不得遗留 active 资源");
  assert.equal(limiter.snapshot().queued, 0, "任务结束后不得遗留排队任务");

  const recordFile = path.join(temp, "运行时记录.json");
  const manager = new PiRuntimeManager({ recordFile, agentConcurrency: 1, officeConcurrency: 1 });
  const runtime = manager.beginRuntime({ key: "client::thread", clientId: "client", threadId: "thread", cwd: temp, profile: "测试 Profile" });
  const fakeSession = { sessionId: "session-test", model: { provider: "test-provider", id: "test-model", name: "Test Model" }, isStreaming: false, isIdle: true };
  manager.bindSession(runtime.runtimeId, { session: fakeSession, toolPolicy: { mode: "agent", tools: ["read"] } });
  const snapshot = manager.health(runtime.runtimeId, fakeSession);
  assert.equal(snapshot.runtimeId, runtime.runtimeId);
  assert.equal(snapshot.profile, "测试 Profile");
  assert.equal(snapshot.model.id, "test-model");
  assert.equal(snapshot.toolPolicy.mode, "agent");
  assert.equal(snapshot.capabilities.nativeCheckpoint.status, "unsupported");
  assert.equal(snapshot.capabilities.replay.status, "fallback");
  assert.equal(JSON.stringify(snapshot).includes("api_key"), false, "Runtime 快照不得泄漏凭据字段");
  assert.equal(manager.listSnapshots().length, 1);

  const workspaceContext = path.join(temp, ".agent-context.md");
  fs.writeFileSync(workspaceContext, `当前工作区：${temp}\n`, "utf8");
  const evaluation = await runRuntimeEvaluation({ workspace: temp, runtime: snapshot });
  assert.equal(evaluation.checks.length, 6, "阶段六应覆盖六项运行合同检查");
  assert.equal(evaluation.checks.find((item) => item.id === "runtime").status, "passed");
  assert.equal(evaluation.checks.find((item) => item.id === "memory-governance").status, "passed");
  assert.equal(evaluation.checks.find((item) => item.id === "concurrency-write").status, "passed");

  const failing = new Error("模型连接失败");
  failing.code = "TEST_RUNTIME_ERROR";
  manager.markFailure(runtime.runtimeId, failing, { recovering: true, reason: "test" });
  assert.equal(manager.listSnapshots()[0].status, "recovering");
  assert.equal(manager.listSnapshots()[0].health.status, "degraded");

  const run = beginRun({ clientId: "stage6", threadId: "checkpoint", sessionId: "session-test", cwd: temp, task: { goal: "检查点测试" }, runtimeSnapshot: snapshot });
  try {
    recordRunEvent(run.id, "tool_start", { toolCallId: "tool-1", name: "read" });
    recordRunEvent(run.id, "tool_start", { toolCallId: "tool-1", name: "read" });
    const idempotent = getRun(run.id);
    assert.equal(idempotent.steps.find((step) => step.id.endsWith("tool:tool-1"))?.attempts, 1, "重复工具开始事件不得重复增加 attempts");
    const checkpoint = updateRunCheckpoint(run.id, { status: "available", cursor: "tool-1" });
    const eventCount = checkpoint.events.length;
    const repeated = updateRunCheckpoint(run.id, { status: "available", cursor: "tool-1" });
    assert.equal(repeated.events.length, eventCount, "重复检查点上报不得追加重复事件");
    assert.equal(repeated.checkpoint.type, "jsonl_reopen");
    assert.equal(repeated.checkpoint.native, false);
  } finally {
    finishRun(run.id, { status: "cancelled", sessionId: "session-test", summary: "阶段六检查点测试清理" });
  }

  console.log(JSON.stringify({ ok: true, peak, runtimeId: runtime.runtimeId, evaluation: evaluation.status, capabilities: runtimeCapabilities }, null, 2));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
