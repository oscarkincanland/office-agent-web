import React, { useState, useCallback, useEffect, useRef } from "react";
import SessionSidebar from "./components/SessionSidebar.jsx";
import DocViewer from "./components/DocViewer.jsx";
import ChatPanel from "./components/ChatPanel.jsx";
import Resizer from "./components/Resizer.jsx";
import SkillsManager from "./components/SkillsManager.jsx";
import AgentMarket from "./components/AgentMarket.jsx";
import KnowledgeBase from "./components/KnowledgeBase.jsx";
import TemplateLibrary from "./components/TemplateLibrary.jsx";
import MapPanel from "./components/MapPanel.jsx";
import CommandPalette from "./components/CommandPalette.jsx";
import Icon from "./components/Icon.jsx";
import Logo from "./components/Logo.jsx";
import { useTheme } from "./theme.jsx";
import { loadUIState, saveUIState } from "./persist-ui.js";
import { listFiles, listModels, listSessions, listWorkspaces, switchWorkspace, getSession, getClientId, createAgentThread, resumeAgentThread } from "./api.js";

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
  return refs;
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

export default function App() {
  const [files, setFiles] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [tabs, setTabs] = useState([]); // [{ name, kind, url?, sheets?, grids?, content? }]
  const [activeTab, setActiveTab] = useState(null); // 当前激活的文件名
  const current = activeTab ? tabs.find((t) => t.name === activeTab) || null : null;
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [skillsOpen, setSkillsOpen] = useState(false); // 技能管理弹层
  const [agentsOpen, setAgentsOpen] = useState(false); // 智能体广场弹层
  const [kbMode, setKbMode] = useState(false); // 知识库全屏模式
  const [tplMode, setTplMode] = useState(false); // 模版库全屏模式
  const [mapMode, setMapMode] = useState(false); // 地图全屏模式（三栏：图层树+地图+对话）
  const [paletteOpen, setPaletteOpen] = useState(false); // 命令面板（Ctrl/Cmd+K）
  const [clientId] = useState(getClientId);
  const [threadId, setThreadId] = useState(() => {
    const saved = localStorage.getItem("oaw_thread_id");
    if (saved) return saved;
    const id = `thread-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    localStorage.setItem("oaw_thread_id", id);
    return id;
  });
  const [models, setModels] = useState([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [workspaces, setWorkspaces] = useState([]);
  const [currentWorkspace, setCurrentWorkspace] = useState("");
  const [currentDir, setCurrentDir] = useState(""); // 相对路径子目录
  const [historyMessages, setHistoryMessages] = useState(null); // 加载的历史会话消息
  const [currentSessionId, setCurrentSessionId] = useState(null); // 当前会话 id（用于界面恢复）
  const [docLoading, setDocLoading] = useState(false); // 文档加载中
  const restoredRef = useRef(false); // 界面状态恢复标记（避免重复/过早保存）
  const sessionsRef = useRef([]);
  const chatInputRef = useRef(null); // 引用 ChatPanel 输入框（@ 按钮插入）
  const { theme, toggleTheme } = useTheme();

  // @ 按钮：把文件/文件夹路径插入到对话输入框
  const handleAtMention = useCallback((rel, isDir) => {
    const marker = isDir ? rel + "/" : rel;
    chatInputRef.current?.insertText(`@${marker}`);
  }, []);

  // 新建会话：清空历史消息和当前文档
  const handleNewSession = useCallback(async (workspace = currentWorkspace) => {
    const next = `thread-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    setThreadId(next);
    localStorage.setItem("oaw_thread_id", next);
    setHistoryMessages(null);
    setTabs([]);
    setActiveTab(null);
    setCurrentDir("");
    setCurrentSessionId(null);
    lastSessionIdRef.current = null;
    try {
      const d = await createAgentThread(clientId, next, workspace || undefined);
      if (d.sessionId) setCurrentSessionId(d.sessionId);
      refreshSessions();
    } catch (e) {
      console.warn("创建新会话失败，将在首次对话时自动创建:", e.message);
    }
  }, [clientId, currentWorkspace]);

  const refreshFiles = useCallback(async (dir) => {
    try { setFiles((await listFiles(dir || currentDir)).files); } catch {}
  }, [currentDir]);

  const refreshSessions = useCallback(async () => {
    try { setSessions((await listSessions()).sessions || []); } catch {}
  }, []);

  useEffect(() => {
    refreshFiles();
    refreshSessions();
    (async () => {
      try {
        const d = await listModels();
        setModels(d.models || []);
        setDefaultModel(d.default || "");
      } catch {}
    })();
    (async () => {
      try {
        const w = await listWorkspaces();
        setWorkspaces(w.workspaces || []);
        if (w.workspaces?.[0]) setCurrentWorkspace(w.workspaces[0].path);
      } catch {}
    })();
  }, [refreshFiles, refreshSessions]);

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
    try {
      const r = await switchWorkspace(dir);
      setCurrentWorkspace(r.workspace);
      // 新工作区加入下拉列表（自定义路径切换后也能在下拉中看到）
      setWorkspaces((prev) => {
        if (prev.some((w) => w.path === r.workspace)) return prev;
        const name = String(r.workspace).split(/[\\/]/).filter(Boolean).pop() || r.workspace;
        return [...prev, { path: r.workspace, name }];
      });
      setCurrentDir("");
      setFiles(r.files || []);
      setTabs([]); // 关闭所有文档
      setActiveTab(null);
      await handleNewSession(r.workspace);
    } catch (e) { alert("切换失败: " + e.message); }
  }, [handleNewSession]);

  // 进入/返回子目录
  const handleDirChange = useCallback((dir) => {
    setCurrentDir(dir || "");
    refreshFiles(dir || "");
  }, [refreshFiles]);

  const open = useCallback(async (name) => {
    setDocLoading(true);
    try {
      const doc = await fetch(`/api/doc/${encodeURIComponent(name)}?client=${encodeURIComponent(clientId)}&thread=${encodeURIComponent(threadId)}`).then((r) => r.json());
      // 单次 setTabs：避免 React 批处理导致重复 tab
      setTabs((prev) => {
        const exists = prev.find((t) => t.name === name);
        if (exists) {
          return prev.map((t) => (t.name === name ? { ...t, ...doc } : t));
        }
        return [...prev, { name, ...doc }];
      });
      setActiveTab(name);
      setDocLoading(false);
    } catch (e) { alert("打开失败: " + e.message); setDocLoading(false); }
  }, [clientId, threadId]);

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
    setCurrentSessionId(session.id);
    setThreadId(session.id);
    localStorage.setItem("oaw_thread_id", session.id);
    try { await resumeAgentThread(clientId, session.id, session.id, session.cwd || currentWorkspace); } catch (e) { console.warn("恢复 Agent 会话失败，仍加载历史记录:", e.message); }
    try {
      const d = await getSession(session.id);
      const msgs = (d.entries || [])
        .filter((e) => e.type === "message" && e.message)
        .map((e) => {
          const m = e.message;
          let text = "";
          const blocks = [];
          if (typeof m.content === "string") text = m.content;
          else if (Array.isArray(m.content)) {
            for (const b of m.content) {
              if (b.type === "text") text += (text ? "\n" : "") + b.text;
              else if (b.type === "thinking") blocks.push({ type: "thinking", text: b.thinking || "" });
              else if (b.type === "toolCall") {
                const input = typeof b.input === "string" ? b.input : JSON.stringify(b.input, null, 2);
                blocks.push({
                  type: "tool",
                  id: histId(),
                  name: b.toolName || b.name || "tool",
                  input,
                  output: "",
                  result: "",
                  done: true,
                  isError: false,
                  expanded: false,
                  duration: null,
                });
              }
            }
          }
          const isAssistant = m.role === "assistant";
          // 若 assistant 有纯文本且没有 text block，追加为 text block
          if (isAssistant && text && !blocks.some((b) => b.type === "text")) {
            blocks.push({ type: "text", text });
          }
          const currentDocMatch = text.match(/当前(?:打开|工作)文件:\s*([^\]\n]+)/);
          return {
            id: e.id,
            role: isAssistant ? "assistant" : "user",
            text,
            images: [],
            blocks,
            references: historyReferences(text),
            currentDoc: currentDocMatch?.[1]?.trim() || null,
            status: "done",
          };
        });
      setHistoryMessages(msgs);
      // 从消息里解析会话关联的文件，尝试打开
      const fileMatch = msgs.find((m) => m.role === "user" && m.text && m.text.includes("当前打开文件"));
      if (fileMatch) {
        const fn = fileMatch.text.match(/当前打开文件:\s*([^\]\n]+)/);
        if (fn?.[1]) {
          try { await open(fn[1].trim()); } catch {}
        }
      }
    } catch (e) { alert("加载会话失败: " + e.message); }
  }, [clientId, currentWorkspace, open]);

  const handleFileChanged = useCallback((changed) => {
    refreshFiles();
    if (activeTab && changed.includes(activeTab)) {
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
        if (saved.workspace && saved.workspace !== currentWorkspace) {
          await switchWorkspace(saved.workspace);
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
        setCurrentDir(saved.currentDir);
        refreshFiles(saved.currentDir);
      }
      if (saved.mapMode) setMapMode(true);
      else if (saved.kbMode) setKbMode(true);
      else if (saved.tplMode) setTplMode(true);
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
      kbMode,
      tplMode,
      mapMode,
      workspace: currentWorkspace,
      currentDir,
      sidebarOpen,
      lastSessionId: currentSessionId ?? lastSessionIdRef.current,
    });
  }, [tabs, activeTab, kbMode, tplMode, mapMode, currentWorkspace, currentDir, sidebarOpen, currentSessionId, uiRestored]);

  return (
    <AppErrorBoundary>
      <div className="app">
        {kbMode && (
          <KnowledgeBase
            onExit={(marks) => {
              setKbMode(false);
              if (marks?.length) {
                setTimeout(() => {
                  for (const m of marks) chatInputRef.current?.insertText(m + " ");
                }, 120);
              }
            }}
            onAtMention={(text) => chatInputRef.current?.insertText(text)}
          />
        )}
        {tplMode && (
          <TemplateLibrary
            onExit={(marks) => {
              // 返回时统一把累积的 @标记 插入对话（支持一次多个）
              setTplMode(false);
              if (marks?.length) {
                setTimeout(() => {
                  for (const m of marks) chatInputRef.current?.insertText(m + " ");
                }, 120);
              }
            }}
            onOpenFile={open}
            onAtMention={() => {}}
          />
        )}
        {mapMode && (
          <MapPanel
            onExit={() => setMapMode(false)}
            onOpenFile={open}
            clientId={clientId}
            threadId={threadId}
            models={models}
            defaultModel={defaultModel}
            onAgentEnd={handleAgentEnd}
            onNewSession={handleNewSession}
            sessions={sessions}
            onSelectSession={handleSelectSession}
            onSessionChange={handleSessionChange}
            onRefreshSessions={refreshSessions}
          />
        )}
        {!kbMode && !tplMode && !mapMode && (
        <>
        {sidebarOpen && (
          <>
            <SessionSidebar
              sessions={sessions}
              files={files}
              currentName={current?.name}
              onOpenFile={open}
              onRefreshFiles={refreshFiles}
              onRefreshSessions={refreshSessions}
              onUploaded={refreshFiles}
              workspaces={workspaces}
              currentWorkspace={currentWorkspace}
              onWorkspaceChange={handleWorkspaceChange}
              currentDir={currentDir}
              onDirChange={handleDirChange}
              onSelectSession={handleSelectSession}
              onAtMention={handleAtMention}
              onNewSession={handleNewSession}
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
              <Logo size={18} /> <span className="brand-name">Open Plan</span>
              {current?.name && <span className="topbar-file"> · {current.name}</span>}
            </span>
            <button className="btn-sm theme-toggle" onClick={toggleTheme} title={theme === "dark" ? "切换到亮色主题" : "切换到暗色主题"}>
              <Icon name={theme === "dark" ? "sun" : "moon"} size={14} />
            </button>
            <button className="btn-sm skills-btn" onClick={() => setSkillsOpen(true)} title="技能管理"><Icon name="skills" size={14} /> 技能</button>
            <button className="btn-sm agents-btn" onClick={() => setAgentsOpen(true)} title="智能体广场"><Icon name="robot" size={14} /> 智能体</button>
            <button className="btn-sm kb-btn" onClick={() => setKbMode(true)} title="知识库（Obsidian 风格）"><Icon name="grid" size={14} /> 知识库</button>
            <button className="btn-sm tpl-btn" onClick={() => setTplMode(true)} title="模版库（交通规划产出模版）"><Icon name="doc" size={14} /> 模版库</button>
            <button className={`btn-sm map-btn ${mapMode ? "active" : ""}`} onClick={() => setMapMode(true)} title="地图（GIS 项目）"><Icon name="map" size={14} /> 地图</button>
              <span className="topbar-badge">{models.length} 模型</span>
            </div>
            <DocViewer
              tabs={tabs}
              activeTab={activeTab}
              onSwitchTab={(n) => setActiveTab(n)}
              onCloseTab={closeTab}
              onOpenFile={open}
              loading={docLoading}
              onSendToAgent={(t) => chatInputRef.current?.insertText(t)}
            />
          </div>
        </div>
        <Resizer side="right" min={300} max={600} cssVar="--chat-w" />
        <ChatPanel
          ref={chatInputRef}
          clientId={clientId}
          threadId={threadId}
          onFileChanged={handleFileChanged}
          currentDoc={current?.name}
          models={models}
          defaultModel={defaultModel}
          onAgentEnd={handleAgentEnd}
          historyMessages={historyMessages}
          onNewSession={handleNewSession}
          onOpenFile={open}
          sessions={sessions}
          onSelectSession={handleSelectSession}
              onSessionChange={handleSessionChange}
              onRefreshSessions={refreshSessions}
        />
        <SkillsManager
          open={skillsOpen}
          onClose={() => setSkillsOpen(false)}
          onAtMention={(value) => chatInputRef.current?.insertText(String(value || "").startsWith("@") ? value : `@${value}`)}
        />
        <AgentMarket
          open={agentsOpen}
          onClose={() => setAgentsOpen(false)}
          onAtMention={(text) => chatInputRef.current?.insertText(text)}
        />
        </>
        )}
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onOpenFile={open}
          onKb={() => setKbMode(true)}
          onTpl={() => setTplMode(true)}
          onMap={() => setMapMode(true)}
          onSession={handleSelectSession}
        />
      </div>
    </AppErrorBoundary>
  );
}
