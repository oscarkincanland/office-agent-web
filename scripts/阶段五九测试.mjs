#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseReferences } from "../server/context.mjs";
import { createTaskEnvelope } from "../server/task.mjs";
import { listWorkflows } from "../server/workflows.mjs";
import { beginRun, finishRun, getRun, rollbackRun, runsDir } from "../server/runs.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-phase5-9-"));
try {
  const refs = parseReferences("请分析 @文件[data/report.md] 和 @知识库[政策.md@本地库]");
  assert.equal(refs.length, 2);
  assert.equal(refs.some((r) => r.kind === "file"), true);
  const cellRef = parseReferences("请看 @文件[data.xlsx#Sheet1!A1:B2]").find((r) => r.kind === "file");
  assert.equal(cellRef.target, "data.xlsx");
  assert.equal(cellRef.range.cell, "A1:B2");

  const task = createTaskEnvelope({ goal: "整理报告", mode: "agent", threadId: "thread-test", references: refs });
  assert.equal(task.version, 1);
  assert.equal(task.references.length, 2);

  const workflows = listWorkflows([{ name: "od-workflow" }]);
  assert.equal(workflows.length, 4);
  assert.equal(workflows.find((w) => w.id === "wf-od-analysis").valid, false);

  fs.writeFileSync(path.join(temp, "before.txt"), "before\n", "utf8");
  const run = beginRun({ clientId: "client-test", threadId: "thread-test", cwd: temp, task, references: refs });
  fs.writeFileSync(path.join(temp, "before.txt"), "after\n", "utf8");
  fs.writeFileSync(path.join(temp, "added.txt"), "added\n", "utf8");
  const done = finishRun(run.id, { summary: "smoke" });
  assert.equal(done.status, "completed");
  assert.equal(done.artifacts.length, 2);
  assert.equal(getRun(run.id).id, run.id);
  const rollback = rollbackRun(run.id, ["before.txt", "added.txt"]);
  assert.equal(rollback.ok, true);
  assert.equal(fs.readFileSync(path.join(temp, "before.txt"), "utf8"), "before\n");
  assert.equal(fs.existsSync(path.join(temp, "added.txt")), false);
  fs.rmSync(path.join(runsDir(), run.id), { recursive: true, force: true });
  fs.rmSync(path.join(runsDir(), `${run.id}.json`), { force: true });
  console.log("phase5-9 smoke: ok");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
