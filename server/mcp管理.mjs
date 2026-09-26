import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { APP_DATA_DIR } from "./Pi配置管理.mjs";
import { atomicWriteJson, ensureDirectory, readJsonFile } from "./持久化工具.mjs";

const CONFIG_FILE = path.join(APP_DATA_DIR, "集成", "mcp-servers.json");
const connections = new Map();
const MAX_TOOLS_PER_SERVER = 100;
const MAX_TOOL_SCHEMA_BYTES = 128 * 1024;

function readConfig() {
  const value = readJsonFile(CONFIG_FILE, { version: 1, servers: [] });
  return { version: 1, servers: Array.isArray(value?.servers) ? value.servers : [] };
}

function saveConfig(config) {
  ensureDirectory(path.dirname(CONFIG_FILE));
  atomicWriteJson(CONFIG_FILE, { ...config, updatedAt: new Date().toISOString() });
}

function cleanEnv(value) {
  return Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {})
    .filter(([key, item]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof item === "string")
    .slice(0, 100));
}

function cleanHeaders(value) {
  return Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {})
    .filter(([key, item]) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) && typeof item === "string")
    .slice(0, 100));
}

function cleanTool(tool) {
  const schema = tool?.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} };
  let schemaText = "";
  try { schemaText = JSON.stringify(schema); } catch {}
  return {
    name: String(tool?.name || "").slice(0, 200),
    description: String(tool?.description || "").slice(0, 4000),
    inputSchema: schemaText.length <= MAX_TOOL_SCHEMA_BYTES ? schema : { type: "object", properties: {}, additionalProperties: true },
    annotations: {
      readOnlyHint: tool?.annotations?.readOnlyHint === true,
      destructiveHint: tool?.annotations?.destructiveHint === true,
      idempotentHint: tool?.annotations?.idempotentHint === true,
    },
  };
}

function publicServer(server) {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.transport === "stdio" ? server.command : undefined,
    argsCount: server.transport === "stdio" ? (server.args || []).length : undefined,
    endpoint: server.transport === "http" ? server.endpoint : undefined,
    cwd: server.transport === "stdio" ? server.cwd || "" : undefined,
    enabled: Boolean(server.enabled),
    envKeys: Object.keys(server.env || {}),
    headerNames: Object.keys(server.headers || {}),
    hasSecrets: Object.keys(server.env || {}).length > 0 || Object.keys(server.headers || {}).length > 0,
    tools: Array.isArray(server.tools) ? server.tools.map(cleanTool) : [],
    lastTest: server.lastTest || null,
  };
}

function makeId(name) {
  const slug = String(name || "server").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "server";
  return `${slug}-${crypto.randomBytes(3).toString("hex")}`;
}

function validateServer(input = {}, previous = null) {
  const name = String(input.name ?? previous?.name ?? "").trim().slice(0, 80);
  const transport = String(input.transport ?? previous?.transport ?? "stdio");
  if (!name) throw new Error("请填写 MCP 服务名称");
  if (!new Set(["stdio", "http"]).has(transport)) throw new Error("MCP 传输类型只支持 stdio 或 Streamable HTTP");
  const result = {
    id: previous?.id || String(input.id || makeId(name)).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48),
    name,
    transport,
    enabled: input.enabled === undefined ? Boolean(previous?.enabled) : Boolean(input.enabled),
    tools: Array.isArray(previous?.tools) ? previous.tools : [],
    lastTest: previous?.lastTest || null,
  };
  if (transport === "stdio") {
    const command = String(input.command ?? previous?.command ?? "").trim().slice(0, 1000);
    if (!command) throw new Error("stdio 类型必须填写启动命令");
    result.command = command;
    result.args = (Array.isArray(input.args) ? input.args : previous?.args || []).map((arg) => String(arg).slice(0, 2000)).slice(0, 100);
    result.cwd = String(input.cwd ?? previous?.cwd ?? "").trim().slice(0, 2000);
    result.env = { ...(previous?.env || {}), ...cleanEnv(input.env) };
  } else {
    const endpoint = String(input.endpoint ?? previous?.endpoint ?? "").trim().slice(0, 4000);
    let url;
    try { url = new URL(endpoint); } catch { throw new Error("请填写有效的 MCP 服务 URL"); }
    if (!new Set(["https:", "http:"]).has(url.protocol)) throw new Error("MCP URL 只支持 HTTP 或 HTTPS");
    if (url.username || url.password || [...url.searchParams.keys()].some((key) => /token|secret|key|auth|credential/i.test(key))) {
      throw new Error("请不要把凭据写在 URL 中，改用 HTTP 请求头配置；凭据才可保持隐藏。");
    }
    url.hash = "";
    result.endpoint = url.toString();
    result.headers = { ...(previous?.headers || {}), ...cleanHeaders(input.headers) };
  }
  return result;
}

async function closeConnection(id) {
  const connection = connections.get(id);
  if (!connection) return;
  connections.delete(id);
  try { await connection.client.close(); } catch {}
}

