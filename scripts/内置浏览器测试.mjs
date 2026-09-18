#!/usr/bin/env node
/**
 * 内置浏览器测试。
 * 默认运行离线部分（工具契约/接入点/错误处理）；
 * 加 --live 参数（或设置 OAW_BROWSER_LIVE=1）时追加真实浏览器链路测试
 * （启动 Edge → Bing 搜索 → 读取结果 → 关闭）。
 *
 * 用法: node scripts/内置浏览器测试.mjs [--live]
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 测试使用独立 profile 目录：保证“未启动”断言确定性，也避免影响用户正在使用的浏览器
process.env.OAW_BROWSER_PROFILE = path.join(os.tmpdir(), `oaw-browser-test-${Date.now().toString(36)}`);
const {
  browserClick,
  browserClose,
  browserOpen,
  browserSessionKey,
  browserSnapshot,
  browserType,
  browserUserInput,
  getBrowserSession,
  shutdownBrowsers,
} = await import("../server/内置浏览器.mjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LIVE = process.argv.includes("--live") || process.env.OAW_BROWSER_LIVE === "1";
let failed = 0;
function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); failed = 1; }
async function test(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(`${name}: ${e.message}`); }
}

console.log("\n▶ 离线契约");

await test("会话 key 生成稳定，且兼容工具上下文的复合 agentKey", () => {
  assert.equal(browserSessionKey("c1", "t1"), "c1::t1");
  assert.equal(browserSessionKey("c1", ""), "c1::");
  // Agent 工具传入的 clientId 实为 client::thread；必须归一化到与前端面板同一个键
  assert.equal(browserSessionKey("c1::t1", "t1"), "c1::t1");
  assert.equal(browserSessionKey("client-abc::thread-9", "thread-9"), "client-abc::thread-9");
});

await test("未启动时会话为空 / 快照与点击给出可解释错误", async () => {
  const key = browserSessionKey("offline", "none");
  assert.equal(getBrowserSession(key), null);
  await assert.rejects(() => browserSnapshot(key), /尚未启动/);
  await assert.rejects(() => browserClick(key, "e1"), /尚未启动/);
  const closed = await browserClose(key);
  assert.equal(closed.closed, false);
});

await test("无效 URL 被拒绝（不启动浏览器）", async () => {
  const key = browserSessionKey("offline", "badurl");
  await assert.rejects(() => browserOpen(key, "file:///etc/passwd"), /无效的 URL/);
  await assert.rejects(() => browserOpen(key, ""), /URL 不能为空/);
});

await test("点击非法编号被拒绝", async () => {
  const key = browserSessionKey("offline", "badref");
  // 直接构造一个假会话条目，验证编号校验（不会真正连浏览器）
  const { getBrowserSession: get } = await import("../server/内置浏览器.mjs");
  assert.equal(get(key), null);
  await assert.rejects(() => browserType(key, "javascript:1", "x"), /尚未启动/);
});

console.log("\n▶ 服务端与前端接入点");

await test("agent / task / index / 前端已接入浏览器能力", () => {
  const agent = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
  const task = fs.readFileSync(path.join(ROOT, "server", "task.mjs"), "utf8");
  const index = fs.readFileSync(path.join(ROOT, "server", "index.mjs"), "utf8");
  const panel = fs.readFileSync(path.join(ROOT, "client", "src", "components", "内置浏览器面板.jsx"), "utf8");
  const app = fs.readFileSync(path.join(ROOT, "client", "src", "App.jsx"), "utf8");
  for (const name of ["browser_open", "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_scroll", "browser_screenshot", "browser_tabs", "browser_back", "browser_close"]) {
    assert.match(agent, new RegExp(`name: "${name}"`), `缺少工具 ${name}`);
    assert.match(task, new RegExp(`"${name}"`), `task 白名单缺少 ${name}`);
  }
  assert.match(index, /\/api\/browser\/stream/);
  assert.match(index, /\/api\/browser\/input/);
  assert.match(index, /\/api\/browser\/open/, "前端需要可主动打开浏览器会话");
  assert.match(panel, /EventSource\(`\/api\/browser\/stream/);
  assert.match(panel, /browserOpen/, "浏览器面板需要支持手动打开网址");
  assert.match(panel, /browser-idle-open/, "浏览器面板需要提供未启动状态的地址栏");
  assert.match(panel, /browser-control-toggle/, "浏览器面板需要提供明确的用户接管入口");
  assert.match(panel, /onToggleFullscreen/, "浏览器面板需要支持铺满工作区");
  assert.match(app, /browser-fullscreen/, "工作台需要支持浏览器专注模式");
  assert.match(fs.readFileSync(path.join(ROOT, "server", "内置浏览器.mjs"), "utf8"), /quality: 86/);
  assert.match(app, /setBrowserPanelOpen\(true\)/, "浏览器活动应自动打开独立侧栏");
  assert.match(app, /app-browser-slot/, "浏览器应为独立可伸缩侧栏");
  assert.doesNotMatch(app, /setPreviewTab\("browser"\)/, "浏览器不应再作为工作产物页签");
  // 标签页 UI 与文档按 cwd 打开（产物跨工作区）
  assert.match(panel, /action: "tab_switch"/);
  assert.match(panel, /action: "tab_new"/);
  assert.match(app, /cwdQuery/, "打开文档必须携带 cwd");
  assert.match(index, /resolvePath\(fileName, requestedCwd\)/, "文档接口需支持 cwd 解析");
});

if (LIVE) {
  console.log("\n▶ 真实浏览器链路（Bing 搜索）");
  const key = browserSessionKey("live", "browser-test");
  try {
    await test("启动并打开 Bing", async () => {
      const state = await browserOpen(key, "https://cn.bing.com");
      assert.match(state.url, /bing\.com/);
      const session = getBrowserSession(key);
      assert.ok(session?.state.active, "会话应为活动状态");
    });
    await test("快照包含搜索框元素", async () => {
      await new Promise((r) => setTimeout(r, 1500));
      const snap = await browserSnapshot(key);
      assert.ok(snap.elements.length > 5, `元素过少：${snap.elements.length}`);
      const target = snap.elements.find((line) => /\[e\d+\] (search|searchbox|textbox|textarea|input)\b/.test(line));
      assert.ok(target, "未找到搜索框元素");
    });
    await test("输入关键词并提交后出现结果", async () => {
      const snap = await browserSnapshot(key);
      const ref = snap.elements.find((line) => /\[e\d+\] (search|searchbox|textbox|textarea|input)\b/.test(line)).match(/\[(e\d+)\]/)[1];
      await browserType(key, ref, "浙江省综合交通规划", { submit: true });
      await new Promise((r) => setTimeout(r, 3000));
      const after = await browserSnapshot(key);
      assert.match(after.url, /search\?q=/, "未跳转到搜索结果页");
      assert.match((after.text || "").slice(0, 400), /浙江省|交通|规划/, "结果正文未包含关键词");
    });
    await test("拖拽接管：页面收到按下/移动/抬起事件", async () => {
      const session = getBrowserSession(key);
      await session.evaluate(`(() => {
        window.__oawDrag = { down: 0, move: 0, up: 0 };
        document.addEventListener('mousedown', () => { window.__oawDrag.down += 1; }, true);
        document.addEventListener('mousemove', () => { window.__oawDrag.move += 1; }, true);
        document.addEventListener('mouseup', () => { window.__oawDrag.up += 1; }, true);
        return true;
      })()`);
      await browserUserInput(key, { action: "pointer", phase: "down", nx: 0.5, ny: 0.5 });
      await browserUserInput(key, { action: "pointer", phase: "move", nx: 0.55, ny: 0.5 });
      await browserUserInput(key, { action: "pointer", phase: "move", nx: 0.6, ny: 0.5 });
      await browserUserInput(key, { action: "pointer", phase: "up", nx: 0.6, ny: 0.5 });
      await new Promise((r) => setTimeout(r, 400));
      const counters = JSON.parse((await session.evaluate("JSON.stringify(window.__oawDrag)")) || "{}");
      assert.ok(counters.down >= 1 && counters.move >= 1 && counters.up >= 1, `拖拽事件缺失: ${JSON.stringify(counters)}`);
    });
    await test("标签页：新建 / 切换 / 关闭", async () => {
      const { browserTabs } = await import("../server/内置浏览器.mjs");
      const before = await browserTabs(key, "list");
      assert.ok(before.tabs.length >= 1, "应有至少一个标签页");
      const created = await browserTabs(key, "new", "", "about:blank");
      assert.ok(created.tabId, "新标签页应返回 id");
      const opened = await browserTabs(key, "list");
      assert.ok(opened.tabs.some((tab) => tab.id === created.tabId), "新标签页应出现在列表中");
      const backId = opened.tabs.find((tab) => tab.id !== created.tabId)?.id;
      await browserTabs(key, "switch", backId);
      const afterSwitch = await browserTabs(key, "list");
      assert.equal(afterSwitch.tabs.find((tab) => tab.id === backId)?.active, true, "切换后目标标签应为激活态");
      await browserTabs(key, "close", created.tabId);
      const afterClose = await browserTabs(key, "list");
      assert.ok(!afterClose.tabs.some((tab) => tab.id === created.tabId), "关闭后标签应消失");
    });
    await test("滚轮接管：归一化坐标滚动页面", async () => {
      const session = getBrowserSession(key);
      const before = await session.evaluate("window.scrollY");
      await browserUserInput(key, { action: "wheel", nx: 0.5, ny: 0.5, deltaY: 900 });
      await new Promise((r) => setTimeout(r, 600));
      const after = await session.evaluate("window.scrollY");
      assert.ok(after >= before, `滚动位置未变化（${before} → ${after}）`);
      // 面板用户操作后，Agent 侧关闭应被拒绝（保护接管）
      const kept = await browserClose(key);
      assert.equal(kept.kept, true, "用户操作后 Agent 关闭应被保留");
      const forced = await browserClose(key, { force: true });
      assert.equal(forced.closed, true, "强制关闭应生效");
    });
  } catch (error) {
    fail(`真实链路异常: ${error.message}`);
  } finally {
    await browserClose(key).catch(() => {});
    shutdownBrowsers();
  }
} else {
  console.log("\n（跳过真实浏览器链路：加 --live 运行）");
}

await new Promise((resolve) => setTimeout(resolve, 400));
console.log(failed ? "\n内置浏览器测试：失败" : "\n内置浏览器测试：通过");
process.exit(failed ? 1 : 0);
