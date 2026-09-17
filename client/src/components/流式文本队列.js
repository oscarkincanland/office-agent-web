/**
 * 计算一次展示帧应揭示的字符数。
 * 常规流式保持可感知的逐字节奏；当供应商只在结束时给出整段文本时，
 * 自动追赶积压，避免动画反而拖慢任务完成。
 */
export function 计算展示字符数({ remaining = 0, elapsedMs = 16, reducedMotion = false } = {}) {
  const total = Math.max(0, Number(remaining) || 0);
  if (!total) return 0;
  if (reducedMotion) return total;
  const normalPerSecond = 90;
  const catchUpPerSecond = Math.ceil(total / 0.24);
  const rate = Math.max(normalPerSecond, catchUpPerSecond);
  return Math.min(total, Math.max(1, Math.ceil(rate * Math.max(1, elapsedMs) / 1000)));
}

/**
 * 从一条历史消息中提取真正显示在回复气泡里的文本。
 * Pi 历史可能把正文放在 blocks，也可能只保留旧版 text 字段；两者不能叠加，
 * 否则 run_finished 用权威全文补齐时会把同一结论再次追加一遍。
 */
export function 提取消息展示文本(message) {
  const blockText = (Array.isArray(message?.blocks) ? message.blocks : [])
    .filter((block) => block?.type === "text")
    .map((block) => String(block?.text || ""))
    .join("");
  return blockText || String(message?.text || "");
}
