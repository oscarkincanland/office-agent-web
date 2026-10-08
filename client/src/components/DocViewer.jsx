import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { openInSystem, revealInSystem } from "../api.js";
import { buildDocUrls, makeFileIdentity, identityMatches, PREVIEW_STATE, PREVIEW_STATE_LABEL } from "../文件地址.js";
import MarkdownBody from "./MarkdownBody.jsx";
import MarkdownToc from "./MarkdownToc.jsx";
import ExcelGrid from "./ExcelGrid.jsx";
import DocxViewer from "./DocxViewer.jsx";
import PptxViewer from "./PptxViewer.jsx";
import ImageViewer from "./ImageViewer.jsx";
import CommentMarker from "./CommentMarker.jsx";
import Icon from "./Icon.jsx";

const ICONS = { docx: "doc", xlsx: "xls", xls: "xls", pptx: "ppt", md: "md", html: "html", htm: "html", txt: "txt", pdf: "pdf", png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", svg: "image", avif: "image" };
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
function DocContent({ doc, loading, onRefresh, onSendToAgent, onInsertContext }) {
  const [watchUrl, setWatchUrl] = useState(null);
  const [watchLoading, setWatchLoading] = useState(false);
  const [watchErr, setWatchErr] = useState("");
  const [comments, setComments] = useState([]);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentsLoading, setCommentsLoading] = useState(false);

  // 统一预览状态：loading | ready | partial | unsupported | failed（子查看器一致消费）
  const [previewState, setPreviewState] = useState(PREVIEW_STATE.LOADING);
  const [previewErr, setPreviewErr] = useState("");

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

  // 文件身份：所有预览请求都显式带同一份 { cwd, relativePath, revision }。
  const identity = useMemo(
    () => doc?.identity || makeFileIdentity({ relativePath: doc?.name }),
    [doc?.identity, doc?.name],
  );
  const docKey = `${identity.workspaceId}::${identity.relativePath}`;
  const urls = useMemo(() => buildDocUrls(identity), [identity.workspaceId, identity.relativePath, identity.revision]);
  // 渲染 generation：切文件时递增，旧请求（即使已完成）的结果直接丢弃。
  const generationRef = useRef(0);
  const abortMapRef = useRef(new Map());
  const docKeyRef = useRef(docKey);
  docKeyRef.current = docKey;
  const identityRef = useRef(identity);
  identityRef.current = identity;

  // 按通道取消旧请求并发起新请求，返回的 controller 供调用方 abort。
  const scopedFetch = useCallback((channel, url, options = {}) => {
    abortMapRef.current.get(channel)?.abort();
    const controller = new AbortController();
    abortMapRef.current.set(channel, controller);
    return fetch(url, { cache: "no-store", ...options, signal: controller.signal });
  }, []);

  // 响应身份核对：服务端返回 identity 与当前文件不符则丢弃（防止串内容）。
  const identityOk = useCallback((serverIdentity) => {
    if (!serverIdentity) return true;
    return identityMatches(identityRef.current, serverIdentity);
  }, []);

  const isHtmlKind = doc?.kind === "html" || doc?.kind === "htmlfile";
  // DOCX/PPTX 使用各自的专用查看器；通用 HTML 工具栏对这两类文件不生效。
  const isOfficePreview = doc?.kind === "html" && (doc.ext === "docx" || doc.ext === "pptx");

  // iframe 内容通过 postMessage 上报身份与就绪状态：onload 只代表页面已加载。
  useEffect(() => {
    const onMessage = (event) => {
      const data = event?.data;
      if (!data || data.__oawPreview !== true) return;
      // 只接受来自当前预览 iframe 的消息，忽略其它来源。
      if (htmlFrameRef.current && event.source && event.source !== htmlFrameRef.current.contentWindow) return;
      // 身份不符：内容来自别的文件/工作区，直接判定失败，不展示。
      if (data.identity && !identityMatches(identityRef.current, data.identity)) {
        setPreviewState(PREVIEW_STATE.FAILED);
        setPreviewErr("预览内容与当前文件身份不一致，已停止展示");
        return;
      }
      if (data.type === "unsupported") { setPreviewState(PREVIEW_STATE.UNSUPPORTED); setPreviewErr(""); }
      else if (data.type === "error") { setPreviewState(PREVIEW_STATE.FAILED); setPreviewErr(data.message || "预览渲染失败"); }
      else if (data.type === "ready") { setPreviewState(PREVIEW_STATE.READY); setPreviewErr(""); }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [docKey]);

  const fetchComments = useCallback(async () => {
    if (!doc) return;
    const gen = generationRef.current;
    const key = docKeyRef.current;
    setCommentsLoading(true);
    try {
      const r = await scopedFetch("comments", urls.comments);
      if (gen !== generationRef.current || key !== docKeyRef.current) return;
      const d = await r.json();
      if (gen !== generationRef.current || key !== docKeyRef.current) return;
      if (!identityOk(d?.identity)) {
        setPreviewState(PREVIEW_STATE.FAILED);
        setPreviewErr("批注响应与当前文件身份不一致，已丢弃");
        return;
      }
      setComments(d.comments || []);
    } catch (e) {
      if (e?.name !== "AbortError") console.error("获取批注失败:", e);
    } finally {
      if (gen === generationRef.current && key === docKeyRef.current) setCommentsLoading(false);
    }
  }, [doc, urls, scopedFetch, identityOk]);

  // 切换/打开文件时重置标注状态 + 加载服务端 annotations
  useEffect(() => {
    // 进入新文件：递增 generation 并取消所有在途预览请求，旧结果不得写入。
    generationRef.current += 1;
    for (const controller of abortMapRef.current.values()) { try { controller.abort(); } catch {} }
    abortMapRef.current.clear();
    // text / xlsx / htmlfile 的内容已随 open 响应返回并经身份核对，可直接 ready；
    // 其余格式（docx/pptx/pdf/html）还要经过渲染或 iframe 加载，先置 loading。
    const localReady = doc?.kind === "text" || doc?.kind === "xlsx" || doc?.kind === "htmlfile";
    setPreviewState(localReady ? PREVIEW_STATE.READY : PREVIEW_STATE.LOADING);
    setPreviewErr("");
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
    // DOCX/PPTX 由专用查看器自己读取批注/原始文件；这里不要再触发一轮
    // OfficeCLI 查询，否则每次点击 Word 预览都会重复启动一次读取进程。
    if ((doc?.kind === "html" && !isOfficePreview) || doc?.kind === "text") {
      fetchComments();
    }
    if (isHtmlKind && !isOfficePreview) {
      const gen = generationRef.current;
      scopedFetch("annotations", urls.annotations)
        .then((r) => {
          if (gen !== generationRef.current) return null;
          return r.json();
        })
        .then((d) => {
          if (!d || gen !== generationRef.current) return;
          if (!identityOk(d.identity)) {
            setPreviewState(PREVIEW_STATE.FAILED);
            setPreviewErr("标注响应与当前文件身份不一致，已丢弃");
            return;
          }
          const list = d.annotations || [];
          setAnnotations(list);
          setAnnoLoaded(true);
          lastSavedJsonRef.current = JSON.stringify(list);
        })
        .catch((e) => { if (e?.name !== "AbortError") console.error("加载标注失败:", e); });
    } else {
      setAnnotations([]);
      setAnnoLoaded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, doc?.kind, isOfficePreview, isHtmlKind]);

  const startLive = useCallback(async () => {
    if (!doc) return;
    const gen = generationRef.current;
    const key = docKeyRef.current;
    setWatchLoading(true);
    setWatchErr("");
    try {
      const r = await scopedFetch("watch", urls.watch).then((x) => x.json());
      if (gen !== generationRef.current || key !== docKeyRef.current) return;
      if (r.ok) {
        setWatchUrl(r.url);
      } else {
        setWatchErr(r.error || "启动实时预览失败");
      }
    } catch (e) {
      if (e?.name !== "AbortError") setWatchErr("网络错误: " + e.message);
    } finally {
      if (gen === generationRef.current && key === docKeyRef.current) setWatchLoading(false);
    }
  }, [doc, urls, scopedFetch]);

  const stopLive = useCallback(() => {
    setWatchUrl(null);
    // 通知服务端停止该文件的 watch，避免切换静态预览后进程长期驻留。
    try { scopedFetch("watch", urls.watchStop, { method: "POST" }).catch(() => {}); } catch {}
  }, [urls, scopedFetch]);

  const mdContentRef = useRef(null);
  const htmlFrameRef = useRef(null);
  const [showComments, setShowComments] = useState(false);
  const [activeComment, setActiveComment] = useState(null);

  // annotations 变化 → 防抖保存（带文件身份，切文件后不再写回旧文件）
  useEffect(() => {
    if (!isHtmlKind || !annoLoaded) return;
    const json = JSON.stringify(annotations);
    if (json === lastSavedJsonRef.current) return;
    const key = docKey;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      if (key !== docKeyRef.current) return;
      lastSavedJsonRef.current = json;
      fetch(urls.annotations, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ annotations }),
      }).catch((e) => console.error("保存标注失败:", e));
    }, ANNO_SAVE_DEBOUNCE);
  }, [annotations, docKey, urls, isHtmlKind, annoLoaded]);

  // iframe onload → 只代表页面已加载（partial）；内容身份由 postMessage 确认后才 ready。
  const handleIframeLoad = useCallback(() => {
    iframeReadyRef.current = true;
    setIframeReady(true);
    setPreviewState((prev) => (prev === PREVIEW_STATE.FAILED ? prev : PREVIEW_STATE.PARTIAL));
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
      if (onInsertContext || onSendToAgent) {
        const msg = `在当前打开的 ${doc.name} 中，对选中内容「${annoInput.text}」做修改：${val}`;
        try {
          (onInsertContext || onSendToAgent)(msg);
        } catch (e) {
          console.error("onSendToAgent 调用失败:", e);
        }
      }
    }
    setAnnoInput(null);
    setAnnoToolbar(null);
  }, [annoInput, doc, onInsertContext, onSendToAgent]);

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
        <span className={`badge preview-state preview-state-${previewState}`} title={previewErr || ""}>
          {previewState === PREVIEW_STATE.LOADING && <Icon name="loading" size={11} />}
          {previewState === PREVIEW_STATE.FAILED && <Icon name="warning" size={11} />}
          {PREVIEW_STATE_LABEL[previewState] || previewState}
        </span>
        {doc.kind === "html" && !isOfficePreview && (
          <>
            <span className="badge">{watchUrl ? "实时预览" : "静态预览"}</span>
            {!watchUrl && (
              <button className="btn-sm" onClick={startLive} disabled={watchLoading}>
                {watchLoading ? "启动中..." : "开启实时预览"}
              </button>
            )}
            {watchUrl && (
              <button className="btn-sm" onClick={stopLive}>静态预览</button>
            )}
          </>
        )}
        {isOfficePreview && <span className="badge">专用预览工具栏</span>}
        {doc.kind === "xlsx" && <span className="badge">可编辑</span>}
        {doc.kind === "htmlfile" && <span className="badge">HTML 页面</span>}
        {doc.kind === "pdf" && <span className="badge">PDF</span>}
        {doc.kind === "text" && <span className="badge">{doc.ext === "md" || doc.ext === "markdown" ? "Markdown" : "文本"}</span>}
        {isHtmlKind && !isOfficePreview && (
          <button
            className={`btn-sm oa-anno-toggle ${annoMode ? "active" : ""}`}
            onClick={toggleAnnoMode}
            title="标注模式：划词高亮/批注"
          >
            <Icon name={annoMode ? "pin" : "comment"} size={12} />
            {annoMode ? "退出标注" : "标注"}
          </button>
        )}
        {(doc.kind === "text" || (doc.kind === "html" && !isOfficePreview)) && (
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
        {previewErr && <span className="badge err-badge"><Icon name="warning" size={11} /> {previewErr}</span>}
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
          <DocxViewer name={doc.name} revision={doc.previewRevision} identity={identity} onPreviewState={setPreviewState} onPreviewError={setPreviewErr} onSendToAgent={onSendToAgent} onInsertContext={onInsertContext} />
        )}
        {doc.kind === "html" && doc.ext === "pptx" && (
          <PptxViewer name={doc.name} revision={doc.previewRevision} identity={identity} onPreviewState={setPreviewState} onPreviewError={setPreviewErr} />
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
        {doc.kind === "image" && (
          <ImageViewer doc={doc} onPreviewState={setPreviewState} onPreviewError={setPreviewErr} />
        )}
        {doc.kind === "pdf" && (
          <div className="docframe-container">
            <iframe
              title={doc.name}
              src={doc.url}
              className="docframe"
              onLoad={() => setPreviewState((prev) => (prev === PREVIEW_STATE.FAILED ? prev : PREVIEW_STATE.PARTIAL))}
              onError={() => { setPreviewState(PREVIEW_STATE.FAILED); setPreviewErr("PDF 预览加载失败，可用系统应用打开"); }}
            />
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
              onLoad={() => { handleIframeLoad(); setPreviewState(PREVIEW_STATE.READY); }}
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

export default function DocViewer({ tabs = [], activeTab, onSwitchTab, onCloseTab, onOpenFile, loading, onSendToAgent, onInsertContext }) {
  // activeTab 是标签 id（工作区 + 相对路径），兼容旧数据仍可能传文件名。
  const doc = tabs.find((t) => (t.id || t.name) === activeTab) || null;
  const tabId = (t) => t.id || t.name;
  // 标签副标题：不同工作区的同名文件用工作区末段提示，便于区分。
  const workspaceHint = (t) => {
    const ws = t.identity?.workspaceId || t.identity?.cwd || "";
    const parts = String(ws).replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  };

  // 本机原生操作：用系统默认应用打开 / 在文件管理器中显示（服务端做路径白名单校验）
  const handleNative = async (action) => {
    if (!doc?.name) return;
    try {
      if (action === "reveal") await revealInSystem(doc.name);
      else await openInSystem(doc.name);
    } catch (error) {
      alert(`${action === "reveal" ? "在文件管理器中显示" : "用系统应用打开"}失败：${error.message}`);
    }
  };

  return (
    <div className="docview">
      {/* 文件 tab 栏（类似浏览器标签页） */}
      {tabs.length > 0 && (
        <div className="doc-tabs">
          {tabs.map((t) => (
            <div
              key={tabId(t)}
              role="tab"
              tabIndex={0}
              aria-selected={tabId(t) === activeTab}
              className={`doc-tab ${tabId(t) === activeTab ? "active" : ""}`}
              onClick={() => onSwitchTab && onSwitchTab(tabId(t))}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSwitchTab && onSwitchTab(tabId(t)); }
              }}
              title={workspaceHint(t) ? `${t.name} — ${workspaceHint(t)}` : t.name}
            >
              <span className="doc-tab-icon"><Icon name={ICONS[t.ext] || "file"} size={12} /></span>
              <span className="doc-tab-name">{t.name}</span>
              <button
                type="button"
                className="doc-tab-close"
                aria-label={`关闭 ${t.name}`}
                title={`关闭 ${t.name}`}
                onClick={(e) => { e.stopPropagation(); onCloseTab && onCloseTab(tabId(t)); }}
              ><Icon name="close" size={11} /></button>
            </div>
          ))}
        </div>
      )}
      {/* 本机原生操作条：与预览器无关，任何格式都可用（图片/Excel/PDF 等用系统应用打开） */}
      {doc && (
        <div className="doc-native-actions">
          <span className="doc-native-name" title={doc.name}><Icon name={ICONS[doc.ext] || "file"} size={11} /> {doc.name}</span>
          <span className="doc-native-spacer" />
          <button type="button" className="btn-xs" onClick={() => handleNative("open")} title="用系统默认应用打开（例如 WPS/Word/预览/浏览器）">
            <Icon name="externalLink" size={11} /> 用系统应用打开
          </button>
          <button type="button" className="btn-xs" onClick={() => handleNative("reveal")} title="在文件管理器中显示该文件">
            <Icon name="folderOpen" size={11} /> 在文件管理器中显示
          </button>
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
        <DocContent doc={doc} loading={loading} onSendToAgent={onSendToAgent} onInsertContext={onInsertContext} />
      )}
    </div>
  );
}
