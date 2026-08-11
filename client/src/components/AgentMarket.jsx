import React from "react";
import Icon from "./Icon.jsx";

/**
 * 智能体广场：面向交通规划工程师的预置专用助手
 * 每个助手 = 一组 skill + 角色指令，可一键 @ 到对话栏
 */
const AGENTS = [
  {
    id: "agent-gongwen",
    name: "公文报告编制助手",
    icon: "doc",
    desc: "按公文/报告版面规范撰写政府公文、汇报材料、规划报告，输出规范 .docx",
    skills: ["gongwen-banmian", "traffic-report-briefing", "traffic-report-comprehensive", "md-to-docx"],
    prompt: "你现在是公文报告编制助手：请按公文版面规范撰写/修订公文或报告，输出规范 .docx，注意标题层级、字体字号、段落格式与附件清单。",
    color: "#b7791f",
  },
  {
    id: "agent-map",
    name: "地图可视化助手",
    icon: "locate",
    desc: "OD 期望线、站点分布、流向图、等时圈等交通地图可视化，单文件 HTML 开箱即用",
    skills: ["traffic-map-template", "od-workflow", "transport-chart-geospatial", "tanstack-charts-overview"],
    prompt: "你现在是地图可视化助手：基于数据生成交通专题地图（OD期望线/站点/热力/等时圈等），输出单文件 HTML，使用 MapTiler 卫星底图，注意坐标系为中国范围。",
    color: "#2a8c82",
  },
  {
    id: "agent-review",
    name: "文本审查助手",
    icon: "search",
    desc: "公文/报告/论文的错别字、语病、格式、术语一致性、逻辑结构审查",
    skills: ["huashu-proofreading", "humanizer-zh", "every-style-editor", "text-summarizer"],
    prompt: "你现在是文本审查助手：逐段审查文本的错别字/语病/格式/术语一致性/逻辑结构，输出审查意见清单（问题位置+修改建议），不直接改稿。",
    color: "#5c7a1f",
  },
  {
    id: "agent-data",
    name: "数据分析及可视化助手",
    icon: "xls",
    desc: "Excel/OD/客流数据统计分析、图表生成（ECharts）、报告输出",
    skills: ["huashu-data-pro", "od-workflow", "traffic-charts-template", "echarts-pie-charts"],
    prompt: "你现在是数据分析及可视化助手：对表格/OD/客流数据做统计分析，验证数据完整性，生成 ECharts 图表与结论性分析，输出图表 HTML 与说明。",
    color: "#2a8c82",
  },
];

export default function AgentMarket({ open, onClose, onAtMention }) {
  if (!open) return null;

  const startAgent = (agent) => {
    const ats = agent.skills.map((s) => `@${s}`).join(" ");
    onAtMention(`${ats} ${agent.prompt}`);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="skills-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title"><Icon name="robot" size={14} /> 智能体广场 ({AGENTS.length})</span>
          <button className="btn-xs" onClick={onClose}><Icon name="close" size={12} /> 关闭</button>
        </div>
        <div className="agent-market-intro">交通规划工程师专用助手：一键 @ 到对话栏，agent 将按对应角色执行任务</div>
        <div className="skills-list">
          {AGENTS.map((a) => (
            <div className="agent-item" key={a.id}>
              <div className="agent-icon" style={{ background: a.color }}>
                <Icon name={a.icon} size={18} />
              </div>
              <div className="agent-info">
                <div className="agent-name">{a.name}</div>
                <div className="agent-desc">{a.desc}</div>
                <div className="agent-skills">
                  {a.skills.map((s) => (
                    <span className="workflow-skill-chip" key={s} title={s}>@{s}</span>
                  ))}
                </div>
              </div>
              <button
                className="btn-sm primary"
                onClick={() => startAgent(a)}
                title="插入角色指令与依赖技能到对话栏"
              ><Icon name="at" size={12} /> 调用</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
