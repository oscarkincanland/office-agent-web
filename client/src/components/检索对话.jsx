import React, { useCallback, useMemo, useState } from "react";
import ChatPanel from "./ChatPanel.jsx";

/**
 * 知识库 / Skills 入口共用的只读 Chat。
 * 它复用主 ChatPanel 的 Pi SSE、重连、工具事件和会话处理，避免页面入口各自维护一套对话协议。
 */
export default function RetrievalChat({
  scope = "knowledge",
  title = "检索 Chat",
  clientId,
  workspace = "",
  project = null,
  models = [],
  defaultModel = "",
  contextLabel = "",
  contextText = "",
  references = [],
  onClose,
  onPromoteToAgent,
}) {
  const storageKey = `oaw_retrieval_thread_${scope}`;
  const [threadId] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) return saved;
      const next = `retrieval-${scope}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
      localStorage.setItem(storageKey, next);
      return next;
    } catch {
      return `retrieval-${scope}`;
    }
  });
  const referenceKey = useMemo(() => references.map((item) => `${item.id || ""}:${item.kind || ""}:${item.target || ""}`).join("|"), [references]);
  const initialReferences = useMemo(() => references, [referenceKey]);
  const promote = useCallback((payload) => {
    onPromoteToAgent?.({
      ...payload,
      references: payload?.references?.length ? payload.references : initialReferences,
      contextText: [contextText, payload?.contextText].filter(Boolean).join("\n\n"),
    });
  }, [contextText, initialReferences, onPromoteToAgent]);

  return (
    <div className="retrieval-chat-shell">
      <div className="retrieval-chat-head">
        <div>
          <div className="retrieval-chat-title">{title}</div>
          <div className="retrieval-chat-subtitle">只读搜索与说明 · 不修改文件</div>
        </div>
        {onClose && <button className="btn-xs" onClick={onClose}>关闭</button>}
      </div>
      <ChatPanel
        clientId={clientId}
        threadId={threadId}
        workspace={workspace}
        project={project}
        currentDoc={contextLabel}
        models={models}
        defaultModel={defaultModel}
        embedded
        forcedMode="chat"
        panelTitle="Chat"
        contextText={contextText}
        initialReferences={initialReferences}
        onPromoteToAgent={promote}
        onFileChanged={() => {}}
        onMapAction={() => {}}
        onNewSession={() => {}}
        onRefreshSessions={() => {}}
        onSessionChange={() => {}}
        sessions={[]}
        unreadByThread={{}}
      />
    </div>
  );
}
