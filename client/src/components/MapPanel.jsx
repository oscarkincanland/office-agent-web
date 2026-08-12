import React, { useState, useEffect, useCallback } from "react";
import Icon from "./Icon.jsx";
import { mapProject, mapRebuildTiles } from "../api.js";

const BASEMAP_OPTIONS = [
  { id: "carto", name: "Carto 亮色" },
  { id: "osm", name: "OSM 标准" },
  { id: "dark", name: "Carto 暗色" },
  { id: "satellite", name: "卫星影像" },
];

/**
 * 左侧面板（QGIS 风格三 tab）：
 *   📁 文件  — 地图项目文件清单（style.json / map.config.json / layers/*.geojson）
 *   🧰 工具箱 — 导出/重建瓦片/定位/全屏
 *   🗂 图层  — 图层显隐/透明度/顺序/底图切换
 */
export default function MapPanel({ project = "zhejiang-map", mapRef, onFilesChanged }) {
  const [tab, setTab] = useState("layers");
  const [data, setData] = useState(null); // { config, style, files, basemaps }
  const [vis, setVis] = useState({}); // layerId -> bool
  const [opacity, setOpacity] = useState({}); // layerId -> 0..1
  const [basemap, setBasemap] = useState("carto");
  const [busy, setBusy] = useState("");

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
          <div className="mp-tool-btn" onClick={() => doExport(1)}>
            <Icon name="download" size={14} /> 导出地图 PNG
          </div>
          <div className="mp-tool-btn" onClick={() => doExport(3)}>
            <Icon name="image" size={14} /> 高清导出 (3x)
          </div>
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
        <div className="map-panel-body">
          <div className="mp-section-title">底图</div>
          <div className="mp-basemap-row">
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

          <div className="mp-section-title" style={{ marginTop: 10 }}>
            图层
            <button className="mp-refresh" title="刷新" onClick={refresh}>
              <Icon name="refresh" size={11} />
            </button>
          </div>
          {(data?.config?.layers || []).map((l, idx) => (
            <div className="mp-layer" key={l.id}>
              <div className="mp-layer-head">
                <label className="mp-check">
                  <input
                    type="checkbox"
                    checked={vis[l.id] !== false}
                    onChange={() => toggleLayer(l.id)}
                  />
                  <span className="mp-check-mark"><Icon name="check" size={10} /></span>
                  <span className="mp-layer-name">{l.name}</span>
                </label>
                <div className="mp-layer-ops">
                  <button title="上移" onClick={() => moveLayer(l.id, "up")} disabled={idx === 0}>
                    <Icon name="chevronRight" size={11} className="mp-rotate-ccw" />
                  </button>
                  <button title="下移" onClick={() => moveLayer(l.id, "down")} disabled={idx === (data?.config?.layers || []).length - 1}>
                    <Icon name="chevronRight" size={11} className="mp-rotate-cw" />
                  </button>
                </div>
              </div>
              <div className="mp-opacity">
                <span>透明度</span>
                <input
                  type="range" min="0" max="1" step="0.05"
                  value={opacity[l.id] ?? 1}
                  onChange={(e) => changeOpacity(l.id, parseFloat(e.target.value))}
                />
              </div>
            </div>
          ))}
          {!(data?.config?.layers || []).length && <div className="mp-empty">暂无图层</div>}
        </div>
      )}

      {busy && <div className="mp-busy">{busy}</div>}
    </div>
  );
}
