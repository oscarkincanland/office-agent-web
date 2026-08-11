#!/usr/bin/env node
/**
 * 准备浙江省地图图层数据（矢量数据 → 简化 → 输出到项目 layers/）
 *
 * 用法: node scripts/prepare-map-data.mjs [数据源目录]
 *
 * 数据源目录（默认 ../全省高速公路可视化/浙江省高速矢量数据，可传任意目录）：
 *   按文件名关键词自动匹配（不区分大小写）：
 *     高速        → highways.geojson        高速公路
 *     国省道|省道|国道|trunk → roads-trunk.geojson  国省道/快速路
 *     农村公路|县道|乡道  → roads-rural.geojson     农村公路
 *     收费站      → toll-stations.geojson   收费站
 *     枢纽|互通   → junctions.geojson       枢纽/互通
 *     边界|区县|行政区划 → boundary-county.geojson  区县边界（也可直接用 fetch-boundaries.mjs 拉取）
 *   若文件名不含以上关键词，则要求文件名为规范名（highways/roads-trunk/roads-rural/...）。
 *   对 OSM 标签数据（properties.highway），自动按 motorway/trunk/其他 拆分。
 *
 * 输出:
 *   office-workspace/maps/zhejiang-map/layers/*.geojson
 *
 * 之后运行 `node scripts/build-vector-tiles.mjs` 生成矢量瓦片。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const DEFAULT_SRC = path.resolve(PROJECT_DIR, "..", "全省高速公路可视化", "浙江省高速矢量数据");
const SRC = path.resolve(process.argv[2] || DEFAULT_SRC);
const LAYERS_DIR = path.join(PROJECT_DIR, "office-workspace", "maps", "zhejiang-map", "layers");

fs.mkdirSync(LAYERS_DIR, { recursive: true });
if (!fs.existsSync(SRC)) {
  console.error(`✗ 数据源目录不存在: ${SRC}`);
  console.error("  用法: node scripts/prepare-map-data.mjs [数据源目录]");
  process.exit(1);
}

/** 抽稀线坐标：按比例均匀取点（保留首尾） */
function simplifyLine(coords, keep = 0.05) {
  if (coords.length <= 4) return coords;
  const step = Math.max(1, Math.floor(coords.length * keep));
  const out = [coords[0]];
  for (let i = step; i < coords.length - 1; i += step) out.push(coords[i]);
  out.push(coords[coords.length - 1]);
  return out;
}

function toFC(features) {
  return { type: "FeatureCollection", features };
}

/** 从数据源目录收集 .geojson/.json 文件 */
function listSources() {
  return fs
    .readdirSync(SRC)
    .filter((f) => /\.(geojson|json)$/i.test(f) && !f.startsWith("."))
    .sort();
}

/** 按关键词匹配数据源文件 */
function findSource(files, keywords, canonical) {
  const hit = files.find((f) => keywords.some((k) => f.toLowerCase().includes(k)));
  if (hit) return hit;
  const c = files.find((f) => f.toLowerCase().startsWith(canonical));
  return c || null;
}

function load(name) {
  const p = path.join(SRC, name);
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`✗ 读取失败 ${p}: ${e.message}`);
    return null;
  }
}

function write(name, fc) {
  const p = path.join(LAYERS_DIR, name);
  fs.writeFileSync(p, JSON.stringify(fc));
  console.log(`  ✅ ${name}  ${fc.features.length} 要素  ${(fs.statSync(p).size / 1024).toFixed(1)} KB`);
}

const ROAD_PROPS = (p) => ({
  name: p.name || "",
  ref: p.ref || "",
  highway: p.highway || "",
  lanes: p.lanes || "",
  maxspeed: p.maxspeed || "",
  flow_avg: p.flow_avg || "",
});

function lineFeat(f, props = {}) {
  const coords = f.geometry?.coordinates;
  if (!coords) return null;
  return {
    type: "Feature",
    properties: { ...ROAD_PROPS(f.properties), ...props },
    geometry: { type: "LineString", coordinates: simplifyLine(coords, 0.05) },
  };
}

function pointFeat(f) {
  if (!f.properties?.name) return null;
  return { type: "Feature", properties: { name: f.properties.name }, geometry: f.geometry };
}

