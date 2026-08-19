import React, { useEffect, useState } from "react";
import Icon from "./Icon.jsx";
import { mapCambodiaOD } from "../api.js";

/** 暹粒 OD 演示：数据来源、筛选、统计、期望线和起点热力统一联动。 */
export default function CambodiaODPanel({ mapRef, onClose, onSaveAnalysis }) {
  const [data, setData] = useState(null);
  const [minFlow, setMinFlow] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError("");
    mapCambodiaOD(minFlow).then((next) => { if (!cancelled) setData(next); }).catch((e) => { if (!cancelled) setError(e.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [minFlow]);

  useEffect(() => {
    if (!data) return undefined;
    let attempts = 0;
    const render = () => {
      attempts += 1;
      if (mapRef.current?.showAnalysis({ id: "cambodia-od", analysis: "od", type: "od", title: "暹粒市 OD 出行分析", source: "demo", fitBounds: true, geojson: data.points, lines: data.lines }) || attempts > 10) clearInterval(timer);
    };
    const timer = setInterval(render, 250); render();
    return () => clearInterval(timer);
  }, [data, mapRef]);

  const clear = () => mapRef.current?.clearAnalysis("cambodia-od");
  const save = () => data && onSaveAnalysis?.({ id: "cambodia-od", analysis: "od", region: "暹粒市", geojson: data.points, lines: data.lines, source: "demo" });
  const exportJson = () => {
    if (!data) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ points: data.points, lines: data.lines }, null, 2)], { type: "application/json" }));
    a.download = "siem-reap-od-demo.json"; a.click();
  };

  return <div className="analysis-dashboard cambodia-dashboard">
    <div className="analysis-head"><div><small>DEMO DATASET · SIEM REAP</small><h3>暹粒市 OD 出行分析</h3></div><button className="mp-op" onClick={onClose} aria-label="关闭"><Icon name="close" size={14} /></button></div>
    {loading && <div className="analysis-state"><Icon name="loading" size={14} /> 正在加载演示数据…</div>}
    {error && <div className="analysis-state error">{error}</div>}
    {data && <>
      <div className="analysis-source"><span>演示数据</span><strong>{data.source}</strong><small>{data.stats.records} 条有坐标记录</small></div>
      <label className="analysis-filter">流量阈值 <strong>{minFlow}</strong><input type="range" min="0" max="700" step="10" value={minFlow} onChange={(e) => setMinFlow(Number(e.target.value))} /></label>
      <div className="analysis-kpis"><div><b>{data.stats.records}</b><span>OD记录</span></div><div><b>{Math.round(data.stats.totalFlow).toLocaleString()}</b><span>总出行量</span></div><div><b>{data.stats.originCount}</b><span>起点</span></div><div><b>{data.stats.destinationCount}</b><span>终点</span></div></div>
      <div className="analysis-columns"><div><h4>热门起点</h4>{data.topOrigins.slice(0, 6).map((x, i) => <div className="analysis-rank" key={x.name}><b>{i + 1}</b><span>{x.name}</span><strong>{x.flow}</strong></div>)}</div><div><h4>热门终点</h4>{data.topDestinations.slice(0, 6).map((x, i) => <div className="analysis-rank" key={x.name}><b>{i + 1}</b><span>{x.name}</span><strong>{x.flow}</strong></div>)}</div></div>
      <div className="analysis-actions"><button className="btn-sm" onClick={clear}>清除地图结果</button><button className="btn-sm" onClick={save}>保存为图层</button><button className="btn-sm" onClick={exportJson}>导出 JSON</button></div>
      <div className="analysis-hint">地图：起点热力 + 紫色 OD 期望线；当前数据明确标记为演示数据。</div>
    </>}
  </div>;
}
