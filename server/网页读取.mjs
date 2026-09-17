/**
 * 网页读取：抓取 URL 并转为适合模型阅读的 Markdown 文本。
 *
 * 策略：
 *   1. 直接抓取（零依赖），HTML 走启发式正文提取；
 *   2. 正文过短（多为 JS 渲染页）或抓取失败时，回退 Jina Reader（r.jina.ai）；
 *   3. 全程有大小上限与字符数上限，避免把巨页塞进上下文。
 */

const MAX_DOWNLOAD_BYTES = 1_500_000;
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

async function fetchText(url, { timeoutMs = 20000, accept = "text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5" } = {}) {
  const response = await fetch(url, {
    headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const type = String(response.headers.get("content-type") || "");
  const raw = await response.text();
  return { type, text: raw.length > MAX_DOWNLOAD_BYTES ? raw.slice(0, MAX_DOWNLOAD_BYTES) : raw };
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function fetchViaJina(url, maxChars, timeoutMs = 30000) {
  const response = await fetch(`${JINA_READER}${url}`, {
    headers: { "User-Agent": UA, Accept: "text/plain" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Jina Reader HTTP ${response.status}`);
  const text = (await response.text()).trim();
  const truncated = text.length > maxChars;
  return { title: "", markdown: truncated ? `${text.slice(0, maxChars)}\n\n…（内容过长已截断）` : text, via: "jina", truncated };
}

/**
 * 读取网页并返回 Markdown 正文。
 * @returns {{ url, title, markdown, chars, truncated, via }}
 */
export async function webFetch(url, { maxChars = DEFAULT_MAX_CHARS, timeoutMs = 20000 } = {}) {
  const target = String(url || "").trim();
  if (!isHttpUrl(target)) {
    const error = new Error("仅支持 http/https 链接");
    error.code = "WEB_FETCH_INVALID_URL";
    throw error;
  }
  const limit = Math.min(40000, Math.max(1000, Number(maxChars) || DEFAULT_MAX_CHARS));
  let direct = null;
  let directError = null;
  try {
    const { type, text } = await fetchText(target, { timeoutMs });
    if (/application\/json/i.test(type)) {
      const pretty = (() => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } })();
      direct = { title: "", markdown: pretty.slice(0, limit), via: "direct-json", truncated: pretty.length > limit };
    } else if (/^text\/(plain|markdown)/i.test(type)) {
      direct = { title: "", markdown: text.slice(0, limit).trim(), via: "direct-text", truncated: text.length > limit };
    } else {
      const extracted = htmlToMarkdown(text, limit);
      direct = { ...extracted, via: "direct-html" };
    }
  } catch (error) {
    directError = error;
  }

  const thin = !direct || direct.markdown.replace(/[#\-\s]/g, "").length < 200;
  if (thin) {
    try {
      const viaJina = await fetchViaJina(target, limit, Math.max(timeoutMs, 30000));
      if (viaJina.markdown.length > (direct?.markdown.length || 0)) {
        return { url: target, title: viaJina.title || direct?.title || "", markdown: viaJina.markdown, chars: viaJina.markdown.length, truncated: viaJina.truncated, via: "jina" };
      }
    } catch {
      // 回退失败时继续使用直连结果或抛出直连错误
    }
  }
  if (!direct) {
    const message = directError?.name === "TimeoutError" ? "抓取超时" : String(directError?.message || directError || "抓取失败");
    const error = new Error(`网页抓取失败：${message}。若目标站点需要国际网络，请检查代理设置。`);
    error.code = "WEB_FETCH_FAILED";
    throw error;
  }
  return {
    url: target,
    title: direct.title || "",
    markdown: direct.markdown,
    chars: direct.markdown.length,
    truncated: Boolean(direct.truncated),
    via: direct.via,
  };
}
