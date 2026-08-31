#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import XLSX from "xlsx";
import { parseReferences } from "../server/context.mjs";
import { createTaskEnvelope } from "../server/task.mjs";
import { listWorkflows } from "../server/workflows.mjs";
import { beginRun, finishRun, getRun, rollbackRun, runsDir } from "../server/runs.mjs";
import { evaluateArtifactFile } from "../server/成果验收.mjs";
import { checkOfficecli } from "../server/office.mjs";
import { confirmArtifactAcceptance, inspectRunAcceptance } from "../server/成果管理.mjs";

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

  // 用真实 XLSX 文件验证结构、内容、视觉三层结果；Office CLI 不可用时必须明确为人工确认。
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["项目", "状态"], ["规聚", "通过"]]), "成果清单");
  const officeFixture = path.join(temp, "真实表格样本.xlsx");
  XLSX.writeFile(workbook, officeFixture);
  const acceptance = await evaluateArtifactFile(officeFixture, { root: temp, relativePath: "真实表格样本.xlsx", rules: { requiredSheets: ["成果清单"], requiredText: ["规聚"] } });
  const officecli = await checkOfficecli();
  assert.equal(acceptance.checks.structure.status, officecli.available ? "passed" : "manual_review");
  assert.equal(acceptance.checks.content.status, officecli.available ? "passed" : "manual_review");
  assert.equal(acceptance.checks.visual.status, officecli.available ? "passed" : "manual_review");
  assert.equal(acceptance.readyToPublish, officecli.available);
  const missingPublish = await (await import("../server/成果管理.mjs")).publishArtifact("run-not-found", "artifact-no");
  assert.equal(missingPublish.ok, false);

  // PDF 没有自动视觉渲染时先进入人工确认；确认后重新验收不能丢失确认状态。
  const pdfRun = beginRun({ clientId: "client-test", threadId: "thread-pdf", cwd: temp, task: createTaskEnvelope({ goal: "验收 PDF", mode: "agent" }) });
  const pdfPath = path.join(temp, "人工确认样本.pdf");
  fs.writeFileSync(pdfPath, "%PDF-1.4\n1 0 obj<</Type /Page>>endobj\n%%EOF", "latin1");
  const pdfDone = finishRun(pdfRun.id, { summary: "pdf smoke" });
  const pdfInitial = await inspectRunAcceptance(pdfDone.id);
  assert.equal(pdfInitial.acceptance.artifacts[0].status, "manual_review");
  const pdfArtifact = pdfDone.artifacts.find((item) => item.path === "人工确认样本.pdf");
  const pdfConfirmed = await confirmArtifactAcceptance(pdfDone.id, pdfArtifact.artifactId, { note: "已人工检查 PDF" });
  assert.equal(pdfConfirmed.acceptance.artifacts[0].readyToPublish, true);
  const pdfRechecked = await inspectRunAcceptance(pdfDone.id);
  assert.equal(pdfRechecked.acceptance.artifacts[0].readyToPublish, true);
  fs.rmSync(path.join(runsDir(), pdfRun.id), { recursive: true, force: true });
  fs.rmSync(path.join(runsDir(), `${pdfRun.id}.json`), { force: true });
  fs.rmSync(path.join(runsDir(), run.id), { recursive: true, force: true });
  fs.rmSync(path.join(runsDir(), `${run.id}.json`), { force: true });
  console.log("phase5-9 smoke: ok");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
