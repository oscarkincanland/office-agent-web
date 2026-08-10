import React, { useEffect, useState, useCallback, useRef } from "react";
import Icon from "./Icon.jsx";

export default function MemoryTab() {
  const [files, setFiles] = useState([]);
  const [active, setActive] = useState(null); // rel path
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [changes, setChanges] = useState([]); // {file, preview, time}
  const [loading, setLoading] = useState(false);
  const saveTimer = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/memory");
      const d = await r.json();
      setFiles(d.files || []);
    } catch {}
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // SSE 记忆变更监听
  useEffect(() => {
    const es = new EventSource("/api/memory/stream");
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        setChanges((prev) => {
          const next = [data, ...prev.filter((c) => c.file !== data.file)].slice(0, 8);
          return next;
        });
        // 如果正在查看变更的文件，自动刷新
        if (active === data.file && !dirty) loadFile(active);
      } catch {}
    };
    es.onerror = () => {};
    return () => es.close();
  }, [active, dirty]);

  const loadFile = useCallback(async (rel) => {
    try {
      const r = await fetch(`/api/memory/${encodeURIComponent(rel)}`);
      const d = await r.json();
      setActive(rel);
      setContent(d.content || "");
      setEditing(false);
      setDirty(false);
    } catch {}
  }, []);

  const saveFile = useCallback(async () => {
    if (!active || !dirty) return;
    setLoading(true);
    try {
      await fetch(`/api/memory/${encodeURIComponent(active)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      setDirty(false);
    } catch {}
    setLoading(false);
  }, [active, content, dirty]);

  // 自动保存防抖
  useEffect(() => {
    if (!dirty) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(saveFile, 800);
    return () => clearTimeout(saveTimer.current);
  }, [dirty, saveFile]);

  const handleInit = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/memory/init", { method: "POST" });
      const d = await r.json();
      if (d.files) setFiles(d.files);
    } catch {}
    setLoading(false);
  };

  const dismissChange = (file) => {
    setChanges((prev) => prev.filter((c) => c.file !== file));
  };

  return (
    <div className="memory-tab">
      {/* 记忆变更 Dock（Proma MemoryChangeDock 风格） */}
      {changes.length > 0 && (
        <div className="memory-dock">
          <div className="memory-dock-head"><Icon name="info" size={10} /> 记忆已更新</div>
          {changes.map((c) => (
            <div key={c.file} className="memory-change-item" onClick={() => loadFile(c.file)}>
              <Icon name="file" size={10} />
              <span className="memory-change-file">{c.file}</span>
              <button className="memory-change-dismiss" onClick={(e) => { e.stopPropagation(); dismissChange(c.file); }}>
                <Icon name="x" size={9} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 工具栏 */}
      <div className="memory-toolbar">
        <button className="btn-sm" onClick={refresh}>刷新</button>
        <button className="btn-sm" onClick={handleInit} disabled={loading}>
          {loading ? "创建中..." : "初始化记忆"}
        </button>
      </div>

      {/* 文件列表 + 内容区 */}
      <div className="memory-layout">
        <div className="memory-file-list">
          {files.length === 0 && <div className="empty">暂无记忆文件，点击「初始化记忆」</div>}
          {files.map((f) => (
            <div
              key={f.rel}
              className={`memory-file-item ${active === f.rel ? "active" : ""}`}
              onClick={() => loadFile(f.rel)}
            >
              <Icon name={f.type === "agents" ? "doc" : "file"} size={11} />
              <span className="memory-file-name">{f.rel}</span>
              <span className="memory-file-size">{(f.size / 1024).toFixed(1)}k</span>
            </div>
          ))}
        </div>
        {active && (
          <div className="memory-editor">
            <div className="memory-editor-head">
              <span className="memory-editor-name">{active}</span>
              <div className="memory-editor-actions">
                <button className={`btn-xs ${editing ? "active" : ""}`} onClick={() => setEditing(!editing)}>
                  {editing ? "预览" : "编辑"}
                </button>
                {dirty && <button className="btn-xs" onClick={saveFile}>保存</button>}
              </div>
            </div>
            <textarea
              className="memory-textarea"
              value={content}
              readOnly={!editing}
              onChange={(e) => { setContent(e.target.value); setDirty(true); }}
              placeholder="在此编辑记忆文件..."
            />
          </div>
        )}
      </div>
    </div>
  );
}
