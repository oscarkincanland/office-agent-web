import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from "undici";

export const PI_NETWORK_MODES = Object.freeze(["direct", "system", "manual"]);

export const PI_ERROR_CODES = Object.freeze({
  HOST_NETWORK_RESTRICTED: "HOST_NETWORK_RESTRICTED",
  NETWORK_UNREACHABLE: "NETWORK_UNREACHABLE",
  AUTH_ERROR: "AUTH_ERROR",
  RATE_LIMIT: "RATE_LIMIT",
  MODEL_TIMEOUT: "MODEL_TIMEOUT",
  MODEL_STREAM_TIMEOUT: "MODEL_STREAM_TIMEOUT",
  CONTEXT_LIMIT: "CONTEXT_LIMIT",
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
  REQUEST_ERROR: "REQUEST_ERROR",
});

const DEFAULT_NO_PROXY = "localhost,127.0.0.1,::1";
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 30_000;
// 模型响应是长 SSE 流，bodyTimeout 会把“暂时没有 token”误判成断流。
// 长流的空闲保护由 Agent 层按 Pi 事件单独处理，避免 Undici 在 5 分钟处硬中断。
const DEFAULT_BODY_TIMEOUT_MS = 0;
const MANUAL_PROXY_PROBE_URL = "https://api.openai.com/v1/models";
const MANUAL_PROXY_PROBE_TIMEOUT_MS = 3_000;
// 代理可能在系统启动后稍晚才就绪；回退直连只能是短暂降级，不能污染整个服务生命周期。
const MANUAL_PROXY_RETRY_INTERVAL_MS = 10_000;
const SECRET_PATTERN = /(api[_-]?key|authorization|bearer|access[_-]?token|refresh[_-]?token|password)([\s=:]+)[^\s,;]+/gi;
const NETWORK_ERROR_CODES = new Set([
  "EACCES",
  "EPERM",
  "ERR_NETWORK_ACCESS_DENIED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "ECONNABORTED",
  "EPIPE",
]);

function text(value) {
  return String(value ?? "");
}

function firstValue(...values) {
  return values.find((value) => text(value).trim().length > 0) || "";
}

function nonNegativeInteger(value, fallback) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function normalizePiNetworkMode(value) {
  const mode = text(value).trim().toLowerCase();
  return PI_NETWORK_MODES.includes(mode) ? mode : "direct";
}

export function redactProxyUrl(value) {
  const raw = text(value).trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return raw.replace(/^(\w+:\/\/)[^/@\s]+@/i, "$1").slice(0, 200);
  }
}

function sanitizeMessage(value) {
  return text(value)
    .replace(SECRET_PATTERN, "$1$2[已隐藏]")
    .replace(/(\w+:\/\/)[^/@\s]+@/gi, "$1")
    .slice(0, 800);
}

function environmentValue(environment, name) {
  const source = environment || process.env;
  return firstValue(source[name], source[name.toLowerCase()]);
}

export function resolvePiNetworkSettings(options = {}) {
  const environment = options.environment || process.env;
  const mode = normalizePiNetworkMode(options.mode ?? environment.OAW_MODEL_NETWORK_MODE);
  const httpProxy = firstValue(options.httpProxy, environmentValue(environment, "HTTP_PROXY"));
  const httpsProxy = firstValue(options.httpsProxy, environmentValue(environment, "HTTPS_PROXY"), httpProxy);
  const noProxy = firstValue(options.noProxy, environmentValue(environment, "NO_PROXY"), DEFAULT_NO_PROXY);
  const manualProxyUrl = firstValue(options.proxyUrl, environment.OAW_MODEL_PROXY_URL);
  const timeoutMs = Math.max(1_000, Number.parseInt(String(options.timeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS), 10) || DEFAULT_HEADERS_TIMEOUT_MS);
  return Object.freeze({
    mode,
    httpProxy: mode === "system" ? httpProxy : "",
    httpsProxy: mode === "system" ? httpsProxy : "",
    proxyUrl: mode === "manual" ? manualProxyUrl : "",
    noProxy,
    timeoutMs,
    connectTimeoutMs: Math.max(1_000, Number.parseInt(String(options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS), 10) || DEFAULT_CONNECT_TIMEOUT_MS),
    bodyTimeoutMs: nonNegativeInteger(options.bodyTimeoutMs, DEFAULT_BODY_TIMEOUT_MS),
  });
}

