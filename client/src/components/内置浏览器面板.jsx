import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon.jsx";
import { browserClose, browserInput, browserOpen, browserState } from "../api.js";

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
  const [urlDraft, setUrlDraft] = useState("");
  const [openDraft, setOpenDraft] = useState("");
  const [textDraft, setTextDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [connected, setConnected] = useState(false);
  const [takeover, setTakeover] = useState(false);
  const imgRef = useRef(null);
  const sourceRef = useRef(null);

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
        if (!stopped && result?.state) setState((previous) => ({ ...previous, ...result.state }));
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
          } else if (payload.type === "tabs") {
            setTabs(Array.isArray(payload.data?.tabs) ? payload.data.tabs : []);
          } else if (payload.type === "frame" && payload.data?.data) {
            setFrame(payload.data.data);
          } else if (payload.type === "closed") {
            setFrame(null);
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

  const send = useCallback(async (payload) => {
    setBusy(true);
    setMessage("");
    try {
      const result = await browserInput({ client: clientId, thread: threadId || "", ...payload });
      if (result?.ok === false) setMessage(result.error || "操作失败");
      if (["click", "pointer", "wheel", "type", "key", "scroll", "back", "reload", "tab_new", "tab_switch", "tab_close"].includes(payload.action)) setTakeover(true);
    } catch (error) {
      setMessage(String(error.message || error));
    } finally {
      setBusy(false);
    }
  }, [clientId, threadId]);

  const openUrl = useCallback(async (url) => {
    const target = String(url || "").trim();
    if (!target) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await browserOpen(clientId, threadId || "", target);
      if (result?.ok === false) throw new Error(result.error || "打开网页失败");
      if (result?.state) setState((previous) => ({ ...previous, ...result.state }));
      setOpenDraft(target);
      setUrlDraft("");
      setTakeover(false);
    } catch (error) {
      setMessage(String(error.message || error));
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
    return {
      nx: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      ny: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  }, []);

  // 鼠标接管：按下 → 拖动 → 抬起（支持滑块验证码/画布/文本选择；单击即按下+抬起）
  const dragRef = useRef({ active: false, lastSentAt: 0 });
  const sendPointer = useCallback((phase, point) => {
    setTakeover(true);
    browserInput({ client: clientId, thread: threadId || "", action: "pointer", phase, nx: point.nx, ny: point.ny }).catch(() => {});
  }, [clientId, threadId]);
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !state.active) return undefined;
    const onDown = (event) => {
      if (event.button !== 0) return;
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
      browserInput({ client: clientId, thread: threadId || "", action: "wheel", nx: point.nx, ny: point.ny, deltaX, deltaY }).catch(() => {});
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
  }, [state.active, clientId, threadId, normalizedPoint]);

  // 键盘直输：点击画面后可直接打字（ASCII 字符 + 常用按键），IME 中文建议用下方输入行
  const sendQuiet = useCallback((payload) => {
    setTakeover(true);
    browserInput({ client: clientId, thread: threadId || "", ...payload }).catch(() => {});
  }, [clientId, threadId]);
  const handleImageKeyDown = useCallback((event) => {
    if (!state.active) return;
    const key = event.key;
    const specialKeys = ["Backspace", "Tab", "Enter", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Delete"];
    if (specialKeys.includes(key)) {
      event.preventDefault();
      sendQuiet({ action: "key", key });
      return;
    }
    if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      sendQuiet({ action: "type", text: key });
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
            value={urlDraft || state.url || ""}
            onChange={(event) => setUrlDraft(event.target.value)}
            placeholder="输入网址后回车打开"
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
      <div className="browser-view" title="滚轮滚动 · 单击接管 · 按住拖动可操作滑块">
        {frame ? (
          <img
            ref={imgRef}
            src={`data:image/jpeg;base64,${frame}`}
            alt="浏览器画面"
            draggable={false}
            tabIndex={0}
            onKeyDown={handleImageKeyDown}
          />
        ) : (
          <div className="browser-placeholder"><span>{state.loading ? "正在加载网页…" : "正在获取画面…"}</span><button className="btn-sm" onClick={() => send({ action: "reload" })} disabled={busy}>重新连接</button></div>
        )}
      </div>
      <div className="browser-hint"><Icon name="cursor" size={11} /> 点击画面后可直接用键盘打字 · 滚轮滚动 · 按住拖动滑块/验证码 · 中文用下方输入行</div>
      <div className="browser-input-row">
        <span className="browser-input-label">向网页输入</span>
        <input
          className="browser-text-input"
          value={textDraft}
          onChange={(event) => setTextDraft(event.target.value)}
          placeholder="输入文本（先点击页面输入框）"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (textDraft) { send({ action: "type", text: textDraft }); setTextDraft(""); }
            }
          }}
        />
        <button className="btn-sm" disabled={busy || !textDraft} onClick={() => { send({ action: "type", text: textDraft }); setTextDraft(""); }}>输入</button>
        <button className="btn-sm" disabled={busy} onClick={() => send({ action: "key", key: "Enter" })}>回车</button>
        <button className="btn-sm" disabled={busy} onClick={() => send({ action: "scroll", direction: "down" })}>滚动</button>
      </div>
      {message && <div className="browser-msg">{message}</div>}
    </div>
  );
}
