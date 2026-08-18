/**
 * 地图项目服务：项目读取/样式保存/图层导入/瓦片重建
 *
 * 目录结构（office-workspace/maps/{project}/）:
 *   map.config.json   项目配置（名称/中心/底图/图层清单）
 *   style.json        MapLibre 样式（sources 用相对瓦片 URL）
 *   layers/*.geojson  图层数据
 *   tiles/{layer}/{z}/{x}/{y}.pbf  矢量瓦片（生成产物）
 *
 * 静态文件由 index.mjs 挂载: /api/map/data/* → maps 根目录
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_DIR } from "./workspace.mjs";
import { LAYER_DEFS, GROUP_BY_TYPE, buildProjectTiles } from "../scripts/lib/tiler.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPS_ROOT = path.join(WORKSPACE_DIR, "maps");
export const DEFAULT_PROJECT = "zhejiang-map";

export const STATIC_ROOT = MAPS_ROOT; // index.mjs 静态挂载点

// 基础底图（始终可用）：高德 3 档，国内 CDN 稳定、CORS 全开
// style=8 路网（含道路注记） / style=6 卫星影像 / style=7 卫星影像+注记
const GAODE_BASEMAPS = {
  "gaode-road": {
    name: "高德路网",
    type: "raster",
    tileSize: 256,
    tiles: [
      "https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
      "https://webrd02.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
      "https://webrd03.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
      "https://webrd04.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
    ],
    attribution: '&copy; <a href="https://www.amap.com/">高德地图</a>',
  },
  "gaode-sat": {
    name: "高德卫星",
    type: "raster",
    tileSize: 256,
    tiles: [
      "https://webst01.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}",
      "https://webst02.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}",
      "https://webst03.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}",
      "https://webst04.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}",
    ],
    attribution: '&copy; <a href="https://www.amap.com/">高德地图</a>',
  },
  "gaode-sat-label": {
    name: "高德卫星注记",
    type: "raster",
    tileSize: 256,
    tiles: [
      "https://webst01.is.autonavi.com/appmaptile?style=7&x={x}&y={y}&z={z}",
      "https://webst02.is.autonavi.com/appmaptile?style=7&x={x}&y={y}&z={z}",
      "https://webst03.is.autonavi.com/appmaptile?style=7&x={x}&y={y}&z={z}",
      "https://webst04.is.autonavi.com/appmaptile?style=7&x={x}&y={y}&z={z}",
    ],
    attribution: '&copy; <a href="https://www.amap.com/">高德地图</a>',
  },
};

// 公开免 Key 栅格底图。OpenFreeMap 的 Liberty/Bright/Fiord 是完整 MapLibre
// 矢量样式，直接作为单个 raster source 会替换项目图层，因此不在此列表中。
function noKeyBasemaps() {
  return {
    "osm-standard": {
      name: "OSM 标准",
      type: "raster",
      tileSize: 256,
      maxzoom: 19,
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    },
    "carto-positron": {
      name: "CARTO 浅色",
      type: "raster",
      tileSize: 256,
      maxzoom: 20,
      tiles: ["https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"],
      attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
    "carto-dark": {
      name: "CARTO 暗色",
      type: "raster",
      tileSize: 256,
      maxzoom: 20,
      tiles: ["https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"],
      attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
    "carto-voyager": {
      name: "CARTO Voyager",
      type: "raster",
      tileSize: 256,
      maxzoom: 20,
      tiles: ["https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"],
      attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
    opentopomap: {
      name: "OpenTopoMap 地形",
      type: "raster",
      tileSize: 256,
      maxzoom: 17,
      tiles: [
        "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
        "https://b.tile.opentopomap.org/{z}/{x}/{y}.png",
        "https://c.tile.opentopomap.org/{z}/{x}/{y}.png",
      ],
      attribution: '&copy; <a href="https://opentopomap.org/">OpenTopoMap</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
    "tencent-road": {
      name: "腾讯路网（GCJ-02）",
      type: "raster",
      tileSize: 256,
      maxzoom: 18,
      scheme: "tms",
      tiles: [
        "https://rt0.map.gtimg.com/tile?z={z}&x={x}&y={y}&type=vector&styleid=0",
        "https://rt1.map.gtimg.com/tile?z={z}&x={x}&y={y}&type=vector&styleid=0",
        "https://rt2.map.gtimg.com/tile?z={z}&x={x}&y={y}&type=vector&styleid=0",
        "https://rt3.map.gtimg.com/tile?z={z}&x={x}&y={y}&type=vector&styleid=0",
      ],
      attribution: '&copy; <a href="https://map.qq.com/">腾讯地图</a>（GCJ-02）',
    },
    "tencent-satellite": {
      name: "腾讯卫星（GCJ-02）",
      type: "raster",
      tileSize: 256,
      maxzoom: 18,
      scheme: "tms",
      tiles: [
        "https://p0.map.gtimg.com/sateTiles/{z}/{x}/{y}.jpg",
        "https://p1.map.gtimg.com/sateTiles/{z}/{x}/{y}.jpg",
        "https://p2.map.gtimg.com/sateTiles/{z}/{x}/{y}.jpg",
        "https://p3.map.gtimg.com/sateTiles/{z}/{x}/{y}.jpg",
      ],
      attribution: '&copy; <a href="https://map.qq.com/">腾讯地图</a>（GCJ-02）',
    },
  };
}

// 底图设置（maps/settings.json）：各底图服务 Key
const MAP_SETTINGS_PATH = path.join(MAPS_ROOT, "settings.json");
// 密钥只写入 settings.local.json（被 .gitignore 忽略），避免误提交到仓库。
const MAP_SETTINGS_LOCAL_PATH = path.join(MAPS_ROOT, "settings.local.json");
const DEFAULT_MAP_SETTINGS = { basemaps: { tiandituKey: "", maptilerKey: "", geoapifyKey: "", esriToken: "" } };

export function loadMapSettings() {
  const raw = readJson(MAP_SETTINGS_PATH, null);
  const local = readJson(MAP_SETTINGS_LOCAL_PATH, null);
  return {
    basemaps: {
      ...DEFAULT_MAP_SETTINGS.basemaps,
      ...(raw?.basemaps || {}),
      ...(local?.basemaps || {}),
    },
  };
}

export function saveMapSettings(basemaps = {}) {
  const cur = loadMapSettings();
  cur.basemaps = {
    tiandituKey: String(basemaps.tiandituKey ?? cur.basemaps.tiandituKey ?? ""),
    maptilerKey: String(basemaps.maptilerKey ?? cur.basemaps.maptilerKey ?? ""),
    geoapifyKey: String(basemaps.geoapifyKey ?? cur.basemaps.geoapifyKey ?? ""),
    esriToken: String(basemaps.esriToken ?? cur.basemaps.esriToken ?? ""),
  };
  fs.mkdirSync(MAPS_ROOT, { recursive: true });
  fs.writeFileSync(MAP_SETTINGS_LOCAL_PATH, JSON.stringify({ basemaps: cur.basemaps }, null, 2));
  return cur;
}

// Esri 免费底图（World_Imagery / World_Street_Map，无需 Key）
function esriBasemaps() {
  return {
    "esri-sat": {
      name: "Esri 卫星",
      type: "raster",
      tileSize: 256,
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      attribution: '&copy; Esri, Maxar, Earthstar Geographics',
    },
    "esri-street": {
      name: "Esri 街道",
      type: "raster",
      tileSize: 256,
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}"],
      attribution: '&copy; Esri, HERE, Garmin, OpenStreetMap contributors',
    },
  };
}

// 天地图 WMTS（XYZ 风格），需用户填 tk；子域 t0-t7
function tiandituBasemaps(key) {
  const tk = encodeURIComponent(key);
  const hosts = ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7"];
  const wmts = (layer, matrix) =>
    hosts.map(
      (h) =>
        `https://${h}.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=default&TILEMATRIXSET=${matrix}&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${tk}`
    );
  return {
    "tianditu-vec": {
      name: "天地图矢量",
      type: "raster",
      tileSize: 256,
      tiles: wmts("vec", "w"),
      attribution: '&copy; <a href="https://www.tianditu.gov.cn/">天地图</a>',
    },
    "tianditu-img": {
      name: "天地图影像",
      type: "raster",
      tileSize: 256,
      tiles: wmts("img", "w"),
      attribution: '&copy; <a href="https://www.tianditu.gov.cn/">天地图</a>',
    },
  };
}

// MapTiler XYZ，需用户填 Key
function maptilerBasemaps(key) {
  const k = encodeURIComponent(key);
  const raster = (name, mapId, ext = "png") => ({
    name,
    type: "raster",
    tileSize: 256,
    tiles: [`https://api.maptiler.com/maps/${mapId}/{z}/{x}/{y}.${ext}?key=${k}`],
    attribution: '&copy; <a href="https://www.maptiler.com/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  });
  return {
    "maptiler-streets": raster("MapTiler 街道", "streets-v2"),
    "maptiler-satellite": {
      ...raster("MapTiler 卫星", "satellite-v2", "jpg"),
      tiles: [`https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=${k}`],
    },
    "maptiler-hybrid": raster("MapTiler 卫星混合注记", "hybrid", "jpg"),
    "maptiler-outdoor": raster("MapTiler 户外地形", "outdoor-v2"),
    "maptiler-winter": raster("MapTiler 冬季地形", "winter-v2"),
    "maptiler-basic": raster("MapTiler 简洁底图", "basic-v2"),
  };
}

/** 按设置生成可用底图源（免 Key 源固定，天地图/MapTiler 填 Key 后启用） */
function markBasemap(s) {
  return { ...s, metadata: { ...(s.metadata || {}), basemap: true } };
}
export function getBasemaps(settings = loadMapSettings()) {
  let b = {};
  b.blank = markBasemap({ name: "无底图", type: "raster", tileSize: 256, tiles: [], attribution: "" });
  for (const [id, s] of Object.entries(GAODE_BASEMAPS)) b[id] = markBasemap(s);
  for (const [id, s] of Object.entries(noKeyBasemaps())) b[id] = markBasemap(s);
  for (const [id, s] of Object.entries(esriBasemaps())) b[id] = markBasemap(s);
  const tk = settings?.basemaps?.tiandituKey;
  if (tk) for (const [id, s] of Object.entries(tiandituBasemaps(tk))) b[id] = markBasemap(s);
  const mk = settings?.basemaps?.maptilerKey;
  if (mk) for (const [id, s] of Object.entries(maptilerBasemaps(mk))) b[id] = markBasemap(s);
  return b;
}

