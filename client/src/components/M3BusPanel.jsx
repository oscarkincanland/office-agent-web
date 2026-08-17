/**
 * M3 公交数据分析仪表盘
 * 
 * 功能：
 * 1. 公交线路图层（按类型分级配色）
 * 2. 站点客流热力图
 * 3. OD 期望线（可清除）
 * 4. 线网结构统计
 * 5. 地图图层清除功能
 */
import React, { useState, useEffect, useCallback } from "react";
import Icon from "./Icon.jsx";

/** 获取公交分析数据 */
async function fetchBusData(endpoint) {
  const res = await fetch(`/api/bus/${endpoint}`);
  return res.json();
}

/** 清除所有公交相关图层 */
function clearBusLayers(map) {
  const layers = ["bus-routes-fill", "bus-stops-heatmap-fill", "bus-od-fill"];
  const sources = ["bus-routes", "bus-stops-heatmap", "bus-od"];
  
  for (const layerId of layers) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  for (const sourceId of sources) {
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  }
}

/** 公交线路图层面板 */
function BusRoutesPanel({ mapRef, onClear }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [routeType, setRouteType] = useState("all");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchBusData("routes");
      if (result.error) setError(result.error);
      else {
        setData(result);
        if (mapRef.current) {
          clearBusLayers(mapRef.current);
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

  if (loading) return <div className="m3-card"><Icon name="loading" size={14} /> 加载线路数据...</div>;
  if (error) return <div className="m3-card m3-error">{error}</div>;
  if (!data) return null;

  const { stats } = data;
  
  return (
    <div className="m3-card">
      <div className="m3-card-header">
        <div className="m3-card-title">
          <Icon name="bus" size={16} />
          <span>公交线路</span>
        </div>
        <div className="m3-card-actions">
          <button className="m3-btn m3-btn-clear" onClick={onClear} title="清除地图图层">
            <Icon name="trash" size={12} /> 清除
          </button>
        </div>
      </div>
      <div className="m3-card-body">
        <div className="m3-stats-grid">
          <div className="m3-stat-item">
            <div className="m3-stat-number">{stats.total}</div>
            <div className="m3-stat-label">总线路</div>
          </div>
          <div className="m3-stat-item">
            <div className="m3-stat-number">{stats.urban || 0}</div>
            <div className="m3-stat-label">城市公交</div>
          </div>
          <div className="m3-stat-item">
            <div className="m3-stat-number">{stats.suburban || 0}</div>
            <div className="m3-stat-label">城乡公交</div>
          </div>
          <div className="m3-stat-item">
            <div className="m3-stat-number">{stats.totalLength?.toFixed(0) || 0}km</div>
            <div className="m3-stat-label">总里程</div>
          </div>
        </div>
        <div className="m3-filter-group">
          <label className="m3-filter-label">线路类型：</label>
          <div className="m3-radio-group">
            <label className="m3-radio">
              <input type="radio" checked={routeType === "all"} onChange={() => setRouteType("all")} />
              <span>全部</span>
            </label>
            <label className="m3-radio">
              <input type="radio" checked={routeType === "urban"} onChange={() => setRouteType("urban")} />
              <span>城市</span>
            </label>
            <label className="m3-radio">
              <input type="radio" checked={routeType === "suburban"} onChange={() => setRouteType("suburban")} />
              <span>城乡</span>
            </label>
          </div>
        </div>
        <div className="m3-legend">
          <div className="m3-legend-item">
            <span className="m3-legend-color" style={{background: "#1f77b4"}}></span>
            <span>城市公交</span>
          </div>
          <div className="m3-legend-item">
            <span className="m3-legend-color" style={{background: "#ff7f0e"}}></span>
            <span>城乡公交</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 公交站点热力图 */
function BusStopsHeatmap({ mapRef, onClear }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    fetchBusData("stops")
      .then(result => {
        if (result.error) setError(result.error);
        else if (mapRef.current) {
          clearBusLayers(mapRef.current);
          applyBusStopsHeatmap(mapRef.current, result.geojson);
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [mapRef]);

  if (loading) return <div className="m3-card"><Icon name="loading" size={14} /> 加载站点数据...</div>;
  if (error) return <div className="m3-card m3-error">{error}</div>;
  return (
    <div className="m3-card">
      <div className="m3-card-header">
        <div className="m3-card-title">
          <Icon name="locate" size={16} />
          <span>站点客流热力图</span>
        </div>
        <div className="m3-card-actions">
          <button className="m3-btn m3-btn-clear" onClick={onClear} title="清除地图图层">
            <Icon name="trash" size={12} /> 清除
          </button>
        </div>
      </div>
      <div className="m3-card-body">
        <div className="m3-heatmap-legend">
          <div className="m3-heatmap-bar"></div>
          <div className="m3-heatmap-labels">
            <span>低客流</span>
            <span>高客流</span>
          </div>
        </div>
        <p className="m3-note">颜色越深表示该站点客流量越大</p>
      </div>
    </div>
  );
}

/** OD 期望线面板 */
function BusODPanel({ mapRef, onClear }) {
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
          clearBusLayers(mapRef.current);
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

  if (loading) return <div className="m3-card"><Icon name="loading" size={14} /> 加载 OD 数据...</div>;
  if (error) return <div className="m3-card m3-error">{error}</div>;
  if (!data) return null;

  const { stats } = data;
  
  return (
    <div className="m3-card">
      <div className="m3-card-header">
        <div className="m3-card-title">
          <Icon name="flow" size={16} />
          <span>OD 期望线分析</span>
        </div>
        <div className="m3-card-actions">
          <button className="m3-btn m3-btn-clear" onClick={onClear} title="清除地图图层">
            <Icon name="trash" size={12} /> 清除
          </button>
        </div>
      </div>
      <div className="m3-card-body">
        <div className="m3-explain-box">
          <h4>什么是 OD 期望线？</h4>
          <ul>
            <li><strong>O</strong> = Origin（起点）：乘客上车站点</li>
            <li><strong>D</strong> = Destination（终点）：乘客下车站点</li>
            <li>线条粗细 = 客流量：越粗表示该 OD 对客流越大</li>
            <li>用途：识别主要客流走廊，优化线路布局</li>
          </ul>
        </div>
        <div className="m3-stats-grid">
          <div className="m3-stat-item">
            <div className="m3-stat-number">{stats.pairs || 0}</div>
            <div className="m3-stat-label">OD 对数</div>
          </div>
          <div className="m3-stat-item">
            <div className="m3-stat-number">{stats.totalFlow?.toLocaleString() || 0}</div>
            <div className="m3-stat-label">总客流</div>
          </div>
        </div>
        <div className="m3-filter-group">
          <label className="m3-filter-label">时段选择：</label>
          <select className="m3-select" value={timePeriod} onChange={(e) => setTimePeriod(e.target.value)}>
            <option value="all">全时段</option>
            <option value="morning">早高峰 (06-09)</option>
            <option value="evening">晚高峰 (16-19)</option>
            <option value="offpeak">平峰</option>
          </select>
        </div>
      </div>
    </div>
  );
}

/** 公交线网结构统计 */
function BusNetworkStats({ onClear }) {
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
  }, []);

  if (loading) return <div className="m3-card"><Icon name="loading" size={14} /> 加载统计...</div>;
  if (error) return <div className="m3-card m3-error">{error}</div>;
  if (!data) return null;

  const { stats } = data;
  
  return (
    <div className="m3-card">
      <div className="m3-card-header">
        <div className="m3-card-title">
          <Icon name="chart" size={16} />
          <span>线网结构统计</span>
        </div>
        <div className="m3-card-actions">
          <button className="m3-btn m3-btn-clear" onClick={onClear} title="清除地图图层">
            <Icon name="trash" size={12} /> 清除
          </button>
        </div>
      </div>
      <div className="m3-card-body">
        <div className="m3-stats-grid">
          <div className="m3-stat-item">
            <div className="m3-stat-number">{stats.routes || 0}</div>
            <div className="m3-stat-label">线路数</div>
          </div>
          <div className="m3-stat-item">
            <div className="m3-stat-number">{stats.stops || 0}</div>
            <div className="m3-stat-label">站点数</div>
          </div>
          <div className="m3-stat-item">
            <div className="m3-stat-number">{stats.coverage?.toFixed(1) || 0}%</div>
            <div className="m3-stat-label">覆盖率</div>
          </div>
        </div>
        <div className="m3-breakdown">
          <h4>线路类型分布</h4>
          <div className="m3-bar-chart">
            {stats.byType?.map((item, i) => (
              <div key={i} className="m3-bar-item">
                <div className="m3-bar-label">{item.type}</div>
                <div className="m3-bar-track">
                  <div 
                    className="m3-bar-fill" 
                    style={{width: `${(item.count / stats.routes * 100)}%`}}
                  ></div>
                </div>
                <div className="m3-bar-value">{item.count}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** M3 公交分析仪表盘主面板 */
export default function M3BusPanel({ project, mapRef, activeTab, onClose }) {
  const handleClear = useCallback(() => {
    if (mapRef.current) {
      clearBusLayers(mapRef.current);
    }
  }, [mapRef]);

  return (
    <div className="m3-dashboard">
      {activeTab === "routes" && <BusRoutesPanel mapRef={mapRef} onClear={handleClear} />}
      {activeTab === "heatmap" && <BusStopsHeatmap mapRef={mapRef} onClear={handleClear} />}
      {activeTab === "od" && <BusODPanel mapRef={mapRef} onClear={handleClear} />}
      {activeTab === "stats" && <BusNetworkStats onClear={handleClear} />}
    </div>
  );
}
