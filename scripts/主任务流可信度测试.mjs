#!/usr/bin/env node
/**
 * Agent 主任务流回归（P2）：
 * 1. 空白态按模式给可执行示例，Chat 只读模式不得引导改文件；
 * 2. 输入区显示可移除的目标上下文（工作区/当前文件），并说明“引用≠授权写入”；
 * 3. 模型选择收敛为 当前/最近/收藏/全部 高级入口，能力标签来自真实元数据；
 * 4. 运行态只讲当前关键步骤与下一步，待审批可一键定位，详细事件仍可展开；
 * 5. 结果卡统一展示目标达成/文件变更/验证/未完成项/下一步，原始错误在技术详情；
 * 6. 命令面板为可键盘操作的语义控件，关闭后焦点归还，选中项滚动进视区；
 * 7. 发送失败恢复草稿；运行结束不写成“已完成”。
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const 对话面板 = read("../client/src/components/ChatPanel.jsx");
const 命令面板 = read("../client/src/components/CommandPalette.jsx");
const 图标 = read("../client/src/components/Icon.jsx");
const 样式 = read("../client/src/styles.css");
const App = read("../client/src/App.jsx");
const 侧栏 = read("../client/src/components/SessionSidebar.jsx");
const 智能体广场 = read("../client/src/components/AgentMarket.jsx");
const 运行展示投影 = read("../client/src/运行展示投影.js");
const 智能体管理 = read("../server/智能体管理.mjs");
const 智能体运行时 = read("../server/agent.mjs");
const 服务端索引 = read("../server/index.mjs");
const 运行记录 = read("../server/runs.mjs");
const 事件注册表 = read("../server/事件注册表.mjs");
const 事件展示 = read("../client/src/事件展示.js");

// 0. 智能体广场入口语义（P1）：动作名与真实行为一致，且展示所需输入/预计产物/工作区
assert.match(智能体广场, /带入对话<\/button>/, "入口动作应叫「带入对话」，而不是“调用”");
assert.doesNotMatch(智能体广场, /> 调用<\/button>/, "不应再把预填草稿称为“调用/启动”");
assert.match(智能体广场, /只会把角色指令与依赖技能填成草稿，<b>发送后才会开始执行<\/b>/, "入口应说明发送后才执行");
assert.match(智能体广场, /className="agent-brief"/, "卡片应提供带入前的知情信息");
assert.match(智能体广场, /所需输入/, "应展示所需输入");
assert.match(智能体广场, /预计产物/, "应展示预计产物");
assert.match(智能体广场, /执行工作区/, "应展示执行工作区");
assert.match(智能体广场, /workspace = ""/, "应接受当前工作区");
assert.match(App, /workspace=\{currentWorkspace\}/, "App 应把当前工作区传给智能体广场");
assert.match(智能体广场, /不会自动执行，确认并发送后才开始/, "按钮提示应明确不会自动执行");
// 内置 Agent 的所需输入/预计产物在服务端与前端默认值里都要有（避免只在前端“装样子”）
assert.match(智能体管理, /inputs: \["主题\/事由"/, "服务端内置 Agent 应声明所需输入");
assert.match(智能体管理, /outputs: \["规范 \.docx 公文或报告"\]/, "服务端内置 Agent 应声明预计产物");
assert.match(智能体广场, /inputs: \["OD\/站点\/客流数据（表格或 GeoJSON）"/, "前端默认 Agent 应同步所需输入");
assert.match(样式, /\.agent-brief-grid/, "知情信息应有样式");

// 1. 空白态按模式给示例，且 Chat 的示例不含写文件动作
assert.match(对话面板, /const EMPTY_EXAMPLES = \{/, "应有按模式划分的空白态示例");
assert.match(对话面板, /chat: \{[\s\S]*?全程不会修改文件/, "Chat 空白态应说明只读");
assert.match(对话面板, /const emptyExample = EMPTY_EXAMPLES\[normalizeUiMode\(editMode\)\]/, "空白态应按当前模式取示例");
assert.match(对话面板, /className=\{`chat-empty mode-\$\{normalizeUiMode\(editMode\)\}`\}/, "空白态应带模式标记");
assert.match(对话面板, /chat-empty-example/, "示例应可点击填入输入框");
{
  const chatBlock = 对话面板.slice(对话面板.indexOf("chat: {"), 对话面板.indexOf("agent: {"));
  assert.doesNotMatch(chatBlock, /改成|填入|生成一份/, "Chat 只读模式的示例不得引导改文件/生成产物");
}

// 2. 目标上下文标签与作用域提示
assert.match(对话面板, /className="chat-target-bar"/, "输入区应有目标范围标签区");
assert.match(对话面板, /className="chat-target-chip file"/, "应显示当前文件标签");
assert.match(对话面板, /onClick=\{\(\) => setContextFileDismissed\(true\)\}/, "当前文件标签应可移除");
assert.match(对话面板, /不等于授权写入/, "应明确引用不等于授权写入");
assert.match(对话面板, /const selectedCurrentDoc = source\.currentDoc \?\? \(contextFileDismissed \? null : currentDoc\)/, "移除当前文件后本轮不再注入该文件");

// 3. 模型选择收敛与真实能力标签
assert.match(对话面板, /MODEL_RECENT_KEY/, "应有最近使用偏好");
assert.match(对话面板, /MODEL_FAVORITE_KEY/, "应有收藏偏好");
assert.match(对话面板, /const modelSections = useMemo/, "应有当前/最近/收藏分区");
assert.match(对话面板, /title: "当前使用"/, "应有当前使用分区");
assert.match(对话面板, /title: "最近使用"/, "应有最近使用分区");
assert.match(对话面板, /title: "收藏"/, "应有收藏分区");
assert.match(对话面板, /全部模型（\{models\.length\}）/, "应保留可展开的全部模型高级入口");
assert.match(对话面板, /function modelCapabilityLabel\(model\)/, "能力标签应走统一函数");
assert.match(对话面板, /typeof model\.vision === "boolean"/, "能力标签应基于真实 vision 元数据");
assert.match(对话面板, /Number\(model\.contextWindow\)/, "能力标签应读取真实上下文窗口");
assert.doesNotMatch(对话面板, /m\.vision \? "支持图片" : "文本"/, "不应再按布尔直接猜能力文案");
assert.match(图标, /star: \(/, "应提供收藏图标");

// 4. 运行态：下一步 + 待审批定位，详细事件可展开
assert.match(对话面板, /const nextStepText = useMemo/, "应派生当前下一步");
assert.match(对话面板, /等待你批准「/, "待审批应进入下一步提示");
assert.match(对话面板, /className="execution-flow-next"/, "运行态应显示下一步");
assert.match(对话面板, /const locateApproval = useCallback/, "待审批应可一键定位");
assert.match(对话面板, /aria-expanded=\{expanded\}/, "详细事件仍应可展开");
assert.match(对话面板, /className="efs-approval"/, "状态行应显示待批准入口");
assert.match(对话面板, /if \(followLatestRef\.current\) requestAnimationFrame\(\(\) => locateApproval\(\)\)/, "只在用户跟随时自动定位审批");

// 5. 结果卡
assert.match(对话面板, /className="run-result"/, "应有统一结果卡");
for (const label of ["目标达成", "文件变更", "验证"]) {
  assert.ok(对话面板.includes(`>${label}<`), `结果卡应包含「${label}」`);
}
assert.match(对话面板, /未完成：\{completion\.incomplete\.join/, "结果卡应列出未完成项");
assert.match(对话面板, /受阻：\{completion\.blockers\.join/, "结果卡应列出受阻项");
// A02-4（W1）：删除通用“下一步”，改成“仅有真实行动需求时才给行动提示”
assert.doesNotMatch(对话面板, /className="run-result-next"/, "通用“下一步”应按计划删除");
assert.match(对话面板, /className=\{`run-result-action \$\{actionNeeded\.kind\}`\}/, "仅有真实行动需求时才给行动提示");
assert.match(对话面板, /const actionNeeded = view\.lifecycle === "waiting_approval"/, "等待审批应进入行动提示");
assert.match(对话面板, /completion\?\.status === "partial"/, "部分完成应给出行动提示分支");
assert.match(对话面板, /view\.lifecycle === "failed"/, "失败应给出行动提示分支");
// W1：单一份文件集合 + 统一投影（不再同时渲染 m.products 与 m.artifacts 两套清单）
assert.match(对话面板, /import \{[^}]*projectLegacyRunSummary[^}]*\} from "\.\.\/运行展示投影\.js"/, "结果卡应消费统一展示投影");
assert.match(对话面板, /const fileChanges = useMemo\(\(\) => changes\.filter\(\(change\) => change\.role !== "internal"\)/, "文件改动应来自投影的单一份集合");
// 最终答案只在助手正文显示；结果卡只给状态与文件入口。
assert.match(对话面板, /const finalAnswer = String\(view\.answer\?\.text \|\| m\.authoritativeFinalText/, "结果卡应识别已显示的权威答案");
assert.match(对话面板, /const fallbackSummary = finalAnswer \? ""/, "有最终答案时不得再显示 completion 摘要");
assert.doesNotMatch(对话面板, /run-result-conclusion/, "结果卡不能再生成第二份折叠结论");
assert.match(对话面板, /交付产物 \{deliverables\.length\}/, "交付产物应单独成入口");
assert.doesNotMatch(对话面板, /m\.products\.map/, "结果卡不应再单独渲染产物标签（与变更重复）");
assert.match(对话面板, /className="run-result-tech"/, "原始错误应放在技术详情");
assert.match(对话面板, /errors: \(Array\.isArray\(m\.events\)/, "技术详情应含原始错误事件");
assert.match(对话面板, /className="run-result-fallback"/, "缺少模型终稿时，结果卡应提供有标识的运行摘要兜底");
assert.doesNotMatch(对话面板, /结论：\{readableProgressText\(completion\.summary\)\}/, "不得再把结论抹平为纯文本");
assert.match(运行展示投影, /data\.summary \|\| data\.completion\?\.summary/, "run_finished 缺 summary 时应回退到 completion.summary（统一投影层）");
assert.match(运行展示投影, /completed: "运行结束"/, "运行结束不应写成已完成（文案单一来源：运行展示投影）");
assert.match(对话面板, /const statusLabel = view\.lifecycleLabel/, "结果卡状态应来自统一投影");
assert.match(对话面板, /const showResultCard = fileChanges\.length > 0/, "结果卡由真实文件、审查依据或待处理事项决定");
// 纯只读问答不弹空结果卡（目标达成/文件变更/验证网格），但保留一行实测的用时与 token 记录。
assert.match(对话面板, /if \(!showResultCard && !hasTurnMetrics\) return null/, "纯只读问答不弹空结果卡，仅保留每轮用时与 token 指标");

// 7. 发送失败恢复草稿
assert.match(对话面板, /const restoreDraft = \(\) => \{/, "应有失败恢复草稿逻辑");
assert.match(对话面板, /updateInput\(\(value\) => \(value \? value : rawText\)\)/, "失败应把草稿放回输入框（并写回会话草稿存储）");

// 6. 命令面板：语义控件 + 焦点归还 + 滚动进视区
assert.match(命令面板, /role="combobox"/, "输入应为 combobox");
assert.match(命令面板, /aria-activedescendant=\{totalCount \? `cmd-option-\$\{selectedIdx\}` : undefined\}/, "应暴露当前选项");
assert.match(命令面板, /id="cmd-results-list" role="listbox"/, "结果区应为 listbox");
assert.match(命令面板, /role="option"/, "结果项应为 option");
assert.match(命令面板, /const restoreFocusRef = useRef\(null\)/, "应记录触发控件");
assert.match(命令面板, /requestAnimationFrame\(\(\) => target\.focus\(\)\)/, "关闭后应把焦点还回触发控件");
assert.match(命令面板, /scrollIntoView\?\.\(\{ block: "nearest" \}\)/, "选中项应滚动进视区");

// 8. 样式覆盖
for (const selector of [
  ".chat-empty-example",
  ".chat-target-bar",
  ".model-fav-btn",
  ".efs-approval",
  ".run-result",
  ".cmd-item.selected",
]) {
  assert.ok(样式.includes(`${selector} {`) || 样式.includes(`${selector} {\n`), `样式应包含 ${selector}`);
}
assert.match(样式, /@media \(max-width: 720px\), \(max-height: 560px\) \{/, "命令面板应有窄屏/矮屏适配");

// 9. 文件树被改文件短时高亮（由本轮 run_finished 驱动，历史回放不重播）
assert.match(App, /const \[changedFiles, setChangedFiles\] = useState/, "应记录本轮被改文件");
assert.match(App, /function fileBasename\(value\)/, "应用末段名匹配文件树");
assert.match(App, /changedFilesTimerRef\.current = window\.setTimeout\(\(\) => setChangedFiles\(new Set\(\)\), 2600\)/, "改文件高亮应短时自动清除");
assert.match(App, /changedFiles=\{changedFiles\}/, "应把被改文件传给侧栏文件树");
assert.match(侧栏, /changedFiles = NO_CHANGED_FILES/, "侧栏应接收被改文件");
assert.match(侧栏, /const isChanged = !f\.isDir && changedFiles\.has\(f\.name\)/, "文件行应按被改文件打标");
assert.match(侧栏, /\$\{isChanged \? "changed" : ""\}/, "文件行应带 changed 类");
assert.match(样式, /\.file-item\.changed \{ animation: oaw-file-flash/, "文件树高亮复用一次性 oaw-file-flash");

// 9. 模型切换（工程化）：运行中排队到本轮结束、每轮记录模型、界面显示切换分割线
assert.match(智能体运行时, /entry\.pendingModelSpec = nextSpec/, "运行中切换模型应排队到本轮结束，而不是用 busy 直接失败");
assert.match(智能体运行时, /async applyModelSpec\(entry, spec\)/, "模型应用逻辑应抽成可复用方法（排队生效与直接切换共用）");
assert.match(智能体运行时, /emitChannelSafe\(entry, "model_switched", \{[\s\S]{0,120}?reason: "queued"/, "排队切换应广播 model_switched(queued)");
assert.match(智能体运行时, /if \(entry\.pendingModelSpec\) \{[\s\S]{0,320}?applyModelSpec\(entry, pendingSpec\)/, "本轮结束后应真正应用排队的模型");
assert.match(智能体运行时, /function currentModelSpec\(entry\)/, "应能读出当前会话实际在用的模型标识");
assert.match(事件注册表, /\{ type: "model_switched", lifecycle: true, persist: true/, "model_switched 必须登记进事件注册表");
assert.match(事件展示, /case "model_switched": \{/, "前端事件展示应有 model_switched 文案");
assert.match(事件展示, /模型切换已排队：本轮结束后切到/, "排队文案应说明「本轮结束后生效」");
assert.match(服务端索引, /model: effectiveModel \|\| null/, "beginRun 应记录本轮实际生效的模型");
assert.match(运行记录, /model: model \? String\(model\) : null/, "Run 记录应保存本轮模型");
assert.match(运行展示投影, /model: String\(data\.model \|\| previous\?\.model \|\| ""\)/, "每轮摘要应携带本轮模型");
assert.match(对话面板, /case "model_switched": \{/, "前端应消费 model_switched 事件");
assert.match(对话面板, /if \(result\?\.pending\) \{[\s\S]{0,220}?本轮仍由 \$\{result\.current \|\| "当前模型"\} 执行；已排队/, "运行中切换应提示本轮仍用旧模型、稍后生效");
assert.match(对话面板, /const \[pendingModel, setPendingModel\] = useState\(""\)/, "应有待切换状态（提示保持可见）");
assert.match(对话面板, /className="model-switch-divider"/, "相邻两轮模型不同应显示切换分割线");
assert.match(对话面板, /const roundModel = m\?\.role === "assistant" \? String\(m\.model \|\| runSummary\?\.model \|\| ""\)/, "消息应按轮取真实模型，而不是当前选择");
assert.match(对话面板, /const modelDisplayName = useCallback/, "分割线应把模型标识映射成展示名");
assert.match(样式, /\.model-switch-divider \{/, "切换分割线应有样式");
assert.match(样式, /\.model-msg\.pending \{ color: var\(--warning\); \}/, "待切换提示应有独立样式");

// 10. 模型选择浮层：高度必须真正夹住（展开「全部模型」不再撑出视口）+ 供应商图标覆盖
assert.match(对话面板, /maxHeight: modelPopRect\.maxHeight/, "模型浮层必须把夹取后的高度应用到内联样式（只算不用会被撑出视口）");
assert.match(对话面板, /const spaceAbove = rect\.top - margin - 6;/, "浮层高度应按触发器上方可用空间计算");
assert.match(对话面板, /const spaceBelow = window\.innerHeight - rect\.bottom - margin - 6;/, "同时计算下方空间用于翻转");
assert.match(对话面板, /const flip = spaceAbove < 200 && spaceBelow > spaceAbove;/, "上方空间不足时应改为向下展开");
assert.match(样式, /\.model-control-pop \{\n  display: flex;\n  flex-direction: column;\n  overflow: hidden;\n\}/, "浮层应是内部滚动的列容器（头部/思考深度固定，中间列表滚动）");
assert.match(对话面板, /"command-code": \{ label: "Command Code", icon: "commandcode" \}/, "Command Code 供应商应有自己的品牌图标");
assert.match(对话面板, /"command-code-anthropic": \{ label: "Command Code", icon: "commandcode" \}/, "command-code-anthropic 走同一品牌图标");
assert.match(图标, /commandcode: \(/, "应提供 Command Code 的终端提示符图形");
assert.match(图标, /STROKED_PROVIDER_GLYPHS = new Set\(\["opencode", "commandcode"\]\)/, "描边渲染集合应包含 commandcode（避免实心块）");
assert.match(对话面板, /function providerInitials\(provider\)/, "未收录供应商应显示首字母缩写");
assert.match(对话面板, /function providerHue\(provider\)/, "首字母标记应有稳定配色（同一供应商颜色固定）");
assert.match(对话面板, /provider-initials/, "未收录供应商应带 provider-initials 类");
assert.match(样式, /\.model-provider-mark\.provider-initials \{/, "首字母标记应有样式");
assert.match(样式, /\.model-provider-mark\.provider-command-code, \.model-provider-mark\.provider-command-code-anthropic \{/, "Command Code 标记应有配色");

// 11. 地图能力与模式一致（阶段 3 · 防复发）
// 背景：X1 断链的根因是 capability_plan 标了地图能力、但 Chat 的工具白名单里没有任何
// map 工具——"说得到做不到"。这条断言用真实函数调用守住两者的对应关系。
const { planTaskCapabilities, toolPolicyForMode } = await import("../server/task.mjs");

const mapText = "在地图上显示义乌市的点位热力图";
for (const mode of ["chat", "office", "agent", "review"]) {
  const plan = planTaskCapabilities({ text: mapText, task: { mode } });
  const mapCap = (plan.capabilities || []).find((c) => c.id === "map");
  const tools = toolPolicyForMode(mode).tools.filter((t) => t.startsWith("map_"));

  if (!mapCap) {
    // 没有声明地图能力时，也不应该有地图工具（避免"有能力没声明"的反向不一致）
    assert.equal(tools.length, 0, `${mode} 未声明地图能力，不应授予地图工具：${tools.join(",")}`);
    continue;
  }

  // 核心一致性：声明了地图能力 → 必须真的有地图工具可用
  assert.ok(tools.length > 0, `${mode} 声明了地图能力（${mapCap.status}），但工具白名单里没有 map_* 工具`);

  if (mode === "chat") {
    assert.equal(plan.routing.map, "read_only", "Chat 模式地图应为只读（routing.map=read_only）");
    assert.ok(!tools.some((t) => ["map_edit", "map_import", "map_save_analysis"].includes(t)),
      "Chat 模式不得授予地图写工具");
    assert.ok(tools.includes("map_analyze"), "Chat 模式必须能生成临时可视化（map_analyze）");
  } else if (mode === "agent") {
    assert.equal(plan.routing.map, "read_write", "Work 模式地图应为可写（routing.map=read_write）");
    for (const t of ["map_edit", "map_import", "map_save_analysis"]) {
      assert.ok(tools.includes(t), `Work 模式应授予写工具 ${t}`);
    }
  } else {
    assert.equal(plan.routing.map, "not_needed", `${mode} 模式不应启用地图能力`);
    assert.equal(tools.length, 0, `${mode} 模式不应授予地图工具`);
  }
}

// 能力说明注入提示词：Chat 必须明确"保存图层需切 Work"
const chatPlan = planTaskCapabilities({ text: mapText, task: { mode: "chat" } });
const { taskSummary } = await import("../server/task.mjs");
const chatSummary = taskSummary({
  goal: mapText, mode: "chat", modeLabel: "Chat", capabilityPlan: chatPlan,
});
assert.match(chatSummary, /地图能力（只读）/, "Chat 提示词应说明地图只读能力");
assert.match(chatSummary, /切到 Work 模式/, "Chat 提示词应引导用户切 Work 而不是尝试绕过");
assert.doesNotMatch(chatSummary, /可保存为正式图层/, "Chat 提示词不得暗示可以保存图层");

const workPlan = planTaskCapabilities({ text: mapText, task: { mode: "agent" } });
const workSummary = taskSummary({
  goal: mapText, mode: "agent", modeLabel: "Work", capabilityPlan: workPlan,
});
assert.match(workSummary, /保存为正式图层/, "Work 提示词应说明可将结果保存为正式图层");
assert.doesNotMatch(workSummary, /需要用户切换到 Work 模式/, "Work 提示词不应再要求切换模式");

// 非地图轮次不注入地图说明（避免每轮多占上下文）
const plainSummary = taskSummary({ goal: "写一段总结", mode: "chat", modeLabel: "Chat" });
assert.doesNotMatch(plainSummary, /地图能力/, "无地图意图的轮次不应注入地图能力说明");

console.log("主任务流可信度回归：通过");