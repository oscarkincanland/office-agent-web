import path from "node:path";
import crypto from "node:crypto";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createLocalBashOperations,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  createAgentSession,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AGENT_DIR, PROJECT_DIR } from "./workspace.mjs";
import { getPiConfigPaths, loadNetworkSettings, readCredentials as readConfigCredentials, writeCredentials as writeConfigCredentials } from "./Pi配置管理.mjs";
import { atomicWriteJson, ensureDirectory, readJsonFile } from "./持久化工具.mjs";
import {
  classifyPiError,
  createPiNetworkAdapter,
  redactProxyUrl,
  resolvePiNetworkSettings,
  wrapPiAgentStreamFunction,
} from "./Pi网络代理.mjs";

const RUNTIME_RECORD_FILE = process.env.OAW_RUNTIME_RECORD_FILE || path.join(PROJECT_DIR, ".oaw", "运行时记录.json");
export const PI_PACKAGE_VERSION = "0.85.1";
/**
 * Pi 原生上下文压缩策略（唯一事实来源）。
 * reserveTokens：接近窗口上限时预留的输出/工具空间，压缩线 = contextWindow − reserveTokens；
 * keepRecentTokens：压缩后保留的最近上下文，保证任务连续性。
 * 前端「上下文」浮层直接展示这两个数字，避免用户误以为 UI 的 60%/85% 颜色阈值就是压缩线。
 */
export const PI_COMPACTION_POLICY = Object.freeze({ reserveTokens: 16384, keepRecentTokens: 20000 });
const RUNTIME_RECORD_LIMIT = 120;
const DEFAULT_AGENT_CONCURRENCY = 2;
const DEFAULT_OFFICE_CONCURRENCY = 1;

function now() {
  return new Date().toISOString();
}

function positiveInteger(value, fallback) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function readCredentials() {
  return readCredentialsFromConfig();
}

function readCredentialsFromConfig() {
  return readConfigCredentials({ dir: AGENT_DIR });
}

function localCredentialStore() {
  return {
    read: async (provider) => readCredentials()[provider],
    list: async () => Object.entries(readCredentials()).map(([providerId, value]) => ({ providerId, type: value?.type })),
    modify: async (provider, fn) => {
      const auth = readCredentials();
      const next = await fn(auth[provider]);
      if (next === undefined) return auth[provider];
      auth[provider] = next;
      writeConfigCredentials(auth, { dir: AGENT_DIR });
      return next;
    },
    delete: async (provider) => {
      const auth = readCredentials();
      delete auth[provider];
      writeConfigCredentials(auth, { dir: AGENT_DIR });
    },
  };
}

function modelSnapshot(model) {
  if (!model) return null;
  return {
    provider: String(model.provider || ""),
    id: String(model.id || ""),
    name: String(model.name || model.id || ""),
    reasoning: model.reasoning === true,
    vision: model.vision === true,
    ...(Number(model.contextWindow || model.contextLength || model.limit?.context) > 0
      ? { contextWindow: Math.floor(Number(model.contextWindow || model.contextLength || model.limit.context)) }
      : {}),
  };
}

function safeRuntimeRecord(record) {
  if (!record || typeof record !== "object") return null;
  const { session, modelRuntime, error, ...publicRecord } = record;
  const classification = error?.classification || null;
  return {
    ...publicRecord,
    error: error ? {
      code: error.code || null,
      category: error.category || classification?.code || null,
      retryable: error.retryable ?? classification?.retryable ?? false,
      status: error.status ?? classification?.status ?? null,
      message: String(error.message || classification?.message || error).slice(0, 500),
    } : null,
  };
}

/**
 * 一个小型异步资源闸门。它只限制“正在调用模型/Office 子进程”的数量，
 * 不限制 SSE、历史读取和已存在会话的切换，因此不会把多子对话误认为互斥。
 */
export class AsyncLimiter {
  constructor(limit = 1, name = "resource") {
    this.limit = positiveInteger(limit, 1);
    this.name = name;
    this.active = 0;
    this.queue = [];
    this.started = 0;
    this.completed = 0;
  }

  async acquire(metadata = {}) {
    const item = { metadata, queuedAt: now() };
    if (this.active < this.limit) {
      this.active += 1;
      this.started += 1;
      return this.release.bind(this);
    }
    return new Promise((resolve) => {
      item.resolve = resolve;
      this.queue.push(item);
    });
  }

  release() {
    if (this.active > 0) this.active -= 1;
    this.completed += 1;
    const next = this.queue.shift();
    if (!next) return;
    this.active += 1;
    this.started += 1;
    next.resolve(this.release.bind(this));
  }

