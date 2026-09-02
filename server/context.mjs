import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import JSZip from "jszip";
import XLSX from "xlsx";
import { getWorkspace, resolveExternalPath, resolvePath, listFileRoots } from "./workspace.mjs";

const execFileAsync = promisify(execFile);
const MAX_READ_CHARS = 50000;
const SUPPORTED = new Set(["docx", "xlsx", "pptx", "pdf", "csv", "json", "md", "markdown", "txt", "html", "htm"]);
const MAX_DOCUMENT_CACHE_ENTRIES = 32;
const MAX_DOCUMENT_CACHE_CHARS = 2_000_000;
const documentReadCache = new Map();
let documentCacheChars = 0;

function cacheKeyFor(file, version, range) {
  return `${file}|${version}|${JSON.stringify(range || {})}`;
}

function readCachedDocument(key) {
  const hit = documentReadCache.get(key);
  if (!hit) return null;
  documentReadCache.delete(key);
  documentReadCache.set(key, hit);
  return hit.text;
}

function cacheDocument(key, text) {
  const value = String(text || "");
  if (!value || value.length > MAX_DOCUMENT_CACHE_CHARS) return;
  const old = documentReadCache.get(key);
  if (old) documentCacheChars -= old.text.length;
  documentReadCache.delete(key);
  documentReadCache.set(key, { text: value, cachedAt: new Date().toISOString() });
  documentCacheChars += value.length;
  while (documentReadCache.size > MAX_DOCUMENT_CACHE_ENTRIES || documentCacheChars > MAX_DOCUMENT_CACHE_CHARS) {
    const first = documentReadCache.keys().next().value;
    const item = documentReadCache.get(first);
    documentReadCache.delete(first);
    documentCacheChars -= item?.text?.length || 0;
  }
}

export function clearReadCache() {
  documentReadCache.clear();
  documentCacheChars = 0;
}

function idFor(ref) {
  return "ref_" + crypto.createHash("sha1").update(JSON.stringify(ref)).digest("hex").slice(0, 12);
}

function makeRef(kind, target, extra = {}) {
  let cleanTarget = String(target || "").trim();
  const cell = kind === "file" ? cleanTarget.match(/^(.*?)#([^!]+)!([A-Z]+\d+(?::[A-Z]+\d+)?)$/i) : null;
  const locator = kind === "file" ? cleanTarget.match(/^(.*?)#(page|p|slide|paragraph)=(\d+)(?:-(\d+))?$/i) : null;
  const range = cell
    ? { ...(extra.range || {}), sheet: cell[2], cell: cell[3] }
    : locator
      ? { ...(extra.range || {}), [locator[2].toLowerCase() === "p" ? "page" : locator[2].toLowerCase()]: Number(locator[3]), ...(locator[4] ? { end: Number(locator[4]) } : {}) }
      : extra.range;
  if (cell) cleanTarget = cell[1];
  if (locator) cleanTarget = locator[1];
  const ref = { kind, target: cleanTarget, ...extra };
  if (range) ref.range = range;
  ref.id = idFor(ref);
  return ref;
}

/** Parse the user-facing @ syntax into stable, serialisable Reference objects. */
export function parseReferences(text = "") {
  const out = [];
  const seen = new Set();
  const add = (ref) => {
    if (!ref?.target) return;
    const key = JSON.stringify({ kind: ref.kind, target: ref.target, rootId: ref.rootId, range: ref.range });
    if (!seen.has(key)) { seen.add(key); out.push({ ...ref, id: idFor(ref) }); }
  };
  const source = String(text || "");
  for (const m of source.matchAll(/@知识库目录\[([^\]]+)\]/g)) add(makeRef("knowledge_dir", m[1], { source: m[0] }));
  for (const m of source.matchAll(/@知识库\[([^\]]+)\]/g)) add(makeRef("knowledge", m[1], { source: m[0] }));
  for (const m of source.matchAll(/@模板目录\[([^\]]+)\]/g)) add(makeRef("template_dir", m[1], { source: m[0] }));
  for (const m of source.matchAll(/@模板\[([^\]]+)\]/g)) add(makeRef("template", m[1], { source: m[0] }));
  for (const m of source.matchAll(/@文件\[([^\]]+)\]/g)) add(makeRef("file", m[1], { source: m[0] }));
  const ext = /\.(docx|xlsx|pptx|pdf|csv|json|md|markdown|txt|html|htm)$/i;
  for (const m of source.matchAll(/(^|[\s(])@([^\s@，。！？\]}]+)/g)) {
    const target = m[2].replace(/[),;。！？]+$/, "");
    if (/^(?:文件|知识库|模板|模板目录)\[/.test(target)) continue;
    if (target.includes("/") || target.includes("\\") || ext.test(target)) add(makeRef("file", target, { source: `@${target}` }));
  }
  return out;
}

