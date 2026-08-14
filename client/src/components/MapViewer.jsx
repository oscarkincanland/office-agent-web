import React, { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { Map as MapLibreMap, LngLatBounds, NavigationControl, ScaleControl, Popup } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import shp from "shpjs";
import Icon from "./Icon.jsx";
import { mapImportLayer } from "../api.js";

const STYLE_PATH = (project) => `/api/map/data/${project}/style.json`;

// 底图 id 清单（与 server/map.mjs BASEMAPS 对齐）
const BASEMAP_IDS = ["gaode-road", "gaode-sat", "gaode-sat-label"];
// 旧底图 id → 新底图 id（老项目 config 里可能存的是 carto/osm/dark/satellite）
const LEGACY_BASEMAP = { carto: "gaode-road", osm: "gaode-road", dark: "gaode-road", satellite: "gaode-sat" };
const normalizeBasemap = (id) => LEGACY_BASEMAP[id] || (BASEMAP_IDS.includes(id) ? id : "gaode-road");

/**
 * 地图主区（MapLibre GL）
 * - 加载 style.json（矢量瓦片图层 + 4 底图）
 * - 轮询 style.json 感知 agent 修改 → 热更新
 * - 点击要素弹窗、坐标状态栏
 * - 导出 PNG / 导入 GeoJSON+SHP（外部 ref API）
 */
const MapViewer = forwardRef(function MapViewer(
  { project = "zhejiang-map", config, onConfigChange, onLayerTilesChanged, onDrillDown },
  ref
) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const styleHashRef = useRef("");
  const popupEnabledRef = useRef(true); // 绘制/测量模式下禁用属性弹窗
  // 当前 style 中实际存在的底图图层 id（服务端按 Key 配置动态生成）
  const basemapIdsRef = useRef([...BASEMAP_IDS]);
  // 路网图层 id（下钻过滤目标：非边界 line 图层 + 标号 symbol 图层）
  const roadLayerIdsRef = useRef([]);
  const drillRef = useRef(null);
  const [loaded, setLoaded] = useState(false);
  const [basemap, setBasemap] = useState(() => normalizeBasemap(config?.basemap));
  const [cursor, setCursor] = useState({ lng: null, lat: null, zoom: null });
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState(""); // 轻提示
  const fileInputRef = useRef(null);
  const drawModeRef = useRef(false); // 绘制/选点模式中（抑制要素弹窗）
  const stopDrawRef = useRef(null); // 当前绘制会话的清理函数

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
    // 从 style 提取底图/路网图层 id（下钻过滤与底图切换用）
    const syncLayerRefs = (s) => {
      if (!s?.layers) return;
      const ids = s.layers
        .filter((l) => String(l.id).startsWith("basemap-"))
        .map((l) => String(l.id).slice("basemap-".length));
      if (ids.length) basemapIdsRef.current = ids;
      roadLayerIdsRef.current = s.layers
        .filter((l) => l.type === "line" && !["boundary-city", "boundary-county"].includes(l.id))
        .map((l) => l.id)
        .concat(
          s.layers.filter((l) => l.type === "symbol" && String(l.id).endsWith("-label")).map((l) => l.id)
        );
    };
    map.on("load", () => {
      setLoaded(true);
      // 立即同步图层列表（避免加载后第一时间下钻时 ref 为空）
      fetch(STYLE_PATH(project))
        .then((r) => r.json())
        .then(syncLayerRefs)
        .catch(() => {});
    });
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
      if (drawModeRef.current) return; // 绘制/选点模式：不弹要素
      if (!popupEnabledRef.current) return; // 绘制/测量模式下不弹属性窗
      const feats = map.queryRenderedFeatures(e.point, {});
      const pick = feats.find(
        (f) => f.layer && !f.layer.id.startsWith("basemap") && f.properties && Object.keys(f.properties).length
      );
      if (!pick) return;
      // 点击行政区划边界 → 触发下钻（市级/县区级）
      if (pick.layer.id === "boundary-city" || pick.layer.id === "boundary-county") {
        const p = pick.properties;
        const code = String(p.adcode ?? "");
        if (code) {
          onDrillDown?.({
            source: pick.layer.id,
            code,
            name: p.name || code,
            level: pick.layer.id === "boundary-city" ? "city" : "county",
          });
        }
      }
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
    // 记录 style 中实际存在的底图图层（服务端按 Key 配置动态生成）
    const ids = (style?.layers || [])
      .filter((l) => String(l.id).startsWith("basemap-"))
      .map((l) => String(l.id).slice("basemap-".length));
    if (ids.length) basemapIdsRef.current = ids;
    // 记录路网图层（下钻过滤目标）
    roadLayerIdsRef.current = (style?.layers || [])
      .filter((l) => l.type === "line" && !["boundary-city", "boundary-county"].includes(l.id))
      .map((l) => l.id)
      .concat(
        (style?.layers || [])
          .filter((l) => l.type === "symbol" && String(l.id).endsWith("-label"))
          .map((l) => l.id)
      );
    // 重放下钻状态（style 重载后恢复过滤与高亮；setStyle 异步，需等 style 渲染完成）
    if (drillRef.current) {
      const d = drillRef.current;
      const field = d.level === "city" ? "city_code" : "adcode";
      const restoreDrill = () => {
        const m = mapRef.current;
        if (!m || !drillRef.current) return;
        try { if (m.getLayer("drill-highlight")) m.removeLayer("drill-highlight"); } catch {}
        if (d.source && m.getSource(d.source)) {
          m.addLayer({
            id: "drill-highlight",
            type: "fill",
            source: d.source,
            "source-layer": d.source,
            filter: ["==", "adcode", d.code],
            paint: { "fill-color": "#ffd54f", "fill-opacity": 0.3 },
          });
        }
        for (const id of roadLayerIdsRef.current) {
          if (m.getLayer(id)) m.setFilter(id, ["in", field, d.code]);
        }
      };
      map.once("idle", restoreDrill);
      // 兜底：idle 若长时间不触发（无交互时不触发？MapLibre idle 在渲染稳定后触发）
      setTimeout(() => {
        if (drillRef.current && mapRef.current) restoreDrill();
      }, 1500);
    }
    // 重放底图
    setBasemap((prev) => {
      for (const id of basemapIdsRef.current) {
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
      for (const bid of basemapIdsRef.current) {
        if (map.getLayer(`basemap-${bid}`)) {
          map.setLayoutProperty(`basemap-${bid}`, "visibility", bid === id ? "visible" : "none");
        }
      }
      setBasemap(id);
    },
    /** 省市县下钻：高亮区域 + 按 adcode/city_code 过滤路网 */
    drillTo: (d) => {
      const map = mapRef.current;
      if (!map || !d?.code) return;
      try { if (map.getLayer("drill-highlight")) map.removeLayer("drill-highlight"); } catch {}
      const field = d.level === "city" ? "city_code" : "adcode";
      if (d.source && map.getSource(d.source)) {
        map.addLayer({
          id: "drill-highlight",
          type: "fill",
          source: d.source,
          "source-layer": d.source,
          filter: ["==", "adcode", d.code],
          paint: { "fill-color": "#ffd54f", "fill-opacity": 0.3 },
        });
      }
      for (const id of roadLayerIdsRef.current) {
        if (map.getLayer(id)) map.setFilter(id, ["in", field, d.code]);
      }
      drillRef.current = d;
    },
    /** 清除下钻 */
    clearDrill: () => {
      const map = mapRef.current;
      if (!map) return;
      try { if (map.getLayer("drill-highlight")) map.removeLayer("drill-highlight"); } catch {}
      for (const id of roadLayerIdsRef.current) {
        if (map.getLayer(id)) map.setFilter(id, null);
      }
      drillRef.current = null;
    },
    /** 绘制/测量模式：开关属性弹窗与光标 */
    setDrawingMode: (on) => {
      popupEnabledRef.current = !on;
      const map = mapRef.current;
      if (map) map.getCanvas().style.cursor = on ? "crosshair" : "";
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
    /** 样式编辑：运行时改 paint 属性（持久化由上层调 mapSaveStyle） */
    setLayerPaint: (id, key, value) => {
      const map = mapRef.current;
      if (!map || !map.getLayer(id)) return;
      try { map.setPaintProperty(id, key, value); } catch {}
    },
    /** 图层定位：fitBounds 到图层数据范围 */
    zoomToLayer: (id) => {
      const map = mapRef.current;
      if (!map) return;
      try {
        const src = map.getSource(id);
        if (!src || typeof src.getData !== "function") return;
        const fc = src.getData();
        const b = new LngLatBounds();
        const walk = (g) => {
          if (!g) return;
          if (g.type === "FeatureCollection") g.features.forEach((f) => walk(f.geometry));
          else if (g.type === "Feature") walk(g.geometry);
          else if (g.type === "Point") b.extend(g.coordinates);
          else if (g.type === "MultiPoint" || g.type === "LineString") g.coordinates.forEach((c) => b.extend(c));
          else if (g.type === "MultiLineString" || g.type === "Polygon") g.coordinates.flat().forEach((c) => b.extend(c));
          else if (g.type === "MultiPolygon") g.coordinates.flat(2).forEach((c) => b.extend(c));
        };
        walk(fc);
        if (!b.isEmpty()) map.fitBounds(b, { padding: 60, maxZoom: 14 });
      } catch {}
    },
    /** 拖拽排序：移动到指定图层上方 */
    moveLayerTo: (id, targetId) => {
      const map = mapRef.current;
      if (!map || !map.getLayer(id) || id === targetId) return;
      try { map.moveLayer(id, targetId); } catch {}
    },
    /** 等时圈显示：添加/更新 isochrones 面图层 */
    showIsochrones: (polygons) => {
      const map = mapRef.current;
      if (!map) return;
      const fc = { type: "FeatureCollection", features: (polygons || []).map((ring, i) => ({
        type: "Feature",
        properties: { idx: i, color: ["#f97316", "#f59e0b", "#84cc16", "#22c55e"][i % 4] },
        geometry: { type: "Polygon", coordinates: [ring] },
      })) };
      try {
        if (map.getSource("isochrones")) {
          map.getSource("isochrones").setData(fc);
        } else {
          map.addSource("isochrones", { type: "geojson", data: fc });
          map.addLayer({
            id: "isochrones",
            type: "fill",
            source: "isochrones",
            paint: { "fill-color": ["get", "color"], "fill-opacity": 0.25, "fill-outline-color": "#f97316" },
          });
        }
        map.fitBounds(new LngLatBounds().extend([[118.5, 28.0], [122.5, 31.5]]), { padding: 40 });
      } catch {}
    },
    clearIsochrones: () => {
      const map = mapRef.current;
      if (!map) return;
      try {
        if (map.getLayer("isochrones")) map.removeLayer("isochrones");
        if (map.getSource("isochrones")) map.removeSource("isochrones");
      } catch {}
    },
    /** 测量/绘制工具：startDraw(kind, { onDone, onUpdate })；双击完成，Esc 取消 */
    startDraw: (kind, handlers = {}) => {
      const map = mapRef.current;
      if (!map) return;
      stopDrawRef.current?.();
      const points = [];
      let srcId = "draw-layer";
      const ensureSource = () => {
        try {
          if (!map.getSource(srcId)) {
            map.addSource(srcId, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
            if (kind === "measure-polygon" || kind === "draw-point") {
              if (!map.getLayer("draw-fill")) {
                map.addLayer({ id: "draw-fill", type: "fill", source: srcId, paint: { "fill-color": "#f97316", "fill-opacity": 0.2 } });
              }
            }
            if (!map.getLayer("draw-line")) {
              map.addLayer({ id: "draw-line", type: "line", source: srcId, paint: { "line-color": "#f97316", "line-width": 2 } });
            }
            if (!map.getLayer("draw-dots")) {
              map.addLayer({ id: "draw-dots", type: "circle", source: srcId, paint: { "circle-color": "#f97316", "circle-radius": 4 } });
            }
          }
        } catch {}
      };
      const render = () => {
        ensureSource();
        const feats = [];
        if (kind === "draw-point" && points.length) {
          feats.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: points[0] } });
        } else if (kind === "measure-line") {
          if (points.length >= 2) feats.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: points } });
          if (points.length >= 1) feats.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: points[points.length - 1] } });
        } else {
          if (points.length >= 3) feats.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...points, points[0]]] } });
          feats.push(...points.map((c) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c } })));
        }
        try { map.getSource(srcId)?.setData({ type: "FeatureCollection", features: feats }); } catch {}
        handlers.onUpdate?.(points);
      };
      const onClick = (e) => {
        points.push([e.lngLat.lng, e.lngLat.lat]);
        render();
        if (kind === "draw-point") {
          handlers.onDone?.(points, { kind });
          stopDrawRef.current?.();
        }
      };
      const onDblClick = (e) => {
        e.preventDefault?.();
        if (points.length >= 2) {
          handlers.onDone?.(points, { kind });
          stopDrawRef.current?.();
        }
      };
      const onKey = (e) => {
        if (e.key === "Escape") stopDrawRef.current?.();
      };
      map.on("click", onClick);
      map.on("dblclick", onDblClick);
      map.on("keydown", onKey);
      drawModeRef.current = true;
      stopDrawRef.current = () => {
        map.off("click", onClick);
        map.off("dblclick", onDblClick);
        map.off("keydown", onKey);
        drawModeRef.current = false;
        stopDrawRef.current = null;
        try {
          if (map.getLayer("draw-fill")) map.removeLayer("draw-fill");
          if (map.getLayer("draw-line")) map.removeLayer("draw-line");
          if (map.getLayer("draw-dots")) map.removeLayer("draw-dots");
          if (map.getSource(srcId)) map.removeSource(srcId);
        } catch {}
      };
    },
    stopDraw: () => stopDrawRef.current?.(),
    /** 点击选点（等时圈起点）：pickLocation(onPick) */
    pickLocation: (onPick) => {
      const map = mapRef.current;
      if (!map) return;
      const onClick = (e) => {
        map.off("click", onClick);
        drawModeRef.current = false;
        onPick?.([e.lngLat.lng, e.lngLat.lat]);
      };
      map.on("click", onClick);
      drawModeRef.current = true;
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
          : "浙江省交通基础数据沙盘 — 点击要素查看属性"}
      </div>
    </div>
  );
});

export default MapViewer;
