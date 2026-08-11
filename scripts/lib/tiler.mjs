#!/usr/bin/env node
/**
 * 矢量瓦片生成库（CLI 与 server/map.mjs 共用）
 *
 * 输入: {projectDir}/layers/*.geojson
 * 输出: {projectDir}/tiles/{layer}/{z}/{x}/{y}.pbf
 */
import fs from "node:fs";
import path from "node:path";
import geojsonvt from "geojson-vt";
import vtpbf from "vt-pbf";

/** 内置图层切片参数 */
export const LAYER_DEFS = [
  { id: "boundary-city",    minzoom: 0, maxzoom: 9,  tolerance: 0.0002, name: "地市边界", type: "boundary" },
  { id: "boundary-county",  minzoom: 0, maxzoom: 11, tolerance: 0.0002, name: "区县边界", type: "boundary" },
  { id: "highways",         minzoom: 5, maxzoom: 13, tolerance: 0.0001, name: "高速公路", type: "road" },
  { id: "roads-trunk",      minzoom: 5, maxzoom: 13, tolerance: 0.0001, name: "国省道", type: "road" },
  { id: "toll-stations",    minzoom: 5, maxzoom: 14, tolerance: 0.00001, name: "收费站", type: "point" },
  { id: "junctions",        minzoom: 5, maxzoom: 14, tolerance: 0.00001, name: "枢纽", type: "point" },
];

function recursiveSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += recursiveSize(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

function walk(index, z, x, y, minz, maxz, layerDir) {
  let tile;
  try { tile = index.getTile(z, x, y); } catch { return; }
  if (!tile || !tile.features || !tile.features.length) return;
  if (z >= minz) {
    const buf = vtpbf.fromGeojsonVt({ [index.name]: tile });
    const dir = path.join(layerDir, String(z), String(x));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${y}.pbf`), buf);
  }
  if (z >= maxz) return;
  for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    walk(index, z + 1, x * 2 + cx, y * 2 + cy, minz, maxz, layerDir);
  }
}

/** 为单个图层生成瓦片。返回 {count, bytes} */
export function buildLayerTiles(projectDir, def, { force = false } = {}) {
  const srcPath = path.join(projectDir, "layers", `${def.id}.geojson`);
  if (!fs.existsSync(srcPath)) return { count: 0, bytes: 0, skipped: true };
  const data = JSON.parse(fs.readFileSync(srcPath, "utf8"));
  const index = geojsonvt(data, {
    maxZoom: def.maxzoom,
    tolerance: def.tolerance,
    buffer: 64,
    indexMaxZoom: def.maxzoom,
    indexMaxPoints: 1000000,
  });
  index.name = def.id;
  const layerDir = path.join(projectDir, "tiles", def.id);
  if (force && fs.existsSync(layerDir)) fs.rmSync(layerDir, { recursive: true });
  walk(index, 0, 0, 0, def.minzoom, def.maxzoom, layerDir);
  const bytes = fs.existsSync(layerDir) ? recursiveSize(layerDir) : 0;
  return { count: countTiles(layerDir), bytes };
}

function countTiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countTiles(path.join(dir, e.name));
    else if (e.name.endsWith(".pbf")) n++;
  }
  return n;
}

/** 为项目内所有（或指定）图层生成瓦片 */
export function buildProjectTiles(projectDir, { layerIds = null, force = false, defs = LAYER_DEFS } = {}) {
  const targets = defs.filter((d) => !layerIds || layerIds.includes(d.id));
  const results = {};
  for (const def of targets) {
    results[def.id] = buildLayerTiles(projectDir, def, { force });
  }
  return results;
}
