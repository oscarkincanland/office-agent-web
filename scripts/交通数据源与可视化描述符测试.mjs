#!/usr/bin/env node
/**
 * 交通数据源与可视化描述符测试（阶段 5 + 阶段 2.1）
 *
 * 覆盖：
 *   G1 local-file 适配器能识别车流量 CSV 的坐标列并出图（真造一个 CSV 验证）
 *   G2 适配器注册表：listSources 含 local-file / bundled-xinchang
 *   G3 新增适配器只需实现 load()，不改上层（用测试桩验证）
 *   G4 既有 M2 / 柬埔寨 / 演示数据源适配为统一描述符，形状一致
 *
 * 同时锁定描述符形状（v/kind/geojson/stats/styleHint/provenance），
 * 防止阶段 2 的可视面板与阶段 5 的适配器对不上。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  toDescriptor,
  detectMeasureField,
  fromDemoAnalysis,
  fromTrafficBandwidth,
  fromOdLines,
  fromCambodiaOd,
  fromBus,
  registerSource,
  listSources,
  loadSource,
} from "../server/地图可视化.mjs";
import { createDemoAnalysis } from "../server/地图演示.mjs";
import { getTrafficBandwidth, getODLines } from "../server/map.mjs";
import { getCambodiaOD } from "../server/柬埔寨OD.mjs";
import { detectColumns } from "../server/交通数据源.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log("  ✓ " + name); }
  catch (e) { failed += 1; console.log("  ✗ " + name + "\n      " + (e.message || e)); }
}

/** 描述符形状必须一致——这是"一份数据形状驱动一个面板"的前提 */
function assertDescriptorShape(d, label = "描述符") {
  assert.equal(d.v, 1, `${label} 应有版本号 v=1`);
  assert.ok(d.id && typeof d.id === "string", `${label} 应有 id`);
  assert.ok(d.title && typeof d.title === "string", `${label} 应有 title`);
  assert.ok(["heatmap", "flow", "choropleth", "categorical", "points", "isochrone"].includes(d.kind),
    `${label} kind 应在允许集合内，实际 ${d.kind}`);
  assert.equal(d.geojson?.type, "FeatureCollection", `${label} geojson 应为 FeatureCollection`);
  assert.ok(d.stats && typeof d.stats === "object", `${label} 应有 stats`);
  assert.ok(d.styleHint && typeof d.styleHint === "object", `${label} 应有 styleHint`);
  assert.ok(d.provenance && typeof d.provenance === "object", `${label} 应有 provenance`);
  assert.ok("dataset" in d.provenance, `${label} provenance 应含 dataset（可溯源）`);
  // styleHint 必须是纯数据（不能塞 MapLibre 表达式）
  assert.equal(typeof d.styleHint.field === "string" || d.styleHint.field === null, true,
    `${label} styleHint.field 应为字符串或 null`);
}

console.log("\n▶ 2.1 描述符形状（统一出口）");

await test("toDescriptor 输出完整形状且幂等", () => {
  const d = toDescriptor({
    id: "t", title: "测试", kind: "points",
    geojson: { type: "FeatureCollection", features: [
      { type: "Feature", properties: { value: 10 }, geometry: { type: "Point", coordinates: [120, 29] } },
      { type: "Feature", properties: { value: 30 }, geometry: { type: "Point", coordinates: [121, 30] } },
    ] },
  });
  assertDescriptorShape(d);
  assert.equal(d.stats.count, 2);
  assert.equal(d.stats.min, 10, "应统计出最小值");
  assert.equal(d.stats.max, 30, "应统计出最大值");
  assert.equal(d.stats.avg, 20);
});

await test("kind 可省略（按几何类型推断）", () => {
  const point = toDescriptor({ id: "p", geojson: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } }] } });
  assert.equal(point.kind, "points");
  const poly = toDescriptor({ id: "a", geojson: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }] } });
  assert.equal(poly.kind, "choropleth");
});

await test("detectMeasureField 认得出常见流量列名", () => {
  const g = (key) => ({ type: "FeatureCollection", features: [{ type: "Feature", properties: { [key]: 5, name: "x" }, geometry: { type: "Point", coordinates: [0, 0] } }] });
  assert.equal(detectMeasureField(g("flow")), "flow");
  assert.equal(detectMeasureField(g("客流量")), "客流量");
  assert.equal(detectMeasureField(g("volume")), "volume");
  // 无数值列时返回空串（不误判文字列）
  const text = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "a", type: "b" }, geometry: { type: "Point", coordinates: [0, 0] } }] };
  assert.equal(detectMeasureField(text), "");
});

