#!/usr/bin/env node
/**
 * P4 · 性能与流量基线
 *
 * 对应《规聚启动交互与动效完整修改计划》P4 第 3 条：测量首屏轮询与长任务的
 * 流量/开销，把「不退化」变成可执行的预算；若改动让首屏或长任务变重，
 * 优先撤销装饰性动效而不是加轮询。
 *
 * 这里能测的部分：
 *   - 启动期只读接口的响应体积与延迟（真实服务，隔离数据目录）；
 *   - 轮询节奏：会话 15s / 项目 30s / 模型 60s，且页面不可见时暂停；
 *   - 运行态对账只在需要时开启（900ms 循环不得常驻）；
 *   - 装饰性持续动画数量预算（与 P3 清单同源）；
 *   - 构建产物体积预算（若已 build）。
 *
 * 主线程长任务、首屏可交互时间需要真实浏览器，见 P4 验收清单的人工/浏览器专项。
 * 退出码 0 = 通过。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(projectRoot, rel), "utf8");

let failed = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { console.error(`  ✗ ${msg}`); failed = 1; };
function 检查(name, fn) {
  try {
    fn();
    ok(name);
  } catch (e) {
    bad(`${name}: ${e.message}`);
  }
}

// ============================================================
// 1. 轮询与对账节奏（静态预算）
// ============================================================
console.log("\n▶ 轮询与对账节奏");

检查("启动轮询节奏保守，且页面不可见时暂停", () => {
  const App = read("client/src/App.jsx");
  const 间隔 = (变量) => {
    const m = App.match(new RegExp(`${变量} = window\\.setInterval\\([\\s\\S]*?[,}]\\s*([\\d_]+)\\s*\\)`));
    assert.ok(m, `应能定位 ${变量} 的轮询间隔`);
    return Number(m[1].replace(/_/g, ""));
  };
  const 会话 = 间隔("sessionTimer");
  const 项目 = 间隔("projectTimer");
  const 模型 = 间隔("modelTimer");
  assert.ok(会话 >= 10_000, `会话轮询应至少 10s，实际 ${会话}ms`);
  assert.ok(项目 >= 20_000, `项目轮询应至少 20s，实际 ${项目}ms`);
  assert.ok(模型 >= 30_000, `模型目录轮询应至少 30s，实际 ${模型}ms`);
  console.log(`    会话 ${会话 / 1000}s ｜ 项目 ${项目 / 1000}s ｜ 模型 ${模型 / 1000}s`);
  // 页面不可见时必须跳过，避免后台标签页持续拉数据
  const 守卫 = App.match(/document\.visibilityState === "visible"/g) || [];
  assert.ok(守卫.length >= 2, "会话与项目轮询都应在页面不可见时暂停");
});

检查("运行态对账循环只在需要时开启", () => {
  const ChatPanel = read("client/src/components/ChatPanel.jsx");
  assert.match(ChatPanel, /const timer = shouldReconcile \? window\.setInterval\(refresh, 900\) : null;/, "900ms 对账必须带条件");
  assert.match(ChatPanel, /if \(timer\) window\.clearInterval\(timer\);/, "退出时必须清理定时器");
});

// ============================================================
// 2. 装饰性持续动画预算（静态预算）
// ============================================================
console.log("\n▶ 装饰性动效预算");

检查("持续动画种类不超预算", () => {
  const 样式 = read("client/src/styles.css");
  const 无限 = 样式.match(/animation\s*:[^;]*infinite/g) || [];
  const 名字 = new Set(无限.map((声明) => (声明.match(/animation\s*:\s*([\w-]+)/) || [])[1]).filter(Boolean));
  // P3 清单已登记的 16 个持续动画名；出现新的持续动画必须先登记再进预算
  assert.ok(名字.size <= 16, `持续动画种类不应超过 16 种，实际 ${名字.size} 种：${[...名字].join(", ")}`);
  console.log(`    持续动画 ${名字.size} 种 / ${无限.length} 处声明（预算 16 种）`);
});

// ============================================================
// 3. 构建产物体积预算（可选）
// ============================================================
console.log("\n▶ 构建产物体积");

检查("前端产物体积在预算内", () => {
  const 产物目录 = path.join(projectRoot, "client", "dist", "assets");
  if (!fs.existsSync(产物目录)) {
    console.log("    未找到 client/dist（先跑 npm run build），本次跳过体积核对");
    return;
  }
  const 文件 = fs.readdirSync(产物目录);
  const 总css = 文件.filter((f) => f.endsWith(".css")).reduce((sum, f) => sum + fs.statSync(path.join(产物目录, f)).size, 0);
  const js = 文件.filter((f) => f.endsWith(".js")).map((f) => ({ f, size: fs.statSync(path.join(产物目录, f)).size }));
  const 最大js = js.reduce((max, item) => (item.size > max.size ? item : max), { f: "-", size: 0 });
  const 总js = js.reduce((sum, item) => sum + item.size, 0);
  console.log(`    CSS 合计 ${(总css / 1024).toFixed(1)} KB ｜ JS 合计 ${(总js / 1024 / 1024).toFixed(2)} MB ｜ 最大 chunk ${(最大js.size / 1024).toFixed(1)} KB (${最大js.f})`);
  assert.ok(总css <= 440 * 1024, `CSS 合计应 ≤ 440KB，实际 ${(总css / 1024).toFixed(1)}KB`);
  assert.ok(总js <= 6 * 1024 * 1024, `JS 合计应 ≤ 6MB，实际 ${(总js / 1024 / 1024).toFixed(2)}MB`);
  assert.ok(最大js.size <= 3.5 * 1024 * 1024, `最大 JS chunk 应 ≤ 3.5MB，实际 ${(最大js.size / 1024).toFixed(1)}KB`);
});

// ============================================================
// 4. 只读接口体积与延迟（真实服务）
// ============================================================
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "规聚性能基线-"));
const port = 37_500 + Math.floor(Math.random() * 2_000);
const baseUrl = `http://127.0.0.1:${port}`;
let child = null;

function environment() {
  return {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    OAW_DATA_DIR: path.join(temporaryRoot, "应用数据"),
    OAW_LOCAL_PI_AGENT_DIR: path.join(temporaryRoot, "本地Pi"),
    OAW_RUNTIME_RECORD_FILE: path.join(temporaryRoot, "运行时记录.json"),
    OAW_RUNS_DIR: path.join(temporaryRoot, "任务"),
    OAW_EVENT_DIR: path.join(temporaryRoot, "事件"),
    OAW_WRITE_LOCK_DIR: path.join(temporaryRoot, "写锁"),
    OAW_AGENTS_FILE: path.join(temporaryRoot, "智能体.json"),
    OAW_MEMORY_PROPOSALS_FILE: path.join(temporaryRoot, "记忆建议.json"),
    OAW_PROJECTS_FILE: path.join(temporaryRoot, "项目.json"),
  };
}

async function 停服务() {
  if (!child) return;
  const target = child;
  child = null;
  if (target.exitCode === null) target.kill();
  await Promise.race([
    new Promise((resolve) => target.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

async function 起服务() {
  let logs = "";
  child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: projectRoot,
    env: environment(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：\n${logs}`);
    try {
      const response = await fetch(`${baseUrl}/api/status`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`测试服务启动超时：\n${logs}`);
}

/** 返回 { 字节, 毫秒 }，取 3 次的中位延迟。 */
async function 采样(pathname) {
  const 延迟 = [];
  let 字节 = 0;
  for (let i = 0; i < 3; i += 1) {
    const started = Date.now();
    const response = await fetch(`${baseUrl}${pathname}`);
    const text = await response.text();
    延迟.push(Date.now() - started);
    字节 = Buffer.byteLength(text);
    assert.equal(response.ok, true, `${pathname} 请求失败`);
  }
  延迟.sort((a, b) => a - b);
  return { 字节, 毫秒: 延迟[1] };
}

