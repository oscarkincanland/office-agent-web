import { useCallback, useEffect, useState } from "react";

/**
 * 界面外观设置（跑马灯样式 / 配色 / 速度 + 动效强度）。
 *
 * 与设置面板共用同一份 localStorage（`oaw_settings`），但额外提供订阅机制：
 * 设置面板改动后，会话列表、任务中心、地图等已挂载组件要立即生效，
 * 而不是等下一次刷新。CSS 变体统一挂在 <html> 的 data-* 上，组件不再各传一份 prop。
 */
const SETTINGS_KEY = "oaw_settings";

export const MARQUEE_STYLES = Object.freeze([
  { id: "shine", label: "流光扫过", hint: "名字滚动 + 一道高光缓缓扫过" },
  { id: "neon", label: "霓虹呼吸", hint: "整体明暗呼吸，像霓虹灯牌" },
  { id: "rainbow", label: "彩虹渐变", hint: "多色渐变循环流动，最抢眼" },
  { id: "terminal", label: "终端扫描", hint: "等宽字体 + 硬边扫描线，偏工程风" },
  { id: "stripe", label: "斜纹跑马", hint: "斜向条纹滚动，像进度条灯带" },
  { id: "static", label: "静态高亮", hint: "不闪动，只用颜色标出运行中" },
]);

export const MARQUEE_COLORS = Object.freeze([
  { id: "accent", label: "主题色", hint: "跟随当前皮肤强调色" },
  { id: "cyan", label: "青蓝", hint: "#22d3ee → #3b82f6" },
  { id: "violet", label: "紫粉", hint: "#a78bfa → #f472b6" },
  { id: "amber", label: "橙金", hint: "#fbbf24 → #f97316" },
  { id: "emerald", label: "翠绿", hint: "#34d399 → #10b981" },
  { id: "rainbow", label: "多彩", hint: "红橙黄绿青蓝紫循环" },
]);

export const MARQUEE_SPEEDS = Object.freeze([
  { id: "slow", label: "慢", duration: 1.6 },
  { id: "normal", label: "中", duration: 1 },
  { id: "fast", label: "快", duration: 0.6 },
]);

export const MOTION_LEVELS = Object.freeze([
  { id: "full", label: "完整动效", hint: "灯效、呼吸、扫描线全部开启" },
  { id: "calm", label: "克制", hint: "只保留滚动与轻微高光，减少闪烁" },
  { id: "off", label: "关闭动效", hint: "只保留静态颜色标识，彻底不闪" },
]);

export const APPEARANCE_DEFAULTS = Object.freeze({
  marqueeStyle: "shine",
  marqueeColor: "accent",
  marqueeSpeed: "normal",
  motionLevel: "full",
});

const STYLE_IDS = new Set(MARQUEE_STYLES.map((item) => item.id));
const COLOR_IDS = new Set(MARQUEE_COLORS.map((item) => item.id));
const SPEED_IDS = new Set(MARQUEE_SPEEDS.map((item) => item.id));
const MOTION_IDS = new Set(MOTION_LEVELS.map((item) => item.id));

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

/** 读取外观配置（非法值回落到默认） */
export function loadAppearance() {
  const raw = readSettings();
  return {
    marqueeStyle: STYLE_IDS.has(raw.marqueeStyle) ? raw.marqueeStyle : APPEARANCE_DEFAULTS.marqueeStyle,
    marqueeColor: COLOR_IDS.has(raw.marqueeColor) ? raw.marqueeColor : APPEARANCE_DEFAULTS.marqueeColor,
    marqueeSpeed: SPEED_IDS.has(raw.marqueeSpeed) ? raw.marqueeSpeed : APPEARANCE_DEFAULTS.marqueeSpeed,
    motionLevel: MOTION_IDS.has(raw.motionLevel) ? raw.motionLevel : APPEARANCE_DEFAULTS.motionLevel,
  };
}

const listeners = new Set();

function emit() {
  const next = loadAppearance();
  applyAppearance(next);
  for (const listener of listeners) {
    try { listener(next); } catch {}
  }
}

