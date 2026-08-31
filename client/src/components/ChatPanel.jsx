import React, { useEffect, useRef, useState, useCallback, useMemo, forwardRef, useImperativeHandle } from "react";
import { fileToBase64, listModels, setAgentModel, compactAgentContext, deleteSession, renameSession, forkSession, approveMemoryProposal, rejectMemoryProposal, rollbackRun } from "../api.js";
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
const MODE_KEY = "oaw_chat_mode";

const MODE_META = {
  chat: {
    label: "Chat",
    shortLabel: "Chat",
    icon: "search",
    title: "Chat：只读检索知识库、Skills 和工作区资料，不修改文件",
    hint: "只读检索",
    prefix: "[模式: Chat] 只进行知识库、Skills 和工作区资料检索；不要修改文件、执行脚本或生成产物。若用户要求修改，请提醒切换到 Office 或 Agent。\n",
  },
  office: {
    label: "Office",
    shortLabel: "Office",
    icon: "doc",
    title: "Office：通过 Office CLI 精准编辑当前 Office 文档",
    hint: "精准编辑",
    prefix: "[模式: Office] 优先使用 officecli 对当前 Office 文档做精准文本/样式修改；不要创建新文件，不要调用通用脚本写入。\n",
  },
  agent: {
    label: "Agent / 创作",
    shortLabel: "Agent",
    icon: "penTool",
    title: "Agent / 创作：调用完整工具链执行分析、修改并生成工作产物",
    hint: "执行与产出",
    prefix: "[模式: Agent / 创作] 可以调用完整 skills 和工具执行分析、修改并生成新文件（文档/HTML/PPT 等），产物保存到当前工作区。\n",
  },
};

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

