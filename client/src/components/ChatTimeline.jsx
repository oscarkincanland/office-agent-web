import React, { useState, useCallback } from "react";

/**
 * 会话消息目录栏（珠子时间线，参考 pi web）
 * - 左侧竖轨 + 用户消息圆珠（按消息在对话流中的位置比例分布）
 * - agent 回答不占珠子，只作为珠子之间的连线长度
 * - 悬停珠子显示问题摘要，点击定位到该消息
 */
export default function ChatTimeline({ messages, containerRef }) {
  const [hoverIdx, setHoverIdx] = useState(null);

  const scrollToMsg = useCallback((idx) => {
    const el = containerRef.current?.querySelector(`[data-msg-index="${idx}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [containerRef]);

  if (!messages || messages.length === 0) return null;

  // 用户消息：取位置比例（0-100%）与摘要；相邻重复消息只保留一个定位点。
  const rawBeads = messages
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.role === "user")
    .map(({ m, i }) => ({
      idx: i,
      summary: (m.text || "").replace(/\s+/g, " ").slice(0, 40) || "（图片/附件）",
      error: m.status === "error",
    }));
  const compactBeads = [];
  for (const bead of rawBeads) {
    const previous = compactBeads[compactBeads.length - 1];
    if (previous && previous.summary === bead.summary) {
      previous.count += 1;
      previous.idx = bead.idx;
      previous.error ||= bead.error;
    } else {
      compactBeads.push({ ...bead, count: 1 });
    }
  }
  const stride = Math.max(1, Math.ceil(compactBeads.length / 24));
  const beads = compactBeads
    .filter((_, i) => i % stride === 0 || i === compactBeads.length - 1)
    .map((bead) => ({
      ...bead,
      top: ((bead.idx + 0.5) / messages.length) * 100,
    }));

  return (
    <div className="chat-timeline beads" aria-label="对话定位">
      <div className="timeline-rail" />
      {beads.map((b) => (
        <div
          key={b.idx}
          className="timeline-bead"
          style={{ top: `${b.top}%` }}
          onMouseEnter={() => setHoverIdx(b.idx)}
          onMouseLeave={() => setHoverIdx(null)}
          onClick={() => scrollToMsg(b.idx)}
          title={`${b.summary}${b.count > 1 ? `（合并 ${b.count} 条重复消息）` : ""}`}
        >
          <span className={`bead-dot ${b.error ? "error" : ""}`} />
          {hoverIdx === b.idx && (
            <div className="bead-tip">
              <span className="bead-tip-role">U</span>
              <span className="bead-tip-text">{b.summary}{b.count > 1 ? ` · ${b.count} 条` : ""}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