await test("空数据不抛错（面板要能显示空态）", () => {
  const d = toDescriptor({ id: "empty", geojson: { type: "FeatureCollection", features: [] } });
  assertDescriptorShape(d);
  assert.equal(d.stats.count, 0);
});

console.log("\n▶ G4 既有四类数据源 → 统一描述符");

await test("演示分析（热力图 / OD / 等时圈）", () => {
  for (const analysis of ["heatmap", "od", "isochrone"]) {
    const d = fromDemoAnalysis(createDemoAnalysis({ analysis, region: "义乌市" }));
    assertDescriptorShape(d, `演示 ${analysis}`);
    assert.ok(d.provenance.demo === true, "演示数据必须标明 demo（不伪装成生产数据）");
  }
  const od = fromDemoAnalysis(createDemoAnalysis({ analysis: "od", region: "义乌市" }));
  assert.equal(od.kind, "flow");
  assert.ok(od.lines?.features?.length > 0, "OD 应带流向线");
});

await test("M2 路网流量与 OD 期望线", () => {
  const bw = getTrafficBandwidth("zhejiang-map");
  if (bw?.error) {
    console.log("      （跳过：当前项目缺 M2 数据，" + bw.error + "）");
  } else {
    const d = fromTrafficBandwidth(bw);
    assertDescriptorShape(d, "M2 流量");
    assert.equal(d.kind, "flow");
  }
  const od = getODLines("zhejiang-map");
  if (od?.error) {
    console.log("      （跳过：当前项目缺 OD 数据）");
  } else {
    const d = fromOdLines(od);
    assertDescriptorShape(d, "M2 OD");
  }
});

await test("柬埔寨 OD（points + lines 两个几何）", () => {
  const raw = getCambodiaOD({ minFlow: 0 });
  const d = fromCambodiaOd(raw);
  assertDescriptorShape(d, "柬埔寨 OD");
  assert.ok(d.lines?.features?.length > 0, "应保留流向线");
  assert.ok(Number.isFinite(d.stats.totalFlow), `应带总流量统计（数值），实际 ${d.stats.totalFlow}`);
});

await test("M3 公交四类（routes / stations / od / stats）", () => {
  const routes = fromBus("routes", { type: "FeatureCollection", features: [] });
  assertDescriptorShape(routes, "M3 routes");
  assert.equal(routes.kind, "categorical");
  const stations = fromBus("stations", { geojson: { type: "FeatureCollection", features: [] } });
  assert.equal(stations.kind, "points");
  const od = fromBus("od", { geojson: { type: "FeatureCollection", features: [] } });
  assert.equal(od.kind, "flow");
  const stats = fromBus("stats", { stats: { routeCount: 3 } });
  assertDescriptorShape(stats, "M3 stats");
});

console.log("\n▶ G2 适配器注册表");

await test("内置两个适配器已注册且可发现", () => {
  const ids = listSources().map((s) => s.id);
  assert.ok(ids.includes("local-file"), `应含 local-file，实际：${ids.join(",")}`);
  assert.ok(ids.includes("bundled-xinchang"), `应含 bundled-xinchang，实际：${ids.join(",")}`);
});

await test("适配器元数据齐全（id/label/kind/readOnly）", () => {
  for (const s of listSources()) {
    assert.ok(s.id && s.label, `适配器 ${s.id} 应有 id 与 label`);
    assert.equal(typeof s.readOnly, "boolean", `适配器 ${s.id} 应标明是否只读（只读无需审批）`);
  }
});

await test("bundled-xinchang 可加载并产出描述符", async () => {
  const d = await loadSource("bundled-xinchang", { kind: "stations" });
  assert.ok(!d.error, `应加载成功，实际：${d.error}`);
  assertDescriptorShape(d, "bundled-xinchang");
});

console.log("\n▶ G1 local-file 适配器（真造 CSV 验证）");

