#!/usr/bin/env node
/**
 * 迁移存量地图项目的字形地址（阶段 0 · 修 X7 的配套）
 *
 * 背景：glyphs 原先指向 https://glyphs.openfreestyle.com/...，该域名已无法解析。
 * 前端地图直接读取磁盘上的 style.json（MapViewer 用 /api/map/data/<p>/style.json），
 * 因此只在服务端 getProject() 里内存改写不够——必须把落盘文件一起迁移。
 *
 * 用法：
 *   node scripts/迁移地图字形地址.mjs           # 干跑，只列出会改哪些项目
 *   node scripts/迁移地图字形地址.mjs --apply    # 实际写入
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAPS_ROOT = path.join(ROOT, "office-workspace", "maps");
const NEW_GLYPHS = "/glyphs/{fontstack}/{range}.pbf";
const apply = process.argv.includes("--apply");

if (!fs.existsSync(MAPS_ROOT)) {
  console.log("未找到地图目录：" + MAPS_ROOT);
  process.exit(0);
}

const dirs = fs.readdirSync(MAPS_ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith("."))
  .map((e) => e.name);

let changed = 0;
for (const name of dirs) {
  const stylePath = path.join(MAPS_ROOT, name, "style.json");
  if (!fs.existsSync(stylePath)) continue;
  let style;
  try { style = JSON.parse(fs.readFileSync(stylePath, "utf8")); } catch (e) {
    console.log("  跳过（解析失败）" + name + "：" + e.message);
    continue;
  }
  const current = String(style.glyphs || "");
  if (current === NEW_GLYPHS) { console.log("  已是新地址：" + name); continue; }
  console.log("  待迁移：" + name);
  console.log("    旧：" + (current || "(空)"));
  console.log("    新：" + NEW_GLYPHS);
  changed += 1;
  if (apply) {
    style.glyphs = NEW_GLYPHS;
    fs.writeFileSync(stylePath, JSON.stringify(style, null, 2));
    console.log("    ✓ 已写入");
  }
}

console.log(apply ? `\n迁移完成：${changed} 个项目已更新。` : `\n干跑结束：${changed} 个项目待迁移（加 --apply 实际写入）。`);
