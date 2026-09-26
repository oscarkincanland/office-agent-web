/**
 * 网页读取：抓取 URL 并转为适合模型阅读的 Markdown 文本。
 *
 * 策略：
 *   1. 直接抓取（零依赖），HTML 走启发式正文提取；
 *   2. 正文过短（多为 JS 渲染页）或抓取失败时，可按需回退 Jina Reader（r.jina.ai）；
 *   3. 全程有下载字节上限与字符数上限，避免把巨页塞进上下文。
 *
 * 安全边界（P0）：
 *   - 默认拒绝 localhost、内网、链路本地、云元数据等非公网目标；
 *   - 校验发生在 DNS 解析之后，且每次重定向都重新校验（手动跟随重定向）；
 *   - 含用户名/密码的 URL 一律拒绝，且绝不转发给第三方（Jina）；
 *   - Jina 回退必须显式开启（allowJina / OAW_WEBFETCH_JINA），默认关闭。
 */
import dns from "node:dns/promises";
import net from "node:net";

const MAX_DOWNLOAD_BYTES = 1_500_000;
const MAX_REDIRECTS = 5;
const DEFAULT_MAX_CHARS = 12000;
const JINA_READER = "https://r.jina.ai/";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 OpenPlan/1.0";

function decodeEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function inlineText(html) {
  return decodeEntities(String(html || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** 把 HTML 提取为标题 + Markdown 正文（启发式，够用为先）。 */
export function htmlToMarkdown(html, maxChars = DEFAULT_MAX_CHARS) {
  const source = String(html || "");
  const titleMatch = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? inlineText(titleMatch[1]) : "";
  let body = source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|iframe|head|nav|footer|form)[^>]*>[\s\S]*?<\/\1>/gi, "");
  const articleMatch = body.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || body.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || body.match(/<div[^>]*(?:id|class)=["'][^"']*(?:content|article|post|main)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  if (articleMatch) body = articleMatch[1];
  body = body
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, inner) => `\n\n${"#".repeat(Number(level))} ${inlineText(inner)}\n\n`)
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => `\n\n\`\`\`\n${decodeEntities(String(inner).replace(/<[^>]+>/g, "")).trim()}\n\`\`\`\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n- ${inlineText(inner)}`)
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
      const text = inlineText(inner);
      return text ? `[${text}](${href})` : "";
    })
    .replace(/<(p|div|section|tr|br|hr)\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  body = decodeEntities(body)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const truncated = body.length > maxChars;
  return { title, markdown: truncated ? `${body.slice(0, maxChars)}\n\n…（内容过长已截断）` : body, truncated };
}

/* ------------------------------ 网络边界校验 ------------------------------ */

function blockedError(message, detail = "") {
  const error = new Error(detail ? `${message}：${detail}` : message);
  error.code = "WEB_FETCH_BLOCKED";
  return error;
}

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, part) => (acc << 8) + (Number(part) & 255), 0) >>> 0;
}
function inV4Range(value, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (ipv4ToInt(base) & mask);
}

// 非公网 IPv4：未指定/私网/回环/链路本地/云元数据/CGNAT/文档与保留段/组播。
const BLOCKED_V4 = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // 含 100.100.100.200（阿里云元数据）
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // 含 169.254.169.254（AWS/GCP/Azure 元数据）
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isBlockedIPv4(ip) {
  const value = ipv4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => inV4Range(value, base, bits));
}

function expandIPv6(ip) {
  const [head, tail] = ip.split("::");
  const headParts = head ? head.split(":").filter(Boolean) : [];
  const tailParts = tail !== undefined ? tail.split(":").filter(Boolean) : [];
  const missing = 8 - headParts.length - tailParts.length;
  return [...headParts, ...Array(Math.max(0, missing)).fill("0"), ...tailParts].map((part) => parseInt(part || "0", 16));
}

function embeddedIPv4(high, low) {
  return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join(".");
}

