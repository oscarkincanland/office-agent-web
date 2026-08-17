/**
 * M3 新昌公交分析面板
 *
 * 功能：
 * 1. 公交线路图层渲染（按线路类型分级配色：城市/城乡/城际）
 * 2. 站点客流热力图（MapLibre circle + heatmap 图层）
 * 3. OD 期望线可视化（分级线宽 + 透明度）
 * 4. 公交线网结构统计面板
 */
import React, { useState, useEffect, useCallback } from "react";
import Icon from "./Icon.jsx";

/** 获取 M3 分析数据 */
async function fetchM3(endpoint) {
  const res = await fetch(endpoint);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

function getMapInstance(mapRef) {
  return mapRef.current?.getMap?.() || null;
}

function applyWhenMapReady(map, apply) {
  if (!map) return;
  const run = () => {
    if (!map.isStyleLoaded?.()) return;
    try { apply(map); } catch {}
  };
  if (map.isStyleLoaded?.()) run();
  else map.once("load", run);
}

/** 移除 M3 所有图层和源 */
function clearM3Layers(map) {
  if (!map) return;
  const layerIds = [
    "m3-routes-line", "m3-routes-line-glow",
    "m3-heatmap-circle", "m3-heatmap-circle-outline",
    "m3-od-lines", "m3-od-lines-glow",
  ];
  const sourceIds = ["m3-routes", "m3-stations", "m3-od"];
  for (const id of layerIds) { if (map.getLayer(id)) map.removeLayer(id); }
  for (const id of sourceIds) { if (map.getSource(id)) map.removeSource(id); }
}

/* ================================================================
 *  1. 公交线路图层面板
 * ================================================================ */
function BusRoutesPanel({ mapRef }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [visible, setVisible] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchM3("/api/m3/bus-routes");
      if (result.error) { setError(result.error); return; }
      setData(result);
      const map = getMapInstance(mapRef);
      applyWhenMapReady(map, (m) => applyBusRoutes(m, result));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [mapRef]);

  useEffect(() => { loadData(); }, [loadData]);

  // 显隐切换
  useEffect(() => {
    const map = getMapInstance(mapRef);
    if (!map) return;
    applyWhenMapReady(map, (m) => {
      for (const id of ["m3-routes-line", "m3-routes-line-glow"]) {
        if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
      }
    });
  }, [visible, mapRef]);

  if (loading) return <div className="m3-panel"><Icon name="loading" size={14} /> 加载线路数据...</div>;
  if (error) return <div className="m3-panel m3-error">{error}</div>;
  if (!data) return null;

  const { stats } = data;

  return (
    <div className="m3-panel">
      <div className="m3-header">
        <Icon name="route" size={14} />
        <span>公交线路图层</span>
        <label className="m3-toggle">
          <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
          <span>{visible ? "显示" : "隐藏"}</span>
        </label>
        <button className="m3-refresh" onClick={loadData} title="刷新">
          <Icon name="refresh" size={12} />
        </button>
      </div>
      <div className="m3-stats">
        <div className="m3-stat">
          <div className="m3-stat-value">{stats.routeCount}</div>
          <div className="m3-stat-label">线路数</div>
        </div>
        <div className="m3-stat">
          <div className="m3-stat-value">{stats.totalLength.toFixed(0)}km</div>
          <div className="m3-stat-label">总里程</div>
        </div>
        <div className="m3-stat">
          <div className="m3-stat-value">{stats.featureCount}</div>
          <div className="m3-stat-label">方向数</div>
        </div>
      </div>
      <div className="m3-legend">
        {stats.byType.map((t) => (
          <div key={t.type} className="m3-legend-item">
            <span className="m3-legend-color" style={{ background: t.color }}></span>
            <span>{t.type}</span>
            <span className="m3-legend-count">{t.count}条 / {t.length}km</span>
          </div>
        ))}
      </div>
      <p className="m3-hint">地图已显示线路分级配色渲染</p>
    </div>
  );
}

