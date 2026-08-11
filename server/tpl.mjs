/**
 * 模版库服务（tpl.mjs）
 *
 * 扫描本地交通规划模版目录，提供分类列表和内容预览。
 * 模版来源：
 *   - .claude/skills/ 下的交通报告写作 SKILL.md（真模板）
 *   - _报告模板/ 下的 docx/pdf/md 实例
 *   - 零碳货运白皮书/1会前/ 下的行政模板
 *   - 义乌物流项目/04_调研执行/ 下的调研模板
 *   - 衢州多式联运项目/ 下的研究框架
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", ".."); // F:\Claude code本地文件

// ── 模版分类定义 ──
const CATEGORIES = [
  { id: "gongwen",   name: "公文版面", icon: "📋", dirs: ["_报告模板/公文版面", ".claude/skills/gongwen-banmian"], exts: [".md", ".docx", ".doc", ".pdf"] },
  { id: "huibao",    name: "工作汇报", icon: "📊", dirs: [".claude/skills/gongzuo-huibao", "_报告模板/工作汇报"], exts: [".md", ".docx", ".doc", ".pdf"] },
  { id: "yanjiu",    name: "研究报告", icon: "📑", dirs: [".claude/skills/yanjiu-baogao", "_报告模板/研究报告"], exts: [".md", ".docx", ".doc", ".pdf"] },
  { id: "guihua",    name: "规划报告", icon: "🗺️", dirs: [".claude/skills/guihua-baogao", "_报告模板/规划报告"], exts: [".md", ".docx", ".doc", ".pdf"] },
  { id: "hangye",    name: "行业研究", icon: "📈", dirs: [".claude/skills/hangye-yanjiu-baogao"], exts: [".md", ".docx", ".doc", ".pdf"] },
  { id: "lunwen",    name: "论文写作", icon: "📝", dirs: [".claude/skills/lunwen", ".claude/skills/academic-writing", "_报告模板/论文"], exts: [".md", ".docx", ".doc", ".pdf"] },
  { id: "huiyi",     name: "会议通知/纪要", icon: "📅", dirs: ["零碳货运白皮书/1会前", "义乌物流专题资料"], exts: [".md", ".docx", ".doc", ".pdf"] },
  { id: "diaoyan",   name: "调研问卷", icon: "❓", dirs: ["义乌物流项目/04_调研执行/docs/superpowers/specs", "义乌物流专题资料"], exts: [".md", ".docx", ".doc"] },
  { id: "kuangjia",  name: "研究框架", icon: "🏗️", dirs: ["衢州多式联运项目", "柬埔寨公交项目"], exts: [".md"] },
  { id: "tubiao",    name: "图表/地图", icon: "📊", dirs: ["交通规划工作台/模板/图表模板", "交通规划工作台/模板/HTML模板", ".claude/skills/traffic-charts-template", ".claude/skills/traffic-map-template"], exts: [".md", ".html", ".js"] },
];

const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "__pycache__", ".obsidian", "dist", "build"]);

let _cache = null;

function walkDir(dir, baseRel, out, maxDepth = 3, depth = 0) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    const rel = baseRel ? `${baseRel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walkDir(abs, rel, out, maxDepth, depth + 1);
    } else if (e.isFile()) {
      out.push({ abs, rel, name: e.name });
    }
  }
}

function parseTitle(absPath, name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".md" || ext === ".markdown") {
    try {
      const content = fs.readFileSync(absPath, "utf8").slice(0, 2000);
      const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (fm) {
        const titleLine = fm[1].split("\n").find((l) => /^\s*title\s*:/i.test(l));
        if (titleLine) return titleLine.replace(/^\s*title\s*:\s*/i, "").replace(/^['"]|['"]$/g, "").trim();
      }
      const h1 = content.match(/^#\s+(.+)$/m);
      if (h1) return h1[1].trim();
    } catch {}
  }
  return name.replace(/\.[^.]+$/, "").replace(/_/g, " ");
}

function scanTemplates() {
  const templates = [];
  for (const cat of CATEGORIES) {
    for (const dir of cat.dirs) {
      const absDir = path.join(ROOT, dir);
      if (!fs.existsSync(absDir)) continue;
      const files = [];
      walkDir(absDir, dir, files, 2);
      for (const f of files) {
        const ext = path.extname(f.name).toLowerCase();
        if (!cat.exts.includes(ext)) continue;
        const st = fs.statSync(f.abs);
        templates.push({
          id: `${cat.id}/${f.rel}`,
          category: cat.id,
          name: f.name,
          relPath: f.rel,
          title: parseTitle(f.abs, f.name),
          ext: ext.slice(1),
          size: st.size,
          mtime: st.mtimeMs,
          type: ext === ".md" || ext === ".markdown" ? "markdown" : ext === ".html" || ext === ".htm" ? "html" : ext === ".docx" || ext === ".doc" ? "word" : ext === ".pdf" ? "pdf" : ext === ".pptx" || ext === ".ppt" ? "ppt" : ext === ".xlsx" || ext === ".xls" ? "xls" : "other",
        });
      }
    }
  }
  // 去重（同一 relPath 出现在多个分类时保留第一个）
  const seen = new Set();
  const deduped = [];
  for (const t of templates) {
    if (seen.has(t.relPath)) continue;
    seen.add(t.relPath);
    deduped.push(t);
  }
  return deduped;
}

export function getTemplates() {
  if (!_cache) _cache = scanTemplates();
  return _cache;
}

export function getCategories() {
  return CATEGORIES.map((c) => ({ id: c.id, name: c.name, icon: c.icon }));
}

export function getTemplatesByCategory(categoryId) {
  const all = getTemplates();
  if (!categoryId || categoryId === "all") return all;
  return all.filter((t) => t.category === categoryId);
}

export function getTemplateContent(relPath) {
  const absPath = path.join(ROOT, relPath);
  if (!fs.existsSync(absPath)) return null;
  const ext = path.extname(absPath).toLowerCase();
  const st = fs.statSync(absPath);
  if (ext === ".md" || ext === ".markdown" || ext === ".txt" || ext === ".html" || ext === ".htm") {
    try {
      const content = fs.readFileSync(absPath, "utf8");
      return { type: "text", content, ext: ext.slice(1), size: st.size };
    } catch { return null; }
  }
  // 二进制文件：返回类型信息（前端用 iframe 渲染）
  if (ext === ".docx" || ext === ".doc") return { type: "word", ext: ext.slice(1), size: st.size, relPath };
  if (ext === ".pdf") return { type: "pdf", ext: ext.slice(1), size: st.size, relPath };
  if (ext === ".pptx" || ext === ".ppt") return { type: "ppt", ext: ext.slice(1), size: st.size, relPath };
  if (ext === ".xlsx" || ext === ".xls") return { type: "xls", ext: ext.slice(1), size: st.size, relPath };
  return { type: "binary", ext: ext.slice(1), size: st.size, relPath };
}

// 重新扫描（目录变更后调用）
export function refresh() { _cache = null; }