function isBlockedIPv6(ip) {
  const value = ip.toLowerCase().replace(/%.*$/, "");
  const v4Mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isBlockedIPv4(v4Mapped[1]);
  const nat64 = value.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/);
  if (nat64) return isBlockedIPv4(nat64[1]);

  const hextets = expandIPv6(value);
  if (hextets.length !== 8 || hextets.some((part) => !Number.isFinite(part))) return true;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets;

  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 === 0 && h7 === 0) return true; // ::
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 === 0 && h7 === 1) return true; // ::1
  if ((h0 & 0xfe00) === 0xfc00) return true; // fc00::/7（含 fd00:ec2::254 元数据）
  if ((h0 & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((h0 & 0xff00) === 0xff00) return true; // ff00::/8 组播
  if (h0 === 0x0064 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) return true; // 64:ff9b::/96 NAT64
  if (h0 === 0x2002) return isBlockedIPv4(embeddedIPv4(h1, h2)); // 6to4 内嵌 IPv4
  if (h0 === 0x2001 && h1 === 0x0db8) return true; // 2001:db8::/32 文档段
  if (h0 === 0x0100 && h1 === 0 && h2 === 0 && h3 === 0) return true; // 100::/64 丢弃段
  return false;
}

/** 判断一个 IP 字面量是否属于禁止访问的范围（无法识别的输入一律视为禁止）。 */
export function isBlockedAddress(input) {
  const ip = String(input || "").trim().replace(/^\[|\]$/g, "");
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true;
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "instance-data", "metadata", "metadata.goog"]);

function hostLooksBlocked(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** 同步的语法级校验：协议、URL 内嵌凭据、主机名/IP 字面量。 */
function assertUrlSyntaxAllowed(parsed) {
  if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
    throw blockedError("仅支持 http/https 链接");
  }
  if (parsed.username || parsed.password) {
    throw blockedError("链接包含用户名或密码，出于安全考虑不予读取");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (hostLooksBlocked(host)) throw blockedError("拒绝访问本机/内网地址", host);
  if (net.isIP(host) && isBlockedAddress(host)) throw blockedError("拒绝访问内网/保留地址", host);
}

/** 校验一个待跳转的重定向目标（协议/凭据/主机名 + IP 字面量）。导出以便测试。 */
export function resolveRedirectTarget(location, baseUrl) {
  let next;
  try {
    next = new URL(String(location || ""), baseUrl);
  } catch {
    throw blockedError("重定向地址无法解析");
  }
  assertUrlSyntaxAllowed(next);
  return next.toString();
}

/** 完整校验：语法 + DNS 解析结果（解析到内网/保留地址即拒绝）。 */
async function assertPublicTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw blockedError("仅支持 http/https 链接");
  }
  assertUrlSyntaxAllowed(parsed);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return; // 字面量已在语法校验中确认是公网地址
  let addresses = [];
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw blockedError("域名解析失败", host);
  }
  if (!addresses.length) throw blockedError("域名没有解析结果", host);
  const bad = addresses.find((item) => isBlockedAddress(item.address));
  if (bad) throw blockedError("域名解析到内网/保留地址", `${host} → ${bad.address}`);
}

/* ------------------------------ 抓取实现 ------------------------------ */

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

async function readCapped(response, maxBytes) {
  const body = response.body;
  if (!body) return { text: "", truncatedBytes: false };
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  let truncatedBytes = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      const remaining = maxBytes - total;
      if (bytes.length >= remaining) {
        if (remaining > 0) chunks.push(bytes.subarray(0, remaining));
        total = maxBytes;
        truncatedBytes = true;
        try { await reader.cancel(); } catch {}
        break;
      }
      chunks.push(bytes);
      total += bytes.length;
    }
  } finally {
    try { reader.releaseLock?.(); } catch {}
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncatedBytes };
}

function httpError(status) {
  const error = new Error(`HTTP ${status}`);
  error.status = status;
  return error;
}

/**
 * 抓取文本：手动跟随重定向，每一跳都重新做网络边界校验，并按字节上限流式截断。
 * @returns {{ type: string, text: string, url: string, truncatedBytes: boolean }}
 */
async function fetchText(url, { timeoutMs = 20000, accept = "text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5", maxBytes = MAX_DOWNLOAD_BYTES } = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicTarget(current);
    const response = await fetch(current, {
      headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (REDIRECT_STATUS.has(response.status)) {
      const location = response.headers.get("location");
      try { await response.body?.cancel(); } catch {}
      if (!location) throw httpError(response.status);
      if (hop === MAX_REDIRECTS) throw blockedError(`重定向次数超过上限（${MAX_REDIRECTS}）`);
      current = resolveRedirectTarget(location, current);
      continue;
    }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      throw httpError(response.status);
    }
    const type = String(response.headers.get("content-type") || "");
    const { text, truncatedBytes } = await readCapped(response, maxBytes);
    return { type, text, url: current, truncatedBytes };
  }
  throw blockedError(`重定向次数超过上限（${MAX_REDIRECTS}）`);
}

function isTextualType(type) {
  return /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|javascript|ld\+json))/i.test(String(type || ""));
}

