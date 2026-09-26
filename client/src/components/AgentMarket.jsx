import React, { useEffect, useState } from "react";
import Icon from "./Icon.jsx";
import { createAgent, deleteAgent, listAgents, updateAgent } from "../api.js";

/**
 * 智能体广场：面向交通规划工程师的预置专用助手
 * 每个助手 = 一组 skill + 角色指令，可一键 @ 到对话栏
 */
const DEFAULT_AGENTS = [
  {
    id: "agent-gongwen",
    name: "公文报告编制助手",
    icon: "doc",
    desc: "按公文/报告版面规范撰写政府公文、汇报材料、规划报告，输出规范 .docx",
    skills: ["gongwen-banmian", "traffic-report-briefing", "traffic-report-comprehensive", "md-to-docx"],
    inputs: ["主题/事由", "已有素材或参考文件", "篇幅与格式要求"],
    outputs: ["规范 .docx 公文或报告"],
    prompt: "你现在是公文报告编制助手：请按公文版面规范撰写/修订公文或报告，输出规范 .docx，注意标题层级、字体字号、段落格式与附件清单。",
    color: "#b7791f",
  },
  {
    id: "agent-map",
    name: "地图可视化助手",
    icon: "locate",
    desc: "OD 期望线、站点分布、流向图、等时圈等交通地图可视化，单文件 HTML 开箱即用",
    skills: ["traffic-map-template", "od-workflow", "transport-chart-geospatial", "tanstack-charts-overview"],
    inputs: ["OD/站点/客流数据（表格或 GeoJSON）", "分析口径与范围"],
    outputs: ["单文件 HTML 交通专题地图"],
    prompt: "你现在是地图可视化助手：基于数据生成交通专题地图（OD期望线/站点/热力/等时圈等），输出单文件 HTML，使用 MapTiler 卫星底图，注意坐标系为中国范围。",
    color: "#2a8c82",
  },
  {
    id: "agent-review",
    name: "文本审查助手",
    icon: "search",
    desc: "公文/报告/论文的错别字、语病、格式、术语一致性、逻辑结构审查",
    skills: ["huashu-proofreading", "humanizer-zh", "every-style-editor", "text-summarizer"],
    inputs: ["待审文本或文档", "审查重点（可选）"],
    outputs: ["审查意见清单（位置 + 建议）"],
    prompt: "你现在是文本审查助手：逐段审查文本的错别字/语病/格式/术语一致性/逻辑结构，输出审查意见清单（问题位置+修改建议），不直接改稿。",
    color: "#5c7a1f",
  },
  {
    id: "agent-data",
    name: "数据分析及可视化助手",
    icon: "xls",
    desc: "Excel/OD/客流数据统计分析、图表生成（ECharts）、报告输出",
    skills: ["huashu-data-pro", "od-workflow", "traffic-charts-template", "echarts-pie-charts"],
    inputs: ["数据表格（xlsx/csv）", "分析目标"],
    outputs: ["统计结论 + ECharts 图表 HTML"],
    prompt: "你现在是数据分析及可视化助手：对表格/OD/客流数据做统计分析，验证数据完整性，生成 ECharts 图表与结论性分析，输出图表 HTML 与说明。",
    color: "#2a8c82",
  },
];

