import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "规聚配置独立化-"));
const dataDir = path.join(root, "应用数据");
const sourceDir = path.join(root, "本地Pi");
const projectSessionDir = path.join(root, "项目", ".规聚会话");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configUrl = pathToFileURL(path.join(projectRoot, "server", "Pi配置管理.mjs")).href;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function writeJsonl(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

function expectNoSecret(value, secret) {
  assert.ok(!JSON.stringify(value).includes(secret), `结果不应包含明文凭据：${secret}`);
}

try {
  // 必须在导入配置模块前设置临时目录，避免触碰真实用户的 Pi 数据。
  process.env.OAW_DATA_DIR = dataDir;
  delete process.env.PI_AGENT_DIR;
  const config = await import(configUrl);
  const runtimeModule = await import(pathToFileURL(path.join(projectRoot, "server", "Pi运行时管理.mjs")).href);

  const defaultPaths = config.getPiConfigPaths(dataDir, { standardNames: false });
  assert.equal(path.basename(defaultPaths.modelsPath), "模型配置.json");
  assert.equal(path.basename(defaultPaths.modelsStorePath), "模型目录缓存.json");
  assert.equal(path.basename(defaultPaths.authPath), "凭据.json");
  assert.equal(path.basename(defaultPaths.settingsPath), "运行设置.json");
  assert.equal(path.basename(defaultPaths.networkPath), "网络代理.json");
  assert.equal(path.basename(defaultPaths.migrationPath), "会话迁移记录.json");

  const sourcePaths = config.getPiConfigPaths(sourceDir, { standardNames: true });
  const fakeKey = "sk-test-config-secret-123";
  const fakeModelKey = "sk-model-config-secret-456";
  writeJson(sourcePaths.modelsPath, { providers: { "测试供应商": { api: "https://example.test/v1", apiKey: fakeModelKey } } });
  writeJson(sourcePaths.modelsStorePath, { "测试供应商": { models: [{ id: "测试模型", name: "测试模型" }] } });
  writeJson(sourcePaths.settingsPath, { defaultProvider: "测试供应商", defaultModel: "测试模型" });
  writeJson(sourcePaths.authPath, { "测试供应商": { type: "api_key", key: fakeKey } });

  const before = config.getConfigStatus({ dir: dataDir });
  assert.equal(before.files.auth.status, "missing");
  assert.equal(fs.existsSync(defaultPaths.authPath), false, "未导入时不应创建凭据快照");

  const preview = config.previewLocalPiConfig({ sourceDir });
  expectNoSecret(preview, fakeKey);
  expectNoSecret(preview, fakeModelKey);
  assert.deepEqual(preview.models.providers, ["测试供应商"]);
  assert.equal(preview.files.auth.providers["测试供应商"].set, true);
  assert.equal(fs.existsSync(defaultPaths.authPath), false, "预览不能复制凭据");

  const imported = config.importLocalPiConfig({ sourceDir, targetDir: dataDir });
  expectNoSecret(imported, fakeKey);
  assert.equal(imported.files.auth.status, "imported");
  assert.deepEqual(imported.imported.sort(), ["auth", "models", "modelsStore", "settings"].sort());
  assert.equal(imported.providers[0].provider, "测试供应商");
  assert.equal(imported.providers[0].masked.includes(fakeKey), false);
  assert.equal(path.basename(defaultPaths.authPath), "凭据.json");
  assert.equal(JSON.parse(fs.readFileSync(defaultPaths.authPath, "utf8"))["测试供应商"].key, fakeKey);

  writeJson(sourcePaths.modelsPath, { providers: { "源目录后来修改": {} } });
  writeJson(sourcePaths.authPath, { "测试供应商": { type: "api_key", key: "sk-source-changed" } });
  assert.equal(JSON.parse(fs.readFileSync(defaultPaths.modelsPath, "utf8")).providers["测试供应商"]?.api, "https://example.test/v1");
  assert.equal(JSON.parse(fs.readFileSync(defaultPaths.authPath, "utf8"))["测试供应商"].key, fakeKey, "目标快照不能跟随源目录变化");

  const savedNetwork = config.saveNetworkSettings({ mode: "manual", proxyUrl: "http://user:proxy-secret@example.test:8080", noProxy: ["127.0.0.1"] }, { dir: dataDir });
  expectNoSecret(savedNetwork, "proxy-secret");
  expectNoSecret(config.readNetworkSettings({ dir: dataDir }), "proxy-secret");
  assert.equal(config.loadNetworkSettings({ dir: dataDir }).proxyUrl, "http://user:proxy-secret@example.test:8080");
  assert.equal(savedNetwork.noProxy, "127.0.0.1");
  const preservedNetwork = config.saveNetworkSettings({ mode: "direct", noProxy: "localhost" }, { dir: dataDir, preserveProxy: true });
  assert.equal(preservedNetwork.proxy, "http://example.test:8080");
  assert.equal(preservedNetwork.hasProxy, true);

  const sessionSource = path.join(sourceDir, "sessions");
  writeJsonl(path.join(sessionSource, "有效会话.jsonl"), [{ type: "session", id: "session-1" }, { type: "message", text: "hello" }]);
  writeJsonl(path.join(sessionSource, "嵌套", "第二个会话.jsonl"), [{ type: "session", id: "session-2" }]);
  fs.mkdirSync(path.join(sessionSource, "目录.jsonl"), { recursive: true });
  fs.writeFileSync(path.join(sessionSource, "无效会话.jsonl"), "不是 JSON\n", "utf8");
  writeJson(path.join(sessionSource, "旧格式.json"), { id: "should-not-import" });
  writeJsonl(path.join(projectSessionDir, "有效会话.jsonl"), [{ type: "session", id: "existing" }]);

  const sessions = config.importLocalPiSessions({ sourceDir: sessionSource, targetDir: projectSessionDir });
  assert.equal(sessions.ok, true);
  assert.equal(sessions.files.find((item) => item.name === "有效会话.jsonl")?.status, "exists_skipped");
  assert.equal(sessions.files.find((item) => item.name === "第二个会话.jsonl")?.status, "imported");
  assert.equal(sessions.files.find((item) => item.name === "无效会话.jsonl")?.status, "invalid");
  assert.equal(fs.existsSync(path.join(projectSessionDir, "旧格式.json")), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(projectSessionDir, "有效会话.jsonl"), "utf8").split("\n")[0]).id, "existing", "重名会话不能覆盖");
  assert.throws(() => config.importLocalPiSessionFile(path.join(sessionSource, "目录.jsonl"), projectSessionDir));

  const manager = new runtimeModule.PiRuntimeManager({ recordFile: path.join(root, "运行时记录.json"), network: { mode: "direct" } });
  const modelRuntime = await manager.modelRuntime();
  const runtimePaths = config.getPiConfigPaths(dataDir);
  assert.equal(path.resolve(modelRuntime.modelsPath), path.resolve(runtimePaths.modelsPath));
  assert.equal(path.resolve(modelRuntime.models.modelsStore.path), path.resolve(runtimePaths.modelsStorePath));
  assert.equal(path.basename(runtimePaths.authPath), "凭据.json", "Runtime 凭据路径必须来自规聚配置路径");
  const oldAdapter = manager.networkAdapter();
  manager.updateNetworkSettings({ mode: "manual", proxyUrl: "http://user:proxy-secret@example.test:8080" });
  assert.equal(oldAdapter.diagnostics().closed, true);
  assert.equal(manager.networkDiagnostics().mode, "manual");
  assert.equal(manager.networkDiagnostics().proxy, "http://example.test:8080");
  await manager.disposeAll();

  const compatScript = `
    const m = await import(${JSON.stringify(configUrl)});
    process.stdout.write(JSON.stringify({ agent: m.AGENT_DIR, models: m.PI_CONFIG_PATHS.modelsPath, auth: m.PI_CONFIG_PATHS.authPath }));
  `;
  const compat = spawnSync(process.execPath, ["--input-type=module", "-e", compatScript], {
    env: { ...process.env, OAW_DATA_DIR: path.join(root, "兼容数据"), PI_AGENT_DIR: path.join(root, "兼容Pi") },
    encoding: "utf8",
  });
  assert.equal(compat.status, 0, compat.stderr);
  const compatResult = JSON.parse(compat.stdout);
  assert.equal(path.basename(compatResult.models), "models.json");
  assert.equal(path.basename(compatResult.auth), "auth.json");
  assert.equal(path.resolve(compatResult.agent), path.resolve(root, "兼容Pi"));

  console.log("Pi 配置独立化测试通过");
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
