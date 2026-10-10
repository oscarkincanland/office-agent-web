/**
 * SSE 长连接登记表（服务端侧）。
 *
 * 为什么需要它：浏览器同源 HTTP/1.1 连接池只有 6 个槽位，SSE 长期占位。
 * 客户端反复重连（切换会话/工作区、半开连接、多标签页）时，服务端如果不主动
 * 收掉旧连接，旧连接会一直挂在连接池里——用户看到的就是"整站卡死、切不动"。
 * 这里做两件事：
 *   1. 同键去重：同一个 (path, client, thread) 只保留最新一条流，旧流主动收尾；
 *   2. 诊断：GET /api/diagnostics/streams 能直接看到当前挂了哪些流、各挂了多久。
 */

const streams = new Map();
let seq = 0;

/** 同一 (path, client, thread) 允许同时存活的流条数。 */
const MAX_SAME_KEY = 1;
/** 同一个 client 允许同时存活的总流条数（多标签页时的兜底）。 */
const MAX_PER_CLIENT = 8;
/**
 * 同 (path, client) 的"最新者胜"规则：页面重载/切会话时浏览器可能已经不用旧连接，
 * 但服务端迟迟收不到 FIN（半开连接），旧流就会一直挂在登记表里。
 * keep 是保留条数；graceMs 内不判旧（覆盖组件切换时新旧流短暂并存）。
 */
const SUPERSEDE = {
  "/api/agent/stream": { keep: 1, graceMs: 60000 },
  "/api/browser/stream": { keep: 1, graceMs: 5000 },
  "/api/agent/events": { keep: 1, graceMs: 5000 },
  "/api/memory/stream": { keep: 1, graceMs: 5000 },
};

export function streamKeyOf({ path, client = "", thread = "" }) {
  return `${path}|${client}|${thread}`;
}

/**
 * 登记一条流。返回 { id, release }；若触发了去重/超限，会把被顶掉的旧流写进 replaced。
 * @param {{path: string, client?: string, thread?: string, close: () => void, note?: string, probe?: () => boolean}} options
 *        probe 用于判断连接是否还活着（默认看响应/socket 状态），供清扫使用。
 */
export function registerServerStream({ path, client = "", thread = "", close, note = "", probe = null }) {
  const key = streamKeyOf({ path, client, thread });
  const replaced = [];
  // 同键去重：旧连接不主动收掉的话，客户端每次重连都会多占一个池槽位。
  const sameKey = [...streams.values()].filter((entry) => entry.key === key);
  while (sameKey.length >= MAX_SAME_KEY) {
    const victim = sameKey.shift();
    streams.delete(victim.id);
    replaced.push({ id: victim.id, reason: "same-key" });
    safeClose(victim);
  }
  // 同一 client 总量兜底：超过上限时收掉最旧的非最新流。
  const sameClient = [...streams.values()].filter((entry) => entry.client && entry.client === client);
  while (sameClient.length >= MAX_PER_CLIENT) {
    const victim = sameClient.shift();
    streams.delete(victim.id);
    replaced.push({ id: victim.id, reason: "client-limit" });
    safeClose(victim);
  }
  // 最新者胜：同类型同客户端只留最新 keep 条，超宽限期的旧流一律收掉。
  const rule = SUPERSEDE[path];
  if (rule && client) {
    const samePath = [...streams.values()]
      .filter((entry) => entry.path === path && entry.client === client)
      .sort((a, b) => b.openedAt - a.openedAt);
    const now = Date.now();
    for (const entry of samePath.slice(rule.keep)) {
      if (now - entry.openedAt < rule.graceMs) continue;
      streams.delete(entry.id);
      replaced.push({ id: entry.id, reason: "superseded" });
      safeClose(entry);
    }
  }
  const id = `stream-${++seq}`;
  streams.set(id, { id, key, path, client, thread, note, probe, openedAt: Date.now(), bytes: 0, lastWriteAt: 0, close });
  return { id, release: () => releaseServerStream(id), replaced };
}

/**
 * 清扫已经断开的流：客户端被强杀/网络静默断开时不发 FIN，
 * req.on("close") 不会触发，登记表里就留下一条永远"存活"的僵尸流。
 */
export function sweepServerStreams() {
  let closed = 0;
  for (const entry of [...streams.values()]) {
    if (typeof entry.probe !== "function") continue;
    let alive = true;
    try { alive = entry.probe() !== false; } catch { alive = false; }
    if (alive) continue;
    streams.delete(entry.id);
    safeClose(entry);
    closed += 1;
  }
  return closed;
}

export function releaseServerStream(id) {
  const entry = streams.get(id);
  if (!entry) return false;
  streams.delete(id);
  return true;
}

export function listServerStreams() {
  const now = Date.now();
  return [...streams.values()].map((entry) => ({
    id: entry.id,
    path: entry.path,
    client: entry.client,
    thread: entry.thread,
    note: entry.note,
    ageMs: now - entry.openedAt,
    idleMs: entry.lastWriteAt ? now - entry.lastWriteAt : now - entry.openedAt,
    bytes: entry.bytes,
  }));
}

export function serverStreamStats() {
  const items = listServerStreams();
  const byPath = {};
  const byClient = {};
  for (const item of items) {
    byPath[item.path] = (byPath[item.path] || 0) + 1;
    if (item.client) byClient[item.client] = (byClient[item.client] || 0) + 1;
  }
  return { total: items.length, byPath, byClient, maxPerClient: MAX_PER_CLIENT, maxSameKey: MAX_SAME_KEY, supersede: SUPERSEDE };
}

/** 关掉某条流（或某个 client 的全部流）；用于诊断接口与"卡死"时的救援。 */
export function closeServerStreams(filter = {}) {
  let closed = 0;
  for (const entry of [...streams.values()]) {
    if (filter.id && entry.id !== filter.id) continue;
    if (filter.path && entry.path !== filter.path) continue;
    if (filter.client && entry.client !== filter.client) continue;
    streams.delete(entry.id);
    safeClose(entry);
    closed += 1;
  }
  return closed;
}

/** 心跳/写入时记账：诊断里能区分"活着"和"挂死"。 */
export function noteStreamWrite(id, bytes = 0) {
  const entry = streams.get(id);
  if (!entry) return;
  entry.bytes += bytes;
  entry.lastWriteAt = Date.now();
}

function safeClose(entry) {
  try { entry.close?.(); } catch {}
}