/** [路径, 体积上限（字节）, 中位延迟上限（毫秒）] */
const 接口预算 = [
  ["/api/files", 4 * 1024 * 1024, 4_000],
  ["/api/sessions", 3 * 1024 * 1024, 4_000],
  ["/api/projects", 1 * 1024 * 1024, 3_000],
  ["/api/workspaces", 256 * 1024, 3_000],
  ["/api/models", 1 * 1024 * 1024, 4_000],
  ["/api/artifacts", 512 * 1024, 3_000],
  ["/api/runs", 2 * 1024 * 1024, 4_000],
  ["/api/kb/tree", 1 * 1024 * 1024, 3_000],
];

try {
  await 起服务();
  console.log("\n▶ 只读接口体积与延迟（真实服务）");
  for (const [路径, 体积上限, 延迟上限] of 接口预算) {
    try {
      const { 字节, 毫秒 } = await 采样(路径);
      const 体积 = `${(字节 / 1024).toFixed(1)}KB`;
      console.log(`    ${路径.padEnd(20)} ${体积.padStart(9)} ｜ 中位 ${String(毫秒).padStart(5)}ms`);
      assert.ok(字节 <= 体积上限, `${路径} 体积 ${体积} 超过上限 ${(体积上限 / 1024).toFixed(0)}KB`);
      assert.ok(毫秒 <= 延迟上限, `${路径} 中位延迟 ${毫秒}ms 超过上限 ${延迟上限}ms`);
    } catch (e) {
      bad(`接口基线 ${路径}: ${e.message}`);
    }
  }
} catch (e) {
  bad(`接口基线：${e.message}`);
} finally {
  await 停服务();
  try { fs.rmSync(temporaryRoot, { recursive: true, force: true }); } catch {}
}

console.log(failed ? "\n性能与流量基线：失败" : "\n性能与流量基线：通过");
process.exitCode = failed ? 1 : 0;
