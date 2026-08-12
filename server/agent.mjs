import { EventEmitter } from "node:events";
import path from "node:path";
import fs from "node:fs";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AGENT_DIR, PROJECT_DIR, WORKSPACE_DIR, OFFICECLI } from "./workspace.mjs";

const SESSION_STORE = path.join(AGENT_DIR, "sessions");

/** Per-client agent sessions. Emits events to SSE subscribers. */
class AgentManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map(); // clientId -> { session, emitter, busy, loader, modelRuntime }
    this.modelRuntimePromise = null;
  }

  modelRuntime() {
    if (!this.modelRuntimePromise) {
      this.modelRuntimePromise = ModelRuntime.create().catch((e) => {
        this.modelRuntimePromise = null;
        throw e;
      });
    }
    return this.modelRuntimePromise;
  }

  async getOrCreate(clientId) {
    const existing = this.sessions.get(clientId);
    if (existing) return existing;
    if (!this.creates) this.creates = new Map();
    if (this.creates.has(clientId)) return this.creates.get(clientId);
    const p = this._create(clientId);
    this.creates.set(clientId, p);
    try {
      return await p;
    } finally {
      this.creates.delete(clientId);
    }
  }

  async _create(clientId) {
    const modelRuntime = await this.modelRuntime();
    let entry; // 在下方创建，供 officeTool 闭包引用
    const loader = new DefaultResourceLoader({
      cwd: PROJECT_DIR,
      agentDir: AGENT_DIR,
      agentsFilesOverride: (current) => ({
        agentsFiles: [
          ...current.agentsFiles,
          {
            path: "F:\\Claude code本地文件\\office-agent-web\\.agent-context.md",
            content: [
              "# Office Agent Workspace",
              "",
              "- Office files live in the current workspace folder (default: `" + WORKSPACE_DIR + "`).",
              "- ALWAYS operate on office documents through the `officecli` tool — it runs on Windows natively and resolves file names relative to the current workspace. NEVER try to run `officecli` via the bash tool.",
              "- The bash tool may run inside WSL: Windows paths like `F:\\...` are not directly valid there; prefer the officecli tool for documents and `read`/`write` for text.",
              "- **IMPORTANT**: the user is currently working on a specific document. Before modifying any document, read the file `F:\\Claude code本地文件\\office-agent-web\\.agent-context.md` (it contains the CURRENT WORKING FILE). Operate on that file unless the user explicitly names another.",
              "- **写文件规范**: 创建任何新文件（HTML/文档/图表等）时，必须写入当前工作区 `" + WORKSPACE_DIR + "`（绝对路径），禁止写入项目目录 `F:\\Claude code本地文件\\office-agent-web\\`。否则产物不会被前端检测到。",
              "- **知识库（kb）**: 本地知识库索引了多个 Markdown 根目录（如 柬埔寨公交项目/义乌物流专题资料/_knowledge_base）。可用 kb_search 搜索、kb_read 读取全文。用户引用格式 `@知识库[路径@根目录名]`——例如 `@知识库[OD出行分析报告_完整版.md@柬埔寨公交项目]`，分析知识库内容时优先调用这两个工具，不要靠猜测。",
              "- **地图项目（maps）**: 地图可视化项目位于 `" + WORKSPACE_DIR + "\\maps\\zhejiang-map\\`。结构：`map.config.json`（项目配置）、`style.json`（MapLibre 样式，改这里可改地图样式）、`layers/*.geojson`（图层数据）、`tiles/`（矢量瓦片，由脚本生成，勿手改）。用户在地图页面与您对话时，改图操作 = 修改 `style.json`（图层颜色/线宽/显隐）或 `layers/*.geojson`（数据），文件保存后浏览器会自动热更新。若改了图层数据，可运行 `node scripts/build-vector-tiles.mjs --layer=<图层名>` 重建瓦片（在项目根目录 `" + PROJECT_DIR + "` 下执行）。底图源：carto/osm/dark/satellite。",
              "- When you modify a document, confirm what changed. Files are auto-refreshed in the browser.",
            ].join("\n"),
          },
        ],
        diagnostics: current.diagnostics,
      }),
    });
    await loader.reload();

    const officeTool = defineTool({
      name: "officecli",
      label: "Office CLI",
      description:
        "Run officecli commands on Office documents (.docx/.xlsx/.pptx) in the current workspace folder. Pass the FULL command arguments as a single string, e.g. 'view report.docx text', 'get report.docx / --depth 2 --json', 'set report.docx /body/p[1] --prop bold=true', 'set report.docx / --find draft --replace final', 'add deck.pptx /slide[1] --type shape --prop text=... --prop size=24pt'. File names are relative to the current workspace folder (may include subfolder paths). The user's CURRENT WORKING FILE is noted in the context file — when the user asks to modify a document, operate on that file unless they say otherwise. Use --json for structured output. Prefer this tool over bash for all document operations.",
      parameters: Type.Object({
        args: Type.String({ description: "officecli command arguments (single string)" }),
      }),
      execute: async (_toolCallId, params) => {
        const { runOfficecli } = await import("./office.mjs");
        const { getWorkspace } = await import("./workspace.mjs");
        const args = parseArgs(params.args);
        const r = await runOfficecli(args, { cwd: getWorkspace() });
        const body = r.stdout + (r.stderr || "");
        const hint = entry.currentFile
          ? `\n[当前工作文件: ${entry.currentFile}]`
          : "";
        return {
          content: [{ type: "text", text: (body || `(exit ${r.code}, no output)`) + hint }],
          details: {},
        };
      },
    });

    const kbSearchTool = defineTool({
      name: "kb_search",
      label: "知识库搜索",
      description:
        "搜索本地知识库（已索引的 Markdown 文档）。返回匹配文档的路径、标题与摘要片段。当用户引用知识库内容、要求检索资料/观点/素材时使用。支持中文关键词。",
      parameters: Type.Object({
        query: Type.String({ description: "搜索关键词（支持中文，可多个词空格分隔）" }),
      }),
      execute: async (_toolCallId, params) => {
        const kb = await import("./kb.mjs");
        await kb.scan();
        const results = kb.search(params.query || "", null, 8);
        if (!results.length) return { content: [{ type: "text", text: "未找到匹配的知识库文档。" }], details: {} };
        const lines = results.map(
          (r) => `[${r.title}] 路径: ${r.relPath}（得分 ${r.score}）\n  摘要: ${r.snippet}`
        );
        return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
      },
    });

    const kbReadTool = defineTool({
      name: "kb_read",
      label: "知识库读取",
      description:
        "读取知识库中某篇文档的完整 Markdown 内容。参数 path 格式为「相对路径@根目录名」，例如「OD出行分析报告_完整版.md@柬埔寨公交项目」。当用户以 @知识库[路径@根目录名] 引用文档时，把其中的路径与根目录名填入此参数。",
      parameters: Type.Object({
        path: Type.String({ description: "相对路径@根目录名，如 xx.md@根目录" }),
      }),
      execute: async (_toolCallId, params) => {
        const kb = await import("./kb.mjs");
        await kb.scan();
        const raw = String(params.path || "").trim();
        const parts = raw.split("@").map((s) => (s || "").trim());
        const relPath = parts[0];
        const rootName = parts[1] || "";
        let rootIdx = null;
        if (rootName) {
          const idx = kb.status().roots.findIndex((r) => r.name === rootName);
          if (idx >= 0) rootIdx = idx;
        }
        const doc = kb.getDoc(relPath, rootIdx);
        if (!doc) {
          return { content: [{ type: "text", text: `未找到文档: ${raw}` }], details: {} };
        }
        const text = `# ${doc.title}\n\n标签: ${doc.tags.join(", ") || "无"}\n路径: ${relPath}\n\n${doc.content}`;
        return { content: [{ type: "text", text: text.slice(0, 40000) }], details: {} };
      },
    });

    // ---- 地图工具（map_read / map_edit / map_import，移植自 v0.7.5） ----
    const mapReadTool = defineTool({
      name: "map_read",
      label: "地图读取",
      description:
        "读取地图项目（默认 zhejiang-map 浙江省交通地图）的配置、图层清单与当前样式。用户在地图模式下询问地图状态/图层/样式时使用。返回：项目中心/缩放/底图、图层文件列表（id/名称/类型）、样式图层（显隐/颜色/线宽/透明度）。",
      parameters: Type.Object({
        project: Type.Optional(Type.String({ description: "项目名，默认 zhejiang-map" })),
      }),
      execute: async (_toolCallId, params) => {
        const map = await import("./map.mjs");
        const name = params.project || map.DEFAULT_PROJECT;
        const p = map.getProject(name);
        if (!p) return { content: [{ type: "text", text: `项目不存在: ${name}` }], details: {} };
        const cfgLines = `项目: ${p.config.name}\n中心: ${p.config.center} 缩放: ${p.config.zoom} 底图: ${p.config.basemap}`;
        const files = (p.files || []).length
          ? p.files.map((f) => `  ${f.id}（${(f.size / 1024).toFixed(1)} KB）`).join("\n")
          : "  （无图层文件）";
        const styleLayers = p.style.layers
          .filter((l) => !l.id.startsWith("basemap-"))
          .map((l) => {
            const vis = l.layout?.visibility === "none" ? "隐藏" : "显示";
            const paint = l.paint ? JSON.stringify(l.paint) : "";
            return `  ${l.id} [${l.type}] ${vis} ${paint}`;
          })
          .join("\n") || "  （无样式图层）";
        return {
          content: [{
            type: "text",
            text: `${cfgLines}\n\n图层文件（${p.files?.length || 0}）:\n${files}\n\n样式图层:\n${styleLayers}`,
          }],
          details: {},
        };
      },
    });

    const mapEditTool = defineTool({
      name: "map_edit",
      label: "地图样式编辑",
      description:
        "修改地图项目样式（style.json），立即反映到前端地图。action 支持：\n1) setVisibility：显示/隐藏图层（layerId + visible）\n2) setPaint：修改图层绘制属性（layerId + paint，JSON 字符串，如 {\"line-color\":\"#ff0000\",\"line-width\":3,\"line-opacity\":0.8}；线图层用 line-*，点图层用 circle-*，面图层用 fill-*）\n3) move：调整图层叠放顺序（layerId + direction up/down）\n4) add：新增样式图层（layerId + type 如 fill/line/circle + paint JSON + source 可选，默认引用同名矢量源）\n修改前建议先 map_read 查看当前样式。",
      parameters: Type.Object({
        project: Type.Optional(Type.String({ description: "项目名，默认 zhejiang-map" })),
        action: Type.Union([
          Type.Literal("setVisibility"),
          Type.Literal("setPaint"),
          Type.Literal("move"),
          Type.Literal("add"),
        ]),
        layerId: Type.String({ description: "样式图层 id，如 highways / boundary-city / toll-stations" }),
        visible: Type.Optional(Type.Boolean({ description: "setVisibility: 是否显示" })),
        paint: Type.Optional(Type.String({ description: "setPaint/add: 绘制属性 JSON 字符串" })),
        direction: Type.Optional(Type.String({ description: "move: up / down" })),
        type: Type.Optional(Type.String({ description: "add: fill / line / circle" })),
        source: Type.Optional(Type.String({ description: "add: 数据源 id，默认等于 layerId" })),
      }),
      execute: async (_toolCallId, params) => {
        const map = await import("./map.mjs");
        const name = params.project || map.DEFAULT_PROJECT;
        const dir = map.projectDir(name);
        if (!dir) return { content: [{ type: "text", text: "项目不存在" }], details: {} };
        const fs = (await import("node:fs")).default;
        const path = (await import("node:path")).default;
        const stylePath = path.join(dir, "style.json");
        const style = JSON.parse(fs.readFileSync(stylePath, "utf8"));
        const layerId = String(params.layerId || "");
        if (!layerId) return { content: [{ type: "text", text: "layerId 必填" }], details: {} };
        let paint = null;
        if (params.paint) {
          try { paint = JSON.parse(params.paint); } catch { return { content: [{ type: "text", text: `paint 不是合法 JSON: ${params.paint}` }], details: {} }; }
        }
        if (params.action === "setVisibility") {
          const l = style.layers.find((x) => x.id === layerId);
          if (!l) return { content: [{ type: "text", text: `样式图层不存在: ${layerId}` }], details: {} };
          l.layout = { ...(l.layout || {}), visibility: params.visible ? "visible" : "none" };
        } else if (params.action === "setPaint") {
          const l = style.layers.find((x) => x.id === layerId);
          if (!l) return { content: [{ type: "text", text: `样式图层不存在: ${layerId}` }], details: {} };
          l.paint = { ...(l.paint || {}), ...paint };
        } else if (params.action === "move") {
          const idx = style.layers.findIndex((x) => x.id === layerId);
          if (idx === -1) return { content: [{ type: "text", text: `样式图层不存在: ${layerId}` }], details: {} };
          const target = params.direction === "up" ? idx + 1 : idx - 1;
          if (target < 0 || target >= style.layers.length) {
            return { content: [{ type: "text", text: "已到边界，无法继续移动" }], details: {} };
          }
          const [item] = style.layers.splice(idx, 1);
          style.layers.splice(target, 0, item);
        } else if (params.action === "add") {
          const src = params.source || layerId;
          const base = { id: layerId, source: src, type: params.type || "fill", "source-layer": src };
          const defs = { fill: { "fill-color": "#8abeb7", "fill-opacity": 0.4 }, line: { "line-color": "#8abeb7", "line-width": 2 }, circle: { "circle-radius": 5, "circle-color": "#8abeb7" } };
          base.layout = { visibility: "visible" };
          base.paint = paint || defs[params.type] || defs.fill;
          style.layers.push(base);
        }
        fs.writeFileSync(stylePath, JSON.stringify(style, null, 2));
        const vis = style.layers.find((x) => x.id === layerId)?.layout?.visibility;
        return {
          content: [{ type: "text", text: `已更新样式图层 ${layerId}（${params.action}${vis ? ", 可见性=" + vis : ""}），前端地图已实时刷新。` }],
          details: {},
        };
      },
    });

    const mapImportTool = defineTool({
      name: "map_import",
      label: "地图数据导入",
      description:
        "把工作区中的 GeoJSON 文件导入为地图项目的新图层（自动生成矢量瓦片）。参数 file 为相对工作区根目录的路径，layerId 可选（默认取文件名）。导入后前端图层树会显示新图层。",
      parameters: Type.Object({
        file: Type.String({ description: "相对工作区的 GeoJSON 文件路径，如 maps_data/highways.geojson" }),
        project: Type.Optional(Type.String({ description: "项目名，默认 zhejiang-map" })),
        layerId: Type.Optional(Type.String({ description: "图层 id（字母数字下划线），默认取文件名" })),
      }),
      execute: async (_toolCallId, params) => {
        const map = await import("./map.mjs");
        const { getWorkspace } = await import("./workspace.mjs");
        const fs = (await import("node:fs")).default;
        const path = (await import("node:path")).default;
        const ws = getWorkspace();
        const rel = String(params.file || "");
        const fp = path.resolve(ws, rel);
        if (!fp.startsWith(path.resolve(ws))) {
          return { content: [{ type: "text", text: "file 必须在工作区内" }], details: {} };
        }
        if (!fs.existsSync(fp)) {
          return { content: [{ type: "text", text: `文件不存在: ${rel}` }], details: {} };
        }
        let geojson;
        try { geojson = JSON.parse(fs.readFileSync(fp, "utf8")); } catch {
          return { content: [{ type: "text", text: `不是合法的 GeoJSON: ${rel}` }], details: {} };
        }
        const fallbackId = path.basename(rel, path.extname(rel)).replace(/[^a-zA-Z0-9_-]/g, "_") || "layer";
        const layerId = (params.layerId || fallbackId).replace(/[^a-zA-Z0-9_-]/g, "_");
        const name = params.project || map.DEFAULT_PROJECT;
        const r = await map.importLayer(name, layerId, geojson);
        const count = geojson.features?.length || 0;
        return {
          content: [{ type: "text", text: `已导入图层 ${layerId}（${count} 个要素，${r.tiles?.count || 0} 个瓦片）到项目 ${name}，前端地图已实时刷新。` }],
          details: {},
        };
      },
    });

    const sessionManager = SessionManager.create(SESSION_STORE);
    const { session } = await createAgentSession({
      cwd: PROJECT_DIR,
      agentDir: AGENT_DIR,
      modelRuntime,
      resourceLoader: loader,
      customTools: [officeTool, kbSearchTool, kbReadTool, mapReadTool, mapEditTool, mapImportTool],
      tools: ["read", "bash", "grep", "find", "ls", "write", "edit", "officecli"],
      sessionManager,
    });

    const emitter = new EventEmitter();
    // event channel with history for SSE replay
    const channel = { history: [], seq: 0, emitter: new EventEmitter() };
    const emit = (type, data) => {
      const id = ++channel.seq;
      const ev = { id, type, data: data ?? {} };
      channel.history.push(ev);
      if (channel.history.length > 2000) channel.history.shift();
      channel.emitter.emit("event", ev);
    };
    session.subscribe((ev) => {
      // forward interesting events
      switch (ev.type) {
        case "message_update":
          if (ev.assistantMessageEvent.type === "text_delta") {
            emit("token", { text: ev.assistantMessageEvent.delta });
          }
          // 思考过程转发
          if (ev.assistantMessageEvent.type === "thinking_delta") {
            emit("thinking", { text: ev.assistantMessageEvent.delta });
          }
          break;
        case "tool_execution_start":
          // 工具调用开始：传递工具名 + 输入参数（pi SDK 字段是 args）
          emit("tool_start", {
            name: ev.toolName,
            input: typeof ev.args === "string" ? ev.args : JSON.stringify(ev.args || "", null, 2),
          });
          break;
        case "tool_execution_update":
          // 工具执行过程中的输出流
          if (ev.output || ev.delta) {
            emit("tool_output", {
              name: ev.toolName,
              output: ev.output || ev.delta || "",
            });
          }
          break;
        case "tool_execution_end":
          emit("tool_end", {
            name: ev.toolName,
            isError: ev.isError,
            result: ev.result || ev.output || "",
          });
          break;
        case "message_start":
          emit("message_start", {});
          break;
        case "message_end":
          emit("message_end", {});
          break;
        case "usage":
        case "stats":
          // usage/stats 事件：转发为统一的 stats 事件给前端
          if (ev.usage || ev.tokens) {
            const u = ev.usage || ev.tokens;
            emit("stats", {
              tokens: {
                input: u.inputTokens ?? u.input ?? 0,
                output: u.outputTokens ?? u.output ?? 0,
                cacheRead: u.cacheReadTokens ?? u.cacheRead ?? u.cache_read ?? 0,
                cacheWrite: u.cacheWriteTokens ?? u.cacheWrite ?? u.cache_write ?? 0,
              },
              cost: ev.cost ?? u.cost ?? 0,
            });
          }
          break;
        case "agent_end":
          emit("agent_end", {});
          // 若 ev 包含 usage 信息，emit stats 事件
          if (ev.usage) {
            const u = ev.usage;
            emit("stats", {
              tokens: {
                input: u.inputTokens ?? u.input ?? 0,
                output: u.outputTokens ?? u.output ?? 0,
                cacheRead: u.cacheReadTokens ?? u.cacheRead ?? u.cache_read ?? 0,
                cacheWrite: u.cacheWriteTokens ?? u.cacheWrite ?? u.cache_write ?? 0,
              },
              cost: ev.cost ?? u.cost ?? 0,
            });
          }
          break;
        case "error":
          emit("agent_error", { message: ev.error?.message || String(ev.error || "") });
          break;
        default:
          break;
      }
    });

    entry = { session, channel, busy: false, loader };
    this.sessions.set(clientId, entry);
    return entry;
  }

  /** Run a prompt. Events stream to entry.emitter; resolves on completion. */
  async prompt(clientId, text, images = [], effort) {
    const entry = await this.getOrCreate(clientId);
    const isStreaming = entry.busy;
    entry.busy = true;
    try {
      // 应用推理强度（low/medium/high → pi thinking level）
      if (effort) {
        try { entry.session.setThinkingLevel(effort); } catch {}
      }
      // 强制注入当前工作文件声明（兜底，防止 agent 不知道在改哪个文档）
      if (entry.currentFile) {
        const marker = `[当前工作文件: ${entry.currentFile}]\n`;
        if (!text.includes("当前工作文件") && !text.includes(entry.currentFile)) {
          text = marker + text;
        }
      }
      const opts = {};
      if (images && images.length) {
        // pi-ai v0.83 ImageContent: { type: "image", data, mimeType }
        opts.images = images.map((img) => ({
          type: "image",
          data: img.data,
          mimeType: img.mediaType || "image/png",
        }));
      }
      if (isStreaming) {
        // 打断当前回合并插入新指令（steer 在 agent 停止后生效，或中断当前工具调用）
        opts.streamingBehavior = "steer";
        emitChannelSafe(entry, "steer", { text: text.slice(0, 80) });
        await entry.session.prompt(text, opts);
      } else {
        try {
          await entry.session.prompt(text, opts);
        } catch (e) {
          // 竞态兜底：entry.busy=false 但 pi 内部仍在收尾（compaction/post-run），
          // 此时 pi 的 isStreaming 仍为 true，重试走 steer 队列
          if (e && typeof e.message === "string" && e.message.includes("Agent is already processing")) {
            emitChannelSafe(entry, "steer", { text: text.slice(0, 80) });
            await entry.session.prompt(text, { ...opts, streamingBehavior: "steer" });
          } else {
            throw e;
          }
        }
      }
    } finally {
      entry.busy = false;
    }
  }

  /** 中止当前 agent 运行。 */
  async abort(clientId) {
    const entry = this.sessions.get(clientId);
    if (!entry) return { ok: true };
    try {
      await entry.session.abort();
      emitChannelSafe(entry, "aborted", {});
    } catch {}
    entry.busy = false;
    return { ok: true };
  }

  /** 记录当前工作文件，并同步到 agent 上下文（agent 通过读 .agent-context.md 感知）。 */
  async setCurrentFile(clientId, file) {
    let entry = this.sessions.get(clientId);
    if (!entry) entry = await this.getOrCreate(clientId);
    entry.currentFile = file || null;
    // 更新 agent 上下文文件（动态注入当前工作文件）
    try {
      const ctx = [
        "# Office Agent Workspace",
        "",
        "- Office files live in `" + WORKSPACE_DIR + "` (or the current workspace).",
        "- ALWAYS operate on office documents through the `officecli` tool — it runs on Windows natively and resolves file names relative to the workspace folder. NEVER try to run `officecli` via the bash tool.",
        "- The bash tool may run inside WSL: Windows paths like `F:\\...` are not directly valid there; prefer the officecli tool for documents and `read`/`write` for text.",
        "",
        "## 当前工作文件（用户正在查看/编辑的文档）",
        file ? "- 当前工作文件: " + file : "- 当前没有打开文档",
        file
          ? "- 用户的操作默认针对此文件。修改它时直接用 officecli 操作（文件名相对工作区根目录，含子目录路径）。完成后告知用户已修改。"
          : "- 如果用户提到要修改某个文档，先用 officecli view 确认内容再操作。",
        "",
        "- When the user asks to modify a document, make the changes, then confirm what changed. Files are auto-refreshed in the browser.",
      ].join("\n");
      fs.writeFileSync(path.join(PROJECT_DIR, ".agent-context.md"), ctx, "utf8");
    } catch {}
    return { ok: true, currentFile: entry.currentFile };
  }

  async setModel(clientId, spec) {
    const entry = await this.getOrCreate(clientId);
    if (entry.busy) throw new Error("agent busy — wait for the current task to finish");
    const [provider, id] = String(spec).split("/");
    const mr = await this.modelRuntime();
    const model = mr.getModel(provider, id);
    if (!model) throw new Error("model not found: " + spec);
    await entry.session.setModel(model);
    return { ok: true, model: spec };
  }

  async listModels() {
    const mr = await this.modelRuntime();
    const avail = await mr.getAvailable();
    return avail.map((m) => ({
      id: m.provider + "/" + m.id,
      provider: m.provider,
      name: m.name || m.id,
      vision: !!m.vision,
    }));
  }

  async disposeAll() {
    for (const { session } of this.sessions.values()) {
      try {
        session.dispose();
      } catch {}
    }
    this.sessions.clear();
  }
}

/** Minimal arg parser: splits on whitespace, supports double-quoted segments. */
function emitChannelSafe(entry, type, data) {
  try {
    const id = ++entry.channel.seq;
    const ev = { id, type, data: data ?? {} };
    entry.channel.history.push(ev);
    if (entry.channel.history.length > 2000) entry.channel.history.shift();
    entry.channel.emitter.emit("event", ev);
  } catch {}
}

export function parseArgs(input) {
  const args = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(input))) args.push(m[1] ?? m[2] ?? m[3]);
  return args;
}

// 初始化 agent 上下文文件（让 agent 首次能 read 到）
(function ensureContextFile() {
  try {
    const fp = path.join(PROJECT_DIR, ".agent-context.md");
    if (!fs.existsSync(fp)) {
      fs.writeFileSync(fp, "# Office Agent Workspace\n\n- 当前没有打开文档\n- 当前工作文件: (无)\n", "utf8");
    }
  } catch {}
})();

export const agentManager = new AgentManager();
