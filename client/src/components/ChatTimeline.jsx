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

  // 用户消息：取位置比例（0-100%）与摘要
  const beads = messages
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.role === "user")
    .map(({ m, i }) => ({
      idx: i,
      top: ((i + 0.5) / messages.length) * 100,
      summary: (m.text || "").replace(/\s+/g, " ").slice(0, 40) || "（图片/附件）",
      error: m.status === "error",
    }));

  return (
    <div className="chat-timeline beads">
      <div className="timeline-rail" />
      {beads.map((b) => (
        <div
          key={b.idx}
          className="timeline-bead"
          style={{ top: `${b.top}%` }}
          onMouseEnter={() => setHoverIdx(b.idx)}
          onMouseLeave={() => setHoverIdx(null)}
          onClick={() => scrollToMsg(b.idx)}
          title={b.summary}
        >
          <span className={`bead-dot ${b.error ? "error" : ""}`} />
          {hoverIdx === b.idx && (
            <div className="bead-tip">
              <span className="bead-tip-role">U</span>
              <span className="bead-tip-text">{b.summary}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
