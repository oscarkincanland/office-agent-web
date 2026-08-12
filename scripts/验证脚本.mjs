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
  for (let i = 0; i < 80; i++) {
    if (serverOut.includes("running at")) { ready = true; break; }
    if (serverOut.includes("Error") || serverOut.includes("EADDR")) { break; }
    await wait(250);
  }
  if (!ready) { fail("服务器未在 20s 内启动: " + (serverOut.slice(-800) || "(无输出)")); cleanup(1); return; }
  ok("服务器启动");

  const endpoints = [
    ["GET", "/api/status"],
    ["GET", "/api/files"],
    ["GET", "/api/models"],
    ["GET", "/api/sessions"],
    ["GET", "/api/workspaces"],
    ["GET", "/api/skills"],
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
