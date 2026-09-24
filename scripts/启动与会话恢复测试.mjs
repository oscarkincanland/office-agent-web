#!/usr/bin/env node
/**
 * 启动加载与会话恢复回归：
 * 1. files/sessions/projects/workspaces 失败必须可解释、可重试，且保留上一次可用数据，
 *    不得用空列表冒充“没有内容”；
 * 2. 会话恢复不能在会话列表成功返回之前定稿，否则异步列表晚到就再也恢复不了；
 * 3. Agent 恢复失败时历史按只读展示，并提供重试入口。
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const app = read("../client/src/App.jsx");
const 样式 = read("../client/src/styles.css");

// 1. 失败不伪装空结果，逐分区记录错误
assert.doesNotMatch(app, /catch\(\(\) => \[\]\)/, "启动加载失败不应伪装成空列表");
assert.match(app, /setScopeStatus\("files", "error"\)/, "文件加载失败应记录错误状态");
assert.match(app, /setScopeStatus\("sessions", "error"\)/, "会话加载失败应记录错误状态");
assert.match(app, /setScopeStatus\("projects", "error"\)/, "项目加载失败应记录错误状态");
assert.match(app, /setScopeStatus\("workspaces", "error"\)/, "工作区加载失败应记录错误状态");
assert.match(app, /const setScopeError = useCallback/, "应集中记录分区错误");

// 2. 保留上次可用数据 + 统一重试
assert.match(app, /const refreshWorkspaces = useCallback/, "工作区加载应可独立重试");
assert.match(app, /const retryStartupLoads = useCallback/, "应提供统一重试");
assert.match(app, /className="load-recovery"/, "应展示可解释的失败提示");
assert.match(app, /已保留上一次可用数据/, "提示应说明保留上次数据");
assert.match(app, /LOAD_SCOPE_LABELS/, "失败提示应说明具体分区");

// 3. 会话恢复时序
assert.match(app, /if \(loadStatus\.sessions !== "ready"\) return;/, "会话未成功返回前不得定稿恢复标记");
assert.match(app, /restoredSessionRef\.current = true;/, "恢复标记仍应存在，避免重复恢复");

// 4. Agent 恢复失败：只读 + 重试
assert.match(app, /resumeResult\?\.ok \? null : \{ sessionId: session\.id/, "恢复失败应记录为只读状态");
assert.match(app, /const retrySessionResume = useCallback/, "应提供恢复重试");
assert.match(app, /历史已加载为只读/, "应明确说明历史只读");
assert.match(样式, /\.session-resume-warning \{/, "只读提示应有样式");

console.log("启动与会话恢复回归：通过");
