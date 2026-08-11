#!/usr/bin/env node
/**
 * 下载浙江省地市级 + 区县级行政边界（DataV GeoAtlas）
 *
 * 数据源: https://geo.datav.aliyun.com/areas_v3/bound/{adcode}_full.json
 *   - 330000_full.json      → 浙江省 11 个地级市
 *   - {地市}_full.json      → 每个地市的区县（合并后 ≈90 个区县）
 *
 * 输出:
 *   office-workspace/maps/zhejiang-map/layers/boundary-city.geojson
 *   office-workspace/maps/zhejiang-map/layers/boundary-county.geojson
 *
 * 用法: node scripts/fetch-boundaries.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const MAPS_DIR = path.join(PROJECT_DIR, "office-workspace", "maps", "zhejiang-map");
const LAYERS_DIR = path.join(MAPS_DIR, "layers");

const BASE = "https://geo.datav.aliyun.com/areas_v3/bound";
const ZJ = "330000";

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

function simplify(fc, keep = 0.001) {
  const ringSimplify = (ring) => {
    if (ring.length <= 4) return ring;
    const step = Math.max(1, Math.floor(ring.length * keep));
    const out = [ring[0]];
    for (let i = step; i < ring.length - 1; i += step) out.push(ring[i]);
    out.push(ring[ring.length - 1]);
    return out;
  };
  const geomSimplify = (g) => {
    if (!g) return g;
    if (g.type === "Polygon") return { ...g, coordinates: g.coordinates.map(ringSimplify) };
    if (g.type === "MultiPolygon") return { ...g, coordinates: g.coordinates.map((poly) => poly.map(ringSimplify)) };
    return g;
  };
  return {
    type: "FeatureCollection",
    features: fc.features.map((f) => ({
      type: "Feature",
      properties: { ...f.properties },
      geometry: geomSimplify(f.geometry),
    })),
  };
}

async function main() {
  fs.mkdirSync(LAYERS_DIR, { recursive: true });
  console.log("① 下载浙江省地级市边界…");
  const cities = await fetchJson(`${BASE}/${ZJ}_full.json`);
  console.log(`   地级市: ${cities.features.length} 个`);
  const cityNames = cities.features.map((f) => f.properties.name);

  console.log("② 下载各区县边界…");
  const countyFeatures = [];
  for (const name of cityNames) {
    const f = cities.features.find((x) => x.properties.name === name);
    const adcode = f.properties.adcode;
    const full = await fetchJson(`${BASE}/${adcode}_full.json`);
    countyFeatures.push(...full.features);
    console.log(`   ${name}(${adcode}): ${full.features.length} 个区县`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const counties = { type: "FeatureCollection", features: countyFeatures };
  console.log(`   区县合计: ${countyFeatures.length} 个`);

  const cityFile = path.join(LAYERS_DIR, "boundary-city.geojson");
  const countyFile = path.join(LAYERS_DIR, "boundary-county.geojson");
  fs.writeFileSync(cityFile, JSON.stringify(simplify(cities, 0.0015)));
  fs.writeFileSync(countyFile, JSON.stringify(simplify(counties, 0.0015)));
  console.log(`\n✅ 写入:`);
  console.log(`   ${cityFile} (${(fs.statSync(cityFile).size / 1024).toFixed(1)} KB)`);
  console.log(`   ${countyFile} (${(fs.statSync(countyFile).size / 1024).toFixed(1)} KB)`);
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