function dispatcherOptions(settings) {
  return {
    allowH2: false,
    connect: { autoSelectFamilyAttemptTimeout: settings.connectTimeoutMs },
    headersTimeout: settings.timeoutMs,
    bodyTimeout: settings.bodyTimeoutMs,
  };
}

function closeDispatcher(dispatcher) {
  try {
    const result = dispatcher?.close?.();
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {}
}

function hostnameFromInput(input) {
  try {
    return new URL(typeof input === "string" ? input : input?.url || String(input)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function portFromInput(input) {
  try {
    const url = new URL(typeof input === "string" ? input : input?.url || String(input));
    return url.port || (url.protocol === "https:" ? "443" : "80");
  } catch {
    return "";
  }
}

function noProxyMatches(input, noProxy) {
  const hostname = hostnameFromInput(input);
  if (!hostname) return false;
  const port = portFromInput(input);
  return text(noProxy)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === "*") return true;
      const [hostPattern, patternPort] = entry.startsWith("[")
        ? [entry.replace(/^\[|\].*$/g, ""), entry.match(/\]:(\d+)$/)?.[1] || ""]
        : entry.split(":");
      if (patternPort && patternPort !== port) return false;
      const normalized = hostPattern.replace(/^\./, "");
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    });
}

function createDirectDispatcher(settings) {
  return new Agent(dispatcherOptions(settings));
}

function createSystemDispatcher(settings) {
  return new EnvHttpProxyAgent({
    ...dispatcherOptions(settings),
    httpProxy: settings.httpProxy || undefined,
    httpsProxy: settings.httpsProxy || undefined,
    noProxy: settings.noProxy,
  });
}

function createManualDispatchers(settings) {
  const direct = createDirectDispatcher(settings);
  if (!settings.proxyUrl) return { direct, proxy: null };
  return { direct, proxy: new ProxyAgent(settings.proxyUrl) };
}

export function createPiNetworkAdapter(options = {}) {
  const settings = resolvePiNetworkSettings(options);
  let closed = false;
  let dispatcher;
  let directDispatcher;
  let proxyDispatcher;
  let proxyProbePromise = null;
  let proxyFallback = null;

  if (settings.mode === "direct") dispatcher = createDirectDispatcher(settings);
  if (settings.mode === "system") dispatcher = createSystemDispatcher(settings);
  if (settings.mode === "manual") ({ direct: directDispatcher, proxy: proxyDispatcher } = createManualDispatchers(settings));

  const precheckManualProxy = () => {
    if (settings.mode !== "manual" || !proxyDispatcher) return Promise.resolve();
    const retryAt = Number(proxyFallback?.retryAt || 0);
    // 正常请求直接使用用户配置的代理；只有发生过传输失败后，才做恢复探测。
    // 这样不会因为探测地址不可用而误判一个实际可工作的本地代理。
    if (!proxyFallback?.active || proxyProbePromise || retryAt > Date.now()) return Promise.resolve();
    proxyProbePromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MANUAL_PROXY_PROBE_TIMEOUT_MS);
      try {
        // 只要拿到 HTTP 响应就说明代理的 CONNECT/TLS 链路可用；401/404 也属于有效探测结果。
        const response = await undiciFetch(MANUAL_PROXY_PROBE_URL, { method: "GET", signal: controller.signal, dispatcher: proxyDispatcher });
        try { await response.body?.cancel?.(); } catch {}
        proxyFallback = null;
      } catch (error) {
        proxyFallback = {
          active: true,
          at: new Date().toISOString(),
          retryAt: Date.now() + MANUAL_PROXY_RETRY_INTERVAL_MS,
          message: "代理暂时不可达，已临时回退直连，稍后自动重试代理",
          error: sanitizeMessage(error?.message || error),
        };
      } finally {
        clearTimeout(timer);
        proxyProbePromise = null;
      }
    })();
    return proxyProbePromise;
  };

  const selectDispatcher = (input) => {
    if (settings.mode !== "manual") return dispatcher;
    if (proxyFallback?.active) return directDispatcher;
    return proxyDispatcher && !noProxyMatches(input, settings.noProxy) ? proxyDispatcher : directDispatcher;
  };

  const fetch = async (input, init = {}) => {
    if (closed) throw new Error("Pi 网络适配器已关闭");
    if (settings.mode === "manual" && proxyDispatcher && proxyFallback?.active) await precheckManualProxy();
    const selectedDispatcher = init?.dispatcher || selectDispatcher(input);
    try {
      const requestInit = { ...init, dispatcher: selectedDispatcher };
      return await undiciFetch(input, requestInit);
    } catch (error) {
      const classification = classifyPiError(error, { mode: settings.mode, url: hostnameFromInput(input) });
      if (settings.mode === "manual" && selectedDispatcher === proxyDispatcher && classification.retryable) {
        proxyFallback = {
          active: true,
          at: new Date().toISOString(),
          retryAt: Date.now() + MANUAL_PROXY_RETRY_INTERVAL_MS,
          message: "代理请求失败，已临时回退直连，稍后自动重试代理",
          error: sanitizeMessage(error?.message || error),
        };
      }
      const wrapped = new Error(classification.message, { cause: error });
      wrapped.name = "PiNetworkError";
      wrapped.code = classification.code;
      wrapped.oawNetwork = classification;
      throw wrapped;
    }
  };

  return {
    settings,
    fetch,
    diagnostics() {
      return {
        mode: settings.mode,
        noProxy: settings.noProxy,
        proxy: redactProxyUrl(settings.mode === "manual" ? settings.proxyUrl : settings.httpsProxy || settings.httpProxy),
        hasProxy: Boolean(settings.mode === "manual" ? settings.proxyUrl : settings.httpsProxy || settings.httpProxy),
        proxyFallback: proxyFallback && proxyFallback.active ? {
          at: proxyFallback.at,
          retryAt: proxyFallback.retryAt || null,
          message: proxyFallback.message,
        } : null,
        closed,
      };
    },
    close() {
      if (closed) return;
      closed = true;
      closeDispatcher(dispatcher);
      closeDispatcher(directDispatcher);
      closeDispatcher(proxyDispatcher);
    },
  };
}

