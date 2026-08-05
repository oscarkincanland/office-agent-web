import React, { useEffect, useRef, useState, useCallback } from "react";
import { fileToBase64, listModels, setAgentModel } from "../api.js";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

let msgSeq = 0;
const newId = () => `m${++msgSeq}`;
const MODEL_KEY = "oaw_model";

export default function ChatPanel({ clientId, onFileChanged, currentDoc, models: modelsProp, defaultModel, onAgentEnd, historyMessages }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [images, setImages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [models, setModels] = useState(modelsProp || []);
  const [model, setModel] = useState("");
  const [modelVision, setModelVision] = useState(false);
  const [modelMsg, setModelMsg] = useState("");
  const bottomRef = useRef(null);
  const assistantIdRef = useRef(null);
  const fileInputRef = useRef(null);

  // 加载历史会话消息（点击历史列表时触发）
  useEffect(() => {
    if (historyMessages) {
      setMessages(historyMessages);
      setBusy(false);
      assistantIdRef.current = null;
    }
  }, [historyMessages]);

  const patch = useCallback((id, fn) => {
    setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));
  }, []);

  // 同步外部 models
  useEffect(() => { if (modelsProp?.length) setModels(modelsProp); }, [modelsProp]);

  // 初始化模型
  useEffect(() => {
    (async () => {
      if (!modelsProp?.length) {
        try { const d = await listModels(); setModels(d.models || []); defaultModel = d.default; } catch {}
      }
      const saved = localStorage.getItem(MODEL_KEY);
      const cur = saved || defaultModel || "";
      setModel(cur);
      applyModel(cur, modelsProp || models);
    })();
  }, []);

  function applyModel(id, list) {
    const m = (list || models).find((x) => x.id === id);
    setModelVision(!!m?.vision);
    localStorage.setItem(MODEL_KEY, id);
  }

  const changeModel = async (id) => {
    setModel(id);
    applyModel(id);
    setModelMsg("切换中...");
    try { await setAgentModel(clientId, id); setModelMsg("ok"); }
    catch (e) { setModelMsg("失败: " + e.message); }
    setTimeout(() => setModelMsg(""), 2500);
  };

  // SSE 连接
  useEffect(() => {
    const es = new EventSource(`/api/agent/stream?client=${encodeURIComponent(clientId)}`);
    es.onopen = () => setConnected(true);
    es.onmessage = (e) => { try { handleEvent(JSON.parse(e.data)); } catch {} };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [clientId]);

  function handleEvent(ev) {
    const { type, data } = ev;
    const aid = assistantIdRef.current;
    switch (type) {
      // 文本 token
      case "token":
        if (aid) patch(aid, (m) => ({ ...m, text: m.text + data.text }));
        break;
      // 思考过程
      case "thinking":
        if (aid) patch(aid, (m) => ({ ...m, thinking: (m.thinking || "") + data.text }));
        break;
      // 工具调用开始
      case "tool_start":
        if (aid) patch(aid, (m) => ({
          ...m,
          tools: [...(m.tools || []), {
            id: newId(),
            name: data.name,
            input: data.input || "",
            output: "",
            done: false,
            isError: false,
            expanded: false,
          }],
        }));
        break;
      // 工具输出流
      case "tool_output":
        if (aid) patch(aid, (m) => {
          const tools = [...(m.tools || [])];
          const last = tools[tools.length - 1];
          if (last && !last.done) last.output = (last.output || "") + (data.output || "");
          return { ...m, tools };
        });
        break;
      // 工具调用结束
      case "tool_end":
        if (aid) patch(aid, (m) => {
          const tools = [...(m.tools || [])];
          const last = tools[tools.length - 1];
          if (last) {
            last.done = true;
            last.isError = !!data.isError;
            if (data.result) last.result = data.result;
          }
          return { ...m, tools };
        });
        break;
      // 消息开始/结束
      case "message_start":
        break;
      case "message_end":
        break;
      case "agent_end":
        if (aid) patch(aid, (m) => ({ ...m, status: "done" }));
        assistantIdRef.current = null;
        setBusy(false);
        if (onAgentEnd) onAgentEnd();
        break;
      case "agent_error":
        if (aid) patch(aid, (m) => ({ ...m, status: "error", text: m.text || data.message }));
        assistantIdRef.current = null;
        setBusy(false);
        break;
      case "steer":
        // 打断了当前回合，新指令已注入；当前消息保持 streaming，由后续 agent_end 收尾
        pushSystem(`⟳ 插入新指令: ${(data.text || "").slice(0, 60)}...`);
        break;
      case "aborted":
        // 用户主动中止
        if (aid) patch(aid, (m) => ({ ...m, status: "done", text: m.text + (m.text ? "\n" : "") + "(已中止)" }));
        assistantIdRef.current = null;
        setBusy(false);
        break;
      case "file_changed":
        pushSystem(`文件已更新: ${(data.files || []).join(", ")}`);
        if (data.files?.length) onFileChanged(data.files);
        break;
      default:
        break;
    }
  }

  const pushSystem = useCallback((text) => {
    setMessages((ms) => [...ms, { id: newId(), role: "system", text, status: "done" }]);
  }, []);

  const send = async () => {
    const text = input.trim();
    if (!text && images.length === 0) return; // busy 时也允许发送 = 打断插入新指令
    const imgs = images.map((i) => ({ mediaType: i.mediaType, data: i.data }));

    // 注入当前文件上下文
    const contextPrefix = currentDoc ? `[当前打开文件: ${currentDoc}]\n` : "";
    const fullText = contextPrefix + text;

    setMessages((ms) => [...ms, {
      id: newId(), role: "user", text,
      images: images.map((i) => i.dataUrl),
      status: "done", currentDoc,
    }]);
    const aid = newId();
    assistantIdRef.current = aid;
    setMessages((ms) => [...ms, {
      id: aid, role: "assistant", text: "", thinking: "", tools: [],
      status: "streaming", images: [],
    }]);
    setInput("");
    setImages([]);
    setBusy(true);
    try {
      const res = await fetch("/api/agent/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: clientId, text: fullText, images: imgs }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        patch(aid, (m) => ({ ...m, status: "error", text: d.error || "请求失败" }));
        assistantIdRef.current = null;
        setBusy(false);
      }
    } catch (e) {
      patch(aid, (m) => ({ ...m, status: "error", text: "网络错误: " + e.message }));
      assistantIdRef.current = null;
      setBusy(false);
    }
  };

  // 中止当前 agent 运行
  const stop = async () => {
    try {
      await fetch("/api/agent/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: clientId }),
      });
    } catch {}
  };

  const handleFiles = async (list) => {
    const added = [];
    for (const f of Array.from(list).slice(0, 6)) {
      if (!f.type.startsWith("image/")) continue;
      try {
        const { mediaType, data } = await fileToBase64(f);
        added.push({ mediaType, data, dataUrl: `data:${mediaType};base64,${data}`, name: f.name });
      } catch {}
    }
    if (added.length) setImages((im) => [...im, ...added]);
  };

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const hint = currentDoc || "未打开文件";

  return (
    <div className="chat">
      <div className="chat-head">
        <span>agent</span>
        <select className="model-select" value={model} onChange={(e) => changeModel(e.target.value)} title="选择模型 (V=支持图片)">
          <option value="">-- 选择模型 --</option>
          {models.map((m) => <option key={m.id} value={m.id}>{m.vision ? "[V] " : ""}{m.id}</option>)}
        </select>
        {modelMsg && <span className="model-msg">{modelMsg}</span>}
        <span className={`conn ${connected ? "on" : ""}`}>{connected ? "已连接" : "连接中..."}</span>
        <span className="doc-hint" title={hint}>{hint}</span>
      </div>

      <div className="chat-body">
        {messages.length === 0 && (
          <div className="chat-empty">
            <div>发送消息给 agent</div>
            <div className="hint">
              示例: 「把标题改成红色加粗」<br />
              「在 test-data.xlsx 的 B3 填 88」<br />
              粘贴图片可辅助说明（需选择 [V] 模型）
            </div>
          </div>
        )}
        {messages.map((m) => <Message key={m.id} m={m} onToggleTool={(toolId) => {
          patch(m.id, (msg) => ({
            ...msg,
            tools: msg.tools.map((t) => t.id === toolId ? { ...t, expanded: !t.expanded } : t),
          }));
        }} />)}
        <div ref={bottomRef} />
      </div>

      {images.length > 0 && !modelVision && (
        <div className="vision-hint">当前模型可能不支持图片，建议切换 [V] 模型</div>
      )}
      {images.length > 0 && (
        <div className="img-preview-row">
          {images.map((img, i) => (
            <div className="img-chip" key={i}>
              <img src={img.dataUrl} alt={img.name} />
              <button onClick={() => setImages((im) => im.filter((_, j) => j !== i))}>x</button>
            </div>
          ))}
        </div>
      )}
      <div className="chat-input">
        <textarea
          value={input}
          placeholder={busy ? "输入新指令可打断当前回复..." : "输入指令... (Enter 发送，Shift+Enter 换行，可粘贴图片)"}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          onCompositionEnd={() => {}}
          onPaste={(e) => {
            const items = e.clipboardData?.items;
            if (items) handleFiles(Array.from(items).filter((it) => it.kind === "file").map((it) => it.getAsFile()));
          }}
          onChange={(e) => setInput(e.target.value)}
        />
        <div className="input-actions">
          <button className="btn" title="上传图片" onClick={() => fileInputRef.current?.click()}>图片</button>
          <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
          {busy ? (
            <button className="btn danger stop-btn" onClick={stop}>■ 停止</button>
          ) : (
            <button className="btn primary send-btn" onClick={send}>发送</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ========== 消息组件 ==========
function Message({ m, onToggleTool }) {
  if (m.role === "system") {
    return <div className="msg system"><div className="bubble">{m.text}</div></div>;
  }
  const isUser = m.role === "user";

  return (
    <div className={`msg ${isUser ? "user" : "assistant"} ${m.status || ""}`}>
      <div className="avatar">{isUser ? ">" : "$"}</div>
      <div className="bubble">
        {/* 用户图片 */}
        {m.images?.length > 0 && (
          <div className="msg-images">{m.images.map((src, i) => <img key={i} src={src} alt="" />)}</div>
        )}
        {/* 用户文件上下文标记 */}
        {m.currentDoc && (
          <div className="msg-context">当前文件: {m.currentDoc}</div>
        )}
        {/* 思考过程（可折叠） */}
        {m.thinking && <ThinkingBlock text={m.thinking} />}
        {/* 工具调用卡片 */}
        {m.tools?.length > 0 && (
          <div className="tools">
            {m.tools.map((t) => (
              <ToolCard key={t.id} tool={t} onToggle={() => onToggleTool(t.id)} />
            ))}
          </div>
        )}
        {/* 正文：assistant 用 Markdown 渲染，user 用纯文本 */}
        {m.text ? (
          isUser ? (
            <div className="msg-text">{m.text}</div>
          ) : (
            <div className="msg-text markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
            </div>
          )
        ) : null}
        {/* 流式指示 */}
        {m.status === "streaming" && !m.text && !m.thinking && !m.tools?.length && (
          <span className="typing">_</span>
        )}
        {m.status === "error" && <div className="err-badge">出错了</div>}
      </div>
    </div>
  );
}

// ========== 思考过程块 ==========
function ThinkingBlock({ text }) {
  const [expanded, setExpanded] = useState(false);
  const preview = text.length > 100 ? text.slice(0, 100) + "..." : text;
  return (
    <div className="thinking-block" onClick={() => setExpanded(!expanded)}>
      <div className="thinking-header">
        <span className="thinking-icon">{expanded ? "v" : ">"}</span>
        <span className="thinking-label">思考过程</span>
      </div>
      <div className="thinking-text">{expanded ? text : preview}</div>
    </div>
  );
}

// ========== 工具调用卡片 ==========
function ToolCard({ tool, onToggle }) {
  const { name, input, output, done, isError, expanded } = tool;
  const inputPreview = typeof input === "string" ? input : JSON.stringify(input);
  const outputPreview = output?.length > 200 ? output.slice(0, 200) + "..." : output;

  return (
    <div className={`tool-card ${done ? (isError ? "error" : "success") : "pending"}`} onClick={onToggle}>
      <div className="tool-header">
        <span className="tool-icon">{done ? (isError ? "x" : "v") : "..."}</span>
        <span className="tool-name">{name}</span>
        {inputPreview && <span className="tool-input-preview">{inputPreview.slice(0, 60)}</span>}
      </div>
      {expanded && (
        <div className="tool-detail">
          {inputPreview && (
            <div className="tool-section">
              <div className="tool-section-label">输入:</div>
              <pre className="tool-code">{inputPreview}</pre>
            </div>
          )}
          {(output || tool.result) && (
            <div className="tool-section">
              <div className="tool-section-label">{done ? "结果:" : "输出:"}</div>
              <pre className="tool-code">{expanded ? (output || tool.result) : outputPreview}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
