import React, { lazy, Suspense, useState, useCallback, useEffect, useRef } from "react";
import SessionSidebar from "./components/SessionSidebar.jsx";
import ChatPanel, { normalizeHistoryMessages } from "./components/ChatPanel.jsx";
import Resizer from "./components/Resizer.jsx";
const SkillsManager = lazy(() => import("./components/SkillsManager.jsx"));
const AgentMarket = lazy(() => import("./components/AgentMarket.jsx"));
const KnowledgeBase = lazy(() => import("./components/KnowledgeBase.jsx"));
const TemplateLibrary = lazy(() => import("./components/TemplateLibrary.jsx"));
const MapPanel = lazy(() => import("./components/MapPanel.jsx"));
const CommandPalette = lazy(() => import("./components/CommandPalette.jsx"));
// 文档预览依赖 docx-preview / pptxviewjs / x-data-spreadsheet 等重库，按需加载
const DocViewer = lazy(() => import("./components/DocViewer.jsx"));
import Icon from "./components/Icon.jsx";
import Logo from "./components/Logo.jsx";
import TaskCenter from "./components/任务中心.jsx";
import WorkProductPanel from "./components/工作产物面板.jsx";
import BrowserPanel from "./components/内置浏览器面板.jsx";
import SettingsPanel from "./components/SettingsPanel.jsx";
import MemoryTab from "./components/MemoryTab.jsx";
import { useTheme } from "./theme.jsx";
import { loadUIState, saveUIState } from "./persist-ui.js";
import { listFiles, refreshModels, listSessions, listProjects, listRuns, listWorkspaces, switchWorkspace, deleteWorkspace, deleteSession, deleteSessions, renameSession, getSession, getClientId, createAgentThread, resumeAgentThread, markAgentEventsRead, forkSession, pinSession, freezeSession } from "./api.js";

function historyReferences(text = "") {
  const refs = [];
  const seen = new Set();
  const add = (kind, target, source) => {
    const value = String(target || "").trim();
    if (!value) return;
    const id = `history_ref_${kind}_${value}`;
    if (seen.has(id)) return;
    seen.add(id);
    refs.push({ id, kind, target: value, source });
  };
  for (const m of String(text).matchAll(/@(知识库目录|知识库|模板目录|模板|文件)\[([^\]]+)\]/g)) {
    add({"知识库目录":"knowledge_dir", "知识库":"knowledge", "模板目录":"template_dir", "模板":"template", "文件":"file"}[m[1]], m[2], m[0]);
  }
  for (const m of String(text).matchAll(/(^|[\s(])@([^\s@，。！？\]}]+)/g)) {
    const target = m[2].replace(/[),;。！？]+$/, "");
    if (target.includes("/") || target.includes("\\") || /\.(docx|xlsx|pptx|pdf|csv|json|md|markdown|txt|html|htm)$/i.test(target)) add("file", target, `@${target}`);
  }
  for (const m of String(text).matchAll(/&会话\[([^\]]+)\]/g)) add("session", m[1], m[0]);
  return refs;
}

