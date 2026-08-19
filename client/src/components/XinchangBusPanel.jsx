import React, { useEffect, useState } from "react";
import Icon from "./Icon.jsx";
import { mapM3Routes, mapM3Stations, mapM3OD, mapM3Stats } from "../api.js";

function mapOf(ref) { return ref.current?.getMap?.() || null; }
function remove(map, layers, sources) { if (!map) return; layers.forEach((id) => { try { if (map.getLayer(id)) map.removeLayer(id); } catch {} }); sources.forEach((id) => { try { if (map.getSource(id)) map.removeSource(id); } catch {} }); }
function renderRoutes(map, data) {
  remove(map, ["xinchang-routes"], ["xinchang-routes-src"]);
  map.addSource("xinchang-routes-src", { type: "geojson", data });
  map.addLayer({ id: "xinchang-routes", type: "line", source: "xinchang-routes-src", paint: { "line-color": ["get", "route_color"], "line-width": ["match", ["get", "route_type"], "城际公交", 3, "城乡公交", 2.5, 2], "line-opacity": 0.86 } });
}
function renderStations(map, data) {
  remove(map, ["xinchang-station-heat", "xinchang-stations"], ["xinchang-stations-src"]);
  map.addSource("xinchang-stations-src", { type: "geojson", data: data.geojson });
  map.addLayer({ id: "xinchang-station-heat", type: "heatmap", source: "xinchang-stations-src", paint: { "heatmap-weight": ["interpolate", ["linear"], ["get", "flow"], 0, 0, data.stats.maxFlow, 1], "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 9, 12, 14, 28], "heatmap-opacity": 0.7, "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(33,102,172,0)", 0.35, "#2d9cdb", 0.62, "#f2c94c", 1, "#eb5757"] } });
  map.addLayer({ id: "xinchang-stations", type: "circle", source: "xinchang-stations-src", minzoom: 12, paint: { "circle-radius": ["interpolate", ["linear"], ["get", "flow"], 0, 3, data.stats.maxFlow, 9], "circle-color": "#eb5757", "circle-stroke-color": "#fff", "circle-stroke-width": 1 } });
}
function renderOD(map, data) {
  remove(map, ["xinchang-od"], ["xinchang-od-src"]);
  map.addSource("xinchang-od-src", { type: "geojson", data: data.geojson });
  map.addLayer({ id: "xinchang-od", type: "line", source: "xinchang-od-src", paint: { "line-color": "#7c3aed", "line-width": ["interpolate", ["linear"], ["get", "flow"], 0, 1, data.stats.maxFlow, 5], "line-opacity": 0.65 } });
}

/** 新昌公交 Demo：线路、站点客流、公交 OD、线网统计四个 tab。 */
export default function XinchangBusPanel({ mapRef, activeTab = "routes", onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let cancelled = false; setLoading(true); setError("");
    const task = activeTab === "routes" ? mapM3Routes() : activeTab === "stations" ? mapM3Stations() : activeTab === "od" ? mapM3OD() : mapM3Stats();
    task.then((next) => {
      if (cancelled) return; setData(next);
      let tries = 0; const apply = () => { const map = mapOf(mapRef); if (!map?.isStyleLoaded?.()) { if (++tries < 12) setTimeout(apply, 250); return; } remove(map, ["xinchang-routes", "xinchang-station-heat", "xinchang-stations", "xinchang-od"], ["xinchang-routes-src", "xinchang-stations-src", "xinchang-od-src"]); if (activeTab === "routes") renderRoutes(map, next); if (activeTab === "stations") renderStations(map, next); if (activeTab === "od") renderOD(map, next); };
      apply();
    }).catch((e) => { if (!cancelled) setError(e.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeTab, mapRef]);

  return <div className="analysis-dashboard bus-dashboard">
    <div className="analysis-head"><div><small>DEMO DATASET · XINCHANG</small><h3>新昌公交线网与客流分析</h3></div><button className="mp-op" onClick={onClose} aria-label="关闭"><Icon name="close" size={14} /></button></div>
    {loading && <div className="analysis-state"><Icon name="loading" size={14} /> 正在加载公交数据…</div>}
    {error && <div className="analysis-state error">{error}</div>}
    {data && activeTab === "routes" && <><div className="analysis-source"><span>演示数据</span><strong>{data.source}</strong></div><div className="analysis-kpis"><div><b>{data.stats.routeCount}</b><span>线路数</span></div><div><b>{Math.round(data.stats.totalLength)}km</b><span>总里程</span></div><div><b>{data.stats.featureCount}</b><span>方向数</span></div></div><div className="analysis-list">{data.stats.byType.map((x) => <div className="analysis-rank" key={x.type}><i style={{ background: x.color }} /><span>{x.type}</span><strong>{x.count} 条 / {x.length}km</strong></div>)}</div></>}
    {data && activeTab === "stations" && <><div className="analysis-kpis"><div><b>{data.stats.stationCount}</b><span>站点数</span></div><div><b>{data.stats.totalFlow.toLocaleString()}</b><span>总客流</span></div><div><b>{data.stats.avgFlow}</b><span>站均客流</span></div></div><h4>客流 Top 10</h4><div className="analysis-list">{data.top20.slice(0, 10).map((x, i) => <div className="analysis-rank" key={x.name}><b>{i + 1}</b><span>{x.name}</span><strong>{x.flow.toLocaleString()}</strong></div>)}</div></>}
    {data && activeTab === "od" && <><div className="analysis-kpis"><div><b>{data.stats.displayPairs}</b><span>OD 对数</span></div><div><b>{data.stats.totalFlow.toLocaleString()}</b><span>总客流</span></div><div><b>{data.stats.avgFlow}</b><span>平均流量</span></div></div><div className="analysis-hint">紫色线为公交 OD 期望线，线宽按客流缩放。</div></>}
    {data && activeTab === "stats" && <><div className="analysis-kpis"><div><b>{data.stats.routeCount}</b><span>线路数</span></div><div><b>{data.stats.stationCount}</b><span>站点数</span></div><div><b>{data.stats.totalFlow.toLocaleString()}</b><span>总客流</span></div><div><b>{data.stats.odPairs}</b><span>OD 对</span></div></div><div className="analysis-list">{data.stats.longestRoutes.map((x, i) => <div className="analysis-rank" key={x.name}><b>{i + 1}</b><span>{x.name} · {x.type}</span><strong>{x.length}km</strong></div>)}</div></>}
    <div className="analysis-hint">当前数据明确标记为新昌公交演示数据；切换 tab 会更新对应地图临时图层。</div>
  </div>;
}
