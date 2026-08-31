import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { validateArtifactFile } from "./产物验证.mjs";
import { checkOfficecli, runOfficecli } from "./office.mjs";

const OFFICE_EXTENSIONS = new Set(["docx", "xlsx", "pptx"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);
const NOT_CHECKED = "not_checked";

function check(id, status, message, details = {}) {
  return { id, status, message, ...details };
}

function group(status, checks = [], required = true) {
  return { status, required, checks };
}

function highestStatus(statuses) {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("manual_review")) return "manual_review";
  if (statuses.includes("warning")) return "warning";
  if (statuses.every((status) => ["passed", "not_applicable"].includes(status))) return "passed";
  return NOT_CHECKED;
}

function cliText(result) {
  return String(result?.json?.message || result?.json?.error?.message || result?.stderr || result?.text || "").trim().slice(0, 500);
}

function resultData(result) {
  return result?.json?.data ?? null;
}

function resultWarnings(result) {
  const warnings = result?.json?.warnings;
  return Array.isArray(warnings) ? warnings : [];
}

function hashFile(file) {
  return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
}

function safeRules(rules = {}) {
  return {
    requiredText: Array.isArray(rules.requiredText) ? rules.requiredText.map(String).filter(Boolean).slice(0, 30) : [],
    requiredSheets: Array.isArray(rules.requiredSheets) ? rules.requiredSheets.map(String).filter(Boolean).slice(0, 30) : [],
    requiredCells: Array.isArray(rules.requiredCells) ? rules.requiredCells.slice(0, 30) : [],
    minPages: Number.isFinite(Number(rules.minPages)) ? Math.max(0, Number(rules.minPages)) : 0,
    minFormulas: Number.isFinite(Number(rules.minFormulas)) ? Math.max(0, Number(rules.minFormulas)) : 0,
  };
}

function flattenText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(flattenText).join("\n");
  if (typeof value === "object") return Object.entries(value).map(([key, item]) => `${key} ${flattenText(item)}`).join("\n");
  return "";
}

function imageDimensions(file, ext) {
  const buffer = fs.readFileSync(file);
  if (ext === "png" && buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (ext === "webp" && buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const type = buffer.toString("ascii", 12, 16);
    if (type === "VP8X") return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  }
  if (["jpg", "jpeg"].includes(ext) && buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3) return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      if (!length) break;
      offset += 2 + length;
    }
  }
  return null;
}

async function officeStats(file, ext, officecli, cwd) {
  if (!officecli?.available) return { result: null, data: null, error: officecli?.message || "Office CLI 不可用" };
  const args = ["view", file, "stats", "--json"];
  if (ext === "docx") args.push("--page-count");
  try {
    const result = await runOfficecli(args, { cwd });
    return { result, data: resultData(result), error: result.code === 0 && resultData(result) ? null : cliText(result) || "无法读取 Office 统计信息" };
  } catch (error) {
    return { result: null, data: null, error: error.message };
  }
}

async function officeIssues(file, type, officecli, cwd) {
  if (!officecli?.available) return { status: "manual_review", checks: [check("officecli", "manual_review", officecli?.message || "Office CLI 不可用")] };
  try {
    const result = await runOfficecli(["view", file, "issues", "--type", type, "--json", "--limit", "100"], { cwd });
    if (result.code !== 0 || result.json?.error) return { status: "manual_review", checks: [check(`issues-${type}`, "manual_review", cliText(result) || "Office 问题扫描结果不确定")] };
    const data = resultData(result) || {};
    const issues = Array.isArray(data.issues) ? data.issues : [];
    return {
      status: issues.length ? "warning" : "passed",
      checks: [check(`issues-${type}`, issues.length ? "warning" : "passed", issues.length ? `发现 ${issues.length} 个${type}问题` : `未发现${type}问题`, { issues: issues.slice(0, 20) })],
    };
  } catch (error) {
    return { status: "manual_review", checks: [check(`issues-${type}`, "manual_review", `问题扫描不可用：${error.message}`)] };
  }
}

async function officeText(file, officecli, cwd) {
  if (!officecli?.available) return { text: "", error: officecli?.message || "Office CLI 不可用" };
  try {
    const result = await runOfficecli(["view", file, "text", "--json", "--max-lines", "500"], { cwd });
    return { text: resultData(result) ? flattenText(resultData(result)) : "", error: result.code === 0 ? null : cliText(result) || "无法读取 Office 文本" };
  } catch (error) {
    return { text: "", error: error.message };
  }
}

