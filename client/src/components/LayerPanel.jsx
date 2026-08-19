import React, { useState, useCallback, useMemo, useEffect, useRef } from "react";
import Icon from "./Icon.jsx";
import { mapGetLayer } from "../api.js";

const GROUP_ORDER = ["行政区划", "公路网", "设施点", "其他"];
const GROUP_FALLBACK = { boundary: "行政区划", road: "公路网", point: "设施点" };
const TYPE_NAMES = { boundary: "面", road: "线", point: "点" };
const DASH_PRESETS = [
  { label: "实线", value: null },
  { label: "虚线", value: [2, 1.2] },
  { label: "点线", value: [1, 0.5] },
  { label: "长虚线", value: [4, 2] },
];
const COLOR_PAINT_KEYS = {
  line: ["line-color", "line-width", "line-opacity", "line-dasharray"],
  circle: ["circle-color", "circle-radius", "circle-opacity", "circle-stroke-color", "circle-stroke-width"],
  fill: ["fill-color", "fill-opacity", "fill-outline-color"],
};

/** 按字段渲染调色板 */
const PALETTES = [
  ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b", "#e377c2", "#7f7f7f"],
  ["#4e79a7", "#f28e2b", "#59a14f", "#e15759", "#b07aa1", "#76b7b2", "#edc948", "#ff9da7"],
  ["#e4572e", "#17bebb", "#ffc914", "#2e282a", "#76b041", "#8b5e34"],
  ["#004c6d", "#346888", "#5d8ba6", "#8abeb7", "#c8e0d8"],
];

/** 从图层 paint 属性推断 SVG 图例符号 */
function LegendSymbol({ styleType, paint, color }) {
  const c = color || "#8abeb7";
  if (styleType === "circle") {
    const r = typeof paint?.["circle-radius"] === "number" ? paint["circle-radius"] : 4;
    return (
      <svg width="18" height="14" viewBox="0 0 18 14">
        <circle cx="9" cy="7" r={Math.min(6, r)} fill={paint?.["circle-color"] || c} stroke={paint?.["circle-stroke-color"] || "#fff"} strokeWidth={paint?.["circle-stroke-width"] ?? 1} />
      </svg>
    );
  }
  if (styleType === "fill") {
    return (
      <svg width="18" height="14" viewBox="0 0 18 14">
        <rect x="2" y="2" width="14" height="10" rx="1" fill={paint?.["fill-color"] || c} fillOpacity={paint?.["fill-opacity"] ?? 0.5} stroke={paint?.["fill-outline-color"] || c} strokeWidth="1" />
      </svg>
    );
  }
  return (
    <svg width="18" height="14" viewBox="0 0 18 14">
      <line x1="1" y1="7" x2="17" y2="7" stroke={paint?.["line-color"] || c} strokeWidth={typeof paint?.["line-width"] === "number" ? Math.min(6, Math.max(1, paint["line-width"])) : 2} strokeDasharray={paint?.["line-dasharray"]?.join(" ") || undefined} strokeLinecap="round" />
    </svg>
  );
}

/**
 * QGIS 风格图层面板：分组折叠 / 拖拽排序 / 符号缩略图 / 右键菜单 / 样式编辑器 / 图例
 */
