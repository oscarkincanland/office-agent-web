import React, { useEffect, useRef, useState } from "react";
import { useAppearance, useReducedMotion } from "../界面外观.js";

/**
 * 跑马灯文本：运行中的会话 / 项目 / 任务名自动横向滚动，并按外观设置叠加灯效。
 *
 * 关键实现点（v0.11.10 修复闪烁）：
 *   测量用的是**独立隐藏元素**，不会随动画状态改变尺寸。
 *   旧实现直接量动画元素本身，滚动时 `width: max-content` 让它变宽、
 *   量出来又不溢出 → 类名来回切换 → 名字右边缘和右侧"执行中"标签持续抖动。
 *
 * 另外：只有被容器截断（overflow > 4px）且 active 时才滚动，短名字保持静止；
 * `prefers-reduced-motion` 或外观设置里选择"关闭动效"时不滚动，只保留静态高亮。
 *
 * P3：滚动层与灯效层分离 —— `.marquee-inner` 只负责位移，`.marquee-text` 负责
 * 渐变/呼吸/扫描等灯效。旧实现把两条 animation 写在同一个元素上，后声明的灯效
 * 会覆盖滚动，长名字既被截断又不动（详见 P3 动效清单）。
 */
export default function 跑马灯文本({ text, active = false, className = "", title }) {
  const wrapRef = useRef(null);
  const measureRef = useRef(null);
  const [overflow, setOverflow] = useState(0);
  const reduceMotion = useReducedMotion();
  const { motionLevel, marqueeStyle } = useAppearance();
  const content = String(text ?? "");

  useEffect(() => {
    const measure = () => {
      const wrap = wrapRef.current;
      const probe = measureRef.current;
      if (!wrap || !probe) return;
      // 隐藏测量元素的宽度 = 文本完整宽度；容器宽度 = 可见宽度
      const next = Math.max(0, Math.ceil(probe.scrollWidth - wrap.clientWidth));
      setOverflow((current) => (Math.abs(current - next) > 1 ? next : current));
    };
    // 首次布局、字体加载完成、容器宽度变化都要重算：只观察容器会漏掉
    // "容器宽度没变但文本宽度变了"（字体后到）的情况；面板开合动画期间
    // 宽度会在若干帧内变化，RO 可能只回调一次，这里再补几次定时重算。
    measure();
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(measure) : null;
    const timers = [120, 400, 1200].map((delay) => window.setTimeout(measure, delay));
    if (document.fonts?.ready?.then) document.fonts.ready.then(() => measure()).catch(() => {});
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => {
        if (raf) cancelAnimationFrame(raf);
        for (const timer of timers) window.clearTimeout(timer);
        window.removeEventListener("resize", measure);
      };
    }
    const observer = new ResizeObserver(measure);
    if (wrapRef.current) observer.observe(wrapRef.current);
    if (measureRef.current) observer.observe(measureRef.current);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      for (const timer of timers) window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [content]);

  const animate = motionLevel !== "off" && !reduceMotion;
  // "静态高亮"的语义是完全不动：不滚动也不做灯效，只用颜色标出运行中
  const scrolling = active && animate && marqueeStyle !== "static" && overflow > 4;
  const style = scrolling
    ? {
      "--marquee-shift": `-${overflow + 10}px`,
      "--marquee-distance": `${overflow + 10}px`,
    }
    : undefined;

  return (
    <span
      ref={wrapRef}
      className={`marquee ${active ? "is-active" : ""} ${scrolling ? "is-scrolling" : ""} ${className}`.trim()}
      style={style}
      data-marquee-overflow={overflow}
      data-marquee-motion={motionLevel}
      title={title ?? content}
    >
      <span className="marquee-inner">
        <span className="marquee-text">{content}</span>
      </span>
      {/* 稳定测量：不参与动画、不影响布局，仅供 scrollWidth 读取 */}
      <span className="marquee-measure" ref={measureRef} aria-hidden="true">{content}</span>
    </span>
  );
}
