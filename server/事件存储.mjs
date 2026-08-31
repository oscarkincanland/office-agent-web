import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { appendJsonLine, atomicWriteJson, ensureDirectory } from "./持久化工具.mjs";

const PROJECT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const EVENT_DIR = path.join(PROJECT_DIR, ".oaw", "events");
const EVENT_FILE = path.join(EVENT_DIR, "事件流.jsonl");
const READ_CURSOR_FILE = path.join(EVENT_DIR, "阅读游标.json");
const MAX_MEMORY_EVENTS = 20000;
const MAX_DATA_STRING = 8000;

// token/thinking/tool_output 属于高频流式事件，仍由当前会话 SSE 实时发送，
// 但不写入根级 Store，避免长任务把持久日志膨胀成不可用的副作用。
const PERSISTED_TYPES = new Set([
  "run_started", "run_recovered", "run_cancel_requested", "run_recovery_started",
  "prompt", "capability_plan", "mode_policy", "tool_start", "tool_end", "ask_user",
  "agent_retry", "agent_retry_end", "agent_error", "assistant_final", "agent_end",
  "aborted", "context_compacted", "file_changed", "agent_summary", "step_updated", "artifact_published", "run_finished",
  "write_started", "write_locked", "write_rejected", "artifact_staged", "artifact_materialized", "write_cleaned",
  "memory_proposal_created", "memory_proposal_edited", "memory_proposal_rejected", "memory_proposal_approved",
  "memory_proposal_merged", "memory_proposal_failed", "memory_written",
  "memory_file_edited", "memory_initialized",
]);

const emitter = new EventEmitter();
emitter.setMaxListeners(0);
let loaded = false;
let nextSeq = 0;
let events = [];

function ensureStore() {
  ensureDirectory(EVENT_DIR);
}

function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? {}, (_key, item) => {
      if (typeof item === "string" && item.length > MAX_DATA_STRING) return `${item.slice(0, MAX_DATA_STRING)}…[截断]`;
      return item;
    }));
  } catch {
    return { text: String(value ?? "") };
  }
}

function loadStore() {
  if (loaded) return;
  loaded = true;
  ensureStore();
  try {
    const lines = fs.readFileSync(EVENT_FILE, "utf8").split(/\r?\n/).filter(Boolean);
    const parsed = [];
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (!item || !Number.isFinite(Number(item.seq))) continue;
        parsed.push(item);
        nextSeq = Math.max(nextSeq, Number(item.seq));
      } catch {}
    }
    events = parsed.slice(-MAX_MEMORY_EVENTS);
  } catch {}
}

export function shouldPersistEvent(type) {
  return PERSISTED_TYPES.has(String(type || ""));
}

export function appendEvent({ clientId = null, threadId = null, runId = null, type, data = {}, at = new Date().toISOString() } = {}) {
  if (!shouldPersistEvent(type)) return null;
  loadStore();
  const event = {
    eventId: `event_${crypto.randomUUID()}`,
    seq: ++nextSeq,
    at,
    clientId: clientId || null,
    threadId: threadId || null,
    runId: runId || null,
    type: String(type),
    data: safeJson(data),
  };
  try {
    appendJsonLine(EVENT_FILE, event);
  } catch (error) {
    // Store 写入失败不能阻断 Agent 当前回合；内存事件仍让当前 UI 可见。
    console.warn("[events] 持久化事件失败：", error?.message || error);
  }
  events.push(event);
  if (events.length > MAX_MEMORY_EVENTS) events = events.slice(-MAX_MEMORY_EVENTS);
  emitter.emit("event", event);
  return event;
}

export function listEvents({ after = 0, clientId = "", threadId = "", runId = "", limit = 500 } = {}) {
  loadStore();
  const n = Number(after) || 0;
  const filtered = events.filter((event) =>
    Number(event.seq) > n &&
    (!clientId || event.clientId === clientId) &&
    (!threadId || event.threadId === threadId) &&
    (!runId || event.runId === runId)
  );
  const max = Math.max(1, Math.min(2000, Number(limit) || 500));
  return {
    events: filtered.slice(-max),
    latest: nextSeq,
    earliest: events[0]?.seq || nextSeq,
    truncated: n > 0 && events.length > 0 && n < Number(events[0].seq),
  };
}

export function subscribeEvents(listener) {
  loadStore();
  emitter.on("event", listener);
  return () => emitter.off("event", listener);
}

function readCursors() {
  try { return JSON.parse(fs.readFileSync(READ_CURSOR_FILE, "utf8")) || {}; } catch { return {}; }
}

export function getReadCursor(clientId = "") {
  if (!clientId) return 0;
  return Number(readCursors()[clientId] || 0);
}

export function markReadCursor(clientId = "", seq = 0) {
  if (!clientId) return { ok: false, error: "clientId required" };
  loadStore();
  ensureStore();
  const cursors = readCursors();
  const requested = Math.max(0, Number(seq) || 0);
  cursors[clientId] = Math.max(Number(cursors[clientId] || 0), Math.min(requested, nextSeq));
  atomicWriteJson(READ_CURSOR_FILE, cursors);
  return { ok: true, clientId, seq: cursors[clientId] };
}

export function eventStoreInfo() {
  loadStore();
  return { file: EVENT_FILE, latest: nextSeq, earliest: events[0]?.seq || nextSeq, count: events.length };
}
