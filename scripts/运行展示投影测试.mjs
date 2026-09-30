#!/usr/bin/env node
/**
 * 运行展示投影回归（W1/A01）：
 *   1. 权威优先：Run 快照的 completion/finalText/artifacts 不被空事件清除；
 *   2. 非终态不宣告完成；缺失状态显示 unknown（“状态待同步”）；
 *   3. 终态幂等：重复 assistant_final / run_finished 只有一个最终答案；
 *   4. 生命周期与目标达成严格分开；
 *   5. 等待审批/回答可从隐藏过程里找回；
 *   6. 文件分类：内部/缓存文件不得进入交付列表，事件线索只算疑似且不重复；
 *   7. 其他 Run 的迟到事件不得影响本 Run；
 *   8. 旧 RunSummary 消息可通过适配器走同一投影；
 *   9. 真实 Run 样本投影不抛错（有样本时）。
 * 用法: node scripts/运行展示投影测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  adaptLegacyRunSummary,
  isInternalChangePath,
  lifecycleLabel,
  normalizeFileChange,
  normalizeLifecycle,
  projectLegacyRunSummary,
  projectRunView,
} from "../client/src/运行展示投影.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const LIFECYCLE_LABELS_FOR_TEST = { queued: 1, running: 1, waiting_user: 1, waiting_approval: 1, finalizing: 1, completed: 1, failed: 1, cancelled: 1, unknown: 1 };

let failed = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { console.error(`  ✗ ${msg}`); failed = 1; };
function test(name, fn) {
  try { fn(); ok(name); } catch (error) { bad(`${name}: ${error.message}`); }
}

console.log("\n▶ 生命周期归一化");

test("生命周期映射覆盖排队/运行/等待/收尾/终态，缺失不默认完成", () => {
  assert.equal(normalizeLifecycle("queued"), "queued");
  assert.equal(normalizeLifecycle("running"), "running");
  assert.equal(normalizeLifecycle("recovering"), "running");
  assert.equal(normalizeLifecycle("waiting_user"), "waiting_user");
  assert.equal(normalizeLifecycle("cancel_requested"), "finalizing");
  assert.equal(normalizeLifecycle("completed"), "completed");
  assert.equal(normalizeLifecycle("failed"), "failed");
  assert.equal(normalizeLifecycle("aborted"), "cancelled");
  // 关键：缺失/未知不得当成“已完成”
  assert.equal(normalizeLifecycle(""), "unknown");
  assert.equal(normalizeLifecycle("idle"), "unknown");
  assert.equal(normalizeLifecycle("某种新状态"), "unknown");
  assert.equal(lifecycleLabel("unknown"), "状态待同步");
  assert.equal(lifecycleLabel("completed"), "运行结束");
});

console.log("\n▶ 权威数据优先 / 非终态语义");

test("空事件不清除 Run 快照的权威结论与文件", () => {
  const run = {
    id: "run_a",
    status: "completed",
    completion: { status: "success", source: "explicit", summary: "已生成报告", incomplete: [], blockers: [] },
    finalText: "这是最终回答",
    finalMessageId: "msg_final",
    finalTextVersion: 2,
    verificationStatus: "passed",
    artifacts: [{ path: "报告.docx", status: "modified", acceptanceStatus: "passed", before: { hash: "h1", size: 10, reversible: true }, after: { hash: "h2", size: 20 } }],
  };
  const view = projectRunView(run, []);
  assert.equal(view.runId, "run_a");
  assert.equal(view.lifecycle, "completed");
  assert.equal(view.outcome.status, "success");
  assert.equal(view.answer.text, "这是最终回答");
  assert.equal(view.answer.messageId, "msg_final");
  assert.equal(view.answer.version, 2);
  assert.equal(view.changes.length, 1);
  assert.equal(view.changes[0].changeType, "modified");
  assert.equal(view.verification.status, "passed");
  assert.equal(view.verification.source, "run");
});

test("运行未终态时不宣告完成，且给出可行动等待原因", () => {
  const events = [
    { type: "run_started", at: "2026-09-30T01:00:00.000Z" },
    { type: "tool_start", data: { name: "write", toolCallId: "t1" }, at: "2026-09-30T01:00:01.000Z" },
    { type: "tool_approval_request", data: { id: "ap1", tool: "officecli" }, at: "2026-09-30T01:00:02.000Z" },
  ];
  const view = projectRunView({ id: "run_b", status: "running" }, events);
  assert.equal(view.lifecycle, "waiting_approval", "有待审批时应进入等待审批");
  assert.equal(view.terminal, false);
  assert.match(String(view.progress.waitingReason), /等待你批准/);
  assert.equal(view.progress.waitingKind, "approval");
  assert.equal(view.outcome, null, "未终态且无声明时不应宣告完成");

  const resolved = projectRunView({ id: "run_b", status: "running" }, [...events, { type: "tool_approval_resolved", data: { id: "ap1" } }]);
  assert.equal(resolved.lifecycle, "running");
  assert.equal(resolved.progress.waitingReason, null);
});

test("状态缺失显示 unknown，事件推断终态但不默认完成", () => {
  const unknown = projectRunView({ id: "run_c" }, []);
  assert.equal(unknown.lifecycle, "unknown");
  assert.equal(unknown.lifecycleLabel, "状态待同步");
  assert.equal(unknown.terminal, false);

  const inferred = projectRunView({ id: "run_c" }, [
    { type: "run_started" },
    { type: "run_finished", data: { status: "completed" } },
  ]);
  assert.equal(inferred.lifecycle, "completed");
});

test("生命周期与目标达成严格分开", () => {
  const view = projectRunView({ id: "run_d", status: "completed", completion: { status: "partial", summary: "部分完成", incomplete: ["x"] } }, []);
  assert.equal(view.lifecycle, "completed");
  assert.equal(view.outcome.status, "partial");
  assert.deepEqual(view.outcome.incomplete, ["x"]);
});

console.log("\n▶ 一个终态、一个最终答案");

test("重复 assistant_final / run_finished 仍只有一个最终答案", () => {
  const events = [
    { type: "assistant_final", data: { text: "旧答案", messageId: "m1" } },
    { type: "run_finished", data: { status: "completed" } },
    { type: "assistant_final", data: { text: "新答案", messageId: "m2" } },
    { type: "run_finished", data: { status: "completed" } },
  ];
  const view = projectRunView({ id: "run_e", status: "completed" }, events);
  assert.ok(view.answer, "应有最终答案");
  assert.equal(view.answer.text, "新答案", "同 Run 只保留最新一份答案");
  assert.equal(typeof view.answer, "object");
  assert.equal(Array.isArray(view.answer), false);
});

test("快照终稿优先于事件里的旧文本", () => {
  const view = projectRunView(
    { id: "run_f", status: "completed", finalText: "权威终稿", finalMessageId: "mf" },
    [{ type: "assistant_final", data: { text: "事件里的旧文本", messageId: "me" } }],
  );
  assert.equal(view.answer.text, "权威终稿");
  assert.equal(view.answer.messageId, "mf");
  assert.equal(view.answer.source, "run");
});

console.log("\n▶ 文件改动与交付语义");

test("内部/缓存/临时文件归 internal，不进交付列表", () => {
  for (const internal of [".oaw/runs/x.json", ".agent-context.md", "node_modules/a.js", "tmp_x.log", "~$报告.docx", "._资源.md", "cache/abc.tmp"]) {
    assert.equal(isInternalChangePath(internal), true, `${internal} 应判为内部文件`);
  }
  for (const deliverable of ["报告.docx", "审查副本/批注稿.docx", "maps/zj/layers/road.geojson", "data/od.csv", "图.png"]) {
    assert.equal(isInternalChangePath(deliverable), false, `${deliverable} 不应判为内部文件`);
  }
  const run = {
    id: "run_g",
    status: "completed",
    artifacts: [
      { path: ".oaw/runs/run_g.json", status: "modified" },
      { path: "报告.docx", status: "added", acceptanceStatus: "passed" },
      { path: "草稿.tmp", status: "added" },
      { path: "数据.csv", status: "modified" },
    ],
  };
  const view = projectRunView(run, []);
  assert.equal(view.changes.length, 4, "变更清单应保留全部（含内部），由角色区分");
  assert.deepEqual(view.deliverables.map((item) => item.relativePath), ["报告.docx"], "交付列表只含明确交付物");
  const internal = view.changes.find((item) => item.relativePath === ".oaw/runs/run_g.json");
  assert.equal(internal.role, "internal");
  const unclassified = view.changes.find((item) => item.relativePath === "数据.csv");
  assert.equal(unclassified.role, "unclassified", "未验收的变更不得直接算交付");
});

test("事件里的 file_changed 只作疑似线索且不重复计入", () => {
  const events = [
    { type: "file_changed", data: { files: ["报告.docx", "新增.md"] } },
    { type: "file_changed", data: { files: ["新增.md"] } },
  ];
  const view = projectRunView({ id: "run_h", status: "completed", artifacts: [{ path: "报告.docx", status: "modified" }] }, events);
  const paths = view.changes.map((item) => item.relativePath);
  assert.deepEqual(paths, ["报告.docx", "新增.md"], "同一路径只出现一次，已知路径不重复");
  assert.equal(view.changes.find((item) => item.relativePath === "新增.md").confidence, "suspected");
});

test("normalizeFileChange：删除/新增类型与回滚可用性", () => {
  const deleted = normalizeFileChange({ path: "旧文件.docx", status: "deleted", before: { hash: "h", size: 5, reversible: true } }, { runId: "run_i" });
  assert.equal(deleted.changeType, "deleted");
  assert.equal(deleted.runId, "run_i");
  assert.equal(deleted.before.reversible, true);
  assert.equal(normalizeFileChange({ path: "a.txt", status: "新增" }).changeType, "unclassified");
});

console.log("\n▶ 归属与旧数据适配");

test("其他 Run 的迟到事件不影响本 Run", () => {
  const view = projectRunView({ id: "run_j", status: "running" }, [
    { type: "tool_start", data: { name: "read", toolCallId: "t1", runId: "run_j" } },
    { type: "run_finished", data: { status: "failed" }, runId: "run_other" },
    { type: "file_changed", data: { files: ["别人的文件.md"], runId: "run_other" } },
  ]);
  assert.equal(view.lifecycle, "running", "其他 Run 的终态不得改变本 Run");
  assert.equal(view.changes.length, 0, "其他 Run 的文件不得计入");
});

test("旧 RunSummary 消息可走同一投影（含产物与结论）", () => {
  const message = {
    summary: true,
    runId: "run_legacy",
    runStatus: "completed",
    text: "本轮对话完成，共处理 2 个文件",
    completion: { status: "success", source: "explicit", summary: "已修订报告", incomplete: [], blockers: [] },
    products: ["报告.docx", "摘要.md"],
    artifacts: [{ path: "报告.docx", status: "modified" }],
    events: [{ type: "run_finished", data: { status: "completed" } }],
  };
  const snapshot = adaptLegacyRunSummary(message);
  assert.equal(snapshot.runId, "run_legacy");
  const view = projectLegacyRunSummary(message);
  assert.equal(view.lifecycle, "completed");
  assert.equal(view.outcome.summary, "已修订报告");
  assert.equal(view.answer.text, "本轮对话完成，共处理 2 个文件");
  assert.ok(view.changes.length >= 1, "旧摘要的历史产出应可读");
});

console.log("\n▶ R04 客户端契约（非终态不得宣告完成）");

test("ChatPanel 不再默认 completed，缺失状态显示“状态待同步”", () => {
  const panel = fs.readFileSync(path.join(ROOT, "client/src/components/ChatPanel.jsx"), "utf8");
  assert.doesNotMatch(panel, /upsertRunSummary\(\{ \.\.\.data, status: data\.status \|\| "completed" \}\)/, "agent_summary 不得强制 completed");
  assert.doesNotMatch(panel, /const status = data\.status \|\| "completed"/, "结果卡状态不得默认 completed");
  assert.doesNotMatch(panel, /const finalStatus = data\.status \|\| "completed"/, "run_finished 缺失状态不得谎报完成");
  assert.match(panel, /"状态待同步"/, "缺失状态应显示“状态待同步”");
  assert.match(panel, /runStatus: status \|\| "unknown"/, "结果卡应以 unknown 表达待同步");
});

console.log("\n▶ 真实样本");

test("真实 Run 样本投影不抛错且字段自洽", () => {
  const dir = path.join(ROOT, ".oaw", "runs");
  if (!fs.existsSync(dir)) { console.log("      （无 .oaw/runs 样本，跳过）"); return; }
  const files = fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.startsWith(".")) // 排除 macOS AppleDouble（._xxx.json）
    .slice(0, 12);
  let checked = 0;
  for (const name of files) {
    let run = null;
    try { run = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { continue; }
    const view = projectRunView(run, Array.isArray(run.events) ? run.events : []);
    assert.equal(view.runId, run.id, "runId 应与样本一致");
    assert.ok(Object.keys(LIFECYCLE_LABELS_FOR_TEST).includes(view.lifecycle), `生命周期取值应受控：${view.lifecycle}`);
    assert.equal(view.lifecycle === "completed", ["completed"].includes(String(run.status)));
    if (Array.isArray(run.artifacts) && run.artifacts.length) {
      assert.ok(view.changes.length >= run.artifacts.length, "产物应全部进入变更清单");
    }
    checked += 1;
  }
  assert.ok(checked > 0, "应至少校验一个真实样本");
  console.log(`      已校验 ${checked} 个真实 Run 样本`);
});


console.log(failed ? "\n运行展示投影：失败" : "\n运行展示投影：通过");
process.exit(failed ? 1 : 0);
