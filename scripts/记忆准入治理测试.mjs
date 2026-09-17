#!/usr/bin/env node
/**
 * 记忆准入治理测试（阶段五）：校验服务端确定性准入规则。
 * 用法: node scripts/记忆准入治理测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateMemoryCandidate, normalizeMemoryText } from "../server/记忆准入.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let failed = 0;
function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); failed = 1; }
function test(name, fn) {
  try { fn(); ok(name); } catch (e) { fail(`${name}: ${e.message}`); }
}

const WS = "F:\\测试工作区\\龙港数据";

console.log("\n▶ 拒绝规则");

test("敏感信息（Token/密码/手机号）被拒绝", () => {
  assert.equal(evaluateMemoryCandidate({ content: "接口 Key 是 sk-abcdef1234567890abcd", workspace: WS }).code, "SENSITIVE");
  assert.equal(evaluateMemoryCandidate({ content: "用户密码为 123456，请记住", workspace: WS }).code, "SENSITIVE");
  assert.equal(evaluateMemoryCandidate({ content: "联系手机号 13800138000", workspace: WS }).code, "SENSITIVE");
});

test("临时环境状态被拒绝", () => {
  assert.equal(evaluateMemoryCandidate({ content: "当前环境无外网，缓存为空", workspace: WS }).code, "TEMPORARY");
  assert.equal(evaluateMemoryCandidate({ content: "目录写入报 EPERM 权限不足", workspace: WS }).code, "TEMPORARY");
  assert.equal(evaluateMemoryCandidate({ content: "本次会话暂时只能使用本地模型", workspace: WS }).code, "TEMPORARY");
});

test("Harness 内部实现被拒绝", () => {
  assert.equal(evaluateMemoryCandidate({ content: "写产物需要复制到 .oaw/runs 目录下再发布", workspace: WS }).code, "HARNESS_INTERNAL");
  assert.equal(evaluateMemoryCandidate({ content: "SSE 重连时要检查游标是否过期", workspace: WS }).code, "HARNESS_INTERNAL");
});

test("指向其他工作区的路径被拒绝", () => {
  const verdict = evaluateMemoryCandidate({ content: "义乌项目的路网数据在 E:\\老电脑文件\\工作\\义乌十五五物流 下", workspace: WS });
  assert.equal(verdict.code, "OTHER_WORKSPACE");
});

test("过程描述与过短内容被拒绝", () => {
  assert.equal(evaluateMemoryCandidate({ content: "测试一下", workspace: WS }).code, "TOO_SHORT");
  assert.equal(evaluateMemoryCandidate({ content: "验证一下这个流程是否能跑通并记录结果", workspace: WS }).code, "NOT_DURABLE");
});

test("超长内容要求拆分为原子事实", () => {
  const long = "这是一条很长的内容。".repeat(40);
  assert.equal(evaluateMemoryCandidate({ content: long, workspace: WS }).code, "TOO_LONG");
});

test("与已有记忆重复或包含关系被拒绝", () => {
  const existing = [{ content: "龙港市公交分担率约 18%，数据口径为 2025 年居民出行调查", status: "approved" }];
  const exact = evaluateMemoryCandidate({ content: "龙港市公交分担率约18%,数据口径为2025年居民出行调查。", workspace: WS, existing });
  assert.equal(exact.code, "DUPLICATE");
  const contained = evaluateMemoryCandidate({ content: "龙港市公交分担率约 18%", workspace: WS, existing });
  assert.equal(contained.code, "DUPLICATE");
});

console.log("\n▶ 通过规则");

test("稳定、可复用、有归属的内容通过准入", () => {
  const verdict = evaluateMemoryCandidate({
    content: "龙港公交 OD 数据口径：早晚高峰按 7:00-9:00 与 17:00-19:00 统计",
    workspace: WS,
    existing: [],
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.code, "OK");
});

test("归一化忽略空白与标点差异", () => {
  assert.equal(normalizeMemoryText("A，B。 C"), normalizeMemoryText("A B C"));
});

console.log("\n▶ 服务端接入点");

const agentSource = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
test("memory_update 调用前执行准入检查", () => {
  assert.match(agentSource, /evaluateMemoryCandidate\(/);
  assert.match(agentSource, /memory_proposal_rejected/);
});

test("manual 策略禁用自动沉淀", () => {
  assert.match(agentSource, /memoryPolicy === "manual"/);
});

console.log(failed ? "\n记忆准入治理：失败" : "\n记忆准入治理：通过");
process.exit(failed ? 1 : 0);
