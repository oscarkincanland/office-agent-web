import React, { useRef, useState, useCallback } from "react";
import { uploadFile, deleteFile, deleteSession, renameSession, fileToBase64, listSessions, validateWorkspace } from "../api.js";
import ContextMenu from "./ContextMenu.jsx";
import Icon from "./Icon.jsx";
import MemoryTab from "./MemoryTab.jsx";

const EXT_LABELS = { docx: "doc", xlsx: "xls", pptx: "ppt", md: "md", html: "html", htm: "html", txt: "txt", pdf: "pdf" };
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

// 会话列表：置顶区 + 日期分组（Proma 风格）
function SessionList({ sessions, onSelect, onDelete, onRename }) {
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [pinned, setPinned] = useState(getPinnedSet);
  const [search, setSearch] = useState("");

  const handleRename = async (id) => {
    await onRename(id, editValue);
    setEditingId(null);
  };

  const handleTogglePin = (id) => {
    const next = togglePin(id);
    setPinned(new Set(next));
  };

  const filtered = search.trim()
    ? sessions.filter((s) => (s.title || s.label || s.id).toLowerCase().includes(search.toLowerCase()))
    : sessions;
  const pinnedList = filtered.filter((s) => pinned.has(s.id));
  const unpinned = filtered.filter((s) => !pinned.has(s.id));
  const groups = groupByDate(unpinned);

  const renderItem = (s) => (
    <div key={s.id} className="session-item" onClick={() => onSelect(s)}>
      <div className="session-indicator" data-status={s.running ? "running" : "idle"} />
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
            <span className="session-label" title={s.title || s.label || s.id}>
              {pinned.has(s.id) && <Icon name="pin" size={10} className="pin-icon" />}
              {s.title || s.label || "(空会话) " + s.id.slice(0, 8)}
            </span>
            <span className="session-time">{formatTime(s.modified)}</span>
          </>
        )}
      </div>
      {s.cwd && <div className="session-cwd" title={s.cwd}>{shortenCwd(s.cwd)}</div>}
      <div className="session-actions" onClick={(e) => e.stopPropagation()}>
        <button className="btn-xs" onClick={() => handleTogglePin(s.id)} title={pinned.has(s.id) ? "取消置顶" : "置顶"}>
          {pinned.has(s.id) ? "取消置顶" : "置顶"}
        </button>
        <button
          className="btn-xs"
          onClick={() => { setEditingId(s.id); setEditValue(s.label || s.title || ""); }}
          title="重命名"
        >重命名</button>
        <button
          className="btn-xs danger"
          onClick={async () => { if (confirm("确认删除此会话?")) { await onDelete(s.id); } }}
          title="删除"
        >删除</button>
      </div>
    </div>
  );

  return (
    <div className="session-list">
      <div className="session-search">
        <Icon name="search" size={11} />
        <input placeholder="搜索会话…" value={search} onChange={(e) => setSearch(e.target.value)} />
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

export default function SessionSidebar({ sessions, files, currentName, onOpenFile, onRefreshFiles, onRefreshSessions, onUploaded, workspaces = [], currentWorkspace = "", onWorkspaceChange, currentDir = "", onDirChange, onSelectSession, onAtMention }) {
  const fileRef = useRef(null);
  const [tab, setTab] = useState("files"); // "files" | "sessions"
  const [customMode, setCustomMode] = useState(false);
  const [customPath, setCustomPath] = useState("");
  const [applying, setApplying] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [newFiles, setNewFiles] = useState(new Set()); // 跟踪新创建的文件
  const [fileFilter, setFileFilter] = useState(false); // 会话按当前文档过滤
  const [filteredSessions, setFilteredSessions] = useState(null); // 过滤后的会话列表

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
    finally { e.target.value = ""; }
  };

  const handleDeleteFile = async (name) => {
    if (!confirm(`删除 ${name} ?`)) return;
    try { await deleteFile(name); onRefreshFiles(); } catch (err) { alert("删除失败: " + err.message); }
  };

  // 切换按当前文档过滤会话
  const toggleFileFilter = async () => {
    const next = !fileFilter;
    setFileFilter(next);
    if (next && currentName) {
      try {
        const d = await listSessions(currentName);
        setFilteredSessions(d.sessions || []);
      } catch { setFilteredSessions(sessions); }
    } else {
      setFilteredSessions(null);
    }
  };

  // 在文件管理器中打开
  const handleOpenInExplorer = (filePath) => {
    // 调用后端API打开文件管理器
    fetch("/api/open-in-explorer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath })
    }).catch(() => {
      // 如果API不存在，复制路径到剪贴板
      navigator.clipboard.writeText(filePath).then(() => {
        alert("路径已复制到剪贴板: " + filePath);
      });
    });
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
      menuItems.push(
        { separator: true },
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

  const handleDeleteSession = async (id) => {
    try { await deleteSession(id); onRefreshSessions(); } catch (err) { alert("删除失败: " + err.message); }
  };

  const handleRenameSession = async (id, label) => {
    try { await renameSession(id, label); onRefreshSessions(); } catch (err) { alert("重命名失败: " + err.message); }
  };

  return (
    <div className="sidebar">
      <div className="workspace-selector">
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
      </div>
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
      <div className="sidebar-tabs">
        <button className={`tab-btn ${tab === "files" ? "active" : ""}`} onClick={() => setTab("files")}>文件</button>
        <button className={`tab-btn ${tab === "artifacts" ? "active" : ""}`} onClick={() => setTab("artifacts")}>产物</button>
        <button className={`tab-btn ${tab === "sessions" ? "active" : ""}`} onClick={() => setTab("sessions")}>历史</button>
        <button className={`tab-btn ${tab === "memory" ? "active" : ""}`} onClick={() => setTab("memory")}>记忆</button>
      </div>

      {tab === "files" && (
        <>
          <div className="sidebar-actions">
            <button className="btn-sm" onClick={onRefreshFiles}>刷新</button>
            <button className="btn-sm" onClick={() => fileRef.current?.click()}>上传</button>
            <input ref={fileRef} type="file" accept=".docx,.xlsx,.pptx" hidden onChange={handleUpload} />
          </div>
          <div className="file-list">
            {files.length === 0 && <div className="empty">暂无文件，点击上传</div>}
            {/* 面包屑：返回上级 */}
            {currentDir && (
              <div className="crumb-bar">
                <button className="btn-xs" onClick={() => onDirChange && onDirChange("")} title="返回工作区根目录">← 根目录</button>
                <span className="crumb-path">/{currentDir.split("/").pop()}</span>
              </div>
            )}
            {files.map((f) => {
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
                  title={f.isDir ? f.name : f.name}
                >
                  <span className={`file-ext ${f.isDir ? "dir" : ""}`}>{f.isDir ? <Icon name="folder" size={12} /> : <Icon name={EXT_LABELS[f.ext] || "file"} size={12} />}</span>
                  <span className="file-name">{f.isDir ? f.name + "/" : f.name}</span>
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
          <div className="sidebar-foot">office-workspace</div>
        </>
      )}

      {tab === "artifacts" && (
        <>
          <div className="sidebar-actions">
            <button className="btn-sm" onClick={onRefreshFiles}>刷新</button>
          </div>
          <div className="file-list">
            {files.length === 0 && <div className="empty">暂无文件，agent 生成的文档会显示在这里</div>}
            {/* 按修改时间倒序展示（产物优先） */}
            {[...files]
              .filter((f) => !f.isDir)
              .sort((a, b) => b.mtime - a.mtime)
              .map((f) => (
                <div
                  key={f.name}
                  className={`file-item ${f.name === currentName ? "active" : ""}`}
                  onClick={() => {
                    const rel = currentDir ? `${currentDir}/${f.name}` : f.name;
                    onOpenFile(rel);
                  }}
                  title={f.name}
                >
                  <span className={`file-ext ${f.isDir ? "dir" : ""}`}><Icon name={EXT_LABELS[f.ext] || "file"} size={12} /></span>
                  <span className="file-name">{f.name}</span>
                  <span className="file-time" title={new Date(f.mtime).toLocaleString()}>
                    {formatRelTime(f.mtime)}
                  </span>
                </div>
              ))}
          </div>
          <div className="sidebar-foot">产物保存目录: {currentDir || "工作区根目录"}</div>
        </>
      )}

      {tab === "sessions" && (
        <>
          <div className="sidebar-actions">
            <button className="btn-sm" onClick={onRefreshSessions}>刷新</button>
            {currentName && (
              <button
                className={`btn-sm ${fileFilter ? "active" : ""}`}
                onClick={toggleFileFilter}
                title={fileFilter ? `仅显示与 ${currentName} 相关的会话` : `点击过滤出与 ${currentName} 相关的会话`}
              >
                <Icon name="filter" size={11} /> 当前文档
              </button>
            )}
          </div>
          <SessionList
            sessions={filteredSessions || sessions}
            onDelete={handleDeleteSession}
            onRename={handleRenameSession}
            onSelect={(s) => {
              if (onSelectSession) onSelectSession(s);
            }}
          />
          {fileFilter && currentName && (
            <div className="sidebar-foot">已过滤：仅显示与「{currentName}」相关的会话</div>
          )}
        </>
      )}

      {tab === "memory" && <MemoryTab />}
      
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
