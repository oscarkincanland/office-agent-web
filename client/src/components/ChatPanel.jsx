import React, { useEffect, useRef, useState, useCallback, useMemo, forwardRef, useImperativeHandle } from "react";
import { fileToBase64, listModels, setAgentModel, deleteSession, renameSession, forkSession, approveMemoryProposal, rollbackRun } from "../api.js";
import MarkdownBody from "./MarkdownBody.jsx";
import Icon from "./Icon.jsx";
import Logo from "./Logo.jsx";
import ChatTimeline from "./ChatTimeline.jsx";
import { SessionList } from "./SessionSidebar.jsx";
import { loadSettings } from "./SettingsPanel.jsx";

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

function formatMsgTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const p = (n) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return sameYear ? `${p(d.getMonth() + 1)}/${p(d.getDate())} ${hm}` : `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${hm}`;
}

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
  arr.push({ type: "thinking", text, startTime: Date.now() });
  return arr;
}

function referenceId(kind, target) {
  let hash = 0;
  for (const ch of `${kind}:${target}`) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return `ref_${Math.abs(hash).toString(36)}`;
}

function parseReferenceMarkers(text = "") {
  const refs = [];
  const seen = new Set();
  const add = (kind, target, source) => {
    const value = String(target || "").trim();
    if (!value) return;
    const id = referenceId(kind, value);
    if (seen.has(id)) return;
    seen.add(id);
    refs.push({ id, kind, target: value, source });
  };
  for (const m of String(text).matchAll(/@知识库目录\[([^\]]+)\]/g)) add("knowledge_dir", m[1], m[0]);
  for (const m of String(text).matchAll(/@知识库\[([^\]]+)\]/g)) add("knowledge", m[1], m[0]);
  for (const m of String(text).matchAll(/@模板目录\[([^\]]+)\]/g)) add("template_dir", m[1], m[0]);
  for (const m of String(text).matchAll(/@模板\[([^\]]+)\]/g)) add("template", m[1], m[0]);
  for (const m of String(text).matchAll(/@文件\[([^\]]+)\]/g)) add("file", m[1], m[0]);
  for (const m of String(text).matchAll(/(^|[\s(])@([^\s@，。！？\]}]+)/g)) {
    const target = m[2].replace(/[),;。！？]+$/, "");
    if (/^(?:文件|知识库|模板|模板目录)\[/.test(target)) continue;
    if (target.includes("/") || target.includes("\\") || /\.(docx|xlsx|pptx|pdf|csv|json|md|markdown|txt|html|htm)$/i.test(target)) add("file", target, `@${target}`);
  }
  return refs;
}