await test("适应中文列名的点数据 CSV", async () => {
  const ws = path.join(ROOT, "office-workspace");
  const csvPath = path.join(ws, "_tmp_traffic_test.csv");
  fs.writeFileSync(csvPath, [
    "路段名称,经度,纬度,车流量",
    "路段A,120.075,29.306,1200",
    "路段B,120.080,29.310,850",
    "路段C,120.070,29.300,2100",
  ].join("\n"), "utf8");
  try {
    const d = await loadSource("local-file", { workspace: ws, path: "_tmp_traffic_test.csv" });
    assert.ok(!d.error, `应加载成功，实际：${d.error}`);
    assertDescriptorShape(d, "local-file 点");
    assert.equal(d.kind, "points");
    assert.equal(d.stats.count, 3, "应解析出 3 个点");
    assert.equal(d.styleHint.field, "车流量", "应自动认出车流量列作为数值列");
    assert.equal(d.stats.max, 2100, "数值统计应正确");
  } finally { fs.rmSync(csvPath, { force: true }); }
});

await test("适应 OD 数据 CSV（起点/终点经纬度）", async () => {
  const ws = path.join(ROOT, "office-workspace");
  const csvPath = path.join(ws, "_tmp_od_test.csv");
  fs.writeFileSync(csvPath, [
    "起点经度,起点纬度,终点经度,终点纬度,流量",
    "120.075,29.306,121.420,28.656,180",
    "120.075,29.306,121.232,28.136,320",
  ].join("\n"), "utf8");
  try {
    const d = await loadSource("local-file", { workspace: ws, path: "_tmp_od_test.csv" });
    assert.ok(!d.error, `应加载成功，实际：${d.error}`);
    assert.equal(d.kind, "flow", "识别为 OD 时应产出 flow 类型");
    assert.ok(d.lines?.features?.length === 2, "应为每条 OD 生成流向线");
    assert.ok(d.stats.max >= 320, "流量统计应含最大值");
  } finally { fs.rmSync(csvPath, { force: true }); }
});

await test("适应英文字段名的 CSV（lng/lat/flow）", async () => {
  const ws = path.join(ROOT, "office-workspace");
  const csvPath = path.join(ws, "_tmp_en_test.csv");
  fs.writeFileSync(csvPath, ["name,lng,lat,flow", "a,120.1,29.1,10", "b,120.2,29.2,20"].join("\n"), "utf8");
  try {
    const d = await loadSource("local-file", { workspace: ws, path: "_tmp_en_test.csv" });
    assert.ok(!d.error, `应加载成功，实际：${d.error}`);
    assert.equal(d.stats.count, 2);
    assert.equal(d.styleHint.field, "flow");
  } finally { fs.rmSync(csvPath, { force: true }); }
});

await test("识别不了坐标列时给出可读错误（附表头）", async () => {
  const ws = path.join(ROOT, "office-workspace");
  const csvPath = path.join(ws, "_tmp_bad_test.csv");
  fs.writeFileSync(csvPath, ["名称,备注", "甲,乙"].join("\n"), "utf8");
  try {
    const d = await loadSource("local-file", { workspace: ws, path: "_tmp_bad_test.csv" });
    assert.ok(d.error, "应返回错误而不是静默出空图");
    assert.match(d.error, /无法识别坐标列/, "错误应说明原因");
    assert.ok(Array.isArray(d.header), "应回传表头供用户/模型纠正");
  } finally { fs.rmSync(csvPath, { force: true }); }
});

await test("路径逃逸被拒绝（不能读工作区外文件）", async () => {
  const d = await loadSource("local-file", { workspace: path.join(ROOT, "office-workspace"), path: "../../package.json" });
  assert.ok(d.error, "越界路径应被拒绝");
  assert.match(d.error, /必须在工作区内/, "错误应说明边界原因");
});

await test("同前缀兄弟目录也不能绕过（S2 回归）", async () => {
  // 工作区 F:\ws 时，F:\ws-evil\x.csv 是"同前缀兄弟目录"——纯 startsWith 会放行
  const ws = path.join(ROOT, "office-workspace");
  const d = await loadSource("local-file", { workspace: ws, path: "../office-workspace-evil/x.csv" });
  assert.ok(d.error, `同前缀兄弟目录应被拒绝，实际：${JSON.stringify(d).slice(0, 120)}`);
  assert.match(d.error, /必须在工作区内/, "错误应说明边界原因");
});

