import React, { useState, useCallback, useEffect } from "react";
import MarkdownBody from "./MarkdownBody.jsx";
import ExcelGrid from "./ExcelGrid.jsx";

export default function DocViewer({ doc, loading }) {
  const [watchUrl, setWatchUrl] = useState(null);
  const [watchLoading, setWatchLoading] = useState(false);
  const [watchErr, setWatchErr] = useState("");
  const [comments, setComments] = useState([]);
  const [commentsOpen, setCommentsOpen] = useState(false);

  // 切换文档时重置状态 + 加载批注
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

  if (!doc) {
    return (
      <div className="docview">
        <div className="empty-view">
          <div>从左侧选择一个文件</div>
          <div className="hint">.docx / .xlsx / .pptx — 可通过右侧 agent 编辑</div>
        </div>
      </div>
    );
  }

  // 文件加载中
  if (loading && !doc.kind) {
    return (
      <div className="docview">
        <div className="empty-view">
          <div className="loading-spinner"></div>
          <div>正在加载文件...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="docview">
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
        {doc.kind === "html" && watchUrl && (
          <iframe title={doc.name} src={watchUrl} className="docframe" />
        )}
        {doc.kind === "html" && !watchUrl && (
          <iframe title={doc.name} src={doc.url} className="docframe" />
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
          <div className="mdview">
            <div className="markdown-body">
              <MarkdownBody>{doc.content || ""}</MarkdownBody>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
