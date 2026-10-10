/**
 * 清理地图残留层（阶段 1 · 修 X4）
 *
 * 背景：zhejiang-map/style.json 里积累了一批历史遗留样式层——早期测试用的
 * `drawn-*`、`__codex_shp_test__-label`，被改过名字的旧分析层
 * （`yiwu-od-lines-style`、`highway_flow*`），以及数据已被删除却还留着的
 * `roads-rural`。它们不在 map.config.json 的业务图层清单里，地图上表现为
 * "没有业务名字的杂线"或直接加载失败。
 *
 * 判据（两层，宁可不删也不错删）：
 *   1. 悬空引用：图层引用的 source 不在 style.sources 里，或该 source 的矢量瓦片
 *      目录 / GeoJSON 文件已不存在 → 一定渲染不出来，属残留。
 *   2. 历史命名：id 命中 drawn-* / __* / *-style / highway_flow* 等模式。
 *   只有同时满足"不在业务清单里"且"数据确实缺失"才列入删除建议。
 *
 * 安全约束：
 *   - 默认只列出可疑层，不修改任何文件（干跑）。
 *   - 只有显式 `--apply` 才写入；删除前备份 style.json。
 *   - `--exclude=<id,id>` 可排除用户判断仍需保留的层。
 *   - 工作区数据文件（layers/*.geojson）只报告、不删除。
 *
 * 用法：
 *   node scripts/清理地图残留层.mjs                       # 列出可疑层（干跑）
 *   node scripts/清理地图残留层.mjs --apply               # 执行清理
 *   node scripts/清理地图残留层.mjs --apply --project=xxx
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const pick = (name, fallback = "") => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(`--${name}=`.length) : fallback;
};
const EXCLUDED = new Set(String(pick("exclude")).split(",").map((v) => v.trim()).filter(Boolean));
const PROJECT = pick("project", "zhejiang-map");

/** 历史命名模式：辅助判据（仍需数据缺失才删除）。 */
const LEGACY_PATTERNS = [/^drawn-/, /^__/, /-style$/, /^highway_flow/, /^roads_flow/];

const projectDir = path.join(ROOT, "office-workspace", "maps", PROJECT);
const stylePath = path.join(projectDir, "style.json");
const configPath = path.join(projectDir, "map.config.json");

if (!fs.existsSync(stylePath)) {
  console.error(`找不到样式文件：${stylePath}`);
  process.exit(1);
}

const style = JSON.parse(fs.readFileSync(stylePath, "utf8"));
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : { layers: [] };
const businessIds = new Set((config.layers || []).map((l) => String(l.id)));
const sources = style.sources || {};

/** 业务图层派生层（{id}-label、{id}-outline）不算残留。 */
function isDerivedOfBusiness(id) {
  return [...businessIds].some((bid) => id === bid || id.startsWith(`${bid}-`));
}

/** 判断某个 source 的数据是否还在磁盘上。 */
function sourceDataMissing(sourceId) {
  const source = sources[sourceId];
  if (!source) return true; // 悬空引用
  if (source.type !== "vector") {
    // GeoJSON 源：检查 data 指向的本地文件
    const data = typeof source.data === "string" ? source.data : "";
    const m = data.match(/\/api\/map\/data\/([^/]+)\/layers\/(.+)$/);
    if (!m) return false; // 非本地数据（或内联对象），无法判断，按存在处理
    return !fs.existsSync(path.join(ROOT, "office-workspace", "maps", m[1], "layers", decodeURIComponent(m[2])));
  }
  const tile = Array.isArray(source.tiles) ? String(source.tiles[0] || "") : "";
  const m = tile.match(/\/api\/map\/data\/([^/]+)\/tiles\/([^/]+)\//);
  if (!m) return false; // 远程底图源，不参与判断
  return !fs.existsSync(path.join(ROOT, "office-workspace", "maps", m[1], "tiles", m[2]));
}

const layers = Array.isArray(style.layers) ? style.layers : [];
const suspects = [];
const legacyButAlive = [];
for (const layer of layers) {
  const id = String(layer.id || "");
  if (!id || id.startsWith("basemap")) continue;
  if (EXCLUDED.has(id)) continue;
  if (businessIds.has(id) || isDerivedOfBusiness(id)) continue;
  const sourceMissing = layer.source ? sourceDataMissing(String(layer.source)) : false;
  const legacy = LEGACY_PATTERNS.some((re) => re.test(id));
  if (sourceMissing) {
    suspects.push({ id, type: layer.type || "?", source: layer.source || "", reason: sources[layer.source] ? "数据源已删除" : "引用的数据源不存在" });
  } else if (legacy) {
    // 命名像历史残留，但数据仍在：列出但不建议删除，交由用户判断。
    legacyButAlive.push({ id, source: layer.source || "" });
  }
}

console.log(`项目：${PROJECT}`);
console.log(`样式层总数：${layers.length}，业务图层：${businessIds.size}`);

console.log(`\n建议删除的残留层（${suspects.length}）：`);
for (const s of suspects) console.log(`  - ${s.id}（${s.type}${s.source ? ` · source=${s.source}` : ""} · ${s.reason}）`);
if (!suspects.length) console.log("  （无）");

if (legacyButAlive.length) {
  console.log(`\n命名像历史残留、但数据仍存在（${legacyButAlive.length}，未列入删除，请人工判断）：`);
  for (const s of legacyButAlive) console.log(`  - ${s.id}${s.source ? ` · source=${s.source}` : ""}`);
}

// 孤儿数据文件：layers/ 里存在但没有进 config.layers 的 GeoJSON。只报告，不删除。
const layersDir = path.join(projectDir, "layers");
const orphans = fs.existsSync(layersDir)
  ? fs.readdirSync(layersDir)
      .filter((n) => n.endsWith(".geojson"))
      .map((n) => n.replace(/\.geojson$/, ""))
      .filter((id) => !businessIds.has(id) && !/^drawn-/.test(id))
  : [];
if (orphans.length) {
  console.log(`\n未登记到图层清单的数据文件（${orphans.length}，仅报告，可留作数据资产）：\n  ${orphans.join(", ")}`);
}

if (!suspects.length) {
  console.log("\n没有需要清理的残留层。");
  process.exit(0);
}

if (!APPLY) {
  console.log("\n以上为干跑结果，未修改任何文件。");
  console.log("确认无误后执行：node scripts/清理地图残留层.mjs --apply");
  console.log("（若某层仍需保留，加 --exclude=<layerId> 排除）");
  process.exit(0);
}

const suspectIds = new Set(suspects.map((s) => s.id));
const before = layers.length;
style.layers = layers.filter((l) => !suspectIds.has(String(l.id)));
// 悬空 source 一并清掉（已无图层引用），避免下次加载时又触发运行时剔除。
const usedSources = new Set(style.layers.map((l) => l.source).filter(Boolean));
const orphanSources = Object.keys(sources).filter((id) => !usedSources.has(id) && /^(drawn-|__|highway_flow|roads_flow|yiwu-od)/.test(id));
for (const id of orphanSources) delete style.sources[id];
const removed = before - style.layers.length;

const backupPath = `${stylePath}.bak-${Date.now()}`;
fs.copyFileSync(stylePath, backupPath);
fs.writeFileSync(stylePath, JSON.stringify(style, null, 2), "utf8");

console.log(`\n已删除 ${removed} 个残留样式层${orphanSources.length ? `、${orphanSources.length} 个悬空数据源` : ""}（备份：${path.basename(backupPath)}）。`);
console.log("提示：刷新前端地图后生效。");
