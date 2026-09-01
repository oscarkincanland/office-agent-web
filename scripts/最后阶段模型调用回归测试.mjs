#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-final-model-"));
process.env.OAW_RUNS_DIR = path.join(temp, "运行记录");
process.env.OAW_EVENT_DIR = path.join(temp, "事件流");
process.env.OAW_WRITE_LOCK_DIR = path.join(temp, "写入锁");
fs.mkdirSync(path.join(temp, "工作区"), { recursive: true });

try {
  const [{ classifyAgentError, createSettledAgentError, captureSettledAgentError }, runs] = await Promise.all([
    import("../server/agent.mjs"),
    import("../server/runs.mjs"),
  ]);

  const entry = { lastAgentError: "Request timed out.", lastSettledError: null };
  assert.equal(captureSettledAgentError(entry), "Request timed out.");
  assert.equal(entry.lastSettledError, "Request timed out.");

  const settled = createSettledAgentError("Request timed out.");
  assert.equal(settled.code, "PI_SETTLED_ERROR");
  assert.equal(classifyAgentError(settled).retryable, true);

  const terminal = createSettledAgentError("invalid api key");
  assert.equal(classifyAgentError(terminal).retryable, false);

  const run = runs.beginRun({
    clientId: "final-model",
    threadId: "settled-error",
    cwd: path.join(temp, "工作区"),
    task: { version: 1, goal: "模型失败状态传播", mode: "agent", workspace: path.join(temp, "工作区"), references: [] },
  });
  const failed = runs.finishRun(run.id, { status: "failed", error: settled.message, summary: "模型调用失败" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "Request timed out.");
  assert.equal(failed.events.at(-1).type, "run_finished");
  assert.equal(failed.events.at(-1).data.status, "failed");

  const agentSource = fs.readFileSync(path.join(repo, "server", "agent.mjs"), "utf8");
  assert.match(agentSource, /if \(settledError\) throw createSettledAgentError\(settledError\)/);
  const startupSource = fs.readFileSync(path.join(repo, "启动规聚服务.ps1"), "utf8");
  assert.match(startupSource, /LocalVersion/);
  assert.match(startupSource, /ExistingService\.version/);

  console.log(`final model regression: ok\n${JSON.stringify({
    settledError: settled.code,
    timeoutRetryable: true,
    authRetryable: false,
    runStatus: failed.status,
    versionGuard: true,
  }, null, 2)}`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
