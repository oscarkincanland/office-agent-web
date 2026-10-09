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
const markdownSource = fs.readFileSync(new URL("../client/src/components/MarkdownBody.jsx", import.meta.url), "utf8");
const artifactTypeSource = fs.readFileSync(new URL("../client/src/产物类型.js", import.meta.url), "utf8");
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
  assert.match(chatPanelSource, /const messageExecutionFlow = executionFlow \? \{ \.\.\.executionFlow, events: visibleExecutionEvents \} : null/, "SSE 工具事件应先与富交互工具卡去重");
  const runSummarySource = chatPanelSource.slice(chatPanelSource.indexOf("function RunSummary("), chatPanelSource.indexOf("// ========== 消息组件"));
  assert.match(runSummarySource, /const \[resultTab, setResultTab\] = useState\("products"\)/, "本轮结果区应是页签结构，默认落在“本轮产物”");
  assert.match(runSummarySource, /role="tablist" aria-label="本轮结果视图"/, "本轮产物/文件改动/依据应是无障碍页签");
  assert.match(runSummarySource, /className=\{`product-card\$\{item\.deliverable \? " deliverable" : ""\}\$\{item\.confirmed \? "" : " provisional"\}`\}/, "本轮产物应渲染为文件卡片（图标 + 名称 + 类型，未确认的带待确认标记）");
  assert.match(runSummarySource, /className="product-card-badge">交付/, "产物卡片应标记交付项");
  assert.match(runSummarySource, /className="product-card-open"[\s\S]{0,200}?>打开</, "产物卡片应有“打开”按钮");
  assert.match(runSummarySource, /productCards\.map/, "产物卡片应来自统一去重集合（不再截断成 6 项）");
  // 归属分层：write-ledger/已验收 = 已确认；"本轮写过 + 窗口内变更" = 待确认（可见但标注）；
  // 完全没有写入证据的差异才是"未归属线索"，不参与产物计数。
  assert.match(runSummarySource, /const attributedProducts = useMemo\(\(\) => products\.filter\(\(item\) => item\.attributed\)/, "产物应按归属过滤（未归属线索不计数）");
  assert.match(runSummarySource, /const confirmedProducts = useMemo\(\(\) => products\.filter\(\(item\) => item\.confirmed\)/, "已确认产物应按写入台账/验收结果单独归类");
  assert.match(runSummarySource, /本轮产物 <span className="result-tab-count">\{attributedProducts\.length\}/, "页签计数应包含归属到本轮的产物（含待确认）");
  assert.match(runSummarySource, /className="product-card-badge provisional"/, "未确认的产物卡片应带待确认标记");
  assert.match(runSummarySource, /本轮没有把该文件写进台账/, "待确认标记应解释原因（bash / officecli 不回报路径）");
  assert.match(runSummarySource, /className="product-leads"/, "未归属线索应单独成组（默认折叠）");
  assert.match(runSummarySource, /未归属线索 \{leadProducts\.length\} · 可能来自其他运行，需人工确认/, "线索组应明确说明可能来自其他运行");
  assert.match(chatPanelSource, /const confirmedOf = \(change\) => change\?\.source === "write-ledger" \|\| change\?\.role === "deliverable"/, "只有写入台账或已验收的文件才算已确认");
  assert.match(chatPanelSource, /const attributedOf = \(change\) => change\?\.attributed !== false && change\?\.source !== "unattributed"/, "归属判定应放行 run-window，只把 unattributed 当线索");
  assert.doesNotMatch(runSummarySource, /run-summary-details/, "文件清单不再另起一层折叠，统一进结果区页签");
  assert.match(runSummarySource, /run-result-fold \$\{embedded \? "embedded" : ""\}/, "嵌入式结果摘要应服从消息级统一折叠");
  assert.doesNotMatch(runSummarySource, /任务轮次 \{m\.runIndex/, "常规对话结果头不显示任务轮次计数");
  assert.match(runSummarySource, /useEffect\(\(\) => setSummaryOpen\(runIsLive\), \[runIsLive\]\)/, "任务结束时应自动收起结论与工具轨迹");
  assert.match(runSummarySource, /!embedded && \(trace\?\.tools\?\.length > 0/, "嵌入式结果卡不重复渲染工具明细");
  assert.match(runSummarySource, /run-trace-step-heading/, "独立结果摘要仍保留有序工具时间线");
  assert.match(runSummarySource, /const fallbackSummary = finalAnswer \? ""/, "已有最终答案时结果卡不再重复展示结论");
  assert.match(chatPanelSource, /foldedProcessBlocks/, "思考、工具及运行中的进度播报应并入消息级过程卡");
  assert.match(chatPanelSource, /message-process-scroll/, "过程内容应在一个有界滚动容器中回看");
  assert.match(chatPanelSource, /<ExecutionFlow \{\.\.\.messageExecutionFlow\} embedded \/>/, "去重后的 SSE 轨迹应嵌入消息过程卡");
  assert.match(chatPanelSource, /authoritativeFinalText/, "权威终稿应与过程播报分离，避免折叠误吞结论");
  assert.doesNotMatch(chatPanelSource, /latestTextBlock\?\.text/, "不能把最后一条过程播报猜成最终答复并留在折叠区外");
  // 过程折叠的归属：只收思考/工具/审批/子代理/系统提醒；模型发言（小节结论）留在正文原位。
  assert.match(chatPanelSource, /const isProcessBlock = \(block\) => Boolean\(block\) && processBlockTypes\.has\(block\.type\)/, "过程折叠只收思考与工具，模型发言留在正文");
  assert.match(chatPanelSource, /const renderSegments = \[\];/, "渲染片段应按模型真实输出顺序拼装");
  assert.match(chatPanelSource, /process_note/, "内部系统提醒应收进过程区，不作为独立用户消息显示");
  assert.match(chatPanelSource, /streaming=\{streaming && processOrder === lastThinkingBlockIndex\} embedded/, "只有最新思考块在流式阶段显示实时打字状态");
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
  assert.match(chatPanelSource, /className=\{`message-process-fold \$\{isTaskActivity \? "run-activity-fold" : ""\} \$\{isLiveFold \? "is-live" : ""\}`\}/, "思考、SSE 与工具归入同一个消息级折叠");
  // 输入栏待处理条：折叠过程收起时审批/提问仍可直接处理（计划 B01）
  assert.match(chatPanelSource, /function PendingActionBar/, "输入栏应提供待处理入口组件");
  assert.match(chatPanelSource, /const pendingAsk = useMemo/, "应计算待回答项");
  assert.match(chatPanelSource, /<PendingActionBar\s/, "待处理条应渲染进输入栏");
  // 执行行去重：同一工具的调用/完成只保留一行；tool_start 不再重复工具名
  assert.match(chatPanelSource, /const endedToolCalls = new Set/, "已结束的工具调用应从事件行中去重");
  assert.match(chatPanelSource, /className={`conn-status \$\{connectionNotice\.state\}`}/, "输入框旁应有连接状态点");
  assert.doesNotMatch(chatPanelSource, /pushSystem\("模型连接已恢复/, "恢复不应再作为系统消息堆在对话里");
  assert.match(chatPanelSource, /if \(event\.type === "agent_retry_end"\) return false;/, "过程区不应显示“已恢复”行");
  assert.match(chatPanelSource, /blockIndex !== hiddenFinalTextIndex/, "与权威终稿同源的文本块不应重复渲染一份");
  assert.doesNotMatch(chatPanelSource, /block\?\.type === "text" && isTaskActivity && streaming\) return false/, "流式正文不能在首字后继续隐藏");
  assert.match(chatPanelSource, /let lastTextBlockIndex = -1/, "应显式计算最后一段文本块");
  assert.match(chatPanelSource, /const dedupedEvents = visibleEvents.filter/, "事件行应使用去重后的序列");
  assert.match(chatPanelSource, /event.type === "tool_start" \? "" : event.type === "file_changed"/, "tool_start 不应重复显示工具名 detail");
  // 嵌入事件直接进入同一个过程滚动区，不再添加第二层折叠。
  assert.doesNotMatch(chatPanelSource, /execution-flow-embedded-toggle/, "过程内部不应再有第二个事件折叠按钮");
  // 消息流不再摊开 SSE 事件时间线（计划/执行逐条事件是诊断信息），阶段分组已整体移除。
  assert.doesNotMatch(chatPanelSource, /execution-phase-group/, "计划/执行事件时间线不应再渲染进消息流");
  assert.doesNotMatch(chatPanelSource, /execution-flow-phase/, "阶段不再用逐条插入的平面标题");
  assert.match(chatPanelSource, /消息流里不再摊开 SSE 事件时间线/, "应以注释说明事件时间线的归属（诊断视图在右栏事件页签）");
  assert.match(chatPanelSource, /if \(!notes\.length\) return null;/, "嵌入式执行流没有系统提示时不占位");
  assert.match(chatPanelSource, /const eventRows = dedupedEvents\.map\(\(event, index\) => eventRow\(event, index\)\)/, "事件行仍供独立执行流使用");
  // 每轮用时与 token：常驻指标行 + 可展开的逐轮明细，数据来自持久化的回合/用量事件。
  assert.match(chatPanelSource, /const turnMetrics = useMemo\(\(\) => \(Array\.isArray\(m\.events\) && m\.events\.length \? reduceTurnMetrics\(m\.events\) : \[\]\)/, "每轮指标应由回合事件归约得到");
  assert.match(chatPanelSource, /const metricsText = useMemo\(\(\) => turnMetricsText\(turnTotals, \{ durationMs: trace\?\.durationMs \}\)/, "指标行文案应由统一函数生成");
  assert.match(chatPanelSource, /className="run-metrics" aria-label="本轮用时与 token"/, "结果区应有常驻的用时与 token 指标行");
  assert.match(chatPanelSource, /className="run-turns-table" role="table" aria-label="每轮用时与 token"/, "每轮明细应是无障碍表格");
  assert.match(chatPanelSource, /<span role="columnheader">回合<\/span>[\s\S]{0,220}?<span role="columnheader">用时<\/span>[\s\S]{0,120}?输出[\s\S]{0,80}?输入/, "每轮明细应列出回合/用时/输出/输入");
  assert.match(chatPanelSource, /if \(!showResultCard && !hasTurnMetrics\) return null;/, "纯问答轮也保留一行实测指标，不弹空结果卡");
  assert.match(stylesSource, /\.run-metrics \{ display: flex;[\s\S]{0,120}?font-size: 10px;/, "指标行应是一行小字（无卡片框）");
  assert.match(stylesSource, /\.run-turns-row \{/, "每轮明细应有样式");
  assert.match(chatPanelSource, /className="run-metrics-text"/, "指标行应是单行文本");
  assert.doesNotMatch(stylesSource, /\.run-metrics \{[^}]*border: 1px solid/, "指标行不应再画卡片边框");
  assert.match(chatPanelSource, /const open = typeof override === "boolean" \? override : isLiveFold/, "运行中执行过程默认展开，但用户可随时收起（状态由用户决定）");
  assert.match(chatPanelSource, /isLiveFold \? "is-live" : ""/, "运行中过程区应维持有界滚动容器");
  assert.doesNotMatch(chatPanelSource, /setEmbeddedExpanded\(Boolean\(running\)\)/, "事件列表不应随运行自动展开（默认折叠）");
  const livePlainStyles = fs.readFileSync(new URL("../client/src/styles.css", import.meta.url), "utf8");
  assert.match(livePlainStyles, /\.message-process-fold\.is-live \.message-process-scroll \{ max-height: 300px; overflow: auto; overscroll-behavior: contain; \}/, "运行中的过程使用单个有界滚动容器");
  assert.match(livePlainStyles, /\.markdown-body p:has\(> br:only-child\) \{ display: none; \}/, "仅含换行的段落不应占位");
  assert.match(livePlainStyles, /\.result-tabbed/, "结果区页签应有独立视觉分节");
  assert.match(livePlainStyles, /\.product-card-main/, "产物卡片应有可点击主体样式");
  assert.match(livePlainStyles, /\.artifact-inline \{/, "结论内嵌产物应有行内文件条样式");
  assert.match(livePlainStyles, /\.center-chat-slot \.chat-body > \.msg,[\s\S]{0,220}?margin-left: auto;/, "无侧栏时消息列应居中（有侧栏时自适应）");
  // 本轮产物 tab + 面板宽度
  assert.match(chatPanelSource, /className="result-tabbed" aria-label="本轮结果"/, "结论之后应是本轮产物的页签区域");
  assert.match(chatPanelSource, /className="loading-inline"/, "等待首块应为无框行内指示");
  assert.doesNotMatch(chatPanelSource, /可写：工作区内/, "输入框不应再显示写入权限徽标");
  assert.doesNotMatch(chatPanelSource, /输入消息…  @ 引用文件/, "输入框占位提示不应再带长说明");
  assert.match(chatPanelSource, /: "输入消息…"\}/, "输入框占位提示应简化为“输入消息…”");
  assert.match(chatPanelSource, /交付产物 \{deliverables\.length\}/, "产物页签应显示交付产物数量");
  const widthStyles = fs.readFileSync(new URL("../client/src/styles.css", import.meta.url), "utf8");
  assert.match(widthStyles, /--chat-w: 460px/, "对话面板默认宽度应加宽");
  assert.match(widthStyles, /--chat-max: 720px/, "对话面板最大宽度应放宽");
  assert.match(widthStyles, /\.center-chat-slot \.msg\.user \.msg-main \{ width: auto; max-width: min\(78%, 540px\); \}/, "用户气泡应随内容收缩（不再固定宽度）");
  assert.match(widthStyles, /\.center-chat-slot \.msg\.user \.bubble \{ width: fit-content/, "用户气泡应为内容宽度");
  assert.match(widthStyles, /\.center-chat-slot \.msg-main \{ width: min\(100%, 880px\); max-width: 880px; \}/, "agent 回答区应加宽到 880px");
  assert.doesNotMatch(widthStyles, /\.msg-main > \.message-process-fold \{ order: -1; \}/, "执行过程顺序应由 DOM 表达，不再用 flex order 制造视觉/阅读顺序错位");
  assert.match(chatPanelSource, /\{renderMessageBlocks\(\)\}[\s\S]{0,300}?<div className="msg-blocks">|className="msg-blocks">[\s\S]{0,60}?\{renderMessageBlocks\(\)\}/, "过程折叠与正文按输出顺序同列渲染");
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
  // 唯一展示所有权：过程折叠（思考/工具/SSE）→ 小节结论 → 最终答复 → 结果与产物。
  assert.match(chatPanelSource, /const renderMessageBlocks = \(\) => renderSegments\.map/, "过程折叠应按片段渲染，并包含去重后的 SSE 轨迹");
  assert.match(chatPanelSource, /isLastProcess && messageExecutionFlow && <ExecutionFlow \{\.\.\.messageExecutionFlow\} embedded \/>/, "SSE 轨迹只挂在最后一个过程片段里");
  assert.doesNotMatch(chatPanelSource.slice(chatPanelSource.indexOf("const renderProcessBlock ="), chatPanelSource.indexOf("className=\"msg-blocks\"")), /RunSummary/, "结果卡不得再渲染进过程折叠容器");
  assert.match(chatPanelSource, /className="msg-blocks">[\s\S]{0,120}?\{renderMessageBlocks\(\)\}[\s\S]{0,900}?assistant-final-answer[\s\S]{0,700}?\{runSummary && \(\s*<RunSummary/, "DOM 顺序应为：过程与正文 → 答案 → 结果与产物");
  assert.match(chatPanelSource, /authoritativeFinalText[\s\S]{0,220}assistant-final-answer/, "简洁的权威最终答复仍保持可见");
  // 结论内嵌产物：正文里提到的产物名与本地文件链接渲染为可点击文件条（点击打开预览）。
  assert.match(chatPanelSource, /artifacts=\{answerArtifacts\}/, "结论正文应带本轮产物索引");
  assert.match(chatPanelSource, /const answerArtifacts = useMemo\(\(\) => artifactsFromView\(runCardView\)/, "结论与结果卡共用同一份产物投影");
  assert.match(markdownSource, /function linkifyArtifactMentions\(/, "正文里的产物名应转成 #artifact 链接");
  assert.match(markdownSource, /className="artifact-inline"/, "行内文件条应渲染为可点击按钮");
  assert.match(markdownSource, /const localTarget = normalizeLocalFileHref\(href\)/, "指向本地文件的 Markdown 链接应改走预览而不是新开标签页");
  assert.match(markdownSource, /artifactIndex = useMemo\(\(\) => \(onOpenFile && artifacts\?\.length/, "没有可打开的文件时不改写正文");
  assert.match(artifactTypeSource, /export function buildArtifactIndex/, "产物索引应集中在 产物类型.js");
  assert.match(artifactTypeSource, /export function formatFileSize/, "文件大小应有统一格式化（不编造未知大小）");
  // harness 提醒不得显示为可见消息（恢复 + 实时兜底各一道）
  assert.match(chatPanelSource, /不得在恢复会话后显示为“You”消息/, "历史恢复应过滤系统提醒");
  assert.match(chatPanelSource, /未被分组消费的提醒消息同样不渲染/, "渲染层应有提醒兜底过滤");
  assert.match(chatPanelSource, /const open = typeof override === "boolean" \? override : isLiveFold;/, "运行中的过程片段默认展开，其余收成一行摘要（用户点过按用户选择）");
  assert.match(chatPanelSource, /else if \(!isTaskLive && processWasLiveRef\.current\)[\s\S]{0,120}setProcessOpenMap\(\{\}\)/, "运行完成后统一收束过程卡");
  assert.match(chatPanelSource, /const \[summaryOpen, setSummaryOpen\] = useState\(runIsLive\)/, "运行中展开、结束后收起总结");
  assert.match(serverSource, /function officeResults\(response\)/, "Excel 解析应兼容 Office CLI 结果结构");
  assert.match(serverSource, /s\.path \|\| `\/\$\{s\.name\}`/, "Excel 工作表读取应使用 DOM 路径");
  assert.match(serverSource, /ext === "xlsx" \|\| ext === "xls"/, "Excel 预览应同时识别 xlsx/xls");
  assert.match(excelSource, /hooks 顺序错误/, "Excel 空结果不能破坏 React hooks 顺序");

  // 首字延迟链路（方案 §3.5）：分段计时，而不是一条“总耗时”。
  assert.match(chatPanelSource, /startLatencyProbe\(\{ model:/, "提交时即开始首字延迟计时");
  assert.match(chatPanelSource, /if \(streamReady && !connected\) \{/, "已建立的连接不应再等固定握手门槛");
  assert.match(chatPanelSource, /patchLatencyMeta\(\{ handshakeWaitMs/, "握手等待耗时应单独记录");
  assert.match(chatPanelSource, /markLatency\("firstEventAt"\)/, "首个 SSE 事件应打点");
  assert.match(chatPanelSource, /markLatency\("firstTextDeltaAt"\)/, "首个正文 token 应打点");
  assert.match(chatPanelSource, /if \(hasVisibleAnswer\) markFirstDomText\(\)/, "正文真正进 DOM 时应打点（不是 token 到达内存）");
  assert.match(chatPanelSource, /finalizeLatencyProbe\(\{ runId: data\?\.runId/, "run_finished 时结算一次样本");
  assert.match(serverSource, /markRunTiming\(run\.id, "admissionReadyAt"\)/, "服务端应记录 admission 完成时刻");
  assert.match(serverSource, /if \(type === "run_finished" && eventData\.runId\) \{\s*finishRunTiming\(eventData\.runId\);/, "所有终态路径统一结算样本");

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
  assert.match(chatPanelSource, /useAppearance\(\)\.answerDetail/, "消息气泡应消费回答详细程度");
  assert.match(chatPanelSource, /answerDetail === "brief" && !answerExpanded && lines\.length > 3/, "brief 应收窄唯一答案出口");
  assert.match(chatPanelSource, /className="answer-detail-toggle"/, "brief 收窄后应提供展开完整答案的入口");
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
