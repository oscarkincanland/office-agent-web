import React, { useRef, useState } from "react";
import { uploadFile, deleteFile, deleteSession, renameSession, fileToBase64, listSessions, validateWorkspace } from "../api.js";

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

function shortenCwd(cwd) {
  if (!cwd) return "";
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return cwd;
  return "\u2026/" + parts.slice(-2).join("/");
}

// 会话列表：按 modified 倒序，显示标签/首条消息/时间
function SessionList({ sessions, onSelect, onDelete, onRename }) {
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState("");

  const handleRename = async (id) => {
    await onRename(id, editValue);
    setEditingId(null);
  };

  return (
    <div className="session-list">
      {sessions.length === 0 && <div className="empty">暂无会话记录</div>}
      {sessions.map((s) => (
        <div key={s.id} className="session-item" onClick={() => onSelect(s)}>
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
                  {s.title || s.label || "(空会话) " + s.id.slice(0, 8)}
                </span>
                <span className="session-time">{formatTime(s.modified)}</span>
              </>
            )}
          </div>
          {s.cwd && <div className="session-cwd" title={s.cwd}>{shortenCwd(s.cwd)}</div>}
          <div className="session-actions" onClick={(e) => e.stopPropagation()}>
            <button
              className="btn-xs"
              onClick={() => { setEditingId(s.id); setEditValue(s.label || ""); }}
              title="重命名"
            >重命名</button>
            <button
              className="btn-xs danger"
              onClick={async () => { if (confirm("确认删除此会话?")) { await onDelete(s.id); } }}
              title="删除"
            >删除</button>
          </div>
        </div>
      ))}
    </div>
  );
}

const EXT_LABELS = { docx: "W", xlsx: "X", pptx: "P" };

export default function SessionSidebar({ sessions, files, currentName, onOpenFile, onRefreshFiles, onRefreshSessions, onUploaded, workspaces = [], currentWorkspace = "", onWorkspaceChange, currentDir = "", onDirChange, onSelectSession }) {
  const fileRef = useRef(null);
  const [tab, setTab] = useState("files"); // "files" | "sessions"
  const [customMode, setCustomMode] = useState(false);
  const [customPath, setCustomPath] = useState("");
  const [applying, setApplying] = useState(false);

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
        <button className={`tab-btn ${tab === "sessions" ? "active" : ""}`} onClick={() => setTab("sessions")}>历史</button>
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
            {files.map((f) => (
              <div
                key={f.name}
                className={`file-item ${!f.isDir && f.name === currentName ? "active" : ""}`}
                onClick={() => {
                  if (f.isDir) {
                    const next = currentDir ? `${currentDir}/${f.name}` : f.name;
                    onDirChange && onDirChange(next);
                  } else {
                    const rel = currentDir ? `${currentDir}/${f.name}` : f.name;
                    onOpenFile(rel);
                  }
                }}
                title={f.isDir ? f.name : f.name}
              >
                <span className={`file-ext ${f.isDir ? "dir" : ""}`}>{f.isDir ? "DIR" : (EXT_LABELS[f.ext] || f.ext?.slice(0, 2).toUpperCase() || "?" )}</span>
                <span className="file-name">{f.isDir ? f.name + "/" : f.name}</span>
                {!f.isDir && (
                  <span className="file-del" onClick={(e) => { e.stopPropagation(); handleDeleteFile(currentDir ? `${currentDir}/${f.name}` : f.name); }}>x</span>
                )}
              </div>
            ))}
          </div>
          <div className="sidebar-foot">office-workspace</div>
        </>
      )}

      {tab === "sessions" && (
        <>
          <div className="sidebar-actions">
            <button className="btn-sm" onClick={onRefreshSessions}>刷新</button>
          </div>
          <SessionList
            sessions={sessions}
            onDelete={handleDeleteSession}
            onRename={handleRenameSession}
            onSelect={(s) => {
              if (onSelectSession) onSelectSession(s);
            }}
          />
        </>
      )}
    </div>
  );
}
