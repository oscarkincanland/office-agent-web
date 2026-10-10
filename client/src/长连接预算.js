/**
 * 长连接预算（卡死防护）：
 *
 * 浏览器的同源 HTTP/1.1 连接池只有 6 个槽位，而 SSE 流会长期占住其中一格。
 * 一旦流连接把槽位占满，切工作区 / 切会话这类控制面请求只会永远排队：
 * 服务端完全空闲，页面却"整站卡死"。因此客户端必须对长连接总量负责——
 *   1. 连接前先在这里申请槽位，申请不到就不要连（避免"关掉→重连→再关掉"的抖动）；
 *   2. 控制面请求超时时一键回收所有可放弃的流，把槽位让出来重试。
 *
 * 核心两条（对话流、全局事件流）声明为 essential：它们申请槽位时一定成功，
 * 必要时会顶掉优先级最低的可放弃流；面板类（浏览器帧流、记忆变更流）申请不到
 * 就保持"等待连接"，等有槽位空出来（subscribeStreams 通知）再重试。
 */

/** 同时存活的流上限：留出至少 3 个槽位给普通请求，控制面不会被饿死。 */
export const MAX_STREAMS = 3;

const streams = new Map();
let seq = 0;
const listeners = new Set();
const eventLog = [];

function publish() {
  const snapshot = streamSnapshot();
  if (typeof window !== "undefined") {
    window.__oawStreams = { max: MAX_STREAMS, active: snapshot.length, items: snapshot, updatedAt: Date.now() };
  }
  for (const listener of [...listeners]) {
    try { listener(snapshot); } catch {}
  }
  return snapshot;
}

function note(kind, action, reason = "") {
  eventLog.push({ at: Date.now(), kind, action, reason });
  if (eventLog.length > 60) eventLog.splice(0, eventLog.length - 60);
}

/** 最近的申请/释放/回收记录，排查"为什么流断了"用。 */
export function streamEvents(limit = 20) {
  return eventLog.slice(-limit);
}

export function streamSnapshot() {
  return [...streams.values()].map((entry) => ({
    key: entry.key,
    kind: entry.kind,
    label: entry.label,
    essential: entry.essential,
    priority: entry.priority,
    ageMs: Date.now() - entry.openedAt,
  }));
}

export function activeStreamCount() {
  return streams.size;
}

export function hasStreamSlot() {
  return streams.size < MAX_STREAMS;
}

/**
 * 申请一条长连接的槽位。返回 { key, release }；不可放弃的流申请不到时返回 null。
 * 拿到槽位后再真正建立连接，release 放在连接/组件的清理函数里。
 */
export function acquireStream(kind, { essential = false, priority = 5, label = "" } = {}) {
  if (streams.size >= MAX_STREAMS) {
    if (!essential) {
      note(kind, "denied", `长连接预算已满（${streams.size}/${MAX_STREAMS}）`);
      return null;
    }
    // 必需流必须拿到槽位：先顶掉最不重要的可放弃流。
    const victim = [...streams.values()]
      .filter((entry) => !entry.essential)
      .sort((a, b) => b.priority - a.priority || a.openedAt - b.openedAt)[0];
    if (!victim) {
      note(kind, "denied", "预算已满且无可放弃的流");
      return null;
    }
    streams.delete(victim.key);
    note(victim.kind, "evict", `为必需流「${label || kind}」让位`);
    try { victim.close?.(); } catch {}
  }
  const key = `${kind}#${++seq}`;
  streams.set(key, { key, kind, label: label || kind, essential, priority, close: null, openedAt: Date.now() });
  const handle = {
    key,
    kind,
    /** 连接建立后把真正的关闭动作交给预算表，回收时才能真的断开。 */
    attach(close) {
      const entry = streams.get(key);
      if (!entry) { try { close?.(); } catch {} return false; }
      entry.close = close;
      return true;
    },
    release: () => releaseStream(key),
  };
  note(kind, "open");
  publish();
  return handle;
}

/**
 * 回收所有可放弃的流（控制面请求超时的救援动作）。
 * 返回被关闭的条数；essential 流不受影响。
 */
export function closeOptionalStreams(reason = "") {
  let closed = 0;
  for (const entry of [...streams.values()]) {
    if (entry.essential) continue;
    releaseStream(entry.key);
    closed += 1;
  }
  if (closed) note("optional", "reclaim", reason);
  publish();
  return closed;
}

export function releaseStream(key) {
  const entry = streams.get(key);
  if (!entry) return false;
  streams.delete(key);
  note(entry.kind, "close");
  try { entry.close?.(); } catch {}
  publish();
  return true;
}

/** 订阅槽位变化：申请不到槽位的面板可以在这里等空位再重试。 */
export function subscribeStreams(listener) {
  listeners.add(listener);
  listener(streamSnapshot());
  return () => listeners.delete(listener);
}

/** 等一个空槽位（有槽位时立刻回调）。返回取消函数，组件卸载时必须调用。 */
export function waitForStreamSlot(listener) {
  if (hasStreamSlot()) {
    listener();
    return () => {};
  }
  let done = false;
  const unsubscribe = subscribeStreams(() => {
    if (done || !hasStreamSlot()) return;
    done = true;
    unsubscribe();
    listener();
  });
  return () => {
    if (done) return;
    done = true;
    unsubscribe();
  };
}

/** 测试用：清空登记表（不调用 close）。 */
export function resetStreams() {
  streams.clear();
  eventLog.length = 0;
  publish();
}
