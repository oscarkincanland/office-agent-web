#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, readJsonFile } from "../server/持久化工具.mjs";
import { beginRun, finishRun, getRun, recoverActiveRuns } from "../server/runs.mjs";
import { listEvents } from "../server/事件存储.mjs";
import { validateArtifactFile } from "../server/产物验证.mjs";
import {
  acquireWriteLock,
  discardStagedRun,
  ensureRunStaging,
  holdWorkspaceWriteLock,
  listStagedFilesForValidation,
  publishStagedRun,
  releaseRunLocks,
  resolveReadablePath,
  stageWrite,
} from "../server/写入协调.mjs";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "规聚阶段一-"));
const events = [];
const emit = (type, data) => events.push({ type, data });
const runId = "run_phase1_test";
const otherRunId = "run_phase1_other";
const createdRunIds = new Set([runId, otherRunId, "run_phase1_root", "run_phase1_child", "run_phase1_discard"]);

try {
  const existingFile = path.join(workspace, "报告.md");
  fs.writeFileSync(existingFile, "旧内容\n", "utf8");
  ensureRunStaging(runId, workspace);

  stageWrite({
    runId,
    workspace,
    targetPath: existingFile,
    content: "新内容\n",
    threadId: "thread_phase1",
    kind: "write",
    onEvent: emit,
  });
  assert.equal(fs.readFileSync(existingFile, "utf8"), "旧内容\n", "写入 staging 不能提前修改正式文件");
  const stagedPath = resolveReadablePath({ runId, workspace, targetPath: existingFile });
  assert.equal(fs.readFileSync(stagedPath, "utf8"), "新内容\n", "同一 Run 应能读到暂存内容");
  assert.ok(events.some((item) => item.type === "write_locked"));
  assert.ok(events.some((item) => item.type === "artifact_staged"));

  assert.throws(
    () => acquireWriteLock({ workspace, targetPath: existingFile, runId: otherRunId, kind: "write" }),
    (error) => error.code === "WRITE_CONFLICT" && error.details.ownerRunId === runId,
    "其他 Run 修改同一文件必须得到结构化冲突",
  );

  const materialized = [];
  const published = publishStagedRun(runId, workspace, { threadId: "thread_phase1", onEvent: (type) => materialized.push(type) });
  assert.equal(published[0].status, "published");
  assert.equal(fs.readFileSync(existingFile, "utf8"), "新内容\n", "发布后正式文件应更新");
  assert.ok(materialized.includes("artifact_materialized"), "暂存产物发布应进入写入事件流");
  releaseRunLocks(runId);

  const rootRun = "run_phase1_root";
  const childRun = "run_phase1_child";
  holdWorkspaceWriteLock({ workspace, runId: rootRun, kind: "bash" });
  assert.throws(
    () => acquireWriteLock({ workspace, targetPath: existingFile, runId: childRun, kind: "write" }),
    (error) => error.code === "WRITE_CONFLICT" && error.details.ownerRunId === rootRun,
    "工作区锁必须覆盖其下的文件锁",
  );
  releaseRunLocks(rootRun);

  const discardedRun = "run_phase1_discard";
  const newFile = path.join(workspace, "临时", "未完成.md");
  stageWrite({ runId: discardedRun, workspace, targetPath: newFile, content: "不应发布", onEvent: emit });
  discardStagedRun(discardedRun, { reason: "cancelled", onEvent: emit });
  assert.equal(fs.existsSync(newFile), false, "取消 Run 不应把暂存文件发布到工作区");
  releaseRunLocks(discardedRun);

  const stateFile = path.join(workspace, "状态.json");
  atomicWriteJson(stateFile, { version: 1, status: "ok" });
  assert.deepEqual(readJsonFile(stateFile, null), { version: 1, status: "ok" }, "JSON 原子写入应可读取");

  const cancelledRun = beginRun({ clientId: "client_phase1", threadId: "thread_phase1", cwd: workspace, task: { goal: "取消清理测试" } });
  createdRunIds.add(cancelledRun.id);
  const cancelledFile = path.join(workspace, "取消后不应出现.md");
  stageWrite({ runId: cancelledRun.id, workspace, targetPath: cancelledFile, content: "未完成", onEvent: emit });
  const cancelled = finishRun(cancelledRun.id, { status: "cancelled", error: "test_cancelled" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(fs.existsSync(cancelledFile), false, "取消 Run 必须清理未发布的暂存产物");
  assert.equal(cancelled.staging.status, "discarded");
  assert.ok(listEvents({ runId: cancelledRun.id }).events.some((item) => item.type === "write_cleaned"), "取消清理应进入持久化事件流");

  const invalidRun = beginRun({ clientId: "client_phase1", threadId: "thread_phase1", cwd: workspace, task: { goal: "校验闸门测试" } });
  createdRunIds.add(invalidRun.id);
  const invalidFile = path.join(workspace, "无效产物.json");
  stageWrite({ runId: invalidRun.id, workspace, targetPath: invalidFile, content: "{bad-json" });
  const invalidStaged = listStagedFilesForValidation(invalidRun.id).map((item) => validateArtifactFile(item.file, item.root, item.path));
  const rejected = finishRun(invalidRun.id, { status: "completed", validations: invalidStaged });
  assert.equal(rejected.status, "failed", "产物校验失败时 Run 不能标记为完成");
  assert.equal(fs.existsSync(invalidFile), false, "产物校验失败时暂存文件不能发布");

  const recoverableRun = beginRun({ clientId: "client_phase1", threadId: "thread_phase1", cwd: workspace, task: { goal: "重启恢复测试" } });
  createdRunIds.add(recoverableRun.id);
  const recoveredIds = recoverActiveRuns({ onlyIds: [recoverableRun.id] });
  assert.ok(recoveredIds.includes(recoverableRun.id), "服务重启后活动 Run 应进入恢复态");
  assert.equal(getRun(recoverableRun.id).status, "recovering");

  console.log("phase1 stability: ok");
} finally {
  releaseRunLocks(runId);
  releaseRunLocks(otherRunId);
  releaseRunLocks("run_phase1_root");
  releaseRunLocks("run_phase1_child");
  releaseRunLocks("run_phase1_discard");
  const runStore = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".oaw", "runs");
  for (const id of createdRunIds) {
    try { fs.rmSync(path.join(runStore, id), { recursive: true, force: true }); } catch {}
    try { fs.rmSync(path.join(runStore, `${id}.json`), { force: true }); } catch {}
  }
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
}