function metadata(file, rootId = null, workspace = getWorkspace()) {
  const st = fs.statSync(file);
  // 目录引用只需要用于展示和版本判断，不能把目录交给 readFileSync。
  // Windows 上对目录调用 readFileSync 会抛出 EISDIR，导致整个 Agent 请求失败。
  const hash = st.isDirectory()
    ? null
    : crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
  return {
    path: file,
    relativePath: rootId ? path.relative(listFileRoots().find((r) => r.id === rootId)?.path || file, file).replace(/\\/g, "/") : path.relative(workspace, file).replace(/\\/g, "/"),
    rootId,
    name: path.basename(file),
    ext: path.extname(file).slice(1).toLowerCase(),
    mime: mimeFor(file),
    size: st.size,
    mtime: st.mtimeMs,
    hash,
    version: st.isDirectory() ? `${st.size}:${st.mtimeMs}:directory` : `${st.size}:${st.mtimeMs}:${hash.slice(0, 8)}`,
  };
}

function mimeFor(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return ({
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    pdf: "application/pdf", csv: "text/csv", json: "application/json",
    md: "text/markdown", markdown: "text/markdown", txt: "text/plain", html: "text/html", htm: "text/html",
  })[ext] || "application/octet-stream";
}

function resolveFile(ref, workspace = getWorkspace()) {
  if (ref.rootId) return resolveExternalPath(ref.rootId, ref.target);
  return resolvePath(ref.target, workspace);
}

export function resolveReference(input, workspace = getWorkspace()) {
  const ref = typeof input === "string" ? makeRef("file", input) : { ...input };
  ref.id ||= idFor(ref);
  if (["knowledge", "knowledge_dir", "template", "template_dir"].includes(ref.kind)) {
    return { ...ref, status: "deferred", message: "由知识库/模板索引解析", metadata: null };
  }
  const file = resolveFile(ref, workspace);
  if (!file) return { ...ref, status: "missing", metadata: null, message: "文件不存在或不在已登记目录内" };
  const stat = fs.statSync(file);
  if (stat.isDirectory()) {
    const files = [];
    const walk = (dir, depth = 0) => {
      if (depth > 3 || files.length >= 100) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p, depth + 1);
        else if (SUPPORTED.has(path.extname(entry.name).slice(1).toLowerCase())) files.push(metadata(p, ref.rootId || null, workspace));
      }
    };
    walk(file);
    return { ...ref, status: "resolved", metadata: { ...metadata(file, ref.rootId || null, workspace), isDirectory: true, files } };
  }
  return { ...ref, status: SUPPORTED.has(path.extname(file).slice(1).toLowerCase()) ? "resolved" : "unsupported", metadata: metadata(file, ref.rootId || null, workspace) };
}

