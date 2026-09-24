#!/usr/bin/env node
/**
 * P4 · 五条跨层回归（API/SSE 层 → React 状态层 → 文案层 → 动画层）
 *
 * 对应《规聚启动交互与动效完整修改计划》P4 第 2 条：
 *   1. 首次启动部分失败：单分区失败不得伪装空结果，其他分区照常可用；
 *   2. 会话恢复失败：历史只读 + 可重试，不得假装能继续对话；
 *   3. 并行任务等待审批：任务中心与会话指向同一个待办锚点；
 *   4. 工具部分失败仍结束：结果不得宣称全部成功，必须能查失败步骤与未验证项；
 *   5. 成果不可回滚：首个版本没有历史版本时，文案不得宣称可回滚。
 *
 * 每条都同时核对：真实服务接口、客户端状态与文案、样式动画闸门。
 * 退出码 0 = 通过。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  completionLabel,
  reduceRunTrace,
  runTraceSummaryText,
  summarizeRunTrace,
  verificationLabel,
} from "../client/src/运行轨迹.js";
import { inferCompletion } from "../server/运行轨迹.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(projectRoot, rel), "utf8");

const 源码 = {
  App: read("client/src/App.jsx"),
  ChatPanel: read("client/src/components/ChatPanel.jsx"),
  工作产物面板: read("client/src/components/工作产物面板.jsx"),
  样式: read("client/src/styles.css"),
  审批策略: read("server/审批策略.mjs"),
  服务端: read("server/index.mjs"),
};

let failed = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { console.error(`  ✗ ${msg}`); failed = 1; };
/** 跑一个纯逻辑场景，失败只记录不中断。 */
function 场景(name, fn) {
  console.log(`\n▶ ${name}`);
  try {
    fn();
    ok(name);
  } catch (e) {
    bad(`${name}: ${e.message}`);
  }
}
/** 跑一个需要真实服务的场景。 */
async function 接口场景(name, fn) {
  console.log(`\n▶ ${name}`);
  try {
    await fn();
    ok(name);
  } catch (e) {
    bad(`${name}: ${e.message}`);
  }
}

/** 把样式表拆成「选择器 → 规则体」，用于核对动画闸门。 */
function 样式规则(样式) {
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(样式))) {
    blocks.push({ 选择器: m[1].trim().replace(/\s+/g, " "), 规则: m[2] });
  }
  return blocks;
}
const 规则 = 样式规则(源码.样式);
/** 失败/错误/恢复这类状态永远不该持续闪动：状态先于动效。 */
const 错误态关键词 = /error|fail|recovery|blocked|warning|离线|失败|错误|异常/i;
/** 选择器带这些词的地方挂无限动画，说明把「等待」错当成「进度」在演。 */
function 查询无限动画(匹配) {
  return 规则
    .filter((r) => 匹配.test(r.选择器) && /animation\s*:[^;]*infinite/.test(r.规则))
    .map((r) => r.选择器);
}

