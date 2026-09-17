import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { PROJECT_DIR } from "./workspace.mjs";

/**
 * 内置浏览器：Agent 可直接操作的可视化浏览器。
 *
 * 实现方式（零外部依赖）：
 *   - 启动系统 Edge/Chrome（headless=new，独立 profile 保留登录态），开启 CDP；
 *   - Node 内置 WebSocket 直连页面级 CDP，执行导航 / 快照 / 点击 / 输入 / 滚动 / 截图；
 *   - Page.startScreencast 帧推送给前端面板，用户在“工作产物 → 浏览器”中实时观看并可接管。
 *
 * 观察方式与 Playwright MCP 一致：可访问性语义快照（编号元素），非像素识别。
 */

const PROFILE_DIR = process.env.OAW_BROWSER_PROFILE || path.join(PROJECT_DIR, ".oaw", "browser-profile");
const SHOT_DIR = path.join(PROJECT_DIR, ".oaw", "browser-shots");
const PORT_FILE = path.join(PROFILE_DIR, ".oaw-devtools-port");
const VIEWPORT = { width: 1280, height: 800 };
const NAV_TIMEOUT_MS = 25000;

const sessions = new Map(); // key -> BrowserSession
const subscribers = new Map(); // key -> Set<fn(type, data)>

/**
 * 会话键（client::thread）。
 * 注意：Agent 工具上下文里的 clientId 实际是复合 agentKey（client::thread），
 * 这里统一归一化为「原始 client + thread」，保证工具与前端面板订阅同一个键。
 */
export function browserSessionKey(clientId, threadId) {
  let client = String(clientId || "").trim();
  const thread = String(threadId || "").trim();
  if (thread && client.endsWith(`::${thread}`)) {
    client = client.slice(0, -(thread.length + 2));
  }
  return `${client}::${thread}`;
}

export function hasBrowserSession(key) {
  const session = sessions.get(key);
  return Boolean(session && session.state.active);
}

export function subscribeBrowser(key, handler) {
  if (!subscribers.has(key)) subscribers.set(key, new Set());
  subscribers.get(key).add(handler);
  cleanupSubscribers();
  return () => {
    const set = subscribers.get(key);
    if (!set) return;
    set.delete(handler);
    if (!set.size) subscribers.delete(key);
  };
}

function cleanupSubscribers() {
  for (const [key, set] of subscribers.entries()) {
    if (!set.size) subscribers.delete(key);
  }
}

export function broadcast(key, type, data) {
  const set = subscribers.get(key);
  if (!set) return;
  for (const handler of set) {
    try { handler(type, data); } catch {}
  }
}

function findBrowserExecutable() {
  const candidates = [
    process.env.OAW_BROWSER_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  return candidates.find((item) => { try { return fs.existsSync(item); } catch { return false; } }) || null;
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 页面内快照脚本：给可交互元素编号并输出语义清单 + 正文。 */
const SNAPSHOT_SCRIPT = `(() => {
  const SELECTOR = 'a,button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[role="searchbox"],[contenteditable="true"],[onclick]';
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };
  document.querySelectorAll('[data-oaw-ref]').forEach((el) => el.removeAttribute('data-oaw-ref'));
  const lines = [];
  let counter = 0;
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (counter >= 140) break;
    if (!isVisible(el)) continue;
    counter += 1;
    const ref = 'e' + counter;
    el.setAttribute('data-oaw-ref', ref);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? (el.type || 'input') : tag);
    const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
    const rawName = isField
      ? (el.value || el.getAttribute('aria-label') || el.placeholder || el.title || el.name || '')
      : (el.innerText || el.getAttribute('aria-label') || el.title || '');
    const name = String(rawName).replace(/\\s+/g, ' ').trim().slice(0, 90);
    let extra = '';
    if (tag === 'a' && el.href) extra = ' → ' + String(el.href).slice(0, 140);
    else if ((tag === 'input' || tag === 'textarea') && el.value) extra = ' 值:"' + String(el.value).slice(0, 40) + '"';
    lines.push('[' + ref + '] ' + role + ' "' + name + '"' + extra);
  }
  const bodyText = String(document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 5000);
  return { url: location.href, title: document.title, elements: lines, text: bodyText };
})()`;

class CdpConnection {
  constructor(wsUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP 连接超时")), 15000);
      this.ws.addEventListener("open", () => { clearTimeout(timer); resolve(); });
      this.ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP 连接失败")); });
    });
    this.ws.addEventListener("message", (event) => {
      let message = null;
      try { message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)); } catch { return; }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || "CDP 命令失败"));
        else pending.resolve(message.result || {});
        return;
      }
      if (message.method) {
        const handlers = this.listeners.get(message.method);
        if (!handlers) return;
        for (const handler of handlers) { try { handler(message.params || {}); } catch {} }
      }
    });
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const [id, pending] of this.pending.entries()) {
        pending.reject(new Error("浏览器连接已关闭"));
        this.pending.delete(id);
      }
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error("浏览器连接已关闭"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 命令超时：${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch {}
  }
}

function normalizeNavUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) throw new Error("URL 不能为空");
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(value)) return `https://${value}`;
  throw new Error(`无效的 URL：${value}（需 http/https 链接，或先调用 web_search 获取链接）`);
}

class BrowserSession {
  constructor(key) {
    this.key = key;
    this.child = null;
    this.cdp = null;
    this.port = 0;
    this.frame = null;
    this.lastUserInputAt = 0;
    this.activeTargetId = null;
    this.tabs = [];
    this.tabsTimer = null;
    this.state = { active: false, url: "about:blank", title: "", loading: false, viewport: { ...VIEWPORT }, startedAt: null, error: null };
  }

  /** 列出所有页面标签（id/标题/URL/是否激活）。 */
  async fetchTargets() {
    if (!this.port) return [];
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(2500) });
      const list = await response.json();
      return list.filter((item) => item.type === "page") || [];
    } catch {
      return [];
    }
  }

  /** 刷新标签列表并向面板广播（防抖合并）。 */
  async refreshTabs() {
    const targets = await this.fetchTargets();
    const tabs = targets.map((item) => ({
      id: item.id,
      title: String(item.title || "").trim() || String(item.url || "").replace(/^https?:\/\//, "").slice(0, 40) || "新标签页",
      url: item.url || "",
      active: item.id === this.activeTargetId,
    }));
    const fingerprint = JSON.stringify(tabs);
    if (fingerprint !== this.lastTabsFingerprint) {
      this.lastTabsFingerprint = fingerprint;
      this.tabs = tabs;
      broadcast(this.key, "tabs", { tabs, activeId: this.activeTargetId });
    }
    return tabs;
  }

  scheduleTabsRefresh(delay = 400) {
    if (this.tabsTimer) clearTimeout(this.tabsTimer);
    this.tabsTimer = setTimeout(() => {
      this.tabsTimer = null;
      this.refreshTabs().catch(() => {});
    }, delay);
  }

  /** 新建标签页并切换过去。 */
  async newTab(url = "about:blank") {
    await this.ensureStarted();
    // about:blank 是浏览器内置空白页，不走 http/https 校验
    const target = String(url || "").trim() === "about:blank" ? "about:blank" : normalizeNavUrl(url);
    const endpoint = `http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(target)}`;
    // 新版 Edge/Chrome 要求 PUT
    let created = null;
    try {
      const response = await fetch(endpoint, { method: "PUT", signal: AbortSignal.timeout(5000) });
      created = await response.json();
    } catch {
      try {
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
        created = await response.json();
      } catch {}
    }
    const targets = await this.fetchTargets();
    const targetInfo = (created?.id && targets.find((item) => item.id === created.id)) || targets[targets.length - 1] || null;
    if (!targetInfo) throw new Error("新建标签页失败");
    await this.switchToTarget(targetInfo.id);
    return { tabId: targetInfo.id, url: targetInfo.url };
  }

  /** 切换到指定标签页（重连 CDP 到该页面）。 */
  async switchToTarget(targetId) {
    const targets = await this.fetchTargets();
    const target = targets.find((item) => item.id === targetId);
    if (!target) throw new Error("标签页不存在或已关闭");
    try { await fetch(`http://127.0.0.1:${this.port}/json/activate/${targetId}`, { signal: AbortSignal.timeout(3000) }); } catch {}
    try { this.cdp?.close(); } catch {}
    this.cdp = null;
    this.frame = null;
    await this.connectToTarget(target);
    this.activeTargetId = targetId;
    this.state.url = target.url || this.state.url;
    this.state.title = target.title || this.state.title;
    this.state.loading = false;
    this.emitState();
    this.scheduleTabsRefresh(80);
    return this.stateView();
  }

  /** 关闭指定标签页；关掉当前页时自动切到剩余页。 */
  async closeTab(targetId) {
    const targets = await this.fetchTargets();
    if (targets.length <= 1) throw new Error("至少保留一个标签页");
    await fetch(`http://127.0.0.1:${this.port}/json/close/${targetId}`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
    await sleep(400);
    if (targetId === this.activeTargetId) {
      const remaining = await this.fetchTargets();
      const next = remaining[remaining.length - 1];
      if (next) await this.switchToTarget(next.id);
    } else {
      this.scheduleTabsRefresh(100);
    }
    return { closed: targetId };
  }

  async reload() {
    await this.ensureStarted();
    await this.cdp.send("Page.reload", {});
    await sleep(500);
    return { reloaded: true, url: this.state.url };
  }

  /**
   * 把面板坐标换算成页面 CSS 像素：
   * 面板发送归一化坐标（nx/ny ∈ [0,1]），这里按当前布局视口换算，
   * 不受帧缩放、设备像素比和面板宽度影响。
   */
  async resolvePoint(payload = {}) {
    await this.ensureStarted();
    let clientWidth = VIEWPORT.width;
    let clientHeight = VIEWPORT.height;
    try {
      const metrics = await this.cdp.send("Page.getLayoutMetrics");
      const viewport = metrics.cssLayoutViewport || {};
      if (viewport.clientWidth) clientWidth = Number(viewport.clientWidth);
      if (viewport.clientHeight) clientHeight = Number(viewport.clientHeight);
    } catch {}
    const nx = Number(payload.nx);
    const ny = Number(payload.ny);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      return {
        x: Math.round(Math.max(0, Math.min(1, nx)) * clientWidth),
        y: Math.round(Math.max(0, Math.min(1, ny)) * clientHeight),
      };
    }
    const x = Number(payload.x);
    const y = Number(payload.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("无效的点击坐标");
    return { x: Math.round(x), y: Math.round(y) };
  }

  stateView() {
    return {
      active: this.state.active,
      url: this.state.url,
      title: this.state.title,
      loading: this.state.loading,
      viewport: this.state.viewport,
      error: this.state.error,
      hasFrame: Boolean(this.frame),
    };
  }

  emitState() {
    broadcast(this.key, "state", this.stateView());
  }

  async start() {
    if (this.state.active) return;
    const executable = findBrowserExecutable();
    if (!executable) throw new Error("未找到 Edge/Chrome，无法启动内置浏览器（可设置环境变量 OAW_BROWSER_PATH 指定浏览器路径）");
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    // 1) 尝试复用上次启动且仍在运行的实例（服务重启后浏览器不中断）
    if (await this.tryReuse()) return;

    this.port = await allocatePort();
    const headless = process.env.OAW_BROWSER_HEADLESS !== "0";
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-sync",
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      "about:blank",
    ];
    if (headless) args.unshift("--headless=new");
    this.child = spawn(executable, args, { stdio: "ignore", windowsHide: true });
    this.child.on("exit", () => {
      if (this.state.active) {
        this.state.active = false;
        this.emitState();
      }
    });

    // 等待 CDP 端点就绪
    let target = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(300);
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(2000) });
        const list = await response.json();
        target = list.find((item) => item.type === "page") || null;
        if (target?.webSocketDebuggerUrl) break;
      } catch {}
      if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) break;
    }
    if (!target?.webSocketDebuggerUrl) {
      const exited = this.child?.exitCode;
      await this.close().catch(() => {});
      throw new Error(`浏览器启动失败：CDP 端点不可用${exited !== null && exited !== undefined ? `（进程退出码 ${exited}）` : ""}`);
    }
    try { fs.writeFileSync(PORT_FILE, String(this.port)); } catch {}
    await this.connectToTarget(target);
  }

  /** 复用上次记录的浏览器实例（同 profile）。 */
  async tryReuse() {
    try {
      if (!fs.existsSync(PORT_FILE)) return false;
      const port = Number(String(fs.readFileSync(PORT_FILE, "utf8")).trim());
      if (!Number.isFinite(port) || port <= 0) return false;
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
      const list = await response.json();
      const target = list.find((item) => item.type === "page") || null;
      if (!target?.webSocketDebuggerUrl) return false;
      this.port = port;
      this.child = null; // 复用实例不持有子进程
      await this.connectToTarget(target);
      return true;
    } catch {
      try { fs.rmSync(PORT_FILE, { force: true }); } catch {}
      return false;
    }
  }

  async connectToTarget(target) {
    this.cdp = new CdpConnection(target.webSocketDebuggerUrl);
    await this.cdp.ready;
    await this.cdp.send("Page.enable");
    await this.cdp.send("Runtime.enable");
    this.cdp.on("Page.screencastFrame", (params) => {
      const metadata = params?.metadata || {};
      this.frame = {
        data: params.data,
        at: Date.now(),
        width: Number(metadata.deviceWidth) || null,
        height: Number(metadata.deviceHeight) || null,
      };
      broadcast(this.key, "frame", { data: params.data, at: this.frame.at, width: this.frame.width, height: this.frame.height });
      this.cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    });
    this.cdp.on("Page.frameNavigated", (params) => {
      const frame = params?.frame;
      if (!frame || frame.parentId) return;
      this.state.url = frame.url || this.state.url;
      if (frame.name) this.state.title = frame.name;
      this.emitState();
    });
    this.cdp.on("Page.loadEventFired", () => {
      this.state.loading = false;
      this.refreshTitle().catch(() => {});
      this.emitState();
      this.scheduleTabsRefresh();
    });
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 2 }).catch(() => {});
    if (target.id) this.activeTargetId = target.id;
    this.state.active = true;
    this.state.startedAt = this.state.startedAt || new Date().toISOString();
    this.state.error = null;
    this.emitState();
    this.scheduleTabsRefresh(100);
  }

  async ensureStarted() {
    if (!this.state.active) await this.start();
  }

  async evaluate(expression) {
    await this.ensureStarted();
    const result = await this.cdp.send("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "页面脚本执行失败");
    return result.result?.value;
  }

  async refreshTitle() {
    const value = await this.evaluate("({ url: location.href, title: document.title })");
    if (value && typeof value === "object") {
      if (value.url) this.state.url = value.url;
      if (value.title) this.state.title = value.title;
    }
  }

  async waitForLoad(timeoutMs = NAV_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const ready = await this.evaluate("document.readyState");
        if (ready === "complete" || ready === "interactive") return true;
      } catch {}
      await sleep(400);
    }
    return false;
  }

  async navigate(rawUrl) {
    const url = normalizeNavUrl(rawUrl);
    await this.ensureStarted();
    this.state.loading = true;
    this.state.url = url;
    this.emitState();
    await this.cdp.send("Page.navigate", { url });
    await this.waitForLoad();
    this.state.loading = false;
    await this.refreshTitle().catch(() => {});
    this.emitState();
    this.scheduleTabsRefresh();
    return this.stateView();
  }

  async snapshot() {
    const value = await this.evaluate(SNAPSHOT_SCRIPT);
    if (value?.url) this.state.url = value.url;
    if (value?.title) this.state.title = value.title;
    this.emitState();
    return value || { url: this.state.url, title: this.state.title, elements: [], text: "" };
  }

  async click(ref) {
    const safe = String(ref || "").trim();
    if (!/^e\d+$/.test(safe)) throw new Error(`无效的元素编号：${ref}（请先 browser_snapshot 获取）`);
    const box = await this.evaluate(`(() => {
      const el = document.querySelector('[data-oaw-ref="${safe}"]');
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: String(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 80) };
    })()`);
    if (!box) throw new Error(`页面上没有编号 ${safe} 的元素，请重新 browser_snapshot`);
    const point = { x: Math.round(box.x), y: Math.round(box.y) };
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", clickCount: 0 });
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await sleep(600);
    await this.waitForLoad(8000).catch(() => {});
    await this.refreshTitle().catch(() => {});
    this.emitState();
    return { clicked: safe, text: box.text, url: this.state.url };
  }

  async type(ref, text, { submit = false } = {}) {
    const safe = String(ref || "").trim();
    if (!/^e\d+$/.test(safe)) throw new Error(`无效的元素编号：${ref}（请先 browser_snapshot 获取）`);
    const focused = await this.evaluate(`(() => {
      const el = document.querySelector('[data-oaw-ref="${safe}"]');
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      if (el.isContentEditable) { el.textContent = ''; } else { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
      return true;
    })()`);
    if (!focused) throw new Error(`页面上没有编号 ${safe} 的元素，请重新 browser_snapshot`);
    await this.cdp.send("Input.insertText", { text: String(text ?? "") });
    if (submit) {
      await this.press("Enter");
    } else {
      await sleep(200);
    }
    return { typed: safe, chars: String(text ?? "").length, submitted: Boolean(submit) };
  }

  async press(key) {
    const keyName = String(key || "Enter").trim() || "Enter";
    const map = {
      Enter: { code: "Enter", keyCode: 13, text: "\r" },
      Tab: { code: "Tab", keyCode: 9, text: "\t" },
      Escape: { code: "Escape", keyCode: 27, text: "" },
      Backspace: { code: "Backspace", keyCode: 8, text: "" },
      ArrowDown: { code: "ArrowDown", keyCode: 40, text: "" },
      ArrowUp: { code: "ArrowUp", keyCode: 38, text: "" },
      PageDown: { code: "PageDown", keyCode: 34, text: "" },
      PageUp: { code: "PageUp", keyCode: 33, text: "" },
    };
    const info = map[keyName] || map.Enter;
    await this.ensureStarted();
    const base = { key: keyName, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode };
    // text/unmodifiedText 是表单回车提交的关键：缺省时多数页面不会触发提交行为
    const down = info.text ? { ...base, text: info.text, unmodifiedText: info.text } : base;
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...down });
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(600);
    await this.waitForLoad(10000).catch(() => {});
    await this.refreshTitle().catch(() => {});
    this.emitState();
    return { pressed: keyName };
  }

  async scroll(direction = "down", amount = 600) {
    const delta = direction === "up" ? -Math.abs(amount) : Math.abs(amount);
    const value = await this.evaluate(`(() => { window.scrollBy(0, ${Number(delta) || 600}); return { y: window.scrollY, height: document.body.scrollHeight }; })()`);
    await sleep(400);
    return value || {};
  }

  async screenshot() {
    await this.ensureStarted();
    const result = await this.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    const data = result.data || "";
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const file = path.join(SHOT_DIR, `shot-${Date.now()}.jpg`);
    try { fs.writeFileSync(file, Buffer.from(data, "base64")); } catch {}
    this.frame = { data, at: Date.now() };
    broadcast(this.key, "frame", { data, at: this.frame.at });
    return { file, bytes: Buffer.byteLength(data, "base64"), url: this.state.url };
  }

  async back() {
    await this.ensureStarted();
    await this.evaluate("history.back()");
    await sleep(800);
    await this.waitForLoad(8000).catch(() => {});
    await this.refreshTitle().catch(() => {});
    this.emitState();
    return this.stateView();
  }

  async close() {
    const child = this.child;
    const port = this.port;
    this.state.active = false;
    this.frame = null;
    this.emitState();
    broadcast(this.key, "closed", {});
    try { this.cdp?.close(); } catch {}
    this.cdp = null;
    this.child = null;
    try { fs.rmSync(PORT_FILE, { force: true }); } catch {}
    if (port) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
        const list = await response.json();
        for (const target of list.filter((item) => item.type === "page")) {
          fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
        }
      } catch {}
    }
    if (child?.pid) {
      await new Promise((resolve) => {
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve());
        setTimeout(resolve, 3000);
      });
    } else if (port) {
      // 复用模式（无子进程句柄）：通过浏览器级 CDP 优雅关闭
      try {
        const versionResponse = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
        const version = await versionResponse.json();
        if (version?.webSocketDebuggerUrl) {
          const browserConnection = new CdpConnection(version.webSocketDebuggerUrl);
          await browserConnection.ready;
          await browserConnection.send("Browser.close").catch(() => {});
          browserConnection.close();
        }
      } catch {}
    }
  }
}

