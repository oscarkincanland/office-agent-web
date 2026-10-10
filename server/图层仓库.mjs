/**
 * 图层仓库（阶段 1）
 *
 * 职责：把"图层归属"这件事集中到一处，供 UI 与 Agent 共用。
 *
 * 归属模型（D2：共享数据集共用、工作区各自管理）：
 *   - shared    共享数据集：内置路网与区划（见 tiler 的 LAYER_DEFS）。所有工作区都能看，
 *               改样式需逐次授权（审批 pattern = shared/*），不允许往里新增文件。
 *   - workspace 工作区自有图层：导入或分析落盘的图层。记录 owner（工作区根路径），
 *               只有该工作区能看到与直接编辑（pattern = workspace/*）。
 *
 * 图层数据物理位置**保持不变**（仍在 maps/<project>/layers/ + tiles/），
 * 原因：瓦片构建（buildProjectTiles）、style.json 组装、静态路由都绑定项目目录，
 * 把工作区图层搬到 <workspace>/map-layers/ 需要同时改这四处且会拆散"一个项目一份瓦片"的结构。
 * 归属改用 map.config.json 里的 origin/owner 字段记录——语义等价、风险低得多。
 * 「每个工作区对应自己的图层管理」通过 listLayers 的过滤实现（只返回共享 + 本人所有）。
 */
import path from "node:path";
import { LAYER_DEFS } from "../scripts/lib/tiler.mjs";
import { getProject, saveConfig } from "./map.mjs";

/** 内置图层 id 集合（tiler 定义的基线路网与区划）。 */
const BUILTIN_LAYER_IDS = new Set(LAYER_DEFS.map((d) => String(d.id)));

/**
 * 项目可自行声明的共享图层（map.config.json 的 sharedLayers 数组）。
 * 用途：把 LAYER_DEFS 之外的"公用底图数据"也归入共享集合（例如省道、OSM 路网），
 * 避免它们被当成某个工作区的私有图层。内置图层永远是共享，不依赖此配置。
 */
function declaredSharedIds(config) {
  const list = Array.isArray(config?.sharedLayers) ? config.sharedLayers : [];
  return new Set(list.map((v) => String(v || "").trim()).filter(Boolean));
}

export const ORIGIN = Object.freeze({ SHARED: "shared", WORKSPACE: "workspace" });

