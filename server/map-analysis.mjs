/**
 * 地图分析演示数据与轻量适配器。
 * 没有真实数据时明确返回 source=demo，保证演示链路可验证且不会伪装成生产数据。
 */

const CENTERS = {
  "义乌市": [120.075, 29.306],
  "金华市": [119.647, 29.079],
  "杭州市": [120.155, 30.274],
  "新昌县": [120.903, 29.499],
  "暹粒市": [103.856, 13.363],
};

const centerOf = (region = "义乌市") => CENTERS[region] || CENTERS["义乌市"];
const point = (lon, lat, properties = {}) => ({ type: "Feature", properties, geometry: { type: "Point", coordinates: [lon, lat] } });
const line = (a, b, properties = {}) => ({ type: "Feature", properties, geometry: { type: "LineString", coordinates: [a, b] } });

export function createDemoAnalysis({ analysis = "heatmap", region = "义乌市", project = "zhejiang-map", count = 36 } = {}) {
  const center = centerOf(region);
  if (analysis === "isochrone") {
    const ranges = [15, 30, 45];
    const features = ranges.map((range, index) => {
      const radius = 0.0045 * range;
      const ring = Array.from({ length: 48 }, (_, i) => {
        const angle = (Math.PI * 2 * i) / 48;
        const wobble = 1 + 0.12 * Math.sin(i * 2.7 + index);
        return [center[0] + Math.cos(angle) * radius * wobble, center[1] + Math.sin(angle) * radius * 0.72 * wobble];
      });
      ring.push(ring[0]);
      return { type: "Feature", properties: { range, color: ["#c4b5fd", "#8b5cf6", "#6d28d9"][index] }, geometry: { type: "Polygon", coordinates: [ring] } };
    });
    return { action: "show_analysis", analysis, type: analysis, id: "agent-analysis", project, region, source: "demo", title: `${region}可达性等时圈`, fitBounds: true, geojson: { type: "FeatureCollection", features }, stats: { demo: true, region, ranges } };
  }
  const total = Math.min(120, Math.max(12, Math.round(Number(count) || 36)));
  const features = Array.from({ length: total }, (_, i) => {
    const angle = i * 2.39996;
    const radius = 0.008 + ((i * 17) % 29) / 1000;
    const value = 20 + ((i * 37) % 180);
    return point(center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius * 0.72, { name: `${region}演示点-${String(i + 1).padStart(2, "0")}`, value, category: i % 3 === 0 ? "枢纽" : i % 3 === 1 ? "商贸" : "居住" });
  });
  return { action: "show_analysis", analysis: "heatmap", type: "heatmap", id: "agent-analysis", project, region, source: "demo", title: `${region}点位热力图`, fitBounds: true, geojson: { type: "FeatureCollection", features }, stats: { demo: true, region, count: total } };
}

function demoCambodiaRows() {
  const places = ["吴哥窟", "老市场", "皇家花园", "机场", "酒吧街", "暹粒车站", "Wat Bo", "Chreav"];
  return Array.from({ length: 42 }, (_, i) => {
    const o = i % places.length;
    const d = (i * 3 + 2) % places.length;
    const a = [103.80 + (o % 4) * 0.018, 13.32 + Math.floor(o / 4) * 0.018];
    const b = [103.80 + (d % 4) * 0.018, 13.32 + Math.floor(d / 4) * 0.018];
    return { start: places[o], dest: places[d], start_lon: a[0], start_lat: a[1], dest_lon: b[0], dest_lat: b[1], flow: 80 + ((i * 47) % 620) };
  }).filter((r) => r.start !== r.dest);
}

export function getCambodiaOD({ minFlow = 0 } = {}) {
  const threshold = Math.max(0, Number(minFlow) || 0);
  const rows = demoCambodiaRows().filter((r) => r.flow >= threshold);
  const origins = new Map();
  const destinations = new Map();
  const points = [];
  const lines = [];
  for (const row of rows) {
    origins.set(row.start, (origins.get(row.start) || 0) + row.flow);
    destinations.set(row.dest, (destinations.get(row.dest) || 0) + row.flow);
    const o = [row.start_lon, row.start_lat];
    const d = [row.dest_lon, row.dest_lat];
    points.push(point(o[0], o[1], { name: row.start, value: row.flow, role: "origin" }));
    lines.push(line(o, d, { origin: row.start, destination: row.dest, flow: row.flow }));
  }
  const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, flow]) => ({ name, flow }));
  const totalFlow = rows.reduce((sum, r) => sum + r.flow, 0);
  return {
    error: null,
    source: "siem-reap-od-demo.csv",
    status: "demo",
    stats: { records: rows.length, totalFlow, averageFlow: rows.length ? Number((totalFlow / rows.length).toFixed(2)) : 0, originCount: origins.size, destinationCount: destinations.size, minFlow: threshold },
    topOrigins: top(origins),
    topDestinations: top(destinations),
    topPairs: rows.slice().sort((a, b) => b.flow - a.flow).slice(0, 8).map((r) => ({ name: `${r.start} → ${r.dest}`, flow: r.flow })),
    points: { type: "FeatureCollection", features: points },
    lines: { type: "FeatureCollection", features: lines },
  };
}

