import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PROJECT_DIR, WORKSPACE_DIR, normalizeWorkspace } from "./workspace.mjs";
import { atomicWriteJson, ensureDirectory } from "./持久化工具.mjs";

const PROJECTS_FILE = process.env.OAW_PROJECTS_FILE || path.join(PROJECT_DIR, ".oaw", "projects.json");
const PROJECT_TYPES = ["交通规划", "GIS / 地图分析", "调研报告", "Office 文档", "数据分析", "综合项目", "资料库"];
const PROJECT_STATUSES = ["进行中", "待整理", "已完成", "已归档", "模板项目"];
const PROJECT_PROFILES = ["通用 Agent", "创作", "研究", "Office", "GIS", "数据分析"];
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
  if (/gis|map|地图|空间/.test(text)) return "GIS / 地图分析";
  if (/交通|公交|\btransport\b|\bod\b/.test(text)) return "交通规划";
  if (/报告|research|调研/.test(text)) return "调研报告";
  if (/office|文档|word|excel|ppt/.test(text)) return "Office 文档";
  if (/资料|知识|knowledge|kb/.test(text)) return "资料库";
  return "综合项目";
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
  return next;
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
  return { ...DEFAULT_PROJECT_SETTINGS, skills: [] };
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
