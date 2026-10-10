#!/usr/bin/env node
/**
 * 阶段 1 回归：图层模型与图层入口
 *
 * 覆盖 2026-10-09-012 阶段 1 的交付：
 *   1.1 图层仓库（共享/工作区归属、选择器解析、归属标注）
 *   1.2 共享数据集编辑授权流程（审批规则）
 *   1.3 map_edit 支持选择器 + 归属前缀审批
 *   1.4 图层入口（LayerPanel 三组归属分组）
 *   1.5 工作区切换时图层树跟随（修 X6）
 *   1.6 残留层清理脚本
 *
 * 分两层：
 *   - 行为断言：直接调用 server/图层仓库.mjs 的真实函数（不是源码字符串匹配）。
 *   - 源码断言：约束前端与工具定义，防止后续改动悄悄改掉能力边界。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ORIGIN,
  isSharedLayerId,
  layerOriginOf,
  layerRef,
  listLayers,
  parseSelector,
  resolveLayer,
  markLayerOwnership,
  annotateProject,
} from "../server/图层仓库.mjs";
import { listPermissionRules } from "../server/审批策略.mjs";
import { LAYER_DEFS } from "./lib/tiler.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const agentSrc = read("server/agent.mjs");
const layerPanelSrc = read("client/src/components/LayerPanel.jsx");
const mapPanelSrc = read("client/src/components/MapPanel.jsx");
const apiSrc = read("client/src/api.js");
const serverSrc = read("server/index.mjs");
const stylesSrc = read("client/src/styles.css");
const cleanupSrc = read("scripts/清理地图残留层.mjs");

const DEFAULT_WORKSPACE = path.join(ROOT, "office-workspace");
const OTHER_WORKSPACE = path.join(ROOT, "__probe_other_workspace__");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log("  ✓ " + name); }
  catch (e) { failed += 1; console.log("  ✗ " + name + "\n      " + (e.message || e)); }
}

console.log("\n▶ 1.1 图层仓库：归属模型（行为断言）");

test("内置图层恒为共享（不依赖 config 声明）", () => {
  for (const def of LAYER_DEFS) {
    assert.equal(isSharedLayerId(def.id, null), true, `${def.id} 应恒为共享`);
    assert.equal(layerRef({ id: def.id }).startsWith("shared/"), true, `${def.id} 的 ref 应以 shared/ 开头`);
  }
});

test("config.sharedLayers 可把额外图层声明为共享", () => {
  const config = { sharedLayers: ["roads-province", "gis_osm_roads_free_1"] };
  assert.equal(isSharedLayerId("roads-province", config), true, "声明过的应算共享");
  assert.equal(isSharedLayerId("taizhou_od", config), false, "未声明的不是共享");
});

test("未标注的历史图层默认归当前工作区，不会凭空消失", () => {
  const legacy = { id: "my-old-layer" };
  const { origin, owner } = layerOriginOf(legacy, { workspace: DEFAULT_WORKSPACE });
  assert.equal(origin, ORIGIN.WORKSPACE);
  assert.equal(owner, DEFAULT_WORKSPACE, "未标注时归属当前工作区，避免迁移前图层不可见");
});

test("workOnly 隔离：另一个工作区只能看到共享图层", () => {
  const mine = listLayers("zhejiang-map", { workspace: DEFAULT_WORKSPACE });
  const other = listLayers("zhejiang-map", { workspace: OTHER_WORKSPACE });
  const mineWorkspace = mine.filter((l) => l.origin === ORIGIN.WORKSPACE);
  assert.ok(mineWorkspace.length > 0, "默认工作区应有自有图层（测试前置数据）");
  assert.ok(mine.length > other.length, "本人视图应比他人视图多出工作区图层");
  const otherWorkspaceVisible = other.filter((l) => l.origin === ORIGIN.WORKSPACE);
  assert.equal(otherWorkspaceVisible.length, 0, "他人的工作区图层不应可见");
  // 共享部分两者必须一致（共用语义）
  const mineShared = mine.filter((l) => l.origin === ORIGIN.SHARED).map((l) => l.id).sort();
  const otherShared = other.filter((l) => l.origin === ORIGIN.SHARED).map((l) => l.id).sort();
  assert.deepEqual(mineShared, otherShared, "共享数据集对所有工作区一致");
});

test("scope=all 可看到全部（诊断用），且带 visibleToMe 标记", () => {
  const all = listLayers("zhejiang-map", { workspace: OTHER_WORKSPACE, scope: "all" });
  const mine = listLayers("zhejiang-map", { workspace: DEFAULT_WORKSPACE });
  assert.ok(all.length >= mine.length, "scope=all 不应少于本人视图");
  const hidden = all.filter((l) => !l.visibleToMe);
  assert.ok(hidden.length > 0, "他人图层应被标记为 visibleToMe=false");
  assert.ok(hidden.every((l) => l.origin === ORIGIN.WORKSPACE), "不可见的只能是工作区图层");
});

test("共享图层 editable 恒为 false（编辑要授权）", () => {
  const mine = listLayers("zhejiang-map", { workspace: DEFAULT_WORKSPACE });
  const shared = mine.filter((l) => l.origin === ORIGIN.SHARED);
  assert.ok(shared.length > 0, "应有共享图层");
  assert.ok(shared.every((l) => l.editable === false), "共享图层不应标记为可直接编辑");
  const owned = mine.filter((l) => l.origin === ORIGIN.WORKSPACE && l.owner && l.editable);
  assert.ok(owned.length > 0, "本工作区图层应可编辑");
});

console.log("\n▶ 1.2 选择器解析（行为断言）");

test("parseSelector 支持五种写法，裸值按 id", () => {
  assert.deepEqual(parseSelector("id:highways"), { kind: "id", value: "highways" });
  assert.deepEqual(parseSelector("group:公路网"), { kind: "group", value: "公路网" });
  assert.deepEqual(parseSelector("name:~高速"), { kind: "name", value: "~高速" });
  assert.deepEqual(parseSelector("origin:shared"), { kind: "origin", value: "shared" });
  assert.deepEqual(parseSelector("ref:shared/highways"), { kind: "ref", value: "shared/highways" });
  assert.deepEqual(parseSelector("highways"), { kind: "id", value: "highways" }, "裸值按 id（向后兼容）");
});

test("group: 批量匹配整组（对应验收 B4「隐藏所有公路」）", () => {
  const r = resolveLayer("zhejiang-map", "group:公路网", { workspace: DEFAULT_WORKSPACE });
  assert.equal(r.ok, true);
  assert.ok(r.matches.length >= 3, `公路网应匹配多个图层，实际 ${r.matches.length}`);
  assert.ok(r.refs.every((ref) => ref.includes("/")), "ref 必须带归属前缀");
});

test("origin: 按归属筛选", () => {
  const shared = resolveLayer("zhejiang-map", "origin:shared", { workspace: DEFAULT_WORKSPACE });
  assert.equal(shared.ok, true);
  assert.ok(shared.refs.every((ref) => ref.startsWith("shared/")), "origin:shared 只应返回共享图层");
  const mine = resolveLayer("zhejiang-map", "origin:workspace", { workspace: DEFAULT_WORKSPACE });
  assert.equal(mine.ok, true);
  assert.ok(mine.refs.every((ref) => ref.startsWith("workspace/")), "origin:workspace 只应返回自有图层");
});

test("未匹配时给出可用清单，而不是静默失败", () => {
  const r = resolveLayer("zhejiang-map", "id:不存在的图层", { workspace: DEFAULT_WORKSPACE });
  assert.equal(r.ok, false);
  assert.match(r.error, /没有匹配的图层/);
  assert.ok(r.candidates.length > 0, "应回传候选清单供模型自我纠正");
});

test("resolveLayer 不会匹配到其他工作区的图层（隔离兜底）", () => {
  const other = resolveLayer("zhejiang-map", "origin:workspace", { workspace: OTHER_WORKSPACE });
  assert.equal(other.ok, false, "他人视角不应解析到工作区图层");
});

console.log("\n▶ 1.3 map_edit 选择器与归属前缀审批");

test("map_edit 接受 target 且保留 layerId 向后兼容", () => {
  assert.match(agentSrc, /name: "map_edit"/);
  assert.match(agentSrc, /target: Type\.Optional/, "应新增 target 参数");
  assert.match(agentSrc, /layerId: Type\.Optional/, "应保留 layerId（向后兼容）");
  assert.match(agentSrc, /resolveLayer\(/, "应通过图层仓库解析选择器");
});

test("map_edit 审批 pattern 用归属 ref（shared/* 或 workspace/*）", () => {
  const start = agentSrc.indexOf('name: "map_edit"');
  const body = agentSrc.slice(start, start + 9000);
  assert.match(body, /sharedRefs/, "应区分共享 ref");
  assert.match(body, /startsWith\("shared\/"\)/, "应以 shared/ 前缀判定共享");
  assert.match(body, /approvalPattern/, "应把归属前缀作为审批 pattern");
});

test("写工具在共享数据集上被拒绝，在工作区上放行（审批规则）", () => {
  const { defaults } = listPermissionRules();
  const find = (tool, pattern) => defaults.find((r) => r.tool === tool && r.pattern === pattern);
  assert.equal(find("map_import", "shared/*")?.action, "deny", "共享集不允许新增文件");
  assert.equal(find("map_save_analysis", "shared/*")?.action, "deny", "共享集不允许落盘分析结果");
  assert.equal(find("map_edit", "shared/*")?.action, "ask", "改共享样式需逐次授权");
  assert.equal(find("map_edit", "workspace/*")?.action, "allow", "本工作区图层可直接改");
  // 最后匹配生效：地图细分规则必须排在默认规则之后，否则会被更早的 allow 覆盖。
  // 用户自定义规则可以追加在更后面，所以只要求"晚于内置默认规则"。
  const indexOfRule = (tool, pattern) => defaults.findIndex((r) => r.tool === tool && r.pattern === pattern);
  const catchAllIndex = defaults.findIndex((r) => r.tool === "*" && r.pattern === "*");
  assert.ok(catchAllIndex >= 0, "应有 catch-all 默认规则（tool=* pattern=*）");
  for (const [tool, pattern] of [["map_edit", "shared/*"], ["map_edit", "workspace/*"], ["map_import", "shared/*"], ["map_save_analysis", "shared/*"]]) {
    assert.ok(indexOfRule(tool, pattern) > catchAllIndex, `${tool}+${pattern} 应排在 catch-all 之后才能生效`);
  }
});

test("map_edit 通过 refs 判定共享，并支持通配 action 列表", () => {
  const start = agentSrc.indexOf('name: "map_edit"');
  const body = agentSrc.slice(start, start + 9000);
  assert.match(body, /const refs = matched\.map/, "应从匹配结果取 ref 列表");
  assert.match(body, /params\.action !== "add"/, "add 动作不需要先解析已有图层");
});

console.log("\n▶ 1.3b 导入与保存落盘后标注归属");

test("map_import 落盘后标注工作区归属", () => {
  const start = agentSrc.indexOf('name: "map_import"');
  const body = agentSrc.slice(start, start + 5000);
  assert.match(body, /markLayerOwnership/, "map_import 应标注归属");
  assert.match(body, /entry\.workspace/, "归属应取当前工作区");
});

test("map_save_analysis 落盘后标注归属（含 -lines 派生层）", () => {
  const start = agentSrc.indexOf('name: "map_save_analysis"');
  const body = agentSrc.slice(start, start + 5000);
  assert.match(body, /markLayerOwnership\(project, layerId/, "主图层应标注归属");
  assert.match(body, /markLayerOwnership\(project, `\$\{layerId\}-lines`/, "派生线层也应标注归属");
});

test("markLayerOwnership 不会把共享图层改写成工作区私有", () => {
  // 行为验证：内置图层调用后应返回 false（拒绝改写）
  const changed = markLayerOwnership("zhejiang-map", "highways", { workspace: DEFAULT_WORKSPACE });
  assert.equal(changed, false, "共享图层不应被标注为工作区私有");
  // 且视图里仍是共享
  const view = listLayers("zhejiang-map", { workspace: DEFAULT_WORKSPACE });
  assert.equal(view.find((l) => l.id === "highways")?.origin, ORIGIN.SHARED);
});

console.log("\n▶ 1.4 图层入口（三组归属分组）");

test("LayerPanel 接受 layerViews 与 tempLayers", () => {
  assert.match(layerPanelSrc, /layerViews = \[\]/, "应接受归属视图 prop");
  assert.match(layerPanelSrc, /tempLayers = \[\]/, "应接受临时层 prop");
});

test("LayerPanel 分「共享数据集 / 我的图层 / 临时层」三组", () => {
  assert.match(layerPanelSrc, /共享数据集/, "应有共享数据集分组");
  assert.match(layerPanelSrc, /临时层/, "应有临时层分组");
  assert.match(layerPanelSrc, /my.*图层组|我的图层|groups\.map/, "应保留用户图层组（我的图层）");
});

test("共享图层带锁标识，且提示编辑需授权", () => {
  assert.match(layerPanelSrc, /name="lock"/, "共享图层应显示锁图标");
  assert.match(layerPanelSrc, /共享数据集，编辑需授权/, "悬停应说明编辑需授权");
  assert.match(layerPanelSrc, /lp-row-lock/, "应有锁样式类");
});

test("组头复选框仍是展开/折叠语义，未被改成显隐（保护既有交互）", () => {
  assert.match(layerPanelSrc, /setCollapsed/, "组头仍控制折叠");
  assert.match(layerPanelSrc, /toggleGroup/, "组级显隐仍由眼形复选框承担");
  // 折叠状态 key 与显隐逻辑分离
  assert.match(layerPanelSrc, /__shared__/, "共享组折叠状态应有独立 key");
  assert.match(layerPanelSrc, /__temp__/, "临时层折叠状态应有独立 key");
});

test("临时层只展示不可写（不提供删除/保存操作）", () => {
  const start = layerPanelSrc.indexOf("lp-group-temp");
  assert.ok(start > 0, "应存在临时层分组");
  const body = layerPanelSrc.slice(start, start + 1400);
  assert.doesNotMatch(body, /onDeleteLayer/, "临时层不应出现删除操作");
  assert.doesNotMatch(body, /onRenameLayer/, "临时层不应出现重命名操作");
  assert.match(body, /未保存/, "应标明未保存");
});

test("样式已定义归属分组（CSS 预算内）", () => {
  for (const cls of [".lp-group-shared", ".lp-group-temp", ".lp-row-lock", ".lp-row-temp"]) {
    assert.ok(stylesSrc.includes(cls), `应定义 ${cls}`);
  }
});

console.log("\n▶ 1.4b 图层入口（三个入口，B6）");

test("主入口：地图模块左栏图层树", () => {
  assert.match(mapPanelSrc, /<LayerPanel/, "地图左栏应是图层主入口");
});

test("快捷入口：侧栏「工作能力」含地图入口", () => {
  const sidebarSrc = read("client/src/components/SessionSidebar.jsx");
  assert.match(sidebarSrc, /onOpenMap/, "侧栏应有地图入口回调");
  assert.match(sidebarSrc, /GIS 分析/, "入口应说明用途");
});

test("工作区入口：文件页工具条有图层按钮（阶段 1 §1.4 第三个入口）", () => {
  const sidebarSrc = read("client/src/components/SessionSidebar.jsx");
  assert.match(sidebarSrc, /section-layers/, "文件页工具条应有图层入口");
  assert.match(sidebarSrc, /图层管理（打开地图模块/, "入口应说明它会打开地图模块");
});

test("命令面板可直达地图模块", () => {
  const appSrc = read("client/src/App.jsx");
  assert.match(appSrc, /onMap=\{\(\) => openExternalModule\("map"\)\}/, "命令面板应能打开地图模块");
});

console.log("\n▶ 1.4c Agent 视角的归属隔离（E1 / D2）");

test("map_read 按归属过滤（不暴露其他工作区的图层）", () => {
  const start = agentSrc.indexOf('name: "map_read"');
  const body = agentSrc.slice(start, start + 4000);
  assert.match(body, /图层仓库|listLayers/, "map_read 应用图层仓库取归属视图");
  assert.match(body, /entry\.workspace/, "应按当前工作区过滤");
  assert.match(body, /共享|origin/, "应标注归属");
});

test("map_datasets 区分「共享数据集 / 我的图层」", () => {
  const start = agentSrc.indexOf('name: "map_datasets"');
  const body = agentSrc.slice(start, start + 5000);
  assert.match(body, /listLayers/, "应用图层仓库");
  assert.match(body, /共享数据集/, "应分组显示共享数据集");
  assert.match(body, /我的图层/, "应分组显示本工作区图层");
});

test("落盘工具的台账记具体文件（E4 产物可确认）", () => {
  // 产物归属按精确路径匹配；记项目目录会让保存的图层落到"待确认"而不是"已确认"。
  const importStart = agentSrc.indexOf('name: "map_import"');
  const importBody = agentSrc.slice(importStart, importStart + 4000);
  assert.match(importBody, /path: file, kind: "map_import"/, "map_import 应逐文件记台账");
  assert.match(importBody, /layers\/\$\{layerId\}\.geojson/, "应含图层文件路径");

  const saveStart = agentSrc.indexOf('name: "map_save_analysis"');
  const saveBody = agentSrc.slice(saveStart, saveStart + 4000);
  assert.match(saveBody, /path: file, kind: "map_save_analysis"/, "map_save_analysis 应逐文件记台账");
  assert.match(saveBody, /layers\/\$\{layerId\}-lines\.geojson/, "含 -lines 派生层时应记入台账");
});

console.log("\n▶ 1.5 工作区切换时图层树跟随（修 X6）");

test("前端请求项目详情时带上 workspace", () => {
  assert.match(apiSrc, /mapProject = \(name, workspace = ""\)/, "mapProject 应接受 workspace");
  assert.match(apiSrc, /params\.set\("workspace"/, "应把 workspace 作为查询参数");
});

test("MapPanel 加载时传 workspace 并保存 layerViews", () => {
  assert.match(mapPanelSrc, /mapProject\(name, workspace\)/, "加载项目应带 workspace");
  assert.match(mapPanelSrc, /setLayerViews/, "应保存归属视图");
  assert.match(mapPanelSrc, /layerViews=\{layerViews\}/, "应传给 LayerPanel");
});

test("工作区变化触发图层树重拉（共享数据集不变）", () => {
  assert.match(mapPanelSrc, /workspaceRef/, "应用 ref 追踪上一次工作区");
  assert.match(mapPanelSrc, /workspaceRef\.current === workspace/, "工作区变化时才重拉");
});

test("服务端 /api/map/project 返回 layerViews 且兼容旧响应", () => {
  assert.match(serverSrc, /p\.layerViews = repo\.listLayers/, "项目详情应附归属视图");
  assert.match(serverSrc, /try \{[\s\S]{0,200}图层仓库[\s\S]{0,200}\} catch/, "归属视图失败不应影响项目详情");
});

console.log("\n▶ 1.6 残留层清理脚本");

test("清理脚本默认干跑，需显式 --apply", () => {
  assert.match(cleanupSrc, /const APPLY = argv\.includes\("--apply"\)/, "默认应不写入");
  assert.match(cleanupSrc, /未修改任何文件/, "干跑应明确提示");
});

test("清理脚本写入前备份 style.json", () => {
  assert.match(cleanupSrc, /copyFileSync\(stylePath, backupPath\)/, "应备份原样式");
  assert.match(cleanupSrc, /\.bak-/, "备份文件名应带时间戳");
});

test("清理脚本按「数据源缺失」判定，并支持排除项", () => {
  assert.match(cleanupSrc, /sourceDataMissing/, "应以数据是否缺失为判据");
  assert.match(cleanupSrc, /--exclude=/, "应支持人工排除");
  assert.match(cleanupSrc, /仅报告/, "孤儿数据文件只报告不删除");
});

console.log("\n▶ 1.7 归属可持久化（迁移脚本与仓库一致性）");

test("annotateProject 干跑不写盘，apply 才写入", () => {
  const before = JSON.parse(read("office-workspace/maps/zhejiang-map/map.config.json"));
  const dry = annotateProject("zhejiang-map", { workspace: DEFAULT_WORKSPACE, apply: false });
  assert.ok(dry, "应返回结果");
  assert.equal(dry.applied, false, "干跑不应写入");
  const after = JSON.parse(read("office-workspace/maps/zhejiang-map/map.config.json"));
  assert.deepEqual(after, before, "干跑后文件内容不应变化");
});

test("归属已落盘：config 中共享图层带 origin=shared", () => {
  const config = JSON.parse(read("office-workspace/maps/zhejiang-map/map.config.json"));
  const layers = config.layers || [];
  const shared = layers.filter((l) => l.origin === "shared");
  assert.ok(shared.length >= LAYER_DEFS.length, `共享图层应至少覆盖全部内置定义，实际 ${shared.length}`);
  assert.ok(Array.isArray(config.sharedLayers) && config.sharedLayers.length > 0, "应有 sharedLayers 声明（省道/OSM 等公用数据）");
});

if (failed) {
  console.log(`\n阶段 1 图层模型与入口回归：${failed} 项失败`);
  process.exit(1);
}
console.log("\n阶段 1 图层模型与入口回归：通过");