/** 图层默认样式（与 LAYER_DEFS 对齐，Agent 可改 style.json 覆盖） */
function layerStyle(def) {
  const base = { id: def.id, source: def.id, "source-layer": def.id, layout: { visibility: "visible" } };
  switch (def.type) {
    case "boundary":
      return {
        ...base,
        type: "line",
        paint: {
          "line-color": def.id === "boundary-city" ? "#e4572e" : "#b8b8c8",
          "line-width": def.id === "boundary-city" ? 2 : 0.8,
          "line-opacity": 0.9,
          "line-dasharray": def.id === "boundary-city" ? [1, 0] : [2, 1.2],
        },
      };
    case "road":
      return {
        ...base,
        type: "line",
        paint: {
          "line-color": def.id === "highways" ? "#d62728" : def.id === "roads-rural" ? "#2ca02c" : "#ff7f0e",
          "line-width": def.id === "highways" ? ["interpolate", ["linear"], ["zoom"], 5, 1, 10, 2.5, 13, 4.5] : ["interpolate", ["linear"], ["zoom"], 5, 0.8, 10, 1.8, 13, 3.2],
          "line-opacity": 0.85,
        },
      };
    case "point":
      return {
        ...base,
        type: "circle",
        paint: {
          "circle-radius": def.id === "toll-stations" ? 4 : 4.5,
          "circle-color": def.id === "toll-stations" ? "#2ca02c" : "#9467bd",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
          "circle-opacity": 0.9,
        },
      };
    default:
      return base;
  }
}