function redactServerError(server, value) {
  let message = String(value?.message || value || "MCP 连接失败").slice(0, 500);
  for (const secret of [...Object.values(server.env || {}), ...Object.values(server.headers || {})].filter((item) => item && String(item).length >= 4)) {
    message = message.replaceAll(String(secret), "[已隐藏]");
  }
  return message;
}

function createTransport(server) {
  if (server.transport === "stdio") {
    const env = { ...getDefaultEnvironment(), ...(server.env || {}) };
    return new StdioClientTransport({ command: server.command, args: server.args || [], env, cwd: server.cwd || undefined, stderr: "pipe" });
  }
  return new StreamableHTTPClientTransport(new URL(server.endpoint), {
    requestInit: { headers: server.headers || {} },
    reconnectionOptions: { maxReconnectionDelay: 4000, initialReconnectionDelay: 400, reconnectionDelayGrowFactor: 1.5, maxRetries: 1 },
  });
}

async function connectServer(server, timeoutMs = 8000) {
  const cached = connections.get(server.id);
  if (cached) return cached;
  const client = new Client({ name: "open-plan", version: "0.11.11" });
  const transport = createTransport(server);
  const connection = { client, transport, tools: [], serverId: server.id };
  let timeoutTimer;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => { timeoutTimer = setTimeout(() => reject(new Error(`连接超时（${timeoutMs} ms）`)), timeoutMs); }),
    ]);
    connections.set(server.id, connection);
    return connection;
  } catch (error) {
    try { await client.close(); } catch {}
    throw error;
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
}

export function listMcpServers() {
  return readConfig().servers.map(publicServer);
}

export function saveMcpServer(input = {}) {
  const config = readConfig();
  const id = String(input.id || "");
  const index = id ? config.servers.findIndex((item) => item.id === id) : -1;
  const previous = index >= 0 ? config.servers[index] : null;
  const server = validateServer(input, previous);
  if (index >= 0) config.servers[index] = server;
  else config.servers.push(server);
  saveConfig(config);
  if (previous && JSON.stringify(previous) !== JSON.stringify(server)) void closeConnection(server.id);
  return publicServer(server);
}

export function updateMcpServer(id, patch = {}) {
  const config = readConfig();
  const index = config.servers.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const server = validateServer({ ...patch, id }, config.servers[index]);
  config.servers[index] = server;
  saveConfig(config);
  void closeConnection(id);
  return publicServer(server);
}

export async function deleteMcpServer(id) {
  const config = readConfig();
  const next = config.servers.filter((item) => item.id !== id);
  if (next.length === config.servers.length) return false;
  config.servers = next;
  saveConfig(config);
  await closeConnection(id);
  return true;
}

export async function testMcpServer(id) {
  const config = readConfig();
  const server = config.servers.find((item) => item.id === id);
  if (!server) return { ok: false, error: "MCP 服务不存在" };
  let connection;
  try {
    connection = await connectServer(server, 12000);
    const { tools = [] } = await connection.client.listTools();
    connection.tools = tools.slice(0, MAX_TOOLS_PER_SERVER).map(cleanTool).filter((tool) => tool.name);
    const current = readConfig();
    const saved = current.servers.find((item) => item.id === id);
    if (saved) {
      saved.tools = connection.tools;
      saved.lastTest = { ok: true, at: new Date().toISOString(), serverInfo: connection.client.getServerVersion()?.name || null };
      saveConfig(current);
    }
    return { ok: true, server: publicServer(saved || server), serverInfo: connection.client.getServerVersion() || null };
  } catch (error) {
    const current = readConfig();
    const saved = current.servers.find((item) => item.id === id);
    const safeError = redactServerError(server, error);
    if (saved) { saved.lastTest = { ok: false, at: new Date().toISOString(), error: safeError }; saveConfig(current); }
    await closeConnection(id);
    return { ok: false, error: safeError };
  }
}

export function cachedMcpTools() {
  return readConfig().servers.filter((server) => server.enabled)
    .flatMap((server) => (server.tools || []).slice(0, MAX_TOOLS_PER_SERVER).map((tool) => ({ server: publicServer(server), tool: cleanTool(tool) })));
}

export async function callMcpTool(serverId, name, args, options = {}) {
  const server = readConfig().servers.find((item) => item.id === serverId && item.enabled);
  if (!server) throw new Error("MCP 服务已停用或不存在，请启用后新建会话");
  const connection = await connectServer(server, 12000);
  try {
    return await connection.client.callTool({ name, arguments: args || {} }, { signal: options.signal, timeout: 120000 });
  } catch (error) {
    if (/closed|transport|connection|timeout/i.test(String(error?.message || error))) await closeConnection(serverId);
    throw error;
  }
}

export async function closeMcpConnections() {
  await Promise.all([...connections.keys()].map((id) => closeConnection(id)));
}

process.once("beforeExit", () => { void closeMcpConnections(); });
