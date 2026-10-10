import React, { useState, useCallback, useEffect } from "react";
import { motionScrollBehavior } from "../界面外观.js";

/**
 * 会话消息目录栏（ZCode 风格细横杠时间线）
 * - 右侧一条竖直的"刻度条"：每条用户消息一根短横杠（按消息在对话流中的位置比例分布）
 * - agent 回答不占刻度，只作为刻度之间的间距
 * - 当前滚动位置所在的刻度高亮；悬停显示问题摘要，点击定位到该消息
 */
export default function ChatTimeline({ messages, containerRef }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const [activeIdx, setActiveIdx] = useState(null);

  const scrollToMsg = useCallback((idx) => {
    const el = containerRef.current?.querySelector(`[data-msg-index="${idx}"]`);
    if (el) el.scrollIntoView({ behavior: motionScrollBehavior(), block: "start" });
  }, [containerRef]);

  // 滚动跟随：把视口上沿附近的那条消息记为"当前刻度"。用 rAF 合帧，滚动本身不做别的活。
  useEffect(() => {
    const root = containerRef?.current;
    if (!root) return undefined;
    let raf = 0;
    const update = () => {
      raf = 0;
      const nodes = root.querySelectorAll("[data-msg-index]");
      if (!nodes.length) return;
      const threshold = root.getBoundingClientRect().top + Math.min(120, root.clientHeight * 0.25);
      let current = null;
      for (const node of nodes) {
        if (node.getBoundingClientRect().top <= threshold) current = Number(node.getAttribute("data-msg-index"));
        else break;
      }
      setActiveIdx(current);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    root.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      root.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [containerRef, messages]);

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
  // 高亮"当前刻度"：取不超过滚动位置的那条；没有则落到第一条。
  const activeKey = (() => {
    if (activeIdx == null) return beads.length ? beads[beads.length - 1].idx : null;
    let current = beads.length ? beads[0].idx : null;
    for (const bead of beads) {
      if (bead.idx <= activeIdx) current = bead.idx;
      else break;
    }
    return current;
  })();

  return (
    <div className="chat-timeline beads" aria-label="对话定位">
      {beads.map((b) => (
        <div
          key={b.idx}
          className={`timeline-bead${b.idx === activeKey ? " active" : ""}${b.error ? " error" : ""}`}
          style={{ top: `${b.top}%` }}
          onMouseEnter={() => setHoverIdx(b.idx)}
          onMouseLeave={() => setHoverIdx(null)}
          onClick={() => scrollToMsg(b.idx)}
          title={`${b.summary}${b.count > 1 ? `（合并 ${b.count} 条重复消息）` : ""}`}
        >
          <span className="bead-dot" />
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
