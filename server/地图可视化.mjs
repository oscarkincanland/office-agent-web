/**
 * 地图可视化：统一描述符 + 数据源适配层（阶段 2 §2.1 + 阶段 5 §5.1）
 *
 * 背景：五套分析数据源各自返回不同形状（`{error, geojson, stats}` / `{points, lines, …}`
 * / `{geojson, stats, top20}`），前端就要写五套消费逻辑；再加一种数据（交通流量）
 * 就变六套。这里把"数据 → 可视化描述符"收敛成一处。
 *
 * 描述符（v1，纯数据，不含 MapLibre 表达式）：
 *   {
 *     v: 1,
 *     id, title,
 *     kind: "heatmap" | "flow" | "choropleth" | "categorical" | "points" | "isochrone",
 *     geojson,                    // FeatureCollection（主几何）
 *     lines?,                     // 可选：流向线（OD）
 *     stats: { count, min, max, avg, ... },
 *     styleHint: { field, ramp, widthRange, radiusRange },
 *     provenance: { dataset, generatedBy, runId, at, demo? },
 *   }
 *
 * 两种用法：
 *   1. 适配既有端点（不改它们的响应形状）：`adapt*()` 把旧形状转成描述符。
 *   2. 数据源适配器（阶段 5）：`registerSource` / `listSources` / `loadSource`，
 *      新增数据源 = 新增一个 adapter，不改上层。
 */

/** 数值统计（含分位，供分级着色提示） */
function numericStats(values = []) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return { count: 0, min: null, max: null, avg: null, sum: 0 };
  const sorted = [...nums].sort((a, b) => a - b);
  const sum = nums.reduce((s, v) => s + v, 0);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
  return {
    count: nums.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Number((sum / nums.length).toFixed(2)),
    sum: Number(sum.toFixed(2)),
    p25: at(0.25),
    p50: at(0.5),
    p75: at(0.75),
  };
}

/** 从要素集合里取某个属性列的数值统计（缺列时返回零值统计） */
function statsOfField(geojson, field) {
  const features = geojson?.features || [];
  return numericStats(features.map((f) => f?.properties?.[field]));
}

/** 探测要素里最像"数值指标"的属性列（按常见命名优先） */
const MEASURE_HINTS = ["flow", "value", "volume", "count", "客流", "流量", "value_avg", "flow_avg"];
export function detectMeasureField(geojson) {
  const features = geojson?.features || [];
  if (!features.length) return "";
  const keys = new Set();
  for (const f of features.slice(0, 50)) for (const k of Object.keys(f?.properties || {})) keys.add(k);
  for (const hint of MEASURE_HINTS) if (keys.has(hint)) return hint;
  // 退化：取第一个"多数样本都是数值"的列
  for (const k of keys) {
    const nums = features.slice(0, 50).filter((f) => Number.isFinite(Number(f?.properties?.[k]))).length;
    if (nums >= Math.min(3, features.length)) return k;
  }
  return "";
}

/** 探测几何类型（决定 kind 的兜底判断） */
function geometryKind(geojson) {
  const types = new Set((geojson?.features || []).slice(0, 30).map((f) => f?.geometry?.type));
  if (types.has("Point") || types.has("MultiPoint")) return "points";
  if (types.has("Polygon") || types.has("MultiPolygon")) return "choropleth";
  if (types.has("LineString") || types.has("MultiLineString")) return "lines";
  return "unknown";
}

/**
 * 统一出口：任何数据源产出描述符都过这里，保证形状一致。
 * kind 省略时按几何类型推断（点→points，面→choropleth，线→flow）。
 */
