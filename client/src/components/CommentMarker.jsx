import React, { useState, useRef, useEffect, useCallback } from "react";

/**
 * 批注标记组件
 * 在文档旁边显示批注列表，点击可以跳转到对应位置并高亮段落
 */
export default function CommentMarker({ comments, containerRef }) {
  const [activeComment, setActiveComment] = useState(null);
  const [hoveredComment, setHoveredComment] = useState(null);
  const highlightTimerRef = useRef(null);

  // 清除高亮
  const clearHighlight = useCallback(() => {
    if (containerRef?.current) {
      const container = containerRef.current;
      if (container.tagName === "IFRAME") {
        try {
          const iframeDoc = container.contentDocument || container.contentWindow?.document;
          if (iframeDoc) {
            const highlighted = iframeDoc.querySelectorAll(".comment-highlight-active");
            highlighted.forEach(el => el.classList.remove("comment-highlight-active"));
          }
        } catch (e) {}
      } else {
        const highlighted = container.querySelectorAll(".comment-highlight-active");
        highlighted.forEach(el => el.classList.remove("comment-highlight-active"));
      }
    }
  }, [containerRef]);

  // 高亮段落
  const highlightElement = useCallback((element) => {
    if (!element) return;
    
    // 清除之前的高亮
    clearHighlight();
    
    // 添加高亮样式
    element.classList.add("comment-highlight-active");
    
    // 滚动到元素位置
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    
    // 3秒后自动清除高亮
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = setTimeout(() => {
      element.classList.remove("comment-highlight-active");
    }, 3000);
  }, [clearHighlight]);

  // 根据批注的path或位置信息，找到对应的DOM元素
  const findCommentElement = useCallback((comment) => {
    if (!containerRef?.current) return null;
    
    const container = containerRef.current;
    
    // 如果是iframe，需要通过postMessage或直接操作
    if (container.tagName === "IFRAME") {
      try {
        const iframeDoc = container.contentDocument || container.contentWindow?.document;
        if (iframeDoc) {
          // 尝试通过批注ID查找
          if (comment.id) {
            const el = iframeDoc.querySelector(`[data-comment-id="${comment.id}"]`);
            if (el) return el;
          }
          // 尝试通过path查找
          if (comment.path) {
            const el = iframeDoc.querySelector(`[data-path="${comment.path}"]`);
            if (el) return el;
          }
          // 尝试通过文本内容查找
          if (comment.text) {
            const allElements = iframeDoc.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, td, th");
            for (const el of allElements) {
              if (el.textContent.includes(comment.text.slice(0, 20))) {
                return el;
              }
            }
          }
        }
      } catch (e) {
        console.log("Cannot access iframe content:", e);
      }
    }
    
    // 普通DOM元素
    if (comment.id) {
      const el = container.querySelector(`[data-comment-id="${comment.id}"]`);
      if (el) return el;
    }
    if (comment.path) {
      const el = container.querySelector(`[data-path="${comment.path}"]`);
      if (el) return el;
    }
    // 通过文本内容查找
    if (comment.text) {
      const allElements = container.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, td, th");
      for (const el of allElements) {
        if (el.textContent.includes(comment.text.slice(0, 20))) {
          return el;
        }
      }
    }
    
    return null;
  }, [containerRef]);

  // 点击批注跳转到对应位置
  const handleCommentClick = useCallback((comment, index) => {
    setActiveComment(index);
    const el = findCommentElement(comment);
    if (el) {
      highlightElement(el);
    }
  }, [findCommentElement, highlightElement]);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  if (!comments || comments.length === 0) return null;

  return (
    <div className="comment-marker-panel">
      <div className="comment-marker-header">
        <span className="comment-marker-icon">💬</span>
        <span>批注 ({comments.length})</span>
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
              {c.path && <div className="comment-marker-path">📍 {c.path}</div>}
            </div>
            <div className="comment-marker-locate" title="定位到段落">
              📍
            </div>
          </div>
        ))}
      </div>
      <div className="comment-marker-footer">
        点击批注可定位到文档对应段落
      </div>
    </div>
  );
}

/**
 * 批注气泡组件
 * 显示在文档旁边，带引线连接到对应位置
 */
export function CommentBubble({ comment, index, position, isActive, onClick }) {
  const [showDetail, setShowDetail] = useState(false);

  return (
    <div
      className={`comment-bubble ${isActive ? "active" : ""}`}
      style={{ top: `${position?.y || 0}px` }}
      onMouseEnter={() => setShowDetail(true)}
      onMouseLeave={() => setShowDetail(false)}
      onClick={onClick}
    >
      <div className="comment-bubble-marker">{index + 1}</div>
      {showDetail && (
        <div className="comment-bubble-detail">
          <div className="comment-bubble-author">{comment.author || "匿名"}</div>
          <div className="comment-bubble-text">{comment.text}</div>
          {comment.date && <div className="comment-bubble-date">{String(comment.date).slice(0, 10)}</div>}
        </div>
      )}
    </div>
  );
}
