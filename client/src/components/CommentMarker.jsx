import React, { useState, useRef, useEffect, useCallback } from "react";
import Icon from "./Icon.jsx";

/**
 * 批注组件（Word 风格）
 * - 批注列表（右侧栏）：点击 → 定位到文档对应段落
 * - 定位效果：段落黄色高亮 + 段落前插入编号徽标 + 滚动居中
 * - 文档正文关键词匹配失败时回退到段落级匹配
 */
export default function CommentMarker({ comments, containerRef, activeComment, setActiveComment }) {
  const [hoveredComment, setHoveredComment] = useState(null);
  const highlightTimerRef = useRef(null);
  const badgeTimerRef = useRef(null);

  // 清理高亮和徽标
  const clearVisuals = useCallback(() => {
    if (containerRef?.current) {
      const c = containerRef.current;
      const doc = c.tagName === "IFRAME" ? (c.contentDocument || null) : c;
      if (doc) {
        doc.querySelectorAll(".comment-highlight-active").forEach((el) => el.classList.remove("comment-highlight-active"));
        doc.querySelectorAll(".comment-anchor-badge").forEach((el) => el.remove());
      }
    }
  }, [containerRef]);

  // 从批注指令中提取正文可能包含的关键词（4+ 字符中文/英文串）
  const extractKeywords = useCallback((text) => {
    const clean = (text || "")
      .replace(/\[当前打开文件:?[^\]]*\]/g, " ")
      .replace(/[模式:[^\]]*\]/g, " ")
      .replace(/^[@#@]\S+\s*/g, " ");
    const kws = [];
    // 中文连续片段
    const cn = clean.match(/[\u4e00-\u9fa5]{4,}/g) || [];
    // 英文/数字连续片段
    const en = clean.match(/[A-Za-z0-9._-]{4,}/g) || [];
    for (const w of cn) kws.push(w);
    for (const w of en) kws.push(w);
    return kws;
  }, []);

  // 收集 docx-preview 渲染生成的批注锚点注释节点（按文档顺序）。
  // docx-preview 将批注范围渲染为 HTML 注释节点：
  //   "start of comment #N"（范围起点）/ "comment #N by author on date"（💬 引用处）
  const collectCommentAnchors = useCallback((doc, container) => {
    const anchors = [];
    try {
      // createNodeIterator 是 Document 的方法；root 可为任意 Node（含 Element）
      const docObj = doc && doc.nodeType === 9 ? doc : (doc?.ownerDocument || doc);
      const walker = docObj.createNodeIterator(container, NodeFilter.SHOW_COMMENT, null);
      let n;
      while ((n = walker.nextNode())) {
        const t = (n.nodeValue || "").trim();
        if (/^(start of comment #|comment #\d+ by)/.test(t)) anchors.push(n);
      }
    } catch { /* 非 DOM 容器（如未渲染完成的 iframe） */ }
    return anchors;
  }, []);

  // 从注释锚点向上找最近的块级元素（段落）
  const findBlockAncestor = useCallback((el, root) => {
    let cur = el;
    while (cur && cur !== root) {
      if (/^(P|H1|H2|H3|H4|H5|H6|LI|TD|TH|BLOCKQUOTE|PRE)$/.test(cur.tagName)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }, []);

  // 定位批注对应段落
  const findCommentElement = useCallback((comment, index) => {
    if (!containerRef?.current) return null;
    const container = containerRef.current;
    const doc = container.tagName === "IFRAME" ? (container.contentDocument || container.contentWindow?.document) : container;
    if (!doc) return null;

    // 1) docx-preview 注释锚点：按文档顺序与批注列表索引对应
    //    （officecli 与 docx-preview 均按文档顺序处理批注）
    const anchors = collectCommentAnchors(doc, container);
    const anchor = typeof index === "number" ? anchors[index] : null;
    if (anchor) {
      const para = findBlockAncestor(anchor.parentElement, container);
      if (para) {
        // 顺序对应校验：锚点段落若含批注关键词则直接采用；否则继续关键词匹配
        const kws = extractKeywords(comment.text);
        if (kws.some((k) => para.textContent.includes(k))) return para;
      }
    }

    // 2) 显式 path / data-comment-id
    if (comment.path) {
      const el = doc.querySelector(`[data-path="${comment.path}"], [data-comment-id="${comment.id}"]`);
      if (el) return el;
    }
    // 3) 关键词匹配：提取的正文关键词 → 找包含它的段落
    const keywords = extractKeywords(comment.text);
    const candidates = Array.from(doc.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, td, th"));
    for (const kw of [...keywords].sort((a, b) => b.length - a.length)) {
      const hit = candidates.find((el) => el.textContent.includes(kw));
      if (hit) return hit;
    }
    // 4) 兜底：锚点顺序对应（无关键词命中时仍可用）
    if (anchor) {
      const para = findBlockAncestor(anchor.parentElement, container);
      if (para) return para;
    }
    return null;
  }, [containerRef, extractKeywords, collectCommentAnchors, findBlockAncestor]);

  // 点击批注：定位 + 高亮 + 徽标
  const handleCommentClick = useCallback((comment, index) => {
    setActiveComment?.(index);
    clearVisuals();
    const el = findCommentElement(comment, index);
    if (el) {
      const container = containerRef.current;
      const doc = container?.tagName === "IFRAME"
        ? (container.contentDocument || null)
        : container;
      // 段落级高亮
      el.classList.add("comment-highlight-active");
      // 段落前插入编号徽标（Word 风格）
      if (doc) {
        // createElement 是 Document 的方法；doc 可能是 Element（div 容器）
        const docObj = doc.nodeType === 9 ? doc : (doc.ownerDocument || doc);
        const badge = docObj.createElement("span");
        badge.className = "comment-anchor-badge";
        badge.textContent = String(index + 1);
        badge.style.position = "absolute";
        const rect = el.getBoundingClientRect();
        badge.style.left = Math.max(4, rect.left - 26) + "px";
        badge.style.top = rect.top + "px";
        badge.style.zIndex = "50";
        (doc.body || container).appendChild(badge);
      }
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // 定时清理
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = setTimeout(() => el.classList.remove("comment-highlight-active"), 5000);
      if (badgeTimerRef.current) clearTimeout(badgeTimerRef.current);
      badgeTimerRef.current = setTimeout(clearVisuals, 5000);
    }
  }, [containerRef, findCommentElement, clearVisuals, setActiveComment]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      if (badgeTimerRef.current) clearTimeout(badgeTimerRef.current);
    };
  }, []);

  if (!comments || comments.length === 0) return null;

  return (
    <div className="comment-marker-panel">
      <div className="comment-marker-header">
        <span className="comment-marker-icon"><Icon name="comment" size={14} /></span>
        <span>批注 ({comments.length})</span>
        <span className="comment-marker-tip">点击定位到文档段落</span>
      </div>
      <div className="comment-marker-list">
        {comments.map((c, i) => (
          <div
            key={i}
            className={`comment-marker-item ${activeComment === i ? "active" : ""} ${hoveredComment === i ? "hovered" : ""}`}
            onClick={() => handleCommentClick(c, i)}
            onMouseEnter={() => setHoveredComment(i)}
            onMouseLeave={() => setHoveredComment(null)}
          >
            <div className="comment-marker-index">{i + 1}</div>
            <div className="comment-marker-content">
              <div className="comment-marker-author">{c.author || "匿名"}</div>
              <div className="comment-marker-text">{c.text}</div>
              {c.path && <div className="comment-marker-path">{c.path}</div>}
            </div>
            <div className="comment-marker-locate" title="定位到段落">
              <Icon name="pin" size={14} />
            </div>
          </div>
        ))}
      </div>
      <div className="comment-marker-footer">点击批注定位到文档对应段落（黄底高亮 + 编号徽标）</div>
    </div>
  );
}
