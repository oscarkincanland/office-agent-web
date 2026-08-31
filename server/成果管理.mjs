import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { getRun, updateRunAcceptance } from "./runs.mjs";
import { appendEvent } from "./事件存储.mjs";
import { normalizeWorkspace } from "./workspace.mjs";
import { atomicWriteJson, ensureDirectory } from "./持久化工具.mjs";
import { withWriteLock } from "./写入协调.mjs";
import { evaluateRunArtifacts } from "./成果验收.mjs";

const PROJECT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PUBLISHED_FILE = path.join(PROJECT_DIR, ".oaw", "artifacts.json");
const RUNS_DIR = process.env.OAW_RUNS_DIR || path.join(PROJECT_DIR, ".oaw", "runs");

function readPublished() {
  try {
    const value = JSON.parse(fs.readFileSync(PUBLISHED_FILE, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function savePublished(items) {
  ensureDirectory(path.dirname(PUBLISHED_FILE));
  atomicWriteJson(PUBLISHED_FILE, items.slice(-1000));
}

function isInside(root, target) {
  const base = path.resolve(root);
  const full = path.resolve(target);
  return full === base || full.startsWith(base + path.sep);
}

function hashFile(file) {
  const hash = crypto.createHash("sha1");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    let count = 0;
    do {
      count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count) {
        hash.update(buffer.subarray(0, count));
        size += count;
      }
    } while (count);
    return { hash: hash.digest("hex"), size };
  } finally {
    fs.closeSync(fd);
  }
}

function publicationRun(publication) {
  return getRun(publication?.runId || publication?.sourceRunId);
}

export function listPublishedArtifacts({ cwd = "", projectId = "", limit = 200 } = {}) {
  const root = cwd ? normalizeWorkspace(cwd) : "";
  return readPublished()
    .filter((item) => (!root || item.cwd === root) && (!projectId || item.projectId === projectId))
    .sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")))
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 200)));
}

export async function inspectRunAcceptance(runId, rules = {}) {
  const run = getRun(runId);
  if (!run) return { ok: false, status: 404, error: "run not found" };
  const acceptance = await evaluateRunArtifacts(run, { rules });
  const previous = run.acceptance;
  const previousByPath = new Map((previous?.artifacts || []).map((item) => [String(item.path || "").replace(/\\/g, "/"), item]));
  acceptance.artifacts = acceptance.artifacts.map((item) => {
    const old = previousByPath.get(String(item.path || "").replace(/\\/g, "/"));
    const groups = item.checks || {};
    const automaticFailed = [groups.structure, groups.content, groups.visual].some((group) => group?.status === "failed");
    if (!old?.manualConfirmation || !old.fileHash || old.fileHash !== item.fileHash || automaticFailed) return item;
    return {
      ...item,
      status: "passed",
      readyToPublish: true,
      summary: "自动验收结果未变化，沿用已完成人工确认",
      checks: {
        ...groups,
        manual: { status: "passed", required: false, checks: [{ id: "manual-confirmation", status: "passed", message: old.manualConfirmation.note || "人工确认通过", ...old.manualConfirmation }] },
      },
      manualConfirmation: old.manualConfirmation,
    };
  });
  const hasFailed = acceptance.artifacts.some((item) => item.status === "failed");
  const allReady = acceptance.artifacts.length > 0 && acceptance.artifacts.every((item) => item.readyToPublish);
  acceptance.status = hasFailed ? "failed" : allReady ? "passed" : "manual_review";
  acceptance.readyToPublish = allReady;
  const saved = updateRunAcceptance(run.id, acceptance) || run;
  return { ok: true, run: saved, acceptance: saved.acceptance || acceptance };
}

function acceptanceItem(run, artifactId) {
  const artifact = (run.artifacts || []).find((item) => item.artifactId === String(artifactId || ""));
  const item = (run.acceptance?.artifacts || []).find((result) => String(result.path || "").replace(/\\/g, "/") === String(artifact?.path || "").replace(/\\/g, "/"));
  return { artifact, item };
}

export async function confirmArtifactAcceptance(runId, artifactId, { note = "", operator = "本地用户", rules = {} } = {}) {
  const inspected = await inspectRunAcceptance(runId, rules);
  if (!inspected.ok) return inspected;
  const run = inspected.run;
  const found = acceptanceItem(run, artifactId);
  if (!found.artifact || !found.item) return { ok: false, status: 404, error: "artifact not found" };
  if (found.artifact.status === "deleted") return { ok: false, status: 409, error: "已删除文件不能验收" };
  const groups = found.item.checks || {};
  const failed = [groups.structure, groups.content, groups.visual].some((item) => item?.status === "failed");
  if (failed) return { ok: false, status: 409, error: "存在自动验收失败项，人工确认不能覆盖失败", acceptance: run.acceptance };
  const now = new Date().toISOString();
  const confirmed = {
    ...found.item,
    status: "passed",
    readyToPublish: true,
    summary: "自动验收后已完成人工确认",
    checks: {
      ...groups,
      manual: {
        status: "passed",
        required: false,
        checks: [{ id: "manual-confirmation", status: "passed", message: note.trim() || "人工确认通过", operator, confirmedAt: now }],
      },
    },
    manualConfirmation: { operator, note: note.trim(), confirmedAt: now },
  };
  const acceptance = {
    ...run.acceptance,
    status: run.acceptance?.artifacts?.every((item) => item.path === confirmed.path || item.readyToPublish) ? "passed" : "manual_review",
    readyToPublish: (run.acceptance?.artifacts || []).every((item) => item.path === confirmed.path ? confirmed.readyToPublish : item.readyToPublish),
    artifacts: (run.acceptance?.artifacts || []).map((item) => item.path === confirmed.path ? confirmed : item),
    checkedAt: now,
  };
  const saved = updateRunAcceptance(run.id, acceptance) || run;
  return { ok: true, run: saved, acceptance: saved.acceptance };
}

