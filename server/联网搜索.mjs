import fs from "node:fs";
import path from "node:path";
import { PROJECT_DIR } from "./workspace.mjs";
import { atomicWriteJson } from "./持久化工具.mjs";

/**
 * 联网搜索后端抽象。
 *
 * 支持多个后端（可按环境切换）：
 *   - tavily : Tavily API（为 Agent 设计，免费 1000 次/月，需国际网络）
 *   - searxng: 自建/公共 SearXNG 元搜索（免费，需实例地址）
 *   - jina   : Jina Reader 搜索（s.jina.ai，免 Key 有频率限制）
 *   - bocha  : 博查（国内可达，按量计费）
 *
 * 状态契约（供前端单一消费，避免前后端各写一套 backendReady 规则）：
 *   searchState() -> { selectedBackend, configured, connectivity, label, tone, reason, backends[] }
 *   connectivity ∈ untested | ok | failed；label/tone 直接可用于徽标。
 */

// 允许测试与运维使用隔离的配置路径，避免在用户正在使用的 .oaw/search.json 上写入。
const CONFIG_FILE = process.env.OAW_SEARCH_CONFIG
  ? path.resolve(process.env.OAW_SEARCH_CONFIG)
  : path.join(PROJECT_DIR, ".oaw", "search.json");

export const SEARCH_BACKENDS = Object.freeze([
  {
    id: "tavily",
    name: "Tavily",
    needsKey: true,
    needsUrl: false,
    hint: "为 AI Agent 设计的搜索 API，免费 1000 次/月；需要能访问国际网络",
    keyUrl: "https://app.tavily.com/home",
  },
  {
    id: "searxng",
    name: "SearXNG（自建/公共实例）",
    needsKey: false,
    needsUrl: true,
    hint: "开源元搜索引擎，聚合 200+ 引擎，完全免费；填入实例地址（需允许 JSON 输出）",
    keyUrl: "https://searx.space",
  },
  {
    id: "jina",
    name: "Jina Reader 搜索",
    needsKey: false,
    needsUrl: false,
    hint: "s.jina.ai，免 Key 可用（有频率限制），配置 Key 可提升配额",
    keyUrl: "https://jina.ai/reader",
  },
  {
    id: "bocha",
    name: "博查（国内）",
    needsKey: true,
    needsUrl: false,
    hint: "国内可直连的搜索 API，新用户有免费额度",
    keyUrl: "https://open.bochaai.com",
  },
]);

const DEFAULTS = Object.freeze({
  backend: "tavily",
  tavilyKey: "",
  searxngUrl: "",
  jinaKey: "",
  bochaKey: "",
  maxResults: 6,
  timeoutMs: 20000,
});

// 各后端凭据字段与对应的进程环境变量。用于区分「用户保存」和「环境提供」，
// 以及写回配置时排除环境值（避免环境凭据意外落盘）。
const CREDENTIAL_FIELDS = Object.freeze({
  tavily: "tavilyKey",
  searxng: "searxngUrl",
  jina: "jinaKey",
  bocha: "bochaKey",
});
const ENV_FIELDS = Object.freeze({
  tavily: "TAVILY_API_KEY",
  searxng: "SEARXNG_URL",
  jina: "JINA_API_KEY",
  bocha: "BOCHA_API_KEY",
});

// 连通性只是「最近一次测试」的事实，保留在进程内、不写盘；重启后诚实地回到 untested。
const connectivity = new Map();

