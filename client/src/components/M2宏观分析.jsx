/**
 * M2 宏观交通分析面板
 * 
 * 功能：
 * 1. 路网流量带宽图
 * 2. OD 期望线
 * 3. 多时距等时圈
 * 4. 区域交换量桑基图
 * 5. 路网结构统计
 */
import React, { useState, useEffect, useCallback } from "react";
import Icon from "./Icon.jsx";

/** 获取 M2 分析数据 */
async function fetchM2Data(endpoint, project = "zhejiang-map") {
  const url = endpoint.startsWith("/api/map/") 
    ? `${endpoint}?project=${project}`
    : endpoint;
  const res = await fetch(url);
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

/** 路网流量带宽图面板 */
function TrafficBandwidthPanel({ project, mapRef }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchM2Data("/api/map/traffic-bandwidth", project);
      if (result.error) {
        setError(result.error);
      } else {
        setData(result);
        // 在地图上渲染流量带宽
        const map = getMapInstance(mapRef);
        applyWhenMapReady(map, (loadedMap) => applyTrafficBandwidth(loadedMap, result.geojson));
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [project, mapRef]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) return <div className="m2-panel"><Icon name="loading" size={14} /> 加载中...</div>;
  if (error) return <div className="m2-panel m2-error">{error}</div>;
  if (!data) return null;

  const { stats, geojson } = data;
  
  return (
    <div className="m2-panel">
      <div className="m2-header">
        <Icon name="chart" size={14} />
        <span>路网流量带宽图</span>
        <button className="m2-refresh" onClick={loadData} title="刷新">
          <Icon name="refresh" size={12} />
        </button>
      </div>
      <div className="m2-stats">
        <div className="m2-stat">
          <div className="m2-stat-value">{stats.count.toLocaleString()}</div>
          <div className="m2-stat-label">路段总数</div>
        </div>
        <div className="m2-stat">
          <div className="m2-stat-value">{stats.avg.toLocaleString()}</div>
          <div className="m2-stat-label">平均流量</div>
        </div>
        <div className="m2-stat">
          <div className="m2-stat-value">{stats.max.toLocaleString()}</div>
          <div className="m2-stat-label">最大流量</div>
        </div>
      </div>
      <div className="m2-legend">
        <div className="m2-legend-item">
          <span className="m2-legend-color" style={{ background: "#d62728" }}></span>
          <span>高流量 (&gt;15000)</span>
        </div>
        <div className="m2-legend-item">
          <span className="m2-legend-color" style={{ background: "#ff7f0e" }}></span>
          <span>中流量 (8000-15000)</span>
        </div>
        <div className="m2-legend-item">
          <span className="m2-legend-color" style={{ background: "#2ca02c" }}></span>
          <span>低流量 (&lt;8000)</span>
        </div>
      </div>
      <p className="m2-hint">地图已显示流量分级带宽渲染</p>
    </div>
  );
}

/** 应用流量带宽渲染到地图 */
function applyTrafficBandwidth(map, geojson) {
  const sourceId = "traffic-bandwidth";
  const layerId = "traffic-bandwidth-fill";
  
  // 移除旧图层
  if (map.getLayer(layerId)) map.removeLayer(layerId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);
  
  // 添加数据源
  map.addSource(sourceId, {
    type: "geojson",
    data: geojson,
  });
  
  // 添加渲染图层
  map.addLayer({
    id: layerId,
    type: "line",
    source: sourceId,
    paint: {
      "line-color": [
        "case",
        [">", ["get", "flow_avg"], 15000], "#d62728",
        [">", ["get", "flow_avg"], 8000], "#ff7f0e",
        "#2ca02c"
      ],
      "line-width": [
        "interpolate", ["linear"], ["get", "flow_avg"],
        0, 1,
        10000, 2,
        20000, 4
      ],
      "line-opacity": 0.8,
    },
  });
}

/** OD 期望线面板 */
function ODLinesPanel({ project, mapRef }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchM2Data("/api/map/od-lines", project);
      if (result.error) {
        setError(result.error);
      } else {
        setData(result);
        const map = getMapInstance(mapRef);
        applyWhenMapReady(map, (loadedMap) => applyODLines(loadedMap, result.geojson));
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [project, mapRef]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) return <div className="m2-panel"><Icon name="loading" size={14} /> 加载中...</div>;
  if (error) return <div className="m2-panel m2-error">{error}</div>;
  if (!data) return null;

  const { stats, geojson } = data;
  
  return (
    <div className="m2-panel">
      <div className="m2-header">
        <Icon name="flow" size={14} />
        <span>OD 期望线</span>
        <button className="m2-refresh" onClick={loadData}>
          <Icon name="refresh" size={12} />
        </button>
      </div>
      <div className="m2-stats">
        <div className="m2-stat">
          <div className="m2-stat-value">{stats.count}</div>
          <div className="m2-stat-label">OD 对数</div>
        </div>
        <div className="m2-stat">
          <div className="m2-stat-value">{stats.volumeStats.avg.toLocaleString()}</div>
          <div className="m2-stat-label">平均流量</div>
        </div>
      </div>
      <div className="m2-legend">
        <div className="m2-legend-item">
          <span className="m2-legend-color" style={{ background: "#1f77b4", height: 3 }}></span>
          <span>高流量</span>
        </div>
        <div className="m2-legend-item">
          <span className="m2-legend-color" style={{ background: "#1f77b4", height: 2, opacity: 0.6 }}></span>
          <span>中流量</span>
        </div>
        <div className="m2-legend-item">
          <span className="m2-legend-color" style={{ background: "#1f77b4", height: 1, opacity: 0.3 }}></span>
          <span>低流量</span>
        </div>
      </div>
    </div>
  );
}

/** 应用 OD 期望线渲染 */
function applyODLines(map, geojson) {
  const sourceId = "od-lines";
  const layerId = "od-lines-fill";
  
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
      "line-color": "#1f77b4",
      "line-width": [
        "case",
        ["==", ["get", "level"], "high"], 3,
        ["==", ["get", "level"], "medium"], 2,
        1
      ],
      "line-opacity": [
        "case",
        ["==", ["get", "level"], "high"], 0.8,
        ["==", ["get", "level"], "medium"], 0.5,
        0.3
      ],
    },
  });
}

