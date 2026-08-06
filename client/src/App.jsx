import { useState, useCallback, useEffect, useRef } from "react";
import SessionSidebar from "./components/SessionSidebar.jsx";
import DocViewer from "./components/DocViewer.jsx";
import ChatPanel from "./components/ChatPanel.jsx";
import Resizer from "./components/Resizer.jsx";
import SkillsManager from "./components/SkillsManager.jsx";
import { listFiles, listModels, listSessions, listWorkspaces, switchWorkspace, getSession, getClientId } from "./api.js";

export default function App() {
  const [files, setFiles] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [current, setCurrent] = useState(null); // { name, kind, url?, sheets?, grids? }
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [skillsOpen, setSkillsOpen] = useState(false); // 技能管理弹层
  const [clientId] = useState(getClientId);
  const [models, setModels] = useState([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [workspaces, setWorkspaces] = useState([]);
  const [currentWorkspace, setCurrentWorkspace] = useState("");
  const [currentDir, setCurrentDir] = useState(""); // 相对路径子目录
  const [historyMessages, setHistoryMessages] = useState(null); // 加载的历史会话消息
  const [docLoading, setDocLoading] = useState(false); // 文档加载中
  const chatInputRef = useRef(null); // 引用 ChatPanel 输入框（@ 按钮插入）

  // @ 按钮：把文件/文件夹路径插入到对话输入框
  const handleAtMention = useCallback((rel, isDir) => {
    const marker = isDir ? rel + "/" : rel;
    chatInputRef.current?.insertText(`@${marker}`);
  }, []);

  // 新建会话：清空历史消息和当前文档
  const handleNewSession = useCallback(() => {
    setHistoryMessages(null);
    setCurrent(null);
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
      setCurrent(null); // 关闭当前文档
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
      const doc = await fetch(`/api/doc/${encodeURIComponent(name)}?client=${encodeURIComponent(clientId)}`).then((r) => r.json());
      setCurrent({ name, ...doc });
    } catch (e) { alert("打开失败: " + e.message); }
    finally { setDocLoading(false); }
  }, [clientId]);

  // 点击历史会话：加载该会话的消息记录，并尝试打开关联文件
  const handleSelectSession = useCallback(async (session) => {
    try {
      const d = await getSession(session.id);
      const msgs = (d.entries || [])
        .filter((e) => e.type === "message" && e.message)
        .map((e) => {
          const m = e.message;
          let text = "";
          if (typeof m.content === "string") text = m.content;
          else if (Array.isArray(m.content)) text = m.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
          return {
            id: e.id,
            role: m.role === "assistant" ? "assistant" : "user",
            text,
            images: [],
            tools: [],
            thinking: "",
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
    if (current && changed.includes(current.name)) open(current.name);
  }, [current, refreshFiles, open]);

  // 暴露 refreshSessions 给 ChatPanel（agent_end 时刷新）
  const handleAgentEnd = useCallback(() => {
    refreshSessions();
  }, [refreshSessions]);

  return (
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
            <button className="btn-sm skills-btn" onClick={() => setSkillsOpen(true)} title="技能管理">🧩 技能</button>
            <span className="topbar-badge">{models.length} 模型</span>
          </div>
          <DocViewer doc={current} loading={docLoading} />
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
      />
      <SkillsManager
        open={skillsOpen}
        onClose={() => setSkillsOpen(false)}
        onAtMention={(skillName) => chatInputRef.current?.insertText(`@${skillName}`)}
      />
    </div>
  );
}