/** 写入外观配置（与设置面板共用 oaw_settings） */
export function saveAppearance(patch = {}) {
  try {
    const settings = readSettings();
    const merged = { ...loadAppearance(), ...patch };
    if (STYLE_IDS.has(merged.marqueeStyle)) settings.marqueeStyle = merged.marqueeStyle;
    if (COLOR_IDS.has(merged.marqueeColor)) settings.marqueeColor = merged.marqueeColor;
    if (SPEED_IDS.has(merged.marqueeSpeed)) settings.marqueeSpeed = merged.marqueeSpeed;
    if (MOTION_IDS.has(merged.motionLevel)) settings.motionLevel = merged.motionLevel;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
  emit();
}

/** 把外观配置写到 <html> 的 data-*，CSS 变体据此生效 */
export function applyAppearance(appearance = loadAppearance()) {
  try {
    const root = document.documentElement;
    root.dataset.marqueeStyle = appearance.marqueeStyle;
    root.dataset.marqueeColor = appearance.marqueeColor;
    root.dataset.marqueeSpeed = appearance.marqueeSpeed;
    root.dataset.motionLevel = appearance.motionLevel;
    // 兜底再同步一次系统偏好：即使 index.html 的内联脚本被剥离，闸门依然生效
    root.dataset.reduceMotion = prefersReducedMotion() ? "1" : "";
  } catch {}
}

/** 系统是否要求减少动效（纯函数，可在事件回调里直接调用） */
export function prefersReducedMotion() {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  } catch {
    return false;
  }
}

/**
 * 统一动效闸门（非 React 版本）：系统"减少动效"优先于产品"完整动效"，
 * 产品"关闭动效"再叠加。命中时不做持续动画/入场动画，滚动与文本揭示立即落定。
 */
export function isMotionReduced() {
  return prefersReducedMotion() || loadAppearance().motionLevel === "off";
}

/** 滚动行为：闸门命中时立即落定，不使用平滑滚动 */
export function motionScrollBehavior() {
  return isMotionReduced() ? "auto" : "smooth";
}

/** React Hook：系统减少动效偏好（跟随系统设置变化） */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener?.("change", sync);
    return () => query.removeEventListener?.("change", sync);
  }, []);
  return reduced;
}

/** React Hook：动效闸门（组件内使用，跟随系统与产品设置变化） */
export function useMotionGate() {
  const { motionLevel } = useAppearance();
  const reducedMotion = useReducedMotion();
  return { motionLevel, reducedMotion, instant: reducedMotion || motionLevel === "off" };
}

/** 订阅外观变化（返回取消订阅函数） */
export function subscribeAppearance(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// 模块加载即应用一次：即使当前页面还没渲染跑马灯，CSS 变体也先挂到 <html> 上
applyAppearance();

// 系统"减少动效"偏好变化时同步 <html>，CSS 闸门据此立即生效（与 index.html 内联脚本互为兜底）
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const syncReduceMotion = () => {
    try { document.documentElement.dataset.reduceMotion = reduceQuery.matches ? "1" : ""; } catch {}
  };
  syncReduceMotion();
  if (reduceQuery.addEventListener) reduceQuery.addEventListener("change", syncReduceMotion);
  else if (reduceQuery.addListener) reduceQuery.addListener(syncReduceMotion);
}

/** React Hook：组件里读取外观配置并跟随设置面板实时更新 */
export function useAppearance() {
  const [appearance, setAppearance] = useState(() => loadAppearance());
  useEffect(() => {
    applyAppearance(appearance);
    const unsubscribe = subscribeAppearance(setAppearance);
    // 其他标签页/其他入口改了设置也要跟随
    const onStorage = (event) => { if (event.key === SETTINGS_KEY) setAppearance(loadAppearance()); };
    window.addEventListener("storage", onStorage);
    return () => { unsubscribe(); window.removeEventListener("storage", onStorage); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return appearance;
}

/** 便捷：返回当前速度倍率（CSS 变量使用） */
export function useMarqueeSpeedScale() {
  const { marqueeSpeed } = useAppearance();
  const item = MARQUEE_SPEEDS.find((entry) => entry.id === marqueeSpeed) || MARQUEE_SPEEDS[1];
  return item.duration;
}

/** 纯函数：把任意输入归一化成合法外观配置（非法值回落默认） */
export function normalizeAppearance(input = {}) {
  return {
    marqueeStyle: STYLE_IDS.has(input.marqueeStyle) ? input.marqueeStyle : APPEARANCE_DEFAULTS.marqueeStyle,
    marqueeColor: COLOR_IDS.has(input.marqueeColor) ? input.marqueeColor : APPEARANCE_DEFAULTS.marqueeColor,
    marqueeSpeed: SPEED_IDS.has(input.marqueeSpeed) ? input.marqueeSpeed : APPEARANCE_DEFAULTS.marqueeSpeed,
    motionLevel: MOTION_IDS.has(input.motionLevel) ? input.motionLevel : APPEARANCE_DEFAULTS.motionLevel,
  };
}

/** 供组件使用的稳定回调（避免每次渲染新建函数） */
export function useAppearanceSetter() {
  return useCallback((patch) => saveAppearance(patch), []);
}