async function renderOffice(file, ext, officecli, cwd) {
  if (!officecli?.available) return { status: "manual_review", checks: [check("render", "manual_review", officecli?.message || "Office CLI 不可用")] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "规聚-成果验收-"));
  const output = path.join(dir, "成果预览.png");
  try {
    const args = ["view", file, "screenshot", "--out", output, "--json"];
    if (ext === "docx" || ext === "pptx") args.push("--grid", "auto");
    else args.push("--page", "1");
    const result = await runOfficecli(args, { cwd, timeoutMs: 180000 });
    const ok = result.code === 0 && fs.existsSync(output) && fs.statSync(output).size > 0;
    return {
      status: ok ? "passed" : "manual_review",
      checks: [check("render", ok ? "passed" : "manual_review", ok ? "已生成视觉预览" : (cliText(result) || "视觉预览未能生成"), { sample: ext === "xlsx" ? "第1页" : "全部页面缩略图" })],
    };
  } catch (error) {
    return { status: "manual_review", checks: [check("render", "manual_review", `视觉预览不可用：${error.message}`)] };
  } finally {
    try { await runOfficecli(["close", file], { cwd, timeoutMs: 10000 }); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function baseFailure(base, rel) {
  const failed = check("file", "failed", base.message || "文件基础检查失败");
  return {
    path: rel,
    format: base.format || path.extname(rel).slice(1).toLowerCase() || "unknown",
    status: "failed",
    readyToPublish: false,
    checks: {
      structure: group("failed", [failed]),
      content: group(NOT_CHECKED, [], false),
      visual: group(NOT_CHECKED, [], false),
      manual: group("not_required", [], false),
    },
    summary: base.message || "文件基础检查失败",
    checkedAt: new Date().toISOString(),
  };
}

export async function evaluateArtifactFile(file, { root = path.dirname(file), relativePath = path.basename(file), rules = {}, officecli = null } = {}) {
  const base = validateArtifactFile(file, root, relativePath);
  const rel = String(relativePath || path.basename(file)).replace(/\\/g, "/");
  if (base.status !== "passed") return baseFailure(base, rel);
  const ext = String(base.format || path.extname(file).slice(1)).toLowerCase();
  const safe = safeRules(rules);
  const checkedAt = new Date().toISOString();

  if (OFFICE_EXTENSIONS.has(ext)) {
    const cli = officecli || await checkOfficecli();
    const structureChecks = [check("container", "passed", base.message || "文件容器可读取")];
    let structureStatus = "passed";
    if (!cli.available) {
      structureStatus = "manual_review";
      structureChecks.push(check("officecli", "manual_review", cli.message || "Office CLI 不可用"));
    } else {
      try {
        const result = await runOfficecli(["validate", file, "--json"]);
        const warnings = resultWarnings(result);
        if (result.code !== 0 || result.json?.error) {
          structureStatus = "manual_review";
          structureChecks.push(check("openxml", "manual_review", cliText(result) || "OpenXML 校验结果不确定", { warnings }));
        } else if (result.json?.success === true) {
          structureChecks.push(check("openxml", "passed", cliText(result) || "OpenXML 结构校验通过", { warnings }));
        } else {
          structureStatus = warnings.length ? "warning" : "manual_review";
          structureChecks.push(check("openxml", structureStatus, warnings.length ? `OpenXML 存在 ${warnings.length} 个警告` : "OpenXML 校验未明确通过", { warnings }));
        }
      } catch (error) {
        structureStatus = "manual_review";
        structureChecks.push(check("openxml", "manual_review", `OpenXML 校验不可用：${error.message}`));
      }
    }

    const stats = await officeStats(file, ext, cli, root);
    const contentChecks = [];
    let contentStatus = "passed";
    if (!stats.data) {
      contentStatus = "manual_review";
      contentChecks.push(check("stats", "manual_review", stats.error || "无法读取内容统计"));
    } else if (ext === "docx") {
      const pages = Number(stats.data.pages || 0);
      const paragraphs = Number(stats.data.paragraphs || 0);
      const characters = Number(stats.data.totalCharacters || 0);
      if (!paragraphs || !characters) { contentStatus = "failed"; contentChecks.push(check("content", "failed", "DOCX 没有可读的段落或正文内容")); }
      else contentChecks.push(check("content", "passed", `DOCX 内容可读取：${paragraphs} 个段落，${characters} 个字符`));
      if (pages && safe.minPages && pages < safe.minPages) { contentStatus = "failed"; contentChecks.push(check("pages", "failed", `页数 ${pages} 小于要求的 ${safe.minPages} 页`)); }
      else if (pages) contentChecks.push(check("pages", "passed", `DOCX 共 ${pages} 页`));
      if (Object.keys(stats.data.styleDistribution || {}).length) contentChecks.push(check("styles", "passed", "DOCX 样式分布可读取", { styleDistribution: stats.data.styleDistribution }));
    } else if (ext === "xlsx") {
      const sheets = Array.isArray(stats.data.sheets) ? stats.data.sheets : [];
      const sheetCount = Number(stats.data.sheets || 0);
      const cells = Number(stats.data.totalCells || 0);
      if (!sheetCount || !cells) { contentStatus = "failed"; contentChecks.push(check("content", "failed", "XLSX 没有可读取的工作表或单元格")); }
      else contentChecks.push(check("content", "passed", `XLSX 内容可读取：${sheetCount} 个工作表，${cells} 个单元格`));
      if (safe.requiredSheets.length && Array.isArray(stats.data.sheets)) {
        const names = sheets.map((item) => item.name);
        const missing = safe.requiredSheets.filter((name) => !names.includes(name));
        if (missing.length) { contentStatus = "failed"; contentChecks.push(check("required-sheets", "failed", `缺少工作表：${missing.join("、")}`)); }
        else contentChecks.push(check("required-sheets", "passed", "指定工作表均存在"));
      }
      const formulaCells = Number(stats.data.formulaCells || 0);
      if (safe.minFormulas && formulaCells < safe.minFormulas) { contentStatus = "failed"; contentChecks.push(check("formulas", "failed", `公式单元格 ${formulaCells} 小于要求的 ${safe.minFormulas}`)); }
      else contentChecks.push(check("formulas", "passed", `公式单元格：${formulaCells}`));
    } else {
      const slides = Number(stats.data.slides || 0);
      const shapes = Number(stats.data.totalShapes || 0);
      if (!slides || !shapes) { contentStatus = "failed"; contentChecks.push(check("content", "failed", "PPTX 没有可读取的页面或元素")); }
      else contentChecks.push(check("content", "passed", `PPTX 内容可读取：${slides} 页，${shapes} 个元素`));
      if (safe.minPages && slides < safe.minPages) { contentStatus = "failed"; contentChecks.push(check("slides", "failed", `页面数 ${slides} 小于要求的 ${safe.minPages} 页`)); }
    }

    if (safe.requiredText.length || safe.requiredCells.length || safe.requiredSheets.length) {
      const textResult = await officeText(file, cli, root);
      if (textResult.error) { contentStatus = "manual_review"; contentChecks.push(check("required-content", "manual_review", textResult.error)); }
      else {
        const haystack = textResult.text.toLowerCase();
        const missingText = safe.requiredText.filter((value) => !haystack.includes(value.toLowerCase()));
        const missingCells = safe.requiredCells.filter((value) => !haystack.includes(typeof value === "string" ? value.toLowerCase() : JSON.stringify(value).toLowerCase()));
        const missingSheets = safe.requiredSheets.filter((value) => !haystack.includes(value.toLowerCase()));
        if (missingText.length || missingCells.length || missingSheets.length) { contentStatus = "failed"; contentChecks.push(check("required-content", "failed", `缺少关键内容${missingText.length ? `：${missingText.join("、")}` : ""}${missingCells.length ? `；关键单元格未匹配：${missingCells.length} 个` : ""}${missingSheets.length ? `；工作表未匹配：${missingSheets.join("、")}` : ""}`)); }
        else contentChecks.push(check("required-content", "passed", "关键内容均可检索"));
      }
    }

    const contentIssueResult = await officeIssues(file, "content", cli, root);
    if (contentIssueResult.status === "warning") contentStatus = contentStatus === "failed" ? "failed" : "warning";
    if (contentIssueResult.status === "manual_review" && contentStatus !== "failed") contentStatus = "manual_review";
    contentChecks.push(...contentIssueResult.checks);

    const formatIssueResult = await officeIssues(file, "format", cli, root);
    const visual = await renderOffice(file, ext, cli, root);
    let visualStatus = visual.status;
    const visualChecks = [...formatIssueResult.checks, ...visual.checks];
    if (formatIssueResult.status === "warning" && visualStatus !== "manual_review") visualStatus = "warning";
    if (formatIssueResult.status === "manual_review" && visualStatus !== "failed") visualStatus = "manual_review";
    const manualRequired = [structureStatus, contentStatus, visualStatus].some((status) => ["warning", "manual_review"].includes(status));
    const manualStatus = manualRequired ? "pending" : "not_required";
    const statuses = [structureStatus, contentStatus, visualStatus, manualStatus === "pending" ? "manual_review" : "passed"];
    const status = highestStatus(statuses);
    return {
      path: rel,
      format: ext,
      status,
      readyToPublish: [structureStatus, contentStatus, visualStatus].every((value) => ["passed", "not_applicable"].includes(value)) && !manualRequired,
      checks: {
        structure: group(structureStatus, structureChecks),
        content: group(contentStatus, contentChecks),
        visual: group(visualStatus, visualChecks),
        manual: group(manualStatus, manualRequired ? [check("manual-confirmation", "pending", "存在警告或不确定结果，需要人工确认")] : [], manualRequired),
      },
      summary: status === "passed" ? "结构、内容和视觉验收通过" : manualRequired ? "存在警告或不确定结果，等待人工确认" : "验收失败",
      checkedAt,
      verifier: "server+officecli",
      rules: safe,
    };
  }

  if (ext === "pdf") {
    const buffer = fs.readFileSync(file);
    const pages = Math.max(1, (buffer.toString("latin1").match(/\/Type\s*\/Page(?:\s|\/|>)/g) || []).length);
    return {
      path: rel,
      format: ext,
      status: "manual_review",
      readyToPublish: false,
      checks: {
        structure: group("passed", [check("pdf-header", "passed", "PDF 文件头正常")]),
        content: group("passed", [check("pdf-pages", "passed", `PDF 可读取，至少 ${pages} 页`)]),
        visual: group("manual_review", [check("render", "manual_review", "当前服务未内置 PDF 页面渲染器")]),
        manual: group("pending", [check("manual-confirmation", "pending", "需要人工确认 PDF 页面显示效果")]),
      },
      summary: "PDF 可读取，但视觉效果需要人工确认",
      checkedAt,
      verifier: "server",
      rules: safe,
    };
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    const dimensions = imageDimensions(file, ext);
    const valid = dimensions && dimensions.width > 0 && dimensions.height > 0;
    const status = valid ? "passed" : "failed";
    return {
      path: rel,
      format: ext,
      status,
      readyToPublish: valid,
      checks: {
        structure: group(status, [check("image-header", status, valid ? "图片格式和尺寸可读取" : "图片尺寸不可读取", { dimensions })]),
        content: group(valid ? "passed" : "failed", [check("image-content", valid ? "passed" : "failed", valid ? `${dimensions.width}×${dimensions.height}` : "图片内容不可读取")]),
        visual: group(status, [check("image-preview", status, valid ? "图片可以直接预览" : "图片无法预览")]),
        manual: group("not_required", [], false),
      },
      summary: valid ? "图片格式、尺寸和可预览性通过" : "图片无法通过读取检查",
      checkedAt,
      verifier: "server",
      rules: safe,
    };
  }

  const contentStatus = base.status === "passed" ? "passed" : "failed";
  return {
    path: rel,
    format: ext || "unknown",
    status: contentStatus,
    readyToPublish: contentStatus === "passed",
    checks: {
      structure: group("passed", [check("file", "passed", base.message || "文件可读取")]),
      content: group(contentStatus, [check("content", contentStatus, base.message || "内容可读取")]),
      visual: group("not_applicable", [], false),
      manual: group("not_required", [], false),
    },
    summary: base.message || "文件可读取",
    checkedAt,
    verifier: "server",
    rules: safe,
  };
}

export async function evaluateRunArtifacts(run, { rules = {} } = {}) {
  const officecli = await checkOfficecli();
  const artifacts = (run?.artifacts || []).filter((item) => item.status !== "deleted");
  const results = [];
  for (const artifact of artifacts) {
    const target = path.resolve(run.cwd, artifact.path || "");
    const result = await evaluateArtifactFile(target, { root: run.cwd, relativePath: artifact.path, rules: rules[artifact.path] || rules || {}, officecli });
    try { result.fileHash = hashFile(target); } catch {}
    results.push(result);
  }
  const status = results.length ? highestStatus(results.map((item) => item.status)) : "not_checked";
  return {
    version: 1,
    runId: run?.id || null,
    status,
    readyToPublish: results.length > 0 && results.every((item) => item.readyToPublish),
    artifacts: results,
    checkedAt: new Date().toISOString(),
    verifier: officecli.available ? "server+officecli" : "server",
    officecli,
  };
}
