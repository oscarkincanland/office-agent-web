#!/usr/bin/env node
/**
 * 任务中心可信度回归：
 * 1. 非整页触发器必须独立于面板渲染，初始关闭时也可见可点；
 * 2. 运行结束 / 任务达成 / 步骤进度 / 验收结果 必须分开表达，不混成一个“已完成”；
 * 3. 验收状态文案覆盖人工确认与验证中。
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const 任务中心 = read("../client/src/components/任务中心.jsx");
const 运行轨迹 = read("../client/src/运行轨迹.js");
const 样式 = read("../client/src/styles.css");

// 1. 触发器与面板的渲染边界
assert.match(任务中心, /const trigger = !fullPage && \(/, "非整页触发器应独立定义");
assert.match(任务中心, /const panel = \(fullPage \|\| open\) && \(/, "面板只在打开或整页时渲染");
// B04：触发按钮留在原位（定位与焦点归还），浮层通过 Portal 挂到 body
assert.match(任务中心, /<div className="task-center-wrap">\{trigger\}\{floatingPanel\}<\/div>/, "触发器应留在原位，面板不再依赖祖先容器");
assert.match(任务中心, /import \{ createPortal \} from "react-dom"/, "弹层应使用 Portal");
assert.match(任务中心, /className="task-center-float"/, "Portal 容器应是固定定位浮层");
assert.match(任务中心, /window\.innerWidth <= 560/, "窄屏应交回 CSS 贴边抽屉而不是内联定位");
assert.match(任务中心, /updateFloatingRect/, "浮层应随触发按钮位置与视口边缘更新");
assert.match(样式, /\.task-center-float \{ position: fixed/, "浮层容器应有固定定位样式");
assert.doesNotMatch(任务中心, /const panel = open && \(/, "面板不应把未打开的触发器一起隐藏");

// 2. 四种状态语义分开表达
assert.match(任务中心, /function lifecycleText\(run\)/, "应有独立的运行生命周期文案");
assert.match(任务中心, /function completionText\(run\)/, "应有独立的任务达成文案");
assert.match(任务中心, /function stepsText\(run\)/, "应有独立的步骤进度文案");
assert.match(任务中心, /function verificationText\(run\)/, "应有独立的验收结果文案");
assert.doesNotMatch(任务中心, /return "已完成";/, "运行结束不应直接写成已完成");
assert.match(任务中心, /completed: "运行结束"/, "运行生命周期应叫运行结束");
assert.match(任务中心, /success: "任务已达成"/, "任务达成应有独立文案");
assert.match(任务中心, /completion\.source === "inferred"/, "推断完成应如实标注");
assert.match(任务中心, /detail\.completion \? completionText\(detail\) : "模型未声明"/, "详情应说明任务达成来源");

// 3. 验收状态覆盖人工确认与验证中
assert.match(运行轨迹, /manual_review: "待人工确认"/, "验收状态应覆盖待人工确认");
assert.match(运行轨迹, /pending: "验证中"/, "验收状态应覆盖验证中");

// 4. 状态分区样式
assert.match(样式, /\.task-center-status \{/, "状态分区应有样式");
assert.match(样式, /\.task-center-completion-note/, "完成说明应有样式");

// 5. 结论要详细且保格式（任务中心不再只给一行纯文本、事件不再只有类型）
assert.match(任务中心, /import MarkdownBody from "\.\/MarkdownBody\.jsx"/, "任务中心应能渲染 Markdown 结论");
assert.match(任务中心, /task-center-completion-markdown[\s\S]{0,200}?<MarkdownBody>\{detail\.completion\.summary\}<\/MarkdownBody>/, "完成说明应按 Markdown 渲染");
assert.match(任务中心, /function eventDigest\(event\)/, "事件应带一行可读摘要");
assert.match(任务中心, /\(detail\.events \|\| \[\]\)\.slice\(-12\)/, "事件应展示更多（12 条）");
assert.match(样式, /\.task-center-completion-markdown \.markdown-body/, "Markdown 结论应有排版样式");
assert.match(样式, /\.task-center-event-digest/, "事件摘要应有样式");

console.log("任务中心可信度回归：通过");
