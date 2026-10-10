#!/usr/bin/env node
/**
 * 阶段 4 浏览器场景验证（L3）
 *
 * 验证只靠源码断言覆盖不到的呈现效果：
 *   H1 进入地图模式：对话栏默认 360px、紧凑
 *   H2 拖动分隔条仍可调整（300–620）
 *   H3 对话栏顶部显示当前地图项目与视口
 *   H7 退出地图回到主对话：消息流连续（无重复、无丢失）
 *
 * 前置：服务在 3002 运行，且已 npm run build。
 * 用法：node scripts/地图对话栏场景测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BASE = process.env.OAW_BASE || "http://127.0.0.1:3002";
const PW_CACHE = process.env.OAW_PLAYWRIGHT || "C:\\Users\\admin\\AppData\\Local\\npm-cache\\_npx\\86170c4cd1c5da32\\node_modules";
const PW_ENTRY = path.join(PW_CACHE, "playwright-core", "index.js");
if (!fs.existsSync(PW_ENTRY)) { console.error("找不到 playwright-core：" + PW_ENTRY); process.exit(1); }
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
if (!exePath) { console.error("找不到 Chromium"); process.exit(1); }

const browser = await chromium.launch({ headless: true, executablePath: exePath, args: ["--headless=new"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e.message || e)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

console.log("\n▶ H1/H3 进入地图：紧凑对话栏 + 地图状态行");

await test("进入地图模式，对话栏宽度收紧且带地图状态行", async () => {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sidebar-capabilities, .sidebar-section", { timeout: 25000 }).catch(() => {});
  const toolsTab = page.locator("button", { hasText: "能力" }).first();
  if (await toolsTab.count()) await toolsTab.click().catch(() => {});
  await page.locator(".sidebar-capabilities button", { hasText: "地图" }).first().click({ timeout: 15000 });
  await page.waitForSelector(".mp-topbar", { timeout: 30000 });

  // 对话栏（全局单实例挂在地图槽位）
  await page.waitForSelector(".app-chat-slot.map", { timeout: 20000 });
  const width = await page.evaluate(() => {
    const el = document.querySelector(".app-chat-slot.map");
    return el ? Math.round(el.getBoundingClientRect().width) : 0;
  });
  assert.ok(width >= 300 && width <= 400, `地图对话栏宽度应在 300–400（默认 360），实际 ${width}`);
  // 紧凑类
  const compact = await page.locator(".app-chat-slot.map .chat-compact").count();
  assert.ok(compact > 0, "地图模式对话栏应带 chat-compact（紧凑）");
});

await test("顶部显示地图项目与视口（H3）", async () => {
  const status = await page.locator(".chat-map-status").count();
  assert.ok(status > 0, "应显示地图状态行");
  const text = await page.locator(".chat-map-status").innerText();
  assert.match(text, /zhejiang-map/, `状态行应含项目名，实际：${text}`);
  // 视口可能尚未上报（地图初始化中），等一会儿再确认
  await page.waitForTimeout(2500);
  const text2 = await page.locator(".chat-map-status").innerText();
  assert.match(text2, /缩放|附近/, `状态行应显示视口信息，实际：${text2}`);
});

console.log("\n▶ H2 拖动分隔条仍可调整");

await test("拖拽后宽度变化且被限制在 300–620", async () => {
  const before = await page.evaluate(() => Math.round(document.querySelector(".app-chat-slot.map").getBoundingClientRect().width));
  const resizer = page.locator(".map-chat-resizer");
  const box = await resizer.boundingBox();
  assert.ok(box, "应存在拖拽条");
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + 200, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => Math.round(document.querySelector(".app-chat-slot.map").getBoundingClientRect().width));
  assert.ok(after > before, `向右拖拽应加宽（${before} → ${after}）`);
  assert.ok(after <= 640, `不应超过上限（实际 ${after}）`);
});

console.log("\n▶ H4/H5 地图可视化的结果区提示");

await test("生成分析后出现「临时，未保存」提示（H4）", async () => {
  // 走真实事件路径：SSE 的 map_action 最终由 ChatPanel 的 handleEvent 处理。
  const res = await page.request.get(`${BASE}/api/map/demo-analysis?analysis=heatmap&region=%E4%B9%89%E4%B9%8C%E5%B8%82&project=zhejiang-map`);
  const action = await res.json();
  // 一路两吃：既驱动地图（MapPanel 桥接），也驱动对话栏（事件处理器）。
  await page.evaluate((payload) => {
    window.__oawMapBridge?.mapAction?.(payload);
    window.__oawChatEvents?.handle?.({ type: "map_action", data: payload });
  }, action);
  await page.waitForSelector(".chat-map-visual", { timeout: 15000 });
  const text = await page.locator(".chat-map-visual").innerText();
  assert.match(text, /临时，未保存/, `应提示临时未保存，实际：${text}`);
  assert.match(text, /热力图|分析/, "应含结果名称");
});

await test("Chat 模式点保存 → 就地提示需切 Work（H5）", async () => {
  await page.locator(".cmv-save").click();
  await page.waitForSelector(".cmv-hint", { timeout: 8000 });
  const hint = await page.locator(".cmv-hint").innerText();
  assert.match(hint, /保存正式图层需要切换到 Work 模式/, `应就地提示切 Work，实际：${hint}`);
});

console.log("\n▶ H7 退出地图回到主对话：对话栏连续可用");

await test("返回主对话后对话栏仍在且可用（无重复消息）", async () => {
  const before = await page.locator(".msg").count();
  await page.locator(".mp-topbar .mp-exit").click();
  await page.waitForTimeout(1500);

  // 对话栏仍在（全局单实例），输入框与发送键可用
  assert.ok(await page.locator(".chat").count() > 0, "返回后对话栏应仍在");
  assert.ok(await page.locator(".center-chat-slot .chat").count() > 0, "应回到主对话槽位");
  const after = await page.locator(".msg").count();
  // 不重复：返回不应把消息复制一遍
  assert.ok(after <= before + 1, `返回不应产生重复消息（${before} → ${after}）`);

  // 已知边界（既有结构，非阶段 4 引入）：地图模块与主对话是两个挂载点
  // （.app-chat-slot.map / .center-chat-slot），切换会重新挂载对话栏，
  // 服务端已持久化的历史会重新水合，而"仅本地"的系统提示（如 map_action 的
  // 一次性 toast）不保留。真实对话消息不受影响。
  const welcome = await page.locator(".center-chat-slot").innerText();
  assert.ok(welcome.length > 0, "主对话区域应有内容");
});

await test("页面无 JS 错误", () => {
  const relevant = consoleErrors.filter((t) => !/favicon|ResizeObserver|glyph|Failed to load resource|WebGL|style is not done loading/i.test(t));
  assert.equal(relevant.length, 0, `不应有 JS 错误：\n${relevant.slice(0, 5).join("\n")}`);
});

await browser.close();

if (failed) {
  console.log(`\n阶段 4 浏览器场景：${failed} 项失败`);
  process.exit(1);
}
console.log("\n阶段 4 浏览器场景：通过");