export function toDescriptor({
  id, title, kind, geojson, lines = null,
  stats = null, styleHint = null, provenance = {},
} = {}) {
  const main = geojson && geojson.type === "FeatureCollection" ? geojson : { type: "FeatureCollection", features: [] };
  const guessed = kind || (geometryKind(main) === "points" ? "points" : geometryKind(main) === "choropleth" ? "choropleth" : "flow");
  const measure = styleHint?.field || detectMeasureField(main) || detectMeasureField(lines || {});
  const fieldStats = measure ? statsOfField(main, measure) : {};
  const mergedStats = {
    // count 恒为"要素数"（卡片文案"N 个要素"据此显示）；
    // 有值的数量单独放在 valueCount，避免缺失值的要素被少报。
    count: main.features.length,
    valueCount: fieldStats.count ?? 0,
    ...fieldStats,
    ...(stats || {}),
    count: main.features.length,
  };
  const hint = styleHint || {
    field: measure || null,
    ramp: guessed === "heatmap" ? "warm" : "ramp",
    widthRange: guessed === "flow" ? [0.7, 4.5] : null,
    radiusRange: guessed === "points" ? [3, 10] : null,
  };
  return {
    v: 1,
    id: String(id || "visual"),
    title: String(title || "可视化"),
    kind: guessed,
    geojson: main,
    lines: lines || null,
    stats: mergedStats,
    styleHint: hint,
    provenance: {
      dataset: String(provenance.dataset || ""),
      generatedBy: String(provenance.generatedBy || "map-visual"),
      runId: provenance.runId || null,
      at: provenance.at || Date.now(),
      demo: Boolean(provenance.demo),
    },
  };
}

// ---------- 既有端点形状 → 描述符 ----------

/** 演示分析（`createDemoAnalysis` 的返回） → 描述符 */
export function fromDemoAnalysis(action = {}) {
  const kind = action.analysis === "isochrone" ? "isochrone" : action.analysis === "od" ? "flow" : "heatmap";
  return toDescriptor({
    id: action.id || "agent-analysis",
    title: action.title || "演示分析",
    kind,
    geojson: action.geojson,
    lines: action.lines || null,
    stats: action.stats || null,
    provenance: { dataset: "demo-analysis", generatedBy: "map-analysis.mjs", demo: action.source === "demo" },
    styleHint: kind === "flow" ? { field: "flow", ramp: "ramp", widthRange: [0.7, 4.5] } : undefined,
  });
}

/** M2 路网流量（`getTrafficBandwidth`） → 描述符 */
export function fromTrafficBandwidth(result = {}) {
  const geojson = result.geojson || { type: "FeatureCollection", features: [] };
  return toDescriptor({
    id: "m2-traffic-bandwidth",
    title: "高速路段流量带宽",
    kind: "flow",
    geojson,
    stats: { withTraffic: result.stats?.withTraffic, max: result.stats?.max, min: result.stats?.min, avg: result.stats?.avg },
    styleHint: { field: "flow_avg", ramp: "traffic", widthRange: [0.7, 6] },
    provenance: { dataset: "m2-traffic-bandwidth", generatedBy: "map.mjs" },
  });
}

/** M2 OD 期望线（`getODLines`） → 描述符 */
export function fromOdLines(result = {}) {
  const geojson = result.geojson || { type: "FeatureCollection", features: [] };
  return toDescriptor({
    id: "m2-od-lines",
    title: "市—县 OD 期望线",
    kind: "flow",
    geojson,
    stats: { levels: result.stats?.levels, volume: result.stats?.volumeStats },
    styleHint: { field: "volume", ramp: "ramp", widthRange: [0.7, 4.5] },
    provenance: { dataset: "m2-od-lines", generatedBy: "map.mjs" },
  });
}

/** 柬埔寨 OD（`getCambodiaOD`：points + lines） → 描述符（两几何合成一条流线图层） */
export function fromCambodiaOd(result = {}) {
  const lines = result.lines || { type: "FeatureCollection", features: [] };
  const points = result.points || { type: "FeatureCollection", features: [] };
  // 描述符主几何取"点"（可热力/圆点），流向线作为 lines 供叠加渲染。
  return toDescriptor({
    id: "cambodia-od",
    title: "暹粒 OD 流向",
    kind: "flow",
    geojson: points,
    lines,
    stats: { ...(result.stats || {}), totalFlow: result.stats?.totalFlow },
    styleHint: { field: "value", ramp: "ramp", widthRange: [0.7, 4.5], radiusRange: [3, 10] },
    provenance: { dataset: "cambodia-od", generatedBy: "柬埔寨OD.mjs", demo: result.status === "demo" },
  });
}

