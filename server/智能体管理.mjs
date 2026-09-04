import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PROJECT_DIR } from "./workspace.mjs";
import { atomicWriteJson, ensureDirectory } from "./持久化工具.mjs";

const AGENTS_FILE = process.env.OAW_AGENTS_FILE || path.join(PROJECT_DIR, ".oaw", "agents.json");

export const BUILTIN_AGENTS = Object.freeze([
  {
    id: "agent-gongwen",
    name: "公文报告编制助手",
    icon: "doc",
    description: "按公文/报告版面规范撰写政府公文、汇报材料、规划报告，输出规范 .docx",
    skills: ["gongwen-banmian", "traffic-report-briefing", "traffic-report-comprehensive", "md-to-docx"],
    prompt: "你现在是公文报告编制助手：请按公文版面规范撰写/修订公文或报告，输出规范 .docx，注意标题层级、字体字号、段落格式与附件清单。",
    color: "#b7791f",
    builtin: true,
  },
  {
    id: "agent-map",
    name: "地图可视化助手",
    icon: "locate",
    description: "OD 期望线、站点分布、流向图、等时圈等交通地图可视化，单文件 HTML 开箱即用",
    skills: ["traffic-map-template", "od-workflow", "transport-chart-geospatial", "tanstack-charts-overview"],
    prompt: "你现在是地图可视化助手：基于数据生成交通专题地图（OD期望线/站点/热力/等时圈等），输出单文件 HTML，使用 MapTiler 卫星底图，注意坐标系为中国范围。",
    color: "#2a8c82",
    builtin: true,
  },
  {
    id: "agent-review",
    name: "文本审查助手",
    icon: "search",
    description: "公文/报告/论文的错别字、语病、格式、术语一致性、逻辑结构审查",
    skills: ["huashu-proofreading", "humanizer-zh", "every-style-editor", "text-summarizer"],
    prompt: "你现在是文本审查助手：逐段审查文本的错别字/语病/格式/术语一致性/逻辑结构，输出审查意见清单（问题位置+修改建议），不直接改稿。",
    color: "#5c7a1f",
    builtin: true,
  },
  {
    id: "agent-data",
    name: "数据分析及可视化助手",
    icon: "xls",
    description: "Excel/OD/客流数据统计分析、图表生成（ECharts）、报告输出",
    skills: ["huashu-data-pro", "od-workflow", "traffic-charts-template", "echarts-pie-charts"],
    prompt: "你现在是数据分析及可视化助手：对表格/OD/客流数据做统计分析，验证数据完整性，生成 ECharts 图表与结论性分析，输出图表 HTML 与说明。",
    color: "#2a8c82",
    builtin: true,
  },
]);

function readCustomAgents() {
  try {
    const value = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf8"));
    return Array.isArray(value) ? value.filter((item) => item && item.id && !BUILTIN_AGENTS.some((builtin) => builtin.id === item.id)) : [];
  } catch {
    return [];
  }
}

function saveCustomAgents(agents) {
  ensureDirectory(path.dirname(AGENTS_FILE));
  atomicWriteJson(AGENTS_FILE, agents);
}

function cleanAgent(input = {}, previous = {}) {
  const name = String(input.name ?? previous.name ?? "").trim();
  const description = String(input.description ?? previous.description ?? "").trim();
  const prompt = String(input.prompt ?? previous.prompt ?? "").trim();
  const skills = [...new Set((Array.isArray(input.skills) ? input.skills : previous.skills || [])
    .map((item) => String(typeof item === "object" ? item?.name : item || "").trim()).filter(Boolean))];
  if (!name) return { ok: false, error: "智能体名称不能为空" };
  if (!prompt) return { ok: false, error: "智能体指令不能为空" };
  if (name.length > 80 || description.length > 300 || prompt.length > 8000 || skills.length > 30) return { ok: false, error: "智能体配置超出长度限制" };
  return {
    ok: true,
    agent: {
      id: String(input.id ?? previous.id ?? `agent-${crypto.randomUUID()}`),
      name,
      icon: String(input.icon ?? previous.icon ?? "robot"),
      description,
      skills,
      prompt,
      color: String(input.color ?? previous.color ?? "#638e2d"),
      builtin: false,
      updatedAt: new Date().toISOString(),
    },
  };
}

export function listAgents() {
  return [...BUILTIN_AGENTS.map((item) => ({ ...item })), ...readCustomAgents()];
}

export function createAgent(input = {}) {
  const result = cleanAgent(input);
  if (!result.ok) return result;
  const custom = readCustomAgents();
  custom.push(result.agent);
  saveCustomAgents(custom);
  return { ok: true, agent: result.agent };
}

export function updateAgent(id, patch = {}) {
  const custom = readCustomAgents();
  const index = custom.findIndex((item) => item.id === String(id || ""));
  if (index < 0) return { ok: false, error: "自定义智能体不存在或内置智能体不可编辑" };
  const result = cleanAgent({ ...patch, id: custom[index].id }, custom[index]);
  if (!result.ok) return result;
  custom[index] = result.agent;
  saveCustomAgents(custom);
  return { ok: true, agent: result.agent };
}

export function deleteAgent(id) {
  const target = String(id || "");
  if (BUILTIN_AGENTS.some((item) => item.id === target)) return { ok: false, error: "内置智能体不可删除" };
  const custom = readCustomAgents();
  const next = custom.filter((item) => item.id !== target);
  if (next.length === custom.length) return { ok: false, error: "自定义智能体不存在" };
  saveCustomAgents(next);
  return { ok: true, id: target };
}
