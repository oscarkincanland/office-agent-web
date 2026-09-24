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
assert.match(任务中心, /<div className="task-center-wrap">\{trigger\}\{panel\}<\/div>/, "非整页应把触发器与面板同时挂在 wrap 内");
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

console.log("任务中心可信度回归：通过");
