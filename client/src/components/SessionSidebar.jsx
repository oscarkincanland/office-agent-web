import React, { useRef, useState, useCallback } from "react";
import { Document, Packer, Paragraph } from "docx";
import { uploadFile, deleteFile, deleteSession, renameSession, fileToBase64, listSessions, validateWorkspace } from "../api.js";
import ContextMenu from "./ContextMenu.jsx";
import Icon from "./Icon.jsx";
import MemoryTab from "./MemoryTab.jsx";
import SettingsPanel from "./SettingsPanel.jsx";

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
        <button className="btn-icon" onClick={() => handleTogglePin(s.id)} title={pinned.has(s.id) ? "取消置顶" : "置顶"}>
          <Icon name="pin" size={12} className={pinned.has(s.id) ? "pinned" : ""} />
        </button>
        <button
          className="btn-icon"
          onClick={() => { setEditingId(s.id); setEditValue(s.label || s.title || ""); }}
          title="重命名"
        ><Icon name="penTool" size={12} /></button>
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

export default function SessionSidebar({ sessions, files, currentName, onOpenFile, onRefreshFiles, onRefreshSessions, onUploaded, workspaces = [], currentWorkspace = "", onWorkspaceChange, currentDir = "", onDirChange, onSelectSession, onAtMention, onNewSession }) {
  const fileRef = useRef(null);
  const [bottomTab, setBottomTab] = useState("artifacts"); // 底部 tab：产物/记忆/设置
  const [modal, setModal] = useState(null);   // 弹窗：artifacts | settings
  const [modalTab, setModalTab] = useState("settings"); // 设置弹窗子 tab：settings | memory
  const [fileQ, setFileQ] = useState("");    // 文件搜索关键词
  const [sessionsH, setSessionsH] = useState(null); // 历史区高度（null=默认30%），可拖拽
  const splitDragRef = useRef(null);

  // 历史/文件 上下分割拖拽
  const startSplitDrag = (e) => {
    e.preventDefault();
    const section = e.currentTarget.closest(".sessions-section");
    const startY = e.clientY;
    const startH = section ? section.getBoundingClientRect().height : 300;
    splitDragRef.current = { startY, startH };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev) => {
      const next = Math.min(window.innerHeight * 0.6, Math.max(80, splitDragRef.current.startH + (ev.clientY - splitDragRef.current.startY)));
      setSessionsH(next);
    };
    const onUp = () => {
      splitDragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const [sessionsOpen, setSessionsOpen] = useState(() => {
    try { return localStorage.getItem("oaw_sidebar_sessions_open") !== "0"; } catch { return true; }
  });
  const toggleSessions = () => {
    const next = !sessionsOpen;
    setSessionsOpen(next);
    try { localStorage.setItem("oaw_sidebar_sessions_open", next ? "1" : "0"); } catch {}
  };
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
      {/* 顶部：工作区选择器 + 新建会话 */}
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
        <button className="btn-sm sidebar-new-session" onClick={() => onNewSession && onNewSession()} title="新建会话">
          <Icon name="plus" size={13} />
        </button>
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

      {/* 会话历史（折叠区） */}
      <div className="sidebar-section-head" onClick={toggleSessions}>
        <span className="section-chevron">{sessionsOpen ? "▾" : "▸"}</span>
        <Icon name="history" size={12} />
        <span className="section-name">历史</span>
        <span className="section-count">{sessions.length}</span>
        <button className="btn-xs section-refresh" onClick={(e) => { e.stopPropagation(); onRefreshSessions(); }} title="刷新会话">
          <Icon name="refresh" size={11} />
        </button>
        {currentName && (
          <button
            className={`btn-xs section-filter ${fileFilter ? "active" : ""}`}
            onClick={(e) => { e.stopPropagation(); toggleFileFilter(); }}
            title="按当前文档过滤"
          ><Icon name="filter" size={11} /></button>
        )}
      </div>
      {sessionsOpen && (
        <div className="sidebar-section sessions-section" style={sessionsH ? { height: sessionsH, maxHeight: sessionsH } : undefined}>
          <SessionList
            sessions={filteredSessions || sessions}
            onDelete={handleDeleteSession}
            onRename={handleRenameSession}
            onSelect={(s) => { if (onSelectSession) onSelectSession(s); }}
          />
          {fileFilter && currentName && (
            <div className="sidebar-foot">已过滤：仅显示与「{currentName}」相关的会话</div>
          )}
        </div>
      )}
      {/* 历史/文件 垂直分割手柄（会话区展开时可用） */}
      {sessionsOpen && <div className="sidebar-split-handle" onMouseDown={startSplitDrag} title="拖动调整历史/文件高度" />}

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
        <input ref={fileRef} type="file" accept=".docx,.xlsx,.pptx" hidden onChange={handleUpload} />
      </div>
      <div className="sidebar-section files-section">
        {files.length === 0 && <div className="empty">暂无文件，点击上传</div>}
        {currentDir && (
          <div className="crumb-bar">
            <button className="btn-xs" onClick={() => onDirChange && onDirChange("")} title="返回工作区根目录">← 根目录</button>
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
      <div className="sidebar-bottom-hint">
        产物与设置点击后弹窗显示
      </div>

      {/* 产物弹窗 */}
      {modal === "artifacts" && (
        <div className="sb-modal-backdrop" onClick={() => setModal(null)}>
          <div className="sb-modal" onClick={(e) => e.stopPropagation()}>
            <div className="sb-modal-head">
              <Icon name="file" size={13} />
              <span className="sb-modal-title">产物（{files.filter((f) => !f.isDir).length}）</span>
              <span className="sb-modal-sub">agent 生成的文档按时间倒序</span>
              <button className="mp-op" onClick={() => setModal(null)} title="关闭"><Icon name="close" size={14} /></button>
            </div>
            <div className="sb-modal-body">
              {files.filter((f) => !f.isDir).length === 0 && <div className="empty">暂无产物，agent 生成的文档会显示在这里</div>}
              <div className="file-list">
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
                        setModal(null);
                      }}
                      title={f.name}
                    >
                      <span className="file-ext"><Icon name={EXT_LABELS[f.ext] || "file"} size={12} /></span>
                      <span className="file-name">{f.name}</span>
                      <span className="file-time" title={new Date(f.mtime).toLocaleString()}>
                        {formatTime(new Date(f.mtime).toISOString())}
                      </span>
                    </div>
                  ))}
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
              {modalTab === "settings" ? <SettingsPanel /> : <MemoryTab />}
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
