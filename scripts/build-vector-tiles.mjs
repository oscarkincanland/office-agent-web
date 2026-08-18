#!/usr/bin/env node
/**
 * 生成矢量瓦片（CLI 入口，逻辑见 scripts/lib/tiler.mjs）
 *
 * 用法: node scripts/build-vector-tiles.mjs [--force] [--layer=highways]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LAYER_DEFS, buildProjectTiles } from "./lib/tiler.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const MAP_DIR = path.join(PROJECT_DIR, "office-workspace", "maps", "zhejiang-map");
const TILES_DIR = path.join(MAP_DIR, "tiles");

const FORCE = process.argv.includes("--force");
const layerArg = process.argv.find((a) => a.startsWith("--layer="));
const layerIds = layerArg ? [layerArg.split("=")[1]] : null;

async function main() {
  const t0 = Date.now();
  console.log(`生成矢量瓦片 → ${TILES_DIR}`);
  fs.mkdirSync(TILES_DIR, { recursive: true });
  const results = buildProjectTiles(MAP_DIR, { force: FORCE, layerIds, defs: LAYER_DEFS });
  let total = 0;
  for (const [id, r] of Object.entries(results)) {
    if (r.skipped) { console.log(`  ⚠ ${id}: 无源文件，跳过`); continue; }
    console.log(`  ✅ ${id}: ${r.count} 瓦片, ${(r.bytes / 1024).toFixed(0)} KB`);
    total += r.count;
  }
  console.log(`\n完成：共 ${total} 个瓦片，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