export default function AgentMarket({ open, onClose, onAtMention, onPromoteToAgent, fullPage = false, workspace = "" }) {
  const [agents, setAgents] = useState(DEFAULT_AGENTS);
  const [editor, setEditor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    listAgents().then((result) => setAgents(Array.isArray(result.agents) && result.agents.length ? result.agents : DEFAULT_AGENTS))
      .catch((error) => setMessage(`加载智能体失败：${error.message}`))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  const startAgent = (agent) => {
    const skills = Array.isArray(agent.skills) ? agent.skills.filter(Boolean) : [];
    if (onPromoteToAgent) {
      onPromoteToAgent({ text: agent.prompt || "", skills });
      return;
    }
    const ats = skills.map((s) => `@技能[${s}]`).join(" ");
    onAtMention?.(`${ats} ${agent.prompt || ""}`.trim());
    onClose();
  };

  const beginCreate = () => setEditor({ id: "", name: "", description: "", prompt: "", skills: "", icon: "robot", color: "#638e2d" });
  const beginEdit = (agent) => setEditor({ ...agent, skills: (agent.skills || []).join(", ") });
  const save = async () => {
    if (!editor?.name?.trim() || !editor?.prompt?.trim()) { setMessage("请填写名称和 Agent 指令"); return; }
    setLoading(true);
    try {
      const payload = { ...editor, skills: String(editor.skills || "").split(/[,，\n]/).map((item) => item.trim()).filter(Boolean) };
      const result = editor.id ? await updateAgent(editor.id, payload) : await createAgent(payload);
      if (!result.ok) throw new Error(result.error || "保存失败");
      setAgents((current) => editor.id ? current.map((item) => item.id === editor.id ? result.agent : item) : [...current, result.agent]);
      setEditor(null);
      setMessage("智能体已保存");
    } catch (error) { setMessage(`保存失败：${error.message}`); }
    finally { setLoading(false); }
  };
  const remove = async (agent) => {
    if (agent.builtin || !window.confirm(`删除自定义智能体“${agent.name}”？`)) return;
    setLoading(true);
    try {
      const result = await deleteAgent(agent.id);
      if (!result.ok) throw new Error(result.error || "删除失败");
      setAgents((current) => current.filter((item) => item.id !== agent.id));
      setMessage("智能体已删除");
    } catch (error) { setMessage(`删除失败：${error.message}`); }
    finally { setLoading(false); }
  };

  return (
    <div className={fullPage ? "module-view module-agents-view" : "modal-overlay"} onClick={onClose}>
      <div className="skills-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title"><Icon name="robot" size={14} /> 智能体广场 ({agents.length})</span>
          <button className="btn-xs" onClick={onClose}><Icon name="close" size={12} /> 关闭</button>
        </div>
        <div className="agent-market-toolbar">
          <div className="agent-market-intro">选择并配置适合当前任务的 Agent。「带入对话」只会把角色指令与依赖技能填成草稿，<b>发送后才会开始执行</b>；内置 Agent 保留为只读模板。</div>
          <button className="btn-sm primary" onClick={beginCreate} disabled={loading}><Icon name="plus" size={12} /> 创建 Agent</button>
        </div>
        {message && <div className="modal-msg">{message}</div>}
        {editor && (
          <div className="agent-editor">
            <div className="agent-editor-title">{editor.id ? "编辑自定义 Agent" : "创建自定义 Agent"}</div>
            <div className="agent-editor-grid">
              <input className="sp-input" placeholder="名称" value={editor.name} onChange={(e) => setEditor((v) => ({ ...v, name: e.target.value }))} />
              <input className="sp-input" placeholder="简介" value={editor.description} onChange={(e) => setEditor((v) => ({ ...v, description: e.target.value }))} />
              <input className="sp-input" placeholder="技能名，逗号分隔（可选）" value={editor.skills} onChange={(e) => setEditor((v) => ({ ...v, skills: e.target.value }))} />
              <textarea className="sp-textarea" placeholder="Agent 指令（必填）" value={editor.prompt} onChange={(e) => setEditor((v) => ({ ...v, prompt: e.target.value }))} />
            </div>
            <div className="agent-editor-actions"><button className="btn-sm primary" onClick={save} disabled={loading}>保存</button><button className="btn-sm" onClick={() => setEditor(null)}>取消</button></div>
          </div>
        )}
        <div className="skills-list">
          {agents.map((a) => (
            <div className="agent-item" key={a.id}>
              <div className="agent-icon" style={{ background: a.color }}>
                <Icon name={a.icon} size={18} />
              </div>
              <div className="agent-info">
                <div className="agent-name">{a.name}</div>
                <div className="agent-desc">{a.description || a.desc}</div>
                <div className="agent-skills">
                  {(Array.isArray(a.skills) ? a.skills : []).map((s) => (
                    <span className="workflow-skill-chip" key={s} title={s}>@{s}</span>
                  ))}
                </div>
                {/* 真实动作前的知情信息：所需输入 / 预计产物 / 执行工作区；不再把“预填草稿”说成“已启动” */}
                <details className="agent-brief">
                  <summary aria-label={`查看 ${a.name} 的所需输入与预计产物`}>所需输入 / 预计产物</summary>
                  <div className="agent-brief-grid">
                    <div><span>所需输入</span><ul>{(Array.isArray(a.inputs) && a.inputs.length ? a.inputs : ["按任务描述提供资料"]).map((item) => <li key={item}>{item}</li>)}</ul></div>
                    <div><span>预计产物</span><ul>{(Array.isArray(a.outputs) && a.outputs.length ? a.outputs : ["模型按任务判断"]).map((item) => <li key={item}>{item}</li>)}</ul></div>
                    <div><span>依赖技能</span><p>{(Array.isArray(a.skills) && a.skills.length) ? a.skills.map((s) => `@${s}`).join("、") : "无（仅角色指令）"}</p></div>
                    <div><span>执行工作区</span><p title={workspace || ""}>{workspace || "当前工作区（对话栏顶部可切换）"}</p></div>
                  </div>
                  <p className="agent-brief-note">点「带入对话」只会把角色指令与技能填入输入框；你确认并发送后才会真正开始执行。</p>
                </details>
              </div>
              <button
                className="btn-sm primary agent-bring-in"
                onClick={() => startAgent(a)}
                title="把角色指令与依赖技能填入对话输入框作为草稿；不会自动执行，确认并发送后才开始"
              ><Icon name="at" size={12} /> 带入对话</button>
              {a.builtin ? <span className="agent-builtin-label">内置</span> : <div className="agent-admin-actions"><button className="btn-xs" onClick={() => beginEdit(a)}>编辑</button><button className="btn-xs danger" onClick={() => remove(a)}>删除</button></div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
