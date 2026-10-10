import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon.jsx";
import { mapVisual, mapVisualSources, mapDemoAnalysis } from "../api.js";

/**
 * 可视面板（阶段 2 §2.2）
 *
 * 替代原先六个分析面板（M2 宏观 4 tab / M3 公交 4 tab / 柬埔寨 OD / 示例数据菜单）：
 * 它们各自一套数据形状、一套渲染逻辑；这里统一为「数据集 + 类型 + 阈值」三参数，
 * 底层走 `GET /api/map/visual` 的统一描述符（阶段 2.1 / 阶段 5）。
 *
 * 两种用法：
 *   1. 自然语言（默认）：把一句话交给对话栏的 Agent，由它调 map_analyze / map_visualize。
 *   2. 高级（折叠）：不用自然语言时直接选参数，就地出图。
 *
 * 面板只做三件事：选数据 → 出图（临时层）→ 管理结果（显隐 / 清除 / 保存）。
 * 图层树里的正式图层管理仍归左栏（分工见阶段 4 §4.5）。
 */

/** 内置数据集选项：来自既有端点 + 适配器（阶段 5），收敛原面板的 tab */
const DATASETS = [
  { id: "demo-analysis", label: "演示分析（浙江）", kinds: [["heatmap", "点位热力图"], ["flow", "OD 出行"], ["isochrone", "可达性等时圈"]], needRegion: true },
  { id: "m2-traffic-bandwidth", label: "M2 · 高速流量带宽", kinds: [["flow", "流量带宽"]] },
  { id: "m2-od-lines", label: "M2 · 市—县 OD", kinds: [["flow", "OD 期望线"]] },
  { id: "bundled-xinchang", label: "新昌公交（内置）", kinds: [["stations", "站点客流"], ["routes", "公交线路"], ["od", "公交 OD"], ["stats", "线网统计"]] },
  { id: "cambodia-od", label: "暹粒 OD 演示", kinds: [["flow", "OD 流向"]], needThreshold: true },
  { id: "local-file", label: "工作区数据文件（CSV / GeoJSON）", kinds: [], needPath: true, auto: true },
];

const REGIONS = ["义乌市", "金华市", "杭州市", "新昌县", "台州市", "玉环市"];

/**
 * 地图渲染重试：Agent 事件与手动出图都会遇到"地图 style 还没就绪"的瞬时状态
 * （MapPanel.handleMapAction 用的是同一套做法）。这里抽成一个小工具，
 * 避免"点了生成但地图上什么都没有"。
 */
function renderWithRetry(render, { attempts = 12, intervalMs = 250 } = {}) {
  return new Promise((resolve) => {
    let tries = 0;
    const tick = () => {
      tries += 1;
      let ok = false;
      try {
        // 只认真值：mapRef 尚未挂载时 show* 返回 undefined，
        // 若按 `!== false` 判定会被当成"渲染成功"，卡片显示"已生成"但地图空白。
        ok = render() === true;
      } catch { ok = false; }
      if (ok || tries >= attempts) { clearInterval(timer); resolve(ok); }
    };
    const timer = setInterval(tick, intervalMs);
    tick();
  });
}