export default forwardRef(function ChatPanel({ clientId, threadId, onFileChanged, onMapAction, currentDoc, models: modelsProp, defaultModel, onAgentEnd, historyMessages, onNewSession, onOpenFile, sessions = [], onSelectSession, onSessionChange, onRefreshSessions }, ref) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [references, setReferences] = useState([]);
  const [histOpen, setHistOpen] = useState(false); // 会话历史抽屉（默认隐藏，点击展开）
  const [images, setImages] = useState([]);
  const [attachments, setAttachments] = useState([]); // 非图片附件
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [models, setModels] = useState(modelsProp || []);
  const [model, setModel] = useState("");
  const [modelVision, setModelVision] = useState(false);
  const [modelMsg, setModelMsg] = useState("");
  const [editMode, setEditMode] = useState("office"); // "office" | "agent"：office编辑模式 / 普通agent模式
  const [effort, setEffort] = useState("medium"); // 推理强度 low/medium/high
  const [modelOpen, setModelOpen] = useState(false); // 模型选择浮层
  const [effortOpen, setEffortOpen] = useState(false); // 思考程度浮层
  const [modelQ, setModelQ] = useState(""); // 模型搜索
  const [runState, setRunState] = useState({ status: "idle", runId: null, artifacts: [], references: [] });
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
  // SSE 重连可能重放同一事件；按运行/文件/摘要去重，避免对话栏污染。
  const systemEventKeysRef = useRef(new Set());

  useEffect(() => {
    const found = parseReferenceMarkers(input);
    if (!found.length) return;
    setReferences((prev) => {
      const merged = [...found, ...prev.filter((r) => input.includes(r.source || `@${r.target}`))];
      return merged.filter((r, i, arr) => arr.findIndex((x) => x.id === r.id) === i);
    });
  }, [input]);

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
      systemEventKeysRef.current.clear();
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
    setReferences([]);
    setImages([]);
    setAttachments([]);
    systemEventKeysRef.current.clear();
    if (onNewSession) onNewSession();
  }, [onNewSession]);

  // 暴露插入文本方法（供 @ 按钮调用）
  useImperativeHandle(ref, () => ({
    insertText(text) {
      const found = parseReferenceMarkers(text);
      if (found.length) setReferences((prev) => [...prev, ...found.filter((r) => !prev.some((p) => p.id === r.id))]);
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
    try { await setAgentModel(clientId, id, threadId); setModelMsg("ok"); }
    catch (e) { setModelMsg("失败: " + e.message); }
    setTimeout(() => setModelMsg(""), 2500);
  };

  // SSE 连接
  useEffect(() => {
    let es = null;
    let reconnectTimer = null;
    
    const connect = () => {
      if (!mountedRef.current) return;
      
      es = new EventSource(`/api/agent/stream?client=${encodeURIComponent(clientId)}&thread=${encodeURIComponent(threadId || "")}`);
      
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
  }, [clientId, threadId]);

  const acceptSystemEvent = useCallback((key) => {
    const value = String(key || "");
    if (!value) return true;
    if (systemEventKeysRef.current.has(value)) return false;
    systemEventKeysRef.current.add(value);
    // 限制长期运行的浏览器标签页内存增长。
    if (systemEventKeysRef.current.size > 600) {
      const first = systemEventKeysRef.current.values().next().value;
      if (first) systemEventKeysRef.current.delete(first);
    }
    return true;
  }, []);

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
      // 工具结束：标记完成
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
      // agent 主动提问（ask_user 工具）：追加问题卡片，用户回答后 agent 继续
      case "ask_user":
        if (aid) {
          if (streamBufRef.current) flushNow(aid);
          patch(aid, (m) => ({
            ...m,
            blocks: [...(m.blocks || []), {
              type: "ask",
              id: newId(),
              question: data.question || "",
              options: data.options || [],
              answer: "",
            }],
          }));
        }
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
        setRunState((s) => ({ ...s, status: "finishing" }));
        if (onAgentEnd) onAgentEnd();
        break;
      case "agent_error":
        if (aid) patch(aid, (m) => ({ ...m, status: "error", errorText: data.message || "出错了" }));
        assistantIdRef.current = null;
        streamBufRef.current = null;
        streamingMsgIdRef.current = null;
        setBusy(false);
        setRunState((s) => ({ ...s, status: "failed" }));
        break;
      case "steer":
        pushSystem(`⟳ 插入新指令: ${(data.text || "").slice(0, 60)}...`, `steer:${data.text || ""}`);
        break;
      case "aborted":
        if (aid) patch(aid, (m) => ({
          ...m,
          status: "done",
          stopped: true,
        }));
        assistantIdRef.current = null;
        streamBufRef.current = null;
        streamingMsgIdRef.current = null;
        setBusy(false);
        break;
      case "file_changed":
        {
          const files = Array.isArray(data.files) ? data.files.filter(Boolean) : [];
          const runKey = data.runId || runState.runId || "unknown";
          pushSystem(`文件已更新: ${files.join(", ")}`, `file_changed:${runKey}:${files.join("|")}`);
        }
        if (data.files?.length) onFileChanged(data.files);
        break;
      case "map_action":
        if (data && acceptSystemEvent(`map_action:${data.id || "analysis"}:${data.updatedAt || JSON.stringify(data.stats || {})}`)) {
          if (data.action === "clear_analysis") {
            pushSystem("已清除地图临时分析结果");
          } else {
            pushSystem(`地图分析已生成：${data.title || data.analysis || "分析结果"}${data.source === "demo" ? "（演示数据）" : ""}`);
          }
          onMapAction?.(data);
        }
        break;
      case "agent_summary":
        // 对话结束总结条
        {
          const key = `agent_summary:${data.runId || "unknown"}:${(data.products || []).join("|")}:${data.summary || ""}`;
          if (!acceptSystemEvent(key)) break;
        }
        if (data.products?.length) {
          setMessages((ms) => [...ms, {
            id: newId(),
            role: "system",
            text: `${data.summary || "本轮对话完成"}`,
            products: data.products,
            runId: data.runId,
            artifacts: data.artifacts || [],
            status: "done",
            summary: true,
            createdAt: Date.now(),
          }]);
        }
        break;
      case "run_finished":
        setRunState({ status: data.status || "completed", runId: data.runId || null, artifacts: data.artifacts || [], references: data.references || [] });
        if (data.runId) setMessages((ms) => ms.map((m) => m.runId === data.runId ? { ...m, artifacts: data.artifacts || m.artifacts, references: data.references || m.references, runStatus: data.status || "completed" } : m));
        break;
      case "memory_proposal":
        if (data.proposal && acceptSystemEvent(`memory_proposal:${data.proposal.id || JSON.stringify(data.proposal)}`)) {
          setMessages((ms) => [...ms, { id: newId(), role: "system", text: "Agent 提出了一条长期记忆建议，请确认后写入。", memoryProposal: data.proposal, status: "done", createdAt: Date.now() }]);
        }
        break;
      case "memory_proposal_resolved":
        setMessages((ms) => ms.map((m) => m.memoryProposal?.id === data.proposal?.id ? { ...m, memoryProposal: data.proposal, text: "长期记忆建议已写入。" } : m));
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

  const pushSystem = useCallback((text, key = text) => {
    if (!mountedRef.current) return;
    if (!acceptSystemEvent(key)) return;
    setMessages((ms) => [...ms, { id: newId(), role: "system", text, status: "done", createdAt: Date.now() }]);
  }, [acceptSystemEvent]);

  const send = async (overrideText) => {
    const rawText = (overrideText ?? input).trim();
    if (!rawText && images.length === 0 && attachments.length === 0) return; // busy 时也允许发送 = 打断插入新指令
    const text = rawText || (images.length ? "（图片消息）" : "（附件消息）");
    const imgs = images.map((i) => ({ mediaType: i.mediaType, data: i.data }));
    const atts = attachments.map((a) => ({ name: a.name, mediaType: a.mediaType, data: a.data }));
    const sendReferences = [...references, ...parseReferenceMarkers(text)].filter((r, i, arr) => arr.findIndex((x) => x.id === r.id) === i);

    // 注入当前文件上下文
    const contextPrefix = currentDoc ? `[当前打开文件: ${currentDoc}]\n` : "";
    // 按模式注入指令提示
    const modePrefix = editMode === "office"
      ? "[模式: Office编辑] 优先用 officecli 工具对当前文档做精准文本/样式修改，不要创建新文件。\n"
      : "[模式: 创作] 你可以调用所有 skills 和工具生成新文件（文档/HTML/PPT等），产物保存到当前工作区。\n";
    const attachPrefix = attachments.length > 0
      ? `[已上传附件: ${attachments.map((a) => a.name).join(", ")}，文件已保存到工作区，可读取处理]\n`
      : "";
    const fullText = contextPrefix + modePrefix + attachPrefix + (rawText || text);

    if (!mountedRef.current) return;
    
    setMessages((ms) => [...ms, {
      id: newId(), role: "user", text,
      images: images.map((i) => i.dataUrl),
      attachments: attachments.map((a) => a.name),
      references: sendReferences,
      status: "done", currentDoc,
      createdAt: Date.now(),
    }]);
    const aid = newId();
    assistantIdRef.current = aid;
    streamingMsgIdRef.current = aid;
    streamBufRef.current = { text: "", thinking: "" };
    setMessages((ms) => [...ms, {
      id: aid, role: "assistant", blocks: [],
      status: "streaming", images: [],
      createdAt: Date.now(),
    }]);
    setInput("");
    setImages([]);
    setAttachments([]);
    setBusy(true);
    setRunState({ status: "running", runId: null, artifacts: [], references: sendReferences });
    try {
      const res = await fetch("/api/agent/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client: clientId,
          thread: threadId,
          text: fullText,
          images: imgs,
          attachments: atts,
          references: sendReferences,
          effort,
          task: {
            goal: text,
            mode: editMode,
            currentFile: currentDoc || null,
            references: sendReferences,
            workflowId: text.match(/@工作流\[([^\]]+)\]/)?.[1] || null,
          },
        }),
      });
      if (!mountedRef.current) return;
      const d = await res.json().catch(() => ({}));
      // 上报 pi 会话 id（App 持久化，刷新后恢复当前对话）
      if (d.sessionId) onSessionChange?.(d.sessionId);
      if (d.runId) {
        patch(aid, (m) => ({ ...m, runId: d.runId, task: d.task || null, references: d.task?.references || sendReferences }));
        setRunState((s) => ({ ...s, runId: d.runId, references: d.task?.references || sendReferences }));
      }
      if (!res.ok) {
        patch(aid, (m) => ({ ...m, status: "error", text: d.error || "请求失败" }));
        assistantIdRef.current = null;
        if (mountedRef.current) setBusy(false);
        setRunState((s) => ({ ...s, status: "failed" }));
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
        body: JSON.stringify({ client: clientId, thread: threadId }),
      });
    } catch {}
  };

  const handleMemoryApprove = async (id) => {
    try {
      const d = await approveMemoryProposal(id);
      if (d.proposal) setMessages((ms) => ms.map((m) => m.memoryProposal?.id === id ? { ...m, memoryProposal: d.proposal, text: "长期记忆建议已写入。" } : m));
    } catch (e) {
      setMessages((ms) => ms.map((m) => m.memoryProposal?.id === id ? { ...m, text: `记忆写入失败：${e.message}` } : m));
    }
  };

  const handleRollbackRun = async (runId, paths) => {
    if (!runId || !window.confirm("确认回滚本轮产物？这会恢复修改前的文件内容。")) return;
    try {
      await rollbackRun(runId, paths);
      pushSystem("已回滚本轮可恢复的文件变更。");
      onFileChanged?.(paths || []);
    } catch (e) { pushSystem(`回滚失败：${e.message}`); }
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
        {/* 会话历史抽屉（对话栏一侧，可折叠隐藏） */}
        <div className={`chat-hist ${histOpen ? "open" : ""}`}>
          <div className="chat-hist-head" onClick={() => setHistOpen((v) => !v)}>
            <span className="chat-hist-chevron">{histOpen ? "▾" : "▸"}</span>
            <Icon name="history" size={12} />
            <span className="chat-hist-title">历史</span>
            <span className="chat-hist-count">{sessions.length}</span>
            <button
              className="btn-xs chat-hist-refresh"
              onClick={(e) => { e.stopPropagation(); onRefreshSessions(); }}
              title="刷新会话"
            ><Icon name="refresh" size={11} /></button>
          </div>
          {histOpen && (
            <div className="chat-hist-list">
              <SessionList
                sessions={sessions}
                onSelect={(s) => { if (onSelectSession) onSelectSession(s); setHistOpen(false); }}
                onDelete={async (id) => { try { await deleteSession(id); onRefreshSessions(); } catch (e) { alert("删除失败: " + e.message); } }}
                onRename={async (id, label) => { try { await renameSession(id, label); onRefreshSessions(); } catch (e) { alert("重命名失败: " + e.message); } }}
                onFork={async (id) => { try { await forkSession(id); onRefreshSessions(); } catch (e) { alert("创建分支失败: " + e.message); } }}
              />
            </div>
          )}
        </div>
        <div className="chat-head">
          <span className="chat-title"><Logo size={16} /> Open Plan</span>
          <span className={`conn ${connected ? "on" : ""}`}>{connected ? "已连接" : "连接中..."}</span>
          <span className="doc-hint" title={hint}>{hint}</span>
        </div>
        <div className="task-status-bar" role="status" aria-live="polite">
          <span className={`task-status-dot ${runState.status}`} />
          <span>{runState.status === "running" ? "任务执行中" : runState.status === "finishing" ? "整理产物" : runState.status === "failed" ? "任务失败" : runState.status === "completed" ? "任务已完成" : "待命"}</span>
          {runState.runId && <code title={runState.runId}>{runState.runId.slice(0, 18)}</code>}
          {runState.references?.length > 0 && <span className="task-status-meta">引用 {runState.references.length}</span>}
          {runState.artifacts?.length > 0 && <span className="task-status-meta">产物 {runState.artifacts.length}</span>}
        </div>

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
          {messages.map((m, i) => <Message key={m.id} m={m} index={i} prevRole={messages[i - 1]?.role} model={model} clientId={clientId} threadId={threadId} onOpenFile={onOpenFile} onMemoryApprove={handleMemoryApprove} onRollbackRun={handleRollbackRun} onResend={(text) => send(text)} onToggleTool={(toolId) => {
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
        {/* 会话消息目录栏：固定于聊天面板左侧（不随消息滚动），悬停展开；可在设置中关闭 */}
        {loadSettings().showTimeline !== false && <ChatTimeline messages={messages} containerRef={bodyRef} />}

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
        {references.length > 0 && (
          <div className="reference-bar" aria-label="本轮引用">
            <span className="reference-bar-label">引用</span>
            {references.map((ref) => (
              <span className="reference-chip" key={ref.id} title={ref.target}>
                <span className="reference-chip-kind">@</span>{ref.target}
                <button type="button" onClick={() => setReferences((prev) => prev.filter((r) => r.id !== ref.id))} aria-label={`移除引用 ${ref.target}`}>×</button>
              </span>
            ))}
          </div>
        )}
        <div className="chat-input">
          <div className="chat-input-row">
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
                if (items) handleFiles(Array.from(items).filter((it) => it.kind === "file").map((it) => it.getAsFile()).filter(Boolean));
              }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
              onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer?.files || []); }}
              onChange={(e) => setInput(e.target.value)}
            />
            <div className="input-send">
              {busy ? (
                <button className="btn danger stop-btn" onClick={stop} title="停止生成"><Icon name="stop" size={14} /></button>
              ) : (
                <button className="btn primary send-btn" onClick={() => send()} title="发送 (Enter)"><Icon name="send" size={14} /></button>
              )}
            </div>
          </div>
          {/* 单行工具栏（pi-web 风格）：图片/附件 | 模式 | 模型/思考图标 | 新建会话 */}
          <div className="chat-toolbar">
            <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
            <input ref={attInputRef} type="file" accept=".docx,.xlsx,.pptx,.md,.markdown,.txt,.pdf,.html,.htm,.csv,.json" multiple hidden onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
            <button className="ct-btn" title="上传图片" onClick={() => fileInputRef.current?.click()}>
              <Icon name="image" size={14} />
            </button>
            <button className="ct-btn" title="上传附件（docx/xlsx/pdf/md/txt 等）" onClick={() => attInputRef.current?.click()}>
              <Icon name="link" size={14} />
            </button>
            <span className="ct-sep" />
            <div className="mode-switch" title="办公模式（编辑文档） / 开发模式（调用全部 skills 生成新文件）">
              <button
                className={`mode-btn ${editMode === "office" ? "active" : ""}`}
                onClick={() => setEditMode("office")}
                title="办公模式：直接编辑文档"
              ><Icon name="doc" size={13} /></button>
              <button
                className={`mode-btn ${editMode === "agent" ? "active" : ""}`}
                onClick={() => setEditMode("agent")}
                title="开发模式：生成新文件"
              ><Icon name="pen-tool" size={13} /></button>
            </div>
            <span className="ct-sep" />
            {/* 模型选择：图标 + 浮层 */}
            <div className="ct-popwrap">
              <button className={`ct-btn ${modelOpen ? "active" : ""}`} onClick={() => { setModelOpen((v) => !v); setEffortOpen(false); }} title={model ? `模型: ${model}` : "选择模型"}>
                <Icon name="robot" size={14} />
                {model && <span className="ct-model-dot" title={model} />}
              </button>
              {modelOpen && (
                <div className="ct-pop model-pop">
                  <input
                    className="ct-pop-search"
                    placeholder="搜索模型…"
                    value={modelQ}
                    onChange={(e) => setModelQ(e.target.value)}
                    autoFocus
                  />
                  <div className="ct-pop-list">
                    <div className="ct-pop-refresh" onClick={async (e) => { e.stopPropagation(); setModelMsg("扫描中…"); try { const d = await fetch("/api/models/refresh", { method: "POST" }).then((x) => x.json()); if (d.ok) { setModels(d.models.map((id) => ({ id, provider: id.split("/")[0], name: id.split("/")[1] }))); setModelMsg(`已扫描 ${d.count} 个模型`); } else setModelMsg("扫描失败: " + (d.error || "")); } catch (err) { setModelMsg("扫描失败: " + err.message); } setTimeout(() => setModelMsg(" "), 2500); }} title="重新扫描模型（读取 models.json 配置）">
                      <Icon name="refresh" size={11} /> 重新扫描模型
                    </div>
                    {models
                      .filter((m) => !modelQ || m.id.toLowerCase().includes(modelQ.toLowerCase()))
                      .map((m) => (
                        <div
                          key={m.id}
                          className={`ct-pop-item ${model === m.id ? "active" : ""}`}
                          onClick={() => { changeModel(m.id); setModelOpen(false); }}
                          title={m.id}
                        >
                          {m.vision ? "[V] " : ""}{m.id}
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
            {/* 思考程度：图标 + 浮层 */}
            <div className="ct-popwrap">
              <button className={`ct-btn ${effortOpen ? "active" : ""}`} onClick={() => { setEffortOpen((v) => !v); setModelOpen(false); }} title={`推理强度: ${effort === "low" ? "快速" : effort === "high" ? "深度" : "标准"}`}>
                <Icon name="info" size={14} />
              </button>
              {effortOpen && (
                <div className="ct-pop effort-pop">
                  {[
                    { id: "low", label: "快速", desc: "响应快，适合简单任务" },
                    { id: "medium", label: "标准", desc: "平衡速度与质量" },
                    { id: "high", label: "深度", desc: "深入推理，适合复杂任务" },
                  ].map((e) => (
                    <div
                      key={e.id}
                      className={`ct-pop-item ${effort === e.id ? "active" : ""}`}
                      onClick={() => { setEffort(e.id); setEffortOpen(false); }}
                    >
                      <b>{e.label}</b>
                      <span className="ct-pop-desc">{e.desc}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <span style={{ flex: 1 }} />
            <button className="ct-btn" onClick={handleNewSession} title="新建会话">
              <Icon name="plus" size={14} />
            </button>
            {modelMsg && <span className="model-msg">{modelMsg}</span>}
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
});

// ========== 超大消息保护：>100KB 转点击展开，避免 markdown 渲染卡死 ==========
const MAX_MARKDOWN_CHARS = 100000;

function SafeMarkdown({ text }) {
  const [showRaw, setShowRaw] = useState(false);
  if (!text) return null;
  if (text.length <= MAX_MARKDOWN_CHARS) return <MarkdownBody>{text}</MarkdownBody>;
  if (!showRaw) {
    return (
      <button className="large-msg-reveal" onClick={() => setShowRaw(true)}>
        ⚠ 内容过长（{(text.length / 1024).toFixed(0)} KB），点击查看全文
      </button>
    );
  }
  return <pre className="large-msg-raw">{text}</pre>;
}

// ========== 消息组件（Proma 风格：头部 + 无气泡长文 AI / 淡色气泡用户） ==========
function Message({ m, model, onToggleTool, onOpenFile, onMemoryApprove, onRollbackRun, onResend, index, prevRole, clientId, threadId }) {
  if (m.role === "system") {
    return (
      <div className={`msg system ${m.summary ? "summary-msg" : ""}`}>
        <div className="bubble">
          {m.text}
          {m.memoryProposal && (
            <div className="memory-proposal-card" role="note">
              <div><strong>{m.memoryProposal.section}</strong>：{m.memoryProposal.content}</div>
              {m.memoryProposal.status === "pending" ? (
                <button className="btn-xs primary" onClick={() => onMemoryApprove?.(m.memoryProposal.id)}>确认写入记忆</button>
              ) : <span className="memory-proposal-state">{m.memoryProposal.status === "approved" ? "✓ 已写入" : "未写入"}</span>}
            </div>
          )}
          {m.products?.length > 0 && (
            <div className="file-change-summary">
              <span className="file-change-label"><Icon name="folder" size={11} /> 本轮产物</span>
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
            </div>
          )}
          {m.artifacts?.length > 0 && (
            <div className="run-artifacts">
              {m.artifacts.map((a) => <div key={a.path} className="run-artifact-row"><span>{a.status === "added" ? "新增" : a.status === "deleted" ? "删除" : "修改"}</span> <code>{a.path}</code>{a.before?.reversible && <span className="artifact-reversible">可回滚</span>}</div>)}
              {m.runId && m.artifacts.some((a) => a.before?.reversible) && <button className="btn-xs" onClick={() => onRollbackRun?.(m.runId, m.artifacts.map((a) => a.path))}>回滚本轮</button>}
            </div>
          )}
        </div>
      </div>
    );
  }
  const isUser = m.role === "user";
  const blocks = m.blocks || [];
  const streaming = m.status === "streaming";
  // 相邻同角色消息精简头部（连续 AI 回复/连续用户消息不再重复显示作者与时间）
  const hideHeader = prevRole === m.role;
  const hasContent = blocks.length > 0 || m.images?.length > 0;
  const [copied, setCopied] = useState(false);
  const [waitSec, setWaitSec] = useState(0);

  // 从文本块解析任务清单（- [ ] / - [x]）
  const planTasks = useMemo(() => {
    const tasks = [];
    for (const b of blocks) {
      if (!b.text) continue;
      const re = /^\s*[-*]\s*\[( |x|X)\]\s*(.+)$/gm;
      let match;
      while ((match = re.exec(b.text))) {
        tasks.push({ text: match[2].trim(), done: match[1] !== " " });
      }
    }
    return tasks;
  }, [blocks]);

  // 等待首个内容块：显示"正在思考..." + 耗时计时
  useEffect(() => {
    if (!streaming || hasContent) return;
    setWaitSec(0);
    const t = setInterval(() => setWaitSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [streaming, hasContent]);

  const copyText = async () => {
    try {
      const allText = blocks.map((b) => b.type === "text" ? b.text : b.type === "tool" ? (b.name + " " + (b.input || "")) : "").join("\n");
      await navigator.clipboard.writeText(allText || m.text || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const actionsVisible = (hasContent || m.errorText || m.stopped) && !streaming;

  return (
    <div className={`msg ${isUser ? "user" : "assistant"} ${m.status || ""}`} data-msg-index={index}>
      <div className={`avatar ${isUser ? "user-avatar" : "agent-avatar"}`}>
        <Icon name={isUser ? "user" : "robot"} size={14} />
      </div>
      <div className="msg-main">
        {/* 消息头：作者 + 时间（相邻同角色消息省略，减少重复气泡头部） */}
        {!hideHeader && (
        <div className="msg-header">
          <span className="msg-author">{isUser ? "You" : (model || "Agent")}</span>
          <span className="msg-time">{formatMsgTime(m.createdAt || Date.now())}</span>
          {!isUser && streaming && <span className="msg-streaming-badge"><StreamingDot /> 生成中</span>}
          {!isUser && m.status === "error" && <span className="msg-error-badge">生成失败</span>}
          {!isUser && m.stopped && <span className="msg-stopped-badge">已停止生成</span>}
        </div>
        )}
        {isUser ? (
          <div className="bubble user-bubble">
            {m.images?.length > 0 && (
              <div className="msg-images">{m.images.map((src, i) => <img key={i} src={src} alt="" />)}</div>
            )}
            {m.currentDoc && <div className="msg-context">当前文件: {m.currentDoc}</div>}
            {m.references?.length > 0 && <ReferenceChips references={m.references} onOpenFile={onOpenFile} />}
            {m.text && <div className="msg-text">{m.text}</div>}
          </div>
        ) : (
          <>
            {m.images?.length > 0 && (
              <div className="msg-images assistant-images">{m.images.map((src, i) => <img key={i} src={src} alt="Agent 附图" />)}</div>
            )}
            {/* 任务进度卡（Proma TaskProgressCard：聚合 - [x] 任务 + 进度条） */}
            {planTasks.length > 0 && <TaskProgressCard tasks={planTasks} />}
            {/* 独立条目流（pi-web BlockView 模型）：思考/工具调用/文本按原始顺序各自成条目，不包裹分组框 */}
            <div className="msg-blocks">
              {blocks.map((b, i) => {
                if (b.type === "thinking") return <ThinkingBlock key={i} text={b.text} startTime={b.startTime} streaming={streaming} />;
                if (b.type === "tool") return <ToolCard key={b.id || i} tool={b} onToggle={() => onToggleTool(b.id || i)} />;
                if (b.type === "ask") return <AskBlock key={b.id || i} block={b} clientId={clientId} threadId={threadId} />;
                if (b.type === "text") return (
                  <div className="flow-markdown" key={i}>
                    <SafeMarkdown text={b.text} />
                  </div>
                );
                return null;
              })}
            </div>
            {m.references?.length > 0 && <ReferenceChips references={m.references} onOpenFile={onOpenFile} />}
            {/* 流式等待首块：思考中 + 耗时 */}
            {streaming && !hasContent && (
              <div className="bubble loading-bubble">
                <LoadingDots label="正在思考" seconds={waitSec} />
              </div>
            )}
            {/* 流式收尾：呼吸脉冲圆点 */}
            {streaming && hasContent && <StreamingDot />}
            {/* 已停止 / 错误标记 */}
            {m.status === "error" && <div className="err-badge">{m.errorText || "出错了"}</div>}
          </>
        )}
        {/* 操作条：常显微透明，hover 加深（Proma MessageActions 风格） */}
        {actionsVisible && (
          <div className="msg-actions">
            <button className="msg-action" onClick={copyText} title="复制">
              {copied ? <Icon name="check" size={12} /> : <Icon name="copy" size={12} />}
              <span>{copied ? "已复制" : "复制"}</span>
            </button>
            {isUser && (
              <button className="msg-action" onClick={() => onResend && onResend(m.text)} title="重新发送">
                <Icon name="refresh" size={12} />
                <span>重发</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ReferenceChips({ references = [], onOpenFile }) {
  if (!references.length) return null;
  return (
    <div className="msg-references" aria-label="本轮引用">
      {references.map((r) => {
        const label = r.metadata?.name || r.metadata?.relativePath || r.target;
        const canOpen = r.kind === "file" && !!onOpenFile && r.status !== "missing";
        const content = <><Icon name="file" size={10} /> @{label}</>;
        return canOpen ? (
          <button type="button" className={`msg-reference-chip ${r.status || ""}`} key={r.id} onClick={() => onOpenFile(r.metadata?.relativePath || r.target)} title={`打开引用：${label}`}>{content}</button>
        ) : (
          <span className={`msg-reference-chip ${r.status || ""}`} key={r.id} title={r.message || label}>{content}</span>
        );
      })}
    </div>
  );
}

// ========== 流式指示器：呼吸脉冲圆点（Proma StreamingIndicator） ==========
function StreamingDot() {
  return <span className="streaming-dot" title="生成中" />;
}

// ========== 等待指示器：弹跳点 + 耗时（Proma MessageLoading） ==========
function LoadingDots({ label, seconds }) {
  return (
    <span className="loading-dots">
      <span className="ldot" /><span className="ldot" /><span className="ldot" />
      <span className="loading-label">{label}…</span>
      {seconds > 0 && <span className="loading-elapsed">{seconds}s</span>}
    </span>
  );
}

// ========== 思考过程块（Proma Reasoning 风格：默认折叠成一行，点击展开） ==========
function ThinkingBlock({ text, startTime, streaming }) {
  const [expanded, setExpanded] = useState(() => loadSettings().thinkingDefaultOpen);
  const [duration, setDuration] = useState(null);

  // 流式结束时：计算耗时
  useEffect(() => {
    if (streaming) return;
    if (startTime) setDuration(((Date.now() - startTime) / 1000).toFixed(1));
  }, [streaming, startTime]);

  return (
    <div className={`thinking-block ${expanded ? "expanded" : ""}`} onClick={() => setExpanded((v) => !v)}>
      <div className="thinking-header">
        <span className="thinking-icon">{expanded ? "▾" : "▸"}</span>
        <span className="thinking-label"><Icon name="info" size={11} /> 思考</span>
        {streaming && <span className="thinking-status">思考中…</span>}
        {!streaming && duration && <span className="thinking-status">思考了 {duration}s</span>}
        {!streaming && !duration && <span className="thinking-status">{text.length} 字</span>}
      </div>
      {expanded && <div className="thinking-text">{text}</div>}
    </div>
  );
}

// ========== 主动提问卡片（ask_user：agent 遇不明确处询问用户） ==========
function AskBlock({ block, clientId, threadId }) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const submit = async (text) => {
    const answer = (text || "").trim();
    if (!answer || sending) return;
    setSending(true);
    try {
      await fetch("/api/agent/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: clientId, thread: threadId, answer }),
      });
      block.answer = answer;
      setInput("");
    } catch {}
    setSending(false);
  };

  return (
    <div className={`ask-block ${block.answer ? "answered" : ""}`}>
      <div className="ask-head">
        <Icon name="comment" size={12} />
        <span className="ask-title">需要你确认</span>
        {block.answer && <span className="ask-status">✓ 已回答</span>}
      </div>
      <div className="ask-question">{block.question}</div>
      {block.answer ? (
        <div className="ask-answer">你的回答：{block.answer}</div>
      ) : (
        <>
          {block.options?.length > 0 && (
            <div className="ask-options">
              {block.options.map((opt, i) => (
                <button key={i} className="ask-opt" onClick={() => submit(opt)}>{opt}</button>
              ))}
            </div>
          )}
          <div className="ask-input-row">
            <input
              className="ask-input"
              placeholder="输入你的回答…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(input); }}
            />
            <button className="btn primary ask-submit" onClick={() => submit(input)} disabled={sending}>
              {sending ? "…" : "发送"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ========== 任务进度卡（Proma TaskProgressCard：进度条 + 状态图标行） ==========
function TaskProgressCard({ tasks }) {
  const [open, setOpen] = useState(true);
  const done = tasks.filter((t) => t.done).length;

  return (
    <div className={`task-card ${open ? "open" : ""}`}>
      <div className="task-head" onClick={() => setOpen((v) => !v)}>
        <span className="task-chevron">{open ? "▾" : "▸"}</span>
        <Icon name="grid" size={11} />
        <span className="task-title">任务进度</span>
        <span className="task-progress">{done}/{tasks.length} 完成</span>
      </div>
      {open && (
        <div className="task-body">
          <div className="task-bar">
            <div className="task-bar-fill" style={{ width: `${(done / tasks.length) * 100}%` }} />
          </div>
          {tasks.map((t, i) => (
            <div key={i} className={`task-item ${t.done ? "done" : ""}`}>
              <span className="task-status">{t.done ? <Icon name="check" size={11} /> : <span className="task-pending-dot" />}</span>
              <span className="task-text">{t.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ========== 工具语义短语（Proma tool-phrase：完成态/流式态短语） ==========
function toolPhrase(name, input, done) {
  let arg = "";
  try {
    const obj = typeof input === "object" ? input : JSON.parse(input || "{}");
    arg = obj.args || obj.file_path || obj.filePath || obj.path || obj.pattern || obj.query || obj.cwd || "";
  } catch {}
  arg = String(arg || "").trim();
  const tail = arg ? ` ${arg.slice(0, 60)}` : "";
  const loading = done ? "" : "正在";
  switch (name) {
    case "read": return `${loading}读取文件${tail}`;
    case "write": return `${loading}写入文件${tail}`;
    case "edit": return `${loading}编辑文件${tail}`;
    case "bash": return `执行命令${tail}`;
    case "officecli": return `操作 Office 文档${tail}`;
    case "grep": return `${loading}搜索内容${tail}`;
    case "find": case "ls": return `${loading}查看文件列表${tail}`;
    case "glob": return `${loading}查找文件${tail}`;
    case "webSearch": return `${loading}联网搜索${tail}`;
    case "webFetch": return `${loading}抓取网页${tail}`;
    case "TaskCreate": return `创建任务${tail}`;
    case "TaskUpdate": return `更新任务${tail}`;
    default: return `${loading}调用 ${name}${tail}`;
  }
}

// ========== 工具调用行（Proma ToolUseBlock：状态图标 + 语义短语 + 展开详情） ==========
function ToolCard({ tool, onToggle }) {
  const { name, input, output, done, isError, expanded, duration } = tool;
  // 命令预览：bash/officecli 等命令行工具显示 $ 前缀
  // 注意：JSON.stringify(undefined) 返回 undefined，历史会话中 tool.input 可能缺失
  let inputStr = typeof input === "string" ? input : (input != null ? JSON.stringify(input, null, 2) : "");
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
          {done ? (isError ? <Icon name="x" size={12} /> : <Icon name="check" size={12} />) : <Icon name="loading" size={12} className="icon-loading" />}
        </span>
        <span className="tool-phrase" title={inputStr}>{toolPhrase(name, input, done)}</span>
        {isCmd && <code className="cmd-code">$ {cmdPreview}</code>}
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
