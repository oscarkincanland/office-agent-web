import React, { useCallback, useEffect, useRef, useState } from "react";
import PPTXViewJS from "pptxviewjs";
import Icon from "./Icon.jsx";

const LARGE_PPT_BYTES = 100 * 1024 * 1024;

/**
 * PPT 预览：普通文件使用 Canvas，超大文件自动切换 OfficeCLI 高保真 HTML。
 * 关键点是给 pptxviewjs 传入明确的 px 尺寸；传入 100% 会被库解析为 100px，导致整页内容缩成一点。
 */
export default function PptxViewer({ name }) {
  const hostRef = useRef(null);
  const canvasRef = useRef(null);
  const viewerRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [renderer, setRenderer] = useState("canvas");
  const [largeFile, setLargeFile] = useState(false);
  const [fitWidth, setFitWidth] = useState(960);
  const [slideRatio, setSlideRatio] = useState(16 / 9);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const update = () => setFitWidth(Math.max(320, Math.min(1440, host.clientWidth - 40)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const canvasSize = useCallback(() => {
    const width = Math.max(320, Math.round(fitWidth * zoom / 100));
    return { width, height: Math.max(180, Math.round(width / slideRatio)) };
  }, [fitWidth, slideRatio, zoom]);

  const applyCanvasSize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { width, height } = canvasSize();
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }, [canvasSize]);

  const renderCurrent = useCallback(async (index = current - 1) => {
    const viewer = viewerRef.current;
    if (!viewer || !canvasRef.current || index < 0) return;
    applyCanvasSize();
    await viewer.renderSlide(index, canvasRef.current);
  }, [applyCanvasSize, current]);

  useEffect(() => {
    if (renderer === "canvas" && viewerRef.current && current > 0) {
      renderCurrent().catch((e) => setError(e.message));
    }
  }, [renderer, current, fitWidth, slideRatio, zoom, renderCurrent]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setRenderer("canvas");
    setLargeFile(false);
    viewerRef.current = null;
    const load = async () => {
      try {
        const res = await fetch(`/api/doc/${encodeURIComponent(name)}/raw`);
        if (!res.ok) throw new Error(`加载失败 HTTP ${res.status}`);
        const fileSize = Number(res.headers.get("content-length") || 0);
        if (fileSize > LARGE_PPT_BYTES) {
          try { await res.body?.cancel(); } catch {}
          if (!cancelled) { setLargeFile(true); setRenderer("office"); setLoading(false); }
          return;
        }
        const data = new Uint8Array(await res.arrayBuffer());
        if (cancelled) return;
        const viewer = new PPTXViewJS.PPTXViewer({ canvas: canvasRef.current, renderMode: "canvas", lazyLoad: true });
        await viewer.loadFile(data);
        if (cancelled) return;
        viewerRef.current = viewer;
        const dims = viewer.processor?.getSlideDimensions?.() || viewer.presentation?.slideSize;
        const ratio = dims?.cx && dims?.cy ? dims.cx / dims.cy : 16 / 9;
        setSlideRatio(ratio);
        setTotal(viewer.getSlideCount());
        setCurrent(1);
        applyCanvasSize();
        await viewer.renderSlide(0, canvasRef.current);
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
    const viewer = viewerRef.current;
    if (!viewer) return;
    const next = Math.min(total - 1, Math.max(0, current - 1 + dir));
    if (next === current - 1) return;
    try { await renderCurrent(next); setCurrent(next + 1); } catch (e) { setError(e.message); }
  };

  const jump = async (page) => {
    if (!viewerRef.current) return;
    try { await renderCurrent(page - 1); setCurrent(page); } catch (e) { setError(e.message); }
  };

  return (
    <div className="oaw-pptx-wrap">
      <div className="oaw-pptx-toolbar">
        {renderer === "canvas" && <>
          <button className="btn-xs" onClick={() => go(-1)} disabled={current <= 1} title="上一页">‹ 上一页</button>
          <span className="oaw-pptx-count">{current} / {total}</span>
          <button className="btn-xs" onClick={() => go(1)} disabled={current >= total} title="下一页">下一页 ›</button>
          <select className="oaw-pptx-jump" value={current} onChange={(e) => jump(Number(e.target.value))} title="跳转到页">
            {Array.from({ length: total }, (_, i) => i + 1).map((n) => <option key={n} value={n}>第 {n} 页</option>)}
          </select>
          <span className="toolbar-sep" />
          <button className="btn-xs" onClick={() => setZoom((v) => Math.max(60, v - 10))} title="缩小幻灯片">−</button>
          <span className="oaw-pptx-zoom">{zoom}%</span>
          <button className="btn-xs" onClick={() => setZoom((v) => Math.min(180, v + 10))} title="放大幻灯片">＋</button>
          <button className="btn-xs" onClick={() => setZoom(100)} title="适合窗口">适合窗口</button>
        </>}
        {renderer === "canvas" ? (
          <button className="btn-xs" onClick={() => setRenderer("office")} title="切换到 OfficeCLI 高保真预览">高保真预览</button>
        ) : (
          <>
            <span className="oaw-pptx-high-fidelity">OfficeCLI 高保真渲染（适合超大 PPT）</span>
            {!largeFile && <button className="btn-xs" onClick={() => { setRenderer("canvas"); setLoading(false); }} title="切换回浏览器 Canvas 渲染">浏览器渲染</button>}
          </>
        )}
        <span className="oaw-pptx-hint">{renderer === "canvas" ? "Canvas" : "HTML"}</span>
      </div>
      {loading && <div className="oaw-pptx-loading"><div className="loading-spinner"></div><div>{renderer === "office" ? "正在准备高保真预览..." : "正在渲染幻灯片..."}</div></div>}
      {error && <div className="oaw-pptx-error"><Icon name="warning" size={14} /> {error}</div>}
      <div className="oaw-pptx-host" ref={hostRef}>
        {renderer === "canvas" ? (
          <div className="oaw-pptx-stage"><canvas ref={canvasRef} /></div>
        ) : (
          <iframe className="oaw-pptx-frame" title={`${name} 高保真预览`} src={`/api/doc/${encodeURIComponent(name)}/html`} onLoad={() => setLoading(false)} onError={() => { setLoading(false); setError("OfficeCLI 高保真预览加载失败，请切回浏览器渲染"); }} />
        )}
      </div>
    </div>
  );
}
