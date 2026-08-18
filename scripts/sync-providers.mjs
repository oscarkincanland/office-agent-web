/**
 * 同步 opencode 配置中的 provider 到 pi models.json（scripts/sync-providers.mjs）
 *
 * 背景：pi 的模型列表来自 ~/.pi/agent/models.json 的 providers（带凭证的才可用）。
 * 用户在 opencode（~/.config/opencode/opencode.json）配置了带 key 的 provider，
 * 这里把它们转换合并进 pi models.json，恢复可用的模型数量。
 *
 * 用法：node scripts/sync-providers.mjs
 * 之后调 POST /api/models/refresh（或重启）让运行时重新扫描。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PI_MODELS = path.join(os.homedir(), ".pi", "agent", "models.json");
const OPENCODE_CFG = path.join(os.homedir(), ".config", "opencode", "opencode.json");

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** opencode 的 models 对象（{id: {limit, modalities, name}}）→ pi 的 ModelDefinition 数组 */
function convertModels(modelsObj) {
  if (!modelsObj || typeof modelsObj !== "object") return [];
  return Object.entries(modelsObj).map(([id, def]) => ({
    id,
    name: def.name || id,
    contextWindow: def.limit?.context,
    maxTokens: def.limit?.output,
    input: Array.isArray(def.modalities?.input) ? def.modalities.input : undefined,
  })).filter((m) => m.id);
}

function main() {
  const oc = readJson(OPENCODE_CFG);
  if (!oc?.provider) {
    console.log(`未找到 opencode 配置: ${OPENCODE_CFG}`);
    process.exit(1);
  }
  const pi = readJson(PI_MODELS) || { providers: {} };
  if (!pi.providers) pi.providers = {};

  let added = 0;
  for (const [pid, prov] of Object.entries(oc.provider)) {
    const options = prov.options || {};
    const apiKey = options.apiKey || prov.apiKey;
    if (!apiKey) continue; // 无凭证跳过
    const baseUrl = options.baseURL || options.baseUrl || prov.baseUrl;
    const models = convertModels(prov.models || {});
    if (!pi.providers[pid]) {
      pi.providers[pid] = { apiKey, baseUrl, models };
      added++;
      console.log(`新增 provider: ${pid}（${models.length} 模型, ${baseUrl || "默认 baseUrl"}）`);
    } else {
      console.log(`已存在 provider: ${pid}，跳过`);
    }
  }
  if (added === 0) {
    console.log("没有可迁移的新 provider（opencode 配置中带凭证的 provider 均已存在或缺失）");
    return;
  }
  fs.writeFileSync(PI_MODELS, JSON.stringify(pi, null, 2), "utf8");
  console.log(`已合并 ${added} 个 provider 到 ${PI_MODELS}`);
  console.log("提示：调 POST /api/models/refresh 或重启服务让运行时重新扫描");
}

main();
