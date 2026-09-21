/**
 * 从 docx 包内 XML 提取真实标题大纲（Word 目录用）。
 *
 * 为什么不用 DOM 启发式：docx-preview 渲染出的段落类名是 `oaw-docx_<styleId>`，
 * 并不含 heading 字样；只看类名或"加粗+编号"的启发式会把正文里的编号段落（附件模板
 * 里成百上千条）也当成标题——实测出现 917 条"目录"，与 Word 的 50 条标题完全不符。
 *
 * 这里直接读 word/document.xml 与 word/styles.xml：
 *  - 段落级 w:outlineLvl 优先；
 *  - 否则用 w:pStyle → styles.xml 里该样式的 w:outlineLvl 或 w:name（heading N / 标题 N）。
 */
import JSZip from "jszip";

const DECODE = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text) {
  return String(text || "").replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (all, token) => {
    if (token.startsWith("#x") || token.startsWith("#X")) return String.fromCodePoint(parseInt(token.slice(2), 16));
    if (token.startsWith("#")) return String.fromCodePoint(parseInt(token.slice(1), 10));
    return DECODE[token] ?? all;
  });
}

/** 提取一个 <w:p> 的可见文字（只取 w:t，制表符/换行算空格） */
function paragraphText(xml) {
  const parts = [];
  for (const match of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) parts.push(match[1]);
  if (parts.length === 0) return "";
  return decodeEntities(parts.join("")).replace(/\s+/g, " ").trim();
}

/** 样式表：styleId → { level, name } */
function readStyles(stylesXml) {
  const styles = new Map();
  for (const match of String(stylesXml || "").matchAll(/<w:style\s[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const id = match[1];
    const body = match[2];
    const name = (body.match(/<w:name\s+w:val="([^"]+)"/) || [])[1] || "";
    let level = null;
    const outline = body.match(/<w:outlineLvl\s+w:val="(\d+)"/);
    if (outline) level = Number(outline[1]);
    if (level === null) {
      const heading = name.match(/^heading\s*(\d+)/i) || name.match(/^(?:标题|標題)\s*(\d+)/);
      if (heading) level = Number(heading[1]) - 1;
    }
    styles.set(id, { level, name });
  }
  return styles;
}

/**
 * @param {ArrayBuffer|Uint8Array} data docx 原始字节
 * @returns {Promise<{items: {level:number,text:string}[], headingClasses: {className:string,level:number}[]}>}
 */
export async function extractDocxOutline(data) {
  const empty = { items: [], headingClasses: [] };
  try {
    const zip = await JSZip.loadAsync(data);
    const documentFile = zip.file("word/document.xml");
    if (!documentFile) return empty;
    const [documentXml, stylesXml] = await Promise.all([
      documentFile.async("string"),
      zip.file("word/styles.xml")?.async("string") || Promise.resolve(""),
    ]);
    const styles = readStyles(stylesXml);

    const items = [];
    const usedStyleIds = new Set();
    const body = documentXml.match(/<w:body>[\s\S]*<\/w:body>/);
    const source = body ? body[0] : documentXml;
    for (const match of source.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)) {
      const paragraph = match[0];
      const text = paragraphText(paragraph);
      if (!text) continue;
      let level = null;
      const styleId = (paragraph.match(/<w:pStyle\s+w:val="([^"]+)"/) || [])[1] || null;
      const direct = paragraph.match(/<w:outlineLvl\s+w:val="(\d+)"/);
      if (direct) level = Number(direct[1]);
      else if (styleId && styles.get(styleId)?.level !== null && styles.get(styleId)?.level !== undefined) level = styles.get(styleId).level;
      if (level === null || Number.isNaN(level)) continue;
      items.push({ level: Math.min(6, Math.max(1, level + 1)), text: text.slice(0, 160) });
      if (styleId) usedStyleIds.add(styleId);
    }

    // docx-preview 用 oaw-docx_<styleId> 作为段落类名，便于把大纲条目对回 DOM
    const headingClasses = [...usedStyleIds].map((styleId) => ({
      className: `oaw-docx_${styleId}`,
      level: Math.min(6, Math.max(1, (styles.get(styleId)?.level ?? 0) + 1)),
    }));
    return { items, headingClasses };
  } catch {
    return empty;
  }
}
