import React, { useEffect, useState, useCallback, useMemo } from "react";
import { listSkills, listWorkflows, exportSkill, importSkill, validateWorkflow } from "../api.js";
import Icon from "./Icon.jsx";

/**
 * 技能广场（页面中的页面）：
 * - 按类型分类展示所有 skills（交通规划/文档/图表/图像…）
 * - 技能集合：预置面向交通规划工程师的多技能工作流，一键组合调用
 * - 搜索/导出/导入/@调用
 */
const CATEGORY_LABELS = {
  traffic: "交通规划",
  doc: "文档报告",
  chart: "图表可视化",
  image: "图像生成",
  media: "媒体内容",
  office: "Office办公",
  dev: "开发工具",
  research: "搜索研究",
  other: "其他",
};

// 面向交通规划工程师的预置技能集合（工作流）
const WORKFLOWS = [
  {
    id: "wf-plan-doc",
    name: "规划报告全流程",
    icon: "doc",
    desc: "从调研到成稿：研究→规划报告撰写→图表生成→排版导出",
    skills: ["huashu-research", "traffic-report-comprehensive", "traffic-charts-template", "huashu-md-to-pdf"],
    prompt: "请按「交通综合规划报告」标准流程：1) 先调研相关资料；2) 用交通规划报告框架撰写；3) 用图表模板生成配图；4) 导出为规范 PDF。",
  },
  {
    id: "wf-od-analysis",
    name: "OD数据分析工作台",
    icon: "xls",
    desc: "OD数据导入→分析→可视化→报告输出",
    skills: ["od-workflow", "huashu-data-pro", "transport-chart-composition", "traffic-map-template"],
    prompt: "请处理 OD 数据：1) 用 OD 工作流导入并校验数据；2) 统计分析客流/流向；3) 生成分布图表和地图；4) 汇总为分析报告。",
  },
  {
    id: "wf-bus-plan",
    name: "公交规划专项",
    icon: "menu",
    desc: "公交专项规划：现状分析→方案→配图→汇报材料",
    skills: ["traffic-report-bus", "traffic-charts-template", "traffic-map-template", "traffic-report-briefing"],
    prompt: "请按「公共交通专项规划」流程：1) 现状客流分析；2) 撰写规划报告；3) 生成线路/客流图表与地图；4) 输出汇报材料。",
  },
  {
    id: "wf-meeting-brief",
    name: "汇报材料速成",
    icon: "ppt",
    desc: "工作汇报/上会材料：简报→PPT→配图",
    skills: ["traffic-report-briefing", "huashu-slides", "baoyu-xhs-images", "gongzuo-huibao"],
    prompt: "请准备汇报材料：1) 按工作汇报框架撰写简报；2) 生成 PPT；3) 为关键页面配图。",
  },
];

