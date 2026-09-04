import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PROJECT_DIR, WORKSPACE_DIR, normalizeWorkspace } from "./workspace.mjs";
import { atomicWriteJson, ensureDirectory } from "./持久化工具.mjs";

const PROJECTS_FILE = process.env.OAW_PROJECTS_FILE || path.join(PROJECT_DIR, ".oaw", "projects.json");
const PROJECT_TYPES = ["交通规划", "GIS / 地图分析", "调研报告", "Office 文档", "数据分析", "综合项目", "资料库"];
const PROJECT_STATUSES = ["进行中", "待整理", "已完成", "已归档", "模板项目"];
const PROJECT_PROFILES = ["通用 Agent", "创作", "研究", "Office", "GIS", "数据分析"];
const PROFILE_POLICIES = Object.freeze({
  "通用 Agent": { description: "完整工具链，按任务计划执行", allowedModes: ["chat", "agent"], preferredTools: ["read", "write", "edit", "bash", "officecli", "memory_update"], thinking: "medium", maxContextTokens: 64000, approval: "危险写入前确认", outputDir: "当前工作区" },
  "创作": { description: "优先模板、素材和 Office 产出", allowedModes: ["chat", "agent"], preferredTools: ["read", "officecli", "write", "edit", "skills_read", "memory_update"], thinking: "medium", maxContextTokens: 48000, approval: "产物固定前确认", outputDir: "当前工作区" },
  "研究": { description: "优先知识库、资料和可追溯引用", allowedModes: ["chat", "agent"], preferredTools: ["read", "grep", "find", "kb_search", "kb_read", "skills_search", "skills_read", "memory_update"], thinking: "high", maxContextTokens: 96000, approval: "记忆沉淀前确认", outputDir: "当前工作区" },
  Office: { description: "优先 Office CLI，限制通用脚本写入", allowedModes: ["chat", "office", "agent"], preferredTools: ["read", "officecli", "skills_read"], thinking: "medium", maxContextTokens: 64000, approval: "文档写入前确认", outputDir: "当前工作区" },
  GIS: { description: "优先地图、空间数据和分析产出", allowedModes: ["chat", "agent"], preferredTools: ["read", "map_read", "map_edit", "map_import", "map_analyze", "map_save_analysis", "officecli"], thinking: "high", maxContextTokens: 64000, approval: "图层写入前确认", outputDir: "当前工作区" },
  "数据分析": { description: "优先数据读取、校验和图表产出", allowedModes: ["chat", "agent"], preferredTools: ["read", "grep", "find", "bash", "write", "edit", "officecli", "memory_update"], thinking: "high", maxContextTokens: 64000, approval: "数据覆盖前确认", outputDir: "当前工作区" },
});
const DEFAULT_PROJECT_SETTINGS = Object.freeze({
  defaultModel: "",
  agentProfile: "通用 Agent",
  skills: [],
  memoryPolicy: "approval_required",
  artifactPolicy: "validation_required",
});

function now() { return new Date().toISOString(); }