function getDefaultStyle(project) {
  const basemaps = getBasemaps();
  const sources = { ...basemaps };
  for (const def of LAYER_DEFS) {
    sources[def.id] = {
      type: "vector",
      // 绝对路径：MapLibre 不解析 sources.tiles 的相对 URL
      tiles: [`/api/map/data/${project}/tiles/${def.id}/{z}/{x}/{y}.pbf`],
      maxzoom: def.maxzoom,
    };
  }
  // 底图栅格图层：切换底图 = 切换显隐，无需整样式重载
  const DEFAULT_BASEMAP = "gaode-road";
  const basemapLayers = Object.keys(basemaps).map((id) =>
    id === "blank"
      ? {
          id: "basemap-blank",
          type: "background",
          layout: { visibility: id === DEFAULT_BASEMAP ? "visible" : "none" },
          paint: { "background-color": "rgba(0,0,0,0)" },
        }
      : {
          id: `basemap-${id}`,
          type: "raster",
          source: id,
          layout: { visibility: id === DEFAULT_BASEMAP ? "visible" : "none" },
          paint: { "raster-opacity": 1 },
        }
  );
  const layers = [
    ...basemapLayers,
    ...LAYER_DEFS.map(layerStyle),
  ];
  return {
    version: 8,
    name: `${project} 地图样式`,
    sources,
    layers,
    glyphs: "https://glyphs.openfreestyle.com/{fontstack}/{range}.pbf",
  };
}

