import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PI_ERROR_CODES,
  classifyPiError,
  classifyPiResponse,
  createPiNetworkAdapter,
  redactProxyUrl,
  resolvePiNetworkSettings,
  wrapPiAgentStreamFunction,
} from "../server/Pi网络代理.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

const target = http.createServer((request, response) => {
  if (request.url === "/slow") {
    setTimeout(() => response.end("slow"), 150);
    return;
  }
  if (request.url === "/auth") response.writeHead(401);
  else if (request.url === "/rate") response.writeHead(429, { "retry-after": "1" });
  else if (request.url === "/context") response.writeHead(400);
  else if (request.url === "/missing") response.writeHead(404);
  response.end(request.url === "/context" ? "maximum context length exceeded" : "ok");
});

let proxyRequests = 0;
const proxy = http.createServer((request, response) => {
  proxyRequests += 1;
  response.end("proxy-ok");
});

let targetPort;
let proxyPort;
try {
  targetPort = await listen(target);
  proxyPort = await listen(proxy);
  const targetUrl = `http://127.0.0.1:${targetPort}`;

  const beforeFetch = globalThis.fetch;
  const createSessionTypes = fs.readFileSync(path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts"), "utf8");
  const piAiTypes = fs.readFileSync(path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/types.d.ts"), "utf8");
  assert.equal(/interface CreateAgentSessionOptions[\s\S]*?streamFunction/.test(createSessionTypes), false, "CreateAgentSessionOptions 不应猜测 streamFunction 参数");
  assert.equal(/interface CreateAgentSessionOptions[\s\S]*?fetch\??:/.test(createSessionTypes), false, "CreateAgentSessionOptions 不应猜测 fetch 参数");
  assert.match(piAiTypes, /fetch\?: FetchFunction/, "pi-ai StreamOptions 应提供 fetch 注入点");
  const direct = createPiNetworkAdapter({ mode: "direct", timeoutMs: 2_000 });
  assert.equal(direct.settings.bodyTimeoutMs, 0, "长 SSE 默认不得启用 Undici bodyTimeout");
  const directResponse = await direct.fetch(`${targetUrl}/ok`);
  assert.equal(directResponse.status, 200, "direct 模式应访问目标服务");
  assert.equal(globalThis.fetch, beforeFetch, "适配器不得修改 globalThis.fetch");

  const manual = createPiNetworkAdapter({
    mode: "manual",
    proxyUrl: `http://user:secret@127.0.0.1:${proxyPort}`,
    noProxy: "localhost,127.0.0.1",
    timeoutMs: 2_000,
  });
  const bypassResponse = await manual.fetch(`${targetUrl}/bypass`);
  assert.equal(bypassResponse.status, 200, "NO_PROXY 应绕过手动代理");
  assert.equal(proxyRequests, 0, "NO_PROXY 目标不得经过代理");
  const proxiedResponse = await manual.fetch("http://example.invalid/proxied");
  assert.equal(proxiedResponse.status, 200, "手动代理应代理非 NO_PROXY 目标");
  assert.equal(proxyRequests, 1, "非 NO_PROXY 目标应经过代理");

  const system = resolvePiNetworkSettings({
    mode: "system",
    environment: {
      HTTP_PROXY: "http://system-user:system-secret@proxy.example:8080",
      HTTPS_PROXY: "http://proxy.example:8080",
      NO_PROXY: "localhost,127.0.0.1",
    },
  });
  assert.equal(system.mode, "system");
  assert.equal(system.httpProxy, "http://system-user:system-secret@proxy.example:8080");
  assert.equal(system.noProxy, "localhost,127.0.0.1");

  assert.equal(classifyPiResponse({ status: 401 }).code, PI_ERROR_CODES.AUTH_ERROR);
  assert.equal(classifyPiResponse({ status: 429 }).code, PI_ERROR_CODES.RATE_LIMIT);
  assert.equal(classifyPiResponse({ status: 404 }, { body: "model not found" }).code, PI_ERROR_CODES.MODEL_NOT_FOUND);
  assert.equal(classifyPiResponse({ status: 400 }, { body: "maximum context length exceeded" }).code, PI_ERROR_CODES.CONTEXT_LIMIT);
  assert.equal(classifyPiError(new Error("connect ECONNREFUSED"), { mode: "direct", hostNetworkRestricted: false }).code, PI_ERROR_CODES.NETWORK_UNREACHABLE);
  assert.equal(classifyPiError(new Error("request timed out"), { mode: "direct" }).code, PI_ERROR_CODES.MODEL_TIMEOUT);
  const empty400 = classifyPiError(new Error("400 status code (no body)"), { mode: "direct" });
  assert.equal(empty400.code, PI_ERROR_CODES.REQUEST_ERROR);
  assert.equal(empty400.status, 400, "Pi 格式化错误中的 HTTP 状态应保留");
  assert.equal(classifyPiError(Object.assign(new Error("模型流式输出无新事件"), { code: PI_ERROR_CODES.MODEL_STREAM_TIMEOUT })).code, PI_ERROR_CODES.MODEL_STREAM_TIMEOUT);
  assert.equal(classifyPiError(Object.assign(new Error("blocked by policy"), { code: "EPERM" })).code, PI_ERROR_CODES.HOST_NETWORK_RESTRICTED);
  assert.equal(classifyPiError(new Error("unexpected request failure"), { hostNetworkRestricted: false }).code, PI_ERROR_CODES.REQUEST_ERROR);
  assert.equal(resolvePiNetworkSettings({ bodyTimeoutMs: 0 }).bodyTimeoutMs, 0, "bodyTimeoutMs=0 应表示禁用 body 超时");
  const zeroTimeoutAdapter = createPiNetworkAdapter({ mode: "direct", bodyTimeoutMs: 0 });
  assert.equal(zeroTimeoutAdapter.settings.bodyTimeoutMs, 0, "dispatcher 配置不得把 bodyTimeoutMs=0 替换成默认值");
  zeroTimeoutAdapter.close();

  const previousRestricted = process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1";
  try {
    assert.equal(classifyPiError(new Error("Provider is not configured: minimax")).code, PI_ERROR_CODES.AUTH_ERROR, "宿主标记不得覆盖 Provider 未配置");
    assert.equal(classifyPiError(new Error("ordinary request error")).code, PI_ERROR_CODES.REQUEST_ERROR, "普通请求错误不得被宿主标记污染");
    assert.equal(classifyPiError(new Error("ordinary request error"), { hostNetworkRestricted: true }).code, PI_ERROR_CODES.REQUEST_ERROR, "显式宿主标记不得单独覆盖普通请求错误");
    assert.equal(classifyPiError(new Error("fetch failed")).code, PI_ERROR_CODES.HOST_NETWORK_RESTRICTED, "fetch failed 加宿主标记应归类为宿主网络受限");
    assert.equal(classifyPiError(new Error("fetch failed"), { hostNetworkRestricted: true }).code, PI_ERROR_CODES.HOST_NETWORK_RESTRICTED, "fetch failed 加显式宿主标记应归类为宿主网络受限");
    assert.equal(classifyPiError(Object.assign(new Error("operation failed"), { code: "EPERM" })).code, PI_ERROR_CODES.HOST_NETWORK_RESTRICTED, "EPERM 应作为宿主网络受限证据");
  } finally {
    if (previousRestricted === undefined) delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
    else process.env.CODEX_SANDBOX_NETWORK_DISABLED = previousRestricted;
  }
  assert.equal(redactProxyUrl("http://user:secret@proxy.example:8080").includes("secret"), false, "脱敏地址不得包含代理密码");
  assert.equal(manual.diagnostics().proxy, `http://127.0.0.1:${proxyPort}`);

  const timeoutAdapter = createPiNetworkAdapter({ mode: "direct", timeoutMs: 2_000 });
  await assert.rejects(
    timeoutAdapter.fetch(`${targetUrl}/slow`, { signal: AbortSignal.timeout(20) }),
    (error) => error.code === PI_ERROR_CODES.MODEL_TIMEOUT,
    "AbortSignal 超时应归类为 MODEL_TIMEOUT",
  );

  const calls = [];
  const originalStreamFunction = function (model, context, options) {
    calls.push({ model, context, options, receiver: this });
    return "stream";
  };
  const fakeSession = { agent: { streamFunction: originalStreamFunction } };
  assert.equal(wrapPiAgentStreamFunction(fakeSession, direct.fetch), true, "应在创建会话后包装原有 streamFunction");
  assert.notEqual(fakeSession.agent.streamFunction, originalStreamFunction, "应保留原函数并通过包装函数调用");
  assert.equal(fakeSession.agent.streamFunction("model", "context", { timeoutMs: 100 }), "stream");
  assert.equal(calls[0].options.fetch, direct.fetch, "原 streamFunction 应收到适配器 fetch");
  assert.equal(calls[0].receiver, undefined, "包装调用不得改变原 streamFunction 的调用语义");
  const callerFetch = () => "caller-fetch";
  fakeSession.agent.streamFunction("model", "context", { fetch: callerFetch });
  assert.equal(calls[1].options.fetch, callerFetch, "调用方显式 fetch 应覆盖规聚默认 fetch");
  assert.equal(wrapPiAgentStreamFunction(fakeSession, direct.fetch), true, "重复包装应保持幂等");
  assert.equal(globalThis.fetch, beforeFetch, "包装 AgentSession streamFunction 不得修改 globalThis.fetch");

  direct.close();
  manual.close();
  timeoutAdapter.close();
  console.log(JSON.stringify({ ok: true, checked: ["direct", "system", "manual", "no_proxy", "error_classification", "fetch_injection", "credential_redaction"] }, null, 2));
} finally {
  await close(target);
  await close(proxy);
}
