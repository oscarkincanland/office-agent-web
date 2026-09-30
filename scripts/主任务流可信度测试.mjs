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
assert.match(对话面板, /import \{ projectLegacyRunSummary \} from "\.\.\/运行展示投影\.js"/, "结果卡应消费统一展示投影");
assert.match(对话面板, /const fileChanges = useMemo\(\(\) => changes\.filter\(\(change\) => change\.role !== "internal"\)/, "文件改动应来自投影的单一份集合");
assert.match(对话面板, /交付产物 \{deliverables\.length\}/, "交付产物应单独成入口");
assert.doesNotMatch(对话面板, /m\.products\.map/, "结果卡不应再单独渲染产物标签（与变更重复）");
assert.match(对话面板, /className="run-result-tech"/, "原始错误应放在技术详情");
assert.match(对话面板, /errors: \(Array\.isArray\(m\.events\)/, "技术详情应含原始错误事件");
// 结论要「详细且保格式」：结果卡用 Markdown 渲染结论，而不是抹平成一行
assert.match(对话面板, /className="run-result-conclusion"/, "结果卡应有独立结论区");
assert.match(对话面板, /run-result-conclusion-label/, "结论区应有标签");
assert.match(对话面板, /<SafeMarkdown text=\{completion\.summary\}/, "结论必须按 Markdown 渲染，保留标题/列表");
assert.doesNotMatch(对话面板, /结论：\{readableProgressText\(completion\.summary\)\}/, "不得再把结论抹平为纯文本");
assert.match(对话面板, /data\.summary \|\| data\.completion\?\.summary/, "run_finished 缺 summary 时应回退到 completion.summary");
assert.match(运行展示投影, /completed: "运行结束"/, "运行结束不应写成已完成（文案单一来源：运行展示投影）");
assert.match(对话面板, /const statusLabel = view\.lifecycleLabel/, "结果卡状态应来自统一投影");
assert.match(对话面板, /const showResultCard = m\.runMode !== "chat"/, "纯只读问答不弹结果卡");

// 7. 发送失败恢复草稿
assert.match(对话面板, /const restoreDraft = \(\) => \{/, "应有失败恢复草稿逻辑");
assert.match(对话面板, /setInput\(\(value\) => \(value \? value : rawText\)\)/, "失败应把草稿放回输入框");

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

console.log("主任务流可信度回归：通过");