export default function SkillsManager({ open, onClose, onAtMention }) {
  const [skills, setSkills] = useState([]);
  const [workflows, setWorkflows] = useState(WORKFLOWS);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [view, setView] = useState("skills"); // "skills" | "workflows"
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const fileRef = React.useRef(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await listSkills();
      setSkills(d.skills || []);
      try {
        const w = await listWorkflows();
        if (w.workflows?.length) setWorkflows(w.workflows);
      } catch {}
    } catch (e) { setMsg("加载失败: " + e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { if (open) refresh(); }, [open, refresh]);

  // 按分类聚合（hooks 必须无条件执行）
  const grouped = useMemo(() => {
    const groups = {};
    for (const s of skills) {
      const c = s.category && CATEGORY_LABELS[s.category] ? s.category : "other";
      if (!groups[c]) groups[c] = [];
      groups[c].push(s);
    }
    return groups;
  }, [skills]);

  const filtered = query
    ? skills.filter((s) => s.name.includes(query.toLowerCase()) || (s.description || "").toLowerCase().includes(query.toLowerCase()))
    : skills;

  const visibleCategories = category === "all"
    ? Object.keys(grouped)
    : [category];

  if (!open) return null;

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

  // 启动工作流：插入工作流 prompt 并逐个 @ 其依赖技能
  const startWorkflow = (wf) => {
    const ats = wf.skills.map((s) => `@${s}`).join(" ");
    const prompt = wf.prompt || `请按「${wf.name}」工作流执行：${(wf.steps || []).join(" → ")}。完成后汇总产物和来源。`;
    onAtMention(`@工作流[${wf.id}] ${ats} ${prompt}`);
    onClose();
    setMsg(`已启动「${wf.name}」工作流`);
  };

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="skills-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="技能广场">
        <div className="modal-head">
          <span className="modal-title"><Icon name="skills" size={14} /> 技能广场 ({skills.length})</span>
          <button className="btn-xs" onClick={onClose} aria-label="关闭技能广场"><Icon name="close" size={12} /> 关闭</button>
        </div>

        <div className="modal-toolbar">
          <div className="modal-view-switch">
            <button className={`btn-sm ${view === "skills" ? "active" : ""}`} onClick={() => setView("skills")}>技能</button>
            <button className={`btn-sm ${view === "workflows" ? "active" : ""}`} onClick={() => setView("workflows")}>技能集合</button>
          </div>
          <input
            type="text"
            placeholder="搜索技能..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="modal-search"
          />
          <button className="btn-sm" onClick={() => fileRef.current?.click()}><Icon name="upload" size={12} /> 导入</button>
          <input
            ref={fileRef}
            type="file"
            accept=".json"
            hidden
            onChange={(e) => { if (e.target.files?.[0]) handleImportFile(e.target.files[0]); e.target.value = ""; }}
          />
          <button className="btn-sm" onClick={refresh} disabled={loading}>{loading ? "加载中..." : <><Icon name="refresh" size={12} /> 刷新</>}</button>
        </div>

        {msg && <div className="modal-msg">{msg}</div>}

        {view === "workflows" ? (
          <div className="skills-list">
            <div className="workflow-intro">面向交通规划工程师的多技能组合工作流，一键启动</div>
            {workflows.map((wf) => (
              <div className="workflow-item" key={wf.id}>
                <div className="workflow-info">
                  <div className="workflow-name"><Icon name={wf.icon} size={14} /> {wf.name}</div>
                  <div className="workflow-desc">{wf.desc || wf.description}</div>
                  <div className="workflow-skills">
                    {wf.skills.map((s) => (
                      <span className="workflow-skill-chip" key={s} title={s}>@{s}</span>
                    ))}
                  </div>
                  {wf.missing?.length > 0 && <div className="workflow-warning">缺少技能：{wf.missing.join(", ")}</div>}
                </div>
                <button className="btn-sm primary" onClick={async () => { try { const v = await validateWorkflow(wf.id); if (!v.ok) setMsg(v.message || "部分技能不可用，仍将保留工作流上下文"); } catch (e) { setMsg(e.message); } startWorkflow(wf); }}>启动</button>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="modal-cats">
              <button className={`btn-xs ${category === "all" ? "active" : ""}`} onClick={() => setCategory("all")}>全部</button>
              {Object.keys(CATEGORY_LABELS).map((c) => (
                <button
                  key={c}
                  className={`btn-xs ${category === c ? "active" : ""}`}
                  onClick={() => setCategory(c)}
                >
                  {CATEGORY_LABELS[c]} ({grouped[c]?.length || 0})
                </button>
              ))}
            </div>
            <div className="skills-list">
              {visibleCategories.length === 0 && <div className="empty">无匹配技能</div>}
              {visibleCategories.map((cat) => (
                <div className="skill-group" key={cat}>
                  <div className="skill-group-title">{CATEGORY_LABELS[cat] || cat}</div>
                  {filtered.filter((s) => (s.category || "other") === cat).map((s) => (
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
                        ><Icon name="at" size={11} /> 调用</button>
                        <button className="btn-xs" title="导出技能" onClick={() => handleExport(s)}><Icon name="download" size={11} /> 导出</button>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
