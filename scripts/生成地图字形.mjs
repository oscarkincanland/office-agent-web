#!/usr/bin/env node
/**
 * 生成自托管地图字形（阶段 0 · 修 X7）
 *
 * 背景：底图 glyphs 原先指向 https://glyphs.openfreestyle.com/...，该域名已不可解析，
 * 15 个标注图层（道路注记、行政区名）因此没有字形可用。改为自托管：
 *   源字体 → MapLibre 兼容的 SDF PBF 分片 → client/public/glyphs/<fontstack>/<start>-<end>.pbf
 * 运行时由静态服务按 /glyphs/{fontstack}/{range}.pbf 提供，不依赖外网。
 *
 * 用法：
 *   node scripts/生成地图字形.mjs                # 默认生成常用中文 + 拉丁区间
 *   node scripts/生成地图字形.mjs --check        # 只检查现有产物是否可用
 *   node scripts/生成地图字形.mjs --force        # 已存在也重新生成
 *
 * 字体来源：优先系统 Noto Sans（Windows 常见于 C:\Windows\Fonts），
 * 缺失时可用 --font <path> 显式指定，或 --font-url <url> 下载。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateGlyphPbfFiles } from "maplibre-font-maker-node";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_ROOT = path.join(ROOT, "client", "public", "glyphs");
// 与 style.json 里的 text-font 一致；字体族名决定 URL 里的 {fontstack}
const FONTSTACK = "Noto Sans Regular";

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes("--check");
const FORCE = args.includes("--force");
const fontArgIdx = args.indexOf("--font");
const FONT_PATH_ARG = fontArgIdx >= 0 ? args[fontArgIdx + 1] : "";

// 字形区间（MapLibre 按 256 码位一片请求）。
// 覆盖范围：拉丁 + 标点 + 常用汉字（含浙江地名用字）+ 全角符号。
// 不生成整个 CJK 区（会产出上千个 PBF、数十 MB）；缺字时按需再补区间。
const RANGES = [
  { start: 0, end: 255 },        // 基本拉丁 + 拉丁补充
  { start: 256, end: 511 },      // 拉丁扩展
  { start: 8192, end: 8447 },    // 通用标点（含中文引号、破折号）
  { start: 12288, end: 12543 },  // CJK 符号与标点（含全角、中文括号）
  { start: 19968, end: 20223 },  // 常用汉字 1（一…）
  { start: 20224, end: 20479 },  // 常用汉字 2
  { start: 20480, end: 20735 },  // 常用汉字 3
  { start: 20736, end: 20991 },  // 常用汉字 4
  { start: 20992, end: 21247 },  // 常用汉字 5
  { start: 21248, end: 21503 },  // 常用汉字 6
  { start: 21504, end: 21759 },  // 常用汉字 7
  { start: 21760, end: 22015 },  // 常用汉字 8
  { start: 22016, end: 22271 },  // 常用汉字 9
  { start: 22272, end: 22527 },  // 常用汉字 10
  { start: 22528, end: 22783 },  // 常用汉字 11
  { start: 22784, end: 23039 },  // 常用汉字 12
];

const CANDIDATE_FONTS = [
  "C:/Windows/Fonts/Noto Sans SC (TrueType).otf",
  "C:/Windows/Fonts/NotoSansSC-Regular.otf",
  "C:/Windows/Fonts/msyh.ttc",
  "/System/Library/Fonts/PingFang.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
];

function log(msg) { console.log(msg); }

function findFont() {
  if (FONT_PATH_ARG) {
    if (!fs.existsSync(FONT_PATH_ARG)) throw new Error(`--font 指定的字体不存在：${FONT_PATH_ARG}`);
    return FONT_PATH_ARG;
  }
  for (const p of CANDIDATE_FONTS) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    "未找到可用中文字体。请用 --font <path> 指定一个含中文字形的 OTF/TTF/TTC 字体。\n" +
    "已尝试：\n  " + CANDIDATE_FONTS.join("\n  "),
  );
}

function countExisting() {
  const dir = path.join(OUT_ROOT, FONTSTACK);
  if (!fs.existsSync(dir)) return { dir, files: 0, bytes: 0 };
  const list = fs.readdirSync(dir).filter((f) => f.endsWith(".pbf"));
  let bytes = 0;
  for (const f of list) bytes += fs.statSync(path.join(dir, f)).size;
  return { dir, files: list.length, bytes };
}

async function main() {
  const existing = countExisting();
  if (CHECK_ONLY) {
    log(`字形目录：${existing.dir}`);
    log(`现有分片：${existing.files} 个，合计 ${(existing.bytes / 1024).toFixed(0)} KB`);
    log(existing.files > 0 ? "状态：已有自托管字形" : "状态：尚未生成");
    process.exit(existing.files > 0 ? 0 : 1);
  }

  if (existing.files > 0 && !FORCE) {
    log(`字形已存在（${existing.files} 个分片，${(existing.bytes / 1024).toFixed(0)} KB）：${existing.dir}`);
    log("如需重新生成请加 --force。");
    return;
  }

  const fontPath = findFont();
  log(`源字体：${fontPath}`);
  const bytes = new Uint8Array(fs.readFileSync(fontPath));
  log(`字体大小：${(bytes.length / 1024 / 1024).toFixed(1)} MB`);

  log(`开始生成 ${RANGES.length} 个区间……`);
  const started = Date.now();
  const generated = await generateGlyphPbfFiles({
    fontstack: FONTSTACK,
    fonts: [{ name: "Noto Sans", bytes }],
    ranges: RANGES,
  });

  const outDir = path.join(OUT_ROOT, FONTSTACK);
  fs.mkdirSync(outDir, { recursive: true });
  let written = 0;
  let totalBytes = 0;
  for (const file of generated) {
    // 库返回的 filename 形如 "0-255.pbf"；统一落到 fontstack 目录下
    const name = path.basename(file.filename);
    if (!/^\d+-\d+\.pbf$/.test(name)) continue;
    fs.writeFileSync(path.join(outDir, name), file.bytes);
    written += 1;
    totalBytes += file.bytes.length;
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  log(`完成：${written} 个分片，${(totalBytes / 1024).toFixed(0)} KB，用时 ${seconds}s`);
  log(`输出目录：${outDir}`);
  log("提示：将这些分片纳入版本库或部署产物；运行时由 /glyphs/{fontstack}/{range}.pbf 提供。");
}

main().catch((error) => {
  console.error("生成字形失败：" + (error?.message || error));
  process.exit(1);
});
