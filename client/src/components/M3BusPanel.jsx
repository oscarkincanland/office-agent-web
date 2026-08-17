/**
 * M3 公交数据分析面板
 * 
 * 数据源：新昌公交数据
 * - 线路矢量 GeoJSON（52 条线路）
 * - 站点坐标 CSV
 * - OD 矩阵数据
 * - 客流数据
 */
import React, { useState, useEffect, useCallback } from "react";
import Icon from "./Icon.jsx";

// 新昌公交数据路径（相对 office-workspace/maps/）
const BUS_DATA_BASE = "bus-xinchang";

/** 获取公交分析数据 */
async function fetchBusData(endpoint) {
  const res = await fetch(`/api/bus/${endpoint}`);
  return res.json();
}

/** 公交线路图层面板 */
function BusRoutesPanel({ mapRef }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [routeType, setRouteType] = useState("all"); // all/urban/suburban

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchBusData("routes");
      if (result.error) setError(result.error);
      else {
        setData(result);
        if (mapRef.current) {
          applyBusRoutes(mapRef.current, result.geojson, routeType);
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [mapRef, routeType]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) return <div className="m3-panel"><Icon name="loading" size={14} /> 加载线路数据...</div>;
  if (error) return <div className="m3-panel m3-error">{error}</div>;
  if (!data) return null;

  const { stats } = data;
  
  return (
    <div className="m3-panel">
      <div className="m3-header">
        <Icon name="bus" size={14} />
        <span>公交线路（{stats.total} 条）</span>
      </div>
      <div className="m3-stats">
        <div className="m3-stat">
          <div className="m3-stat-value">{stats.urban || 0}</div>
          <div className="m3-stat-label">城市公交</div>
        </div>
        <div className="m3-stat">
          <div className="m3-stat-value">{stats.suburban || 0}</div>
          <div className="m3-stat-label">城乡公交</div>
        </div>
        <div className="m3-stat">
          <div className="m3-stat-value">{stats.totalLength?.toFixed(0) || 0}km</div>
          <div className="m3-stat-label">总里程</div>
        </div>
      </div>
      <div className="m3-filter">
        <label>
          <input type="radio" checked={routeType === "all"} onChange={() => setRouteType("all")} />
          全部线路
        </label>
        <label>
          <input type="radio" checked={routeType === "urban"} onChange={() => setRouteType("urban")} />
          城市公交
        </label>
        <label>
          <input type="radio" checked={routeType === "suburban"} onChange={() => setRouteType("suburban")} />
          城乡公交
        </label>
      </div>
      <p className="m3-hint">地图已显示公交线路（按类型分级配色）</p>
    </div>
  );
}

/** 应用公交线路渲染 */
function applyBusRoutes(map, geojson, type) {
  const sourceId = "bus-routes";
  const layerId = "bus-routes-fill";
  
  if (map.getLayer(layerId)) map.removeLayer(layerId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);
  
  // 按类型过滤
  let features = geojson.features || [];
  if (type !== "all") {
    features = features.filter(f => (f.properties.type || "urban") === type);
  }
  
  map.addSource(sourceId, {
    type: "geojson",
    data: { type: "FeatureCollection", features },
  });
  
  map.addLayer({
    id: layerId,
    type: "line",
    source: sourceId,
    paint: {
      "line-color": [
        "case",
        ["==", ["get", "type"], "suburban"], "#ff7f0e",
        "#1f77b4"
      ],
      "line-width": 2,
      "line-opacity": 0.7,
    },
  });
}

/** 公交站点热力图 */
function BusStopsHeatmap({ mapRef }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    fetchBusData("stops")
      .then(result => {
        if (result.error) setError(result.error);
        else if (mapRef.current) {
          applyBusStopsHeatmap(mapRef.current, result.geojson);
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [mapRef]);

  if (loading) return <div className="m3-panel"><Icon name="loading" size={14} /> 加载站点数据...</div>;
  if (error) return <div className="m3-panel m3-error">{error}</div>;
  return null;
}

/** 应用站点热力图 */
function applyBusStopsHeatmap(map, geojson) {
  const sourceId = "bus-stops-heatmap";
  const layerId = "bus-stops-heatmap-fill";
  
  if (map.getLayer(layerId)) map.removeLayer(layerId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);
  
  map.addSource(sourceId, {
    type: "geojson",
    data: geojson,
  });
  
  map.addLayer({
    id: layerId,
    type: "heatmap",
    source: sourceId,
    paint: {
      "heatmap-weight": ["get", "passengers"],
      "heatmap-intensity": 1.5,
      "heatmap-radius": 30,
      "heatmap-color": [
        "interpolate", ["linear"], ["heatmap-density"],
        0, "rgba(0,0,255,0)",
        0.3, "rgba(0,255,255,1)",
        0.6, "rgba(0,255,0,1)",
        0.8, "rgba(255,255,0,1)",
        1, "rgba(255,0,0,1)"
      ],
    },
  });
}

/** OD 期望线面板 */
function BusODPanel({ mapRef }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [timePeriod, setTimePeriod] = useState("all");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchBusData(`od?period=${timePeriod}`);
      if (result.error) setError(result.error);
      else {
        setData(result);
        if (mapRef.current) {
          applyBusOD(mapRef.current, result.geojson);
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [mapRef, timePeriod]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) return <div className="m3-panel"><Icon name="loading" size={14} /> 加载 OD 数据...</div>;
  if (error) return <div className="m3-panel m3-error">{error}</div>;
  if (!data) return null;

  const { stats } = data;
  
  return (
    <div className="m3-panel">
      <div className="m3-header">
        <Icon name="flow" size={14} />
        <span>公交 OD 期望线</span>
      </div>
      <div className="m3-stats">
        <div className="m3-stat">
          <div className="m3-stat-value">{stats.pairs || 0}</div>
          <div className="m3-stat-label">OD 对数</div>
        </div>
        <div className="m3-stat">
          <div className="m3-stat-value">{stats.totalFlow?.toLocaleString() || 0}</div>
          <div className="m3-stat-label">总客流</div>
        </div>
      </div>
      <div className="m3-filter">
        <select value={timePeriod} onChange={(e) => setTimePeriod(e.target.value)}>
          <option value="all">全时段</option>
          <option value="morning">早高峰 (06-09)</option>
          <option value="evening">晚高峰 (16-19)</option>
          <option value="offpeak">平峰</option>
        </select>
      </div>
    </div>
  );
}

/** 应用 OD 期望线 */
function applyBusOD(map, geojson) {
  const sourceId = "bus-od";
  const layerId = "bus-od-fill";
  
  if (map.getLayer(layerId)) map.removeLayer(layerId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);
  
  map.addSource(sourceId, {
    type: "geojson",
    data: geojson,
  });
  
  map.addLayer({
    id: layerId,
    type: "line",
    source: sourceId,
    paint: {
      "line-color": "#2ca02c",
      "line-width": ["interpolate", ["linear"], ["get", "flow"], 0, 1, 100, 4],
      "line-opacity": 0.6,
    },
  });
}

/** 公交线网结构统计 */
function BusNetworkStats({ project }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    fetchBusData("stats")
      .then(result => {
        if (result.error) setError(result.error);
        else setData(result);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [project]);

  if (loading) return <div className="m3-panel"><Icon name="loading" size={14} /> 加载统计...</div>;
  if (error) return <div className="m3-panel m3-error">{error}</div>;
  if (!data) return null;

  const { stats } = data;
  
  return (
    <div className="m3-panel">
      <div className="m3-header">
        <Icon name="chart" size={14} />
        <span>公交线网结构</span>
      </div>
      <div className="m3-stats">
        <div className="m3-stat">
          <div className="m3-stat-value">{stats.routes || 0}</div>
          <div className="m3-stat-label">线路数</div>
        </div>
        <div className="m3-stat">
          <div className="m3-stat-value">{stats.stops || 0}</div>
          <div className="m3-stat-label">站点数</div>
        </div>
        <div className="m3-stat">
          <div className="m3-stat-value">{stats.coverage?.toFixed(1) || 0}%</div>
          <div className="m3-stat-label">覆盖率</div>
        </div>
      </div>
      <div className="m3-list">
        {stats.byType?.map((item, i) => (
          <div key={i} className="m3-list-item">
            <span>{item.type}</span>
            <span className="m3-list-value">{item.count} 条</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** M3 公交分析主面板 */
export default function M3BusPanel({ project, mapRef, activeTab }) {
  return (
    <div className="m3-analysis">
      {activeTab === "routes" && <BusRoutesPanel mapRef={mapRef} />}
      {activeTab === "heatmap" && <BusStopsHeatmap mapRef={mapRef} />}
      {activeTab === "od" && <BusODPanel mapRef={mapRef} />}
      {activeTab === "stats" && <BusNetworkStats project={project} />}
    </div>
  );
}