function statusFrom(error, context = {}) {
  const direct = Number(error?.status ?? error?.statusCode ?? error?.response?.status ?? context.status ?? 0) || null;
  if (direct) return direct;
  const message = text(error?.message || error?.cause?.message || error || "");
  const match = message.match(/\b([1-5]\d{2})\s+status\s+code\b/i);
  return match ? Number(match[1]) : null;
}

function errorMessage(error) {
  return sanitizeMessage(error?.message || error?.cause?.message || error || "模型请求失败");
}

function hasNetworkErrorEvidence(error, message) {
  const causeCode = text(error?.cause?.code || error?.code).toUpperCase();
  return NETWORK_ERROR_CODES.has(causeCode)
    || NETWORK_ERROR_CODES.has(text(error?.oawNetwork?.causeCode).toUpperCase())
    || /(?:network.?error|connection.?error|connection.?refused|connection.?lost|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|socket connection was closed|upstream connect|reset before headers)/i.test(message);
}

function isHostNetworkRestricted(error, message, context, networkEvidence) {
  if (context.hostNetworkRestricted === false) return false;
  const causeCode = text(error?.cause?.code || error?.code).toUpperCase();
  const hostRestrictionEvidence = context.hostNetworkRestricted === true
    || process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1"
    || process.env.OAW_HOST_NETWORK_RESTRICTED === "1"
    || ["EACCES", "EPERM", "ERR_NETWORK_ACCESS_DENIED"].includes(causeCode)
    || /(?:sandbox|network access|network permission|blocked by policy|受限宿主|网络权限)/i.test(message);
  return hostRestrictionEvidence && networkEvidence;
}