  async run(fn, metadata = {}) {
    const release = await this.acquire(metadata);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  snapshot() {
    return {
      name: this.name,
      limit: this.limit,
      active: this.active,
      queued: this.queue.length,
      started: this.started,
      completed: this.completed,
    };
  }
}

export const runtimeCapabilities = Object.freeze({
  nativeFork: { status: "reserved", message: "Pi AgentSessionRuntime 提供 fork 接口，本阶段暂未绑定到工作台 Run。" },
  nativeCheckpoint: { status: "unsupported", message: "当前没有 token 级检查点；使用 JSONL 会话重开 + 恢复提示词。" },
  replay: { status: "fallback", message: "支持从 JSONL 会话文件恢复，并由 Run 恢复链重新执行未完成目标。" },
});

/**
 * Pi 的唯一生命周期入口。业务层只通过本类创建、恢复、停止、压缩和调用会话，
 * Pi SDK 的依赖、凭据目录以及能力降级都集中在这里，后续可以替换为 Pi 原生 runtime。
 */
export class PiRuntimeManager {
  constructor({ recordFile = RUNTIME_RECORD_FILE, agentConcurrency = process.env.OAW_MAX_AGENT_RUNS, officeConcurrency = process.env.OAW_MAX_OFFICECLI, network = {} } = {}) {
    this.recordFile = recordFile;
    this.networkSettings = resolvePiNetworkSettings(Object.keys(network || {}).length ? network : loadNetworkSettings());
    this.networkAdapterInstance = null;
    this.modelRuntimePromise = null;
    this.records = loadRuntimeRecordsFrom(recordFile);
    this.agentLimiter = new AsyncLimiter(positiveInteger(agentConcurrency, DEFAULT_AGENT_CONCURRENCY), "agent");
    this.officeLimiter = new AsyncLimiter(positiveInteger(officeConcurrency, DEFAULT_OFFICE_CONCURRENCY), "officecli");
    this.markPersistedRuntimesRecovering();
  }

  networkAdapter() {
    if (!this.networkAdapterInstance) this.networkAdapterInstance = createPiNetworkAdapter(this.networkSettings);
    return this.networkAdapterInstance;
  }

  networkDiagnostics() {
    return this.networkAdapterInstance?.diagnostics?.() || {
      mode: this.networkSettings.mode,
      noProxy: this.networkSettings.noProxy,
      proxy: redactProxyUrl(this.networkSettings.mode === "manual"
        ? this.networkSettings.proxyUrl
        : this.networkSettings.httpsProxy || this.networkSettings.httpProxy),
      hasProxy: Boolean(this.networkSettings.proxyUrl || this.networkSettings.httpsProxy || this.networkSettings.httpProxy),
      closed: false,
    };
  }

  /** 更新网络配置时先关闭旧连接池；会话通过动态 fetch 在下一次请求使用新配置。 */
  updateNetworkSettings(settings = loadNetworkSettings()) {
    this.networkAdapterInstance?.close?.();
    this.networkAdapterInstance = null;
    this.networkSettings = resolvePiNetworkSettings(settings || {});
    return this.networkDiagnostics();
  }

  modelRuntime() {
    if (!this.modelRuntimePromise) {
      const paths = getPiConfigPaths(AGENT_DIR);
      this.modelRuntimePromise = ModelRuntime.create({
        authPath: paths.authPath,
        modelsPath: paths.modelsPath,
        modelsStorePath: paths.modelsStorePath,
        credentials: localCredentialStore(),
      }).catch((error) => {
        this.modelRuntimePromise = null;
        throw error;
      });
    }
    return this.modelRuntimePromise;
  }

  resetModelRuntime() {
    this.modelRuntimePromise = null;
  }

  async createSession({ cwd, sessionPath = null, sessionStore = null, ...options } = {}) {
    const sessionManager = sessionPath
      ? SessionManager.open(sessionPath, sessionStore || undefined, cwd)
      : SessionManager.create(cwd, sessionStore || undefined);
    const settingsManager = options.settingsManager || SettingsManager.inMemory({
      // 上下文压缩交给 Pi 按当前模型的 contextWindow 自动判断；
      // 明确保留输出/工具调用空间，避免工作台另设固定 token 线与 Pi 竞争。
      compaction: { enabled: true, reserveTokens: PI_COMPACTION_POLICY.reserveTokens, keepRecentTokens: PI_COMPACTION_POLICY.keepRecentTokens },
      // 工作台自己负责备用模型和最终失败收敛；Pi 只保留一次短重试，
      // 避免供应商不可达时叠加多层指数退避，把界面长时间卡在“连接模型”。
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 800, provider: { maxRetries: 0 } },
    });
    const modelRuntime = options.modelRuntime || await this.modelRuntime();
    const result = await createAgentSession({ ...options, cwd, modelRuntime, sessionManager, settingsManager });
    const dynamicFetch = (...args) => this.networkAdapter().fetch(...args);
    if (!wrapPiAgentStreamFunction(result.session, dynamicFetch)) {
      throw new Error("Pi AgentSession 未提供可注入网络适配器的 agent.streamFunction");
    }
    return { ...result, sessionManager };
  }