function markConnectivity(id, patch) {
  connectivity.set(id, { ...(connectivity.get(id) || {}), ...patch });
}
function resetConnectivity(id) {
  if (id) connectivity.delete(id);
  else connectivity.clear();
}
function connectivityOf(id) {
  return connectivity.get(id) || { status: "untested" };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function maskKey(value) {
  const key = String(value || "");
  if (!key) return "";
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

/** 只读取磁盘上已保存的配置（不含进程环境变量）；写回配置时以它为基础。 */
export function readStoredSearchSettings() {
  const stored = readJson(CONFIG_FILE, {}) || {};
  const merged = { ...DEFAULTS };
  for (const [key, value] of Object.entries(stored)) {
    if (value !== undefined && value !== null && value !== "") merged[key] = value;
  }
  return merged;
}

/** 生效配置 = 默认值 + 环境变量 + 磁盘配置（磁盘优先，与既有行为一致）。 */
export function readSearchSettings() {
  const merged = { ...DEFAULTS };
  for (const [id, envName] of Object.entries(ENV_FIELDS)) {
    const value = process.env[envName];
    if (value) merged[CREDENTIAL_FIELDS[id]] = String(value).trim();
  }
  const stored = readJson(CONFIG_FILE, {}) || {};
  for (const [key, value] of Object.entries(stored)) {
    if (value !== undefined && value !== null && value !== "") merged[key] = value;
  }
  return merged;
}

/** 当前凭据来自哪里：用户保存 / 进程环境 / 无。 */
function credentialSource(id) {
  const field = CREDENTIAL_FIELDS[id];
  if (!field) return "none";
  const stored = readJson(CONFIG_FILE, {}) || {};
  if (stored[field]) return "saved";
  if (process.env[ENV_FIELDS[id]]) return "env";
  return "none";
}

function backendReady(settings, id) {
  if (id === "tavily") return Boolean(settings.tavilyKey);
  if (id === "searxng") return Boolean(settings.searxngUrl);
  if (id === "jina") return true; // 免 Key 可用
  if (id === "bocha") return Boolean(settings.bochaKey);
  return false;
}

function notReadyMessage(id) {
  if (id === "tavily") return "Tavily 未配置 API Key（设置 → 联网搜索）";
  if (id === "searxng") return "SearXNG 未配置实例地址（设置 → 联网搜索）";
  if (id === "bocha") return "博查未配置 API Key（设置 → 联网搜索）";
  return "搜索后端未配置";
}

/** 单一状态：徽标文案 + 语气 + 可解释原因，前端不再自行拼装规则。 */
function readinessOf(id, settings) {
  const meta = SEARCH_BACKENDS.find((item) => item.id === id) || null;
  const ready = backendReady(settings, id);
  const conn = connectivityOf(id);
  const keyless = Boolean(meta && !meta.needsKey && !meta.needsUrl);
  if (!ready) return { label: "待配置", tone: "warn", reason: notReadyMessage(id) };
  if (conn.status === "ok") return { label: "已连通", tone: "ok", reason: conn.message || "最近一次测试已连通" };
  if (conn.status === "failed") return { label: "连接失败", tone: "error", reason: conn.message || "最近一次测试失败，请重试或检查配置" };
  if (keyless) return { label: "无需 Key · 未验证", tone: "warn", reason: "免 Key 可以尝试，但连通性尚未验证；点“测试连接”确认，不要当成已连通。" };
  return { label: "已配置 · 未验证", tone: "warn", reason: "凭据已保存，但尚未验证连通性；点“测试连接”确认。" };
}

/**
 * 统一的搜索状态：选中后端、是否配置、连通性、可解释原因，以及每个后端的就绪情况。
 * 前端只消费这一份状态。
 */
export function searchState() {
  const settings = readSearchSettings();
  const selected = String(settings.backend || "tavily");
  const meta = SEARCH_BACKENDS.find((item) => item.id === selected) || null;
  const conn = connectivityOf(selected);
  const readiness = readinessOf(selected, settings);
  const backends = SEARCH_BACKENDS.map((item) => {
    const itemConn = connectivityOf(item.id);
    return {
      ...item,
      configured: backendReady(settings, item.id),
      keyless: !item.needsKey && !item.needsUrl,
      credentialSource: item.needsKey || item.needsUrl ? credentialSource(item.id) : "none",
      connectivity: itemConn.status || "untested",
      connectivityMessage: itemConn.message || "",
    };
  });
  return {
    selectedBackend: selected,
    selectedName: meta?.name || selected,
    configured: backendReady(settings, selected),
    needsKey: Boolean(meta?.needsKey),
    needsUrl: Boolean(meta?.needsUrl),
    keyless: Boolean(meta && !meta.needsKey && !meta.needsUrl),
    credentialSource: meta && (meta.needsKey || meta.needsUrl) ? credentialSource(selected) : "none",
    connectivity: conn.status || "untested",
    connectivityMessage: conn.message || "",
    connectivityAt: conn.at || "",
    connectivityDurationMs: Number.isFinite(conn.durationMs) ? conn.durationMs : null,
    label: readiness.label,
    tone: readiness.tone,
    reason: readiness.reason,
    backends,
  };
}

/** 供前端展示的脱敏配置（含统一状态）。 */
export function publicSearchSettings() {
  const settings = readSearchSettings();
  return {
    backend: settings.backend,
    searxngUrl: settings.searxngUrl,
    maxResults: settings.maxResults,
    hasTavilyKey: Boolean(settings.tavilyKey),
    tavilyKeyMasked: maskKey(settings.tavilyKey),
    hasJinaKey: Boolean(settings.jinaKey),
    jinaKeyMasked: maskKey(settings.jinaKey),
    hasBochaKey: Boolean(settings.bochaKey),
    bochaKeyMasked: maskKey(settings.bochaKey),
    state: searchState(),
  };
}

function credentialFieldName(token) {
  const value = String(token || "").trim();
  if (!value) return null;
  if (CREDENTIAL_FIELDS[value]) return CREDENTIAL_FIELDS[value];
  if (Object.values(CREDENTIAL_FIELDS).includes(value)) return value;
  return null;
}

function normalizeClearInput(value) {
  if (value === true) return Object.keys(CREDENTIAL_FIELDS).map((id) => CREDENTIAL_FIELDS[id]);
  if (typeof value === "string") return value ? [value] : [];
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [];
}

export function saveSearchSettings(input = {}) {
  // 以磁盘配置为基础：绝不把进程环境变量写回 JSON。
  const next = { ...readStoredSearchSettings() };
  const touched = new Set();

  if (["tavily", "searxng", "jina", "bocha"].includes(input.backend)) next.backend = input.backend;
  // 密钥类：空字符串表示「保持不变」；清理请用 clearCredentials。
  if (typeof input.tavilyKey === "string" && input.tavilyKey.trim()) { next.tavilyKey = input.tavilyKey.trim(); touched.add("tavily"); }
  if (typeof input.jinaKey === "string" && input.jinaKey.trim()) { next.jinaKey = input.jinaKey.trim(); touched.add("jina"); }
  if (typeof input.bochaKey === "string" && input.bochaKey.trim()) { next.bochaKey = input.bochaKey.trim(); touched.add("bocha"); }
  // 实例地址允许被清空（原行为保持）。
  if (typeof input.searxngUrl === "string") {
    next.searxngUrl = input.searxngUrl.trim().replace(/\/+$/, "");
    touched.add("searxng");
  }
  if (Number.isFinite(Number(input.maxResults))) next.maxResults = Math.min(10, Math.max(1, Number(input.maxResults)));
  delete next.timeoutMs; // 保留字段兼容但不可由前端修改

  // 显式清除凭据：clearCredentials: true 清空全部；或传后端 id / 字段名数组。
  for (const token of normalizeClearInput(input.clearCredentials)) {
    const field = credentialFieldName(token);
    if (!field) continue;
    next[field] = "";
    const backendId = Object.entries(CREDENTIAL_FIELDS).find(([, name]) => name === field)?.[0];
    if (backendId) touched.add(backendId);
  }

  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  atomicWriteJson(CONFIG_FILE, next);
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
  for (const id of touched) resetConnectivity(id);
  return publicSearchSettings();
}

async function fetchJson(url, options = {}, timeoutMs = 20000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!response.ok) {
    const detail = data?.detail || data?.message || data?.error || text.slice(0, 200);
    const error = new Error(`HTTP ${response.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function normalizeResults(list, maxResults) {
  return (Array.isArray(list) ? list : [])
    .map((item) => ({
      title: String(item?.title || item?.name || "").trim(),
      url: String(item?.url || "").trim(),
      snippet: String(item?.content || item?.snippet || item?.summary || item?.description || "").replace(/\s+/g, " ").trim().slice(0, 600),
    }))
    .filter((item) => item.url && item.title)
    .slice(0, maxResults);
}

async function searchTavily(query, settings, maxResults) {
  const data = await fetchJson("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: settings.tavilyKey,
      query,
      max_results: maxResults,
      include_answer: false,
      search_depth: "basic",
    }),
  }, settings.timeoutMs);
  return { answer: String(data?.answer || "").trim(), results: normalizeResults(data?.results, maxResults) };
}

async function searchSearxng(query, settings, maxResults) {
  const base = String(settings.searxngUrl || "").replace(/\/+$/, "");
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1`;
  const data = await fetchJson(url, { headers: { Accept: "application/json" } }, settings.timeoutMs);
  return { answer: "", results: normalizeResults(data?.results, maxResults) };
}

async function searchJina(query, settings, maxResults) {
  const headers = { Accept: "application/json" };
  if (settings.jinaKey) headers.Authorization = `Bearer ${settings.jinaKey}`;
  const data = await fetchJson(`https://s.jina.ai/${encodeURIComponent(query)}`, { headers }, settings.timeoutMs);
  // Jina 返回 { data: [{title,url,content}] }
  const list = Array.isArray(data) ? data : data?.data;
  return { answer: "", results: normalizeResults(list, maxResults) };
}

async function searchBocha(query, settings, maxResults) {
  const data = await fetchJson("https://api.bochaai.com/v1/web-search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.bochaKey}` },
    body: JSON.stringify({ query, count: maxResults, summary: true, freshness: "noLimit" }),
  }, settings.timeoutMs);
  const pages = data?.data?.webPages?.value || data?.webPages?.value || [];
  return { answer: "", results: normalizeResults(pages, maxResults) };
}

const BACKENDS = {
  tavily: searchTavily,
  searxng: searchSearxng,
  jina: searchJina,
  bocha: searchBocha,
};

/** 把错误映射为「类别 + 可读文案」；类别用于有限重试与前端区分。 */
function classifySearchError(error, backendId) {
  const message = String(error?.message || error);
  const status = Number(error?.status);
  if (error?.name === "TimeoutError" || /aborted|timeout/i.test(message)) {
    return { category: "timeout", message: `搜索超时（${backendId}）。请检查网络或代理设置，或在设置中切换其他搜索后端。` };
  }
  if (status === 401 || status === 403 || /HTTP 401|HTTP 403|unauthorized|invalid.*key/i.test(message)) {
    return { category: "auth", message: `搜索认证失败（${backendId}）：API Key 无效或已过期。` };
  }
  if (status === 429 || /HTTP 429|rate limit|quota|usage limit|exceeded/i.test(message)) {
    return { category: "quota", message: `搜索配额已用尽或触发频率限制（${backendId}）：${message.slice(0, 160)}` };
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network/i.test(message)) {
    return { category: "network", message: `无法连接搜索服务（${backendId}）：可能需要国际网络或代理。可用国内后端（博查）或自建 SearXNG。原始错误：${message.slice(0, 120)}` };
  }
  if (Number.isFinite(status) && status >= 400) {
    return { category: "http", message: `搜索服务返回 HTTP ${status}（${backendId}）：${message.slice(0, 160)}` };
  }
  return { category: "unknown", message: `搜索失败（${backendId}）：${message.slice(0, 200)}` };
}

/** 从任意文案中抹掉已配置的凭据，避免测试/错误信息把 Key 带出去。 */
function redactSecrets(text, settings = {}) {
  let out = String(text || "");
  for (const field of Object.values(CREDENTIAL_FIELDS)) {
    const value = String(settings[field] || "");
    if (value.length >= 6) out = out.split(value).join(maskKey(value));
  }
  return out.replace(/([?&](?:api[_-]?key|key|token|apikey)=)[^&\s]+/gi, "$1••••");
}

function summarizeResults(results) {
  return (results || []).slice(0, 2).map((item) => ({
    title: String(item?.title || "").slice(0, 80),
    url: String(item?.url || "").slice(0, 200),
  }));
}

/** 只用于本次测试的草稿覆盖，绝不落盘。 */
function applyDraft(settings, draft) {
  const next = { ...settings };
  if (typeof draft.tavilyKey === "string" && draft.tavilyKey.trim()) next.tavilyKey = draft.tavilyKey.trim();
  if (typeof draft.searxngUrl === "string" && draft.searxngUrl.trim()) next.searxngUrl = draft.searxngUrl.trim().replace(/\/+$/, "");
  if (typeof draft.jinaKey === "string" && draft.jinaKey.trim()) next.jinaKey = draft.jinaKey.trim();
  if (typeof draft.bochaKey === "string" && draft.bochaKey.trim()) next.bochaKey = draft.bochaKey.trim();
  return next;
}

/**
 * 执行一次联网搜索。
 * @returns {{ backend: string, query: string, answer: string, results: Array }}
 */
export async function webSearch(query, { maxResults = null, backend = "" } = {}) {
  const text = String(query || "").trim();
  if (!text) throw new Error("搜索关键词不能为空");
  const settings = readSearchSettings();
  const selected = String(backend || settings.backend || "tavily");
  const handler = BACKENDS[selected];
  if (!handler) throw new Error(`不支持的搜索后端：${selected}`);
  if (!backendReady(settings, selected)) {
    const error = new Error(notReadyMessage(selected));
    error.code = "SEARCH_NOT_CONFIGURED";
    error.category = "unconfigured";
    throw error;
  }
  const limit = Math.min(10, Math.max(1, Number(maxResults) || Number(settings.maxResults) || 6));
  try {
    const outcome = await handler(text, settings, limit);
    return { backend: selected, query: text, answer: outcome.answer || "", results: outcome.results };
  } catch (error) {
    const classified = classifySearchError(error, selected);
    const wrapped = new Error(redactSecrets(classified.message, settings));
    wrapped.code = "SEARCH_FAILED";
    wrapped.category = classified.category;
    wrapped.original = redactSecrets(String(error?.message || error), settings);
    throw wrapped;
  }
}

/**
 * 测试指定（或当前）后端的连通性。
 * @param {string} backend
 * @param {{ draft?: object }} [options] draft 只在本次请求内生效，不写入配置、不改变已保存后端的连通性状态。
 * @returns {{ ok, backend, name, category, connectivity, durationMs, message, testedDraft, summary? }}
 */
export async function testSearchBackend(backend = "", options = {}) {
  const settings = readSearchSettings();
  const selected = String(backend || settings.backend || "tavily");
  const meta = SEARCH_BACKENDS.find((item) => item.id === selected) || null;
  const draft = options && typeof options.draft === "object" && options.draft ? options.draft : null;
  const testedDraft = Boolean(draft);
  const effective = draft ? applyDraft(settings, draft) : settings;
  const base = { backend: selected, name: meta?.name || selected, testedDraft };

  if (!BACKENDS[selected]) {
    return { ...base, ok: false, category: "unknown", connectivity: "untested", durationMs: 0, message: `不支持的搜索后端：${selected}` };
  }
  if (!backendReady(effective, selected)) {
    return { ...base, ok: false, category: "unconfigured", connectivity: "untested", durationMs: 0, message: notReadyMessage(selected) };
  }

  const startedAt = Date.now();
  try {
    const outcome = await BACKENDS[selected]("Open Plan 规聚", effective, 2);
    const durationMs = Date.now() - startedAt;
    if (!outcome.results.length) {
      const message = `已连通但未返回结果（${durationMs}ms），请检查实例配置`;
      if (!testedDraft) markConnectivity(selected, { status: "failed", category: "empty", message, at: new Date().toISOString(), durationMs });
      return { ...base, ok: false, category: "empty", connectivity: "failed", durationMs, message };
    }
    const message = `连接成功（${durationMs}ms，返回 ${outcome.results.length} 条）`;
    if (!testedDraft) markConnectivity(selected, { status: "ok", category: "ok", message, at: new Date().toISOString(), durationMs });
    return { ...base, ok: true, category: "ok", connectivity: "ok", durationMs, message, summary: summarizeResults(outcome.results) };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const classified = classifySearchError(error, selected);
    const message = redactSecrets(classified.message, effective);
    if (!testedDraft) markConnectivity(selected, { status: "failed", category: classified.category, message, at: new Date().toISOString(), durationMs });
    return { ...base, ok: false, category: classified.category, connectivity: "failed", durationMs, message };
  }
}

export function searchStoreInfo() {
  return { file: CONFIG_FILE, exists: fs.existsSync(CONFIG_FILE), backends: SEARCH_BACKENDS };
}
