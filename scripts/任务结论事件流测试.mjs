#!/usr/bin/env node
/**
 * 任务结论 / 事件流 / 工具语义图标测试（P0–P3）：
 * 1. 运行终态（runConclusion）：失败/取消/部分完成不得显示成功色；
 * 2. 工具语义图标（toolIdentity）：现有全部内置工具名都有确定的类别图标；
 * 3. 服务端终态契约：客观结果可下调声明结论、模型 success 不可上调客观失败；
 * 4. Run Store 终稿单写入：同 Run 至多一条 assistant_final，重复/修正幂等；
 * 5. 静态契约：终稿按 Run 隔离、提醒回合不生成第二终稿、run_finished 携带幂等键。
 *
 * 用法: node scripts/任务结论事件流测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flowEventTone, runConclusion, toolIdentity } from "../client/src/事件展示.js";
import { applyObjectiveDowngrade } from "../server/运行轨迹.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
let failed = 0;
function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); failed = 1; }
function test(name, fn) {
  try {
    fn();
    ok(name);
  } catch (e) {
    fail(`${name}: ${e.message}`);
  }
}

const 事件展示 = read("client/src/事件展示.js");
const 对话面板 = read("client/src/components/ChatPanel.jsx");
const 图标 = read("client/src/components/Icon.jsx");
const 语义图标 = read("client/src/components/工具语义图标.jsx");
const runs源 = read("server/runs.mjs");
const agent源 = read("server/agent.mjs");
const index源 = read("server/index.mjs");

// ---------- 1. 运行终态（Run 生命周期层） ----------
console.log("\n▶ 运行终态与语气");

const finished = (status, completion) => ({ type: "run_finished", data: { status, completion } });

test("completed + success → 运行结束 / success", () => {
  const c = runConclusion(finished("completed", { status: "success", source: "explicit" }));
  assert.equal(c.label, "运行结束");
  assert.equal(c.tone, "success");
});
test("completed + partial → 部分完成 / warning（不是成功色）", () => {
  const c = runConclusion(finished("completed", { status: "partial", source: "explicit" }));
  assert.equal(c.label, "部分完成");
  assert.equal(c.tone, "warning");
});
test("completed + blocked → 受阻 / warning（不是成功色）", () => {
  const c = runConclusion(finished("completed", { status: "blocked", source: "explicit" }));
  assert.equal(c.label, "受阻");
  assert.equal(c.tone, "warning");
});
test("failed → 运行失败 / error", () => {
  const c = runConclusion(finished("failed", { status: "success", source: "explicit" }));
  assert.equal(c.label, "运行失败");
  assert.equal(c.tone, "error");
});
test("cancelled → 已取消 / warning", () => {
  const c = runConclusion(finished("cancelled", null));
  assert.equal(c.label, "已取消");
  assert.equal(c.tone, "warning");
});
test("flowEventTone 对 run_finished 复用 runConclusion（不再恒为 success）", () => {
  assert.equal(flowEventTone(finished("failed", null)), "error");
  assert.equal(flowEventTone(finished("completed", { status: "partial" })), "warning");
  assert.equal(flowEventTone(finished("completed", { status: "success" })), "success");
});
test("flowEventLabel 的 run_finished 不再是笼统的“任务完成”", () => {
  assert.match(事件展示, /case "run_finished": return runConclusion\(event\)\.label/);
});

// ---------- 2. 工具语义图标 ----------
console.log("\n▶ 工具语义图标");

test("思维 / 搜索 / 读写 / 终端 / 浏览器 / Office / 知识库 / 审批 / 通用 各有图标", () => {
  assert.equal(toolIdentity("__thinking__").icon, "brain");
  assert.equal(toolIdentity("grep").icon, "search");
  assert.equal(toolIdentity("web_search").icon, "search");
  assert.equal(toolIdentity("read").icon, "file");
  assert.equal(toolIdentity("write").icon, "edit");
  assert.equal(toolIdentity("bash").icon, "terminal");
  assert.equal(toolIdentity("browser_open").icon, "globe");
  assert.equal(toolIdentity("officecli").icon, "doc");
  assert.equal(toolIdentity("kb_search").icon, "book");
  assert.equal(toolIdentity("tool_approval_request").icon, "shield");
  assert.equal(toolIdentity("完全未知的工具").icon, "tool");
  assert.equal(toolIdentity("").icon, "tool");
});

test("内置工具清单全部映射到确定图标（无遗漏、无异常）", () => {
  // agent.mjs 里还有子代理等较短的 tools 清单；内置工具清单是最长的那一个，按此取用。
  const candidates = [...agent源.matchAll(/tools: \[([^\]]+)\]/g)].map((m) => m[1]);
  const toolsLine = candidates.reduce((longest, item) => (item.length > (longest?.length || 0) ? item : longest), null);
  assert.ok(toolsLine, "应能从 agent.mjs 解析出内置工具清单");
  const names = [...toolsLine.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.length >= 30, `工具清单应完整（实际 ${names.length} 项）`);
  const expected = {
    read: "file", context_read: "file",
    write: "edit", edit: "edit", review_source_apply: "edit",
    bash: "terminal", officecli: "doc",
    grep: "search", find: "search", ls: "search", web_search: "search", web_fetch: "search",
    kb_search: "book", kb_read: "book", skills_search: "book", skills_read: "book", memory_update: "book",
    map_read: "map", map_datasets: "map", map_edit: "map", map_import: "map", map_analyze: "map", map_save_analysis: "map", map_clear_analysis: "map",
    review_copy: "shield", ask_user: "comment", todo: "list", complete_task: "check", run_subagent: "flow",
  };
  const unmapped = [];
  for (const name of names) {
    const got = toolIdentity(name).icon;
    const want = /^browser_/i.test(name) ? "globe" : expected[name];
    assert.notEqual(got, undefined);
    if (!want) unmapped.push(name);
    else assert.equal(got, want, `${name} 应映射为 ${want}，实际 ${got}`);
  }
  assert.equal(unmapped.length, 0, `以下工具没有确定类别: ${unmapped.join(", ")}`);
});

test("语义图标与状态徽记是两套：语义文件独立、工具卡同时渲染二者", () => {
  assert.match(语义图标, /export default function ToolIdentityIcon/);
  assert.match(语义图标, /toolIdentity/);
  assert.match(对话面板, /import ToolIdentityIcon from "\.\/工具语义图标\.jsx"/);
  assert.match(对话面板, /<ToolIdentityIcon name=\{name\} size=\{12\}/);
  // 状态徽记（运行/成功/失败）仍然保留
  assert.match(对话面板, /className=\{`tool-icon \$\{done \? \(isError \? "err" : "ok"\) : "run"\}`\}/);
  // 思维图标与工具图标都由映射表驱动，颜色之外保留文字
  assert.match(事件展示, /export function toolIdentity\(/);
  assert.match(图标, /\n  brain: \(/);
});

// ---------- 3. 客观结果降级（服务端） ----------
console.log("\n▶ 客观结果降级");

test("取消可把模型 success 下调为 cancelled", () => {
  const r = applyObjectiveDowngrade({ status: "success", source: "explicit" }, { runStatus: "cancelled" });
  assert.equal(r.status, "cancelled");
  assert.equal(r.downgradedFrom, "success");
  assert.match(r.downgradeReason, /取消/);
});
test("运行失败可把模型 success 下调为 failed", () => {
  const r = applyObjectiveDowngrade({ status: "success", source: "explicit" }, { runStatus: "failed" });
  assert.equal(r.status, "failed");
});
test("产物验收失败可把 success 下调为 partial 并保留来源", () => {
  const r = applyObjectiveDowngrade({ status: "success", source: "explicit" }, { runStatus: "completed", verificationStatus: "failed" });
  assert.equal(r.status, "partial");
  assert.equal(r.source, "explicit");
  assert.match(r.downgradeReason, /验收/);
  assert.equal(r.verificationStatus, "failed");
});
test("模型 failed 不会被上调为 success", () => {
  const r = applyObjectiveDowngrade({ status: "failed", source: "explicit" }, { runStatus: "completed", verificationStatus: "passed" });
  assert.equal(r.status, "failed");
});
test("success + warning 不降级，只标注验收状态", () => {
  const r = applyObjectiveDowngrade({ status: "success", source: "explicit" }, { runStatus: "completed", verificationStatus: "warning" });
  assert.equal(r.status, "success");
  assert.equal(r.verificationStatus, "warning");
});

// ---------- 4. Run Store 终稿单写入（隔离目录） ----------
console.log("\n▶ Run Store 终稿单写入");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-conclusion-"));
process.env.OAW_RUNS_DIR = path.join(tmpRoot, "runs");
process.env.OAW_EVENT_DIR = path.join(tmpRoot, "events");
process.env.OAW_WRITE_LOCK_DIR = path.join(tmpRoot, "locks");
const runs = await import("../server/runs.mjs");

const ws = path.join(tmpRoot, "ws");
fs.mkdirSync(ws, { recursive: true });
const newRun = () => runs.beginRun({ clientId: "c1", threadId: "t1", cwd: ws, snapshotMode: "none", task: { goal: "测试", mode: "agent" } });
const finalsOf = (id) => runs.getRun(id).events.filter((e) => e.type === "assistant_final");
const finishOf = (id) => [...runs.getRun(id).events].reverse().find((e) => e.type === "run_finished");

try {
  const run = newRun();
  runs.recordRunFinalText(run.id, "最终答复");
  runs.recordRunFinalText(run.id, "最终答复");
  test("同文本重复写入只保留一条 assistant_final", () => {
    assert.equal(finalsOf(run.id).length, 1);
    assert.equal(runs.getRun(run.id).finalText, "最终答复");
    assert.equal(runs.getRun(run.id).finalMessageId, `final_${run.id}`);
  });
  runs.recordRunEvent(run.id, "assistant_final", { text: "最终答复" });
  test("经 recordRunEvent 写入的终稿同样幂等", () => {
    assert.equal(finalsOf(run.id).length, 1);
  });
  runs.recordRunFinalText(run.id, "最终答复（修订）");
  test("文本被修正时更新同一条事件并递增 version", () => {
    assert.equal(finalsOf(run.id).length, 1);
    assert.equal(runs.getRun(run.id).finalText, "最终答复（修订）");
    assert.equal(runs.getRun(run.id).finalTextVersion, 2);
  });
  const finishedRun = runs.finishRun(run.id, { status: "completed" });
  test("run_finished 携带终稿与稳定幂等键", () => {
    const ev = finishOf(run.id);
    assert.equal(ev.data.finalText, "最终答复（修订）");
    assert.equal(ev.data.finalMessageId, `final_${run.id}`);
    assert.equal(ev.data.completion?.runId || run.id, run.id);
    assert.equal(finishedRun.status, "completed");
  });
  test("终态单调：再次 finishRun 不改写已终结状态", () => {
    runs.finishRun(run.id, { status: "failed", completion: { status: "failed", source: "explicit", summary: "x" } });
    assert.equal(runs.getRun(run.id).status, "completed");
  });

  // 取消 + 模型声明 success → 客观降级
  const cancelRun = newRun();
  runs.recordRunFinalText(cancelRun.id, "我会完成它");
  const cancelled = runs.finishRun(cancelRun.id, { status: "cancelled", completion: { status: "success", source: "explicit", summary: "模型声明成功" } });
  test("取消后模型 success 被降级为 cancelled", () => {
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.completion.status, "cancelled");
    assert.equal(cancelled.completion.downgradedFrom, "success");
  });

  // completed + 验收失败 + 有可发布文件 → success 降为 partial
  const partialRun = newRun();
  runs.recordRunFinalText(partialRun.id, "已写两份文件");
  const partial = runs.finishRun(partialRun.id, {
    status: "completed",
    completion: { status: "success", source: "explicit", summary: "全部完成" },
    validations: [{ path: "ok.txt", status: "warning" }, { path: "bad.xlsx", status: "failed" }],
    publishPaths: ["ok.txt"],
  });
  test("验收有失败文件时 success 降为 partial", () => {
    assert.equal(partial.status, "completed");
    assert.equal(partial.verificationStatus, "failed");
    assert.equal(partial.completion.status, "partial");
    assert.equal(partial.completion.downgradedFrom, "success");
  });
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

// ---------- 5. 静态契约：跨 Run 隔离与提醒回合 ----------
console.log("\n▶ 终态契约（静态）");

test("新 Run 开始即清空终稿缓存（跨 Run 隔离）", () => {
  assert.match(agent源, /entry\.lastFinalText = "";/);
  assert.match(agent源, /entry\.suppressFinalText = false;/);
});
test("提醒回合不得生成第二份用户终稿", () => {
  assert.match(agent源, /const previousSuppressFinalText = entry\.suppressFinalText/);
  assert.match(agent源, /entry\.suppressFinalText = true/);
  assert.match(agent源, /entry\.suppressFinalText = previousSuppressFinalText/);
  assert.match(agent源, /if \(entry\.lastAssistantText && !entry\.suppressFinalText\)/);
});
test("终稿有唯一写入点，recordRunEvent 的 assistant_final 走幂等路径", () => {
  assert.match(runs源, /export function recordRunFinalText/);
  assert.match(runs源, /if \(type === "assistant_final"\)/);
  assert.match(runs源, /return recordRunFinalText\(id, data\?\.text/);
});
test("finishRun 对完成语义做客观降级并绑定 runId", () => {
  assert.match(runs源, /run\.completion = \{ \.\.\.completion, runId: run\.id \}/);
  assert.match(runs源, /applyObjectiveDowngrade\(run\.completion/);
});
test("run_finished 携带 finalText 与 finalMessageId", () => {
  assert.match(runs源, /finalMessageId: run\.finalMessageId \|\| null/);
  assert.match(index源, /getRun\(run\.id\)\?\.finalMessageId \|\| null/);
});
test("结论详细度：提示词允许结构化成果摘要，Run 摘要优先用结论", () => {
  // 生成端：不再强制「1-3 句、禁止 Markdown」，有成果时允许结构化 Markdown
  assert.match(agent源, /当本轮产生了文件、报告、数据、代码改动等成果时，用简洁但完整的 Markdown 把成果讲清楚/);
  assert.match(agent源, /建议 ≤800 字/);
  assert.match(agent源, /不要逐条复述工具调用流水/);
  // 落盘端：Run 摘要优先采用结论，历史列表/结果卡标题才能显示真实结论
  assert.match(runs源, /if \(run\.completion\?\.summary\) run\.summary = String\(run\.completion\.summary\)\.slice\(0, 4000\)/);
});
test("index 读取权威终稿优先走 Run 根级投影", () => {
  assert.match(index源, /if \(run && String\(run\.finalText \|\| ""\)\.trim\(\)\) return String\(run\.finalText\);/);
});
test("思考块默认收起且尊重设置，并有 ARIA 展开状态", () => {
  assert.match(对话面板, /useState\(\(\) => loadSettings\(\)\.thinkingDefaultOpen === true\)/);
  assert.match(对话面板, /className="thinking-header"[\s\S]{0,200}aria-expanded=\{expanded\}/);
  assert.match(对话面板, /aria-controls=\{idRef\.current\}/);
});

test("终态总结无条件发出：没有产物也要有总结卡与过程行", () => {
  // 成功/取消路径：file_changed 仍按需，agent_summary 不再被 productPaths 判空包裹
  assert.doesNotMatch(index源, /if \(productPaths\.length\) \{/, "终态总结不得再被 productPaths 判空包裹");
  assert.match(index源, /if \(productPaths\.length\) emitChannel\(entry, "file_changed"/, "file_changed 仍按需发出");
  assert.match(index源, /emitChannel\(entry, "agent_summary", \{[\s\S]{0,260}?summary: completed\?\.summary/, "成功/取消路径总结与 run 记录同文案");
  assert.match(index源, /emitChannel\(entry, "agent_summary", \{[\s\S]{0,260}?summary: finished\?\.summary/, "恢复路径总结与 run 记录同文案");
  assert.match(index源, /未检测到文件变更/, "无产物轮次也要有明确文案");
});

// ---------- 6. 用户中断 ≠ 模型故障 ----------
console.log("\n▶ 中断语义（不是故障）");

test("中断识别：必须同时是'用户请求中断'且错误形如中断", () => {
  assert.match(agent源, /export function isAbortLikeError\(value\)/, "应导出中断文案识别函数");
  assert.match(agent源, /export function isUserAbortSettled\(entry, value\)/, "应导出'用户中断收尾'判定");
  assert.match(agent源, /entry\.cancelRequested\) \|\| Boolean\(entry\.abortRequestedAt && Date\.now\(\) - entry\.abortRequestedAt < 120000\)/,
    "只有用户确实请求过中断才算中断（避免把真实网络中断静默掉）");
});

test("中断收尾不发 agent_error，改发 aborted（且只发一次）", () => {
  assert.match(agent源, /if \(isUserAbortSettled\(entry, settledError\)\) \{[\s\S]{0,220}?emitAbortedOnce\(entry, "用户请求中断"\)/,
    "agent_settled 里的中断应走 aborted");
  assert.match(agent源, /function emitAbortedOnce\(entry, reason = ""\)/, "中断终态事件必须幂等");
  assert.match(agent源, /entry\.abortedEmittedRunId = token/, "同一 Run 只发一次 aborted");
});

test("发送路由：中断不写 runtime_error，也不发 agent_error", () => {
  assert.match(index源, /const userAborted = cancelRequested && isAbortLikeError\(diagnostic\.message\)/,
    "中断判定要结合取消标记与错误文案");
  assert.match(index源, /if \(entry && userAborted\) \{[\s\S]{0,220}?emitChannel\(entry, "aborted"/, "中断只发 aborted");
  // 两条执行路径（排队执行器 + 直接发送路由）都要守住：runtime_error 一旦写入，
  // Run 会被标成"需要恢复"、Runtime 被标成 failed，用户中断后还要"恢复任务"。
  const guards = index源.match(/if \(runtimeHealth && !userAborted\) recordRunEvent\(run\.id, "runtime_error"/g) || [];
  assert.equal(guards.length, 2, "排队执行器与发送路由都必须跳过 runtime_error");
  assert.match(index源, /const userAborted = cancelRequestedHere && isAbortLikeError\(diagnostic\.message\)/,
    "排队执行器也要做同一套中断判定");
  assert.match(index源, /const cancelled = userAborted \|\| getRun\(run\.id\)\?\.status === "cancel_requested"/, "中断必须落 cancelled");
});

test("中断不把 Runtime 标成失败（否则下一条消息被当作失效运行时重建）", () => {
  const 运行时源 = read("server/Pi运行时管理.mjs");
  assert.match(运行时源, /record\.abortRequestedAt = Date\.now\(\)/, "中断时打时间标记");
  assert.match(运行时源, /isUserAbort\(record, error\)/, "收尾判定要认用户中断");
  assert.match(运行时源, /if \(this\.isUserAbort\(record, error\)\) \{[\s\S]{0,260}?reason: "user_abort"/, "中断收尾记 user_abort 而不是 markFailure");
});

test("abort 接口返回真实结果，并按 client 兜底查找在跑会话", () => {
  assert.match(agent源, /resolveLiveEntry\(clientId\)/, "找不到精确 key 时要按 client 前缀兜底");
  assert.match(agent源, /return \{ ok: true, cancelled: false, reason: "no-live-session" \}/, "没有在跑的任务要如实返回");
  assert.match(index源, /res\.json\(\{ \.\.\.result, runId: result\.runId \|\| runId \|\| null \}\)/, "中断结果要回传 runId");
  assert.match(index源, /const running = listRuns\(\{ limit: 20 \}\)\.find/, "内存 key 不匹配时按 Run 记录兜底取消");
});

test("中断看门狗：静默超时后按用户意图收尾，不再永远停在 cancel_requested", () => {
  assert.match(runs源, /const pendingCancellations = new Map\(\)/, "应记录待收尾的取消");
  assert.match(runs源, /export function listPendingCancellations\(\)/, "应导出待收尾列表供看门狗消费");
  assert.match(index源, /const cancelWatchdogTimer = setInterval/, "服务端应定时检查中断是否卡住");
  assert.match(index源, /now - cancelAt < CANCEL_STALL_MS\) continue/, "未超时不动");
  assert.match(index源, /if \(lastEventAt && now - lastEventAt < CANCEL_STALL_MS\) continue/, "仍在产出事件时不强制收尾");
  assert.match(index源, /\[runs\] 中断后静默超时，已按中断收尾/, "强制收尾要留日志");
});

test("客户端：中断后的 agent_error 按中断处理，且不残留错误文案", () => {
  assert.match(对话面板, /if \(stoppingRef\.current \|\| stopRequestedRef\.current\) \{[\s\S]{0,600}?finalizeStopped\(\);/,
    "中断后到达的 agent_error 应直接收尾为中断");
  assert.match(对话面板, /if \(id\) patch\(id, \(m\) => \(\{ \.\.\.m, status: "done", stopped: true, errorText: "" \}\)\)/,
    "中断收尾要清掉 errorText，结果卡里不能再留「模型调用失败」");
  assert.match(对话面板, /pushSystem\("已请求中断，但服务端未在 10 秒内确认收尾/, "服务端未确认时要说实话");
  assert.match(对话面板, /pushSystem\("没有找到正在运行的任务，可能这一轮已经结束了。"/, "没有在跑的任务不要谎报已中断");
  assert.match(对话面板, /}, 10000\);\n    try \{\n      const res = await fetch\("\/api\/agent\/abort"/, "确认窗口应为 10 秒而不是 1.2 秒本地收尾");
});

console.log(failed ? "\n✗ 任务结论事件流测试未通过\n" : "\n✓ 任务结论事件流测试全部通过\n");
process.exit(failed ? 1 : 0);
