import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * 统一命令面板（Ctrl/Cmd+K）
 * 数据源：
 *   - 文件：GET /api/files → {files:[{name,ext,isDir}]}
 *   - 知识库：GET /api/kb/search?q=… → {results:[{relPath,title,snippet,tags}]}
 *   - 模板：GET /api/templates → {categories, items:[{title,name,relPath,category,ext}]}
 *   - 地图：GET /api/map/projects → {projects:[{name,project,…}]}
 *   - 会话：GET /api/sessions → {sessions:[{id,title,modified,label,…}]}
 */

const ICONS = {
  file: "📄",
  kb: "📚",
  template: "📋",
  map: "🗺️",
  session: "💬",
};

function matches(item, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    (item.title || "").toLowerCase().includes(needle) ||
    (item.subtitle || "").toLowerCase().includes(needle)
  );
}

export default function CommandPalette({ open, onClose, onOpenFile, onKb, onTpl, onMap, onSession }) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState([]);
  const [kbResults, setKbResults] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [mapProjects, setMapProjects] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  // 打开前记录触发控件，关闭后把焦点还回去，键盘用户不会丢失位置。
  const restoreFocusRef = useRef(null);

  useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return undefined;
    }
    const target = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (target && typeof target.focus === "function" && document.contains(target)) {
      requestAnimationFrame(() => target.focus());
    }
  }, [open]);

  // 打开时重置 + 拉数据
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIdx(0);
    setKbResults([]);

    const fetchJson = (url) => fetch(url).then((r) => r.json()).catch(() => null);

    (async () => {
      // 文件
      try {
        const d = await fetchJson("/api/files");
        const arr = (d?.files || []).filter((f) => !f.isDir).slice(0, 30);
        setFiles(arr);
      } catch { setFiles([]); }
      // 模板
      try {
        const d = await fetchJson("/api/templates");
        const arr = (d?.items || d?.templates || []).slice(0, 30);
        setTemplates(arr);
      } catch { setTemplates([]); }
      // 地图
      try {
        const d = await fetchJson("/api/map/projects");
        const arr = (d?.projects || []).slice(0, 10);
        setMapProjects(arr);
      } catch { setMapProjects([]); }
      // 会话
      try {
        const d = await fetchJson("/api/sessions");
        const arr = (d?.sessions || []).slice(0, 10);
        setSessions(arr);
      } catch { setSessions([]); }
    })();
  }, [open]);

  // 防抖搜索知识库
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) { setKbResults([]); return; }
    const timer = setTimeout(async () => {
      try {
        const d = await fetch(`/api/kb/search?q=${encodeURIComponent(q)}`).then((r) => r.json());
        setKbResults(d?.results || []);
      } catch { setKbResults([]); }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, open]);

  // 打开时自动聚焦
  useEffect(() => {
    if (open) {
      // 下一帧聚焦（确保 input 已挂载）
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // 构建扁平化结果（组 → 项）
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = [];

    const fileItems = files
      .filter((f) => matches({ title: f.name, subtitle: f.ext }, q))
      .map((f) => ({
        type: "file",
        id: `file:${f.name}`,
        title: f.name,
        subtitle: f.ext ? `.${f.ext}` : "",
        icon: ICONS.file,
        action: () => onOpenFile?.(f.name),
      }));
    if (fileItems.length) out.push({ id: "files", title: "📄 文件", items: fileItems });

    if (q) {
      const kbItems = kbResults
        .map((r) => ({
          type: "kb",
          id: `kb:${r.relPath}`,
          title: r.title || r.relPath,
          subtitle: r.snippet || r.relPath,
          icon: ICONS.kb,
          action: () => onKb?.(),
        }));
      if (kbItems.length) out.push({ id: "kb", title: "📚 知识库", items: kbItems });
    }

    const tplItems = templates
      .filter((t) => matches({ title: t.title || t.name, subtitle: t.category }, q))
      .map((t) => ({
        type: "template",
        id: `tpl:${t.id || t.relPath || t.title}`,
        title: t.title || t.name,
        subtitle: [t.category, t.ext].filter(Boolean).join(" · "),
        icon: ICONS.template,
        action: () => onTpl?.(),
      }));
    if (tplItems.length) out.push({ id: "templates", title: "📋 模板", items: tplItems });

    const mapItems = mapProjects
      .filter((p) => matches({ title: p.name || p.project, subtitle: p.project }, q))
      .map((p) => ({
        type: "map",
        id: `map:${p.project || p.name}`,
        title: p.name || p.project,
        subtitle: p.project ? `项目 · ${p.project}` : "",
        icon: ICONS.map,
        action: () => onMap?.(),
      }));
    if (mapItems.length) out.push({ id: "map", title: "🗺️ 地图", items: mapItems });

    const sessItems = sessions
      .filter((s) => matches({ title: s.title || s.label, subtitle: s.id }, q))
      .map((s) => ({
        type: "session",
        id: `sess:${s.id}`,
        title: s.title || s.label || s.id,
        subtitle: s.modified ? new Date(s.modified).toLocaleString() : s.id,
        icon: ICONS.session,
        action: () => onSession?.(s),
      }));
    if (sessItems.length) out.push({ id: "sessions", title: "💬 会话", items: sessItems });

    return out;
  }, [files, kbResults, templates, mapProjects, sessions, query, onOpenFile, onKb, onTpl, onMap, onSession]);

  // 扁平化供键盘导航使用
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // 输入或结果变化时，重置选中到第一项
  useEffect(() => {
    setSelectedIdx(0);
  }, [query, flat.length]);

  // 键盘上下移动选择时，把当前项滚进可视区，长列表也不会“选中项在屏幕外”。
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector(`[data-cmd-index="${selectedIdx}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIdx, open]);

  // 关闭时清空防抖中的知识库结果，避免下次打开闪现过期内容
  useEffect(() => {
    if (!open) setKbResults([]);
  }, [open]);

  // 键盘处理
  const handleKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose?.();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flat.length) setSelectedIdx((i) => (i + 1) % flat.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length) setSelectedIdx((i) => (i - 1 + flat.length) % flat.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = flat[selectedIdx];
      if (item) {
        item.action();
        onClose?.();
      }
    }
  };

  if (!open) return null;

  // 计算每个 item 在 flat 中的起始索引（用于高亮）——普通计算（非 hook，避免条件 hooks）
  const indexMap = (() => {
    const m = new Map();
    let i = 0;
    for (const g of groups) {
      for (const it of g.items) {
        m.set(it.id, i++);
      }
    }
    return m;
  })();

  const totalCount = flat.length;

  return (
    <div className="cmd-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="cmd-panel" role="dialog" aria-modal="true" aria-label="命令面板">
        <input
          ref={inputRef}
          className="cmd-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="cmd-results-list"
          aria-autocomplete="list"
          aria-activedescendant={totalCount ? `cmd-option-${selectedIdx}` : undefined}
          aria-label="搜索文件、知识库、模板、地图和会话"
          placeholder="搜索 文件 / 知识库 / 模板 / 地图 / 会话…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="cmd-results" id="cmd-results-list" role="listbox" aria-label="命令面板结果" ref={listRef}>
          {totalCount === 0 && (
            <div className="cmd-empty" role="status">{query.trim() ? "无匹配结果" : "暂无内容"}</div>
          )}
          {groups.map((g) => (
            <div className="cmd-group" key={g.id} role="group" aria-label={g.title}>
              <div className="cmd-group-title" aria-hidden="true">{g.title}</div>
              {g.items.map((it) => {
                const idx = indexMap.get(it.id);
                const isSelected = idx === selectedIdx;
                return (
                  <div
                    key={it.id}
                    id={`cmd-option-${idx}`}
                    data-cmd-index={idx}
                    role="option"
                    tabIndex={-1}
                    aria-selected={isSelected}
                    aria-label={[it.title, it.subtitle].filter(Boolean).join("，")}
                    className={`cmd-item${isSelected ? " selected" : ""}`}
                    onMouseEnter={() => setSelectedIdx(idx)}
                    onClick={() => { it.action(); onClose?.(); }}
                  >
                    <span className="cmd-item-icon" aria-hidden="true">{it.icon}</span>
                    <div className="cmd-item-main">
                      <div className="cmd-item-title">{it.title}</div>
                      {it.subtitle && <div className="cmd-item-sub">{it.subtitle}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="cmd-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>Enter</kbd> 打开</span>
          <span><kbd>Esc</kbd> 关闭后焦点返回</span>
          <span style={{ marginLeft: "auto" }}>{totalCount} 项</span>
        </div>
      </div>
    </div>
  );
}