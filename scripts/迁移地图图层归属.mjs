#!/usr/bin/env node
/**
 * 迁移地图图层的归属标注（阶段 1）
 *
 * 背景：历史 map.config.json 没有 origin/owner 字段，图层归属无法区分——
 * 任何工作区都会把所有图层当成自己的（既看不到"共享数据集"的边界，
 * 也做不到"每个工作区对应自己的图层管理"）。
 *
 * 本脚本把归属写回 config：
 *   - 共享数据集（shared）：内置路网/区划（tiler 的 LAYER_DEFS）+ 本脚本声明的公用底图数据
 *   - 工作区图层（workspace）：其余图层，owner = 指定的工作区
 *
 * 用法：
 *   node scripts/迁移地图图层归属.mjs                       # 干跑：列出归类结果，不写盘
 *   node scripts/迁移地图图层归属.mjs --apply               # 实际写入
 *   node scripts/迁移地图图层归属.mjs --apply --shared=a,b   # 额外把某些 id 声明为共享
 *   node scripts/迁移地图图层归属.mjs --workspace=<path>     # 指定工作区图层归属（默认默认工作区）
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { annotateProject, listLayers } from "../server/图层仓库.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_WORKSPACE = path.join(ROOT, "office-workspace");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const sharedArg = args.find((a) => a.startsWith("--shared="));
const wsArg = args.find((a) => a.startsWith("--workspace="));
const workspace = wsArg ? wsArg.slice("--workspace=".length) : DEFAULT_WORKSPACE;

// LAYER_DEFS 之外的公用底图数据：这些不属于任何单个工作区，
// 而是"大家都能看"的基础数据，因此一并声明为共享。
// （用户明确提到"高速公路国省道这些图层是共用的"，省道与 OSM 路网属同类。）
const DEFAULT_SHARED_EXTRA = ["roads-province", "gis_osm_roads_free_1", "gis_osm_railways_free_1"];
const sharedIds = [...DEFAULT_SHARED_EXTRA, ...(sharedArg ? sharedArg.slice("--shared=".length).split(",") : [])]
  .map((s) => s.trim())
  .filter(Boolean);

console.log("工作区（工作区图层归属）：" + workspace);
console.log("额外共享声明：" + (sharedIds.length ? sharedIds.join(", ") : "(无)"));
console.log("模式：" + (apply ? "写入" : "干跑（加 --apply 实际写入）") + "\n");

const result = annotateProject("zhejiang-map", { workspace, sharedIds, apply });
if (!result) {
  console.log("未找到地图项目 zhejiang-map");
  process.exit(1);
}

console.log(`待标注图层 ${result.changed.length} 个：`);
for (const c of result.changed) {
  const suffix = c.to === "shared" ? "（共享，改样式需授权）" : `（工作区自有，owner=${c.owner || "(当前工作区)"}）`;
  console.log(`  ${String(c.id).padEnd(32)} ${c.name || ""}  →  ${c.to} ${suffix}`);
}
if (!result.changed.length) console.log("  （无需变更，归属已是最新）");
if (result.sharedChanged) console.log(`\n共享声明已更新（config.sharedLayers）`);

// 输出最终的归属视图，便于人工复核
const view = listLayers("zhejiang-map", { workspace });
const shared = view.filter((l) => l.origin === "shared");
const mine = view.filter((l) => l.origin === "workspace");
console.log(`\n最终视图（工作区 ${path.basename(workspace)}）：共享 ${shared.length} 个，本人 ${mine.length} 个`);
console.log("  共享：" + shared.map((l) => l.id).join(", "));
console.log("  本人：" + mine.map((l) => l.id).join(", "));

// 反证：另一个工作区只能看到共享图层（隔离生效）
const other = "F:/__other_workspace_probe__";
const otherView = listLayers("zhejiang-map", { workspace: other });
console.log(`\n隔离检查（模拟另一个工作区 ${path.basename(other)}）：可见 ${otherView.length} 个 = 共享 ${otherView.filter((l) => l.origin === "shared").length} + 本人 ${otherView.filter((l) => l.editable).length}`);
if (otherView.some((l) => l.origin === "workspace")) {
  console.log("  ⚠ 仍有工作区图层对其他工作区可见（检查 owner 是否为空）");
} else {
  console.log("  ✓ 工作区图层已正确隔离");
}
const allView = listLayers("zhejiang-map", { workspace: other, scope: "all" });
console.log(`  （scope=all 时可看到全部 ${allView.length} 个，供诊断）`);

if (!apply) console.log("\n干跑结束，未写入任何文件。");
