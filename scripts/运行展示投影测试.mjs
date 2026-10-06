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
  associateRunMessages,
  deriveTimeline,
  deriveWorkPhase,
  isInternalChangePath,
  lifecycleLabel,
  normalizeFileChange,
  normalizeLifecycle,
  projectLegacyRunSummary,
  projectRunView,
  upsertRunSummaryMessage,
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

test("同一 Run 的过程消息归组且真实用户消息保持边界", () => {
  const source = [
    { id: "user-1", role: "user", text: "检查浏览器" },
    { id: "assistant-1", role: "assistant", text: "先检查浏览器状态" },
    { id: "reminder-1", role: "user", text: "[系统提醒] 已运行 3 轮，继续检查截图" },
    { id: "assistant-2", role: "assistant", text: "截图功能正常" },
    { id: "reminder-2", role: "user", text: "系统提醒：本轮工具执行已经结束，请记录结论" },
    { id: "summary-1", role: "system", summary: true, runId: "run_group" },
    { id: "user-2", role: "user", text: "开始另一个任务" },
    { id: "assistant-3", role: "assistant", text: "新任务答复" },
  ];
  const grouped = associateRunMessages(source);
  assert.equal(grouped[0].runId, undefined, "真实用户消息不应加入执行折叠");
  assert.equal(grouped[1].runId, "run_group");
  assert.equal(grouped[2].runId, "run_group");
  assert.equal(grouped[2].internalProcess, true, "系统提醒应成为执行过程而非独立用户气泡");
  assert.equal(grouped[4].runId, "run_group", "无方括号格式的收尾提醒也必须识别为内部事件");
  assert.equal(grouped[5].summary, true);
  assert.equal(grouped[6].runId, undefined, "下一条真实用户消息保持边界");
  assert.equal(grouped[7].runId, undefined, "下一轮助手答复不应被旧 Run 吸收");
});

test("agent_summary 与 run_finished 合并为同一条摘要，并保留早到的文件信息", () => {
  const initial = upsertRunSummaryMessage([{ id: "user-1", role: "user", text: "修改报告" }], {
    runId: "run_merge",
    status: "running",
    summary: "正在处理报告",
    artifacts: [{ path: "报告.docx", status: "modified" }],
    products: ["报告.docx"],
  }, { id: "summary-1", createdAt: 100, workspace: "/workspace", runMode: "agent" });
  const finished = upsertRunSummaryMessage(initial, {
    runId: "run_merge",
    status: "completed",
    completion: { status: "success", summary: "报告已修改并通过检查" },
    artifacts: [],
    products: [],
  }, { id: "must-not-replace", createdAt: 200 });

  assert.equal(finished.length, 2, "终态事件应更新原摘要，而非新增第二条");
  const summary = finished.find((item) => item.summary);
  assert.equal(summary.id, "summary-1", "同一 Run 应保留原消息 id");
  assert.equal(summary.runStatus, "completed");
  assert.equal(summary.text, "报告已修改并通过检查");
  assert.deepEqual(summary.products, ["报告.docx"], "空终态产物不得清除先到的文件列表");
  assert.deepEqual(summary.artifacts, [{ path: "报告.docx", status: "modified" }]);
  assert.equal(summary.createdAt, 100);
  assert.equal(summary.expanded, false, "历史摘要的文件详情默认折叠");
});

test("缺少 runId 的摘要事件无副作用，缺失状态不冒报为完成", () => {
  const messages = [{ id: "existing", role: "user", text: "保留" }];
  assert.equal(upsertRunSummaryMessage(messages, { summary: "缺少 runId" }), messages);
  const next = upsertRunSummaryMessage(messages, { runId: "run_unknown" }, { id: "summary-unknown" });
  const summary = next.find((item) => item.summary);
  assert.equal(summary.runStatus, "unknown");
  assert.equal(summary.text, "本轮任务状态待同步");
});

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
  // 旧 RunSummary 的 text 是 harness 收尾摘要，不是助手答复：不得进入答案投影，
  // 否则同一条答案会在正文与结果卡各出现一次（P0 单一展示所有权）。
  assert.equal(view.answer, null, "harness 收尾摘要不得冒充助手最终答复");
  assert.equal(snapshot.finalText, "", "旧摘要不应被改写成 finalText");
  assert.ok(view.changes.length >= 1, "旧摘要的历史产出应可读");
});

test("真正的权威终稿仍进入答案投影（旧消息兼容）", () => {
  const message = {
    summary: true,
    runId: "run_legacy_final",
    runStatus: "completed",
    authoritativeFinalText: "我已经把报告改好了，共 2 个文件。",
    completion: { status: "success", source: "explicit", summary: "已修订报告", incomplete: [], blockers: [] },
    events: [{ type: "run_finished", data: { status: "completed" } }],
  };
  const view = projectLegacyRunSummary(message);
  assert.ok(view.answer, "有权威终稿时答案投影不应为空");
  assert.equal(view.answer.text, "我已经把报告改好了，共 2 个文件。");
  assert.notEqual(view.answer.text, view.outcome.summary, "答案与收尾摘要必须是两段不同的文本，不能重复");
});