export function getBrowserSession(key) {
  return sessions.get(key) || null;
}

/**
 * 获取活动会话；服务重启后若浏览器进程仍存活，自动复用重连（无需重新 open）。
 */
async function requireActiveSession(key) {
  let session = sessions.get(key);
  if (!session) {
    session = await sessionFor(key);
    const reused = await session.tryReuse().catch(() => false);
    if (!reused) {
      sessions.delete(key); // 复用失败不留空会话，保持注册表干净
      const error = new Error("浏览器尚未启动，请先调用 browser_open 打开网页");
      error.code = "BROWSER_NOT_STARTED";
      throw error;
    }
  }
  if (!session.state.active) {
    const error = new Error("浏览器尚未启动，请先调用 browser_open 打开网页");
    error.code = "BROWSER_NOT_STARTED";
    throw error;
  }
  return session;
}

async function sessionFor(key) {
  if (!sessions.has(key)) sessions.set(key, new BrowserSession(key));
  return sessions.get(key);
}

/** 打开/切换页面（首次调用会启动浏览器；URL 非法时不启动）。 */
export async function browserOpen(key, url) {
  const target = normalizeNavUrl(url); // 先校验，避免为无效地址启动浏览器
  const session = await sessionFor(key);
  await session.ensureStarted();
  return session.navigate(target);
}

