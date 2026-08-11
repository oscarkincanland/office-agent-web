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

const BASEMAP_NAMES = { carto: "亮色", osm: "OSM", dark: "暗色", satellite: "卫星" };
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
}) {
  const [projects, setProjects] = useState([]);
  const [project, setProject] = useState("zhejiang-map");
  const [cfg, setCfg] = useState(null);
  const [style, setStyle] = useState(null);
  const [files, setFiles] = useState([]);
  const [msg, setMsg] = useState("");
  const [selectedLayer, setSelectedLayer] = useState(null);
  const [attrLayer, setAttrLayer] = useState(null); // {layerId, name}
  const [isoOpen, setIsoOpen] = useState(false);
  const [iso, setIso] = useState({ mode: "driving", range: 30, loc: null, picking: false, loading: false, err: "", info: "" });
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
        if (value === null || value === undefined) delete paint[key];
        else paint[key] = value;
        return { ...l, paint };
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

  const drawIsoPolygons = useCallback((polygons, center) => {
    const m = mapRef.current?.getMap();
    if (!m) return;
    // 清理上一轮结果
    for (const id of ["iso-fill", "iso-line", "iso-center"]) {
      if (m.getLayer(id)) m.removeLayer(id);
    }
    if (m.getSource("iso-temp")) m.removeSource("iso-temp");
    if (m.getSource("iso-center-src")) m.removeSource("iso-center-src");
    // 绘制等时圈多边形（临时图层，不写入项目）
    const fc = {
      type: "FeatureCollection",
      features: polygons.map((pts) => ({
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [pts] },
      })),
    };
    m.addSource("iso-temp", { type: "geojson", data: fc });
    m.addLayer({ id: "iso-fill", type: "fill", source: "iso-temp", paint: { "fill-color": "#7b1fa2", "fill-opacity": 0.25 } });
    m.addLayer({ id: "iso-line", type: "line", source: "iso-temp", paint: { "line-color": "#7b1fa2", "line-width": 2, "line-opacity": 0.9 } });
    if (center) {
      m.addSource("iso-center-src", {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: center } },
      });
      m.addLayer({ id: "iso-center", type: "circle", source: "iso-center-src", paint: { "circle-radius": 6, "circle-color": "#7b1fa2", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
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

  const runIso = useCallback(async () => {
    if (!iso.loc) {
      setIso((s) => ({ ...s, err: "请先选择中心点（点击「地图选点」或使用当前地图中心）" }));
      return;
    }
    setIso((s) => ({ ...s, loading: true, err: "", info: "" }));
    try {
      const r = await mapIsochrone({
        name: project,
        location: `${iso.loc[0].toFixed(6)},${iso.loc[1].toFixed(6)}`,
        mode: iso.mode,
        range: iso.range,
        rangeType: "time",
      });
      drawIsoPolygons(r.polygons, r.center);
      setIso((s) => ({ ...s, info: `计算完成：${r.polygons.length} 个多边形（成本 ${r.cost ?? "?"}），已绘制到地图` }));
    } catch (e) {
      setIso((s) => ({ ...s, err: e.message }));
    }
    setIso((s) => ({ ...s, loading: false }));
  }, [iso.loc, iso.mode, iso.range, project, drawIsoPolygons]);

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
        <div className="mp-basemap" title="开源底图切换">
          {Object.entries(BASEMAP_NAMES).map(([id, label]) => (
            <button
              key={id}
              className={`mp-basemap-btn ${cfg?.basemap === id ? "active" : ""}`}
              onClick={() => switchBasemap(id)}
            >
              {label}
            </button>
          ))}
        </div>
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
        {msg && <span className="mp-msg">{msg}</span>}
        <button className="btn-sm mp-exit" onClick={onExit}><Icon name="back" size={14} /> 返回</button>
      </div>

      <div className="mp-body">
        {/* 左栏：QGIS 风格图层面板 */}
        <div className="mp-left">
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
            onSetOpacity={setOpacity}
            onMoveLayerTo={moveLayerTo}
            onRenameLayer={renameLayer}
            onDuplicateLayer={duplicateLayer}
            onDeleteLayer={removeLayer}
            onZoomToLayer={zoomToLayer}
            onOpenAttribute={openAttribute}
          />
        </div>

        {/* 中栏：地图 */}
        <div className="mp-center">
          <MapViewer
            ref={mapRef}
            project={project}
            config={cfg}
            onLayerTilesChanged={() => loadProject(project)}
          />
        </div>

        {/* 右栏：agent 对话 */}
        <div className="mp-right">
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
          />
        </div>
      </div>

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
              </div>
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