function defaultConfig(project) {
  return {
    name: project === "zhejiang-map" ? "浙江省交通基础数据沙盘" : project,
    project,
    center: [120.0, 29.2],
    zoom: 7,
    basemap: "gaode-road",
    layers: LAYER_DEFS.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      group: d.group || GROUP_BY_TYPE[d.type] || "其他",
      visible: true,
      minzoom: d.minzoom,
      maxzoom: d.maxzoom,
    })),
  };
}

/** 项目目录（防目录穿越） */
export function projectDir(name = DEFAULT_PROJECT) {
  const n = String(name || "").replace(/[\\/]/g, "");
  if (!n || n === "." || n === "..") return null;
  return path.join(MAPS_ROOT, n);
}

export function listProjects() {
  if (!fs.existsSync(MAPS_ROOT)) return [];
  return fs
    .readdirSync(MAPS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(MAPS_ROOT, e.name, "map.config.json")))
    .map((e) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(MAPS_ROOT, e.name, "map.config.json"), "utf8"));
      } catch {
        return { project: e.name, name: e.name };
      }
    });
}

function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

// 样式文件可能被提交到仓库，持久化时把底图服务凭证替换为占位符。
// 运行时由 /api/map/data/:project/style.json 注入真实 URL，因此地图仍可正常加载。
function redactBasemapCredentials(style) {
  const out = { ...style, sources: { ...(style?.sources || {}) } };
  for (const [id, source] of Object.entries(out.sources)) {
    if (!source?.metadata?.basemap && !/^(maptiler|tianditu)-/.test(id)) continue;
    out.sources[id] = {
      ...source,
      tiles: Array.isArray(source.tiles)
        ? source.tiles.map((t) => String(t).replace(/([?&](?:key|tk)=)[^&]+/gi, "$1__MAP_SERVICE_KEY__"))
        : source.tiles,
    };
  }
  return out;
}

/** 将当前本地设置注入样式响应，不把凭证写回 tracked style.json。 */
export function hydrateBasemapSources(style) {
  const out = { ...style, sources: { ...(style?.sources || {}) } };
  const runtime = getBasemaps();
  for (const [id, source] of Object.entries(runtime)) out.sources[id] = source;

  // 兼容旧的 tracked style.json：新增免 Key 底图无需用户先保存一次设置，
  // 也能在动态样式响应中直接出现。缺失的底图图层插入到第一个业务图层之前，
  // 避免栅格覆盖道路、边界和分析图层。
  const layers = Array.isArray(out.layers) ? [...out.layers] : [];
  const baseIds = new Set(layers.filter((l) => String(l?.id || "").startsWith("basemap-")).map((l) => String(l.id).slice("basemap-".length)));
  const visibleId = layers.find((l) => String(l?.id || "").startsWith("basemap-") && l.layout?.visibility === "visible")?.id?.slice("basemap-".length) || "gaode-road";
  const missing = Object.keys(runtime).filter((id) => !baseIds.has(id));
  if (missing.length) {
    const insertAt = layers.findIndex((l) => !String(l?.id || "").startsWith("basemap-"));
    const baseLayers = missing.map((id) => id === "blank"
      ? {
          id: "basemap-blank",
          type: "background",
          layout: { visibility: id === visibleId ? "visible" : "none" },
          paint: { "background-color": "rgba(0,0,0,0)" },
        }
      : {
          id: `basemap-${id}`,
          type: "raster",
          source: id,
          layout: { visibility: id === visibleId ? "visible" : "none" },
          paint: { "raster-opacity": 1 },
        });
    layers.splice(insertAt < 0 ? layers.length : insertAt, 0, ...baseLayers);
    out.layers = layers;
  }
  return out;
}