// ============================================================
// 1. 首次启动部分失败（静态层）
// ============================================================
场景("1. 首次启动部分失败：逐分区降级（静态层）", () => {
  assert.match(源码.App, /setScopeStatus\("files", "error"\)/);
  assert.match(源码.App, /setScopeStatus\("sessions", "error"\)/);
  assert.match(源码.App, /setScopeStatus\("projects", "error"\)/);
  assert.match(源码.App, /setScopeStatus\("workspaces", "error"\)/);
  assert.doesNotMatch(源码.App, /catch\(\(\) => \[\]\)/, "启动加载失败不得伪装成空列表");
  assert.match(源码.App, /已保留上一次可用数据/, "失败时应保留上次可用数据");
  assert.match(源码.App, /const retryStartupLoads = useCallback/, "应提供统一重试");
  assert.match(源码.App, /className="load-recovery"/, "应展示可解释的失败提示");

  const 失败态动画 = 查询无限动画(错误态关键词);
  assert.equal(失败态动画.length, 0, `失败/错误态不得挂无限动画：${失败态动画.join(" | ")}`);
  assert.match(源码.样式, /\.load-recovery\s*\{/, "失败提示应有独立样式");
});

// ============================================================
// 2. 会话恢复失败（静态层）
// ============================================================
场景("2. 会话恢复失败：只读 + 可重试（静态层）", () => {
  assert.match(源码.App, /resumeResult\?\.ok \? null : \{ sessionId: session\.id/, "恢复失败必须落为只读状态");
  assert.match(源码.App, /const retrySessionResume = useCallback/, "应提供恢复重试");
  assert.match(源码.App, /历史已加载为只读/, "应明确说明历史只读");
  assert.match(源码.App, /session-resume-warning/, "只读提示应有专属标记");
  assert.match(源码.样式, /\.session-resume-warning\s*\{/);

  const 告警动画 = 查询无限动画(/session-resume-warning/);
  assert.equal(告警动画.length, 0, "只读告警不得持续闪动");
});

// ============================================================
// 3. 并行任务等待审批（静态层）
// ============================================================
场景("3. 并行任务等待审批：同一次审批只有一个锚点", () => {
  assert.match(源码.审批策略, /pendingApprovals\.set\(approvalId,/, "待审批记录以 approvalId 入表");
  assert.match(源码.审批策略, /export function listPendingApprovals/, "应能列出待审批记录");
  assert.match(源码.ChatPanel, /data-approval-id=\{block\.id \|\| ""\}/, "审批卡应带稳定锚点 id");
  assert.match(源码.ChatPanel, /querySelector\("\.approval-block:not\(\.resolved\)"\)/, "定位只找未决审批");
  assert.match(源码.ChatPanel, /onLocateApproval=\{locateApproval\}/, "状态条应能定位到同一条审批");
  assert.match(源码.ChatPanel, /className="efs-approval"/, "执行流应展示审批等待态");

  const 审批动画 = 查询无限动画(/approval-block|efs-approval/);
  assert.equal(审批动画.length, 0, "审批等待不得靠循环闪动表达");
});

// ============================================================
// 4. 工具部分失败仍结束（事件 → 归约 → 文案 → 动画）
// ============================================================
场景("4. 工具部分失败仍结束", () => {
  const at = (n) => new Date(Date.UTC(2026, 8, 23, 10, 0, n)).toISOString();
  const events = [
    { type: "run_admitted", at: at(0), data: { runId: "run_x" } },
    { type: "tool_start", at: at(1), data: { toolCallId: "t1", name: "read", input: "a.docx" } },
    { type: "tool_end", at: at(2), data: { toolCallId: "t1", name: "read" } },
    { type: "tool_start", at: at(3), data: { toolCallId: "t2", name: "write", input: "b.docx" } },
    { type: "tool_end", at: at(4), data: { toolCallId: "t2", name: "write", isError: true } },
    { type: "officecli_failed", at: at(5), data: { message: "目标文件被占用" } },
    { type: "file_changed", at: at(6), data: { files: ["a.docx"] } },
    { type: "run_finished", at: at(7), data: { status: "completed", verificationStatus: "failed" } },
  ];
  const trace = reduceRunTrace(events, "run_x");
  const stats = summarizeRunTrace(trace);
  const text = runTraceSummaryText(trace);
  assert.equal(stats.toolOk, 1, "成功工具应计入统计");
  assert.equal(stats.toolFailed, 1, "失败工具应计入统计");
  assert.equal(trace.errors.length, 1, "officecli_failed 应记入错误");
  assert.equal(trace.verification, "failed");
  assert.match(text, /1 失败/, "摘要必须暴露失败工具数");
  assert.match(text, /验收失败/, "摘要必须暴露验收失败");
  assert.doesNotMatch(text, /全部成功|全部完成|一切正常/, "有失败步骤时不得宣称全部成功");
  assert.equal(verificationLabel("failed"), "验收失败");

  // 部分完成：必须显式列出未完成项与受阻项，而不是笼统「已完成」
  const partial = reduceRunTrace([
    { type: "task_completed", at: at(0), data: { status: "partial", summary: "只完成前两步", incomplete: ["第三步：回读校验"], blockers: ["模板缺失"] } },
    { type: "run_finished", at: at(1), data: { status: "completed" } },
  ]);
  assert.equal(partial.completion.status, "partial");
  assert.equal(partial.completion.source, "explicit", "显式声明优先于 run_finished 推断");
  assert.equal(completionLabel("partial"), "部分完成");
  assert.deepEqual(partial.completion.incomplete, ["第三步：回读校验"]);
  assert.deepEqual(partial.completion.blockers, ["模板缺失"]);
  assert.match(runTraceSummaryText(partial), /部分完成/);

  // 服务端推断与客户端标签同源：校验失败不得降级为 success
  assert.equal(inferCompletion({ runStatus: "completed", validations: [{ status: "failed" }] }).status, "partial");
  assert.equal(inferCompletion({ runStatus: "failed" }).status, "failed");

  // 文案层：结果卡能查到失败细节、未完成/受阻项与验收口径
  assert.match(源码.ChatPanel, /className="run-result-note warn">未完成：/, "部分完成应列出未完成项");
  assert.match(源码.ChatPanel, /className="run-result-note warn">受阻：/, "受阻项应单独呈现");
  assert.match(源码.ChatPanel, /先处理未完成\/受阻项，再重新发起一轮。/, "失败/部分完成应给可操作下一步");
  assert.match(源码.ChatPanel, /className="run-result-tech"/, "应提供可展开的技术细节");
  assert.match(源码.ChatPanel, /verificationLabel\(trace\?\.verification \|\| "not_checked"\)/, "验收结果应独立表达");

  // 动画层：结果揭示一次性，不循环
  assert.match(源码.样式, /animation:\s*oaw-result-in\s/, "结果卡应有一次性的入场反馈");
  const 结果循环 = 查询无限动画(/run-result/);
  assert.equal(结果循环.length, 0, "结果卡不得循环跳动");
});

// ============================================================
// 5. 成果不可回滚（静态层）
// ============================================================
场景("5. 成果不可回滚：能力决定文案", () => {
  assert.match(源码.工作产物面板, /const canRollback = !rolledBack && !!item\.rollbackTarget/, "回滚能力由 rollbackTarget 决定");
  assert.match(源码.工作产物面板, /首个版本 · 无历史版本可回滚/, "首个版本必须显式说明不可回滚");
  assert.match(源码.工作产物面板, /首个版本没有历史版本，需手动恢复/, "说明文案应给出人工恢复路径");
  assert.doesNotMatch(源码.工作产物面板, /所有操作都可回滚|全部可回滚/, "不得写死「所有操作都可回滚」");
  assert.match(源码.工作产物面板, /当前没有可回滚的历史版本/, "无可回滚项时应如实说明");

  const 成果循环 = 查询无限动画(/artifact|publication/);
  assert.equal(成果循环.length, 0, "成果列表与版本行不得无限闪动");
});

// ============================================================
// 真实服务：1 / 2 / 3 / 5 的接口层
// ============================================================
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "规聚跨层回归-"));
const port = 33_500 + Math.floor(Math.random() * 4_000);
const baseUrl = `http://127.0.0.1:${port}`;
let child = null;

function environment() {
  return {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    OAW_DATA_DIR: path.join(temporaryRoot, "应用数据"),
    OAW_LOCAL_PI_AGENT_DIR: path.join(temporaryRoot, "本地Pi"),
    OAW_RUNTIME_RECORD_FILE: path.join(temporaryRoot, "运行时记录.json"),
    OAW_RUNS_DIR: path.join(temporaryRoot, "任务"),
    OAW_EVENT_DIR: path.join(temporaryRoot, "事件"),
    OAW_WRITE_LOCK_DIR: path.join(temporaryRoot, "写锁"),
    OAW_AGENTS_FILE: path.join(temporaryRoot, "智能体.json"),
    OAW_MEMORY_PROPOSALS_FILE: path.join(temporaryRoot, "记忆建议.json"),
    OAW_PROJECTS_FILE: path.join(temporaryRoot, "项目.json"),
  };
}

async function 停服务() {
  if (!child) return;
  const target = child;
  child = null;
  if (target.exitCode === null) target.kill();
  await Promise.race([
    new Promise((resolve) => target.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

async function 起服务() {
  let logs = "";
  child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: projectRoot,
    env: environment(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：\n${logs}`);
    try {
      const response = await fetch(`${baseUrl}/api/status`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`测试服务启动超时：\n${logs}`);
}

async function 请求(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, ok: response.ok, body };
}
const JSON头 = { "content-type": "application/json" };

try {
  await 起服务();

  await 接口场景("1. 首次启动部分失败：四分区互相独立（接口层）", async () => {
    const [files, sessions, projects, workspaces] = await Promise.all([
      请求("/api/files"),
      请求("/api/sessions"),
      请求("/api/projects"),
      请求("/api/workspaces"),
    ]);
    assert.equal(files.status, 200, "文件分区应可用");
    assert.ok(Array.isArray(files.body?.files), "文件分区应返回 files 数组");
    assert.equal(sessions.status, 200, "会话分区应可用");
    assert.ok(Array.isArray(sessions.body?.sessions), "会话分区应返回 sessions 数组");
    assert.equal(projects.status, 200, "项目分区应可用");
    assert.ok(Array.isArray(projects.body?.projects), "项目分区应返回 projects 数组");
    assert.equal(workspaces.status, 200, "工作区分区应可用");
    assert.ok(Array.isArray(workspaces.body?.workspaces), "工作区分区应返回 workspaces 数组");

    // 制造一个分区级失败：目录不存在。必须是结构化 4xx，且不牵连其他分区。
    const 单分区失败 = await 请求("/api/files?dir=__不存在的目录__");
    assert.equal(单分区失败.status, 404, `单分区失败应是 404，实际 ${单分区失败.status}`);
    assert.ok(单分区失败.body?.error, "单分区失败应带可解释的 error");
    const 其余 = await Promise.all([请求("/api/sessions"), 请求("/api/projects"), 请求("/api/workspaces")]);
    assert.equal(其余.every((r) => r.status === 200), true, "一个分区失败后其他分区不得级联失败");
  });

  await 接口场景("2. 会话恢复失败：结构化 4xx（接口层）", async () => {
    const 会话不存在 = await 请求("/api/agent/resume", {
      method: "POST",
      headers: JSON头,
      body: JSON.stringify({ client: "跨层回归", thread: "t1", sessionId: "不存在的会话" }),
    });
    assert.equal(会话不存在.status, 404, `恢复不存在的会话应是 404，实际 ${会话不存在.status}`);
    assert.ok(会话不存在.body?.error, "恢复失败应返回可解释的 error");

    const 缺参数 = await 请求("/api/agent/resume", {
      method: "POST",
      headers: JSON头,
      body: JSON.stringify({ client: "跨层回归" }),
    });
    assert.equal(缺参数.status, 400, "缺少 sessionId 应返回 400");

    const 任务不存在 = await 请求("/api/runs/不存在的任务/resume", { method: "POST" });
    assert.equal(任务不存在.status, 404, "恢复不存在的任务应返回 404");
    assert.equal(任务不存在.body?.error, "run not found");
  });

  await 接口场景("3. 并行任务等待审批：待办清单可枚举（接口层）", async () => {
    const approvals = await 请求("/api/agent/approvals");
    assert.equal(approvals.status, 200);
    assert.ok(Array.isArray(approvals.body?.approvals), "待审批列表应是数组");
    const pending = await 请求("/api/agent/pending?client=跨层回归&thread=t1");
    assert.equal(pending.status, 200);
    assert.ok(Array.isArray(pending.body?.questions), "待回答列表应是数组");

    const 缺id = await 请求("/api/agent/approval", { method: "POST", headers: JSON头, body: JSON.stringify({ decision: "allow" }) });
    assert.equal(缺id.status, 400, "缺少审批 id 应返回 400");
    const 非法决定 = await 请求("/api/agent/approval", { method: "POST", headers: JSON头, body: JSON.stringify({ id: "x", decision: "随便" }) });
    assert.equal(非法决定.status, 400, "非法决定值应返回 400");
    const 审批不存在 = await 请求("/api/agent/approval", { method: "POST", headers: JSON头, body: JSON.stringify({ id: "不存在的审批", decision: "allow" }) });
    assert.equal(审批不存在.status, 404, "处理不存在的审批应返回 404");
  });

  await 接口场景("5. 成果不可回滚：清单可判定（接口层）", async () => {
    const artifacts = await 请求("/api/artifacts");
    assert.equal(artifacts.status, 200);
    assert.ok(Array.isArray(artifacts.body?.artifacts), "成果清单应是数组");

    // 回滚接口必须要求 confirm=true，避免误触
    const 未确认 = await 请求("/api/artifacts/不存在/rollback", { method: "POST", headers: JSON头, body: JSON.stringify({}) });
    assert.equal(未确认.status, 400, "未确认的回滚应被拒绝");
  });
} catch (e) {
  bad(`接口层：${e.message}`);
} finally {
  await 停服务();
  try { fs.rmSync(temporaryRoot, { recursive: true, force: true }); } catch {}
}

console.log(failed ? "\n跨层回归：失败" : "\n跨层回归：通过");
process.exitCode = failed ? 1 : 0;
