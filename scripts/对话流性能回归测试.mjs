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
const workProductSource = fs.readFileSync(new URL("../client/src/components/工作产物面板.jsx", import.meta.url), "utf8");
const apiSource = fs.readFileSync(new URL("../client/src/api.js", import.meta.url), "utf8");
const runProjectionSource = fs.readFileSync(new URL("../client/src/运行展示投影.js", import.meta.url), "utf8");
const appSource = fs.readFileSync(new URL("../client/src/App.jsx", import.meta.url), "utf8");
const stylesSource = fs.readFileSync(new URL("../client/src/styles.css", import.meta.url), "utf8");
const settingsSource = fs.readFileSync(new URL("../client/src/components/SettingsPanel.jsx", import.meta.url), "utf8");
const appearanceSource = fs.readFileSync(new URL("../client/src/界面外观.js", import.meta.url), "utf8");
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
  assert.match(chatPanelSource, /const showExecutionFlow = busy &&/, "SSE 执行流只在当前运行期间呈现");
  const topbarStart = chatPanelSource.indexOf('<div className="chat-topbar">');
  const chatBodyStart = chatPanelSource.indexOf('<div className="chat-body"', topbarStart);
  const topbarSource = chatPanelSource.slice(topbarStart, chatBodyStart);
  assert.doesNotMatch(topbarSource, /<ExecutionFlow/, "执行流不能再挂在对话顶部栏");
  assert.ok(chatBodyStart >= 0 && chatPanelSource.indexOf("<ExecutionFlow", chatBodyStart) > chatBodyStart, "实时执行流应作为当前消息流的一部分呈现");
  assert.doesNotMatch(chatPanelSource, /className="task-status-bar"/, "顶部不再重复展示复杂状态栏");
  assert.doesNotMatch(stylesSource, /\.chat-body > \.execution-flow \{\s*position: sticky/, "消息内执行流不能吸顶遮挡消息");
  assert.match(workProductSource, /import React, \{[^}]*useCallback/, "改动页签使用的 useCallback 必须正确从 React 导入");
  assert.match(workProductSource, /Boolean\(currentSessionId\) && run\.sessionId === currentSessionId/, "无会话 id 时不得跨会话显示产物（防同文件夹污染）");
  assert.match(workProductSource, /sessionId: currentSessionId,[\s\S]{0,80}includeEvents: "none"/, "改动页签应在服务端按会话筛选并省略 SSE 事件载荷");
  assert.match(workProductSource, /setTimeout\(\(\) => controller\.abort\(\), 15000\)/, "改动数据请求应有限等待并超时收敛");
  assert.match(workProductSource, /abortRef\.current\?\.abort\(\)/, "切换会话/组件卸载时应取消过期的改动请求");
  assert.match(apiSource, /if \(options\.includeEvents\) params\.set\("includeEvents", options\.includeEvents\)/, "Run 列表接口应允许请求轻量元数据");
  assert.match(apiSource, /options\.signal \? \{ signal: options\.signal \} : \{\}/, "Run 数据请求应支持 AbortSignal");
  assert.match(chatPanelSource, /useState\(Boolean\(defaultExpanded \|\| running\)\)/, "活动 SSE 执行流应在运行时展开");
  assert.match(chatPanelSource, /if \(running && !wasRunning\)[\s\S]{0,180}setExpanded\(true\)/, "SSE 运行开始时应展开过程流");
  assert.match(chatPanelSource, /else if \(!running && wasRunning\)[\s\S]{0,80}setExpanded\(false\)/, "SSE 运行结束后应自动收束");
  assert.match(chatPanelSource, /executionListRef[\s\S]{0,260}list\.scrollTop = list\.scrollHeight/, "展开的实时事件流应自动跟随最新事件");
  assert.match(chatPanelSource, /followExecutionTailRef\.current = list\.scrollHeight - list\.scrollTop - list\.clientHeight <= 28/, "用户向上回看时应暂停自动滚动，回到底部后恢复跟随");
  assert.match(chatPanelSource, /const processSummary = view\.progress\.toolTotal/, "过程行摘要应只聚合工具成功/失败数，不与文件验收信息重复");
  const runSummarySource = chatPanelSource.slice(chatPanelSource.indexOf("function RunSummary("), chatPanelSource.indexOf("// ========== 消息组件"));
  assert.match(runSummarySource, /const \[open, setOpen\] = useState\(false\)/, "每轮文件清单默认折叠");
  assert.match(runSummarySource, /run-result-fold \$\{embedded \? "embedded" : ""\}/, "嵌入式结果摘要应服从消息级统一折叠");
  assert.doesNotMatch(runSummarySource, /任务轮次 \{m\.runIndex/, "常规对话结果头不显示任务轮次计数");
  assert.match(runSummarySource, /useEffect\(\(\) => setSummaryOpen\(runIsLive\), \[runIsLive\]\)/, "任务结束时应自动收起结论与工具轨迹");
  assert.match(runSummarySource, /!embedded && \(trace\?\.tools\?\.length > 0/, "嵌入式结果卡不重复渲染工具明细");
  assert.match(runSummarySource, /run-trace-step-heading/, "独立结果摘要仍保留有序工具时间线");
  assert.match(runSummarySource, /run-result-conclusion/, "本轮结论应收纳在同一个可展开摘要内");
  assert.match(chatPanelSource, /foldedProcessBlocks/, "思考、工具及运行中的进度播报应并入消息级过程卡");
  assert.match(chatPanelSource, /message-process-scroll/, "过程内容应在一个有界滚动容器中回看");
  assert.match(chatPanelSource, /<ExecutionFlow \{\.\.\.executionFlow\} embedded \/>/, "SSE 轨迹应嵌入消息过程卡，而非独立置底状态栏");
  assert.match(chatPanelSource, /authoritativeFinalText/, "权威终稿应与过程播报分离，避免折叠误吞结论");
  assert.doesNotMatch(chatPanelSource, /latestTextBlock\?\.text/, "不能把最后一条过程播报猜成最终答复并留在折叠区外");
  assert.match(chatPanelSource, /Boolean\(m\.runId\)/, "历史 Run 的所有非终稿文本都应归入过程折叠");
  assert.match(chatPanelSource, /process_note/, "内部系统提醒应收进过程区，不作为独立用户消息显示");
  assert.match(chatPanelSource, /streaming=\{streaming && blockIndex === lastThinkingBlockIndex\} embedded/, "只有最新思考块在流式阶段显示实时打字状态");
  assert.match(chatPanelSource, /useLayoutEffect\(\(\) => \{[\s\S]{0,220}list\.scrollTop = list\.scrollHeight/, "流式内容 DOM 更新后应在布局阶段贴底，避免滚动慢一帧");
  assert.match(chatPanelSource, /followProcessTailRef\.current = list\.scrollHeight - list\.scrollTop - list\.clientHeight <= 28/, "用户上滚阅读时暂停自动贴底，回到底部后恢复跟随");
  assert.match(chatPanelSource, /thinking-process-inline \$\{streaming \? "is-streaming" : ""\}/, "实时思考应显示轻量打字光标");
  assert.match(stylesSource, /\.message-process-scroll \.thinking-text \{ max-height: none; overflow: visible; \}/, "思考内容不得在过程滚动区内产生第二个滚动条");
  assert.match(chatPanelSource, /appendAssistantMessageBoundary/, "流式 assistant 消息边界应支持准确分离进度与终稿");
  assert.match(runProjectionSource, /export function associateRunMessages\(/, "历史对话需按真实用户消息边界关联到对应 Run");
  assert.match(stylesSource, /\.message-process-scroll \{[^}]*max-height: 300px; overflow: auto/s, "过程面板应限制高度并在内部滚动");
  assert.match(stylesSource, /\.message-process-scroll \.execution-flow-list-embedded \{ max-height: none; overflow: visible; padding: 0; border: 0; background: transparent; \}/, "SSE 事件列表应压平到外层滚动区，不再单独套框");
  assert.match(stylesSource, /\.execution-flow-embedded \{ min-width: 0; padding: 0; border: 0; background: transparent; \}/, "嵌入式事件轨迹不应额外增加分隔框");
  assert.match(stylesSource, /\.embedded-run-summary \{ display: block; min-width: 0; margin: 0; border: 0; background: transparent; \}/, "结构化总结也不应在过程流里再套第二层卡片");
  assert.match(stylesSource, /\.embedded-run-summary \.run-result-fold\.embedded > \.run-result \{[^}]*background: transparent;/, "嵌入式结果摘要底色也应压平");
  assert.match(chatPanelSource, /function ContextUsageRing\(/, "顶部应提供模型上下文用量环形圈");
  assert.match(chatPanelSource, /function ApprovalModeControl\(/, "顶部应提供 Codex 风格审批模式按钮");
  // B02：执行过程显示改为外观设置驱动（compact|expanded|hidden）并走共享订阅；
  // 旧独立开关只在 界面外观.js 里做一次性迁移。
  assert.match(chatPanelSource, /const flowHidden = appearance\.activityDisplay === "hidden"/, "执行流隐藏应由设置项决定");
  assert.match(chatPanelSource, /setAppearance\(\{ activityDisplay: next \? "hidden" : "compact" \}\)/, "隐藏/显示选择应写回设置并保留");
  assert.match(chatPanelSource, /useAppearance\(\)/, "执行流显示应订阅外观设置（立即生效，而不是只在挂载时读一次）");
  assert.match(appearanceSource, /LEGACY_EXECUTION_FLOW_HIDDEN_KEY/, "旧隐藏开关应保留常量用于迁移");
  assert.match(appearanceSource, /export function migrateLegacyAppearance\(\)/, "旧开关应一次性迁移到 activityDisplay");  assert.match(stylesSource, /\.msg-blocks \.thinking-block \.thinking-text[\s\S]{0,220}height: auto/, "思考块应按内容自适应高度");
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
  assert.match(runProjectionSource, /previous\?\.products \|\| \[\]/, "空的终结事件不能覆盖已有产物列表");
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
  assert.match(chatPanelSource, /className=\{`message-process-fold \$\{isTaskActivity \? "run-activity-fold" : ""\} \$\{isTaskLive \? "is-live is-live-plain" : ""\}`\}/, "思考、SSE、总结归入同一个消息级折叠；运行时标记活跃且去框");
  // 输入栏待处理条：折叠过程收起时审批/提问仍可直接处理（计划 B01）
  assert.match(chatPanelSource, /function PendingActionBar/, "输入栏应提供待处理入口组件");
  assert.match(chatPanelSource, /const pendingAsk = useMemo/, "应计算待回答项");
  assert.match(chatPanelSource, /<PendingActionBar\s/, "待处理条应渲染进输入栏");
  // 执行行去重：同一工具的调用/完成只保留一行；tool_start 不再重复工具名
  assert.match(chatPanelSource, /const endedToolCalls = new Set/, "已结束的工具调用应从事件行中去重");
  assert.match(chatPanelSource, /const dedupedEvents = visibleEvents.filter/, "事件行应使用去重后的序列");
  assert.match(chatPanelSource, /event.type === "tool_start" \? "" : event.type === "file_changed"/, "tool_start 不应重复显示工具名 detail");
  // 嵌入执行列表默认折叠：一行摘要 + 点击展开
  assert.match(chatPanelSource, /const \[embeddedExpanded, setEmbeddedExpanded\] = useState\(false\)/, "嵌入执行流应默认折叠");
  assert.match(chatPanelSource, /open=\{isTaskLive \|\| processOpen\}/, "运行中执行过程应强制展开");
  assert.match(chatPanelSource, /isTaskLive \? "is-live is-live-plain" : ""/, "运行中过程区应去掉框");
  assert.doesNotMatch(chatPanelSource, /setEmbeddedExpanded\(Boolean\(running\)\)/, "事件列表不应随运行自动展开（默认折叠）");
  const livePlainStyles = fs.readFileSync(new URL("../client/src/styles.css", import.meta.url), "utf8");
  assert.match(livePlainStyles, /\.message-process-fold\.is-live-plain \.message-process-scroll \{ max-height: none; overflow: visible; padding: 0; gap: 6px; \}/, "运行中过程应平铺、由页面滚动");
  assert.match(livePlainStyles, /\.message-process-fold\.is-live-plain \.message-process-fold-body \{ border-top: 0; \}/, "运行中过程区不应有分隔边框");
  assert.match(livePlainStyles, /\.markdown-body p:has\(> br:only-child\) \{ display: none; \}/, "仅含换行的段落不应占位");
  assert.match(livePlainStyles, /\.run-result-conclusion \.markdown-body \{ line-height: 1\.6; \}/, "结论区行距应紧凑");
  assert.match(livePlainStyles, /\.center-chat-slot \.chat-body > \.msg,[\s\S]{0,220}?margin-left: auto;/, "无侧栏时消息列应居中（有侧栏时自适应）");
  assert.match(chatPanelSource, /className="execution-flow-embedded-toggle"/, "嵌入执行流应有一行折叠摘要");
  assert.match(chatPanelSource, /\{embeddedExpanded && <div className="execution-flow-list execution-flow-list-embedded">/, "事件明细应仅在展开时渲染");
  // 本轮产物独立框 + 面板宽度
  assert.match(chatPanelSource, /className="run-products-box"/, "结论之后应有本轮产物独立框");
  assert.match(chatPanelSource, /className="loading-inline"/, "等待首块应为无框行内指示");
  assert.doesNotMatch(chatPanelSource, /可写：工作区内/, "输入框不应再显示写入权限徽标");
  assert.doesNotMatch(chatPanelSource, /输入消息…  @ 引用文件/, "输入框占位提示不应再带长说明");
  assert.match(chatPanelSource, /: "输入消息…"\}/, "输入框占位提示应简化为“输入消息…”");
  assert.match(chatPanelSource, /className="run-products-badge">交付/, "产物框应标记交付项");
  const widthStyles = fs.readFileSync(new URL("../client/src/styles.css", import.meta.url), "utf8");
  assert.match(widthStyles, /--chat-w: 460px/, "对话面板默认宽度应加宽");
  assert.match(widthStyles, /--chat-max: 720px/, "对话面板最大宽度应放宽");
  assert.match(widthStyles, /\.center-chat-slot \.msg\.user \.msg-main \{ width: auto; max-width: min\(78%, 540px\); \}/, "用户气泡应随内容收缩（不再固定宽度）");
  assert.match(widthStyles, /\.center-chat-slot \.msg\.user \.bubble \{ width: fit-content/, "用户气泡应为内容宽度");
  assert.match(widthStyles, /\.center-chat-slot \.msg-main \{ width: min\(100%, 880px\); max-width: 880px; \}/, "agent 回答区应加宽到 880px");
  assert.match(widthStyles, /\.msg-main > \.message-process-fold \{ order: -1; \}/, "执行过程折叠应排在文字上方");
  assert.match(widthStyles, /\.msg-main > \.msg-header \{ margin-bottom: 2px; order: -2; \}/, "标题应保持在最上方");
  assert.match(widthStyles, /\.msg \.markdown-body \{ line-height: 1\.65; \}/, "对话正文行距应收紧");
  assert.match(chatPanelSource, /待审批：\{approvalLabel\}/, "待审批应显示在输入栏");
  assert.match(chatPanelSource, /待回答：\{String\(ask\.question/, "待回答应显示在输入栏");
  assert.match(chatPanelSource, /\/api\/agent\/approval/, "输入栏可直接提交审批");
  assert.match(chatPanelSource, /\/api\/agent\/answer/, "输入栏可直接提交回答");
  assert.match(chatPanelSource, /messageId: messages\[index\]\.id/, "待回答应带所在消息 id");
  assert.match(chatPanelSource, /onAnswered=\{\(blockId, answer\) => handleMessageAskAnswered\(pendingAsk\?\.messageId, blockId, answer\)\}/, "输入栏回答成功应标记已回答（待处理条消失）");
  assert.match(chatPanelSource, /const visibleMessages = useMemo\([\s\S]{0,100}associateRunMessages\(messages\.slice\(visibleStart\)\)/, "渲染层必须再次保障历史过程消息按 Run 归组");
  assert.doesNotMatch(chatPanelSource, /<span>\{activityCount\} 项/, "执行过程摘要不显示容易与模型轮次混淆的数量标签");
  // 本轮结构化结论、事件轨迹与思考/播报共用同一滚动折叠；权威最终答复仍留在外面。
  assert.match(chatPanelSource, /message-process-scroll[\s\S]{0,2400}\{runSummary && \([\s\S]{0,240}<RunSummary/, "本轮结构化结论应并入同一个滚动过程容器");
  assert.match(chatPanelSource, /authoritativeFinalText[\s\S]{0,220}assistant-final-answer/, "简洁的权威最终答复仍保持可见");
  // harness 提醒不得显示为可见消息（恢复 + 实时兜底各一道）
  assert.match(chatPanelSource, /不得在恢复会话后显示为“You”消息/, "历史恢复应过滤系统提醒");
  assert.match(chatPanelSource, /未被分组消费的提醒消息同样不渲染/, "渲染层应有提醒兜底过滤");
  assert.match(chatPanelSource, /else if \(!isTaskLive && processWasLiveRef\.current\)[\s\S]{0,80}setProcessOpen\(false\)/, "运行完成后统一收束过程卡");
  assert.match(chatPanelSource, /const \[summaryOpen, setSummaryOpen\] = useState\(runIsLive\)/, "运行中展开、结束后收起总结");
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

  // B02：执行过程 / 回答详细程度 / 自动打开预览（设置项 + 立即生效 + 旧开关迁移）
  for (const id of ['activityDisplay: "compact"', 'answerDetail: "auto"', 'previewAutoOpen: "requested"']) {
    assert.ok(appearanceSource.includes(id), `外观默认值应包含 ${id}`);
  }
  assert.match(appearanceSource, /activityMarqueeEnabled: true/, "对话过程跑马灯默认开启");
  assert.match(appearanceSource, /root\.dataset\.activityMarquee = appearance\.activityMarqueeEnabled \? "true" : "false"/, "对话过程跑马灯设置应实时同步到页面样式");
  assert.match(settingsSource, /checked=\{appearance\.activityMarqueeEnabled\}/, "设置页应提供对话过程跑马灯开关");
  assert.match(stylesSource, /html\[data-activity-marquee="true"\] \.message-process-fold\.run-activity-fold\.is-live > summary::after/, "流光只绘制在运行中的外层过程栏");
  for (const name of ["ACTIVITY_DISPLAY_OPTIONS", "ANSWER_DETAIL_OPTIONS", "PREVIEW_AUTO_OPEN_OPTIONS"]) {
    assert.match(appearanceSource, new RegExp(`export const ${name} = Object.freeze\\(\\[`), `应导出 ${name} 供设置面板消费`);
  }
  assert.match(appearanceSource, /const SETTINGS_VERSION = 2;/, "设置应有版本号以便一次性迁移");
  assert.match(appearanceSource, /migrateLegacyAppearance\(\);\napplyAppearance\(\);/, "模块加载应先迁移再应用");
  assert.match(appearanceSource, /if \(Number\(raw\.settingsVersion \|\| 0\) >= SETTINGS_VERSION\) return false;/, "迁移必须幂等");
  // 设置面板：文案与计划一致
  for (const label of ["执行过程", "回答详细程度", "自动打开预览"]) {
    assert.ok(settingsSource.includes(`>${label}<`) || settingsSource.includes(`>${label}`), `设置面板应有「${label}」`);
  }
  assert.match(settingsSource, /setAppearance\(\{ activityDisplay: item\.id \}\)/, "执行过程设置应写回外观");
  assert.match(settingsSource, /setAppearance\(\{ answerDetail: item\.id \}\)/, "回答详细程度应写回外观");
  assert.match(settingsSource, /setAppearance\(\{ previewAutoOpen: item\.id \}\)/, "自动打开预览应写回外观");
  // 三处消费点
  assert.match(chatPanelSource, /useAppearance\(\)\.answerDetail/, "结果卡应消费回答详细程度");
  assert.match(chatPanelSource, /answerDetail === "brief" && fullConclusion/, "brief 应收窄结论");
  assert.match(appSource, /const previewAutoOpen = appearance\.previewAutoOpen;/, "App 应消费自动打开预览策略");
  assert.match(appSource, /if \(previewAutoOpen === "never"\) return;/, "never 应从不自动打开");
  assert.match(appSource, /if \(previewAutoOpen === "deliverable"\) \{[\s\S]{0,200}?acceptanceStatus/, "deliverable 应只认通过验收的交付文件");
  assert.match(appSource, /\}, \[currentWorkspace, open, previewAutoOpen, threadId\]\)/, "策略变化应立即生效（依赖数组）");
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
