import React, { useEffect, useRef, useCallback } from "react";
import { Graph } from "@antv/g6";

const TYPE_COLORS = {
  file: "#8abeb7",
  tag: "#f0c674",
  folder: "#6a9bc7",
};

const EDGE_COLORS = {
  link: "#8abeb7",
  similar: "#5a7d9c",
  tag: "#d4a84b",
  folder: "#4a6d8c",
};

/**
 * 知识图谱（antv G6 v5 力导向图）
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
          size: (d) => (d.data.type === "file" ? 18 : d.data.type === "tag" ? 7 : 8),
          fill: (d) => TYPE_COLORS[d.data.type] || "#8abeb7",
          labelText: (d) => {
            const label = d.data.label || "";
            return label.length > 16 ? label.slice(0, 15) + "…" : label;
          },
          labelPlacement: "bottom",
          labelFontSize: (d) => (d.data.type === "file" ? 10 : 8),
          labelFill: (d) => (d.data.type === "file" ? "#d4d4d4" : "#999"),
          labelMaxWidth: 140,
          labelWordWrap: true,
          lineWidth: 1.5,
          stroke: (d) => (d.id === highlightId ? "#ffffff" : "transparent"),
          shadowBlur: (d) => (d.id === highlightId ? 12 : 0),
          shadowColor: (d) => (d.id === highlightId ? "#8abeb7" : "transparent"),
          cursor: (d) => (d.data.type === "file" ? "pointer" : "default"),
        },
        state: {
          highlight: { fill: "#b5bd68", lineWidth: 2, stroke: "#ffffff" },
        },
      },
      edge: {
        style: {
          stroke: (d) => EDGE_COLORS[d.data.type] || "#33415c",
          lineWidth: (d) => (d.data.type === "link" ? 1.6 : d.data.type === "similar" ? 0.6 : 0.8),
          opacity: (d) => (d.data.type === "similar" ? 0.35 : 0.7),
          endArrow: false,
        },
      },
      layout: {
        type: "force",
        linkDistance: (d) => (d.data?.type === "similar" ? 200 : 120),
        nodeStrength: -400,
        preventOverlap: true,
        collideStrength: 0.95,
        alphaDecay: 0.12,
        alphaMin: 0.01,
      },
      behaviors: ["drag-canvas", "zoom-canvas", "drag-element", "hover-activate"],
    });
    g.on("node:click", (evt) => {
      const id = evt.target?.id;
      if (!id) return;
      const nodeData = data?.nodes?.find((n) => n.id === id);
      onSelectNode?.(nodeData && nodeData.type === "file" ? nodeData : null);
    });
    // 悬停 tooltip
    g.on("node:pointerenter", (evt) => {
      const el = evt.target;
      if (el) el.attr({ lineWidth: 2, stroke: "#8abeb7" });
    });
    g.on("node:pointerleave", (evt) => {
      const el = evt.target;
      if (el && el.id !== highlightId) el.attr({ lineWidth: 1.5, stroke: "transparent" });
    });
    g.render().then(() => {
      setTimeout(() => g.fitView(30, "both", true), 200);
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
      setTimeout(() => g.fitView(30, "both", true), 200);
    }).catch(() => {});
  }, [data, buildData]);

  // 高亮定位
  useEffect(() => {
    const g = graphRef.current;
    if (!g || !highlightId) return;
    try { g.setElementState(highlightId, ["highlight"]); g.focusElement(highlightId); } catch {}
  }, [highlightId]);

  return (
    <div className="kb-graph">
      <div className="kb-graph-canvas" ref={containerRef} />
      <div className="kb-graph-legend">
        <span><i style={{ background: TYPE_COLORS.file }} /> 文档</span>
        <span><i style={{ background: TYPE_COLORS.tag }} /> 标签</span>
        <span><i style={{ background: TYPE_COLORS.folder }} /> 目录</span>
        <span><i style={{ background: EDGE_COLORS.link, width: 14, height: 2, borderRadius: 1 }} /> 链接</span>
        <span><i style={{ background: EDGE_COLORS.similar, width: 14, height: 2, borderRadius: 1 }} /> 相似</span>
        <span className="kb-graph-hint">拖拽画布 · 滚轮缩放 · 点击文档节点查看</span>
      </div>
    </div>
  );
}