/** 区域交换量桑基图面板 */
function ExchangeSankeyPanel({ project }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    fetchM2Data("/api/map/exchange-sankey", project)
      .then(result => {
        if (result.error) setError(result.error);
        else setData(result);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [project]);

  if (loading) return <div className="m2-panel"><Icon name="loading" size={14} /> 加载中...</div>;
  if (error) return <div className="m2-panel m2-error">{error}</div>;
  if (!data) return null;

  const { data: sankeyData, stats } = data;
  
  return (
    <div className="m2-panel">
      <div className="m2-header">
        <Icon name="sankey" size={14} />
        <span>区域交换量</span>
      </div>
      <div className="m2-stats">
        <div className="m2-stat">
          <div className="m2-stat-value">{stats.nodes}</div>
          <div className="m2-stat-label">城市数</div>
        </div>
        <div className="m2-stat">
          <div className="m2-stat-value">{stats.links}</div>
          <div className="m2-stat-label">交换流</div>
        </div>
        <div className="m2-stat">
          <div className="m2-stat-value">{(stats.totalVolume / 1000).toFixed(0)}k</div>
          <div className="m2-stat-label">总流量</div>
        </div>
      </div>
      <div className="m2-sankey-list">
        {sankeyData.links.map((link, i) => (
          <div key={i} className="m2-sankey-item">
            <span>{link.source}</span>
            <span className="m2-sankey-arrow">→</span>
            <span>{link.target}</span>
            <span className="m2-sankey-value">{link.value.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 路网结构统计面板 */
function RoadStructurePanel({ project }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    fetchM2Data("/api/map/road-structure", project)
      .then(result => {
        if (result.error) setError(result.error);
        else setData(result);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [project]);

  if (loading) return <div className="m2-panel"><Icon name="loading" size={14} /> 加载中...</div>;
  if (error) return <div className="m2-panel m2-error">{error}</div>;
  if (!data) return null;

  const { stats } = data;
  const layers = Object.values(stats);
  const totalCount = layers.reduce((sum, l) => sum + l.count, 0);
  
  return (
    <div className="m2-panel">
      <div className="m2-header">
        <Icon name="road" size={14} />
        <span>路网结构</span>
      </div>
      <div className="m2-stats">
        <div className="m2-stat">
          <div className="m2-stat-value">{totalCount.toLocaleString()}</div>
          <div className="m2-stat-label">路段总数</div>
        </div>
      </div>
      <div className="m2-road-list">
        {layers.map((layer, i) => (
          <div key={i} className="m2-road-item">
            <span className="m2-road-name">{layer.name}</span>
            <span className="m2-road-count">{layer.count.toLocaleString()}</span>
            <span className="m2-road-group">{layer.group}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** M2 宏观交通分析主面板 */
export default function M2AnalysisPanel({ project, mapRef, activeTab }) {
  return (
    <div className="m2-analysis">
      {activeTab === "traffic" && <TrafficBandwidthPanel project={project} mapRef={mapRef} />}
      {activeTab === "od" && <ODLinesPanel project={project} mapRef={mapRef} />}
      {activeTab === "exchange" && <ExchangeSankeyPanel project={project} />}
      {activeTab === "structure" && <RoadStructurePanel project={project} />}
    </div>
  );
}