export function resolveReferences(references = [], text = "", workspace = getWorkspace()) {
  const refs = [...(Array.isArray(references) ? references : []), ...parseReferences(text)];
  const seen = new Set();
  return refs.map((r) => ({ ...r, id: r.id || idFor(r) })).filter((r) => {
    const key = `${r.kind}:${r.target}:${r.rootId || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((ref) => resolveReference(ref, workspace));
}

async function extractDocx(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) return "";
  return [...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map((m) => [...m[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((x) => x[1]).join("").trim()).filter(Boolean).join("\n");
}

async function extractPptx(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort();
  const chunks = [];
  for (const name of slides) {
    const xml = await zip.file(name).async("string");
    const text = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join("").trim();
    if (text) chunks.push(`${name.match(/slide(\d+)/)?.[1] || "?"}. ${text}`);
  }
  return chunks.join("\n");
}

async function extractPdf(file) {
  try {
    const { stdout } = await execFileAsync("pdftotext", [file, "-"], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch {
    if (process.env.OAW_ENABLE_OCR !== "1") return "[PDF 文本抽取工具不可用；可安装 poppler，或设置 OAW_ENABLE_OCR=1 启用可选 OCR。]";
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-pdf-"));
    try {
      const prefix = path.join(tmp, "page");
      await execFileAsync("pdftoppm", ["-f", "1", "-l", "5", "-png", "-r", "150", file, prefix], { timeout: 60000 });
      const pages = fs.readdirSync(tmp).filter((name) => name.endsWith(".png")).sort();
      const chunks = [];
      for (const page of pages) {
        try {
          const { stdout } = await execFileAsync("tesseract", [path.join(tmp, page), "stdout", "-l", process.env.OAW_OCR_LANG || "eng"], { timeout: 60000, maxBuffer: 5 * 1024 * 1024 });
          if (stdout.trim()) chunks.push(`${page}:\n${stdout.trim()}`);
        } catch {}
      }
      return chunks.join("\n\n") || "[OCR 未识别到文本；请检查 tesseract 与语言包。]";
    } catch {
      return "[OCR 依赖不可用；请安装 pdftoppm 与 tesseract，或使用 PDF 文本层。]";
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }
}

async function extractFile(file, range = null) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (["md", "markdown", "txt", "html", "htm", "csv", "json"].includes(ext)) return fs.readFileSync(file, "utf8");
  if (ext === "docx") return extractDocx(file);
  if (ext === "pptx") return extractPptx(file);
  if (ext === "xlsx") {
    const wb = XLSX.readFile(file, { cellText: true, cellDates: true });
    const names = range?.sheet && wb.SheetNames.includes(range.sheet) ? [range.sheet] : wb.SheetNames;
    return names.map((name) => {
      const sheet = wb.Sheets[name];
      if (range?.cell && name === range.sheet) {
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
        const decoded = XLSX.utils.decode_range(range.cell);
        const selected = rows.slice(decoded.s.r, decoded.e.r + 1).map((row) => row.slice(decoded.s.c, decoded.e.c + 1).join("\t"));
        return `## ${name}!${range.cell}\n${selected.join("\n")}`;
      }
      return `## ${name}\n${XLSX.utils.sheet_to_csv(sheet)}`;
    }).join("\n\n");
  }
  if (ext === "pdf") return extractPdf(file);
  return "";
}

function applyRange(text, range = {}) {
  let out = String(text || "");
  if (range?.slide || range?.page || range?.paragraph) {
    const n = Number(range.slide || range.page || range.paragraph);
    const end = Number(range.end || n);
    const lines = out.split(/\r?\n/);
    if (range.slide) out = lines.filter((line) => { const m = line.match(/^(\d+)\./); return m && Number(m[1]) >= n && Number(m[1]) <= end; }).join("\n");
    else out = lines.slice(Math.max(0, n - 1), Math.max(0, end)).join("\n");
  }
  if (range?.startLine || range?.endLine) {
    const lines = out.split(/\r?\n/);
    const start = Math.max(1, Number(range.startLine || 1));
    const end = Math.min(lines.length, Number(range.endLine || lines.length));
    out = lines.slice(start - 1, end).join("\n");
  }
  return out;
}

