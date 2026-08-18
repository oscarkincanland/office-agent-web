import fs from "node:fs";
import path from "node:path";

const DEFAULT_ROOT = path.join("F:\\Claude code本地文件", "柬埔寨公交项目");

function dataFile() {
  return process.env.CAMBODIA_OD_FILE || path.join(process.env.CAMBODIA_PROJECT_DIR || DEFAULT_ROOT, "od_data_for_map.json");
}

function readData() {
  const file = dataFile();
  if (!fs.existsSync(file)) return { error: `柬埔寨 OD 数据不存在：${file}` };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const rows = Array.isArray(raw) ? raw : raw?.data || [];
    return { file, rows };
  } catch (e) {
    return { error: `柬埔寨 OD 数据解析失败：${e.message}` };
  }
}

export function getCambodiaOD() {
  const loaded = readData();
  if (loaded.error) return loaded;
  const valid = loaded.rows.filter((row) => [row.start_lon, row.start_lat, row.dest_lon, row.dest_lat].every((v) => Number.isFinite(Number(v))));
  const totalFlow = valid.reduce((sum, row) => sum + (Number(row.flow) || 0), 0);
  const origins = new Map();
  const destinations = new Map();
  const pairs = [];
  for (const row of valid) {
    const flow = Number(row.flow) || 1;
    const origin = String(row.start || "未命名起点");
    const destination = String(row.dest || "未命名终点");
    origins.set(origin, (origins.get(origin) || 0) + flow);
    destinations.set(destination, (destinations.get(destination) || 0) + flow);
    pairs.push({ origin, destination, flow });
  }
  const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, flow]) => ({ name, flow }));
  const points = [];
  const lines = [];
  for (const row of valid) {
    const flow = Number(row.flow) || 1;
    const origin = String(row.start || "未命名起点");
    const destination = String(row.dest || "未命名终点");
    const o = [Number(row.start_lon), Number(row.start_lat)];
    const d = [Number(row.dest_lon), Number(row.dest_lat)];
    points.push({ type: "Feature", properties: { name: origin, value: flow, role: "origin" }, geometry: { type: "Point", coordinates: o } });
    lines.push({ type: "Feature", properties: { origin, destination, flow }, geometry: { type: "LineString", coordinates: [o, d] } });
  }
  return {
    error: null,
    source: path.basename(loaded.file),
    sourcePath: loaded.file,
    status: "demo",
    stats: { records: valid.length, totalFlow, averageFlow: valid.length ? Number((totalFlow / valid.length).toFixed(2)) : 0, originCount: origins.size, destinationCount: destinations.size },
    topOrigins: top(origins),
    topDestinations: top(destinations),
    topPairs: pairs.sort((a, b) => b.flow - a.flow).slice(0, 8),
    points: { type: "FeatureCollection", features: points },
    lines: { type: "FeatureCollection", features: lines },
  };
}