function applyBusRoutes(map, data) {
  const sourceId = "m3-routes";
  // 清理旧图层
  for (const id of ["m3-routes-line-glow", "m3-routes-line"]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(sourceId)) map.removeSource(sourceId);

  map.addSource(sourceId, { type: "geojson", data });

  // 底层发光
  map.addLayer({
    id: "m3-routes-line-glow",
    type: "line",
    source: sourceId,
    paint: {
      "line-color": ["get", "route_color"],
      "line-width": 6,
      "line-opacity": 0.15,
      "line-blur": 3,
    },
  });

  // 主线
  map.addLayer({
    id: "m3-routes-line",
    type: "line",
    source: sourceId,
    paint: {
      "line-color": ["get", "route_color"],
      "line-width": [
        "case",
        ["==", ["get", "route_type"], "城际公交"], 2.5,
        ["==", ["get", "route_type"], "城乡公交"], 2,
        1.5,
      ],
      "line-opacity": 0.85,
    },
  });

  // 定位到数据范围
  try {
    const coords = data.features.flatMap((f) => f.geometry.coordinates);
    if (coords.length > 0) {
      const lngs = coords.map((c) => c[0]);
      const lats = coords.map((c) => c[1]);
      map.fitBounds(
        [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
        { padding: 40, duration: 800 }
      );
    }
  } catch {}
}

/* ================================================================
 *  2. 站点客流热力图面板
 * ================================================================ */
function StationHeatmapPanel({ mapRef }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [visible, setVisible] = useState(true);
  const [mode, setMode] = useState("circle"); // circle | heatmap

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchM3("/api/m3/station-heatmap");
      if (result.error) { setError(result.error); return; }
      setData(result);
      const map = getMapInstance(mapRef);
      applyWhenMapReady(map, (m) => applyStationHeatmap(m, result, mode));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [mapRef, mode]);

  useEffect(() => { loadData(); }, [loadData]);

  // 显隐切换
  useEffect(() => {
    const map = getMapInstance(mapRef);
    if (!map) return;
    applyWhenMapReady(map, (m) => {
      const layers = mode === "heatmap" ? ["m3-heatmap-heat"] : ["m3-heatmap-circle", "m3-heatmap-circle-outline"];
      for (const id of layers) {
        if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
      }
    });
  }, [visible, mapRef, mode]);

  if (loading) return <div className="m3-panel"><Icon name="loading" size={14} /> 加载站点数据...</div>;
  if (error) return <div className="m3-panel m3-error">{error}</div>;
  if (!data) return null;

  const { stats, top20 } = data;

  return (
    <div className="m3-panel">
      <div className="m3-header">
        <Icon name="locate" size={14} />
        <span>站点客流热力图</span>
        <label className="m3-toggle">
          <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
          <span>{visible ? "显示" : "隐藏"}</span>
        </label>
        <button className="m3-refresh" onClick={loadData} title="刷新">
          <Icon name="refresh" size={12} />
        </button>
      </div>
      <div className="m3-mode-switch">
        <button className={`m3-mode-btn ${mode === "circle" ? "active" : ""}`} onClick={() => setMode("circle")}>气泡</button>
        <button className={`m3-mode-btn ${mode === "heatmap" ? "active" : ""}`} onClick={() => setMode("heatmap")}>热力</button>
      </div>
      <div className="m3-stats">
        <div className="m3-stat">
          <div className="m3-stat-value">{stats.stationCount}</div>
          <div className="m3-stat-label">站点数</div>
        </div>
        <div className="m3-stat">
          <div className="m3-stat-value">{stats.totalFlow.toLocaleString()}</div>
          <div className="m3-stat-label">总客流</div>
        </div>
        <div className="m3-stat">
          <div className="m3-stat-value">{stats.avgFlow}</div>
          <div className="m3-stat-label">均客流</div>
        </div>
      </div>
      <div className="m3-legend">
        <div className="m3-legend-item">
          <span className="m3-legend-color" style={{ background: "#d62728" }}></span>
          <span>大站 (&gt;500人, {stats.highCount}个)</span>
        </div>
        <div className="m3-legend-item">
          <span className="m3-legend-color" style={{ background: "#ff7f0e" }}></span>
          <span>中站 (100-500人, {stats.mediumCount}个)</span>
        </div>
        <div className="m3-legend-item">
          <span className="m3-legend-color" style={{ background: "#2ca02c" }}></span>
          <span>小站 (&lt;100人, {stats.lowCount}个)</span>
        </div>
      </div>
      <div className="m3-top-list">
        <div className="m3-top-title">Top 10 站点</div>
        {top20.slice(0, 10).map((s, i) => (
          <div key={i} className="m3-top-item">
            <span className="m3-top-rank">{i + 1}</span>
            <span className="m3-top-name">{s.name}</span>
            <span className="m3-top-value">{s.flow.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function applyStationHeatmap(map, data, mode) {
  const sourceId = "m3-stations";
  const geojson = data.geojson;
  const maxFlow = data.stats.maxFlow;

  // 清理旧图层
  for (const id of ["m3-heatmap-heat", "m3-heatmap-circle-outline", "m3-heatmap-circle"]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(sourceId)) map.removeSource(sourceId);

  map.addSource(sourceId, { type: "geojson", data: geojson });

  if (mode === "heatmap") {
    map.addLayer({
      id: "m3-heatmap-heat",
      type: "heatmap",
      source: sourceId,
      paint: {
        "heatmap-weight": ["interpolate", ["linear"], ["get", "flow"], 0, 0, maxFlow, 1],
        "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 8, 1, 14, 3],
        "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 8, 10, 14, 30],
        "heatmap-opacity": 0.7,
        "heatmap-color": [
          "interpolate", ["linear"], ["heatmap-density"],
          0, "rgba(0,0,255,0)",
          0.2, "rgb(0,200,0)",
          0.4, "rgb(255,255,0)",
          0.6, "rgb(255,150,0)",
          0.8, "rgb(255,50,0)",
          1, "rgb(200,0,0)",
        ],
      },
    });
  } else {
    // 气泡模式
    map.addLayer({
      id: "m3-heatmap-circle",
      type: "circle",
      source: sourceId,
      paint: {
        "circle-radius": [
          "interpolate", ["linear"], ["get", "flow"],
          0, 2,
          maxFlow, 12,
        ],
        "circle-color": [
          "case",
          [">", ["get", "flow"], 500], "#d62728",
          [">", ["get", "flow"], 100], "#ff7f0e",
          "#2ca02c",
        ],
        "circle-opacity": 0.7,
        "circle-stroke-width": 0.5,
        "circle-stroke-color": "#fff",
      },
    });
    // 外圈
    map.addLayer({
      id: "m3-heatmap-circle-outline",
      type: "circle",
      source: sourceId,
      paint: {
        "circle-radius": [
          "interpolate", ["linear"], ["get", "flow"],
          0, 4,
          maxFlow, 16,
        ],
        "circle-color": "transparent",
        "circle-opacity": 0,
        "circle-stroke-width": 1,
        "circle-stroke-color": [
          "case",
          [">", ["get", "flow"], 500], "#d62728",
          [">", ["get", "flow"], 100], "#ff7f0e",
          "#2ca02c",
        ],
        "circle-stroke-opacity": 0.4,
      },
    });
  }
}

/* ================================================================
 *  3. OD 期望线面板
 * ================================================================ */
function BusODPanel({ mapRef }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [visible, setVisible] = useState(true);
  const [count, setCount] = useState(100); // 显示条数

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchM3("/api/m3/od-lines");
      if (result.error) { setError(result.error); return; }
      setData(result);
      const map = getMapInstance(mapRef);
      applyWhenMapReady(map, (m) => applyBusOD(m, result, count));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [mapRef, count]);

  useEffect(() => { loadData(); }, [loadData]);

  // 显隐
  useEffect(() => {
    const map = getMapInstance(mapRef);
    if (!map) return;
    applyWhenMapReady(map, (m) => {
      for (const id of ["m3-od-lines", "m3-od-lines-glow"]) {
        if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
      }
    });
  }, [visible, mapRef]);

  if (loading) return <div className="m3-panel"><Icon name="loading" size={14} /> 加载OD数据...</div>;
  if (error) return <div className="m3-panel m3-error">{error}</div>;
  if (!data) return null;

  const { stats } = data;

  return (
    <div className="m3-panel">
      <div className="m3-header">
        <Icon name="flow" size={14} />
        <span>OD 期望线</span>
        <label className="m3-toggle">
          <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
          <span>{visible ? "显示" : "隐藏"}</span>
        </label>
        <button className="m3-refresh" onClick={loadData} title="刷新">
          <Icon name="refresh" size={12} />
        </button>
      </div>
      <div className="m3-slider-row">
        <label>显示数量</label>
        <input
          type="range"
          min={20}
          max={200}
          step={10}
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
        />
        <span className="m3-slider-val">{count}</span>
      </div>
      <div className="m3-stats">
        <div className="m3-stat">
          <div className="m3-stat-value">{stats.totalPairs}</div>
          <div className="m3-stat-label">OD 对数</div>
        </div>
        <div className="m3-stat">
          <div className="m3-stat-value">{stats.totalFlow.toLocaleString()}</div>
          <div className="m3-stat-label">总客流</div>
        </div>
        <div className="m3-stat">
          <div className="m3-stat-value">{stats.maxFlow}</div>
          <div className="m3-stat-label">最大流量</div>
        </div>
      </div>
      <div className="m3-legend">
        <div className="m3-legend-item">
          <span className="m3-legend-color" style={{ background: "#e74c3c", height: 3 }}></span>
          <span>强 OD（&gt;50% 最大流量）</span>
        </div>
        <div className="m3-legend-item">
          <span className="m3-legend-color" style={{ background: "#f39c12", height: 2, opacity: 0.7 }}></span>
          <span>中 OD（15-50%）</span>
        </div>
        <div className="m3-legend-item">
          <span className="m3-legend-color" style={{ background: "#3498db", height: 1, opacity: 0.4 }}></span>
          <span>弱 OD（&lt;15%）</span>
        </div>
      </div>
      <p className="m3-hint">OD 线按流量分级显示线宽和透明度</p>
    </div>
  );
}

function applyBusOD(map, data, count) {
  const sourceId = "m3-od";
  const features = data.geojson.features.slice(0, count);
  const geojson = { type: "FeatureCollection", features };

  // 清理旧图层
  for (const id of ["m3-od-lines-glow", "m3-od-lines"]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(sourceId)) map.removeSource(sourceId);

  map.addSource(sourceId, { type: "geojson", data: geojson });

  // 发光底层
  map.addLayer({
    id: "m3-od-lines-glow",
    type: "line",
    source: sourceId,
    paint: {
      "line-color": [
        "case",
        ["==", ["get", "level"], "high"], "#e74c3c",
        ["==", ["get", "level"], "medium"], "#f39c12",
        "#3498db",
      ],
      "line-width": 4,
      "line-opacity": 0.1,
      "line-blur": 2,
    },
  });

  // 主线
  map.addLayer({
    id: "m3-od-lines",
    type: "line",
    source: sourceId,
    paint: {
      "line-color": [
        "case",
        ["==", ["get", "level"], "high"], "#e74c3c",
        ["==", ["get", "level"], "medium"], "#f39c12",
        "#3498db",
      ],
      "line-width": [
        "case",
        ["==", ["get", "level"], "high"], 2.5,
        ["==", ["get", "level"], "medium"], 1.5,
        0.8,
      ],
      "line-opacity": [
        "case",
        ["==", ["get", "level"], "high"], 0.85,
        ["==", ["get", "level"], "medium"], 0.55,
        0.3,
      ],
    },
  });
}

/* ================================================================
 *  4. 线网结构统计面板
 * ================================================================ */
function NetworkStatsPanel() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    fetchM3("/api/m3/network-stats")
      .then((result) => { if (result.error) setError(result.error); else setData(result); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="m3-panel"><Icon name="loading" size={14} /> 加载统计数据...</div>;
  if (error) return <div className="m3-panel m3-error">{error}</div>;
  if (!data) return null;

  const { stats } = data;

  return (
    <div className="m3-panel">
      <div className="m3-header">
        <Icon name="chart" size={14} />
        <span>线网结构统计</span>
      </div>
      <div className="m3-stats">
        <div className="m3-stat">
          <div className="m3-stat-value">{stats.routeCount}</div>
          <div className="m3-stat-label">线路数</div>
        </div>
        <div className="m3-stat">
          <div className="m3-stat-value">{stats.stationCount}</div>
          <div className="m3-stat-label">站点数</div>
        </div>
        <div className="m3-stat">
          <div className="m3-stat-value">{stats.totalFlow.toLocaleString()}</div>
          <div className="m3-stat-label">日客流</div>
        </div>
      </div>

      {/* 线路类型构成 */}
      <div className="m3-section">
        <div className="m3-section-title">线路类型构成</div>
        <div className="m3-type-bars">
          {stats.byType.map((t) => {
            const pct = Math.round(t.count / stats.routeCount * 100);
            return (
              <div key={t.type} className="m3-type-bar">
                <div className="m3-type-bar-head">
                  <span className="m3-type-dot" style={{ background: t.color }}></span>
                  <span className="m3-type-name">{t.type}</span>
                  <span className="m3-type-pct">{pct}%</span>
                </div>
                <div className="m3-bar-track">
                  <div className="m3-bar-fill" style={{ width: `${pct}%`, background: t.color }}></div>
                </div>
                <div className="m3-type-meta">{t.count}条 / {t.totalLength}km</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 线路长度分布 */}
      <div className="m3-section">
        <div className="m3-section-title">线路长度分布</div>
        <div className="m3-dist-bars">
          {stats.lengthDist.map((d) => (
            <div key={d.range} className="m3-dist-bar">
              <span className="m3-dist-label">{d.range}</span>
              <div className="m3-bar-track">
                <div
                  className="m3-bar-fill"
                  style={{
                    width: `${Math.round(d.count / stats.routeCount * 100)}%`,
                    background: "#8abeb7",
                  }}
                ></div>
              </div>
              <span className="m3-dist-count">{d.count}</span>
            </div>
          ))}
        </div>
      </div>

      {/* 最长线路 */}
      <div className="m3-section">
        <div className="m3-section-title">最长线路 Top 5</div>
        <div className="m3-route-list">
          {stats.longestRoutes.map((r, i) => (
            <div key={i} className="m3-route-item">
              <span className="m3-route-rank">{i + 1}</span>
              <span className="m3-route-name">{r.name}</span>
              <span className="m3-route-type" style={{ color: stats.byType.find(t => t.type === r.type)?.color || "#999" }}>
                {r.type}
              </span>
              <span className="m3-route-length">{r.length}km</span>
            </div>
          ))}
        </div>
      </div>

      {/* 关键指标 */}
      <div className="m3-section">
        <div className="m3-section-title">关键指标</div>
        <div className="m3-kpi-grid">
          <div className="m3-kpi">
            <div className="m3-kpi-value">{stats.avgRouteLength}km</div>
            <div className="m3-kpi-label">平均线路长度</div>
          </div>
          <div className="m3-kpi">
            <div className="m3-kpi-value">{stats.totalRouteLength}km</div>
            <div className="m3-kpi-label">线路总里程</div>
          </div>
          <div className="m3-kpi">
            <div className="m3-kpi-value">{stats.odPairs}</div>
            <div className="m3-kpi-label">有效 OD 对</div>
          </div>
          <div className="m3-kpi">
            <div className="m3-kpi-value">{(stats.totalFlow / stats.stationCount).toFixed(0)}</div>
            <div className="m3-kpi-label">站均客流</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================================================================
 *  M3 主面板（tab 切换）
 * ================================================================ */
export default function M3AnalysisPanel({ mapRef, activeTab }) {
  return (
    <div className="m3-analysis">
      {activeTab === "routes" && <BusRoutesPanel mapRef={mapRef} />}
      {activeTab === "stations" && <StationHeatmapPanel mapRef={mapRef} />}
      {activeTab === "od" && <BusODPanel mapRef={mapRef} />}
      {activeTab === "stats" && <NetworkStatsPanel />}
    </div>
  );
}
