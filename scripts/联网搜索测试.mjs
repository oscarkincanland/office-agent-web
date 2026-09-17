#!/usr/bin/env node
/**
 * 联网搜索模块测试：配置读写/脱敏、后端校验、网页正文提取、错误分类。
 * 用法: node scripts/联网搜索测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 * 说明：不进行真实联网请求（CI/离线环境可运行）；真实连通性请在设置页"测试连接"。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_DIR } from "../server/workspace.mjs";
import { SEARCH_BACKENDS, publicSearchSettings, readSearchSettings, saveSearchSettings, testSearchBackend, webSearch } from "../server/联网搜索.mjs";
import { htmlToMarkdown, webFetch } from "../server/网页读取.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let failed = 0;
function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); failed = 1; }
async function test(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(`${name}: ${e.message}`); }
}

console.log("\n▶ 网页正文提取");

await test("HTML 转 Markdown：标题/段落/链接/代码块", () => {
  const html = `<!doctype html><html><head><title>测试页</title><style>.a{}</style></head>
    <body><nav>导航忽略</nav><article>
      <h1>大标题</h1><p>第一段 <a href="https://example.com/x">链接</a> 结尾。</p>
      <h2>小节</h2><ul><li>要点一</li><li>要点二</li></ul>
      <pre><code>const a = 1;</code></pre>
      <script>console.log(1)</script>
    </article><footer>页脚忽略</footer></body></html>`;
  const result = htmlToMarkdown(html, 5000);
  assert.equal(result.title, "测试页");
  assert.match(result.markdown, /# 大标题/);
  assert.match(result.markdown, /## 小节/);
  assert.match(result.markdown, /\[链接\]\(https:\/\/example\.com\/x\)/);
  assert.match(result.markdown, /- 要点一/);
  assert.match(result.markdown, /const a = 1;/);
  assert.doesNotMatch(result.markdown, /console\.log/);
  assert.doesNotMatch(result.markdown, /导航忽略|页脚忽略/);
});

await test("超长正文被截断且标记", () => {
  const html = `<article><p>${"内容".repeat(2000)}</p></article>`;
  const result = htmlToMarkdown(html, 300);
  assert.equal(result.truncated, true);
  assert.match(result.markdown, /已截断/);
});

await test("webFetch 拒绝非 http 链接", async () => {
  await assert.rejects(() => webFetch("file:///etc/passwd"), /仅支持 http\/https/);
  await assert.rejects(() => webFetch("not-a-url"), /仅支持 http\/https/);
});

console.log("\n▶ 搜索配置");

await test("后端元数据完整（含免费/自建方案）", () => {
  const ids = SEARCH_BACKENDS.map((item) => item.id);
  for (const id of ["tavily", "searxng", "jina", "bocha"]) assert.ok(ids.includes(id), `缺少后端 ${id}`);
});

await test("未配置后端时搜索给出可解释错误", async () => {
  // 临时清空配置以避免依赖本机已有 Key
  const configFile = path.join(PROJECT_DIR, ".oaw", "search.json");
  const backup = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : null;
  try {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ backend: "tavily", tavilyKey: "" }));
    await assert.rejects(() => webSearch("测试"), /未配置/);
    const verdict = await testSearchBackend("tavily");
    assert.equal(verdict.ok, false);
    assert.match(verdict.message, /未配置/);
    await assert.rejects(() => webSearch("x", { backend: "nonexistent" }), /不支持的搜索后端/);
  } finally {
    if (backup !== null) fs.writeFileSync(configFile, backup);
    else { try { fs.rmSync(configFile); } catch {} }
  }
});

await test("保存配置：后端白名单与 URL 规范化", () => {
  const configFile = path.join(PROJECT_DIR, ".oaw", "search.json");
  const backup = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : null;
  try {
    saveSearchSettings({ backend: "searxng", searxngUrl: "https://searx.example.com///" });
    const saved = readSearchSettings();
    assert.equal(saved.backend, "searxng");
    assert.equal(saved.searxngUrl, "https://searx.example.com");
    saveSearchSettings({ backend: "不存在的后端" });
    assert.equal(readSearchSettings().backend, "searxng", "非法后端不应覆盖已有值");
  } finally {
    if (backup !== null) fs.writeFileSync(configFile, backup);
    else { try { fs.rmSync(configFile); } catch {} }
  }
});

await test("公开配置脱敏：不返回明文 Key", () => {
  const configFile = path.join(PROJECT_DIR, ".oaw", "search.json");
  const backup = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : null;
  try {
    saveSearchSettings({ backend: "tavily", tavilyKey: "tvly-ABCDEFGH12345678" });
    const publicView = publicSearchSettings();
    assert.equal(publicView.hasTavilyKey, true);
    assert.match(publicView.tavilyKeyMasked, /^tvly••••5678$/);
    assert.equal(JSON.stringify(publicView).includes("ABCDEFGH"), false, "公开配置不得包含明文片段");
  } finally {
    if (backup !== null) fs.writeFileSync(configFile, backup);
    else { try { fs.rmSync(configFile); } catch {} }
  }
});

console.log("\n▶ 服务端接入点");

await test("agent/task/index 已接入联网工具", () => {
  const agent = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
  const task = fs.readFileSync(path.join(ROOT, "server", "task.mjs"), "utf8");
  const index = fs.readFileSync(path.join(ROOT, "server", "index.mjs"), "utf8");
  assert.match(agent, /name: "web_search"/);
  assert.match(agent, /name: "web_fetch"/);
  assert.match(agent, /webSearchTool, webFetchTool/);
  assert.match(task, /"web_search", "web_fetch"/);
  assert.match(index, /\/api\/search\/settings/);
  assert.match(index, /\/api\/search\/test/);
});

console.log(failed ? "\n联网搜索测试：失败" : "\n联网搜索测试：通过");
process.exit(failed ? 1 : 0);
