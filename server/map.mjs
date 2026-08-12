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
import { LAYER_DEFS, buildProjectTiles } from "../scripts/lib/tiler.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPS_ROOT = path.join(WORKSPACE_DIR, "maps");
export const DEFAULT_PROJECT = "zhejiang-map";

export const STATIC_ROOT = MAPS_ROOT; // index.mjs 静态挂载点

const BASEMAPS = {
  carto: {
    name: "Carto 亮色",
    type: "raster",
    tiles: ["https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"],
    tileSize: 256,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
  osm: {
    name: "OSM 标准",
    type: "raster",
    tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
    tileSize: 256,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  },
  dark: {
    name: "Carto 暗色",
    type: "raster",
    tiles: ["https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"],
    tileSize: 256,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
  satellite: {
    name: "卫星影像",
    type: "raster",
    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
    tileSize: 256,
    attribution: '&copy; Esri, Maxar, Earthstar Geographics',
  },
};

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
          "line-color": def.id === "highways" ? "#d62728" : "#ff7f0e",
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
  const sources = { ...BASEMAPS };
  for (const def of LAYER_DEFS) {
    sources[def.id] = {
      type: "vector",
      // 绝对路径：MapLibre 不解析 sources.tiles 的相对 URL
      tiles: [`/api/map/data/${project}/tiles/${def.id}/{z}/{x}/{y}.pbf`],
      maxzoom: def.maxzoom,
    };
  }
  // 4 个底图栅格图层：切换底图 = 切换显隐，无需整样式重载
  const basemapLayers = Object.keys(BASEMAPS).map((id) => ({
    id: `basemap-${id}`,
    type: "raster",
    source: id,
    layout: { visibility: id === "carto" ? "visible" : "none" },
    paint: { "raster-opacity": 1 },
  }));
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
    name: project === "zhejiang-map" ? "浙江省交通地图" : project,
    project,
    center: [120.0, 29.2],
    zoom: 7,
    basemap: "carto",
    layers: LAYER_DEFS.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
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

export function ensureProject(name = DEFAULT_PROJECT) {
  const dir = projectDir(name);
  if (!dir) return null;
  fs.mkdirSync(path.join(dir, "layers"), { recursive: true });
  const cfgPath = path.join(dir, "map.config.json");
  const stylePath = path.join(dir, "style.json");
  if (!fs.existsSync(cfgPath)) fs.writeFileSync(cfgPath, JSON.stringify(defaultConfig(name), null, 2));
  if (!fs.existsSync(stylePath)) fs.writeFileSync(stylePath, JSON.stringify(getDefaultStyle(name), null, 2));
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
        .filter((e) => e.isFile() && e.name.endsWith(".geojson"))
        .map((e) => {
          const st = fs.statSync(path.join(layersDir, e.name));
          return { file: e.name, id: e.name.replace(/\.geojson$/, ""), size: st.size, mtime: st.mtimeMs };
        })
    : [];
  return { config, style, files, basemaps: Object.keys(BASEMAPS) };
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
    config.layers.push({ id: safeId, name: safeId, type: guessType(geojson), visible: true, minzoom: 5, maxzoom: 13 });
    fs.writeFileSync(path.join(dir, "map.config.json"), JSON.stringify(config, null, 2));
  }
  // 重建该图层瓦片（缺 def 时按通用参数）
  const def = LAYER_DEFS.find((d) => d.id === safeId) || { id: safeId, minzoom: 5, maxzoom: 13, tolerance: 0.0001 };
  const r = buildProjectTiles(dir, { layerIds: [safeId], force: true, defs: [def] });
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