/** 路径比较：Windows 上大小写与分隔符都会变，统一归一化后再比。 */
function samePath(a, b) {
  const norm = (v) => String(v || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const left = norm(a);
  const right = norm(b);
  return Boolean(left) && left === right;
}

/** 是否共享数据集：内置图层，或项目声明的共享图层。 */
export function isSharedLayerId(layerId, config = null) {
  const id = String(layerId || "");
  if (!id) return false;
  if (BUILTIN_LAYER_IDS.has(id)) return true;
  return declaredSharedIds(config).has(id);
}

/**
 * 解析单个图层的归属。
 * 未标注时按规则推断：共享集合 → shared；其余 → workspace（owner 为空表示尚未归属到具体工作区）。
 */
export function layerOriginOf(layer = {}, { workspace = "", config = null } = {}) {
  const id = String(layer.id || "");
  if (isSharedLayerId(id, config)) return { origin: ORIGIN.SHARED, owner: "" };
  const origin = String(layer.origin || "").trim();
  if (origin === ORIGIN.SHARED) return { origin: ORIGIN.SHARED, owner: "" };
  if (origin === ORIGIN.WORKSPACE) return { origin: ORIGIN.WORKSPACE, owner: String(layer.owner || "") };
  // 历史数据没有标注：视为"未归属的工作区图层"，落在当前工作区（迁移时会写回 config）
  return { origin: ORIGIN.WORKSPACE, owner: String(layer.owner || workspace || "") };
}

/** 图层的稳定引用，作为审批规则的 pattern 来源。 */
export function layerRef(layer = {}, options = {}) {
  const { origin } = layerOriginOf(layer, options);
  return `${origin}/${String(layer.id || "")}`;
}

/**
 * 列出图层视图（含归属与可见性）。
 *
 * scope 决定过滤范围（默认 "mine" = 共享 + 本人所有，这是 UI 与 Agent 都该看到的集合）：
 *   - "mine"：共享数据集 + 当前工作区自有图层
 *   - "all" ：全部图层（迁移脚本、诊断用；带 visibleToMe 标记便于区分）
 *
 * editable：工作区自有且属于当前工作区 → true；共享 → false（改样式需走审批）。
 * visible：以 style.json 为准（config.visible 可能落后）。owner 为空的历史图层对所有人可见，
 *          避免归属迁移前"图层凭空消失"。
 */
export function listLayers(project, { workspace = "", scope = "mine" } = {}) {
  const proj = getProject(project);
  if (!proj) return [];
  const config = proj.config;
  const styleVisibility = new Map(
    (proj.style?.layers || []).map((l) => [String(l.id), l.layout?.visibility !== "none"]),
  );
  const out = [];
  for (const layer of config?.layers || []) {
    const id = String(layer.id || "");
    if (!id) continue;
    const { origin, owner } = layerOriginOf(layer, { workspace, config });
    const ownedByMe = origin === ORIGIN.WORKSPACE && (!owner || samePath(owner, workspace));
    const visibleToMe = origin === ORIGIN.SHARED || ownedByMe;
    if (scope !== "all" && !visibleToMe) continue;
    out.push({
      id,
      name: layer.name || id,
      type: layer.type || "",
      group: layer.group || "",
      origin,
      owner,
      ref: `${origin}/${id}`,
      editable: ownedByMe,
      visibleToMe,
      // 地图上的实际显隐以 style 为准（config.visible 可能落后），缺失时回退 config。
      visible: styleVisibility.has(id) ? styleVisibility.get(id) : layer.visible !== false,
    });
  }
  return out;
}

/** 选择器解析：支持 id: / group: / name:~ / origin: / ref:，裸值按 id 处理（向后兼容）。 */
export function parseSelector(selector = "") {
  const raw = String(selector || "").trim();
  const matched = raw.match(/^(id|group|name|origin|ref)\s*[:：]\s*(.*)$/i);
  if (matched) return { kind: matched[1].toLowerCase(), value: matched[2].trim() };
  return { kind: "id", value: raw };
}

function matchLayers(layers, selector) {
  const { kind, value } = parseSelector(selector);
  const needle = value.toLowerCase();
  if (!needle) return [];
  switch (kind) {
    case "ref":
      return layers.filter((l) => l.ref.toLowerCase() === needle);
    case "origin":
      return layers.filter((l) => l.origin === needle || (needle.startsWith("shared") && l.origin === ORIGIN.SHARED));
    case "group":
      return layers.filter((l) => String(l.group).toLowerCase() === needle);
    case "name": {
      // name:高速 或 name:~高速 都按包含匹配（图层名多为中文全称，精确匹配太脆）
      const fuzzy = needle.startsWith("~") ? needle.slice(1) : needle;
      return layers.filter((l) => String(l.name).toLowerCase().includes(fuzzy) || l.id.toLowerCase().includes(fuzzy));
    }
    case "id":
    default:
      return layers.filter((l) => l.id.toLowerCase() === needle);
  }
}

/**
 * 把选择器解析成具体图层（只在"当前工作区可见"的范围内匹配，避免误改别人的图层）。
 * 返回 { ok, matches, refs } 或 { ok:false, error, candidates }。
 */
export function resolveLayer(project, selector, { workspace = "" } = {}) {
  const visible = listLayers(project, { workspace });
  const matches = matchLayers(visible, selector);
  if (!matches.length) {
    const sample = visible.slice(0, 12).map((l) => l.ref).join("、");
    return {
      ok: false,
      error: `没有匹配的图层：${selector}${sample ? `（可用：${sample}）` : "（当前项目没有可见图层）"}`,
      candidates: visible.map((l) => l.ref),
    };
  }
  return { ok: true, matches, refs: matches.map((l) => l.ref) };
}

/**
 * 把归属写回 config（幂等）。
 * sharedIds 可选：把 LAYER_DEFS 之外、但属于公用底图数据的图层声明为共享
 * （写入 config.sharedLayers，之后 isSharedLayerId 会认它）。
 * apply=false 时只计算不落盘，供迁移脚本干跑复核。
 */
export function annotateProject(project, { workspace = "", sharedIds = [], apply = true } = {}) {
  const proj = getProject(project);
  if (!proj) return null;
  const config = proj.config;

  // 先合并声明的共享图层，再据此计算每个图层的归属。
  // 注意：干跑（apply=false）也要用合并后的视图计算，否则"新增的共享声明"在结果里看不出效果。
  const seed = sharedIds.map((v) => String(v || "").trim()).filter(Boolean);
  const currentShared = Array.isArray(config.sharedLayers) ? config.sharedLayers.map(String) : [];
  const nextShared = [...new Set([...currentShared, ...seed])];
  const sharedChanged = nextShared.length !== currentShared.length
    || nextShared.some((id, i) => id !== currentShared[i]);
  const effectiveConfig = sharedChanged ? { ...config, sharedLayers: nextShared } : config;

  const changed = [];
  for (const layer of config.layers || []) {
    const { origin, owner } = layerOriginOf(layer, { workspace, config: effectiveConfig });
    const wantOwner = origin === ORIGIN.WORKSPACE ? owner : "";
    if (layer.origin !== origin || String(layer.owner || "") !== wantOwner) {
      changed.push({ id: layer.id, name: layer.name || layer.id, from: layer.origin || "(未标注)", to: origin, owner: wantOwner });
    }
  }
  if (apply) {
    if (sharedChanged) config.sharedLayers = nextShared;
    for (const item of changed) {
      const layer = (config.layers || []).find((l) => String(l.id) === String(item.id));
      if (!layer) continue;
      layer.origin = item.to;
      if (item.to === ORIGIN.WORKSPACE) layer.owner = item.owner;
      else delete layer.owner;
    }
    if (changed.length || sharedChanged) saveConfig(project, config);
  }
  return { project, changed, sharedChanged, applied: Boolean(apply && (changed.length || sharedChanged)) };
}

/**
 * 新建工作区图层后标注归属（importLayer 完成后调用）。
 * 共享数据集内的 id 不会被标注成工作区私有——内置/声明的共享图层不因导入而改变归属。
 */
export function markLayerOwnership(project, layerId, { workspace = "", name = "" } = {}) {
  const id = String(layerId || "");
  if (!id) return false;
  const proj = getProject(project);
  if (!proj) return false;
  const config = proj.config;
  if (isSharedLayerId(id, config)) return false;
  const layer = (config.layers || []).find((l) => String(l.id) === id);
  if (!layer) return false;
  layer.origin = ORIGIN.WORKSPACE;
  layer.owner = String(workspace || "");
  if (name) layer.name = String(name);
  saveConfig(project, config);
  return true;
}