function busStops() {
  return Array.from({ length: 48 }, (_, i) => {
    const col = i % 8;
    const row = Math.floor(i / 8);
    return { name: `新昌站点${String(i + 1).padStart(2, "0")}`, lng: 120.88 + col * 0.009, lat: 29.46 + row * 0.009, flow: 50 + ((i * 83) % 760) };
  });
}

function busRoutes() {
  const colors = { "城市公交": "#2563eb", "城乡公交": "#16a34a", "城际公交": "#f97316" };
  return Array.from({ length: 12 }, (_, i) => {
    const type = i % 3 === 0 ? "城乡公交" : i % 4 === 0 ? "城际公交" : "城市公交";
    const start = [120.87 + (i % 4) * 0.025, 29.45 + Math.floor(i / 4) * 0.025];
    const coords = Array.from({ length: 8 }, (_, j) => [start[0] + j * 0.012, start[1] + Math.sin(j / 2 + i) * 0.006]);
    return { type: "Feature", properties: { name: type === "城市公交" ? `${i + 1}路` : type === "城乡公交" ? `G${i + 3}` : `5${i}`, route_type: type, route_color: colors[type], length_km: 6 + i * 1.7 }, geometry: { type: "LineString", coordinates: coords } };
  });
}

export function getXinchangBus(kind = "all") {
  const stops = busStops();
  const routes = busRoutes();
  const od = routes.slice(0, 10).map((r, i) => ({ origin: r.properties.name, dest: routes[(i + 3) % routes.length].properties.name, flow: 120 + i * 47, o: r.geometry.coordinates[0], d: routes[(i + 3) % routes.length].geometry.coordinates.at(-1) }));
  const totalFlow = stops.reduce((s, x) => s + x.flow, 0);
  const byType = ["城市公交", "城乡公交", "城际公交"].map((type) => ({ type, color: type === "城市公交" ? "#2563eb" : type === "城乡公交" ? "#16a34a" : "#f97316", count: routes.filter((r) => r.properties.route_type === type).length, length: Math.round(routes.filter((r) => r.properties.route_type === type).reduce((s, r) => s + r.properties.length_km, 0)) }));
  if (kind === "routes") return { type: "FeatureCollection", features: routes, source: "xinchang-bus-demo", stats: { routeCount: routes.length, featureCount: routes.length, totalLength: routes.reduce((s, r) => s + r.properties.length_km, 0), byType } };
  if (kind === "stations") return { geojson: { type: "FeatureCollection", features: stops.map((s) => point(s.lng, s.lat, { name: s.name, flow: s.flow })) }, source: "xinchang-bus-demo", stats: { stationCount: stops.length, totalFlow, avgFlow: Math.round(totalFlow / stops.length), maxFlow: Math.max(...stops.map((s) => s.flow)), highCount: stops.filter((s) => s.flow > 500).length, mediumCount: stops.filter((s) => s.flow > 100 && s.flow <= 500).length, lowCount: stops.filter((s) => s.flow <= 100).length }, top20: stops.slice().sort((a, b) => b.flow - a.flow).slice(0, 20).map((s) => ({ name: s.name, flow: s.flow })) };
  if (kind === "od") return { geojson: { type: "FeatureCollection", features: od.map((x) => line(x.o, x.d, { origin: x.origin, dest: x.dest, flow: x.flow })) }, source: "xinchang-bus-demo", stats: { totalPairs: od.length, displayPairs: od.length, totalFlow: od.reduce((s, x) => s + x.flow, 0), maxFlow: Math.max(...od.map((x) => x.flow)), avgFlow: Math.round(od.reduce((s, x) => s + x.flow, 0) / od.length) } };
  return { source: "xinchang-bus-demo", status: "demo", stats: { routeCount: routes.length, totalRouteLength: Math.round(routes.reduce((s, r) => s + r.properties.length_km, 0)), avgRouteLength: Number((routes.reduce((s, r) => s + r.properties.length_km, 0) / routes.length).toFixed(1)), stationCount: stops.length, totalFlow, odPairs: od.length, byType, lengthDist: [{ range: "< 5km", count: 0 }, { range: "5-10km", count: 4 }, { range: "10-15km", count: 5 }, { range: "> 15km", count: 3 }], longestRoutes: routes.slice().sort((a, b) => b.properties.length_km - a.properties.length_km).slice(0, 5).map((r) => ({ name: r.properties.name, type: r.properties.route_type, length: Number(r.properties.length_km.toFixed(1)) })) } };
}
