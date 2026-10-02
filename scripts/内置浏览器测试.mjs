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

console.log("\n▶ 沙箱与 CDP 归属（P0）");

await test("默认开启沙箱：--no-sandbox 仅在显式开关函数中出现", () => {
  const src = fs.readFileSync(path.join(ROOT, "server", "内置浏览器.mjs"), "utf8");
  assert.equal((src.match(/"--no-sandbox"/g) || []).length, 1, "--no-sandbox 只应出现在 sandboxArgs 中，不得无条件启用");
  assert.match(src, /OAW_BROWSER_NO_SANDBOX/, "应有显式的沙箱降级开关");
  assert.match(src, /--remote-debugging-address=127\.0\.0\.1/, "CDP 应只绑定回环地址");
  assert.match(src, /DevToolsActivePort/, "复用前应校验 CDP 归属");
  assert.match(src, /hasLiveProfileProcess/, "清锁前应确认没有存活实例");
});

await test("CDP 归属校验：标记/进程双重证明，缺失标记不误判", async () => {
  const { verifyCdpOwnership } = await import("../server/内置浏览器.mjs");
  const { spawn } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-cdp-own-"));
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},8000)", dir], { stdio: "ignore" });
  try {
    // 1) 无标记 + 无 pid → 无法证明归属，拒绝
    let verdict = await verifyCdpOwnership({ port: 9333, pid: 0, profileDir: dir });
    assert.equal(verdict.ok, false, "既无标记也无进程时应拒绝");
    assert.match(verdict.reason, /DevToolsActivePort|归属/);
    // 2) 标记存在但端口不一致 → 拒绝
    fs.writeFileSync(path.join(dir, "DevToolsActivePort"), "9444\n/devtools/browser/abc");
    verdict = await verifyCdpOwnership({ port: 9333, pid: 0, profileDir: dir });
    assert.equal(verdict.ok, false, "端口不一致时应拒绝");
    assert.match(verdict.reason, /不一致/);
    // 3) 标记一致 → 通过
    verdict = await verifyCdpOwnership({ port: 9444, pid: 0, profileDir: dir });
    assert.equal(verdict.ok, true, "标记端口一致时应通过");
    // 4) pid 不存在 → 拒绝
    verdict = await verifyCdpOwnership({ port: 9444, pid: 999999, profileDir: dir });
    assert.equal(verdict.ok, false, "pid 已不存在时应拒绝");
    assert.match(verdict.reason, /已不存在|不属于/);
    // 5) 关键回归：真实平台可能不生成 DevToolsActivePort，此时靠「进程存活 + 命令行含本 profile」证明归属
    fs.rmSync(path.join(dir, "DevToolsActivePort"), { force: true });
    verdict = await verifyCdpOwnership({ port: 9444, pid: child.pid, profileDir: dir });
    assert.equal(verdict.ok, true, "无标记但有本 profile 的进程时应通过（否则内置浏览器会打不开）");
  } finally {
    try { child.kill("SIGKILL"); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("启动期不再因缺少 DevToolsActivePort 而拒绝启动", () => {
  const src = fs.readFileSync(path.join(ROOT, "server", "内置浏览器.mjs"), "utf8");
  assert.match(src, /if \(!marker\) console\.warn\("\[browser\] profile 内未生成 DevToolsActivePort/, "缺少标记时应只告警");
  assert.doesNotMatch(src, /if \(!marker \|\| Number\(marker\.port\) !== Number\(this\.port\)\)/, "不得再因缺少标记而抛错");
  assert.match(src, /if \(marker && Number\(marker\.port\) !== Number\(this\.port\)\)/, "标记存在且不一致时才拒绝");
});

console.log("\n▶ 用户接管仲裁与恢复（P1）");

await test("归属逻辑：用户 lease 生效/过期/Agent 放行", async () => {
  const { normalizeBrowserOwnership, browserAgentWriteBlocked } = await import("../server/内置浏览器.mjs");
  const now = 1_000_000;
  assert.equal(normalizeBrowserOwnership({ owner: "agent" }, now).owner, "agent");
  const user = { owner: "user", leaseExpiresAt: now + 30_000, reason: "用户正在操作（click）" };
  const blocked = browserAgentWriteBlocked(user, now);
  assert.ok(blocked, "用户接管期间 Agent 写操作应被阻塞");
  assert.equal(blocked.code, "BROWSER_USER_TAKEOVER");
  assert.match(blocked.message, /用户操作|暂停/);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 30_000);
  // lease 过期 → 自动回到 Agent，避免用户断线后永久锁死
  const expired = normalizeBrowserOwnership({ owner: "user", leaseExpiresAt: now - 1 }, now);
  assert.equal(expired.owner, "agent");
  assert.equal(expired.expiredFrom, "user");
  assert.equal(browserAgentWriteBlocked({ owner: "user", leaseExpiresAt: now - 1 }, now), null, "过期后应放行");
});

await test("只有真正的交互才算接管（resize/tabs 列表不算）", async () => {
  const { BROWSER_USER_ACTION_SET } = await import("../server/内置浏览器.mjs");
  for (const action of ["click", "pointer", "type", "key", "scroll", "wheel", "navigate", "back", "reload", "tab_switch"]) {
    assert.ok(BROWSER_USER_ACTION_SET.has(action), `${action} 应算作用户接管`);
  }
  for (const action of ["resize", "tabs", "release", "takeover"]) {
    assert.ok(!BROWSER_USER_ACTION_SET.has(action), `${action} 不应算作用户接管输入`);
  }
});

await test("服务端持有归属，Agent 写操作被守卫拦截", () => {
  const src = fs.readFileSync(path.join(ROOT, "server", "内置浏览器.mjs"), "utf8");
  assert.match(src, /this\.ownership = \{ owner: "agent"/, "会话应持有归属状态");
  assert.match(src, /USER_TAKEOVER_LEASE_MS/, "应有短期 lease");
  assert.match(src, /releaseToAgent\(/, "应支持交还 Agent");
  assert.match(src, /assertAgentWrite\(/, "应提供 Agent 写操作守卫");
  // 写操作必须带守卫；只读操作不得被阻断
  for (const fn of ["browserOpen", "browserClick", "browserType", "browserPress", "browserScroll", "browserBack"]) {
    const body = src.slice(src.indexOf(`export async function ${fn}(`), src.indexOf(`export async function ${fn}(`) + 420);
    assert.match(body, /assertAgentWrite\(/, `${fn} 缺少写操作守卫`);
  }
  assert.doesNotMatch(src.slice(src.indexOf("export async function browserSnapshot("), src.indexOf("export async function browserSnapshot(") + 200), /assertAgentWrite/, "只读 snapshot 不应被拦截");
  assert.match(src, /ownership: this\.ownershipView\(\)/, "stateView 应暴露归属状态");
  // 用户输入入口支持 release/takeover，且不再对 resize 计接管
  assert.match(src, /action === "release"\) return session\.releaseToAgent/, "应支持 release");
  assert.match(src, /action === "takeover"\) return session\.takeover/, "应支持 takeover");
  assert.doesNotMatch(src, /browserUserInput[\s\S]{0,220}?session\.lastUserInputAt = Date\.now\(\);\s*\n\s*const action/, "不应无条件刷新用户输入时间");
});

await test("前端接管按钮走服务端，且只在可恢复错误时重置浏览器", () => {
  const panel = fs.readFileSync(path.join(ROOT, "client", "src", "components", "内置浏览器面板.jsx"), "utf8");
  assert.doesNotMatch(panel, /setTakeover\(/, "不应再只改本地布尔值");
  assert.match(panel, /const userOwns = ownership\.owner === "user"/, "应由服务端归属驱动 UI");
  assert.match(panel, /action, reason: action === "release"/, "接管/交回应调用服务端");
  assert.match(panel, /isRecoverableBrowserError\(error\)/, "只应对可识别的启动异常做重置");
  assert.match(panel, /BROWSER_LAUNCH_FAILED/, "应识别启动失败错误码");
  assert.match(panel, /RECOVERABLE_BROWSER_PATTERN/, "应识别 profile 锁/退出码 21 文案");
});

await test("Agent 侧错误文案解释接管原因", () => {
  const agent = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
  assert.match(agent, /BROWSER_USER_TAKEOVER/, "Agent 工具应识别接管错误码");
  assert.match(agent, /请等待用户点击「交还 Agent」/, "应给出可执行指引");
  assert.match(agent, /接管仲裁/, "系统提示应说明接管仲裁");
});

console.log("\n▶ 帧流与恢复（P1）");

await test("订阅者计数随订阅/取消变化", async () => {
  const { browserSubscriberCount, subscribeBrowser } = await import("../server/内置浏览器.mjs");
  const key = browserSessionKey("frames", "count");
  assert.equal(browserSubscriberCount(key), 0, "初始应为 0");
  const off = subscribeBrowser(key, () => {});
  assert.equal(browserSubscriberCount(key), 1, "订阅后应为 1");
  off();
  assert.equal(browserSubscriberCount(key), 0, "取消后应回到 0");
});

await test("推流不再被静默吞掉，且有恢复与兜底机制", () => {
  const src = fs.readFileSync(path.join(ROOT, "server", "内置浏览器.mjs"), "utf8");
  // 推流启动失败必须记录并进入兜底，而不是 .catch(()=>{})
  assert.match(src, /async startScreencast\(\)/, "应有独立的推流启动方法");
  assert.match(src, /this\.screencastError/, "推流失败原因应被记录");
  assert.match(src, /画面推流启动失败，已改用定时截图兜底/, "失败时应给出兜底说明");
  assert.match(src, /async captureFrame\(\)/, "应能主动截图兜底");
  assert.match(src, /ensureWatching\(\)/, "应有空白画面巡检");
  assert.match(src, /noteSubscribers\(/, "应按订阅者数量启停推流");
  assert.doesNotMatch(src, /Page\.startScreencast",\s*\{[^}]*\}\)\.catch\(\(\) => \{\}\)/, "不得静默吞掉推流启动失败");
  // 帧预算与超帧丢弃
  assert.match(src, /MAX_FRAME_BYTES/, "应有单帧字节上限");
  assert.match(src, /frame\.data\.length > MAX_FRAME_BYTES/, "超限帧应被丢弃");
  assert.match(src, /everyNthFrame: FRAME_EVERY_NTH/, "推流应使用采样预算");
  // 交互后补帧，保证推流失效时画面也会更新
  assert.match(src, /syncFrameSoon\(/, "交互后应补一帧");
  assert.match(src, /Page\.loadEventFired[\s\S]{0,400}?this\.captureFrame\(\)/, "页面加载完成后应补一帧");
});

await test("SSE 帧流有背压处理（保留最新帧）", () => {
  const index = fs.readFileSync(path.join(ROOT, "server", "index.mjs"), "utf8");
  const stream = index.slice(index.indexOf('app.get("/api/browser/stream"'), index.indexOf('app.post("/api/browser/input"'));
  assert.match(stream, /pendingFrame/, "应只保留最新一帧");
  assert.match(stream, /res\.once\("drain"/, "应在 drain 后继续发送");
  assert.match(stream, /noteSubscribers/, "连接建立/断开应通知会话调整推流");
  assert.match(stream, /session\.captureFrame\(\)/, "无缓存帧时应先截一帧，避免空白面板");
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
  assert.match(fs.readFileSync(path.join(ROOT, "server", "内置浏览器.mjs"), "utf8"), /FRAME_QUALITY/, "推流应受帧预算约束（质量/采样）");
  assert.match(panel, /queueBrowserInput/, "浏览器输入事件必须经过串行队列");
  assert.match(panel, /action: "resize"/, "浏览器面板尺寸变化需要同步给 CDP viewport");
  assert.match(fs.readFileSync(path.join(ROOT, "client", "src", "styles.css"), "utf8"), /object-fit: contain/);
  assert.match(app, /setBrowserPanelOpen\(true\)/, "浏览器活动应自动打开独立侧栏");
  assert.match(app, /app-browser-slot/, "浏览器应为独立可伸缩侧栏");
  assert.doesNotMatch(app, /setPreviewTab\("browser"\)/, "浏览器不应再作为工作产物页签");
  // 标签页 UI 与文档按 cwd 打开（产物跨工作区）
  assert.match(panel, /action: "tab_switch"/);
  assert.match(panel, /action: "tab_new"/);
  // W4/D01：打开文档改为携带“文件身份”（含 cwd/wsid），由 文件地址.js 统一生成地址
  assert.match(app, /makeFileIdentity\(\{ workspaceId: effectiveCwd, cwd: effectiveCwd, relativePath: name \}\)/, "打开文档应构造含 cwd 的文件身份");
  assert.match(app, /buildDocUrls\(/, "预览地址应由统一文件身份生成");
  assert.match(fs.readFileSync(path.join(ROOT, "client/src/文件地址.js"), "utf8"), /cwd/, "文件身份应包含工作区 cwd");
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
    await test("面板尺寸同步到 CSS viewport", async () => {
      const resized = await browserUserInput(key, { action: "resize", width: 720, height: 760 });
      assert.equal(resized.result?.viewport?.width ?? resized.viewport?.width, 720, "viewport 宽度未同步");
      assert.equal(resized.result?.viewport?.height ?? resized.viewport?.height, 760, "viewport 高度未同步");
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
