#!/usr/bin/env node
/**
 * 阶段 2 回归：可视化统一与面板整合
 *
 * 覆盖 2026-10-09-013 阶段 2 的交付：
 *   2.1 统一可视化描述符（行为断言在 交通数据源与可视化描述符测试.mjs）
 *   2.2 统一可视面板（替代 6 个旧分析面板）
 *   2.4 顶栏 33 → 9 控件 + 画布浮动条
 *
 * 这里主要做源码级断言：约束"面板已下线且没有残留引用""顶栏不再膨胀"
 * "浮动条承接了测量/绘制"，防止后续改动把这些约束悄悄改回去。
 * 描述符与适配器的**行为**断言在另一个测试文件里（真调函数，不做字符串匹配）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const mapPanelSrc = read("client/src/components/MapPanel.jsx");
const visualPanelSrc = read("client/src/components/可视面板.jsx");
const stylesSrc = read("client/src/styles.css");
const apiSrc = read("client/src/api.js");
const indexSrc = read("server/index.mjs");
const verifySrc = read("scripts/验证脚本.mjs");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log("  ✓ " + name); }
  catch (e) { failed += 1; console.log("  ✗ " + name + "\n      " + (e.message || e)); }
}

console.log("\n▶ 2.2 六个旧面板已下线");

test("六个旧面板文件已删除", () => {
  for (const f of [
    "client/src/components/M2宏观分析.jsx",
    "client/src/components/M3公交分析.jsx",
    "client/src/components/柬埔寨OD面板.jsx",
    "client/src/components/M3BusPanel.jsx",
    "client/src/components/XinchangBusPanel.jsx",
    "client/src/components/CambodiaODPanel.jsx",
  ]) {
    assert.equal(exists(f), false, `${f} 应已删除（功能已并入可视面板）`);
  }
});

test("MapPanel 不再 import 旧面板", () => {
  assert.doesNotMatch(mapPanelSrc, /import\s+M2Analysis/, "不应 import M2 面板");
  assert.doesNotMatch(mapPanelSrc, /import\s+M3Analysis/, "不应 import M3 面板");
  assert.doesNotMatch(mapPanelSrc, /import\s+CambodiaODPanel/, "不应 import 柬埔寨面板");
  assert.match(mapPanelSrc, /import 可视面板 from "\.\/可视面板\.jsx"/, "应 import 可视面板");
});

test("旧面板状态与分支已清除（无死代码）", () => {
  for (const k of ["setM2Tab", "setM3Tab", "setCambodiaOpen", "setDemoOpen", "setAnalysisMenuOpen", "runDemoAnalysis"]) {
    assert.doesNotMatch(mapPanelSrc, new RegExp(`\\b${k}\\b`), `MapPanel 不应残留 ${k}`);
  }
  assert.doesNotMatch(mapPanelSrc, /m2-overlay-body|m3-overlay-body|cambodia-overlay/, "不应残留旧面板容器");
});

console.log("\n▶ 2.2 可视面板");

test("可视面板有自然语言入口与高级折叠", () => {
  assert.match(visualPanelSrc, /vp-ask-input/, "应有自然语言输入框");
  assert.match(visualPanelSrc, /交给 Agent/, "应能把意图交给 Agent");
  assert.match(visualPanelSrc, /vp-advanced-toggle/, "应有高级折叠开关");
  assert.match(visualPanelSrc, /高级（手动选数据集与参数）/, "高级入口应有可读文案");
});

test("可视面板首屏有功能发现提示（R6：面板下线的沟通）", () => {
  assert.match(visualPanelSrc, /分析面板已整合到这里/, "应有功能发现说明");
});

test("可视面板消费统一描述符（不再自己拼数据形状）", () => {
  assert.match(visualPanelSrc, /mapVisual\(/, "应调用 /api/map/visual");
  assert.match(visualPanelSrc, /descriptor/, "应基于描述符渲染");
  assert.match(visualPanelSrc, /styleHint/, "应使用 styleHint（纯数据）而非自建映射");
});

test("可视面板把六个旧 tab 收敛为数据集 + 类型", () => {
  // 原 M2 四 tab（traffic/od/exchange/structure）+ M3 四 tab（routes/stations/od/stats）+ 柬埔寨 + 演示
  for (const ds of ["m2-traffic-bandwidth", "m2-od-lines", "bundled-xinchang", "cambodia-od", "demo-analysis"]) {
    assert.ok(visualPanelSrc.includes(ds), `数据集选项应含 ${ds}`);
  }
  assert.match(visualPanelSrc, /type.*数据集|数据集.*类型/s, "应有数据集与类型两个维度");
});

test("图层卡片提供显隐/清除/撤销/保存（保存受模式约束）", () => {
  assert.match(visualPanelSrc, /保存为图层/, "应有保存入口");
  assert.match(visualPanelSrc, /清除/, "应有清除入口");
  assert.match(visualPanelSrc, /撤销/, "应有撤销入口（原示例数据菜单的能力）");
  assert.match(visualPanelSrc, /toggleVisible/, "应有显隐开关（对照底图时常用）");
  assert.match(visualPanelSrc, /setAnalysisVisibility/, "显隐应走 MapViewer 的临时层可见性");
  // 真约束：Chat 模式下按钮必须 disabled，且 save() 内部也要拦住（不能只靠文案）
  assert.match(visualPanelSrc, /disabled=\{!canSave \|\| conversationMode === "chat"\}/, "Chat 模式应禁用保存按钮");
  assert.match(visualPanelSrc, /if \(conversationMode === "chat"\)[\s\S]{0,120}保存正式图层请切换到 Work 模式/, "save() 内部也应拦截");
});

test("可视面板样式已定义", () => {
  for (const cls of [".vp-overlay", ".vp-ask-input", ".vp-card", ".vp-advanced"]) {
    assert.ok(stylesSrc.includes(cls), `应定义 ${cls}`);
  }
});

console.log("\n▶ 2.4 顶栏收敛");

test("顶栏为 9 个一级控件（不再逐个平铺）", () => {
  const start = mapPanelSrc.indexOf('<div className="mp-topbar">');
  assert.ok(start > 0, "应找到顶栏");
  const end = mapPanelSrc.indexOf('<div className="mp-body">', start);
  assert.ok(end > start, "应能找到顶栏结束位置");
  const bar = mapPanelSrc.slice(start, end);
  // 一级控件：模式切换组、任务中心、项目菜单、底图、区域菜单、图层、可视化、数据、视图、导出、返回
  for (const need of ["mp-mode-switch", "mp-menu-btn", "mp-basemap-select", "可视化", "图层", "导出", "mp-exit"]) {
    assert.ok(bar.includes(need), `顶栏应含 ${need}`);
  }
  // 被收敛的旧控件：只允许出现在下拉菜单容器内部。
  // 逐行扫描（维护菜单块深度），并剥掉 JSX 注释与 title/aria 属性——
  // 菜单按钮的 title 里提到"重建瓦片"是合理的，不算"平铺控件"。
  const lines = bar
    .split("\n")
    .map((l) => l.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\b(title|aria-label|placeholder)="[^"]*"/g, ""));
  let menuDepth = 0;
  const leaked = [];
  for (const line of lines) {
    if (/<div className="mp-(analysis|project|region)-menu/.test(line)) menuDepth = 1;
    else if (menuDepth > 0) {
      menuDepth += (line.match(/<div/g) || []).length - (line.match(/<\/div>/g) || []).length;
      if (menuDepth <= 0) { menuDepth = 0; continue; }
    }
    if (menuDepth > 0) continue;
    for (const gone of ["重建瓦片", "导入数据", "刷新地图", "分析工具", "示例数据"]) {
      if (line.includes(gone)) leaked.push(gone);
    }
  }
  assert.deepEqual(leaked, [], `这些控件应只出现在下拉菜单里：${leaked.join("、")}`);
  // 一级控件总数：数"菜单块之外"的 button/select/input（菜单项不算一级）。
  let depth = 0;
  let topLevel = 0;
  for (const line of lines) {
    if (/<div className="mp-(analysis|project|region)-menu/.test(line)) { depth = 1; continue; }
    if (depth > 0) {
      depth += (line.match(/<div/g) || []).length - (line.match(/<\/div>/g) || []).length;
      if (depth <= 0) depth = 0;
      continue;
    }
    topLevel += (line.match(/<button|<select|<input/g) || []).length;
  }
  assert.ok(topLevel <= 14, `一级控件应 ≤14 个（原为 33 个），实际 ${topLevel}`);
});

test("测量与绘制移到画布浮动条（C5）", () => {
  assert.match(mapPanelSrc, /mp-floatbar/, "应有画布浮动条");
  const start = mapPanelSrc.indexOf('className="mp-floatbar"');
  const end = mapPanelSrc.indexOf("</div>", start);
  const bar = mapPanelSrc.slice(start, end);
  for (const need of ["测量", "绘制", "OD", "可达性"]) {
    assert.ok(bar.includes(need), `浮动条应含 ${need}`);
  }
});

test("浮动条样式已定义", () => {
  for (const cls of [".mp-floatbar", ".mp-float-btn", ".mp-float-sep"]) {
    assert.ok(stylesSrc.includes(cls), `应定义 ${cls}`);
  }
});

test("沿用 .mp-topbar 类名（无障碍与窄屏测试的断言不受影响）", () => {
  const a11ySrc = read("scripts/无障碍与窄屏测试.mjs");
  assert.match(a11ySrc, /mp-topbar/, "既有测试断言的是 .mp-topbar");
  assert.match(mapPanelSrc, /className="mp-topbar"/, "顶栏应继续用该类名");
});

console.log("\n▶ 2.1 描述符接入点");

test("服务端提供 /api/map/visual 与数据源发现端点", () => {
  assert.match(indexSrc, /app\.get\("\/api\/map\/visual"/);
  assert.match(indexSrc, /app\.get\("\/api\/map\/visual\/sources"/);
});

test("前端 API 已封装（可视面板消费入口）", () => {
  assert.match(apiSrc, /export const mapVisual = /);
  assert.match(apiSrc, /export const mapVisualSources = /);
});

test("旧端点全部保留（契约 10 个，验证脚本不改）", () => {
  for (const ep of ["/api/map/traffic-bandwidth", "/api/map/od-lines", "/api/map/exchange-sankey", "/api/map/road-structure", "/api/map/demo-analysis", "/api/demo/cambodia-od", "/api/m3/bus-routes", "/api/m3/station-heatmap", "/api/m3/od-lines", "/api/m3/network-stats"]) {
    assert.ok(indexSrc.includes(ep), `旧端点 ${ep} 应保留`);
  }
  // 验证脚本仍以旧端点做契约（阶段 2 不改它）
  assert.match(verifySrc, /\/api\/map\/traffic-bandwidth/, "验证脚本应仍检查旧端点");
});

test("适配器注册后自动出现在可视面板的数据集下拉（不改面板代码）", () => {
  assert.match(visualPanelSrc, /mapVisualSources\(\)/, "面板应拉取数据源清单");
  assert.match(visualPanelSrc, /sources\s*\.filter/, "应把新数据源并入选项");
});

console.log("\n▶ 与阶段 1 的边界（分工不重复）");

test("可视面板不做图层管理（那是左栏的事）", () => {
  assert.doesNotMatch(visualPanelSrc, /listLayers|layerViews|onToggleLayer/, "可视面板不应承担图层树职责");
  assert.match(mapPanelSrc, /<LayerPanel/, "图层管理仍在左栏");
});

test("可视面板不做对话（那是对话栏的事）", () => {
  assert.doesNotMatch(visualPanelSrc, /useSSE|EventSource|subscribeEvents/, "可视面板不应自建事件流");
  assert.match(visualPanelSrc, /onAskAgent/, "自然语言应交给对话栏");
});

if (failed) {
  console.log(`\n阶段 2 可视化统一与面板整合：${failed} 项失败`);
  process.exit(1);
}
console.log("\n阶段 2 可视化统一与面板整合：通过");