/** Jina 回退默认关闭：需 allowJina: true 或环境变量 OAW_WEBFETCH_JINA=1；显式 0 时强制关闭。 */
function resolveAllowJina(options) {
  const env = String(process.env.OAW_WEBFETCH_JINA ?? "").trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(env)) return false;
  if (["1", "true", "on", "yes"].includes(env)) return true;
  return options?.allowJina === true;
}

async function fetchViaJina(url, maxChars, timeoutMs = 30000) {
  // 只允许公开 URL（调用方已校验），且不携带 URL 内嵌凭据。
  await assertPublicTarget(url);
  const response = await fetch(`${JINA_READER}${url}`, {
    headers: { "User-Agent": UA, Accept: "text/plain" },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Jina Reader HTTP ${response.status}`);
  const { text: raw } = await readCapped(response, MAX_DOWNLOAD_BYTES);
  const text = raw.trim();
  const truncated = text.length > maxChars;
  return { title: "", markdown: truncated ? `${text.slice(0, maxChars)}\n\n…（内容过长已截断）` : text, via: "jina", truncated };
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 读取网页并返回 Markdown 正文。
 * @param {string} url
 * @param {{ maxChars?: number, timeoutMs?: number, allowJina?: boolean }} [options]
 *   allowJina 默认 false：回退 Jina Reader 会把目标 URL 交给第三方，必须显式开启。
 * @returns {{ url, title, markdown, chars, truncated, via }}
 */
export async function webFetch(url, options = {}) {
  const { maxChars = DEFAULT_MAX_CHARS, timeoutMs = 20000 } = options;
  const allowJina = resolveAllowJina(options);
  const target = String(url || "").trim();
  if (!isHttpUrl(target)) {
    const error = new Error("仅支持 http/https 链接");
    error.code = "WEB_FETCH_INVALID_URL";
    throw error;
  }
  // 先做一次完整校验：被拒绝的目标不会产生任何请求，也不会被转发给第三方。
  await assertPublicTarget(target);

  const limit = Math.min(40000, Math.max(1000, Number(maxChars) || DEFAULT_MAX_CHARS));
  let direct = null;
  let directError = null;
  let directTruncatedBytes = false;
  try {
    const { type, text, truncatedBytes } = await fetchText(target, { timeoutMs });
    directTruncatedBytes = truncatedBytes;
    if (/application\/json/i.test(type)) {
      const pretty = (() => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } })();
      direct = { title: "", markdown: pretty.slice(0, limit), via: "direct-json", truncated: pretty.length > limit };
    } else if (/^text\/(plain|markdown)/i.test(type)) {
      direct = { title: "", markdown: text.slice(0, limit).trim(), via: "direct-text", truncated: text.length > limit };
    } else if (isTextualType(type)) {
      const extracted = htmlToMarkdown(text, limit);
      direct = { ...extracted, via: "direct-html" };
    } else {
      directError = Object.assign(new Error(`不支持的内容类型 ${type || "未知"}`), { code: "WEB_FETCH_UNSUPPORTED_TYPE" });
    }
  } catch (error) {
    directError = error;
  }

  // 边界被拒时立即返回，不做任何回退（避免把内网地址交给第三方）。
  if (directError?.code === "WEB_FETCH_BLOCKED") throw directError;

  const thin = !direct || direct.markdown.replace(/[#\-\s]/g, "").length < 200;
  if (thin && allowJina) {
    try {
      const viaJina = await fetchViaJina(target, limit, Math.max(timeoutMs, 30000));
      if (viaJina.markdown.length > (direct?.markdown.length || 0)) {
        return { url: target, title: viaJina.title || direct?.title || "", markdown: viaJina.markdown, chars: viaJina.markdown.length, truncated: viaJina.truncated, via: "jina" };
      }
    } catch (error) {
      // 回退失败时继续使用直连结果或抛出直连错误；边界拒绝优先抛出。
      if (error?.code === "WEB_FETCH_BLOCKED") throw error;
    }
  }
  if (!direct) {
    const message = directError?.name === "TimeoutError" || /aborted|timeout/i.test(String(directError?.message || ""))
      ? "抓取超时"
      : String(directError?.message || directError || "抓取失败");
    const error = new Error(`网页抓取失败：${message}。若目标站点需要国际网络，请检查代理设置。`);
    error.code = directError?.code === "WEB_FETCH_UNSUPPORTED_TYPE" ? "WEB_FETCH_UNSUPPORTED_TYPE" : "WEB_FETCH_FAILED";
    throw error;
  }
  return {
    url: target,
    title: direct.title || "",
    markdown: direct.markdown,
    chars: direct.markdown.length,
    truncated: Boolean(direct.truncated) || directTruncatedBytes,
    truncatedBytes: directTruncatedBytes,
    via: direct.via,
  };
}
