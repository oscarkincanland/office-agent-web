import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import MapViewer from "./MapViewer.jsx";
import ChatPanel from "./ChatPanel.jsx";
import LayerPanel from "./LayerPanel.jsx";
import AttributeTable from "./AttributeTable.jsx";
import Icon from "./Icon.jsx";
import TaskCenter from "./任务中心.jsx";
// 阶段 2：M2宏观分析 / M3公交分析 / 柬埔寨OD面板 三个旧面板已下线，
// 统一由可视面板（可视面板.jsx + /api/map/visual 描述符）承担。
import 可视面板 from "./可视面板.jsx";
import shp from "shpjs";
import { registerLayerReplay, unregisterLayerReplay } from "../图层注册表.js";
import {
  mapProjects, mapCreateProject, mapProject, mapSaveStyle, mapSaveConfig,
  mapDeleteLayer, mapRebuild, mapGetLayer, mapImportLayer, mapImportBatch, mapPrepare, mapIsochrone, mapRoute, mapDemoAnalysis,
  mapDuplicateProject, mapRenameProject, mapArchiveProject, mapDeleteProject,
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

function waitForMapToSettle(map, timeout = 12000) {
  return new Promise((resolve) => {
    let finished = false;
    let rendered = false;
    let idle = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      map.off("idle", markIdle);
      map.off("render", markRendered);
      map.off("styledata", check);
    };
    const finish = (settled) => {
      if (finished) return;
      finished = true;
      cleanup();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(settled)));
    };
    const check = () => {
      if (!rendered || !idle) return;
      const styleReady = typeof map.isStyleLoaded !== "function" || map.isStyleLoaded();
      const tilesReady = typeof map.areTilesLoaded !== "function" || map.areTilesLoaded();
      const moving = typeof map.isMoving === "function" && map.isMoving();
      if (styleReady && tilesReady && !moving) finish(true);
    };
    const markRendered = () => {
      rendered = true;
      check();
    };
    const markIdle = () => {
      idle = true;
      check();
    };
    timer = setTimeout(() => finish(false), timeout);
    map.on("idle", markIdle);
    map.on("render", markRendered);
    map.on("styledata", check);
    map.triggerRepaint();
  });
}

function loadCanvasImage(canvas) {
  return new Promise((resolve, reject) => {
    let dataUrl;
    try {
      dataUrl = canvas.toDataURL("image/png");
    } catch (error) {
      reject(error);
      return;
    }
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("地图绘制缓冲无法转换为图片"));
    image.src = dataUrl;
  });
}