  beginRuntime({ key, clientId, threadId, cwd, profile = "通用 Agent", toolPolicyVersion = "task-tool-policy-v1" } = {}) {
    const previous = [...this.records].reverse().find((item) => item.key === key);
    const record = {
      version: 1,
      runtimeId: `runtime_${crypto.randomUUID()}`,
      key: key || null,
      clientId: clientId || null,
      threadId: threadId || null,
      cwd: cwd || null,
      status: "creating",
      health: { status: "starting", checkedAt: null, message: null },
      provider: null,
      model: null,
      profile: profile || "通用 Agent",
      toolPolicyVersion,
      toolPolicy: null,
      piPackageVersion: PI_PACKAGE_VERSION,
      capabilities: runtimeCapabilities,
      recoveryChain: previous?.runtimeId ? [{ runtimeId: previous.runtimeId, reason: "previous_runtime" }] : [],
      createdAt: now(),
      updatedAt: now(),
      lastActivityAt: now(),
      networkMode: this.networkSettings.mode,
      errorCategory: null,
      error: null,
    };
    this.records.push(record);
    this.trimAndPersist();
    return record;
  }

  bindSession(runtimeId, { session, profile, toolPolicyVersion, toolPolicy } = {}) {
    const record = this.find(runtimeId);
    if (!record) return null;
    record.status = "idle";
    record.health = { status: "healthy", checkedAt: now(), message: null };
    record.sessionId = session?.sessionId || null;
    record.provider = session?.model?.provider || null;
    record.model = modelSnapshot(session?.model);
    record.profile = profile || record.profile || "通用 Agent";
    record.toolPolicyVersion = toolPolicyVersion || record.toolPolicyVersion;
    record.toolPolicy = toolPolicy || record.toolPolicy || null;
    record.updatedAt = now();
    record.lastActivityAt = record.updatedAt;
    this.trimAndPersist();
    return record;
  }

  update(runtimeId, patch = {}) {
    const record = this.find(runtimeId);
    if (!record) return null;
    Object.assign(record, patch, { updatedAt: now(), lastActivityAt: now() });
    if (patch.model) record.model = modelSnapshot(patch.model);
    this.trimAndPersist();
    return record;
  }

  markFailure(runtimeId, error, { recovering = false, reason = "runtime_error" } = {}) {
    const record = this.find(runtimeId);
    if (!record) return null;
    const classification = classifyPiError(error, {
      mode: this.networkSettings.mode,
      provider: record.provider,
      model: record.model?.id,
    });
    record.status = recovering ? "recovering" : "failed";
    record.health = {
      status: recovering ? "degraded" : "failed",
      checkedAt: now(),
      message: classification.message,
      category: classification.code,
    };
    record.errorCategory = classification.code;
    record.error = {
      code: error?.code && ["PI_SETTLED_ERROR", "MODEL_TIMEOUT", "MODEL_STREAM_TIMEOUT", "MODEL_PROBE_TIMEOUT"].includes(String(error.code))
        ? String(error.code)
        : classification.code,
      category: classification.code,
      retryable: classification.retryable,
      status: classification.status,
      message: classification.message,
      classification,
    };
    record.recoveryChain = [...(record.recoveryChain || []), { at: now(), reason, status: record.status }].slice(-20);
    this.trimAndPersist();
    return record;
  }

  markRecovery(runtimeId, reason = "manual_recovery") {
    const record = this.find(runtimeId);
    if (!record) return null;
    record.status = "recovering";
    record.health = { status: "degraded", checkedAt: now(), message: "等待恢复入口" };
    record.recoveryChain = [...(record.recoveryChain || []), { at: now(), reason, status: "recovering" }].slice(-20);
    this.trimAndPersist();
    return record;
  }

