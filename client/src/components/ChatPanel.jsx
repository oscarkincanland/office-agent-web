import React, { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { fileToBase64, listModels, setAgentModel } from "../api.js";
import MarkdownBody from "./MarkdownBody.jsx";
import Icon from "./Icon.jsx";

// 错误边界包装器
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ChatPanel error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="chat-error-boundary">
          <div className="error-content">
            <div className="error-icon"><Icon name="warning" size={32} /></div>
            <div className="error-text">组件出错，请刷新页面</div>
            <button className="btn" onClick={() => window.location.reload()}>
              刷新页面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

let msgSeq = 0;
const newId = () => `m${++msgSeq}`;
const MODEL_KEY = "oaw_model";

// blocks 辅助：追加/合并文本块、思考块
function appendTextBlock(blocks, text) {
  const arr = [...blocks];
  const last = arr[arr.length - 1];
  if (last && last.type === "text") {
    last.text = (last.text || "") + text;
    return arr;
  }
  arr.push({ type: "text", text });
  return arr;
}
function appendThinkingBlock(blocks, text) {
  const arr = [...blocks];
  const last = arr[arr.length - 1];
  if (last && last.type === "thinking") {
    last.text = (last.text || "") + text;
    return arr;
  }
  arr.push({ type: "thinking", text });
  return arr;
}

export default forwardRef(function ChatPanel({ clientId, onFileChanged, currentDoc, models: modelsProp, defaultModel, onAgentEnd, historyMessages, onNewSession, onOpenFile, sessions = [], onSelectSession }, ref) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [images, setImages] = useState([]);
  const [attachments, setAttachments] = useState([]); // 非图片附件
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [models, setModels] = useState(modelsProp || []);
  const [model, setModel] = useState("");
  const [modelVision, setModelVision] = useState(false);
  const [modelMsg, setModelMsg] = useState("");
  const [editMode, setEditMode] = useState("office"); // "office" | "agent"：office编辑模式 / 普通agent模式
  const bottomRef = useRef(null);
  const assistantIdRef = useRef(null);
  const fileInputRef = useRef(null);
  const attInputRef = useRef(null);
  // streaming 累积缓冲（性能优化：避免每 token setState）
  const streamBufRef = useRef(null);
  const rafRef = useRef(null);
  const streamingMsgIdRef = useRef(null);
  // 组件挂载状态追踪，防止卸载后更新状态
  const mountedRef = useRef(true);

  // 组件卸载时标记
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // 清理定时器和动画帧
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  // 加载历史会话消息（点击历史列表时触发）
  useEffect(() => {
    if (historyMessages) {
      setMessages(historyMessages);
      setBusy(false);
      assistantIdRef.current = null;
      streamBufRef.current = null;
      streamingMsgIdRef.current = null;
    }
  }, [historyMessages]);

  // 新建会话：清空消息
  const handleNewSession = useCallback(() => {
    setMessages([]);
    setBusy(false);
    assistantIdRef.current = null;
    streamBufRef.current = null;
    streamingMsgIdRef.current = null;
    setInput("");
    setImages([]);
    setAttachments([]);
    if (onNewSession) onNewSession();
  }, [onNewSession]);

  // 暴露插入文本方法（供 @ 按钮调用）
  useImperativeHandle(ref, () => ({
    insertText(text) {
      setInput((v) => {
        const sep = v && !v.endsWith(" ") ? " " : "";
        return v + sep + text;
      });
    },
  }));

  // 流式刷新调度：合并同一帧内的多次文本追加
  const patch = useCallback((id, fn) => {
    if (!mountedRef.current) return;
    setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));
  }, []);

  const scheduleFlush = useCallback((type, data) => {
    if (!streamBufRef.current) return;
    const buf = streamBufRef.current;
    if (type === "token") buf.text += data.text;
    else if (type === "thinking") buf.thinking += data.text;
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const id = streamingMsgIdRef.current;
        if (id && streamBufRef.current) {
          const { text, thinking } = streamBufRef.current;
          if (text || thinking) {
            patch(id, (m) => {
              let blocks = [...(m.blocks || [])];
              if (text) blocks = appendTextBlock(blocks, text);
              if (thinking) blocks = appendThinkingBlock(blocks, thinking);
              return { ...m, blocks };
            });
          }
          // 清空已刷新的增量
          streamBufRef.current.text = "";
          streamBufRef.current.thinking = "";
        }
      });
    }
  }, [patch]);

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
    let es = null;
    let reconnectTimer = null;
    
    const connect = () => {
      if (!mountedRef.current) return;
      
      es = new EventSource(`/api/agent/stream?client=${encodeURIComponent(clientId)}`);
      
      es.onopen = () => {
        if (mountedRef.current) setConnected(true);
      };
      
      es.onmessage = (e) => {
        if (!mountedRef.current) return;
        try { 
          handleEvent(JSON.parse(e.data)); 
        } catch (err) {
          console.error("SSE message parse error:", err);
        }
      };
      
      es.onerror = () => {
        if (mountedRef.current) {
          setConnected(false);
          // 自动重连
          es.close();
          reconnectTimer = setTimeout(connect, 3000);
        }
      };
    };
    
    connect();
    
    return () => {
      if (es) es.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [clientId]);

  function handleEvent(ev) {
    const { type, data } = ev;
    const aid = assistantIdRef.current;
    // 追加/更新 block 的辅助函数
    const appendToBlock = (type, field, text, makeNew) => {
      if (!aid) return;
      patch(aid, (m) => {
        const blocks = [...(m.blocks || [])];
        const last = blocks[blocks.length - 1];
        if (last && last.type === type) {
          last[field] = (last[field] || "") + text;
          return { ...m, blocks };
        }
        blocks.push(makeNew(text));
        return { ...m, blocks };
      });
    };
    switch (type) {
      // 文本 token：节流合并到 blocks
      case "token":
        if (aid) scheduleFlush("token", data);
        break;
      // 思考过程：节流合并到 blocks
      case "thinking":
        if (aid) scheduleFlush("thinking", data);
        break;
      // 工具调用开始：推入新 tool block
      case "tool_start":
        if (aid) {
          if (streamBufRef.current) flushNow(aid);
          patch(aid, (m) => ({
            ...m,
            blocks: [...(m.blocks || []), {
              type: "tool",
              id: newId(),
              name: data.name,
              input: data.input || "",
              output: "",
              done: false,
              isError: false,
              expanded: false,
              startTime: Date.now(),
              duration: null,
            }],
          }));
        }
        break;
      // 工具输出流：更新最后一个 tool block
      case "tool_output":
        if (aid) patch(aid, (m) => {
          const blocks = [...(m.blocks || [])];
          const last = blocks[blocks.length - 1];
          if (last && last.type === "tool" && !last.done) last.output = (last.output || "") + (data.output || "");
          return { ...m, blocks };
        });
        break;
      // 工具调用结束：标记完成
      case "tool_end":
        if (aid) patch(aid, (m) => {
          const blocks = [...(m.blocks || [])];
          const last = blocks[blocks.length - 1];
          if (last && last.type === "tool") {
            last.done = true;
            last.isError = !!data.isError;
            if (data.result) last.result = data.result;
            if (last.startTime) last.duration = ((Date.now() - last.startTime) / 1000).toFixed(1);
          }
          return { ...m, blocks };
        });
        break;
      // 消息开始/结束
      case "message_start":
        break;
      case "message_end":
        break;
      case "agent_end":
        if (streamBufRef.current) flushNow(aid);
        if (aid) patch(aid, (m) => ({ ...m, status: "done" }));
        assistantIdRef.current = null;
        streamBufRef.current = null;
        streamingMsgIdRef.current = null;
        setBusy(false);
        if (onAgentEnd) onAgentEnd();
        break;
      case "agent_error":
        if (aid) patch(aid, (m) => ({ ...m, status: "error", errorText: data.message || "出错了" }));
        assistantIdRef.current = null;
        streamBufRef.current = null;
        streamingMsgIdRef.current = null;
        setBusy(false);
        break;
      case "steer":
        pushSystem(`⟳ 插入新指令: ${(data.text || "").slice(0, 60)}...`);
        break;
      case "aborted":
        if (aid) patch(aid, (m) => ({
          ...m,
          status: "done",
          blocks: appendTextBlock(m.blocks || [], "\n(已中止)"),
        }));
        assistantIdRef.current = null;
        streamBufRef.current = null;
        streamingMsgIdRef.current = null;
        setBusy(false);
        break;
      case "file_changed":
        pushSystem(`文件已更新: ${(data.files || []).join(", ")}`);
        if (data.files?.length) onFileChanged(data.files);
        break;
      case "agent_summary":
        // 对话结束总结条
        if (data.products?.length) {
          setMessages((ms) => [...ms, {
            id: newId(),
            role: "system",
            text: `${data.summary || "本轮对话完成"}`,
            products: data.products,
            status: "done",
            summary: true,
          }]);
        }
        break;
      default:
        break;
    }
  }

  // 立即刷新流式缓冲（工具边界、agent_end 前调用）
  const flushNow = useCallback((id) => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    const buf = streamBufRef.current;
    if (id && buf && (buf.text || buf.thinking)) {
      const { text, thinking } = buf;
      patch(id, (m) => {
        let blocks = [...(m.blocks || [])];
        if (text) blocks = appendTextBlock(blocks, text);
        if (thinking) blocks = appendThinkingBlock(blocks, thinking);
        return { ...m, blocks };
      });
      buf.text = "";
      buf.thinking = "";
    }
  }, [patch]);

  const pushSystem = useCallback((text) => {
    if (!mountedRef.current) return;
    setMessages((ms) => [...ms, { id: newId(), role: "system", text, status: "done" }]);
  }, []);

  const send = async () => {
    const text = input.trim();
    if (!text && images.length === 0 && attachments.length === 0) return; // busy 时也允许发送 = 打断插入新指令
    const imgs = images.map((i) => ({ mediaType: i.mediaType, data: i.data }));
    const atts = attachments.map((a) => ({ name: a.name, mediaType: a.mediaType, data: a.data }));

    // 注入当前文件上下文
    const contextPrefix = currentDoc ? `[当前打开文件: ${currentDoc}]\n` : "";
    // 按模式注入指令提示
    const modePrefix = editMode === "office"
      ? "[模式: Office编辑] 优先用 officecli 工具对当前文档做精准文本/样式修改，不要创建新文件。\n"
      : "[模式: 创作] 你可以调用所有 skills 和工具生成新文件（文档/HTML/PPT等），产物保存到当前工作区。\n";
    const attachPrefix = attachments.length > 0
      ? `[已上传附件: ${attachments.map((a) => a.name).join(", ")}，文件已保存到工作区，可读取处理]\n`
      : "";
    const fullText = contextPrefix + modePrefix + attachPrefix + text;

    if (!mountedRef.current) return;
    
    setMessages((ms) => [...ms, {
      id: newId(), role: "user", text,
      images: images.map((i) => i.dataUrl),
      attachments: attachments.map((a) => a.name),
      status: "done", currentDoc,
    }]);
    const aid = newId();
    assistantIdRef.current = aid;
    streamingMsgIdRef.current = aid;
    streamBufRef.current = { text: "", thinking: "" };
    setMessages((ms) => [...ms, {
      id: aid, role: "assistant", blocks: [],
      status: "streaming", images: [],
    }]);
    setInput("");
    setImages([]);
    setAttachments([]);
    setBusy(true);
    try {
      const res = await fetch("/api/agent/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: clientId, text: fullText, images: imgs, attachments: atts }),
      });
      if (!mountedRef.current) return;
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        patch(aid, (m) => ({ ...m, status: "error", text: d.error || "请求失败" }));
        assistantIdRef.current = null;
        if (mountedRef.current) setBusy(false);
      }
    } catch (e) {
      if (!mountedRef.current) return;
      patch(aid, (m) => ({ ...m, status: "error", text: "网络错误: " + e.message }));
      assistantIdRef.current = null;
      if (mountedRef.current) setBusy(false);
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
    const addedImgs = [];
    const addedAtts = [];
    const ALLOWED_EXT = /\.(docx|xlsx|pptx|md|markdown|txt|pdf|html|htm|csv|json)$/i;
    for (const f of Array.from(list).slice(0, 6)) {
      if (f.type.startsWith("image/")) {
        try {
          const { mediaType, data } = await fileToBase64(f);
          addedImgs.push({ mediaType, data, dataUrl: `data:${mediaType};base64,${data}`, name: f.name });
        } catch {}
      } else if (ALLOWED_EXT.test(f.name)) {
        try {
          const { mediaType, data } = await fileToBase64(f);
          addedAtts.push({ mediaType, data, dataUrl: `data:${mediaType};base64,${data}`, name: f.name });
        } catch {}
      }
    }
    if (addedImgs.length) setImages((im) => [...im, ...addedImgs]);
    if (addedAtts.length) setAttachments((at) => [...at, ...addedAtts]);
  };

  // 滚动：用户向上滑动查看历史时暂停自动滚动；在底部才自动滚到最新
  const scrollTimerRef = useRef(null);
  const bodyRef = useRef(null);
  const userScrolledUpRef = useRef(false);
  useEffect(() => {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      const el = bodyRef.current;
      if (!el) return;
      // 判断用户是否在底部（距底部 < 80px 视为在底部）
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (nearBottom) {
        userScrolledUpRef.current = false;
        bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      }
      // 用户主动向上滑时 userScrolledUpRef 被标记，跳过自动滚动
    }, 60);
    return () => { if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current); };
  }, [messages]);

  const hint = currentDoc || "未打开文件";

  return (
    <ErrorBoundary>
      <div className="chat">
        <div className="chat-head">
          <span className="chat-title">agent</span>
          <button className="btn-xs new-session-btn" onClick={handleNewSession} title="新建会话">＋ 新建会话</button>
          <div className="mode-switch" title="切换编辑模式">
            <button
              className={`mode-btn ${editMode === "office" ? "active" : ""}`}
              onClick={() => setEditMode("office")}
            ><Icon name="doc" size={12} /> Office</button>
            <button
              className={`mode-btn ${editMode === "agent" ? "active" : ""}`}
              onClick={() => setEditMode("agent")}
            ><Icon name="pen-tool" size={12} /> 创作</button>
          </div>
          <select className="model-select" value={model} onChange={(e) => changeModel(e.target.value)} title="选择模型 (V=支持图片)">
            <option value="">-- 选择模型 --</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.vision ? "[V] " : ""}{m.id}</option>)}
          </select>
          {modelMsg && <span className="model-msg">{modelMsg}</span>}
          <span className={`conn ${connected ? "on" : ""}`}>{connected ? "已连接" : "连接中..."}</span>
          <span className="doc-hint" title={hint}>{hint}</span>
        </div>

        {sessions.length > 0 && (
          <div className="chat-recent">
            <span className="chat-recent-label"><Icon name="history" size={11} /> 最近会话</span>
            <div className="chat-recent-list">
              {sessions.slice(0, 5).map((s) => (
                <span
                  key={s.id}
                  className="chat-recent-item"
                  title={s.title || s.label || s.id}
                  onClick={() => onSelectSession && onSelectSession(s)}
                >
                  {s.title || s.label || s.id.slice(0, 8)}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="chat-body" ref={bodyRef} onScroll={() => {
          const el = bodyRef.current;
          if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 80) {
            userScrolledUpRef.current = true;
          }
        }}>
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
          {messages.map((m) => <Message key={m.id} m={m} onOpenFile={onOpenFile} onToggleTool={(toolId) => {
            patch(m.id, (msg) => {
              let blocks = [...(msg.blocks || [])];
              blocks = blocks.map((b, i) => {
                if (b.type === "tool" && (b.id === toolId || (b.id === undefined && i === toolId))) {
                  return { ...b, expanded: !b.expanded };
                }
                return b;
              });
              return { ...msg, blocks };
            });
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
        {attachments.length > 0 && (
          <div className="att-preview-row">
            {attachments.map((att, i) => (
              <div className="att-chip" key={i} title={att.name}>
                <Icon name="file" size={13} />
                <span className="att-name">{att.name}</span>
                <button className="att-remove" onClick={() => setAttachments((at) => at.filter((_, j) => j !== i))}>
                  <Icon name="x" size={10} />
                </button>
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
            <button className="btn" title="上传图片" onClick={() => fileInputRef.current?.click()}><Icon name="image" size={12} /> 图片</button>
            <button className="btn" title="上传附件（docx/xlsx/pdf/md/txt 等）" onClick={() => attInputRef.current?.click()}><Icon name="link" size={12} /> 附件</button>
            <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
            <input ref={attInputRef} type="file" accept=".docx,.xlsx,.pptx,.md,.markdown,.txt,.pdf,.html,.htm,.csv,.json" multiple hidden onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
            {busy ? (
              <button className="btn danger stop-btn" onClick={stop}><Icon name="stop" size={12} /> 停止</button>
            ) : (
              <button className="btn primary send-btn" onClick={send}><Icon name="send" size={12} /> 发送</button>
            )}
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
});

// ========== 消息组件（pi-web MessageView 风格：text/thinking/toolCall 分块渲染） ==========
function Message({ m, onToggleTool, onOpenFile }) {
  if (m.role === "system") {
    return (
      <div className="msg system">
        <div className="bubble">
          {m.text}
          {m.products?.length > 0 && (
            <div className="summary-products">
              {m.products.map((p) => (
                <span 
                  key={p} 
                  className="summary-product clickable"
                  onClick={() => onOpenFile && onOpenFile(p)}
                  title={`点击打开 ${p}`}
                >
                  <Icon name="file" size={11} /> {p}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
  const isUser = m.role === "user";
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const blocks = m.blocks || [];
  // 从 blocks 提取工具步骤（用于 todo list）
  const toolBlocks = blocks.filter((b) => b.type === "tool");
  const hasContent = blocks.length > 0 || m.images?.length > 0;

  const copyText = async () => {
    try {
      const allText = blocks.map((b) => b.type === "text" ? b.text : b.type === "tool" ? (b.name + " " + (b.input || "")) : "").join("\n");
      await navigator.clipboard.writeText(allText || m.text || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div
      className={`msg ${isUser ? "user" : "assistant"} ${m.status || ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className={`avatar ${isUser ? "user-avatar" : "agent-avatar"}`}>
        <Icon name={isUser ? "user" : "robot"} size={14} />
      </div>
      <div className="msg-main">
        {/* 用户消息：一个气泡 */}
        {isUser ? (
          <div className="bubble">
            {m.images?.length > 0 && (
              <div className="msg-images">{m.images.map((src, i) => <img key={i} src={src} alt="" />)}</div>
            )}
            {m.currentDoc && <div className="msg-context">当前文件: {m.currentDoc}</div>}
            {m.text && <div className="msg-text">{m.text}</div>}
          </div>
        ) : (
          <>
            {/* 工具步骤 todo list */}
            {toolBlocks.length > 0 && <TodoList tools={toolBlocks} />}
            {/* blocks 按序渲染：思考/工具/文本各自独立气泡 */}
            {blocks.map((b, i) => {
              if (b.type === "thinking") return <ThinkingBlock key={i} text={b.text} />;
              if (b.type === "tool") return <ToolCard key={b.id || i} tool={b} onToggle={() => onToggleTool(b.id || i)} />;
              if (b.type === "text") {
                return (
                  <div className="bubble markdown-bubble" key={i}>
                    <MarkdownBody>{b.text}</MarkdownBody>
                  </div>
                );
              }
              return null;
            })}
            {/* 流式指示 */}
            {m.status === "streaming" && !hasContent && (
              <div className="bubble"><span className="typing">_</span></div>
            )}
            {m.status === "error" && <div className="err-badge">{m.errorText || "出错了"}</div>}
            {/* 复制按钮 */}
            {hasContent && m.status === "done" && (
              <button
                className={`copy-btn ${copied ? "copied" : ""}`}
                style={{ opacity: hovered ? 1 : 0 }}
                onClick={copyText}
                title="复制"
              >
                {copied ? <Icon name="check" size={12} /> : <Icon name="copy" size={12} />}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ========== 步骤 todo list（展示工具调用序列） ==========
function TodoList({ tools }) {
  const [open, setOpen] = useState(true);
  const done = tools.filter((t) => t.done).length;
  return (
    <div className={`todo-list ${open ? "open" : ""}`}>
      <div className="todo-head" onClick={() => setOpen(!open)}>
        <span className="todo-icon">{open ? "▾" : "▸"}</span>
        <span className="todo-title">执行步骤</span>
        <span className="todo-progress">{done}/{tools.length}</span>
      </div>
      {open && (
        <div className="todo-body">
          {tools.map((t, i) => (
            <div key={t.id || i} className={`todo-item ${t.done ? "done" : "running"} ${t.isError ? "err" : ""}`}>
              <span className="todo-num">{t.done ? <Icon name="check" size={11} /> : t.isError ? <Icon name="x" size={11} /> : "●"}</span>
              <span className="todo-tool">{t.name}</span>
              <span className="todo-cmd">{typeof t.input === "string" ? t.input.slice(0, 40) : ""}</span>
              {t.duration && <span className="todo-dur">{t.duration}s</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ========== 思考过程块（独立气泡：折叠 + 耗时） ==========
function ThinkingBlock({ text }) {
  const [expanded, setExpanded] = useState(true); // 默认展开，推理过程实时可见
  return (
    <div className={`thinking-block ${expanded ? "expanded" : ""}`} onClick={() => setExpanded(!expanded)}>
      <div className="thinking-header">
        <span className="thinking-icon">{expanded ? "▾" : "▸"}</span>
        <span className="thinking-label"><Icon name="info" size={11} /> 思考</span>
        <span className="thinking-duration">{text.length} 字</span>
      </div>
      {expanded && <div className="thinking-text">{text}</div>}
    </div>
  );
}

// ========== 工具调用卡片（独立气泡，pi ToolCallBlock 风格） ==========
function ToolCard({ tool, onToggle }) {
  const { name, input, output, done, isError, expanded, duration } = tool;
  // 命令预览：bash/officecli 等命令行工具显示 $ 前缀
  let inputStr = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  // 解析 pi 工具参数格式 { args: "..." } → 提取命令
  try {
    if (typeof input === "object" && input?.args) {
      inputStr = typeof input.args === "string" ? input.args : JSON.stringify(input.args);
    }
  } catch {}
  const isCmd = name === "bash" || name === "officecli" || name === "find" || name === "grep" || name === "ls" || name === "cat";
  const cmdPreview = isCmd ? inputStr : inputStr.slice(0, 80);
  const outputPreview = output?.length > 300 ? output.slice(0, 300) + "..." : output;

  return (
    <div className={`tool-card ${done ? (isError ? "error" : "success") : "pending"}`} onClick={onToggle}>
      <div className="tool-header">
        <span className={`tool-icon ${done ? (isError ? "err" : "ok") : "run"}`}>
          {done ? (isError ? <Icon name="x" size={12} /> : <Icon name="check" size={12} />) : "●"}
        </span>
        <span className="tool-name">{name}</span>
        <span className="tool-input-preview" title={inputStr}>
          {isCmd ? <code className="cmd-code">$ {cmdPreview}</code> : cmdPreview}
        </span>
        {duration && <span className="tool-duration">{duration}s</span>}
        <span className={`tool-chevron ${expanded ? "open" : ""}`}>{expanded ? "▾" : "▸"}</span>
      </div>
      {expanded && (
        <div className="tool-detail">
          {/* 输入参数 */}
          {inputStr && (
            <div className="tool-section">
              <div className="tool-section-label">输入</div>
              <pre className={`tool-code ${isCmd ? "cmd" : ""}`}>{inputStr}</pre>
            </div>
          )}
          {/* 配对结果（按 toolCallId 配对，pi PairedResult 风格） */}
          {(output || tool.result) && (
            <div className="tool-section">
              <div className="tool-section-label">{done ? "结果" : "输出"}</div>
              <pre className={`tool-code ${isError ? "err" : ""}`}>{expanded ? (output || tool.result) : outputPreview}</pre>
            </div>
          )}
          {done && !output && !tool.result && (
            <div className="tool-section">
              <div className="tool-section-label">结果</div>
              <pre className="tool-code empty">(no output)</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
