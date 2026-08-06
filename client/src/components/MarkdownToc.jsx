import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";

/**
 * Markdown 目录浮窗组件
 * 从 markdown 内容中提取标题，显示为可点击的目录
 */
export default function MarkdownToc({ content, targetRef }) {
  const [isOpen, setIsOpen] = useState(true);
  const [activeId, setActiveId] = useState(null);
  const observerRef = useRef(null);

  // 从 markdown 内容中提取标题
  const headings = useMemo(() => {
    if (!content) return [];
    const lines = content.split("\n");
    const result = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 匹配 markdown 标题: # Heading, ## Heading, ### Heading 等
      const match = line.match(/^(#{1,6})\s+(.+)$/);
      if (match) {
        const level = match[1].length;
        const text = match[2].replace(/[*_`]/g, ""); // 移除 markdown 格式字符
        // 生成 heading id（与 rehype-slug 生成的 id 一致）
        const id = text
          .toLowerCase()
          .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
          .replace(/^-|-$/g, "");
        result.push({ level, text, id, line: i + 1 });
      }
    }
    return result;
  }, [content]);

  // 监听滚动，高亮当前标题
  useEffect(() => {
    if (!targetRef?.current || headings.length === 0) return;

    const container = targetRef.current;
    
    // 使用 IntersectionObserver 监听标题进入视口
    const callback = (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          setActiveId(entry.target.id);
        }
      }
    };

    observerRef.current = new IntersectionObserver(callback, {
      root: container,
      rootMargin: "-10% 0px -80% 0px",
      threshold: 0,
    });

    // 延迟观察，等待 DOM 渲染完成
    const timer = setTimeout(() => {
      for (const heading of headings) {
        const el = container.querySelector(`#${heading.id}`);
        if (el) observerRef.current.observe(el);
      }
    }, 100);

    return () => {
      clearTimeout(timer);
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [headings, targetRef]);

  // 点击标题跳转
  const handleClick = useCallback((id) => {
    if (!targetRef?.current) return;
    const el = targetRef.current.querySelector(`#${id}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      setActiveId(id);
    }
  }, [targetRef]);

  if (headings.length === 0) return null;

  return (
    <div className={`md-toc-panel ${isOpen ? "open" : ""}`}>
      <button 
        className="md-toc-toggle"
        onClick={() => setIsOpen(!isOpen)}
        title={isOpen ? "收起目录" : "展开目录"}
      >
        <span className="md-toc-icon">☰</span>
        {isOpen && <span className="md-toc-title">目录</span>}
      </button>
      
      {isOpen && (
        <div className="md-toc-content">
          {headings.map((h, i) => (
            <div
              key={`${h.id}-${i}`}
              className={`md-toc-item level-${h.level} ${activeId === h.id ? "active" : ""}`}
              style={{ paddingLeft: `${(h.level - 1) * 12 + 8}px` }}
              onClick={() => handleClick(h.id)}
              title={h.text}
            >
              <span className="md-toc-text">{h.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