export default forwardRef(function ChatPanel({ clientId, threadId, workspace = "", project = null, onFileChanged, onMapAction, currentDoc, mapContext, models: modelsProp, defaultModel, onAgentEnd, historyMessages, onNewSession, onOpenFile, sessions = [], unreadByThread = {}, onSelectSession, onSessionChange, onRefreshSessions }, ref) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [references, setReferences] = useState([]);
  const [histOpen, setHistOpen] = useState(false); // 会话历史抽屉（默认隐藏，点击展开）
  const [images, setImages] = useState([]);
  const [attachments, setAttachments] = useState([]); // 非图片附件
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [connected, setConnected] = useState(false);
  const [models, setModels] = useState(modelsProp || []);
  const [model, setModel] = useState("");
  const [modelVision, setModelVision] = useState(false);
  const [modelMsg, setModelMsg] = useState("");
  const [modelCounts, setModelCounts] = useState({ available: 0, configured: 0 });
  const [compacting, setCompacting] = useState(false);
  const [editMode, setEditMode] = useState(() => {
    const saved = localStorage.getItem(MODE_KEY);
    return MODE_META[saved] ? saved : "chat";
  }); // chat只读检索 / office精准编辑 / agent完整执行与创作
  const [effort, setEffort] = useState("medium"); // 推理强度 low/medium/high
  const [modelOpen, setModelOpen] = useState(false); // 模型选择浮层
  const [effortOpen, setEffortOpen] = useState(false); // 思考程度浮层
  const [modelQ, setModelQ] = useState(""); // 模型搜索
  const [runState, setRunState] = useState({ status: "idle", runId: null, artifacts: [], references: [], task: null, mode: "chat" });
  const [queuedMessages, setQueuedMessages] = useState([]); // 当前任务完成后顺序执行
  const [injectedContext, setInjectedContext] = useState([]); // 等待下一轮发送的上下文片段
  const [busyInputMode, setBusyInputMode] = useState("queue"); // "queue" | "context"
  const bottomRef = useRef(null);
  const assistantIdRef = useRef(null);
  const fileInputRef = useRef(null);
  const attInputRef = useRef(null);
  // streaming 累积缓冲（性能优化：避免每 token setState）
  const streamBufRef = useRef(null);
  const rafRef = useRef(null);
  const streamingMsgIdRef = useRef(null);
  const stoppingRef = useRef(false);
  const queueRef = useRef([]);
  // 组件挂载状态追踪，防止卸载后更新状态
  const mountedRef = useRef(true);
  // SSE 重连可能重放同一事件；按运行/文件/摘要去重，避免对话栏污染。
  const systemEventKeysRef = useRef(new Set());
  const syncedModelRef = useRef("");
  // ChatPanel 本身持续挂载时，按 thread 保存界面状态，切换子对话不会把原对话的流式内容丢掉。
  const threadCacheRef = useRef(new Map());
  const previousThreadRef = useRef(threadId);

  const currentMode = MODE_META[editMode] || MODE_META.chat;

  useEffect(() => {
    if (MODE_META[editMode]) localStorage.setItem(MODE_KEY, editMode);
  }, [editMode]);

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
      const latestRun = [...historyMessages].reverse().find((item) => item?.runId && item?.runStatus);
      const active = new Set(["running", "queued", "waiting_user", "recovering", "cancel_requested"]);
      setBusy(Boolean(latestRun && active.has(latestRun.runStatus)));
      setRunState({
        status: latestRun?.runStatus || "idle",
        runId: latestRun?.runId || null,
        artifacts: latestRun?.artifacts || [],
        references: latestRun?.references || [],
        task: latestRun?.task || null,
        mode: latestRun?.task?.mode || "chat",
      });
      if (latestRun?.task?.mode && MODE_META[latestRun.task.mode]) setEditMode(latestRun.task.mode);
      stoppingRef.current = false;
      setStopping(false);
      assistantIdRef.current = null;
      streamBufRef.current = null;
      streamingMsgIdRef.current = null;
      systemEventKeysRef.current.clear();
      queueRef.current = [];
      setQueuedMessages([]);
      setInjectedContext([]);
    }
  }, [historyMessages]);

  // 切换子对话时只切换本地视图，不销毁其它会话的消息/运行状态。
  // 后端 SSE 会随 thread 重连；旧 thread 的任务继续由任务中心跟踪。
  useEffect(() => {
    const previous = previousThreadRef.current;
    if (previous === threadId) return;
    threadCacheRef.current.set(previous, {
      messages,
      runState,
      busy,
      editMode,
    });
    const cached = threadCacheRef.current.get(threadId);
    setMessages(cached?.messages || []);
    setRunState(cached?.runState || { status: "idle", runId: null, artifacts: [], references: [], task: null, mode: editMode });
    if (cached?.editMode && MODE_META[cached.editMode]) setEditMode(cached.editMode);
    setBusy(Boolean(cached?.busy));
    setStopping(false);
    stoppingRef.current = false;
    assistantIdRef.current = null;
    streamBufRef.current = null;
    streamingMsgIdRef.current = null;
    queueRef.current = [];
    setQueuedMessages([]);
    setInjectedContext([]);
    setReferences([]);
    setImages([]);
    setAttachments([]);
    setInput("");
    systemEventKeysRef.current.clear();
    previousThreadRef.current = threadId;
  }, [threadId]);

  // 新建会话：清空消息
  const handleNewSession = useCallback(() => {
    setMessages([]);
    setBusy(false);
    stoppingRef.current = false;
    setStopping(false);
    assistantIdRef.current = null;
    streamBufRef.current = null;
    streamingMsgIdRef.current = null;
    setInput("");
    setReferences([]);
    setImages([]);
    setAttachments([]);
    queueRef.current = [];
    setQueuedMessages([]);
    setInjectedContext([]);
    setRunState({ status: "idle", runId: null, artifacts: [], references: [], task: null, mode: editMode });
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
    insertContext(text) {
      const value = String(text || "").trim();
      if (!value) return;
      setInput((v) => {
        const prefix = v && !v.endsWith("\n") ? "\n\n" : "";
        return `${v}${prefix}[选区上下文]\n${value}\n[/选区上下文]`;
      });
      setModelMsg("已加入选区上下文，请补充指令后发送");
      window.setTimeout(() => setModelMsg(""), 2600);
    },
    focusRun() {
      const el = bodyRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
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

  // 初始化模型：等待真实列表后再选择，避免 App 首次传入空数组时选中失效模型。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let d = { models: modelsProp || [], default: defaultModel || "" };
      if (!modelsProp?.length) {
        try { d = await listModels(); } catch {}
      }
      if (cancelled) return;
      const nextModels = d.models || [];
      setModels(nextModels);
      if (d.counts) setModelCounts(d.counts);
      const saved = localStorage.getItem(MODEL_KEY);
      const preferred = saved || d.default || "";
      const cur = nextModels.some((m) => m.id === preferred) ? preferred : (nextModels[0]?.id || "");
      setModel(cur);
      applyModel(cur, nextModels);
      const syncKey = `${clientId}:${threadId || ""}:${cur}`;
      if (cur && syncKey !== syncedModelRef.current) {
        syncedModelRef.current = syncKey;
        try { await setAgentModel(clientId, cur, threadId); }
        catch (e) { if (mountedRef.current) setModelMsg(`模型同步失败：${e.message}`); }
      }
    })();
    return () => { cancelled = true; };
  }, [modelsProp, defaultModel, clientId, threadId]);

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
      
      const workspaceQuery = workspace ? `&cwd=${encodeURIComponent(workspace)}` : "";
      es = new EventSource(`/api/agent/stream?client=${encodeURIComponent(clientId)}&thread=${encodeURIComponent(threadId || "")}${workspaceQuery}`);
      
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
  }, [clientId, threadId, workspace]);

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
              id: data.toolCallId || newId(),
              toolCallId: data.toolCallId || null,
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
          const tool = data.toolCallId
            ? blocks.find((block) => block.type === "tool" && block.id === data.toolCallId)
            : [...blocks].reverse().find((block) => block.type === "tool" && !block.done && (!data.name || block.name === data.name));
          if (tool) tool.output = data.replace ? (data.output || "") : (tool.output || "") + (data.output || "");
          return { ...m, blocks };
        });
        break;
      // 工具结束：标记完成
      case "tool_end":
        if (aid) patch(aid, (m) => {
          const blocks = [...(m.blocks || [])];
          const tool = data.toolCallId
            ? blocks.find((block) => block.type === "tool" && block.id === data.toolCallId)
            : [...blocks].reverse().find((block) => block.type === "tool" && (!data.name || block.name === data.name));
          if (tool) {
            tool.done = true;
            tool.isError = !!data.isError;
            if (data.result) tool.result = data.result;
            if (tool.startTime) tool.duration = ((Date.now() - tool.startTime) / 1000).toFixed(1);
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
      case "agent_retry":
        pushSystem(`模型连接异常，正在重试${data.attempt && data.maxAttempts ? `（${data.attempt}/${data.maxAttempts}）` : ""}：${data.message || "请稍候"}`, `agent_retry:${data.source || "agent"}:${data.attempt || "retry"}:${data.message || "retry"}`);
        break;
      case "agent_retry_end":
        if (data.success) pushSystem("模型连接已恢复，继续执行当前任务。", `agent_retry_end:${data.attempt || "ok"}`);
        break;
      case "capability_plan":
        {
          const plan = data.plan || {};
          const labels = (plan.capabilities || []).map((item) => item.label).filter(Boolean);
          if (labels.length) pushSystem(`本轮能力已就绪：${labels.join("、")}`, `capability_plan:${data.runId || "current"}`);
          setRunState((s) => ({ ...s, capabilityPlan: plan }));
        }
        break;
      case "mode_policy":
        {
          const mode = MODE_META[data.mode] ? data.mode : "agent";
          const policyText = data.description || MODE_META[mode].hint;
          if (acceptSystemEvent(`mode_policy:${data.runId || "current"}:${mode}`)) {
            pushSystem(`当前模式：${MODE_META[mode].label} · ${policyText}`, `mode_policy:${data.runId || "current"}:${mode}`);
          }
          setEditMode(mode);
          setRunState((s) => ({ ...s, mode, modePolicy: data }));
        }
        break;
      case "assistant_final":
        if (aid && data.text) patch(aid, (m) => {
          const blocks = [...(m.blocks || [])];
          const hasText = blocks.some((block) => block.type === "text" && String(block.text || "").trim());
          return hasText ? m : { ...m, blocks: appendTextBlock(blocks, data.text) };
        });
        break;
      case "context_compacted":
        pushSystem(`上下文已压缩${data.tokensBefore ? `（压缩前约 ${Number(data.tokensBefore).toLocaleString()} tokens）` : ""}。`);
        break;
      case "agent_end":
        if (streamBufRef.current) flushNow(aid);
        if (aid) patch(aid, (m) => ({ ...m, status: "done" }));
        assistantIdRef.current = null;
        streamBufRef.current = null;
        streamingMsgIdRef.current = null;
        setBusy(false);
        stoppingRef.current = false;
        setStopping(false);
        setRunState((s) => ({ ...s, status: "finishing" }));
        if (onAgentEnd) onAgentEnd();
        flushQueued(true);
        break;
      case "agent_error":
        if (aid) patch(aid, (m) => ({ ...m, status: "error", errorText: data.message || "出错了" }));
        assistantIdRef.current = null;
        streamBufRef.current = null;
        streamingMsgIdRef.current = null;
        setBusy(false);
        stoppingRef.current = false;
        setStopping(false);
        setRunState((s) => ({ ...s, status: "failed" }));
        break;
      case "steer":
        pushSystem(`⟳ 插入新指令: ${(data.text || "").slice(0, 60)}...`, `steer:${data.text || ""}`);
        break;
      case "aborted":
        finalizeStopped();
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
        setRunState((s) => ({ ...s, status: data.status || "completed", runId: data.runId || s.runId || null, artifacts: data.artifacts || [], references: data.references || [], verificationStatus: data.verificationStatus || "not_checked" }));
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

  const finalizeStopped = useCallback(() => {
    const id = assistantIdRef.current;
    if (id) patch(id, (m) => ({ ...m, status: "done", stopped: true }));
    assistantIdRef.current = null;
    streamBufRef.current = null;
    streamingMsgIdRef.current = null;
    stoppingRef.current = false;
    setStopping(false);
    setBusy(false);
    setRunState((s) => ({ ...s, status: "aborted" }));
  }, [patch]);

  const send = async (overrideText, options = {}) => {
    if (stoppingRef.current) return;
    const source = options.payload || {};
    const sourceImages = source.images || images;
    const sourceAttachments = source.attachments || attachments;
    const sourceReferences = source.references || references;
    const rawText = String(source.rawText ?? overrideText ?? input).trim();
    if (!rawText && sourceImages.length === 0 && sourceAttachments.length === 0) return;
    const text = rawText || (sourceImages.length ? "（图片消息）" : "（附件消息）");
    const contextNotes = source.contextNotes || injectedContext;
    const contextImages = contextNotes.flatMap((note) => note.images || []);
    const contextAttachments = contextNotes.flatMap((note) => note.attachments || []);
    const allImages = [...contextImages, ...sourceImages];
    const allAttachments = [...contextAttachments, ...sourceAttachments];
    const imgs = allImages.map((i) => ({ mediaType: i.mediaType, data: i.data }));
    const atts = allAttachments.map((a) => ({ name: a.name, mediaType: a.mediaType, data: a.data }));
    const sendReferences = [...sourceReferences, ...parseReferenceMarkers(text)].filter((r, i, arr) => arr.findIndex((x) => x.id === r.id) === i);

    // 当前任务执行中：默认排队，另一种选择是只保存为下一轮上下文，不再隐式 steer 打断当前回复。
    if (busy && !options.force) {
      if (busyInputMode === "context") {
        setInjectedContext((prev) => [...prev, { text, images: sourceImages, attachments: sourceAttachments }]);
        setInput("");
        setImages([]);
        setAttachments([]);
        pushSystem("已加入待注入上下文，不会打断当前任务。", `context:${Date.now()}:${text.slice(0, 40)}`);
        return;
      }
      const messageId = newId();
      const item = {
        messageId,
        rawText,
        images: sourceImages,
        attachments: sourceAttachments,
        references: sourceReferences,
        contextNotes,
        currentDoc,
        editMode,
        effort,
      };
      const nextQueue = [...queueRef.current, item];
      queueRef.current = nextQueue;
      setQueuedMessages(nextQueue);
      setMessages((ms) => [...ms, {
        id: messageId, role: "user", text,
        images: sourceImages.map((i) => i.dataUrl).filter(Boolean),
        attachments: sourceAttachments.map((a) => a.name),
        references: sendReferences,
        status: "queued", queued: true, currentDoc,
        createdAt: Date.now(),
      }]);
      setInput("");
      setImages([]);
      setAttachments([]);
      setInjectedContext([]);
      pushSystem(`已排队第 ${nextQueue.length} 条，当前任务完成后自动执行。`, `queue:${messageId}`);
      return;
    }

    // 注入当前文件上下文
    const selectedCurrentDoc = source.currentDoc ?? currentDoc;
    const selectedEditMode = source.editMode ?? editMode;
    const selectedEffort = source.effort ?? effort;
    const contextPrefix = selectedCurrentDoc ? `[当前打开文件: ${selectedCurrentDoc}]\n` : "";
    const mapContextPrefix = mapContext?.center
      ? `[当前地图视图: 中心 ${mapContext.center[0]},${mapContext.center[1]}；缩放 ${mapContext.zoom}；可视范围 ${mapContext.bounds?.join(",") || "未知"}]\n`
      : "";
    // 按模式注入指令提示
    const modePrefix = (MODE_META[selectedEditMode] || MODE_META.chat).prefix;
    const contextPrefixText = contextNotes.length
      ? `## 已注入上下文\n${contextNotes.map((note) => note.text).join("\n\n")}\n\n`
      : "";
    const attachPrefix = allAttachments.length > 0
      ? `[已上传附件: ${allAttachments.map((a) => a.name).join(", ")}，文件已保存到工作区，可读取处理]\n`
      : "";
    const fullText = contextPrefix + mapContextPrefix + modePrefix + contextPrefixText + attachPrefix + (rawText || text);

    if (!mountedRef.current) return;

    const queuedMessageId = source.messageId;
    if (queuedMessageId) {
      patch(queuedMessageId, (m) => ({ ...m, status: "done", queued: false, references: sendReferences }));
    } else {
      setMessages((ms) => [...ms, {
        id: newId(), role: "user", text,
        images: sourceImages.map((i) => i.dataUrl).filter(Boolean),
        attachments: sourceAttachments.map((a) => a.name),
        references: sendReferences,
        status: "done", currentDoc: selectedCurrentDoc,
        createdAt: Date.now(),
      }]);
    }
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
    setInjectedContext([]);
    setBusy(true);
    setRunState({ status: "running", runId: null, artifacts: [], references: sendReferences, mode: selectedEditMode });
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
          model,
           effort: selectedEffort,
           task: {
             goal: text,
           mode: selectedEditMode,
             projectId: project?.id || null,
             currentFile: selectedCurrentDoc || null,
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
        setRunState((s) => ({ ...s, runId: d.runId, references: d.task?.references || sendReferences, task: d.task || s.task }));
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
    if (!busy || stoppingRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    try {
      const res = await fetch("/api/agent/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: clientId, thread: threadId }),
      });
      if (!res.ok) throw new Error(`请求失败（${res.status}）`);
      // SSE 正常会收到 aborted；断线时也要让输入框恢复可用。
      window.setTimeout(() => {
        if (stoppingRef.current) finalizeStopped();
      }, 1200);
    } catch (e) {
      stoppingRef.current = false;
      setStopping(false);
      pushSystem(`中断失败：${e.message || "网络错误"}`);
    }
  };

  // 当前回合结束后只启动一条队列消息，避免多个请求同时争抢同一个 Pi 会话。
  const flushQueued = (force = false) => {
    if (stoppingRef.current || (!force && busy) || !queueRef.current.length) return;
    const [next, ...rest] = queueRef.current;
    queueRef.current = rest;
    setQueuedMessages(rest);
    // agent_end 事件先于服务端 prompt finally 到达，留出收尾时间再发下一条，避免被误判为 steer。
    window.setTimeout(() => send(undefined, { force: true, payload: next }), 450);
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
    const count = addedImgs.length + addedAtts.length;
    if (count) {
      setModelMsg(`已加入上下文 ${count} 个文件`);
      setTimeout(() => setModelMsg(""), 2200);
    }
  };

  const handleClipboardPaste = (e) => {
    const files = Array.from(e.clipboardData?.items || [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    handleFiles(files);
  };

  const compactContext = async () => {
    if (busy || compacting) return;
    setCompacting(true);
    setModelMsg("正在压缩上下文…");
    try {
      const result = await compactAgentContext(clientId, threadId);
      const before = result.tokensBefore ? `，压缩前约 ${result.tokensBefore.toLocaleString()} tokens` : "";
      pushSystem(`上下文压缩完成${before}。后续对话将继续保留任务摘要。`);
      setModelMsg("压缩完成");
    } catch (e) {
      setModelMsg(`压缩失败：${e.message}`);
    } finally {
      setCompacting(false);
      setTimeout(() => setModelMsg(""), 2800);
    }
  };

  const handleMemoryReject = async (id) => {
    const reason = window.prompt("拒绝原因（可选）", "用户拒绝该记忆建议");
    if (reason === null) return;
    try {
      const d = await rejectMemoryProposal(id, reason);
      if (d.proposal) setMessages((ms) => ms.map((m) => m.memoryProposal?.id === id ? { ...m, memoryProposal: d.proposal, text: "长期记忆建议已拒绝。" } : m));
    } catch (e) {
      setMessages((ms) => ms.map((m) => m.memoryProposal?.id === id ? { ...m, text: `记忆拒绝失败：${e.message}` } : m));
    }
  };

  const injectMapContext = () => {
    if (!mapContext?.center) return;
    const text = `当前地图视图：中心 ${mapContext.center[0]},${mapContext.center[1]}，缩放 ${mapContext.zoom}，可视范围 ${mapContext.bounds?.join(",") || "未知"}。`;
    setInjectedContext((prev) => [...prev, { text }]);
    pushSystem("已将当前地图视图加入待注入上下文。", `map_context:${mapContext.updatedAt || text}`);
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
  const hasDraft = Boolean(input.trim() || images.length || attachments.length);

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
                unreadByThread={unreadByThread}
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
          <span className={`chat-mode-badge mode-${editMode}`} title={currentMode.title}>
            <Icon name={currentMode.icon} size={11} /> {currentMode.label}
          </span>
          {project?.type && <span className="chat-project-badge" title={`项目分类：${project.type}`}>
            {project.type}
          </span>}
          <span className={`conn ${connected ? "on" : ""}`}>{connected ? "已连接" : "连接中..."}</span>
          <span className="doc-hint" title={hint}>{hint}</span>
        </div>
        <div className="task-status-bar" role="status" aria-live="polite">
          <span className={`task-status-dot ${runState.status}`} />
          <span>{runState.status === "running" ? "任务执行中" : runState.status === "finishing" ? "整理产物" : runState.status === "recovering" ? "等待恢复" : runState.status === "cancel_requested" ? "正在取消" : runState.status === "cancelled" ? "任务已取消" : runState.status === "aborted" ? "任务已中断" : runState.status === "failed" ? "任务失败" : runState.status === "completed" ? "任务已完成" : "待命"}</span>
          <span className="task-status-meta task-mode-meta">{MODE_META[runState.mode || editMode]?.label || currentMode.label}</span>
          {runState.runId && <code title={runState.runId}>{runState.runId.slice(0, 18)}</code>}
          {runState.references?.length > 0 && <span className="task-status-meta">引用 {runState.references.length}</span>}
          {runState.artifacts?.length > 0 && <span className="task-status-meta">产物 {runState.artifacts.length}</span>}
          {runState.verificationStatus && runState.verificationStatus !== "not_checked" && <span className={`task-status-meta verification-${runState.verificationStatus}`}>产物校验 {runState.verificationStatus === "passed" ? "通过" : runState.verificationStatus === "warning" ? "有提示" : "失败"}</span>}
        </div>

        <div className="chat-stream-shell">
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
          {messages.map((m, i) => <Message key={m.id} m={m} index={i} prevRole={messages[i - 1]?.role} model={model} clientId={clientId} threadId={threadId} onOpenFile={onOpenFile} onMemoryApprove={handleMemoryApprove} onMemoryReject={handleMemoryReject} onRollbackRun={handleRollbackRun} onResend={(text) => send(text)} onToggleTool={(toolId) => {
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
          {/* 会话消息目录栏：收纳在聊天滚动区右侧，靠近滚动条；悬停显示摘要 */}
          {loadSettings().showTimeline !== false && <ChatTimeline messages={messages} containerRef={bodyRef} />}
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
        {(queuedMessages.length > 0 || injectedContext.length > 0) && (
          <div className="chat-pending-bar" aria-live="polite">
            {queuedMessages.length > 0 && <span><Icon name="list" size={12} /> 待执行 {queuedMessages.length} 条</span>}
            {injectedContext.length > 0 && <span><Icon name="layers" size={12} /> 待注入上下文 {injectedContext.length} 条</span>}
            {queuedMessages.length > 0 && !busy && <button type="button" onClick={() => flushQueued()} title="继续执行队列">继续队列</button>}
            {queuedMessages.length > 0 && <button type="button" onClick={() => { queueRef.current = []; setQueuedMessages([]); }} title="清空待执行消息">清空</button>}
          </div>
        )}
        <div className="chat-input">
          {busy && (
            <div className="busy-input-mode" role="group" aria-label="当前任务中的新输入处理方式">
              <span>当前任务中新输入：</span>
              <button type="button" className={busyInputMode === "queue" ? "active" : ""} onClick={() => setBusyInputMode("queue")}>排队执行</button>
              <button type="button" className={busyInputMode === "context" ? "active" : ""} onClick={() => setBusyInputMode("context")}>注入上下文</button>
              <small>{busyInputMode === "queue" ? "本轮完成后自动开始" : "保存到下一轮，不打断当前任务"}</small>
            </div>
          )}
          <div className="chat-input-row">
            <textarea
              value={input}
              placeholder={busy ? "输入后可排队执行，或仅注入下一轮上下文..." : "输入指令... (Enter 发送，Shift+Enter 换行，可粘贴图片)"}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              onCompositionEnd={() => {}}
              onPaste={(e) => {
                handleClipboardPaste(e);
              }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
              onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer?.files || []); }}
              onChange={(e) => setInput(e.target.value)}
            />
            <div className="input-send">
              {busy ? (
                <>
                  {hasDraft && <button className="btn primary pending-send-btn" onClick={() => send()} title={busyInputMode === "queue" ? "排队执行（Enter）" : "注入上下文（Enter）"}>
                    <Icon name={busyInputMode === "queue" ? "list" : "layers"} size={13} />
                    <span>{busyInputMode === "queue" ? "排队" : "注入"}</span>
                  </button>}
                  <button className="btn danger stop-btn" onClick={stop} disabled={stopping} title={stopping ? "正在中断当前回复" : "中断当前回复"} aria-label={stopping ? "正在中断当前回复" : "中断当前回复"}>
                    <Icon name={stopping ? "loading" : "stop"} size={14} className={stopping ? "icon-loading" : ""} />
                    <span>{stopping ? "中断中" : "中断"}</span>
                  </button>
                </>
              ) : (
                <button className="btn primary send-btn" onClick={() => send()} title="发送 (Enter)"><Icon name="send" size={14} /></button>
              )}
            </div>
          </div>
          {/* 工具栏按“上下文 / 工作模式 / Agent 设置 / 会话”分组，窄栏时整组换行 */}
          <div className="chat-toolbar">
            <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
            <input ref={attInputRef} type="file" accept=".docx,.xlsx,.pptx,.md,.markdown,.txt,.pdf,.html,.htm,.csv,.json" multiple hidden onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
            <div className="chat-toolbar-group toolbar-context-group" title="上下文工具">
              <span className="chat-toolbar-label">上下文</span>
              <button className="ct-btn" title="上传图片" onClick={() => fileInputRef.current?.click()}>
                <Icon name="image" size={14} />
              </button>
              <button className="ct-btn" title="上传附件（docx/xlsx/pdf/md/txt 等）" onClick={() => attInputRef.current?.click()}>
                <Icon name="link" size={14} />
              </button>
              {mapContext?.center && <button className="ct-btn" title="将当前地图视图加入下一轮上下文" onClick={injectMapContext}>
                <Icon name="locate" size={14} />
              </button>}
              <button className={`ct-btn ct-context-btn ${compacting ? "active" : ""}`} title={busy ? "当前任务完成后才能压缩上下文" : "压缩当前 Pi 会话上下文，保留任务摘要"} onClick={compactContext} disabled={busy || compacting}>
                <Icon name={compacting ? "loading" : "layers"} size={14} />
                <span>压缩</span>
              </button>
            </div>
            <span className="ct-sep" />
            <div className="chat-toolbar-group toolbar-mode-group" title={currentMode.title}>
              <span className="chat-toolbar-label">模式</span>
              <div className="mode-switch mode-switch-wide">
              {Object.entries(MODE_META).map(([id, meta]) => (
                <button
                  key={id}
                  className={`mode-btn ${editMode === id ? "active" : ""}`}
                  onClick={() => setEditMode(id)}
                  title={meta.title}
                ><Icon name={meta.icon} size={12} /><span className="mode-label">{meta.shortLabel}</span></button>
              ))}
              </div>
              <span className="mode-current-hint">{currentMode.hint}</span>
            </div>
            <span className="ct-sep" />
            {/* 模型选择：图标 + 浮层 */}
            <div className="chat-toolbar-group toolbar-agent-group" title="Agent 设置：模型 / 思考程度">
              <span className="chat-toolbar-label">Agent</span>
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
                    <div className="ct-pop-refresh" onClick={async (e) => { e.stopPropagation(); setModelMsg("扫描中…"); try { const d = await fetch("/api/models/refresh", { method: "POST" }).then((x) => x.json()); if (d.ok) { setModels(d.models || []); if (d.counts) setModelCounts(d.counts); setModelMsg(`可用 ${d.counts?.available ?? d.count ?? 0} / 配置 ${d.counts?.configured ?? "?"}`); } else setModelMsg("扫描失败: " + (d.error || "")); } catch (err) { setModelMsg("扫描失败: " + err.message); } setTimeout(() => setModelMsg(""), 2500); }} title="重新扫描 Pi 模型目录与可用模型">
                      <Icon name="refresh" size={11} /> 重新扫描模型
                    </div>
                    <div className="ct-model-meta">Pi Runtime：可用 {modelCounts.available || "—"} / 配置目录 {modelCounts.configured || models.length}</div>
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
            </div>
            <span className="chat-toolbar-spacer" />
            <div className="chat-toolbar-group toolbar-session-group">
              <button className="ct-btn" onClick={handleNewSession} title="新建会话">
                <Icon name="plus" size={14} />
              </button>
            </div>
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
function Message({ m, model, onToggleTool, onOpenFile, onMemoryApprove, onMemoryReject, onRollbackRun, onResend, index, prevRole, clientId, threadId }) {
  if (m.role === "system") {
    return (
      <div className={`msg system ${m.summary ? "summary-msg" : ""}`}>
        <div className="bubble">
          {m.text}
          {m.memoryProposal && (
            <div className="memory-proposal-card" role="note">
              <div><strong>{m.memoryProposal.section}</strong>：{m.memoryProposal.content}</div>
              {m.memoryProposal.status === "pending" ? (
                <><button className="btn-xs primary" onClick={() => onMemoryApprove?.(m.memoryProposal.id)}>确认写入记忆</button><button className="btn-xs" onClick={() => onMemoryReject?.(m.memoryProposal.id)}>拒绝</button></>
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

// ========== 旧版消息内任务卡（保留组件，兼容历史代码） ==========
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
