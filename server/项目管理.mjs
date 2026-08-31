import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PROJECT_DIR, WORKSPACE_DIR, normalizeWorkspace } from "./workspace.mjs";
import { atomicWriteJson, ensureDirectory } from "./持久化工具.mjs";

const PROJECTS_FILE = path.join(PROJECT_DIR, ".oaw", "projects.json");
const PROJECT_TYPES = ["交通规划", "GIS / 地图分析", "调研报告", "Office 文档", "数据分析", "综合项目", "资料库"];
const PROJECT_STATUSES = ["进行中", "待整理", "已完成", "已归档", "模板项目"];

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

export function listProjectTypes() {
  return [...PROJECT_TYPES];
}

export function listProjectStatuses() {
  return [...PROJECT_STATUSES];
}

/** 确保一个工作区有稳定的项目对象；兼容现有未迁移的 workspace。 */
export function ensureProjectForWorkspace(rootPath = WORKSPACE_DIR, options = {}) {
  const real = normalizeWorkspace(rootPath);
  if (!real) return null;
  const projects = readProjects();
  const existing = projects.find((project) => project.rootPath === real);
  if (existing) return existing;
  const timestamp = now();
  const project = {
    id: projectIdFor(real),
    name: String(options.name || path.basename(real) || "未命名项目"),
    type: normalizeType(options.type, options.name || path.basename(real), real),
    status: normalizeStatus(options.status),
    rootPath: real,
    description: String(options.description || ""),
    pinned: Boolean(options.pinned),
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  projects.push(project);
  saveProjects(projects);
  return project;
}

export function listProjects() {
  const projects = readProjects();
  const defaultProject = ensureProjectForWorkspace(WORKSPACE_DIR, { name: "默认工作区" });
  const all = defaultProject && !projects.some((project) => project.id === defaultProject.id)
    ? [...projects, defaultProject]
    : projects;
  return all.sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
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

export function createProject({ name, rootPath, type, status, description } = {}) {
  const cleanName = String(name || "").trim();
  const real = normalizeWorkspace(rootPath);
  if (!cleanName) return { ok: false, error: "项目名称不能为空" };
  if (!real) return { ok: false, error: "项目工作区不存在或不是文件夹" };
  const projects = readProjects();
  const existing = projects.find((project) => project.rootPath === real);
  if (existing) return { ok: true, project: existing, existing: true };
  const timestamp = now();
  const project = {
    id: projectIdFor(real),
    name: cleanName,
    type: normalizeType(type, cleanName, real),
    status: normalizeStatus(status),
    rootPath: real,
    description: String(description || ""),
    pinned: false,
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
  if (patch.status === "已归档") project.archivedAt ||= now();
  if (patch.status && patch.status !== "已归档") project.archivedAt = null;
  project.updatedAt = now();
  saveProjects(projects);
  return { ok: true, project };
}

export function archiveProject(id, archived = true) {
  return updateProject(id, { status: archived ? "已归档" : "进行中" });
}
