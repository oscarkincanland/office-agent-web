#!/usr/bin/env node
/**
 * 联网搜索模块测试：配置读写/脱敏、后端校验、状态契约、网页正文提取、错误分类。
 * 用法: node scripts/联网搜索测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 *
 * 说明：
 *   - 使用隔离的临时配置文件（OAW_SEARCH_CONFIG），不触碰用户真实的 .oaw/search.json。
 *   - 不进行真实外网请求；连通性相关的用例只访问本机不可达端口，快速失败。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let failed = 0;
function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); failed = 1; }
async function test(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(`${name}: ${e.message}`); }
}

// 必须在 import 联网搜索模块之前设置，模块在导入期读取该变量决定配置路径。
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-search-test-"));
const TMP_CONFIG = path.join(TMP_DIR, "search.json");
process.env.OAW_SEARCH_CONFIG = TMP_CONFIG;

const {
  SEARCH_BACKENDS, publicSearchSettings, readSearchSettings, readStoredSearchSettings,
  saveSearchSettings, testSearchBackend, webSearch, searchState, searchStoreInfo,
} = await import("../server/联网搜索.mjs");
const { htmlToMarkdown, webFetch, isBlockedAddress, resolveRedirectTarget } = await import("../server/网页读取.mjs");

function writeConfig(value) {
  fs.mkdirSync(path.dirname(TMP_CONFIG), { recursive: true });
  fs.writeFileSync(TMP_CONFIG, JSON.stringify(value));
}
function resetConfig() {
  try { fs.rmSync(TMP_CONFIG, { force: true }); } catch {}
}

console.log("\n▶ 测试隔离");
await test("配置路径指向隔离临时文件，不触碰真实 .oaw/search.json", () => {
  assert.equal(searchStoreInfo().file, TMP_CONFIG, "应使用 OAW_SEARCH_CONFIG 指定的临时路径");
  assert.equal(TMP_CONFIG.includes(path.join(".oaw", "search.json")), false);
});

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
  resetConfig();
  writeConfig({ backend: "tavily", tavilyKey: "" });
  await assert.rejects(() => webSearch("测试"), /未配置/);
  const verdict = await testSearchBackend("tavily");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.category, "unconfigured");
  assert.match(verdict.message, /未配置/);
  await assert.rejects(() => webSearch("x", { backend: "nonexistent" }), /不支持的搜索后端/);
});

await test("保存配置：后端白名单与 URL 规范化", () => {
  resetConfig();
  saveSearchSettings({ backend: "searxng", searxngUrl: "https://searx.example.com///" });
  const saved = readSearchSettings();
  assert.equal(saved.backend, "searxng");
  assert.equal(saved.searxngUrl, "https://searx.example.com");
  saveSearchSettings({ backend: "不存在的后端" });
  assert.equal(readSearchSettings().backend, "searxng", "非法后端不应覆盖已有值");
});

await test("公开配置脱敏：不返回明文 Key", () => {
  resetConfig();
  saveSearchSettings({ backend: "tavily", tavilyKey: "tvly-ABCDEFGH12345678" });
  const publicView = publicSearchSettings();
  assert.equal(publicView.hasTavilyKey, true);
  assert.match(publicView.tavilyKeyMasked, /^tvly••••5678$/);
  assert.equal(JSON.stringify(publicView).includes("ABCDEFGH"), false, "公开配置不得包含明文片段");
});

console.log("\n▶ 状态契约（P0）");

await test("选中 Tavily 无 Key 明示待配置", () => {
  resetConfig();
  writeConfig({ backend: "tavily", tavilyKey: "" });
  const state = searchState();
  assert.equal(state.selectedBackend, "tavily");
  assert.equal(state.configured, false);
  assert.equal(state.label, "待配置");
  assert.equal(state.tone, "warn");
  assert.match(state.reason, /未配置 API Key/);
});

await test("其他后端的凭据不得算作当前后端可用", () => {
  resetConfig();
  writeConfig({ backend: "tavily", tavilyKey: "", bochaKey: "sk-bocha-only" });
  const state = searchState();
  assert.equal(state.configured, false, "只有博查 Key 时 Tavily 仍应待配置");
  assert.equal(state.label, "待配置");
  const bocha = state.backends.find((item) => item.id === "bocha");
  assert.equal(bocha.configured, true, "博查自身应显示已配置");
});

await test("Jina 标记为免 Key 可尝试而非已连通", () => {
  resetConfig();
  writeConfig({ backend: "jina" });
  const state = searchState();
  assert.equal(state.configured, true, "Jina 免 Key，视为可尝试");
  assert.equal(state.keyless, true);
  assert.equal(state.connectivity, "untested");
  assert.equal(state.label, "无需 Key · 未验证");
  assert.notEqual(state.label, "已连通");
});

await test("测试失败会写入连接失败状态并可被状态读取", async () => {
  resetConfig();
  saveSearchSettings({ backend: "searxng", searxngUrl: "http://127.0.0.1:1" });
  const verdict = await testSearchBackend("searxng");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.connectivity, "failed");
  assert.equal(verdict.testedDraft, false);
  const state = searchState();
  assert.equal(state.connectivity, "failed");
  assert.equal(state.label, "连接失败");
  assert.equal(state.tone, "error");
});

console.log("\n▶ 凭据治理（P0）");

await test("草稿测试不落盘、不改变已保存后端的连通性", async () => {
  resetConfig();
  writeConfig({ backend: "tavily", tavilyKey: "" });
  const before = fs.readFileSync(TMP_CONFIG, "utf8");
  const verdict = await testSearchBackend("searxng", { draft: { searxngUrl: "http://127.0.0.1:1" } });
  assert.equal(verdict.testedDraft, true);
  assert.equal(verdict.ok, false);
  assert.equal(fs.readFileSync(TMP_CONFIG, "utf8"), before, "草稿测试不得写入配置文件");
  assert.equal(readSearchSettings().searxngUrl, "", "草稿不得出现在生效配置中");
  assert.equal(searchState().connectivity, "untested", "草稿测试不得改变已保存后端的连通性");
});

await test("显式清除凭据可撤销已保存的 Key", () => {
  resetConfig();
  saveSearchSettings({ backend: "tavily", tavilyKey: "tvly-TOCLEAR12345678" });
  assert.equal(publicSearchSettings().hasTavilyKey, true);
  const after = saveSearchSettings({ backend: "tavily", clearCredentials: ["tavily"] });
  assert.equal(after.hasTavilyKey, false, "清除后不应再有 Tavily Key");
  assert.equal(readStoredSearchSettings().tavilyKey, "", "磁盘配置应清空该字段");
  assert.equal(fs.readFileSync(TMP_CONFIG, "utf8").includes("TOCLEAR"), false);
});

await test("环境变量凭据不落盘，且标记来源为 env", () => {
  resetConfig();
  process.env.BOCHA_API_KEY = "sk-env-secret-987654321";
  try {
    saveSearchSettings({ backend: "bocha" });
    const raw = fs.readFileSync(TMP_CONFIG, "utf8");
    assert.equal(raw.includes("env-secret"), false, "环境凭据不得写入配置文件");
    assert.equal(readSearchSettings().bochaKey, "sk-env-secret-987654321", "环境凭据仍应生效");
    const state = searchState();
    assert.equal(state.selectedBackend, "bocha");
    assert.equal(state.configured, true);
    assert.equal(state.credentialSource, "env");
  } finally {
    delete process.env.BOCHA_API_KEY;
  }
});

await test("配置文件权限收紧为仅属主可读写（非 Windows）", () => {
  if (process.platform === "win32") return;
  resetConfig();
  saveSearchSettings({ backend: "tavily", tavilyKey: "tvly-PERMCHECK123456" });
  const mode = fs.statSync(TMP_CONFIG).mode & 0o777;
  assert.equal(mode, 0o600, `期望 0600，实际 ${mode.toString(8)}`);
});

console.log("\n▶ 网页安全边界（P0）");

await test("内网/回环/链路本地/元数据地址判定", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.5.5", "192.168.1.1", "169.254.169.254", "100.100.100.200", "0.0.0.0", "::1", "fc00::1", "fd00:ec2::254", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} 应被拒绝`);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
    assert.equal(isBlockedAddress(ip), false, `${ip} 应被允许`);
  }
});

await test("重定向目标校验：内网字面量/协议/凭据被拒", () => {
  assert.throws(() => resolveRedirectTarget("http://127.0.0.1/secret", "https://example.com/"), /内网|保留/);
  assert.throws(() => resolveRedirectTarget("http://169.254.169.254/latest/meta-data/", "https://example.com/"), /内网|保留/);
  assert.throws(() => resolveRedirectTarget("file:///etc/passwd", "https://example.com/"), /仅支持 http\/https/);
  assert.throws(() => resolveRedirectTarget("http://user:pass@example.com/", "https://example.com/"), /用户名或密码/);
  assert.equal(resolveRedirectTarget("/next", "https://example.com/a"), "https://example.com/next");
});

await test("被拒目标不产生任何请求", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response("x"); };
  try {
    for (const url of ["http://localhost/", "http://127.0.0.1/", "http://169.254.169.254/", "http://[::1]/", "http://10.1.2.3/", "http://user:pass@example.com/"]) {
      await assert.rejects(() => webFetch(url), /拒绝|仅支持|用户名或密码/, `${url} 应被拒`);
    }
    assert.equal(called, false, "被拒目标不得发起任何请求");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("重定向到内网被拦截且不请求该地址", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
  };
  try {
    await assert.rejects(() => webFetch("http://93.184.216.34/redir"), /内网|保留/);
    assert.equal(calls.some((item) => item.includes("169.254.169.254")), false, "不得请求被拒的重定向地址");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("Jina 回退默认关闭，需显式开启", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const target = String(url);
    if (target.startsWith("https://r.jina.ai/")) return new Response("J".repeat(600), { status: 200, headers: { "content-type": "text/plain" } });
    return new Response("<html><body>过短正文</body></html>", { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    await webFetch("http://93.184.216.34/short");
    assert.equal(calls.some((item) => item.startsWith("https://r.jina.ai/")), false, "默认不得调用第三方阅读服务");

    calls.length = 0;
    const page = await webFetch("http://93.184.216.34/short", { allowJina: true });
    assert.equal(page.via, "jina");
    assert.ok(calls.some((item) => item.startsWith("https://r.jina.ai/")), "显式开启后应回退 Jina");

    calls.length = 0;
    process.env.OAW_WEBFETCH_JINA = "0";
    await webFetch("http://93.184.216.34/short", { allowJina: true });
    assert.equal(calls.some((item) => item.startsWith("https://r.jina.ai/")), false, "环境变量置 0 应强制关闭回退");
    delete process.env.OAW_WEBFETCH_JINA;
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OAW_WEBFETCH_JINA;
  }
});

await test("下载按字节流式截断，不做整包读取", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("A".repeat(2_000_000), { status: 200, headers: { "content-type": "text/plain" } });
  try {
    const page = await webFetch("http://93.184.216.34/big", { maxChars: 40000 });
    assert.equal(page.truncatedBytes, true, "超过字节上限应标记截断");
    assert.ok(page.chars <= 40000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("不支持的内容类型给出明确错误（不回退时）", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("%PDF-1.4 ....", { status: 200, headers: { "content-type": "application/pdf" } });
  try {
    await assert.rejects(() => webFetch("http://93.184.216.34/f.pdf"), /不支持的内容类型/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

console.log("\n▶ 服务端接入点");

await test("agent/task/index 已接入联网工具与新契约", () => {
  const agent = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
  const task = fs.readFileSync(path.join(ROOT, "server", "task.mjs"), "utf8");
  const index = fs.readFileSync(path.join(ROOT, "server", "index.mjs"), "utf8");
  const api = fs.readFileSync(path.join(ROOT, "client", "src", "api.js"), "utf8");
  assert.match(agent, /name: "web_search"/);
  assert.match(agent, /name: "web_fetch"/);
  assert.match(agent, /webSearchTool, webFetchTool/);
  assert.match(task, /"web_search", "web_fetch"/);
  assert.match(index, /\/api\/search\/settings/);
  assert.match(index, /\/api\/search\/test/);
  assert.match(index, /draft: req\.body\?\.draft/, "测试接口应支持草稿测试");
  assert.match(api, /searchSettingsTest = \(backend = "", draft = null\)/, "前端 API 应支持传入草稿");
  assert.match(agent, /allowJina: params\.allowReaderFallback !== false/, "web_fetch 工具应显式控制第三方回退");
  const reader = fs.readFileSync(path.join(ROOT, "server", "网页读取.mjs"), "utf8");
  assert.match(reader, /redirect: "manual"/, "网页读取应手动跟随重定向");
  assert.match(reader, /export function isBlockedAddress/, "应导出网络边界判定供测试");
});

try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}

console.log(failed ? "\n联网搜索测试：失败" : "\n联网搜索测试：通过");
process.exit(failed ? 1 : 0);