/** 观察页面：可交互元素编号清单 + 正文摘要。 */
export async function browserSnapshot(key) {
  const session = await requireActiveSession(key);
  return session.snapshot();
}

export async function browserClick(key, ref) {
  return (await requireActiveSession(key)).click(ref);
}

export async function browserType(key, ref, text, options = {}) {
  return (await requireActiveSession(key)).type(ref, text, options);
}

export async function browserPress(key, pressKey) {
  return (await requireActiveSession(key)).press(pressKey);
}

export async function browserScroll(key, direction, amount) {
  return (await requireActiveSession(key)).scroll(direction, amount);
}

export async function browserScreenshot(key) {
  return (await requireActiveSession(key)).screenshot();
}

export async function browserBack(key) {
  return (await requireActiveSession(key)).back();
}

/** 用户接管：把面板上的点击/输入/导航/滚轮转发到页面。 */
export async function browserUserInput(key, payload = {}) {
  const session = await requireActiveSession(key);
  session.lastUserInputAt = Date.now();
  const action = String(payload.action || "");
  if (action === "navigate") return session.navigate(payload.url);
  if (action === "click") {
    const point = await session.resolvePoint(payload);
    await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", clickCount: 0 });
    await session.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1, buttons: 1 });
    await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1, buttons: 0 });
    return { clicked: point };
  }
  // 拖拽（滑块验证码、画布、文本选择等）：按下 → 多次移动 → 抬起
  if (action === "pointer") {
    const point = await session.resolvePoint(payload);
    const phase = String(payload.phase || "move");
    if (phase === "down") {
      await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", clickCount: 0 });
      await session.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1, buttons: 1 });
    } else if (phase === "up") {
      await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1, buttons: 0 });
    } else {
      await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "left", buttons: 1 });
    }
    return { pointer: phase, point };
  }
  if (action === "wheel") {
    const point = await session.resolvePoint(payload);
    const deltaY = Math.max(-3000, Math.min(3000, Number(payload.deltaY) || 0));
    const deltaX = Math.max(-3000, Math.min(3000, Number(payload.deltaX) || 0));
    await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX, deltaY, button: "none" });
    return { wheel: { deltaX, deltaY } };
  }
  if (action === "type") {
    await session.cdp.send("Input.insertText", { text: String(payload.text ?? "") });
    return { typed: String(payload.text ?? "").length };
  }
  if (action === "key") return session.press(payload.key || "Enter");
  if (action === "scroll") return session.scroll(payload.direction || "down", payload.amount);
  if (action === "back") return session.back();
  if (action === "reload") return session.reload();
  if (action === "tab_new") return session.newTab(payload.url || "about:blank");
  if (action === "tab_switch") return session.switchToTarget(String(payload.tabId || ""));
  if (action === "tab_close") return session.closeTab(String(payload.tabId || ""));
  if (action === "tabs") return { tabs: await session.refreshTabs() };
  throw new Error(`不支持的操作：${action}`);
}

