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
 */

const CONFIG_FILE = path.join(PROJECT_DIR, ".oaw", "search.json");

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

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function maskKey(value) {
  const key = String(value || "");
  if (!key) return "";
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

export function readSearchSettings() {
  const stored = readJson(CONFIG_FILE, {}) || {};
  const env = {
    tavilyKey: process.env.TAVILY_API_KEY || "",
    searxngUrl: process.env.SEARXNG_URL || "",
    jinaKey: process.env.JINA_API_KEY || "",
    bochaKey: process.env.BOCHA_API_KEY || "",
  };
  const merged = { ...DEFAULTS, ...env };
  for (const [key, value] of Object.entries(stored)) {
    if (value !== undefined && value !== null && value !== "") merged[key] = value;
  }
  return merged;
}

/** 供前端展示的脱敏配置 */
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
  };
}

export function saveSearchSettings(input = {}) {
  const current = readSearchSettings();
  const next = { ...current };
  if (["tavily", "searxng", "jina", "bocha"].includes(input.backend)) next.backend = input.backend;
  if (typeof input.tavilyKey === "string") next.tavilyKey = input.tavilyKey.trim();
  if (typeof input.searxngUrl === "string") next.searxngUrl = input.searxngUrl.trim().replace(/\/+$/, "");
  if (typeof input.jinaKey === "string") next.jinaKey = input.jinaKey.trim();
  if (typeof input.bochaKey === "string") next.bochaKey = input.bochaKey.trim();
  if (Number.isFinite(Number(input.maxResults))) next.maxResults = Math.min(10, Math.max(1, Number(input.maxResults)));
  delete next.timeoutMs; // 保留字段兼容但不可由前端修改
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  atomicWriteJson(CONFIG_FILE, next);
  return publicSearchSettings();
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

function classifySearchError(error, backendId) {
  const message = String(error?.message || error);
  if (error?.name === "TimeoutError" || /aborted|timeout/i.test(message)) {
    return `搜索超时（${backendId}）。请检查网络或代理设置，或在设置中切换其他搜索后端。`;
  }
  if (/HTTP 401|HTTP 403|unauthorized|invalid.*key/i.test(message)) {
    return `搜索认证失败（${backendId}）：API Key 无效或已过期。`;
  }
  if (/HTTP 429|rate limit|quota|usage limit|exceeded/i.test(message)) {
    return `搜索配额已用尽或触发频率限制（${backendId}）：${message.slice(0, 160)}`;
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network/i.test(message)) {
    return `无法连接搜索服务（${backendId}）：可能需要国际网络或代理。可用国内后端（博查）或自建 SearXNG。原始错误：${message.slice(0, 120)}`;
  }
  return `搜索失败（${backendId}）：${message.slice(0, 200)}`;
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
    throw error;
  }
  const limit = Math.min(10, Math.max(1, Number(maxResults) || Number(settings.maxResults) || 6));
  try {
    const outcome = await handler(text, settings, limit);
    return { backend: selected, query: text, answer: outcome.answer || "", results: outcome.results };
  } catch (error) {
    const wrapped = new Error(classifySearchError(error, selected));
    wrapped.code = "SEARCH_FAILED";
    wrapped.original = String(error?.message || error);
    throw wrapped;
  }
}

/** 测试指定（或当前）后端的连通性，返回可读结果。 */
export async function testSearchBackend(backend = "") {
  const settings = readSearchSettings();
  const selected = String(backend || settings.backend || "tavily");
  const meta = SEARCH_BACKENDS.find((item) => item.id === selected) || null;
  if (!backendReady(settings, selected)) {
    return { ok: false, backend: selected, message: notReadyMessage(selected) };
  }
  const startedAt = Date.now();
  try {
    const outcome = await BACKENDS[selected]("Open Plan 规聚", settings, 2);
    const elapsed = Date.now() - startedAt;
    if (!outcome.results.length) {
      return { ok: false, backend: selected, message: `已连通但未返回结果（${elapsed}ms），请检查实例配置` };
    }
    return {
      ok: true,
      backend: selected,
      message: `连接成功（${elapsed}ms，返回 ${outcome.results.length} 条）`,
      sample: outcome.results[0],
    };
  } catch (error) {
    return { ok: false, backend: selected, message: classifySearchError(error, selected), name: meta?.name || selected };
  }
}

export function searchStoreInfo() {
  return { file: CONFIG_FILE, exists: fs.existsSync(CONFIG_FILE), backends: SEARCH_BACKENDS };
}
