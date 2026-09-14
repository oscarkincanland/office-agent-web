#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planTaskCapabilities } from "../server/task.mjs";
import { beginRun, finishRun, getRun, runsDir } from "../server/runs.mjs";
import { 提取消息展示文本, 计算展示字符数 } from "../client/src/components/流式文本队列.js";
import { bashTimeoutPolicy, isGlobalSearchCommand, normalizeBashOptions } from "../server/命令安全策略.mjs";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "规聚对话流-"));
const chatPanelSource = fs.readFileSync(new URL("../client/src/components/ChatPanel.jsx", import.meta.url), "utf8");
const stylesSource = fs.readFileSync(new URL("../client/src/styles.css", import.meta.url), "utf8");
const settingsSource = fs.readFileSync(new URL("../client/src/components/SettingsPanel.jsx", import.meta.url), "utf8");
const agentSource = fs.readFileSync(new URL("../server/agent.mjs", import.meta.url), "utf8");
const serverSource = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
let runId = null;

try {
  // 对话期间要可见 Runtime 冷启动事件，并在内容增高时继续跟随最新消息。
  assert.match(chatPanelSource, /const FLOW_EVENT_TYPES = new Set\(\[\s*"runtime_connecting"/);
  assert.match(chatPanelSource, /case "runtime_connecting":/);
  assert.match(chatPanelSource, /\}, \[messages, executionEvents, busy\]\);/);
  assert.match(chatPanelSource, /className="chat-topbar"/);
  assert.match(chatPanelSource, /showExecutionFlow && <ExecutionFlow events=\{executionEvents\} running=\{busy\} \/>/, "执行流应固定在对话顶部而不是插入消息气泡之间");
  assert.doesNotMatch(chatPanelSource, /executionFlowAnchored && m\.id === executionFlowAnchorId && <ExecutionFlow/);
  assert.match(chatPanelSource, /function ContextUsageRing\(/, "顶部应提供模型上下文用量环形圈");
  assert.match(chatPanelSource, /function ApprovalModeControl\(/, "顶部应提供 Codex 风格审批模式按钮");
  assert.match(chatPanelSource, /EXECUTION_FLOW_HIDDEN_KEY/, "执行流应支持隐藏并记住用户选择");
  assert.match(stylesSource, /\.msg-blocks \.thinking-block \.thinking-text[\s\S]{0,220}height: 240px/, "思考块应使用固定 240px 高度");
  assert.match(settingsSource, /thinkingDefaultOpen: true/, "思考块默认应展开");
  assert.match(serverSource, /\/api\/agent\/approval-mode/, "审批模式应由服务端持久化");
  assert.match(agentSource, /modelContextWindow[\s\S]{0,220}0\.78/, "自动压缩阈值应根据模型上下文窗口计算");
  assert.match(chatPanelSource, /const agentPhaseRef = useRef\(""\)/, "重复 token 不应反复触发相同的 React 状态更新");
  assert.match(chatPanelSource, /elapsedMs < 32/, "流式正文应合帧更新，避免每个 token 都触发 Markdown 渲染");
  assert.match(chatPanelSource, /const queueToolOutput = useCallback/);
  assert.match(chatPanelSource, /case "tool_output":[\s\S]{0,220}queueToolOutput\(aid, data\)/, "工具输出增量应先合并，再批量更新消息");
  assert.match(agentSource, /entry\.busy \|\| entry\.compacting \|\| entry\.queuedCount > 0/, "压缩期间新消息必须被视为排队");
  assert.doesNotMatch(agentSource, /emitChannelSafe\(entry, "context_compacting"/, "压缩开始只由 Pi SDK 事件产生，不能重复合成一份");
  assert.doesNotMatch(agentSource, /emitChannelSafe\(entry, "context_compacted"/, "压缩完成只由 Pi SDK 事件产生，不能重复合成一份");
  assert.match(serverSource, /requireWorkspaceWriteForTask\(initialWritePlan, requestedWorkspace\)/, "工作区产物任务必须在创建 Runtime 和模型初始化前探测写权限");

  // UI 的模式说明不可混入用户输入；普通 Agent 任务不应因此误触发 Office 或 Skills。
  const plan = planTaskCapabilities({ text: "测试一下", task: { mode: "agent" } });
  assert.equal(plan.routing.officecli, "not_needed");
  assert.equal(plan.routing.skills, "available_on_demand");
  assert.equal(isGlobalSearchCommand('find / -name "梳理总结"'), true);
  assert.equal(isGlobalSearchCommand('find . -name "梳理总结"'), false);
  assert.equal(normalizeBashOptions({}).timeout, bashTimeoutPolicy.defaultSeconds);
  assert.equal(normalizeBashOptions({ timeout: 999 }).timeout, bashTimeoutPolicy.maxSeconds);

  // 正常逐字显示，同时要能在短时间内追上没有 token 的 assistant_final。
  assert.equal(计算展示字符数({ remaining: 30, elapsedMs: 20, reducedMotion: true }), 30);
  assert.ok(计算展示字符数({ remaining: 30, elapsedMs: 20 }) >= 1);
  assert.equal(计算展示字符数({ remaining: 10, elapsedMs: 16 }), 2, "常规回复应比旧版 52 字符/秒更快显示");
  assert.ok(计算展示字符数({ remaining: 800, elapsedMs: 16 }) >= 20);
  assert.equal(提取消息展示文本({ text: "旧字段结论" }), "旧字段结论");
  assert.equal(提取消息展示文本({ text: "不可重复", blocks: [{ type: "text", text: "权威" }, { type: "tool", output: "忽略" }, { type: "text", text: "结论" }] }), "权威结论");

  // Chat 仍记录 Run，但不得为只读问答扫描、复制或追踪整个工作区。
  fs.writeFileSync(path.join(workspace, "大文件样本.txt"), "x".repeat(1024 * 1024), "utf8");
  const run = beginRun({
    clientId: "chat-flow-test",
    threadId: "chat-flow-thread",
    cwd: workspace,
    task: { mode: "chat", goal: "只读问答" },
    snapshotMode: "none",
  });
  runId = run.id;
  assert.equal(run.snapshotMode, "none");
  assert.equal(run.before.size, 0);
  assert.deepEqual(run.before.files, {});

  fs.writeFileSync(path.join(workspace, "不应作为聊天产物.txt"), "仅用于验证", "utf8");
  const completed = finishRun(run.id, { status: "completed", summary: "聊天回归" });
  assert.equal(completed.status, "completed");
  assert.equal(completed.artifacts.length, 0);
  assert.equal(getRun(run.id).snapshotMode, "none");

  console.log("对话流性能回归：通过");
} finally {
  if (runId) {
    fs.rmSync(path.join(runsDir(), runId), { recursive: true, force: true });
    fs.rmSync(path.join(runsDir(), `${runId}.json`), { force: true });
  }
  fs.rmSync(workspace, { recursive: true, force: true });
}