function cleanPersistedMessage(text = "") {
  const source = String(text || "");
  const inlineTaskGoal = source.match(/^#{1,6}\s*当前任务目标\s*[:：]\s*([^\n]+)/i);
  if (inlineTaskGoal?.[1]) return inlineTaskGoal[1].trim();
  const envelopeGoal = source.match(/^\s*#{1,6}\s*当前任务(?:\s+|\n)+(?:目标|任务目标)\s*[:：]\s*([\s\S]*?)(?=(?:\s+|\n)-?\s*(?:模式|引用|输出要求|当前文件|工作流)\s*[:：]|$)/i);
  if (envelopeGoal?.[1]) return envelopeGoal[1].trim();
  const goal = source.match(/(?:^|\n)\s*-?\s*(?:目标|任务目标)\s*[:：]\s*([\s\S]*?)(?=\n\s*-?\s*(?:模式|引用|输出要求|当前文件|工作流)\s*[:：]|$)/i);
  if (goal?.[1]) return goal[1].trim();
  return source.replace(/^##\s*当前任务[\s\S]*?\n边界：[^\n]+\n\n?/i, "").trim();
}

function DeferredModule({ children, label = "模块" }) {
  return <Suspense fallback={<div className="module-loading">正在加载{label}…</div>}>{children}</Suspense>;
}

// 全局错误边界
class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("App error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="app-error">
          <div className="app-error-content">
            <div className="app-error-icon">⚠</div>
            <div className="app-error-title">应用出错</div>
            <div className="app-error-text">{this.state.error?.message || "未知错误"}</div>
            <button className="btn primary" onClick={() => window.location.reload()}>
              刷新页面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

let histSeq = 0;
const histId = () => `h${++histSeq}`;

function historyImageData(block) {
  if (!block) return null;
  const source = block.source || block.image || block;
  const data = source?.data || block.data || source?.url || block.url;
  if (!data) return null;
  if (String(data).startsWith("data:")) return String(data);
  const mediaType = source?.mediaType || source?.mimeType || block.mediaType || block.mimeType || "image/png";
  return `data:${mediaType};base64,${data}`;
}

function entryCreatedAt(entry, message) {
  return entry?.timestamp || entry?.createdAt || entry?.time || message?.timestamp || message?.createdAt || null;
}

function sameWorkspacePath(a, b) {
  if (!a || !b) return false;
  const normalize = (value) => String(value).replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

const GLOBAL_EVENT_NOTICES = new Set(["run_finished", "run_recovered", "run_cancel_requested", "agent_error", "ask_user"]);

export default function App() {
  const [files, setFiles] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [unreadByThread, setUnreadByThread] = useState({});
  const [eventVersion, setEventVersion] = useState(0);
  const [artifactVersion, setArtifactVersion] = useState(0);
  const [tabs, setTabs] = useState([]); // [{ name, kind, url?, sheets?, grids?, content? }]
  const [activeTab, setActiveTab] = useState(null); // 当前激活的文件名
  const current = activeTab ? tabs.find((t) => t.name === activeTab) || null : null;
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeModule, setActiveModule] = useState(null); // 0.10 统一模块入口
  const [settingsModuleTab, setSettingsModuleTab] = useState("settings");
  const [settingsSection, setSettingsSection] = useState("model");
  const [previewOpen, setPreviewOpen] = useState(true); // 0.10 右侧工作产物预览
  const [previewLayout, setPreviewLayout] = useState(0); // 0=默认，1=50%，2=100%
  const [mapChatVisible, setMapChatVisible] = useState(true); // 地图模式保留 Agent 对话，可独立隐藏
  const [previewTab, setPreviewTab] = useState("document");
  const [browserPanelOpen, setBrowserPanelOpen] = useState(false); // 内置浏览器独立侧栏
  const [browserFullscreen, setBrowserFullscreen] = useState(false);
  const browserActiveRef = useRef(false);

  useEffect(() => {
    if (!browserPanelOpen) setBrowserFullscreen(false);
  }, [browserPanelOpen]);
  const [conversationMode, setConversationMode] = useState("chat");
  const [conversationPhase, setConversationPhase] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false); // 命令面板（Ctrl/Cmd+K）
  const [clientId] = useState(getClientId);
  const [threadId, setThreadId] = useState(() => {
    const saved = localStorage.getItem("oaw_thread_id");
    if (saved) return saved;
    const id = `thread-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    localStorage.setItem("oaw_thread_id", id);
    return id;
  });
  const [mapContexts, setMapContexts] = useState({});
  const currentMapContext = mapContexts[threadId] || null;
  const currentMapProject = currentMapContext?.mapProject || "zhejiang-map";

  // 浏览器活动侦测：Agent 调用 browser_* 时自动打开浏览器侧栏（仅在激活瞬间触发一次）
  useEffect(() => {
    if (!clientId) return undefined;
    let stopped = false;
    let source = null;
    let retry = null;
    const connect = () => {
      if (stopped) return;
      const params = new URLSearchParams({ client: clientId, thread: threadId || "", frames: "0" });
      source = new EventSource(`/api/browser/stream?${params.toString()}`);
      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data || "{}");
          if (payload.type !== "state") return;
          const active = Boolean(payload.data?.active);
          if (active && !browserActiveRef.current) {
            setBrowserPanelOpen(true);
          }
          browserActiveRef.current = active;
        } catch {}
      };
      source.onerror = () => {
        try { source.close(); } catch {}
        if (!stopped) retry = setTimeout(connect, 5000);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      try { source?.close(); } catch {}
      browserActiveRef.current = false;
    };
  }, [clientId, threadId]);

  const [models, setModels] = useState([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem("oaw_model") || "");
  const [workspaces, setWorkspaces] = useState([]);
  const [projects, setProjects] = useState([]);
  const [currentWorkspace, setCurrentWorkspace] = useState("");
  const currentProject = projects.find((project) => sameWorkspacePath(project.rootPath, currentWorkspace)) || null;
  const [currentDir, setCurrentDir] = useState(""); // 相对路径子目录
  const currentDirRef = useRef(""); // 与 currentDir 同步的最新值，供无参 refreshFiles 使用
  const [historyMessages, setHistoryMessages] = useState(null); // 加载的历史会话消息
  const [historyThreadId, setHistoryThreadId] = useState(null); // 当前历史消息对应的 thread，避免切换 effect 覆盖恢复内容
  const [currentSessionId, setCurrentSessionId] = useState(null); // 当前会话 id（用于界面恢复）
  const currentSession = sessions.find((session) => session.id === currentSessionId) || null;
  const [docLoading, setDocLoading] = useState(false); // 文档加载中
  const restoredRef = useRef(false); // 界面状态恢复标记（避免重复/过早保存）
  const sessionsRef = useRef([]);
  const sessionsRefreshRef = useRef(null);
  const projectsRefreshRef = useRef(null);
  const eventRefreshTimerRef = useRef(null);
  const sessionHistoryCacheRef = useRef(new Map());
  const chatInputRef = useRef(null); // 引用 ChatPanel 输入框（@ 按钮插入）
  const mapBridgeRef = useRef(null); // 地图模式复用同一个 ChatPanel，保持消息与 SSE 事件流连续
  const sessionLoadSeqRef = useRef(0);
  const workspaceSwitchSeqRef = useRef(0);
  const filesRequestSeqRef = useRef(0);
  const currentThreadRef = useRef(threadId);
  const eventCursorRef = useRef(Number(localStorage.getItem("oaw_event_cursor") || 0));
  const eventNoticeKeysRef = useRef(new Set());
  const pendingChatInsertRef = useRef([]);
  const { theme, toggleTheme } = useTheme();

  // 所有功能模块共用一个互斥入口，避免知识库、地图、智能体广场等弹层叠在一起。
  const closeExternalModules = useCallback(() => {
    setActiveModule(null);
  }, []);
  const openExternalModule = useCallback((module) => {
    setActiveModule(module);
  }, []);

  // 外部模块打开时主 ChatPanel 会卸载；先暂存 @ 引用，待回到对话后再写入，
  // 避免“点击调用但输入框没有任何内容”的竞态。
  const insertChatText = useCallback((value) => {
    const text = String(value || "").trim();
    if (!text) return;
    if (chatInputRef.current?.insertText) {
      chatInputRef.current.insertText(text);
      return;
    }
    pendingChatInsertRef.current.push(text);
  }, []);

  useEffect(() => {
    if (activeModule || !pendingChatInsertRef.current.length) return undefined;
    const timer = window.setTimeout(() => {
      const pending = pendingChatInsertRef.current.splice(0);
      if (!chatInputRef.current?.insertText) {
        pendingChatInsertRef.current.unshift(...pending);
        return;
      }
      pending.forEach((text) => chatInputRef.current.insertText(text));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeModule]);

  const refreshModelCatalog = useCallback(async () => {
    const data = await refreshModels();
    setModels(data.models || []);
    setDefaultModel(data.default || "");
    return data;
  }, []);

  useEffect(() => {
    currentThreadRef.current = threadId;
  }, [threadId]);

  // @ 按钮：把文件/文件夹路径插入到对话输入框
  const handleAtMention = useCallback((rel, isDir) => {
    const marker = isDir ? rel + "/" : rel;
    insertChatText(`@${marker}`);
  }, [insertChatText]);

  // 知识库 / Skills 的只读 Chat 转 Agent：关闭入口后把问题、引用和上下文
  // 交给主 ChatPanel，用户确认后再发送，避免检索入口隐式产生写入。
  const handlePromoteToAgent = useCallback((payload = {}) => {
    closeExternalModules();
    window.setTimeout(() => chatInputRef.current?.startAgentTask?.(payload), 120);
  }, [closeExternalModules]);

  // 新建会话：清空历史消息和当前文档
  const handleNewSession = useCallback(async (workspace = currentWorkspace) => {
    const next = `thread-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    let created = null;
    try {
      // 先让后端创建并固定 session/workspace，再切换前端 thread，避免 SSE 先创建一个错误 cwd 的空 Agent。
      const project = projects.find((item) => sameWorkspacePath(item.rootPath, workspace || currentWorkspace));
      created = await createAgentThread(clientId, next, workspace || undefined, { projectId: project?.id || null });
      // 新会话已经由当前 Chat 状态立即接管；历史列表刷新延后，避免工作区切换
      // 立刻触发一次全量 JSONL 扫描，阻塞刚完成的界面切换。
      window.setTimeout(() => refreshSessions(), 600);
    } catch (e) {
      console.warn("创建新会话失败，将在首次对话时自动创建:", e.message);
    }
    setThreadId(next);
    localStorage.setItem("oaw_thread_id", next);
    setHistoryMessages(null);
    setHistoryThreadId(null);
    setTabs([]);
    setActiveTab(null);
    currentDirRef.current = "";
    setCurrentDir("");
    setCurrentSessionId(created?.sessionId || null);
    setMapContexts((prev) => ({ ...prev, [next]: null }));
    lastSessionIdRef.current = created?.sessionId || null;
  }, [clientId, currentWorkspace, projects]);

const refreshFiles = useCallback(async (dir) => {
    const requestedDir = typeof dir === "string" ? dir : currentDirRef.current;
    const requestSeq = ++filesRequestSeqRef.current;
    try {
      const result = await listFiles(requestedDir);
      // 目录已切换或本次请求不是最新时，过期响应不得覆盖列表
      if (requestSeq === filesRequestSeqRef.current && requestedDir === currentDirRef.current) setFiles(result.files || []);
    } catch {}
  }, []);

  const refreshSessions = useCallback(async () => {
    if (sessionsRefreshRef.current) return sessionsRefreshRef.current;
    const request = listSessions()
      .then((data) => {
        const next = data.sessions || [];
        setSessions(next);
        return next;
      })
      .catch(() => []);
    sessionsRefreshRef.current = request;
    try { return await request; }
    finally {
      if (sessionsRefreshRef.current === request) sessionsRefreshRef.current = null;
    }
  }, []);

  // 根级事件订阅：当前对话继续使用原有 thread SSE，App 额外监听所有 thread 的重要状态，
  // 让切换后的后台任务仍能刷新历史和未读提示。
  useEffect(() => {
    let source;
    let cancelled = false;
    const cursorKey = "oaw_event_cursor";
    const connect = async () => {
      let cursor = eventCursorRef.current;
      if (!localStorage.getItem(cursorKey)) {
        try {
          const state = await fetch(`/api/agent/events/state?client=${encodeURIComponent(clientId)}`).then((r) => r.json());
          if (Number.isFinite(Number(state.latest))) cursor = Number(state.latest);
          eventCursorRef.current = cursor;
          localStorage.setItem(cursorKey, String(cursor));
        } catch {}
      }
      if (cancelled) return;
      source = new EventSource(`/api/agent/events?client=${encodeURIComponent(clientId)}&after=${encodeURIComponent(cursor)}`);
      source.onmessage = (message) => {
        try {
          const payload = JSON.parse(message.data || "{}");
          const event = payload.event || payload;
          const seq = Number(event.seq || 0);
          if (!seq || seq <= eventCursorRef.current) return;
          eventCursorRef.current = seq;
          localStorage.setItem(cursorKey, String(seq));
          setEventVersion((value) => value + 1);
          if (["run_finished", "file_changed", "artifact_published"].includes(event.type)) {
            setArtifactVersion((value) => value + 1);
          }
          const thread = event.threadId || "";
          const noticeKey = `${thread}:${event.runId || "event"}:${event.type}`;
          if (thread && thread !== currentThreadRef.current && GLOBAL_EVENT_NOTICES.has(event.type) && !eventNoticeKeysRef.current.has(noticeKey)) {
            eventNoticeKeysRef.current.add(noticeKey);
            setUnreadByThread((prev) => ({ ...prev, [thread]: (prev[thread] || 0) + 1 }));
          }
          if (["run_finished", "run_recovered", "run_cancel_requested", "agent_error"].includes(event.type)) {
            if (!eventRefreshTimerRef.current) {
              eventRefreshTimerRef.current = window.setTimeout(() => {
                eventRefreshTimerRef.current = null;
                if (document.visibilityState === "visible") refreshSessions();
              }, 180);
            }
          }
        } catch {}
      };
    };
    connect();
    return () => {
      cancelled = true;
      source?.close();
      if (eventRefreshTimerRef.current) {
        clearTimeout(eventRefreshTimerRef.current);
        eventRefreshTimerRef.current = null;
      }
    };
  }, [clientId, refreshSessions]);

  const refreshProjects = useCallback(async () => {
    if (projectsRefreshRef.current) return projectsRefreshRef.current;
    const request = listProjects()
      .then((data) => {
        const next = data.projects || [];
        setProjects(next);
        return next;
      })
      .catch(() => []);
    projectsRefreshRef.current = request;
    try { return await request; }
    finally {
      if (projectsRefreshRef.current === request) projectsRefreshRef.current = null;
    }
  }, []);

  useEffect(() => {
    refreshFiles();
    refreshSessions();
    refreshProjects();
    let modelTimer;
    const sessionTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshSessions();
    }, 15000);
    const projectTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshProjects();
    }, 30000);
    const syncModels = async () => {
      try {
        await refreshModelCatalog();
      } catch {
        // 扫描失败时保留上一次列表，避免模型下拉框瞬间清空。
      }
    };
    syncModels();
    modelTimer = window.setInterval(syncModels, 60_000);
    const onVisibility = () => { if (document.visibilityState === "visible") syncModels(); };
    document.addEventListener("visibilitychange", onVisibility);
    (async () => {
      try {
        const w = await listWorkspaces();
        setWorkspaces(w.workspaces || []);
        const savedWorkspace = loadUIState()?.workspace;
        const restored = w.workspaces?.find((item) => sameWorkspacePath(item.path, savedWorkspace));
        if (restored) setCurrentWorkspace(restored.path);
        else if (w.workspaces?.[0]) setCurrentWorkspace(w.workspaces[0].path);
      } catch {}
    })();
    return () => {
      window.clearInterval(modelTimer);
      window.clearInterval(sessionTimer);
      window.clearInterval(projectTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshFiles, refreshSessions, refreshProjects, refreshModelCatalog]);

  // 全局 Ctrl/Cmd+K 切换命令面板
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 切换工作区
  const handleWorkspaceChange = useCallback(async (dir) => {
    const requestedPath = String(dir || "").trim();
    if (!requestedPath || sameWorkspacePath(requestedPath, currentWorkspace)) return;
    const switchSeq = ++workspaceSwitchSeqRef.current;
    // 先清空旧工作区的视图，避免等待服务端时继续操作旧文件。
    currentDirRef.current = "";
    setCurrentDir("");
    setFiles([]);
    setTabs([]);
    setActiveTab(null);
    setHistoryMessages(null);
    setCurrentSessionId(null);
    try {
      const r = await switchWorkspace(requestedPath);
      if (switchSeq !== workspaceSwitchSeqRef.current) return;
      setCurrentWorkspace(r.workspace);
      // 新工作区加入下拉列表（自定义路径切换后也能在下拉中看到）
      setWorkspaces((prev) => {
        if (prev.some((w) => w.path === r.workspace)) return prev;
        const name = String(r.workspace).split(/[\\/]/).filter(Boolean).pop() || r.workspace;
        return [...prev, { path: r.workspace, name }];
      });
      setFiles(r.files || []);
      // 工作区切换后异步刷新项目：让新打开的本地目录立即出现在项目栏，且不阻塞文件视图。
      void refreshProjects();
      void handleNewSession(r.workspace);
    } catch (e) {
      if (switchSeq === workspaceSwitchSeqRef.current) {
        refreshFiles();
        alert("切换失败: " + e.message);
      }
    }
  }, [currentWorkspace, handleNewSession, refreshFiles, refreshProjects]);

  const visibleSessions = currentWorkspace
    ? sessions.filter((session) => !session.cwd || sameWorkspacePath(session.cwd, currentWorkspace))
    : sessions;
  const handleProjectChange = useCallback((id) => {
    const project = projects.find((item) => item.id === id);
    if (project?.rootPath) handleWorkspaceChange(project.rootPath);
  }, [projects, handleWorkspaceChange]);

  // 移除工作区路径（从下拉列表隐藏，不删文件）
  const handleWorkspaceRemove = useCallback(async (dir) => {
    try {
      await deleteWorkspace(dir);
      setWorkspaces((prev) => prev.filter((w) => w.path !== dir));
      // 若移除的是当前工作区，切回默认
      if (dir === currentWorkspace) {
        const def = workspaces.find((w) => w.name === "默认工作区");
        if (def) handleWorkspaceChange(def.path);
      }
    } catch (e) { alert("移除失败: " + e.message); }
  }, [currentWorkspace, workspaces, handleWorkspaceChange]);

// 进入/返回子目录
  const handleDirChange = useCallback((dir) => {
    const nextDir = String(dir || "");
    currentDirRef.current = nextDir;
    setCurrentDir(nextDir);
    void refreshFiles(nextDir);
  }, [refreshFiles]);

  const open = useCallback(async (name, thread = threadId, cwd = currentWorkspace) => {
    setDocLoading(true);
    // 容错：调用方可能只传了工作区（例如产物跨工作区打开），thread 缺失时回退到当前会话
    const effectiveThread = thread || threadId;
    const effectiveCwd = cwd || currentWorkspace;
    try {
      const revision = Date.now();
      // 携带 cwd：产物可能属于其他工作区，不能依赖服务端全局当前工作区
      const cwdQuery = effectiveCwd ? `&cwd=${encodeURIComponent(effectiveCwd)}` : "";
      const response = await fetch(`/api/doc/${encodeURIComponent(name)}?client=${encodeURIComponent(clientId)}&thread=${encodeURIComponent(effectiveThread)}${cwdQuery}&v=${revision}`, { cache: "no-store" });
      const doc = await response.json();
      if (!response.ok || doc?.error) throw new Error(doc?.error || `加载失败 HTTP ${response.status}`);
      const previewUrl = doc.url ? `${doc.url}${doc.url.includes("?") ? "&" : "?"}v=${revision}` : doc.url;
      const nextDoc = { ...doc, url: previewUrl, previewRevision: revision };
      // 单次 setTabs：避免 React 批处理导致重复 tab
      setTabs((prev) => {
        const exists = prev.find((t) => t.name === name);
        if (exists) {
          return prev.map((t) => (t.name === name ? { ...t, ...nextDoc } : t));
        }
        return [...prev, { name, ...nextDoc }];
      });
      setActiveTab(name);
      setDocLoading(false);
    } catch (e) { alert("打开失败: " + e.message); setDocLoading(false); }
  }, [clientId, threadId, currentWorkspace]);

  // 关闭 tab
  const closeTab = useCallback((name) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.name === name);
      if (idx === -1) return prev;
      const next = prev.filter((t) => t.name !== name);
      if (activeTab === name) {
        // 激活相邻 tab
        const neighbor = next[Math.min(idx, next.length - 1)];
        setActiveTab(neighbor ? neighbor.name : null);
      }
      return next;
    });
  }, [activeTab]);

  // 点击历史会话：加载该会话的消息记录，并尝试打开关联文件
  const handleSelectSession = useCallback(async (session) => {
    const loadSeq = ++sessionLoadSeqRef.current;
    // 会话自带工作区归属；先切换文件视图，再切换 thread，避免历史会话在另一个项目目录下恢复。
    const targetWorkspace = session.cwd || currentWorkspace;
    let resumedWorkspace = targetWorkspace;
    if (targetWorkspace && !sameWorkspacePath(targetWorkspace, currentWorkspace)) {
      try {
        const switched = await switchWorkspace(targetWorkspace);
        if (loadSeq !== sessionLoadSeqRef.current) return;
        resumedWorkspace = switched.workspace;
        setCurrentWorkspace(switched.workspace);
        currentDirRef.current = "";
        setCurrentDir("");
        setFiles(switched.files || []);
        setTabs([]);
        setActiveTab(null);
      } catch (e) {
        console.warn("切换到会话工作区失败，仍尝试加载历史:", e.message);
      }
    }
    const conversationId = session.threadId || session.id;
    const cachedHistory = sessionHistoryCacheRef.current.get(session.id);
    if (cachedHistory) {
      setHistoryThreadId(conversationId);
      setHistoryMessages(cachedHistory);
    } else {
      setHistoryThreadId(null);
      setHistoryMessages(null);
    }
    // 恢复 Agent 与读取历史互不依赖；并行执行可明显缩短点击历史后的空白等待。
    // 但在 resume 完成前不切换 thread，避免 SSE 先创建一个新的空会话并与恢复竞态。
    const historyPromise = Promise.all([
      getSession(session.id),
      listRuns("", 50, { sessionId: session.id }).catch(() => ({ runs: [] })),
    ]);
    const resumePromise = resumeAgentThread(clientId, conversationId, session.id, resumedWorkspace)
      .catch((e) => { console.warn("恢复 Agent 会话失败，仍加载历史记录:", e.message); return null; });
    setUnreadByThread((prev) => {
      if (!prev[conversationId]) return prev;
      const next = { ...prev };
      delete next[conversationId];
      return next;
    });
    markAgentEventsRead(clientId, eventCursorRef.current).catch(() => {});
    try {
      const [[d, runData]] = await Promise.all([historyPromise, resumePromise]);
      if (loadSeq !== sessionLoadSeqRef.current) return;
      setCurrentSessionId(session.id);
      setThreadId(conversationId);
      localStorage.setItem("oaw_thread_id", conversationId);
      // 按原始 JSONL 顺序重建消息。toolResult 是工具输出，不能渲染成 You 的用户气泡；
      // 它要按 toolCallId 回填到对应 Agent 工具卡，否则 Word/PPT 读取结果会被误认为用户输入。
      const msgs = [];
      const toolBlocks = new Map();
      for (const e of (d.entries || [])) {
        if (e.type !== "message" || !e.message) continue;
        const m = e.message;
        const role = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : m.role;
        if (role === "toolResult" || role === "tool_result") {
          const output = typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content.filter((b) => b?.type === "text").map((b) => b.text || "").join("\n")
              : JSON.stringify(m.content || m.output || "", null, 2);
          const block = toolBlocks.get(m.toolCallId);
          if (block) {
            block.output = output;
            block.result = output;
            block.done = true;
            block.isError = !!m.isError;
          } else {
            // 老会话可能没有可配对的 toolCallId：挂到最近一条 Agent 消息，仍不显示为用户消息。
            const lastAssistant = [...msgs].reverse().find((item) => item.role === "assistant");
            if (lastAssistant) lastAssistant.blocks.push({
              type: "tool", id: histId(), name: m.toolName || "tool result", input: "",
              output, result: output, done: true, isError: !!m.isError, expanded: false, duration: null,
            });
          }
          continue;
        }
        if (role !== "assistant" && role !== "user") continue;
        let text = "";
        const blocks = [];
        const images = [];
        if (typeof m.content === "string") text = m.content;
        else if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b.type === "text" || b.type === "input_text") text += (text ? "\n" : "") + (b.text || b.content || "");
            else if (b.type === "image" || b.type === "input_image") {
              const src = historyImageData(b);
              if (src) images.push(src);
            } else if (b.type === "thinking") blocks.push({ type: "thinking", text: b.thinking || "" });
            else if (b.type === "toolCall") {
              const callId = b.id || b.toolCallId || histId();
              const rawInput = b.input ?? b.arguments ?? b.params ?? "";
              const input = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput, null, 2);
              const block = {
                type: "tool", id: callId, name: b.toolName || b.name || "tool", input,
                output: "", result: "", done: false, isError: false, expanded: false, duration: null,
              };
              blocks.push(block);
              toolBlocks.set(callId, block);
            }
          }
        }
        // 若 assistant 有纯文本且没有 text block，追加为文本块；用户消息仍保留原始文本。
        if (role === "assistant" && text && !blocks.some((b) => b.type === "text")) blocks.push({ type: "text", text });
        const displayText = role === "user" ? cleanPersistedMessage(text) : text;
        const currentDocMatch = text.match(/当前(?:打开|工作)文件:\s*([^\]\n]+)/);
        msgs.push({
          id: e.id, role, text: displayText, images, blocks, references: historyReferences(text),
          currentDoc: currentDocMatch?.[1]?.trim() || null, status: "done", createdAt: entryCreatedAt(e, m),
        });
      }
      const runMessages = [...(runData?.runs || [])]
        .filter((run) => run?.status)
        .filter((run, index, list) => list.findIndex((item) => item.id === run.id) === index)
        .sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")))
        .map((run, index, list) => ({
          id: `run-summary-${run.id}`,
          role: "system",
          text: run.summary || (run.status === "running" ? "本轮任务仍在执行中" : `本轮任务${run.status === "failed" ? "失败" : run.status === "cancelled" ? "已取消" : "完成"}，处理 ${run.artifacts?.length || 0} 个文件`),
          products: (run.artifacts || []).map((a) => a.path).filter(Boolean),
          artifacts: run.artifacts || [],
          runId: run.id,
          runStatus: run.status,
          references: run.references || [],
          task: run.task || null,
          status: run.status === "running" ? "streaming" : "done",
          summary: true,
          runIndex: index + 1,
          runCount: list.length,
          runMode: run.task?.mode || "agent",
          // 完成语义：显式 complete_task 或服务端推断结果
          completion: run.completion || null,
          eventCount: Array.isArray(run.events) ? run.events.length : 0,
          events: Array.isArray(run.events) ? run.events.map((event, eventIndex) => ({
            ...event,
            key: `history:${run.id}:${event.seq || eventIndex}`,
          })) : [],
          expanded: true,
          createdAt: run.finishedAt || run.startedAt || null,
        }));
      // Run 总结按完成/开始时间插回原始消息流。之前把所有 Run 总结直接
      // append 到消息末尾，恢复会话后就会出现“对话一坨、产物一坨”。
      const loadedHistory = normalizeHistoryMessages([...msgs, ...runMessages].sort((a, b) => {
        const left = Date.parse(a.createdAt || "") || 0;
        const right = Date.parse(b.createdAt || "") || 0;
        return left - right;
      }));
      sessionHistoryCacheRef.current.set(session.id, loadedHistory);
      // 只保留最近几条缓存，避免长会话历史常驻内存；再次点击时仍可先显示缓存。
      while (sessionHistoryCacheRef.current.size > 8) {
        const first = sessionHistoryCacheRef.current.keys().next().value;
        if (first === undefined) break;
        sessionHistoryCacheRef.current.delete(first);
      }
      setHistoryMessages(loadedHistory);
      setHistoryThreadId(conversationId);
      // 从消息里解析会话关联的文件，尝试打开
      const fileMatch = msgs.find((m) => m.role === "user" && m.text && m.text.includes("当前打开文件"));
      if (fileMatch) {
        const fn = fileMatch.text.match(/当前打开文件:\s*([^\]\n]+)/);
        if (fn?.[1]) {
          // 历史文本先显示，关联文档在后台打开，不再阻塞会话切换。
          void open(fn[1].trim(), conversationId).catch(() => {});
        }
      }
    } catch (e) {
      if (loadSeq === sessionLoadSeqRef.current) alert("加载会话失败: " + e.message);
    }
  }, [clientId, currentWorkspace, open, refreshProjects]);

  const handleForkSession = useCallback(async (id, label) => {
    const source = sessions.find((item) => item.id === id);
    const result = await forkSession(id, label, {
      purpose: "从历史会话创建独立分析分支",
      sourceMessageId: null,
    });
    await refreshSessions();
    await handleSelectSession({
      id: result.id,
      threadId: result.threadId || result.id,
      cwd: result.cwd || source?.cwd || currentWorkspace,
      projectId: result.projectId || source?.projectId || currentProject?.id || null,
      parentSessionId: result.parentSessionId || id,
      label: result.label || label || "会话分支",
      title: result.label || label || "会话分支",
      pinned: false,
      frozen: false,
    });
    return result;
  }, [currentProject?.id, currentWorkspace, handleSelectSession, refreshSessions, sessions]);

  const handlePinSession = useCallback(async (id, pinned) => {
    await pinSession(id, pinned);
    await refreshSessions();
  }, [refreshSessions]);

  const handleDeleteSession = useCallback(async (id) => {
    await deleteSession(id);
    if (currentSessionId === id) {
      setHistoryMessages(null);
      setCurrentSessionId(null);
    }
    await refreshSessions();
  }, [currentSessionId, refreshSessions]);

  const handleBatchDeleteSessions = useCallback(async (ids) => {
    const result = await deleteSessions(ids);
    if (currentSessionId && result.deleted?.includes(currentSessionId)) {
      setHistoryMessages(null);
      setCurrentSessionId(null);
    }
    await refreshSessions();
    if (result.skipped?.length) {
      const names = result.skipped.map((item) => item.reason).filter(Boolean);
      if (names.length) window.setTimeout(() => alert(`部分会话未删除：${names.join("、")}`), 0);
    }
    return result;
  }, [currentSessionId, refreshSessions]);

  const handleRenameSession = useCallback(async (id, label) => {
    await renameSession(id, label);
    await refreshSessions();
  }, [refreshSessions]);

  const handleFreezeSession = useCallback(async (id, frozen) => {
    await freezeSession(id, frozen);
    await refreshSessions();
  }, [refreshSessions]);

  const handleOpenRun = useCallback((run) => {
    const id = run?.sessionId || run?.threadId;
    if (!id) return;
    return handleSelectSession({
      id,
      threadId: run.threadId || id,
      cwd: run.cwd || currentWorkspace,
      projectId: run.projectId || currentProject?.id || null,
      title: run.task?.goal || "任务对应会话",
      label: run.task?.goal || "任务对应会话",
    });
  }, [currentProject?.id, currentWorkspace, handleSelectSession]);

  const handleFileChanged = useCallback((changed) => {
    const changedPaths = new Set((Array.isArray(changed) ? changed : []).map((item) => String(item || "").replace(/\\/g, "/")));
    refreshFiles();
    if (activeTab && changedPaths.has(String(activeTab).replace(/\\/g, "/"))) {
      // 添加延迟避免与 agent_end 竞态
      setTimeout(() => {
        open(activeTab);
      }, 100);
    }
  }, [activeTab, refreshFiles, open]);

  // 暴露 refreshSessions 给 ChatPanel（agent_end 时刷新）
  const handleAgentEnd = useCallback(() => {
    // 添加延迟让文件变更事件先处理
    setTimeout(() => {
      refreshSessions();
    }, 200);
  }, [refreshSessions]);

  // ChatPanel 上报 pi 会话 id → 持久化（刷新后恢复当前对话）
  const handleSessionChange = useCallback((id) => {
    if (id) setCurrentSessionId(id);
  }, []);

  // ===== 界面状态固化（localStorage）=====
  const [uiRestored, setUiRestored] = useState(false); // 恢复是否完成（完成后才允许保存）
  const restoredSessionRef = useRef(false); // 会话恢复只执行一次
  // 上次会话 id 缓存：刷新后会话恢复前，保存逻辑不覆盖 lastSessionId（避免恢复竞态）
  const lastSessionIdRef = useRef(null);
  useEffect(() => {
    lastSessionIdRef.current = loadUIState()?.lastSessionId || null;
  }, []);

  // 恢复：工作区 → 打开的文档 tabs → 激活 tab → 模式/侧栏/子目录
  useEffect(() => {
    if (uiRestored) return;
    if (!currentWorkspace) return; // 等待工作区列表就绪
    const saved = loadUIState();
    if (!saved) { setUiRestored(true); return; }
    (async () => {
      try {
        if (saved.workspace && !sameWorkspacePath(saved.workspace, currentWorkspace)) {
          const switched = await switchWorkspace(saved.workspace);
          setCurrentWorkspace(switched.workspace);
          setFiles(switched.files || []);
        }
      } catch {}
      for (const t of saved.tabs || []) {
        if (!t?.name) continue;
        // 防御：过滤非法/脏文件名（历史遗留的 URL 编码或正则片段），避免打开失败
        if (!/^(?![\\/])[^:*?"<>|\[\]]{1,300}$/.test(t.name) || t.name.split(/[\\/]/).includes("..")) continue;
        try { await open(t.name); } catch {}
      }
      if (saved.activeTab) setActiveTab(saved.activeTab);
      if (saved.currentDir) {
        currentDirRef.current = saved.currentDir;
        setCurrentDir(saved.currentDir);
        refreshFiles(saved.currentDir);
      }
      if (saved.activeModule) setActiveModule(saved.activeModule);
      else if (saved.mapMode) setActiveModule("map");
      else if (saved.kbMode) setActiveModule("knowledge");
      else if (saved.tplMode) setActiveModule("templates");
      setSidebarOpen(saved.sidebarOpen !== false);
      setUiRestored(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspace]);

  // 恢复最后会话（sessions 就绪后执行一次）
  useEffect(() => {
    sessionsRef.current = sessions;
    if (!uiRestored || restoredSessionRef.current) return;
    restoredSessionRef.current = true;
    const saved = loadUIState();
    if (!saved?.lastSessionId) return;
    const sess = sessions.find((x) => x.id === saved.lastSessionId);
    if (sess) handleSelectSession(sess);
  }, [sessions, uiRestored, handleSelectSession]);

  // 保存：界面状态变化时写入 localStorage
  useEffect(() => {
    if (!uiRestored) return;
    if (currentSessionId) lastSessionIdRef.current = currentSessionId;
    saveUIState({
      tabs: tabs.map((t) => ({ name: t.name, kind: t.kind || "" })),
      activeTab,
      activeModule,
      workspace: currentWorkspace,
      currentDir,
      sidebarOpen,
      lastSessionId: currentSessionId ?? lastSessionIdRef.current,
    });
  }, [tabs, activeTab, activeModule, currentWorkspace, currentDir, sidebarOpen, currentSessionId, uiRestored]);

  const sharedChatPanel = (
      <ChatPanel
      ref={chatInputRef}
      clientId={clientId}
      threadId={threadId}
      workspace={currentWorkspace}
      project={currentProject}
      frozen={Boolean(currentSession?.frozen)}
      onFileChanged={(changed) => {
        handleFileChanged(changed);
        mapBridgeRef.current?.onFileChanged?.(changed);
      }}
      onMapAction={(action) => mapBridgeRef.current?.onMapAction?.(action)}
       currentDoc={activeModule === "map" ? `地图项目:${currentMapProject}` : current?.name}
       mapContext={activeModule === "map" ? currentMapContext : null}
       mapProject={activeModule === "map" ? currentMapProject : null}
      models={models}
      defaultModel={defaultModel}
      selectedModel={selectedModel}
      onModelChange={setSelectedModel}
      onAgentEnd={() => {
        handleAgentEnd();
        mapBridgeRef.current?.onAgentEnd?.();
      }}
      onModeChange={setConversationMode}
      onPhaseChange={setConversationPhase}
      historyMessages={historyMessages}
      historyThreadId={historyThreadId}
      onNewSession={handleNewSession}
      onOpenFile={(name) => {
         if (activeModule === "map") mapBridgeRef.current?.onOpenFile?.(name);
        else open(name);
      }}
      referenceFiles={files.map((file) => currentDir ? currentDir + "/" + file.name : file.name)}
      sessions={visibleSessions}
      onSelectSession={handleSelectSession}
      onSessionChange={handleSessionChange}
      onRefreshSessions={refreshSessions}
      onDeleteSession={handleDeleteSession}
      onBatchDeleteSession={handleBatchDeleteSessions}
      unreadByThread={unreadByThread}
      onForkSession={handleForkSession}
      onPinSession={handlePinSession}
      onFreezeSession={handleFreezeSession}
    />
  );

  return (
    <AppErrorBoundary>
      <div className={`app ${previewLayout === 1 ? "preview-half" : previewLayout === 2 ? "preview-maximized" : ""} ${browserFullscreen ? "browser-fullscreen" : ""} ${sidebarOpen ? "sidebar-expanded" : "sidebar-collapsed"}`}>
        {activeModule === "knowledge" && (
          <DeferredModule label="知识库">
          <KnowledgeBase
            clientId={clientId}
            workspace={currentWorkspace}
            project={currentProject}
            models={models}
            defaultModel={defaultModel}
            onPromoteToAgent={handlePromoteToAgent}
            onExit={(marks) => {
              closeExternalModules();
              if (marks?.length) {
                setTimeout(() => {
                  for (const m of marks) chatInputRef.current?.insertText(m + " ");
                }, 120);
              }
            }}
            onAtMention={insertChatText}
          />
          </DeferredModule>
        )}
        {activeModule === "templates" && (
          <DeferredModule label="模板库">
          <TemplateLibrary
            onExit={(marks) => {
              // 返回时统一把累积的 @标记 插入对话（支持一次多个）
              closeExternalModules();
              if (marks?.length) {
                setTimeout(() => {
                  for (const m of marks) insertChatText(m);
                }, 120);
              }
            }}
            onOpenFile={open}
            onAtMention={insertChatText}
          />
          </DeferredModule>
        )}
        {activeModule === "map" && (
          <DeferredModule label="地图">
          <MapPanel
            onExit={closeExternalModules}
            onOpenFile={open}
            clientId={clientId}
            threadId={threadId}
            workspace={currentWorkspace}
            models={models}
            defaultModel={defaultModel}
            onAgentEnd={handleAgentEnd}
            onNewSession={handleNewSession}
            historyMessages={historyMessages}
            sessions={visibleSessions}
            currentSessionId={currentSessionId}
            onSelectSession={handleSelectSession}
            onSessionChange={handleSessionChange}
            onRefreshSessions={refreshSessions}
            onFocusRun={(run) => chatInputRef.current?.focusRun?.(run?.id)}
            onProjectChange={(name) => setMapContexts((prev) => ({ ...prev, [threadId]: { ...(prev[threadId] || {}), mapProject: name } }))}
            hideChat
            chatVisible={mapChatVisible}
            onToggleChat={() => setMapChatVisible((value) => !value)}
            bridgeRef={mapBridgeRef}
            onViewportChange={(context) => setMapContexts((prev) => ({ ...prev, [threadId]: context }))}
          />
          </DeferredModule>
        )}
        {activeModule === "map" && mapChatVisible && (
          <div className="app-chat-slot map">
            {sharedChatPanel}
          </div>
        )}
        {activeModule === "map" && mapChatVisible && (
          <Resizer
            className="map-chat-resizer"
            side="right"
            min={300}
            max={620}
            cssVar="--map-chat-w"
          />
        )}
        {!["knowledge", "templates", "map"].includes(activeModule) && (
        <>
        {sidebarOpen && (
          <>
            <SessionSidebar
              files={files}
              currentName={current?.name}
              onOpenFile={open}
              onRefreshFiles={refreshFiles}
              onUploaded={refreshFiles}
              projects={projects}
              currentProjectId={currentProject?.id || ""}
              onProjectChange={handleProjectChange}
              workspaces={workspaces}
              currentWorkspace={currentWorkspace}
              onWorkspaceChange={handleWorkspaceChange}
              onWorkspaceRemove={handleWorkspaceRemove}
              currentDir={currentDir}
              onDirChange={handleDirChange}
              onAtMention={handleAtMention}
              onNewSession={handleNewSession}
              onProjectUpdated={refreshProjects}
              models={models}
              clientId={clientId}
              threadId={threadId}
              activeModel={selectedModel}
              onModelChange={setSelectedModel}
              sessions={sessions}
              unreadByThread={unreadByThread}
              onSelectSession={handleSelectSession}
              onRefreshSessions={refreshSessions}
              onDeleteSession={handleDeleteSession}
              onBatchDeleteSession={handleBatchDeleteSessions}
              onRenameSession={handleRenameSession}
              onForkSession={handleForkSession}
              onPinSession={handlePinSession}
              onFreezeSession={handleFreezeSession}
              onOpenSkills={() => openExternalModule("skills")}
              onOpenAgents={() => openExternalModule("agents")}
              onOpenKnowledgeBase={() => openExternalModule("knowledge")}
              onOpenTemplates={() => openExternalModule("templates")}
              onOpenMap={() => openExternalModule("map")}
               onOpenTasks={() => openExternalModule("tasks")}
               onOpenSettings={(tab = "settings") => { if (tab === "memory") setSettingsModuleTab("memory"); else { setSettingsModuleTab("settings"); setSettingsSection(tab === "project" ? "project" : "model"); } openExternalModule("settings"); }}
               onOpenArtifacts={() => openExternalModule("artifacts")}
              onBeforeOpenModal={closeExternalModules}
              onOpenCommandPalette={() => setPaletteOpen(true)}
              onToggleTheme={toggleTheme}
              theme={theme}
            />
            <Resizer side="left" min={180} max={400} cssVar="--sidebar-w" />
          </>
        )}
        <div className="center-area">
          {!sidebarOpen && (
            <button className="sidebar-toggle" onClick={() => setSidebarOpen(true)} title="展开侧栏">
              {"\u25B6"}
            </button>
          )}
          <div className="center-content">
            <div className="topbar">
              {sidebarOpen && (
                <button className="btn-sm" onClick={() => setSidebarOpen(false)} title="收起侧栏">{"\u25C0"}</button>
              )}
            <span className="topbar-title">
              <Icon name="comment" size={16} />
              <span>{currentSession?.title || currentSession?.label || currentProject?.name || "新建 Agent 会话"}</span>
              {current?.name && <span className="topbar-file"> · {current.name}</span>}
            </span>
            <div className="conversation-mode-switch" role="group" aria-label="对话工作模式">
              <button
                type="button"
                className={`conversation-mode-option ${conversationMode === "chat" ? "active" : ""}`}
                aria-pressed={conversationMode === "chat"}
                title="Chat：只读问答和资料检索"
                onClick={() => {
                  const switched = chatInputRef.current?.setMode?.("chat");
                  if (switched !== false) setConversationMode("chat");
                }}
              >
                <Icon name="comment" size={15} />
                <span>Chat</span>
              </button>
              <button
                type="button"
                className={`conversation-mode-option work ${conversationMode === "agent" ? "active" : ""}`}
                aria-pressed={conversationMode === "agent"}
                title="Work：允许 Agent 调用编辑工具；实际读写与联网仍受运行环境权限限制"
                onClick={() => {
                  const switched = chatInputRef.current?.setMode?.("agent");
                  if (switched !== false) setConversationMode("agent");
                }}
              >
                <Icon name="tool" size={15} />
                <span>Work</span>
              </button>
            </div>
            <span className={`conversation-status ${conversationPhase ? "working" : ""}`}><i /> {conversationPhase || "待命"}</span>
            <button className="btn-sm topbar-new-chat" onClick={handleNewSession} title="新建对话"><Icon name="plus" size={13} /></button>
            <button className="btn-sm topbar-preview-toggle" onClick={() => { if (previewOpen) setPreviewLayout(0); setPreviewOpen((v) => !v); }} title={previewOpen ? "隐藏右侧预览" : "显示右侧预览"}><Icon name="layers" size={13} /></button>
            <button className={`btn-sm topbar-browser-toggle ${browserPanelOpen ? "active" : ""}`} onClick={() => setBrowserPanelOpen((v) => !v)} title={browserPanelOpen ? "隐藏内置浏览器" : "显示内置浏览器"} aria-label="内置浏览器"><Icon name="globe" size={13} /></button>
              <TaskCenter
                sessions={visibleSessions}
                projects={projects}
                currentProjectId={currentProject?.id || ""}
                currentWorkspace={currentWorkspace}
                currentThreadId={threadId}
                currentSessionId={currentSessionId}
                unreadCount={Object.values(unreadByThread).reduce((sum, count) => sum + Number(count || 0), 0)}
                onSelectSession={handleSelectSession}
                onFocusRun={(run) => chatInputRef.current?.focusRun?.(run?.id)}
                onOpenRun={handleOpenRun}
                eventVersion={eventVersion}
              />
            </div>
            <div className="center-chat-slot">{!activeModule && sharedChatPanel}</div>
          </div>
        </div>
        {previewOpen && <Resizer side="right" min={280} max={680} cssVar="--preview-w" />}
        {previewOpen && (
          <aside className="app-preview-slot">
            <div className="preview-panel-head">
              <span><Icon name="file" size={15} /> 当前工作产物</span>
              <span className="preview-panel-actions">
                <button
                  className="btn-icon preview-layout-button"
                  onClick={() => setPreviewLayout((value) => (value + 1) % 3)}
                  title={`工作产物布局：${previewLayout === 0 ? "默认" : previewLayout === 1 ? "50%" : "100%"}，点击切换`}
                  aria-label={`工作产物布局：${previewLayout === 0 ? "默认" : previewLayout === 1 ? "50%" : "100%"}，点击切换`}
                >
                  <Icon name={previewLayout === 2 ? "minimize" : "maximize"} size={14} />
                  <span className="preview-layout-label">{previewLayout === 0 ? "默认" : `${previewLayout * 50}%`}</span>
                </button>
                <button className="btn-icon" onClick={() => { setPreviewLayout(0); setPreviewOpen(false); }} title="隐藏右侧预览" aria-label="隐藏右侧预览"><Icon name="close" size={14} /></button>
              </span>
            </div>
            <div className="preview-panel-tabs">
              {[['document', '文档预览'], ['artifacts', '产物']].map(([id, label]) => (
                <button key={id} className={previewTab === id ? "active" : ""} onClick={() => setPreviewTab(id)}>{label}</button>
              ))}
            </div>
            <WorkProductPanel
              tab={previewTab}
              clientId={clientId}
              threadId={threadId}
              workspace={currentWorkspace}
              projectId={currentProject?.id || ""}
              currentSessionId={currentSessionId}
              refreshToken={artifactVersion}
              onOpenFile={open}
            >
              <Suspense fallback={<div className="module-loading">正在加载文档预览…</div>}>
                <DocViewer
                  tabs={tabs}
                  activeTab={activeTab}
                  onSwitchTab={(n) => setActiveTab(n)}
                  onCloseTab={closeTab}
                  onOpenFile={open}
                  loading={docLoading}
                  onSendToAgent={insertChatText}
                  onInsertContext={(t) => chatInputRef.current?.insertContext(t)}
                />
              </Suspense>
            </WorkProductPanel>
          </aside>
        )}
        {browserPanelOpen && <Resizer side="right" min={340} max={960} cssVar="--browser-w" />}
        {browserPanelOpen && (
          <aside className="app-browser-slot">
            <div className="preview-panel-head browser-slot-head">
              <span><Icon name="globe" size={15} /> 内置浏览器</span>
              <span className="preview-panel-actions">
                <button
                  className="btn-icon"
                  onClick={() => setBrowserFullscreen((value) => !value)}
                  title={browserFullscreen ? "退出浏览器全屏" : "浏览器铺满工作区"}
                  aria-label={browserFullscreen ? "退出浏览器全屏" : "浏览器铺满工作区"}
                >
                  <Icon name={browserFullscreen ? "minimize" : "maximize"} size={14} />
                </button>
                <button className="btn-icon" onClick={() => setBrowserPanelOpen(false)} title="隐藏内置浏览器" aria-label="隐藏内置浏览器"><Icon name="close" size={14} /></button>
              </span>
            </div>
            <BrowserPanel clientId={clientId} threadId={threadId} fullscreen={browserFullscreen} onToggleFullscreen={() => setBrowserFullscreen((value) => !value)} />
          </aside>
        )}
        <DeferredModule label="技能管理">
        <SkillsManager
          open={activeModule === "skills"}
          fullPage
          onClose={closeExternalModules}
          clientId={clientId}
          workspace={currentWorkspace}
          project={currentProject}
          models={models}
          defaultModel={defaultModel}
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
          onPromoteToAgent={handlePromoteToAgent}
          onAtMention={(value) => insertChatText(String(value || "").startsWith("@") ? value : `@${value}`)}
        />
        </DeferredModule>
        <DeferredModule label="智能体广场">
        <AgentMarket
          open={activeModule === "agents"}
          fullPage
          onClose={closeExternalModules}
          onAtMention={insertChatText}
          onPromoteToAgent={handlePromoteToAgent}
        />
        </DeferredModule>
        </>
        )}
         {!["knowledge", "templates", "map"].includes(activeModule) && !previewOpen && (
          <button className="preview-reopen" onClick={() => setPreviewOpen(true)} title="显示右侧预览"><Icon name="file" size={13} /> 预览</button>
        )}
         <DeferredModule label="命令面板">
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onOpenFile={open}
          onKb={() => openExternalModule("knowledge")}
          onTpl={() => openExternalModule("templates")}
          onMap={() => openExternalModule("map")}
          onSession={handleSelectSession}
        />
         </DeferredModule>
         {activeModule === "settings" && (
           <div className="module-view">
             <div className="module-head">
               <button className="module-back" onClick={closeExternalModules} title="返回对话"><Icon name="back" size={15} /></button>
               <div className="module-brand-heading"><Logo size={22} /><span><h2>设置</h2><p>外观、模型、项目运行和工作区记忆</p></span></div>
               <div className="module-head-tabs">
                 <button className={settingsModuleTab === "settings" ? "active" : ""} onClick={() => setSettingsModuleTab("settings")}>设置</button>
                 <button className={settingsModuleTab === "memory" ? "active" : ""} onClick={() => setSettingsModuleTab("memory")}>记忆与沉淀</button>
               </div>
             </div>
             <div className="module-body module-settings-body">
               {settingsModuleTab === "memory"
                 ? <MemoryTab workspace={currentWorkspace} projectId={currentProject?.id || ""} />
                 : <SettingsPanel project={currentProject} projects={projects} currentWorkspace={currentWorkspace} models={models} defaultModel={defaultModel} activeModel={selectedModel} clientId={clientId} threadId={threadId} initialSection={settingsSection} onModelChange={setSelectedModel} onModelsRefresh={refreshModelCatalog} onProjectUpdated={refreshProjects} onProjectSelect={(id) => { closeExternalModules(); handleProjectChange(id); }} />}
             </div>
           </div>
         )}
         {activeModule === "artifacts" && (
           <div className="module-view">
             <div className="module-head">
               <button className="module-back" onClick={closeExternalModules} title="返回对话"><Icon name="back" size={15} /></button>
               <div className="module-brand-heading"><Logo size={22} /><span><h2>成果</h2><p>查看、验收、固定和回滚工作产物</p></span></div>
             </div>
             <div className="module-body module-artifacts-body">
               <WorkProductPanel tab="artifacts" clientId={clientId} threadId={threadId} workspace={currentWorkspace} projectId={currentProject?.id || ""} currentSessionId={currentSessionId} refreshToken={artifactVersion} onOpenFile={(name) => { closeExternalModules(); open(name); }} />
             </div>
           </div>
         )}
         {activeModule === "tasks" && (
           <DeferredModule label="任务中心"><TaskCenter
             fullPage
             onClose={closeExternalModules}
             sessions={visibleSessions}
             projects={projects}
             currentProjectId={currentProject?.id || ""}
             currentWorkspace={currentWorkspace}
             currentThreadId={threadId}
             currentSessionId={currentSessionId}
             unreadCount={Object.values(unreadByThread).reduce((sum, count) => sum + Number(count || 0), 0)}
             onSelectSession={handleSelectSession}
             onFocusRun={(run) => chatInputRef.current?.focusRun?.(run?.id)}
             onOpenRun={handleOpenRun}
             eventVersion={eventVersion}
           /></DeferredModule>
         )}
       </div>
    </AppErrorBoundary>
  );
}
