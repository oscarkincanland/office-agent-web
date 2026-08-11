#!/usr/bin/env node
/**
 * 准备浙江省地图图层数据（从 OSM 原始数据裁剪 + 简化）
 *
 * 数据源（本地已有）:
 *   ../全省高速公路可视化/浙江省高速矢量数据/浙江省高速公路数据.geojson  (48,072 条线)
 *   ../全省高速公路可视化/浙江省高速矢量数据/浙江省高速收费站.geojson    (1,522 点)
 *   ../全省高速公路可视化/浙江省高速矢量数据/浙江省高速枢纽.geojson      (1,208 点)
 *
 * 输出:
 *   office-workspace/maps/zhejiang-map/layers/
 *     highways.geojson      高速公路 (motorway + motorway_link)
 *     roads-trunk.geojson   国省道/快速路 (trunk + trunk_link)
 *     toll-stations.geojson 收费站
 *     junctions.geojson     枢纽/互通
 *
 * 用法: node scripts/prepare-map-data.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const SRC = path.resolve(PROJECT_DIR, "..", "全省高速公路可视化", "浙江省高速矢量数据");
const LAYERS_DIR = path.join(PROJECT_DIR, "office-workspace", "maps", "zhejiang-map", "layers");

fs.mkdirSync(LAYERS_DIR, { recursive: true });

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

function load(name) {
  const p = path.join(SRC, name);
  if (!fs.existsSync(p)) {
    console.error(`✗ 缺少数据源: ${p}`);
    return null;
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function write(name, fc) {
  const p = path.join(LAYERS_DIR, name);
  fs.writeFileSync(p, JSON.stringify(fc));
  console.log(`  ✅ ${name}  ${fc.features.length} 要素  ${(fs.statSync(p).size / 1024).toFixed(1)} KB`);
}

async function main() {
  console.log("① 高速公路 + 国省道（按 OSM highway 标签拆分）…");
  const roads = load("浙江省高速公路数据.geojson");
  if (roads) {
    const motorways = [];
    const trunks = [];
    for (const f of roads.features) {
      const h = f.properties.highway || "";
      const coords = f.geometry?.coordinates;
      if (!coords) continue;
      const props = {
        name: f.properties.name || "",
        ref: f.properties.ref || "",
        highway: h,
        lanes: f.properties.lanes || "",
        maxspeed: f.properties.maxspeed || "",
        flow_avg: f.properties.flow_avg || "",
      };
      if (h === "motorway" || h === "motorway_link") {
        motorways.push({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: simplifyLine(coords, 0.05) } });
      } else if (h === "trunk" || h === "trunk_link") {
        trunks.push({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: simplifyLine(coords, 0.05) } });
      }
    }
    write("highways.geojson", toFC(motorways));
    write("roads-trunk.geojson", toFC(trunks));
  }

  console.log("② 收费站…");
  const tolls = load("浙江省高速收费站.geojson");
  if (tolls) {
    const feats = tolls.features
      .filter((f) => f.properties?.name)
      .map((f) => ({ type: "Feature", properties: { name: f.properties.name }, geometry: f.geometry }));
    write("toll-stations.geojson", toFC(feats));
  }

  console.log("③ 枢纽/互通…");
  const hubs = load("浙江省高速枢纽.geojson");
  if (hubs) {
    const feats = hubs.features
      .filter((f) => f.properties?.name)
      .map((f) => ({ type: "Feature", properties: { name: f.properties.name }, geometry: f.geometry }));
    write("junctions.geojson", toFC(feats));
  }

  console.log("\n完成。运行 `node scripts/build-vector-tiles.mjs` 生成矢量瓦片。");
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
