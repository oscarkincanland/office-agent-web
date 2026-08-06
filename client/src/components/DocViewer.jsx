import React, { useState, useCallback, useEffect, useRef } from "react";
import MarkdownBody from "./MarkdownBody.jsx";
import MarkdownToc from "./MarkdownToc.jsx";
import ExcelGrid from "./ExcelGrid.jsx";

const ICONS = { docx: "W", xlsx: "X", pptx: "P", md: "M", html: "H", htm: "H", txt: "T" };

// 文件内容渲染（单个 tab 的正文）
function DocContent({ doc, loading }) {
  const [watchUrl, setWatchUrl] = useState(null);
  const [watchLoading, setWatchLoading] = useState(false);
  const [watchErr, setWatchErr] = useState("");
  const [comments, setComments] = useState([]);
  const [commentsOpen, setCommentsOpen] = useState(false);

  useEffect(() => {
    setWatchUrl(null);
    setWatchLoading(false);
    setWatchErr("");
    setComments([]);
    setCommentsOpen(false);
    if (doc?.kind === "html") {
      fetch(`/api/doc/${encodeURIComponent(doc.name)}/comments`)
        .then((r) => r.json())
        .then((d) => setComments(d.comments || []))
        .catch(() => {});
    }
  }, [doc?.name, doc?.kind]);

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
            {comments.length > 0 && (
              <button className={`btn-sm comment-btn ${commentsOpen ? "active" : ""}`} onClick={() => setCommentsOpen(!commentsOpen)}>
                💬 批注 ({comments.length})
              </button>
            )}
          </>
        )}
        {doc.kind === "xlsx" && <span className="badge">可编辑</span>}
        {doc.kind === "htmlfile" && <span className="badge">HTML 页面</span>}
        {doc.kind === "text" && <span className="badge">{doc.ext === "md" || doc.ext === "markdown" ? "Markdown" : "文本"}</span>}
        {watchErr && <span className="badge err-badge">⚠ {watchErr}</span>}
        {watchUrl && <span className="badge ws-hint">可点选元素，配合右侧 agent 修改</span>}
      </div>
      {commentsOpen && comments.length > 0 && (
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
        {doc.kind === "html" && (
          <iframe title={doc.name} src={watchUrl || doc.url} className="docframe" />
        )}
        {doc.kind === "xlsx" && <ExcelGrid name={doc.name} sheets={doc.sheets} grids={doc.grids} />}
        {doc.kind === "htmlfile" && (
          <iframe
            title={doc.name}
            srcDoc={doc.content || ""}
            className="docframe"
            sandbox="allow-scripts allow-same-origin"
          />
        )}
        {doc.kind === "text" && (
          <div className="mdview-container">
            <MarkdownToc content={doc.content} targetRef={mdContentRef} />
            <div className="mdview" ref={mdContentRef}>
              <div className="markdown-body">
                <MarkdownBody withToc>{doc.content || ""}</MarkdownBody>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

export default function DocViewer({ tabs = [], activeTab, onSwitchTab, onCloseTab, onOpenFile, loading }) {
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
              <span className="doc-tab-icon">{ICONS[t.ext] || (t.kind === "text" ? "M" : "?")}</span>
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
        <DocContent doc={doc} loading={loading} />
      )}
    </div>
  );
}