export async function readReference(input, query = "", range = null, workspace = getWorkspace()) {
  const resolved = resolveReference(input, workspace);
  if (resolved.kind === "knowledge") {
    const kb = await import("./kb.mjs");
    await kb.scan();
    const [relPath, rootName] = String(resolved.target).split("@").map((s) => s.trim());
    const rootIdx = rootName ? kb.status().roots.findIndex((r) => r.name === rootName) : null;
    const doc = kb.getDoc(relPath, rootIdx >= 0 ? rootIdx : null);
    if (!doc) return { ...resolved, status: "missing", message: `未找到知识库文档 ${resolved.target}` };
    const text = applyRange(`# ${doc.title}\n\n${doc.content}`, range);
    return { ...resolved, status: "resolved", metadata: { relativePath: relPath, rootName, mime: "text/markdown" }, text: text.slice(0, MAX_READ_CHARS), truncated: text.length > MAX_READ_CHARS };
  }
  if (resolved.kind === "knowledge_dir") {
    const kb = await import("./kb.mjs");
    await kb.scan();
    const [relPath, rootName] = String(resolved.target).split("@").map((s) => s.trim());
    const rootIdx = rootName ? kb.status().roots.findIndex((r) => r.name === rootName) : null;
    const tree = kb.getTreeLevel(rootIdx >= 0 ? rootIdx : 0, relPath || "");
    const text = [...(tree?.dirs || []).map((d) => `[目录] ${d.name || d.path}`), ...(tree?.files || []).map((f) => `[文件] ${f.title || f.name || f.relPath}`)].join("\n");
    return { ...resolved, status: "resolved", metadata: { relativePath: relPath, rootName, mime: "text/plain", isDirectory: true }, text: text || "（目录为空）" };
  }
  if (resolved.kind === "template") {
    const tpl = await import("./tpl.mjs");
    const doc = tpl.getTemplateContent(resolved.target);
    if (!doc) return { ...resolved, status: "missing", message: `未找到模板 ${resolved.target}` };
    const text = applyRange(doc.content || "", range);
    return { ...resolved, status: "resolved", metadata: { relativePath: resolved.target, mime: mimeFor(resolved.target) }, text: text.slice(0, MAX_READ_CHARS), truncated: text.length > MAX_READ_CHARS };
  }
  if (resolved.kind === "template_dir") return { ...resolved, status: "deferred", message: "模板目录引用请先选择具体模板文件" };
  if (resolved.status !== "resolved" || resolved.metadata?.isDirectory) return { ...resolved, text: resolved.message || "目录引用需要逐个读取文件" };
  const extractionRange = range || resolved.range || null;
  const cacheKey = cacheKeyFor(resolved.metadata.path, resolved.metadata.version, extractionRange);
  let text = readCachedDocument(cacheKey);
  const cacheHit = text !== null;
  if (!cacheHit) {
    text = await extractFile(resolved.metadata.path, extractionRange);
    cacheDocument(cacheKey, text);
  }
  text = applyRange(text, extractionRange);
  const q = String(query || "").trim();
  const result = q ? text.split(/\r?\n/).filter((line) => line.toLowerCase().includes(q.toLowerCase())).join("\n") : text;
  return {
    ...resolved,
    metadata: { ...resolved.metadata, parser: path.extname(resolved.metadata.path).slice(1).toLowerCase(), cacheHit, readAt: new Date().toISOString() },
    text: result.slice(0, MAX_READ_CHARS),
    truncated: result.length > MAX_READ_CHARS,
  };
}

export function contextSummary(resolved = []) {
  return resolved.map((r) => `- ${r.id}: ${r.kind} ${r.target} → ${r.status}${r.metadata?.relativePath ? ` (${r.metadata.relativePath})` : ""}`).join("\n");
}
