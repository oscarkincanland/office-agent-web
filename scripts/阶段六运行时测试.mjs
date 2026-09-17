import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncLimiter, PiRuntimeManager, runtimeCapabilities } from "../server/Pi运行时管理.mjs";
import { evaluateWorkspaceWrite, runRuntimeEvaluation } from "../server/运行评测.mjs";
import { acquireWriteLock, releaseWriteLock, writeWorkspaceFile } from "../server/写入协调.mjs";
import { normalizeOfficeFailure, normalizeWorkspaceWriteError, workspaceWriteHttpStatus } from "../server/文件权限错误.mjs";
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
  const target = path.join(temp, "写入回归测试.md");
  const created = writeWorkspaceFile({ workspace: temp, targetPath: target, content: "初稿", kind: "test" });
  assert.equal(created.status, "added", "工作区写入应报告新建状态");
  assert.equal(fs.readFileSync(target, "utf8"), "初稿", "工作区新建内容应可回读");
  const modified = writeWorkspaceFile({ workspace: temp, targetPath: target, content: "修订稿", kind: "test" });
  assert.equal(modified.status, "modified", "工作区写入应报告覆盖状态");
  assert.equal(fs.readFileSync(target, "utf8"), "修订稿", "工作区修改内容应完整回读");
  assert.throws(() => writeWorkspaceFile({ workspace: temp, targetPath: path.join(temp, "..", "越界.md"), content: "越界" }), (error) => error.code === "WRITE_SCOPE_ERROR");
  assert.throws(() => writeWorkspaceFile({ workspace: temp, targetPath: path.join(temp, "memory", "MEMORY.md"), content: "越权" }), (error) => error.code === "MEMORY_WRITE_REQUIRES_PROPOSAL");
  const lock = acquireWriteLock({ workspace: temp, targetPath: target, runId: "phase6_lock_owner", kind: "test" });
  try {
    assert.throws(() => writeWorkspaceFile({ workspace: temp, targetPath: target, content: "冲突" }), (error) => error.code === "WRITE_CONFLICT");
  } finally {
    releaseWriteLock(lock);
  }
  const writeProbe = evaluateWorkspaceWrite(temp);
  assert.equal(writeProbe.status, "passed", "实际写入探针应经过原子写入和写锁链路");
  assert.deepEqual(writeProbe.details.operations, ["create", "modify", "readback", "delete"]);
  assert.equal(fs.readdirSync(temp).some((name) => name.startsWith(".规聚写入探针-")), false, "成功的能力探针必须清理临时文件");
  const permission = normalizeWorkspaceWriteError(Object.assign(new Error("operation not permitted"), { code: "EPERM" }));
  assert.equal(permission.code, "WORKSPACE_PERMISSION_DENIED");
  assert.equal(normalizeWorkspaceWriteError(Object.assign(new Error("busy"), { code: "EBUSY" })).code, "OFFICE_DOCUMENT_LOCKED");
  assert.equal(normalizeOfficeFailure(new Error("Office CLI failed")).code, "OFFICECLI_FAILED");
  assert.equal(normalizeOfficeFailure(null, [], { stderr: "access denied" }).code, "WORKSPACE_PERMISSION_DENIED");
  const nestedPermission = normalizeOfficeFailure(new Error("Office CLI execution failed"), ["set", "报告.docx"], {
    json: { data: { results: [{ error: { code: "io_error", message: "Access to the path 'E:\\项目\\报告.docx' is denied." } }] } },
  });
  assert.equal(nestedPermission.code, "WORKSPACE_PERMISSION_DENIED", "Office CLI 嵌套 io_error/Windows is denied 必须识别为权限拒绝");
  assert.equal(workspaceWriteHttpStatus(nestedPermission), 403, "权限拒绝必须返回 403，而不是 CLI 通用失败");
  assert.equal(workspaceWriteHttpStatus(Object.assign(new Error("工作区探针未能回读"), { code: "WORKSPACE_WRITE_UNAVAILABLE" })), 503);
  assert.equal(normalizeOfficeFailure(null, [], { stderr: "The file is being used by another process (sharing violation)" }).code, "OFFICE_DOCUMENT_LOCKED");
  const evaluation = await runRuntimeEvaluation({ workspace: temp, runtime: snapshot });
  assert.equal(evaluation.version, 2, "运行评测合同应包含真实工作区写入探针");
  assert.equal(evaluation.checks.length, 7, "阶段六应覆盖七项运行合同检查");
  assert.equal(evaluation.checks.find((item) => item.id === "workspace-write").status, "passed");
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
