import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon.jsx";
import { browserClose, browserInput, browserOpen, browserReset, browserState } from "../api.js";

/**
 * 内置浏览器面板（工作产物 → 浏览器）
 *
 * - Agent 调用 browser_* 工具时，画面以帧流（CDP screencast）实时显示在这里；
 * - 用户可直接在画面上点击、输入，随时接管（登录、验证码等）；
 * - 只在有活动会话时建立帧流连接，避免空跑。
 */
export default function BrowserPanel({ clientId, threadId, fullscreen = false, onToggleFullscreen }) {
  const [state, setState] = useState({ active: false, url: "", title: "", loading: false, viewport: { width: 1280, height: 800 }, hasFrame: false });
  const [tabs, setTabs] = useState([]);
  const [frame, setFrame] = useState(null);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const [urlDraft, setUrlDraft] = useState("");
  const [openDraft, setOpenDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [connected, setConnected] = useState(false);
  const [takeover, setTakeover] = useState(false);
  const imgRef = useRef(null);
  const viewRef = useRef(null);
  const keyboardRef = useRef(null);
  const composingRef = useRef(false);
  const sourceRef = useRef(null);
  const addressEditingRef = useRef(false);
  const inputQueueRef = useRef(Promise.resolve());

  // 先读取状态，再订阅帧流；这样用户切回“浏览器”页签时不会先看到旧的未启动状态。
  useEffect(() => {
    if (!clientId) return undefined;
    let stopped = false;
    let source = null;
    let retryTimer = null;
    let retryCount = 0;

    const syncState = async () => {
      try {
        const result = await browserState(clientId, threadId || "");
        if (!stopped && result?.state) {
          setState((previous) => ({ ...previous, ...result.state }));
          if (result.state.frameSize) setFrameSize(result.state.frameSize);
        }
      } catch {}
    };

    const connect = () => {
      if (stopped) return;
      const params = new URLSearchParams({ client: clientId, thread: threadId || "", frames: "1" });
      source = new EventSource(`/api/browser/stream?${params.toString()}`);
      sourceRef.current = source;
      source.onopen = () => { retryCount = 0; setConnected(true); };
      source.onerror = () => {
        setConnected(false);
        try { source.close(); } catch {}
        if (!stopped) {
          const delay = Math.min(10000, 1000 * (2 ** Math.min(retryCount, 3)));
          retryCount += 1;
          retryTimer = setTimeout(connect, delay);
        }
      };
      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data || "{}");
          if (payload.type === "state") {
            setState((previous) => ({ ...previous, ...(payload.data || {}) }));
            if (payload.data?.frameSize) setFrameSize(payload.data.frameSize);
          } else if (payload.type === "tabs") {
            setTabs(Array.isArray(payload.data?.tabs) ? payload.data.tabs : []);
          } else if (payload.type === "frame" && payload.data?.data) {
            setFrame(payload.data.data);
            if (payload.data.width && payload.data.height) setFrameSize({ width: payload.data.width, height: payload.data.height });
          } else if (payload.type === "closed") {
            setFrame(null);
            setFrameSize({ width: 0, height: 0 });
            setTabs([]);
            setTakeover(false);
            setState((previous) => ({ ...previous, active: false, hasFrame: false }));
          }
        } catch {}
      };
    };
    void syncState();
    connect();

    return () => {
      stopped = true;
      try { source?.close(); } catch {}
      if (retryTimer) clearTimeout(retryTimer);
      sourceRef.current = null;
    };
  }, [clientId, threadId]);

  // 所有 CDP 输入都经过同一条队列，保证 down → move → up、滚轮和键盘不会乱序。
  const queueBrowserInput = useCallback((payload) => {
    const run = inputQueueRef.current
      .catch(() => {})
      .then(() => browserInput({ client: clientId, thread: threadId || "", ...payload }));
    inputQueueRef.current = run.catch(() => {});
    return run;
  }, [clientId, threadId]);

  useEffect(() => {
    if (!addressEditingRef.current) setUrlDraft(state.url || "");
  }, [state.url]);

  const send = useCallback(async (payload) => {
    setBusy(true);
    setMessage("");
    try {
      const result = await queueBrowserInput(payload);
      if (result?.ok === false) setMessage(result.error || "操作失败");
      if (["click", "pointer", "wheel", "type", "key", "scroll", "back", "reload", "tab_new", "tab_switch", "tab_close"].includes(payload.action)) setTakeover(true);
    } catch (error) {
      setMessage(String(error.message || error));
    } finally {
      setBusy(false);
    }
  }, [queueBrowserInput]);

  const openUrl = useCallback(async (url) => {
    const target = String(url || "").trim();
    if (!target) return;
    setBusy(true);
    setMessage("");
    const applyState = (result) => {
      if (result?.state) setState((previous) => ({ ...previous, ...result.state }));
      setOpenDraft(target);
      addressEditingRef.current = false;
      setUrlDraft(target);
      setTakeover(false);
    };
    try {
      const result = await browserOpen(clientId, threadId || "", target);
      if (result?.ok === false) throw new Error(result.error || "打开网页失败");
      applyState(result);
    } catch (error) {
      // 启动失败（常见：孤儿进程占用用户数据目录 → 退出码 21）：先强制释放该会话的
      // 浏览器（杀孤儿 + 清锁），再重试一次，避免用户必须重启服务。
      try {
        setMessage("正在修复浏览器环境…");
        await browserReset(clientId, threadId || "");
        const retry = await browserOpen(clientId, threadId || "", target);
        if (retry?.ok === false) throw new Error(retry.error || "打开网页失败");
        applyState(retry);
      } catch (retryError) {
        setMessage(String(retryError?.message || retryError || error?.message || error));
      }
    } finally {
      setBusy(false);
    }
  }, [clientId, threadId]);

  // 归一化坐标：不受帧缩放与设备像素比影响，由服务端按真实视口换算
  const normalizedPoint = useCallback((event) => {
    const img = imgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const sourceWidth = Number(frameSize.width) || Number(state.viewport?.width) || 1440;
    const sourceHeight = Number(frameSize.height) || Number(state.viewport?.height) || 900;
    const scale = Math.max(rect.width / sourceWidth, rect.height / sourceHeight);
    const renderedWidth = sourceWidth * scale;
    const renderedHeight = sourceHeight * scale;
    const cropX = Math.max(0, (renderedWidth - rect.width) / 2);
    const cropY = Math.max(0, (renderedHeight - rect.height) / 2);
    const localX = (event.clientX - rect.left) + cropX;
    const localY = (event.clientY - rect.top) + cropY;
    return {
      nx: Math.max(0, Math.min(1, localX / renderedWidth)),
      ny: Math.max(0, Math.min(1, localY / renderedHeight)),
    };
  }, [frameSize.height, frameSize.width, state.viewport?.height, state.viewport?.width]);

  // 让 Chromium 的 CSS viewport 跟右侧栏同步，网页本身按真实面板宽度排版，
  // 避免把固定 1440×900 的截图硬塞进窄栏后再裁切/放大。
  useEffect(() => {
    const node = viewRef.current;
    if (!node || !state.active || typeof ResizeObserver === "undefined") return undefined;
    let timer = null;
    let last = "";
    const resize = () => {
      const rect = node.getBoundingClientRect();
      const width = Math.max(320, Math.floor(rect.width));
      const height = Math.max(240, Math.floor(rect.height));
      const signature = `${width}x${height}`;
      if (!width || !height || signature === last) return;
      last = signature;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        queueBrowserInput({ action: "resize", width, height }).catch(() => {});
      }, 120);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    resize();
    return () => {
      observer.disconnect();
      if (timer) window.clearTimeout(timer);
    };
  }, [queueBrowserInput, state.active]);

  // 鼠标接管：按下 → 拖动 → 抬起（支持滑块验证码/画布/文本选择；单击即按下+抬起）
  const dragRef = useRef({ active: false, lastSentAt: 0 });
  const sendPointer = useCallback((phase, point) => {
    setTakeover(true);
    return queueBrowserInput({ action: "pointer", phase, nx: point.nx, ny: point.ny });
  }, [queueBrowserInput]);
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !state.active) return undefined;
    const onDown = (event) => {
      if (event.button !== 0) return;
      img.focus({ preventScroll: true });
      keyboardRef.current?.focus({ preventScroll: true });
      event.preventDefault();
      const point = normalizedPoint(event);
      if (!point) return;
      dragRef.current.active = true;
      dragRef.current.lastSentAt = Date.now();
      sendPointer("down", point);
    };
    const onMove = (event) => {
      if (!dragRef.current.active) return;
      const now = Date.now();
      if (now - dragRef.current.lastSentAt < 40) return; // 节流，避免刷屏
      const point = normalizedPoint(event);
      if (!point) return;
      dragRef.current.lastSentAt = now;
      sendPointer("move", point);
    };
    const onUp = (event) => {
      if (!dragRef.current.active) return;
      dragRef.current.active = false;
      const point = normalizedPoint(event);
      if (point) sendPointer("up", point);
    };
    img.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      img.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      dragRef.current.active = false;
    };
    // 注意：不要把 frame 放进依赖。帧流每 ~100ms 更新一次，effect 会被反复重建并
    // 重置拖拽状态，导致 mouseup 发不出去（表现为点击无效、输入框拿不到焦点）。
  }, [state.active, normalizedPoint, sendPointer]);

  // 滚轮接管：把面板滚轮转发为页面滚动（节流合并，避免刷屏）
  const wheelRef = useRef({ deltaX: 0, deltaY: 0, timer: null, point: null });
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !state.active) return undefined;
    const flush = () => {
      const pending = wheelRef.current;
      pending.timer = null;
      if (!pending.point || (!pending.deltaX && !pending.deltaY)) return;
      const { deltaX, deltaY, point } = pending;
      pending.deltaX = 0;
      pending.deltaY = 0;
      queueBrowserInput({ action: "wheel", nx: point.nx, ny: point.ny, deltaX, deltaY }).catch(() => {});
    };
    const onWheel = (event) => {
      event.preventDefault();
      const point = normalizedPoint(event);
      if (!point) return;
      const pending = wheelRef.current;
      pending.point = point;
      pending.deltaX += event.deltaX;
      pending.deltaY += event.deltaY;
      setTakeover(true);
      if (!pending.timer) pending.timer = window.setTimeout(flush, 130);
    };
    img.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      img.removeEventListener("wheel", onWheel);
      if (wheelRef.current.timer) window.clearTimeout(wheelRef.current.timer);
    };
  }, [state.active, normalizedPoint, queueBrowserInput]);

  // 键盘直输：点击画面后把本地键盘焦点交给不可见捕获层，再通过 CDP
  // Input.insertText/dispatchKeyEvent 转发到真实网页，支持中文输入法。
  const sendQuiet = useCallback((payload) => {
    setTakeover(true);
    return queueBrowserInput(payload);
  }, [queueBrowserInput]);
  const flushKeyboardText = useCallback((target) => {
    if (composingRef.current) return;
    const text = target.value;
    if (!text) return;
    target.value = "";
    sendQuiet({ action: "type", text });
  }, [sendQuiet]);
  const handleKeyboardKeyDown = useCallback((event) => {
    if (!state.active) return;
    const key = event.key;
    const specialKeys = ["Backspace", "Tab", "Enter", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Delete"];
    if (specialKeys.includes(key)) {
      event.preventDefault();
      sendQuiet({ action: "key", key });
    }
  }, [state.active, sendQuiet]);

  const handleClose = useCallback(async () => {
    setBusy(true);
    try {
      const result = await browserClose(clientId, threadId || "", { force: true });
      setFrame(null);
      setState((previous) => ({ ...previous, active: false }));
      setTakeover(false);
      setMessage(result?.closed ? "浏览器已关闭" : result?.message || "浏览器未关闭");
    } catch (error) {
      setMessage(String(error.message || error));
    } finally {
      setBusy(false);
    }
  }, [clientId, threadId]);

  const toggleTakeover = useCallback(() => {
    setTakeover((value) => {
      const next = !value;
      setMessage(next ? "已切换为手动操作，点击画面即可操作网页" : "已交还 Agent，Agent 可以继续编排网页");
      return next;
    });
  }, []);

  const statusText = useMemo(() => {
    if (!state.active) return "未启动";
    if (state.loading) return "加载中…";
    return "运行中";
  }, [state.active, state.loading]);

  if (!state.active && !frame) {
    return (
      <div className="browser-panel browser-panel-idle">
        <div className="browser-idle-card">
          <div className="browser-idle-icon"><Icon name="globe" size={22} /></div>
          <div className="browser-idle-heading"><strong>Open Plan 浏览器</strong><span>Agent 与你共用的可视化网页空间</span></div>
          <p>Agent 打开网页后，画面会实时出现在这里。你可以直接点击、拖动、滚动、输入，接管登录、验证码或网页操作。</p>
          <form className="browser-idle-open" onSubmit={(event) => { event.preventDefault(); openUrl(openDraft); }}>
            <Icon name="link" size={14} />
            <input value={openDraft} onChange={(event) => setOpenDraft(event.target.value)} placeholder="输入网址，例如 https://cn.bing.com" spellCheck={false} />
            <button type="submit" className="browser-primary-btn" disabled={busy || !openDraft.trim()}><Icon name="arrowRight" size={13} />打开</button>
          </form>
          <div className="browser-quick-links">
            <span>快速打开</span>
            <button type="button" onClick={() => openUrl("https://cn.bing.com")} disabled={busy}>必应</button>
            <button type="button" onClick={() => openUrl("https://www.baidu.com")} disabled={busy}>百度</button>
            <button type="button" onClick={() => openUrl("https://example.com")} disabled={busy}>示例页</button>
          </div>
          <p className="browser-idle-hint">也可以直接对 Agent 说：<em>“打开浏览器，搜索浙江省综合交通规划 2026”</em></p>
          {message && <div className="browser-msg">{message}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="browser-panel">
      <div className="browser-tabs" role="tablist">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.active}
            className={`browser-tab ${tab.active ? "active" : ""}`}
            onClick={() => { if (!tab.active) send({ action: "tab_switch", tabId: tab.id }); }}
            title={tab.url || tab.title}
          >
            <span className="browser-tab-title">{tab.title || "新标签页"}</span>
            <button
              type="button"
              className="browser-tab-close"
              title="关闭标签页"
              onClick={(event) => { event.stopPropagation(); send({ action: "tab_close", tabId: tab.id }); }}
            >✕</button>
          </div>
        ))}
        <button type="button" className="browser-tab-new" onClick={() => send({ action: "tab_new", url: "about:blank" })} disabled={busy} title="新建标签页">＋</button>
      </div>
      <div className="browser-toolbar">
        <div className="browser-nav-actions">
          <button className="btn-icon" onClick={() => send({ action: "back" })} disabled={busy} title="后退" aria-label="后退"><Icon name="back" size={13} /></button>
          <button className="btn-icon" onClick={() => send({ action: "reload" })} disabled={busy} title="刷新页面" aria-label="刷新页面"><Icon name="refresh" size={13} /></button>
        </div>
        <form
          className="browser-url-form"
          onSubmit={(event) => { event.preventDefault(); if (urlDraft.trim()) openUrl(urlDraft.trim()); }}
        >
          <Icon name="lock" size={12} />
          <input
            className="browser-url-input"
            value={urlDraft}
            onChange={(event) => setUrlDraft(event.target.value)}
            onFocus={() => { addressEditingRef.current = true; }}
            onBlur={() => { addressEditingRef.current = false; }}
            placeholder="输入网址或搜索内容后回车"
            spellCheck={false}
          />
        </form>
        <span className={`browser-status ${state.loading ? "loading" : state.active ? "active" : ""}`} title={state.error || "浏览器连接状态"}>
          <i /> {statusText}
        </span>
        <span className={`browser-connection ${connected ? "online" : "offline"}`}><i />{connected ? "同步中" : "重连中"}</span>
        <span className={`browser-takeover ${takeover ? "is-user" : "is-agent"}`} title={takeover ? "最近一次操作来自你，Agent 仍可继续使用此浏览器" : "Agent 可继续使用此浏览器"}>
          <i />{takeover ? "你在操作" : "Agent 可用"}
        </span>
        <button
          type="button"
          className={`browser-control-toggle ${takeover ? "active" : ""}`}
          onClick={toggleTakeover}
          title={takeover ? "交还 Agent 继续操作" : "切换为手动操作"}
        >
          <Icon name="cursor" size={12} />{takeover ? "交还 Agent" : "接管操作"}
        </button>
        <button
          type="button"
          className="browser-fullscreen-toggle"
          onClick={onToggleFullscreen}
          title={fullscreen ? "退出浏览器全屏" : "浏览器铺满工作区"}
          aria-label={fullscreen ? "退出浏览器全屏" : "浏览器铺满工作区"}
        >
          <Icon name={fullscreen ? "minimize" : "maximize"} size={13} />
        </button>
        <button className="btn-icon" onClick={handleClose} disabled={busy} title="关闭浏览器" aria-label="关闭浏览器"><Icon name="close" size={13} /></button>
      </div>
      {state.title && <div className="browser-title" title={state.title}>{state.title}</div>}
      <div ref={viewRef} className="browser-view" title="滚轮滚动 · 单击接管 · 按住拖动可操作滑块">
        <textarea
          ref={keyboardRef}
          className="browser-keyboard-capture"
          aria-label="网页键盘输入"
          tabIndex={-1}
          onInput={(event) => flushKeyboardText(event.currentTarget)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            flushKeyboardText(event.currentTarget);
          }}
          onKeyDown={handleKeyboardKeyDown}
        />
        {frame ? (
          <img
            ref={imgRef}
            src={`data:image/jpeg;base64,${frame}`}
            alt="浏览器画面"
            draggable={false}
            style={frameSize.width && frameSize.height ? { aspectRatio: `${frameSize.width} / ${frameSize.height}` } : undefined}
          />
        ) : (
          <div className="browser-placeholder"><span>{state.loading ? "正在加载网页…" : "正在获取画面…"}</span><button className="btn-sm" onClick={() => send({ action: "reload" })} disabled={busy}>重新连接</button></div>
        )}
      </div>
      <div className="browser-hint"><Icon name="cursor" size={11} /> 点击网页控件后直接键盘输入 · 滚轮滚动 · 按住拖动滑块/验证码 · 回车提交</div>
      {message && <div className="browser-msg">{message}</div>}
    </div>
  );
}