export default function LayerPanel({
  project, cfg, style, files, selected, onSelect,
  onToggleLayer, onSetPaint, onSetOpacity, onMoveLayerTo,
  onRenameLayer, onDuplicateLayer, onDeleteLayer, onZoomToLayer, onOpenAttribute,
  onSetLayout,
  onSetLabel,
}) {
  const [collapsed, setCollapsed] = useState({});          // 组折叠
  const [expanded, setExpanded] = useState({});            // 图层图例展开
  const [dragId, setDragId] = useState(null);
  const [ctx, setCtx] = useState(null);                    // 右键菜单 {x,y,layerId}
  const [editing, setEditing] = useState(null);            // 重命名 {layerId, name}
  const [legend, setLegend] = useState({});                // {layerId: {count, fields}}
  const [fieldData, setFieldData] = useState(null);        // {layerId, fields, numFields, props}
  const [renderMode, setRenderMode] = useState(null);      // {layerId, mode, field, palette, classes}
  const panelRef = useRef(null);

  // ---- 分组：组内图层按 style.layers 顺序（视觉逆序=顶部最上层） ----
  const groups = useMemo(() => {
    const styleOrder = new Map((style?.layers || []).map((l, i) => [l.id, i]));
    const map = new Map();
    for (const meta of cfg?.layers || []) {
      const g = meta.group || GROUP_FALLBACK[meta.type] || "其他";
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(meta.id);
    }
    for (const ids of map.values()) {
      ids.sort((a, b) => (styleOrder.get(b) ?? 0) - (styleOrder.get(a) ?? 0)); // 顶部=最上层
    }
    return [...map.entries()].sort(
      (a, b) => (GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0])) || a[0].localeCompare(b[0])
    );
  }, [cfg, style]);

  // ---- 组显隐（组内所有图层） ----
  const groupAllVisible = useCallback((ids) => ids.every((id) => {
    const l = style?.layers?.find((x) => x.id === id);
    return !l || l.layout?.visibility !== "none";
  }), [style]);

  const toggleGroup = useCallback((ids) => {
    const target = !groupAllVisible(ids);
    ids.forEach((id) => {
      const l = style?.layers?.find((x) => x.id === id);
      if (l) onToggleLayer(id, target);
    });
  }, [style, groupAllVisible, onToggleLayer]);

  // ---- 右键菜单 ----
  const openCtx = useCallback((e, layerId) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = panelRef.current?.getBoundingClientRect();
    setCtx({ x: e.clientX - (rect?.left || 0), y: e.clientY - (rect?.top || 0), layerId });
  }, []);

  useEffect(() => {
    if (!ctx) return undefined;
    const close = () => setCtx(null);
    document.addEventListener("click", close);
    document.addEventListener("contextmenu", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("contextmenu", close);
    };
  }, [ctx]);

  const ctxAction = useCallback((fn) => (...args) => { setCtx(null); fn(...args); }, []);

  // ---- 按字段渲染：选中图层时加载属性字段 ----
  useEffect(() => {
    if (!selected) { setFieldData(null); setRenderMode(null); return undefined; }
    let alive = true;
    mapGetLayer(project, selected).then((g) => {
      if (!alive || !g?.features?.length) return;
      const props = g.features.map((f) => f.properties || {});
      const fields = Object.keys(props[0] || {});
      const numFields = fields.filter((f) => props.some((p) => typeof p[f] === "number"));
      if (alive) setFieldData({ layerId: selected, fields, numFields, props });
    }).catch(() => {});
    return () => { alive = false; };
  }, [selected, project]);

  // ---- 图例数据（展开时读取 geojson 统计） ----
  const toggleLegend = useCallback(async (layerId) => {
    setExpanded((prev) => ({ ...prev, [layerId]: !prev[layerId] }));
    if (!legend[layerId]) {
      try {
        const g = await mapGetLayer(project, layerId);
        if (g?.features) {
          const fields = Object.keys(g.features[0]?.properties || {}).slice(0, 12);
          setLegend((prev) => ({ ...prev, [layerId]: { count: g.features.length, fields } }));
        }
      } catch { /* 忽略 */ }
    }
  }, [project, legend]);

  const layerPaint = useCallback((id) => style?.layers?.find((x) => x.id === id)?.paint || {}, [style]);
  const layerStyleType = useCallback((id) => style?.layers?.find((x) => x.id === id)?.type || "line", [style]);
  const relatedLayers = useCallback((id) => {
    const layers = style?.layers || [];
    // 标签开关只控制标签本身；业务图层开关则同时控制同名 source
    // 以及由该图层派生的样式/标签层。
    if (id.endsWith("-label")) return layers.filter((x) => x.id === id);
    return layers.filter((x) => (
      x.id === id
      || x.source === id
      || x.id.startsWith(`${id}-`)
    ));
  }, [style]);
  const layerVisible = useCallback((id) => {
    const layers = relatedLayers(id);
    return !layers.length || layers.some((x) => x.layout?.visibility !== "none");
  }, [relatedLayers]);

  // ---- 拖拽 ----
  const handleDrop = useCallback((targetId) => {
    if (dragId && dragId !== targetId) onMoveLayerTo(dragId, targetId);
    setDragId(null);
  }, [dragId, onMoveLayerTo]);

  // ---- 样式编辑器（选中图层） ----
  const selectedMeta = cfg?.layers?.find((l) => l.id === selected);
  const selectedPaint = selected ? layerPaint(selected) : {};
  const selectedStyleType = selected ? layerStyleType(selected) : null;
  const paintKeys = selectedStyleType ? (COLOR_PAINT_KEYS[selectedStyleType] || []) : [];

  const setPaint = (key, value) => { if (selected) onSetPaint(selected, key, value); };
  const paintColor = paintKeys.includes("line-color") ? selectedPaint["line-color"]
    : paintKeys.includes("fill-color") ? selectedPaint["fill-color"]
    : paintKeys.includes("circle-color") ? selectedPaint["circle-color"]
    : null;
  const strokeColor = paintKeys.includes("circle-stroke-color") ? selectedPaint["circle-stroke-color"] : null;
  const outlineColor = paintKeys.includes("fill-outline-color") ? selectedPaint["fill-outline-color"] : null;
  const dash = selectedPaint["line-dasharray"] ? selectedPaint["line-dasharray"].join(",") : "null";

  const colorRow = (label, key, value) => (
    <div className="lp-ed-row" key={key}>
      <span className="lp-ed-label">{label}</span>
      <input type="color" className="lp-ed-color" value={normalizeHex(value)} onChange={(e) => setPaint(key, e.target.value)} />
      <code className="lp-ed-hex">{typeof value === "string" ? value : "表达式"}</code>
    </div>
  );

  // ---- 标注渲染（{layerId}-label symbol 层） ----
  const labelLayer = selected ? style?.layers?.find((l) => l.id === selected + "-label") : null;
  const [labelField, setLabelField] = useState(labelLayer?.layout?.["text-field"]?.[1] || "name");
  const [labelSize, setLabelSize] = useState(labelLayer?.layout?.["text-size"] || 13);
  const [labelColor, setLabelColor] = useState(labelLayer?.paint?.["text-color"] || "#2d3142");
  const labelOn = !!labelLayer;
  const labelFields = fieldData?.layerId === selected ? fieldData.fields : ["name", "ref", "title", "label"];
  const applyLabel = (on, field = labelField, size = labelSize, color = labelColor) => {
    onSetLabel?.(selected, on ? { field, size, color } : null);
  };

  // ---- 按字段渲染：应用/恢复 ----
  const colorKey = paintKeys.find((k) => k === "line-color" || k === "fill-color" || k === "circle-color") || null;
  const rm = renderMode?.layerId === selected ? renderMode : null;
  const uniqueValues = useMemo(() => {
    if (!fieldData || !rm || rm.mode !== "categorized" || !rm.field) return [];
    return [...new Set(fieldData.props.map((p) => String(p[rm.field] ?? "")).filter((v) => v !== ""))].slice(0, 8);
  }, [fieldData, rm]);

  const applyFieldRender = useCallback((mode, field, paletteIdx, classes = 5) => {
    if (!colorKey || !fieldData || !selected) return;
    const props = fieldData.props;
    if (mode === "categorized") {
      const uniq = [...new Set(props.map((p) => String(p[field] ?? "")).filter((v) => v !== ""))].slice(0, 8);
      if (!uniq.length) return;
      const expr = ["match", ["get", field]];
      uniq.forEach((v, i) => expr.push(v, PALETTES[paletteIdx][i % PALETTES[paletteIdx].length]));
      expr.push("#9e9e9e");
      setPaint(colorKey, expr);
      setRenderMode({ layerId: selected, mode, field, palette: paletteIdx, classes: uniq });
    } else if (mode === "graduated") {
      const nums = props.map((p) => Number(p[field])).filter((v) => Number.isFinite(v));
      if (nums.length < 2) return;
      const min = Math.min(...nums);
      const max = Math.max(...nums);
      const n = Math.max(3, Math.min(6, classes));
      const step = (max - min) / n;
      const colors = PALETTES[paletteIdx];
      const expr = ["step", ["get", field], colors[0]];
      for (let i = 1; i < n; i++) expr.push(Number((min + step * i).toFixed(4)), colors[i % colors.length]);
      setPaint(colorKey, expr);
      setRenderMode({ layerId: selected, mode, field, palette: paletteIdx, classes: n, min, max, step });
    }
  }, [colorKey, fieldData, selected, setPaint]);

  const resetFieldRender = useCallback(() => {
    if (!colorKey) return;
    const defs = { line: "#d62728", fill: "#8abeb7", circle: "#9467bd" };
    setPaint(colorKey, defs[selectedStyleType] || "#8abeb7");
    setRenderMode({ layerId: selected, mode: "single", field: null, palette: 0 });
  }, [colorKey, selected, selectedStyleType, setPaint]);

  return (
    <div className="lp" ref={panelRef}>
      <div className="lp-list">
        {groups.length === 0 && <div className="mp-empty">暂无图层，点地图右上角「导入」添加 GeoJSON / SHP</div>}
        {groups.map(([gname, ids]) => {
          const isCollapsed = !!collapsed[gname];
          const gVisible = groupAllVisible(ids);
          return (
            <div key={gname} className="lp-group">
              <div className="lp-group-head" onClick={() => setCollapsed((p) => ({ ...p, [gname]: !p[gname] }))}>
                <span className="lp-caret">{isCollapsed ? <Icon name="chevronRight" size={10} /> : <Icon name="chevronDown" size={10} />}</span>
                <label className="lp-eye" onClick={(e) => e.stopPropagation()} title={gVisible ? "隐藏整组" : "显示整组"}>
                  <input type="checkbox" checked={gVisible} onChange={() => toggleGroup(ids)} />
                </label>
                <span className="lp-group-name">{gname}</span>
                <span className="lp-group-count">{ids.length}</span>
              </div>
              {!isCollapsed && (
                <div className="lp-group-body">
                  {ids.map((id) => {
                    const meta = cfg?.layers?.find((l) => l.id === id);
                    const paint = layerPaint(id);
                    const stype = layerStyleType(id);
                    const vis = layerVisible(id);
                    const isSelected = selected === id;
                    const isDrag = dragId === id;
                    return (
                      <div
                        key={id}
                        className={`lp-row ${isSelected ? "active" : ""} ${isDrag ? "dragging" : ""}`}
                        draggable
                        onClick={() => onSelect(id)}
                        onContextMenu={(e) => openCtx(e, id)}
                        onDragStart={(e) => { setDragId(id); e.dataTransfer.effectAllowed = "move"; }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => { e.preventDefault(); handleDrop(id); }}
                        onDragEnd={() => setDragId(null)}
                      >
                        <label className="lp-eye" onClick={(e) => e.stopPropagation()} title={vis ? "隐藏" : "显示"}>
                          <input type="checkbox" checked={vis} onChange={() => onToggleLayer(id)} />
                        </label>
                        <span className="lp-symbol"><LegendSymbol styleType={stype} paint={paint} /></span>
                        {editing?.layerId === id ? (
                          <input
                            className="lp-rename-input"
                            autoFocus
                            defaultValue={editing.name}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={(e) => { onRenameLayer(id, e.target.value.trim() || meta?.name || id); setEditing(null); }}
                            onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setEditing(null); }}
                          />
                        ) : (
                          <span className="lp-row-name" title={id} onDoubleClick={(e) => { e.stopPropagation(); setEditing({ layerId: id, name: meta?.name || id }); }}>
                            {meta?.name || id}
                            <span className="lp-row-type">{TYPE_NAMES[meta?.type] || meta?.type || "?"}</span>
                          </span>
                        )}
                        <button
                          className={`lp-caret-btn ${expanded[id] ? "open" : ""}`}
                          title="图例 / 信息"
                          onClick={(e) => { e.stopPropagation(); toggleLegend(id); }}
                        >
                          <Icon name="chevronDown" size={10} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 图层图例信息 */}
      {Object.entries(expanded).map(([id, open]) => {
        if (!open) return null;
        const meta = cfg?.layers?.find((l) => l.id === id);
        const paint = layerPaint(id);
        const stype = layerStyleType(id);
        const data = legend[id];
        return (
          <div key={`legend-${id}`} className="lp-legend">
            <div className="lp-legend-head">
              <LegendSymbol styleType={stype} paint={paint} />
              <span className="lp-legend-title">{meta?.name || id} 图例</span>
              <button className="lp-op" onClick={() => onZoomToLayer(id)} title="缩放到图层"><Icon name="locate" size={11} /></button>
            </div>
            <div className="lp-legend-body">
              {data ? (
                <>
                  <div className="lp-legend-row">要素数：{data.count}</div>
                  <div className="lp-legend-row">字段：{data.fields.length ? data.fields.join("、") : "（无属性字段）"}</div>
                  <div className="lp-legend-row">样式：{styleSummary(stype, paint)}</div>
                </>
              ) : (
                <div className="lp-legend-row lp-legend-loading">加载中…</div>
              )}
            </div>
          </div>
        );
      })}

      {/* 右键菜单 */}
      {ctx && (
        <div className="lp-ctx" style={{ left: ctx.x, top: ctx.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={ctxAction(() => onOpenAttribute(ctx.layerId))}><Icon name="list" size={12} /> 属性表</button>
          <button onClick={ctxAction(() => onZoomToLayer(ctx.layerId))}><Icon name="locate" size={12} /> 缩放到图层</button>
          <button onClick={ctxAction(() => setEditing({ layerId: ctx.layerId, name: cfg?.layers?.find((l) => l.id === ctx.layerId)?.name || ctx.layerId }))}>
            <Icon name="penTool" size={12} /> 重命名
          </button>
          <button onClick={ctxAction(() => onDuplicateLayer(ctx.layerId))}><Icon name="copy" size={12} /> 复制图层</button>
          <div className="lp-ctx-sep" />
          <button className="danger" onClick={ctxAction(() => onDeleteLayer(ctx.layerId))}><Icon name="trash" size={12} /> 删除图层</button>
        </div>
      )}

      {/* 样式编辑器（选中图层） */}
      {selected && selectedMeta && (
        <div className="lp-editor">
          <div className="lp-editor-head">
            <LegendSymbol styleType={selectedStyleType} paint={selectedPaint} />
            <span className="lp-editor-title">{selectedMeta.name || selected} 样式</span>
            <span className="lp-editor-id">{selected}</span>
          </div>
          <div className="lp-editor-body">
            {paintKeys.length === 0 && <div className="lp-ed-hint">该图层暂无可用样式属性</div>}
            {paintColor && colorRow("颜色", paintKeys.find((k) => k === "line-color" || k === "fill-color" || k === "circle-color"), paintColor)}
            {strokeColor && colorRow("描边色", "circle-stroke-color", strokeColor)}
            {outlineColor && colorRow("边框色", "fill-outline-color", outlineColor)}
            {paintKeys.includes("line-width") && (
              <div className="lp-ed-row">
                <span className="lp-ed-label">线宽</span>
                <input type="range" min="0.5" max="8" step="0.5" value={typeof selectedPaint["line-width"] === "number" ? selectedPaint["line-width"] : 2}
                  onChange={(e) => setPaint("line-width", Number(e.target.value))} />
                <span className="lp-ed-val">{typeof selectedPaint["line-width"] === "number" ? selectedPaint["line-width"] : "自动"}</span>
              </div>
            )}
            {paintKeys.includes("circle-radius") && (
              <div className="lp-ed-row">
                <span className="lp-ed-label">半径</span>
                <input type="range" min="2" max="14" step="1" value={typeof selectedPaint["circle-radius"] === "number" ? selectedPaint["circle-radius"] : 5}
                  onChange={(e) => setPaint("circle-radius", Number(e.target.value))} />
                <span className="lp-ed-val">{selectedPaint["circle-radius"] ?? 5}</span>
              </div>
            )}
            {paintKeys.includes("circle-stroke-width") && (
              <div className="lp-ed-row">
                <span className="lp-ed-label">描边宽</span>
                <input type="range" min="0" max="5" step="0.5" value={selectedPaint["circle-stroke-width"] ?? 1}
                  onChange={(e) => setPaint("circle-stroke-width", Number(e.target.value))} />
                <span className="lp-ed-val">{selectedPaint["circle-stroke-width"] ?? 1}</span>
              </div>
            )}
            {paintKeys.includes("line-opacity") && (
              <div className="lp-ed-row">
                <span className="lp-ed-label">透明度</span>
                <input type="range" min="0" max="1" step="0.05" value={selectedPaint["line-opacity"] ?? 1}
                  onChange={(e) => setPaint("line-opacity", Number(e.target.value))} />
                <span className="lp-ed-val">{Math.round((selectedPaint["line-opacity"] ?? 1) * 100)}%</span>
              </div>
            )}
            {paintKeys.includes("fill-opacity") && (
              <div className="lp-ed-row">
                <span className="lp-ed-label">透明度</span>
                <input type="range" min="0" max="1" step="0.05" value={selectedPaint["fill-opacity"] ?? 1}
                  onChange={(e) => setPaint("fill-opacity", Number(e.target.value))} />
                <span className="lp-ed-val">{Math.round((selectedPaint["fill-opacity"] ?? 1) * 100)}%</span>
              </div>
            )}
            {paintKeys.includes("line-dasharray") && (
              <div className="lp-ed-row">
                <span className="lp-ed-label">线型</span>
                <select className="lp-ed-select" value={dash} onChange={(e) => setPaint("line-dasharray", e.target.value === "null" ? null : e.target.value.split(",").map(Number))}>
                  {DASH_PRESETS.map((p) => (
                    <option key={p.label} value={p.value ? p.value.join(",") : "null"}>{p.label}</option>
                  ))}
                </select>
              </div>
            )}
            {selectedStyleType === "road" && (() => {
              const labelLyr = style?.layers?.find((x) => x.id === `${selected}-label`);
              const tf = labelLyr?.layout?.["text-field"];
              const labelField = Array.isArray(tf) && tf[1]?.[1] ? tf[1][1] : "__auto__";
              const setLabelField = (v) => {
                if (!onSetLayout) return;
                if (v === "__auto__") {
                  onSetLayout(`${selected}-label`, "text-field", ["coalesce", ["get", "ref"], ["get", "name"], ""]);
                } else {
                  onSetLayout(`${selected}-label`, "text-field", ["coalesce", ["get", v], ["get", "name"], ""]);
                }
              };
              return (
                <>
                  <div className="lp-ed-row">
                    <span className="lp-ed-label">标号（编号/名称）</span>
                    <input
                      type="checkbox"
                      checked={layerVisible(`${selected}-label`)}
                      onChange={(e) => onToggleLayer(`${selected}-label`)}
                      title="沿道路线显示标号文字"
                    />
                    <span className="lp-ed-val">{layerVisible(`${selected}-label`) ? "显示" : "隐藏"}</span>
                  </div>
                  <div className="lp-ed-row">
                    <span className="lp-ed-label">标号字段</span>
                    <select
                      className="lp-ed-select lp-ed-field"
                      value={labelField}
                      onChange={(e) => setLabelField(e.target.value)}
                      title="选择显示哪个字段作为标号（默认编号优先、名称回退）"
                    >
                      <option value="__auto__">自动（编号→名称）</option>
                      <option value="ref">ref（编号）</option>
                      <option value="name">name（名称）</option>
                      {fieldData?.layerId === selected &&
                        fieldData.fields.filter((f) => f !== "ref" && f !== "name").map((f) => (
                          <option key={f} value={f}>{f}</option>
                        ))}
                    </select>
                  </div>
                </>
              );
            })()}
            {/* 按字段渲染（分类/分级着色） */}
            {colorKey && fieldData && fieldData.layerId === selected && (
              <div className="lp-ed-sec">
                <div className="lp-ed-sec-title">按字段渲染</div>
                <div className="lp-ed-row">
                  <span className="lp-ed-label">模式</span>
                  <select
                    className="lp-ed-select"
                    value={rm?.mode || "single"}
                    onChange={(e) => {
                      const m = e.target.value;
                      if (m === "single") resetFieldRender();
                      else {
                        const field = m === "graduated" ? (fieldData.numFields[0] || fieldData.fields[0]) : fieldData.fields[0];
                        setRenderMode({ layerId: selected, mode: m, field, palette: 0, classes: m === "graduated" ? 5 : null });
                      }
                    }}
                  >
                    <option value="single">单一颜色</option>
                    <option value="categorized">按字段分类</option>
                    <option value="graduated">按数值分级</option>
                  </select>
                </div>
                {rm && rm.mode !== "single" && (
                  <>
                    <div className="lp-ed-row">
                      <span className="lp-ed-label">字段</span>
                      <select
                        className="lp-ed-select lp-ed-field"
                        value={rm.field || ""}
                        onChange={(e) => setRenderMode((s) => ({ ...s, field: e.target.value }))}
                      >
                        {rm.mode === "graduated"
                          ? fieldData.numFields.map((f) => <option key={f} value={f}>{f}</option>)
                          : fieldData.fields.map((f) => <option key={f} value={f}>{f}</option>)}
                        {rm.mode === "graduated" && fieldData.numFields.length === 0 && <option value="">（无数值字段）</option>}
                      </select>
                    </div>
                    <div className="lp-ed-row">
                      <span className="lp-ed-label">调色板</span>
                      <div className="lp-palettes">
                        {PALETTES.map((pal, i) => (
                          <button
                            key={i}
                            className={`lp-palette ${rm.palette === i ? "active" : ""}`}
                            onClick={() => setRenderMode((s) => ({ ...s, palette: i }))}
                            title={`调色板 ${i + 1}`}
                          >
                            {pal.slice(0, 6).map((c) => <i key={c} style={{ background: c }} />)}
                          </button>
                        ))}
                      </div>
                    </div>
                    {rm.mode === "graduated" && (
                      <div className="lp-ed-row">
                        <span className="lp-ed-label">级数</span>
                        <select
                          className="lp-ed-select"
                          value={rm.classes || 5}
                          onChange={(e) => setRenderMode((s) => ({ ...s, classes: Number(e.target.value) }))}
                        >
                          {[3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} 级</option>)}
                        </select>
                      </div>
                    )}
                    {/* 图例预览 */}
                    <div className="lp-legend-preview">
                      {rm.mode === "categorized" && uniqueValues.map((v, i) => (
                        <div className="lp-legend-item" key={v}>
                          <i style={{ background: PALETTES[rm.palette][i % PALETTES[rm.palette].length] }} />
                          <span>{v}</span>
                        </div>
                      ))}
                      {rm.mode === "graduated" && rm.step && Array.from({ length: rm.classes }, (_, i) => (
                        <div className="lp-legend-item" key={i}>
                          <i style={{ background: PALETTES[rm.palette][i % PALETTES[rm.palette].length] }} />
                          <span>{fmtNum(rm.min + rm.step * i)} ~ {fmtNum(rm.min + rm.step * (i + 1))}</span>
                        </div>
                      ))}
                      {rm.mode === "categorized" && <div className="lp-legend-item"><i style={{ background: "#9e9e9e" }} /><span>其他</span></div>}
                    </div>
                    <div className="lp-ed-row lp-ed-actions">
                      <button className="btn-sm primary" onClick={() => applyFieldRender(rm.mode, rm.field, rm.palette, rm.classes)}>应用</button>
                      <button className="btn-sm" onClick={resetFieldRender}>恢复单一颜色</button>
                    </div>
                  </>
                )}
              </div>
            )}
            {/* 标注渲染 */}
            {selected && (
              <div className="lp-ed-sec">
                <div className="lp-ed-sec-title">标注</div>
                <div className="lp-ed-row">
                  <span className="lp-ed-label">显示</span>
                  <input
                    type="checkbox"
                    checked={labelOn}
                    onChange={(e) => applyLabel(e.target.checked)}
                  />
                  {labelOn && (
                    <button className="btn-xs" onClick={() => applyLabel(false)} title="移除标注层">移除</button>
                  )}
                </div>
                {labelOn && (
                  <>
                    <div className="lp-ed-row">
                      <span className="lp-ed-label">字段</span>
                      <select
                        className="lp-ed-select lp-ed-field"
                        value={labelField}
                        onChange={(e) => { setLabelField(e.target.value); applyLabel(true, e.target.value); }}
                      >
                        {labelFields.map((f) => <option key={f} value={f}>{f}</option>)}
                      </select>
                    </div>
                    <div className="lp-ed-row">
                      <span className="lp-ed-label">字号</span>
                      <input
                        type="range" min="9" max="22" step="1"
                        value={labelSize}
                        onChange={(e) => { setLabelSize(Number(e.target.value)); applyLabel(true, labelField, Number(e.target.value)); }}
                      />
                      <span className="lp-ed-val">{labelSize}</span>
                    </div>
                    <div className="lp-ed-row">
                      <span className="lp-ed-label">颜色</span>
                      <input
                        type="color"
                        className="lp-ed-color"
                        value={normalizeHex(labelColor)}
                        onChange={(e) => { setLabelColor(e.target.value); applyLabel(true, labelField, labelSize, e.target.value); }}
                      />
                      <code className="lp-ed-hex">{labelColor}</code>
                    </div>
                  </>
                )}
              </div>
            )}
            <div className="lp-ed-note">样式保存到 style.json，agent 与地图实时同步</div>
          </div>
        </div>
      )}
    </div>
  );
}

/** paint 值可能是表达式（如 interpolate），只取纯值 */
function normalizeHex(v) {
  if (typeof v !== "string" || !/^#[0-9a-fA-F]{3,8}$/.test(v)) return "#8abeb7";
  return v;
}

function fmtNum(v) {
  return Math.abs(v) >= 10000 ? Math.round(v).toLocaleString() : Number(v.toFixed(2));
}

function styleSummary(stype, paint) {
  const parts = [];
  if (stype === "line") parts.push(`颜色 ${paint["line-color"] || "默认"}`, `线宽 ${paint["line-width"] ?? 2}`, `透明度 ${Math.round((paint["line-opacity"] ?? 1) * 100)}%`);
  if (stype === "circle") parts.push(`颜色 ${paint["circle-color"] || "默认"}`, `半径 ${paint["circle-radius"] ?? 5}`);
  if (stype === "fill") parts.push(`填充 ${paint["fill-color"] || "默认"}`, `透明度 ${Math.round((paint["fill-opacity"] ?? 1) * 100)}%`);
  return parts.join(" · ");
}
