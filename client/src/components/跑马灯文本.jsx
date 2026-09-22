import React, { useEffect, useRef, useState } from "react";

/**
 * 跑马灯文本：运行中的会话 / 项目 / 任务名自动横向滚动，并叠加一段流动的高光（灯效）。
 *
 * 只在「被容器截断」且 active（运行中）时才滚动：短名字保持静止，
 * 避免整栏文字无谓抖动；不滚动时仍然用省略号截断，保证布局稳定。
 */
export default function 跑马灯文本({ text, active = false, className = "", title }) {
  const innerRef = useRef(null);
  const [overflow, setOverflow] = useState(0);
  const content = String(text ?? "");

  useEffect(() => {
    const measure = () => {
      const inner = innerRef.current;
      if (!inner) return;
      // 未滚动时 inner 是受限块级元素：scrollWidth 是完整文本宽度，clientWidth 是可见宽度
      const next = Math.max(0, inner.scrollWidth - inner.clientWidth);
      setOverflow((current) => (Math.abs(current - next) > 1 ? next : current));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    if (innerRef.current) observer.observe(innerRef.current);
    return () => observer.disconnect();
  }, [content]);

  const scrolling = active && overflow > 4;
  const style = scrolling
    ? {
      "--marquee-shift": `-${overflow + 10}px`,
      "--marquee-duration": `${Math.min(16, 4 + overflow / 22).toFixed(1)}s`,
    }
    : undefined;

  return (
    <span
      className={`marquee ${active ? "is-active" : ""} ${scrolling ? "is-scrolling" : ""} ${className}`.trim()}
      style={style}
      title={title ?? content}
    >
      <span ref={innerRef} className="marquee-inner">{content}</span>
    </span>
  );
}