  async runPrompt(runtimeId, operation, { steer = false, metadata = {} } = {}) {
    const record = this.find(runtimeId);
    if (record) this.update(runtimeId, { status: steer ? "running" : "queued", health: { status: "healthy", checkedAt: now(), message: null }, error: null });
    const execute = async () => {
      if (record) this.update(runtimeId, { status: "running" });
      try {
        return await operation();
      } catch (error) {
        this.markFailure(runtimeId, error, { recovering: false });
        throw error;
      } finally {
        const current = this.find(runtimeId);
        if (current && current.status === "running") this.update(runtimeId, { status: "idle", health: { status: "healthy", checkedAt: now(), message: null } });
      }
    };
    return steer ? execute() : this.agentLimiter.run(execute, { runtimeId, ...metadata });
  }

  prompt(_runtimeId, session, text, options = {}) {
    return session.prompt(text, options);
  }

  async abort(runtimeId, session) {
    const record = this.find(runtimeId);
    if (record) this.update(runtimeId, { status: "aborting" });
    try {
      await session?.abort?.();
      if (record) this.update(runtimeId, { status: "idle", health: { status: "healthy", checkedAt: now(), message: null } });
    } catch (error) {
      this.markFailure(runtimeId, error, { reason: "abort_failed" });
      throw error;
    }
  }

  async compact(runtimeId, session, instructions = "") {
    const record = this.find(runtimeId);
    if (record) this.update(runtimeId, { status: "compacting" });
    try {
      const result = await session.compact(instructions || undefined);
      if (record) this.update(runtimeId, { status: "idle", health: { status: "healthy", checkedAt: now(), message: null } });
      return result;
    } catch (error) {
      this.markFailure(runtimeId, error, { recovering: true, reason: "compact_failed" });
      throw error;
    }
  }

  async setModel(runtimeId, session, model) {
    try {
      await session.setModel(model);
      this.update(runtimeId, { provider: model?.provider || null, model: modelSnapshot(model), status: "idle" });
    } catch (error) {
      this.markFailure(runtimeId, error, { recovering: false, reason: "model_switch_failed" });
      throw error;
    }
  }

