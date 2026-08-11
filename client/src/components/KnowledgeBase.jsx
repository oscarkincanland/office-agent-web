import React, { useState, useEffect, useCallback, useMemo } from "react";
import Icon from "./Icon.jsx";
import MarkdownBody from "./MarkdownBody.jsx";
import KnowledgeGraph from "./KnowledgeGraph.jsx";
import {
  kbStatus, kbAddRoot, kbRemoveRoot, kbTree, kbSearch, kbGraph, kbDoc,
  kbImaStatus, kbImaBases, kbImaSearch, kbImaDoc,
} from "../api.js";

/**
 * 知识库全屏模式（Obsidian 风格）
 * 左：目录树 / 搜索结果；中：Markdown 预览；右：文档信息（标签/链接/反链）+ @ 到对话
 * 图谱视图：antv G6 力导向图，点击节点联动预览
 */
export default function KnowledgeBase({ onExit, onAtMention }) {
  const [roots, setRoots] = useState([]);
  const [rootIdx, setRootIdx] = useState(0);
  const [tree, setTree] = useState([]);
  const [view, setView] = useState("browse"); // browse | graph
  const [searchQ, setSearchQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState(null);
  const [doc, setDoc] = useState(null);
  const [graphData, setGraphData] = useState(null);
  const [graphInc, setGraphInc] = useState(["links", "similar"]);
  const [expanded, setExpanded] = useState({});
  const [copied, setCopied] = useState("");
  const [loading, setLoading] = useState(false);

  // IMA 云端
  const [imaOpen, setImaOpen] = useState(false);
  const [imaConfigured, setImaConfigured] = useState(false);
  const [imaBases, setImaBases] = useState([]);
  const [imaQ, setImaQ] = useState("");
  const [imaResults, setImaResults] = useState(null);
  const [imaDocView, setImaDocView] = useState(null);

  const rootName = useMemo(() => roots[rootIdx]?.name || "", [roots, rootIdx]);

  // 初始化
  useEffect(() => {
    (async () => {
      try {
        const st = await kbStatus();
        setRoots(st.roots || []);
        const i = await kbImaStatus();
        setImaConfigured(!!i.configured);
      } catch {}
    })();
  }, []);

  // 切换根目录 → 加载树 + 默认打开第一篇
  const loadRoot = useCallback(async (idx) => {
    setRootIdx(idx);
    setResults(null);
    setDoc(null);
    try {
      const t = await kbTree(idx);
      setTree(t.tree || []);
      // 自动打开第一篇文档
      const first = findFirstFile(t.tree || []);
      if (first) openDocByPath(first.relPath, idx);
    } catch {}
  }, []);

  useEffect(() => {
    if (roots.length > 0 && tree.length === 0 && doc === null) loadRoot(0);
  }, [roots, tree, doc, loadRoot]);

  const openDocByPath = useCallback(async (relPath, idx = rootIdx) => {
    setLoading(true);
    try {
      const d = await kbDoc(relPath, idx);
      setDoc(d);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [rootIdx]);

  // 搜索
  const doSearch = useCallback(async (q) => {
    const query = q.trim();
    if (!query) { setResults(null); return; }
    setSearching(true);
    try {
      const r = await kbSearch(query, rootIdx);
      setResults(r.results || []);
    } catch {}
    setSearching(false);
  }, [rootIdx]);

  // 图谱
  const loadGraph = useCallback(async () => {
    setLoading(true);
    try {
      const g = await kbGraph(rootIdx, graphInc, 800);
      setGraphData(g);
    } catch {}
    setLoading(false);
  }, [rootIdx, graphInc]);

  useEffect(() => {
    if (view === "graph" && !graphData) loadGraph();
  }, [view, graphData, loadGraph]);

  // 图谱点击节点 → 打开文档
  const handleGraphSelect = useCallback((node) => {
    if (node?.relPath) openDocByPath(node.relPath, node.rootIdx);
    else setDoc(null);
  }, [openDocByPath]);

  // @ 到对话
  const handleAtMention = useCallback(() => {
    if (!doc) return;
    const marker = `@知识库[${doc.relPath}@${rootName}]`;
    onAtMention?.(marker);
    setCopied(doc.title);
    setTimeout(() => setCopied(""), 1600);
  }, [doc, rootName, onAtMention]);

  // 添加/删除根目录
  const handleAddRoot = useCallback(async () => {
    const p = window.prompt("输入知识库根目录绝对路径（例如 F:\\Claude code本地文件\\义乌物流项目）");
    if (!p) return;
    try {
      const r = await kbAddRoot(p);
      const st = await kbStatus();
      setRoots(st.roots || []);
      if (r.ok && st.roots.length > 0) loadRoot(st.roots.length - 1);
    } catch (e) { alert("添加失败: " + e.message); }
  }, [loadRoot]);

  const handleRemoveRoot = useCallback(async (i) => {
    if (!window.confirm(`移除根目录「${roots[i]?.name}」？（仅移出索引，不删除文件）`)) return;
    try {
      await kbRemoveRoot(roots[i]?.path);
      const st = await kbStatus();
      setRoots(st.roots || []);
      setTree([]);
      setDoc(null);
      if (st.roots.length > 0) loadRoot(0);
    } catch (e) { alert("移除失败: " + e.message); }
  }, [roots, loadRoot]);

  // IMA
  const loadImaBases = useCallback(async () => {
    try {
      const r = await kbImaBases();
      if (r.ok) setImaBases(r.bases || []);
      else alert(r.error || "获取知识库列表失败");
    } catch {}
  }, []);
  const doImaSearch = useCallback(async () => {
    if (!imaQ.trim()) return;
    try {
      const r = await kbImaSearch(imaQ.trim(), "");
      if (r.ok) setImaResults(r.items || []);
      else alert(r.error || "搜索失败");
    } catch {}
  }, [imaQ]);
  const openImaDoc = useCallback(async (mediaId) => {
    try {
      const r = await kbImaDoc(mediaId);
      if (r.ok) setImaDocView(r);
      else alert(r.error || "获取内容失败");
    } catch {}
  }, []);

  // 渲染目录树
  const renderTree = (nodes, depth = 0) => (
    <ul className="kb-tree" style={{ paddingLeft: depth * 12 }}>
      {nodes.map((n) =>
        n.type === "dir" ? (
          <li key={"d" + n.name} className="kb-tree-item kb-tree-dir">
            <div className="kb-tree-row" onClick={() => setExpanded((e) => ({ ...e, [n.name]: !e[n.name] }))}>
              <span className="kb-tree-caret">{expanded[n.name] ? "▾" : "▸"}</span>
              <Icon name="folder" size={12} />
              <span className="kb-tree-label">{n.name}</span>
            </div>
            {expanded[n.name] && renderTree(n.children || [], depth + 1)}
          </li>
        ) : (
          <li key={"f" + n.name} className="kb-tree-item">
            <div
              className={"kb-tree-row" + (doc?.relPath === n.relPath ? " active" : "")}
              onClick={() => openDocByPath(n.relPath)}
              title={n.relPath}
            >
              <span className="kb-tree-caret" />
              <Icon name="md" size={12} />
              <span className="kb-tree-label">{n.name}</span>
            </div>
          </li>
        )
      )}
    </ul>
  );

  return (
    <div className="kb">
      {/* 顶栏 */}
      <div className="kb-topbar">
        <button className="btn-sm" onClick={onExit} title="返回办公模式">
          <Icon name="back" size={14} /> 返回
        </button>
        <span className="kb-title">知识库</span>
        <select
          className="kb-root-select"
          value={rootIdx}
          onChange={(e) => loadRoot(parseInt(e.target.value, 10))}
        >
          {roots.map((r, i) => (
            <option key={i} value={i}>{r.name}（{r.exists ? "" : "缺失"}）</option>
          ))}
        </select>
        <button className="btn-sm" onClick={handleAddRoot} title="添加知识库根目录"><Icon name="plus" size={12} /> 添加目录</button>
        {roots.length > 1 && (
          <button className="btn-sm" onClick={() => handleRemoveRoot(rootIdx)} title="移除当前根目录"><Icon name="trash" size={12} /></button>
        )}
        <div className="kb-search">
          <input
            placeholder="搜索知识库…"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doSearch(searchQ)}
          />
          <button className="btn-sm" onClick={() => doSearch(searchQ)} disabled={searching}>
            {searching ? "…" : <Icon name="search" size={12} />}
          </button>
          {searchQ && <button className="btn-sm" onClick={() => { setSearchQ(""); setResults(null); }} title="清除搜索">✕</button>}
        </div>
        <div className="kb-view-toggle">
          <button className={"btn-sm" + (view === "browse" ? " active" : "")} onClick={() => setView("browse")}>浏览</button>
          <button className={"btn-sm" + (view === "graph" ? " active" : "")} onClick={() => setView("graph")}>思维图谱</button>
        </div>
        <button className={"btn-sm kb-ima-btn" + (imaOpen ? " active" : "")} onClick={() => { setImaOpen((v) => !v); if (!imaOpen && !imaBases.length) loadImaBases(); }} title="IMA 云端知识库">
          <Icon name="cloud" size={13} /> IMA{imaConfigured ? "" : " ⚠"}
        </button>
      </div>

      {/* IMA 弹层 */}
      {imaOpen && (
        <div className="kb-ima-panel">
          <div className="kb-ima-head">
            <b>IMA 云端知识库</b>
            {!imaConfigured && (
              <span className="kb-ima-hint">
                未配置凭证：在 ima.qq.com/agent-interface 获取 ClientID/APIKey，写入 <code>~/.config/ima/client_id</code> 与 <code>api_key</code> 后刷新。
              </span>
            )}
          </div>
          <div className="kb-ima-search">
            <input placeholder="搜索云端知识库…" value={imaQ} onChange={(e) => setImaQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && doImaSearch()} />
            <button className="btn-sm" onClick={doImaSearch}>搜索</button>
          </div>
          {imaBases.length > 0 && <div className="kb-ima-bases">知识库：{imaBases.map((b) => <span key={b.id} className="tag">{b.name}</span>)}</div>}
          {imaResults && (
            <ul className="kb-ima-results">
              {imaResults.map((r) => (
                <li key={r.media_id} onClick={() => openImaDoc(r.media_id)}>
                  <b>{r.title || "(未命名)"}</b>
                  <div className="kb-ima-snippet">{r.snippet || ""}</div>
                </li>
              ))}
            </ul>
          )}
          {imaDocView && (
            <div className="kb-ima-doc">
              <div className="kb-ima-doc-head">
                <b>{imaDocView.title}</b>
                <button className="btn-sm" onClick={() => setImaDocView(null)}>关闭</button>
              </div>
              <pre>{imaDocView.content || imaDocView.url || "(该类型暂不支持预览原文)"}</pre>
            </div>
          )}
        </div>
      )}

      {view === "browse" ? (
        <div className="kb-body">
          {/* 左：树 / 搜索结果 */}
          <div className="kb-left">
            {results ? (
              <>
                <div className="kb-left-title">搜索结果（{results.length}）</div>
                <ul className="kb-results">
                  {results.map((r, i) => (
                    <li key={i} onClick={() => openDocByPath(r.relPath)} className={doc?.relPath === r.relPath ? "active" : ""}>
                      <div className="kb-result-title">{r.title}</div>
                      <div className="kb-result-snippet">{r.snippet}</div>
                      {r.tags.length > 0 && <div className="kb-result-tags">{r.tags.map((t) => <span key={t} className="tag">#{t}</span>)}</div>}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className="kb-tree-wrap">
                <div className="kb-left-title">{rootName} · {tree.length ? "" : "（空目录）"}</div>
                {renderTree(tree)}
              </div>
            )}
          </div>
          {/* 中：预览 */}
          <div className="kb-center">
            {loading && <div className="kb-loading">加载中…</div>}
            {!doc && !loading && <div className="kb-empty">← 从左侧选择一篇文档，或在图谱中点击节点</div>}
            {doc && (
              <>
                <div className="kb-doc-head">
                  <h2>{doc.title}</h2>
                  <div className="kb-doc-actions">
                    <button className="btn-sm primary" onClick={handleAtMention} title="插入 @ 引用到对话">
                      <Icon name="at" size={13} /> 到对话
                    </button>
                  </div>
                  {copied && <span className="kb-copied">已插入 @ 引用 ✓</span>}
                </div>
                {doc.tags.length > 0 && (
                  <div className="kb-doc-tags">{doc.tags.map((t) => <span key={t} className="tag">#{t}</span>)}</div>
                )}
                <div className="kb-doc-body">
                  <MarkdownBody>{doc.content}</MarkdownBody>
                </div>
              </>
            )}
          </div>
          {/* 右：文档信息 */}
          <div className="kb-right">
            {doc ? (
              <>
                <div className="kb-right-section">
                  <div className="kb-right-title">路径</div>
                  <div className="kb-meta-path">{doc.rootIdx !== undefined ? roots[doc.rootIdx]?.name + " / " : ""}{doc.relPath}</div>
                </div>
                <div className="kb-right-section">
                  <div className="kb-right-title">双向链接（{doc.links.length}）</div>
                  {doc.links.length === 0 && <div className="kb-meta-muted">无 [[链接]]</div>}
                  <ul className="kb-links">
                    {doc.links.map((l, i) => (
                      <li key={i} onClick={() => openDocByPath(l.relPath, l.rootIdx)} title={l.relPath}>
                        <Icon name="link" size={11} /> {l.alias || l.title}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="kb-right-section">
                  <div className="kb-right-title">反向链接（{doc.backlinks.length}）</div>
                  {doc.backlinks.length === 0 && <div className="kb-meta-muted">暂无引用</div>}
                  <ul className="kb-links">
                    {doc.backlinks.map((b, i) => (
                      <li key={i} onClick={() => openDocByPath(b.relPath, b.rootIdx)} title={b.relPath}>
                        <Icon name="backlink" size={11} /> {b.title}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="kb-right-section">
                  <div className="kb-right-title">标题结构</div>
                  <ul className="kb-headings">
                    {doc.headings.slice(0, 20).map((h, i) => <li key={i}>{h}</li>)}
                  </ul>
                </div>
              </>
            ) : (
              <div className="kb-right-empty">选择文档后显示链接与反链</div>
            )}
          </div>
        </div>
      ) : (
        <div className="kb-body kb-graph-body">
          <div className="kb-graph-toolbar">
            <span>节点关系</span>
            {["links", "similar", "tags", "folders"].map((t) => (
              <label key={t} className="kb-check">
                <input
                  type="checkbox"
                  checked={graphInc.includes(t)}
                  onChange={(e) => {
                    const inc = e.target.checked ? [...graphInc, t] : graphInc.filter((x) => x !== t);
                    setGraphInc(inc);
                    setGraphData(null);
                  }}
                />
                {t === "links" ? "双向链接" : t === "similar" ? "内容相似" : t === "tags" ? "标签" : "目录"}
              </label>
            ))}
            <button className="btn-sm" onClick={loadGraph} disabled={loading}>重新布局</button>
            <span className="kb-graph-meta">{graphData?.meta?.total ? `${graphData.meta.total} 篇文档` : ""}{graphData?.meta?.capped ? "（已截断）" : ""}</span>
          </div>
          {graphData ? (
            <KnowledgeGraph data={graphData} onSelectNode={handleGraphSelect} highlightId={doc ? `n${doc.rootIdx}/${doc.relPath}` : null} />
          ) : (
            <div className="kb-loading">图谱加载中…</div>
          )}
        </div>
      )}
    </div>
  );
}

function findFirstFile(nodes) {
  for (const n of nodes) {
    if (n.type === "file") return n;
  }
  for (const n of nodes) {
    if (n.type === "dir") {
      const r = findFirstFile(n.children || []);
      if (r) return r;
    }
  }
  return null;
}
