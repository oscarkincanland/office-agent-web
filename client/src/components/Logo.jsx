import React, { useId } from "react";

/**
 * Open Plan（规聚）品牌 Logo
 * 概念：四条轨道汇聚到中心，表达资料、知识、分析与成果回到同一个工作台。
 * 默认使用紧凑的绿色底 + 白色图形；不依赖位图，缩放到 favicon 或侧栏尺寸都清晰。
 */
export default function Logo({ size = 20, withGradient = true, withBackground = true, className = "" }) {
  const gradientId = `open-plan-logo-${useId().replace(/:/g, "")}`;
  return (
    <svg className={`open-plan-logo ${className}`} width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Open Plan 规聚">
      <defs>
        <linearGradient id={gradientId} x1="6" y1="4" x2="42" y2="44" gradientUnits="userSpaceOnUse">
          <stop stopColor="#78b9a2" />
          <stop offset="1" stopColor="#3f887b" />
        </linearGradient>
      </defs>
      {withBackground && <rect x="1.5" y="1.5" width="45" height="45" rx="13" fill={withGradient ? `url(#${gradientId})` : "var(--accent, #4f9a88)"} />}
      {/* 四条圆润轨道：保持图二的汇聚结构，但用矢量曲线避免位图背景过宽。 */}
      <g fill="none" stroke="#ffffff" strokeWidth="4.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22.2 20.6C17.3 11.6 8.3 8.7 5.2 14.1c-3.4 6 3.8 10.4 14.9 9.8" />
        <path d="M27.4 22.2C36.4 17.3 39.3 8.3 33.9 5.2c-6-3.4-10.4 3.8-9.8 14.9" />
        <path d="M25.8 27.4C30.7 36.4 39.7 39.3 42.8 33.9c3.4-6-3.8-10.4-14.9-9.8" />
        <path d="M20.6 25.8C11.6 30.7 8.7 39.7 14.1 42.8c6 3.4 10.4-3.8 9.8-14.9" />
      </g>
      <g fill="#ffffff">
        <circle cx="24" cy="18.6" r="2.3" />
        <circle cx="29.4" cy="24" r="2.3" />
        <circle cx="24" cy="29.4" r="2.3" />
        <circle cx="18.6" cy="24" r="2.3" />
        <circle cx="24" cy="24" r="5.1" />
      </g>
    </svg>
  );
}