  /**
   * 只探测 provider 的真实请求链路，不创建/改写用户会话。
   * 模型目录可见、凭据已配置并不等于当前网络和网关真的可用；
   * 连接测试必须走和 Agent 相同的 Pi ModelRuntime。
   */
  async probeModel(model, { timeoutMs = 15000 } = {}) {
    const runtime = await this.modelRuntime();
    const limit = Math.max(5000, Math.min(30000, Number.parseInt(String(timeoutMs), 10) || 15000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    const startedAt = Date.now();
    const sessionId = `probe-${crypto.randomUUID()}`;
    try {
      const response = await runtime.completeSimple(model, {
        messages: [{ role: "user", content: "Reply with OK only.", timestamp: Date.now() }],
      }, {
        signal: controller.signal,
        timeoutMs: limit,
        maxRetries: 0,
        maxRetryDelayMs: 1000,
        // Anthropic Messages 传输在 reasoning="off" 时算不出思考预算（budget 未定义），
        // max_tokens 会变成 null 而被网关判为非法参数，把真实错误（如套餐不含该模型）掩盖掉。
        reasoning: model?.api === "anthropic-messages" ? "low" : "off",
        maxTokens: 16,
        fetch: this.networkAdapter().fetch,
        // OpenCode Go 要求 x-opencode-session；Pi Agent 本身会自动传递
        // SessionManager 的 ID，这个独立探测也必须保持同一请求语义。
        sessionId,
        ...(model?.provider === "opencode" || model?.provider === "opencode-go"
          ? { headers: { "x-opencode-session": sessionId, "x-opencode-client": "pi" } }
          : {}),
      });
      if (response?.stopReason === "error" || response?.errorMessage) {
        const error = new Error(response.errorMessage || "模型返回错误");
        error.code = "PI_SETTLED_ERROR";
        error.provider = model?.provider || null;
        error.model = model?.id || null;
        throw error;
      }
      return { response, latencyMs: Date.now() - startedAt };
    } catch (error) {
      if (controller.signal.aborted && error?.name !== "AbortError") {
        error.code = error.code || "MODEL_PROBE_TIMEOUT";
      } else if (controller.signal.aborted) {
        const timeoutError = new Error(`模型连接测试超过 ${Math.round(limit / 1000)} 秒没有响应`);
        timeoutError.code = "MODEL_PROBE_TIMEOUT";
        timeoutError.provider = model?.provider || null;
        timeoutError.model = model?.id || null;
        throw timeoutError;
      }
      const classification = classifyPiError(error, { mode: this.networkSettings.mode, provider: model?.provider, model: model?.id });
      error.errorCategory = classification.code;
      error.oawClassification = classification;
      if (!error.code || !["PI_SETTLED_ERROR", "MODEL_PROBE_TIMEOUT"].includes(String(error.code))) error.code = classification.code;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  setActiveTools(runtimeId, session, tools) {
    try {
      session.setActiveToolsByName([...new Set(Array.isArray(tools) ? tools : [])]);
      this.update(runtimeId, { toolPolicy: { tools: [...new Set(Array.isArray(tools) ? tools : [])] } });
    } catch (error) {
      this.markFailure(runtimeId, error, { recovering: false, reason: "tool_policy_apply_failed" });
      throw error;
    }
  }

  setThinkingLevel(runtimeId, session, level) {
    try {
      session.setThinkingLevel(level);
      this.update(runtimeId, { thinkingLevel: level });
    } catch (error) {
      this.markFailure(runtimeId, error, { recovering: false, reason: "thinking_level_apply_failed" });
      throw error;
    }
  }

  health(runtimeId, session, overrides = {}) {
    const record = this.find(runtimeId);
    if (!record) return null;
    const streaming = Boolean(session?.isStreaming);
    const idle = typeof session?.isIdle === "boolean" ? session.isIdle : !streaming;
    const status = record.status === "failed" ? "failed" : streaming ? "running" : idle ? "healthy" : "degraded";
    const next = {
      ...record,
      status: record.status === "failed" ? "failed" : streaming ? "running" : "idle",
      health: { status, checkedAt: now(), message: record.health?.message || null },
      sessionId: session?.sessionId || record.sessionId || null,
      provider: session?.model?.provider || record.provider || null,
      model: modelSnapshot(session?.model) || record.model || null,
      ...overrides,
      scheduler: this.agentLimiter.snapshot(),
    };
    this.update(runtimeId, next);
    return safeRuntimeRecord(next);
  }

  snapshot(runtimeId, overrides = {}) {
    const record = this.find(runtimeId);
    if (!record) return null;
    return safeRuntimeRecord({ ...record, ...overrides, capabilities: record.capabilities || runtimeCapabilities });
  }

  listSnapshots() {
    return this.records.map((record) => safeRuntimeRecord(record)).filter(Boolean).reverse();
  }

  schedulerSnapshot() {
    return { agent: this.agentLimiter.snapshot(), officecli: this.officeLimiter.snapshot() };
  }

  dispose(runtimeId, session) {
    try { session?.dispose?.(); } catch (error) { this.markFailure(runtimeId, error, { reason: "dispose_failed" }); }
    const record = this.find(runtimeId);
    if (record) {
      record.status = "disposed";
      record.health = { status: "stopped", checkedAt: now(), message: null };
      record.updatedAt = now();
      this.trimAndPersist();
    }
  }

  async disposeAll(entries = []) {
    for (const entry of entries) this.dispose(entry.runtimeId, entry.session);
    this.modelRuntimePromise = null;
    this.networkAdapterInstance?.close?.();
    this.networkAdapterInstance = null;
  }

  find(runtimeId) {
    return this.records.find((item) => item.runtimeId === runtimeId) || null;
  }

  markPersistedRuntimesRecovering() {
    let changed = false;
    for (const record of this.records) {
      if (["creating", "queued", "running", "aborting", "compacting"].includes(record.status)) {
        record.status = "recovering";
        record.health = { status: "degraded", checkedAt: now(), message: "服务重启后等待显式恢复" };
        record.recoveryChain = [...(record.recoveryChain || []), { at: now(), reason: "process_restart", status: "recovering" }].slice(-20);
        changed = true;
      }
    }
    if (changed) this.trimAndPersist();
  }

  trimAndPersist() {
    this.records = this.records.slice(-RUNTIME_RECORD_LIMIT);
    ensureDirectory(path.dirname(this.recordFile));
    try { atomicWriteJson(this.recordFile, this.records.map((record) => safeRuntimeRecord(record))); } catch {}
  }
}

function loadRuntimeRecordsFrom(file) {
  const value = readJsonFile(file, []);
  return Array.isArray(value) ? value : [];
}

export const piRuntimeManager = new PiRuntimeManager();
export const officeLimiter = piRuntimeManager.officeLimiter;

// Agent 业务层只从本适配层取得 Pi 构造器，避免在业务模块散落 Pi SDK 依赖。
export {
  createBashToolDefinition,
  createEditToolDefinition,
  createLocalBashOperations,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  defineTool,
};
