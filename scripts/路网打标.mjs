#!/usr/bin/env node
/**
 * 路网行政编码打标：给高速/国道/省道线要素打 adcode（县区编码）与 city_code（地市编码）
 *
 * 方法：线中点 → 点在多边形内判断（射线法，bbox 粗筛加速）
 * 输入: layers/boundary-city.geojson + layers/boundary-county.geojson（含 adcode/name）
 * 输出: 改写 layers/highways|roads-trunk|roads-province.geojson（新增 adcode/county_name/city_code/city_name）
 * 用法: node scripts/路网打标.mjs   （之后需重建瓦片）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAYERS_DIR = path.resolve(__dirname, "..", "office-workspace", "maps", "zhejiang-map", "layers");

const TARGETS = ["highways", "roads-trunk", "roads-province"];

/** 点在多边形（单环）内：射线法 */
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygon(lng, lat, geom) {
  if (!geom) return false;
  if (geom.type === "Polygon") return geom.coordinates.some((ring) => pointInRing(lng, lat, ring));
  if (geom.type === "MultiPolygon") return geom.coordinates.some((poly) => poly.some((ring) => pointInRing(lng, lat, ring)));
  return false;
}

function bboxOf(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (coords) => {
    if (typeof coords[0] === "number") {
      const [x, y] = coords;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    } else coords.forEach(walk);
  };
  walk(geom.coordinates);
  return [minX, minY, maxX, maxY];
}

/** 线要素中点（MultiLineString 取第一段） */
function lineMidpoint(geom) {
  if (!geom || !geom.coordinates) return null;
  const line = geom.type === "MultiLineString" ? geom.coordinates[0] : geom.coordinates;
  if (!line?.length) return null;
  const a = line[0];
  const b = line[line.length - 1];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function buildIndex(fc) {
  return (fc?.features || [])
    .filter((f) => f.geometry)
    .map((f) => ({
      adcode: f.properties?.adcode,
      name: f.properties?.name,
      geom: f.geometry,
      bbox: bboxOf(f.geometry),
    }));
}

function locate(pt, index) {
  const [x, y] = pt;
  for (const it of index) {
    const [bx0, by0, bx1, by1] = it.bbox;
    if (x < bx0 || x > bx1 || y < by0 || y > by1) continue;
    if (pointInPolygon(x, y, it.geom)) return it;
  }
  return null;
}

function main() {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(LAYERS_DIR, f), "utf8"));
  // 边界 adcode 统一为字符串（DataV 源是 number，MapLibre filter 严格区分类型）
  for (const f of ["boundary-city.geojson", "boundary-county.geojson"]) {
    const fc = read(f);
    for (const feat of fc.features) {
      if (feat.properties?.adcode !== undefined) feat.properties.adcode = String(feat.properties.adcode);
    }
    fs.writeFileSync(path.join(LAYERS_DIR, f), JSON.stringify(fc));
  }
  const cityIdx = buildIndex(read("boundary-city.geojson"));
  const countyIdx = buildIndex(read("boundary-county.geojson"));
  console.log(`索引: 市 ${cityIdx.length} 个 / 县区 ${countyIdx.length} 个`);

  for (const id of TARGETS) {
    const p = path.join(LAYERS_DIR, `${id}.geojson`);
    if (!fs.existsSync(p)) { console.log(`${id}: 无文件，跳过`); continue; }
    const fc = JSON.parse(fs.readFileSync(p, "utf8"));
    let hit = 0;
    for (const f of fc.features) {
      const pt = lineMidpoint(f.geometry);
      if (!pt) continue;
      const county = locate(pt, countyIdx);
      const city = locate(pt, cityIdx);
      const pr = f.properties || (f.properties = {});
      if (county) { pr.adcode = String(county.adcode); pr.county_name = county.name; hit++; }
      if (city) { pr.city_code = String(city.adcode); pr.city_name = city.name; }
    }
    fs.writeFileSync(p, JSON.stringify(fc));
    const withCode = fc.features.filter((f) => f.properties?.adcode).length;
    console.log(`${id}: ${fc.features.length} 要素，命中县区 ${withCode}（${Math.round((withCode / fc.features.length) * 100)}%）`);
  }
  console.log("\n完成。运行 build-vector-tiles.mjs --force 重建瓦片后即可按 adcode/city_code 下钻过滤。");
}

main();
