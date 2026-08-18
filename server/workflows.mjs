const BUILTIN_WORKFLOWS = [
  { id: "wf-plan-doc", name: "规划报告全流程", icon: "doc", description: "调研→报告→图表→排版导出", skills: ["huashu-research", "traffic-report-comprehensive", "traffic-charts-template", "huashu-md-to-pdf"], steps: ["资料调研", "报告撰写", "图表生成", "排版导出"], output: "报告文档与 PDF" },
  { id: "wf-od-analysis", name: "OD 数据分析工作台", icon: "xls", description: "导入→校验→分析→可视化→报告", skills: ["od-workflow", "huashu-data-pro", "transport-chart-composition", "traffic-map-template"], steps: ["数据校验", "统计分析", "地图图表", "分析报告"], output: "图表、地图与分析报告" },
  { id: "wf-bus-plan", name: "公交规划专项", icon: "menu", description: "客流现状→方案→配图→汇报", skills: ["traffic-report-bus", "traffic-charts-template", "traffic-map-template", "traffic-report-briefing"], steps: ["现状分析", "方案编制", "配图", "汇报材料"], output: "专项规划与汇报材料" },
  { id: "wf-meeting-brief", name: "汇报材料速成", icon: "ppt", description: "简报→PPT→配图", skills: ["traffic-report-briefing", "huashu-slides", "baoyu-xhs-images", "gongzuo-huibao"], steps: ["简报", "PPT", "配图"], output: "汇报材料与演示文稿" },
];

export function listWorkflows(skills = []) {
  const names = new Set(skills.map((s) => s.name));
  return BUILTIN_WORKFLOWS.map((w) => ({ ...w, available: w.skills.filter((s) => names.has(s)), missing: w.skills.filter((s) => !names.has(s)), valid: w.skills.every((s) => names.has(s)) }));
}

export function getWorkflow(id, skills = []) {
  return listWorkflows(skills).find((w) => w.id === id) || null;
}

export function workflowIdFromText(text = "") {
  return String(text).match(/@工作流\[([^\]]+)\]/)?.[1]?.trim() || null;
}

export function workflowSteps(workflow) {
  return (workflow?.steps || []).map((name, index) => ({ id: `${workflow.id}:step-${index + 1}`, index, name, status: index === 0 ? "ready" : "pending", attempts: 0, startedAt: null, finishedAt: null, error: null }));
}