export default function 可视面板({
  project = "zhejiang-map",
  workspace = "",
  mapRef,
  conversationMode = "chat",
  onSaveAnalysis,
  onAskAgent,
  onClose,
  onResultChange,
}) {
  const [dataset, setDataset] = useState("demo-analysis");
  const [kind, setKind] = useState("heatmap");
  const [region, setRegion] = useState("义乌市");
  const [threshold, setThreshold] = useState(0);
  const [filePath, setFilePath] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [descriptor, setDescriptor] = useState(null);
  const [visible, setVisible] = useState(true);
  const [sources, setSources] = useState([]);
  const [askText, setAskText] = useState("");
  const renderedIdRef = useRef(null);

  const current = useMemo(() => DATASETS.find((d) => d.id === dataset) || DATASETS[0], [dataset]);

  // 数据源发现（适配器清单）：让"未来接入的数据"自动出现在下拉里，不改本文件。
  useEffect(() => {
    let alive = true;
    mapVisualSources()
      .then((r) => { if (alive) setSources(Array.isArray(r.sources) ? r.sources : []); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // 切换数据集时把类型收敛到该数据集的第一个合法值
  useEffect(() => {
    const kinds = current.kinds || [];
    if (kinds.length && !kinds.some(([k]) => k === kind)) setKind(kinds[0][0]);
    if (!kinds.length && current.id === "demo-analysis") setKind("heatmap");
  }, [current, kind]);

  const options = useMemo(() => {
    // 内置数据集 + 适配器里"能直接出图"的源（local-file 单独走文件路径输入）
    const builtin = DATASETS.map((d) => ({ value: d.id, label: d.label }));
    const extra = sources
      .filter((s) => !DATASETS.some((d) => d.id === s.id))
      .map((s) => ({ value: s.id, label: `${s.label}（数据源）` }));
    return [...builtin, ...extra];
  }, [sources]);

  /**
   * 出图：拉描述符 → 交给地图渲染（临时层，不落盘）。
   * 渲染前先清上一次的结果（否则连续生成两个数据集会叠加残留）；
   * 线类描述符（M2 流量、公交线路）的主几何就是 LineString，
   * showAnalysisRich 只认 Point/Polygon，必须把它当 lines 传进去才画得出来。
   */
  const run = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const descriptorResult = await mapVisual({
        dataset,
        kind,
        project,
        workspace,
        region: current.needRegion ? region : undefined,
        threshold: current.needThreshold ? threshold : undefined,
        path: current.needPath ? filePath : undefined,
      });
      // 清上一次（同一次会话里连续出图不该叠加）
      if (renderedIdRef.current && renderedIdRef.current !== descriptorResult.id) {
        mapRef.current?.clearAnalysisRich?.(renderedIdRef.current);
        mapRef.current?.clearAnalysis?.(renderedIdRef.current);
      }
      setDescriptor(descriptorResult);
      const geometryTypes = new Set((descriptorResult.geojson?.features || []).map((f) => f?.geometry?.type));
      const isLineOnly = geometryTypes.size > 0 && [...geometryTypes].every((t) => /LineString/.test(String(t)));
      const ok = await renderWithRetry(() => mapRef.current?.showAnalysisRich?.({
        id: descriptorResult.id,
        type: descriptorResult.kind === "points" || descriptorResult.kind === "heatmap" ? "heatmap" : descriptorResult.kind === "isochrone" ? "isochrone" : "od",
        title: descriptorResult.title,
        source: descriptorResult.provenance?.demo ? "demo" : "data",
        fitBounds: true,
        // 纯线几何：交给 lines 渲染（showAnalysisRich 的线图层），主几何留空避免空 source
        geojson: isLineOnly ? { type: "FeatureCollection", features: [] } : descriptorResult.geojson,
        lines: descriptorResult.lines || (isLineOnly ? descriptorResult.geojson : null),
      }));
      if (!ok) setError("地图尚未就绪，请稍后重试");
      renderedIdRef.current = ok ? descriptorResult.id : null;
      setVisible(true);
      onResultChange?.({ ...descriptorResult, rendered: ok });
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, [dataset, kind, project, workspace, region, threshold, filePath, current, mapRef, onResultChange]);

  /** 演示数据走统一描述符（与其它数据集同一条路径，保证卡片与统计一致） */
  const runDemo = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const action = await mapDemoAnalysis({ analysis: kind === "flow" ? "od" : kind === "isochrone" ? "isochrone" : "heatmap", region, project });
      // 同时取描述符：既有 map_action 的实时渲染，也有统一的统计摘要与卡片。
      let descriptorResult = null;
      try {
        descriptorResult = await mapVisual({
          dataset: "demo-analysis",
          kind: kind === "flow" ? "flow" : kind === "isochrone" ? "isochrone" : "heatmap",
          project,
          region,
        });
      } catch { /* 描述符失败不影响出图 */ }
      // 清上一次（与 run() 同一规则）：两套渲染路径的图层 id 族不同，
      // 不清会两套并存——用户看到"临时层"里有两条，清除也只清得掉一条。
      const nextId = descriptorResult?.id || action?.id || "agent-analysis";
      if (renderedIdRef.current && renderedIdRef.current !== nextId) {
        mapRef.current?.clearAnalysisRich?.(renderedIdRef.current);
        mapRef.current?.clearAnalysis?.(renderedIdRef.current);
      }
      setDescriptor(descriptorResult);
      // 统一走 rich 渲染（与适配器路径同一套图层 id：analysis-*），
      // 这样"清除/撤销/重放"只需处理一种 id 族；描述符缺失时退回旧路径。
      const payload = descriptorResult?.geojson
        ? {
          id: nextId,
          type: descriptorResult.kind === "isochrone" ? "isochrone" : descriptorResult.kind,
          analysis: descriptorResult.kind,
          title: descriptorResult.title,
          source: "demo",
          fitBounds: true,
          geojson: descriptorResult.geojson,
          lines: descriptorResult.lines,
        }
        : action;
      const useRich = Boolean(descriptorResult?.geojson);
      const ok = await renderWithRetry(() => (useRich
        ? mapRef.current?.showAnalysisRich?.(payload)
        : mapRef.current?.showAnalysis?.(payload)));
      if (!ok) setError("地图尚未就绪，请稍后重试");
      renderedIdRef.current = ok ? nextId : null;
      setVisible(true);
      onResultChange?.({ ...action, ...(descriptorResult || {}), rendered: ok });
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, [kind, region, project, mapRef, onResultChange]);

  const submit = useCallback(() => {
    if (dataset === "demo-analysis") return runDemo();
    return run();
  }, [dataset, runDemo, run]);

  const clear = useCallback(() => {
    const id = descriptor?.id || renderedIdRef.current || "agent-analysis";
    mapRef.current?.clearAnalysisRich?.(id);
    mapRef.current?.clearAnalysis?.(id);
    setDescriptor(null);
    renderedIdRef.current = null;
    setVisible(true);
    onResultChange?.(null);
  }, [descriptor, mapRef, onResultChange]);

  /** 临时层显隐：对照底图时常用（不清除，只切换可见性） */
  const toggleVisible = useCallback(() => {
    const id = descriptor?.id || renderedIdRef.current;
    if (!id) return;
    const next = !visible;
    mapRef.current?.setAnalysisVisibility?.(id, next);
    setVisible(next);
  }, [descriptor, visible, mapRef]);

  const undo = useCallback(() => {
    const id = descriptor?.id || renderedIdRef.current;
    if (!id) return;
    // 撤销 = 清掉当前渲染（可视面板一次只保留一个结果，撤销与清除对面板状态等价，
    // 差别在地图侧的历史栈：MapViewer 的 undoAnalysis 会回退到上一次的 payload）。
    const reverted = mapRef.current?.undoAnalysis?.(id);
    if (!reverted) clear();
    else {
      setDescriptor(null);
      renderedIdRef.current = null;
      onResultChange?.(null);
    }
  }, [descriptor, mapRef, clear, onResultChange]);

  const save = useCallback(() => {
    if (!descriptor?.geojson) return;
    // Chat 模式不允许落盘（阶段 3 的能力划分）：这里硬拦住，
    // 不能只靠文案提示——按钮可点就等于给了绕过的入口。
    if (conversationMode === "chat") {
      setError("Chat 模式只做临时可视化；保存正式图层请切换到 Work 模式");
      return;
    }
    onSaveAnalysis?.({
      id: descriptor.id,
      type: descriptor.kind,
      analysis: descriptor.kind,
      region,
      title: descriptor.title,
      geojson: descriptor.geojson,
      lines: descriptor.lines,
      source: descriptor.provenance?.demo ? "demo" : "data",
    });
  }, [descriptor, region, onSaveAnalysis, conversationMode]);

  const ask = useCallback(() => {
    const text = askText.trim();
    if (!text) return;
    onAskAgent?.(text);
    setAskText("");
  }, [askText, onAskAgent]);

  const stats = descriptor?.stats || {};
  const canSave = Boolean(descriptor?.geojson);

  return (
    <div className="vp" role="dialog" aria-label="可视面板">
      <div className="vp-head">
        <Icon name="chart" size={13} />
        <span className="vp-title">可视化</span>
        <span className="vp-sub">六个分析面板已整合到这里</span>
        <button type="button" className="mp-op" onClick={onClose} title="关闭可视面板" aria-label="关闭可视面板">
          <Icon name="close" size={13} />
        </button>
      </div>

      <div className="vp-body">
        {/* 自然语言入口 */}
        <div className="vp-ask">
          <div className="vp-ask-row">
            <input
              className="vp-ask-input"
              value={askText}
              placeholder="用一句话说明要看什么，例如：新昌站点客流热力"
              onChange={(e) => setAskText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") ask(); }}
              aria-label="用自然语言描述可视化需求"
            />
            <button className="btn-sm vp-ask-send" type="button" onClick={ask} title="交给 Agent 出图（它会调用地图工具）">
              <Icon name="send" size={12} /> 交给 Agent
            </button>
          </div>
          <div className="vp-ask-hint">
            分析面板已整合到这里；用一句话描述你要看什么，或展开「高级」自己选参数。
          </div>
        </div>

        <button className="vp-advanced-toggle" type="button" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
          <Icon name={advanced ? "chevronDown" : "chevronRight"} size={11} /> 高级（手动选数据集与参数）
        </button>

        {advanced && (
          <div className="vp-advanced">
            <label className="vp-field">
              <span>数据集</span>
              <select value={dataset} onChange={(e) => setDataset(e.target.value)}>
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            {(current.kinds?.length > 0) && (
              <label className="vp-field">
                <span>类型</span>
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  {current.kinds.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
              </label>
            )}
            {current.needRegion && (
              <label className="vp-field">
                <span>区域</span>
                <select value={region} onChange={(e) => setRegion(e.target.value)}>
                  {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
            )}
            {current.needThreshold && (
              <label className="vp-field vp-field-range">
                <span>阈值 <strong>{threshold}</strong></span>
                <input type="range" min="0" max="600" step="10" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
              </label>
            )}
            {current.needPath && (
              <label className="vp-field">
                <span>文件</span>
                <input
                  className="vp-path-input"
                  value={filePath}
                  placeholder="留空自动选最新的 CSV / GeoJSON"
                  onChange={(e) => setFilePath(e.target.value)}
                />
              </label>
            )}
            <button className="btn-sm vp-run" type="button" onClick={submit} disabled={loading}>
              <Icon name={loading ? "loading" : "locate"} size={12} /> {loading ? "生成中…" : "生成可视化"}
            </button>
            {current.needPath && (
              <div className="vp-note">交通流量数据可以是一个 CSV：识别经度/纬度（或起点/终点）与流量列后直接出图。</div>
            )}
          </div>
        )}

        {error && <div className="vp-error"><Icon name="warning" size={12} /> {error}</div>}

        {descriptor && (
          <div className="vp-card">
            <div className="vp-card-head">
              <Icon name="star" size={11} />
              <span className="vp-card-name" title={descriptor.title}>{descriptor.title}</span>
              <span className="vp-card-badge">临时</span>
            </div>
            <div className="vp-card-stats">
              <span>{stats.count ?? 0} 个要素</span>
              {Number.isFinite(stats.min) && <span>值域 {stats.min}–{stats.max}</span>}
              {Number.isFinite(stats.avg) && <span>均值 {stats.avg}</span>}
              {descriptor.lines?.features?.length ? <span>{descriptor.lines.features.length} 条流向</span> : null}
              {descriptor.styleHint?.field ? <span>指标列 {descriptor.styleHint.field}</span> : null}
            </div>
            {descriptor.provenance?.demo && <div className="vp-card-demo">演示数据，请勿当作生产数据</div>}
            <div className="vp-card-actions">
              <button
                className="btn-sm"
                type="button"
                onClick={toggleVisible}
                title={visible ? "隐藏该临时层（对照底图时常用）" : "显示该临时层"}
              >
                <Icon name={visible ? "eye" : "eyeOff"} size={12} /> {visible ? "隐藏" : "显示"}
              </button>
              <button className="btn-sm" type="button" onClick={clear}><Icon name="trash" size={12} /> 清除</button>
              <button className="btn-sm" type="button" onClick={undo} title="撤销当前结果（回到上一次临时分析）"><Icon name="back" size={12} /> 撤销</button>
              <button
                className="btn-sm"
                type="button"
                onClick={save}
                disabled={!canSave || conversationMode === "chat"}
                title={conversationMode === "chat" ? "保存正式图层需要切换到 Work 模式" : "保存为正式图层（会写入项目）"}
              >
                <Icon name="download" size={12} /> 保存为图层
              </button>
              {conversationMode === "chat" && <span className="vp-card-hint">当前 Chat 模式只做临时可视化；保存需切到 Work</span>}
            </div>
          </div>
        )}

        {!descriptor && !error && (
          <div className="vp-empty">
            还没有生成可视化。展开「高级」选参数，或在上面输入一句话。
          </div>
        )}
      </div>
    </div>
  );
}
