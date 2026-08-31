#!/usr/bin/env node
/**
 * 验证脚本：语法检查 + 构建 + API 冒烟测试
 * 用法: node scripts/验证脚本.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import { execSync, spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { modeDescription, modeLabel, planTaskCapabilities, toolPolicyForMode } from "../server/task.mjs";
import { clearReadCache, readReference } from "../server/context.mjs";
import { validateArtifactFile } from "../server/产物验证.mjs";
import { eventStoreInfo, listEvents } from "../server/事件存储.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let failed = 0;
const NETWORK_BLOCKED = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1";

function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); failed = 1; }
function section(name) { console.log(`\n▶ ${name}`); }

function runSync(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf8", ...opts, shell: true });
}

// ---------- 1. Server 语法检查 ----------
section("Server 语法检查 (node --check)");
const serverFiles = fs.readdirSync(path.join(ROOT, "server")).filter((f) => f.endsWith(".mjs") && !f.startsWith("._"));
for (const f of serverFiles) {
  try {
    runSync(`node --check server/${f}`);
    ok(`server/${f}`);
  } catch (e) {
    fail(`server/${f}: ${e.message.split("\n")[0]}`);
  }
}

// ---------- 2. 前端构建 ----------
section("前端构建 (npm run build)");
try {
  const out = runSync("npm run build", { stdio: "pipe" });
  if (out.includes("built in")) ok("vite build 成功");
  else fail("构建输出异常");
} catch (e) {
  fail("前端构建失败: " + (e.message || "").split("\n").slice(-3).join(" | "));
}

// ---------- 3. API 冒烟测试 ----------
section("API 冒烟测试");
const PORT = 3199;
const server = spawn("node", ["server/index.mjs"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOut = "";
server.stdout.on("data", (d) => (serverOut += d.toString()));
server.stderr.on("data", (d) => (serverOut += d.toString()));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function smokeTest() {
  // 等待服务器就绪
  let ready = false;
  for (let i = 0; i < 400; i++) {
    if (serverOut.includes("running at")) { ready = true; break; }
    if (serverOut.includes("Error") || serverOut.includes("EADDR")) { break; }
    await wait(250);
  }
  if (!ready) { fail("服务器未在 100s 内启动: " + (serverOut.slice(-800) || "(无输出)")); cleanup(1); return; }
  ok("服务器启动");

  // 第二阶段稳定性定向检查：能力计划、文档读取缓存、基础产物结构校验
  try {
    const plan = planTaskCapabilities({ text: "修改报告.docx并导出", task: { mode: "office", currentFile: "报告.docx" } });
    if (plan.routing.officecli !== "preferred") throw new Error("Office 路由未识别");
    const artifact = validateArtifactFile(path.join(ROOT, "package.json"), ROOT, "package.json");
    if (artifact.status !== "passed") throw new Error("JSON 产物校验未通过");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "规聚读取-"));
    try {
      const tempFile = path.join(tempDir, "第二阶段读取测试.md");
      fs.writeFileSync(tempFile, "# cache test\n第二阶段稳定性", "utf8");
      clearReadCache();
      const first = await readReference({ kind: "file", target: "第二阶段读取测试.md" }, "", null, tempDir);
      const second = await readReference({ kind: "file", target: "第二阶段读取测试.md" }, "", null, tempDir);
      if (first.status !== "resolved" || second.status !== "resolved" || second.metadata?.cacheHit !== true) throw new Error("文档读取缓存未命中");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    ok("第二阶段能力路由/文档缓存/产物校验");
  } catch (e) {
    fail("第二阶段稳定性定向检查: " + e.message);
  }

  // 第三阶段模式边界检查：Chat 只读、Office 只走 Office CLI、Agent 保留完整工具链
  try {
    const chat = toolPolicyForMode("chat");
    const office = toolPolicyForMode("office");
    const agent = toolPolicyForMode("agent");
    const has = (policy, name) => policy.tools.includes(name);
    if (modeLabel("chat") !== "Chat" || !modeDescription("office")) throw new Error("模式元数据缺失");
    if (!has(chat, "kb_search") || !has(chat, "context_read") || !has(chat, "skills_search") || !has(chat, "skills_read") || has(chat, "bash") || has(chat, "write") || has(chat, "officecli")) throw new Error("Chat 不是只读工具集");
    if (!has(office, "officecli") || has(office, "bash") || has(office, "write") || has(office, "edit")) throw new Error("Office 工具边界异常");
    if (!has(agent, "bash") || !has(agent, "write") || !has(agent, "memory_update")) throw new Error("Agent 完整工具集缺失");
    const chatPlan = planTaskCapabilities({ text: "搜索知识库", task: { mode: "chat" } });
    if (chatPlan.mode !== "chat" || chatPlan.capabilities[0]?.label !== "Chat 检索") throw new Error("Chat 能力计划未标识");
    const chatDocumentPlan = planTaskCapabilities({ text: "查看报告.docx", task: { mode: "chat", currentFile: "报告.docx" } });
    if (chatDocumentPlan.routing.officecli !== "not_needed" || chatDocumentPlan.output.saveToWorkspace) throw new Error("Chat 文档请求错误触发 Office/写入路由");
    if (modeLabel("agent") !== "Agent") throw new Error("Agent 主模式标签异常");
    ok("第三阶段 Chat/Office/Agent 模式工具边界");
  } catch (e) {
    fail("第三阶段模式边界检查: " + e.message);
  }

  // 第四阶段事件/恢复接口检查：根级 Store 可读，状态接口可返回游标和事件范围
  try {
    const info = eventStoreInfo();
    const listed = listEvents({ after: Math.max(0, Number(info.latest || 0) - 10), limit: 20 });
    if (!Number.isFinite(info.latest) || !Array.isArray(listed.events) || listed.latest < info.latest) throw new Error("事件 Store 返回结构异常");
    ok("第四阶段持久事件 Store 读写结构");
  } catch (e) {
    fail("第四阶段事件 Store 检查: " + e.message);
  }

  const endpoints = [
    ["GET", "/api/status"],
    ["GET", "/api/files"],
    ["GET", "/api/models"],
    ["GET", "/api/sessions"],
    ["GET", "/api/projects"],
    ["GET", "/api/workspaces"],
    ["GET", "/api/skills"],
    ["GET", "/api/map/traffic-bandwidth?project=zhejiang-map"],
    ["GET", "/api/map/od-lines?project=zhejiang-map"],
    ["GET", "/api/map/exchange-sankey?project=zhejiang-map"],
    ["GET", "/api/map/road-structure?project=zhejiang-map"],
    ["GET", "/api/map/demo-analysis?analysis=heatmap&region=%E4%B9%89%E4%B9%8C%E5%B8%82"],
    ["GET", "/api/demo/cambodia-od?minFlow=0"],
    ["GET", "/api/m3/bus-routes"],
    ["GET", "/api/m3/station-heatmap"],
    ["GET", "/api/m3/od-lines"],
    ["GET", "/api/m3/network-stats"],
    ["GET", "/api/kb/graph?root=0&include=links,tags,folders&max=800"],
    ["GET", "/api/workflows"],
    ["GET", "/api/runs"],
    ["GET", "/api/artifacts"],
    ["GET", "/api/memory/proposals"],
    ["GET", "/api/agent/events/state?client=verify"],
  ];
  for (const [method, url] of endpoints) {
    try {
      const res = await fetch(`http://localhost:${PORT}${url}`);
      if (res.ok) ok(`${method} ${url} -> ${res.status}`);
      else fail(`${method} ${url} -> ${res.status}`);
    } catch (e) {
      if (NETWORK_BLOCKED) console.warn(`  ! ${method} ${url}：当前沙箱禁用回环网络，跳过 API 请求（${e.message}）`);
      else fail(`${method} ${url}: ${e.message}`);
    }
  }

  try {
    const res = await fetch(`http://localhost:${PORT}/api/skills/preflight`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workflowId: "wf-not-found" }) });
    const body = await res.json().catch(() => ({}));
    if (res.status === 409 && body.ok === false && Array.isArray(body.missing)) ok("POST /api/skills/preflight -> 可解释地拦截缺失工作流");
    else fail(`POST /api/skills/preflight -> 返回结构异常 (${res.status})`);
  } catch (e) {
    fail(`POST /api/skills/preflight: ${e.message}`);
  }

  // 任务控制接口只验证不存在任务的可解释错误，不启动真实模型调用。
  try {
    const checks = await Promise.all(["cancel", "resume", "retry"].map(async (action) => {
      const res = await fetch(`http://localhost:${PORT}/api/runs/run-not-found/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      return { action, status: res.status, body: await res.json().catch(() => ({})) };
    }));
    const publish = await fetch(`http://localhost:${PORT}/api/runs/run-not-found/artifacts/artifact-no/publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const publishBody = await publish.json().catch(() => ({}));
    if (checks.every((item) => item.status === 404 && item.body?.error === "run not found") && publish.status === 404 && publishBody.error === "run not found") ok("任务取消/继续/重试/成果固定接口错误结构");
    else fail("任务控制接口错误结构异常");
  } catch (e) {
    fail(`任务控制接口检查: ${e.message}`);
  }

  try {
    const res = await fetch(`http://localhost:${PORT}/api/agent/events/read`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client: "verify", seq: Number.MAX_SAFE_INTEGER }) });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok === true && Number.isFinite(Number(body.seq))) ok("事件阅读游标可安全写入");
    else fail(`事件阅读游标接口返回结构异常 (${res.status})`);
  } catch (e) {
    fail(`事件阅读游标检查: ${e.message}`);
  }

  // 知识图谱结构校验：节点、边和健康统计必须同时返回
  try {
    const res = await fetch(`http://localhost:${PORT}/api/kb/graph?root=0&include=links,tags,folders&max=800`);
    const body = await res.json();
    if (res.ok && Array.isArray(body.nodes) && Array.isArray(body.edges) && body.stats && Number.isFinite(body.stats.brokenLinks)) {
      ok("GET /api/kb/graph -> nodes/edges/stats 完整");
    } else {
      fail(`GET /api/kb/graph -> 返回结构异常 (${res.status})`);
    }
  } catch (e) {
    fail(`GET /api/kb/graph 结构校验: ${e.message}`);
  }

  // 静态资源
  try {
    const res = await fetch(`http://localhost:${PORT}/`);
    if (res.ok && res.headers.get("content-type")?.includes("text/html")) ok("GET / -> index.html");
    else fail(`GET / -> ${res.status}`);
  } catch (e) {
    if (NETWORK_BLOCKED) console.warn(`  ! GET /：当前沙箱禁用回环网络，跳过静态资源请求（${e.message}）`);
    else fail(`GET /: ${e.message}`);
  }

  cleanup();
}

function cleanup(code = 0) {
  try { server.kill(); } catch {}
  setTimeout(() => process.exit(failed || code), 500);
}

smokeTest();
