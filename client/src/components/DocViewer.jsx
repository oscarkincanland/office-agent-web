import React, { useState, useCallback, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ExcelGrid from "./ExcelGrid.jsx";

export default function DocViewer({ doc, loading }) {
  const [watchUrl, setWatchUrl] = useState(null);
  const [watchLoading, setWatchLoading] = useState(false);
  const [watchErr, setWatchErr] = useState("");

  // 切换文档时重置 watch 状态
  useEffect(() => {
    setWatchUrl(null);
    setWatchLoading(false);
    setWatchErr("");
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
          </>
        )}
        {doc.kind === "xlsx" && <span className="badge">可编辑</span>}
        {doc.kind === "text" && <span className="badge">{doc.ext === "md" || doc.ext === "markdown" ? "Markdown" : "文本"}</span>}
        {watchErr && <span className="badge err-badge">⚠ {watchErr}</span>}
        {watchUrl && <span className="badge ws-hint">可点选元素，配合右侧 agent 修改</span>}
      </div>
      <div className="docview-body">
        {doc.kind === "html" && watchUrl && (
          <iframe title={doc.name} src={watchUrl} className="docframe" />
        )}
        {doc.kind === "html" && !watchUrl && (
          <iframe title={doc.name} src={doc.url} className="docframe" />
        )}
        {doc.kind === "xlsx" && <ExcelGrid name={doc.name} sheets={doc.sheets} grids={doc.grids} />}
        {doc.kind === "text" && (
          <div className="mdview">
            <div className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.content || ""}</ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
