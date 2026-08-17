/**
 * M3 新昌公交分析数据服务
 *
 * 提供 4 个分析维度的数据：
 *   1. 公交线路图层（按线路类型分级配色）
 *   2. 站点客流热力图
 *   3. OD 期望线可视化
 *   4. 公交线网结构统计
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "xinchang-data");

/** 读取 JSON 文件（带缓存） */
const cache = new Map();
function readJSON(file) {
  const key = file;
  if (cache.has(key)) return cache.get(key);
  const fp = path.join(DATA_DIR, file);
  if (!fs.existsSync(fp)) return null;
  const data = JSON.parse(fs.readFileSync(fp, "utf8"));
  cache.set(key, data);
  return data;
}

/** 线路类型分类规则 */
function classifyRoute(name) {
  const n = String(name || "");
  if (/^G\d/.test(n)) return "城乡公交";    // G3/G4/G16 → 城乡
  if (/^(50|51|22)/.test(n)) return "城际公交"; // 50/51/22 → 跨区
  if (/^(1[0-9]|2[0-3]|[1-9])路/.test(n)) return "城市公交"; // 1-23 → 城市
  return "其他";
}

/** 线路类型配色 */
const ROUTE_COLORS = {
  "城市公交": "#4A90D9",   // 蓝色
  "城乡公交": "#50C878",   // 绿色
  "城际公交": "#FF8C42",   // 橙色
  "其他": "#999999",
};

/** 1. 公交线路图层数据（按类型分级配色） */
export function getBusRoutes() {
  const geojson = readJSON("routes.geojson");
  if (!geojson) return { error: "线路数据不存在" };

  const features = geojson.features.map((f) => {
    const name = f.properties?.name || f.properties?.线路名 || "";
    const type = classifyRoute(name);
    const dir = f.properties?.dir || f.properties?.方向 || "";
    const len = f.properties?.length_km || 0;
    return {
      type: "Feature",
      properties: { ...f.properties, route_type: type, route_color: ROUTE_COLORS[type], direction: dir, length_km: len },
      geometry: f.geometry,
    };
  });

  // 统计
  const byType = {};
  for (const f of features) {
    const t = f.properties.route_type;
    if (!byType[t]) byType[t] = { count: 0, length: 0 };
    byType[t].count++;
    byType[t].length += f.properties.length_km || 0;
  }

  const routeNames = new Set(features.map((f) => f.properties.name));
  const stats = {
    routeCount: routeNames.size,
    featureCount: features.length,
    totalLength: features.reduce((s, f) => s + (f.properties.length_km || 0), 0),
    byType: Object.entries(byType).map(([type, v]) => ({
      type,
      color: ROUTE_COLORS[type],
      count: Math.ceil(v.count / 2),  // 上下行对半分
      length: Math.round(v.length),
    })),
  };

  return {
    type: "FeatureCollection",
    features,
    stats,
  };
}

/** 2. 站点客流热力图数据 */
export function getStationHeatmap() {
  const stations = readJSON("stations.json");
  if (!stations) return { error: "站点数据不存在" };

  const totalFlow = stations.reduce((s, st) => s + st.flow, 0);
  const maxFlow = Math.max(...stations.map((s) => s.flow));
  const minFlow = Math.min(...stations.map((s) => s.flow));

  // 生成 GeoJSON FeatureCollection（用于 MapLibre circle 图层）
  const features = stations.map((st) => ({
    type: "Feature",
    properties: { name: st.name, flow: st.flow, level: st.flow > 500 ? "high" : st.flow > 100 ? "medium" : "low" },
    geometry: { type: "Point", coordinates: [st.lng, st.lat] },
  }));

  // Top 20 站点
  const top20 = stations.slice(0, 20).map((s) => ({ name: s.name, flow: s.flow }));

  const stats = {
    stationCount: stations.length,
    totalFlow,
    avgFlow: Math.round(totalFlow / stations.length),
    maxFlow,
    minFlow,
    highCount: stations.filter((s) => s.flow > 500).length,
    mediumCount: stations.filter((s) => s.flow > 100 && s.flow <= 500).length,
    lowCount: stations.filter((s) => s.flow <= 100).length,
  };

  return {
    geojson: { type: "FeatureCollection", features },
    stats,
    top20,
  };
}

