#!/usr/bin/env node
/**
 * 成果可信度回归：
 * 1. 界面不得宣称“所有操作都可回滚”这类超出真实能力的说法；
 * 2. 是否可回滚必须由「未回滚 + 存在上一正式版本（rollbackTarget）」决定；
 * 3. 服务端继续拒绝没有历史版本的回滚请求。
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const 面板 = read("../client/src/components/工作产物面板.jsx");
const 成果管理 = read("../server/成果管理.mjs");

// 1. 不再承诺“所有操作都可回滚”
assert.doesNotMatch(面板, /所有操作都可回滚/, "不应宣称所有操作都可回滚");
assert.match(面板, /首个版本没有历史版本，需手动恢复/, "应说明首个版本不可回滚");

// 2. 回滚能力按真实条件生成
assert.match(面板, /const rollbackableCount = published\.filter\(\(item\) => item\.status !== "rolled_back" && item\.rollbackTarget\)\.length/, "可回滚数量应按真实条件统计");
assert.match(面板, /const canRollback = !rolledBack && !!item\.rollbackTarget/, "逐项回滚能力应按真实条件判定");
assert.match(面板, /首个版本 · 无历史版本可回滚/, "首个版本应显式说明不可回滚");
assert.match(面板, /当前没有可回滚的历史版本/, "无历史版本时不应暗示可回滚");

// 3. 服务端能力未被放宽
assert.match(成果管理, /if \(!current\.rollbackTarget\) return \{ ok: false, status: 409, error: "没有可回滚的历史版本" \}/, "服务端应继续拒绝没有历史版本的回滚");

console.log("成果可信度回归：通过");
