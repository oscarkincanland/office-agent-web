import React, { useState, useCallback, useEffect, useRef } from "react";
import MarkdownBody from "./MarkdownBody.jsx";
import MarkdownToc from "./MarkdownToc.jsx";
import ExcelGrid from "./ExcelGrid.jsx";
import DocxViewer from "./DocxViewer.jsx";
import PptxViewer from "./PptxViewer.jsx";
import CommentMarker from "./CommentMarker.jsx";
import Icon from "./Icon.jsx";

const ICONS = { docx: "doc", xlsx: "xls", pptx: "ppt", md: "md", html: "html", htm: "html", txt: "txt", pdf: "pdf" };
const ANNO_SAVE_DEBOUNCE = 800;

// 在 iframe 文档的 body 中查找首个匹配 text 的文本节点并按 wrapType 包裹
function wrapFirstTextMatch(rootDoc, text, wrapType, note) {
  if (!rootDoc || !rootDoc.body || !text) return false;
  const className = wrapType === "highlight" ? "oa-anno-hl" : "oa-anno-cm";
  const tag = wrapType === "highlight" ? "mark" : "u";
  const walker = rootDoc.createTreeWalker(rootDoc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.includes(text)) return NodeFilter.FILTER_REJECT;
      // 已包裹则跳过（防止重复包裹）
      let p = node.parentNode;
      while (p && p !== rootDoc.body) {
        if (p.nodeType === 1 && p.classList) {
          if (p.classList.contains("oa-anno-hl") || p.classList.contains("oa-anno-cm")) {
            return NodeFilter.FILTER_REJECT;
          }
        }
        p = p.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node = walker.nextNode();
  if (!node) return false;
  const idx = node.nodeValue.indexOf(text);
  if (idx < 0) return false;
  const range = rootDoc.createRange();
  try {
    range.setStart(node, idx);
    range.setEnd(node, idx + text.length);
    const wrap = rootDoc.createElement(tag);
    wrap.className = className;
    if (wrapType === "comment" && note) wrap.title = note;
    range.surroundContents(wrap);
    return true;
  } catch (e) {
    return false;
  }
}

// 在 iframe load 时按 annotations 列表逐个恢复 DOM 包裹
function restoreAnnotationsInDoc(rootDoc, annotations) {
  if (!rootDoc || !rootDoc.body || !annotations || !annotations.length) return;
  for (const a of annotations) {
    if (!a || !a.text) continue;
    if (a.type === "highlight") {
      wrapFirstTextMatch(rootDoc, a.text, "highlight", null);
    } else if (a.type === "comment") {
      wrapFirstTextMatch(rootDoc, a.text, "comment", a.note || "");
    }
  }
}

// 把 range.getBoundingClientRect() 转换为 iframe 父容器 (docframe-container) 内的坐标
function selectionToContainerCoords(iframe, range) {
  if (!iframe || !range) return null;
  const container = iframe.parentElement;
  if (!container) return null;
  const iframeRect = iframe.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const r = range.getBoundingClientRect();
  return {
    x: iframeRect.left - containerRect.left + r.left,
    y: iframeRect.top - containerRect.top + (r.top - iframeRect.height > 0 ? 0 : r.top), // 选区在 iframe 视口内
    width: r.width,
    height: r.height,
  };
}

// 单文件内容渲染
function DocContent({ doc, loading, onRefresh, onSendToAgent }) {
  const [watchUrl, setWatchUrl] = useState(null);
  const [watchLoading, setWatchLoading] = useState(false);
  const [watchErr, setWatchErr] = useState("");
  const [comments, setComments] = useState([]);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentsLoading, setCommentsLoading] = useState(false);

  // 标注模式相关状态
  const [annoMode, setAnnoMode] = useState(false);
  const [annotations, setAnnotations] = useState([]);
  const [annoLoaded, setAnnoLoaded] = useState(false); // 服务端 annotations 已加载
  const [iframeReady, setIframeReady] = useState(false); // iframe 已 onload
  const [annoToolbar, setAnnoToolbar] = useState(null); // {x,y,text}
  const [annoInput, setAnnoInput] = useState(null); // {mode:'comment'|'agent', text, value}

  const iframeReadyRef = useRef(false);
  const saveTimerRef = useRef(null);
  const lastSavedJsonRef = useRef("[]");

  const isHtmlKind = doc?.kind === "html" || doc?.kind === "htmlfile";

  const fetchComments = useCallback(async () => {
    if (!doc) return;
    setCommentsLoading(true);
    try {
      const r = await fetch(`/api/doc/${encodeURIComponent(doc.name)}/comments`);
      const d = await r.json();
      setComments(d.comments || []);
    } catch (e) {
      console.error("获取批注失败:", e);
    }
    setCommentsLoading(false);
  }, [doc]);

  // 切换/打开文件时重置标注状态 + 加载服务端 annotations
  useEffect(() => {
    setWatchUrl(null);
    setWatchLoading(false);
    setWatchErr("");
    setComments([]);
    setCommentsOpen(false);
    setAnnoMode(false);
    setAnnoToolbar(null);
    setAnnoInput(null);
    setAnnoLoaded(false);
    setIframeReady(false);
    iframeReadyRef.current = false;
    lastSavedJsonRef.current = "[]";
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    if (doc?.kind === "html" || doc?.kind === "text") {
      fetchComments();
    }
    if (isHtmlKind) {
      fetch(`/api/doc/${encodeURIComponent(doc.name)}/annotations`)
        .then((r) => r.json())
        .then((d) => {
          const list = d.annotations || [];
          setAnnotations(list);
          setAnnoLoaded(true);
          lastSavedJsonRef.current = JSON.stringify(list);
        })
        .catch((e) => console.error("加载标注失败:", e));
    } else {
      setAnnotations([]);
      setAnnoLoaded(true);
    }
  }, [doc?.name, doc?.kind, fetchComments, isHtmlKind]);

  const startLive = useCallback(async () => {
    if (!doc) return;
    setWatchLoading(true);
    setWatchErr("");
    try {
      const r = await fetch(`/api/doc/${encodeURIComponent(doc.name)}/watch`).then((x) => x.json());
      if (r.ok) {
        setWatchUrl(r.url);
      } else {
        setWatchErr(r.error || "启动实时预览失败");
      }
    } catch (e) {
      setWatchErr("网络错误: " + e.message);
    }
    setWatchLoading(false);
  }, [doc]);

  const mdContentRef = useRef(null);
  const htmlFrameRef = useRef(null);
  const [showComments, setShowComments] = useState(false);
  const [activeComment, setActiveComment] = useState(null);

  // annotations 变化 → 防抖保存
  useEffect(() => {
    if (!isHtmlKind || !annoLoaded) return;
    const json = JSON.stringify(annotations);
    if (json === lastSavedJsonRef.current) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      lastSavedJsonRef.current = json;
      fetch(`/api/doc/${encodeURIComponent(doc.name)}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ annotations }),
      }).catch((e) => console.error("保存标注失败:", e));
    }, ANNO_SAVE_DEBOUNCE);
  }, [annotations, doc, isHtmlKind, annoLoaded]);

  // iframe onload → 标记 ready → 触发恢复（若 annotations 已加载）
  const handleIframeLoad = useCallback(() => {
    iframeReadyRef.current = true;
    setIframeReady(true);
  }, []);

  // ready + annotations 变化都触发恢复（首次 + 新增项）
  useEffect(() => {
    if (!iframeReady || !annoLoaded || !isHtmlKind) return;
    const iframe = htmlFrameRef.current;
    if (!iframe) return;
    let doc;
    try {
      doc = iframe.contentDocument;
    } catch (e) {
      return;
    }
    if (!doc || !doc.body) return;
    // 等 body 就绪（srcDoc 下可能下一帧才解析完）
    const restore = () => restoreAnnotationsInDoc(doc, annotations);
    // 恢复函数本身有"已包裹跳过"逻辑，重复调用安全
    restore();
    // 下一次微任务再补一次，规避某些浏览器首次挂载时机问题
    const raf = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(raf);
  }, [iframeReady, annoLoaded, annotations, isHtmlKind]);

  // 标注模式开启 → 在 iframe 文档内绑定 mouseup/scroll 监听
  useEffect(() => {
    if (!annoMode || !isHtmlKind) {
      setAnnoToolbar(null);
      setAnnoInput(null);
      return;
    }
    const iframe = htmlFrameRef.current;
    if (!iframe) return;
    let innerDoc;
    try {
      innerDoc = iframe.contentDocument;
    } catch (e) {
      return;
    }
    if (!innerDoc || !innerDoc.body) return;

    const onMouseUp = () => {
      const sel = innerDoc.getSelection ? innerDoc.getSelection() : null;
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setAnnoToolbar(null);
        return;
      }
      const text = sel.toString();
      if (!text || !text.trim()) {
        setAnnoToolbar(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const coords = selectionToContainerCoords(iframe, range);
      if (!coords) {
        setAnnoToolbar(null);
        return;
      }
      setAnnoInput(null);
      setAnnoToolbar({ ...coords, text: text.trim() });
    };

    const onScroll = () => {
      setAnnoToolbar(null);
      setAnnoInput(null);
    };

    const onIframeWinScroll = () => {
      setAnnoToolbar(null);
      setAnnoInput(null);
    };

    innerDoc.addEventListener("mouseup", onMouseUp);
    innerDoc.addEventListener("scroll", onScroll, true);
    if (iframe.contentWindow) {
      iframe.contentWindow.addEventListener("scroll", onIframeWinScroll, true);
    }

    return () => {
      innerDoc.removeEventListener("mouseup", onMouseUp);
      innerDoc.removeEventListener("scroll", onScroll, true);
      if (iframe.contentWindow) {
        iframe.contentWindow.removeEventListener("scroll", onIframeWinScroll, true);
      }
    };
  }, [annoMode, isHtmlKind]);

  // 标注模式切换（关闭时清空工具条）
  const toggleAnnoMode = useCallback(() => {
    setAnnoMode((v) => {
      if (v) {
        setAnnoToolbar(null);
        setAnnoInput(null);
      }
      return !v;
    });
  }, []);

  // 高亮：包 mark.oa-anno-hl
  const handleHighlight = useCallback(() => {
    if (!annoToolbar) return;
    const iframe = htmlFrameRef.current;
    if (!iframe) return;
    let innerDoc;
    try {
      innerDoc = iframe.contentDocument;
    } catch (e) {
      return;
    }
    if (!innerDoc) return;
    const sel = innerDoc.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    try {
      const wrap = innerDoc.createElement("mark");
      wrap.className = "oa-anno-hl";
      range.surroundContents(wrap);
      sel.removeAllRanges();
      const newAnno = {
        id: `${Date.now()}-h${Math.random().toString(36).slice(2, 6)}`,
        type: "highlight",
        text: annoToolbar.text,
        created: Date.now(),
      };
      setAnnotations((prev) => [...prev, newAnno]);
      setAnnoToolbar(null);
    } catch (e) {
      console.warn("高亮包裹失败（选区可能跨元素）:", e);
    }
  }, [annoToolbar]);

  // 进入批注输入态
  const handleCommentClick = useCallback(() => {
    if (!annoToolbar) return;
    setAnnoInput({ mode: "comment", text: annoToolbar.text, value: "" });
  }, [annoToolbar]);

  // 进入交给 agent 输入态
  const handleAgentClick = useCallback(() => {
    if (!annoToolbar) return;
    setAnnoInput({ mode: "agent", text: annoToolbar.text, value: "" });
  }, [annoToolbar]);

  // 提交内联输入
  const submitInput = useCallback(() => {
    if (!annoInput) return;
    const val = (annoInput.value || "").trim();
    if (annoInput.mode === "comment") {
      if (!val) {
        setAnnoInput(null);
        setAnnoToolbar(null);
        return;
      }
      const iframe = htmlFrameRef.current;
      let innerDoc;
      try {
        innerDoc = iframe?.contentDocument;
      } catch (e) {}
      if (innerDoc) {
        const sel = innerDoc.getSelection();
        if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
          const range = sel.getRangeAt(0);
          let wrapped = false;
          // 尝试直接包裹 u.oa-anno-cm
          try {
            const wrap = innerDoc.createElement("u");
            wrap.className = "oa-anno-cm";
            wrap.title = val;
            range.surroundContents(wrap);
            wrapped = true;
          } catch (e) {
            // 选区可能跨元素或已被高亮包裹；尝试退而求其次
            try {
              const wrap = innerDoc.createElement("u");
              wrap.className = "oa-anno-cm";
              wrap.title = val;
              wrap.textContent = annoInput.text;
              range.extractContents();
              range.insertNode(wrap);
              wrapped = true;
            } catch (e2) {
              console.warn("批注包裹失败:", e2);
            }
          }
          if (wrapped) sel.removeAllRanges();
        }
      }
      const newAnno = {
        id: `${Date.now()}-c${Math.random().toString(36).slice(2, 6)}`,
        type: "comment",
        text: annoInput.text,
        note: val,
        created: Date.now(),
      };
      setAnnotations((prev) => [...prev, newAnno]);
    } else if (annoInput.mode === "agent") {
      if (!val) {
        setAnnoInput(null);
        setAnnoToolbar(null);
        return;
      }
      if (onSendToAgent) {
        const msg = `在当前打开的 ${doc.name} 中，对选中内容「${annoInput.text}」做修改：${val}`;
        try {
          onSendToAgent(msg);
        } catch (e) {
          console.error("onSendToAgent 调用失败:", e);
        }
      }
    }
    setAnnoInput(null);
    setAnnoToolbar(null);
  }, [annoInput, doc, onSendToAgent]);

  if (loading && !doc.kind) {
    return (
      <div className="docview-body">
        <div className="empty-view">
          <div className="loading-spinner"></div>
          <div>正在加载文件...</div>
        </div>
      </div>
    );
  }

  // 浮动工具条按钮样式辅助
  const agentDisabled = !onSendToAgent;

  return (
    <>
      <div className="docview-head">
        <span className="doc-title">{doc.name}</span>
        {doc.kind === "html" && (
          <>
            <span className="badge">{watchUrl ? "实时预览" : "静态预览"}</span>
            {!watchUrl && (
              <button className="btn-sm" onClick={startLive} disabled={watchLoading}>
                {watchLoading ? "启动中..." : "开启实时预览"}
              </button>
            )}
            {watchUrl && (
              <button className="btn-sm" onClick={() => setWatchUrl(null)}>静态预览</button>
            )}
          </>
        )}
        {doc.kind === "xlsx" && <span className="badge">可编辑</span>}
        {doc.kind === "htmlfile" && <span className="badge">HTML 页面</span>}
        {doc.kind === "text" && <span className="badge">{doc.ext === "md" || doc.ext === "markdown" ? "Markdown" : "文本"}</span>}
        {isHtmlKind && (
          <button
            className={`btn-sm oa-anno-toggle ${annoMode ? "active" : ""}`}
            onClick={toggleAnnoMode}
            title="标注模式：划词高亮/批注"
          >
            <Icon name={annoMode ? "pin" : "comment"} size={12} />
            {annoMode ? "退出标注" : "标注"}
          </button>
        )}
        {(doc.kind === "html" || doc.kind === "text") && (
          <>
            <button
              className="btn-sm"
              onClick={fetchComments}
              disabled={commentsLoading}
              title="刷新批注"
            >
              <Icon name={commentsLoading ? "loading" : "refresh"} size={12} />
            </button>
            <button
              className={`btn-sm comment-btn ${showComments ? "active" : ""}`}
              onClick={() => setShowComments(!showComments)}
            >
              <Icon name="comment" size={12} /> 批注 ({comments.length})
            </button>
          </>
        )}
        {watchErr && <span className="badge err-badge"><Icon name="warning" size={11} /> {watchErr}</span>}
        {watchUrl && <span className="badge ws-hint">可点选元素，配合右侧 agent 修改</span>}
      </div>
      {commentsOpen && comments.length > 0 && !showComments && (
        <div className="comments-panel">
          <div className="comments-head">文档批注</div>
          {comments.map((c, i) => (
            <div className="comment-item" key={i}>
              <div className="comment-meta">
                <span className="comment-author">{c.author || "匿名"}</span>
                {c.date && <span className="comment-date">{String(c.date).slice(0, 10)}</span>}
              </div>
              <div className="comment-text">{c.text}</div>
              {c.path && <div className="comment-path">{c.path}</div>}
            </div>
          ))}
        </div>
      )}
      <div className="docview-body">
        {doc.kind === "html" && doc.ext === "docx" && (
          <DocxViewer name={doc.name} />
        )}
        {doc.kind === "html" && doc.ext === "pptx" && (
          <PptxViewer name={doc.name} />
        )}
        {doc.kind === "html" && doc.ext !== "docx" && doc.ext !== "pptx" && (
          <div className="docframe-container">
            <iframe
              ref={htmlFrameRef}
              title={doc.name}
              src={watchUrl || doc.url}
              className="docframe"
              onLoad={handleIframeLoad}
            />
            {annoMode && annoToolbar && !annoInput && (
              <div
                className="oa-anno-toolbar"
                style={{
                  left: Math.max(0, annoToolbar.x),
                  top: Math.max(0, annoToolbar.y - 36),
                }}
                onMouseDown={(e) => e.preventDefault()}
              >
                <button className="oa-anno-btn" onClick={handleHighlight} title="高亮">
                  <Icon name="penTool" size={12} />
                  <span>高亮</span>
                </button>
                <button className="oa-anno-btn" onClick={handleCommentClick} title="批注">
                  <Icon name="comment" size={12} />
                  <span>批注</span>
                </button>
                <button
                  className="oa-anno-btn"
                  onClick={handleAgentClick}
                  disabled={agentDisabled}
                  title={agentDisabled ? "未连接 agent" : "交给 agent"}
                >
                  <Icon name="robot" size={12} />
                  <span>交给agent</span>
                </button>
              </div>
            )}
            {annoMode && annoInput && (
              <div
                className="oa-anno-input"
                style={{
                  left: Math.max(0, annoToolbar?.x ?? 0),
                  top: Math.max(0, (annoToolbar?.y ?? 0) - 56),
                }}
                onMouseDown={(e) => e.preventDefault()}
              >
                <div className="oa-anno-input-head">
                  {annoInput.mode === "comment" ? "添加批注" : "交给 agent 的指令"}
                </div>
                <div className="oa-anno-input-body">
                  <input
                    type="text"
                    autoFocus
                    value={annoInput.value}
                    placeholder={annoInput.mode === "comment" ? "写下你的批注..." : "例如：把这段改成红色加粗"}
                    onChange={(e) =>
                      setAnnoInput((prev) => (prev ? { ...prev, value: e.target.value } : prev))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitInput();
                      else if (e.key === "Escape") {
                        setAnnoInput(null);
                        setAnnoToolbar(null);
                      }
                    }}
                  />
                  <button className="oa-anno-btn oa-anno-primary" onClick={submitInput}>
                    确定
                  </button>
                </div>
                <div className="oa-anno-input-hint">
                  选中：「{annoInput.text.slice(0, 30)}{annoInput.text.length > 30 ? "..." : ""}」
                </div>
              </div>
            )}
            {showComments && comments.length > 0 && (
              <CommentMarker
                comments={comments}
                containerRef={htmlFrameRef}
                activeComment={activeComment}
                setActiveComment={setActiveComment}
              />
            )}
          </div>
        )}
        {doc.kind === "xlsx" && <ExcelGrid name={doc.name} sheets={doc.sheets} grids={doc.grids} />}
        {doc.kind === "htmlfile" && (
          <div className="docframe-container">
            <iframe
              ref={htmlFrameRef}
              title={doc.name}
              srcDoc={doc.content || ""}
              className="docframe"
              sandbox="allow-scripts allow-same-origin"
              onLoad={handleIframeLoad}
            />
            {annoMode && annoToolbar && !annoInput && (
              <div
                className="oa-anno-toolbar"
                style={{
                  left: Math.max(0, annoToolbar.x),
                  top: Math.max(0, annoToolbar.y - 36),
                }}
                onMouseDown={(e) => e.preventDefault()}
              >
                <button className="oa-anno-btn" onClick={handleHighlight} title="高亮">
                  <Icon name="penTool" size={12} />
                  <span>高亮</span>
                </button>
                <button className="oa-anno-btn" onClick={handleCommentClick} title="批注">
                  <Icon name="comment" size={12} />
                  <span>批注</span>
                </button>
                <button
                  className="oa-anno-btn"
                  onClick={handleAgentClick}
                  disabled={agentDisabled}
                  title={agentDisabled ? "未连接 agent" : "交给 agent"}
                >
                  <Icon name="robot" size={12} />
                  <span>交给agent</span>
                </button>
              </div>
            )}
            {annoMode && annoInput && (
              <div
                className="oa-anno-input"
                style={{
                  left: Math.max(0, annoToolbar?.x ?? 0),
                  top: Math.max(0, (annoToolbar?.y ?? 0) - 56),
                }}
                onMouseDown={(e) => e.preventDefault()}
              >
                <div className="oa-anno-input-head">
                  {annoInput.mode === "comment" ? "添加批注" : "交给 agent 的指令"}
                </div>
                <div className="oa-anno-input-body">
                  <input
                    type="text"
                    autoFocus
                    value={annoInput.value}
                    placeholder={annoInput.mode === "comment" ? "写下你的批注..." : "例如：把这段改成红色加粗"}
                    onChange={(e) =>
                      setAnnoInput((prev) => (prev ? { ...prev, value: e.target.value } : prev))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitInput();
                      else if (e.key === "Escape") {
                        setAnnoInput(null);
                        setAnnoToolbar(null);
                      }
                    }}
                  />
                  <button className="oa-anno-btn oa-anno-primary" onClick={submitInput}>
                    确定
                  </button>
                </div>
                <div className="oa-anno-input-hint">
                  选中：「{annoInput.text.slice(0, 30)}{annoInput.text.length > 30 ? "..." : ""}」
                </div>
              </div>
            )}
            {showComments && comments.length > 0 && (
              <CommentMarker
                comments={comments}
                containerRef={htmlFrameRef}
                activeComment={activeComment}
                setActiveComment={setActiveComment}
              />
            )}
          </div>
        )}
        {doc.kind === "text" && (
          <div className="mdview-container">
            <MarkdownToc content={doc.content} targetRef={mdContentRef} />
            <div className="mdview" ref={mdContentRef}>
              <div className="markdown-body">
                <MarkdownBody withToc>{doc.content || ""}</MarkdownBody>
              </div>
            </div>
            {showComments && comments.length > 0 && (
              <CommentMarker
                comments={comments}
                containerRef={mdContentRef}
                activeComment={activeComment}
                setActiveComment={setActiveComment}
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}

export default function DocViewer({ tabs = [], activeTab, onSwitchTab, onCloseTab, onOpenFile, loading, onSendToAgent }) {
  const doc = tabs.find((t) => t.name === activeTab) || null;
  return (
    <div className="docview">
      {/* 文件 tab 栏（类似浏览器标签页） */}
      {tabs.length > 0 && (
        <div className="doc-tabs">
          {tabs.map((t) => (
            <div
              key={t.name}
              className={`doc-tab ${t.name === activeTab ? "active" : ""}`}
              onClick={() => onSwitchTab && onSwitchTab(t.name)}
              title={t.name}
            >
              <span className="doc-tab-icon"><Icon name={ICONS[t.ext] || "file"} size={12} /></span>
              <span className="doc-tab-name">{t.name}</span>
              <span
                className="doc-tab-close"
                onClick={(e) => { e.stopPropagation(); onCloseTab && onCloseTab(t.name); }}
              >×</span>
            </div>
          ))}
        </div>
      )}
      {!doc ? (
        <div className="docview-body">
          <div className="empty-view">
            <div>从左侧选择一个文件</div>
            <div className="hint">.docx / .xlsx / .pptx / .md / .html — 支持多标签打开</div>
          </div>
        </div>
      ) : (
        <DocContent doc={doc} loading={loading} onSendToAgent={onSendToAgent} />
      )}
    </div>
  );
}