function readWebglCanvas(canvas) {
  try {
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!gl || !canvas.width || !canvas.height) return null;
    const width = canvas.width;
    const height = canvas.height;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const output = document.createElement("canvas");
    output.width = width;
    output.height = height;
    const ctx = output.getContext("2d");
    const image = ctx.createImageData(width, height);
    const rowBytes = width * 4;
    for (let y = 0; y < height; y += 1) {
      const source = pixels.subarray((height - y - 1) * rowBytes, (height - y) * rowBytes);
      image.data.set(source, y * rowBytes);
    }
    ctx.putImageData(image, 0, 0);
    return output;
  } catch {
    return null;
  }
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
  onSessionChange, onRefreshSessions, onFocusRun, hideChat = false, chatVisible = true, onToggleChat, bridgeRef, onViewportChange, onProjectChange,
  // 对话模式：地图里的查询（Chat）与分析总结可直接用，新增/修改图层需要 Work。
  // 用户不必返回主对话切换——这正是此前"在地图里说画热力图却做不出来"的成因之一。
  conversationMode = "chat", onModeChange,
  // 阶段 2：可视面板的"交给 Agent"需要把文字送到对话栏输入框（复用全局单实例）。
  insertChatText,
}) {
  const [projects, setProjects] = useState([]);
  const [project, setProject] = useState("zhejiang-map");
  const [cfg, setCfg] = useState(null);
  const [style, setStyle] = useState(null);
  const [files, setFiles] = useState([]);
  // 图层归属视图（阶段 1）：[{id,name,type,group,origin,owner,ref,editable,visible}]。
  // 来源是服务端图层仓库，只返回"共享 + 本工作区"可见的图层。
  const [layerViews, setLayerViews] = useState([]);
  // 临时层清单：当前画面上存在的临时可视化（OD / 等时圈 / 路径 / 绘制 / Agent 分析）。
  const [tempLayers, setTempLayers] = useState([]);
  const [basemapMeta, setBasemapMeta] = useState([]);
  const [drill, setDrill] = useState(null); // 下钻状态 {source, code, name, level}
  const [regionOptions, setRegionOptions] = useState([{ value: "", label: "全省 / 全部区域" }]);
  const [regionCode, setRegionCode] = useState("");
  const [layerScope, setLayerScope] = useState("region"); // 当前区域 / 当前地市 / 全省
  const [regionQuery, setRegionQuery] = useState("");
  const [annotationsVisible, setAnnotationsVisible] = useState(true);
  // 阶段 2：顶栏收敛后的菜单与面板开关
  const [visualOpen, setVisualOpen] = useState(false);   // 可视面板（替代 6 个旧分析面板）
  const [dataMenuOpen, setDataMenuOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [regionMenuOpen, setRegionMenuOpen] = useState(false);
  const [leftHidden, setLeftHidden] = useState(false);
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
  const regionOptionsCacheRef = useRef(new Map());   // 项目级行政区缓存，切换区域不重复读边界文件

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
  const [projectMenuOpen, setProjectMenuOpen] = useState(false); // 项目生命周期菜单
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
    if (m) {
      for (const id of ["od-heat", "od-lines"]) { if (m.getLayer(id)) m.removeLayer(id); }
      for (const src of ["od-heat-src", "od-lines-src"]) { if (m.getSource(src)) m.removeSource(src); }
    }
    // 主动清除时同时注销重放，否则下次样式重载会把它画回来。
    if (odSpecRef.current) {
      odSpecRef.current = null;
      const mm = mapRef.current?.getMap();
      if (mm) unregisterLayerReplay(mm, "od");
    }
  }, []);

  // OD 的绘制规格（点/线的 FeatureCollection + 最大流量）。存成 ref 供样式重载后重放，
  // 与当前输入的解析结果解耦：重放时不应再依赖 odText/odCols 这些界面状态。
  const odSpecRef = useRef(null);

  // 纯绘制：只做"清旧 → 加图层 → 缩放到范围"，不读界面状态，可被重放安全调用。
  const paintOd = useCallback((m, spec) => {
    if (!m || !spec) return;
    for (const id of ["od-heat", "od-lines"]) { try { if (m.getLayer(id)) m.removeLayer(id); } catch {} }
    for (const src of ["od-heat-src", "od-lines-src"]) { try { if (m.getSource(src)) m.removeSource(src); } catch {} }
    const { points, odLines = [], maxFlow = 1 } = spec;
    if (!points?.length) return;
    m.addSource("od-heat-src", { type: "geojson", data: { type: "FeatureCollection", features: points } });
    m.addLayer({
      id: "od-heat", type: "heatmap", source: "od-heat-src",
      paint: {
        "heatmap-weight": ["interpolate", ["linear"], ["get", "flow"], 0, 0, maxFlow, 1],
        "heatmap-intensity": 1.2,
        "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 5, 18, 10, 36],
        "heatmap-opacity": 0.65,
        "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"],
          0, "rgba(33,102,172,0)", 0.25, "rgb(103,169,207)", 0.45, "rgb(229,245,249)",
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
    // 只有首次绘制才缩放视野；重放时保持用户当前视角，不打断操作。
    if (spec.fitBounds && points.length) {
      const lngs = points.map((p) => p.geometry.coordinates[0]);
      const lats = points.map((p) => p.geometry.coordinates[1]);
      try {
        m.fitBounds([[Math.min(...lngs) - 0.05, Math.min(...lats) - 0.05], [Math.max(...lngs) + 0.05, Math.max(...lats) + 0.05]], { padding: 50 });
      } catch {}
    }
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
    const spec = { points, odLines, maxFlow, fitBounds: true };
    odSpecRef.current = spec;
    paintOd(m, spec);
    // 登记重放：改样式或被样式热更新清掉后，自动画回来。
    registerLayerReplay(m, "od", (map) => paintOd(map, odSpecRef.current));
    setOdMsg(`已渲染 ${count} 条 OD（总流量 ${Math.round(totalFlow).toLocaleString()}，最大 ${maxFlow}），起点热力图${odLines.length ? " + 流向线" : ""}`);
  }, [odText, odCols, odShowLines, clearOdLayers, paintOd]);
  const mapRef = useRef(null);

  const flash = useCallback((t) => {
    setMsg(t);
    setTimeout(() => setMsg(""), 4000);
  }, []);

  // 加载项目详情（config + style + 图层文件清单 + 归属视图）
  const loadProject = useCallback(async (name) => {
    try {
      // 归属视图随工作区变化：共享数据集 + 本工作区自有图层（阶段 1）。
      const p = await mapProject(name, workspace);
      setCfg(p.config);
      setStyle(p.style);
      setFiles(p.files || []);
      setLayerViews(Array.isArray(p.layerViews) ? p.layerViews : []);
      setBasemapMeta(Array.isArray(p.basemapMeta) && p.basemapMeta.length ? p.basemapMeta : BASEMAP_FALLBACK);
    } catch (e) {
      flash("加载项目失败: " + e.message);
    }
  }, [flash, workspace]);

  // 行政区选择器：边界数据已有 name/adcode，前端只读取一次并复用地图矢量源。
  useEffect(() => {
    let cancelled = false;
    setRegionCode("");
    setRegionQuery("");
    const cached = regionOptionsCacheRef.current.get(project);
    if (cached) {
      setRegionOptions(cached);
      return undefined;
    }
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
        const options = [{ value: "", label: "全省 / 全部区域" }, ...cityOptions, ...countyOptions];
        regionOptionsCacheRef.current.set(project, options);
        setRegionOptions(options);
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
    mapRef.current?.focusBounds(item.bbox, { maxZoom: item.level === "county" ? 13 : 11, duration: 280 });
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
    onProjectChange?.(project);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // 工作区切换时"我的图层"跟随（阶段 1 · 修 X6）：
  // 共享数据集不变，工作区自有图层随 owner 过滤重新拉取。
  const workspaceRef = useRef(workspace);
  useEffect(() => {
    if (workspaceRef.current === workspace) return;
    workspaceRef.current = workspace;
    loadProject(project);
  }, [workspace, project, loadProject]);

  // 临时分析只属于当前对话；切换会话时清理运行时图层，但保留共享基础图层和正式文件图层。
  useEffect(() => {
    mapRef.current?.clearAllAnalysis?.();
    mapRef.current?.clearDrill?.();
    setActiveAnalysis(null);
    setDrill(null);
    setRegionCode("");
    setLayerScope("region");
    mapRef.current?.setCoverageMode("region");
    setOdOpen(false);
    setIsoOpen(false);
    setVisualOpen(false);
    setDataMenuOpen(false);
    setViewMenuOpen(false);
    setRegionMenuOpen(false);
  }, [threadId, project]);

  // 保存 style.json 并热更新地图
  const saveStyle = useCallback(async (nextStyle) => {
    setStyle(nextStyle);
    try { await mapSaveStyle(project, nextStyle); } catch (e) { flash("保存样式失败: " + e.message); }
    mapRef.current?.reloadStyle();
  }, [project, flash]);

  // 临时层清单：从地图实例读"画面上真实存在的临时可视化"。
  // 这些图层不在 style.json 里，属于本次会话；此处只做展示，不参与写入。
  const TEMP_LAYER_LABELS = useMemo(() => ([
    { key: "od", match: (id) => id === "od-heat" || id === "od-lines", label: "OD 流量热力" },
    { key: "iso", match: (id) => id.startsWith("iso-"), label: "等时圈" },
    { key: "route", match: (id) => id === "route-line" || id === "route-pts", label: "路径规划" },
    { key: "draw", match: (id) => id.startsWith("draw-"), label: "测量 / 绘制" },
    { key: "analysis", match: (id) => id.includes("agent-analysis") || id.startsWith("analysis-"), label: "分析结果" },
  ]), []);

  const syncTempLayers = useCallback(() => {
    const m = mapRef.current?.getMap?.();
    if (!m?.getStyle) { setTempLayers([]); return; }
    let ids = [];
    try { ids = (m.getStyle().layers || []).map((l) => String(l.id)); } catch { ids = []; }
    const found = [];
    for (const item of TEMP_LAYER_LABELS) {
      if (ids.some((id) => item.match(id))) found.push({ key: item.key, label: item.label });
    }
    setTempLayers(found);
  }, [TEMP_LAYER_LABELS]);

  // 临时层变化没有统一事件源：跟随样式与选中状态做轻量重扫（开销极小，仅读 id 列表）。
  useEffect(() => {
    syncTempLayers();
  }, [syncTempLayers, style, activeAnalysis, odMsg, iso.info]);

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
    const titleH = exp.title ? 100 : 0;
    const legendH = exp.legend ? 160 : 0;
    const pad = 40;
    const mapH = H - titleH - legendH - pad;
    if (mapH < 200) return flash("画布太小，请调大尺寸");
    setMsg("导出中…");
    const prevRatio = m.getPixelRatio();
    try {
      const settlePromise = waitForMapToSettle(m);
      const settled = await settlePromise;
      const mapCanvas = m.getCanvas();
      const mw = mapCanvas.width, mh = mapCanvas.height;
      if (!mw || !mh) throw new Error("地图画布尺寸为 0，请等待地图加载完成后重试");
      const readbackCanvas = readWebglCanvas(mapCanvas);
      const sourceCanvas = readbackCanvas || mapCanvas;
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
      // 优先直接绘制 MapLibre 的 WebGL canvas。部分 Chromium/WebGL 组合中，
      // canvas -> dataURL -> Image 虽然 onload 成功，但图片像素仍可能是空白。
      let mapImage;
      try { mapImage = await loadCanvasImage(sourceCanvas); } catch {}
      try {
        ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, titleH, W, mapH);
      } catch (drawError) {
        if (!mapImage) throw drawError;
        ctx.drawImage(mapImage, sx, sy, sw, sh, 0, titleH, W, mapH);
      }
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
      flash(settled ? "导出完成 ✓" : "导出完成（部分地图资源仍在加载）✓");
    } catch (e) {
      flash("导出失败: " + e.message);
    } finally {
      try {
        if (m.getPixelRatio() !== prevRatio) {
          m.setPixelRatio(prevRatio);
          m.resize();
        }
      } catch {}
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
    // 先只切换运行时图层，避免用户等待整份 style.json 重载。
    mapRef.current?.setBasemap(id);
    // 持久化仍保留在 style/config；下次轮询会感知样式变化，但不会阻塞本次切换。
    if (style?.layers) {
      const nextStyle = {
        ...style,
        layers: style.layers.map((l) => String(l.id).startsWith("basemap-")
          ? { ...l, layout: { ...(l.layout || {}), visibility: l.id === `basemap-${id}` ? "visible" : "none" } }
          : l),
      };
      setStyle(nextStyle);
      mapSaveStyle(project, nextStyle)
        .then(() => mapRef.current?.syncStyleHash?.())
        .catch((e) => flash("保存底图选择失败: " + e.message));
    }
    setCfg((prev) => {
      const next = { ...(prev || {}), basemap: id };
      mapSaveConfig(project, next).catch(() => {});
      return next;
    });
  }, [project, style, flash]);

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
    // 登记重放：样式重载后路径与起终点标记也要留住。
    routeSpecRef.current = { coords, from, to };
    registerLayerReplay(m, "route", (map) => {
      const spec = routeSpecRef.current;
      if (!spec?.coords?.length) return;
      for (const id of ["route-line", "route-pts"]) { try { if (map.getLayer(id)) map.removeLayer(id); } catch {} }
      try { if (map.getSource("route-src")) map.removeSource("route-src"); } catch {}
      try { if (map.getSource("route-pts-src")) map.removeSource("route-pts-src"); } catch {}
      map.addSource("route-src", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: spec.coords } }] },
      });
      map.addLayer({ id: "route-line", type: "line", source: "route-src", paint: { "line-color": "#1f77b4", "line-width": 4, "line-opacity": 0.85 } });
      map.addSource("route-pts-src", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [spec.from, spec.to].filter(Boolean).map((p, i) => ({ type: "Feature", properties: { i }, geometry: { type: "Point", coordinates: p } })) },
      });
      map.addLayer({ id: "route-pts", type: "circle", source: "route-pts-src", paint: { "circle-radius": 7, "circle-color": ["match", ["get", "i"], 0, "#d62728", "#2ca02c"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
    });
  }, []);

  // 路径重放规格（线坐标 + 起终点）。
  const routeSpecRef = useRef(null);

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
    if (m.getSource(src)) { try { m.removeLayer(`iso-fill${suffix}`); } catch {} try { m.removeLayer(`iso-line${suffix}`); } catch {} try { m.removeSource(src); } catch {} }
    m.addSource(src, { type: "geojson", data: fc });
    m.addLayer({ id: `iso-fill${suffix}`, type: "fill", source: src, paint: { "fill-color": color, "fill-opacity": opacity } });
    m.addLayer({ id: `iso-line${suffix}`, type: "line", source: src, paint: { "line-color": color, "line-width": 2, "line-opacity": 0.9 } });
    if (center && !suffix) {
      if (m.getSource("iso-center-src")) { try { m.removeLayer("iso-center"); } catch {} try { m.removeSource("iso-center-src"); } catch {} }
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
    // 主动清除时注销重放，避免样式重载把它们画回来。
    if (isoSpecRef.current) {
      isoSpecRef.current = null;
      unregisterLayerReplay(m, "iso");
    }
  }, []);

  // 等时圈重放规格：保存"画了哪几档、中心在哪"，供样式重载后恢复。
  const isoSpecRef = useRef(null);

  // 纯绘制：按规格画回全部等时圈（多档叠加），可被重放安全调用。
  const paintIso = useCallback((m, spec) => {
    if (!m || !spec?.results?.length) return;
    const colors = ["#6a1b9a", "#9c27b0", "#ce93d8", "#e1bee7", "#f3e5f5"];
    spec.results.forEach((r, i) => {
      const suffix = i ? `-${i}` : "";
      const src = `iso-temp${suffix}`;
      try { if (m.getLayer(`iso-fill${suffix}`)) m.removeLayer(`iso-fill${suffix}`); } catch {}
      try { if (m.getLayer(`iso-line${suffix}`)) m.removeLayer(`iso-line${suffix}`); } catch {}
      try { if (m.getSource(src)) m.removeSource(src); } catch {}
      if (!r?.polygons?.length) return;
      m.addSource(src, {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: r.polygons.map((pts) => ({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [pts] } })),
        },
      });
      const color = colors[i % colors.length];
      const opacity = Math.max(0.12, 0.32 - i * 0.06);
      m.addLayer({ id: `iso-fill${suffix}`, type: "fill", source: src, paint: { "fill-color": color, "fill-opacity": opacity } });
      m.addLayer({ id: `iso-line${suffix}`, type: "line", source: src, paint: { "line-color": color, "line-width": 2, "line-opacity": 0.9 } });
    });
    const center = spec.results[0]?.center;
    if (center) {
      try { if (m.getLayer("iso-center")) m.removeLayer("iso-center"); } catch {}
      try { if (m.getSource("iso-center-src")) m.removeSource("iso-center-src"); } catch {}
      m.addSource("iso-center-src", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: center } } });
      m.addLayer({ id: "iso-center", type: "circle", source: "iso-center-src", paint: { "circle-radius": 6, "circle-color": "#6a1b9a", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
    }
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
      results.forEach((r, i) => {
        drawIsoPolygons(r.polygons, r.center, colors[i % colors.length], Math.max(0.12, 0.32 - i * 0.06), i ? `-${i}` : "");
      });
      // 登记重放：样式重载（改颜色 / 切底图 / 服务端热更新）后自动画回等时圈。
      isoSpecRef.current = { results, ranges, mode: iso.mode };
      const mm = mapRef.current?.getMap();
      if (mm) registerLayerReplay(mm, "iso", (map) => paintIso(map, isoSpecRef.current));
      const polyCounts = results.map((r, i) => `${ranges[i]}min:${r.polygons.length}个`).join("  ");
      setIso((s) => ({ ...s, info: `计算完成（${ranges.join("/")} 分钟）：${polyCounts}，已叠加绘制` }));
    } catch (e) {
      setIso((s) => ({ ...s, err: e.message }));
    }
    setIso((s) => ({ ...s, loading: false }));
  }, [iso.loc, iso.mode, iso.range, iso.multi, iso.ranges, project, drawIsoPolygons, clearIsoLayers, paintIso]);

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
    if (!points.length) {
      // 清空时注销重放，避免样式重载把已结束的绘制画回来。
      drawSpecRef.current = null;
      unregisterLayerReplay(m, "draw");
      return;
    }
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
    // 登记重放：测量结果与绘制中的草稿都该在地图上留住。
    drawSpecRef.current = { points, kind };
    registerLayerReplay(m, "draw", (map) => {
      const spec = drawSpecRef.current;
      if (!spec) return;
      // 重放时复用同一套绘制逻辑（不走 renderDrawLayer，避免依赖组件 state）。
      const { points: pts, kind: k } = spec;
      const poly = k === "measure-polygon" || k === "draw-polygon";
      const measure = k.startsWith("measure");
      const c = measure ? "#1f77b4" : "#2ca02c";
      for (const id of ["draw-line", "draw-fill", "draw-pts"]) { try { if (map.getLayer(id)) map.removeLayer(id); } catch {} }
      try { if (map.getSource("draw-temp")) map.removeSource("draw-temp"); } catch {}
      try { if (map.getSource("draw-pts-src")) map.removeSource("draw-pts-src"); } catch {}
      const f = { type: "FeatureCollection", features: [] };
      if (pts.length >= (poly ? 3 : 2)) {
        const coords = poly ? [...pts, pts[0]] : pts;
        f.features.push({ type: "Feature", properties: {}, geometry: { type: poly ? "Polygon" : "LineString", coordinates: poly ? [coords] : coords } });
      } else if (pts.length === 1) {
        f.features.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: pts[0] } });
      }
      map.addSource("draw-temp", { type: "geojson", data: f });
      if (poly) map.addLayer({ id: "draw-fill", type: "fill", source: "draw-temp", paint: { "fill-color": c, "fill-opacity": 0.15 } });
      map.addLayer({ id: "draw-line", type: "line", source: "draw-temp", paint: { "line-color": c, "line-width": 2, "line-opacity": 0.9, "line-dasharray": [2, 1.5] } });
      map.addSource("draw-pts-src", { type: "geojson", data: { type: "FeatureCollection", features: pts.map((co, i) => ({ type: "Feature", properties: { i }, geometry: { type: "Point", coordinates: co } })) } });
      map.addLayer({ id: "draw-pts", type: "circle", source: "draw-pts-src", paint: { "circle-radius": 5, "circle-color": "#ffffff", "circle-stroke-color": c, "circle-stroke-width": 2 } });
    });
  }, []);

  // 绘制/测量重放规格（points + kind）。
  const drawSpecRef = useRef(null);

  const clearDrawLayers = useCallback(() => {
    const m = mapRef.current?.getMap();
    if (!m) return;
    for (const id of ["draw-line", "draw-fill", "draw-pts"]) {
      if (m.getLayer(id)) m.removeLayer(id);
    }
    if (m.getSource("draw-temp")) m.removeSource("draw-temp");
    if (m.getSource("draw-pts-src")) m.removeSource("draw-pts-src");
    drawSpecRef.current = null;
    unregisterLayerReplay(m, "draw");
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
  const handleFileChanged = useCallback((changed = []) => {
    const paths = (Array.isArray(changed) ? changed : []).map((item) => String(item || "").replace(/\\/g, "/"));
    const projectPrefix = `maps/${project}/`;
    // 共享 ChatPanel 会接收整个线程的 file_changed；只有当前地图项目的
    // 文件才能触发当前地图刷新，避免 A 项目的产物穿透到 B 项目。
    if (!paths.some((item) => item === `maps/${project}` || item.startsWith(projectPrefix))) return;
    loadProject(project);
    mapRef.current?.reloadStyle();
  }, [project, loadProject]);

  const handleCreateProject = useCallback(async () => {
    const name = window.prompt("新地图项目名称", "新的交通分析项目");
    if (!name?.trim()) return;
    const suggested = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "map-project";
    const id = window.prompt("项目标识（仅英文、数字、下划线或短横线）", suggested);
    if (!id?.trim()) return;
    try {
      const created = await mapCreateProject(id.trim(), name.trim(), "zhejiang-map");
      const listed = await mapProjects();
      setProjects(listed.projects || []);
      setProject(created.project || id.trim());
      flash(`已创建地图项目「${name.trim()}」，基础路网沿用浙江统一底图，业务图层独立保存`);
    } catch (e) {
      flash(`创建地图项目失败：${e.message}`);
    }
  }, [flash]);

  // 当前项目是否已归档（决定菜单显示“归档/取消归档”）
  const currentProjectArchived = useMemo(() => {
    const found = (projects || []).find((item) => (item.project || item.name) === project);
    return Boolean(found?.archived);
  }, [projects, project]);

  // 项目生命周期管理：复制 / 重命名 / 归档 / 删除（默认项目受保护）
  const handleProjectAction = useCallback(async (action) => {
    setProjectMenuOpen(false);
    if (!project) return;
    try {
      if (action === "duplicate") {
        const name = window.prompt("副本项目标识（仅英文、数字、下划线或短横线）", `${project}-copy`);
        if (!name?.trim()) return;
        const created = await mapDuplicateProject(project, name.trim());
        const listed = await mapProjects();
        setProjects(listed.projects || []);
        setProject(created.project || name.trim());
        flash(`已复制为「${created.project || name.trim()}」，可在其上继续分析而不影响原项目`);
      } else if (action === "rename") {
        const name = window.prompt("新的项目标识（仅英文、数字、下划线或短横线）", project);
        if (!name?.trim() || name.trim() === project) return;
        const renamed = await mapRenameProject(project, name.trim());
        const listed = await mapProjects();
        setProjects(listed.projects || []);
        setProject(renamed.project || name.trim());
        flash(`项目已重命名为「${renamed.project || name.trim()}」`);
      } else if (action === "archive") {
        if (!window.confirm(`归档地图项目「${project}」？归档后仍可通过再次操作恢复，不影响已有图层与瓦片。`)) return;
        await mapArchiveProject(project, true);
        const listed = await mapProjects();
        setProjects(listed.projects || []);
        flash(`项目「${project}」已归档`);
      } else if (action === "unarchive") {
        await mapArchiveProject(project, false);
        const listed = await mapProjects();
        setProjects(listed.projects || []);
        flash(`项目「${project}」已恢复`);
      } else if (action === "delete") {
        if (!window.confirm(`删除地图项目「${project}」？项目会移入回收目录（.trash），不会立即物理删除。`)) return;
        await mapDeleteProject(project);
        const listed = await mapProjects();
        const next = listed.projects || [];
        setProjects(next);
        if (next[0]?.project) setProject(next[0].project);
        flash(`项目「${project}」已移入回收目录`);
      }
    } catch (e) {
      flash(`项目操作失败：${e.message}`);
    }
  }, [project, flash]);

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
      syncTempLayers();
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
      if (rendered || attempts >= 12) {
        clearInterval(timer);
        // 图层真正落到地图上之后再重扫临时层清单，否则清单里看不到刚生成的结果。
        syncTempLayers();
      }
    };
    const timer = setInterval(render, 250);
    render();
    const title = action.title || (action.analysis === "isochrone" ? "等时圈" : action.analysis === "od" ? "出行 OD" : "热力图");
    const source = action.source === "demo" ? " · 演示数据" : "";
    flash(`${title}${source}已显示`);
  }, [project, regionOptions, selectRegion, flash, syncTempLayers]);

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
    // 测试钩子：把同一套处理器暴露到 window，供 L3 场景在真实事件路径上触发
    // （与 MapViewer 的 window.__oawMap 同类：只读引用，不参与业务逻辑）。
    try {
      window.__oawMapBridge = {
        mapAction: handleMapAction,
        fileChanged: handleFileChanged,
        agentEnd: handleAgentEnd,
      };
    } catch {}
    return () => {
      if (bridgeRef.current?.onMapAction === handleMapAction) bridgeRef.current = null;
      try { if (window.__oawMapBridge?.mapAction === handleMapAction) window.__oawMapBridge = null; } catch {}
    };
  }, [bridgeRef, handleMapAction, handleFileChanged, handleAgentEnd, handleOpenFile]);

  return (
    <div className={`mp ${hideChat ? "mp-shared-chat" : ""} ${hideChat && !chatVisible ? "mp-chat-hidden" : ""}`}>
      {/* 顶栏：收敛为 9 个一级控件（阶段 2 §2.4）
          场景（项目/底图/区域）· 内容（图层/可视化/数据）· 输出（导出）· 会话（模式/返回）
          测量与绘制移到画布浮动条（C5）。 */}
      <div className="mp-topbar">
        <Icon name="map" size={14} />
        <span className="mp-title">地图</span>

        {/* 模式切换：地图内直接切，不必返回主对话。 */}
        {onModeChange && (
          <div className="mp-mode-switch" role="group" aria-label="对话工作模式">
            <button
              type="button"
              className={`mp-mode-option ${conversationMode === "chat" ? "active" : ""}`}
              aria-pressed={conversationMode === "chat"}
              title="Chat：查询地图数据、生成临时可视化（刷新后不保留）"
              onClick={() => onModeChange("chat")}
            >Chat</button>
            <button
              type="button"
              className={`mp-mode-option work ${conversationMode === "agent" ? "active" : ""}`}
              aria-pressed={conversationMode === "agent"}
              title="Work：可新增/修改图层并保存为正式图层（写操作需审批）"
              onClick={() => onModeChange("agent")}
            >Work</button>
          </div>
        )}
        <TaskCenter
          sessions={sessions}
          currentThreadId={threadId}
          currentSessionId={currentSessionId}
          onSelectSession={onSelectSession}
          onFocusRun={onFocusRun}
        />

        {/* 1) 场景：项目菜单（含新建/复制/重命名/归档/删除，收敛 4 个控件） */}
        {projects.length > 0 && (
          <div className="mp-project-manage">
            <button
              className="btn-sm mp-menu-btn"
              onClick={() => setProjectMenuOpen((v) => !v)}
              title="地图项目：切换 / 新建 / 复制 / 重命名 / 归档 / 删除"
              aria-expanded={projectMenuOpen}
            >
              <Icon name="folder" size={13} /> {projects.find((x) => (x.project || x.name) === project)?.name || project}
              <Icon name="chevronDown" size={11} />
            </button>
            {projectMenuOpen && (
              <>
                <div className="mp-project-menu-backdrop" onClick={() => setProjectMenuOpen(false)} />
                <div className="mp-project-menu" role="menu">
                  <div className="mp-menu-label">切换项目</div>
                  {projects.map((p) => {
                    const id = p.project || p.name;
                    return (
                      <button key={id} type="button" role="menuitem" className={id === project ? "active" : ""} onClick={() => { setProject(id); setProjectMenuOpen(false); }}>
                        {p.name}{id === project ? " ✓" : ""}
                      </button>
                    );
                  })}
                  <div className="mp-analysis-menu-sep" />
                  <button type="button" role="menuitem" onClick={() => { handleCreateProject(); setProjectMenuOpen(false); }}>新建项目</button>
                  <button type="button" role="menuitem" onClick={() => handleProjectAction("duplicate")}>复制为副本</button>
                  <button type="button" role="menuitem" onClick={() => handleProjectAction("rename")}>重命名</button>
                  {currentProjectArchived ? (
                    <button type="button" role="menuitem" onClick={() => handleProjectAction("unarchive")}>取消归档</button>
                  ) : (
                    <button type="button" role="menuitem" onClick={() => handleProjectAction("archive")}>归档项目</button>
                  )}
                  <button type="button" role="menuitem" className="danger" onClick={() => handleProjectAction("delete")}>删除项目</button>
                </div>
              </>
            )}
          </div>
        )}

        {/* 2) 底图 */}
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

        {/* 3) 区域（下钻 / 范围 / 搜索 / 标注，收敛 4 个控件） */}
        <div className="mp-project-manage">
          <button
            className={`btn-sm mp-menu-btn ${regionMenuOpen ? "active" : ""}`}
            onClick={() => setRegionMenuOpen((v) => !v)}
            title="区域：切换地市/县市区、显示范围、标注开关"
            aria-expanded={regionMenuOpen}
          >
            <Icon name="locate" size={13} /> {drill ? drill.name : "全省"}
            <Icon name="chevronDown" size={11} />
          </button>
          {regionMenuOpen && (
            <>
              <div className="mp-project-menu-backdrop" onClick={() => setRegionMenuOpen(false)} />
              <div className="mp-project-menu mp-region-menu" role="menu">
                <div className="mp-menu-label">区域</div>
                <div className="mp-region-menu-tools">
                  <input
                    className="mp-region-search"
                    value={regionQuery}
                    onChange={(e) => setRegionQuery(e.target.value)}
                    placeholder="搜索地市 / 县市区"
                    title="按名称筛选"
                  />
                </div>
                <div className="mp-region-menu-list">
                  {regionOptions
                    .filter((r) => !regionQuery.trim() || !r.value || r.name?.includes(regionQuery.trim()) || r.label?.includes(regionQuery.trim()))
                    .map((r) => (
                      <button
                        key={r.value || "all"}
                        type="button"
                        role="menuitem"
                        className={r.value === regionCode ? "active" : ""}
                        onClick={() => { selectRegion(r.value); setRegionMenuOpen(false); }}
                      >
                        {r.label}{r.value === regionCode ? " ✓" : ""}
                      </button>
                    ))}
                </div>
                <div className="mp-analysis-menu-sep" />
                <div className="mp-menu-label">显示范围</div>
                {[["region", "当前区域"], ["city", "当前地市"], ["province", "全省"]].map(([v, label]) => (
                  <button key={v} type="button" role="menuitem" className={layerScope === v ? "active" : ""} onClick={() => { changeLayerScope(v); setRegionMenuOpen(false); }}>
                    {label}{layerScope === v ? " ✓" : ""}
                  </button>
                ))}
                <div className="mp-analysis-menu-sep" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { const next = !annotationsVisible; setAnnotationsVisible(next); mapRef.current?.setAnnotationVisibility(next); }}
                >
                  {annotationsVisible ? "隐藏标注" : "显示标注"}
                </button>
              </div>
            </>
          )}
        </div>

        <span className="mp-sep" />

        {/* 4) 图层（开合左栏） */}
        <button
          className={`btn-sm ${!leftHidden ? "active" : ""}`}
          onClick={() => setLeftHidden((v) => !v)}
          title={leftHidden ? "显示图层栏" : "隐藏图层栏（地图更宽）"}
          aria-pressed={!leftHidden}
        >
          <Icon name="layers" size={13} /> 图层
        </button>

        {/* 5) 可视化（开可视面板） */}
        <button className={`btn-sm ${visualOpen ? "active" : ""}`} onClick={() => setVisualOpen((v) => !v)} title="可视化：数据集、分析与图层结果">
          <Icon name="chart" size={13} /> 可视化
        </button>

        {/* 6) 数据（导入 / 重建瓦片 / 刷新） */}
        <div className="mp-analysis-wrap">
          <button
            className={`btn-sm ${dataMenuOpen ? "active" : ""}`}
            onClick={(e) => { e.stopPropagation(); setDataMenuOpen((v) => !v); }}
            title="数据：导入、重建瓦片、刷新地图"
            aria-expanded={dataMenuOpen}
          >
            <Icon name="upload" size={13} /> 数据 <Icon name="chevronDown" size={11} />
          </button>
          {dataMenuOpen && (
            <div className="mp-analysis-menu" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => { setImportOpen(true); setDataMenuOpen(false); }}><Icon name="upload" size={13} /> 导入数据</button>
              <button onClick={() => { handleRebuild(); setDataMenuOpen(false); }}><Icon name="refresh" size={13} /> 重建矢量瓦片</button>
              <button onClick={() => { refreshMap(); setDataMenuOpen(false); }}><Icon name="refresh" size={13} /> 刷新地图</button>
            </div>
          )}
        </div>

        <span className="mp-sep" />

        {/* 7) 视图（地球/平面 + 隐藏对话） */}
        <div className="mp-analysis-wrap">
          <button
            className={`btn-sm ${viewMenuOpen ? "active" : ""}`}
            onClick={(e) => { e.stopPropagation(); setViewMenuOpen((v) => !v); }}
            title="视图：地球/平面、Agent 对话开关"
            aria-expanded={viewMenuOpen}
          >
            <Icon name="globe" size={13} /> 视图 <Icon name="chevronDown" size={11} />
          </button>
          {viewMenuOpen && (
            <div className="mp-analysis-menu" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => { toggleGlobe(); setViewMenuOpen(false); }}>
                <Icon name="globe" size={13} /> 切换为{globeMode ? "平面地图" : "地球视图"}
              </button>
              {hideChat && (
                <button onClick={() => { onToggleChat?.(); setViewMenuOpen(false); }}>
                  <Icon name="comment" size={13} /> {chatVisible ? "隐藏 Agent 对话" : "显示 Agent 对话"}
                </button>
              )}
            </div>
          )}
        </div>

        {/* 8) 导出 */}
        <button className="btn-sm" onClick={() => setExportOpen(true)} title="导出报告图（含图例/比例尺/指北针）">
          <Icon name="download" size={13} /> 导出
        </button>

        {msg && <span className="mp-msg">{msg}</span>}

        {/* 9) 返回 */}
        <button className="btn-sm mp-exit" onClick={onExit}><Icon name="back" size={14} /> 返回</button>
      </div>

      <div className="mp-body">
        {/* 可视面板（阶段 2.2）：替代 M2 宏观 4 tab / M3 公交 4 tab / 柬埔寨 OD / 示例数据菜单。
            旧面板组件已下线（删除前已按脚本确认无引用、未进构建产物、无测试断言依赖）。 */}
        {visualOpen && (
          <div className="vp-overlay">
            <可视面板
              project={project}
              workspace={workspace}
              mapRef={mapRef}
              conversationMode={conversationMode}
              onClose={() => setVisualOpen(false)}
              onSaveAnalysis={saveAnalysis}
              onAskAgent={(text) => {
                // 自然语言路径交给对话栏（复用全局单实例，消息与 SSE 连续）
                insertChatText?.(text);
                setVisualOpen(false);
              }}
              onResultChange={(result) => {
                setActiveAnalysis(result);
                syncTempLayers();
              }}
            />
          </div>
        )}
        {/* 左栏：QGIS 风格图层面板（顶栏「图层」可开合，把地图让出来） */}
        {!leftHidden && (
        <div className="mp-left" style={{ width: leftW, minWidth: leftW, maxWidth: leftW }}>
          <div className="mp-left-title">
            <Icon name="layers" size={12} /> 图层
            <span className="mp-layer-count">{layerViews.length || files.length}</span>
          </div>
          <LayerPanel
            project={project}
            cfg={cfg}
            style={style}
            files={files}
            layerViews={layerViews}
            tempLayers={tempLayers}
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
        )}
        {!leftHidden && <div className="mp-hresize left" onMouseDown={(e) => startPaneDrag(e, "left")} title="拖动调整左栏宽度" />}

        {/* 中栏：地图 */}
        <div className="mp-center">
          <MapViewer
            ref={mapRef}
            project={project}
            config={cfg}
            onBasemapResolved={(id) => setCfg((prev) => (prev && prev.basemap === id ? prev : { ...(prev || {}), basemap: id }))}
            onViewportChange={(context) => {
              // 视口上报时带上当前下钻区域名：对话栏的"地图状态行"与 Agent 上下文
              // 都要显示"义乌市附近"这类可读位置，而不只是经纬度。
              onViewportChange?.({ ...context, regionName: drill?.name || "" });
            }}
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
          {/* 画布浮动条（阶段 2 §2.4）：测量 / 绘制 / 分析工具 / 清除从顶栏移到这里，
              贴近地图操作，也让顶栏只保留场景与内容级控件。 */}
          <div className="mp-floatbar" role="toolbar" aria-label="地图工具">
            <button
              className={`mp-float-btn ${odOpen ? "active" : ""}`}
              onClick={() => { setOdOpen(true); setIsoOpen(false); }}
              title="OD 流量分析：粘贴 CSV 出热力图与流向线"
              aria-pressed={odOpen}
            >
              <Icon name="flow" size={13} /> OD
            </button>
            <button
              className={`mp-float-btn ${isoOpen ? "active" : ""}`}
              onClick={() => { setIsoOpen(true); setOdOpen(false); }}
              title="可达性：等时圈与路径规划"
              aria-pressed={isoOpen}
            >
              <Icon name="history" size={13} /> 可达性
            </button>
            <span className="mp-float-sep" />
            <button
              className={`mp-float-btn ${draw?.kind?.startsWith("measure") ? "active" : ""}`}
              onClick={(e) => { e.stopPropagation(); setToolMenu({ type: "measure" }); }}
              title="测量距离/面积（点击加点，双击结束）"
              aria-pressed={Boolean(draw?.kind?.startsWith("measure"))}
            >
              <Icon name="locate" size={13} /> 测量
            </button>
            <button
              className={`mp-float-btn ${draw && !draw.kind.startsWith("measure") ? "active" : ""}`}
              onClick={(e) => { e.stopPropagation(); setToolMenu({ type: "draw" }); }}
              title="绘制点/线/面并保存为图层"
              aria-pressed={Boolean(draw && !draw.kind.startsWith("measure"))}
            >
              <Icon name="penTool" size={13} /> 绘制
            </button>
            {(activeAnalysis || tempLayers.length > 0 || measureResult) && (
              <button
                className="mp-float-btn"
                onClick={() => {
                  // 清除语义 = "清掉地图上所有临时图层"，所以按图层 id 前缀兜底扫描，
                  // 而不是只清"最后一次结果"——连续出图后 activeAnalysis 只记得最后一条，
                  // 逐条清会漏掉更早的（用户看到"清不干净"）。
                  const m = mapRef.current?.getMap?.();
                  const analysisBases = new Set();
                  try {
                    for (const layer of m?.getStyle?.().layers || []) {
                      const id = String(layer.id || "");
                      // 两套 id 族都要认：rich 路径 analysis-<base>-<suffix>，
                      // Agent 路径 <base>-heat/-circles/-labels/-od-lines。
                      // agent 路径只认 agent-* 前缀，避免误伤名字恰好以 -fill/-line 结尾的业务图层。
                      const rich = id.match(/^analysis-(.+?)-(src|heat|points|fill|lines|lines-src|labels|circles)$/);
                      if (rich) { analysisBases.add(rich[1]); continue; }
                      const agent = id.match(/^(agent-.+?)-(heat|circles|labels|fill|line|od-lines)$/);
                      if (agent) analysisBases.add(agent[1]);
                    }
                  } catch { /* 读不到样式时退回逐条清 */ }
                  const ids = new Set(["agent-analysis", "analysis"]);
                  if (activeAnalysis?.id) ids.add(String(activeAnalysis.id));
                  for (const base of analysisBases) ids.add(base);
                  for (const id of ids) {
                    mapRef.current?.clearAnalysisRich?.(id);
                    mapRef.current?.clearAnalysis?.(id);
                  }
                  mapRef.current?.clearAllAnalysis?.();
                  clearDrawLayers();
                  setMeasureResult(null);
                  setActiveAnalysis(null);
                  syncTempLayers();
                  flash("已清除临时图层");
                }}
                title="清除地图上的临时图层（分析结果 / 测量 / 绘制）"
              >
                <Icon name="trash" size={13} /> 清除
              </button>
            )}
          </div>
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
              compact
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

      {/* 画布工具菜单（测量/绘制，由浮动条触发；位置由 CSS 锚定在浮动条下方） */}
      {toolMenu && (
        <div className="mp-toolmenu" onClick={(e) => e.stopPropagation()}>
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
