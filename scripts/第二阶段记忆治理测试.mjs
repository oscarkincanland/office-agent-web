#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "规聚阶段二记忆-"));
process.env.OAW_MEMORY_PROPOSALS_FILE = path.join(workspace, "建议.json");

const memory = await import("../server/记忆管理.mjs");
const { stageWrite } = await import("../server/写入协调.mjs");

try {
  fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "memory", "MEMORY.md"), "# 记忆索引\n\n## 项目事实\n- 已有项目事实\n\n## 工作规则\n\n", "utf8");
  const threadKey = `stage2-memory-${Date.now()}`;
  const first = memory.createMemoryProposal({
    clientId: "stage2-client",
    threadId: "stage2-thread",
    threadKey,
    workspace,
    projectId: "project_stage2",
    runId: "run_stage2_memory",
    category: "项目事实",
    content: "项目使用 Web 工作台",
    source: { type: "agent", label: "阶段二测试" },
  });
  assert.equal(first.category, "project_fact");
  assert.equal(first.projectId, "project_stage2");
  assert.equal(first.runId, "run_stage2_memory");
  assert.equal(first.status, "pending");

  const edited = memory.editMemoryProposal(first.id, { content: "项目使用 Web 工作台并按项目归档" });
  assert.equal(edited.ok, true);
  assert.equal(edited.proposal.version, 2);

  const second = memory.createMemoryProposal({ workspace, threadKey, category: "项目事实", content: "项目产物需要经过验证" });
  const merged = memory.mergeMemoryProposals(first.id, [second.id]);
  assert.equal(merged.ok, true);
  assert.equal(memory.listMemoryProposals({ workspace, status: "merged" })[0].id, second.id);
  assert.match(merged.proposal.content, /经过验证/);

  const approved = memory.approveMemoryProposal(first.id, { reviewer: "stage2-test" });
  assert.equal(approved.ok, true);
  assert.equal(approved.proposal.status, "approved");
  const memoryText = fs.readFileSync(path.join(workspace, "memory", "MEMORY.md"), "utf8");
  assert.match(memoryText, /已有项目事实/);
  assert.match(memoryText, /项目使用 Web 工作台并按项目归档/);
  assert.match(memoryText, /项目产物需要经过验证/);

  const rejected = memory.createMemoryProposal({ workspace, threadKey, category: "用户偏好", content: "临时测试偏好" });
  const rejectedResult = memory.rejectMemoryProposal(rejected.id, "阶段二测试拒绝");
  assert.equal(rejectedResult.proposal.status, "rejected");
  assert.equal(memory.getMemoryProposalHistory(first.id).history.some((item) => item.action === "approved"), true);
  assert.equal(memory.getMemoryProposalHistory(rejected.id).history.some((item) => item.action === "rejected"), true);

  assert.throws(
    () => stageWrite({ runId: "run_stage2_guard", workspace, targetPath: path.join(workspace, "memory", "MEMORY.md"), content: "禁止直接写入", kind: "write" }),
    (error) => error.code === "MEMORY_WRITE_REQUIRES_PROPOSAL",
    "普通 Agent 文件工具不能直接写长期记忆",
  );

  console.log("phase2 memory governance: ok");
} finally {
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
}
