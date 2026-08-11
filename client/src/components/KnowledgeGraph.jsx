import React, { useEffect, useRef, useState, useCallback } from "react";
import { Graph } from "@antv/g6";

const TYPE_COLORS = {
  file: "#8abeb7",
  tag: "#f0c674",
  folder: "#6a9bc7",
};

/**
 * 知识图谱（antv G6 v5 力导向图）
 * - 节点=文档（点击回传 onSelectNode）；标签/目录节点不可打开
 * - 支持拖拽画布/缩放/拖拽节点/悬停高亮
 */
export default function KnowledgeGraph({ data, onSelectNode, highlightId }) {
  const containerRef = useRef(null);
  const graphRef = useRef(null);
  const [selected, setSelected] = useState(null);

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

  // 创建/销毁 graph
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const g = new Graph({
      container: el,
      autoResize: true,
      data: buildData(),
      node: {
        style: {
          size: (d) => (d.data.type === "file" ? 16 : d.data.type === "tag" ? 9 : 7),
          fill: (d) => TYPE_COLORS[d.data.type] || "#8abeb7",
          labelText: (d) => d.data.label,
          labelPlacement: "bottom",
          labelFontSize: 10,
          labelFill: "#d4d4d4",
          labelMaxWidth: 160,
          labelWordWrap: true,
          lineWidth: 1.2,
          stroke: (d) => (d.id === highlightId ? "#ffffff" : "#2a2a44"),
        },
        state: {
          highlight: { fill: "#b5bd68", lineWidth: 2, stroke: "#ffffff" },
        },
      },
      edge: {
        style: {
          stroke: (d) => (d.data.type === "link" ? "#8abeb7" : d.data.type === "similar" ? "#5a7d9c" : "#33415c"),
          lineWidth: (d) => (d.data.type === "link" ? 1.4 : d.data.type === "similar" ? 0.8 : 0.7),
          opacity: (d) => (d.data.type === "similar" ? 0.45 : 0.8),
          endArrow: false,
        },
      },
      layout: {
        type: "force",
        linkDistance: 130,
        nodeStrength: -320,
        preventOverlap: true,
        collideStrength: 0.9,
        alphaDecay: 0.18,
      },
      behaviors: ["drag-canvas", "zoom-canvas", "drag-element", "hover-activate", "click-select"],
    });
    g.on("node:click", (evt) => {
      const id = evt.target?.id;
      if (!id) return;
      setSelected(id);
      const nodeData = data?.nodes?.find((n) => n.id === id);
      onSelectNode?.(nodeData && nodeData.type === "file" ? nodeData : null);
    });
    g.render().catch((e) => console.error("G6 render error:", e));
    graphRef.current = g;
    return () => {
      g.destroy();
      graphRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 数据更新
  useEffect(() => {
    const g = graphRef.current;
    if (!g || !data) return;
    g.setData(buildData());
    g.render().catch((e) => console.error("G6 re-render error:", e));
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

  // 自适应
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    g.fitView(20, "both", false);
  }, [data]);

  return (
    <div className="kb-graph">
      <div className="kb-graph-canvas" ref={containerRef} />
      <div className="kb-graph-legend">
        <span><i style={{ background: TYPE_COLORS.file }} /> 文档</span>
        <span><i style={{ background: TYPE_COLORS.tag }} /> 标签</span>
        <span><i style={{ background: TYPE_COLORS.folder }} /> 目录</span>
        <span><i style={{ background: "#8abeb7", width: 14, height: 2, borderRadius: 1 }} /> 链接</span>
        <span><i style={{ background: "#5a7d9c", width: 14, height: 2, borderRadius: 1 }} /> 相似</span>
        <span className="kb-graph-hint">拖拽画布 / 滚轮缩放 / 点击节点查看</span>
      </div>
    </div>
  );
}
