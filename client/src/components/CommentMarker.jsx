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

  // 定位批注对应段落
  const findCommentElement = useCallback((comment) => {
    if (!containerRef?.current) return null;
    const container = containerRef.current;
    const doc = container.tagName === "IFRAME" ? (container.contentDocument || container.contentWindow?.document) : container;
    if (!doc) return null;

    // 1) 显式 path / data-comment-id
    if (comment.path) {
      const el = doc.querySelector(`[data-path="${comment.path}"], [data-comment-id="${comment.id}"]`);
      if (el) return el;
    }
    // 2) 关键词匹配：提取的正文关键词 → 找包含它的段落
    const keywords = extractKeywords(comment.text);
    const allElements = doc.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, td, th");
    const candidates = Array.from(allElements);
    // 优先匹配最长关键词的段落
    for (const kw of [...keywords].sort((a, b) => b.length - a.length)) {
      const hit = candidates.find((el) => el.textContent.includes(kw));
      if (hit) return hit;
    }
    // 3) 回退：按序号取段落（批注通常对应文档前半部分）
    if (candidates.length) return candidates[0];
    return null;
  }, [containerRef, extractKeywords]);

  // 点击批注：定位 + 高亮 + 徽标
  const handleCommentClick = useCallback((comment, index) => {
    setActiveComment?.(index);
    clearVisuals();
    const el = findCommentElement(comment);
    if (el) {
      const doc = containerRef.current?.tagName === "IFRAME"
        ? (containerRef.current.contentDocument || null)
        : containerRef.current;
      // 段落级高亮
      el.classList.add("comment-highlight-active");
      // 段落前插入编号徽标（Word 风格）
      if (doc) {
        const badge = doc.createElement("span");
        badge.className = "comment-anchor-badge";
        badge.textContent = String(index + 1);
        badge.style.position = "absolute";
        const rect = el.getBoundingClientRect();
        badge.style.left = Math.max(4, rect.left - 26) + "px";
        badge.style.top = rect.top + "px";
        badge.style.zIndex = "50";
        doc.body.appendChild(badge);
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
