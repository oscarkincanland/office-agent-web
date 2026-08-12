import React from "react";

/**
 * Open Plan（规聚）品牌 Logo
 * 概念：网格 = 规划（Plan/规），中心汇聚节点 = 聚集（聚）
 * 配色跟随主题 accent 色系（青绿），支持任意 size
 */
export default function Logo({ size = 20, withGradient = true }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Open Plan 规聚">
      <defs>
        <linearGradient id="op-bg" x1="4" y1="4" x2="44" y2="44" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2a8c82" />
          <stop offset="1" stopColor="#14535c" />
        </linearGradient>
      </defs>
      {/* 圆角方块底 */}
      <rect x="2" y="2" width="44" height="44" rx="12" fill={withGradient ? "url(#op-bg)" : "var(--accent, #2a8c82)"} />
      {/* 规划网格 */}
      <g stroke="#ffffff" strokeOpacity="0.22" strokeWidth="1">
        <path d="M2 16h44M2 32h44M16 2v44M32 2v44" />
      </g>
      {/* 汇聚连接线 */}
      <g stroke="#ffffff" strokeOpacity="0.55" strokeWidth="1.4">
        <line x1="12.5" y1="12.5" x2="19.5" y2="19.5" />
        <line x1="35.5" y1="12.5" x2="28.5" y2="19.5" />
        <line x1="12.5" y1="35.5" x2="19.5" y2="28.5" />
        <line x1="35.5" y1="35.5" x2="28.5" y2="28.5" />
      </g>
      {/* 四个汇聚点 */}
      <circle cx="10" cy="10" r="2.6" fill="#ffffff" fillOpacity="0.9" />
      <circle cx="38" cy="10" r="2.6" fill="#ffffff" fillOpacity="0.9" />
      <circle cx="10" cy="38" r="2.6" fill="#ffffff" fillOpacity="0.9" />
      <circle cx="38" cy="38" r="2.6" fill="#ffffff" fillOpacity="0.9" />
      {/* 中心聚焦节点（聚） */}
      <circle cx="24" cy="24" r="9" stroke="#ffffff" strokeWidth="3" />
      <circle cx="24" cy="24" r="3.6" fill="#ffffff" />
    </svg>
  );
}
