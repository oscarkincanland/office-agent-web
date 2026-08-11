import React, { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { Map as MapLibreMap, NavigationControl, ScaleControl, Popup } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import shp from "shpjs";
import Icon from "./Icon.jsx";
import { mapImportLayer } from "../api.js";

const STYLE_PATH = (project) => `/api/map/data/${project}/style.json`;

/**
 * 地图主区（MapLibre GL）
 * - 加载 style.json（矢量瓦片图层 + 4 底图）
 * - 轮询 style.json 感知 agent 修改 → 热更新
 * - 点击要素弹窗、坐标状态栏
 * - 导出 PNG / 导入 GeoJSON+SHP（外部 ref API）
 */
const MapViewer = forwardRef(function MapViewer(
  { project = "zhejiang-map", config, onConfigChange, onLayerTilesChanged },
  ref
) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const styleHashRef = useRef("");
  const [loaded, setLoaded] = useState(false);
  const [basemap, setBasemap] = useState(config?.basemap || "carto");
  const [cursor, setCursor] = useState({ lng: null, lat: null, zoom: null });
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState(""); // 轻提示
  const fileInputRef = useRef(null);

  // 初始化地图
  useEffect(() => {
    if (!containerRef.current) return undefined;
    const map = new MapLibreMap({
      container: containerRef.current,
      style: STYLE_PATH(project),
      center: config?.center || [120.0, 29.2],
      zoom: config?.zoom || 7,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ visualizePitch: true }), "bottom-right");
    map.addControl(new ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");
    map.on("load", () => setLoaded(true));
    map.on("move", () => {
      const c = map.getCenter();
      setCursor({ lng: c.lng.toFixed(5), lat: c.lat.toFixed(5), zoom: map.getZoom().toFixed(2) });
    });
    return () => {
      try { map.remove(); } catch {}
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // 点击要素弹窗
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return undefined;
    const popup = new Popup({ closeButton: true, closeOnClick: false, maxWidth: "300px" });
    const onClick = (e) => {
      const feats = map.queryRenderedFeatures(e.point, {});
      const pick = feats.find(
        (f) => f.layer && !f.layer.id.startsWith("basemap") && f.properties && Object.keys(f.properties).length
      );
      if (!pick) return;
      const p = pick.properties;
      const rows = Object.entries(p)
        .filter(([, v]) => v !== "" && v !== null && v !== undefined)
        .map(([k, v]) => `<tr><td class="mp-pop-key">${k}</td><td>${v}</td></tr>`)
        .join("");
      popup.setLngLat(e.lngLat).setHTML(`<table class="mp-pop">${rows}</table>`).addTo(map);
    };
    map.on("click", onClick);
    const move = () => popup.remove();
    map.on("move", move);
    return () => {
      map.off("click", onClick);
      map.off("move", move);
      try { popup.remove(); } catch {}
    };
  }, [loaded]);

  // 轮询 style.json + map.config.json，感知 agent 修改（file_changed 后由上层触发立即刷新）
  useEffect(() => {
    if (!loaded) return undefined;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(STYLE_PATH(project));
        const text = await res.text();
        const hash = text.length + ":" + text.slice(0, 200);
        if (hash !== styleHashRef.current) {
          styleHashRef.current = hash;
          applyStyle(JSON.parse(text));
        }
      } catch {}
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, project]);

  // 应用样式（保留相机 + 重放客户端图层状态）
  const applyStyle = useCallback((style) => {
    const map = mapRef.current;
    if (!map) return;
    const camera = map.getCenter();
    const zoom = map.getZoom();
    try { map.setStyle(style, { diff: false }); } catch {}
    map.jumpTo({ center: camera, zoom });
    // 重放底图
    setBasemap((prev) => {
      for (const id of ["carto", "osm", "dark", "satellite"]) {
        if (map.getLayer(`basemap-${id}`)) {
          map.setLayoutProperty(`basemap-${id}`, "visibility", id === prev ? "visible" : "none");
        }
      }
      return prev;
    });
  }, []);

  // 外部命令（MapPanel 调用）
  useImperativeHandle(ref, () => ({
    getMap: () => mapRef.current,
    /** 热更新：agent 修改 style.json 后调用 */
    reloadStyle: async () => {
      try {
        const res = await fetch(STYLE_PATH(project));
        const style = await res.json();
        styleHashRef.current = res.status + ":" + JSON.stringify(style).slice(0, 200);
        applyStyle(style);
        return true;
      } catch { return false; }
    },
    setBasemap: (id) => {
      const map = mapRef.current;
      if (!map) return;
      for (const bid of ["carto", "osm", "dark", "satellite"]) {
        if (map.getLayer(`basemap-${bid}`)) {
          map.setLayoutProperty(`basemap-${bid}`, "visibility", bid === id ? "visible" : "none");
        }
      }
      setBasemap(id);
    },
    setLayerVisibility: (id, visible) => {
      const map = mapRef.current;
      if (!map || !map.getLayer(id)) return;
      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    },
    setLayerOpacity: (id, opacity) => {
      const map = mapRef.current;
      if (!map || !map.getLayer(id)) return;
      const paintProp = ["line-opacity", "circle-opacity", "fill-opacity"].find((p) => map.getPaintProperty(id, p) !== undefined);
      if (paintProp) map.setPaintProperty(id, paintProp, opacity);
    },
    moveLayer: (id, dir) => {
      const map = mapRef.current;
      if (!map || !map.getLayer(id)) return;
      const ids = map.getStyle().layers.map((l) => l.id).filter((i) => !i.startsWith("basemap"));
      const idx = ids.indexOf(id);
      if (idx === -1) return;
      const target = dir === "up" ? ids[idx + 1] : ids[idx - 1];
      if (target) map.moveLayer(id, target);
    },
    exportPng: (scale = 1, filename = "map-export.png") => {
      const map = mapRef.current;
      if (!map) return;
      const prev = map.getPixelRatio();
      map.setPixelRatio(Math.max(1, scale));
      try {
        // 等待一帧重绘后截图
        requestAnimationFrame(() => {
          const canvas = map.getCanvas();
          const url = canvas.toDataURL("image/png");
          const a = document.createElement("a");
          a.href = url;
          a.download = filename;
          a.click();
        });
      } finally {
        setTimeout(() => map.setPixelRatio(prev), 500);
      }
    },
  }), [applyStyle, project]);

  // 导入文件：GeoJSON 直传；SHP 用 shpjs 解析后上传
  const handleImportFiles = useCallback(async (files) => {
    if (!files || !files.length) return;
    setImporting(true);
    setMsg("解析中…");
    try {
      const geoFiles = [...files].filter((f) => /\.(geojson|json)$/i.test(f.name));
      const shpSet = [...files].filter((f) => /\.(shp|dbf|prj|cpg)$/i.test(f.name));
      if (geoFiles.length) {
        const f = geoFiles[0];
        const text = await f.text();
        const geojson = JSON.parse(text);
        const layerId = f.name.replace(/\.(geojson|json)$/i, "").replace(/[^\w-]/g, "_");
        const r = await mapImportLayer(project, layerId, geojson);
        setMsg(`已导入 ${layerId}（${geojson.features?.length || "?"} 要素，${r.tiles?.count || 0} 瓦片）`);
        onLayerTilesChanged?.();
      } else if (shpSet.length) {
        const shpFile = shpSet.find((f) => /\.shp$/i.test(f.name));
        if (!shpFile) { setMsg("缺少 .shp 文件"); setImporting(false); return; }
        const toBuf = async (f) => (f ? (await f.arrayBuffer()) : undefined);
        const geojson = await shp({
          shp: await toBuf(shpFile),
          dbf: await toBuf(shpSet.find((f) => /\.dbf$/i.test(f.name))),
          prj: await toBuf(shpSet.find((f) => /\.prj$/i.test(f.name))),
          cpg: await toBuf(shpSet.find((f) => /\.cpg$/i.test(f.name))),
        });
        const layerId = shpFile.name.replace(/\.shp$/i, "").replace(/[^\w-]/g, "_");
        const r = await mapImportLayer(project, layerId, geojson);
        setMsg(`已导入 ${layerId}（${geojson.features?.length || "?"} 要素，${r.tiles?.count || 0} 瓦片）`);
        onLayerTilesChanged?.();
      } else {
        setMsg("请选择 .geojson / .json，或 .shp+.dbf(+.prj) 文件");
      }
    } catch (e) {
      setMsg("导入失败: " + e.message);
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setTimeout(() => setMsg(""), 4000);
    }
  }, [project, onLayerTilesChanged]);

  return (
    <div className="map-viewer">
      <div ref={containerRef} className="map-canvas" />
      {!loaded && <div className="map-loading">地图加载中…</div>}

      {/* 顶部工具条 */}
      <div className="map-toolbar">
        <span className="map-toolbar-title">
          <Icon name="map" size={14} /> {config?.name || "地图"}
        </span>
        <label className="map-import-btn" title="导入 GeoJSON / SHP 矢量数据">
          <Icon name="upload" size={13} /> 导入
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".geojson,.json,.shp,.dbf,.prj,.cpg"
            style={{ display: "none" }}
            onChange={(e) => handleImportFiles(e.target.files)}
          />
        </label>
        <span className="map-msg">{msg}</span>
        {importing && <Icon name="loading" size={14} className="mp-spin" />}
      </div>

      {/* 左下状态栏 */}
      <div className="map-status">
        {cursor.lng !== null
          ? `经度 ${cursor.lng}  纬度 ${cursor.lat}  缩放 ${cursor.zoom}`
          : "浙江省交通地图 — 点击要素查看属性"}
      </div>
    </div>
  );
});

export default MapViewer;
