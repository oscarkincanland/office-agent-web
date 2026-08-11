import React, { useEffect, useRef, useCallback } from "react";
import { Graph } from "@antv/g6";

const TYPE_COLORS = {
  file: "#8abeb7",
  tag: "#e8c547",
  folder: "#6a9bc7",
};

const EDGE_COLORS = {
  link: "#5a8a7c",
  similar: "#4a6d8c",
  tag: "#b8952e",
  folder: "#3d6080",
};

/**
 * 知识图谱（antv G6 v5 力导向图）
 * - Obsidian 风格纸面背景（细格线）
 * - 节点=文档/标签/目录
 * - 边=双向链接/内容相似/标签关系/目录归属
 * - 点击文档节点回传 onSelectNode
 * - 自动 fitView，拖拽/缩放/悬停
 */
export default function KnowledgeGraph({ data, onSelectNode, highlightId }) {
  const containerRef = useRef(null);
  const graphRef = useRef(null);

  const buildData = useCallback(() => {
    const nodes = (data?.nodes || []).map((n) => ({
      id: n.id,
      data: {
        label: n.label,
        type: n.type || "file",
        relPath: n.relPath,
        rootIdx: n.rootIdx,
      },
    }));
    const edges = (data?.edges || []).map((e, i) => ({
      id: `e${i}`,
      source: e.source,
      target: e.target,
      data: { type: e.type || "link" },
    }));
    return { nodes, edges };
  }, [data]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const g = new Graph({
      container: el,
      autoResize: true,
      data: buildData(),
      node: {
        style: {
          size: (d) => (d.data.type === "file" ? 22 : d.data.type === "tag" ? 8 : 10),
          fill: (d) => TYPE_COLORS[d.data.type] || "#8abeb7",
          labelText: (d) => {
            const label = d.data.label || "";
            return label.length > 18 ? label.slice(0, 17) + "…" : label;
          },
          labelPlacement: "bottom",
          labelFontSize: (d) => (d.data.type === "file" ? 11 : 9),
          labelFill: (d) => (d.data.type === "file" ? "#c8c8d0" : "#8a8a9a"),
          labelMaxWidth: 160,
          labelWordWrap: true,
          lineWidth: 1.5,
          stroke: (d) => (d.id === highlightId ? "#ffffff" : "rgba(255,255,255,0.08)"),
          shadowBlur: (d) => (d.id === highlightId ? 16 : 0),
          shadowColor: (d) => (d.id === highlightId ? "#8abeb7" : "transparent"),
          cursor: (d) => (d.data.type === "file" ? "pointer" : "default"),
          // 悬停状态
          badges: [],
        },
        state: {
          highlight: { fill: "#b5bd68", lineWidth: 2, stroke: "#ffffff" },
          hover: { lineWidth: 2, stroke: "#8abeb7", shadowBlur: 8, shadowColor: "rgba(138,190,183,0.3)" },
        },
      },
      edge: {
        style: {
          stroke: (d) => EDGE_COLORS[d.data.type] || "#33415c",
          lineWidth: (d) => (d.data.type === "link" ? 1.2 : d.data.type === "similar" ? 0.5 : 0.7),
          opacity: (d) => (d.data.type === "similar" ? 0.25 : 0.55),
          endArrow: false,
          curveOffset: 0,
          // 边的动画效果
          increaseVisibilityOnHover: true,
        },
      },
      layout: {
        type: "force",
        linkDistance: (d) => (d.data?.type === "similar" ? 280 : 180),
        nodeStrength: -600,
        edgeStrength: (d) => (d.data?.type === "similar" ? 0.1 : 0.3),
        preventOverlap: true,
        collideStrength: 1.0,
        alphaDecay: 0.08,
        alphaMin: 0.005,
        maxSpeed: 200,
        damping: 0.8,
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

    // 点击文档节点
    g.on("node:click", (evt) => {
      const id = evt.target?.id;
      if (!id) return;
      const nodeData = data?.nodes?.find((n) => n.id === id);
      onSelectNode?.(nodeData && nodeData.type === "file" ? nodeData : null);
    });

    // 悬停高亮
    g.on("node:pointerenter", (evt) => {
      const el = evt.target;
      if (el) {
        try { g.setElementState(el.id, ["hover"]); } catch {}
      }
    });
    g.on("node:pointerleave", (evt) => {
      const el = evt.target;
      if (el && el.id !== highlightId) {
        try { g.setElementState(el.id, []); } catch {}
      }
    });

    g.render().then(() => {
      setTimeout(() => g.fitView(40, "both", true), 300);
    }).catch((e) => console.error("G6 render error:", e));
    graphRef.current = g;
    return () => { g.destroy(); graphRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 数据更新
  useEffect(() => {
    const g = graphRef.current;
    if (!g || !data) return;
    g.setData(buildData());
    g.render().then(() => {
      setTimeout(() => g.fitView(40, "both", true), 300);
    }).catch(() => {});
  }, [data, buildData]);

  // 高亮定位
  useEffect(() => {
    const g = graphRef.current;
    if (!g || !highlightId) return;
    try {
      g.setElementState(highlightId, ["highlight"]);
      g.focusElement(highlightId);
    } catch {}
  }, [highlightId]);

  return (
    <div className="kb-graph">
      <div className="kb-graph-canvas" ref={containerRef} />
      <div className="kb-graph-legend">
        <span><i style={{ background: TYPE_COLORS.file }} /> 文档</span>
        <span><i style={{ background: TYPE_COLORS.tag }} /> 标签</span>
        <span><i style={{ background: TYPE_COLORS.folder }} /> 目录</span>
        <span className="kb-graph-legend-sep" />
        <span><i className="kb-graph-edge-line" style={{ background: EDGE_COLORS.link }} /> 链接</span>
        <span><i className="kb-graph-edge-line" style={{ background: EDGE_COLORS.similar }} /> 相似</span>
        <span className="kb-graph-hint">拖拽画布 · 滚轮缩放 · 点击文档节点</span>
      </div>
    </div>
  );
}