/** M3 公交（`getBusRoutes`/`getBusStops`/`getBusOD`/`getBusStats` 或 m3-xinchang 同名函数） → 描述符 */
export function fromBus(kind, result = {}) {
  if (kind === "routes") {
    return toDescriptor({
      id: "m3-bus-routes",
      title: "新昌公交线路",
      kind: "categorical",
      geojson: result.geojson || result,
      stats: result.stats || null,
      styleHint: { field: "route_type", ramp: "categorical", widthRange: [1.5, 3.5] },
      provenance: { dataset: "m3-bus-routes", generatedBy: "m3" },
    });
  }
  if (kind === "stations") {
    return toDescriptor({
      id: "m3-bus-stations",
      title: "新昌站点客流",
      kind: "points",
      geojson: result.geojson || result,
      stats: result.stats || null,
      styleHint: { field: "flow", ramp: "warm", radiusRange: [3, 12] },
      provenance: { dataset: "m3-bus-stations", generatedBy: "m3" },
    });
  }
  if (kind === "od") {
    return toDescriptor({
      id: "m3-bus-od",
      title: "新昌公交 OD",
      kind: "flow",
      geojson: result.geojson || result,
      stats: result.stats || null,
      styleHint: { field: "flow", ramp: "ramp", widthRange: [0.7, 4.5] },
      provenance: { dataset: "m3-bus-od", generatedBy: "m3" },
    });
  }
  return toDescriptor({
    id: "m3-bus-stats",
    title: "新昌公交网络统计",
    kind: "categorical",
    geojson: { type: "FeatureCollection", features: [] },
    stats: result.stats || result,
    provenance: { dataset: "m3-bus-stats", generatedBy: "m3" },
  });
}

// ---------- 数据源适配层（阶段 5 §5.1） ----------

/** 适配器注册表。adapter: { id, label, kind, paramsSchema?, load(params) → 描述符 } */
const SOURCES = new Map();

export function registerSource(adapter = {}) {
  const id = String(adapter.id || "").trim();
  if (!id) throw new Error("数据源适配器必须有 id");
  if (typeof adapter.load !== "function") throw new Error(`数据源 ${id} 必须有 load()`);
  SOURCES.set(id, {
    id,
    label: String(adapter.label || id),
    kind: String(adapter.kind || "*"),
    paramsSchema: adapter.paramsSchema || {},
    load: adapter.load,
    // 只读数据源无需审批（阶段 5 §5.4）；未来若支持写回，这里改成 false。
    readOnly: adapter.readOnly !== false,
  });
  return SOURCES.get(id);
}

/** 列出已注册的数据源（供 map_datasets / 可视面板发现） */
export function listSources() {
  return [...SOURCES.values()].map((s) => ({
    id: s.id,
    label: s.label,
    kind: s.kind,
    paramsSchema: s.paramsSchema,
    readOnly: s.readOnly,
  }));
}

/** 加载一个数据源 → 描述符（未知 id 给出可读错误与可用清单） */
export async function loadSource(id, params = {}) {
  const adapter = SOURCES.get(String(id || ""));
  if (!adapter) {
    return {
      error: `未知数据源：${id}（可用：${[...SOURCES.keys()].join("、") || "无"}）`,
      available: [...SOURCES.keys()],
    };
  }
  try {
    const out = await adapter.load(params);
    if (out?.error) return out;
    // 适配器可以直接返回描述符（有 v/kind），也可以返回裸 GeoJSON（自动包装）。
    if (out?.v === 1 && out.kind) return out;
    // 裸 GeoJSON：把 FeatureCollection 当作主几何；其它字段原样交给 toDescriptor。
    const isRawGeojson = out?.type === "FeatureCollection";
    return toDescriptor({
      id: adapter.id,
      title: adapter.label,
      ...(isRawGeojson ? { geojson: out } : (out || {})),
      provenance: { dataset: adapter.id, generatedBy: "adapter", ...(out?.provenance || {}) },
    });
  } catch (e) {
    return { error: `数据源 ${id} 加载失败：${e.message}` };
  }
}

/** 仅供测试：清空注册表 */
export function _resetSources() {
  SOURCES.clear();
}

export { numericStats };
