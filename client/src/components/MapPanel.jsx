import React, { useState, useEffect, useCallback } from "react";
import Icon from "./Icon.jsx";
import LayerPanel from "./LayerPanel.jsx";
import AttributeTable from "./AttributeTable.jsx";
import { mapProject, mapRebuildTiles, mapSaveStyle, mapDeleteLayer, mapIsochrone } from "../api.js";

const BASEMAP_OPTIONS = [
  { id: "carto", name: "Carto 亮色" },
  { id: "osm", name: "OSM 标准" },
  { id: "dark", name: "Carto 暗色" },
  { id: "satellite", name: "卫星影像" },
];

// ---- 测量计算（haversine / 多边形面积近似） ----
function haversineM(a, b) {
  const R = 6371000;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const la1 = (a[1] * Math.PI) / 180;
  const la2 = (b[1] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function pathLengthM(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversineM(pts[i - 1], pts[i]);
  return d;
}
function polygonAreaM2(pts) {
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
}
const fmtLen = (m) => (m >= 1000 ? (m / 1000).toFixed(2) + " km" : m.toFixed(0) + " m");
const fmtArea = (m2) => (m2 >= 1e6 ? (m2 / 1e6).toFixed(2) + " km²" : m2.toFixed(0) + " m²");

/**
 * 左侧面板（QGIS 风格三 tab）：
 *   📁 文件  — 地图项目文件清单（style.json / map.config.json / layers/*.geojson）
 *   🧰 工具箱 — 导出/重建瓦片/定位/全屏/测量/绘制/等时圈
 *   🗂 图层  — LayerPanel（显隐/透明度/排序/样式编辑/属性表）
 */
export default function MapPanel({ project = "zhejiang-map", mapRef, onFilesChanged }) {
  const [tab, setTab] = useState("layers");
  const [data, setData] = useState(null); // { config, style, files, basemaps }
  const [vis, setVis] = useState({}); // layerId -> bool
  const [opacity, setOpacity] = useState({}); // layerId -> 0..1
  const [basemap, setBasemap] = useState("carto");
  const [busy, setBusy] = useState("");
  const [selectedLayer, setSelectedLayer] = useState(null);
  const [attrTable, setAttrTable] = useState(null); // { layerId, layerName } 属性表弹窗
  const [drawResult, setDrawResult] = useState(null); // 测量结果 {kind, points, dist?, area?}
  const [drawing, setDrawing] = useState(false); // 绘制进行中
  const [isoMsg, setIsoMsg] = useState(""); // 等时圈状态

  const refresh = useCallback(async () => {
    try {
      const d = await mapProject(project);
      setData(d);
      const v = {};
      for (const l of d.config?.layers || []) v[l.id] = l.visible !== false;
      setVis((prev) => ({ ...prev, ...v }));
      const op = {};
      for (const l of d.config?.layers || []) op[l.id] = 1;
      setOpacity((prev) => ({ ...prev, ...op }));
      setBasemap(d.config?.basemap || "carto");
      mapRef.current?.setBasemap?.(d.config?.basemap || "carto");
    } catch (e) {
      setData({ config: { name: project, layers: [] }, files: [], basemaps: [] });
    }
  }, [project, mapRef]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000); // 感知 agent 新增图层/文件
    return () => clearInterval(t);
  }, [refresh]);

  const toggleLayer = useCallback((id) => {
    setVis((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      mapRef.current?.setLayerVisibility?.(id, next[id]);
      return next;
    });
  }, [mapRef]);

  const changeOpacity = useCallback((id, val) => {
    setOpacity((prev) => ({ ...prev, [id]: val }));
    mapRef.current?.setLayerOpacity?.(id, val);
  }, [mapRef]);

  const moveLayer = useCallback((id, dir) => {
    mapRef.current?.moveLayer?.(id, dir);
  }, [mapRef]);

  const moveLayerTo = useCallback((id, targetId) => {
    mapRef.current?.moveLayerTo?.(id, targetId);
  }, [mapRef]);

  const switchBasemap = useCallback((id) => {
    setBasemap(id);
    mapRef.current?.setBasemap?.(id);
  }, [mapRef]);

  const doRebuildTiles = useCallback(async () => {
    setBusy("正在重建瓦片…");
    try {
      const r = await mapRebuildTiles(project);
      setBusy("瓦片重建完成");
      setTimeout(() => setBusy(""), 2500);
      mapRef.current?.reloadStyle?.();
    } catch (e) {
      setBusy("重建失败: " + e.message);
      setTimeout(() => setBusy(""), 4000);
    }
  }, [project, mapRef]);

  const doExport = useCallback((scale) => {
    mapRef.current?.exportPng?.(scale, `map-${Date.now()}.png`);
  }, [mapRef]);

  const doZoomZhejiang = useCallback(() => {
    const map = mapRef.current?.getMap?.();
    if (map) map.flyTo({ center: [120.0, 29.2], zoom: 7 });
  }, [mapRef]);

  const doFullscreen = useCallback(() => {
    const map = mapRef.current?.getMap?.();
    const canvas = map?.getCanvas?.();
    if (canvas) {
      if (document.fullscreenElement) document.exitFullscreen();
      else canvas.requestFullscreen?.();
    }
  }, [mapRef]);

  // ---- LayerPanel 回调 ----

  // 样式编辑：运行时改 paint + 持久化 style.json
  const setLayerPaint = useCallback(async (layerId, key, value) => {
    mapRef.current?.setLayerPaint?.(layerId, key, value);
    try {
      const style = data?.style;
      if (!style) return;
      const layer = style.layers?.find((l) => l.id === layerId);
      if (layer) {
        layer.paint = layer.paint || {};
        if (value === null) delete layer.paint[key];
        else layer.paint[key] = value;
        await mapSaveStyle(project, style);
      }
    } catch {}
  }, [data, project]);

  const renameLayer = useCallback(async (layerId, name) => {
    try {
      const cfg = data?.config;
      if (!cfg) return;
      cfg.layers = (cfg.layers || []).map((l) => (l.id === layerId ? { ...l, name } : l));
      const r = await fetch(`/api/map/project/${encodeURIComponent(project)}/config`, {
        method: "POST",
        body: JSON.stringify({ config: cfg }),
      });
      await r.json();
      refresh();
    } catch {}
  }, [data, project, refresh]);

  const duplicateLayer = useCallback(async (layerId) => {
    try {
      const cfg = data?.config;
      if (!cfg) return;
      const src = (cfg.layers || []).find((l) => l.id === layerId);
      if (!src) return;
      const newId = `${layerId}_copy`;
      cfg.layers = [...(cfg.layers || []), { ...src, id: newId, name: src.name + "（副本）" }];
      const r = await fetch(`/api/map/project/${encodeURIComponent(project)}/config`, {
        method: "POST",
        body: JSON.stringify({ config: cfg }),
      });
      await r.json();
      refresh();
    } catch {}
  }, [data, project, refresh]);

  const removeLayer = useCallback(async (layerId) => {
    if (!window.confirm(`确定删除图层「${layerId}」？将移除数据、瓦片与样式。`)) return;
    try {
      await mapDeleteLayer(project, layerId);
      refresh();
      mapRef.current?.reloadStyle?.();
    } catch (e) {
      setBusy("删除失败: " + e.message);
      setTimeout(() => setBusy(""), 4000);
    }
  }, [project, refresh, mapRef]);

  const zoomToLayer = useCallback((layerId) => {
    mapRef.current?.zoomToLayer?.(layerId);
  }, [mapRef]);

  const openAttribute = useCallback((layerId) => {
    const layer = (data?.config?.layers || []).find((l) => l.id === layerId);
    setAttrTable({ layerId, layerName: layer?.name || layerId });
  }, [data]);

  // ---- 测量 / 绘制 ----

  const startDraw = useCallback((kind, label) => {
    setDrawResult(null);
    setDrawing(true);
    mapRef.current?.startDraw?.(kind, {
      onDone: (points) => {
        setDrawing(false);
        if (kind === "measure-line") setDrawResult({ kind, points, dist: pathLengthM(points) });
        else if (kind === "measure-polygon") setDrawResult({ kind, points, area: polygonAreaM2(points) });
        else setDrawResult({ kind, points });
      },
    });
    setBusy(`${label}：点击地图开始，双击完成（Esc 取消）`);
    setTimeout(() => setBusy(""), 5000);
  }, [mapRef]);

  const stopDraw = useCallback(() => {
    mapRef.current?.stopDraw?.();
    setDrawing(false);
  }, [mapRef]);

  // ---- 等时圈分析（高德 Web 服务，需 AMAP_KEY） ----

  const doIsochrone = useCallback(() => {
    setIsoMsg("在地图上点击起点位置…");
    setBusy("等时圈：点击地图选择起点");
    mapRef.current?.pickLocation?.(async (loc) => {
      setBusy("");
      const range = window.prompt("等时圈时间范围（分钟）", "30");
      if (!range) { setIsoMsg(""); return; }
      setIsoMsg(`正在请求等时圈（${range} 分钟）…`);
      try {
        const r = await mapIsochrone(project, { location: `${loc[0]},${loc[1]}`, mode: "driving", range: parseInt(range, 10) || 30, rangeType: "time" });
        if (r.error) {
          setIsoMsg("等时圈失败: " + r.error);
          setTimeout(() => setIsoMsg(""), 6000);
          return;
        }
        mapRef.current?.showIsochrones?.(r.polygons || []);
        setIsoMsg(`等时圈已生成（${r.cost?.duration || range} 分钟）`);
        setTimeout(() => setIsoMsg(""), 5000);
      } catch (e) {
        setIsoMsg("等时圈请求失败: " + e.message);
        setTimeout(() => setIsoMsg(""), 6000);
      }
    });
  }, [project, mapRef]);

  const clearIsochrones = useCallback(() => {
    mapRef.current?.clearIsochrones?.();
  }, [mapRef]);

  return (
    <div className="map-panel">
      <div className="map-panel-tabs">
        <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>
          <Icon name="folder" size={13} /> 文件
        </button>
        <button className={tab === "tools" ? "active" : ""} onClick={() => setTab("tools")}>
          <Icon name="tool" size={13} /> 工具箱
        </button>
        <button className={tab === "layers" ? "active" : ""} onClick={() => setTab("layers")}>
          <Icon name="layer" size={13} /> 图层
        </button>
      </div>

      {tab === "files" && (
        <div className="map-panel-body">
          <div className="mp-section-title">地图项目文件</div>
          <div className="mp-file-group">
            <div className="mp-file-item">
              <Icon name="file" size={13} /> map.config.json
              <span className="mp-file-badge">配置</span>
            </div>
            <div className="mp-file-item">
              <Icon name="html" size={13} /> style.json
              <span className="mp-file-badge">样式</span>
            </div>
          </div>
          <div className="mp-section-title">图层数据 layers/</div>
          <div className="mp-file-group">
            {(data?.files || []).map((f) => (
              <div className="mp-file-item" key={f.id}>
                <Icon name={f.id.includes("station") || f.id.includes("junction") ? "pin" : "map"} size={13} />
                {f.file}
                <span className="mp-file-badge">{(f.size / 1024).toFixed(1)}KB</span>
              </div>
            ))}
            {!(data?.files || []).length && <div className="mp-empty">无图层文件</div>}
          </div>
          <div className="mp-hint">
            Agent 对话可直接修改 style.json 与 layers/*.geojson，保存后地图自动热更新。
          </div>
        </div>
      )}

      {tab === "tools" && (
        <div className="map-panel-body">
          <div className="mp-section-title">导出</div>
          <div className="mp-tool-btn" onClick={() => doExport(1)}>
            <Icon name="download" size={14} /> 导出地图 PNG
          </div>
          <div className="mp-tool-btn" onClick={() => doExport(3)}>
            <Icon name="image" size={14} /> 高清导出 (3x)
          </div>

          <div className="mp-section-title" style={{ marginTop: 10 }}>分析工具</div>
          <div className="mp-tool-btn" onClick={() => startDraw("measure-line", "测量距离")}>
            <Icon name="pin" size={14} /> 测量距离
          </div>
          <div className="mp-tool-btn" onClick={() => startDraw("measure-polygon", "测量面积")}>
            <Icon name="map" size={14} /> 测量面积
          </div>
          <div className="mp-tool-btn" onClick={() => startDraw("draw-point", "标绘点")}>
            <Icon name="pin" size={14} /> 标绘点
          </div>
          {drawing && (
            <div className="mp-tool-btn" onClick={stopDraw} style={{ color: "var(--danger, #f87171)" }}>
              <Icon name="x" size={14} /> 取消绘制
            </div>
          )}
          {drawResult && (
            <div className="mp-measure-result">
              {drawResult.dist !== undefined && <span>距离：{fmtLen(drawResult.dist)}</span>}
              {drawResult.area !== undefined && <span>面积：{fmtArea(drawResult.area)}</span>}
              {drawResult.dist === undefined && drawResult.area === undefined && <span>已标绘 {drawResult.points.length} 个点</span>}
            </div>
          )}

          <div className="mp-section-title" style={{ marginTop: 10 }}>等时圈</div>
          <div className="mp-tool-btn" onClick={doIsochrone}>
            <Icon name="globe" size={14} /> 等时圈分析（高德）
          </div>
          <div className="mp-tool-btn" onClick={clearIsochrones}>
            <Icon name="refresh" size={14} /> 清除等时圈
          </div>
          {isoMsg && <div className="mp-hint" style={{ marginTop: 6 }}>{isoMsg}</div>}

          <div className="mp-section-title" style={{ marginTop: 10 }}>项目</div>
          <div className="mp-tool-btn" onClick={doZoomZhejiang}>
            <Icon name="globe" size={14} /> 定位浙江省
          </div>
          <div className="mp-tool-btn" onClick={doFullscreen}>
            <Icon name="menu" size={14} /> 全屏地图
          </div>
          <div className="mp-tool-btn" onClick={doRebuildTiles}>
            <Icon name="refresh" size={14} /> 重建矢量瓦片
          </div>
          <div className="mp-hint" style={{ marginTop: 8 }}>
            提示：导入数据请用地图左上角「导入」按钮，支持 .geojson 与 .shp（需同目录 .dbf）。
          </div>
        </div>
      )}

      {tab === "layers" && (
        <div className="map-panel-body" style={{ padding: 0 }}>
          <div className="mp-section-title" style={{ padding: "8px 10px 0" }}>底图</div>
          <div className="mp-basemap-row" style={{ padding: "0 10px" }}>
            {BASEMAP_OPTIONS.map((b) => (
              <button
                key={b.id}
                className={`mp-basemap-btn ${basemap === b.id ? "active" : ""}`}
                onClick={() => switchBasemap(b.id)}
                title={b.name}
              >
                {b.name}
              </button>
            ))}
          </div>
          <LayerPanel
            project={project}
            cfg={data?.config}
            style={data?.style}
            files={data?.files}
            selected={selectedLayer}
            onSelect={setSelectedLayer}
            onToggleLayer={toggleLayer}
            onSetPaint={setLayerPaint}
            onSetOpacity={changeOpacity}
            onMoveLayerTo={moveLayerTo}
            onRenameLayer={renameLayer}
            onDuplicateLayer={duplicateLayer}
            onDeleteLayer={removeLayer}
            onZoomToLayer={zoomToLayer}
            onOpenAttribute={openAttribute}
          />
        </div>
      )}

      {busy && <div className="mp-busy">{busy}</div>}

      {attrTable && (
        <AttributeTable
          project={project}
          layerId={attrTable.layerId}
          layerName={attrTable.layerName}
          onClose={() => setAttrTable(null)}
          onLocate={() => zoomToLayer(attrTable.layerId)}
        />
      )}
    </div>
  );
}
