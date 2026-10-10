/**
 * 内置数据源适配器（阶段 5 §5.2）
 *
 * 两个适配器，验证"新增数据源 = 新增一个文件，不改上层"这个接口约定：
 *   - `local-file`：工作区里的 CSV / GeoJSON 通用兜底。交通流量数据很可能就是
 *     "一段时间的车流量 CSV"，这个适配器负责识别经纬度列、数值列并转描述符。
 *   - `bundled-xinchang`：把现有 M3 新昌公交数据包装成适配器（证明既有源可平滑迁移）。
 *
 * 未来接入点（本阶段只留桩，不实现）：实时交通流 API、数据库直连、车载 GPS 轨迹。
 * 见 `server/交通数据源.mjs` 的 `registerSource`——那三类的适配器放进来即可，无需改上层。
 */
import fs from "node:fs";
import path from "node:path";
import { registerSource, toDescriptor, detectMeasureField } from "./地图可视化.mjs";
import { getWorkspace } from "./workspace.mjs";

/** 逗号/制表符分隔的表格 → 行对象（带表头） */
function parseCsv(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { header: [], rows: [] };
  const split = (line) => {
    // 支持带引号的字段（简单的双引号转义）
    const out = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = !quoted;
      } else if (!quoted && (ch === "," || ch === "\t")) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((c) => c.trim());
  };
  const header = split(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cells = split(line);
    const obj = {};
    header.forEach((h, i) => { obj[h] = cells[i] ?? ""; });
    return obj;
  });
  return { header, rows };
}

/**
 * 在表头里找某一类列。
 * `exact` 为真时要求列名完全相等（单字符别名 x/y 必须精确匹配，
 * 否则 `max_value` 会被当成 x 列——实测踩过）。
 */
function findColumn(header, aliases, { exact = [] } = {}) {
  const lower = header.map((h) => String(h).toLowerCase().trim());
  for (const alias of aliases) {
    if (exact.includes(alias)) {
      const idx = lower.findIndex((h) => h === alias);
      if (idx >= 0) return header[idx];
      continue;
    }
    const idx = lower.findIndex((h) => h.includes(alias));
    if (idx >= 0) return header[idx];
  }
  return "";
}

/** 识别一份表格的列语义：点数据（经纬度）或 OD 数据（起点/终点） */
export function detectColumns(header = []) {
  // x/y 只按精确列名匹配（`max_value` 不该被当成 x）
  const lng = findColumn(header, ["经度", "longitude", "lng", "lon", "x"], { exact: ["x"] });
  const lat = findColumn(header, ["纬度", "latitude", "lat", "y"], { exact: ["y"] });
  const olng = findColumn(header, ["起点经", "出发经", "olng", "o_lon", "from_lon", "origin_lng", "start_lon"]);
  const olat = findColumn(header, ["起点纬", "出发纬", "olat", "o_lat", "from_lat", "origin_lat", "start_lat"]);
  const dlng = findColumn(header, ["终点经", "到达经", "dlng", "d_lon", "to_lon", "dest_lng", "dest_lon"]);
  const dlat = findColumn(header, ["终点纬", "到达纬", "dlat", "d_lat", "to_lat", "dest_lat"]);
  const flow = findColumn(header, ["流量", "客流", "车流", "flow", "count", "volume", "量", "value"]);
  const isOd = Boolean(olng && olat && dlng && dlat);
  const isPoint = Boolean(lng && lat);
  return { lng, lat, olng, olat, dlng, dlat, flow, mode: isOd ? "od" : isPoint ? "points" : "unknown" };
}

/**
 * 中国路网/交通数据的坐标范围（AGENT.MD 约定 73–135E / 18–54N 的宽松版）。
 * 用来兜住"空单元格被 Number("") 变成 0"和"列识别错位"两类脏数据——
 * 落在范围外的坐标一律丢弃，不让假要素污染统计与地图。
 */
const LNG_RANGE = [70, 140];
const LAT_RANGE = [15, 56];
export function inChinaRange(lng, lat) {
  return Number.isFinite(lng) && Number.isFinite(lat)
    && lng >= LNG_RANGE[0] && lng <= LNG_RANGE[1]
    && lat >= LAT_RANGE[0] && lat <= LAT_RANGE[1];
}

