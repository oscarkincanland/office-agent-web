#!/usr/bin/env node
/**
 * 运行复盘：汇总最近若干天的 Run，回答三件事
 *   1. 哪些工具调用失败最多、失败原因是什么（按错误文案聚类）
 *   2. 任务编排是否有绕圈（同工具+同参数重复调用、超长链路、失败步骤）
 *   3. 供应商/网络类错误（agent_error）分布
 *
 * 用法：
 *   node scripts/任务复盘.mjs [天数=7] [--out 报告.md] [--cwd 关键字]
 *
 * 说明：只读 .oaw/runs/*.json，不修改任何运行数据。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNS_DIR = path.join(ROOT, ".oaw", "runs");

const args = process.argv.slice(2);
const days = Number(args.find((item) => /^\d+$/.test(item)) || 7);
const outIndex = args.indexOf("--out");
const outFile = outIndex >= 0 ? args[outIndex + 1] : null;
const cwdFilter = (() => {
  const i = args.indexOf("--cwd");
  return i >= 0 ? String(args[i + 1] || "") : "";
})();
const since = Date.now() - days * 86400000;

/** 归一化错误文案：去掉 id / 绝对路径 / 长数字，便于聚类 */
const norm = (text) => String(text || "")
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
  .replace(/call_[0-9a-f]+/g, "call_<id>")
  .replace(/run_[0-9a-f-]+/g, "run_<id>")
  .replace(/\b\d{4,}\b/g, "<n>")
  .replace(/[A-Za-z]:\\[^\s"'）)]+/g, "<path>")
  .replace(/\s+/g, " ")
  .trim();

const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
const top = (map, limit = 10) => [...map].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([text, count]) => ({ count, text }));

const files = fs.readdirSync(RUNS_DIR)
  .filter((name) => /^run_.*\.json$/.test(name))
  .map((name) => ({ full: path.join(RUNS_DIR, name), mtime: fs.statSync(path.join(RUNS_DIR, name)).mtimeMs }))
  .filter((item) => item.mtime >= since)
  .sort((a, b) => b.mtime - a.mtime);

const status = new Map();
const special = new Map();
const tools = new Map();
const bashErrors = new Map();
const officeErrors = new Map();
const writeRejected = new Map();
const agentErrors = new Map();
const failedSteps = new Map();
const runs = [];

for (const file of files) {
  let run;
  try { run = JSON.parse(fs.readFileSync(file.full, "utf8")); } catch { continue; }
  if (cwdFilter && !String(run.cwd || "").includes(cwdFilter)) continue;
  const events = Array.isArray(run.events) ? run.events : [];
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const todos = Array.isArray(run.todos) ? run.todos : [];
  const calls = events.filter((event) => event.type === "tool_start");
  const ends = events.filter((event) => event.type === "tool_end");
  const fingerprints = new Map();

  for (const call of calls) {
    const key = `${call?.data?.name || "?"}::${norm(call?.data?.input).slice(0, 140)}`;
    fingerprints.set(key, (fingerprints.get(key) || 0) + 1);
  }
  const repeats = [...fingerprints].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]);

  for (const end of ends) {
    const name = String(end?.data?.name || "unknown");
    const entry = tools.get(name) || { calls: 0, errors: 0, sample: "" };
    entry.calls += 1;
    if (end?.data?.isError) {
      entry.errors += 1;
      if (!entry.sample) entry.sample = norm(end.data.result).slice(0, 100);
      if (name === "officecli") bump(officeErrors, norm(end.data.result).slice(0, 110));
      if (name === "bash") bump(bashErrors, norm(end.data.result).slice(0, 110));
    }
    tools.set(name, entry);
  }
  for (const event of events) {
    if (["write_rejected", "review_write_blocked", "review_waiting_confirmation", "agent_error", "ask_user"].includes(event.type)) bump(special, event.type);
    if (event.type === "write_rejected") bump(writeRejected, `${event?.data?.code || "?"}｜${norm(event?.data?.message).slice(0, 100)}`);
    if (event.type === "agent_error") bump(agentErrors, norm(event?.data?.message || event?.data?.error).slice(0, 120));
  }
  for (const step of steps) if (step.status === "failed") bump(failedSteps, norm(step.name).slice(0, 60));
  bump(status, run.status || "unknown");

  runs.push({
    at: run.startedAt || null,
    cwd: String(run.cwd || "").split(/[\\/]/).filter(Boolean).pop() || "",
    mode: run?.task?.mode || "?",
    status: run.status || "?",
    goal: norm(run?.task?.goal).slice(0, 70),
    tools: calls.length,
    toolErrors: ends.filter((end) => end?.data?.isError).length,
    failedSteps: steps.filter((step) => step.status === "failed").length,
    repeated: repeats.reduce((sum, [, count]) => sum + (count - 1), 0),
    topRepeat: repeats[0] ? `${repeats[0][1]}× ${repeats[0][0].slice(0, 70)}` : "",
    todos: `${todos.filter((todo) => todo.status === "completed").length}/${todos.length}`,
    error: norm(run.error).slice(0, 120) || null,
  });
}

