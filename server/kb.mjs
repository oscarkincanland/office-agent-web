/**
 * 知识库服务（kb.mjs）
 *
 * - 扫描配置的本地根目录（kb.json roots）中的 .md 文件
 * - 解析 frontmatter(title/tags)、标题、[[wikilink]] 双向链接、内联 #tag
 * - 构建内存索引：文件列表 / 全文搜索（中文子串 + 加权打分）/ 知识图谱（nodes+edges）
 * - 可选代理 IMA 云端知识库（credentials 就绪时，走 ima-skill 的 ima_api.cjs）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const CONFIG_FILE = path.join(PROJECT_DIR, "kb.json");
const DEFAULT_IMA_SKILL_DIR = path.join(PROJECT_DIR, "..", ".agents", "skills", "ima-skill");

// ---------- 配置 ----------
function defaultConfig() {
  return {
    roots: [path.join(PROJECT_DIR, "..", "_knowledge_base")],
    imaSkillDir: DEFAULT_IMA_SKILL_DIR,
  };
}

let config = null;
export function loadConfig() {
  if (config) return config;
  config = defaultConfig();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      if (Array.isArray(raw.roots)) config.roots = raw.roots.filter((r) => typeof r === "string");
      if (typeof raw.imaSkillDir === "string") config.imaSkillDir = raw.imaSkillDir;
    }
  } catch {}
  return config;
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
  } catch {}
}

export function addRoot(dir) {
  const d = String(dir || "").trim();
  if (!d || !fs.existsSync(d) || !fs.statSync(d).isDirectory()) return { ok: false, error: "目录不存在" };
  const cfg = loadConfig();
  const norm = path.resolve(d);
  if (!cfg.roots.some((r) => path.resolve(r).toLowerCase() === norm.toLowerCase())) {
    cfg.roots.push(norm);
    saveConfig();
    invalidate();
  }
  return { ok: true, roots: cfg.roots };
}

export function removeRoot(dir) {
  const cfg = loadConfig();
  const norm = path.resolve(String(dir || "").trim());
  const before = cfg.roots.length;
  cfg.roots = cfg.roots.filter((r) => path.resolve(r).toLowerCase() !== norm.toLowerCase());
  if (cfg.roots.length !== before) {
    saveConfig();
    invalidate();
  }
  return { ok: true, roots: cfg.roots };
}

// ---------- 扫描与解析 ----------
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "__pycache__", ".obsidian", ".trash", ".idea", "dist", "build", ".next"]);
const MD_RE = /\.(md|markdown)$/i;

let fileCache = new Map(); // absPath -> { relPath, rootIdx, size, mtimeMs, doc }
let scanFingerprint = "";  // 用于快速判断是否需要重扫
let lastScanMs = 0;
let scanning = null;
let PARSE_VERSION = 2; // 解析逻辑变更时 +1，强制重解析

function invalidate() {
  lastScanMs = 0;
}

function computeFingerprint(roots) {
  let fp = "";
  for (let i = 0; i < roots.length; i++) {
    const r = roots[i];
    try {
      const st = fs.statSync(r);
      fp += `${i}:${st.mtimeMs};`;
    } catch {
      fp += `${i}:missing;`;
    }
  }
  return fp;
}

function walkFiles(dir, rootIdx, out, rel = "") {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walkFiles(abs, rootIdx, out, childRel);
    } else if (e.isFile() && MD_RE.test(e.name)) {
      out.push({ abs, rel: childRel, rootIdx });
    }
  }
}

/** 解析 frontmatter */
function parseFrontmatter(content) {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim().toLowerCase();
    let val = kv[2].trim().replace(/^['"]|['"]$/g, "");
    if (key === "tags") {
      val = val
        .replace(/^\[|\]$/g, "")
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      fm.tags = val;
    } else {
      fm[key] = val;
    }
  }
  return fm;
}

/** 解析 [[wikilink]] 与内联 #tag */
function parseLinksAndTags(content) {
  const links = [];
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;
  let m;
  while ((m = re.exec(content))) {
    const target = m[1].trim().replace(/\.md$/i, "");
    if (target) links.push({ target, alias: m[2]?.trim() });
  }
  const tags = new Set();
  const tagRe = /(^|\s)#([\p{L}\p{N}_-]+)/gu;
  while ((m = tagRe.exec(content))) {
    const t = m[2];
    // 排除 hex 颜色（#F59E0B）与纯数字
    if (!/^\d/.test(t) && !/^[0-9a-fA-F]{3,8}$/.test(t)) tags.add(t);
  }
  return { links, tags: [...tags] };
}

/** 解析单个 md 文件为结构化文档 */
function parseDoc(absPath, content) {
  const fm = parseFrontmatter(content);
  const title = fm.title || content.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(absPath).replace(/\.md$/i, "");
  const headings = [...content.matchAll(/^#{1,4}\s+(.+)$/gm)].map((m) => m[1].trim()).slice(0, 200);
  const { links, tags } = parseLinksAndTags(content);
  const fmTags = Array.isArray(fm.tags) ? fm.tags : [];
  return {
    title,
    tags: [...new Set([...fmTags, ...tags])],
    headings,
    links,
    content,
    size: content.length,
  };
}

/** 扫描全部 roots，增量复用未变更文件 */
export async function scan(force = false) {
  const cfg = loadConfig();
  const fp = computeFingerprint(cfg.roots);
  const now = Date.now();
  if (!force && scanFingerprint === fp && lastScanMs && now - lastScanMs < 8000) {
    return fileCache;
  }
  if (scanning) return scanning;
  scanning = (async () => {
    const found = [];
    for (let i = 0; i < cfg.roots.length; i++) {
      walkFiles(cfg.roots[i], i, found);
    }
    const next = new Map();
    for (const f of found) {
      let st;
      try {
        st = fs.statSync(f.abs);
      } catch {
        continue;
      }
      const cached = fileCache.get(f.abs);
      if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs && cached.parseVersion === PARSE_VERSION) {
        next.set(f.abs, cached);
      } else {
        let content;
        try {
          content = fs.readFileSync(f.abs, "utf8");
        } catch {
          continue;
        }
        next.set(f.abs, { abs: f.abs, relPath: f.rel, rootIdx: f.rootIdx, size: st.size, mtimeMs: st.mtimeMs, parseVersion: PARSE_VERSION, doc: parseDoc(f.abs, content) });
      }
    }
    fileCache = next;
    scanFingerprint = fp;
    lastScanMs = Date.now();
    return fileCache;
  })();
  try {
    return await scanning;
  } finally {
    scanning = null;
  }
}

// ---------- 文件解析辅助 ----------
export function getFileList() {
  return [...fileCache.values()];
}

function normBase(name) {
  return String(name).toLowerCase().replace(/\.md$/i, "").trim();
}

/** 解析 [[target]] 到文件：优先精确 basename，再包含匹配 */
function resolveLinkTarget(target, allFiles) {
  const t = normBase(target);
  if (!t) return null;
  let exact = null;
  let partial = null;
  for (const f of allFiles) {
    const base = normBase(path.basename(f.relPath));
    if (base === t) {
      exact = f;
      break;
    }
    if (!partial && base.includes(t)) partial = f;
  }
  return exact || partial;
}

// ---------- 对外接口 ----------
export function status() {
  const cfg = loadConfig();
  return {
    roots: cfg.roots.map((r, i) => ({ index: i, path: r, name: path.basename(r) || r, exists: fs.existsSync(r) })),
    fileCount: fileCache.size,
    imaSkillDir: cfg.imaSkillDir,
  };
}

export function getTree(rootIdx) {
  const items = [...fileCache.values()].filter((f) => f.rootIdx === rootIdx);
  const tree = [];
  for (const f of items) {
    const parts = f.relPath.split("/");
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      let child = node.find((n) => n.type === "dir" && n.name === parts[i]);
      if (!child) {
        child = { type: "dir", name: parts[i], children: [] };
        node.push(child);
      }
      node = child.children;
    }
    const base = path.basename(f.relPath);
    node.push({ type: "file", name: base, relPath: f.relPath, title: f.doc.title, tags: f.doc.tags.slice(0, 8) });
  }
  return tree;
}

/**
 * 懒加载：返回指定目录的直接子级（dir 为空 = 根级）
 * dir 行带 subCount（直接子项数），file 行带 linkCount（引用数徽标）
 */
export function getTreeLevel(rootIdx, dirPath = "") {
  const items = [...fileCache.values()].filter((f) => f.rootIdx === rootIdx);
  const prefix = dirPath ? dirPath + "/" : "";
  const dirMap = new Map(); // name -> { name, path, subCount }
  const files = [];
  for (const f of items) {
    if (!f.relPath.startsWith(prefix)) continue;
    const rest = f.relPath.slice(prefix.length);
    const parts = rest.split("/");
    if (parts.length === 1) {
      files.push({
        type: "file",
        name: parts[0],
        relPath: f.relPath,
        title: f.doc.title,
        tags: f.doc.tags.slice(0, 8),
        linkCount: f.doc.links.length,
        mtime: f.mtimeMs,
      });
    } else {
      const dirName = parts[0];
      if (!dirMap.has(dirName)) {
        dirMap.set(dirName, { type: "dir", name: dirName, path: prefix + dirName, subCount: 0 });
      }
      dirMap.get(dirName).subCount++;
    }
  }
  // 目录的直接子项数 = 子目录数（自身占位 1）+ 直接文件数
  for (const d of dirMap.values()) {
    const childPrefix = d.path + "/";
    let subFiles = 0;
    for (const f of items) {
      if (f.relPath.startsWith(childPrefix)) {
        const rest = f.relPath.slice(childPrefix.length);
        if (!rest.includes("/")) subFiles++;
      }
    }
    d.subCount = subFiles + [...dirMap.values()].filter((x) => x.path.startsWith(childPrefix) && x.path !== d.path).length;
  }
  const dirs = [...dirMap.values()].sort((a, b) => a.name.localeCompare(b.name, "zh"));
  files.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return { dirs, files };
}

/**
 * 全文搜索（中文友好：子串匹配 + 加权打分）
 * 权重：标题 10 / 标签 6 / 标题行 4 / 正文 1（出现次数封顶 10）
 */
export function search(q, rootIdx = null, limit = 30) {
  const query = String(q || "").trim().toLowerCase();
  if (!query || fileCache.size === 0) return [];
  const terms = query.split(/\s+/).filter(Boolean);
  const results = [];
  for (const f of fileCache.values()) {
    if (rootIdx !== null && f.rootIdx !== rootIdx) continue;
    const d = f.doc;
    const titleLow = d.title.toLowerCase();
    const tagLow = d.tags.join(" ").toLowerCase();
    const headingLow = d.headings.join(" ").toLowerCase();
    const contentLow = d.content.toLowerCase();
    let score = 0;
    let snippet = "";
    for (const t of terms) {
      if (titleLow.includes(t)) score += 10;
      if (tagLow.includes(t)) score += 6;
      if (headingLow.includes(t)) score += 4;
      const contentHits = contentLow.split(t).length - 1;
      if (contentHits > 0) {
        score += Math.min(contentHits, 10);
        if (!snippet) {
          const idx = contentLow.indexOf(t);
          snippet = d.content.slice(Math.max(0, idx - 60), idx + 140).replace(/\s+/g, " ").trim();
        }
      }
    }
    if (score > 0) {
      results.push({
        relPath: f.relPath,
        rootIdx: f.rootIdx,
        title: d.title,
        tags: d.tags.slice(0, 8),
        score,
        snippet: snippet || d.content.slice(0, 160).replace(/\s+/g, " ").trim(),
      });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/** 获取单个文档详情（含解析后的链接 + 反链） */
export function getDoc(relPath, rootIdx = null) {
  let target = null;
  for (const f of fileCache.values()) {
    if (f.relPath === relPath && (rootIdx === null || f.rootIdx === rootIdx)) {
      target = f;
      break;
    }
  }
  if (!target) return null;
  const all = [...fileCache.values()];
  const links = [];
  for (const l of target.doc.links) {
    const r = resolveLinkTarget(l.target, all);
    if (r) links.push({ relPath: r.relPath, rootIdx: r.rootIdx, title: r.doc.title, alias: l.alias });
  }
  const backlinks = [];
  const base = normBase(path.basename(target.relPath));
  for (const f of all) {
    if (f.abs === target.abs) continue;
    const hit = f.doc.links.some((l) => normBase(path.basename(l.target)) === base);
    if (hit) {
      // 引用上下文：源文档中 [[目标]] 所在段落（供反链面板展开预览，大小写不敏感）
      let snippet = "";
      for (const p of f.doc.content.split(/\n{2,}/)) {
        const lower = p.toLowerCase();
        if (lower.includes(`[[${base}]]`) || lower.includes(`[[${base}|`)) {
          snippet = p.replace(/\s+/g, " ").trim().slice(0, 220);
          break;
        }
      }
      backlinks.push({ relPath: f.relPath, rootIdx: f.rootIdx, title: f.doc.title, snippet });
    }
  }
  return {
    relPath: target.relPath,
    rootIdx: target.rootIdx,
    title: target.doc.title,
    tags: target.doc.tags,
    headings: target.doc.headings,
    content: target.doc.content,
    links,
    backlinks,
  };
}

// ---------- 相似度边（无 [[链接]] 时让图谱有意义的兜底） ----------
const simCache = new Map(); // `${rootIdx}` -> edges

function docBigrams(f) {
  // 取内容前 6000 字符，提取 CJK/字母数字 字符二元组（标题/标题行加权重复）
  const src = f.doc.title + "\n" + f.doc.headings.join("\n") + "\n" + f.doc.content.slice(0, 6000);
  const chars = [...src].filter((c) => /[\p{L}\p{N}]/u.test(c));
  const bg = new Set();
  for (let i = 0; i < chars.length - 1; i++) bg.add(chars[i] + chars[i + 1]);
  return bg;
}

function computeSimilarEdges(rootIdx, all) {
  const key = String(rootIdx);
  if (simCache.has(key)) return simCache.get(key);
  const edges = [];
  const bigrams = new Map();
  for (const f of all) bigrams.set(f.abs, docBigrams(f));
  const list = [...bigrams.entries()];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [a, sa] = list[i];
      const [b, sb] = list[j];
      const inter = Math.min(sa.size, sb.size);
      let common = 0;
      // 遍历小的集合
      const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
      for (const x of small) if (large.has(x)) common++;
      if (common >= 12) {
        const overlap = common / inter;
        if (overlap >= 0.25) {
          edges.push({ a, b, w: overlap });
        }
      }
    }
  }
  edges.sort((x, y) => y.w - x.w);
  const capped = edges.slice(0, Math.min(Math.max(all.length * 2, 40), 120));
  const res = capped.map((e) => ({ source: e.a, target: e.b, type: "similar" }));
  simCache.set(key, res);
  return res;
}

/**
 * 知识图谱数据
 * include: "links"（默认，[[wikilink]] 双向边）| "tags"（标签节点）| "folders"（目录节点）| "similar"（内容相似边）
 */
export function getGraph({ rootIdx = null, include = ["links"], maxNodes = 800 } = {}) {
  const all = [...fileCache.values()].filter((f) => rootIdx === null || f.rootIdx === rootIdx);
  if (all.length === 0) return { nodes: [], edges: [], meta: { total: 0 } };
  const nodes = [];
  const edges = [];
  const nodeId = (f) => `n${f.rootIdx}/${f.relPath}`;
  const nodeMap = new Map();

  const want = new Set(Array.isArray(include) ? include : [include]);

  // 文件节点
  for (const f of all) {
    const id = nodeId(f);
    nodeMap.set(id, f);
    const idx = f.relPath.indexOf("/");
    nodes.push({ id, label: f.doc.title, size: 14, type: "file", relPath: f.relPath, rootIdx: f.rootIdx, tags: f.doc.tags.slice(0, 5), group: idx === -1 ? "root" : f.relPath.slice(0, idx) });
  }

  const edgeKey = (a, b, t) => `${a}|${b}|${t}`;
  const seenEdges = new Set();

  // [[wikilink]] 双向边（去重）
  if (want.has("links")) {
    for (const f of all) {
      const srcId = nodeId(f);
      for (const l of f.doc.links) {
        const r = resolveLinkTarget(l.target, all);
        if (!r) continue;
        const dstId = nodeId(r);
        const k = edgeKey(srcId, dstId, "link");
        if (!seenEdges.has(k)) {
          seenEdges.add(k);
          edges.push({ source: srcId, target: dstId, type: "link", label: "" });
        }
      }
    }
  }

  // 内容相似边（无 [[链接]] 时展示主题聚类）
  if (want.has("similar")) {
    const absToId = new Map(all.map((f) => [f.abs, nodeId(f)]));
    for (const e of computeSimilarEdges(rootIdx, all)) {
      const srcId = absToId.get(e.source);
      const dstId = absToId.get(e.target);
      if (!srcId || !dstId) continue;
      const k = edgeKey(srcId, dstId, "similar");
      if (!seenEdges.has(k)) {
        seenEdges.add(k);
        edges.push({ source: srcId, target: dstId, type: "similar" });
      }
    }
  }

  // 标签节点（文件 -> tag）
  if (want.has("tags")) {
    const tagNodeIds = new Map();
    for (const f of all) {
      for (const t of f.doc.tags.slice(0, 10)) {
        const tid = `tag/${t}`;
        if (!tagNodeIds.has(tid)) {
          tagNodeIds.set(tid, nodes.length);
          nodes.push({ id: tid, label: "#" + t, size: 8, type: "tag" });
        }
        const k = edgeKey(nodeId(f), tid, "tag");
        if (!seenEdges.has(k)) {
          seenEdges.add(k);
          edges.push({ source: nodeId(f), target: tid, type: "tag" });
        }
      }
    }
  }

  // 目录节点（文件 -> 一级目录，仅顶层文件夹）
  if (want.has("folders")) {
    const folderNodeIds = new Map();
    for (const f of all) {
      const idx = f.relPath.indexOf("/");
      if (idx === -1) continue;
      const topDir = f.relPath.slice(0, idx);
      const fid = `dir/${topDir}`;
      if (!folderNodeIds.has(fid)) {
        folderNodeIds.set(fid, nodes.length);
        nodes.push({ id: fid, label: "📁 " + topDir, size: 6, type: "folder" });
      }
      const k = edgeKey(nodeId(f), fid, "folder");
      if (!seenEdges.has(k)) {
        seenEdges.add(k);
        edges.push({ source: nodeId(f), target: fid, type: "folder" });
      }
    }
  }

  // 超大图保护：只保留有边的节点 + 最多 maxNodes
  if (nodes.length > maxNodes) {
    const connected = new Set();
    for (const e of edges) {
      connected.add(e.source);
      connected.add(e.target);
    }
    let kept = [...connected].slice(0, maxNodes);
    const keptSet = new Set(kept);
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const filteredNodes = kept.map((id) => nodeById.get(id)).filter(Boolean);
    const filteredEdges = edges.filter((e) => keptSet.has(e.source) && keptSet.has(e.target));
    return { nodes: filteredNodes, edges: filteredEdges, meta: { total: all.length, capped: true } };
  }
  return { nodes, edges, meta: { total: all.length, capped: false } };
}

// ---------- IMA 云端知识库代理 ----------
function imaCredentialsConfigured() {
  const home = os.homedir();
  return !!(process.env.IMA_OPENAPI_CLIENTID || process.env.IMA_CLIENT_ID || fs.existsSync(path.join(home, ".config", "ima", "client_id")));
}

function runImaApi(apiPath, body = {}) {
  return new Promise((resolve) => {
    const cfg = loadConfig();
    const script = path.join(cfg.imaSkillDir, "ima_api.cjs");
    if (!fs.existsSync(script)) {
      return resolve({ ok: false, error: `ima_api.cjs 不存在: ${script}` });
    }
    execFile(
      process.execPath,
      [script, apiPath, JSON.stringify(body), "{}"],
      { windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) {
          // 程序错误：stderr 有结构化 JSON
          try {
            const j = JSON.parse(stderr.trim());
            return resolve({ ok: false, code: j.code, error: j.msg });
          } catch {
            return resolve({ ok: false, error: String(err.message || err) });
          }
        }
        // 去掉 stdout 里可能的非 JSON 前缀行（如 wsl 提示）
        let text = stdout.trim();
        const firstBrace = text.indexOf("{");
        if (firstBrace > 0) text = text.slice(firstBrace);
        try {
          const j = JSON.parse(text);
          if (j.code === 0) return resolve({ ok: true, data: j.data });
          return resolve({ ok: false, code: j.code, error: j.msg });
        } catch {
          return resolve({ ok: false, error: "IMA 响应解析失败", raw: text.slice(0, 300) });
        }
      }
    );
  });
}

export async function imaStatus() {
  return { configured: imaCredentialsConfigured() };
}

export async function imaListBases() {
  const r = await runImaApi("openapi/wiki/v1/search_knowledge_base", { query: "", cursor: "", limit: 20 });
  if (!r.ok) return r;
  const list = (r.data?.records || []).map((b) => ({ id: b.knowledge_base_id, name: b.name || b.knowledge_base_name || "未命名" }));
  return { ok: true, bases: list };
}

export async function imaSearch(query, kbId) {
  const body = kbId ? { query, knowledge_base_id: kbId, cursor: "" } : { query, cursor: "" };
  const r = await runImaApi("openapi/wiki/v1/search_knowledge", body);
  if (!r.ok) return r;
  const items = (r.data?.records || []).map((x) => ({
    media_id: x.media_id,
    title: x.title || x.name || "",
    type: x.media_type,
    snippet: x.summary || x.content_preview || "",
  }));
  return { ok: true, items };
}

export async function imaDoc(mediaId) {
  const r = await runImaApi("openapi/wiki/v1/get_media_info", { media_id: mediaId });
  if (!r.ok) return r;
  const info = r.data;
  // 笔记类型(11) → 需要再取正文
  if (info.media_type === 11 && info.notebook_ext_info?.notebook_id) {
    const c = await runImaApi("openapi/note/v1/get_doc_content", { note_id: info.notebook_ext_info.notebook_id });
    if (!c.ok) return c;
    return { ok: true, title: info.title || "", content: c.data?.content || "", type: "note" };
  }
  return { ok: true, title: info.title || "", url: info.url || "", type: info.media_type };
}

// 启动时预扫描（静默失败）
scan().catch(() => {});
