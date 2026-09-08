/**
 * 计算一次展示帧应揭示的字符数。
 * 常规流式保持可感知的逐字节奏；当供应商只在结束时给出整段文本时，
 * 自动追赶积压，避免动画反而拖慢任务完成。
 */
export function 计算展示字符数({ remaining = 0, elapsedMs = 16, reducedMotion = false } = {}) {
  const total = Math.max(0, Number(remaining) || 0);
  if (!total) return 0;
  if (reducedMotion) return total;
  const normalPerSecond = 52;
  const catchUpPerSecond = Math.ceil(total / 0.28);
  const rate = Math.max(normalPerSecond, catchUpPerSecond);
  return Math.min(total, Math.max(1, Math.ceil(rate * Math.max(1, elapsedMs) / 1000)));
}
