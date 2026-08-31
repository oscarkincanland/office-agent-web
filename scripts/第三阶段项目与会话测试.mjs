#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "规聚阶段三项目-"));
const firstWorkspace = path.join(root, "交通项目");
const secondWorkspace = path.join(root, "研究项目");
fs.mkdirSync(firstWorkspace, { recursive: true });
fs.mkdirSync(secondWorkspace, { recursive: true });
process.env.OAW_PROJECTS_FILE = path.join(root, "projects.json");
process.env.OAW_RUNS_DIR = path.join(root, "runs");
process.env.OAW_WRITE_LOCK_DIR = path.join(root, "write-locks");

const projectManager = await import("../server/项目管理.mjs");
const { beginRun, finishRun, listRuns } = await import("../server/runs.mjs");

try {
  const first = projectManager.createProject({
    name: "交通研究项目",
    rootPath: firstWorkspace,
    type: "交通规划",
    settings: { agentProfile: "研究", skills: ["kb-retriever", "kb-retriever"], memoryPolicy: "manual" },
  });
  assert.equal(first.ok, true);
  assert.equal(first.project.settings.agentProfile, "研究");
  assert.deepEqual(first.project.settings.skills, ["kb-retriever"]);
  assert.equal(first.project.settings.memoryPolicy, "manual");

  const updated = projectManager.updateProjectSettings(first.project.id, {
    defaultModel: "deepseek/deepseek-chat",
    artifactPolicy: "manual",
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.settings.defaultModel, "deepseek/deepseek-chat");
  assert.equal(updated.settings.artifactPolicy, "manual");

  const second = projectManager.createProject({ name: "调研资料项目", rootPath: secondWorkspace, type: "调研报告" });
  assert.equal(second.ok, true);
  assert.equal(projectManager.listProjects({ type: "交通规划" }).some((item) => item.id === first.project.id), true);
  assert.equal(projectManager.listProjects({ status: "已归档" }).length, 0);

  const archived = projectManager.archiveProject(second.project.id, true);
  assert.equal(archived.project.status, "已归档");
  assert.equal(projectManager.listProjects({ status: "已归档" }).some((item) => item.id === second.project.id), true);
  const restored = projectManager.archiveProject(second.project.id, false);
  assert.equal(restored.project.status, "进行中");

  const run = beginRun({
    clientId: "stage3-client",
    threadId: "stage3-thread",
    cwd: firstWorkspace,
    projectId: first.project.id,
    task: { goal: "阶段三任务筛选", mode: "agent" },
  });
  const finished = finishRun(run.id, { status: "failed", error: "阶段三测试故意失败" });
  assert.equal(finished.status, "failed");
  assert.equal(listRuns({ projectId: first.project.id, status: "failed", mode: "agent" }).some((item) => item.id === run.id), true);
  assert.equal(listRuns({ projectId: first.project.id, query: "故意失败" }).some((item) => item.id === run.id), true);
  assert.equal(listRuns({ projectId: first.project.id, query: "不存在的失败原因" }).some((item) => item.id === run.id), false);
  assert.equal(listRuns({ projectId: first.project.id, status: "completed" }).some((item) => item.id === run.id), false);

  console.log("phase3 project/session contracts: ok");
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