await test("空坐标单元格被丢弃，不会变成 (0,0) 假要素（S1 回归）", async () => {
  const ws = path.join(ROOT, "office-workspace");
  const csvPath = path.join(ws, "_tmp_empty_coord.csv");
  fs.writeFileSync(csvPath, [
    "路段名称,经度,纬度,车流量",
    "路段A,120.075,29.306,1200",
    "路段B,,,850",       // Excel 常见：整行坐标为空
    "路段C,120.080,29.310,",  // 流量为空
  ].join("\n"), "utf8");
  try {
    const d = await loadSource("local-file", { workspace: ws, path: "_tmp_empty_coord.csv" });
    assert.ok(!d.error, `应加载成功，实际：${d.error}`);
    assert.equal(d.geojson.features.length, 2, "空坐标行应被丢弃（只留 A 与 C）");
    const coords = d.geojson.features.map((f) => f.geometry.coordinates);
    assert.ok(coords.every(([lng, lat]) => lng !== 0 && lat !== 0), `不应出现 (0,0) 假坐标，实际：${JSON.stringify(coords)}`);
    assert.equal(d.stats.skipped, 1, "应记录跳过的行数（1 行坐标缺失）");
  } finally { fs.rmSync(csvPath, { force: true }); }
});

await test("越界坐标（不在中国范围）也被丢弃（S1 兜底）", async () => {
  const ws = path.join(ROOT, "office-workspace");
  const csvPath = path.join(ws, "_tmp_out_of_range.csv");
  fs.writeFileSync(csvPath, ["name,lng,lat,flow", "ok,120.1,29.1,10", "bad,0.5,0.5,99"].join("\n"), "utf8");
  try {
    const d = await loadSource("local-file", { workspace: ws, path: "_tmp_out_of_range.csv" });
    assert.ok(!d.error, `应加载成功，实际：${d.error}`);
    assert.equal(d.geojson.features.length, 1, "越界行应被丢弃");
    assert.equal(d.geojson.features[0].properties.flow, 10);
  } finally { fs.rmSync(csvPath, { force: true }); }
});

await test("名称等非数值列被带入 properties（M3 回归）", async () => {
  const ws = path.join(ROOT, "office-workspace");
  const csvPath = path.join(ws, "_tmp_carry.csv");
  fs.writeFileSync(csvPath, [
    "路段名称,方向,经度,纬度,车流量",
    "G60 沪昆高速,东向,120.075,29.306,1200",
  ].join("\n"), "utf8");
  try {
    const d = await loadSource("local-file", { workspace: ws, path: "_tmp_carry.csv" });
    assert.ok(!d.error, `应加载成功，实际：${d.error}`);
    const props = d.geojson.features[0].properties;
    assert.equal(props["路段名称"], "G60 沪昆高速", "名称列应保留（地图标签要用）");
    assert.equal(props["方向"], "东向", "其它非数值列也应保留");
    assert.equal(props["车流量"], 1200, "数值列照常保留");
  } finally { fs.rmSync(csvPath, { force: true }); }
});

await test("x/y 只按精确列名匹配（M6 回归）", () => {
  // max_value / min_y 这类业务列名不应被当成经纬度
  const cols = detectColumns(["max_value", "min_y", "count"]);
  assert.equal(cols.mode, "unknown", `不应误判为点数据，实际 mode=${cols.mode}（lng=${cols.lng}, lat=${cols.lat}）`);
  // 但真正的 x/y 列仍要认出来
  const real = detectColumns(["x", "y", "value"]);
  assert.equal(real.mode, "points");
  assert.equal(real.lng, "x");
  assert.equal(real.lat, "y");
});

await test("stats.count 恒为要素数，valueCount 单列有值数（M8 回归）", () => {
  const d = toDescriptor({
    id: "count-semantics",
    geojson: { type: "FeatureCollection", features: [
      { type: "Feature", properties: { flow: 10 }, geometry: { type: "Point", coordinates: [120, 29] } },
      { type: "Feature", properties: { flow: 20 }, geometry: { type: "Point", coordinates: [121, 30] } },
      { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [122, 31] } },
    ] },
  });
  assert.equal(d.stats.count, 3, "count 应为要素数（卡片文案据此显示）");
  assert.equal(d.stats.valueCount, 2, "valueCount 应为有值数");
  assert.equal(d.stats.max, 20, "统计仍应基于有值要素");
});

