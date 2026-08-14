import React, { useState, useEffect, useCallback, useRef } from "react";
import MapViewer from "./MapViewer.jsx";
import ChatPanel from "./ChatPanel.jsx";
import LayerPanel from "./LayerPanel.jsx";
import AttributeTable from "./AttributeTable.jsx";
import Icon from "./Icon.jsx";
import {
  mapProjects, mapProject, mapSaveStyle, mapSaveConfig,
  mapDeleteLayer, mapRebuild, mapGetLayer, mapImportLayer, mapIsochrone,
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
  clientId, models, defaultModel, onAgentEnd, onNewSession, sessions, onSelectSession,
  onSessionChange, onRefreshSessions,
}) {
  const [projects, setProjects] = useState([]);
  const [project, setProject] = useState("zhejiang-map");
  const [cfg, setCfg] = useState(null);
  const [style, setStyle] = useState(null);
  const [files, setFiles] = useState([]);
  const [basemapMeta, setBasemapMeta] = useState([]);
  const [drill, setDrill] = useState(null); // 下钻状态 {source, code, name, level}
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
  const [iso, setIso] = useState({ mode: "driving", range: 30, multi: false, ranges: "30,60,90", loc: null, picking: false, loading: false, err: "", info: "" });
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

  // 初始化：项目列表 + 默认项目
  useEffect(() => {
    mapProjects().then((r) => setProjects(r.projects || [])).catch(() => {});
    loadProject(project);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // 保存 style.json 并热更新地图
  const saveStyle = useCallback(async (nextStyle) => {
    setStyle(nextStyle);
    try { await mapSaveStyle(project, nextStyle); } catch (e) { flash("保存样式失败: " + e.message); }
    mapRef.current?.reloadStyle();
  }, [project, flash]);

  // ---- 图层操作 ----
  const toggleLayer = useCallback((layerId, target) => {
    if (!style) return;
    const next = {
      ...style,
      layers: style.layers.map((l) => {
        if (l.id !== layerId) return l;
        const cur = l.layout?.visibility !== "none";
        const vis = typeof target === "boolean" ? target : !cur;
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

  // ---- 顶栏操作 ----
  const switchBasemap = useCallback(async (id) => {
    mapRef.current?.setBasemap(id);
    setCfg((prev) => {
      const next = { ...(prev || {}), basemap: id };
      mapSaveConfig(project, next).catch(() => {});
      return next;
    });
  }, [project]);

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
  const startPick = useCallback(() => {
    setIso((s) => ({ ...s, picking: true, err: "" }));
    const m = mapRef.current?.getMap();
    m?.once("click", (e) => {
      setIso((s) => ({ ...s, loc: [e.lngLat.lng, e.lngLat.lat], picking: false }));
    });
  }, []);

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
  }, [project, loadProject]);

  const handleAgentEnd = useCallback(() => {
    setTimeout(() => {
      loadProject(project);
      mapRef.current?.reloadStyle();
    }, 300);
    onAgentEnd?.();
  }, [project, loadProject, onAgentEnd]);

  const handleOpenFile = useCallback((name) => {
    onExit?.();
    onOpenFile?.(name);
  }, [onExit, onOpenFile]);

  return (
    <div className="mp">
      {/* 顶栏：工具栏 */}
      <div className="mp-topbar">
        <Icon name="map" size={14} />
        <span className="mp-title">地图</span>
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
        <button className="btn-sm" onClick={() => mapRef.current?.exportPng(2, `${project}.png`)} title="导出高清 PNG">
          <Icon name="download" size={13} /> 导出
        </button>
        <button className={`btn-sm mp-iso-btn ${isoOpen ? "active" : ""}`} onClick={() => setIsoOpen((v) => !v)} title="等时圈分析（外部 API）">
          <Icon name="history" size={13} /> 等时圈
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
          />
        </div>
        <div className="mp-hresize left" onMouseDown={(e) => startPaneDrag(e, "left")} title="拖动调整左栏宽度" />

        {/* 中栏：地图 */}
        <div className="mp-center">
          <MapViewer
            ref={mapRef}
            project={project}
            config={cfg}
            onLayerTilesChanged={() => loadProject(project)}
            onDrillDown={(d) => {
              setDrill(d);
              mapRef.current?.drillTo(d);
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

        {/* 右栏：agent 对话 */}
        <div className="mp-right" style={{ width: rightW, minWidth: rightW, maxWidth: rightW }}>
          <ChatPanel
            clientId={clientId}
            onFileChanged={handleFileChanged}
            currentDoc={`地图项目:${project}`}
            models={models}
            defaultModel={defaultModel}
            onAgentEnd={handleAgentEnd}
            historyMessages={null}
            onNewSession={onNewSession}
            onOpenFile={handleOpenFile}
            sessions={sessions}
            onSelectSession={onSelectSession}
            onSessionChange={onSessionChange}
            onRefreshSessions={onRefreshSessions}
          />
        </div>
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

      {/* 等时圈分析弹窗（选点模式下 backdrop 不拦截鼠标，允许点击地图） */}
      {isoOpen && (
        <div className={`mp-iso-backdrop ${iso.picking ? "mp-iso-picking" : ""}`} onClick={() => !iso.picking && setIsoOpen(false)}>
          <div className="mp-iso-panel" onClick={(e) => e.stopPropagation()}>
            <div className="mp-iso-head">
              <span><Icon name="history" size={14} /> 等时圈分析</span>
              <button className="mp-op" onClick={() => setIsoOpen(false)} title="关闭"><Icon name="close" size={14} /></button>
            </div>
            <div className="mp-iso-body">
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
                使用高德地图 Web 服务（需在服务端配置环境变量 AMAP_KEY）。结果以临时图层叠加在地图上，不写入项目。
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
