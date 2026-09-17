import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon.jsx";
import { browserClose, browserInput } from "../api.js";

/**
 * 内置浏览器面板（工作产物 → 浏览器）
 *
 * - Agent 调用 browser_* 工具时，画面以帧流（CDP screencast）实时显示在这里；
 * - 用户可直接在画面上点击、输入，随时接管（登录、验证码等）；
 * - 只在有活动会话时建立帧流连接，避免空跑。
 */
export default function BrowserPanel({ clientId, threadId }) {
  const [state, setState] = useState({ active: false, url: "", title: "", loading: false, viewport: { width: 1280, height: 800 }, hasFrame: false });
  const [tabs, setTabs] = useState([]);
  const [frame, setFrame] = useState(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [textDraft, setTextDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [connected, setConnected] = useState(false);
  const imgRef = useRef(null);
  const sourceRef = useRef(null);

  // 帧流订阅：无会话时低频探测，会话激活后保持长连接
  useEffect(() => {
    if (!clientId) return undefined;
    let stopped = false;
    let source = null;

    const connect = () => {
      if (stopped) return;
      const params = new URLSearchParams({ client: clientId, thread: threadId || "", frames: "1" });
      source = new EventSource(`/api/browser/stream?${params.toString()}`);
      sourceRef.current = source;
      source.onopen = () => setConnected(true);
      source.onerror = () => {
        setConnected(false);
        try { source.close(); } catch {}
        if (!stopped) setTimeout(connect, 3000);
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
          }
        } catch {}
      };
    };
    connect();

    return () => {
      stopped = true;
      try { source?.close(); } catch {}
      sourceRef.current = null;
    };
  }, [clientId, threadId]);

  const send = useCallback(async (payload) => {
    setBusy(true);
    setMessage("");
    try {
      const result = await browserInput({ client: clientId, thread: threadId || "", ...payload });
      if (result?.ok === false) setMessage(result.error || "操作失败");
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
      if (!pending.timer) pending.timer = window.setTimeout(flush, 130);
    };
    img.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      img.removeEventListener("wheel", onWheel);
      if (wheelRef.current.timer) window.clearTimeout(wheelRef.current.timer);
    };
  }, [state.active, clientId, threadId, normalizedPoint]);

  const handleClose = useCallback(async () => {
    setBusy(true);
    try {
      const result = await browserClose(clientId, threadId || "", { force: true });
      setFrame(null);
      setState((previous) => ({ ...previous, active: false }));
      setMessage(result?.closed ? "浏览器已关闭" : result?.message || "浏览器未关闭");
    } catch (error) {
      setMessage(String(error.message || error));
    } finally {
      setBusy(false);
    }
  }, [clientId, threadId]);

  const statusText = useMemo(() => {
    if (!state.active) return "未启动";
    if (state.loading) return "加载中…";
    return "运行中";
  }, [state.active, state.loading]);

  if (!state.active && !frame) {
    return (
      <div className="browser-panel browser-panel-idle">
        <div className="browser-idle-card">
          <Icon name="globe" size={26} />
          <strong>内置浏览器</strong>
          <p>当 Agent 需要打开网页、自动点击或搜索时（browser_* 工具），浏览器画面会实时出现在这里，你也可以随时接管操作。</p>
          <p className="browser-idle-hint">尝试对 Agent 说：<em>“打开浏览器，在必应搜索浙江省综合交通规划 2026，把前三条摘要给我”</em></p>
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
        <button className="btn-icon" onClick={() => send({ action: "back" })} disabled={busy} title="后退"><Icon name="back" size={13} /></button>
        <button className="btn-icon" onClick={() => send({ action: "reload" })} disabled={busy} title="刷新页面"><Icon name="refresh" size={13} /></button>
        <form
          className="browser-url-form"
          onSubmit={(event) => { event.preventDefault(); if (urlDraft.trim()) { send({ action: "navigate", url: urlDraft.trim() }); setUrlDraft(""); } }}
        >
          <input
            className="browser-url-input"
            value={urlDraft || state.url || ""}
            onChange={(event) => setUrlDraft(event.target.value)}
            placeholder="输入网址后回车打开"
            spellCheck={false}
          />
        </form>
        <span className={`browser-status ${state.loading ? "loading" : state.active ? "active" : ""}`}>
          <i /> {statusText}{connected ? "" : "（未连接）"}
        </span>
        <button className="btn-icon" onClick={handleClose} disabled={busy} title="关闭浏览器"><Icon name="close" size={13} /></button>
      </div>
      {state.title && <div className="browser-title" title={state.title}>{state.title}</div>}
      <div className="browser-view" title="滚轮滚动 · 单击接管 · 按住拖动可操作滑块">
        {frame ? (
          <img
            ref={imgRef}
            src={`data:image/jpeg;base64,${frame}`}
            alt="浏览器画面"
            draggable={false}
          />
        ) : (
          <div className="browser-placeholder">正在获取画面…</div>
        )}
      </div>
      <div className="browser-hint">滚轮滚动 · 单击接管 · 按住拖动操作滑块/验证码 · 登录可直接在画面上完成</div>
      <div className="browser-input-row">
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
