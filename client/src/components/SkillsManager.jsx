import React, { useEffect, useState, useCallback } from "react";
import { listSkills, exportSkill, importSkill } from "../api.js";

/**
 * 技能管理弹层（页面中的页面）：
 * - 扫描展示本地所有 skills
 * - 搜索过滤
 * - @ 到对话（插入 @skill名）
 * - 导出 skill（下载 JSON）
 * - 导入 skill（上传 JSON）
 */
export default function SkillsManager({ open, onClose, onAtMention }) {
  const [skills, setSkills] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const fileRef = React.useRef(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await listSkills();
      setSkills(d.skills || []);
    } catch (e) { setMsg("加载失败: " + e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { if (open) refresh(); }, [open, refresh]);

  if (!open) return null;

  const filtered = query
    ? skills.filter((s) => s.name.includes(query.toLowerCase()) || (s.description || "").toLowerCase().includes(query.toLowerCase()))
    : skills;

  const handleExport = async (skill) => {
    try {
      const d = await exportSkill(skill.name);
      if (!d.ok) { setMsg("导出失败"); return; }
      const blob = new Blob([JSON.stringify(d.skill, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${skill.name}.skill.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg(`已导出 ${skill.name}`);
      setTimeout(() => setMsg(""), 2000);
    } catch (e) { setMsg("导出失败: " + e.message); }
  };

  const handleImportFile = async (file) => {
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const d = await importSkill(payload);
      if (d.ok) {
        setMsg(`已导入 ${d.name}`);
        refresh();
      } else {
        setMsg("导入失败: " + (d.error || ""));
      }
    } catch (e) { setMsg("导入失败: " + e.message); }
    setTimeout(() => setMsg(""), 3000);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="skills-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">🧩 技能管理 ({skills.length})</span>
          <button className="btn-xs" onClick={onClose}>✕ 关闭</button>
        </div>
        <div className="modal-toolbar">
          <input
            type="text"
            placeholder="搜索技能..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="modal-search"
          />
          <button className="btn-sm" onClick={() => fileRef.current?.click()}>⬆ 导入</button>
          <input
            ref={fileRef}
            type="file"
            accept=".json"
            hidden
            onChange={(e) => { if (e.target.files?.[0]) handleImportFile(e.target.files[0]); e.target.value = ""; }}
          />
          <button className="btn-sm" onClick={refresh} disabled={loading}>{loading ? "加载中..." : "刷新"}</button>
        </div>
        {msg && <div className="modal-msg">{msg}</div>}
        <div className="skills-list">
          {filtered.length === 0 && <div className="empty">无匹配技能</div>}
          {filtered.map((s) => (
            <div className="skill-item" key={s.name}>
              <div className="skill-info">
                <div className="skill-name">
                  {s.name}
                  <span className={`skill-source src-${s.source}`}>{s.source}</span>
                </div>
                <div className="skill-desc">{s.description || "(无描述)"}</div>
              </div>
              <div className="skill-actions">
                <button
                  className="btn-xs"
                  title="插入 @ 到对话，让 agent 调用此技能"
                  onClick={() => { onAtMention && onAtMention(s.name); onClose(); }}
                >@ 调用</button>
                <button className="btn-xs" title="导出技能" onClick={() => handleExport(s)}>导出</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
