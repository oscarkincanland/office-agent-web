import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import Icon from "./Icon.jsx";

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
        // rehype-slug 的逻辑：小写、移除非单词字符（保留中文）、空格转连字符
        const id = text
          .toLowerCase()
          .replace(/[^\w\u4e00-\u9fa5\s-]/g, "") // 移除特殊字符，保留中文、字母、数字、空格、连字符
          .replace(/\s+/g, "-") // 空格转连字符
          .replace(/-+/g, "-") // 合并多个连字符
          .replace(/^-|-$/g, ""); // 移除首尾连字符
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
          // 找到对应的 heading
          const text = entry.target.textContent.trim();
          const matchedHeading = headings.find(h => text.includes(h.text.trim()));
          if (matchedHeading) {
            setActiveId(matchedHeading.id);
          }
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
      // 观察所有标题元素
      const allHeadings = container.querySelectorAll("h1, h2, h3, h4, h5, h6");
      for (const el of allHeadings) {
        observerRef.current.observe(el);
      }
    }, 200);

    return () => {
      clearTimeout(timer);
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [headings, targetRef]);

  // 点击标题跳转 - 使用多种方式查找标题元素
  const handleClick = useCallback((heading) => {
    if (!targetRef?.current) return;
    
    const container = targetRef.current;
    let el = null;
    
    // 方式1：通过 ID 查找
    el = container.querySelector(`#${heading.id}`);
    
    // 方式2：如果方式1失败，通过文本内容查找
    if (!el) {
      const allHeadings = container.querySelectorAll("h1, h2, h3, h4, h5, h6");
      for (const h of allHeadings) {
        if (h.textContent.trim().includes(heading.text.trim())) {
          el = h;
          break;
        }
      }
    }
    
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      setActiveId(heading.id);
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
        <span className="md-toc-icon"><Icon name="list" size={14} /></span>
        {isOpen && <span className="md-toc-title">目录</span>}
      </button>
      
      {isOpen && (
        <div className="md-toc-content">
          {headings.map((h, i) => (
            <div
              key={`${h.id}-${i}`}
              className={`md-toc-item level-${h.level} ${activeId === h.id ? "active" : ""}`}
              style={{ paddingLeft: `${(h.level - 1) * 12 + 8}px` }}
              onClick={() => handleClick(h)}
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