export function ensureProject(name = DEFAULT_PROJECT) {
  const dir = projectDir(name);
  if (!dir) return null;
  fs.mkdirSync(path.join(dir, "layers"), { recursive: true });
  const cfgPath = path.join(dir, "map.config.json");
  const stylePath = path.join(dir, "style.json");
  if (!fs.existsSync(cfgPath)) fs.writeFileSync(cfgPath, JSON.stringify(defaultConfig(name), null, 2));
  if (!fs.existsSync(stylePath)) fs.writeFileSync(stylePath, JSON.stringify(redactBasemapCredentials(getDefaultStyle(name)), null, 2));
  return dir;
}

/** 项目详情：config + style + 图层文件清单 */
export function getProject(name = DEFAULT_PROJECT) {
  const dir = ensureProject(name);
  if (!dir) return null;
  const config = readJson(path.join(dir, "map.config.json"), defaultConfig(name));
  const style = readJson(path.join(dir, "style.json"), getDefaultStyle(name));
  const layersDir = path.join(dir, "layers");
  const files = fs.existsSync(layersDir)
    ? fs.readdirSync(layersDir, { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith("._") && !e.name.startsWith(".") && e.name.endsWith(".geojson"))
        .map((e) => {
          const st = fs.statSync(path.join(layersDir, e.name));
          return { file: e.name, id: e.name.replace(/\.geojson$/, ""), size: st.size, mtime: st.mtimeMs };
        })
    : [];
  const basemaps = getBasemaps();
  return {
    config,
    style,
    files,
    basemaps: Object.keys(basemaps),
    basemapMeta: Object.entries(basemaps).map(([id, s]) => ({ id, name: s.name || id })),
  };
}

export function saveStyle(name, style) {
  const dir = ensureProject(name);
  if (!dir || !style || typeof style !== "object") return null;
  fs.writeFileSync(path.join(dir, "style.json"), JSON.stringify(style, null, 2));
  return true;
}

export function saveConfig(name, config) {
  const dir = ensureProject(name);
  if (!dir || !config) return null;
  fs.writeFileSync(path.join(dir, "map.config.json"), JSON.stringify(config, null, 2));
  return true;
}

/**
 * 按最新底图设置重建 style.json 的底图部分（保留图层自定义样式）。
 * 底图源 = id 出现在当前 getBasemaps() 里的 sources；其余 sources/图层原样保留。
 */
export function rebuildBasemapStyle(name = DEFAULT_PROJECT) {
  const dir = projectDir(name);
  if (!dir) return false;
  const stylePath = path.join(dir, "style.json");
  const basemaps = getBasemaps();
  const cfg = readJson(path.join(dir, "map.config.json"), defaultConfig(name));
  const current = cfg?.basemap;
  const DEFAULT_BASEMAP = current && basemaps[current] ? current : "gaode-road";

  let style = readJson(stylePath, null);
  if (!style || typeof style !== "object" || !style.sources) {
    fs.writeFileSync(stylePath, JSON.stringify(redactBasemapCredentials(getDefaultStyle(name)), null, 2));
    return true;
  }
  // 保留非底图 sources（底图 source 带 metadata.basemap 标记）
  const sources = {};
  for (const [id, s] of Object.entries(style.sources)) {
    if (!s?.metadata?.basemap && !s?.basemap) sources[id] = s;
  }
  Object.assign(sources, basemaps);
  // 保留非底图图层，重建 basemap-* 图层
  const keep = style.layers.filter((l) => !String(l.id).startsWith("basemap-"));
  const baseLayers = Object.keys(basemaps).map((id) =>
    id === "blank"
      ? {
          id: "basemap-blank",
          type: "background",
          layout: { visibility: id === DEFAULT_BASEMAP ? "visible" : "none" },
          paint: { "background-color": "rgba(0,0,0,0)" },
        }
      : {
          id: `basemap-${id}`,
          type: "raster",
          source: id,
          layout: { visibility: id === DEFAULT_BASEMAP ? "visible" : "none" },
          paint: { "raster-opacity": 1 },
        }
  );
  // 同步 config.layers 中缺失的矢量图层（数据已导入但 style 未注册，如 roads-province）
  for (const l of cfg?.layers || []) {
    const id = l.id;
    if (!sources[id]) {
      sources[id] = {
        type: "vector",
        tiles: [`/api/map/data/${name}/tiles/${id}/{z}/{x}/{y}.pbf`],
        maxzoom: l.maxzoom || 13,
      };
    }
    if (!style.layers.some((x) => x.id === id)) {
      const def = { id, type: l.type || "road", minzoom: l.minzoom || 5, maxzoom: l.maxzoom || 13 };
      keep.push(layerStyle(def));
    }
    // 道路图层自动补标号图层（显示 ref 编号，缺失回退 name），置于线图层之后
    if (l.type === "road" && !style.layers.some((x) => x.id === `${id}-label`)) {
      keep.push({
        id: `${id}-label`,
        type: "symbol",
        source: id,
        "source-layer": id,
        minzoom: (l.minzoom || 5) + 2,
        layout: {
          "symbol-placement": "line",
          "text-field": ["coalesce", ["get", "ref"], ["get", "name"], ""],
          "text-size": ["interpolate", ["linear"], ["zoom"], 8, 10, 13, 12],
          "text-font": ["Noto Sans Regular"],
          "text-rotation-alignment": "map",
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": "#ffffff",
          "text-halo-color": "rgba(0,0,0,0.75)",
          "text-halo-width": 1.2,
        },
      });
    }
  }
  style.sources = sources;
  style.layers = [...baseLayers, ...keep];
  fs.writeFileSync(stylePath, JSON.stringify(redactBasemapCredentials(style), null, 2));
  return true;
}

/** 导入/覆盖一个 GeoJSON 图层并重建其瓦片 */
export async function importLayer(name, layerId, geojson) {
  const dir = ensureProject(name);
  const safeId = String(layerId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!dir || !safeId) return null;
  const target = path.join(dir, "layers", `${safeId}.geojson`);
  fs.writeFileSync(target, typeof geojson === "string" ? geojson : JSON.stringify(geojson));
  // 把新图层加入 config（若不存在）
  const config = readJson(path.join(dir, "map.config.json"), defaultConfig(name));
  if (!config.layers.some((l) => l.id === safeId)) {
    const type = guessType(geojson);
    config.layers.push({ id: safeId, name: safeId, type, group: GROUP_BY_TYPE[type] || "其他", visible: true, minzoom: 5, maxzoom: 13 });
    fs.writeFileSync(path.join(dir, "map.config.json"), JSON.stringify(config, null, 2));
  }
  // 重建该图层瓦片（缺 def 时按通用参数）
  const def = LAYER_DEFS.find((d) => d.id === safeId) || { id: safeId, minzoom: 5, maxzoom: 13, tolerance: 0.0001 };
  const r = buildProjectTiles(dir, { layerIds: [safeId], force: true, defs: [def] });
  // 导入后立即把新图层注册到 style，确保前端可见性复选框和 Agent 产物都能正常显示/隐藏。
  rebuildBasemapStyle(name);
  return { ok: true, layer: safeId, tiles: r[safeId] };
}

function guessType(geojson) {
  const fc = typeof geojson === "string" ? JSON.parse(geojson) : geojson;
  const g = fc?.features?.[0]?.geometry?.type;
  if (g === "Point" || g === "MultiPoint") return "point";
  if (g === "LineString" || g === "MultiLineString") return "road";
  return "boundary";
}

/** 重建全部瓦片（工具箱按钮 / 数据变更后） */
export function rebuildTiles(name = DEFAULT_PROJECT, layerIds = null) {
  const dir = ensureProject(name);
  if (!dir) return null;
  return buildProjectTiles(dir, { force: true, layerIds });
}

/** 批量导入多个图层（逐个导入 + 统一重建瓦片） */
export async function importBatch(name, items) {
  const results = {};
  for (const it of items || []) {
    if (!it?.geojson) continue;
    const safeId = String(it.layerId || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safeId) continue;
    try { results[safeId] = await importLayer(name, safeId, it.geojson); } catch { results[safeId] = { ok: false, error: "导入失败" }; }
  }
  const tiles = rebuildTiles(name);
  return { ok: true, layers: results, tiles };
}

/** 读取图层原始 GeoJSON */
export function getLayer(name, layerId) {
  const dir = projectDir(name);
  const safeId = String(layerId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!dir || !safeId) return null;
  const p = path.join(dir, "layers", `${safeId}.geojson`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

/** 删除图层：移除 geojson + 瓦片 + style 图层 + config 条目 */
export function deleteLayer(name, layerId) {
  const dir = projectDir(name);
  const safeId = String(layerId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!dir || !safeId) return { ok: false, error: "invalid layer" };
  const dataPath = path.join(dir, "layers", `${safeId}.geojson`);
  if (fs.existsSync(dataPath)) fs.rmSync(dataPath);
  const tilesPath = path.join(dir, "tiles", safeId);
  if (fs.existsSync(tilesPath)) fs.rmSync(tilesPath, { recursive: true });
  // style 里移除对应图层
  const style = readJson(path.join(dir, "style.json"), getDefaultStyle(name));
  const before = style.layers.length;
  style.layers = style.layers.filter((l) => l.id !== safeId && !l.id.startsWith(`basemap-${safeId}`));
  if (style.sources?.[safeId]) delete style.sources[safeId];
  if (style.layers.length !== before) {
    fs.writeFileSync(path.join(dir, "style.json"), JSON.stringify(style, null, 2));
  }
  // config 里移除条目
  const config = readJson(path.join(dir, "map.config.json"), defaultConfig(name));
  config.layers = (config.layers || []).filter((l) => l.id !== safeId);
  fs.writeFileSync(path.join(dir, "map.config.json"), JSON.stringify(config, null, 2));
  return { ok: true };
}

// ---------- 外部服务 ----------

/** 等时圈分析（高德 v5 isochrone）… */
export async function isochrone({ location, mode = "driving", range = 30, rangeType = "time" }) {
  const settings = loadMapSettings();
  const geoapifyKey = settings?.basemaps?.geoapifyKey || process.env.GEOAPIFY_KEY || "";
  if (geoapifyKey) return isochroneGeoapify({ location, mode, range, rangeType, key: geoapifyKey });
  const key = process.env.AMAP_KEY || process.env.GAODE_KEY || "";
  if (!key) return { error: "未配置 Geoapify 或高德等时圈 Key（可在设置中配置 Geoapify Key）" };
  const url = new URL("https://restapi.amap.com/v5/isochrone");
  url.searchParams.set("key", key);
  url.searchParams.set("location", String(location || ""));
  url.searchParams.set("mode", String(mode || "driving"));
  url.searchParams.set("range_type", String(rangeType || "time"));
  url.searchParams.set("range", String(range || 30));
  let data;
  try {
    const r = await fetch(url);
    data = await r.json();
  } catch (e) {
    return { error: "等时圈请求失败: " + e.message };
  }
  if (data.status !== "1") return { error: data.info || data.infocode || "等时圈请求失败" };
  const polygons = (data.result?.polygons || [])
    .map((p) => normalizePoints(p.points))
    .filter((pts) => pts && pts.length >= 3);
  return { error: null, center: data.result.center, cost: data.result.cost, polygons };
}

/** Geoapify Isoline API：返回 GeoJSON，统一转换为当前前端使用的外环点数组。 */
async function isochroneGeoapify({ location, mode = "driving", range = 30, rangeType = "time", key }) {
  const [lon, lat] = String(location || "").split(",").map(Number);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return { error: "等时圈中心点坐标无效" };
  const modeMap = { driving: "drive", walking: "walk", bicycling: "bicycle", transit: "transit", drive: "drive", walk: "walk", bicycle: "bicycle" };
  const apiType = rangeType === "distance" ? "distance" : "time";
  const numericRange = Number(range) || 30;
  const apiRange = apiType === "distance" ? Math.round(numericRange * 1000) : Math.round(numericRange * 60);
  const url = new URL("https://api.geoapify.com/v1/isoline");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("type", apiType);
  url.searchParams.set("mode", modeMap[mode] || "drive");
  url.searchParams.set("range", String(apiRange));
  url.searchParams.set("apiKey", key);
  let data;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
    data = await response.json();
    if (!response.ok) return { error: data?.message || `Geoapify 等时圈请求失败（${response.status}）` };
  } catch (e) {
    return { error: "Geoapify 等时圈请求失败: " + e.message };
  }
  const polygons = [];
  for (const feature of data?.features || []) {
    const geometry = feature?.geometry;
    if (geometry?.type === "Polygon" && geometry.coordinates?.[0]?.length >= 3) polygons.push(geometry.coordinates[0]);
    if (geometry?.type === "MultiPolygon") {
      for (const polygon of geometry.coordinates || []) if (polygon?.[0]?.length >= 3) polygons.push(polygon[0]);
    }
  }
  if (!polygons.length) return { error: data?.message || "Geoapify 未返回有效等时圈多边形" };
  return { error: null, provider: "geoapify", center: [lon, lat], cost: null, polygons };
}

/** 高德 points 可能是 [[lng,lat],...] 或 [{lng,lat},...] 或字符串 */
function normalizePoints(points) {
  if (typeof points === "string") {
    try { points = JSON.parse(points); } catch { return null; }
  }
  if (!Array.isArray(points)) return null;
  return points.map((p) => {
    if (Array.isArray(p)) return [Number(p[0]), Number(p[1])];
    if (p && typeof p === "object") return [Number(p.lng), Number(p.lat)];
    return null;
  }).filter(Boolean);
}

/**
 * 路径规划（可插拔 provider）
 * - osrm（默认）：开源 OSRM 公共服务器，零配置；也可配 OSRM_URL 指向自托管实例
 * - amap：高德 v5 direction（需 AMAP_KEY，中国路网更准）
 * 返回: { error: null, provider, distance(米), duration(秒), geometry: [[lng,lat],...] }
 */
export async function route({ from, to, mode = "driving", provider = "osrm" }) {
  if (!from || !to) return { error: "需要起点和终点坐标" };
  if (provider === "amap") return routeAmap(from, to, mode);
  return routeOsrm(from, to, mode);
}

async function routeOsrm(from, to, mode) {
  const profile = mode === "walking" ? "foot" : mode === "bicycling" ? "bike" : "driving";
  const base = process.env.OSRM_URL || "https://router.project-osrm.org";
  const url = `${base}/route/v1/${profile}/${from};${to}?overview=full&geometries=geojson&steps=false`;
  let data;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    data = await r.json();
  } catch (e) {
    return { error: "OSRM 请求失败: " + e.message + "（可配置环境变量 OSRM_URL 指向自托管实例，或改用 provider=amap）" };
  }
  if (data.code !== "Ok" || !data.routes?.length) {
    return { error: "OSRM 未找到路径: " + (data.code || "unknown") + "（请确认两点间有路网）" };
  }
  const route0 = data.routes[0];
  return {
    error: null,
    provider: "osrm",
    distance: route0.distance,
    duration: route0.duration,
    geometry: route0.geometry?.coordinates || [],
  };
}

async function routeAmap(from, to, mode) {
  const key = process.env.AMAP_KEY || process.env.GAODE_KEY || "";
  if (!key) return { error: "未配置高德 Web 服务 Key（环境变量 AMAP_KEY），请改用默认 OSRM 开源路由" };
  const amapMode = { driving: "driving", walking: "walking", bicycling: "bicycling", transit: "transit" }[mode] || "driving";
  const url = new URL("https://restapi.amap.com/v5/direction/" + amapMode);
  url.searchParams.set("key", key);
  url.searchParams.set("origin", from);
  url.searchParams.set("destination", to);
  url.searchParams.set("show_fields", "polyline,cost");
  let data;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    data = await r.json();
  } catch (e) {
    return { error: "高德路径请求失败: " + e.message };
  }
  if (data.status !== "1" || !data.route?.paths?.length) {
    return { error: "高德未找到路径: " + (data.info || data.infocode || "unknown") };
  }
  const path = data.route.paths[0];
  const coords = String(path.polyline || "")
    .split(";")
    .filter(Boolean)
    .map((p) => p.split(",").map(Number));
  return {
    error: null,
    provider: "amap",
    distance: path.distance ? Number(path.distance) : 0,
    duration: path.cost?.duration ? Number(path.cost.duration) : 0,
    geometry: coords,
  };
}
