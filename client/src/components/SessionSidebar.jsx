import React, { useRef, useState, useEffect, useCallback } from "react";
import { Document, Packer, Paragraph } from "docx";
import { uploadFile, deleteFile, deleteSession, renameSession, fileToBase64, listSessions, listRuns, listPublishedArtifacts, publishArtifact, validateWorkspace, listFileRoots, addFileRoot, removeFileRoot, deleteWorkspace } from "../api.js";
import ContextMenu from "./ContextMenu.jsx";
import Icon from "./Icon.jsx";
import MemoryTab from "./MemoryTab.jsx";
import SettingsPanel from "./SettingsPanel.jsx";

const FILE_TYPE_META = {
  docx: { label: "W", className: "word", title: "Word 文档" },
  xlsx: { label: "X", className: "excel", title: "Excel 工作簿" },
  pptx: { label: "P", className: "powerpoint", title: "PowerPoint 演示文稿" },
  pdf: { label: "PDF", className: "pdf", title: "PDF 文档" },
  md: { label: "M", className: "markdown", title: "Markdown 文档" },
  markdown: { label: "M", className: "markdown", title: "Markdown 文档" },
  csv: { label: "CSV", className: "csv", title: "CSV 数据" },
  json: { label: "{}", className: "json", title: "JSON 数据" },
  html: { label: "<>" , className: "html", title: "HTML 页面" },
  htm: { label: "<>" , className: "html", title: "HTML 页面" },
  txt: { label: "TXT", className: "text", title: "文本文件" },
};

function FileTypeIcon({ file, size = "normal" }) {
  if (file?.isDir) return <span className="file-type-icon dir" title="文件夹"><Icon name="folder" size={12} /></span>;
  const meta = FILE_TYPE_META[String(file?.ext || "").toLowerCase()] || { label: "•", className: "other", title: "其他文件" };
  return <span className={`file-type-icon ${meta.className} ${size}`} title={meta.title}>{meta.label}</span>;
}
const PIN_KEY = "oaw_pinned_sessions";

function getPinnedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(PIN_KEY) || "[]")); } catch { return new Set(); }
}
function togglePin(id) {
  const s = getPinnedSet();
  s.has(id) ? s.delete(id) : s.add(id);
  localStorage.setItem(PIN_KEY, JSON.stringify([...s]));
  return s;
}

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

// 产物面板：接收毫秒时间戳
function formatRelTime(ms) {
  if (!ms) return "";
  return formatTime(new Date(ms).toISOString());
}

function shortenCwd(cwd) {
  if (!cwd) return "";
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return cwd;
  return "\u2026/" + parts.slice(-2).join("/");
}

// 文件大小格式化（文件树展示）
function formatSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

// 日期分组（Proma groupByDate）
function groupByDate(sessions) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86400000;
  const groups = { 今天: [], 昨天: [], 更早: [] };
  for (const s of sessions) {
    const t = new Date(s.modified || 0).getTime();
    if (t >= today) groups["今天"].push(s);
    else if (t >= yesterday) groups["昨天"].push(s);
    else groups["更早"].push(s);
  }
  return Object.entries(groups).filter(([, arr]) => arr.length > 0);
}

