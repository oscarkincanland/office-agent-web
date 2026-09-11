import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "规聚配置接口-"));
const dataDir = path.join(temporaryRoot, "应用数据");
const localPiDir = path.join(temporaryRoot, "本地Pi");
const port = 32_000 + Math.floor(Math.random() * 5_000);
const baseUrl = `http://127.0.0.1:${port}`;
const secret = "sk-api-route-secret-123";
const modelSecret = "sk-model-route-secret-456";
let child = null;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function environment() {
  return {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    OAW_DATA_DIR: dataDir,
    OAW_LOCAL_PI_AGENT_DIR: localPiDir,
    OAW_RUNTIME_RECORD_FILE: path.join(temporaryRoot, "运行时记录.json"),
    OAW_RUNS_DIR: path.join(temporaryRoot, "任务"),
    OAW_EVENT_DIR: path.join(temporaryRoot, "事件"),
    OAW_WRITE_LOCK_DIR: path.join(temporaryRoot, "写锁"),
    OAW_AGENTS_FILE: path.join(temporaryRoot, "智能体.json"),
    OAW_MEMORY_PROPOSALS_FILE: path.join(temporaryRoot, "记忆建议.json"),
    OAW_PROJECTS_FILE: path.join(temporaryRoot, "项目.json"),
  };
}

async function waitForExit(processHandle, timeoutMs = 2_000) {
  if (!processHandle || processHandle.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => processHandle.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function stopServer() {
  if (!child) return;
  const target = child;
  child = null;
  if (target.exitCode === null) target.kill();
  await waitForExit(target);
}

async function startServer() {
  let logs = "";
  child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: projectRoot,
    env: environment(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：\n${logs}`);
    try {
      const response = await fetch(`${baseUrl}/api/status`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`测试服务启动超时：\n${logs}`);
}

async function json(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const value = await response.json();
  assert.equal(response.ok, true, `${pathname} 请求失败：${JSON.stringify(value)}`);
  return value;
}

function expectNoSecret(value) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(secret), false, "接口响应不应包含凭据明文");
  assert.equal(text.includes(modelSecret), false, "接口响应不应包含模型配置内的凭据明文");
  assert.equal(text.includes("proxy-password"), false, "接口响应不应包含代理密码");
}

try {
  writeJson(path.join(localPiDir, "models.json"), {
    providers: { "测试供应商": { api: "openai-completions", baseUrl: "https://example.test/v1", apiKey: modelSecret, models: [{ id: "测试模型", name: "测试模型" }] } },
  });
  writeJson(path.join(localPiDir, "models-store.json"), { "测试供应商": { models: [{ id: "测试模型", name: "测试模型" }] } });
  writeJson(path.join(localPiDir, "settings.json"), { defaultProvider: "测试供应商", defaultModel: "测试模型", defaultThinkingLevel: "low" });
  writeJson(path.join(localPiDir, "auth.json"), { "测试供应商": { type: "api_key", key: secret } });

  await startServer();
  const before = await json("/api/agent/config-status");
  assert.equal(before.configured, false);
  assert.equal(fs.existsSync(path.join(dataDir, "凭据.json")), false, "只启动服务不能复制本地 Pi 凭据");

  const preview = await json("/api/agent/import-preview");
  expectNoSecret(preview);
  assert.equal(preview.available, true);
  assert.equal(preview.credentialCount, 1);
  assert.equal(preview.models.modelCount >= 1, true);
  assert.equal(fs.existsSync(path.join(dataDir, "凭据.json")), false, "导入预览不能复制凭据");

  const imported = await json("/api/agent/import-config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ includeModels: true, includeSettings: true, includeCredentials: true, includeSessions: false }),
  });
  expectNoSecret(imported);
  assert.equal(imported.imported.includes("auth"), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "凭据.json"), "utf8"))["测试供应商"].key, secret);

  const customProvider = await json("/api/agent/custom-provider", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "my-gateway", api: "openai-completions", baseUrl: "https://gateway.example.test/v1", modelId: "route-model", modelName: "路由模型", contextWindow: 64000, reasoning: true, vision: true }),
  });
  expectNoSecret(customProvider);
  assert.equal(customProvider.model, "my-gateway/route-model");
  const customCatalog = await json("/api/models");
  assert.equal(customCatalog.models.some((item) => item.id === "my-gateway/route-model"), true, "自定义模型保存后必须进入当前 Pi 模型目录");

  const auth = await json("/api/agent/auth");
  expectNoSecret(auth);
  assert.equal(auth.providers["测试供应商"].set, true);

  const network = await json("/api/agent/network-settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "manual", proxyUrl: "http://user:proxy-password@127.0.0.1:7890", noProxy: "localhost,127.0.0.1" }),
  });
  expectNoSecret(network);
  assert.equal(network.hasProxy, true);
  assert.equal(network.proxy, "http://127.0.0.1:7890");

  await stopServer();
  await startServer();
  const afterRestart = await json("/api/agent/config-status");
  expectNoSecret(afterRestart);
  assert.equal(afterRestart.configured, true);
  assert.equal(afterRestart.modelsConfigured, true);
  assert.equal(afterRestart.credentialCount, 1);

  console.log("Pi 配置接口测试通过");
} finally {
  await stopServer();
  try { fs.rmSync(temporaryRoot, { recursive: true, force: true }); } catch {}
}
