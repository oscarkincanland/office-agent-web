import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Graph } from "@antv/g6";

// 分组调色板（Obsidian 式：同组同色相，组间区分）
const GROUP_COLORS = ["#7aa2f7", "#9ece6a", "#e0af68", "#bb9af7", "#f7768e", "#73daca", "#2ac3de", "#ff9e64", "#c0caf5", "#a9b1d6"];
const TAG_COLOR = "#e8c547";
const FOLDER_COLOR = "#6a9bc7";

// 稳定 hash：同一组名永远映射到同一颜色
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const EDGE_COLORS = {
  link: "#5a8a7c",
  similar: "#4a6d8c",
  tag: "#b8952e",
  folder: "#3d6080",
};

const BATCH_SIZE = 500; // 分批渲染阈值

const GRAPH_SETTINGS_KEY = "oaw_graph_settings";
function loadGraphSettings() {
  try {
    return { minRefs: 0, showTags: true, showFiles: true, showFolders: true, ...JSON.parse(localStorage.getItem(GRAPH_SETTINGS_KEY) || "{}") };
  } catch {
    return { minRefs: 0, showTags: true, showFiles: true, showFolders: true };
  }
}
function saveGraphSettings(s) {
  try { localStorage.setItem(GRAPH_SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

/**
 * 知识图谱（antv G6 v5 力导向图，Obsidian/siyuan 风格）
 * - 边 = 真实关系（wikilink/标签/目录），similar 相似边默认关闭由上层控制
 * - hover 节点 → 邻接节点+边高亮，非邻接降透明（Obsidian 聚焦）
 * - 节点大小 ∝ 连接度（Obsidian：关联越多越大）
 * - file 节点按顶层目录分组着色（Obsidian 颜色分组）
 * - 缩放联动：缩小到阈值以下自动隐藏标签文字（防密）
 * - 控制条：搜索定位节点 / 隐藏孤立节点（对齐 siyuan pruneUnref）
 * - minRefs 过滤（siyuan）：引用数低于阈值的文件节点剔除
 * - 按类型过滤（siyuan）：文档/标签/目录独立开关
 * - 配置持久化到 localStorage（oaw_graph_settings）
 * - 大数据量分批渲染（对齐 siyuan 分批策略）
 */
export default function KnowledgeGraph({ data, onSelectNode, highlightId, focusId }) {
  const containerRef = useRef(null);
  const graphRef = useRef(null);
  const [hideIsolated, setHideIsolated] = useState(false);
  const [density, setDensity] = useState(1); // 布局密度（0.6 紧凑 ~ 1.8 舒展）
  const [query, setQuery] = useState("");
  const [minRefs, setMinRefs] = useState(() => loadGraphSettings().minRefs);
  const [showTags, setShowTags] = useState(() => loadGraphSettings().showTags);
  const [showFiles, setShowFiles] = useState(() => loadGraphSettings().showFiles);
  const [showFolders, setShowFolders] = useState(() => loadGraphSettings().showFolders);
  // 配置持久化（siyuan：图谱配置保存，刷新不丢）
  useEffect(() => {
    saveGraphSettings({ minRefs, showTags, showFiles, showFolders });
  }, [minRefs, showTags, showFiles, showFolders]);

  const adjMapRef = useRef(new Map());
  const degreeMapRef = useRef(new Map());
  const allNodesRef = useRef([]);
  const allEdgesRef = useRef([]);

  // 预处理：度、邻接表、分组色
  const prepared = useMemo(() => {
    const nodes = (data?.nodes || []).map((n) => ({
      id: n.id,
      data: { label: n.label, type: n.type || "file", relPath: n.relPath, rootIdx: n.rootIdx, group: n.group || "root" },
    }));
    const edges = (data?.edges || []).map((e, i) => ({
      id: `e${i}`,
      source: e.source,
      target: e.target,
      data: { type: e.type || "link" },
    }));
    const adj = new Map();
    const deg = new Map();
    for (const n of nodes) adj.set(n.id, new Set());
    for (const e of edges) {
      const s = adj.get(e.source);
      const t = adj.get(e.target);
      if (s) s.add(e.target);
      if (t) t.add(e.source);
      deg.set(e.source, (deg.get(e.source) || 0) + 1);
      deg.set(e.target, (deg.get(e.target) || 0) + 1);
    }
    const groupColor = new Map();
    for (const n of nodes) {
      if (n.data.type !== "file") continue;
      const g = n.data.group || "root";
      if (!groupColor.has(g)) groupColor.set(g, GROUP_COLORS[hashStr(g) % GROUP_COLORS.length]);
    }
    return { nodes, edges, adj, deg, groupColor };
  }, [data]);

  const { nodes: allNodes, edges: allEdges } = prepared;

  // 局部图谱：focusId 非空时只渲染其 1-hop 子图（对齐 siyuan 局部图）
  const subSet = useMemo(() => {
    if (!focusId) return null;
    const adj = prepared.adj.get(focusId);
    if (!adj) return null;
    return new Set([focusId, ...adj]);
  }, [focusId, prepared]);

  // 记录全量（分批渲染时用）
  useEffect(() => {
    allNodesRef.current = allNodes;
    allEdgesRef.current = allEdges;
    adjMapRef.current = prepared.adj;
    degreeMapRef.current = prepared.deg;
  }, [allNodes, allEdges, prepared]);

  // 主题色（渲染时读取 CSS 变量，跟随暗/亮主题）
  const cs = typeof document !== "undefined" ? getComputedStyle(document.documentElement) : null;
  const themeTextColor = cs?.getPropertyValue("--text").trim() || "#d4d4d4";
  const themeMutedColor = cs?.getPropertyValue("--muted").trim() || "#a0a0b0";
  const themeAccentColor = cs?.getPropertyValue("--accent").trim() || "#8abeb7";

  const nodeSize = useCallback((d) => {
    const t = d.data.type;
    if (t === "tag") return 7;
    if (t === "folder") return 9;
    // 对数缩放（对齐 siyuan getGraphNodeSize：log2(被引用数+1)+1）× base，避免大度节点尺寸爆炸
    const deg = degreeMapRef.current.get(d.id) || 0;
    return Math.min(56, (Math.log2(deg + 1) + 0.6) * 12);
  }, []);

  const nodeFill = useCallback((d) => {
    if (d.data.type === "tag") return TAG_COLOR;
    if (d.data.type === "folder") return FOLDER_COLOR;
    return prepared.groupColor.get(d.data.group || "root") || GROUP_COLORS[0];
  }, [prepared]);

  const labelText = useCallback((d) => {
    const label = d.data.label || "";
    return label.length > 18 ? label.slice(0, 17) + "…" : label;
  }, []);

  // 创建图谱
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const visibleNodes = allNodes.filter((n) => {
      const t = n.data.type;
      if (t === "tag" && !showTags) return false;
      if (t === "folder" && !showFolders) return false;
      if (t === "file" && !showFiles) return false;
      // minRefs：引用数低于阈值的文件节点剔除（局部图谱聚焦节点保留）
      if (t === "file" && minRefs > 0) {
        const deg = degreeMapRef.current.get(n.id) || 0;
        if (deg < minRefs && !subSet?.has(n.id)) return false;
      }
      if (hideIsolated && t === "file" && (degreeMapRef.current.get(n.id) || 0) <= 0) return false;
      return true;
    });
    const localIds = subSet || null;
    const scopeNodes = localIds ? visibleNodes.filter((n) => localIds.has(n.id)) : visibleNodes;
    const scopeIds = new Set(scopeNodes.map((n) => n.id));
    const scopeEdges = allEdges.filter((e) => scopeIds.has(e.source) && scopeIds.has(e.target));

    const batch = scopeNodes.length > BATCH_SIZE;
    const initialNodes = batch ? scopeNodes.slice(0, BATCH_SIZE) : scopeNodes;
    const initialEdgeIds = new Set();
    if (batch) {
      const ids = new Set(initialNodes.map((n) => n.id));
      for (const e of scopeEdges) if (ids.has(e.source) && ids.has(e.target)) initialEdgeIds.add(e.id);
    }
    const initialEdges = batch ? scopeEdges.filter((e) => initialEdgeIds.has(e.id)) : scopeEdges;

    const g = new Graph({
      container: el,
      autoResize: true,
      data: {
        // 黄金角螺旋初始布局（对齐 siyuan createInitialPositions：均匀展开，避免初始化堆叠）
        nodes: initialNodes.map((n, i) => {
          const golden = Math.PI * (3 - Math.sqrt(5));
          let hash = 2166136261;
          for (let j = 0; j < n.id.length; j++) { hash ^= n.id.charCodeAt(j); hash = Math.imul(hash, 16777619); }
          hash >>>= 0;
          const angle = i * golden + (hash % 1024) / 1024;
          const radius = Math.sqrt(i + 1) * Math.max(40, 220 * 0.35);
          return { ...n, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
        }),
        edges: initialEdges,
      },
      node: {
        style: {
          size: nodeSize,
          fill: nodeFill,
          labelText,
          labelPlacement: "bottom",
          labelFontSize: (d) => (d.data.type === "file" ? 11 : 9),
          labelFill: (d) => (d.data.type === "file" ? themeTextColor : themeMutedColor),
          labelMaxWidth: 160,
          labelWordWrap: true,
          lineWidth: 1.5,
          stroke: (d) => (d.id === highlightId ? themeTextColor : "rgba(255,255,255,0.08)"),
          cursor: (d) => (d.data.type === "file" || d.data.type === "tag" ? "pointer" : "default"),
        },
        animation: {
          update: { duration: 400, easing: "ease-out" },
          enter: { duration: 300, easing: "ease-out" },
        },
        state: {
          dim: { opacity: 0.12 },
          neighbor: { lineWidth: 2, stroke: themeTextColor },
          hover: { shadowBlur: 12, shadowColor: themeAccentColor },
          focus: { lineWidth: 2.5, stroke: themeTextColor, shadowBlur: 16, shadowColor: themeAccentColor },
        },
      },
      edge: {
        style: {
          stroke: (d) => EDGE_COLORS[d.data.type] || "#33415c",
          lineWidth: (d) => (d.data.type === "link" ? 1.2 : d.data.type === "similar" ? 0.5 : 0.7),
          opacity: (d) => (d.data.type === "similar" ? 0.25 : 0.55),
          endArrow: false,
        },
        animation: {
          update: { duration: 400, easing: "ease-out" },
          enter: { duration: 300, easing: "ease-out" },
        },
        state: {
          "dim-edge": { opacity: 0.04 },
          near: { opacity: 0.95 },
        },
      },
      layout: {
        type: "force",
        linkDistance: (d) => (d.data?.type === "similar" ? 330 : 220) * density,
        nodeStrength: -1200 * density,
        edgeStrength: (d) => (d.data?.type === "similar" ? 0.06 : 0.25) / density,
        preventOverlap: true,
        collide: true,
        collideRadius: (d) => ((nodeSize(d) || 16) + 24) * density,
        collideStrength: 1.6,
        alpha: 0.5,
        alphaDecay: 0.06,
        alphaMin: 0.004,
        maxSpeed: 300,
        damping: 0.7,
      },
      behaviors: [
        "drag-canvas",
        "zoom-canvas",
        "drag-element",
        {
          type: "hover-activate",
          key: "hover",
          duration: 200,
        },
      ],
    });

    // 分批渲染：稳定后再追加剩余节点/边（对齐 siyuan 分批策略）
    g.render().then(() => {
      setTimeout(() => g.fitView(40, "both", true), 300);
      const canvases = el.querySelectorAll("canvas");
      canvases.forEach((c) => { c.style.background = "transparent"; });
      if (batch && scopeNodes.length > BATCH_SIZE) {
        const restNodes = scopeNodes.slice(BATCH_SIZE);
        const restIds = new Set(restNodes.map((n) => n.id));
        const restEdges = scopeEdges.filter((e) => restIds.has(e.source) && restIds.has(e.target));
        g.addData({ nodes: restNodes, edges: restEdges });
      }
      // 局部图谱：聚焦中心节点
      if (focusId) {
        try { g.focusElement(focusId, { animation: true }); } catch {}
      }
    }).catch((e) => console.error("G6 render error:", e));

    // hover 聚焦：邻接高亮 + 非邻接 dim（Obsidian 核心交互）
    const hoverActivate = (id) => {
      const adj = adjMapRef.current.get(id) || new Set([id]);
      adj.add(id);
      for (const n of allNodesRef.current) {
        const s = adj.has(n.id) ? (n.id === id ? ["hover", "focus", "neighbor"] : ["neighbor"]) : ["dim"];
        try { g.setElementState(n.id, s); } catch {}
      }
      for (const e of allEdgesRef.current) {
        const near = adj.has(e.source) && adj.has(e.target);
        try { g.setElementState(e.id, near ? ["near"] : ["dim-edge"]); } catch {}
      }
    };
    const clearHover = () => {
      for (const n of allNodesRef.current) {
        try { g.setElementState(n.id, n.id === highlightId ? ["focus"] : []); } catch {}
      }
      for (const e of allEdgesRef.current) {
        try { g.setElementState(e.id, []); } catch {}
      }
    };

    g.on("node:pointerenter", (evt) => {
      const id = evt.target?.id;
      if (id) hoverActivate(id);
    });
    g.on("node:pointerleave", clearHover);

    // 点击：文件/标签节点回传（标签 → 上层执行搜索）
    g.on("node:click", (evt) => {
      const id = evt.target?.id;
      if (!id) return;
      const nodeData = allNodesRef.current.find((n) => n.id === id)?.data;
      if (!nodeData) return;
      onSelectNode?.(nodeData);
    });

    // 缩放联动：低于阈值隐藏标签文字（防密）
    const applyZoomLabels = () => {
      const zoom = g.getZoom();
      const show = zoom > 0.55;
      for (const n of allNodesRef.current) {
        try { g.updateNodeData([{ id: n.id, style: { labelText: show ? labelText(n) : "" } }]); } catch {}
      }
    };
    g.on("wheel", applyZoomLabels);

    graphRef.current = g;
    return () => {
      try { g.destroy(); } catch {}
      graphRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, hideIsolated, highlightId, focusId, subSet, density, minRefs, showTags, showFiles, showFolders]);

  // 高亮定位（外部选中文档时）
  useEffect(() => {
    const g = graphRef.current;
    if (!g || !highlightId) return;
    try {
      g.focusElement(highlightId, { animation: true });
      g.setElementState(highlightId, ["focus"]);
    } catch {}
  }, [highlightId]);

  // 搜索定位节点
  const doFocus = useCallback(() => {
    const g = graphRef.current;
    if (!g || !query.trim()) return;
    const q = query.trim().toLowerCase();
    const n = allNodesRef.current.find((x) => String(x.data.label || "").toLowerCase().includes(q));
    if (!n) return;
    try {
      g.focusElement(n.id, { animation: true });
      g.setElementState(n.id, ["focus"]);
    } catch {}
  }, [query]);

  return (
    <div className="kb-graph-wrap">
      <div className="kb-graph-tools">
        <input
          className="kb-graph-search"
          placeholder="搜索节点定位…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && doFocus()}
        />
        <label className="kb-check">
          <input type="checkbox" checked={hideIsolated} onChange={(e) => setHideIsolated(e.target.checked)} />
          隐藏孤立节点
        </label>
        <span className="kb-filter-block" title="按类型过滤（siyuan 式）">
          <label className="kb-check kb-type-check"><input type="checkbox" checked={showFiles} onChange={(e) => setShowFiles(e.target.checked)} />文档</label>
          <label className="kb-check kb-type-check"><input type="checkbox" checked={showTags} onChange={(e) => setShowTags(e.target.checked)} />标签</label>
          <label className="kb-check kb-type-check"><input type="checkbox" checked={showFolders} onChange={(e) => setShowFolders(e.target.checked)} />目录</label>
        </span>
        <span className="kb-minrefs" title="最小引用数过滤（siyuan minRefs）：引用数低于阈值的文档节点隐藏">
          <span className="kb-density-label">最少引用</span>
          <input
            type="range"
            min="0" max="8" step="1"
            value={minRefs}
            onChange={(e) => setMinRefs(Number(e.target.value))}
          />
          <span className="kb-density-val">{minRefs}</span>
        </span>
        <span className="kb-density" title="调整节点间距">
          <span className="kb-density-label">间距</span>
          <input
            type="range"
            min="0.6" max="1.8" step="0.1"
            value={density}
            onChange={(e) => setDensity(Number(e.target.value))}
          />
          <span className="kb-density-val">{density.toFixed(1)}×</span>
        </span>
      </div>
      <div className="kb-graph" ref={containerRef} />
    </div>
  );
}