function readProjects() {
  try {
    const value = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveProjects(projects) {
  ensureDirectory(path.dirname(PROJECTS_FILE));
  atomicWriteJson(PROJECTS_FILE, projects);
}

function projectIdFor(rootPath) {
  return `project-${crypto.createHash("sha1").update(rootPath).digest("hex").slice(0, 12)}`;
}

function inferType(name, rootPath) {
  const text = String(name || path.basename(rootPath) || "").toLowerCase();
  if (/gis|map|geo(?:json)?|地图|空间/.test(text)) return "GIS / 地图分析";
  if (/交通|公交|水运|物流|\btransport\b|\bod\b/.test(text)) return "交通规划";
  if (/报告|research|调研/.test(text)) return "调研报告";
  if (/office|文档|word|excel|ppt/.test(text)) return "Office 文档";
  if (/资料|知识|knowledge|kb/.test(text)) return "资料库";
  return "综合项目";
}

/**
 * 为历史上统一落成“综合项目”的工作区生成可解释的分类建议。
 * 默认只返回预览；只有调用方明确 apply=true 才会写回 projects.json。
 */
export function classifyProjects({ apply = false } = {}) {
  const projects = readProjects();
  const changes = projects.map((project) => {
    const suggestedType = inferType(project.name, project.rootPath);
    const eligible = !project.type || project.type === "综合项目";
    return {
      id: project.id,
      name: project.name,
      currentType: project.type || "综合项目",
      suggestedType: eligible ? suggestedType : project.type,
      changed: Boolean(eligible && suggestedType !== (project.type || "综合项目")),
      applied: false,
    };
  });
  if (!apply) return { ok: true, applied: false, changes };
  let changed = 0;
  for (const item of changes) {
    if (!item.changed) continue;
    const project = projects.find((candidate) => candidate.id === item.id);
    if (!project) continue;
    project.type = item.suggestedType;
    project.updatedAt = now();
    item.applied = true;
    changed += 1;
  }
  if (changed) saveProjects(projects);
  return { ok: true, applied: true, changed, changes };
}

function normalizeType(type, name, rootPath) {
  return PROJECT_TYPES.includes(type) ? type : inferType(name, rootPath);
}

function normalizeStatus(status) {
  return PROJECT_STATUSES.includes(status) ? status : "进行中";
}

function normalizeSettings(settings = {}) {
  const next = { ...DEFAULT_PROJECT_SETTINGS, ...(settings && typeof settings === "object" ? settings : {}) };
  next.defaultModel = String(next.defaultModel || "").trim();
  next.agentProfile = PROJECT_PROFILES.includes(next.agentProfile) ? next.agentProfile : DEFAULT_PROJECT_SETTINGS.agentProfile;
  next.skills = [...new Set((Array.isArray(next.skills) ? next.skills : []).map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 50);
  next.memoryPolicy = next.memoryPolicy === "manual" ? "manual" : "approval_required";
  next.artifactPolicy = next.artifactPolicy === "manual" ? "manual" : "validation_required";
  next.profilePolicy = profilePolicyFor(next.agentProfile);
  return next;
}

export function profilePolicyFor(profile = "通用 Agent") {
  const selected = PROFILE_POLICIES[String(profile)] || PROFILE_POLICIES["通用 Agent"];
  return { ...selected, allowedModes: [...selected.allowedModes], preferredTools: [...selected.preferredTools] };
}

export function listProjectTypes() {
  return [...PROJECT_TYPES];
}

export function listProjectStatuses() {
  return [...PROJECT_STATUSES];
}

export function listProjectProfiles() {
  return [...PROJECT_PROFILES];
}

export function defaultProjectSettings() {
  return { ...DEFAULT_PROJECT_SETTINGS, skills: [], profilePolicy: profilePolicyFor(DEFAULT_PROJECT_SETTINGS.agentProfile) };
}

/** 确保一个工作区有稳定的项目对象；兼容现有未迁移的 workspace。 */
export function ensureProjectForWorkspace(rootPath = WORKSPACE_DIR, options = {}) {
  const real = normalizeWorkspace(rootPath);
  if (!real) return null;
  const projects = readProjects();
  const existing = projects.find((project) => project.rootPath === real);
  if (existing) {
    if (!existing.settings) {
      existing.settings = defaultProjectSettings();
      existing.updatedAt ||= now();
      saveProjects(projects);
    }
    return { ...existing, settings: normalizeSettings(existing.settings) };
  }
  const timestamp = now();
  const project = {
    id: projectIdFor(real),
    name: String(options.name || path.basename(real) || "未命名项目"),
    type: normalizeType(options.type, options.name || path.basename(real), real),
    status: normalizeStatus(options.status),
    rootPath: real,
    description: String(options.description || ""),
    pinned: Boolean(options.pinned),
    settings: normalizeSettings(options.settings),
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  projects.push(project);
  saveProjects(projects);
  return { ...project, settings: normalizeSettings(project.settings) };
}

export function listProjects({ type = "", status = "", pinned = null, sort = "recent" } = {}) {
  const projects = readProjects();
  const defaultProject = ensureProjectForWorkspace(WORKSPACE_DIR, { name: "默认工作区" });
  const all = defaultProject && !projects.some((project) => project.id === defaultProject.id)
    ? [...projects, defaultProject]
    : projects;
  const filtered = all
    .map((project) => ({ ...project, settings: normalizeSettings(project.settings) }))
    .filter((project) => !type || project.type === type)
    .filter((project) => !status || project.status === status)
    .filter((project) => pinned === null || Boolean(project.pinned) === Boolean(pinned));
  return filtered.sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    if (sort === "name") return String(a.name || "").localeCompare(String(b.name || ""));
    if (sort === "created") return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });
}

export function getProject(id) {
  return listProjects().find((project) => project.id === String(id || "")) || null;
}

export function getProjectForWorkspace(rootPath) {
  const real = normalizeWorkspace(rootPath);
  if (!real) return null;
  return listProjects().find((project) => project.rootPath === real) || null;
}

export function createProject({ name, rootPath, type, status, description, settings } = {}) {
  const cleanName = String(name || "").trim();
  const real = normalizeWorkspace(rootPath);
  if (!cleanName) return { ok: false, error: "项目名称不能为空" };
  if (!real) return { ok: false, error: "项目工作区不存在或不是文件夹" };
  const projects = readProjects();
  const existing = projects.find((project) => project.rootPath === real);
  if (existing) return { ok: true, project: { ...existing, settings: normalizeSettings(existing.settings) }, existing: true };
  const timestamp = now();
  const project = {
    id: projectIdFor(real),
    name: cleanName,
    type: normalizeType(type, cleanName, real),
    status: normalizeStatus(status),
    rootPath: real,
    description: String(description || ""),
    pinned: false,
    settings: normalizeSettings(settings),
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  projects.push(project);
  saveProjects(projects);
  return { ok: true, project };
}

export function updateProject(id, patch = {}) {
  const projects = readProjects();
  const project = projects.find((item) => item.id === String(id || ""));
  if (!project) return { ok: false, error: "project not found" };
  if (patch.name !== undefined && String(patch.name).trim()) project.name = String(patch.name).trim();
  if (PROJECT_TYPES.includes(patch.type)) project.type = patch.type;
  if (PROJECT_STATUSES.includes(patch.status)) project.status = patch.status;
  if (patch.description !== undefined) project.description = String(patch.description || "");
  if (patch.pinned !== undefined) project.pinned = Boolean(patch.pinned);
  if (patch.settings !== undefined) project.settings = normalizeSettings({ ...project.settings, ...patch.settings });
  if (patch.status === "已归档") project.archivedAt ||= now();
  if (patch.status && patch.status !== "已归档") project.archivedAt = null;
  project.updatedAt = now();
  saveProjects(projects);
  return { ok: true, project };
}

export function getProjectSettings(id) {
  const project = getProject(id);
  return project ? { ...defaultProjectSettings(), ...normalizeSettings(project.settings) } : null;
}

export function updateProjectSettings(id, patch = {}) {
  const result = updateProject(id, { settings: patch });
  return result.ok ? { ...result, settings: result.project.settings } : result;
}

export function archiveProject(id, archived = true) {
  return updateProject(id, { status: archived ? "已归档" : "进行中" });
}
