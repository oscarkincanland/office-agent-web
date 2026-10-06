/**
 * 全链路首字延迟埋点（方案 §3.5）。
 *
 * 首字慢有几个完全不同的成因：客户端握手等待、服务端 admission 准备、
 * SDK/网关/模型服务的真实推理、以及 token 到达后到 DOM 可见的渲染延迟。
 * 只看一条“总耗时”无法区分，因此这里按阶段分别打点：
 *
 *   client_submit → server_received → admission_ready → sdk_request_dispatched
 *                 → first_provider_event → first_text_delta → first_dom_text
 *
 * 客户端只负责自己那一段（client_submit / first_event / first_text_delta /
 * first_dom_text），服务端部分在 server/首字延迟.mjs 打点；
 * 两边用 runId 合并，聚合时给出各阶段的 P50/P95。
 *
 * 埋点必须永远不能影响对话：任何异常都在内部吞掉。
 */

const REPORT_URL = "/api/agent/timing";

/** 允许的阶段名，避免把任意对象塞进聚合统计。 */
export const LATENCY_STAGES = Object.freeze([
  "clientSubmitAt",
  "serverReceivedAt",
  "admissionReadyAt",
  "sdkRequestDispatchedAt",
  "firstProviderEventAt",
  "firstEventAt",
  "firstTextDeltaAt",
  "firstDomTextAt",
]);

/** 当前活动探针：Message 渲染层不需要 props 就能标记 first_dom_text。 */
let activeProbe = null;

export function getActiveProbe() {
  return activeProbe;
}

/**
 * 开始一次探针。同一时刻只允许一个活动探针（对话面板串行发送），
 * 重复调用会先把上一个探针结算，避免脏样本永远不落库。
 */
export function startLatencyProbe(meta = {}) {
  finalizeLatencyProbe({ reason: "superseded" });
  const marks = { clientSubmitAt: Date.now(), runId: null, ...meta };
  let settled = false;
  const mark = (name, at = Date.now()) => {
    if (!LATENCY_STAGES.includes(name)) return marks[name];
    if (marks[name] == null) marks[name] = at;
    return marks[name];
  };
  const snapshot = (extra = {}) => {
    const base = marks.clientSubmitAt || Date.now();
    const has = (name) => marks[name] != null;
    return {
      ...marks,
      ...extra,
      // 各段耗时分项；缺哪一段就留 null，而不是用 0 伪造“很快”。
      submitToFirstEventMs: has("firstEventAt") ? marks.firstEventAt - base : null,
      submitToFirstTextDeltaMs: has("firstTextDeltaAt") ? marks.firstTextDeltaAt - base : null,
      submitToFirstDomTextMs: has("firstDomTextAt") ? marks.firstDomTextAt - base : null,
      tokenToDomMs: has("firstTextDeltaAt") && has("firstDomTextAt") ? marks.firstDomTextAt - marks.firstTextDeltaAt : null,
      firstEventToFirstTextDeltaMs: has("firstEventAt") && has("firstTextDeltaAt") ? marks.firstTextDeltaAt - marks.firstEventAt : null,
    };
  };
  const settle = (extra = {}, { send = true } = {}) => {
    if (settled) return null;
    settled = true;
    const sample = snapshot(extra);
    if (activeProbe && activeProbe.marks === marks) activeProbe = null;
    if (send) reportLatencySample(sample);
    return sample;
  };
  activeProbe = { marks, mark, snapshot, settle };
  return activeProbe;
}

export function markLatency(name, at) {
  try {
    return activeProbe?.mark?.(name, at) ?? null;
  } catch {
    return null;
  }
}

/**
 * 补充上下文元信息（runId / 模型 / 握手等待耗时等）。
 * runId 要到 run_admitted 才知道，但首字阶段标记可能已经发生，
 * 因此元信息与阶段打点必须分开写、最后一起上报。
 */
export function patchLatencyMeta(patch = {}) {
  try {
    if (!activeProbe) return null;
    Object.assign(activeProbe.marks, patch);
    return activeProbe.marks;
  } catch {
    return null;
  }
}

/** 渲染层看到首个可见正文时调用；同一轮只记第一次。 */
export function markFirstDomText(at) {
  return markLatency("firstDomTextAt", at);
}

export function finalizeLatencyProbe(extra = {}, options = {}) {
  try {
    return activeProbe?.settle?.(extra, options) ?? null;
  } catch {
    return null;
  }
}

/** fire-and-forget 上报：走 sendBeacon 可以在页面关闭/刷新时仍然送达。 */
export function reportLatencySample(sample) {
  try {
    const body = JSON.stringify(sample);
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(REPORT_URL, new Blob([body], { type: "application/json" }));
      return;
    }
    fetch(REPORT_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
  } catch {
    /* 埋点失败不得影响对话 */
  }
}

/** 分位数：样本为空返回 null，不返回 0（0 会让“没有任何样本”看起来像“极快”）。 */
export function percentile(values, p) {
  const sorted = (values || []).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}