function main() {
  console.log(`数据源目录: ${SRC}\n`);
  const files = listSources();
  if (!files.length) {
    console.error("✗ 数据源目录中没有 .geojson/.json 文件");
    process.exit(1);
  }
  console.log(`找到 ${files.length} 个数据文件:\n${files.map((f) => "  " + f).join("\n")}\n`);

  // ① 高速公路（motorway）→ highways
  const motorSrc = findSource(files, ["高速"], "highways");
  if (motorSrc) {
    const data = load(motorSrc);
    if (data) {
      const feats = [];
      for (const f of data.features) {
        const h = (f.properties?.highway || "").toLowerCase();
        if (h && !h.startsWith("motorway")) continue; // OSM 标签数据按类型拆分
        const feat = lineFeat(f);
        if (feat) feats.push(feat);
      }
      if (feats.length) write("highways.geojson", toFC(feats));
      else console.log("  ⚠ 高速公路源文件中未提取到 motorway 要素");
    }
  } else {
    console.log("  ⚠ 未找到高速公路数据（关键词：高速）");
  }

  // ② 国省道/快速路（trunk）→ roads-trunk（无独立文件时回退到高速源文件，兼容单文件混合路网）
  const trunkSrc = findSource(files, ["国省道", "省道", "国道", "trunk"], "roads-trunk") || motorSrc;
  if (trunkSrc) {
    const data = load(trunkSrc);
    if (data) {
      const feats = [];
      for (const f of data.features) {
        const h = (f.properties?.highway || "").toLowerCase();
        if (h && !h.startsWith("trunk")) continue;
        const feat = lineFeat(f);
        if (feat) feats.push(feat);
      }
      if (feats.length) write("roads-trunk.geojson", toFC(feats));
      else console.log("  ⚠ 未从路网数据中提取到 trunk 要素（国省道）");
    }
  } else {
    console.log("  ⚠ 未找到国省道数据（关键词：国省道/省道/国道/trunk）");
  }

  // ③ 农村公路 → roads-rural（无独立文件时回退到高速源文件，排除高速/国省道后剩余即农村公路）
  const ruralSrc = findSource(files, ["农村公路", "县道", "乡道", "rural"], "roads-rural") || motorSrc;
  if (ruralSrc) {
    const data = load(ruralSrc);
    if (data) {
      const feats = [];
      for (const f of data.features) {
        const h = (f.properties?.highway || "").toLowerCase();
        if (h && (h.startsWith("motorway") || h.startsWith("trunk"))) continue; // 排除高速/国省道
        const feat = lineFeat(f);
        if (feat) feats.push(feat);
      }
      if (feats.length) write("roads-rural.geojson", toFC(feats));
      else console.log("  ⚠ 未从路网数据中提取到农村公路要素");
    }
  } else {
    console.log("  ⚠ 未找到农村公路数据（关键词：农村公路/县道/乡道）");
  }

  // ④ 收费站
  const tollSrc = findSource(files, ["收费站", "toll"], "toll-stations");
  if (tollSrc) {
    const data = load(tollSrc);
    if (data) {
      const feats = data.features.map(pointFeat).filter(Boolean);
      write("toll-stations.geojson", toFC(feats));
    }
  } else {
    console.log("  ⚠ 未找到收费站数据（关键词：收费站）");
  }

  // ⑤ 枢纽/互通
  const hubSrc = findSource(files, ["枢纽", "互通", "junction"], "junctions");
  if (hubSrc) {
    const data = load(hubSrc);
    if (data) {
      const feats = data.features.map(pointFeat).filter(Boolean);
      write("junctions.geojson", toFC(feats));
    }
  } else {
    console.log("  ⚠ 未找到枢纽数据（关键词：枢纽/互通）");
  }

  // ⑥ 区县边界（可选；通常用 fetch-boundaries.mjs 拉取）
  const bndSrc = findSource(files, ["边界", "行政区划", "boundary"], "boundary-county");
  if (bndSrc) {
    const data = load(bndSrc);
    if (data && data.features?.length) write("boundary-county.geojson", data);
    else console.log("  ⚠ 边界数据为空");
  } else {
    console.log("  ⚠ 未找到边界数据（可用 scripts/fetch-boundaries.mjs 从 DataV 拉取）");
  }

  console.log("\n完成。运行 `node scripts/build-vector-tiles.mjs` 生成矢量瓦片。");
}

main();
