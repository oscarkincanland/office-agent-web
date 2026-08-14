#!/usr/bin/env node
/**
 * 接入全省基础数据 → 浙江省交通基础数据沙盘
 *
 * 数据源: E:\老电脑文件\工作\全省基础数据\基础数据
 *   - 高速公路（带流量，含 flow_avg/flow_max/flow_min）→ highways
 *   - 高速收费站 → toll-stations / 高速枢纽 → junctions
 *   - 国道（SHP）→ roads-trunk
 *   - 省道（SHP）→ roads-province（新图层）
 *   - 地市/区县边界 → 由 fetch-boundaries.mjs（DataV）生成
 *
 * 用法: node scripts/接入全省基础数据.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const MAPS_DIR = path.join(PROJECT_DIR, "office-workspace", "maps", "zhejiang-map");
const LAYERS_DIR = path.join(MAPS_DIR, "layers");
// shpjs 装在 client 依赖里，通过 client 的 package.json 解析
const clientRequire = createRequire(path.join(PROJECT_DIR, "client", "package.json"));
const shp = clientRequire("shpjs");

const SRC = "E:/老电脑文件/工作/全省基础数据/基础数据";
const HIGHWAY_DIR = path.join(SRC, "浙江省高速矢量数据");

async function shpToGeoJSON(basePath, fieldMap = null, forceCpg = null) {
  const readAB = (p) => {
    if (!fs.existsSync(p)) return undefined;
    const buf = fs.readFileSync(p);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  };
  const geometries = shp.parseShp(readAB(basePath + ".shp")); // 同步：几何数组
  // dbf 编码：forceCpg 优先，否则读 .cpg 文件，默认 UTF-8
  let cpg = forceCpg;
  if (!cpg) {
    try { cpg = fs.readFileSync(basePath + ".cpg", "utf8").trim(); } catch {}
  }
  const props = (await shp.parseDbf(readAB(basePath + ".dbf"), cpg || "UTF-8")) || [];
  const geojson = shp.combine([geometries, props]);
  // 归一标号字段：ref（路线编号 G104/S309 样式，支持模糊/值匹配）+ name（中文路名）
  if (geojson.features?.length) {
    const first = geojson.features[0].properties || {};
    const keys = Object.keys(first);
    const pick = (hint, pattern) => {
      if (hint && keys.includes(hint)) return hint;
      const exact = hint ? keys.find((k) => k.includes(hint.slice(0, 2))) : null;
      return exact || keys.find((k) => pattern.test(String(first[k] ?? "")));
    };
    const refKey = pick(fieldMap?.ref, /^[A-Z]{1,2}\d/);
    const nameKey = fieldMap?.name === fieldMap?.ref
      ? refKey
      : keys.find((k) => k !== refKey && /[\u4e00-\u9fff]/.test(String(first[k] ?? "")) && /线|道|路/.test(String(first[k] ?? ""))) || null;
    for (const f of geojson.features) {
      const p = f.properties || {};
      if (refKey && p[refKey] !== undefined) p.ref = p[refKey];
      if (nameKey && p[nameKey] !== undefined && nameKey !== refKey) p.name = p[nameKey];
      delete p.Shape_Leng;
    }
  }
  return geojson;
}

function statMB(p) {
  if (!fs.existsSync(p)) return "缺失";
  return (fs.statSync(p).size / 1024 / 1024).toFixed(1) + " MB";
}

async function main() {
  fs.mkdirSync(LAYERS_DIR, { recursive: true });
  console.log("① 高速公路（纯高速，含 name/ref 编号）→ highways");
  const hw = path.join(HIGHWAY_DIR, "浙江省高速公路_纯高速.geojson");
  fs.copyFileSync(hw, path.join(LAYERS_DIR, "highways.geojson"));
  console.log(`   ✓ ${statMB(hw)}（纯 motorway，含 ref/name 可做标号）`);

  console.log("② 高速收费站 → toll-stations / 高速枢纽 → junctions");
  fs.copyFileSync(path.join(HIGHWAY_DIR, "浙江省高速收费站.geojson"), path.join(LAYERS_DIR, "toll-stations.geojson"));
  fs.copyFileSync(path.join(HIGHWAY_DIR, "浙江省高速枢纽.geojson"), path.join(LAYERS_DIR, "junctions.geojson"));
  console.log("   ✓ 收费站 / 枢纽");

  console.log("③ 国道（SHP→GeoJSON）→ roads-trunk");
  // 国道 dbf 为 UTF-8（字段名因 dbf 11 字节限制截断，值完整；标号字段按值模式自动识别）
  const gd = await shpToGeoJSON(path.join(SRC, "国道", "国道"), { ref: "路线编码", name: "路线名称" });
  fs.writeFileSync(path.join(LAYERS_DIR, "roads-trunk.geojson"), JSON.stringify(gd));
  console.log(`   ✓ 国道 ${gd.features?.length || 0} 要素（ref=${gd.features?.[0]?.properties?.ref}）`);

  console.log("④ 省道（SHP→GeoJSON）→ roads-province");
  const sd = await shpToGeoJSON(path.join(SRC, "省道", "报自然资源厅省道网规划矢量数据"), { ref: "YSMC", name: "YSMC" });
  fs.writeFileSync(path.join(LAYERS_DIR, "roads-province.geojson"), JSON.stringify(sd));
  console.log(`   ✓ 省道 ${sd.features?.length || 0} 要素（ref=${sd.features?.[0]?.properties?.ref}）`);

  // ⑤ 注册 roads-province 到 config.layers（其余图层 LAYER_DEFS 已内置）
  const cfgPath = path.join(MAPS_DIR, "map.config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  if (!cfg.layers.some((l) => l.id === "roads-province")) {
    cfg.layers.push({
      id: "roads-province",
      name: "省道",
      type: "road",
      group: "公路网",
      visible: true,
      minzoom: 5,
      maxzoom: 13,
    });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    console.log("   ✓ config.layers 已注册 roads-province（省道）");
  }

  console.log("\n完成。运行 `node scripts/fetch-boundaries.mjs` 拉取市县边界，再 `node scripts/build-vector-tiles.mjs --force` 重建瓦片。");
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