runs.sort((a, b) => String(b.at).localeCompare(String(a.at)));
const toolRows = [...tools].map(([name, value]) => ({ name, ...value, rate: value.calls ? +(value.errors / value.calls * 100).toFixed(1) : 0 }))
  .sort((a, b) => b.errors - a.errors || b.calls - a.calls);

const lines = [];
lines.push(`# 运行复盘（最近 ${days} 天）`);
lines.push("");
lines.push(`- 样本：${runs.length} 个 Run${cwdFilter ? `（工作区包含「${cwdFilter}」）` : ""}`);
lines.push(`- 状态分布：${[...status].sort((a, b) => b[1] - a[1]).map(([key, value]) => `${key} ${value}`).join(" / ")}`);
lines.push(`- 特殊事件：${[...special].sort((a, b) => b[1] - a[1]).map(([key, value]) => `${key} ${value}`).join(" / ") || "无"}`);
lines.push("");
lines.push("## 工具失败面");
lines.push("");
lines.push("| 工具 | 调用 | 失败 | 失败率 | 典型错误 |");
lines.push("| --- | --- | --- | --- | --- |");
for (const row of toolRows.filter((item) => item.calls >= 3).slice(0, 14)) {
  lines.push(`| ${row.name} | ${row.calls} | ${row.errors} | ${row.rate}% | ${row.sample.replace(/\|/g, "/")} |`);
}
lines.push("");
lines.push("## 失败原因聚类");
for (const [title, items] of [["bash", top(bashErrors, 8)], ["OfficeCLI", top(officeErrors, 8)], ["写入被拒", top(writeRejected, 6)], ["模型/网络", top(agentErrors, 6)], ["失败步骤", top(failedSteps, 6)]]) {
  if (!items.length) continue;
  lines.push("");
  lines.push(`### ${title}`);
  for (const item of items) lines.push(`- ×${item.count} ${item.text}`);
}
lines.push("");
lines.push("## 编排：调用最多 / 重复最多");
const heavy = [...runs].sort((a, b) => b.tools - a.tools).slice(0, 6);
const repeated = [...runs].sort((a, b) => b.repeated - a.repeated).slice(0, 6);
lines.push("");
lines.push("| 时间 | 工作区 | 模式 | 工具 | 失败 | 重复 | 目标 |");
lines.push("| --- | --- | --- | --- | --- | --- | --- |");
for (const run of heavy) lines.push(`| ${run.at} | ${run.cwd} | ${run.mode} | ${run.tools} | ${run.toolErrors} | ${run.repeated} | ${run.goal.replace(/\|/g, "/")} |`);
lines.push("");
for (const run of repeated) lines.push(`- 重复 ${run.repeated} 次（${run.tools} 次调用）：${run.topRepeat}`);
lines.push("");
lines.push("## 非 completed 的 Run");
lines.push("");
for (const run of runs.filter((item) => item.status !== "completed").slice(0, 20)) {
  lines.push(`- ${run.at} [${run.status}] ${run.cwd}/${run.mode} 工具 ${run.tools}×（失败 ${run.toolErrors}）｜${run.goal}｜${run.error || "—"}`);
}

const report = lines.join("\n");
console.log(report);
if (outFile) {
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(path.resolve(outFile), report + "\n", "utf8");
  console.log(`\n已写入 ${path.resolve(outFile)}`);
}
