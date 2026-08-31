import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { getRun } from "./runs.mjs";
import { appendEvent } from "./事件存储.mjs";
import { normalizeWorkspace } from "./workspace.mjs";
import { atomicWriteJson, ensureDirectory } from "./持久化工具.mjs";

const PROJECT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PUBLISHED_FILE = path.join(PROJECT_DIR, ".oaw", "artifacts.json");

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

export function listPublishedArtifacts({ cwd = "", projectId = "", limit = 200 } = {}) {
  const root = cwd ? normalizeWorkspace(cwd) : "";
  return readPublished()
    .filter((item) => (!root || item.cwd === root) && (!projectId || item.projectId === projectId))
    .sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")))
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 200)));
}

export function publishArtifact(runId, artifactId) {
  const run = getRun(runId);
  if (!run) return { ok: false, status: 404, error: "run not found" };
  if (run.status !== "completed") return { ok: false, status: 409, error: "只有已完成 Run 的成果可以固定" };
  const artifact = (run.artifacts || []).find((item) => item.artifactId === String(artifactId || ""));
  if (!artifact) return { ok: false, status: 404, error: "artifact not found" };
  if (artifact.status === "deleted") return { ok: false, status: 409, error: "已删除文件不能固定为成果" };
  if (artifact.verificationStatus === "failed") return { ok: false, status: 409, error: "产物校验失败，不能固定为正式成果" };

  const cwd = normalizeWorkspace(run.cwd);
  const relativePath = String(artifact.path || "").replace(/\\/g, "/");
  const target = cwd ? path.resolve(cwd, relativePath) : "";
  if (!cwd || !relativePath || !isInside(cwd, target)) return { ok: false, status: 400, error: "成果路径不在项目工作区内" };
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return { ok: false, status: 409, error: "成果文件不存在或不是文件" };

  const file = hashFile(target);
  const items = readPublished();
  const existing = items.find((item) => item.artifactId === artifact.artifactId && item.hash === file.hash);
  if (existing) return { ok: true, existing: true, artifact: existing };
  const versions = items
    .filter((item) => item.projectId === run.projectId && item.cwd === cwd && item.path === relativePath)
    .map((item) => Number(item.version) || 0);
  const published = {
    id: `publication_${crypto.randomUUID()}`,
    artifactId: artifact.artifactId,
    runId: run.id,
    sessionId: run.sessionId || null,
    projectId: run.projectId || null,
    cwd,
    path: relativePath,
    version: Math.max(0, ...versions) + 1,
    hash: file.hash,
    size: file.size,
    verificationStatus: artifact.verificationStatus || "not_checked",
    publishedAt: new Date().toISOString(),
  };
  items.push(published);
  savePublished(items);
  appendEvent({ clientId: run.clientId, threadId: run.threadId, runId: run.id, type: "artifact_published", data: published });
  return { ok: true, artifact: published };
}