export async function publishArtifact(runId, artifactId, { rules = {}, operator = "本地用户" } = {}) {
  const initial = getRun(runId);
  if (!initial) return { ok: false, status: 404, error: "run not found" };
  if (initial.status !== "completed") return { ok: false, status: 409, error: "只有已完成 Run 的成果可以固定" };
  const inspected = await inspectRunAcceptance(runId, rules);
  if (!inspected.ok) return inspected;
  const run = inspected.run;
  const { artifact, item } = acceptanceItem(run, artifactId);
  if (!artifact) return { ok: false, status: 404, error: "artifact not found" };
  if (artifact.status === "deleted") return { ok: false, status: 409, error: "已删除文件不能固定为成果" };
  if (!item?.readyToPublish) {
    const message = item?.status === "failed" ? "产物验收失败，不能固定为正式成果" : "产物仍需人工确认，不能固定为正式成果";
    return { ok: false, status: 409, error: message, acceptance: run.acceptance };
  }

  const cwd = normalizeWorkspace(run.cwd);
  const relativePath = String(artifact.path || "").replace(/\\/g, "/");
  const target = cwd ? path.resolve(cwd, relativePath) : "";
  if (!cwd || !relativePath || !isInside(cwd, target)) return { ok: false, status: 400, error: "成果路径不在项目工作区内" };
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return { ok: false, status: 409, error: "成果文件不存在或不是文件" };

  const file = hashFile(target);
  const items = readPublished();
  const existing = items.find((entry) => entry.artifactId === artifact.artifactId && entry.hash === file.hash && entry.status !== "rolled_back");
  if (existing) return { ok: true, existing: true, artifact: existing, acceptance: item };
  const previous = items
    .filter((entry) => entry.projectId === run.projectId && entry.cwd === cwd && entry.path === relativePath && entry.status !== "rolled_back")
    .sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0))[0] || null;
  const published = {
    id: `publication_${crypto.randomUUID()}`,
    artifactId: artifact.artifactId,
    sourceArtifactId: artifact.artifactId,
    runId: run.id,
    sourceRunId: run.id,
    sessionId: run.sessionId || null,
    projectId: run.projectId || null,
    cwd,
    path: relativePath,
    version: Math.max(0, ...items.filter((entry) => entry.projectId === run.projectId && entry.cwd === cwd && entry.path === relativePath).map((entry) => Number(entry.version) || 0)) + 1,
    hash: file.hash,
    size: file.size,
    status: "active",
    acceptanceStatus: item.status,
    verificationStatus: "passed",
    acceptance: item,
    diffSummary: {
      changeType: artifact.status || "modified",
      from: artifact.from || null,
      beforeSize: artifact.before?.size ?? null,
      afterSize: artifact.after?.size ?? file.size,
      sizeDelta: artifact.before?.size == null ? null : file.size - artifact.before.size,
    },
    publisher: operator,
    rollbackTarget: previous?.id || null,
    publishedAt: new Date().toISOString(),
  };
  items.push(published);
  savePublished(items);
  appendEvent({ clientId: run.clientId, threadId: run.threadId, runId: run.id, type: "artifact_published", data: published });
  return { ok: true, artifact: published, acceptance: item };
}

function rollbackPublishedArtifactUnlocked(publicationId, operator) {
  const items = readPublished();
  const current = items.find((item) => item.id === String(publicationId || ""));
  if (!current) return { ok: false, status: 404, error: "publication not found" };
  if (!current.rollbackTarget) return { ok: false, status: 409, error: "没有可回滚的历史版本" };
  const targetPublication = items.find((item) => item.id === current.rollbackTarget);
  if (!targetPublication) return { ok: false, status: 409, error: "回滚目标版本不存在" };
  const run = publicationRun(targetPublication);
  if (!run) return { ok: false, status: 409, error: "回滚目标来源 Run 不存在" };
  const cwd = normalizeWorkspace(current.cwd || run.cwd);
  const relativePath = String(current.path || "").replace(/\\/g, "/");
  const target = path.resolve(cwd, relativePath);
  const source = path.join(RUNS_DIR, String(targetPublication.runId || targetPublication.sourceRunId), "after", relativePath);
  if (!isInside(cwd, target) || !fs.existsSync(source)) return { ok: false, status: 409, error: "回滚目标文件不可读取" };
  ensureDirectory(path.dirname(target));
  fs.copyFileSync(source, target);
  current.status = "rolled_back";
  current.rolledBackTo = targetPublication.id;
  current.rolledBackAt = new Date().toISOString();
  current.rolledBackBy = operator;
  targetPublication.status = "active";
  savePublished(items);
  appendEvent({ clientId: run.clientId, threadId: run.threadId, runId: run.id, type: "artifact_rolled_back", data: { publicationId: current.id, targetPublicationId: targetPublication.id, path: relativePath, operator } });
  return { ok: true, artifact: targetPublication, rolledBack: current };
}

export function rollbackPublishedArtifact(publicationId, { operator = "本地用户" } = {}) {
  const publication = readPublished().find((item) => item.id === String(publicationId || ""));
  const run = publication ? publicationRun(publication) : null;
  try {
    return withWriteLock({ workspace: run?.cwd || publication?.cwd || "", targetPath: run?.cwd || publication?.cwd || "", runId: `publication_rollback_${publicationId}`, threadId: run?.threadId || null, kind: "publication_rollback" }, () => rollbackPublishedArtifactUnlocked(publicationId, operator));
  } catch (error) {
    return { ok: false, status: 409, error: error?.message || String(error) };
  }
}
