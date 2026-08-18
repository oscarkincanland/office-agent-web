#!/usr/bin/env node
/**
 * 验证脚本：语法检查 + 构建 + API 冒烟测试
 * 用法: node scripts/验证脚本.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import { execSync, spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let failed = 0;

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

  const endpoints = [
    ["GET", "/api/status"],
    ["GET", "/api/files"],
    ["GET", "/api/models"],
    ["GET", "/api/sessions"],
    ["GET", "/api/workspaces"],
    ["GET", "/api/skills"],
    ["GET", "/api/map/traffic-bandwidth?project=zhejiang-map"],
    ["GET", "/api/map/od-lines?project=zhejiang-map"],
    ["GET", "/api/map/exchange-sankey?project=zhejiang-map"],
    ["GET", "/api/map/road-structure?project=zhejiang-map"],
    ["GET", "/api/map/demo-analysis?analysis=heatmap&region=%E4%B9%89%E4%B9%8C%E5%B8%82"],
    ["GET", "/api/kb/graph?root=0&include=links,tags,folders&max=800"],
  ];
  for (const [method, url] of endpoints) {
    try {
      const res = await fetch(`http://localhost:${PORT}${url}`);
      if (res.ok) ok(`${method} ${url} -> ${res.status}`);
      else fail(`${method} ${url} -> ${res.status}`);
    } catch (e) {
      fail(`${method} ${url}: ${e.message}`);
    }
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
    fail(`GET /: ${e.message}`);
  }

  cleanup();
}

function cleanup(code = 0) {
  try { server.kill(); } catch {}
  setTimeout(() => process.exit(failed || code), 500);
}

smokeTest();
