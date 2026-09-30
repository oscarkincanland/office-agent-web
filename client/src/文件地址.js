/**
 * 统一文件身份与预览地址（D01）
 *
 * 目标：一个文件在「哪个工作区、哪个相对路径、哪个版本」上被打开时，
 * 所有预览请求（open / raw / text / html / comments / annotations / outline / watch）
 * 都显式携带同一份「文件身份」，避免不同工作区的同名文件互相串内容。
 *
 * 文件身份契约：
 *   {
 *     workspaceId: string,   // 工作区标识（解析后的工作区根路径，realpath）
 *     cwd: string,           // 发给服务端的工作区（通常与 workspaceId 相同）
 *     relativePath: string,  // 相对工作区的文件路径（统一用 "/"）
 *     revision: string,      // 服务端版本/哈希；空字符串表示服务端未提供
 *   }
 *
 * 地址形状（每条都带 cwd + wsid + v）：
 *   /api/doc/<rel>/raw?cwd=<ws>&wsid=<ws>&v=<rev>
 *   /api/doc/<rel>/html?cwd=<ws>&wsid=<ws>&v=<rev>
 *   /api/doc/<rel>/comments?cwd=<ws>&wsid=<ws>&v=<rev>
 *   /api/doc/<rel>/annotations?cwd=<ws>&wsid=<ws>&v=<rev>
 *   /api/doc/<rel>/outline?cwd=<ws>&wsid=<ws>&v=<rev>
 *   /api/doc/<rel>/watch?cwd=<ws>&wsid=<ws>&v=<rev>
 *   /api/doc/<rel>?cwd=<ws>&wsid=<ws>&v=<rev>            （open 元数据）
 *   /api/doc/<rel>/watch/stop?cwd=<ws>&wsid=<ws>          （POST）
 *   /api/doc/<rel>/raw-save?cwd=<ws>&wsid=<ws>            （POST）
 */

/** 共享预览状态：loading | ready | partial | unsupported | failed */
export const PREVIEW_STATE = Object.freeze({
  LOADING: "loading",
  READY: "ready",
  PARTIAL: "partial",
  UNSUPPORTED: "unsupported",
  FAILED: "failed",
});

export const PREVIEW_STATE_LABEL = Object.freeze({
  [PREVIEW_STATE.LOADING]: "加载中",
  [PREVIEW_STATE.READY]: "已就绪",
  [PREVIEW_STATE.PARTIAL]: "部分内容",
  [PREVIEW_STATE.UNSUPPORTED]: "不支持预览",
  [PREVIEW_STATE.FAILED]: "预览失败",
});

/** 归一化相对路径：统一分隔符、去掉前导 "./" 与 "/"。 */
export function normalizeRelativePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^(?:\.?\/)+/, "");
}

/**
 * 构造文件身份。relativePath 缺失时回退 name，便于旧调用点迁移。
 * workspaceId 缺失时回退 cwd。
 */
export function makeFileIdentity(input = {}) {
  const relativePath = normalizeRelativePath(input.relativePath ?? input.name ?? "");
  const cwd = String(input.cwd || input.workspaceId || "");
  const workspaceId = String(input.workspaceId || cwd || "");
  const revision = input.revision == null ? "" : String(input.revision);
  return { workspaceId, cwd: cwd || workspaceId, relativePath, revision };
}

/** 身份去重键：工作区 + 相对路径（不含版本，版本变化不应新建标签）。 */
export function fileIdentityKey(identity) {
  if (!identity) return "";
  const ws = String(identity.workspaceId || identity.cwd || "").replace(/\\/g, "/").toLowerCase();
  return `${ws}::${normalizeRelativePath(identity.relativePath).toLowerCase()}`;
}

/** 两个身份是否指向同一文件（比较工作区 + 相对路径，大小写与分隔符归一）。 */
export function identityMatches(expected, actual) {
  if (!expected || !actual) return false;
  return fileIdentityKey(expected) === fileIdentityKey(actual);
}

/** 把服务端返回 identity 合并进本地身份（保留本地已知的 cwd 兜底）。 */
export function mergeFileIdentity(local, server) {
  if (!server) return makeFileIdentity(local || {});
  return makeFileIdentity({
    workspaceId: server.workspaceId || local?.workspaceId,
    cwd: server.cwd || local?.cwd,
    relativePath: server.relativePath || local?.relativePath,
    revision: server.revision != null ? server.revision : local?.revision,
  });
}

/** 从服务端 raw 响应头读取文件身份（服务端 URL 编码的 JSON）。 */
export function readIdentityHeader(response) {
  try {
    const raw = response?.headers?.get?.("x-oa-file-identity");
    if (!raw) return null;
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

function identityQuery(identity = {}) {
  const params = new URLSearchParams();
  const ws = String(identity.workspaceId || identity.cwd || "");
  if (ws) {
    params.set("cwd", ws);
    params.set("wsid", ws);
  }
  if (identity.revision) params.set("v", String(identity.revision));
  return params.toString();
}

function withQuery(url, query) {
  return query ? `${url}${url.includes("?") ? "&" : "?"}${query}` : url;
}

/**
 * 由文件身份生成全部预览地址。每条地址都携带同一份 cwd/wsid/v。
 */
export function buildDocUrls(identity) {
  const id = makeFileIdentity(identity || {});
  const rel = encodeURIComponent(id.relativePath);
  const base = `/api/doc/${rel}`;
  const query = identityQuery(id);
  const q = (suffix) => withQuery(`${base}${suffix}`, query);
  return {
    base,
    identity: id,
    open: q(""),
    raw: q("/raw"),
    text: q("/text"),
    html: q("/html"),
    comments: q("/comments"),
    annotations: q("/annotations"),
    outline: q("/outline"),
    watch: q("/watch"),
    watchStop: q("/watch/stop"),
    rawSave: q("/raw-save"),
  };
}

/** 用新的 revision 覆盖地址中的 v 参数（刷新时使用服务端最新版本）。 */
export function withRevision(url, revision) {
  if (!url) return url;
  const next = String(revision || "");
  if (!next) return url;
  const [head, search = ""] = String(url).split("?");
  const params = new URLSearchParams(search);
  params.set("v", next);
  return `${head}?${params.toString()}`;
}

/** 判断错误信息是否表示「格式不支持预览」。 */
export function looksUnsupported(message) {
  return /不支持|无法预览|unsupported|not supported|\.doc\b|\.wps\b/i.test(String(message || ""));
}

/** 依据错误归类预览状态。 */
export function previewStateFromError(error) {
  return looksUnsupported(error?.message || error) ? PREVIEW_STATE.UNSUPPORTED : PREVIEW_STATE.FAILED;
}
