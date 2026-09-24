#!/usr/bin/env node
/**
 * 审批作用域回归：
 * 1. 权限规则持久化在应用全局配置，跨会话/项目/工作区生效；
 * 2. 提供真实的规则撤销能力（服务端 + 接口 + 前端封装 + 设置界面）；
 * 3. 审批界面如实披露作用域与撤销入口；
 * 4. 自动批准只能放行 ask，不能绕过显式 deny。
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const 策略 = read("../server/审批策略.mjs");
const 服务 = read("../server/index.mjs");
const 工作区 = read("../server/workspace.mjs");
const api = read("../client/src/api.js");
const 对话面板 = read("../client/src/components/ChatPanel.jsx");
const 设置面板 = read("../client/src/components/SettingsPanel.jsx");

// 1. 持久化范围 = 应用全局
assert.match(工作区, /export const PROJECT_DIR = path\.resolve\(__dirname, "\.\."\)/, "PROJECT_DIR 应为应用根目录");
assert.match(策略, /const PERMISSIONS_FILE = path\.join\(PROJECT_DIR, "\.oaw", "permissions\.json"\)/, "权限规则应落在应用全局配置");

// 2. 撤销能力
assert.match(策略, /export function removeUserRule\(/, "应能撤销用户规则");
assert.match(服务, /app\.delete\("\/api\/agent\/permissions\/rule"/, "应暴露撤销规则接口");
assert.match(api, /export const removePermissionRule/, "前端应有撤销封装");
assert.match(设置面板, /revokePermissionRule/, "设置界面应能调用撤销");

// 3. 作用域披露
assert.match(对话面板, /跨会话、跨项目、跨工作区生效/, "审批界面应披露规则作用域");
assert.match(对话面板, /可在「设置 → 审批与权限」随时撤销/, "审批界面应说明撤销入口");
assert.match(设置面板, /\["permission", "审批与权限"\]/, "设置应有审批与权限分类");
assert.match(设置面板, /已授权的“总是允许”规则/, "设置应列出已授权规则");

// 4. 自动批准不得绕过 deny
assert.match(策略, /return readPermissionConfig\(\)\.mode === "auto" && matched === "ask" \? "allow" : matched;/, "自动批准只能放行 ask，不能绕过 deny");

console.log("审批作用域回归：通过");
