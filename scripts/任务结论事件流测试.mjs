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
  const toolsLine = agent源.match(/tools: \[([^\]]+)\]/);
  assert.ok(toolsLine, "应能从 agent.mjs 解析出内置工具清单");
  const names = [...toolsLine[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.length >= 30, `工具清单应完整（实际 ${names.length} 项）`);
  const expected = {
    read: "file", context_read: "file",
    write: "edit", edit: "edit", review_source_apply: "edit",
    bash: "terminal", officecli: "doc",
    grep: "search", find: "search", ls: "search", web_search: "search", web_fetch: "search",
    kb_search: "book", kb_read: "book", skills_search: "book", skills_read: "book", memory_update: "book",
    map_read: "map", map_edit: "map", map_import: "map", map_analyze: "map", map_save_analysis: "map", map_clear_analysis: "map",
    review_copy: "shield", ask_user: "comment", todo: "list", complete_task: "check",
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
test("index 读取权威终稿优先走 Run 根级投影", () => {
  assert.match(index源, /if \(run && String\(run\.finalText \|\| ""\)\.trim\(\)\) return String\(run\.finalText\);/);
});
test("思考块默认收起且尊重设置，并有 ARIA 展开状态", () => {
  assert.match(对话面板, /useState\(\(\) => loadSettings\(\)\.thinkingDefaultOpen === true\)/);
  assert.match(对话面板, /className="thinking-header"[\s\S]{0,200}aria-expanded=\{expanded\}/);
  assert.match(对话面板, /aria-controls=\{idRef\.current\}/);
});

console.log(failed ? "\n✗ 任务结论事件流测试未通过\n" : "\n✓ 任务结论事件流测试全部通过\n");
process.exit(failed ? 1 : 0);
