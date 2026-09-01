#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import XLSX from "xlsx";

const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-phase7-"));
const workspace = path.join(temp, "工作区");
const runStore = path.join(temp, "运行记录");
const lockStore = path.join(temp, "写入锁");
const eventStore = path.join(temp, "事件流");
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(runStore, { recursive: true });
fs.mkdirSync(lockStore, { recursive: true });

// 让本次回归完全使用临时运行记录，避免污染开发工作区。
process.env.OAW_RUNS_DIR = runStore;
process.env.OAW_WRITE_LOCK_DIR = lockStore;
process.env.OAW_EVENT_DIR = eventStore;

const [{ Document, Packer, Paragraph, TextRun }, { default: JSZip }, agent, runs, writes, office, acceptance] = await Promise.all([
  import("docx"),
  import("jszip"),
  import("../server/agent.mjs"),
  import("../server/runs.mjs"),
  import("../server/写入协调.mjs"),
  import("../server/office.mjs"),
  import("../server/成果验收.mjs"),
]);
const { classifyAgentError } = agent;
const { beginRun, finishRun, getRun } = runs;
const { stageWrite } = writes;
const { checkOfficecli, runOfficecli } = office;
const { evaluateArtifactFile } = acceptance;

function task(goal, mode = "agent") {
  return { version: 1, goal, mode, workspace, references: [] };
}

function removeRun(id) {
  fs.rmSync(path.join(runStore, id), { recursive: true, force: true });
  fs.rmSync(path.join(runStore, `${id}.json`), { force: true });
}

function persistedEventsFor(runId) {
  try {
    return fs.readFileSync(path.join(eventStore, "事件流.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((event) => event?.runId === runId);
  } catch { return []; }
}

async function waitFor(check, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待条件超时");
}

function addPptxFiles(zip) {
  const xml = (value) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${value}`;
  zip.file("[Content_Types].xml", xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`));
  zip.file("_rels/.rels", xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`));
  zip.file("ppt/presentation.xml", xml(`<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`));
  zip.file("ppt/_rels/presentation.xml.rels", xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`));
  zip.file("ppt/slides/slide1.xml", xml(`<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="标题"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN"/><a:t>规聚真实 PPTX 样本</a:t></a:r><a:endParaRPr lang="zh-CN"/></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`));
  zip.file("ppt/slides/_rels/slide1.xml.rels", xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`));
  zip.file("ppt/slideLayouts/slideLayout1.xml", xml(`<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="空白"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`));
  zip.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels", xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`));
  zip.file("ppt/slideMasters/slideMaster1.xml", xml(`<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="母版"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst><p:clrMap accent1="accent1" accent2="accent2" bg1="lt1" bg2="lt2" tx1="dk1" tx2="dk2" hlink="hlink" folHlink="folHlink"/></p:sldMaster>`));
  zip.file("ppt/slideMasters/_rels/slideMaster1.xml.rels", xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`));
  zip.file("ppt/theme/theme1.xml", xml(`<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="规聚主题"><a:themeElements><a:clrScheme name="默认"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F1F1F"/></a:dk2><a:lt2><a:srgbClr val="F7F7F7"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="默认"><a:majorFont><a:latin typeface="Aptos"/><a:ea typeface="等线"/><a:cs typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface="等线"/><a:cs typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="默认"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>`));
}

async function createFixtures() {
  const docx = path.join(workspace, "真实文档样本.docx");
  const xlsx = path.join(workspace, "真实表格样本.xlsx");
  const pptx = path.join(workspace, "真实演示样本.pptx");
  const pdf = path.join(workspace, "真实PDF样本.pdf");
  const document = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun("规聚真实 DOCX 样本")] }), new Paragraph("用于第七阶段成果验收回归。规聚") ] }] });
  fs.writeFileSync(docx, await Packer.toBuffer(document));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["项目", "状态"], ["规聚", "通过"]]), "成果清单");
  XLSX.writeFile(workbook, xlsx);
  const zip = new JSZip();
  addPptxFiles(zip);
  fs.writeFileSync(pptx, await zip.generateAsync({ type: "nodebuffer" }));
  fs.writeFileSync(pdf, [
    "%PDF-1.4",
    "1 0 obj<</Type /Catalog /Pages 2 0 R>>endobj",
    "2 0 obj<</Type /Pages /Kids [3 0 R] /Count 1>>endobj",
    "3 0 obj<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R>>endobj",
    "4 0 obj<</Length 0>>stream",
    "endstream endobj",
    "trailer<</Root 1 0 R>>",
    "%%EOF",
  ].join("\n"), "latin1");
  return { docx, xlsx, pptx, pdf };
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2500);
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

