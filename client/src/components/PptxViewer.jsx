import React, { useEffect, useRef, useState } from "react";
import PPTXViewJS from "pptxviewjs";
import Icon from "./Icon.jsx";

/**
 * PPT 渲染器（基于 pptxviewjs，Office Viewer 插件同款库）
 * - Canvas 渲染 PPT 幻灯片
 * - 支持翻页 / 跳页 / 全屏
 */
export default function PptxViewer({ name }) {
  const hostRef = useRef(null);
  const canvasRef = useRef(null);
  const viewerRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    const load = async () => {
      try {
        const res = await fetch(`/api/doc/${encodeURIComponent(name)}/raw`);
        if (!res.ok) throw new Error(`加载失败 HTTP ${res.status}`);
        // 统一转 Uint8Array：pptxviewjs 的 ZLib/JSZip 直接走 uint8array 分支，规避 Blob→FileReader 兼容问题
        const buf = await res.arrayBuffer();
        const data = new Uint8Array(buf);
        if (cancelled) return;
        const viewer = new PPTXViewJS.PPTXViewer({ canvas: canvasRef.current, renderMode: "canvas", lazyLoad: false });
        await viewer.loadFile(data);
        viewerRef.current = viewer;
        setTotal(viewer.getSlideCount());
        setCurrent(1);
        await viewer.renderSlide(1);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [name]);

  const go = async (dir) => {
    const v = viewerRef.current;
    if (!v) return;
    if (dir === 1) await v.nextSlide(canvasRef.current);
    else await v.previousSlide(canvasRef.current);
    setCurrent(v.getCurrentSlideIndex() + 1);
  };

  const jump = async (idx) => {
    const v = viewerRef.current;
    if (!v) return;
    await v.goToSlide(idx, canvasRef.current);
    setCurrent(idx);
  };

  return (
    <div className="oaw-pptx-wrap">
      <div className="oaw-pptx-toolbar">
        <button className="btn-xs" onClick={() => go(-1)} disabled={current <= 1} title="上一页">‹ 上一页</button>
        <span className="oaw-pptx-count">{current} / {total}</span>
        <button className="btn-xs" onClick={() => go(1)} disabled={current >= total} title="下一页">下一页 ›</button>
        <select
          className="oaw-pptx-jump"
          value={current}
          onChange={(e) => jump(Number(e.target.value))}
          title="跳转到页"
        >
          {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>第 {n} 页</option>
          ))}
        </select>
        <span className="oaw-pptx-hint">pptxviewjs 渲染</span>
      </div>
      {loading && <div className="oaw-pptx-loading"><div className="loading-spinner"></div><div>正在渲染幻灯片...</div></div>}
      {error && <div className="oaw-pptx-error"><Icon name="warning" size={14} /> {error}</div>}
      <div className="oaw-pptx-host" ref={hostRef}>
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
