import React, { useState, useEffect, useCallback, useRef } from "react";
import MapViewer from "./MapViewer.jsx";
import ChatPanel from "./ChatPanel.jsx";
import LayerPanel from "./LayerPanel.jsx";
import AttributeTable from "./AttributeTable.jsx";
import Icon from "./Icon.jsx";
import TaskCenter from "./任务中心.jsx";
import M2Analysis from "./M2宏观分析.jsx";
import M3Analysis from "./M3公交分析.jsx";
import CambodiaODPanel from "./柬埔寨OD面板.jsx";
import shp from "shpjs";
import {
  mapProjects, mapProject, mapSaveStyle, mapSaveConfig,
  mapDeleteLayer, mapRebuild, mapGetLayer, mapImportLayer, mapImportBatch, mapPrepare, mapIsochrone, mapRoute, mapDemoAnalysis,
} from "../api.js";

// 底图按钮兜底（服务端未返回元信息时）：服务端按 Key 配置动态生成底图列表
const BASEMAP_FALLBACK = [
  { id: "gaode-road", name: "路网" },
  { id: "gaode-sat", name: "卫星" },
  { id: "gaode-sat-label", name: "卫星注记" },
];
const ISO_MODES = [
  { id: "driving", label: "驾车" },
  { id: "walking", label: "步行" },
  { id: "bicycling", label: "骑行" },
  { id: "transit", label: "公交" },
];

function geometryBounds(geometry) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number") {
      b[0] = Math.min(b[0], c[0]);
      b[1] = Math.min(b[1], c[1]);
      b[2] = Math.max(b[2], c[0]);
      b[3] = Math.max(b[3], c[1]);
      return;
    }
    c.forEach(walk);
  };
  walk(geometry?.coordinates || []);
  return b[0] === Infinity ? null : b;
}

async function parseShapefile(shpjs, shpFile, selected) {
  const stem = shpFile.name.replace(/\.shp$/i, "");
  const companion = (ext) => selected.find((x) => (
    x.name.replace(new RegExp("\\." + ext + "$", "i"), "").toLowerCase() === stem.toLowerCase()
  ));
  const dbfFile = companion("dbf");
  const prjFile = companion("prj");
  const cpgFile = companion("cpg");
  const [shpBuffer, dbfBuffer, prjText, cpgText] = await Promise.all([
    shpFile.arrayBuffer(),
    dbfFile?.arrayBuffer(),
    prjFile?.text(),
    cpgFile?.text(),
  ]);
  const geometries = shpjs.parseShp(shpBuffer, prjText || false);
  const properties = dbfBuffer ? shpjs.parseDbf(dbfBuffer, cpgText || undefined) : undefined;
  return shpjs.combine([geometries, properties]);
}

/**
 * 地图全屏模式（GIS 项目，与知识库/模版库同款布局）
 *
 * 布局：
 *   顶栏：项目选择 / 底图切换 / 重建瓦片 / 导出 PNG / 等时圈分析 / 返回
 *   左栏：图层文件树（显隐、透明度、顺序、缩放定位、删除、导入）
 *   中栏：MapViewer（MapLibre GL 矢量瓦片地图）
 *   右栏：ChatPanel（与 agent 对话，agent 通过 map_* 工具改地图，前端实时刷新）
 */
