#!/usr/bin/env node
/**
 * W4 / D01「统一文件身份与预览状态」回归测试
 *
 * 覆盖：
 *   1. 文件身份契约与地址形状：client/src/文件地址.js（纯函数，直接 import 断言）；
 *   2. 同名不同工作区去重、身份核对、revision 覆盖；
 *   3. 前端接线：App.open 携带身份/中止器/generation，不用 Date.now 当真实性标记；
 *      DocViewer / DocxViewer / PptxViewer 消费统一预览状态与身份核对；
 *   4. 后端接线：预览路由接受 cwd 并返回文件身份，raw 响应带身份头，HTML 注入身份消息；
 *   5. 边界：仍禁止任意绝对路径越界（resolvePath 约束不被放开）。
 *
 * 用法: node scripts/预览身份测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PREVIEW_STATE,
  normalizeRelativePath,
  makeFileIdentity,
  fileIdentityKey,
  identityMatches,
  mergeFileIdentity,
  readIdentityHeader,
  buildDocUrls,
  withRevision,
  previewStateFromError,
} from "../client/src/文件地址.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let failed = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { console.error(`  ✗ ${msg}`); failed = 1; };
async function test(name, fn) {
  try { await fn(); ok(name); } catch (error) { bad(`${name}: ${error.message}`); }
}

console.log("\n▶ 文件身份契约（client/src/文件地址.js）");

await test("makeFileIdentity 归一化路径与工作区兜底", () => {
  const identity = makeFileIdentity({ workspaceId: "/ws/A", relativePath: "sub\\报告.docx" });
  assert.equal(identity.workspaceId, "/ws/A");
  assert.equal(identity.cwd, "/ws/A");
  assert.equal(identity.relativePath, "sub/报告.docx");
  assert.equal(identity.revision, "");
  // 缺少 workspaceId 时回退 cwd；缺少 relativePath 时回退 name
  const fallback = makeFileIdentity({ cwd: "/ws/B", name: "./a/b.md", revision: "r1" });
  assert.equal(fallback.workspaceId, "/ws/B");
  assert.equal(fallback.relativePath, "a/b.md");
  assert.equal(fallback.revision, "r1");
  assert.equal(normalizeRelativePath("\\./x/y.txt"), "x/y.txt");
});

await test("同名文件在不同工作区是不同身份；同文件大小写/分隔符归一", () => {
  const a = makeFileIdentity({ workspaceId: "/ws/A", relativePath: "报告.docx" });
  const b = makeFileIdentity({ workspaceId: "/ws/B", relativePath: "报告.docx" });
  assert.notEqual(fileIdentityKey(a), fileIdentityKey(b), "不同工作区同名文件必须不同键");
  assert.equal(identityMatches(a, b), false);
  const a2 = makeFileIdentity({ workspaceId: "/WS/a", relativePath: "报告.docx" });
  assert.equal(fileIdentityKey(a), fileIdentityKey(a2), "大小写/斜杠归一后应视为同一文件");
  assert.equal(identityMatches(a, a2), true);
  // 版本不参与去重
  const a3 = { ...a, revision: "hash-xyz" };
  assert.equal(fileIdentityKey(a), fileIdentityKey(a3));
});

await test("mergeFileIdentity：服务端 revision 优先，缺省时保留本地", () => {
  const local = makeFileIdentity({ workspaceId: "/ws/A", relativePath: "x.docx", revision: "" });
  const server = { workspaceId: "/ws/A", cwd: "/ws/A", relativePath: "x.docx", revision: "svc-1" };
  assert.equal(mergeFileIdentity(local, server).revision, "svc-1");
  assert.equal(mergeFileIdentity(local, { ...server, revision: "" }).revision, "");
  assert.equal(mergeFileIdentity({ ...local, revision: "local-1" }, null).revision, "local-1");
});

await test("buildDocUrls：每条预览地址都显式携带 cwd + wsid + v", () => {
  const identity = makeFileIdentity({ workspaceId: "/ws/A", relativePath: "sub/报告.docx", revision: "rev123" });
  const urls = buildDocUrls(identity);
  for (const channel of ["open", "raw", "html", "comments", "annotations", "outline", "watch"]) {
    const url = urls[channel];
    assert.ok(url, `缺少地址：${channel}`);
    assert.match(url, /cwd=%2Fws%2FA/, `${channel} 必须带 cwd`);
    assert.match(url, /wsid=%2Fws%2FA/, `${channel} 必须带 wsid`);
    assert.match(url, /v=rev123/, `${channel} 必须带版本 v`);
  }
  assert.match(urls.open, /^\/api\/doc\/sub%2F%E6%8A%A5%E5%91%8A\.docx\?/, "open 地址形状");
  assert.match(urls.raw, /\/raw\?/);
  assert.match(urls.comments, /\/comments\?/);
  assert.match(urls.annotations, /\/annotations\?/);
  assert.match(urls.outline, /\/outline\?/);
  assert.match(urls.watch, /\/watch\?/);
  assert.match(urls.watchStop, /\/watch\/stop\?/);
  assert.match(urls.rawSave, /\/raw-save\?/);
  // 无工作区时至少带相对路径，不带空的 cwd
  const bare = buildDocUrls(makeFileIdentity({ relativePath: "a.md" }));
  assert.equal(bare.open, "/api/doc/a.md");
});

await test("withRevision 只替换 v，保留 cwd/相对路径", () => {
  const identity = makeFileIdentity({ workspaceId: "/ws/A", relativePath: "a.md", revision: "old" });
  const next = withRevision(buildDocUrls(identity).raw, "new");
  assert.match(next, /cwd=%2Fws%2FA/);
  assert.match(next, /v=new/);
  assert.doesNotMatch(next, /v=old/);
  assert.equal(withRevision("/api/doc/a.md?cwd=/x", ""), "/api/doc/a.md?cwd=/x", "空版本不改写");
});

await test("readIdentityHeader 解析服务端身份；previewStateFromError 归类", () => {
  const fake = { headers: { get: (name) => (name === "x-oa-file-identity" ? encodeURIComponent(JSON.stringify({ relativePath: "a.docx", workspaceId: "/w" })) : null) } };
  assert.equal(readIdentityHeader(fake).relativePath, "a.docx");
  assert.equal(readIdentityHeader({ headers: { get: () => null } }), null);
  assert.equal(previewStateFromError(new Error("该格式不支持预览")), PREVIEW_STATE.UNSUPPORTED);
  assert.equal(previewStateFromError(new Error("加载失败 HTTP 500")), PREVIEW_STATE.FAILED);
  assert.deepEqual(
    Object.values(PREVIEW_STATE).sort(),
    ["failed", "loading", "partial", "ready", "unsupported"].sort(),
  );
});

console.log("\n▶ 前端接线：App.open 身份 / 中止 / generation");

const App = read("client/src/App.jsx");

await test("App 引入统一文件地址模块", () => {
  assert.match(App, /from "\.\/文件地址\.js"/, "应引入 文件地址.js");
  assert.match(App, /buildDocUrls/, "应使用 buildDocUrls");
  assert.match(App, /makeFileIdentity/, "应使用 makeFileIdentity");
  assert.match(App, /fileIdentityKey/, "应使用 fileIdentityKey 去重");
});

await test("revision 不再用 Date.now 冒充文件真实性标记", () => {
  assert.doesNotMatch(App, /const revision = Date\.now\(\)/, "不得再用 Date.now 作为 revision");
  assert.doesNotMatch(App, /\$\{cwdQuery\}&v=\$\{revision\}/, "不应再拼接 Date.now 版本");
  assert.match(App, /mergeFileIdentity/, "应合并服务端返回的身份");
  assert.match(App, /previewRevision: identity\.revision/, "预览版本应来自服务端身份");
});

await test("open 使用 AbortController 与请求代际，切文件丢弃旧结果", () => {
  assert.match(App, /docAbortRef/, "应有打开请求的中止器");
  assert.match(App, /new AbortController\(\)/, "应创建 AbortController");
  assert.match(App, /signal: controller\.signal/, "fetch 应带 signal");
  assert.match(App, /docRequestSeqRef\.current \+= 1/, "关闭标签/切工作区应推进代际");
  assert.match(App, /e\?\.name === "AbortError"/, "应静默丢弃被取代的请求");
});

await test("标签按工作区 + 相对路径去重（不再只按 name）", () => {
  const open = App.slice(App.indexOf("const open = useCallback"), App.indexOf("const handleChatOpenFile"));
  assert.match(open, /const id = fileIdentityKey\(identity\)/, "应以身份键作为标签 id");
  assert.match(open, /prev\.find\(\(t\) => \(t\.id \|\| t\.name\) === id\)/, "应按 id 去重");
  assert.match(open, /setActiveTab\(id\)/, "activeTab 应为身份键");
  // closeTab 也按 id
  assert.match(App, /const closeTab = useCallback\(\(id\)/, "closeTab 应按 id");
  // 已批准规则（交接文档交互 4）：刷新不恢复上次打开的标签，所以不再持久化 tabs。
  // 标签身份仍在对象上（id/cwd），只是不经 localStorage 跨刷新恢复。
  assert.doesNotMatch(App, /tabs: tabs\.map\(/, "不应持久化标签，刷新后回到空白新会话");
  assert.match(App, /const id = fileIdentityKey\(identity\)/, "标签身份仍按工作区 + 相对路径生成");
});

console.log("\n▶ 前端接线：DocViewer / DocxViewer / PptxViewer");

const DocViewer = read("client/src/components/DocViewer.jsx");
const DocxViewer = read("client/src/components/DocxViewer.jsx");
const PptxViewer = read("client/src/components/PptxViewer.jsx");

await test("DocViewer 用统一状态机与身份核对消费子查看器", () => {
  assert.match(DocViewer, /PREVIEW_STATE/, "应使用共享预览状态");
  assert.match(DocViewer, /buildDocUrls\(identity\)/, "应统一生成预览地址");
  assert.match(DocViewer, /identityMatches\(identityRef\.current, data\.identity\)/, "iframe 消息应核对身份");
  assert.match(DocViewer, /__oawPreview/, "应识别受控预览消息");
  assert.match(DocViewer, /window\.addEventListener\("message"/, "应监听 iframe 身份消息");
  assert.match(DocViewer, /PREVIEW_STATE\.PARTIAL/, "iframe onload 应为 partial 而非直接成功");
  assert.match(DocViewer, /generationRef\.current \+= 1/, "切文件应递增渲染代际");
  assert.match(DocViewer, /scopedFetch/, "应通过按通道中止的 fetch");
  assert.match(DocViewer, /const tabId = \(t\) => t\.id \|\| t\.name/, "标签应以 id 定位");
  // 子查看器接收身份与状态回调
  assert.match(DocViewer, /<DocxViewer name=\{doc\.name\} revision=\{doc\.previewRevision\} identity=\{identity\} onPreviewState=\{setPreviewState\}/, "DocxViewer 应收到身份与状态回调");
  assert.match(DocViewer, /<PptxViewer name=\{doc\.name\} revision=\{doc\.previewRevision\} identity=\{identity\} onPreviewState=\{setPreviewState\}/, "PptxViewer 应收到身份与状态回调");
  // a11y 约束（无障碍测试依赖）仍满足
  assert.match(DocViewer, /role="tab"[\s\S]{0,160}?tabIndex=\{0\}/, "标签应可聚焦");
  assert.match(DocViewer, /aria-label=\{`关闭 \$\{t\.name\}`\}/, "关闭按钮应有可访问名");
});

await test("DocxViewer：身份头核对 + generation + 不再用 Date.now 版本", () => {
  assert.match(DocxViewer, /readIdentityHeader\(res\)/, "应读取 raw 响应的身份头");
  assert.match(DocxViewer, /identityMatches\(fileIdentity, serverIdentity\)/, "应核对身份");
  assert.match(DocxViewer, /new AbortController\(\)/, "应有 AbortController");
  assert.match(DocxViewer, /renderSeqRef/, "应有渲染代际");
  assert.match(DocxViewer, /previewStateFromError/, "应归类预览状态");
  assert.match(DocxViewer, /PREVIEW_STATE\.PARTIAL/, "有丢失图片时应为 partial");
  assert.match(DocxViewer, /urls\.rawSave/, "保存应带文件身份");
  assert.doesNotMatch(DocxViewer, /revision \|\| Date\.now\(\)/, "不得再用 Date.now 兜底版本");
});

await test("PptxViewer：身份头核对 + generation + 高保真回退", () => {
  assert.match(PptxViewer, /readIdentityHeader\(res\)/, "应读取 raw 响应的身份头");
  assert.match(PptxViewer, /identityMatches\(fileIdentity, serverIdentity\)/, "应核对身份");
  assert.match(PptxViewer, /new AbortController\(\)/, "应有 AbortController");
  assert.match(PptxViewer, /generationRef/, "应有渲染代际");
  assert.match(PptxViewer, /__oawPreview/, "高保真 iframe 应核对身份消息");
  assert.match(PptxViewer, /src=\{urls\.html\}/, "高保真 iframe 应带身份地址");
  assert.doesNotMatch(PptxViewer, /revision \|\| Date\.now\(\)/, "不得再用 Date.now 兜底版本");
});

console.log("\n▶ 后端接线：预览路由身份与校验");

const Server = read("server/index.mjs");

await test("服务端有文件身份与版本派生工具", () => {
  assert.match(Server, /function requestedPreviewWorkspace\(req\)/, "应有请求工作区解析");
  assert.match(Server, /function previewFileRevision\(absPath\)/, "版本应由文件状态派生");
  assert.match(Server, /crypto\.createHash\("sha1"\)\.update\(`\$\{st\.size\}:\$\{Math\.floor\(st\.mtimeMs\)\}`\)/, "版本应为 size+mtime 的 sha1");
  assert.match(Server, /function previewFileIdentity\(/, "应有身份构造函数");
  assert.match(Server, /function setPreviewIdentityHeader\(/, "raw 应能回传身份头");
  assert.match(Server, /function injectPreviewIdentityMessage\(/, "HTML 预览应注入身份消息");
});

await test("comments/annotations/outline/watch 均按 cwd 解析并返回身份", () => {
  const routeShapes = {
    comments: "api\\/doc\\/(.+)\\/comments$",
    annotations: "api\\/doc\\/([^\\/]+)\\/annotations$",
    outline: "api\\/doc\\/([^\\/]+)\\/outline$",
    watch: "api\\/doc\\/(.+)\\/watch$",
  };
  for (const [route, shape] of Object.entries(routeShapes)) {
    assert.ok(Server.includes(shape), `应有 ${route} 路由`);
  }
  // 每个预览 GET/POST 都使用 requestedPreviewWorkspace(req)
  const usages = Server.match(/requestedPreviewWorkspace\(req\)/g) || [];
  assert.ok(usages.length >= 9, `预览路由应普遍使用 requestedPreviewWorkspace，当前 ${usages.length} 处`);
  // annotations 支持显式工作区存储
  assert.match(Server, /function annotationsPath\(fileName, workspace\)/, "标注存储应支持工作区");
  // outline 必须在 open 兜底路由之前被放行
  assert.match(Server, /raw\|text\|html\|comments\|watch\|outline/, "open 路由应放行 outline");
  // 响应带 identity
  assert.match(Server, /res\.json\(\{ comments: unique\.slice\(0, 20\), identity \}\)/, "md/txt 批注应带身份");
  assert.match(Server, /res\.json\(\{ comments, identity \}\)/, "office 批注应带身份");
  assert.match(Server, /res\.json\(\{ annotations: JSON\.parse\(fs\.readFileSync\(p, "utf8"\)\), identity \}\)/, "标注应带身份");
  assert.match(Server, /res\.json\(\{ outline, identity \}\)/, "大纲应带身份");
  assert.match(Server, /port: entry\.port, identity: previewFileIdentity/, "watch 应带身份");
});

await test("raw 响应带身份头，html 注入 ready/unsupported/error 消息", () => {
  assert.match(Server, /setPreviewIdentityHeader\(res, previewFileIdentity\(fileName, requestedCwd, p\)\)/, "raw 应设置身份头");
  assert.match(Server, /injectPreviewIdentityMessage\(html, identity, "ready"\)/, "渲染成功应注入 ready");
  assert.match(Server, /previewUnsupportedPage\(fileName, path\.extname\(p\)\.slice\(1\)\.toLowerCase\(\), "", identity\)/, "不支持格式应注入 unsupported");
  assert.match(Server, /, identity, "error"\)/, "渲染异常应注入 error");
});

await test("边界：预览解析仍拒绝越界绝对路径（未放开任意路径）", () => {
  const ws = read("server/workspace.mjs");
  assert.match(ws, /export function resolvePath\(rel, workspace = _currentWorkspace\)/, "resolvePath 签名不变");
  assert.match(ws, /path\.isAbsolute\(raw\)/, "仍拒绝绝对路径");
  assert.match(ws, /\.\./, "仍拒绝 .. 越界");
  // open 路由不再显式放开 cwd 之外的路径；仍走 resolvePath
  assert.match(Server, /const p = resolvePath\(fileName, requestedCwd\)/, "预览仍通过 resolvePath 校验");
});

console.log("\n▶ 样式与交付完整性");

await test("共享预览状态徽标有样式", () => {
  const styles = read("client/src/styles.css");
  assert.match(styles, /\.badge\.preview-state-ready/);
  assert.match(styles, /\.badge\.preview-state-failed/);
  assert.match(styles, /\.badge\.preview-state-partial/);
});

await test("禁改文件未被本工作包改动（基线可读）", () => {
  // 仅确认这些文件仍存在且可读，本工作包不应对其产生依赖变更
  for (const f of ["client/src/components/ChatPanel.jsx", "client/src/components/任务中心.jsx", "client/src/components/工作产物面板.jsx", "package.json"]) {
    assert.ok(read(f).length > 0, `${f} 应存在且非空`);
  }
});

// D04：独立图片查看器与 PDF 状态
const imageViewer = fs.readFileSync(new URL("../client/src/components/ImageViewer.jsx", import.meta.url), "utf8");
assert.match(imageViewer, /PREVIEW_STATE/, "图片查看器应使用统一预览状态");
assert.match(imageViewer, /scale-fit|scale-\$\{/, "图片查看器应支持适应窗口与固定比例");
assert.match(imageViewer, /打开原图/, "图片查看器应提供用系统应用打开原图");
assert.match(imageViewer, /onError=\{markFailed\}/, "图片加载失败应有明确失败态");
const docViewerSource = fs.readFileSync(new URL("../client/src/components/DocViewer.jsx", import.meta.url), "utf8");
assert.match(docViewerSource, /doc\.kind === "image" && \(/, "DocViewer 应分派图片查看器");
assert.match(docViewerSource, /import ImageViewer from "\.\/ImageViewer\.jsx"/, "应引入 ImageViewer");
assert.match(docViewerSource, /doc\.kind === "pdf" && \([\s\S]{0,400}?onError=/, "PDF 分支应有加载失败处理");
const workspaceSource = fs.readFileSync(new URL("../server/workspace.mjs", import.meta.url), "utf8");
assert.match(workspaceSource, /png\|jpg\|jpeg\|gif\|webp/, "文件列表应支持图片扩展名");
const serverSource = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
assert.match(serverSource, /kind: "image"/, "打开接口应返回 kind:image");
assert.match(serverSource, /IMAGE_EXTENSIONS/, "应集中声明图片扩展名");
assert.match(serverSource, /png: "image\/png"/, "raw 应给图片正确 MIME");
assert.match(serverSource, /svg: "image\/svg\+xml"/, "SVG 应使用 image/svg+xml");
assert.match(serverSource, /Content-Security-Policy", "sandbox/, "SVG 应带沙箱响应头，受控展示");
console.log("  ✓ D04 图片查看器与 PDF 状态契约");

// D03：PPT 渲染队列与资源释放（用真实 pptxviewjs 的 destroy 接口，不虚构库 API）
const pptxSource = fs.readFileSync(new URL("../client/src/components/PptxViewer.jsx", import.meta.url), "utf8");
const renderSlideCalls = (pptxSource.match(/renderSlide\(/g) || []).length;
assert.equal(renderSlideCalls, 1, "同一时刻只保留一处 renderSlide 调用路径（单一渲染路径）");
assert.match(pptxSource, /destroy\?\.\(\)/, "必须调用 pptxviewjs 的真实释放接口 destroy");
assert.match(pptxSource, /renderSeqRef/, "渲染请求应有 latest-wins 令牌");
assert.match(pptxSource, /pending\.token !== token\) return;/, "旧页请求应在执行前被跳过");
assert.match(pptxSource, /setRenderer\("office"\)/, "浏览器渲染失败应自动回退高保真");
assert.doesNotMatch(pptxSource, /const go = async|const jump = async/, "go/jump 不得再直接触发渲染（改为只设置目标页）");
const officeSource = fs.readFileSync(new URL("../server/office.mjs", import.meta.url), "utf8");
assert.match(officeSource, /OfficeCLI 渲染失败（退出码/, "renderHtml 非零退出必须明确失败");
assert.match(officeSource, /相对资源引用/, "应检查相对资源引用（临时副本删除后可能失效）");
assert.match(officeSource, /"--out", outFile/, "renderHtml 应用文件输出，绕开 stdout/JSON 大小上限（254MB 样本实测）");
console.log("  ✓ D03 PPT 渲染队列与资源释放契约");
console.log(failed ? "\n预览身份测试：失败" : "\n预览身份测试：通过");
process.exit(failed ? 1 : 0);
