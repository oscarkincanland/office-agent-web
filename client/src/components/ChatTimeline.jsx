import React, { useState, useCallback } from "react";
import Icon from "./Icon.jsx";

/**
 * 会话消息目录栏（Session Timeline）
 * - 位于对话消息区左侧窄条，鼠标悬停展开、移开隐藏
 * - 每条消息一个条目：角色图标 + 摘要 + 状态
 * - 点击条目 → 对话流滚动定位到该消息
 * - 随对话流式输出实时更新（进行中条目显示呼吸点）
 */
export default function ChatTimeline({ messages, containerRef }) {
  const [hover, setHover] = useState(false);

  const scrollToMsg = useCallback((idx) => {
    const el = containerRef.current?.querySelector(`[data-msg-index="${idx}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [containerRef]);

  // 消息摘要：用户取文本；AI 取首个文本块，否则取工具名
  const summarize = useCallback((m) => {
    if (m.role === "user") return (m.text || "").replace(/\s+/g, " ").slice(0, 24) || "（图片/附件）";
    const tb = (m.blocks || []).find((b) => b.type === "text");
    if (tb?.text) return tb.text.replace(/\s+/g, " ").slice(0, 24);
    const tools = (m.blocks || []).filter((b) => b.type === "tool").map((b) => b.name);
    return tools.length ? `工具: ${tools.join("/")}` : "（思考中）";
  }, []);

  const statusIcon = useCallback((m) => {
    if (m.status === "streaming") return <span className="timeline-live" title="生成中" />;
    if (m.status === "error") return <Icon name="x" size={10} />;
    if (m.role === "assistant") return <Icon name="check" size={10} />;
    return null;
  }, []);

  if (!messages || messages.length === 0) return null;

  return (
    <div
      className={`chat-timeline ${hover ? "hover" : ""}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="timeline-handle" title="会话消息目录（悬停展开）">
        <Icon name="list" size={13} />
      </div>
      {hover && (
        <div className="timeline-list">
          <div className="timeline-head">消息目录 · {messages.length} 条</div>
          {messages.map((m, i) => (
            <div
              key={i}
              className={`timeline-item ${m.role} ${m.status || ""}`}
              onClick={() => scrollToMsg(i)}
              title="点击定位到该消息"
            >
              <span className="timeline-role">{m.role === "user" ? "U" : "A"}</span>
              <span className="timeline-text">{summarize(m)}</span>
              {statusIcon(m)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
