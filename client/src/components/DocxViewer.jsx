import React, { useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";
import Icon from "./Icon.jsx";

/**
 * Word 文档渲染器（基于 docx-preview，Office Viewer 插件同款库）
 * - 高保真渲染 docx（分页、表格、图片、样式）
 * - renderComments: 文档内批注显示（Word 式）
 * - renderChanges: 修订痕迹显示（增删高亮）
 */
export default function DocxViewer({ name }) {
  const hostRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showComments, setShowComments] = useState(false);
  const [showChanges, setShowChanges] = useState(false);
  const [renderKey, setRenderKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    const host = hostRef.current;
    if (!host) return;

    const load = async () => {
      try {
        const res = await fetch(`/api/doc/${encodeURIComponent(name)}/raw`);
        if (!res.ok) throw new Error(`加载失败 HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        host.innerHTML = "";
        await renderAsync(blob, host, null, {
          className: "oaw-docx",
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          renderComments: showComments,
          renderChanges: showChanges,
          useBase64URL: true,
        });
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [name, showComments, showChanges, renderKey]);

  return (
    <div className="oaw-docx-wrap">
      <div className="oaw-docx-toolbar">
        <button
          className={`btn-xs ${showComments ? "active" : ""}`}
          onClick={() => setShowComments(!showComments)}
          title="文档内批注显示（Word 式）"
        >💬 批注</button>
        <button
          className={`btn-xs ${showChanges ? "active" : ""}`}
          onClick={() => setShowChanges(!showChanges)}
          title="修订痕迹显示（增删高亮）"
        >✎ 修订</button>
        <button className="btn-xs" onClick={() => setRenderKey((k) => k + 1)} title="重新渲染">↻ 刷新</button>
        <span className="oaw-docx-hint">docx-preview 渲染 · 批注/修订可选显示</span>
      </div>
      {loading && <div className="oaw-docx-loading"><div className="loading-spinner"></div><div>正在渲染文档...</div></div>}
      {error && <div className="oaw-docx-error"><Icon name="warning" size={14} /> {error}</div>}
      <div className="oaw-docx-host" ref={hostRef} />
    </div>
  );
}
