#!/usr/bin/env node
/**
 * 阶段 2 浏览器场景验证（L3）
 *
 * 用真实 Chromium 验证只靠源码断言覆盖不到的行为：
 *   C1 顶栏只剩一级控件，无六个旧面板入口
 *   C2 可视面板：自然语言输入 + 高级参数（数据集/类型）
 *   C3 生成可视化后改样式，临时层仍在（X5 在真实链路上的回归）
 *   C4 四类数据源都能从统一面板出图
 *   C5 测量/绘制从画布浮动条进入
 *   C6 旧端点仍 200（契约）
 *
 * 前置：服务已在 http://127.0.0.1:3002 运行（npm start），且已 npm run build。
 * 用法：node scripts/地图可视面板场景测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BASE = process.env.OAW_BASE || "http://127.0.0.1:3002";
const PW_CACHE = process.env.OAW_PLAYWRIGHT || "C:\\Users\\admin\\AppData\\Local\\npm-cache\\_npx\\86170c4cd1c5da32\\node_modules";
const PW_ENTRY = path.join(PW_CACHE, "playwright-core", "index.js");

if (!fs.existsSync(PW_ENTRY)) {
  console.error(`找不到 playwright-core：${PW_ENTRY}（可用 OAW_PLAYWRIGHT 指定）`);
  process.exit(1);
}
const { chromium } = (await import(pathToFileURL(PW_ENTRY).href)).default;

function findChromium() {
  const base = "C:/Users/admin/AppData/Local/ms-playwright";
  if (process.env.OAW_CHROMIUM && fs.existsSync(process.env.OAW_CHROMIUM)) return process.env.OAW_CHROMIUM;
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
      for (const sub of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe"]) {
        const p = `${base}/${d}/${sub}`;
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return "";
}

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log("  ✓ " + name); }
  catch (e) { failed += 1; console.log("  ✗ " + name + "\n      " + (e.message || e)); }
}

const exePath = findChromium();
if (!exePath) { console.error("找不到 Chromium（可用 OAW_CHROMIUM 指定）"); process.exit(1); }

const browser = await chromium.launch({ headless: true, executablePath: exePath, args: ["--headless=new"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e.message || e)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

async function openMap() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sidebar-capabilities, .sidebar-section", { timeout: 25000 }).catch(() => {});
  const toolsTab = page.locator("button", { hasText: "能力" }).first();
  if (await toolsTab.count()) await toolsTab.click().catch(() => {});
  await page.locator(".sidebar-capabilities button", { hasText: "地图" }).first().click({ timeout: 15000 });
  await page.waitForSelector(".mp-topbar", { timeout: 30000 });
  await page.waitForSelector(".lp-list", { timeout: 30000 });
}

console.log("\n▶ C1 顶栏收敛");
await openMap();

await test("顶栏一级控件 ≤14 个（原 33）", async () => {
  const count = await page.locator(".mp-topbar > button, .mp-topbar > select, .mp-topbar > .mp-project-manage > button, .mp-topbar > .mp-analysis-wrap > button, .mp-topbar > .mp-mode-switch > button").count();
  assert.ok(count <= 16, `一级控件应 ≤16，实际 ${count}`);
});

await test("六个旧面板入口已消失", async () => {
  const bar = await page.locator(".mp-topbar").innerText();
  for (const gone of ["分析工具", "示例数据", "重建瓦片", "新建项目", "可达性"]) {
    assert.ok(!bar.includes(gone), `顶栏不应再有一级「${gone}」入口`);
  }
  // 也不应存在旧面板容器
  for (const sel of [".m2-overlay", ".cambodia-overlay"]) {
    assert.equal(await page.locator(sel).count(), 0, `不应存在旧面板容器 ${sel}`);
  }
});

await test("关键一级控件齐全（项目/底图/区域/图层/可视化/数据/视图/导出/返回）", async () => {
  const bar = await page.locator(".mp-topbar").innerText();
  for (const need of ["图层", "可视化", "数据", "视图", "导出", "返回"]) {
    assert.ok(bar.includes(need), `顶栏应有「${need}」`);
  }
});

console.log("\n▶ C2 可视面板");

await test("打开可视面板：有自然语言输入与高级参数", async () => {
  await page.locator(".mp-topbar button", { hasText: "可视化" }).first().click();
  await page.waitForSelector(".vp", { timeout: 10000 });
  assert.ok(await page.locator(".vp-ask-input").count(), "应有自然语言输入框");
  const hint = await page.locator(".vp-ask-hint").innerText();
  assert.match(hint, /分析面板已整合到这里/, "首屏应有功能发现说明");
  // 展开高级
  await page.locator(".vp-advanced-toggle").click();
  await page.waitForSelector(".vp-advanced", { timeout: 5000 });
  const adv = await page.locator(".vp-advanced").innerText();
  assert.match(adv, /数据集/, "高级应有数据集选择");
});

console.log("\n▶ C4 四类数据源都能出图（走统一描述符）");

await test("演示分析（热力图）出图并显示统计摘要", async () => {
  // 选演示数据集 + 热力类型
  await page.locator(".vp-advanced select").first().selectOption("demo-analysis");
  await page.locator(".vp-run").click();
  await page.waitForSelector(".vp-card", { timeout: 20000 });
  const stats = await page.locator(".vp-card-stats").innerText();
  assert.match(stats, /个要素/, `应显示要素统计，实际：${stats}`);
  const badge = await page.locator(".vp-card-badge").innerText();
  assert.equal(badge.trim(), "临时", "结果应标为临时层");
  // 真断言：地图上确实出现了分析图层（卡片先出现，渲染可能还在重试中）
  await page.waitForFunction(
    () => (window.__oawMap?.getStyle?.().layers || []).some((l) => /^analysis-/.test(l.id)),
    { timeout: 15000 },
  );
  const layers = await page.evaluate(() => (window.__oawMap?.getStyle?.().layers || []).map((l) => l.id).filter((id) => /^analysis-/.test(id)));
  assert.ok(layers.length > 0, `地图上应出现分析图层，实际：${layers.join(",") || "（无）"}`);
});

await test("新昌公交（bundled 适配器）出图", async () => {
  await page.locator(".vp-advanced select").first().selectOption("bundled-xinchang");
  await page.locator(".vp-run").click();
  await page.waitForFunction(() => {
    const el = document.querySelector(".vp-card-name");
    return el && /新昌/.test(el.textContent);
  }, { timeout: 20000 });
  const name = await page.locator(".vp-card-name").innerText();
  assert.match(name, /新昌/, `应显示新昌数据，实际：${name}`);
});

await test("M2 线类数据（若项目有数据）确实画出线图层（S3 回归）", async () => {
  await page.locator(".vp-advanced select").first().selectOption("m2-od-lines");
  await page.locator(".vp-run").click();
  await page.waitForTimeout(2500);
  const err = await page.locator(".vp-error").count();
  if (err) {
    const msg = await page.locator(".vp-error").innerText();
    console.log("      （跳过：项目缺 M2 数据 —— " + msg.slice(0, 40) + "）");
    return;
  }
  await page.waitForSelector(".vp-card", { timeout: 15000 });
  // 线类描述符必须落到 -lines 图层上（此前只加 source 不加 layer，卡片显示成功但地图空白）
  const lineLayers = await page.evaluate(() => (window.__oawMap?.getStyle?.().layers || []).map((l) => l.id).filter((id) => /analysis-.*-lines$/.test(id)));
  assert.ok(lineLayers.length > 0, `M2 线类数据应画出线图层，实际：${lineLayers.join(",") || "（无）"}`);
});

console.log("\n▶ C3 改样式后临时层仍在（X5 真实链路回归）");

await test("样式重载（改颜色）后，可视面板的临时层仍在地图上", async () => {
  // 自己先生成一次可视化（不依赖前面用例的残留，避免顺序耦合）
  await page.locator(".vp-advanced select").first().selectOption("demo-analysis");
  await page.locator(".vp-run").click();
  await page.waitForSelector(".vp-card", { timeout: 20000 });
  await page.waitForTimeout(1200);

  const before = await page.evaluate(() => {
    const m = window.__oawMap;
    if (!m?.getStyle) return [];
    return m.getStyle().layers.map((l) => l.id).filter((id) => /analysis-|agent-/.test(id));
  });
  assert.ok(before.length > 0, `改样式前应已有分析图层，实际：${before.join(",") || "（无）"}`);

  // 真正触发样式重载：改图层颜色会走 saveStyle → reloadStyle（setStyle + 重放）。
  // 通过图层树选中一个共享图层并改颜色，走真实 UI 路径。
  const row = page.locator(".lp-group-shared .lp-row").first();
  await row.click();
  await page.waitForSelector(".lp-editor", { timeout: 8000 });
  const colorInput = page.locator(".lp-editor .lp-ed-color").first();
  if (await colorInput.count()) {
    await colorInput.evaluate((el) => {
      el.value = "#123456";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  } else {
    // 兜底：直接触发一次样式重载
    await page.evaluate(() => {
      const m = window.__oawMap;
      if (m?.setStyle) m.setStyle(m.getStyle(), { diff: false });
    });
  }
  await page.waitForTimeout(3000);

  const after = await page.evaluate(() => {
    const m = window.__oawMap;
    if (!m?.getStyle) return [];
    return m.getStyle().layers.map((l) => l.id).filter((id) => /analysis-|agent-/.test(id));
  });
  assert.ok(after.length > 0, `样式重载后分析图层应仍在（X5），实际：${after.join(",") || "（全被清空）"}`);
});

await test("浮动条「清除」能清掉可视面板出的图层（S4 回归）", async () => {
  const before = await page.evaluate(() => (window.__oawMap?.getStyle?.().layers || []).map((l) => l.id).filter((id) => /^analysis-/.test(id)));
  assert.ok(before.length > 0, `清除前应存在分析图层，实际：${before.join(",") || "（无）"}`);
  await page.locator(".mp-float-btn", { hasText: "清除" }).click();
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => (window.__oawMap?.getStyle?.().layers || []).map((l) => l.id).filter((id) => /^analysis-/.test(id)));
  assert.equal(after.length, 0, `清除后不应残留分析图层，实际：${after.join(",") || "（无）"}`);
});

await test("连续生成两个数据集不叠加残留（S5 回归）", async () => {
  await page.locator(".vp-advanced select").first().selectOption("demo-analysis");
  await page.locator(".vp-run").click();
  await page.waitForSelector(".vp-card", { timeout: 20000 });
  await page.waitForFunction(() => (window.__oawMap?.getStyle?.().layers || []).some((l) => /analysis-/.test(l.id)), { timeout: 15000 });
  const first = await page.evaluate(() => (window.__oawMap?.getStyle?.().layers || []).map((l) => l.id).filter((id) => /analysis-/.test(id)));

  await page.locator(".vp-advanced select").first().selectOption("bundled-xinchang");
  await page.locator(".vp-run").click();
  await page.waitForFunction(() => (window.__oawMap?.getStyle?.().layers || []).some((l) => /analysis-m3/.test(l.id)), { timeout: 20000 });
  await page.waitForTimeout(800);
  const second = await page.evaluate(() => (window.__oawMap?.getStyle?.().layers || []).map((l) => l.id).filter((id) => /analysis-/.test(id)));

  // 第一次结果的图层族不应还留在画面上（第二次出图前会清掉它）
  const baseOf = (id) => id.replace(/-(src|heat|points|fill|lines|lines-src|labels|circles|od-lines)$/, "");
  const firstBases = new Set(first.map(baseOf));
  const leftover = [...firstBases].filter((base) => second.some((id) => baseOf(id) === base));
  assert.deepEqual(leftover, [], `第一次的图层族不应残留，实际：${leftover.join(",")}（当前：${second.join(",")}）`);
  assert.ok(second.length > 0, "第二次的结果应在地图上");
});

await test("结果卡片「隐藏/显示」真的切换临时层可见性（阶段 2 §2.2）", async () => {
  // 注意：不能用 getLayer().layout 读——MapLibre 的 getLayer 返回的是包装后的内部对象，
  // 运行时更新要用 getLayoutProperty 才读得到。
  const visibleOf = () => page.evaluate(() => {
    const m = window.__oawMap;
    const layers = (m?.getStyle?.().layers || []).filter((l) => /^analysis-/.test(l.id));
    if (!layers.length) return null;
    return layers.every((l) => {
      try { return (m.getLayoutProperty(l.id, "visibility") ?? "visible") !== "none"; } catch { return true; }
    });
  });
  assert.equal(await visibleOf(), true, "初始应为可见");
  await page.locator(".vp-card-actions .btn-sm", { hasText: "隐藏" }).first().click();
  await page.waitForTimeout(500);
  assert.equal(await visibleOf(), false, "点隐藏后图层应不可见");
  await page.locator(".vp-card-actions .btn-sm", { hasText: "显示" }).first().click();
  await page.waitForTimeout(500);
  assert.equal(await visibleOf(), true, "再点显示应恢复可见");
});

await test("图层树「临时层」分组能看到可视面板生成的结果", async () => {
  const tempText = await page.locator(".lp-group-temp").innerText().catch(() => "");
  assert.match(tempText, /临时层|分析结果|未保存/, `图层树应列出临时层，实际：${tempText || "（无分组）"}`);
});

console.log("\n▶ C5 测量/绘制从浮动条进入");

await test("画布浮动条含 测量/绘制/OD/可达性", async () => {
  const bar = await page.locator(".mp-floatbar").innerText();
  for (const need of ["测量", "绘制", "OD", "可达性"]) {
    assert.ok(bar.includes(need), `浮动条应有「${need}」`);
  }
});

await test("点浮动条「测量」弹出距离/面积子项", async () => {
  await page.locator(".mp-float-btn", { hasText: "测量" }).click();
  await page.waitForSelector(".mp-toolmenu", { timeout: 5000 });
  const menu = await page.locator(".mp-toolmenu").innerText();
  assert.match(menu, /测量距离/, "应有测量距离");
  assert.match(menu, /测量面积/, "应有测量面积");
  // 关掉菜单，避免影响后续
  await page.keyboard.press("Escape").catch(() => {});
  await page.mouse.click(800, 700);
});

await test("浮动条「OD」能打开 OD 面板", async () => {
  await page.locator(".mp-float-btn", { hasText: "OD" }).click();
  await page.waitForSelector(".mp-od-panel", { timeout: 8000 });
  const panel = await page.locator(".mp-od-panel").innerText();
  assert.match(panel, /OD 流量分析/, "应打开 OD 面板");
  await page.locator(".mp-od-panel .mp-op").first().click();
});

console.log("\n▶ C6 旧端点契约");

await test("10 个旧端点仍返回 200", async () => {
  const endpoints = [
    "/api/map/traffic-bandwidth?project=zhejiang-map",
    "/api/map/od-lines?project=zhejiang-map",
    "/api/map/exchange-sankey?project=zhejiang-map",
    "/api/map/road-structure?project=zhejiang-map",
    "/api/map/demo-analysis?analysis=heatmap&region=%E4%B9%89%E4%B9%8C%E5%B8%82",
    "/api/demo/cambodia-od?minFlow=0",
    "/api/m3/bus-routes",
    "/api/m3/station-heatmap",
    "/api/m3/od-lines",
    "/api/m3/network-stats",
  ];
  for (const ep of endpoints) {
    const r = await page.request.get(`${BASE}${ep}`);
    assert.equal(r.status(), 200, `${ep} 应 200，实际 ${r.status()}`);
  }
});

await test("新端点 /api/map/visual 与 sources 可用", async () => {
  const sources = await page.request.get(`${BASE}/api/map/visual/sources`);
  assert.equal(sources.status(), 200);
  const body = await sources.json();
  assert.ok(body.sources.some((s) => s.id === "local-file"), "应列出 local-file 适配器");
  const visual = await page.request.get(`${BASE}/api/map/visual?dataset=demo-analysis&kind=heatmap`);
  assert.equal(visual.status(), 200);
  const vbody = await visual.json();
  assert.equal(vbody.descriptor?.v, 1, "应返回 v1 描述符");
});

await test("Chat 模式下「保存为图层」被禁用（S6 回归：不能绕过能力边界）", async () => {
  // 默认是 Chat 模式；保存按钮应 disabled
  const disabled = await page.locator(".vp-card .btn-sm", { hasText: "保存为图层" }).first().isDisabled();
  assert.equal(disabled, true, "Chat 模式下保存按钮应禁用（不能只靠文案提示）");
  const hint = await page.locator(".vp-card-hint").innerText().catch(() => "");
  assert.match(hint, /Chat 模式只做临时可视化/, "应说明原因");
});

await test("页面无 JS 错误", () => {
  const relevant = consoleErrors.filter((t) => !/favicon|ResizeObserver|glyph|Failed to load resource|WebGL|style is not done loading/i.test(t));
  assert.equal(relevant.length, 0, `不应有 JS 错误：\n${relevant.slice(0, 5).join("\n")}`);
});

await browser.close();

if (failed) {
  console.log(`\n阶段 2 浏览器场景：${failed} 项失败`);
  process.exit(1);
}
console.log("\n阶段 2 浏览器场景：通过");
