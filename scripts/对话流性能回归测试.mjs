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
const excelSource = fs.readFileSync(new URL("../client/src/components/ExcelGrid.jsx", import.meta.url), "utf8");
const eventDisplaySource = fs.readFileSync(new URL("../client/src/事件展示.js", import.meta.url), "utf8");
const piRuntimeSource = fs.readFileSync(new URL("../server/Pi运行时管理.mjs", import.meta.url), "utf8");
let runId = null;
let selectiveRunId = null;

try {
  // 对话期间要可见 Runtime 冷启动事件，并在内容增高时继续跟随最新消息。
  // 事件展示注册表已集中到 事件展示.js；ChatPanel 只负责引用与渲染。
  assert.match(eventDisplaySource, /export const FLOW_EVENT_TYPES = new Set\(\[\.\.\.Object\.keys\(EVENT_UI\), \.\.\.FLOW_EXTRAS\]\)/, "事件类型注册表应集中在 事件展示.js");
  assert.match(eventDisplaySource, /runtime_connecting: \{ phase: "planning" \}/, "冷启动事件应在注册表登记为计划阶段");
  assert.match(chatPanelSource, /import \{ FLOW_EVENT_TYPES[^}]*\} from "\.\.\/事件展示\.js"/, "ChatPanel 应引用集中的事件类型注册表");
  assert.match(chatPanelSource, /case "runtime_connecting":/);
  assert.match(chatPanelSource, /\}, \[messages\]\);/, "自动滚动只应由消息内容变化触发");
  assert.match(chatPanelSource, /className="chat-scroll-latest"/, "用户离开底部后应提供回到底部按钮");
  assert.match(chatPanelSource, /function appendExecutionFlowEvent\(/, "执行流应合并重复的文件/总结事件");
  assert.match(chatPanelSource, /className="chat-topbar"/);
  assert.match(chatPanelSource, /showExecutionFlow && \(\s*<ExecutionFlow\s+events=\{executionEvents\}\s+running=\{busy\}\s+onFocusTool=\{focusTool\}/, "执行流应固定在对话顶部而不是插入消息气泡之间");
  assert.doesNotMatch(chatPanelSource, /executionFlowAnchored && m\.id === executionFlowAnchorId && <ExecutionFlow/);
  assert.match(chatPanelSource, /function ContextUsageRing\(/, "顶部应提供模型上下文用量环形圈");
  assert.match(chatPanelSource, /function ApprovalModeControl\(/, "顶部应提供 Codex 风格审批模式按钮");
  assert.match(chatPanelSource, /EXECUTION_FLOW_HIDDEN_KEY/, "执行流应支持隐藏并记住用户选择");
  assert.match(stylesSource, /\.msg-blocks \.thinking-block \.thinking-text[\s\S]{0,220}height: auto/, "思考块应按内容自适应高度");
  assert.match(stylesSource, /\.msg-blocks \.thinking-block \.thinking-text[\s\S]{0,260}max-height: 240px/, "思考内容区最多显示 240px 并内部滚动");
  assert.match(settingsSource, /thinkingDefaultOpen: false/, "思考块默认应收起（结论优先）");
  assert.match(chatPanelSource, /const \[expanded, setExpanded\] = useState\(\(\) => loadSettings\(\)\.thinkingDefaultOpen === true\)/, "思考块默认收起但尊重设置面板开关");
  assert.match(chatPanelSource, /usage\?\.contextTokens \?\? usage\?\.context/, "上下文圈应优先使用服务端提供的上下文 token 数");
  assert.match(agentSource, /event\?\.message\?\.usage/, "服务端应读取 Pi message.usage 用量事件");
  assert.match(chatPanelSource, /approval-mode-control/, "每次询问/自动批准切换应始终可见");
  assert.match(chatPanelSource, /body: JSON\.stringify\(\{ id: block\.id, decision \}\)/, "每次工具询问应提交用户的审批决定");
  assert.match(appSource, /if \(switched !== false\) setConversationMode\(/, "模式切换失败时顶部状态不能误更新");
  assert.match(serverSource, /\/api\/agent\/approval-mode/, "审批模式应由服务端持久化");
  assert.match(agentSource, /windowInfo\.known && entry\?\.session\?\.autoCompactionEnabled !== false/, "已知模型应交给 Pi SDK 按模型上下文自动压缩");
  assert.match(agentSource, /UNKNOWN_MODEL_AUTO_COMPACT_INPUT_TOKENS = 26000/, "只有未知模型才保留 2.6 万 token 兜底");
  assert.match(agentSource, /compactionMode: compactionPolicy\.mode/, "上下文快照应说明压缩责任归属");
  assert.match(piRuntimeSource, /PI_COMPACTION_POLICY = Object\.freeze\(\{ reserveTokens: 16384/, "Pi 自动压缩应保留输出与工具调用空间");
  assert.match(agentSource, /PI_COMPACTION_RESERVE_TOKENS = PI_COMPACTION_POLICY\.reserveTokens/, "Agent 应复用统一的压缩保留策略而非另写常量");
  assert.match(agentSource, /compactThresholdSource: compactionPolicy\.source/, "上下文快照应暴露压缩阈值来源");
  assert.match(chatPanelSource, /PI_COMPACTION_RESERVE_TOKENS = 16384/, "前端上下文圈应与 Pi 的默认保留空间一致");
  assert.match(chatPanelSource, /compactionMode === "pi-native" \? "Pi 自动"/, "前端应区分 Pi 原生压缩与未知模型兜底");
  assert.match(agentSource, /entry\.promptChars = 0/, "压缩成功后应清零本地估算，避免下一轮重复压缩");
  assert.match(serverSource, /historyHasMore/, "长会话 Chat 视图应返回历史窗口元数据");
  assert.match(chatPanelSource, /const MemoMessage = React\.memo\(Message/, "历史消息应按消息对象 memo，避免流式更新重渲染整页");
  assert.match(chatPanelSource, /const agentPhaseRef = useRef\(""\)/, "重复 token 不应反复触发相同的 React 状态更新");
  assert.match(chatPanelSource, /elapsedMs < 32/, "流式正文应合帧更新，避免每个 token 都触发 Markdown 渲染");
  assert.match(chatPanelSource, /const queueToolOutput = useCallback/);
  assert.match(chatPanelSource, /case "tool_output":[\s\S]{0,220}queueToolOutput\(aid, data\)/, "工具输出增量应先合并，再批量更新消息");
  assert.match(agentSource, /entry\.busy \|\| entry\.compacting \|\| entry\.queuedCount > 0/, "压缩期间新消息必须被视为排队");
  assert.match(agentSource, /this\.resumePromises = new Map\(\)/, "重复恢复同一会话必须复用同一个 Runtime 创建 Promise");
  assert.match(agentSource, /this\.recoveryPromises = new Map\(\)/, "失效 Runtime 恢复必须按会话单飞，不能重复重启");
  assert.match(agentSource, /AUTO_COMPACT_COOLDOWN_MS = 10000/, "自动压缩应有冷却窗口，避免连续触发");
  assert.doesNotMatch(agentSource, /emitChannelSafe\(entry, "context_compacting"/, "压缩开始只由 Pi SDK 事件产生，不能重复合成一份");
  assert.doesNotMatch(agentSource, /emitChannelSafe\(entry, "context_compacted"/, "压缩完成只由 Pi SDK 事件产生，不能重复合成一份");
  assert.match(serverSource, /requireWorkspaceWriteForTask\(initialWritePlan, requestedWorkspace\)/, "工作区产物任务必须在创建 Runtime 和模型初始化前探测写权限");
  assert.match(serverSource, /publishableStagedValidations/, "暂存产物校验失败时应跳过失败文件并继续发布其他文件");
  assert.match(chatPanelSource, /previous\?\.products \|\| \[\]/, "空的终结事件不能覆盖已有产物列表");
  assert.match(chatPanelSource, /window\.setTimeout\(resolve, 3000\)/, "发送应给 SSE 握手最多 3 秒，超时后靠服务端回放补齐 admission 事件");
  assert.match(chatPanelSource, /streamIdsRef/, "SSE 游标必须按通道代际隔离，避免 Runtime 重建后事件被旧游标过滤");
  assert.match(chatPanelSource, /streamGenerationRef/, "切换会话后必须隔离旧 EventSource 的迟到回调");
  assert.match(chatPanelSource, /generation === streamGenerationRef\.current/, "旧会话 SSE 回调不能写入当前会话");
  assert.match(chatPanelSource, /}, 50000\);/, "Pi Runtime 冷启动期间不能 5 秒就误判 SSE 握手失败");
  assert.match(chatPanelSource, /streamReadyRef\.current\?\.streamKey === currentStreamKey/, "发送只能等待当前会话的 SSE 握手");
  assert.match(serverSource, /stream_resync/, "历史窗口截断时必须通知前端重同步");
  assert.match(serverSource, /}, 5000\);/, "Runtime 初始化期间 SSE 应发送短周期心跳");
  assert.match(serverSource, /protocolVersion: PROTOCOL_VERSION/, "SSE 载荷必须携带协议版本与通道代际");
  assert.match(stylesSource, /\.preview-maximized \.center-area \{ display: none; \}/, "工作区最大化应占满对话主区域");
  assert.match(appSource, /onRunFinished=\{handleRunFinished\}/, "本轮完成后应把权威产物交给预览层");
  assert.match(appSource, /void open\(firstArtifact\.path/, "本轮完成后应自动打开首个产物");
  assert.match(chatPanelSource, /onRunFinished\?\.\(data\)/, "前端应在 run_finished 后通知产物预览");
  assert.match(chatPanelSource, /run-trace-tools-toggle/, "本轮工具应提供独立折叠交互");
  assert.match(chatPanelSource, /const \[toolsOpen, setToolsOpen\] = useState\(false\)/, "本轮工具默认应折叠");
  assert.match(serverSource, /function officeResults\(response\)/, "Excel 解析应兼容 Office CLI 结果结构");
  assert.match(serverSource, /s\.path \|\| `\/\$\{s\.name\}`/, "Excel 工作表读取应使用 DOM 路径");
  assert.match(serverSource, /ext === "xlsx" \|\| ext === "xls"/, "Excel 预览应同时识别 xlsx/xls");
  assert.match(excelSource, /hooks 顺序错误/, "Excel 空结果不能破坏 React hooks 顺序");

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
