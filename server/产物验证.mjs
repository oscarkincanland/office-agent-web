import fs from "node:fs";
import path from "node:path";

const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "csv", "json", "geojson", "html", "htm"]);
const OFFICE_EXTENSIONS = new Set(["docx", "xlsx", "pptx"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "svg"]);

function isInside(root, target) {
  const base = path.resolve(root);
  const full = path.resolve(target);
  return full === base || full.startsWith(base + path.sep);
}

function readSignature(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(8);
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

/** 对本轮新增/修改文件做轻量结构校验，不替代 Word/Excel/PPT 的视觉验收。 */
export function validateArtifactFile(file, root = path.dirname(file), relativePath = path.basename(file)) {
  const checkedAt = new Date().toISOString();
  const target = path.resolve(file);
  const rel = String(relativePath || path.basename(target)).replace(/\\/g, "/");
  const base = path.resolve(root);
  if (!isInside(base, target)) return { path: rel, status: "failed", message: "产物不在当前工作区内", checkedAt };
  if (!fs.existsSync(target)) return { path: rel, status: "failed", message: "产物文件不存在", checkedAt };
  let stat;
  try { stat = fs.statSync(target); } catch (error) { return { path: rel, status: "failed", message: `无法读取产物：${error.message}`, checkedAt }; }
  if (!stat.isFile()) return { path: rel, status: "failed", message: "产物不是文件", checkedAt };
  if (stat.size <= 0) return { path: rel, status: "failed", message: "产物文件为空", checkedAt, size: stat.size };

  const ext = path.extname(target).slice(1).toLowerCase();
  try {
    if (OFFICE_EXTENSIONS.has(ext)) {
      const signature = readSignature(target);
      const zipContainer = signature[0] === 0x50 && signature[1] === 0x4b;
      return {
        path: rel,
        format: ext,
        status: zipContainer ? "passed" : "failed",
        message: zipContainer ? "Office ZIP 容器签名正常" : "不是有效的 Office ZIP 容器",
        checkedAt,
        size: stat.size,
      };
    }
    if (ext === "pdf") {
      const signature = readSignature(target).toString("ascii", 0, 4);
      return { path: rel, format: ext, status: signature === "%PDF" ? "passed" : "failed", message: signature === "%PDF" ? "PDF 文件头正常" : "PDF 文件头无效", checkedAt, size: stat.size };
    }
    if (TEXT_EXTENSIONS.has(ext)) {
      const text = fs.readFileSync(target, "utf8");
      if (!text.trim()) return { path: rel, format: ext, status: "failed", message: "文本产物为空", checkedAt, size: stat.size };
      if (ext === "json" || ext === "geojson") {
        try { JSON.parse(text); } catch { return { path: rel, format: ext, status: "failed", message: "JSON 结构不可解析", checkedAt, size: stat.size }; }
      }
      return { path: rel, format: ext, status: "passed", message: "文本内容可读取" + ((ext === "json" || ext === "geojson") ? "，JSON 结构可解析" : ""), checkedAt, size: stat.size };
    }
    if (IMAGE_EXTENSIONS.has(ext)) return { path: rel, format: ext, status: "passed", message: "图片产物非空", checkedAt, size: stat.size };
    return { path: rel, format: ext || "unknown", status: "not_applicable", message: "暂不执行该格式的结构校验", checkedAt, size: stat.size };
  } catch (error) {
    return { path: rel, format: ext || "unknown", status: "failed", message: `产物校验失败：${error.message}`, checkedAt, size: stat.size };
  }
}

export function validateArtifacts(paths = [], root) {
  const workspace = path.resolve(root || process.cwd());
  return (Array.isArray(paths) ? paths : []).map((item) => {
    const rel = typeof item === "string" ? item : item?.path;
    return validateArtifactFile(path.resolve(workspace, String(rel || "")), workspace, rel);
  });
}