/** 单元格 → 数字；空/非法返回 null（不能返回 0——空值会被当成真实坐标）。 */
function cellNumber(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

/** 把行分成数值（可解析为数字）与分类（其余） */
function splitNumericColumns(header, rows) {
  const numeric = [];
  const categorical = [];
  for (const h of header) {
    const sample = rows.slice(0, 50).map((r) => r[h]).filter((v) => v !== "" && v !== undefined);
    if (!sample.length) continue;
    const nums = sample.filter((v) => Number.isFinite(Number(v))).length;
    if (nums >= sample.length * 0.8) numeric.push(h);
    else categorical.push(h);
  }
  return { numeric, categorical };
}

// ---------- 适配器 1：工作区文件（CSV / GeoJSON） ----------

registerSource({
  id: "local-file",
  label: "工作区数据文件（CSV / GeoJSON）",
  kind: "*",
  paramsSchema: { path: "相对工作区的文件路径；省略时自动选工作区里最新的 CSV/GeoJSON", measure: "可选：指定数值列" },
  async load(params = {}) {
    const ws = String(params.workspace || getWorkspace() || "");
    if (!ws) return { error: "没有当前工作区" };
    const rel = String(params.path || "").trim();

    let filePath = "";
    if (rel) {
      filePath = path.resolve(ws, rel);
      // 用 path.relative 判目录边界：纯字符串前缀比较会放行"同前缀兄弟目录"
      // （工作区 F:\data 时，F:\database\x.csv 会被 startsWith 误判为在内）。
      const relToWs = path.relative(path.resolve(ws), filePath);
      if (!relToWs || relToWs.startsWith("..") || path.isAbsolute(relToWs)) {
        return { error: "path 必须在工作区内" };
      }
      if (!fs.existsSync(filePath)) return { error: `文件不存在：${rel}` };
    } else {
      // 自动挑选：工作区根目录下修改时间最新的 CSV/GeoJSON
      const candidates = fs.readdirSync(ws, { withFileTypes: true })
        .filter((e) => e.isFile() && /\.(csv|geojson|json)$/i.test(e.name))
        .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(ws, e.name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (!candidates.length) return { error: "工作区里没有 CSV / GeoJSON 文件" };
      filePath = path.join(ws, candidates[0].name);
    }

    const ext = path.extname(filePath).toLowerCase();
    const base = path.basename(filePath, ext);

    if (ext === ".geojson" || ext === ".json") {
      const geojson = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (geojson?.type !== "FeatureCollection") return { error: "GeoJSON 需要是 FeatureCollection" };
      const field = String(params.measure || "") || detectMeasureField(geojson);
      return toDescriptor({
        id: `file-${base.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
        title: base,
        geojson,
        styleHint: { field: field || null, ramp: "ramp", widthRange: [0.7, 4.5], radiusRange: [3, 10] },
        provenance: { dataset: "local-file", generatedBy: "交通数据源.mjs" },
      });
    }

    // CSV：识别列语义后生成几何
    const { header, rows } = parseCsv(fs.readFileSync(filePath, "utf8"));
    if (!rows.length) return { error: "CSV 没有数据行" };
    const cols = detectColumns(header);
    if (cols.mode === "unknown") {
      return {
        error: `无法识别坐标列。表头：${header.join("、")}（需要 经度/纬度，或 起点+终点 经纬度）`,
        header,
      };
    }
    const { numeric } = splitNumericColumns(header, rows);
    const measure = String(params.measure || "") || cols.flow || numeric[0] || "";

    // 坐标列与 measure 列之外的字段（路段名称、方向、分类等）带进 properties：
    // 地图标签 ["get","name"]、属性表、"保存为图层"都要用到，丢了就只剩坐标。
    const coordinateCols = new Set(
      [cols.lng, cols.lat, cols.olng, cols.olat, cols.dlng, cols.dlat].filter(Boolean),
    );
    const carryCols = header.filter((h) => h && !coordinateCols.has(h) && h !== measure);

    const features = [];
    const lines = [];
    let skipped = 0;
    for (const row of rows) {
      const rawFlow = measure ? cellNumber(row[measure]) : null;
      const value = rawFlow === null ? 1 : rawFlow;
      const carry = {};
      for (const col of carryCols) {
        const v = String(row[col] ?? "").trim();
        if (v) carry[col] = v;
      }
      if (cols.mode === "od") {
        // 空单元格必须显式判空：Number("") 是 0，会被当成 (0,0) 造出假流向线。
        const o = [cellNumber(row[cols.olng]), cellNumber(row[cols.olat])];
        const d = [cellNumber(row[cols.dlng]), cellNumber(row[cols.dlat])];
        if (!inChinaRange(o[0], o[1]) || !inChinaRange(d[0], d[1])) { skipped += 1; continue; }
        // 点与线都带上 measure 列名，这样统计与配色都能取到值（列名可能是中文）。
        const lineProps = { ...carry, flow: value };
        const pointProps = { ...carry, flow: value, role: "origin" };
        if (measure) { lineProps[measure] = value; pointProps[measure] = value; }
        lines.push({
          type: "Feature",
          properties: lineProps,
          geometry: { type: "LineString", coordinates: [o, d] },
        });
        features.push({ type: "Feature", properties: pointProps, geometry: { type: "Point", coordinates: o } });
      } else {
        const lng = cellNumber(row[cols.lng]);
        const lat = cellNumber(row[cols.lat]);
        if (!inChinaRange(lng, lat)) { skipped += 1; continue; }
        const props = { ...carry, value };
        if (measure) props[measure] = value;
        features.push({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [lng, lat] } });
      }
    }
    if (!features.length) {
      return {
        error: skipped
          ? `没有解析到有效坐标行（${skipped} 行坐标缺失或超出中国范围 ${LNG_RANGE[0]}–${LNG_RANGE[1]}E / ${LAT_RANGE[0]}–${LAT_RANGE[1]}N）`
          : "没有解析到有效坐标行（检查经纬度列是否为数字）",
        skipped,
        header,
      };
    }

    return toDescriptor({
      id: `file-${base.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
      title: base,
      kind: cols.mode === "od" ? "flow" : "points",
      geojson: { type: "FeatureCollection", features },
      lines: lines.length ? { type: "FeatureCollection", features: lines } : null,
      styleHint: cols.mode === "od"
        ? { field: measure || "flow", ramp: "ramp", widthRange: [0.7, 4.5] }
        : { field: measure || "value", ramp: "warm", radiusRange: [3, 12] },
      provenance: { dataset: "local-file", generatedBy: "交通数据源.mjs" },
      stats: { columns: { mode: cols.mode, measure, numeric, carried: carryCols }, rowCount: rows.length, skipped },
    });
  },
});

// ---------- 适配器 2：内置新昌公交（包装既有 M3 数据源） ----------

registerSource({
  id: "bundled-xinchang",
  label: "新昌公交（内置）",
  kind: "od-flow",
  paramsSchema: { kind: "routes | stations | od | stats，默认 stations" },
  async load(params = {}) {
    const kind = ["routes", "stations", "od", "stats"].includes(params.kind) ? params.kind : "stations";
    const { fromBus } = await import("./地图可视化.mjs");
    try {
      const m3 = await import("./m3-xinchang.mjs");
      const result = kind === "routes" ? m3.getBusRoutes()
        : kind === "stations" ? m3.getStationHeatmap()
          : kind === "od" ? m3.getBusODLines()
            : m3.getBusNetworkStats();
      if (result?.error) throw new Error(result.error);
      return fromBus(kind, result);
    } catch {
      // 真实数据缺失时退回内置演示数据，并标明 demo（不伪装成生产数据）。
      const demo = await import("./map-analysis.mjs");
      return fromBus(kind, demo.getXinchangBus(kind));
    }
  },
});

/** 未来接入点的注册桩（本阶段不实现，只声明形状，便于后续替换） */
export const PLANNED_SOURCES = Object.freeze([
  { id: "live-traffic-api", label: "实时交通流 API", kind: "traffic-flow", note: "实现 load() 拉取 → 描述符，kind 用 traffic-flow" },
  { id: "sql-database", label: "数据库直连（SQL / PostGIS）", kind: "traffic-flow", note: "实现 load() 查询 → 描述符；不要引入数据库依赖到核心路径" },
  { id: "gps-trajectory", label: "车载 GPS 轨迹", kind: "flow", note: "load() 分片读 + 抽稀（参考 scripts/prepare-map-data.mjs 的 simplifyLine）" },
]);