// 会话列表：置顶区 + 日期分组（Proma 风格，供左侧栏与对话栏历史抽屉共用）
export function SessionList({ sessions, unreadByThread = {}, onSelect, onDelete, onRename, onFork }) {
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [pinned, setPinned] = useState(getPinnedSet);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const handleRename = async (id) => {
    await onRename(id, editValue);
    setEditingId(null);
  };

  const handleTogglePin = (id) => {
    const next = togglePin(id);
    setPinned(new Set(next));
  };

  const searched = search.trim()
    ? sessions.filter((s) => (s.title || s.label || s.id).toLowerCase().includes(search.toLowerCase()))
    : sessions;
  const filtered = statusFilter === "all"
    ? searched
    : searched.filter((s) => s.runStatus === statusFilter);
  const pinnedList = filtered.filter((s) => pinned.has(s.id));
  const unpinned = filtered.filter((s) => !pinned.has(s.id));
  const groups = groupByDate(unpinned);

  const renderItem = (s) => (
    <div key={s.id} className="session-item" onClick={() => onSelect(s)}>
      <div className="session-indicator" data-status={s.runStatus && s.runStatus !== "idle" ? s.runStatus : "idle"} />
      <div className="session-info">
        {editingId === s.id ? (
          <div className="session-rename" onClick={(e) => e.stopPropagation()}>
            <input
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleRename(s.id); if (e.key === "Escape") setEditingId(null); }}
              autoFocus
              className="rename-input"
            />
            <button className="btn-xs" onClick={() => handleRename(s.id)}>确定</button>
          </div>
        ) : (
          <>
            <span
              className="session-label"
              title={s.title || s.label || "未命名会话"}
              onDoubleClick={(e) => { e.stopPropagation(); setEditingId(s.id); setEditValue(s.label || s.title || ""); }}
            >
              {pinned.has(s.id) && <Icon name="pin" size={10} className="pin-icon" />}
              {s.title || s.label || "未命名会话"}
            </span>
            <span className="session-time">
              {s.mode && <span className={`session-mode mode-${s.mode}`}>{s.mode === "chat" ? "Chat" : s.mode === "office" ? "Office" : "Agent"}</span>}
              {s.runStatus && s.runStatus !== "idle" ? ({ running: "执行中", queued: "排队中", waiting_user: "等待回答", recovering: "恢复中", cancel_requested: "正在中断", completed: "已完成", failed: "失败", aborted: "已中断" }[s.runStatus] || s.runStatus) : formatTime(s.modified)}
              {s.artifactCount > 0 && <span className="session-artifact-count"> · 产物 {s.artifactCount}</span>}
            </span>
          </>
        )}
      </div>
      {(unreadByThread[s.threadId || s.id] || 0) > 0 && <span className="session-unread" title="有新的后台任务状态更新">{unreadByThread[s.threadId || s.id] > 99 ? "99+" : unreadByThread[s.threadId || s.id]}</span>}
      {s.cwd && <div className="session-cwd" title={s.cwd}>{shortenCwd(s.cwd)}</div>}
      <div className="session-actions" onClick={(e) => e.stopPropagation()}>
        <button className="btn-icon" onClick={() => handleTogglePin(s.id)} title={pinned.has(s.id) ? "取消置顶" : "置顶"}>
          <Icon name="pin" size={12} className={pinned.has(s.id) ? "pinned" : ""} />
        </button>
        <button
          className="btn-icon"
          onClick={() => { setEditingId(s.id); setEditValue(s.label || s.title || ""); }}
          title="重命名"
        ><Icon name="penTool" size={12} /></button>
        <button className="btn-icon" onClick={async () => { if (onFork) await onFork(s.id); }} title="从此会话创建分支"><Icon name="copy" size={12} /></button>
        <button
          className="btn-icon danger"
          onClick={async () => { if (confirm("确认删除此会话?")) { await onDelete(s.id); } }}
          title="删除"
        ><Icon name="trash" size={12} /></button>
      </div>
    </div>
  );

  return (
    <div className="session-list">
      <div className="session-search">
        <Icon name="search" size={11} />
        <input placeholder="搜索会话…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="session-filters" role="tablist" aria-label="会话状态筛选">
        {[{ id: "all", label: "全部" }, { id: "running", label: "执行中" }, { id: "completed", label: "已完成" }, { id: "failed", label: "失败" }].map((item) => (
          <button key={item.id} className={`session-filter ${statusFilter === item.id ? "active" : ""}`} onClick={() => setStatusFilter(item.id)}>{item.label}</button>
        ))}
      </div>
      {sessions.length === 0 && <div className="empty">暂无会话记录</div>}
      {/* 置顶区 */}
      {pinnedList.length > 0 && (
        <div className="session-group">
          <div className="session-group-title"><Icon name="pin" size={10} /> 置顶</div>
          {pinnedList.map((s) => renderItem(s))}
        </div>
      )}
      {/* 日期分组区 */}
      {groups.map(([label, items]) => (
        <div className="session-group" key={label}>
          <div className="session-group-title">{label}</div>
          {items.map((s) => renderItem(s))}
        </div>
      ))}
      {filtered.length === 0 && sessions.length > 0 && <div className="empty">无匹配结果</div>}
    </div>
  );
}