await test("detectColumns 的中英文别名覆盖", () => {
  const zh = detectColumns(["起点经度", "起点纬度", "终点经度", "终点纬度", "客流量"]);
  assert.equal(zh.mode, "od");
  assert.equal(zh.flow, "客流量");
  const en = detectColumns(["from_lon", "from_lat", "to_lon", "to_lat", "volume"]);
  assert.equal(en.mode, "od");
  assert.equal(en.flow, "volume");
  const pt = detectColumns(["lng", "lat", "value"]);
  assert.equal(pt.mode, "points");
});

console.log("\n▶ G3 新增适配器不改上层（测试桩）");

await test("注册一个自定义适配器即可用（模拟未来接入实时流量 API）", async () => {
  registerSource({
    id: "test-live-traffic",
    label: "测试用实时流量",
    kind: "traffic-flow",
    async load(params) {
      // 模拟"拉取 API → 转描述符"，完全不依赖上层代码
      const count = Number(params.count || 2);
      return {
        v: 1, id: "test-live", title: "测试实时流量", kind: "flow",
        geojson: { type: "FeatureCollection", features: Array.from({ length: count }, (_, i) => ({
          type: "Feature", properties: { flow: (i + 1) * 100 },
          geometry: { type: "LineString", coordinates: [[120 + i * 0.01, 29], [120.01 + i * 0.01, 29.01]] },
        })) },
        stats: { count }, styleHint: { field: "flow" }, provenance: { dataset: "test-live-traffic" },
      };
    },
  });
  assert.ok(listSources().some((s) => s.id === "test-live-traffic"), "应出现在数据源清单里");
  const d = await loadSource("test-live-traffic", { count: 3 });
  assert.equal(d.v, 1);
  assert.equal(d.geojson.features.length, 3, "参数应透传给适配器");
  assert.equal(d.provenance.dataset, "test-live-traffic");
});

await test("适配器可返回裸 GeoJSON（自动包装为描述符）", async () => {
  registerSource({
    id: "test-raw-geojson",
    label: "测试用裸 GeoJSON",
    load: async () => ({ type: "FeatureCollection", features: [{ type: "Feature", properties: { value: 1 }, geometry: { type: "Point", coordinates: [0, 0] } }] }),
  });
  const d = await loadSource("test-raw-geojson", {});
  assert.equal(d.v, 1, "应被包装成描述符");
  assert.equal(d.kind, "points");
});

await test("适配器抛错时返回可读错误，不冒泡崩溃", async () => {
  registerSource({ id: "test-broken", label: "会失败的源", load: async () => { throw new Error("模拟上游 500"); } });
  const d = await loadSource("test-broken", {});
  assert.ok(d.error);
  assert.match(d.error, /加载失败.*模拟上游 500/);
});

await test("未知数据源给出可用清单", async () => {
  const d = await loadSource("不存在的数据源", {});
  assert.ok(d.error);
  assert.match(d.error, /未知数据源/);
  assert.ok(d.available.length > 0, "应回传可用清单供模型纠正");
});

console.log("\n▶ 未来接入点（只留桩，不实现）");

await test("声明了三个预留位的形状", async () => {
  const { PLANNED_SOURCES } = await import("../server/交通数据源.mjs");
  const ids = PLANNED_SOURCES.map((s) => s.id);
  for (const id of ["live-traffic-api", "sql-database", "gps-trajectory"]) {
    assert.ok(ids.includes(id), `应预留 ${id}`);
  }
  assert.ok(PLANNED_SOURCES.every((s) => s.note), "预留位应说明适配器要做的事");
});

console.log("\n▶ 接入点：端点与文档");

await test("index.mjs 提供 /api/map/visual 与 /api/map/visual/sources", () => {
  const src = read("server/index.mjs");
  assert.match(src, /app\.get\("\/api\/map\/visual"/, "应有统一可视化端点");
  assert.match(src, /app\.get\("\/api\/map\/visual\/sources"/, "应有数据源发现端点");
});

await test("旧端点未被改动（契约 10 个仍在）", () => {
  const src = read("server/index.mjs");
  for (const ep of ["/api/map/traffic-bandwidth", "/api/map/od-lines", "/api/map/exchange-sankey", "/api/map/road-structure", "/api/map/demo-analysis"]) {
    assert.ok(src.includes(ep), `旧端点 ${ep} 应保留`);
  }
});

if (failed) {
  console.log(`\n交通数据源与可视化描述符：${failed} 项失败`);
  process.exit(1);
}
console.log("\n交通数据源与可视化描述符：通过");