export function classifyPiError(error, context = {}) {
  const message = errorMessage(error);
  const status = statusFrom(error, context);
  const causeCode = text(error?.cause?.code || error?.code).toUpperCase() || null;
  const body = sanitizeMessage(error?.responseBody || error?.body || context.body || "");
  const combined = `${message} ${body}`;
  const wrappedCode = error?.oawNetwork?.code;
  const networkEvidence = hasNetworkErrorEvidence(error, combined);
  let code = PI_ERROR_CODES.REQUEST_ERROR;
  let retryable = false;

  if (Object.values(PI_ERROR_CODES).includes(wrappedCode)) {
    code = wrappedCode;
    retryable = Boolean(error.oawNetwork.retryable);
  } else if (status === 401 || status === 403 || /(?:invalid.?api.?key|authentication|unauthori[sz]ed|forbidden|permission denied|no api key|provider\s+is\s+not\s+configured|not\s+configured)/i.test(combined)) {
    code = PI_ERROR_CODES.AUTH_ERROR;
  } else if (status === 429 || status === 529 || /(?:rate.?limit|too many requests|overloaded)/i.test(combined)) {
    code = PI_ERROR_CODES.RATE_LIMIT;
    retryable = true;
  } else if (error?.code === PI_ERROR_CODES.MODEL_STREAM_TIMEOUT || status === 408 || status === 504 || /(?:timed?.?out|timeout|headers timeout|body timeout|abort(ed)?)/i.test(combined)) {
    code = error?.code === PI_ERROR_CODES.MODEL_STREAM_TIMEOUT
      ? PI_ERROR_CODES.MODEL_STREAM_TIMEOUT
      : PI_ERROR_CODES.MODEL_TIMEOUT;
    retryable = true;
  } else if (/context.{0,30}(?:length|window|limit)|maximum context|too many tokens|上下文.{0,12}(?:超限|过长)/i.test(combined)) {
    code = PI_ERROR_CODES.CONTEXT_LIMIT;
  } else if (status === 404 || /(?:model|deployment).{0,30}(?:not found|不存在|unknown)/i.test(combined)) {
    code = PI_ERROR_CODES.MODEL_NOT_FOUND;
  } else if (isHostNetworkRestricted(error, combined, context, networkEvidence)) {
    code = PI_ERROR_CODES.HOST_NETWORK_RESTRICTED;
  } else if (networkEvidence || error?.oawNetwork?.code === PI_ERROR_CODES.NETWORK_UNREACHABLE) {
    code = PI_ERROR_CODES.NETWORK_UNREACHABLE;
    retryable = true;
  }

  return {
    code,
    category: code.toLowerCase(),
    retryable,
    status,
    causeCode,
    provider: error?.provider || error?.model?.provider || context.provider || null,
    model: error?.model?.id || (typeof error?.model === "string" ? error.model : context.model || null),
    message,
    mode: context.mode || error?.oawNetwork?.mode || null,
  };
}

export function classifyPiResponse(response, context = {}) {
  return classifyPiError({
    status: response?.status,
    responseBody: context.body,
    provider: context.provider,
    model: context.model,
  }, context);
}

/**
 * Pi 0.85.1 does not accept streamFunction/fetch in CreateAgentSessionOptions.
 * The created session exposes agent.streamFunction, while pi-ai's
 * SimpleStreamOptions accepts fetch. Wrap that existing function after session
 * creation so the SDK construction contract and global fetch remain untouched.
 */
const STREAM_WRAPPED = Symbol("oawPiStreamWrapped");

export function wrapPiAgentStreamFunction(session, fetch) {
  const agent = session?.agent;
  const original = agent?.streamFunction;
  if (!agent || typeof original !== "function" || typeof fetch !== "function") return false;
  if (original[STREAM_WRAPPED]) return true;
  const wrapped = (model, context, options = {}) => original(model, context, { ...options, fetch: options.fetch || fetch });
  Object.defineProperty(wrapped, STREAM_WRAPPED, { value: true });
  agent.streamFunction = wrapped;
  return true;
}

export function networkErrorMessage(classification) {
  const labels = {
    HOST_NETWORK_RESTRICTED: "宿主网络受限，无法访问模型供应商",
    NETWORK_UNREACHABLE: "模型供应商网络不可达",
    AUTH_ERROR: "模型鉴权失败，请检查 API Key 或权限",
    RATE_LIMIT: "模型供应商限流",
    MODEL_TIMEOUT: "模型请求超时",
    MODEL_STREAM_TIMEOUT: "模型流式输出长时间无事件",
    CONTEXT_LIMIT: "模型上下文超限",
    MODEL_NOT_FOUND: "模型不存在或已下线",
    REQUEST_ERROR: "模型请求失败",
  };
  return labels[classification?.code] || labels.REQUEST_ERROR;
}
