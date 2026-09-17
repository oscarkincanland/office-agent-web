#!/usr/bin/env node
/**
 * 历史数据迁移审查（阶段七）：把历史会话、Run、成果与地图项目按
 * workspace 归属建立索引，输出可审计的迁移报告。
 *
 * 默认只读（dry-run），不移动、不修改任何数据：
 *   node server/迁移历史数据.mjs            # 人读报告
 *   node server/迁移历史数据.mjs --json     # JSON 报告
 *
 * 归属规则：
 *   - 会话：取 JSONL 首行 header.cwd；
 *   - Run：取 run.cwd；
 *   - 成果 / 记忆建议：取记录中的 cwd / workspace 字段；
 *   - 地图项目：固定属于默认工作区（office-workspace）；
 *   - 无法确定归属的记录进入 orphans，禁止自动恢复 / 发布 / 回滚。
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECT_DIR, WORKSPACE_DIR, normalizeWorkspace } from "./workspace.mjs";

const SESSIONS_DIR = path.join(PROJECT_DIR, ".规聚会话");
const RUNS_DIR = path.join(PROJECT_DIR, ".oaw", "runs");
const ARTIFACTS_FILE = path.join(PROJECT_DIR, ".oaw", "artifacts.json");
const PROPOSALS_FILE = path.join(PROJECT_DIR, ".oaw", "memory-proposals.json");
const MAPS_ROOT = path.join(WORKSPACE_DIR, "maps");

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function workspaceKey(value) {
  const normalized = normalizeWorkspace(value);
  return normalized ? normalized.toLowerCase().replace(/\\/g, "/") : null;
}

function scanSessions() {
  const result = { total: 0, byWorkspace: {}, orphans: [] };
  if (!fs.existsSync(SESSIONS_DIR)) return result;
  for (const name of fs.readdirSync(SESSIONS_DIR).filter((item) => item.endsWith(".jsonl"))) {
    result.total += 1;
    const fullPath = path.join(SESSIONS_DIR, name);
    let cwd = null;
    try {
      const firstLine = fs.readFileSync(fullPath, "utf8").split(/\r?\n/, 1)[0];
      cwd = JSON.parse(firstLine)?.cwd || null;
    } catch {}
    const key = workspaceKey(cwd);
    if (!key) {
      result.orphans.push({ file: name, reason: "缺少 header.cwd，无法确定工作区" });
      continue;
    }
    result.byWorkspace[key] = (result.byWorkspace[key] || 0) + 1;
  }
  return result;
}

function scanRuns() {
  const result = { total: 0, byWorkspace: {}, byStatus: {}, orphans: [] };
  if (!fs.existsSync(RUNS_DIR)) return result;
  for (const name of fs.readdirSync(RUNS_DIR).filter((item) => item.endsWith(".json") && item !== "写入清单.json")) {
    const run = readJson(path.join(RUNS_DIR, name));
    if (!run || typeof run !== "object" || !run.id) {
      result.orphans.push({ file: name, reason: "Run 记录损坏或缺少 id" });
      continue;
    }
    result.total += 1;
    const status = String(run.status || "unknown");
    result.byStatus[status] = (result.byStatus[status] || 0) + 1;
    const key = workspaceKey(run.cwd);
    if (!key) {
      result.orphans.push({ id: run.id, reason: "缺少 cwd，无法确定工作区" });
      continue;
    }
    result.byWorkspace[key] = (result.byWorkspace[key] || 0) + 1;
  }
  return result;
}

function scanArtifacts() {
  const store = readJson(ARTIFACTS_FILE, null);
  const list = Array.isArray(store) ? store : Array.isArray(store?.artifacts) ? store.artifacts : [];
  const result = { total: list.length, byWorkspace: {}, orphans: [] };
  for (const item of list) {
    const key = workspaceKey(item?.cwd || item?.workspace);
    if (!key) {
      result.orphans.push({ id: item?.id || item?.path || "(未知)", reason: "缺少 cwd/workspace 字段" });
      continue;
    }
    result.byWorkspace[key] = (result.byWorkspace[key] || 0) + 1;
  }
  return result;
}

function scanMemoryProposals() {
  const store = readJson(PROPOSALS_FILE, null);
  const list = Array.isArray(store) ? store : Array.isArray(store?.proposals) ? store.proposals : [];
  const result = { total: list.length, byWorkspace: {}, orphans: [] };
  for (const item of list) {
    const key = workspaceKey(item?.workspace);
    if (!key) {
      result.orphans.push({ id: item?.id || "(未知)", reason: "缺少 workspace（旧版记录）" });
      continue;
    }
    result.byWorkspace[key] = (result.byWorkspace[key] || 0) + 1;
  }
  return result;
}

function scanMapProjects() {
  const result = { total: 0, projects: [], defaultWorkspace: workspaceKey(WORKSPACE_DIR) };
  if (!fs.existsSync(MAPS_ROOT)) return result;
  for (const entry of fs.readdirSync(MAPS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const cfg = readJson(path.join(MAPS_ROOT, entry.name, "map.config.json"), null);
    if (!cfg) continue;
    result.total += 1;
    result.projects.push({
      project: cfg.project || entry.name,
      name: cfg.name || entry.name,
      archived: Boolean(cfg.archived),
      duplicatedFrom: cfg.duplicatedFrom || null,
    });
  }
  return result;
}

function main() {
  const asJson = process.argv.includes("--json");
  const report = {
    generatedAt: new Date().toISOString(),
    projectDir: PROJECT_DIR,
    defaultWorkspace: normalizeWorkspace(WORKSPACE_DIR),
    sessions: scanSessions(),
    runs: scanRuns(),
    artifacts: scanArtifacts(),
    memoryProposals: scanMemoryProposals(),
    maps: scanMapProjects(),
  };
  report.workspaces = new Set([
    ...Object.keys(report.sessions.byWorkspace),
    ...Object.keys(report.runs.byWorkspace),
    ...Object.keys(report.artifacts.byWorkspace),
    ...Object.keys(report.memoryProposals.byWorkspace),
  ]);
  report.workspaces = [...report.workspaces];
  report.orphanTotal =
    report.sessions.orphans.length + report.runs.orphans.length +
    report.artifacts.orphans.length + report.memoryProposals.orphans.length;

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const lines = [];
  lines.push("历史数据迁移审查（只读，不修改任何数据）");
  lines.push(`生成时间: ${report.generatedAt}`);
  lines.push(`默认工作区: ${report.defaultWorkspace}`);
  lines.push("");
  lines.push(`涉及工作区 (${report.workspaces.length}):`);
  for (const key of report.workspaces) lines.push(`  - ${key}`);
  lines.push("");
  lines.push(`会话: ${report.sessions.total} 条，孤儿 ${report.sessions.orphans.length} 条`);
  lines.push(`Run: ${report.runs.total} 条（${Object.entries(report.runs.byStatus).map(([k, v]) => `${k}:${v}`).join(" ") || "无"}），孤儿 ${report.runs.orphans.length} 条`);
  lines.push(`成果: ${report.artifacts.total} 条，孤儿 ${report.artifacts.orphans.length} 条`);
  lines.push(`记忆建议: ${report.memoryProposals.total} 条，孤儿 ${report.memoryProposals.orphans.length} 条`);
  lines.push(`地图项目: ${report.maps.total} 个（归属默认工作区）`);
  for (const item of report.maps.projects) {
    lines.push(`  - ${item.project}${item.archived ? "（已归档）" : ""}${item.duplicatedFrom ? `（复制自 ${item.duplicatedFrom}）` : ""}`);
  }
  lines.push("");
  if (report.orphanTotal > 0) {
    lines.push(`⚠ 孤儿记录 ${report.orphanTotal} 条：禁止自动恢复 / 发布 / 回滚，需人工确认归属后再迁移。`);
  } else {
    lines.push("所有记录均可确定工作区归属。");
  }
  console.log(lines.join("\n"));
}

main();