export default function SessionSidebar({ sessions, files, currentName, onOpenFile, onRefreshFiles, onRefreshSessions, onUploaded, projects = [], currentProjectId = "", onProjectChange, workspaces = [], currentWorkspace = "", onWorkspaceChange, onWorkspaceRemove, currentDir = "", onDirChange, onSelectSession, onAtMention, onNewSession, onForkSession }) {
  const fileRef = useRef(null);
  const [bottomTab, setBottomTab] = useState("artifacts"); // 底部 tab：产物/记忆/设置
  const [modal, setModal] = useState(null);   // 弹窗：artifacts | settings
  const [modalTab, setModalTab] = useState("settings"); // 设置弹窗子 tab：settings | memory
  const [fileQ, setFileQ] = useState("");    // 文件搜索关键词
  const [customMode, setCustomMode] = useState(false);
  const [customPath, setCustomPath] = useState("");
  const [applying, setApplying] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [newFiles, setNewFiles] = useState(new Set()); // 跟踪新创建的文件
  const [rootOpen, setRootOpen] = useState(false);
  const [rootPath, setRootPath] = useState("");
  const [fileRoots, setFileRoots] = useState([]);
  const [artifactRuns, setArtifactRuns] = useState([]);
  const [publishedArtifacts, setPublishedArtifacts] = useState([]);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const projectTypes = [...new Set(projects.map((project) => project.type || "综合项目"))];
  const currentProject = projects.find((project) => project.id === currentProjectId) || null;

  const refreshArtifacts = useCallback(async () => {
    setArtifactLoading(true);
    try {
      const [runData, publishedData] = await Promise.all([
        listRuns("", 100, { cwd: currentWorkspace }),
        listPublishedArtifacts(currentWorkspace, currentProjectId),
      ]);
      setArtifactRuns((runData.runs || []).filter((run) => run?.artifacts?.length));
      setPublishedArtifacts(publishedData.artifacts || []);
    } catch {}
    setArtifactLoading(false);
  }, [currentWorkspace, currentProjectId]);

  useEffect(() => {
    if (modal === "artifacts") refreshArtifacts();
  }, [modal, refreshArtifacts]);

  const artifactEntries = artifactRuns.flatMap((run) => (run.artifacts || [])
    .filter((artifact) => artifact.status !== "deleted")
    .map((artifact) => ({ ...artifact, run })));
  const publishedByArtifact = new Map(publishedArtifacts.map((item) => [item.artifactId, item]));

  const refreshFileRoots = useCallback(async () => {
    try { setFileRoots((await listFileRoots()).roots || []); } catch {}
  }, []);
  useEffect(() => { refreshFileRoots(); }, [refreshFileRoots]);

  const registerRoot = async () => {
    const value = rootPath.trim();
    if (!value) return;
    try {
      await addFileRoot(value);
      setRootPath("");
      refreshFileRoots();
    } catch (e) { alert("登记失败: " + e.message); }
  };

  const applyCustom = async () => {
    const dir = customPath.trim();
    if (!dir) return alert("请输入文件夹路径");
    setApplying(true);
    try {
      const v = await validateWorkspace(dir);
      if (!v.ok) { alert("无法打开: " + (v.error || "无效目录")); return; }
      await onWorkspaceChange(dir);
      setCustomMode(false);
    } catch (e) { alert("验证失败: " + e.message); }
    finally { setApplying(false); }
  };

  const handleUpload = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const { data } = await fileToBase64(f);
      await uploadFile(f.name, data);
      onUploaded();
    } catch (err) { alert("上传失败: " + err.message); }
    e.target.value = "";
  };

  // 新建空白 Word 文档（docx 库生成 → 上传工作区 → 刷新列表）
  const [creatingWord, setCreatingWord] = useState(false);
  const handleNewWord = async () => {
    if (creatingWord) return;
    setCreatingWord(true);
    try {
      // 含一个空段落，保证各版本 Word/WPS 正常打开
      const doc = new Document({ sections: [{ children: [new Paragraph("")] }] });
      const blob = await Packer.toBlob(doc);
      // blob → base64（绕开 FileReader，分块避免栈溢出）
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      const data = btoa(bin);
      // 文件名查重：新建文档.docx / 新建文档 2.docx …
      const names = new Set(files.map((f) => f.name));
      let name = "新建文档.docx";
      let i = 2;
      while (names.has(name)) name = `新建文档 ${i++}.docx`;
      await uploadFile(name, data);
      onUploaded();
    } catch (err) { alert("新建失败: " + err.message); }
    setCreatingWord(false);
  };

  const handleDeleteFile = async (name) => {
    if (!confirm(`删除 ${name} ?`)) return;
    try { await deleteFile(name); onRefreshFiles(); } catch (err) { alert("删除失败: " + err.message); }
  };

  // 在文件管理器中打开
  const handleOpenInExplorer = (filePath) => {
    fetch("/api/open-in-explorer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath })
    }).catch(() => {
      navigator.clipboard.writeText(filePath).then(() => {
        alert("路径已复制到剪贴板: " + filePath);
      });
    });
  };

  // 存入知识库：docx → 服务端转 md 并注册为 kb 根
  const handleIngestToKB = async (name) => {
    if (!confirm(`将「${name}」存入知识库（自动转换为 Markdown 并注册为知识库根）？`)) return;
    try {
      const r = await fetch("/api/kb/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
      alert(`已存入知识库：${data.mdName || name}`);
    } catch (err) {
      alert("存入失败: " + err.message);
    }
  };

  // 右键菜单处理
  const handleContextMenu = (e, file) => {
    e.preventDefault();
    e.stopPropagation();
    const filePath = currentDir ? `${currentDir}/${file.name}` : file.name;
    const menuItems = [
      {
        icon: "folderOpen",
        label: "在文件管理器中打开",
        onClick: () => handleOpenInExplorer(filePath)
      },
      {
        icon: "copy",
        label: "复制文件名",
        onClick: () => navigator.clipboard.writeText(file.name)
      },
      { separator: true },
      {
        icon: "at",
        label: "@ 到对话中",
        onClick: () => onAtMention && onAtMention(filePath, file.isDir)
      }
    ];
    if (!file.isDir) {
      menuItems.push({ separator: true });
      if (file.ext === "docx") {
        menuItems.push({
          icon: "book",
          label: "存入知识库",
          onClick: () => handleIngestToKB(file.name)
        });
      }
      menuItems.push(
        {
          icon: "trash",
          label: "删除",
          danger: true,
          onClick: () => handleDeleteFile(filePath)
        }
      );
    }
    setContextMenu({ x: e.clientX, y: e.clientY, items: menuItems });
  };

  return (
    <div className="sidebar">
      {/* 顶部：项目 / 工作区选择器 + 新建会话 */}
      <div className="workspace-selector">
        {projects.length > 0 && (
          <>
            <span className="ws-label">项目</span>
            <select
              className="project-select"
              value={currentProjectId}
              onChange={(e) => onProjectChange?.(e.target.value)}
              title="切换项目（按项目类型分类）"
            >
              {projectTypes.map((type) => (
                <optgroup key={type} label={type}>
                  {projects.filter((project) => (project.type || "综合项目") === type).map((project) => (
                    <option key={project.id} value={project.id}>{project.name} · {project.status}{project.pendingMemoryCount ? ` · 待沉淀 ${project.pendingMemoryCount}` : ""}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </>
        )}
        <span className="ws-label">工作区</span>
        <select
          value={customMode ? "__custom__" : currentWorkspace}
          onChange={(e) => {
            if (e.target.value === "__custom__") {
              setCustomMode(true);
            } else {
              setCustomMode(false);
              onWorkspaceChange && onWorkspaceChange(e.target.value);
            }
          }}
          title="切换工作区目录"
        >
          {workspaces.length === 0 && <option value="">默认工作区</option>}
          {workspaces.map((w) => (
            <option key={w.path} value={w.path}>{w.name}</option>
          ))}
          <option value="__custom__">📂 自定义路径...</option>
        </select>
         <button className="btn-sm sidebar-new-session" onClick={() => onNewSession && onNewSession()} title="新建会话">
           <Icon name="plus" size={13} />
         </button>
         {!customMode && currentWorkspace && currentWorkspace !== workspaces[0]?.path && (
           <button
             className="btn-sm sidebar-del-ws"
             title="从列表移除该工作区"
             onClick={async () => {
               if (window.confirm("从列表中移除该工作区路径？（不删除文件）")) {
                 try { await deleteWorkspace(currentWorkspace); onWorkspaceRemove && onWorkspaceRemove(currentWorkspace); } catch (e) { alert("移除失败: " + e.message); }
               }
             }}
           >×</button>
         )}
        <button className={`btn-sm sidebar-root-btn ${rootOpen ? "active" : ""}`} onClick={() => setRootOpen((v) => !v)} title="登记工作区外的本地目录">外部目录</button>
      </div>
      {rootOpen && (
        <div className="workspace-custom external-roots">
          <div className="external-root-form">
            <input type="text" placeholder="本地目录绝对路径" value={rootPath} onChange={(e) => setRootPath(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") registerRoot(); }} />
            <button className="btn-xs" onClick={registerRoot}>登记</button>
          </div>
          {fileRoots.map((root) => (
            <div className="external-root-item" key={root.id} title={root.path}>
              <span>{root.label || root.path}</span>
              <button className="btn-icon danger" onClick={async () => { await removeFileRoot(root.id); refreshFileRoots(); }} title="移除目录">×</button>
            </div>
          ))}
          {!fileRoots.length && <div className="external-root-empty">尚未登记外部目录</div>}
        </div>
      )}
      {customMode && (
        <div className="workspace-custom">
          <input
            type="text"
            placeholder="输入文件夹路径，如 F:\work\docs"
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") applyCustom(); }}
          />
          <button className="btn-xs" onClick={applyCustom} disabled={applying}>
            {applying ? "验证中..." : "打开"}
          </button>
        </div>
      )}
      {currentProject && (
        <div className="project-context-strip" title={`当前项目：${currentProject.name}`}>
          <span className="project-context-name">{currentProject.name}</span>
          <span className="project-context-type">{currentProject.type || "综合项目"}</span>
          {currentProject.status && <span className="project-context-status">{currentProject.status}</span>}
          {currentProject.pendingMemoryCount > 0 && <span className="project-context-status">待沉淀 {currentProject.pendingMemoryCount}</span>}
          {currentProject.approvedMemoryCount > 0 && <span className="project-context-status">已沉淀 {currentProject.approvedMemoryCount}</span>}
          {currentProject.unresolvedRunCount > 0 && <span className="project-context-status">未完成 {currentProject.unresolvedRunCount}</span>}
          <button
            className="project-memory-btn"
            onClick={() => { setModal("settings"); setModalTab("memory"); }}
            title="打开当前工作区的记忆与沉淀"
          ><Icon name="book" size={11} /> 记忆</button>
        </div>
      )}

      {/* 文件树 */}
      <div className="sidebar-section-head">
        <Icon name="folder" size={12} />
        <span className="section-name">文件</span>
        <span className="section-count">{files.length}</span>
        <button className="btn-xs section-refresh" onClick={onRefreshFiles} title="刷新文件">
          <Icon name="refresh" size={11} />
        </button>
        <button className="btn-xs section-new" onClick={handleNewWord} disabled={creatingWord} title="新建空白 Word 文档">
          <Icon name="plus" size={11} />
        </button>
        <button className="btn-xs section-upload" onClick={() => fileRef.current?.click()} title="上传文件">
          <Icon name="upload" size={11} />
        </button>
        <input ref={fileRef} type="file" accept=".docx,.xlsx,.pptx,.pdf,.csv,.json,.md,.markdown,.txt,.html,.htm" hidden onChange={handleUpload} />
      </div>
      <div className="sidebar-section files-section">
        {files.length === 0 && <div className="empty">暂无文件，点击上传</div>}
        {currentDir && (
          <div className="crumb-bar">
            <button className="btn-xs" onClick={() => onDirChange && onDirChange(currentDir.split("/").slice(0, -1).join("/"))} title="返回上一级目录">← 上一级</button>
            <button className="btn-xs" onClick={() => onDirChange && onDirChange("")} title="返回工作区根目录">根目录</button>
            <span className="crumb-path">/{currentDir.split("/").pop()}</span>
          </div>
        )}
        <div className="file-search">
          <Icon name="search" size={11} />
          <input
            placeholder="搜索文件…"
            value={fileQ}
            onChange={(e) => setFileQ(e.target.value)}
          />
          {fileQ && <button className="file-search-clear" onClick={() => setFileQ("")} title="清除">×</button>}
        </div>
        <div className="file-list">
          {files
            .filter((f) => !fileQ.trim() || f.name.toLowerCase().includes(fileQ.trim().toLowerCase()))
            .map((f) => {
            const filePath = currentDir ? `${currentDir}/${f.name}` : f.name;
            const isNew = newFiles.has(filePath);
            return (
              <div
                key={f.name}
                className={`file-item ${!f.isDir && f.name === currentName ? "active" : ""} ${isNew ? "new-file" : ""}`}
                onClick={() => {
                  if (f.isDir) {
                    const next = currentDir ? `${currentDir}/${f.name}` : f.name;
                    onDirChange && onDirChange(next);
                  } else {
                    onOpenFile(filePath);
                  }
                }}
                onContextMenu={(e) => handleContextMenu(e, f)}
                title={f.name}
              >
                <FileTypeIcon file={f} />
                <span className="file-name" title={f.name}>{f.isDir ? f.name : f.name}</span>
                <span className="file-meta">
                  {f.isDir ? "▶" : formatSize(f.size)}
                  {!f.isDir && <span className="file-mtime">{formatTime(new Date(f.mtime).toISOString())}</span>}
                </span>
                <span
                  className="file-at"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAtMention && onAtMention(filePath, f.isDir);
                  }}
                  title="@ 到对话中作为参考"
                >@</span>
                {!f.isDir && (
                  <span className="file-del" onClick={(e) => { e.stopPropagation(); handleDeleteFile(filePath); }}>x</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 底部：产物 / 设置（弹窗） */}
      <div className="sidebar-bottom-tabs">
        <button className={`bt-btn ${modal === "artifacts" ? "active" : ""}`} onClick={() => setModal(modal === "artifacts" ? null : "artifacts")} title="产物（agent 生成的文件）">
          <Icon name="file" size={13} /> 产物
        </button>
        <button className={`bt-btn ${modal === "settings" ? "active" : ""}`} onClick={() => setModal(modal === "settings" ? null : "settings")} title="设置（含记忆）">
          <Icon name="gear" size={13} /> 设置
        </button>
      </div>

      {/* 产物弹窗 */}
      {modal === "artifacts" && (
        <div className="sb-modal-backdrop" onClick={() => setModal(null)}>
          <div className="sb-modal" onClick={(e) => e.stopPropagation()}>
            <div className="sb-modal-head">
              <Icon name="file" size={13} />
              <span className="sb-modal-title">成果（{artifactEntries.length}）</span>
              <span className="sb-modal-sub">按 Run manifest 展示，可固定为项目正式成果</span>
              <button className="mp-op" onClick={() => setModal(null)} title="关闭"><Icon name="close" size={14} /></button>
            </div>
            <div className="sb-modal-body">
              {artifactLoading && <div className="empty">正在读取成果清单…</div>}
              {!artifactLoading && artifactEntries.length === 0 && <div className="empty">暂无已登记成果；完成任务并通过校验后会显示在这里</div>}
              <div className="file-list">
                {[...artifactEntries]
                  .sort((a, b) => String(b.run?.finishedAt || b.run?.startedAt || "").localeCompare(String(a.run?.finishedAt || a.run?.startedAt || "")))
                  .map((item, index) => {
                    const name = String(item.path || "").split(/[\\/]/).pop() || item.path;
                    const published = publishedByArtifact.get(item.artifactId);
                    const canPublish = item.run?.status === "completed" && item.verificationStatus !== "failed" && !published;
                    return (
                      <div
                        key={`${item.artifactId || item.path}-${index}`}
                        className={`file-item artifact-item ${name === currentName ? "active" : ""}`}
                        onClick={() => {
                          onOpenFile(item.path);
                          setModal(null);
                        }}
                        title={`${item.path} · 来源 Run ${item.run?.id || "未知"}`}
                      >
                        <FileTypeIcon file={{ name, ext: name.includes(".") ? name.split(".").pop() : "" }} size="small" />
                        <span className="file-name" title={item.path}>{name}</span>
                        <span className={`artifact-status ${published ? "published" : item.verificationStatus === "failed" ? "failed" : ""}`}>{published ? `v${published.version} 已固定` : item.verificationStatus === "failed" ? "校验失败" : "待固定"}</span>
                        {canPublish && <button className="btn-xs artifact-publish-btn" onClick={async (e) => {
                          e.stopPropagation();
                          try { await publishArtifact(item.run.id, item.artifactId); await refreshArtifacts(); } catch (error) { alert("固定成果失败: " + error.message); }
                        }}>固定成果</button>}
                      </div>
                    );
                  })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 设置弹窗（含记忆） */}
      {modal === "settings" && (
        <div className="sb-modal-backdrop" onClick={() => setModal(null)}>
          <div className="sb-modal sb-modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="sb-modal-head">
              <Icon name="gear" size={13} />
              <span className="sb-modal-title">设置</span>
              <div className="sb-subtabs">
                <button className={`sb-subtab ${modalTab === "settings" ? "active" : ""}`} onClick={() => setModalTab("settings")}>设置</button>
                <button className={`sb-subtab ${modalTab === "memory" ? "active" : ""}`} onClick={() => setModalTab("memory")} title="工作区记忆（AGENTS.md + memory/）">记忆</button>
              </div>
              <button className="mp-op" onClick={() => setModal(null)} title="关闭"><Icon name="close" size={14} /></button>
            </div>
            <div className="sb-modal-body">
              {modalTab === "settings" ? <SettingsPanel /> : <MemoryTab workspace={currentWorkspace} />}
            </div>
          </div>
        </div>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
