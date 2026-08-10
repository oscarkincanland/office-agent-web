import React, { useState, useCallback, useEffect, useRef } from "react";
import SessionSidebar from "./components/SessionSidebar.jsx";
import DocViewer from "./components/DocViewer.jsx";
import ChatPanel from "./components/ChatPanel.jsx";
import Resizer from "./components/Resizer.jsx";
import SkillsManager from "./components/SkillsManager.jsx";
import AgentMarket from "./components/AgentMarket.jsx";
import Icon from "./components/Icon.jsx";
import { useTheme } from "./theme.jsx";
import { listFiles, listModels, listSessions, listWorkspaces, switchWorkspace, getSession, getClientId } from "./api.js";

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
  const [clientId] = useState(getClientId);
  const [models, setModels] = useState([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [workspaces, setWorkspaces] = useState([]);
  const [currentWorkspace, setCurrentWorkspace] = useState("");
  const [currentDir, setCurrentDir] = useState(""); // 相对路径子目录
  const [historyMessages, setHistoryMessages] = useState(null); // 加载的历史会话消息
  const [docLoading, setDocLoading] = useState(false); // 文档加载中
  const chatInputRef = useRef(null); // 引用 ChatPanel 输入框（@ 按钮插入）
  const { theme, toggleTheme } = useTheme();

  // @ 按钮：把文件/文件夹路径插入到对话输入框
  const handleAtMention = useCallback((rel, isDir) => {
    const marker = isDir ? rel + "/" : rel;
    chatInputRef.current?.insertText(`@${marker}`);
  }, []);

  // 新建会话：清空历史消息和当前文档
  const handleNewSession = useCallback(() => {
    setHistoryMessages(null);
    setTabs([]);
    setActiveTab(null);
    setCurrentDir("");
  }, []);

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

  // 切换工作区
  const handleWorkspaceChange = useCallback(async (dir) => {
    try {
      const r = await switchWorkspace(dir);
      setCurrentWorkspace(r.workspace);
      setCurrentDir("");
      setFiles(r.files || []);
      setTabs([]); // 关闭所有文档
      setActiveTab(null);
    } catch (e) { alert("切换失败: " + e.message); }
  }, []);

  // 进入/返回子目录
  const handleDirChange = useCallback((dir) => {
    setCurrentDir(dir || "");
    refreshFiles(dir || "");
  }, [refreshFiles]);

  const open = useCallback(async (name) => {
    setDocLoading(true);
    try {
      // 已在 tab 中则直接激活
      setTabs((prev) => {
        const exists = prev.find((t) => t.name === name);
        if (exists) {
          setActiveTab(name);
          setDocLoading(false);
          return prev;
        }
        return prev;
      });
      const doc = await fetch(`/api/doc/${encodeURIComponent(name)}?client=${encodeURIComponent(clientId)}`).then((r) => r.json());
      setTabs((prev) => {
        const exists = prev.find((t) => t.name === name);
        if (exists) {
          // 更新内容并激活
          setActiveTab(name);
          setDocLoading(false);
          return prev.map((t) => (t.name === name ? { ...t, ...doc } : t));
        }
        setActiveTab(name);
        setDocLoading(false);
        return [...prev, { name, ...doc }];
      });
    } catch (e) { alert("打开失败: " + e.message); }
  }, [clientId]);

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
          return {
            id: e.id,
            role: isAssistant ? "assistant" : "user",
            text,
            images: [],
            blocks,
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
  }, [open]);

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

  return (
    <AppErrorBoundary>
      <div className="app">
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
            <span className="topbar-title">{current?.name || "Office Agent"}</span>
            <button className="btn-sm theme-toggle" onClick={toggleTheme} title={theme === "dark" ? "切换到亮色主题" : "切换到暗色主题"}>
              <Icon name={theme === "dark" ? "sun" : "moon"} size={14} />
            </button>
            <button className="btn-sm skills-btn" onClick={() => setSkillsOpen(true)} title="技能管理"><Icon name="skills" size={14} /> 技能</button>
            <button className="btn-sm agents-btn" onClick={() => setAgentsOpen(true)} title="智能体广场"><Icon name="robot" size={14} /> 智能体</button>
              <span className="topbar-badge">{models.length} 模型</span>
            </div>
            <DocViewer
              tabs={tabs}
              activeTab={activeTab}
              onSwitchTab={(n) => setActiveTab(n)}
              onCloseTab={closeTab}
              onOpenFile={open}
              loading={docLoading}
            />
          </div>
        </div>
        <Resizer side="right" min={300} max={600} cssVar="--chat-w" />
        <ChatPanel
          ref={chatInputRef}
          clientId={clientId}
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
        />
        <SkillsManager
          open={skillsOpen}
          onClose={() => setSkillsOpen(false)}
          onAtMention={(skillName) => chatInputRef.current?.insertText(`@${skillName}`)}
        />
        <AgentMarket
          open={agentsOpen}
          onClose={() => setAgentsOpen(false)}
          onAtMention={(text) => chatInputRef.current?.insertText(text)}
        />
      </div>
    </AppErrorBoundary>
  );
}
