/**
 * 文件内容差异（W3/C02）：纯函数，无 IO、无副作用，便于测试与在路由层加输入上限。
 *
 * 能力分层（按计划 C02 的实现顺序，先做文本）：
 *   1. 文本 / Markdown / CSV / JSON / 代码 → 真实增删行 + 分页 hunks；
 *   2. Word / PPT / Excel → 结构化摘要 + 明确“暂不支持精确对齐”，不猜测匹配；
 *   3. PDF / 图片 / 其他二进制 → 大小/hash 变化摘要。
 *
 * 上限：单侧输入字节、行数、响应 hunks 与字节数都有明确上限，避免大文件阻塞主线程。
 */

export const DIFF_ALGO_VERSION = "text-hunks-v1";

export const DIFF_LIMITS = Object.freeze({
  maxInputBytes: 2 * 1024 * 1024, // 单侧输入上限（超出截断并标注）
  maxLinesPerSide: 4000,          // 单侧参与比对的行走上限
  maxHunksPerPage: 20,
  contextLines: 3,
  maxOutputBytes: 512 * 1024,
});

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "yml", "yaml", "html", "htm",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "scss", "less", "py", "sh", "bash", "zsh",
  "sql", "ini", "toml", "conf", "log", "srt", "vtt", "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "rb", "php",
]);
const OFFICE_EXTENSIONS = new Set(["docx", "doc", "pptx", "ppt", "xlsx", "xls"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "tif", "tiff", "heic"]);

export function extensionOf(relativePath) {
  const name = String(relativePath || "").replace(/\\/g, "/").split("/").pop() || "";
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1).toLowerCase() : "";
}

/** 文件类别：text | office | image | pdf | binary */
export function classifyFileKind(relativePath, { sniff = "" } = {}) {
  const ext = extensionOf(relativePath);
  if (OFFICE_EXTENSIONS.has(ext)) return "office";
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  // 无扩展名或未知扩展名：用内容嗅探兜底（出现 NUL 视为二进制）
  if (!ext) return sniff.includes("\u0000") ? "binary" : "text";
  return "binary";
}

/** 文本归一化：去 BOM、识别换行风格（差异按“行”比较，不因 CRLF/LF 误报）。 */
export function normalizeText(input) {
  const raw = typeof input === "string" ? input : Buffer.isBuffer(input) ? input.toString("utf8") : String(input ?? "");
  const hadBom = raw.charCodeAt(0) === 0xfeff;
  const body = hadBom ? raw.slice(1) : raw;
  const crlf = /\r\n/.test(body);
  return { text: body.replace(/\r\n?/g, "\n"), eol: crlf ? "\r\n" : "\n", hadBom };
}

export function splitLines(text) {
  const value = String(text ?? "");
  if (value === "") return [];
  const lines = value.split("\n");
  // 末尾换行不算多出一行（"a\n" 与 "a" 行内容相同）
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * 行级差异（LCS）。返回 ops：{ type: "equal"|"insert"|"delete", line, text }
 * 行数超过上限时退化为“整体替换”摘要，避免 O(n*m) 卡死主线程。
 */
export function lineDiff(beforeLines = [], afterLines = [], { maxLines = DIFF_LIMITS.maxLinesPerSide } = {}) {
  const a = Array.isArray(beforeLines) ? beforeLines : [];
  const b = Array.isArray(afterLines) ? afterLines : [];
  if (a.length > maxLines || b.length > maxLines) {
    const ops = [];
    for (const text of a) ops.push({ type: "delete", text });
    for (const text of b) ops.push({ type: "insert", text });
    return { ops, degraded: true };
  }
  const n = a.length;
  const m = b.length;
  // DP 表：Uint32Array 减少内存；仅保留长度无关的行号回溯即可
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + (j + 1)] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      ops.push({ type: "delete", text: a[i] });
      i += 1;
    } else {
      ops.push({ type: "insert", text: b[j] });
      j += 1;
    }
  }
  while (i < n) { ops.push({ type: "delete", text: a[i] }); i += 1; }
  while (j < m) { ops.push({ type: "insert", text: b[j] }); j += 1; }
  return { ops, degraded: false };
}

export function summarizeOps(ops = []) {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === "insert") added += 1;
    else if (op.type === "delete") removed += 1;
  }
  return { added, removed, changed: added + removed };
}

/** 把 ops 聚合为带上下文的分页 hunks（附 before/after 行号，便于渲染双栏或统一视图）。 */
export function buildHunks(ops = [], {
  context = DIFF_LIMITS.contextLines,
  maxHunks = DIFF_LIMITS.maxHunksPerPage,
  page = 0,
} = {}) {
  const groups = [];
  let current = null;
  let beforeLine = 1;
  let afterLine = 1;
  const pushOp = (op) => {
    if (!current) {
      current = { ops: [], beforeStart: beforeLine, afterStart: afterLine };
      groups.push(current);
    }
    current.ops.push({ ...op, beforeLine: op.type === "insert" ? null : beforeLine, afterLine: op.type === "delete" ? null : afterLine });
    if (op.type !== "insert") beforeLine += 1;
    if (op.type !== "delete") afterLine += 1;
  };
  let trailingEqual = 0;
  for (const op of ops) {
    if (op.type === "equal") {
      trailingEqual += 1;
      if (current) {
        if (trailingEqual <= context * 2) pushOp(op);
        else {
          // 超出上下文：截断当前 hunk，丢弃多余的中间 equal
          const keep = current.ops.slice(-context);
          current.ops = [...current.ops.slice(0, Math.max(0, current.ops.length - (trailingEqual - context))), ...keep.slice(0, context)];
          current = null;
        }
      }
      continue;
    }
    trailingEqual = 0;
    pushOp(op);
  }
  // 去掉每个 hunk 尾部多余的 equal，只保留 context 行
  const trimmed = groups.map((group) => {
    let end = group.ops.length;
    while (end > 0 && group.ops[end - 1].type === "equal") end -= 1;
    const opsWithTail = group.ops.slice(0, Math.min(group.ops.length, end + (group.ops.length > end ? context : 0)));
    return { ...group, ops: opsWithTail };
  }).filter((group) => group.ops.some((op) => op.type !== "equal"));
  const start = Math.max(0, page) * maxHunks;
  const pageHunks = trimmed.slice(start, start + maxHunks);
  return {
    hunks: pageHunks,
    hunkTotal: trimmed.length,
    page: Math.max(0, page),
    pageCount: Math.max(1, Math.ceil(trimmed.length / maxHunks)),
    truncatedHunks: trimmed.length > start + pageHunks.length,
  };
}