const summary = { errors: {}, files: {}, serviceRestart: {}, officeCli: null };
try {
  const fixtures = await createFixtures();
  const officeCli = await checkOfficecli();
  summary.officeCli = { available: officeCli.available, path: officeCli.path, message: officeCli.message };

  // 模型超时、限流和鉴权失败必须归一化，且鉴权错误不能被误标记为可重试。
  const errorCases = [
    ["timeout", { status: 504, message: "upstream timeout" }, true],
    ["rateLimit", { status: 429, message: "rate limit" }, true],
    ["auth", { status: 401, message: "invalid api key" }, false],
    ["forbidden", { status: 403, message: "permission denied" }, false],
  ];
  for (const [name, input, retryable] of errorCases) {
    const result = classifyAgentError(input);
    assert.equal(result.retryable, retryable, `${name} 重试判断不正确`);
    assert.equal(result.status, input.status);
    summary.errors[name] = result;
  }

  // 同一文件由两个 Run 并发写入时，第二个 Run 必须收到结构化冲突错误。
  const first = beginRun({ clientId: "phase7", threadId: "concurrent-a", cwd: workspace, task: task("并发写入 A") });
  const second = beginRun({ clientId: "phase7", threadId: "concurrent-b", cwd: workspace, task: task("并发写入 B") });
  const target = path.join(workspace, "并发目标.txt");
  stageWrite({ runId: first.id, workspace, targetPath: target, content: "A", threadId: first.threadId });
  assert.throws(() => stageWrite({ runId: second.id, workspace, targetPath: target, content: "B", threadId: second.threadId }), (error) => error.code === "WRITE_CONFLICT");
  finishRun(first.id, { status: "cancelled", error: "并发回归清理" });
  finishRun(second.id, { status: "cancelled", error: "并发回归清理" });
  summary.concurrentWrite = "WRITE_CONFLICT";

  // 取消必须丢弃暂存文件并释放锁，不能留下半成品。
  const cancel = beginRun({ clientId: "phase7", threadId: "cancel", cwd: workspace, task: task("取消清理") });
  stageWrite({ runId: cancel.id, workspace, targetPath: path.join(workspace, "取消后不应发布.txt"), content: "半成品", threadId: cancel.threadId });
  const cancelled = finishRun(cancel.id, { status: "cancelled", error: "用户取消" });
  assert.equal(cancelled.staging.status, "discarded");
  assert.equal(fs.existsSync(path.join(workspace, "取消后不应发布.txt")), false);
  assert.equal(fs.readdirSync(lockStore).filter((name) => name.endsWith(".lock")).length, 0);
  summary.cancellation = { status: cancelled.status, staging: cancelled.staging.status, locks: 0 };

  // 模拟服务重启：活动 Run 先落盘，子服务启动时必须标记为 recovering。
  const restartRun = beginRun({ clientId: "phase7", threadId: "restart", cwd: workspace, task: task("重启恢复") });
  let serviceError = "";
  let serviceOutput = "";
  const port = 32000 + (process.pid % 700);
  const service = spawn(process.execPath, ["server/index.mjs"], {
    cwd: repo,
    env: { ...process.env, PORT: String(port), OAW_RUNS_DIR: runStore, OAW_WRITE_LOCK_DIR: lockStore },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  service.stdout.on("data", (data) => { serviceOutput += String(data); });
  service.stderr.on("data", (data) => { serviceError += String(data); });
  try {
    await waitFor(async () => {
      if (service.exitCode !== null) throw new Error(`服务启动失败：${serviceError || serviceOutput}`);
      try { return (await fetch(`http://127.0.0.1:${port}/api/status`)).ok; } catch { return false; }
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/runs/${encodeURIComponent(restartRun.id)}`);
    assert.equal(response.ok, true);
    const data = await response.json();
    assert.equal(data.run.status, "recovering");
    assert.equal(data.run.recovery.required, true);
    assert.equal(data.run.events.some((event) => event.type === "run_recovered"), true);
    summary.serviceRestart = { status: data.run.status, recoveryRequired: data.run.recovery.required, event: "run_recovered" };
    const diagnosticsResponse = await fetch(`http://127.0.0.1:${port}/api/agent/diagnostics?client=phase7&thread=restart&limit=1`);
    assert.equal(diagnosticsResponse.ok, true);
    const diagnostics = await diagnosticsResponse.json();
    assert.equal(diagnostics.ok, true);
    assert.equal(typeof diagnostics.service.version, "string");
    assert.equal(typeof diagnostics.model.authConfigured, "boolean");
    summary.serviceRestart.diagnostics = { version: diagnostics.service.version, authConfigured: diagnostics.model.authConfigured, recentFailures: diagnostics.recentFailures.length };
  } finally {
    await stopProcess(service);
  }
  finishRun(restartRun.id, { status: "cancelled", error: "重启回归清理" });
  const restartEvents = persistedEventsFor(restartRun.id);
  const restartSeqs = restartEvents.map((event) => event.seq);
  assert.equal(new Set(restartSeqs).size, restartSeqs.length, "重启前后事件全局序号重复");
  summary.serviceRestart.eventSequence = restartSeqs;

  // Runtime 错误要进入事件和恢复边界，而不是只在日志中丢失。
  const runtimeRun = beginRun({ clientId: "phase7", threadId: "runtime-error", cwd: workspace, task: task("运行时错误") });
  const runtimeErrorRun = runs.recordRunEvent(runtimeRun.id, "runtime_error", { code: "PI_TIMEOUT", message: "Pi Runtime timeout", retryable: true, runtime: { status: "failed" } });
  assert.equal(runtimeErrorRun.recovery.required, true);
  assert.equal(runtimeErrorRun.events.at(-1).type, "runtime_error");
  finishRun(runtimeRun.id, { status: "cancelled", error: "运行时错误回归清理" });

  // Office CLI 不可用必须可注入、可观察，不能依赖本机是否恰好安装了 CLI。
  const missingOffice = path.join(temp, "不存在的OfficeCLI", "officecli");
  const unavailable = await checkOfficecli(500, missingOffice);
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.path, missingOffice);
  await assert.rejects(() => runOfficecli(["--help"], { cwd: workspace, timeoutMs: 500, executable: missingOffice }), /officecli not found/i);

  // 生成并验收真实 DOCX/XLSX/PPTX/PDF；PDF 的视觉层按产品边界保留人工确认。
  const rules = {
    "真实文档样本.docx": { requiredText: ["规聚"] },
    "真实表格样本.xlsx": { requiredSheets: ["成果清单"], requiredText: ["规聚"] },
    "真实演示样本.pptx": { requiredText: ["规聚"] },
  };
  for (const [name, file] of Object.entries(fixtures)) {
    const relativePath = path.basename(file);
    const result = await evaluateArtifactFile(file, { root: workspace, relativePath, rules: rules[relativePath] || {}, officecli: officeCli });
    assert.equal(result.checks.structure.checks.some((item) => item.status === "passed"), true, `${relativePath} 结构验收未通过`);
    assert.notEqual(result.status, "failed", `${relativePath} 真实验收失败`);
    summary.files[relativePath] = {
      format: result.format,
      status: result.status,
      readyToPublish: result.readyToPublish,
      structure: result.checks.structure.status,
      content: result.checks.content.status,
      visual: result.checks.visual.status,
    };
  }
  assert.equal(summary.files["真实PDF样本.pdf"].status, "manual_review");
  assert.equal(summary.files["真实PDF样本.pdf"].content, "passed");

  [first.id, second.id, cancel.id, restartRun.id, runtimeRun.id].forEach(removeRun);
  console.log(`phase7 regression: ok\n${JSON.stringify(summary, null, 2)}`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
