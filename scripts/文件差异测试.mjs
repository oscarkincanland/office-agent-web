#!/usr/bin/env node
/**
 * 文件改动与内容差异回归（W3：C01 / C02）
 *   1. 文本差异：增删行、hunks 上下文、分页、CRLF/BOM 不误报、超限退化与截断标注；
 *   2. 类别分派：文本 / Office / PDF / 图片 / 二进制，非文本只给摘要并明确“不支持精确对齐”；
 *   3. C01 字段：changeId 稳定、类型归一、来源与可信度、blob 可用性；
 *   4. 只读接口：changeId 必须由服务端 Run 记录解析（拒绝任意路径/穿越），输入有上限；
 *   5. 端到端（服务在跑时）：真实 changeId 200、伪造/穿越 404。
 * 用法: node scripts/文件差异测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DIFF_ALGO_VERSION,
  DIFF_LIMITS,
  buildHunks,
  classifyFileKind,
  diffFileContents,
  diffOpaque,
  diffText,
  extensionOf,
  lineDiff,
  normalizeText,
  splitLines,
  summarizeOps,
} from "../server/文件差异.mjs";
import { changeIdForPath } from "../server/runs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let failed = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { console.error(`  ✗ ${msg}`); failed = 1; };
function test(name, fn) {
  try { fn(); ok(name); } catch (error) { bad(`${name}: ${error.message}`); }
}

console.log("\n▶ 文本差异");

test("相同内容 → 无差异", () => {
  const diff = diffText({ beforeText: "a\nb\nc", afterText: "a\nb\nc", relativePath: "a.txt" });
  assert.equal(diff.kind, "text");
  assert.equal(diff.identical, true);
  assert.deepEqual(diff.summary.added, 0);
  assert.deepEqual(diff.summary.removed, 0);
  assert.equal(diff.hunks.length, 0);
  assert.equal(diff.algo, DIFF_ALGO_VERSION);
});

test("增删行统计与 hunk 上下文正确", () => {
  const before = ["1", "2", "3", "4", "5", "6", "7", "8"].join("\n");
  const after = ["1", "2", "3", "X", "4", "5", "6", "7", "8"].join("\n");
  const diff = diffText({ beforeText: before, afterText: after, relativePath: "a.md" });
  assert.deepEqual(diff.summary, { added: 1, removed: 0, changed: 1 });
  assert.equal(diff.hunks.length, 1, "应只有一个 hunk");
  const hunk = diff.hunks[0];
  assert.ok(hunk.ops.some((op) => op.type === "insert" && op.text === "X"), "应包含新增行");
  assert.ok(hunk.ops.filter((op) => op.type === "equal").length <= DIFF_LIMITS.contextLines * 2 + 1, "上下文行受控");
  const inserted = hunk.ops.find((op) => op.type === "insert");
  assert.equal(inserted.beforeLine, null, "新增行没有 before 行号");
  assert.ok(inserted.afterLine > 0, "新增行应有 after 行号");

  const removed = diffText({ beforeText: after, afterText: before, relativePath: "a.md" });
  assert.deepEqual(removed.summary, { added: 0, removed: 1, changed: 1 });
});

test("CRLF/LF 与 BOM 不产生假差异", () => {
  const diff = diffText({ beforeText: "a\r\nb\r\n", afterText: "\uFEFFa\nb\n", relativePath: "a.txt" });
  assert.equal(diff.identical, true, "换行风格与 BOM 不应算内容变化");
  assert.equal(diff.eol.changed, true, "仍应报告换行风格变化");
  assert.equal(diff.bom.after, true, "仍应报告 BOM");
  assert.equal(normalizeText("\uFEFFx\r\ny").text, "x\ny");
});

test("行数超限退化为整体替换；输入超限有标注", () => {
  const big = Array.from({ length: DIFF_LIMITS.maxLinesPerSide + 10 }, (_, i) => `line-${i}`).join("\n");
  const diff = diffText({ beforeText: big, afterText: `${big}\nnew`, relativePath: "big.txt" });
  assert.equal(diff.degraded, true, "超限应退化");
  assert.ok(diff.summary.removed >= DIFF_LIMITS.maxLinesPerSide, "退化时按整体替换统计");

  const huge = "x".repeat(DIFF_LIMITS.maxInputBytes + 10);
  const clipped = diffText({ beforeText: huge, afterText: "y", relativePath: "huge.txt" });
  assert.equal(clipped.inputTruncated, true, "超出输入上限应标注");
});

test("分页 hunks 与截断标记", () => {
  const ops = [];
  for (let block = 0; block < 30; block += 1) {
    // 每组改动之间隔 20 行相同内容，确保超出一段上下文后能被切成不同 hunk
    for (let i = 0; i < 20; i += 1) ops.push({ type: "equal", text: `ctx-${block}-${i}` });
    ops.push({ type: "delete", text: `old-${block}` });
    ops.push({ type: "insert", text: `new-${block}` });
  }
  const first = buildHunks(ops, { maxHunks: 3, page: 0 });
  assert.equal(first.pageCount > 1, true, "应多于 1 页");
  assert.equal(first.hunks.length, 3);
  assert.equal(first.truncatedHunks, true);
  const second = buildHunks(ops, { maxHunks: 3, page: 1 });
  assert.notDeepEqual(first.hunks, second.hunks, "第二页应与第一页不同");
});

test("行级工具函数行为正确", () => {
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(summarizeOps(lineDiff(["a"], ["b"]).ops), { added: 1, removed: 1, changed: 2 });
  assert.equal(extensionOf("a/b/Report.DOCX"), "docx");
});

console.log("\n▶ 类别分派与非文本摘要");

test("按扩展名/内容嗅探分类", () => {
  assert.equal(classifyFileKind("报告.docx"), "office");
  assert.equal(classifyFileKind("幻灯片.PPTX"), "office");
  assert.equal(classifyFileKind("数据.xlsx"), "office");
  assert.equal(classifyFileKind("手册.pdf"), "pdf");
  assert.equal(classifyFileKind("图.png"), "image");
  assert.equal(classifyFileKind("说明.md"), "text");
  assert.equal(classifyFileKind("noext", { sniff: "hello" }), "text");
  assert.equal(classifyFileKind("noext", { sniff: "a\u0000b" }), "binary");
  assert.equal(classifyFileKind("blob.bin"), "binary");
});

test("Office/PDF/图片只给摘要并明确不支持精确对齐", () => {
  const office = diffOpaque({ relativePath: "报告.docx", before: { size: 100, hash: "a" }, after: { size: 140, hash: "b" } });
  assert.equal(office.kind, "office");
  assert.equal(office.preciseAlignment, false);
  assert.equal(office.summary.sizeDelta, 40);
  assert.equal(office.summary.hashChanged, true);
  assert.match(office.note, /Office|段落|暂未/i);
  assert.equal(office.identical, false);

  const same = diffOpaque({ relativePath: "图.png", before: { size: 10, hash: "h" }, after: { size: 10, hash: "h" } });
  assert.equal(same.identical, true);
  assert.equal(same.summary.hashChanged, false);

  const pdf = diffOpaque({ relativePath: "a.pdf", before: { size: 1, hash: "x" }, after: { size: 2, hash: "y" } });
  assert.match(pdf.note, /PDF/i);
});

test("统一入口按类别分派", () => {
  const text = diffFileContents({ relativePath: "a.txt", beforeBuffer: "a", afterBuffer: "b" });
  assert.equal(text.kind, "text");
  assert.equal(text.summary.changed, 2);
  const office = diffFileContents({ relativePath: "b.docx", beforeBuffer: Buffer.from("xx"), afterBuffer: Buffer.from("yy") });
  assert.equal(office.kind, "office", "Office 不走文本比对");
});

console.log("\n▶ C01 变更字段与安全边界");

test("changeId 稳定且可复现", () => {
  const a = changeIdForPath("审查报告.md");
  const b = changeIdForPath("审查报告.md");
  const c = changeIdForPath("其他.md");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^change_[0-9a-f]{12}$/);
  assert.equal(changeIdForPath("a\\b\\c.txt"), changeIdForPath("a/b/c.txt"), "路径分隔符应归一");
});

test("runs.mjs 补全审计字段并剔除无内容差异的疑似变更", () => {
  const src = read("server/runs.mjs");
  assert.match(src, /export function changeIdForPath/, "应有稳定 changeId");
  assert.match(src, /function finalizeFileChanges\(run, changes, after\)/, "应有变更补全函数");
  assert.match(src, /changeType: type|changeType,/, "应写入归一后的类型");
  assert.match(src, /source,/, "应记录检测来源");
  assert.match(src, /confidence,/, "应记录可信度");
  assert.match(src, /blobs: \{ before: beforeReversible, after: afterAvailable \}/, "应记录 blob 可用性");
  assert.match(src, /run\.artifacts = shouldTrackWorkspace \? finalizeFileChanges\(run, rawChanges, after\) : \[\]/, "应在 blob 复制后补全");
  assert.match(src, /只是被 touch/, "疑似变更应再核对一次内容差异");
});

test("只读差异接口：changeId 服务端解析、有输入上限、拒绝穿越", () => {
  const src = read("server/index.mjs");
  assert.match(src, /app\.get\("\/api\/runs\/:id\/changes\/:changeId\/diff"/, "应注册差异接口");
  assert.match(src, /function runChangeById\(run, changeId\)/, "changeId 必须从 Run 记录解析");
  assert.match(src, /if \(!change\) return res\.status\(404\)\.json\(\{ ok: false, error: "该 Run 记录里没有这个变更"/, "解析不到应 404");
  assert.match(src, /function readCappedBuffer\(file, maxBytes\)/, "读文件应有字节上限");
  assert.match(src, /isInside\(cwd, target\)/, "当前工作区文件必须做包含校验");
  const routeStart = src.indexOf('app.get("/api/runs/:id/changes/:changeId/diff"');
  const routeBody = src.slice(routeStart, src.indexOf("app.get(", routeStart + 10));
  assert.doesNotMatch(routeBody, /req\.query\.path|req\.body\?\.path|req\.query\.file/, "差异接口不得接受任意路径参数（只认 changeId）");
  assert.match(routeBody, /req\.params\.changeId/, "只允许通过 changeId 定位变更");
  assert.match(src, /inputTruncated/, "应回报输入截断");
  // 路由必须在 /api 兜底之前注册，否则永远 404（旧 open-in-explorer 的教训）
  assert.ok(src.indexOf('app.get("/api/runs/:id/changes/:changeId/diff"') < src.indexOf('app.use("/api", (_req, res) => res.status(404)'), "差异接口必须在 /api 兜底之前");
});

test("前端接入：API 封装 + 改动面板契约", () => {
  const api = read("client/src/api.js");
  assert.match(api, /export const getRunChangeDiff = \(runId, changeId, page = 0\)/, "应有 getRunChangeDiff");
  const panel = read("client/src/components/FileChangesPanel.jsx");
  assert.match(panel, /按需加载（分页）/, "面板应说明按需加载");
  assert.match(panel, /本轮没有文件改动/, "空状态应短句说明");
  assert.match(panel, /暂不支持精确对齐|不支持精确对齐|preciseAlignment/, "非文本应说明支持边界");
  assert.match(panel, /file-diff-pager/, "文本差异应支持分页");
  assert.match(panel, /className=\{`file-change-type \$\{change\.changeType\}`\}/, "类型徽标应按 changeType 渲染");
  assert.match(panel, /const CHANGE_LABEL = \{ added: "新增", modified: "修改", deleted: "删除"/, "删除应有明确文案（记录必须可见）");
  assert.match(read("client/src/运行展示投影.js"), /changeId: input\.changeId/, "投影应带 changeId 供差异请求");
});

console.log("\n▶ 端到端（服务在跑时）");

const BASE = process.env.OAW_TEST_BASE || "http://127.0.0.1:3002";
try {
  const runsRes = await fetch(`${BASE}/api/runs?limit=40`, { signal: AbortSignal.timeout(8000) });
  const runsData = await runsRes.json();
  const withChange = (runsData.runs || []).find((run) => (run.artifacts || []).length);
  if (!withChange) {
    console.log("      （没有带产物的 Run 样本，跳过端到端）");
  } else {
    // 旧 Run 可能只有 artifactId；新 Run 有 changeId —— 两者都应可解析
    const artifactRes = await fetch(`${BASE}/api/runs/${encodeURIComponent(withChange.id)}`, { signal: AbortSignal.timeout(8000) });
    const artifactData = await artifactRes.json();
    const artifact = (artifactData.run?.artifacts || artifactData.artifacts || [])[0];
    const id = artifact?.changeId || artifact?.artifactId;
    if (id) {
      const diffRes = await fetch(`${BASE}/api/runs/${encodeURIComponent(withChange.id)}/changes/${encodeURIComponent(id)}/diff`, { signal: AbortSignal.timeout(15000) });
      const diffBody = await diffRes.json().catch(() => ({}));
      if (diffRes.status === 200 && diffBody.ok) {
        ok(`真实变更可取出差异（kind=${diffBody.diff?.kind}，路径=${diffBody.change?.relativePath}）`);
      } else {
        bad(`真实变更差异接口异常：HTTP ${diffRes.status} ${JSON.stringify(diffBody).slice(0, 120)}`);
      }
    }
    const bogus = await fetch(`${BASE}/api/runs/${encodeURIComponent(withChange.id)}/changes/change_deadbeef0000/diff`, { signal: AbortSignal.timeout(8000) });
    const bogusBody = await bogus.json().catch(() => ({}));
    assert.equal(bogus.status, 404, "伪造 changeId 应 404");
    assert.equal(bogusBody.code, "CHANGE_NOT_FOUND", "应给出 CHANGE_NOT_FOUND");
    ok("伪造 changeId 被拒绝（404 CHANGE_NOT_FOUND）");
    const traversal = await fetch(`${BASE}/api/runs/${encodeURIComponent(withChange.id)}/changes/${encodeURIComponent("../../etc/passwd")}/diff`, { signal: AbortSignal.timeout(8000) });
    const traversalBody = await traversal.json().catch(() => ({}));
    assert.equal(traversal.status, 404, "路径穿越应被拒绝");
    assert.ok(!String(JSON.stringify(traversalBody)).includes("root:"), "不得读出系统文件");
    ok("路径穿越被拒绝（未读取系统文件）");
  }
} catch (error) {
  console.log(`      （服务不可达，跳过端到端：${error.message}）`);
}

console.log(failed ? "\n文件差异测试：失败" : "\n文件差异测试：通过");
process.exit(failed ? 1 : 0);