console.log("\n▶ R04 客户端契约（非终态不得宣告完成）");

test("ChatPanel 不再默认 completed，缺失状态显示“状态待同步”", () => {
  const panel = fs.readFileSync(path.join(ROOT, "client/src/components/ChatPanel.jsx"), "utf8");
  const projection = fs.readFileSync(path.join(ROOT, "client/src/运行展示投影.js"), "utf8");
  assert.doesNotMatch(panel, /upsertRunSummary\(\{ \.\.\.data, status: data\.status \|\| "completed" \}\)/, "agent_summary 不得强制 completed");
  assert.doesNotMatch(panel, /const status = data\.status \|\| "completed"/, "结果卡状态不得默认 completed");
  assert.doesNotMatch(panel, /const finalStatus = data\.status \|\| "completed"/, "run_finished 缺失状态不得谎报完成");
  assert.match(projection, /"状态待同步"/, "缺失状态应显示“状态待同步”");
  assert.match(projection, /runStatus: status \|\| "unknown"/, "结果卡应以 unknown 表达待同步");
  assert.match(panel, /upsertRunSummaryMessage\(messages, data/, "实时与终态事件必须合并到同一个纯函数，覆盖事件时序回归");
  assert.doesNotMatch(panel, /const status = data\.status \|\| previous\?\.runStatus/, "事件处理器不得引用状态更新器内部的 previous 变量");
});

console.log("\n▶ A03 输出与记忆策略契约");

test("记忆建议不插主消息流，改挂结果卡入口", () => {
  const panel = fs.readFileSync(path.join(ROOT, "client/src/components/ChatPanel.jsx"), "utf8");
  assert.doesNotMatch(panel, /text: "Agent 提出了一条长期记忆建议，请确认后写入。"/, "不得再把记忆建议当正文气泡插入");
  assert.match(panel, /memoryProposalIds: \[\.\.\.new Set\(\[\.\.\.\(item\.memoryProposalIds \|\| \[\]\), proposalId\]\)\]/, "应把建议挂到本轮结果卡");
  assert.match(panel, /在「设置 → 记忆」中确认或拒绝/, "入口应指向记忆审核位置");
  assert.match(panel, /memoryProposalIds\.filter\(\(id\) => id !== resolvedId\)/, "审核完成后应移除入口");
});

{
  const { buildOutputPolicyLines } = await import("../server/agent.mjs");
  try {
    const chat = buildOutputPolicyLines({ mode: "chat" }).join("\n");
    const review = buildOutputPolicyLines({ mode: "review" }).join("\n");
    const work = buildOutputPolicyLines({ mode: "work" }).join("\n");
    assert.match(chat, /1-3 句/, "Chat 模式应为短结论");
    assert.doesNotMatch(chat, /简洁但完整的 Markdown/, "Chat 模式不要求结构化成果");
    assert.doesNotMatch(review, /简洁但完整的 Markdown/, "Review 模式同样短结论");
    assert.match(work, /简洁但完整的 Markdown/, "Work 模式应要求结构化成果");
    for (const [name, text] of [["chat", chat], ["review", review], ["work", work]]) {
      assert.match(text, /进度结论（重要）/, `${name} 模式应共享同一条进度策略`);
    }
    // 默认（未知模式）按 work 处理
    assert.match(buildOutputPolicyLines().join("\n"), /简洁但完整的 Markdown/, "未指定模式应退化为 Work 策略");
    ok("输出策略按模式统一（单一来源，Chat/Review 短结论 / Work 结构化成果）");
  } catch (error) {
    bad(`输出策略按模式统一: ${error.message}`);
  }
}

test("服务端不再把全部文件名塞进总结正文（A02-3）", () => {
  const index = fs.readFileSync(path.join(ROOT, "server/index.mjs"), "utf8");
  assert.doesNotMatch(index, /个文件：\$\{[^}]*\.join\(", "\)\}/, "agent_summary 不应再拼接全部文件名");
  // 终态总结与 run 记录同文案（只保留数量/未检测到文件变更），并且无条件发出
  assert.match(index, /summary: completed\?\.summary \|\|/, "成功/取消路径沿用 run 记录文案");
  assert.match(index, /本轮对话完成，共处理 \$\{publishedCount\} 个文件/, "成功路径只保留数量");
  assert.match(index, /本轮对话完成，未检测到文件变更/, "无产物轮次也要有明确文案");
  assert.match(index, /summary: `对话异常结束，仍处理了 \$\{changed\.length\} 个文件`/, "异常路径同样只保留数量");
  assert.match(index, /summary: finished\?\.summary \|\|/, "恢复路径沿用 run 记录文案");
  assert.match(index, /恢复任务完成，共处理 \$\{productPaths\.length\} 个文件/, "恢复路径只保留数量");
  assert.match(index, /if \(productPaths\.length\) emitChannel\(entry, "file_changed"/, "总结无条件，file_changed 仍按需");
});

console.log("\n▶ W7/E01+E03 工作阶段与时间线");

test("工作阶段允许“验证→再执行”回退并计数重试", () => {
  const events = [
    { type: "run_started", at: "2026-10-02T01:00:00.000Z" },
    { type: "capability_plan", at: "2026-10-02T01:00:01.000Z" },
    { type: "tool_start", data: { name: "write", toolCallId: "t1" }, at: "2026-10-02T01:00:02.000Z" },
    { type: "artifacts_validated", data: { status: "failed" }, at: "2026-10-02T01:00:03.000Z" },
    { type: "tool_start", data: { name: "edit", toolCallId: "t2" }, at: "2026-10-02T01:00:04.000Z" },
    { type: "run_finished", data: { status: "completed" }, at: "2026-10-02T01:00:09.000Z" },
  ];
  const trail = deriveWorkPhase(events);
  assert.equal(trail.phase, "delivering", "最终应进入交付阶段");
  assert.equal(trail.retries, 1, "验证失败后再次执行应记为一次重试");
  const phases = trail.trail.map((item) => item.phase);
  assert.ok(phases.includes("verifying") && phases.indexOf("verifying") < phases.lastIndexOf("executing"), "轨迹应出现 verifying → executing 的回退");
});

test("结构化时间线区分首事件/模型执行/后台收尾", () => {
  const events = [
    { type: "run_started", at: "2026-10-02T01:00:00.000Z" },
    { type: "model_request_started", at: "2026-10-02T01:00:02.000Z" },
    { type: "token", at: "2026-10-02T01:00:03.000Z" },
    { type: "agent_end", at: "2026-10-02T01:00:10.000Z" },
    { type: "artifacts_validated", at: "2026-10-02T01:00:11.000Z" },
    { type: "run_finished", at: "2026-10-02T01:00:12.000Z" },
  ];
  const t = deriveTimeline(events, {});
  assert.equal(t.admitted, "2026-10-02T01:00:00.000Z");
  assert.equal(t.firstVisibleText, "2026-10-02T01:00:03.000Z");
  assert.equal(t.verificationEnd, "2026-10-02T01:00:11.000Z");
  assert.equal(t.finished, "2026-10-02T01:00:12.000Z");
  assert.equal(t.latencyToFirstEventMs, 2000, "首事件延迟 = 受理 → 首次模型事件");
  assert.equal(t.modelDurationMs, 8000, "模型执行时长");
  assert.equal(t.tailLatencyMs, 2000, "后台收尾延迟（模型结束 → 终态）");
});

test("E03：进度文本只来自结构化事件，不再正则猜正文", () => {
  const panel = fs.readFileSync(path.join(ROOT, "client/src/components/ChatPanel.jsx"), "utf8");
  assert.doesNotMatch(panel, /PROGRESS_WORDS/, "不得再用进度词正则从模型正文里猜进度");
  assert.doesNotMatch(panel, /const recentNarration = useMemo\(\(\) => \{\s*\n\s*const PROGRESS_WORDS/, "应移除旧的正文猜测实现");
  assert.match(panel, /find\(\(item\) => \["in_progress", "running"\]\.includes\(String\(item\?\.status \|\| ""\)\)\)/, "进度优先取进行中的待办（结构化）");
  assert.match(panel, /flowEventLabel\(event\)/, "退化为最近一条结构化事件的文案");
  const view = projectRunView({ id: "run_e03" }, [{ type: "tool_start", data: { name: "read", toolCallId: "t1" } }]);
  assert.ok(view.progress.timeline, "投影应带结构化时间线");
  assert.equal(typeof view.progress.workPhase, "string", "投影应带工作阶段");
});

test("相邻助手片段不合成（回退：避免跨轮次错乱）", () => {
  const grouped = associateRunMessages([
    { id: "u1", role: "user", text: "任务" },
    { id: "a1", role: "assistant", text: "第一步" },
    { id: "a2", role: "assistant", text: "第二步" },
    { id: "u2", role: "user", text: "追问" },
    { id: "b1", role: "assistant", text: "回答" },
  ]);
  assert.equal(grouped.find((m) => m.id === "a1")?.runId, undefined, "无总结的助手片段不应被强行合成");
  assert.equal(grouped.find((m) => m.id === "a2")?.runId, undefined, "无总结的助手片段不应被强行合成");
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