export default function MapPanel({
  onExit, onOpenFile,
  clientId, threadId, workspace = "", models, defaultModel, onAgentEnd, onNewSession, historyMessages, sessions, currentSessionId, onSelectSession,
  onSessionChange, onRefreshSessions, onFocusRun, hideChat = false, bridgeRef, onViewportChange,
}) {
  const [projects, setProjects] = useState([]);
  const [project, setProject] = useState("zhejiang-map");
  const [cfg, setCfg] = useState(null);
  const [style, setStyle] = useState(null);
  const [files, setFiles] = useState([]);
  const [basemapMeta, setBasemapMeta] = useState([]);
  const [drill, setDrill] = useState(null); // 下钻状态 {source, code, name, level}
  const [regionOptions, setRegionOptions] = useState([{ value: "", label: "全省 / 全部区域" }]);
  const [regionCode, setRegionCode] = useState("");
  const [layerScope, setLayerScope] = useState("region"); // 当前区域 / 当前地市 / 全省
  const [regionQuery, setRegionQuery] = useState("");
  const [annotationsVisible, setAnnotationsVisible] = useState(true);
  const [m2Tab, setM2Tab] = useState(null); // M2 宏观分析标签
  const [m3Tab, setM3Tab] = useState(null); // M3 公交分析标签
  const [cambodiaOpen, setCambodiaOpen] = useState(false);
  const [demoOpen, setDemoOpen] = useState(false);
  const [analysisMenuOpen, setAnalysisMenuOpen] = useState(false);
  const [globeMode, setGlobeMode] = useState(false);
  const [activeAnalysis, setActiveAnalysis] = useState(null);
  const [msg, setMsg] = useState("");
  const [selectedLayer, setSelectedLayer] = useState(null);
  const [attrLayer, setAttrLayer] = useState(null); // {layerId, name}
  const [draw, setDraw] = useState(null);            // 测量/绘制 {kind, points}
  const [measureResult, setMeasureResult] = useState(null); // {dist?, area?}
  const [toolMenu, setToolMenu] = useState(null);    // 顶栏工具菜单 {x, y, type: "measure"|"draw"}
  const [leftW, setLeftW] = useState(260);           // 左栏宽度（可拖拽）
  const [rightW, setRightW] = useState(360);         // 右栏宽度（可拖拽）
  const paneDragRef = useRef(null);

  // 左右栏宽度拖拽（side: left|right）
  const startPaneDrag = useCallback((e, side) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === "left" ? leftW : rightW;
    paneDragRef.current = { side, startX, startW };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev) => {
      const delta = ev.clientX - paneDragRef.current.startX;
      const next = Math.min(480, Math.max(180, paneDragRef.current.startW + (paneDragRef.current.side === "left" ? delta : -delta)));
      if (paneDragRef.current.side === "left") setLeftW(next);
      else setRightW(next);
    };
    const onUp = () => {
      paneDragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [leftW, rightW]);
  const [isoOpen, setIsoOpen] = useState(false);
  const [iso, setIso] = useState({ mode: "driving", range: 30, multi: false, ranges: "30,60,90", loc: null, picking: false, loading: false, err: "", info: "", tab: "iso", route: { from: null, to: null, mode: "driving", loading: false, err: "", info: "" } });
  const [exportOpen, setExportOpen] = useState(false); // 报告图导出弹窗
  const [exp, setExp] = useState({ size: "a4l", title: "", legend: true, customW: 1600, customH: 1131 });
  const [importOpen, setImportOpen] = useState(false); // 数据导入弹窗
  const [impTab, setImpTab] = useState("files");
  const [impDir, setImpDir] = useState("data");
  const [impMsg, setImpMsg] = useState("");
  const impFileRef = useRef(null);
  const [odOpen, setOdOpen] = useState(false);      // OD 分析弹窗
  const [odText, setOdText] = useState("");
  const [odCols, setOdCols] = useState({ olng: "", olat: "", dlng: "", dlat: "", flow: "" });
  const [odHeader, setOdHeader] = useState([]);
  const [odMsg, setOdMsg] = useState("");
  const [odShowLines, setOdShowLines] = useState(true);

  // ---- OD 流量热力图 ----
  // 列名自动检测（支持中英文）
  const detectCols = useCallback((header) => {
    const find = (patterns) => header.find((h) => patterns.some((p) => h.toLowerCase().includes(p))) || "";
    return {
      olng: find(["起点经", "出发经", "olng", "from_lng", "fromlng", "origin_lng"]),
      olat: find(["起点纬", "出发纬", "olat", "from_lat", "fromlat", "origin_lat"]),
      dlng: find(["终点经", "到达经", "dlng", "to_lng", "tolng", "dest_lng"]),
      dlat: find(["终点纬", "到达纬", "dlat", "to_lat", "tolat", "dest_lat"]),
      flow: find(["流量", "客流", "客流量", "flow", "count", "量"]),
    };
  }, []);

  const handleOdText = useCallback((text) => {
    setOdText(text);
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) { setOdHeader([]); return; }
    const header = lines[0].split(/[,\t]/).map((h) => h.trim().replace(/^"|"$/g, ""));
    setOdHeader(header);
    setOdCols(detectCols(header));
  }, [detectCols]);

  const clearOdLayers = useCallback(() => {
    const m = mapRef.current?.getMap();
    if (!m) return;
    for (const id of ["od-heat", "od-lines"]) { if (m.getLayer(id)) m.removeLayer(id); }
    for (const src of ["od-heat-src", "od-lines-src"]) { if (m.getSource(src)) m.removeSource(src); }
  }, []);

  const renderOd = useCallback(() => {
    const m = mapRef.current?.getMap();
    if (!m) return;
    const lines = odText.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) { setOdMsg("请先粘贴或上传 CSV 数据"); return; }
    const header = lines[0].split(/[,\t]/).map((h) => h.trim().replace(/^"|"$/g, ""));
    const idx = (name) => header.indexOf(odCols[name]);
    const iO = [idx("olng"), idx("olat")];
    const iD = [idx("dlng"), idx("dlat")];
    const iF = idx("flow");
    if (iO.some((i) => i < 0) || iD.some((i) => i < 0)) {
      setOdMsg("请检查字段映射：起点/终点经纬度列必须选择");
      return;
    }
    const points = [];
    const odLines = [];
    let maxFlow = 1, totalFlow = 0, count = 0;
    for (let r = 1; r < lines.length; r++) {
      const cells = lines[r].split(/[,\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
      const o = [Number(cells[iO[0]]), Number(cells[iO[1]])];
      const d = [Number(cells[iD[0]]), Number(cells[iD[1]])];
      if (!Number.isFinite(o[0]) || !Number.isFinite(o[1])) continue;
      const flow = iF >= 0 ? Number(cells[iF]) || 1 : 1;
      maxFlow = Math.max(maxFlow, flow);
      totalFlow += flow;
      count++;
      points.push({ type: "Feature", properties: { flow }, geometry: { type: "Point", coordinates: o } });
      if (Number.isFinite(d[0]) && Number.isFinite(d[1]) && odShowLines) {
        odLines.push({ type: "Feature", properties: { flow }, geometry: { type: "LineString", coordinates: [o, d] } });
      }
    }
    if (!count) { setOdMsg("没有解析到有效记录，请检查列名映射"); return; }
    clearOdLayers();
    m.addSource("od-heat-src", { type: "geojson", data: { type: "FeatureCollection", features: points } });
    m.addLayer({
      id: "od-heat", type: "heatmap", source: "od-heat-src",
      paint: {
        "heatmap-weight": ["interpolate", ["linear"], ["get", "flow"], 0, 0, maxFlow, 1],
        "heatmap-intensity": 1.2,
        "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 5, 18, 10, 36],
        "heatmap-opacity": 0.65,
        "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"],
          0, "rgba(33,102,172,0)", 0.25, "rgb(103,169,207)", 0.45, "rgb(209,229,240)",
          0.6, "rgb(253,219,199)", 0.8, "rgb(239,138,98)", 1, "rgb(178,24,43)"],
      },
    });
    if (odLines.length) {
      m.addSource("od-lines-src", { type: "geojson", data: { type: "FeatureCollection", features: odLines } });
      m.addLayer({
        id: "od-lines", type: "line", source: "od-lines-src",
        paint: {
          "line-color": ["interpolate", ["linear"], ["get", "flow"], 0, "#9ecae1", maxFlow / 2, "#fd8d3c", maxFlow, "#a50f15"],
          "line-width": ["interpolate", ["linear"], ["get", "flow"], 0, 1, maxFlow, 4],
          "line-opacity": 0.55,
        },
      });
    }
    const lngs = points.map((p) => p.geometry.coordinates[0]);
    const lats = points.map((p) => p.geometry.coordinates[1]);
    m.fitBounds([[Math.min(...lngs) - 0.05, Math.min(...lats) - 0.05], [Math.max(...lngs) + 0.05, Math.max(...lats) + 0.05]], { padding: 50 });
    setOdMsg(`已渲染 ${count} 条 OD（总流量 ${Math.round(totalFlow).toLocaleString()}，最大 ${maxFlow}），起点热力图${odLines.length ? " + 流向线" : ""}`);
  }, [odText, odCols, odShowLines, clearOdLayers]);
  const mapRef = useRef(null);

  const flash = useCallback((t) => {
    setMsg(t);
    setTimeout(() => setMsg(""), 4000);
  }, []);

  // 加载项目详情（config + style + 图层文件清单）
  const loadProject = useCallback(async (name) => {
    try {
      const p = await mapProject(name);
      setCfg(p.config);
      setStyle(p.style);
      setFiles(p.files || []);
      setBasemapMeta(Array.isArray(p.basemapMeta) && p.basemapMeta.length ? p.basemapMeta : BASEMAP_FALLBACK);
    } catch (e) {
      flash("加载项目失败: " + e.message);
    }
  }, [flash]);

  // 行政区选择器：边界数据已有 name/adcode，前端只读取一次并复用地图矢量源。
  useEffect(() => {
    let cancelled = false;
    setRegionCode("");
    setRegionQuery("");
    setRegionOptions([{ value: "", label: "全省 / 全部区域" }]);
    if (project !== "zhejiang-map") return undefined;
    Promise.all([mapGetLayer(project, "boundary-city"), mapGetLayer(project, "boundary-county")])
      .then(([cities, counties]) => {
        if (cancelled) return;
        const cityOptions = (cities?.features || []).map((f) => ({
          value: String(f.properties?.adcode || ""),
          label: `地市 · ${f.properties?.name || f.properties?.adcode || "未命名"}`,
          name: f.properties?.name || f.properties?.adcode,
          level: "city",
          source: "boundary-city",
          code: String(f.properties?.adcode || ""),
          geometry: f.geometry,
          bbox: geometryBounds(f.geometry),
        })).filter((x) => x.value && x.bbox);
        const cityByCode = new Map(cityOptions.map((city) => [city.value, city]));
        const countyOptions = (counties?.features || []).map((f) => ({
          value: String(f.properties?.adcode || ""),
          label: `县市区 · ${f.properties?.name || f.properties?.adcode || "未命名"}`,
          name: f.properties?.name || f.properties?.adcode,
          level: "county",
          source: "boundary-county",
          code: String(f.properties?.adcode || ""),
          geometry: f.geometry,
          bbox: geometryBounds(f.geometry),
          cityCode: `${String(f.properties?.adcode || "").slice(0, 4)}00`,
          cityGeometry: cityByCode.get(`${String(f.properties?.adcode || "").slice(0, 4)}00`)?.geometry,
        })).filter((x) => x.value && x.bbox);
        setRegionOptions([{ value: "", label: "全省 / 全部区域" }, ...cityOptions, ...countyOptions]);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [project]);

  const selectRegion = useCallback((value) => {
    setRegionCode(value);
    const item = regionOptions.find((x) => x.value === value);
    if (!item?.value) {
      mapRef.current?.clearDrill();
      setDrill(null);
      flash("已恢复全省视图");
      return;
    }
    const next = {
      source: item.source,
      code: item.code,
      name: item.name,
      level: item.level,
      geometry: item.geometry,
      cityCode: item.cityCode || (item.level === "city" ? item.code : `${String(item.code).slice(0, 4)}00`),
      cityGeometry: item.cityGeometry || (item.level === "city" ? item.geometry : undefined),
    };
    mapRef.current?.focusBounds(item.bbox, { maxZoom: item.level === "county" ? 13 : 11 });
    setDrill(next);
    mapRef.current?.drillTo(next);
    flash(`已切换到${item.name}`);
  }, [regionOptions, flash]);

  const changeLayerScope = useCallback((value) => {
    const next = ["region", "city", "province"].includes(value) ? value : "region";
    setLayerScope(next);
    mapRef.current?.setCoverageMode(next);
    flash(next === "province" ? "已显示全省道路与设施" : next === "city" ? "已显示当前地市道路与设施" : "已显示当前区域道路与设施");
  }, [flash]);

  // 初始化：项目列表 + 默认项目
  useEffect(() => {
    mapProjects().then((r) => setProjects(r.projects || [])).catch(() => {});
    loadProject(project);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // 临时分析只属于当前对话；切换会话时清理运行时图层，但保留共享基础图层和正式文件图层。
  useEffect(() => {
    mapRef.current?.clearAllAnalysis?.();
    mapRef.current?.clearDrill?.();
    setActiveAnalysis(null);
    setDrill(null);
    setRegionCode("");
    setLayerScope("region");
    mapRef.current?.setCoverageMode("region");
    setAnalysisMenuOpen(false);
    setDemoOpen(false);
    setOdOpen(false);
    setIsoOpen(false);
    setM2Tab(null);
    setM3Tab(null);
    setCambodiaOpen(false);
  }, [threadId]);

  // 保存 style.json 并热更新地图
  const saveStyle = useCallback(async (nextStyle) => {
    setStyle(nextStyle);
    try { await mapSaveStyle(project, nextStyle); } catch (e) { flash("保存样式失败: " + e.message); }
    mapRef.current?.reloadStyle();
  }, [project, flash]);

  // ---- 图层操作 ----
  const toggleLayer = useCallback((layerId, target) => {
    if (!style) return;
    // 一个业务图层可能对应多个 MapLibre 样式层（例如 OD 主线、样式线和标签）。
    // 只切换同名 layer 会留下其它关联层继续渲染，造成“取消勾选但地图仍显示”。
    const related = style.layers.filter((l) => (
      l.id === layerId
      || l.source === layerId
      || l.id.startsWith(`${layerId}-`)
    ));
    const cur = related.some((l) => l.layout?.visibility !== "none");
    const vis = typeof target === "boolean" ? target : !cur;
    const next = {
      ...style,
      layers: style.layers.map((l) => {
        if (!related.includes(l)) return l;
        return { ...l, layout: { ...(l.layout || {}), visibility: vis ? "visible" : "none" } };
      }),
    };
    saveStyle(next);
  }, [style, saveStyle]);

  const setOpacity = useCallback((layerId, opacity) => {
    if (!style) return;
    const next = {
      ...style,
      layers: style.layers.map((l) => {
        if (l.id !== layerId || !l.paint) return l;
        const key = ["line-opacity", "circle-opacity", "fill-opacity"].find((k) => l.paint[k] !== undefined);
        if (!key) return l;
        return { ...l, paint: { ...l.paint, [key]: Number(opacity) } };
      }),
    };
    saveStyle(next);
  }, [style, saveStyle]);

  const moveLayer = useCallback((layerId, dir) => {
    if (!style) return;
    const ids = style.layers.map((l) => l.id);
    const idx = ids.indexOf(layerId);
    if (idx === -1) return;
    const target = dir === "up" ? idx + 1 : idx - 1;
    if (target < 0 || target >= ids.length) return;
    const layers = [...style.layers];
    const [item] = layers.splice(idx, 1);
    layers.splice(target, 0, item);
    saveStyle({ ...style, layers });
  }, [style, saveStyle]);

  const removeLayer = useCallback(async (layerId) => {
    if (!window.confirm(`删除图层「${layerId}」？（数据与瓦片一并移除）`)) return;
    try {
      await mapDeleteLayer(project, layerId);
      if (selectedLayer === layerId) setSelectedLayer(null);
      if (attrLayer?.layerId === layerId) setAttrLayer(null);
      await loadProject(project);
      mapRef.current?.reloadStyle();
      flash(`已删除图层 ${layerId}`);
    } catch (e) {
      flash("删除失败: " + e.message);
    }
  }, [project, loadProject, flash, selectedLayer, attrLayer]);

  const zoomToLayer = useCallback(async (layerId) => {
    try {
      const g = await mapGetLayer(project, layerId);
      const m = mapRef.current?.getMap();
      if (!m || !g?.features?.length) return;
      const bbox = [Infinity, Infinity, -Infinity, -Infinity];
      const walk = (c) => {
        if (typeof c[0] === "number") {
          bbox[0] = Math.min(bbox[0], c[0]);
          bbox[1] = Math.min(bbox[1], c[1]);
          bbox[2] = Math.max(bbox[2], c[0]);
          bbox[3] = Math.max(bbox[3], c[1]);
        } else c.forEach(walk);
      };
      g.features.forEach((f) => walk(f.geometry?.coordinates || []));
      if (bbox[0] === Infinity) return;
      m.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 40, maxZoom: 13 });
    } catch { /* 忽略定位失败 */ }
  }, [project]);

  // ---- QGIS 式图层管理扩展 ----

  // 样式编辑器：设置单个 paint 属性（null 删除）
  const setLayerPaint = useCallback((layerId, key, value) => {
    if (!style) return;
    const next = {
      ...style,
      layers: style.layers.map((l) => {
        if (l.id !== layerId) return l;
        const paint = { ...(l.paint || {}) };
        if (value === null || value === undefined) delete paint[key];        else paint[key] = value;
        return { ...l, paint };
      }),
    };
    saveStyle(next);
  }, [style, saveStyle]);

  // 样式编辑器：设置单个 layout 属性（null 删除；标号字段等）
  const setLayerLayout = useCallback((layerId, key, value) => {
    if (!style) return;
    const next = {
      ...style,
      layers: style.layers.map((l) => {
        if (l.id !== layerId) return l;
        const layout = { ...(l.layout || {}) };
        if (value === null || value === undefined) delete layout[key];
        else layout[key] = value;
        return { ...l, layout };
      }),
    };
    saveStyle(next);
  }, [style, saveStyle]);

  // 重命名（config.layers[].name）
  const renameLayer = useCallback(async (layerId, name) => {
    if (!cfg) return;
    const next = { ...cfg, layers: (cfg.layers || []).map((l) => (l.id === layerId ? { ...l, name } : l)) };
    setCfg(next);
    try { await mapSaveConfig(project, next); } catch (e) { flash("重命名保存失败: " + e.message); }
  }, [cfg, project, flash]);

  // 图层组管理：组名写入 map.config.json，导入图层和后续拖动都可复用。
  const createLayerGroup = useCallback(async (name) => {
    const group = String(name || "").trim();
    if (!group || !cfg) return;
    const groups = [...new Set([...(cfg.groups || []), group])];
    const next = { ...cfg, groups };
    setCfg(next);
    try { await mapSaveConfig(project, next); flash(`已新建图层组：${group}`); } catch (e) { flash("新建图层组失败: " + e.message); }
  }, [cfg, project, flash]);

  const moveLayerToGroup = useCallback(async (layerId, group) => {
    if (!cfg || !layerId || !group) return;
    const groups = [...new Set([...(cfg.groups || []), group])];
    const next = { ...cfg, groups, layers: (cfg.layers || []).map((l) => l.id === layerId ? { ...l, group } : l) };
    setCfg(next);
    try { await mapSaveConfig(project, next); flash(`已将图层移动到“${group}”`); } catch (e) { flash("移动图层失败: " + e.message); }
  }, [cfg, project, flash]);

  // 复制图层（新 id + 瓦片重建）
  const duplicateLayer = useCallback(async (layerId) => {
    try {
      const g = await mapGetLayer(project, layerId);
      if (!g) return;
      const newId = layerId + "_copy";
      await mapImportLayer(project, newId, g);
      await loadProject(project);
      mapRef.current?.reloadStyle();
      flash(`已复制图层 ${layerId} → ${newId}`);
    } catch (e) {
      flash("复制失败: " + e.message);
    }
  }, [project, loadProject, flash]);

  // 拖拽排序：把 layerId 移到 targetId 的位置
  const moveLayerTo = useCallback((layerId, targetId) => {
    if (!style) return;
    const ids = style.layers.map((l) => l.id);
    const from = ids.indexOf(layerId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1 || from === to) return;
    const layers = [...style.layers];
    const [item] = layers.splice(from, 1);
    const to2 = layers.findIndex((l) => l.id === targetId);
    layers.splice(to2, 0, item);
    saveStyle({ ...style, layers });
  }, [style, saveStyle]);

  // 标注渲染：为图层生成/移除 {layerId}-label symbol 层
  const setLayerLabel = useCallback((layerId, cfg) => {
    if (!style) return;
    const labelId = layerId + "-label";
    const layers = style.layers.filter((l) => l.id !== labelId);
    if (cfg && cfg.field) {
      const srcLayer = style.layers.find((l) => l.id === layerId);
      layers.push({
        id: labelId,
        type: "symbol",
        source: srcLayer?.source || layerId,
        "source-layer": layerId,
        minzoom: cfg.minzoom ?? 8,
        layout: {
          "text-field": ["get", cfg.field],
          "text-size": cfg.size || 13,
          "text-offset": [0, 1.4],
          "text-anchor": "bottom",
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": cfg.color || "#2d3142",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      });
    }
    saveStyle({ ...style, layers });
  }, [style, saveStyle]);

  // 打开属性表
  const openAttribute = useCallback((layerId) => {
    setAttrLayer({ layerId, name: cfg?.layers?.find((l) => l.id === layerId)?.name || layerId });
  }, [cfg]);

  // 属性表行定位到地图
  const locateFeature = useCallback((row) => {
    const m = mapRef.current?.getMap();
    if (!m || !row?.geom) return;
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    const walk = (c) => {
      if (typeof c[0] === "number") {
        bbox[0] = Math.min(bbox[0], c[0]);
        bbox[1] = Math.min(bbox[1], c[1]);
        bbox[2] = Math.max(bbox[2], c[0]);
        bbox[3] = Math.max(bbox[3], c[1]);
      } else c.forEach(walk);
    };
    walk(row.geom.coordinates || []);
    if (bbox[0] === Infinity) return;
    m.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 60, maxZoom: 15 });
  }, []);

  // ---- 报告图导出（截图 + 标题/图例/比例尺/指北针合成） ----
  const EXPORT_SIZES = {
    a4l: { label: "A4 横向", w: 1600, h: 1131, scale: 3 },
    a4p: { label: "A4 纵向", w: 1131, h: 1600, scale: 3 },
    square: { label: "方形", w: 1400, h: 1400, scale: 3 },
    custom: { label: "自定义", w: 1600, h: 1200, scale: 2 },
  };

  // 图例符号绘制（线/点/面色块）
  const drawLegendSymbol = (ctx, x, y, styleType, paint) => {
    const c = paint?.["line-color"] || paint?.["fill-color"] || paint?.["circle-color"] || "#8abeb7";
    const number = (value, fallback) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
    ctx.strokeStyle = c;
    ctx.fillStyle = c;
    ctx.lineWidth = Math.min(7, number(paint?.["line-width"], 2));
    if (styleType === "circle") {
      ctx.beginPath(); ctx.arc(x + 15, y + 9, Math.min(9, number(paint?.["circle-radius"], 6)), 0, Math.PI * 2); ctx.fill();
    } else if (styleType === "fill") {
      ctx.fillStyle = paint?.["fill-color"] || c;
      ctx.globalAlpha = number(paint?.["fill-opacity"], 0.5);
      ctx.fillRect(x + 2, y + 2, 26, 16);
      ctx.globalAlpha = 1;
    } else {
      ctx.beginPath(); ctx.moveTo(x + 2, y + 9); ctx.lineTo(x + 30, y + 9); ctx.stroke();
    }
  };

  const runExport = async () => {
    const m = mapRef.current?.getMap();
    if (!m) return;
    const size = EXPORT_SIZES[exp.size] || EXPORT_SIZES.a4l;
    const W = exp.size === "custom" ? Math.max(400, Math.min(4000, exp.customW)) : size.w;
    const H = exp.size === "custom" ? Math.max(300, Math.min(4000, exp.customH)) : size.h;
    const scale = size.scale || 2;
    const titleH = exp.title ? 100 : 0;
    const legendH = exp.legend ? 160 : 0;
    const pad = 40;
    const mapH = H - titleH - legendH - pad;
    if (mapH < 200) return flash("画布太小，请调大尺寸");
    setMsg("导出中…");
    try {
      const prevRatio = m.getPixelRatio();
      m.setPixelRatio(scale);
      m.resize();
      await new Promise((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          m.off("render", finish);
          m.off("idle", finish);
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        };
        const timer = setTimeout(finish, 1800);
        m.once("render", finish);
        m.once("idle", finish);
        m.triggerRepaint();
      });
      const mapCanvas = m.getCanvas();
      const mw = mapCanvas.width, mh = mapCanvas.height;
      const canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
      // 地图区域（保持宽高比 contain + 居中裁剪）
      const mapRatio = mw / mh, boxRatio = W / mapH;
      let sw, sh, sx = 0, sy = 0;
      if (mapRatio > boxRatio) { sh = mh; sw = mh * boxRatio; sx = (mw - sw) / 2; }
      else { sw = mw; sh = mw / boxRatio; sy = (mh - sh) / 2; }
      // 先把 WebGL canvas 转成普通图片，避免部分浏览器在合成时拿到空的绘制缓冲。
      const mapImage = new Image();
      mapImage.src = mapCanvas.toDataURL("image/png");
      await mapImage.decode().catch(() => {});
      ctx.drawImage(mapImage, sx, sy, sw, sh, 0, titleH, W, mapH);
      // 标题
      if (exp.title) {
        ctx.fillStyle = "#222";
        ctx.font = "bold 34px 'PingFang SC', 'Microsoft YaHei', sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(exp.title, W / 2, titleH / 2 + 12);
        ctx.strokeStyle = "#888"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(W * 0.3, titleH - 18); ctx.lineTo(W * 0.7, titleH - 18); ctx.stroke();
      }
      // 指北针（右上角）
      const nx = W - 70, ny = titleH + 60;
      ctx.save();
      ctx.translate(nx, ny);
      ctx.fillStyle = "#d62728"; ctx.font = "bold 20px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("N", 0, -12);
      ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(7, 10); ctx.lineTo(0, 5); ctx.lineTo(-7, 10); ctx.closePath();
      ctx.fillStyle = "#333"; ctx.fill();
      ctx.restore();
      // 比例尺（左下角，按 zoom 计算合适长度）
      const lat = m.getCenter().lat;
      const mpp = 156543.03392 * Math.cos((lat * Math.PI) / 180) / Math.pow(2, m.getZoom()); // 米/像素
      const targets = [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10];
      let dist = targets[0];
      for (const t of targets) { if (t / mpp <= 300) { dist = t; break; } }
      const barLen = dist / mpp;
      const by = H - (exp.legend ? legendH + 30 : 30);
      ctx.strokeStyle = "#333"; ctx.lineWidth = 2; ctx.fillStyle = "#333";
      ctx.beginPath(); ctx.moveTo(50, by); ctx.lineTo(50 + barLen, by); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(50, by - 6); ctx.lineTo(50, by + 6); ctx.moveTo(50 + barLen, by - 6); ctx.lineTo(50 + barLen, by + 6); ctx.stroke();
      ctx.font = "13px sans-serif"; ctx.textAlign = "left";
      ctx.fillText(dist >= 1000 ? dist / 1000 + " km" : dist + " m", 50 + barLen / 2 - 20, by - 10);
      // 图例
      if (exp.legend) {
        const ly = H - legendH + 28;
        ctx.strokeStyle = "#d6dce5"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(40, H - legendH); ctx.lineTo(W - 40, H - legendH); ctx.stroke();
        ctx.font = "bold 18px 'PingFang SC', 'Microsoft YaHei', sans-serif";
        ctx.textAlign = "left"; ctx.fillStyle = "#243447";
        ctx.fillText("图例", 50, ly);
        let lx = 50, row = 0;
        ctx.font = "17px 'PingFang SC', 'Microsoft YaHei', sans-serif";
        const entries = (style?.layers || [])
          .filter((l) => l.layout?.visibility !== "none" && !l.id.startsWith("basemap") && !l.id.endsWith("-label") && !l.id.startsWith("iso-") && !l.id.startsWith("draw-"))
          .map((l) => ({ layer: l, name: cfg?.layers?.find((x) => x.id === l.id)?.name || l.id }))
          .filter((entry, index, all) => all.findIndex((item) => item.name === entry.name) === index)
          .slice(0, 16);
        for (const entry of entries) {
          const { layer: l, name } = entry;
          const textW = ctx.measureText(name).width + 48;
          if (lx + textW > W - 40) { lx = 50; row++; }
          drawLegendSymbol(ctx, lx, ly + 18 + row * 36, l.type, l.paint);
          ctx.fillStyle = "#333";
          ctx.fillText(name, lx + 40, ly + 24 + row * 36);
          lx += textW;
        }
      }
      // 下载
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = `${(exp.title || project + "地图").replace(/[\\/:*?"<>|]/g, "_")}.png`;
      a.click();
      m.setPixelRatio(prevRatio);
      flash("导出完成 ✓");
    } catch (e) {
      flash("导出失败: " + e.message);
    }
  };

  // ---- 数据导入（批量文件 / 目录一键生成） ----
  const handleBatchImport = useCallback(async (files) => {
    if (!files || !files.length) return;
    setImpMsg("解析并导入中…");
    try {
      const items = [];
      const selected = [...files];
      const addParsed = (baseName, parsed) => {
        const collections = Array.isArray(parsed) ? parsed : [parsed];
        collections
          .filter((geojson) => geojson?.type === "FeatureCollection")
          .forEach((geojson, index) => {
            const suffix = collections.length > 1 ? "-" + (index + 1) : "";
            items.push({
              layerId: (baseName + suffix).replace(/[^\w-]/g, "_"),
              geojson,
            });
          });
      };
      for (const f of selected.filter((x) => /\.(geojson|json)$/i.test(x.name))) {
        addParsed(f.name.replace(/\.(geojson|json)$/i, ""), JSON.parse(await f.text()));
      }
      for (const f of selected.filter((x) => /\.zip$/i.test(x.name))) {
        setImpMsg("正在解析 " + f.name + "…");
        addParsed(f.name.replace(/\.zip$/i, ""), await shp(await f.arrayBuffer()));
      }
      for (const f of selected.filter((x) => /\.shp$/i.test(x.name))) {
        setImpMsg("正在解析 " + f.name + "…");
        addParsed(f.name.replace(/\.shp$/i, ""), await parseShapefile(shp, f, selected));
      }
      if (!items.length) { setImpMsg("请选择 GeoJSON、SHP（可同时选择 DBF/PRJ/CPG）或 ZIP 文件"); return; }
      const r = await mapImportBatch(project, items);
      const failed = Object.entries(r.layers || {}).filter(([, result]) => !result?.ok || !result?.tiles?.count);
      if (failed.length) {
        const detail = failed.map(([id, result]) => `${id}: ${result?.error || "没有生成瓦片，请检查坐标是否为 WGS84/EPSG:4326"}`).join("；");
        throw new Error(detail);
      }
      await loadProject(project);
      await mapRef.current?.reloadStyle?.();
      await zoomToLayer(items[0]?.layerId);
      const names = Object.keys(r.layers || {}).join(", ");
      setImpMsg(`已导入 ${items.length} 个图层（${names}），瓦片已重建`);
    } catch (e) {
      setImpMsg("导入失败: " + e.message);
    }
    setTimeout(() => setImpMsg(""), 5000);
  }, [project, loadProject]);

  const handleDirPrepare = useCallback(async () => {
    setImpMsg("生成中（prepare + 瓦片重建，可能需要一会儿）…");
    try {
      const r = await mapPrepare(impDir.trim() || "data");
      await loadProject(project);
      mapRef.current?.reloadStyle();
      setImpMsg(r.ok ? `生成完成 ✓\n${r.prepare}` : `生成失败:\n${(r.prepare || "").slice(-300)}`);
    } catch (e) {
      setImpMsg("失败: " + e.message);
    }
    setTimeout(() => setImpMsg(""), 8000);
  }, [project, loadProject, impDir]);
  const switchBasemap = useCallback(async (id) => {
    mapRef.current?.setBasemap(id);
    // 同步写入 style 的底图显隐，避免轮询/Agent 热更新后恢复到旧的地形或卫星图层。
    if (style?.layers) {
      const nextStyle = {
        ...style,
        layers: style.layers.map((l) => String(l.id).startsWith("basemap-")
          ? { ...l, layout: { ...(l.layout || {}), visibility: l.id === `basemap-${id}` ? "visible" : "none" } }
          : l),
      };
      await saveStyle(nextStyle);
    }
    setCfg((prev) => {
      const next = { ...(prev || {}), basemap: id };
      mapSaveConfig(project, next).catch(() => {});
      return next;
    });
  }, [project, style, saveStyle]);

  const handleRebuild = useCallback(async () => {
    setMsg("重建瓦片中…");
    try {
      const r = await mapRebuild(project);
      const total = Object.values(r.layers || {}).reduce((n, x) => n + (x.count || 0), 0);
      flash(`瓦片重建完成（${total} 个瓦片）`);
      mapRef.current?.reloadStyle();
    } catch (e) {
      flash("重建失败: " + e.message);
    }
  }, [project, flash]);

  // ---- 等时圈分析 ----
  const startPick = useCallback((target = "center") => {
    setIso((s) => ({ ...s, picking: target, err: "" }));
    const m = mapRef.current?.getMap();
    m?.once("click", (e) => {
      const pt = [e.lngLat.lng, e.lngLat.lat];
      setIso((s) => {
        if (target === "from") return { ...s, picking: null, route: { ...s.route, from: pt } };
        if (target === "to") return { ...s, picking: null, route: { ...s.route, to: pt } };
        return { ...s, picking: null, loc: pt };
      });
    });
  }, []);

  // ---- 路径规划（OSRM 开源默认 / 高德可选） ----
  const drawRoute = useCallback((coords, from, to) => {
    const m = mapRef.current?.getMap();
    if (!m) return;
    for (const id of ["route-line", "route-pts"]) { if (m.getLayer(id)) m.removeLayer(id); }
    if (m.getSource("route-src")) m.removeSource("route-src");
    if (m.getSource("route-pts-src")) m.removeSource("route-pts-src");
    if (!coords?.length) return;
    m.addSource("route-src", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } }] },
    });
    m.addLayer({ id: "route-line", type: "line", source: "route-src", paint: { "line-color": "#1f77b4", "line-width": 4, "line-opacity": 0.85 } });
    m.addSource("route-pts-src", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: [from, to].filter(Boolean).map((p, i) => ({ type: "Feature", properties: { i }, geometry: { type: "Point", coordinates: p } })),
      },
    });
    m.addLayer({ id: "route-pts", type: "circle", source: "route-pts-src", paint: { "circle-radius": 7, "circle-color": ["match", ["get", "i"], 0, "#d62728", "#2ca02c"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
    if (from && to) {
      m.fitBounds(
        [[Math.min(from[0], to[0]) - 0.02, Math.min(from[1], to[1]) - 0.02], [Math.max(from[0], to[0]) + 0.02, Math.max(from[1], to[1]) + 0.02]],
        { padding: 60 }
      );
    }
  }, []);

  const runRoute = useCallback(async () => {
    const { from, to, mode } = iso.route;
    if (!from || !to) { setIso((s) => ({ ...s, route: { ...s.route, err: "请先选择起点和终点（点「选起点/选终点」后点击地图）" } })); return; }
    setIso((s) => ({ ...s, route: { ...s.route, loading: true, err: "", info: "" } }));
    try {
      const r = await mapRoute({ from: from.join(","), to: to.join(","), mode });
      drawRoute(r.geometry, from, to);
      const prov = r.provider === "osrm" ? "OSRM 开源" : "高德";
      setIso((s) => ({ ...s, route: { ...s.route, info: `${prov} · 距离 ${fmtLen(r.distance)} · 约 ${Math.max(1, Math.round(r.duration / 60))} 分钟` } }));
    } catch (e) {
      setIso((s) => ({ ...s, route: { ...s.route, err: e.message } }));
    }
    setIso((s) => ({ ...s, route: { ...s.route, loading: false } }));
  }, [iso.route, drawRoute]);

  // 绘制等时圈多边形（临时图层，不写入项目；suffix 区分多档叠加）
  const drawIsoPolygons = useCallback((polygons, center, color = "#7b1fa2", opacity = 0.25, suffix = "") => {
    const m = mapRef.current?.getMap();
    if (!m || !polygons?.length) return;
    const src = `iso-temp${suffix}`;
    const fc = {
      type: "FeatureCollection",
      features: polygons.map((pts) => ({
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [pts] },
      })),
    };
    m.addSource(src, { type: "geojson", data: fc });
    m.addLayer({ id: `iso-fill${suffix}`, type: "fill", source: src, paint: { "fill-color": color, "fill-opacity": opacity } });
    m.addLayer({ id: `iso-line${suffix}`, type: "line", source: src, paint: { "line-color": color, "line-width": 2, "line-opacity": 0.9 } });
    if (center && !suffix) {
      m.addSource("iso-center-src", {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: center } },
      });
      m.addLayer({ id: "iso-center", type: "circle", source: "iso-center-src", paint: { "circle-radius": 6, "circle-color": color, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
    }
    // 视野缩放到等时圈范围
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    const walk = (c) => {
      if (typeof c[0] === "number") {
        bbox[0] = Math.min(bbox[0], c[0]);
        bbox[1] = Math.min(bbox[1], c[1]);
        bbox[2] = Math.max(bbox[2], c[0]);
        bbox[3] = Math.max(bbox[3], c[1]);
      } else c.forEach(walk);
    };
    polygons.forEach((pts) => walk(pts));
    if (bbox[0] !== Infinity) m.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 50 });
  }, []);

  // 清理全部等时圈临时图层
  const clearIsoLayers = useCallback(() => {
    const m = mapRef.current?.getMap();
    if (!m) return;
    const layerIds = m.getStyle().layers.map((l) => l.id).filter((id) => id.startsWith("iso-"));
    for (const id of layerIds) { try { m.removeLayer(id); } catch {} }
    const srcIds = Object.keys(m.getStyle().sources || {}).filter((id) => id.startsWith("iso-"));
    for (const id of srcIds) { try { m.removeSource(id); } catch {} }
  }, []);

  const runIso = useCallback(async () => {
    if (!iso.loc) {
      setIso((s) => ({ ...s, err: "请先选择中心点（点击「地图选点」或使用当前地图中心）" }));
      return;
    }
    const ranges = iso.multi
      ? iso.ranges.split(/[,，]/).map((x) => Number(x.trim())).filter((n) => n > 0 && n <= 180)
      : [iso.range];
    if (!ranges.length) {
      setIso((s) => ({ ...s, err: "请填写有效的分钟数（1-180，逗号分隔）" }));
      return;
    }
    setIso((s) => ({ ...s, loading: true, err: "", info: "" }));
    clearIsoLayers();
    try {
      const loc = `${iso.loc[0].toFixed(6)},${iso.loc[1].toFixed(6)}`;
      const results = await Promise.all(ranges.map((range) =>
        mapIsochrone({ name: project, location: loc, mode: iso.mode, range, rangeType: "time" })
      ));
      // 深→浅紫色渐变，多档叠加
      const colors = ["#6a1b9a", "#9c27b0", "#ce93d8", "#e1bee7", "#f3e5f5"];
      let allBbox = null;
      results.forEach((r, i) => {
        drawIsoPolygons(r.polygons, r.center, colors[i % colors.length], Math.max(0.12, 0.32 - i * 0.06), i ? `-${i}` : "");
      });
      const polyCounts = results.map((r, i) => `${ranges[i]}min:${r.polygons.length}个`).join("  ");
      setIso((s) => ({ ...s, info: `计算完成（${ranges.join("/")} 分钟）：${polyCounts}，已叠加绘制` }));
    } catch (e) {
      setIso((s) => ({ ...s, err: e.message }));
    }
    setIso((s) => ({ ...s, loading: false }));
  }, [iso.loc, iso.mode, iso.range, iso.multi, iso.ranges, project, drawIsoPolygons, clearIsoLayers]);

  // ---------- 测量 / 绘制 ----------
  const haversineM = useCallback((a, b) => {
    const R = 6371000;
    const dLat = ((b[1] - a[1]) * Math.PI) / 180;
    const dLng = ((b[0] - a[0]) * Math.PI) / 180;
    const la1 = (a[1] * Math.PI) / 180;
    const la2 = (b[1] * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }, []);

  const pathLengthM = useCallback((pts) => {
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += haversineM(pts[i - 1], pts[i]);
    return d;
  }, [haversineM]);

  const polygonAreaM2 = useCallback((pts) => {
    const n = pts.length;
    if (n < 3) return 0;
    const lat0 = pts.reduce((s, p) => s + p[1], 0) / n;
    const k = Math.cos((lat0 * Math.PI) / 180);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % n];
      sum += x1 * y2 - x2 * y1;
    }
    return (Math.abs(sum) / 2) * (111320 * k) ** 2;
  }, []);

  const fmtLen = (m) => (m >= 1000 ? (m / 1000).toFixed(2) + " km" : m.toFixed(0) + " m");
  const fmtArea = (m2) => (m2 >= 1e6 ? (m2 / 1e6).toFixed(2) + " km²" : m2.toFixed(0) + " m²");

  // 渲染测量/绘制临时图层
  const renderDrawLayer = useCallback((points, kind) => {
    const m = mapRef.current?.getMap();
    if (!m) return;
    for (const id of ["draw-line", "draw-fill", "draw-pts"]) {
      if (m.getLayer(id)) m.removeLayer(id);
    }
    if (m.getSource("draw-temp")) m.removeSource("draw-temp");
    if (m.getSource("draw-pts-src")) m.removeSource("draw-pts-src");
    if (!points.length) return;
    const isPoly = kind === "measure-polygon" || kind === "draw-polygon";
    const isMeasure = kind.startsWith("measure");
    const color = isMeasure ? "#1f77b4" : "#2ca02c";
    const fc = { type: "FeatureCollection", features: [] };
    if (points.length >= (isPoly ? 3 : 2)) {
      const coords = isPoly ? [...points, points[0]] : points;
      fc.features.push({
        type: "Feature",
        properties: {},
        geometry: { type: isPoly ? "Polygon" : "LineString", coordinates: isPoly ? [coords] : coords },
      });
    } else if (points.length === 1) {
      fc.features.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: points[0] } });
    }
    m.addSource("draw-temp", { type: "geojson", data: fc });
    if (isPoly) m.addLayer({ id: "draw-fill", type: "fill", source: "draw-temp", paint: { "fill-color": color, "fill-opacity": 0.15 } });
    m.addLayer({ id: "draw-line", type: "line", source: "draw-temp", paint: { "line-color": color, "line-width": 2, "line-opacity": 0.9, "line-dasharray": [2, 1.5] } });
    m.addSource("draw-pts-src", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: points.map((c, i) => ({ type: "Feature", properties: { i }, geometry: { type: "Point", coordinates: c } })),
      },
    });
    m.addLayer({ id: "draw-pts", type: "circle", source: "draw-pts-src", paint: { "circle-radius": 5, "circle-color": "#ffffff", "circle-stroke-color": color, "circle-stroke-width": 2 } });
  }, []);

  const clearDrawLayers = useCallback(() => {
    const m = mapRef.current?.getMap();
    if (!m) return;
    for (const id of ["draw-line", "draw-fill", "draw-pts"]) {
      if (m.getLayer(id)) m.removeLayer(id);
    }
    if (m.getSource("draw-temp")) m.removeSource("draw-temp");
    if (m.getSource("draw-pts-src")) m.removeSource("draw-pts-src");
  }, []);

  // 结束测量/绘制：measure 保留显示，draw 提交为新图层
  const finishDraw = useCallback(async (kind, points) => {
    if (kind.startsWith("measure")) {
      setMeasureResult(
        kind === "measure-polygon"
          ? { area: polygonAreaM2(points) }
          : { dist: pathLengthM(points) }
      );
      setDraw(null);
      mapRef.current?.setDrawingMode(false);
      return;
    }
    // 绘制 → 存为图层
    const defaultName = { "draw-point": "新点", "draw-line": "新路线", "draw-polygon": "新区域" }[kind];
    const name = window.prompt(`命名新图层（${defaultName}）`, defaultName);
    setDraw(null);
    mapRef.current?.setDrawingMode(false);
    if (!name || !name.trim()) { clearDrawLayers(); return; }
    const geometry = kind === "draw-point"
      ? { type: "Point", coordinates: points[0] }
      : kind === "draw-line"
        ? { type: "LineString", coordinates: points }
        : { type: "Polygon", coordinates: [points] };
    const geojson = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: name.trim() }, geometry }] };
    const layerId = "drawn-" + Date.now().toString(36);
    try {
      await mapImportLayer(project, layerId, geojson);
      await loadProject(project);
      mapRef.current?.reloadStyle();
      flash(`已保存图层「${name.trim()}」（${layerId}）`);
    } catch (e) {
      flash("保存图层失败: " + e.message);
    }
    clearDrawLayers();
  }, [project, loadProject, flash, pathLengthM, polygonAreaM2, clearDrawLayers]);

  // 测量/绘制交互：点击加点、双击完成、Esc 取消
  useEffect(() => {
    if (!draw) return undefined;
    const m = mapRef.current?.getMap();
    if (!m) return undefined;
    const onClick = (e) => {
      const pt = [e.lngLat.lng, e.lngLat.lat];
      setDraw((prev) => {
        if (!prev) return prev;
        if (prev.kind === "draw-point") {
          finishDraw(prev.kind, [pt]);
          return null;
        }
        return { ...prev, points: [...prev.points, pt] };
      });
    };
    const onDblClick = (e) => {
      e.preventDefault();
      setDraw((prev) => {
        if (!prev || prev.kind === "draw-point") return prev;
        if (prev.points.length >= 2) finishDraw(prev.kind, prev.points);
        return null;
      });
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        clearDrawLayers();
        setDraw(null);
        mapRef.current?.setDrawingMode(false);
      }
    };
    m.on("click", onClick);
    m.on("dblclick", onDblClick);
    window.addEventListener("keydown", onKey);
    return () => {
      m.off("click", onClick);
      m.off("dblclick", onDblClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [draw, finishDraw, clearDrawLayers]);

  // 测量/绘制预览渲染
  useEffect(() => {
    if (draw) renderDrawLayer(draw.points, draw.kind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draw]);

  // 工具菜单点击外部关闭
  useEffect(() => {
    if (!toolMenu) return undefined;
    const close = () => setToolMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [toolMenu]);

  useEffect(() => {
    if (!analysisMenuOpen) return undefined;
    const close = () => setAnalysisMenuOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [analysisMenuOpen]);

  const startTool = useCallback((type, kind) => {
    setToolMenu(null);
    if (draw) {
      // 已在工具模式：切换或退出
      if (draw.kind === kind) {
        clearDrawLayers();
        setDraw(null);
        setMeasureResult(null);
        mapRef.current?.setDrawingMode(false);
        return;
      }
      setDraw({ kind, points: [] });
      mapRef.current?.setDrawingMode(true);
      return;
    }
    setMeasureResult(null);
    setDraw({ kind, points: [] });
    mapRef.current?.setDrawingMode(true);
  }, [draw, clearDrawLayers]);

  // ---- 与 agent 同步：文件变更 / 一轮对话结束 → 刷新项目并热更新地图 ----
  const handleFileChanged = useCallback(() => {
    loadProject(project);
    mapRef.current?.reloadStyle();
  }, [project, loadProject, zoomToLayer]);

  const refreshMap = useCallback(async () => {
    setMsg("刷新地图与图层中…");
    await loadProject(project);
    const ok = await mapRef.current?.reloadStyle?.();
    flash(ok === false ? "地图刷新失败，请稍后重试" : "地图与图层已刷新");
  }, [project, loadProject, flash]);

  const toggleGlobe = useCallback(() => {
    const next = !globeMode;
    const ok = mapRef.current?.setProjection?.(next ? "globe" : "mercator");
    if (ok === false) {
      flash("当前地图引擎不支持地球视图");
      return;
    }
    setGlobeMode(next);
    flash(next ? "已切换为地球视图" : "已切换为平面地图");
  }, [globeMode, flash]);

  // Agent 地图动作只更新临时分析图层，避免对话结束时再次整体 reloadStyle。
  const handleMapAction = useCallback((action) => {
    if (!action || action.project && action.project !== project) return;
    if (action.action === "clear_analysis") {
      mapRef.current?.clearAnalysis(action.id || "agent-analysis");
      setActiveAnalysis(null);
      flash("已清除地图临时分析结果");
      return;
    }
    setActiveAnalysis(action);
    if (action.region) {
      const matched = regionOptions.find((r) => r.name === action.region || r.label?.includes(action.region));
      if (matched) selectRegion(matched.value);
    }
    // Agent 事件可能先于 MapLibre style 完成，短暂重试只等待地图就绪，不重建地图。
    let attempts = 0;
    const render = () => {
      attempts += 1;
      const rendered = mapRef.current?.showAnalysis(action);
      if (rendered || attempts >= 12) clearInterval(timer);
    };
    const timer = setInterval(render, 250);
    render();
    const title = action.title || (action.analysis === "isochrone" ? "等时圈" : action.analysis === "od" ? "出行 OD" : "热力图");
    const source = action.source === "demo" ? " · 演示数据" : "";
    flash(`${title}${source}已显示`);
  }, [project, regionOptions, selectRegion, flash]);

  const saveAnalysis = useCallback(async (action = activeAnalysis) => {
    if (!action?.geojson) return flash("当前没有可保存的分析结果");
    const base = String(action.id || `analysis-${action.analysis || action.type || "result"}-${action.region || "map"}`)
      .replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    try {
      await mapImportLayer(project, base || "analysis-result", action.geojson);
      if (action.lines) await mapImportLayer(project, `${base || "analysis-result"}-lines`, action.lines);
      await loadProject(project);
      mapRef.current?.reloadStyle();
      flash(`分析结果已保存为图层「${base || "analysis-result"}」`);
    } catch (e) {
      flash(`分析结果保存失败：${e.message}`);
    }
  }, [activeAnalysis, project, loadProject, flash]);

  const runDemoAnalysis = useCallback(async (analysis, region = "义乌市") => {
    try {
      const action = await mapDemoAnalysis({ analysis, region, project });
      handleMapAction(action);
      setDemoOpen(false);
    } catch (e) {
      flash(`演示分析失败：${e.message}`);
    }
  }, [project, handleMapAction, flash]);

  const handleAgentEnd = useCallback(() => {
    setTimeout(() => {
      loadProject(project);
    }, 300);
    if (!hideChat) onAgentEnd?.();
  }, [project, loadProject, onAgentEnd, hideChat]);

  const handleOpenFile = useCallback((name) => {
    onExit?.();
    onOpenFile?.(name);
  }, [onExit, onOpenFile]);

  useEffect(() => {
    if (!bridgeRef) return undefined;
    bridgeRef.current = { onMapAction: handleMapAction, onFileChanged: handleFileChanged, onAgentEnd: handleAgentEnd, onOpenFile: handleOpenFile };
    return () => {
      if (bridgeRef.current?.onMapAction === handleMapAction) bridgeRef.current = null;
    };
  }, [bridgeRef, handleMapAction, handleFileChanged, handleAgentEnd, handleOpenFile]);

  return (
    <div className={`mp ${hideChat ? "mp-shared-chat" : ""}`}>
      {/* 顶栏：工具栏 */}
      <div className="mp-topbar">
        <Icon name="map" size={14} />
        <span className="mp-title">地图</span>
        <TaskCenter
          sessions={sessions}
          currentThreadId={threadId}
          currentSessionId={currentSessionId}
          onSelectSession={onSelectSession}
          onFocusRun={onFocusRun}
        />
        {projects.length > 1 && (
          <select
            className="mp-project-select"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            title="地图项目"
          >
            {projects.map((p) => (
              <option key={p.project || p.name} value={p.project || p.name}>{p.name}</option>
            ))}
          </select>
        )}
        <select
          className="mp-project-select mp-basemap-select"
          value={cfg?.basemap || "gaode-road"}
          onChange={(e) => switchBasemap(e.target.value)}
          title="底图切换（可在设置界面配置 Key 扩展底图）"
        >
          {basemapMeta.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        {drill && (
          <button
            className="mp-drill-btn"
            onClick={() => { mapRef.current?.clearDrill(); setDrill(null); }}
            title="清除下钻过滤，恢复全省路网"
          >
            <Icon name="locate" size={12} /> {drill.name} <span className="mp-drill-x">✕</span>
          </button>
        )}
        <span className="mp-sep" />
        <button className="btn-sm" onClick={handleRebuild} title="重建矢量瓦片（数据变更后）">
          <Icon name="refresh" size={13} /> 重建瓦片
        </button>
        <button className="btn-sm" onClick={() => setImportOpen(true)} title="导入路网数据（批量 GeoJSON 或目录一键生成）">
          <Icon name="upload" size={13} /> 导入数据
        </button>
        <button className="btn-sm" onClick={refreshMap} title="重新读取地图项目、图层和样式">
          <Icon name="refresh" size={13} /> 刷新地图
        </button>
        <div className="mp-analysis-wrap">
          <button
            className={`btn-sm ${analysisMenuOpen || odOpen || isoOpen || m2Tab || m3Tab || cambodiaOpen ? "active" : ""}`}
            onClick={(e) => { e.stopPropagation(); setAnalysisMenuOpen((v) => !v); }}
            title="打开地图分析工具"
          >
            <Icon name="chart" size={13} /> 分析工具
          </button>
          {analysisMenuOpen && (
            <div className="mp-analysis-menu" onClick={(e) => e.stopPropagation()}>
              <div className="mp-analysis-menu-label">地图分析</div>
              <button onClick={() => { setOdOpen(true); setAnalysisMenuOpen(false); }}><Icon name="flow" size={13} /> OD 出行热力与流向</button>
              <button onClick={() => { setIsoOpen(true); setAnalysisMenuOpen(false); }}><Icon name="history" size={13} /> 可达性与路径规划</button>
              <button onClick={() => { setM2Tab("traffic"); setAnalysisMenuOpen(false); }}><Icon name="road" size={13} /> 道路运行分析</button>
              <button onClick={() => { setM3Tab("routes"); setAnalysisMenuOpen(false); }}><Icon name="route" size={13} /> 公交线网分析</button>
              <div className="mp-analysis-menu-sep" />
              <button className="secondary" onClick={() => { setCambodiaOpen(true); setAnalysisMenuOpen(false); }}><Icon name="flow" size={13} /> 暹粒公交演示</button>
            </div>
          )}
        </div>
        <button className={`btn-sm mp-iso-btn ${isoOpen ? "active" : ""}`} onClick={() => setIsoOpen((v) => !v)} title="等时圈与路径规划分析">
          <Icon name="history" size={13} /> 可达性
        </button>
        <div className="mp-demo-wrap">
          <button className={`btn-sm ${demoOpen ? "active" : ""}`} onClick={() => setDemoOpen((v) => !v)} title="打开浙江地图演示分析">
            <Icon name="chart" size={13} /> 示例数据
          </button>
          {demoOpen && (
            <div className="mp-demo-menu">
              <button onClick={() => runDemoAnalysis("heatmap")}><Icon name="locate" size={13} /> 义乌点位热力图</button>
              <button onClick={() => runDemoAnalysis("isochrone")}><Icon name="history" size={13} /> 义乌可达性等时圈</button>
              <button onClick={() => { mapRef.current?.clearAnalysis("agent-analysis"); setActiveAnalysis(null); setDemoOpen(false); flash("已清除临时分析结果"); }}><Icon name="trash" size={13} /> 清除临时结果</button>
              <button onClick={() => { mapRef.current?.undoAnalysis("agent-analysis"); setDemoOpen(false); flash("已撤销上一次临时分析"); }}><Icon name="back" size={13} /> 撤销上一次结果</button>
              <button disabled={!activeAnalysis} onClick={() => { saveAnalysis(); setDemoOpen(false); }}><Icon name="download" size={13} /> 保存当前结果</button>
            </div>
          )}
        </div>
        <button className="btn-sm" onClick={() => setExportOpen(true)} title="导出报告图（含图例/比例尺/指北针）">
          <Icon name="download" size={13} /> 导出
        </button>
        <button className={`btn-sm ${globeMode ? "active" : ""}`} onClick={toggleGlobe} title="切换平面地图 / 地球视图">
          <Icon name="globe" size={13} /> {globeMode ? "平面" : "地球"}
        </button>
        <select
          className="mp-project-select mp-region-select"
          value={regionCode}
          onChange={(e) => selectRegion(e.target.value)}
          title="切换浙江省地市和县市区"
        >
          {regionOptions.filter((r) => !regionQuery.trim() || !r.value || r.name?.includes(regionQuery.trim()) || r.label?.includes(regionQuery.trim())).map((r) => <option key={r.value || "all"} value={r.value}>{r.label}</option>)}
        </select>
        <select
          className="mp-project-select mp-scope-select"
          value={layerScope}
          onChange={(e) => changeLayerScope(e.target.value)}
          title="道路与设施显示范围"
        >
          <option value="region">范围：当前区域</option>
          <option value="city">范围：当前地市</option>
          <option value="province">范围：全省</option>
        </select>
        <input className="mp-region-search" value={regionQuery} onChange={(e) => setRegionQuery(e.target.value)} placeholder="搜索区域" title="按名称筛选地市和县市区" />
        <button
          className={`btn-sm mp-annotation-btn ${annotationsVisible ? "active" : ""}`}
          onClick={() => { const next = !annotationsVisible; setAnnotationsVisible(next); mapRef.current?.setAnnotationVisibility(next); }}
          title="显示或隐藏行政区和道路标注"
        >
          <Icon name="penTool" size={13} /> 标注
        </button>
        <button
          className={`btn-sm mp-tool-btn ${draw?.kind?.startsWith("measure") ? "active" : ""}`}
          onClick={(e) => { e.stopPropagation(); setToolMenu({ x: e.currentTarget.offsetLeft, y: 40, type: "measure" }); }}
          title="测量距离/面积（点击加点，双击结束）"
        >
          <Icon name="locate" size={13} /> 测量
        </button>
        <button
          className={`btn-sm mp-tool-btn ${draw && !draw.kind.startsWith("measure") ? "active" : ""}`}
          onClick={(e) => { e.stopPropagation(); setToolMenu({ x: e.currentTarget.offsetLeft, y: 40, type: "draw" }); }}
          title="绘制点/线/面并保存为图层"
        >
          <Icon name="penTool" size={13} /> 绘制
        </button>
        {msg && <span className="mp-msg">{msg}</span>}
        <button className="btn-sm mp-exit" onClick={onExit}><Icon name="back" size={14} /> 返回</button>
      </div>

      <div className="mp-body">
        {cambodiaOpen && (
          <div className="cambodia-overlay">
            <CambodiaODPanel mapRef={mapRef} onClose={() => setCambodiaOpen(false)} onSaveAnalysis={saveAnalysis} />
          </div>
        )}
        {/* M2 宏观交通分析面板 */}
        {m2Tab && (
          <div className="m2-overlay">
            <div className="m2-overlay-header">
              <h3>道路与区域交通分析</h3>
              <div className="m2-tabs">
                <button className={`m2-tab-btn ${m2Tab === "traffic" ? "active" : ""}`} onClick={() => setM2Tab("traffic")}>
                  <Icon name="chart" size={12} /> 流量带宽
                </button>
                <button className={`m2-tab-btn ${m2Tab === "od" ? "active" : ""}`} onClick={() => setM2Tab("od")}>
                  <Icon name="flow" size={12} /> OD 期望线
                </button>
                <button className={`m2-tab-btn ${m2Tab === "exchange" ? "active" : ""}`} onClick={() => setM2Tab("exchange")}>
                  <Icon name="sankey" size={12} /> 区域交换量
                </button>
                <button className={`m2-tab-btn ${m2Tab === "structure" ? "active" : ""}`} onClick={() => setM2Tab("structure")}>
                  <Icon name="road" size={12} /> 路网结构
                </button>
                <button className="m2-tab-btn" onClick={() => setM2Tab(null)}>
                  <Icon name="close" size={12} /> 关闭
                </button>
              </div>
            </div>
            <div className="m2-overlay-body">
              <M2Analysis project={project} mapRef={mapRef} activeTab={m2Tab} />
            </div>
          </div>
        )}
        {/* M3 新昌公交分析面板 */}
        {m3Tab && (
          <div className="m2-overlay m3-overlay">
            <div className="m2-overlay-header m3-overlay-header">
              <h3>公交线网与客流分析 · 新昌 Demo</h3>
              <div className="m2-tabs m3-tabs">
                <button className={`m2-tab-btn m3-tab-inner ${m3Tab === "routes" ? "active" : ""}`} onClick={() => setM3Tab("routes")}>
                  <Icon name="route" size={12} /> 公交线路
                </button>
                <button className={`m2-tab-btn m3-tab-inner ${m3Tab === "stations" ? "active" : ""}`} onClick={() => setM3Tab("stations")}>
                  <Icon name="locate" size={12} /> 站点客流
                </button>
                <button className={`m2-tab-btn m3-tab-inner ${m3Tab === "od" ? "active" : ""}`} onClick={() => setM3Tab("od")}>
                  <Icon name="flow" size={12} /> OD 期望线
                </button>
                <button className={`m2-tab-btn m3-tab-inner ${m3Tab === "stats" ? "active" : ""}`} onClick={() => setM3Tab("stats")}>
                  <Icon name="chart" size={12} /> 线网统计
                </button>
                <button className="m2-tab-btn" onClick={() => setM3Tab(null)}>
                  <Icon name="close" size={12} /> 关闭
                </button>
              </div>
            </div>
            <div className="m2-overlay-body m3-overlay-body">
              <M3Analysis mapRef={mapRef} activeTab={m3Tab} />
            </div>
          </div>
        )}
        {/* 左栏：QGIS 风格图层面板 */}
        <div className="mp-left" style={{ width: leftW, minWidth: leftW, maxWidth: leftW }}>
          <div className="mp-left-title">
            <Icon name="layers" size={12} /> 图层
            <span className="mp-layer-count">{files.length}</span>
          </div>
          <LayerPanel
            project={project}
            cfg={cfg}
            style={style}
            files={files}
            selected={selectedLayer}
            onSelect={setSelectedLayer}
            onToggleLayer={toggleLayer}
            onSetPaint={setLayerPaint}
            onSetLayout={setLayerLayout}
            onSetOpacity={setOpacity}
            onMoveLayerTo={moveLayerTo}
            onRenameLayer={renameLayer}
            onDuplicateLayer={duplicateLayer}
            onDeleteLayer={removeLayer}
            onZoomToLayer={zoomToLayer}
            onOpenAttribute={openAttribute}
            onSetLabel={setLayerLabel}
            onCreateGroup={createLayerGroup}
            onMoveLayerToGroup={moveLayerToGroup}
          />
        </div>
        <div className="mp-hresize left" onMouseDown={(e) => startPaneDrag(e, "left")} title="拖动调整左栏宽度" />

        {/* 中栏：地图 */}
        <div className="mp-center">
          <MapViewer
            ref={mapRef}
            project={project}
            config={cfg}
            onViewportChange={onViewportChange}
            onLayerTilesChanged={async (layerIds = []) => {
              await loadProject(project);
              await mapRef.current?.reloadStyle?.();
              if (layerIds[0]) await zoomToLayer(layerIds[0]);
            }}
            onDrillDown={(d) => {
              const matched = regionOptions.find((item) => item.value === String(d.code || ""));
              const resolved = matched ? {
                ...d,
                geometry: matched.geometry || d.geometry,
                cityCode: matched.cityCode || (matched.level === "city" ? matched.code : `${String(matched.code).slice(0, 4)}00`),
                cityGeometry: matched.cityGeometry || (matched.level === "city" ? matched.geometry : undefined),
              } : d;
              setDrill(resolved);
              setRegionCode(String(resolved.code || ""));
              mapRef.current?.drillTo(resolved);
            }}
          />
          {/* 测量/绘制提示条 */}
          {draw && (
            <div className="mp-draw-hint">
              {draw.kind === "draw-point" ? "点击地图放置点" : "点击地图加点，双击完成"}（Esc 取消）
              {draw.points.length > 1 && draw.kind.startsWith("measure") && (
                <span className="mp-draw-val">
                  {draw.kind === "measure-polygon"
                    ? `面积 ${fmtArea(polygonAreaM2(draw.points))}`
                    : `距离 ${fmtLen(pathLengthM(draw.points))}`}
                </span>
              )}
            </div>
          )}
          {/* 测量结果浮层 */}
          {measureResult && (
            <div className="mp-measure">
              {measureResult.dist !== undefined && <span>距离：{fmtLen(measureResult.dist)}</span>}
              {measureResult.area !== undefined && <span>面积：{fmtArea(measureResult.area)}</span>}
              <button className="mp-op" title="清除" onClick={() => { setMeasureResult(null); clearDrawLayers(); }}>
                <Icon name="close" size={12} />
              </button>
            </div>
          )}
        </div>

        {/* 右栏：agent 对话；地图模式可由 App 提供同一个常驻 ChatPanel，避免切换地图时丢失消息流。 */}
        {!hideChat && <div className="mp-right" style={{ width: rightW, minWidth: rightW, maxWidth: rightW }}>
          <ChatPanel
              clientId={clientId}
              threadId={threadId}
              workspace={workspace}
              onFileChanged={handleFileChanged}
              onMapAction={handleMapAction}
              currentDoc={`地图项目:${project}`}
              models={models}
              defaultModel={defaultModel}
              onAgentEnd={handleAgentEnd}
              historyMessages={historyMessages}
              onNewSession={onNewSession}
              onOpenFile={handleOpenFile}
              sessions={sessions}
              onSelectSession={onSelectSession}
              onSessionChange={onSessionChange}
              onRefreshSessions={onRefreshSessions}
            />
        </div>}
        <div className="mp-hresize right" onMouseDown={(e) => startPaneDrag(e, "right")} title="拖动调整右栏宽度" />
      </div>

      {/* 顶栏工具菜单（测量/绘制） */}
      {toolMenu && (
        <div className="mp-toolmenu" style={{ left: toolMenu.x, top: toolMenu.y }} onClick={(e) => e.stopPropagation()}>
          {toolMenu.type === "measure" ? (
            <>
              <button onClick={() => startTool("measure", "measure-line")}><Icon name="penTool" size={12} /> 测量距离</button>
              <button onClick={() => startTool("measure", "measure-polygon")}><Icon name="penTool" size={12} /> 测量面积</button>
            </>
          ) : (
            <>
              <button onClick={() => startTool("draw", "draw-point")}><Icon name="plus" size={12} /> 绘制点</button>
              <button onClick={() => startTool("draw", "draw-line")}><Icon name="penTool" size={12} /> 绘制线</button>
              <button onClick={() => startTool("draw", "draw-polygon")}><Icon name="penTool" size={12} /> 绘制面</button>
            </>
          )}
        </div>
      )}

      {/* OD 流量热力图弹窗 */}
      {odOpen && (
        <div className="mp-iso-backdrop" onClick={() => setOdOpen(false)}>
          <div className="mp-iso-panel mp-od-panel" onClick={(e) => e.stopPropagation()}>
            <div className="mp-iso-head">
              <span><Icon name="locate" size={14} /> OD 流量分析</span>
              <button className="mp-op" onClick={() => setOdOpen(false)} title="关闭"><Icon name="close" size={14} /></button>
            </div>
            <div className="mp-iso-body">
              <div className="mp-iso-hint" style={{ border: "none", padding: 0, marginBottom: 8 }}>
                粘贴或上传 CSV（表头含 起点经度/起点纬度/终点经度/终点纬度/流量，支持中英文列名，自动检测映射）。
              </div>
              <textarea
                className="mp-od-textarea"
                placeholder={"起点经度,起点纬度,终点经度,终点纬度,流量\n119.9,29.5,120.3,30.1,1200\n..."}
                value={odText}
                onChange={(e) => handleOdText(e.target.value)}
                rows={5}
              />
              {odHeader.length > 0 && (
                <div className="mp-od-cols">
                  {[
                    ["olng", "起点经度"], ["olat", "起点纬度"], ["dlng", "终点经度"], ["dlat", "终点纬度"], ["flow", "流量"],
                  ].map(([key, label]) => (
                    <label key={key} className="mp-od-col">
                      <span>{label}</span>
                      <select value={odCols[key]} onChange={(e) => setOdCols((p) => ({ ...p, [key]: e.target.value }))}>
                        <option value="">（未选择）</option>
                        {odHeader.map((h) => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </label>
                  ))}
                  <label className="mp-od-col">
                    <span>流向线</span>
                    <input type="checkbox" checked={odShowLines} onChange={(e) => setOdShowLines(e.target.checked)} />
                  </label>
                </div>
              )}
              {odMsg && <div className="mp-iso-info" style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>{odMsg}</div>}
              <div className="mp-iso-actions">
                <button className="btn-sm" onClick={() => { clearOdLayers(); setOdMsg(""); }}>清除图层</button>
                <button className="btn primary" onClick={renderOd}>渲染热力图</button>
              </div>
              <div className="mp-iso-hint">
                起点流量加权热力（蓝→红）+ 可选 OD 流向线（流量分级着色）。结果以临时图层叠加，不写入项目。
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 数据导入弹窗 */}
      {importOpen && (
        <div className="mp-iso-backdrop" onClick={() => setImportOpen(false)}>
          <div className="mp-iso-panel" onClick={(e) => e.stopPropagation()}>
            <div className="mp-iso-head">
              <span><Icon name="upload" size={14} /> 导入路网数据</span>
              <button className="mp-op" onClick={() => setImportOpen(false)} title="关闭"><Icon name="close" size={14} /></button>
            </div>
            <div className="mp-iso-body">
              <div className="mp-iso-modes" style={{ marginBottom: 10 }}>
                <button className={`mp-iso-mode ${impTab === "files" ? "active" : ""}`} onClick={() => setImpTab("files")}>批量文件</button>
                <button className={`mp-iso-mode ${impTab === "dir" ? "active" : ""}`} onClick={() => setImpTab("dir")}>目录一键生成</button>
              </div>
              {impTab === "files" ? (
                <>
                  <div className="mp-iso-hint" style={{ border: "none", padding: 0, marginBottom: 10 }}>
                    选择多个 GeoJSON、SHP（可同时选择同名 DBF/PRJ/CPG）或 ZIP 文件，批量导入并重建瓦片。
                  </div>
                  <div className="mp-iso-actions">
                    <button className="btn primary" onClick={() => impFileRef.current?.click()}>选择文件…</button>
                    <input ref={impFileRef} type="file" multiple accept=".geojson,.json,.zip,.shp,.dbf,.prj,.cpg" style={{ display: "none" }} onChange={(e) => { handleBatchImport(e.target.files); e.target.value = ""; }} />
                  </div>
                </>
              ) : (
                <>
                  <div className="mp-iso-hint" style={{ border: "none", padding: 0, marginBottom: 10 }}>
                    把矢量数据（高速/国省道/农村公路/收费站/枢纽 GeoJSON）放入工作区目录，输入相对路径后一键生成图层与瓦片。
                  </div>
                  <div className="mp-iso-row">
                    <span className="mp-iso-label">目录</span>
                    <input className="mp-iso-range mp-iso-ranges" value={impDir} onChange={(e) => setImpDir(e.target.value)} placeholder="工作区相对路径，如 data" />
                  </div>
                  <div className="mp-iso-actions">
                    <button className="btn primary" onClick={handleDirPrepare}>一键生成</button>
                  </div>
                </>
              )}
              {impMsg && <div className="mp-iso-info" style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>{impMsg}</div>}
            </div>
          </div>
        </div>
      )}

      {/* 报告图导出弹窗 */}
      {exportOpen && (
        <div className="mp-iso-backdrop" onClick={() => setExportOpen(false)}>
          <div className="mp-iso-panel" onClick={(e) => e.stopPropagation()}>
            <div className="mp-iso-head">
              <span><Icon name="download" size={14} /> 导出报告图</span>
              <button className="mp-op" onClick={() => setExportOpen(false)} title="关闭"><Icon name="close" size={14} /></button>
            </div>
            <div className="mp-iso-body">
              <div className="mp-iso-row">
                <span className="mp-iso-label">尺寸</span>
                <div className="mp-iso-modes">
                  {Object.entries(EXPORT_SIZES).map(([id, s]) => (
                    <button
                      key={id}
                      className={`mp-iso-mode ${exp.size === id ? "active" : ""}`}
                      onClick={() => setExp((p) => ({ ...p, size: id }))}
                    >{s.label}</button>
                  ))}
                </div>
              </div>
              {exp.size === "custom" && (
                <div className="mp-iso-row">
                  <span className="mp-iso-label">宽高</span>
                  <input className="mp-iso-range" type="number" min="400" max="4000" value={exp.customW} onChange={(e) => setExp((p) => ({ ...p, customW: Number(e.target.value) || 1600 }))} />
                  <span className="mp-iso-unit">×</span>
                  <input className="mp-iso-range" type="number" min="300" max="4000" value={exp.customH} onChange={(e) => setExp((p) => ({ ...p, customH: Number(e.target.value) || 1200 }))} />
                  <span className="mp-iso-unit">px</span>
                </div>
              )}
              <div className="mp-iso-row">
                <span className="mp-iso-label">标题</span>
                <input
                  className="mp-iso-range mp-iso-ranges"
                  value={exp.title}
                  onChange={(e) => setExp((p) => ({ ...p, title: e.target.value }))}
                  placeholder="如：松阳县停车设施布局图"
                />
              </div>
              <div className="mp-iso-row">
                <span className="mp-iso-label">图例</span>
                <label className="mp-iso-check">
                  <input type="checkbox" checked={exp.legend} onChange={(e) => setExp((p) => ({ ...p, legend: e.target.checked }))} />
                  包含图例
                </label>
              </div>
              <div className="mp-iso-actions">
                <button className="btn primary" onClick={runExport}>导出 PNG</button>
              </div>
              <div className="mp-iso-hint">
                输出 150-300dpi 报告插图：地图 + 标题 + 比例尺 + 指北针 + 图例（图例取当前可见图层）。
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 属性表弹窗 */}
      {attrLayer && (
        <AttributeTable
          project={project}
          layerId={attrLayer.layerId}
          layerName={attrLayer.layerName}
          onClose={() => setAttrLayer(null)}
          onLocate={locateFeature}
        />
      )}

      {/* 地图分析弹窗（等时圈 / 路径规划；选点模式下 backdrop 不拦截鼠标） */}
      {isoOpen && (
        <div className={`mp-iso-backdrop ${iso.picking ? "mp-iso-picking" : ""}`} onClick={() => !iso.picking && setIsoOpen(false)}>
          <div className="mp-iso-panel" onClick={(e) => e.stopPropagation()}>
            <div className="mp-iso-head">
              <span><Icon name="history" size={14} /> 地图分析</span>
              <div className="mp-iso-tabs">
                <button className={`mp-iso-tab ${iso.tab === "iso" ? "active" : ""}`} onClick={() => setIso((s) => ({ ...s, tab: "iso" }))}>等时圈</button>
                <button className={`mp-iso-tab ${iso.tab === "route" ? "active" : ""}`} onClick={() => setIso((s) => ({ ...s, tab: "route" }))}>路径规划</button>
              </div>
              <button className="mp-op" onClick={() => setIsoOpen(false)} title="关闭"><Icon name="close" size={14} /></button>
            </div>
            <div className="mp-iso-body">
            {iso.tab === "iso" ? (
              <>
              <div className="mp-iso-row">
                <span className="mp-iso-label">出行方式</span>
                <div className="mp-iso-modes">
                  {ISO_MODES.map((m) => (
                    <button
                      key={m.id}
                      className={`mp-iso-mode ${iso.mode === m.id ? "active" : ""}`}
                      onClick={() => setIso((s) => ({ ...s, mode: m.id }))}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mp-iso-row">
                <span className="mp-iso-label">时间范围</span>
                <input
                  className="mp-iso-range"
                  type="number" min="5" max="120" step="5"
                  value={iso.range}
                  onChange={(e) => setIso((s) => ({ ...s, range: Number(e.target.value) || 30 }))}
                />
                <span className="mp-iso-unit">分钟</span>
                <label className="mp-iso-check" title="同时计算多档时间范围并叠加显示">
                  <input type="checkbox" checked={iso.multi} onChange={(e) => setIso((s) => ({ ...s, multi: e.target.checked }))} />
                  多档对比
                </label>
              </div>
              {iso.multi && (
                <div className="mp-iso-row">
                  <span className="mp-iso-label">档位(分)</span>
                  <input
                    className="mp-iso-range mp-iso-ranges"
                    value={iso.ranges}
                    onChange={(e) => setIso((s) => ({ ...s, ranges: e.target.value }))}
                    placeholder="30,60,90"
                  />
                  <span className="mp-iso-unit">逗号分隔</span>
                </div>
              )}
              <div className="mp-iso-row">
                <span className="mp-iso-label">中心点</span>
                <button className={`btn-sm ${iso.picking ? "active" : ""}`} onClick={startPick}>
                  {iso.picking ? "点击地图选择中心点…" : "地图选点"}
                </button>
                <span className="mp-iso-loc">
                  {iso.loc ? `(${iso.loc[0].toFixed(4)}, ${iso.loc[1].toFixed(4)})` : "未选择"}
                </span>
              </div>
              {iso.err && <div className="mp-iso-err">{iso.err}</div>}
              {iso.info && <div className="mp-iso-info">{iso.info}</div>}
              <div className="mp-iso-actions">
                <button className="btn primary" disabled={iso.loading || iso.picking} onClick={runIso}>
                  {iso.loading ? "计算中…" : "开始分析"}
                </button>
              </div>
              <div className="mp-iso-hint">
                优先使用 Geoapify Isoline 服务（在设置中配置 Geoapify Key），未配置时回退服务端 AMAP_KEY。结果以临时图层叠加在地图上，不写入项目。
              </div>
              </>
            ) : (
              <>
              <div className="mp-iso-row">
                <span className="mp-iso-label">起点</span>
                <button className={`btn-sm ${iso.picking === "from" ? "active" : ""}`} onClick={() => startPick("from")}>
                  {iso.picking === "from" ? "点击地图选起点…" : "选起点"}
                </button>
                <span className="mp-iso-loc">
                  {iso.route.from ? `(${iso.route.from[0].toFixed(4)}, ${iso.route.from[1].toFixed(4)})` : "未选择"}
                </span>
              </div>
              <div className="mp-iso-row">
                <span className="mp-iso-label">终点</span>
                <button className={`btn-sm ${iso.picking === "to" ? "active" : ""}`} onClick={() => startPick("to")}>
                  {iso.picking === "to" ? "点击地图选终点…" : "选终点"}
                </button>
                <span className="mp-iso-loc">
                  {iso.route.to ? `(${iso.route.to[0].toFixed(4)}, ${iso.route.to[1].toFixed(4)})` : "未选择"}
                </span>
              </div>
              <div className="mp-iso-row">
                <span className="mp-iso-label">方式</span>
                <div className="mp-iso-modes">
                  {ISO_MODES.slice(0, 3).map((m) => (
                    <button
                      key={m.id}
                      className={`mp-iso-mode ${iso.route.mode === m.id ? "active" : ""}`}
                      onClick={() => setIso((s) => ({ ...s, route: { ...s.route, mode: m.id } }))}
                    >{m.label}</button>
                  ))}
                </div>
              </div>
              {iso.route.err && <div className="mp-iso-err">{iso.route.err}</div>}
              {iso.route.info && <div className="mp-iso-info">{iso.route.info}</div>}
              <div className="mp-iso-actions">
                <button className="btn primary" disabled={iso.route.loading || !!iso.picking} onClick={runRoute}>
                  {iso.route.loading ? "规划中…" : "开始规划"}
                </button>
              </div>
              <div className="mp-iso-hint">
                默认使用开源 OSRM 路由（零配置，基于 OpenStreetMap）；配置环境变量 AMAP_KEY 后可切换到高德（中国路网更准）。结果以临时图层叠加，不写入项目。
              </div>
              </>
            )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
