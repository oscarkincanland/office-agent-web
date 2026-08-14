import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Icon from "./Icon.jsx";
import MarkdownBody from "./MarkdownBody.jsx";
import KnowledgeGraph from "./KnowledgeGraph.jsx";
import MindMap from "./MindMap.jsx";
import {
  kbStatus, kbAddRoot, kbRemoveRoot, kbTree, kbSearch, kbGraph, kbDoc,
  kbImaStatus, kbImaBases, kbImaSearch, kbImaDoc,
} from "../api.js";

/**
 * 知识库全屏模式（Obsidian 风格）
 *
 * 布局：
 *   左栏（260px）：上=文件树/搜索，下=路径+标题结构（可拖拽分割）
 *   中栏：顶部 tab 栏 + Markdown 预览 或 图谱
 *   右栏（220px）：双向链接/反链 + @ 到对话
 *
 * @ 引用：点击「到对话」→ onExit 退出 kbMode → 延迟插入文本到 ChatPanel
 */
export default function KnowledgeBase({ onExit, onAtMention }) {
  const [roots, setRoots] = useState([]);
  const [rootIdx, setRootIdx] = useState(0);
  const [treeRoot, setTreeRoot] = useState(null); // 根级 {dirs, files}（懒加载）
  const [treeCache, setTreeCache] = useState({}); // dirPath -> {dirs, files}
  const [treeSort, setTreeSort] = useState("name"); // name | mtime
  const [view, setView] = useState("browse"); // browse | graph
  const [searchQ, setSearchQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState(null);
  const [graphData, setGraphData] = useState(null);
  const [graphInc, setGraphInc] = useState(["links", "tags"]);
  const [graphLocal, setGraphLocal] = useState(false); // 局部图谱（聚焦当前文档 1-hop）
  const [expanded, setExpanded] = useState({}); // 持久化（localStorage）
  const [backOpen, setBackOpen] = useState({}); // 反链展开上下文
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false); // 导出 Word 按钮的 loading

  // Obsidian tabs: {relPath, rootIdx, title}
  const [tabs, setTabs] = useState([]);
  const [activeTab, setActiveTab] = useState(null); // relPath key
  const [docCache, setDocCache] = useState({}); // relPath -> doc

  // 左栏分割比例（文件树 / 信息区）
  const [leftSplit, setLeftSplit] = useState(0.65); // 65% 给树，35% 给信息
  const [leftW, setLeftW] = useState(260);  // 左栏宽度（可拖拽）
  const [rightW, setRightW] = useState(240); // 右栏宽度（可拖拽）
  const paneDragRef = useRef(null);

  // 左右栏宽度拖拽
  const startPaneDrag = (e, side) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === "left" ? leftW : rightW;
    paneDragRef.current = { side, startX, startW };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev) => {
      const delta = ev.clientX - paneDragRef.current.startX;
      const next = Math.min(420, Math.max(180, paneDragRef.current.startW + (paneDragRef.current.side === "left" ? delta : -delta)));
      if (paneDragRef.current.side === "left") setLeftW(next);
      else setRightW(next);
    };
    const onUp = () => {
      paneDragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const leftRef = useRef(null);
  const splitDragRef = useRef(null);

  // IMA 云端
  const [imaOpen, setImaOpen] = useState(false);
  const [imaConfigured, setImaConfigured] = useState(false);
  const [imaBases, setImaBases] = useState([]);
  const [imaQ, setImaQ] = useState("");
  const [imaResults, setImaResults] = useState(null);
  const [imaDocView, setImaDocView] = useState(null);

  const rootName = useMemo(() => roots[rootIdx]?.name || "", [roots, rootIdx]);

  const currentDoc = useMemo(() => {
    if (!activeTab) return null;
    return docCache[activeTab] || null;
  }, [activeTab, docCache]);

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

  // 切换根目录 → 懒加载根级 + 恢复展开状态（seq 防快速切换竞态）
  const loadSeqRef = useRef(0);
  const loadRoot = useCallback(async (idx) => {
    const seq = ++loadSeqRef.current;
    setRootIdx(idx);
    setResults(null);
    setTabs([]);
    setActiveTab(null);
    setDocCache({});
    setTreeRoot(null);
    setTreeCache({});
    setExpanded({});
    try {
      const t = await kbTree(idx);
      if (seq !== loadSeqRef.current) return; // 已有更新的切换
      setTreeRoot(t);
      // 恢复展开状态（localStorage 持久化）
      try {
        const saved = JSON.parse(localStorage.getItem(`oaw_kb_expand_${idx}`) || "[]");
        if (Array.isArray(saved) && saved.length > 0) {
          const exp = {};
          for (const d of saved) exp[d] = true;
          setExpanded(exp);
          // 重新懒加载已展开目录的子级
          const c = {};
          await Promise.all(saved.map(async (d) => {
            try { c[d] = await kbTree(idx, d); } catch {}
          }));
          if (seq !== loadSeqRef.current) return;
          setTreeCache(c);
        }
      } catch {}
    } catch {}
  }, []);

  // 首次加载根 0（仅一次，避免 loadRoot 清空 treeRoot 时反复触发）
  const initRef = useRef(false);
  useEffect(() => {
    if (roots.length > 0 && !initRef.current) {
      initRef.current = true;
      loadRoot(0);
    }
  }, [roots, loadRoot]);

  // 懒加载指定目录子级
  const loadLevel = useCallback(async (dirPath) => {
    try {
      const lvl = await kbTree(rootIdx, dirPath || "");
      setTreeCache((prev) => ({ ...prev, [dirPath || ""]: lvl }));
    } catch {}
  }, [rootIdx]);

  // 展开/收起目录（展开时懒加载，状态持久化）
  const toggleDir = useCallback((dirPath) => {
    const isOpen = !!expanded[dirPath];
    setExpanded((prev) => {
      const next = { ...prev, [dirPath]: !isOpen };
      try {
        localStorage.setItem(`oaw_kb_expand_${rootIdx}`, JSON.stringify(Object.keys(next).filter((k) => next[k])));
      } catch {}
      return next;
    });
    if (!isOpen) loadLevel(dirPath);
  }, [expanded, rootIdx, loadLevel]);

  // 打开文档时自动展开祖先链（对齐 siyuan selectItem）
  const ensureVisible = useCallback(async (relPath) => {
    const parts = relPath.split("/");
    const dirs = parts.slice(0, -1);
    if (dirs.length === 0) return;
    const toOpen = {};
    const c = {};
    let cur = "";
    for (const d of dirs) {
      const next = cur ? `${cur}/${d}` : d;
      try {
        if (!(cur ? treeCache[cur] : treeRoot)) c[cur || ""] = await kbTree(rootIdx, cur || "");
      } catch {}
      toOpen[next] = true;
      cur = next;
    }
    if (Object.keys(c).length > 0) setTreeCache((prev) => ({ ...prev, ...c }));
    setExpanded((prev) => {
      const next = { ...prev, ...toOpen };
      try {
        localStorage.setItem(`oaw_kb_expand_${rootIdx}`, JSON.stringify(Object.keys(next).filter((k) => next[k])));
      } catch {}
      return next;
    });
  }, [treeCache, treeRoot, rootIdx]);

  // 面包屑导航：展开树到指定目录（复用 ensureVisible 祖先展开）
  const onDirNavigate = useCallback((dirPath) => {
    if (!dirPath) return;
    ensureVisible(dirPath + "/x.md");
  }, [ensureVisible]);

  // 选中文档滚动定位（对齐 siyuan setCurrent）
  useEffect(() => {
    if (!activeTab) return;
    const el = document.querySelector(".kb-tree-row.active");
    el?.scrollIntoView?.({ block: "center" });
  }, [activeTab]);

  // 打开文档（Obsidian tab 逻辑）
  const openDoc = useCallback(async (relPath, idx = rootIdx) => {
    const tabKey = relPath;
    // 已在缓存中 → 直接切 tab（并确保树中可见）
    if (docCache[tabKey]) {
      setActiveTab(tabKey);
      ensureVisible(relPath);
      return;
    }
    ensureVisible(relPath);
    setLoading(true);
    try {
      const d = await kbDoc(relPath, idx);
      if (!d) { setLoading(false); return; }
      setDocCache((prev) => ({ ...prev, [tabKey]: d }));
      setTabs((prev) => {
        if (prev.some((t) => t.relPath === tabKey)) return prev;
        return [...prev, { relPath: tabKey, rootIdx: idx, title: d.title }];
      });
      setActiveTab(tabKey);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [rootIdx, docCache, ensureVisible]);

  // 引用悬浮预览（siyuan 式）：hover [[目标]] → 读取目标文档并弹窗预览
  const [wikiPreview, setWikiPreview] = useState(null); // { title, snippet, x, y }
  const wikiTimerRef = useRef(null);
  const handleWikilinkHover = useCallback(async (target, e) => {
    const targetName = target.split("|")[0].trim();
    if (!targetName) return;
    const rect = e?.currentTarget?.getBoundingClientRect?.();
    // 延迟 400ms 再请求（避免快速扫过触发过多请求）
    if (wikiTimerRef.current) clearTimeout(wikiTimerRef.current);
    wikiTimerRef.current = setTimeout(async () => {
      try {
        // 目标可能是纯文件名或含路径；依次尝试 原名 / 原名+".md" / 文件名 / 文件名+".md"
        const base = targetName.split("/").pop();
        const candidates = [targetName, targetName.endsWith(".md") ? targetName : targetName + ".md", base, base.endsWith(".md") ? base : base + ".md"];
        let d = null;
        for (const p of candidates) {
          d = await kbDoc(p, rootIdx).catch(() => null);
          if (d) break;
        }
        if (d) {
          setWikiPreview({
            title: d.title || targetName,
            snippet: String(d.content || "").replace(/[#*_`>|]/g, "").slice(0, 260),
            x: rect?.left ?? 200,
            y: (rect?.bottom ?? 200) + 6,
          });
        }
      } catch {}
    }, 400);
  }, [rootIdx]);
  const hideWikiPreview = useCallback(() => {
    if (wikiTimerRef.current) clearTimeout(wikiTimerRef.current);
    setWikiPreview(null);
  }, []);

  // 关闭 tab
  const closeTab = useCallback((relPath) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.relPath === relPath);
      if (idx === -1) return prev;
      const next = prev.filter((t) => t.relPath !== relPath);
      if (activeTab === relPath) {
        const neighbor = next[Math.min(idx, next.length - 1)];
        setActiveTab(neighbor ? neighbor.relPath : null);
      }
      return next;
    });
    setDocCache((prev) => { const n = { ...prev }; delete n[relPath]; return n; });
  }, [activeTab]);

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

  // 图谱节点点击 → 文件打开 tab；tag 节点 → 搜索（对齐 siyuan 点击标签全局搜索）
  const handleGraphSelect = useCallback((node) => {
    if (!node) return;
    if (node.type === "tag") {
      const t = String(node.label || "").replace(/^#/, "");
      if (t) doSearch(t);
      return;
    }
    if (node.relPath) openDoc(node.relPath, node.rootIdx);
  }, [openDoc, doSearch]);

  // @ 到对话：累积标记（不立即退出，支持一次 @ 多个），返回时统一插入
  const [atMarks, setAtMarks] = useState([]);
  const addMark = useCallback((marker) => {
    setAtMarks((m) => [...m, marker]);
  }, []);
  const handleAtMention = useCallback(() => {
    if (!currentDoc) return;
    addMark(`@知识库[${currentDoc.relPath}@${rootName}]`);
  }, [currentDoc, rootName, addMark]);

  // 文件树行 @ 到对话（文件/文件夹均可，文件夹 @ 目录）
  const onAtMentionFromDoc = useCallback((relPath, isDir) => {
    if (isDir) {
      addMark(`@知识库目录[${relPath}@${rootName}]`);
    } else {
      addMark(`@知识库[${relPath}@${rootName}]`);
    }
  }, [rootName, addMark]);

  // 导出当前文档为 Word（服务端从 md 生成 docx，写入工作区）
  const handleExportDocx = useCallback(async () => {
    if (!currentDoc || exporting) return;
    setExporting(true);
    try {
      const r = await fetch("/api/kb/export-docx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relPath: currentDoc.relPath, rootIdx: currentDoc.rootIdx })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
      alert(`已导出：${data.name}（保存到工作区）`);
    } catch (err) {
      alert("导出失败: " + err.message);
    } finally {
      setExporting(false);
    }
  }, [currentDoc, exporting]);

  // 根目录管理
  const handleAddRoot = useCallback(async () => {
    const p = window.prompt("输入知识库根目录绝对路径（例如 F:\\Claude code本地文件\\义乌物流项目）");
    if (!p) return;
    try {
      await kbAddRoot(p);
      const st = await kbStatus();
      setRoots(st.roots || []);
      if (st.roots.length > 0) loadRoot(st.roots.length - 1);
    } catch (e) { alert("添加失败: " + e.message); }
  }, [loadRoot]);

  const handleRemoveRoot = useCallback(async (i) => {
    if (!window.confirm(`移除根目录「${roots[i]?.name}」？（仅移出索引，不删除文件）`)) return;
    try {
      await kbRemoveRoot(roots[i]?.path);
      const st = await kbStatus();
      setRoots(st.roots || []);
      if (st.roots.length > 0) loadRoot(0);
      else { setTree([]); setTabs([]); setActiveTab(null); setDocCache({}); }
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

  // 左栏下部分割拖拽
  const handleSplitMouseDown = useCallback((e) => {
    e.preventDefault();
    const el = leftRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const onMove = (ev) => {
      const y = ev.clientY - rect.top;
      const ratio = Math.max(0.3, Math.min(0.85, y / rect.height));
      setLeftSplit(ratio);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  // 渲染目录树（懒加载：按 treeCache/treeRoot 分层渲染）
  const sortLevel = useCallback((lvl) => {
    const dirs = [...(lvl?.dirs || [])].sort((a, b) => a.name.localeCompare(b.name, "zh"));
    const files = [...(lvl?.files || [])];
    if (treeSort === "mtime") files.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    else files.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    return { dirs, files };
  }, [treeSort]);

  const renderLevel = (dirPath) => {
    const lvl = dirPath ? treeCache[dirPath] : treeRoot;
    if (!lvl) return null;
    const { dirs, files } = sortLevel(lvl);
    return (
      <ul className="kb-tree" style={{ paddingLeft: dirPath ? 12 : 0 }}>
        {dirs.map((d) => (
          <li key={"d" + d.path} className="kb-tree-item kb-tree-dir">
            <div className="kb-tree-row" onClick={() => toggleDir(d.path)} title={d.name}>
              <span className="kb-tree-caret">{expanded[d.path] ? "▾" : "▸"}</span>
              <Icon name="folder" size={12} />
              <span className="kb-tree-label">{d.name}</span>
              {d.subCount > 0 && <span className="kb-tree-count" title={`${d.subCount} 个子项`}>{d.subCount}</span>}
              <span
                className="kb-tree-at"
                onClick={(e) => { e.stopPropagation(); onAtMentionFromDoc(d.path, true); }}
                title="@ 该文件夹到对话（agent 读取目录下所有文档）"
              >@</span>
            </div>
            {expanded[d.path] && renderLevel(d.path)}
          </li>
        ))}
        {files.map((f) => (
          <li key={"f" + f.relPath} className="kb-tree-item">
            <div
              className={"kb-tree-row" + (activeTab === f.relPath ? " active" : "")}
              onClick={() => openDoc(f.relPath)}
              title={f.relPath}
            >
              <span className="kb-tree-caret" />
              <Icon name="md" size={12} />
              <span className="kb-tree-label">{f.name}</span>
              {f.linkCount > 0 && <span className="kb-tree-count" title={`${f.linkCount} 条引用`}>{f.linkCount}</span>}
              <span
                className="kb-tree-at"
                onClick={(e) => { e.stopPropagation(); onAtMentionFromDoc(f.relPath, false); }}
                title="@ 到对话"
              >@</span>
            </div>
          </li>
        ))}
      </ul>
    );
  };

  const doc = currentDoc;

  return (
    <div className="kb">
      {/* 顶栏 */}
      <div className="kb-topbar">
        <button className="btn-sm" onClick={() => onExit?.(atMarks)} title="返回办公模式（@选中的内容将插入对话）">
          <Icon name="back" size={12} /> 返回{atMarks.length > 0 ? ` · @${atMarks.length}项` : ""}
        </button>
        <span className="kb-title">📚 知识库</span>
        <select className="kb-root-select" value={rootIdx} onChange={(e) => loadRoot(parseInt(e.target.value, 10))}>
          {roots.map((r, i) => (
            <option key={i} value={i}>{r.name}{r.exists ? "" : "（缺失）"}</option>
          ))}
        </select>
        <button className="btn-sm" onClick={handleAddRoot} title="添加知识库根目录"><Icon name="plus" size={12} /></button>
        {roots.length > 1 && <button className="btn-sm" onClick={() => handleRemoveRoot(rootIdx)} title="移除当前根目录"><Icon name="trash" size={12} /></button>}
        <div className="kb-search">
          <input placeholder="搜索知识库…" value={searchQ} onChange={(e) => setSearchQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doSearch(searchQ)} />
          <button className="btn-sm" onClick={() => doSearch(searchQ)} disabled={searching}>
            {searching ? "…" : <Icon name="search" size={12} />}
          </button>
          {searchQ && <button className="btn-sm" onClick={() => { setSearchQ(""); setResults(null); }}>✕</button>}
        </div>
        <div className="kb-view-toggle">
          <button className={"btn-sm" + (view === "browse" ? " active" : "")} onClick={() => setView("browse")}>浏览</button>
          <button className={"btn-sm" + (view === "graph" ? " active" : "")} onClick={() => setView("graph")}>思维图谱</button>
          <button className={"btn-sm" + (view === "mind" ? " active" : "")} onClick={() => setView("mind")}>脑图</button>
        </div>
        <button className={"btn-sm kb-ima-btn" + (imaOpen ? " active" : "")}
          onClick={() => { setImaOpen((v) => !v); if (!imaOpen && !imaBases.length) loadImaBases(); }}
          title="IMA 云端知识库"><Icon name="cloud" size={13} /> IMA{imaConfigured ? "" : " ⚠"}</button>
      </div>

      {/* IMA 弹层 */}
      {imaOpen && (
        <div className="kb-ima-panel">
          <div className="kb-ima-head">
            <b>IMA 云端知识库</b>
            {!imaConfigured && <span className="kb-ima-hint">未配置凭证：在 ima.qq.com/agent-interface 获取 ClientID/APIKey，写入 <code>~/.config/ima/client_id</code> 与 <code>api_key</code> 后刷新。</span>}
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
              <div className="kb-ima-doc-head"><b>{imaDocView.title}</b><button className="btn-sm" onClick={() => setImaDocView(null)}>关闭</button></div>
              <pre>{imaDocView.content || imaDocView.url || "(该类型暂不支持预览原文)"}</pre>
            </div>
          )}
        </div>
      )}

      {view === "browse" ? (
        <div className="kb-body">
          {/* ── 左栏：上=文件树/搜索，下=信息 ── */}
          <div className="kb-left" ref={leftRef} style={{ width: leftW, minWidth: leftW, maxWidth: leftW }}>
            {/* 上：树 / 搜索结果 */}
            <div className="kb-left-top" style={{ flex: `0 0 ${leftSplit * 100}%` }}>
              {results ? (
                <>
                  <div className="kb-left-title">搜索结果（{results.length}）</div>
                  <ul className="kb-results">
                    {results.map((r, i) => (
                      <li key={i} onClick={() => openDoc(r.relPath)} className={activeTab === r.relPath ? "active" : ""}>
                        <div className="kb-result-title">{r.title}</div>
                        <div className="kb-result-snippet">{r.snippet}</div>
                        {r.tags.length > 0 && <div className="kb-result-tags">{r.tags.map((t) => <span key={t} className="tag kb-tag-click" onClick={(e) => { e.stopPropagation(); doSearch(t); }}>#{t}</span>)}</div>}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  <div className="kb-left-title">
                    {rootName}{treeRoot ? "" : "（空目录）"}
                    <span className="kb-tree-sort" title="排序">
                      <select value={treeSort} onChange={(e) => setTreeSort(e.target.value)} onClick={(e) => e.stopPropagation()}>
                        <option value="name">按名称</option>
                        <option value="mtime">按修改时间</option>
                      </select>
                    </span>
                  </div>
                  <div className="kb-tree-wrap">{renderLevel("")}</div>
                </>
              )}
            </div>
            {/* 拖拽分割条 */}
            <div className="kb-split-handle" onMouseDown={handleSplitMouseDown} />
            {/* 下：当前文档信息（路径 + 标题结构 + 标签） */}
            <div className="kb-left-bottom">
              {doc ? (
                <>
                  <div className="kb-right-section">
                    <div className="kb-right-title">📄 {doc.title}</div>
                    <div className="kb-meta-path">{doc.rootIdx !== undefined ? roots[doc.rootIdx]?.name + " / " : ""}{doc.relPath}</div>
                    {doc.tags.length > 0 && <div className="kb-doc-tags">{doc.tags.map((t) => <span key={t} className="tag kb-tag-click" onClick={() => { setSearchQ(t); doSearch(t); }}>#{t}</span>)}</div>}
                  </div>
                  <div className="kb-right-section">
                    <div className="kb-right-title">标题结构</div>
                    <ul className="kb-headings">
                      {doc.headings.slice(0, 25).map((h, i) => <li key={i}>{h}</li>)}
                    </ul>
                  </div>
                </>
              ) : (
                <div className="kb-right-empty">选择文档后显示信息</div>
              )}
                </div>
          </div>
          {/* ── 中栏：tab 栏 + 预览 ── */}
          <div className="kb-center">
            {/* Obsidian tab 栏 */}
            {tabs.length > 0 && (
              <div className="kb-tabbar">
                {tabs.map((t) => (
                  <div key={t.relPath} className={"kb-tab" + (activeTab === t.relPath ? " active" : "")} onClick={() => setActiveTab(t.relPath)} title={t.relPath}>
                    <span className="kb-tab-title">{t.title}</span>
                    <span className="kb-tab-close" onClick={(e) => { e.stopPropagation(); closeTab(t.relPath); }}>✕</span>
                  </div>
                ))}
              </div>
            )}
            {loading && <div className="kb-loading">加载中…</div>}
            {!doc && !loading && <div className="kb-empty">← 从左侧选择一篇文档，或在图谱中点击节点</div>}
            {doc && !loading && (
              <div className="kb-doc-body">
                {/* 标题栏 + 面包屑（对齐 siyuan Title + Breadcrumb） */}
                <div className="kb-doc-titlebar">
                  <div className="kb-doc-titlebar-head">
                    <h2 className="kb-doc-title">{doc.title}</h2>
                    <button
                      className="btn-sm kb-export-btn"
                      onClick={handleExportDocx}
                      disabled={exporting}
                      title="导出为 Word 文档（保存到工作区）"
                    >
                      <Icon name="download" size={12} /> {exporting ? "导出中…" : "导出 Word"}
                    </button>
                  </div>
                  <div className="kb-doc-breadcrumb">
                    <span className="kb-crumb" onClick={() => onDirNavigate("")} title={rootName}>{rootName}</span>
                    {doc.relPath.split("/").slice(0, -1).map((d, i, arr) => {
                      const dirPath = arr.slice(0, i + 1).join("/");
                      return (
                        <span key={dirPath}>
                          <span className="kb-crumb-sep">/</span>
                          <span className="kb-crumb" onClick={() => onDirNavigate(dirPath)}>{d}</span>
                        </span>
                      );
                    })}
                    <span className="kb-crumb-sep">/</span>
                    <span className="kb-crumb-current">{doc.relPath.split("/").pop()}</span>
                  </div>
                </div>
                <MarkdownBody
                  onTagClick={(t) => { setSearchQ(t); doSearch(t); }}
                  onWikilinkHover={handleWikilinkHover}
                >{doc.content}</MarkdownBody>
                {/* 文档底部反链区块（siyuan 式：正文下方显示引用来源） */}
                {(doc.backlinks?.length > 0 || doc.mentions?.length > 0) && (
                  <div className="kb-doc-backlinks">
                    <div className="kb-doc-backlinks-title">
                      <Icon name="backlink" size={12} /> 反向链接（{doc.backlinks.length}）· 提及（{doc.mentions?.length || 0}）
                    </div>
                    {doc.backlinks.length > 0 && (
                      <ul className="kb-doc-backlinks-list">
                        {doc.backlinks.slice(0, 12).map((b, i) => (
                          <li key={i} className="kb-doc-backlink-item" onClick={() => openDoc(b.relPath, b.rootIdx)} title={b.snippet}>
                            <span className="kb-backlink-title">{b.title}</span>
                            <span className="kb-backlink-snippet">{b.snippet}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {doc.mentions?.length > 0 && (
                      <ul className="kb-doc-backlinks-list">
                        {doc.mentions.slice(0, 6).map((m, i) => (
                          <li key={"m" + i} className="kb-doc-backlink-item" onClick={() => openDoc(m.relPath, m.rootIdx)} title={m.snippet}>
                            <span className="kb-backlink-title">{m.title} <span className="kb-backlink-tag">提及</span></span>
                            <span className="kb-backlink-snippet">{m.snippet}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="kb-hresize left" onMouseDown={(e) => startPaneDrag(e, "left")} title="拖动调整左栏宽度" />
          {/* ── 右栏：链接 + @ 到对话 ── */}
          <div className="kb-right" style={{ width: rightW, minWidth: rightW, maxWidth: rightW }}>
            {doc ? (
              <>
                <div className="kb-right-section">
                  <button className="btn-sm primary kb-at-btn" onClick={handleAtMention} title="插入 @ 引用到对话（会返回办公模式）">
                    <Icon name="at" size={13} /> @ 到对话
                  </button>
                </div>
                <div className="kb-right-section">
                  <div className="kb-right-title">双向链接（{doc.links.length}）</div>
                  {doc.links.length === 0 && <div className="kb-meta-muted">无 [[链接]]</div>}
                  <ul className="kb-links">
                    {doc.links.map((l, i) => (
                      <li key={i} onClick={() => openDoc(l.relPath, l.rootIdx)} title={l.relPath}>
                        <Icon name="link" size={11} /> {l.alias || l.title}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="kb-right-section">
                  <div className="kb-right-title">反向链接（{doc.backlinks.length}）</div>
                  {doc.backlinks.length === 0 && <div className="kb-meta-muted">暂无引用</div>}
                  <ul className="kb-links kb-backlinks">
                    {doc.backlinks.map((b, i) => (
                      <li key={i} className={backOpen[b.relPath] ? "open" : ""}>
                        <div className="kb-backlink-title" onClick={() => openDoc(b.relPath, b.rootIdx)} title={b.relPath}>
                          <Icon name="backlink" size={11} /> {b.title}
                        </div>
                        {b.snippet && (
                          <div
                            className="kb-backlink-snippet"
                            onClick={(e) => { e.stopPropagation(); setBackOpen((o) => ({ ...o, [b.relPath]: !o[b.relPath] })); }}
                            title={backOpen[b.relPath] ? "收起" : "展开引用上下文"}
                          >
                            {backOpen[b.relPath] ? b.snippet : (b.snippet.length > 40 ? b.snippet.slice(0, 40) + "…" : b.snippet)}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="kb-right-section">
                  <div className="kb-right-title">提及（{doc.mentions?.length || 0}）</div>
                  {(doc.mentions?.length || 0) === 0 && <div className="kb-meta-muted">正文出现但未建链接</div>}
                  <ul className="kb-links kb-backlinks">
                    {(doc.mentions || []).map((m, i) => (
                      <li key={i} className={backOpen["m" + m.relPath] ? "open" : ""}>
                        <div className="kb-backlink-title" onClick={() => openDoc(m.relPath, m.rootIdx)} title={m.relPath}>
                          <Icon name="file" size={11} /> {m.title}
                        </div>
                        {m.snippet && (
                          <div
                            className="kb-backlink-snippet"
                            onClick={(e) => { e.stopPropagation(); setBackOpen((o) => ({ ...o, ["m" + m.relPath]: !o["m" + m.relPath] })); }}
                            title={backOpen["m" + m.relPath] ? "收起" : "展开提及上下文"}
                          >
                            {backOpen["m" + m.relPath] ? m.snippet : (m.snippet.length > 40 ? m.snippet.slice(0, 40) + "…" : m.snippet)}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : (
              <div className="kb-right-empty">选择文档后显示链接</div>
            )}
          </div>
          <div className="kb-hresize right" onMouseDown={(e) => startPaneDrag(e, "right")} title="拖动调整右栏宽度" />
        </div>
      ) : view === "mind" ? (
        <MindMap
          roots={roots}
          onSelectDoc={(relPath, idx) => openDoc(relPath, idx)}
          highlightPath={currentDoc?.relPath}
          rootIdx={rootIdx}
          doc={currentDoc}
        />
      ) : (
        <div className="kb-body kb-graph-body">
          <div className="kb-graph-toolbar">
            <span>节点关系</span>
            {["links", "similar", "tags", "folders"].map((t) => (
              <label key={t} className="kb-check">
                <input type="checkbox" checked={graphInc.includes(t)}
                  onChange={(e) => { setGraphInc(e.target.checked ? [...graphInc, t] : graphInc.filter((x) => x !== t)); setGraphData(null); }} />
                {t === "links" ? "双向链接" : t === "similar" ? "内容相似" : t === "tags" ? "标签" : "目录"}
              </label>
            ))}
            <button className="btn-sm" onClick={loadGraph} disabled={loading}>重新布局</button>
            <button
              className={"btn-sm" + (graphLocal && doc ? " active" : "")}
              onClick={() => setGraphLocal((v) => !v)}
              disabled={!doc}
              title={graphLocal ? "退出局部图谱，显示全图" : "仅显示当前文档的直接关联（1-hop 局部图）"}
            >{graphLocal ? "全图" : "局部图谱"}</button>
            <span className="kb-graph-meta">{graphData?.meta?.total ? `${graphData.meta.total} 篇文档` : ""}{graphData?.meta?.capped ? "（已截断）" : ""}</span>
          </div>
          {graphData ? (
            <KnowledgeGraph data={graphData} onSelectNode={handleGraphSelect} highlightId={doc ? `n${doc.rootIdx}/${doc.relPath}` : null} focusId={graphLocal && doc ? `n${doc.rootIdx}/${doc.relPath}` : null} />
          ) : (
            <div className="kb-loading">图谱加载中…</div>
          )}
        </div>
      )}

      {/* 引用悬浮预览弹窗（siyuan 式） */}
      {wikiPreview && (
        <div
          className="kb-wiki-preview"
          style={{ left: Math.min(wikiPreview.x, window.innerWidth - 320), top: wikiPreview.y }}
          onMouseEnter={() => { if (wikiTimerRef.current) clearTimeout(wikiTimerRef.current); }}
          onMouseLeave={hideWikiPreview}
        >
          <div className="kb-wiki-preview-title">{wikiPreview.title}</div>
          <div className="kb-wiki-preview-snippet">{wikiPreview.snippet}</div>
        </div>
      )}
    </div>
  );
}
