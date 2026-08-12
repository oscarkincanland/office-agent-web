import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Graph } from "@antv/g6";
import Icon from "./Icon.jsx";
import MarkdownBody from "./MarkdownBody.jsx";
import { kbTree } from "../api.js";

const DIR_COLOR = "#e0af68";
const FILE_COLOR = "#7aa2f7";
const HIGHLIGHT_COLOR = "#f7768e";

/**
 * 知识库脑图（思维导图视图）
 * - 左侧大纲（缩进列表）+ 右侧 G6 树状脑图（indented 布局）
 * - 双向联动：点击大纲 → 脑图高亮；点击脑图节点 → 大纲高亮 + 打开文档
 * - 目录节点可展开/折叠
 */
export default function MindMap({ roots, onSelectDoc, highlightPath, rootIdx: currentRootIdx, doc }) {
  const containerRef = useRef(null);
  const graphRef = useRef(null);
  const dataRef = useRef({ nodes: [], edges: [] });
  const [trees, setTrees] = useState([]); // [{rootIdx, rootName, tree}]
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState({}); // dirKey -> bool
  const [activePath, setActivePath] = useState(null);

  // 加载所有根目录的完整树
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const rootsList = roots || [];
      const out = [];
      for (let i = 0; i < rootsList.length; i++) {
        try {
          const t = await kbTree(rootsList[i].index);
          if (alive && t?.tree) out.push({ rootIdx: rootsList[i].index, rootName: rootsList[i].name, tree: t.tree });
        } catch {}
      }
      if (!alive) return;
      // 构建 G6 数据：每个根为顶层节点，dir/file 为子节点
      // 注意：不同父目录下可能有同名子目录，id 必须用完整路径
      const nodes = [];
      const edges = [];
      const pushNode = (id, label, type, parentId) => {
        nodes.push({ id, data: { label, type, parentId } });
        if (parentId) edges.push({ source: parentId, target: id, data: {} });
      };
      const walk = (items, parentPath, rootIdx) => {
        for (const it of items || []) {
          const fullPath = parentPath ? `${parentPath}/${it.name}` : it.name;
          const id = `${rootIdx}/${fullPath}`;
          if (it.type === "dir") {
            pushNode(id, it.name, "dir", parentPath ? `${rootIdx}/${parentPath}` : `root/${rootIdx}`);
            walk(it.children, fullPath, rootIdx);
          } else {
            pushNode(id, it.name, "file", parentPath ? `${rootIdx}/${parentPath}` : `root/${rootIdx}`);
          }
        }
      };
      for (const t of out) {
        const rootId = `root/${t.rootIdx}`;
        pushNode(rootId, t.rootName, "root", null);
        walk(t.tree, "", t.rootIdx);
      }
      dataRef.current = { nodes, edges };
      setTrees(out);
      setLoading(false);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots]);

  // 大纲：按折叠状态重建（目录可展开/折叠）
  const outline = useMemo(() => {
    const build = (items, depth, parentKey) => {
      const out = [];
      for (const it of items || []) {
        const key = `${parentKey}/${it.name}`;
        const isDir = it.type === "dir";
        out.push({ key, name: it.name, type: it.type, depth, relPath: it.relPath, rootIdx: it.rootIdx ?? null, isDir });
        if (isDir && !collapsed[key] && it.children?.length) {
          out.push(...build(it.children, depth + 1, key));
        }
      }
      return out;
    };
    let rows = [];
    for (const t of trees) rows = rows.concat(build(t.tree, 0, `r${t.rootIdx}`));
    return rows;
  }, [trees, collapsed]);

  // 渲染/更新脑图
  useEffect(() => {
    if (!containerRef.current) return undefined;
    if (!dataRef.current.nodes.length) return undefined;
    const graph = new Graph({
      container: containerRef.current,
      autoResize: true,
      data: dataRef.current,
      node: {
        style: {
          size: 10,
          labelText: (d) => d.data.label,
          labelPlacement: "right",
          labelOffsetX: 8,
          labelFontSize: 11,
          fill: (d) => {
            if (d.data.type === "root") return DIR_COLOR;
            if (d.data.type === "dir") return DIR_COLOR;
            return FILE_COLOR;
          },
          stroke: "#00000000",
          lineWidth: 0,
          labelFill: (d) => (d.data.type === "root" ? "#e0af68" : "#c0caf5"),
          labelFontWeight: (d) => (d.data.type === "root" ? 700 : 400),
        },
      },
      edge: {
        style: { stroke: "#3d6080", lineWidth: 1, endArrow: false },
      },
      layout: {
        type: "indented",
        direction: "LR",
        dropCap: false,
        indent: 24,
        getVGap: () => 4,
        getHGap: () => 30,
      },
      behaviors: ["drag-canvas", "zoom-canvas"],
    });
    graph.render();
    graphRef.current = graph;
    return () => {
      try { graph.destroy(); } catch {}
      graphRef.current = null;
    };
  }, [loading]);

  // 点击脑图节点 → 大纲高亮 + 打开文档
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return undefined;
    const onClick = (evt) => {
      const node = evt.target;
      const d = node?.data;
      if (!d || d.type !== "file") return;
      setActivePath(node.id);
      const rootIdx = parseInt(String(node.id).split("/")[0], 10);
      onSelectDoc?.(d.label, Number.isNaN(rootIdx) ? 0 : rootIdx);
    };
    graph.on("node:click", onClick);
    return () => graph.off("node:click", onClick);
  }, [onSelectDoc]);

  // 外部高亮（从知识库文档切换联动）
  useEffect(() => {
    if (!highlightPath) return;
    const id = `${currentRootIdx ?? 0}/${highlightPath}`;
    setActivePath(id);
    const graph = graphRef.current;
    if (!graph) return;
    try {
      graph.setElementState(id, ["selected"]);
      const n = graph.getElementById(id);
      if (n) graph.focusElement(id, { animation: false });
    } catch {}
  }, [highlightPath, currentRootIdx]);

  const toggleCollapse = useCallback((key) => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      return next;
    });
  }, []);

  return (
    <div className="kb-mindmap">
      <div className="kb-mindmap-outline">
        <div className="kb-mindmap-outline-head">
          <Icon name="list" size={12} /> 大纲
        </div>
        <div className="kb-mindmap-outline-list">
          {loading && <div className="kb-mindmap-loading">加载中…</div>}
          {!loading && outline.map((row) => (
            <div
              key={row.key}
              className={`kb-mindmap-row ${row.isDir ? "dir" : "file"} ${activePath === `${row.rootIdx ?? 0}/${row.relPath}` ? "active" : ""}`}
              style={{ paddingLeft: row.depth * 14 + 8 }}
              onClick={() => {
                if (row.isDir) toggleCollapse(row.key);
                else onSelectDoc?.(row.relPath, row.rootIdx);
              }}
            >
              <span className="kb-mindmap-caret">{row.isDir ? (collapsed[row.key] ? "▸" : "▾") : ""}</span>
              <Icon name={row.isDir ? "folder" : "file"} size={12} />
              <span className="kb-mindmap-name" title={row.name}>{row.name}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="kb-mindmap-canvas" ref={containerRef}>
        {loading && <div className="kb-mindmap-loading">脑图加载中…</div>}
      </div>
      {doc && (
        <div className="kb-mindmap-preview">
          <div className="kb-doc-titlebar">
            <span className="kb-doc-title" title={doc.relPath}>{doc.title || doc.relPath}</span>
            {doc.tags?.length > 0 && (
              <div className="kb-doc-tags">{doc.tags.map((t) => <span key={t} className="tag">#{t}</span>)}</div>
            )}
            <div className="kb-doc-breadcrumb">{doc.rootName || ""}{doc.relPath ? ` / ${doc.relPath}` : ""}</div>
          </div>
          <div className="kb-doc-body kb-preview-scroll">
            <MarkdownBody>{doc.content}</MarkdownBody>
          </div>
        </div>
      )}
    </div>
  );
}
