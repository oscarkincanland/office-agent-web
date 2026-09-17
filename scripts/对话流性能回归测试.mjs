#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planTaskCapabilities } from "../server/task.mjs";
import { beginRun, finishRun, getRun, runsDir } from "../server/runs.mjs";
import { stageWrite } from "../server/写入协调.mjs";
import { 提取消息展示文本, 计算展示字符数 } from "../client/src/components/流式文本队列.js";
import { bashTimeoutPolicy, isGlobalSearchCommand, normalizeBashOptions } from "../server/命令安全策略.mjs";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "规聚对话流-"));
const chatPanelSource = fs.readFileSync(new URL("../client/src/components/ChatPanel.jsx", import.meta.url), "utf8");
const appSource = fs.readFileSync(new URL("../client/src/App.jsx", import.meta.url), "utf8");
const stylesSource = fs.readFileSync(new URL("../client/src/styles.css", import.meta.url), "utf8");
const settingsSource = fs.readFileSync(new URL("../client/src/components/SettingsPanel.jsx", import.meta.url), "utf8");
const agentSource = fs.readFileSync(new URL("../server/agent.mjs", import.meta.url), "utf8");
const serverSource = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
let runId = null;
let selectiveRunId = null;

try {
  // 对话期间要可见 Runtime 冷启动事件，并在内容增高时继续跟随最新消息。
  assert.match(chatPanelSource, /const FLOW_EVENT_TYPES = new Set\(\[\s*"runtime_connecting"/);
  assert.match(chatPanelSource, /case "runtime_connecting":/);
  assert.match(chatPanelSource, /\}, \[messages\]\);/, "自动滚动只应由消息内容变化触发");
  assert.match(chatPanelSource, /className="chat-scroll-latest"/, "用户离开底部后应提供回到底部按钮");
  assert.match(chatPanelSource, /function appendExecutionFlowEvent\(/, "执行流应合并重复的文件/总结事件");
  assert.match(chatPanelSource, /className="chat-topbar"/);
  assert.match(chatPanelSource, /showExecutionFlow && <ExecutionFlow events=\{executionEvents\} running=\{busy\} onFocusTool=\{focusTool\} \/>/, "执行流应固定在对话顶部而不是插入消息气泡之间");
  assert.doesNotMatch(chatPanelSource, /executionFlowAnchored && m\.id === executionFlowAnchorId && <ExecutionFlow/);
  assert.match(chatPanelSource, /function ContextUsageRing\(/, "顶部应提供模型上下文用量环形圈");
  assert.match(chatPanelSource, /function ApprovalModeControl\(/, "顶部应提供 Codex 风格审批模式按钮");
  assert.match(chatPanelSource, /EXECUTION_FLOW_HIDDEN_KEY/, "执行流应支持隐藏并记住用户选择");
  assert.match(stylesSource, /\.msg-blocks \.thinking-block \.thinking-text[\s\S]{0,220}height: auto/, "思考块应按内容自适应高度");
  assert.match(stylesSource, /\.msg-blocks \.thinking-block \.thinking-text[\s\S]{0,260}max-height: 240px/, "思考内容区最多显示 240px 并内部滚动");
  assert.match(settingsSource, /thinkingDefaultOpen: true/, "思考块默认应展开");
  assert.match(chatPanelSource, /const \[expanded, setExpanded\] = useState\(true\)/, "思考块首次渲染应默认展开");
  assert.match(chatPanelSource, /usage\?\.contextTokens \?\? usage\?\.context/, "上下文圈应优先使用服务端提供的上下文 token 数");
  assert.match(agentSource, /event\?\.message\?\.usage/, "服务端应读取 Pi message.usage 用量事件");
  assert.match(chatPanelSource, /approval-mode-control/, "每次询问/自动批准切换应始终可见");
  assert.match(chatPanelSource, /body: JSON\.stringify\(\{ id: block\.id, decision \}\)/, "每次工具询问应提交用户的审批决定");
  assert.match(appSource, /if \(switched !== false\) setConversationMode\(/, "模式切换失败时顶部状态不能误更新");
  assert.match(serverSource, /\/api\/agent\/approval-mode/, "审批模式应由服务端持久化");
  assert.match(agentSource, /modelContextWindow[\s\S]{0,220}0\.78/, "自动压缩阈值应根据模型上下文窗口计算");
  assert.match(chatPanelSource, /const agentPhaseRef = useRef\(""\)/, "重复 token 不应反复触发相同的 React 状态更新");
  assert.match(chatPanelSource, /elapsedMs < 32/, "流式正文应合帧更新，避免每个 token 都触发 Markdown 渲染");
  assert.match(chatPanelSource, /const queueToolOutput = useCallback/);
  assert.match(chatPanelSource, /case "tool_output":[\s\S]{0,220}queueToolOutput\(aid, data\)/, "工具输出增量应先合并，再批量更新消息");
  assert.match(agentSource, /entry\.busy \|\| entry\.compacting \|\| entry\.queuedCount > 0/, "压缩期间新消息必须被视为排队");
  assert.match(agentSource, /AUTO_COMPACT_COOLDOWN_MS = 10000/, "自动压缩应有冷却窗口，避免连续触发");
  assert.doesNotMatch(agentSource, /emitChannelSafe\(entry, "context_compacting"/, "压缩开始只由 Pi SDK 事件产生，不能重复合成一份");
  assert.doesNotMatch(agentSource, /emitChannelSafe\(entry, "context_compacted"/, "压缩完成只由 Pi SDK 事件产生，不能重复合成一份");
  assert.match(serverSource, /requireWorkspaceWriteForTask\(initialWritePlan, requestedWorkspace\)/, "工作区产物任务必须在创建 Runtime 和模型初始化前探测写权限");
  assert.match(serverSource, /publishableStagedValidations/, "暂存产物校验失败时应跳过失败文件并继续发布其他文件");
  assert.match(chatPanelSource, /previous\?\.products \|\| \[\]/, "空的终结事件不能覆盖已有产物列表");
  assert.match(chatPanelSource, /window\.setTimeout\(resolve, 3000\)/, "发送应给 SSE 握手最多 3 秒，超时后靠服务端回放补齐 admission 事件");
  assert.match(chatPanelSource, /streamIdsRef/, "SSE 游标必须按通道代际隔离，避免 Runtime 重建后事件被旧游标过滤");
  assert.match(serverSource, /stream_resync/, "历史窗口截断时必须通知前端重同步");
  assert.match(serverSource, /protocolVersion: PROTOCOL_VERSION/, "SSE 载荷必须携带协议版本与通道代际");
  assert.match(stylesSource, /\.preview-maximized \.center-area \{ display: none; \}/, "工作区最大化应占满对话主区域");

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

  // 暂存产物逐文件验收：坏文件跳过发布，合格文件继续发布，Run 保留校验结果。
  const selectiveRun = beginRun({
    clientId: "chat-flow-selective",
    threadId: "chat-flow-selective-thread",
    cwd: workspace,
    task: { mode: "agent", goal: "逐文件产物验收" },
  });
  selectiveRunId = selectiveRun.id;
  stageWrite({ runId: selectiveRun.id, workspace, targetPath: path.join(workspace, "合格产物.txt"), content: Buffer.from("通过", "utf8"), threadId: selectiveRun.threadId });
  stageWrite({ runId: selectiveRun.id, workspace, targetPath: path.join(workspace, "坏产物.json"), content: Buffer.from("{坏 json", "utf8"), threadId: selectiveRun.threadId });
  const selective = finishRun(selectiveRun.id, {
    status: "completed",
    summary: "逐文件验收",
    validations: [{ path: "合格产物.txt", status: "passed" }, { path: "坏产物.json", status: "failed" }],
    publishPaths: ["合格产物.txt"],
  });
  assert.equal(selective.status, "completed");
  assert.equal(selective.verificationStatus, "failed");
  assert.equal(fs.readFileSync(path.join(workspace, "合格产物.txt"), "utf8"), "通过");
  assert.equal(fs.existsSync(path.join(workspace, "坏产物.json")), false);

  console.log("对话流性能回归：通过");
} finally {
  if (runId) {
    fs.rmSync(path.join(runsDir(), runId), { recursive: true, force: true });
    fs.rmSync(path.join(runsDir(), `${runId}.json`), { force: true });
  }
  if (selectiveRunId) {
    fs.rmSync(path.join(runsDir(), selectiveRunId), { recursive: true, force: true });
    fs.rmSync(path.join(runsDir(), `${selectiveRunId}.json`), { force: true });
  }
  fs.rmSync(workspace, { recursive: true, force: true });
}