/** 3. OD 期望线数据 */
export function getBusODLines() {
  const odData = readJSON("od-flow.json");
  if (!odData) return { error: "OD数据不存在" };

  // 过滤掉 O==D 的自环
  const valid = odData.filter((d) => {
    const dx = Math.abs(d.o_lon - d.d_lon);
    const dy = Math.abs(d.o_lat - d.d_lat);
    return dx > 0.0001 || dy > 0.0001;
  });

  // 按流量排序，取 Top 200
  const sorted = [...valid].sort((a, b) => b.flow - a.flow).slice(0, 200);
  const maxFlow = sorted.length > 0 ? sorted[0].flow : 1;

  const features = sorted.map((d) => {
    const level = d.flow > maxFlow * 0.5 ? "high" : d.flow > maxFlow * 0.15 ? "medium" : "low";
    return {
      type: "Feature",
      properties: {
        origin: d.origin,
        dest: d.dest,
        flow: d.flow,
        level,
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [d.o_lon, d.o_lat],
          [d.d_lon, d.d_lat],
        ],
      },
    };
  });

  const totalFlow = valid.reduce((s, d) => s + d.flow, 0);
  const stats = {
    totalPairs: valid.length,
    displayPairs: features.length,
    totalFlow: Math.round(totalFlow),
    maxFlow: Math.round(maxFlow),
    avgFlow: Math.round(totalFlow / valid.length),
  };

  return {
    geojson: { type: "FeatureCollection", features },
    stats,
  };
}

/** 4. 公交线网结构统计 */
export function getBusNetworkStats() {
  const geojson = readJSON("routes.geojson");
  const stations = readJSON("stations.json");
  const odData = readJSON("od-flow.json");

  if (!geojson) return { error: "线路数据不存在" };

  // 线路分类统计
  const routes = {};
  for (const f of geojson.features) {
    const name = f.properties?.name || "";
    const type = classifyRoute(name);
    if (!routes[name]) {
      routes[name] = {
        name,
        type,
        directions: 0,
        totalPoints: 0,
        lengthKm: 0,
      };
    }
    routes[name].directions++;
    routes[name].totalPoints += f.properties?.pts || f.geometry?.coordinates?.length || 0;
    routes[name].lengthKm = Math.max(routes[name].lengthKm, f.properties?.length_km || 0);
  }

  const routeList = Object.values(routes);
  const byType = {};
  for (const r of routeList) {
    if (!byType[r.type]) byType[r.type] = { count: 0, totalLength: 0, color: ROUTE_COLORS[r.type] };
    byType[r.type].count++;
    byType[r.type].totalLength += r.lengthKm;
  }

  // 线网密度指标
  const totalRouteLength = routeList.reduce((s, r) => s + r.lengthKm, 0);
  const totalFlow = stations ? stations.reduce((s, st) => s + st.flow, 0) : 0;
  const odPairs = odData ? odData.filter(d => {
    const dx = Math.abs(d.o_lon - d.d_lon);
    const dy = Math.abs(d.o_lat - d.d_lat);
    return dx > 0.0001 || dy > 0.0001;
  }).length : 0;

  // 站点覆盖率（按线路经过站点估算）
  const stationCount = stations ? stations.length : 0;

  // 线路长度分布
  const lengthDist = [
    { range: "< 5km", count: 0 },
    { range: "5-10km", count: 0 },
    { range: "10-15km", count: 0 },
    { range: "> 15km", count: 0 },
  ];
  for (const r of routeList) {
    if (r.lengthKm < 5) lengthDist[0].count++;
    else if (r.lengthKm < 10) lengthDist[1].count++;
    else if (r.lengthKm < 15) lengthDist[2].count++;
    else lengthDist[3].count++;
  }

  const stats = {
    routeCount: routeList.length,
    totalRouteLength: Math.round(totalRouteLength),
    avgRouteLength: Math.round(totalRouteLength / routeList.length * 10) / 10,
    stationCount,
    totalFlow,
    odPairs,
    byType: Object.entries(byType).map(([type, v]) => ({
      type,
      color: v.color,
      count: v.count,
      totalLength: Math.round(v.totalLength),
    })),
    lengthDist,
    // Top 5 最长线路
    longestRoutes: [...routeList].sort((a, b) => b.lengthKm - a.lengthKm).slice(0, 5).map(r => ({
      name: r.name,
      type: r.type,
      length: Math.round(r.lengthKm * 10) / 10,
    })),
  };

  return { stats };
}