/** 文本差异：输入原文，输出摘要 + 分页 hunks（含输入上限标注）。 */
export function diffText({ beforeText = "", afterText = "", relativePath = "", page = 0, limits = {} } = {}) {
  const config = { ...DIFF_LIMITS, ...limits };
  const beforeNormalized = normalizeText(beforeText);
  const afterNormalized = normalizeText(afterText);
  const beforeClipped = beforeNormalized.text.length > config.maxInputBytes;
  const afterClipped = afterNormalized.text.length > config.maxInputBytes;
  const before = beforeClipped ? beforeNormalized.text.slice(0, config.maxInputBytes) : beforeNormalized.text;
  const after = afterClipped ? afterNormalized.text.slice(0, config.maxInputBytes) : afterNormalized.text;
  const { ops, degraded } = lineDiff(splitLines(before), splitLines(after), { maxLines: config.maxLinesPerSide });
  const summary = summarizeOps(ops);
  const hunks = buildHunks(ops, { context: config.contextLines, maxHunks: config.maxHunksPerPage, page });
  return {
    kind: "text",
    algo: DIFF_ALGO_VERSION,
    relativePath: String(relativePath || ""),
    summary,
    identical: summary.changed === 0,
    hunks: hunks.hunks,
    hunkTotal: hunks.hunkTotal,
    page: hunks.page,
    pageCount: hunks.pageCount,
    truncatedHunks: hunks.truncatedHunks,
    degraded,
    inputTruncated: beforeClipped || afterClipped,
    eol: { before: beforeNormalized.eol, after: afterNormalized.eol, changed: beforeNormalized.eol !== afterNormalized.eol },
    bom: { before: beforeNormalized.hadBom, after: afterNormalized.hadBom },
  };
}

/** 非文本（Office / PDF / 图片 / 二进制）：给大小与 hash 摘要，并明确支持边界。 */
export function diffOpaque({ before = {}, after = {}, relativePath = "" } = {}) {
  const kind = classifyFileKind(relativePath);
  const beforeSize = Number.isFinite(before.size) ? before.size : null;
  const afterSize = Number.isFinite(after.size) ? after.size : null;
  const hashChanged = Boolean(before.hash && after.hash) ? before.hash !== after.hash : null;
  const note = kind === "office"
    ? "Office 文档暂未提供精确内容对齐（段落/表格/页级差异见计划 D02/D03），当前仅显示大小与哈希变化，避免把匹配猜测当事实。"
    : kind === "pdf"
      ? "PDF 暂未提供文本层差异（见计划 D04），当前仅显示大小与哈希变化。"
      : kind === "image"
        ? "图片暂未提供像素级对比（见计划 D04），当前仅显示大小与哈希变化。"
        : "二进制文件不提供内容差异，仅显示大小与哈希变化。";
  return {
    kind,
    algo: DIFF_ALGO_VERSION,
    relativePath: String(relativePath || ""),
    summary: {
      changed: hashChanged === null ? (beforeSize === afterSize ? 0 : 1) : (hashChanged ? 1 : 0),
      added: 0,
      removed: 0,
      beforeSize,
      afterSize,
      sizeDelta: beforeSize != null && afterSize != null ? afterSize - beforeSize : null,
      hashChanged,
    },
    identical: hashChanged === false || (hashChanged === null && beforeSize != null && beforeSize === afterSize),
    hunks: [],
    hunkTotal: 0,
    page: 0,
    pageCount: 1,
    note,
    preciseAlignment: false,
  };
}

/**
 * 统一入口：按类别选择文本差异或摘要差异。
 * @param {{ relativePath: string, beforeBuffer?: Buffer|string, afterBuffer?: Buffer|string, before?: object, after?: object, page?: number }} input
 */
export function diffFileContents({ relativePath = "", beforeBuffer = null, afterBuffer = null, before = {}, after = {}, page = 0 } = {}) {
  const hasBeforeText = typeof beforeBuffer === "string" || Buffer.isBuffer(beforeBuffer);
  const hasAfterText = typeof afterBuffer === "string" || Buffer.isBuffer(afterBuffer);
  const sniff = hasBeforeText ? String(beforeBuffer).slice(0, 512) : (hasAfterText ? String(afterBuffer).slice(0, 512) : "");
  const kind = classifyFileKind(relativePath, { sniff });
  if (kind === "text" && (hasBeforeText || hasAfterText)) {
    return diffText({
      beforeText: hasBeforeText ? beforeBuffer : "",
      afterText: hasAfterText ? afterBuffer : "",
      relativePath,
      page,
    });
  }
  return diffOpaque({ before, after, relativePath });
}
