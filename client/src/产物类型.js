/**
 * 产物类型展示（单一来源）：扩展名 → 图标、类型文案、文件大小。
 *
 * 消费方：对话结论里的行内产物条、本轮产物 tab 的产物卡片、右栏产物面板。
 * 此前各处各写一份扩展名判断（DocViewer 的 ICONS 只覆盖预览格式），
 * 图标与文案容易互相漂移，这里集中一份纯函数映射，Node 测试可直接调用。
 */

const EXT_KINDS = Object.freeze({
  docx: { icon: "doc", label: "文档" },
  doc: { icon: "doc", label: "文档" },
  md: { icon: "md", label: "Markdown" },
  markdown: { icon: "md", label: "Markdown" },
  xlsx: { icon: "xls", label: "表格" },
  xls: { icon: "xls", label: "表格" },
  csv: { icon: "xls", label: "表格" },
  pptx: { icon: "ppt", label: "演示" },
  ppt: { icon: "ppt", label: "演示" },
  pdf: { icon: "pdf", label: "PDF" },
  txt: { icon: "txt", label: "文本" },
  html: { icon: "html", label: "网页" },
  htm: { icon: "html", label: "网页" },
  json: { icon: "code", label: "数据" },
  geojson: { icon: "map", label: "地图数据" },
  shp: { icon: "map", label: "地图数据" },
  kml: { icon: "map", label: "地图数据" },
  png: { icon: "image", label: "图片" },
  jpg: { icon: "image", label: "图片" },
  jpeg: { icon: "image", label: "图片" },
  gif: { icon: "image", label: "图片" },
  webp: { icon: "image", label: "图片" },
  bmp: { icon: "image", label: "图片" },
  svg: { icon: "image", label: "图片" },
  zip: { icon: "package", label: "压缩包" },
  "7z": { icon: "package", label: "压缩包" },
  rar: { icon: "package", label: "压缩包" },
  js: { icon: "code", label: "代码" },
  mjs: { icon: "code", label: "代码" },
  cjs: { icon: "code", label: "代码" },
  ts: { icon: "code", label: "代码" },
  tsx: { icon: "code", label: "代码" },
  jsx: { icon: "code", label: "代码" },
  py: { icon: "code", label: "代码" },
  sql: { icon: "code", label: "代码" },
});

/** 统一相对路径：反斜杠转正斜杠、去掉前导 "./" 与 "/"。 */
export function normalizeArtifactPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^(?:\.?\/)+/, "")
    .trim();
}

/** 文件名（最后一段路径）。 */
export function artifactName(path) {
  const normalized = normalizeArtifactPath(path);
  return normalized.split("/").pop() || normalized;
}

/** 扩展名（小写，不含点）。 */
export function artifactExt(path) {
  const name = artifactName(path);
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1).toLowerCase() : "";
}

/** 路径 → { icon, label, ext }；未知扩展名回退通用文件图标。 */
export function artifactTypeInfo(path) {
  const ext = artifactExt(path);
  const kind = EXT_KINDS[ext];
  return kind ? { icon: kind.icon, label: kind.label, ext } : { icon: "file", label: "文件", ext };
}

/** 卡片副标题：`表格 · XLSX`（无扩展名时只给类型文案）。 */
export function artifactTypeLabel(path) {
  const { label, ext } = artifactTypeInfo(path);
  return ext ? `${label} · ${ext.toUpperCase()}` : label;
}

/** 字节数 → 人类可读（577 KB / 1.2 MB）。null/undefined 返回空串，不编造大小。 */
export function formatFileSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1024) return `${value} B`;
  const kb = value / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1).replace(/\.0$/, "") : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, "") : Math.round(mb)} MB`;
}

/**
 * 本轮产物索引：把交付物与文件改动归一成一份「可点击产物」清单。
 * 同一路径只保留一条（交付优先），并按名称提供查找（大小写不敏感，
 * 同时支持完整相对路径与文件名两种写法），供 Markdown 结论内嵌链接使用。
 */
export function buildArtifactIndex(entries = []) {
  const byPath = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const path = normalizeArtifactPath(entry?.path || entry?.relativePath || "");
    if (!path) continue;
    const existing = byPath.get(path);
    const deliverable = Boolean(entry?.deliverable) || existing?.deliverable || false;
    const size = entry?.size ?? existing?.size ?? null;
    byPath.set(path, { path, name: entry?.name || artifactName(path), size, deliverable });
  }
  const list = [...byPath.values()].map((item) => ({
    ...item,
    ...artifactTypeInfo(item.path),
    typeLabel: artifactTypeLabel(item.path),
    sizeText: formatFileSize(item.size),
  }));
  const byName = new Map();
  for (const item of list) {
    byName.set(item.path.toLowerCase(), item);
    const nameKey = item.name.toLowerCase();
    // 同名不同目录时保持第一条（按传入顺序，交付物在前），避免张冠李戴。
    if (!byName.has(nameKey)) byName.set(nameKey, item);
  }
  return { list, byName };
}

/**
 * 文本/链接目标 → 本轮产物；命中不了返回 null。
 * 支持：相对路径、`./` 前缀、反斜杠、file:// 前缀、URL 编码、仅文件名。
 */
export function resolveArtifactTarget(target, index) {
  if (!index || !target) return null;
  let value = String(target).trim();
  if (!value) return null;
  if (/^file:\/\//i.test(value)) {
    value = value.replace(/^file:\/+/i, "");
    try { value = decodeURIComponent(value); } catch {}
    value = value.replace(/^\/([a-zA-Z]:)/, "$1"); // Windows 盘符前的斜杠
  } else {
    try { value = decodeURIComponent(value); } catch {}
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-zA-Z]:[\\/]/.test(value)) return null; // http(s)/mailto/... 不是本地产物
  const normalized = normalizeArtifactPath(value).toLowerCase();
  if (!normalized) return null;
  if (index.byName.has(normalized)) return index.byName.get(normalized);
  const name = normalized.split("/").pop();
  return index.byName.get(name) || null;
}

// 本地产物扩展名白名单（用于判断 Markdown 链接是否指向工作区文件）。
const LOCAL_FILE_EXTS = new Set([
  ...Object.keys(EXT_KINDS),
  "docm", "dotx", "xlsm", "xltx", "pptm", "log", "ini", "yml", "yaml", "toml", "xml",
  "sh", "bat", "ps1", "mjs", "tsv", "dat", "nc", "tif", "tiff", "dbf", "prj", "cpg",
]);

/**
 * Markdown 链接目标 → 本地文件相对路径；不是本地文件返回空串。
 * 只认「无协议（或 file://）+ 带已知扩展名」的目标，避免把外部链接误当产物。
 */
export function normalizeLocalFileHref(href) {
  let value = String(href || "").trim();
  if (!value || value.startsWith("#")) return "";
  if (/^file:\/\//i.test(value)) {
    value = value.replace(/^file:\/+/i, "");
    try { value = decodeURIComponent(value); } catch {}
    value = value.replace(/^\/([a-zA-Z]:)/, "$1");
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-zA-Z]:[\\/]/.test(value)) {
    return "";
  }
  const normalized = normalizeArtifactPath(value.split(/[?#]/)[0]);
  if (!normalized) return "";
  const ext = artifactExt(normalized);
  if (!ext || !LOCAL_FILE_EXTS.has(ext)) return "";
  return normalized;
}

