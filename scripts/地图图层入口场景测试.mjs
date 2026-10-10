#!/usr/bin/env node
/**
 * 阶段 1 浏览器场景验证（L3）
 *
 * 用真实 Chromium 打开地图模块，验证源码断言覆盖不到的行为：
 *   B1 图层树分三组（共享数据集 / 我的图层）
 *   B2 共享图层带锁标识且提示"编辑需授权"
 *   B3 临时层分组随分析结果出现（调 MapViewer 的 showAnalysis，等价于收到 map_action）
 *   B4 切换工作区后"我的图层"跟随变化，共享数据集不变
 *
 * 前置：服务已在 http://127.0.0.1:3002 运行（npm start）。
 * 用法：node scripts/地图图层入口场景测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BASE = process.env.OAW_BASE || "http://127.0.0.1:3002";
// playwright-core 不在项目依赖里；用 npx 缓存中与已下载 chromium 匹配的那份。
const PW_CACHE = process.env.OAW_PLAYWRIGHT || "C:\\Users\\admin\\AppData\\Local\\npm-cache\\_npx\\86170c4cd1c5da32\\node_modules";
const PW_ENTRY = path.join(PW_CACHE, "playwright-core", "index.js");

if (!fs.existsSync(PW_ENTRY)) {
  console.error(`找不到 playwright-core：${PW_ENTRY}`);
  console.error("请设置 OAW_PLAYWRIGHT 指向含 playwright-core 的 node_modules 目录。");
  process.exit(1);
}

const { chromium } = (await import(pathToFileURL(PW_ENTRY).href)).default;

// playwright 默认找 chrome-headless-shell；本机只装了完整 chromium，
// 因此显式指定可执行文件（headless 用 --headless=new，功能与 headless shell 等价）。
function findChromium() {
  const base = "C:/Users/admin/AppData/Local/ms-playwright";
  const envExe = process.env.OAW_CHROMIUM;
  if (envExe && fs.existsSync(envExe)) return envExe;
  if (fs.existsSync(base)) {
    const dirs = fs.readdirSync(base).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse();
    for (const d of dirs) {
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
if (!exePath) {
  console.error("找不到 Chromium 可执行文件。请设置 OAW_CHROMIUM。");
  process.exit(1);
}

const browser = await chromium.launch({ headless: true, executablePath: exePath, args: ["--headless=new"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e.message || e)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

// 打开侧栏的"能力"页，点地图入口进入地图模块
async function openMap() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sidebar-capabilities, .sidebar-section", { timeout: 25000 }).catch(() => {});
  const toolsTab = page.locator("button", { hasText: "能力" }).first();
  if (await toolsTab.count()) await toolsTab.click().catch(() => {});
  const mapBtn = page.locator(".sidebar-capabilities button", { hasText: "地图" }).first();
  await mapBtn.click({ timeout: 15000 });
  await page.waitForSelector(".lp-list", { timeout: 30000 });
  await page.waitForFunction(() => {
    const el = document.querySelector(".lp-list");
    return el && el.textContent.includes("共享数据集");
  }, { timeout: 30000 });
}

console.log("\n▶ B1 图层树分三组");
await openMap();

await test("存在「共享数据集」分组且排在最前", async () => {
  const heads = await page.locator(".lp-group-head").allInnerTexts();
  const sharedIndex = heads.findIndex((t) => t.includes("共享数据集"));
  assert.equal(sharedIndex, 0, `共享数据集应为首个分组，实际：${heads.map((h) => h.replace(/\s+/g, " ").trim()).join(" / ")}`);
});

await test("存在用户图层组（我的图层沿用组名）", async () => {
  const txt = await page.locator(".lp-list").innerText();
  assert.match(txt, /行政区划|公路网|设施点|其他|测试demo/, "应保留用户图层组");
});

await test("共享分组层数 ≥ 9（内置 7 + 公用数据声明）", async () => {
  const count = await page.locator(".lp-group-shared .lp-group-count").first().innerText();
  assert.ok(Number(count) >= 9, `共享图层应 ≥9，实际 ${count}`);
});

console.log("\n▶ B2 共享图层只读标识");

await test("共享图层行带锁图标", async () => {
  const locks = await page.locator(".lp-group-shared .lp-row-lock").count();
  assert.ok(locks > 0, "共享图层应显示锁标识");
});

await test("锁的悬停说明为「编辑需授权」", async () => {
  const title = await page.locator(".lp-group-shared .lp-row-name").first().getAttribute("title");
  assert.match(String(title), /共享数据集，编辑需授权/, `悬停提示应说明授权要求，实际：${title}`);
});

await test("自有图层不带锁", async () => {
  const locks = await page.locator(".lp-group:not(.lp-group-shared):not(.lp-group-temp) .lp-row-lock").count();
  assert.equal(locks, 0, "自有图层不应显示锁标识");
});

console.log("\n▶ B3 临时层分组");

await test("生成分析结果后出现「临时层」分组，且标注未保存", async () => {
  // 用 Node 侧请求拿演示数据（浏览器上下文里的 fetch 由页面 CSP 与相对路径约束）
  const res = await page.request.get(`${BASE}/api/map/demo-analysis?analysis=heatmap&region=%E4%B9%89%E4%B9%8C%E5%B8%82&project=zhejiang-map`);
  assert.ok(res.ok(), "演示分析接口应返回结果");
  const action = await res.json();
  assert.ok(action?.geojson, "演示分析应返回 geojson");

  // 走真实事件路径：SSE 的 map_action 最终就是调这个处理器（阶段 0 已验证 SSE 投递）。
  await page.evaluate((payload) => {
    window.__oawMapBridge?.mapAction?.(payload);
  }, action);

  // 等临时层分组出现（handleMapAction → showAnalysis → style 状态更新 → syncTempLayers 重扫）
  await page.waitForSelector(".lp-group-temp", { timeout: 15000 });
  const txt = await page.locator(".lp-group-temp").innerText();
  assert.match(txt, /分析结果/, "临时层应包含分析结果条目");
  assert.match(txt, /未保存/, "临时层应标注未保存");

  // 只读性：临时层不应提供删除/重命名入口
  const ops = await page.locator(".lp-group-temp button").count();
  assert.equal(ops, 0, "临时层不应有操作按钮（只读展示）");
});

console.log("\n▶ B4 工作区切换时图层树跟随（共享不变）");

await test("服务端归属视图随工作区变化，共享部分保持一致", async () => {
  // 前端始终携带当前工作区路径；测试用服务端返回的真实工作区路径（/api/workspaces）
  const wsRes = await page.request.get(`${BASE}/api/workspaces`);
  assert.ok(wsRes.ok(), "工作区列表应可获取");
  const wsList = await wsRes.json();
  const workspaces = wsList.workspaces || [];
  const defaultWs = (workspaces.find((w) => w.name === "默认工作区") || workspaces[0])?.path || "";
  assert.ok(defaultWs, "应存在默认工作区");
  // 取一个非当前列表里的工作区做对比（若无则用不存在路径，等价于"其他工作区"）
  const otherWs = workspaces.find((w) => w.path !== defaultWs)?.path || "F:/__probe_other_workspace__";

  const fetchViews = async (ws) => {
    const r = await page.request.get(`${BASE}/api/map/project?name=zhejiang-map&workspace=${encodeURIComponent(ws)}`);
    assert.ok(r.ok(), `归属视图应可获取（ws=${ws}）`);
    return r.json();
  };
  const mine = await fetchViews(defaultWs);
  const other = await fetchViews(otherWs);
  assert.ok(mine?.layerViews?.length, "应返回归属视图");
  assert.ok(other?.layerViews?.length, "其他工作区也应返回归属视图");
  const sharedOf = (p) => (p.layerViews || []).filter((l) => l.origin === "shared").map((l) => l.id).sort();
  const ownOf = (p) => (p.layerViews || []).filter((l) => l.origin === "workspace").map((l) => l.id).sort();
  assert.deepEqual(sharedOf(other), sharedOf(mine), "共享数据集不随工作区变");
  assert.ok(ownOf(mine).length > 0, `默认工作区应有自有图层，实际 ${ownOf(mine).length}`);
  assert.ok(
    ownOf(mine).every((id) => !ownOf(other).includes(id)),
    `其他工作区不应看到本工作区图层（mine=${ownOf(mine).join(",")} / other=${ownOf(other).join(",")}）`,
  );
});

await test("页面上无 JS 错误", () => {
  const relevant = consoleErrors.filter((t) => !/favicon|ResizeObserver|glyph|Failed to load resource|WebGL/i.test(t));
  assert.equal(relevant.length, 0, `不应有 JS 错误：\n${relevant.slice(0, 5).join("\n")}`);
});

await browser.close();

if (failed) {
  console.log(`\n阶段 1 浏览器场景：${failed} 项失败`);
  process.exit(1);
}
console.log("\n阶段 1 浏览器场景：通过");
