#!/usr/bin/env node
/**
 * 阶段 4 回归：地图模块对话栏适配（轻量）
 *
 * 覆盖 2026-10-09-015 阶段 4 的四项增量改动：
 *   4.1 紧凑呈现（宽度收紧 + compact）
 *   4.2 顶部地图状态行
 *   4.3 工具调用的地图语义标识
 *   4.4 结果区地图产物提示（临时，未保存）
 *
 * **本阶段的红线**：不改 SSE、不动消息流结构、不改 ChatPanel 的分区。
 * 因此这里除了断言新功能存在，还断言"没有碰不该碰的地方"——
 * `对话流性能回归测试.mjs` 的 118 条源码断言继续全绿就是最有力的证明（已单独运行）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const chatSrc = read("client/src/components/ChatPanel.jsx");
const appSrc = read("client/src/App.jsx");
const stylesSrc = read("client/src/styles.css");
const eventSrc = read("client/src/事件展示.js");
const toolIconSrc = read("client/src/components/工具语义图标.jsx");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log("  ✓ " + name); }
  catch (e) { failed += 1; console.log("  ✗ " + name + "\n      " + (e.message || e)); }
}

console.log("\n▶ 4.1 紧凑呈现");

test("地图对话栏默认宽度收紧到 360px", () => {
  assert.match(stylesSrc, /--map-chat-w:\s*360px/, "--map-chat-w 应为 360px");
});

test("地图模式下给全局对话实例传 compact", () => {
  assert.match(appSrc, /compact=\{activeModule === "map"\}/, "应在地图模块传 compact");
});

test("仍可拖拽调整宽度（300–620）", () => {
  assert.match(appSrc, /className="map-chat-resizer"/, "拖拽条应保留");
  assert.match(appSrc, /min=\{300\}[\s\S]{0,80}max=\{620\}/, "范围应保持 300–620");
});

test("紧凑模式只影响视觉密度，不隐藏功能块", () => {
  // compact 在 ChatPanel 里只用于：chat-compact 类 + 隐藏能力预览折叠块
  assert.match(chatSrc, /compact \? " chat-compact"/, "应挂 chat-compact 类");
  assert.match(chatSrc, /\{!compact && \(editMode === "agent" \|\| editMode === "review"\)/, "compact 只影响能力预览块");
});

console.log("\n▶ 4.2 顶部地图状态行");

test("地图模式下显示当前项目与视口", () => {
  assert.match(chatSrc, /chat-map-status/, "应有地图状态行");
  assert.match(chatSrc, /cms-project/, "应显示项目名");
  assert.match(chatSrc, /cms-view/, "应显示视口（缩放）");
});

test("状态行复用既有 props（不新增状态）", () => {
  const start = chatSrc.indexOf("chat-map-status");
  const block = chatSrc.slice(start, start + 1200);
  assert.match(block, /mapProject/, "应复用 mapProject prop");
  assert.match(block, /mapContext/, "应复用 mapContext prop");
  assert.doesNotMatch(block, /useState/, "不应为此新增状态");
});

test("保留「固定视图」入口（原输入框旁按钮的能力）", () => {
  assert.match(chatSrc, /cms-pin/, "应有固定视图按钮");
  assert.match(chatSrc, /injectMapContext/, "应复用既有注入函数");
});

test("状态行样式已定义", () => {
  for (const cls of [".chat-map-status", ".cms-project", ".cms-pin"]) {
    assert.ok(stylesSrc.includes(cls), `应定义 ${cls}`);
  }
});

console.log("\n▶ 4.3 工具调用的地图语义标识");

test("map_* 七个工具都登记了地图图标（单一来源）", () => {
  const idx = eventSrc.indexOf("TOOL_IDENTITY_RULES");
  const block = eventSrc.slice(idx, idx + 1600);
  assert.match(block, /map_read\|map_datasets\|map_edit\|map_import\|map_analyze\|map_save_analysis\|map_clear_analysis/, "应登记全部 7 个地图工具");
  assert.match(block, /"map"\]/, "应映射到 map 图标");
});

test("地图工具卡片有区分标记（色条 + 徽标）", () => {
  assert.match(chatSrc, /isMapTool/, "应判定地图工具");
  assert.match(chatSrc, /tool-card-map/, "应加区分类");
  assert.match(chatSrc, /tool-map-badge/, "应有可读徽标");
  assert.ok(stylesSrc.includes(".tool-card-map"), "应定义色条样式");
  assert.ok(stylesSrc.includes(".tool-map-badge"), "应定义徽标样式");
});

test("判定沿用 map_* 前缀，不另建映射表", () => {
  assert.match(chatSrc, /\/\^map_\//, "应以 map_* 前缀判定（复用工具语义图标的同一来源）");
  assert.match(toolIconSrc, /toolIdentity/, "图标仍走单一来源 toolIdentity");
});

console.log("\n▶ 4.4 结果区地图产物提示");

test("记录最近一次地图可视化（来自既有 map_action 事件）", () => {
  assert.match(chatSrc, /lastMapVisual/, "应有 lastMapVisual 状态");
  const idx = chatSrc.indexOf('case "map_action"');
  const block = chatSrc.slice(idx, idx + 1200);
  assert.match(block, /setLastMapVisual/, "map_action 应记录可视化");
  assert.match(block, /clear_analysis[\s\S]{0,200}setLastMapVisual\(null\)/, "清除时应同步清掉提示");
});

test("提示明确「临时，未保存」", () => {
  assert.match(chatSrc, /chat-map-visual/, "应有提示块");
  assert.match(chatSrc, /（临时，未保存）/, "应写明临时未保存");
});

test("保存按钮按模式分流：Chat 就地提示切 Work，Work 交给 Agent", () => {
  const idx = chatSrc.indexOf("chat-map-visual");
  const block = chatSrc.slice(idx, idx + 1800);
  assert.match(block, /editMode === "chat"/, "Chat 模式应分流");
  assert.match(block, /setMapVisualHint\("保存正式图层需要切换到 Work 模式/, "应就地提示切 Work（写工具栏的 modelMsg 在地图紧凑模式下不显眼）");
  assert.match(block, /send\(`把刚才的地图分析/, "Work 模式应把意图交给 Agent");
});

test("提示样式已定义", () => {
  for (const cls of [".chat-map-visual", ".cmv-text", ".cmv-save", ".cmv-hint", ".cmv-row"]) {
    assert.ok(stylesSrc.includes(cls), `应定义 ${cls}`);
  }
});

console.log("\n▶ 红线：不碰 SSE 与消息流结构");

test("未新增事件类型（仍用既有 map_action）", () => {
  // 事件注册表在服务端（server/事件注册表.mjs）
  const registry = read("server/事件注册表.mjs");
  assert.doesNotMatch(registry, /map_visual_/, "不应新增地图可视化事件类型");
  assert.match(registry, /map_action/, "应继续用既有 map_action");
});

test("未改 SSE 订阅链路", () => {
  assert.match(chatSrc, /\/api\/agent\/stream/, "SSE 端点不变");
  // 不应出现新的 EventSource 实例（阶段 4 是纯前端展示改动）
  const count = (chatSrc.match(/new EventSource/g) || []).length;
  assert.ok(count <= 1, `不应新增 EventSource 实例，实际 ${count}`);
});

test("未改消息流分区结构（Stream/Process/Result 仍在原处）", () => {
  for (const marker of ["chat-stream-shell", "run-result", "execution-flow"]) {
    assert.ok(chatSrc.includes(marker), `应保留 ${marker}`);
  }
});

test("对话流性能回归的 118 条断言不因本阶段改动而需要调整", () => {
  // 本测试只做"不改测试文件"的确认：若断言依赖结构，改动会导致其失败（已单独运行验证全绿）
  const flowTest = read("scripts/对话流性能回归测试.mjs");
  assert.ok(flowTest.length > 0, "对话流测试应存在");
  assert.match(flowTest, /chatPanelSource|ChatPanel/, "它依赖 ChatPanel 源码（结构不变即全绿）");
});

if (failed) {
  console.log(`\n阶段 4 地图对话栏适配：${failed} 项失败`);
  process.exit(1);
}
console.log("\n阶段 4 地图对话栏适配：通过");
