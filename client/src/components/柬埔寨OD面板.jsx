import React, { useEffect, useState } from "react";
import Icon from "./Icon.jsx";

async function loadCambodiaOD() {
  const res = await fetch("/api/demo/cambodia-od");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "柬埔寨 OD 数据加载失败");
  return data;
}

export default function CambodiaODPanel({ mapRef, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadCambodiaOD()
      .then((next) => { if (!cancelled) setData(next); })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!data) return undefined;
    let attempts = 0;
    const render = () => {
      attempts += 1;
      const ok = mapRef.current?.showAnalysis({
        id: "cambodia-od",
        type: "od",
        analysis: "od",
        title: "暹粒市 OD 出行分析",
        source: "demo",
        fitBounds: true,
        geojson: data.points,
        lines: data.lines,
      });
      if (ok || attempts > 10) clearInterval(timer);
    };
    const timer = setInterval(render, 300);
    render();
    return () => clearInterval(timer);
  }, [data, mapRef]);

  const clear = () => mapRef.current?.clearAnalysis("cambodia-od");

  return (
    <div className="cambodia-dashboard">
      <div className="cambodia-head">
        <div>
          <div className="cambodia-kicker">DEMO DATASET · SIEM REAP</div>
          <h3>暹粒市 OD 出行分析</h3>
        </div>
        <button className="mp-op" onClick={onClose} title="关闭"><Icon name="close" size={14} /></button>
      </div>
      {loading && <div className="cambodia-state"><Icon name="loading" size={15} /> 正在加载 OD 数据…</div>}
      {error && <div className="cambodia-state error">{error}</div>}
      {data && (
        <>
          <div className="cambodia-source"><span>演示数据</span><strong>{data.source}</strong><small>{data.stats.records} 条有坐标记录</small></div>
          <div className="cambodia-kpis">
            <div><strong>{data.stats.records.toLocaleString()}</strong><span>OD 记录</span></div>
            <div><strong>{Math.round(data.stats.totalFlow).toLocaleString()}</strong><span>总出行量</span></div>
            <div><strong>{data.stats.originCount}</strong><span>起点</span></div>
            <div><strong>{data.stats.destinationCount}</strong><span>终点</span></div>
          </div>
          <div className="cambodia-columns">
            <div><h4>热门起点</h4>{data.topOrigins.map((item, i) => <div className="cambodia-rank" key={item.name}><b>{i + 1}</b><span>{item.name}</span><strong>{item.flow}</strong></div>)}</div>
            <div><h4>热门终点</h4>{data.topDestinations.map((item, i) => <div className="cambodia-rank" key={item.name}><b>{i + 1}</b><span>{item.name}</span><strong>{item.flow}</strong></div>)}</div>
          </div>
          <div className="cambodia-actions"><button className="btn-sm" onClick={clear}>清除地图结果</button><span>紫色流向线 · 蓝黄红为起点热力</span></div>
        </>
      )}
    </div>
  );
}