/** Agent 侧标签页管理：list / new / switch / close。 */
export async function browserTabs(key, action = "list", tabId = "", url = "") {
  const session = await requireActiveSession(key);
  if (action === "list") return { tabs: await session.refreshTabs() };
  if (action === "new") return session.newTab(url || "about:blank");
  if (action === "switch") return session.switchToTarget(String(tabId || ""));
  if (action === "close") return session.closeTab(String(tabId || ""));
  throw new Error(`不支持的标签页操作：${action}`);
}

/**
 * 关闭浏览器。默认保护用户接管：用户 3 分钟内操作过时拒绝关闭，
 * 只有面板的“强制关闭”（force）或用户明确要求才真正关闭。
 */
export async function browserClose(key, { force = false, reason = "" } = {}) {
  const session = sessions.get(key);
  if (!session) return { closed: false, message: "没有运行中的浏览器" };
  const recent = session.lastUserInputAt && Date.now() - session.lastUserInputAt < 3 * 60 * 1000;
  if (!force && recent) {
    return {
      closed: false,
      kept: true,
      message: "用户刚刚在浏览器中操作过，已保留浏览器（如确需关闭，请让用户点击面板右上角关闭，或稍后再试）。",
    };
  }
  await session.close();
  sessions.delete(key);
  return { closed: true, reason };
}

/** 服务退出时清理所有浏览器进程。 */
export function shutdownBrowsers() {
  for (const [key, session] of sessions.entries()) {
    try { session.close(); } catch {}
    sessions.delete(key);
  }
}

process.on("exit", () => {
  for (const session of sessions.values()) {
    if (session.child?.pid) {
      try { session.child.kill(); } catch {}
    }
  }
});

export function browserStoreInfo() {
  return {
    profileDir: PROFILE_DIR,
    shotDir: SHOT_DIR,
    executable: findBrowserExecutable(),
    headless: process.env.OAW_BROWSER_HEADLESS !== "0",
    sessions: [...sessions.keys()],
  };
}
