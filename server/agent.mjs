import { EventEmitter } from "node:events";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AGENT_DIR, PROJECT_DIR, WORKSPACE_DIR, OFFICECLI, getWorkspace } from "./workspace.mjs";
import { resolveReferences, readReference, contextSummary } from "./context.mjs";
import { recordRunEvent } from "./runs.mjs";
import { taskSummary } from "./task.mjs";

const SESSION_STORE = path.join(AGENT_DIR, "sessions");

/** 分层读取工作区记忆：规则优先，偏好/项目知识/经验再按预算注入。 */
function readMemoryLayers() {
  const layers = { rules: "", project: "", preferences: "", lessons: "", other: [] };
  try {
    const ws = getWorkspace();
    const read = (file, max = 1800) => {
      try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().slice(0, max) : ""; } catch { return ""; }
    };
    layers.rules = read(path.join(ws, "AGENTS.md"), 1800);
    const memDir = path.join(ws, "memory");
    if (fs.existsSync(memDir)) {
      for (const f of fs.readdirSync(memDir).filter((x) => x.endsWith(".md"))) {
        const content = read(path.join(memDir, f), 1800);
        if (!content) continue;
        const key = f.toLowerCase();
        if (key.includes("preference") || key.includes("用户偏好")) layers.preferences += `\n${content}`;
        else if (key.includes("project") || key.includes("项目信息")) layers.project += `\n${content}`;
        else if (key.includes("lesson") || key.includes("经验教训")) layers.lessons += `\n${content}`;
        else layers.other.push({ file: f, content });
      }
    }
  } catch {}
  return layers;
}

function readMemoryContext() {
  const layers = readMemoryLayers();
  return [
    layers.rules && `## 工作区准则（AGENTS.md）\n${layers.rules}`,
    layers.project && `## 项目信息\n${layers.project.slice(0, 1400)}`,
    layers.preferences && `## 用户偏好\n${layers.preferences.slice(0, 1400)}`,
    layers.lessons && `## 经验教训\n${layers.lessons.slice(0, 1400)}`,
    ...layers.other.map((x) => `## 记忆：${x.file}\n${x.content.slice(0, 1000)}`),
  ].filter(Boolean).join("\n\n").slice(0, 6000);
}

/** memory_update 工具：按 section 写入 memory/MEMORY.md（替换同 section，总长控制）——写入当前工作区 */
function writeMemorySection(section, content) {
  const memDir = path.join(getWorkspace(), "memory");
  fs.mkdirSync(memDir, { recursive: true });
  const memFile = path.join(memDir, "MEMORY.md");
  const maxLen = 1200;
  const body = String(content || "").trim().slice(0, maxLen);
  const title = `## ${section}`;
  let text = "";
  try {
    if (fs.existsSync(memFile)) text = fs.readFileSync(memFile, "utf8");
  } catch {}
  // 按 ## section 分组：移除旧的同名 section（含标题行 + 后续内容到下一个 ##）
  const lines = text.split(/\r?\n/);
  const out = [];
  let inTarget = false;
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      inTarget = line.trim().replace(/^##\s+/, "") === section;
      if (!inTarget) out.push(line);
      continue;
    }
    if (!inTarget) out.push(line);
  }
  const rest = out.join("\n").trim();
  const block = `${title}\n${body}`;
  text = rest ? `${rest}\n\n${block}\n` : `${block}\n`;
  // 总长控制（约 6000 字符，超出截断最旧部分）
  if (text.length > 6000) text = text.slice(-6000);
  fs.writeFileSync(memFile, text, "utf8");
  return { ok: true, section, file: "memory/MEMORY.md" };
}

const PROPOSALS_FILE = path.join(PROJECT_DIR, ".oaw", "memory-proposals.json");
const PENDING_ASKS_FILE = path.join(PROJECT_DIR, ".oaw", "pending-asks.json");
function readMemoryProposals() {
  try { return JSON.parse(fs.readFileSync(PROPOSALS_FILE, "utf8")); } catch { return []; }
}
function saveMemoryProposals(items) {
  fs.mkdirSync(path.dirname(PROPOSALS_FILE), { recursive: true });
  fs.writeFileSync(PROPOSALS_FILE, JSON.stringify(items.slice(-200), null, 2) + "\n", "utf8");
}
function createMemoryProposal(threadId, section, content) {
  const items = readMemoryProposals();
  const proposal = { id: `memory_${crypto.randomUUID()}`, threadId, section, content: String(content || "").trim().slice(0, 1200), status: "pending", createdAt: new Date().toISOString() };
  items.push(proposal);
  saveMemoryProposals(items);
  return proposal;
}
function approveMemoryProposal(id) {
  const items = readMemoryProposals();
  const proposal = items.find((x) => x.id === id);
  if (!proposal) return { ok: false, error: "proposal not found" };
  if (proposal.status !== "approved") {
    const result = writeMemorySection(proposal.section, proposal.content);
    proposal.status = result.ok ? "approved" : "failed";
    proposal.approvedAt = new Date().toISOString();
  }
  saveMemoryProposals(items);
  return { ok: proposal.status === "approved", proposal };
}

function readPendingAsks() {
  try { return JSON.parse(fs.readFileSync(PENDING_ASKS_FILE, "utf8")); } catch { return []; }
}
function savePendingAsks(items) {
  fs.mkdirSync(path.dirname(PENDING_ASKS_FILE), { recursive: true });
  fs.writeFileSync(PENDING_ASKS_FILE, JSON.stringify(items.slice(-100), null, 2) + "\n", "utf8");
}
function persistPendingAsk(item) {
  const items = readPendingAsks().filter((x) => x.clientId !== item.clientId || x.status !== "pending");
  items.push(item);
  savePendingAsks(items);
}
function resolvePendingAsk(clientId, answer, status = "answered") {
  const items = readPendingAsks();
  const item = [...items].reverse().find((x) => x.clientId === clientId && x.status === "pending");
  if (item) { item.status = status; item.answer = answer || null; item.resolvedAt = new Date().toISOString(); savePendingAsks(items); }
  return item;
}

function consumeRecoveredAnswers(clientId) {
  const items = readPendingAsks();
  const recovered = items.filter((x) => x.clientId === clientId && x.status === "queued" && x.answer);
  if (!recovered.length) return [];
  for (const item of recovered) { item.status = "consumed"; item.consumedAt = new Date().toISOString(); }
  savePendingAsks(items);
  return recovered;
}

/** Per-client agent sessions. Emits events to SSE subscribers. */
class AgentManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map(); // agentKey(clientId:threadId) -> session entry
    this.modelRuntimePromise = null;
    this.pendingAsks = new Map(); // agentKey -> resolve(回答)（ask_user 工具阻塞等待）
  }

  /** 读取并清除待回答的问题（返回 resolve 函数） */
  askPending(clientId) {
    const ask = this.pendingAsks.get(clientId);
    if (ask) this.pendingAsks.delete(clientId);
    return ask;
  }

  submitAnswer(clientId, answer) {
    const live = this.askPending(clientId);
    if (live) { live(String(answer || "")); return { ok: true, mode: "live" }; }
    const recovered = resolvePendingAsk(clientId, String(answer || ""), "queued");
    return recovered ? { ok: true, mode: "queued", questionId: recovered.id } : { ok: false };
  }

  memoryProposals(threadId = "") {
    return readMemoryProposals().filter((p) => !threadId || p.threadId === threadId);
  }

  approveMemoryProposal(id) {
    const result = approveMemoryProposal(id);
    const proposal = result.proposal;
    if (proposal?.threadId) {
      const entry = this.sessions.get(proposal.threadId);
      if (entry) emitChannelSafe(entry, "memory_proposal_resolved", { proposal });
    }
    return result;
  }

  pendingQuestions(clientId = "") {
    return readPendingAsks().filter((q) => !clientId || q.clientId === clientId);
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

  async getOrCreate(clientId, options = {}) {
    const existing = this.sessions.get(clientId);
    if (existing) return existing;
    if (!this.creates) this.creates = new Map();
    if (this.creates.has(clientId)) return this.creates.get(clientId);
    const p = this._create(clientId, options);
    this.creates.set(clientId, p);
    try {
      return await p;
    } finally {
      this.creates.delete(clientId);
    }
  }

  async _create(clientId, options = {}) {
    const modelRuntime = await this.modelRuntime();
    let entry; // 在下方创建，供 officeTool 闭包引用
    const loader = new DefaultResourceLoader({
      cwd: PROJECT_DIR,
      agentDir: AGENT_DIR,
      agentsFilesOverride: (current) => ({
        agentsFiles: [
          ...current.agentsFiles,
          {
            path: ".agent-context.md",
            content: [
              "# Open Plan（规聚）Workspace",
              "",
              "- **工作区与当前文件**: 每次对话前服务端都会刷新项目根 `.agent-context.md`，其中包含「**当前工作区**」绝对路径与「**当前工作文件**」。操作文件前必须先 read `.agent-context.md` 获取这两个信息（工作区可能被用户切换，不要假设默认路径）。",
              "- ALWAYS operate on office documents through the `officecli` tool — it runs on Windows natively and resolves file names relative to the current workspace. NEVER try to run `officecli` via the bash tool.",
              "- The bash tool may run inside WSL: Windows paths like `F:\\...` are not directly valid there; prefer the officecli tool for documents and `read`/`write` for text.",
              "- **写文件规范**: 创建任何新文件（HTML/文档/图表等）时，必须写入 `.agent-context.md` 中的「当前工作区」绝对路径，禁止写入项目目录。否则产物不会被前端检测到。",
              "- **知识库（kb）**: 本地知识库索引了多个 Markdown 根目录（如 柬埔寨公交项目/义乌物流专题资料/_knowledge_base）。可用 kb_search 搜索、kb_read 读取全文。用户引用格式 `@知识库[路径@根目录名]`——例如 `@知识库[OD出行分析报告_完整版.md@柬埔寨公交项目]`，分析知识库内容时优先调用这两个工具，不要靠猜测。",
              "- **地图（GIS）**: 地图项目位于 `当前工作区/maps/{project}/`（默认项目 zhejiang-map 浙江省交通地图，含高速公路/国省道/农村公路/收费站/枢纽/市县边界图层，矢量瓦片 + MapLibre 渲染）。用户在地图模式下对话时：用 map_read 查看项目状态与图层清单；用 map_edit 修改样式（图层显隐/颜色/线宽/透明度/顺序/新增图层），修改会实时反映到前端地图；用 map_import 把工作区里的 GeoJSON 导入为新图层（自动生成瓦片）。也可直接读写 style.json / map.config.json / layers/*.geojson（相对 maps/{project}/）。若改了 layers/*.geojson 数据，可运行 `node scripts/build-vector-tiles.mjs --layer=<图层名>` 重建瓦片（在项目根目录 `" + PROJECT_DIR + "` 下执行）。底图源：carto/osm/dark/satellite。",
              "- **主动询问（重要）**: 当用户要求撰写/生成文字内容，但关键信息不明确（文档类型、格式、篇幅、受众、数据来源、风格、范围等）时，**必须调用 ask_user 工具主动提问**，等待用户回答后再继续，不要猜测。每次只问一个最关键的、阻塞后续工作的问题。",
              "- **模板引用（@模板）**: 用户以 `@模板[文件名]` 引用模板库中的模板（如 `@模板[01_年度工作报告模板.md]`）时，先用 find 工具在 `templates/` 与 `_报告模板/` 目录下搜索该文件名（注意文件名可能带序号前缀，用文件名包含匹配），找到后用 read 读取全文，作为撰写文档的结构与风格参考；产出保存到当前工作区（见 .agent-context.md）。用户以 `@模板目录[相对路径]` 引用整个模板目录时（如 `@模板目录[templates/opendesign/templates/html-ppt-tech-sharing]`），用 find 列出该目录下所有文件并逐个 read 理解其风格与结构，产出时保持该风格。",
              "- **规划素材库（traffic-material）**: 项目 `templates/traffic-material/` 内置 14 份交通规划详版模板（00_总览通用规范、01_年度工作报告、02_五年发展规划、03_规划文本条文式、04_工程可行性研究报告、05_线位论证预可、06_选址用地预审、07_交通影响评价、08_汇报材料、09_物流园区规划、10_规划研究报告、11_PPT汇报、12_素材库深挖）。用户要求撰写交通规划/工可/汇报/年度报告等文档时，**先用 read 工具读取对应模板作为结构参考**（如 04_工程可行性研究报告模板.md、08_汇报材料模板.md），产出保存到当前工作区。完整列表可用 GET /api/templates?category=sucaiku 查看。",
              "- **模板库（OpenDesign HTML PPT）**: 项目 `templates/opendesign/` 内置 157 个 HTML 模板（64 款 html-ppt-* 演示风格 + landing/dashboard 等），每个模板目录含 example.html 首页可直接预览（模版库页面已接入）。用户要求生成 PPT/演示/海报/网页作品时，优先用 read 工具读取 `templates/opendesign/<模板名>/example.html` 作为风格与结构参考（如 html-ppt-zhangzara-studio、html-ppt-tech-sharing、html-ppt-pitch-deck、html-ppt-taste-editorial），产出应保存到当前工作区。另项目 `.claude/skills/` 内置了 67 个办公/设计/飞书/工程流程技能（docx/pptx/xlsx/baoyu-*/lark-*/ultimate-ppt-master 等），需要对应能力时遵循其 SKILL.md 指引。",
              "- When you modify a document, confirm what changed. Files are auto-refreshed in the browser.",
              "",
              // 工作区记忆（AGENTS.md + memory/）——每次对话前刷新在 .agent-context.md 的「工作区记忆」段
              "- **工作区记忆**: 每次任务开始前阅读 `.agent-context.md` 中的「工作区记忆」段（含 AGENTS.md 准则与 memory/*.md）；沉淀新经验请用 memory_update 工具（自动写入当前工作区 memory/MEMORY.md），勿直接写文件。",
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

    const contextReadTool = defineTool({
      name: "context_read",
      label: "读取引用上下文",
      description: "读取用户本轮通过 @ 引用的文件、目录或外部文件。先使用引用 ID；可选 query 做行过滤，range 可传 startLine/endLine。不要猜测未解析的引用内容。",
      parameters: Type.Object({
        refId: Type.String({ description: "引用 ID，例如 ref_a1b2c3d4e5f6" }),
        query: Type.Optional(Type.String({ description: "可选关键词，只返回包含该词的行" })),
        range: Type.Optional(Type.Object({ startLine: Type.Optional(Type.Number()), endLine: Type.Optional(Type.Number()) })),
      }),
      execute: async (_toolCallId, params) => {
        const refs = entry.references || [];
        const ref = refs.find((r) => r.id === params.refId);
        if (!ref) return { content: [{ type: "text", text: `未找到引用 ${params.refId}。当前引用：\n${contextSummary(refs) || "（无）"}` }], details: {} };
        const result = await readReference(ref, params.query, params.range);
        return { content: [{ type: "text", text: result.status === "resolved" ? `引用 ${result.id}（${result.metadata.relativePath}）：\n${result.text}` : `${result.id}: ${result.message || result.status}` }], details: { reference: result } };
      },
    });

    // ---- 地图（GIS）工具 ----
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

    // ---- 记忆工具（agent 完成任务后自主沉淀经验/偏好） ----
    const memoryUpdateTool = defineTool({
      name: "memory_update",
      label: "记忆更新",
      description:
        "提出一条可确认的长期记忆建议。默认不会直接写入；用户确认后由界面批准。section 取值：项目信息 / 用户偏好 / 经验教训。每条控制在 100 字以内。",
      parameters: Type.Object({
        section: Type.Union([
          Type.Literal("项目信息"),
          Type.Literal("用户偏好"),
          Type.Literal("经验教训"),
        ]),
        content: Type.String({ description: "要记住的内容（≤100 字）" }),
        approved: Type.Optional(Type.Boolean({ description: "仅在用户明确确认后传 true" })),
      }),
      execute: async (_toolCallId, params) => {
        if (!params.approved) {
          const proposal = createMemoryProposal(clientId, params.section, params.content);
          emitChannelSafe(entry, "memory_proposal", { proposal });
          return { content: [{ type: "text", text: `已生成记忆建议（${proposal.id}），等待用户确认后写入。` }], details: { proposal } };
        }
        const r = writeMemorySection(params.section, params.content);
        return {
          content: [{ type: "text", text: `已更新记忆（${params.section}），后续任务会自动读取。${r.ok ? "" : "写入失败"}` }],
          details: { ...r },
        };
      },
    });

    // ---- 询问用户（ask_user）：任务要求不明确时主动提问，等待用户回答后继续 ----
    const askUserTool = defineTool({
      name: "ask_user",
      label: "询问用户",
      description:
        "当用户要求不明确、任务关键信息缺失（文档类型/格式/篇幅/受众/数据来源/风格/范围等）时调用，向用户提出具体问题并等待回答，避免盲目猜测。每次只问一个最关键的、阻塞后续工作的问题，可提供快捷选项。用户回答后继续执行。",
      parameters: Type.Object({
        question: Type.String({ description: "向用户提出的问题（具体、聚焦、一次一个）" }),
        // 兼容两种传法：字符串数组（推荐）或对象数组 {label, description}
        options: Type.Optional(Type.Array(Type.Union([
          Type.String({ description: "快捷选项文本" }),
          Type.Object({ label: Type.String(), description: Type.Optional(Type.String()) }),
        ]))),
      }),
      execute: async (_toolCallId, params) => {
        // 归一化 options（对象 → 字符串）
        const opts = (params.options || []).map((o) => (typeof o === "string" ? o : o.label || JSON.stringify(o)));
        // 阻塞等待用户回答（最长 5 分钟），期间 SSE 推送 ask_user 事件
        return await new Promise((resolve) => {
          persistPendingAsk({
            id: `ask_${crypto.randomUUID()}`,
            clientId,
            runId: entry.activeRunId || null,
            question: String(params.question || ""),
            options: opts,
            status: "pending",
            createdAt: new Date().toISOString(),
          });
          const timer = setTimeout(() => {
            this.pendingAsks.delete(clientId);
            resolvePendingAsk(clientId, null, "expired");
            resolve({
              content: [{ type: "text", text: "(用户未在 5 分钟内回答，请按专业判断继续，并在最终结果中注明你的假设)" }],
            });
          }, 300000);
          const done = (answer) => {
            clearTimeout(timer);
            resolvePendingAsk(clientId, String(answer || ""), "answered");
            resolve({ content: [{ type: "text", text: `用户回答：${answer}` }] });
          };
          this.pendingAsks.set(clientId, done);
          emitChannelSafe(entry, "ask_user", { question: params.question, options: opts });
        });
      },
    });

    const sessionManager = options.sessionPath
      ? SessionManager.open(options.sessionPath, SESSION_STORE, options.cwd || getWorkspace())
      : SessionManager.create(options.cwd || getWorkspace(), SESSION_STORE);
    const { session } = await createAgentSession({
      cwd: PROJECT_DIR,
      agentDir: AGENT_DIR,
      modelRuntime,
      resourceLoader: loader,
      customTools: [askUserTool, officeTool, kbSearchTool, kbReadTool, contextReadTool, mapReadTool, mapEditTool, mapImportTool, memoryUpdateTool],
      tools: ["read", "bash", "grep", "find", "ls", "write", "edit", "officecli", "ask_user", "kb_search", "kb_read", "context_read", "map_read", "map_edit", "map_import", "memory_update"],
      sessionManager,
    });
    // 显式激活全部自定义工具（pi SDK 仅激活 tools 白名单中的工具，customTools 需手动激活，
    // 否则 kb_search/map_read/ask_user 等对模型不可见）
    try {
      session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), "ask_user", "officecli", "kb_search", "kb_read", "context_read", "map_read", "map_edit", "map_import", "memory_update"])]);
    } catch {}

    const emitter = new EventEmitter();
    // event channel with history for SSE replay
    const channel = { history: [], seq: 0, emitter: new EventEmitter() };
    const emit = (type, data) => {
      const id = ++channel.seq;
      const ev = { id, type, data: data ?? {} };
      channel.history.push(ev);
      if (channel.history.length > 2000) channel.history.shift();
      channel.emitter.emit("event", ev);
      if (entry?.activeRunId && ["tool_start", "tool_end", "ask_user", "agent_error", "agent_end"].includes(type)) {
        try { recordRunEvent(entry.activeRunId, type, data || {}); } catch {}
      }
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

    entry = { session, channel, busy: false, loader, clientId, references: [], threadId: options.threadId || null, currentFile: null, activeRunId: null, task: null };
    this.sessions.set(clientId, entry);
    return entry;
  }

  /** Run a prompt. Events stream to entry.emitter; resolves on completion. */
  async prompt(clientId, text, images = [], effort) {
    const entry = await this.getOrCreate(clientId);
    return this._promptEntry(entry, text, images, effort, []);
  }

  async promptWithContext(clientId, text, images = [], effort, references = [], runContext = null) {
    const entry = await this.getOrCreate(clientId);
    return this._promptEntry(entry, text, images, effort, references, runContext);
  }

  async _promptEntry(entry, text, images = [], effort, references = [], runContext = null) {
    const isStreaming = entry.busy;
    entry.busy = true;
    entry.references = Array.isArray(references) ? references : [];
    entry.activeRunId = runContext?.runId || null;
    entry.task = runContext?.task || null;
    try {
      // 每次对话前刷新 agent 上下文（工作区记忆/当前文件变更即时生效）
      try { await entry.loader.reload(); } catch {}
      // 刷新 .agent-context.md（当前工作区路径/记忆/当前文件动态注入）
      this.writeContextFile(entry.currentFile);
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
      // 每次对话前注入动态上下文（当前工作区绝对路径 + 记忆摘要）——直接进 prompt 文本，
      // 不依赖 agent 主动 read .agent-context.md（agentsFiles 注入的是会话创建时的静态快照，会过时）
      try {
        const dyn = this.buildDynamicContext(entry.currentFile);
        if (dyn) text = dyn + "\n\n" + text;
      } catch {}
      const recoveredAnswers = consumeRecoveredAnswers(entry.clientId || "");
      if (recoveredAnswers.length) {
        text = `## 恢复的用户回答\n${recoveredAnswers.map((a) => `- ${a.question}: ${a.answer}`).join("\n")}\n请把这些回答视为对上次中断提问的确认，并继续原任务。\n\n${text}`;
      }
      if (entry.references.length) {
        text = `## 本轮结构化引用\n${contextSummary(entry.references)}\n请使用 context_read(refId) 按需读取引用内容；若状态为 missing/deferred，应明确告诉用户。\n\n${text}`;
      }
      if (entry.task) text = `${taskSummary(entry.task)}\n\n${text}`;
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
      entry.activeRunId = null;
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

  async newThread(clientId, threadId, cwd = getWorkspace()) {
    const old = this.sessions.get(clientId);
    if (old) {
      try { old.session.dispose(); } catch {}
      this.sessions.delete(clientId);
    }
    const entry = await this._create(clientId, { cwd, threadId });
    return { ok: true, threadId, sessionId: entry.session.sessionId, cwd };
  }

  async resumeThread(clientId, threadId, sessionPath, cwd = getWorkspace()) {
    const old = this.sessions.get(clientId);
    if (old) {
      try { old.session.dispose(); } catch {}
      this.sessions.delete(clientId);
    }
    const entry = await this._create(clientId, { cwd, sessionPath, threadId });
    return { ok: true, threadId, sessionId: entry.session.sessionId, cwd };
  }

  /** 记录当前工作文件，并同步到 agent 上下文（agent 通过读 .agent-context.md 感知）。 */
  /**
   * 构建每次对话前注入的动态上下文文本（当前工作区绝对路径 + 当前文件 + 记忆摘要）
   */
  buildDynamicContext(file) {
    try {
      const ws = getWorkspace();
      const memCtx = readMemoryContext();
      const lines = [
        "[动态上下文]",
        `- 当前工作区（绝对路径）: ${ws}`,
        "- Office 文档一律用 officecli 工具操作（文件名相对当前工作区根目录）；若 officecli 不可用，用 read 工具以绝对路径读取工作区文件（docx 可用服务端接口 GET /api/doc/<文件名>/text 提取文本）。",
        `- 当前工作文件: ${file || "（无）"}`,
        "- 新建文件必须写入当前工作区绝对路径，禁止写入项目目录。",
        "- 任务完成时必须按‘读取来源 / 修改文件 / 产物 / 假设 / 下一步’五项给出简短总结；引用缺失或未读取时必须明确说明。",
      ];
      if (memCtx) lines.push("- 工作区记忆（AGENTS.md + memory/*.md）:\n" + memCtx.slice(0, 2000));
      return lines.join("\n");
    } catch {
      return "";
    }
  }

  /**
   * 写入 .agent-context.md（项目根，agent 的 read cwd 可读）——每次对话前刷新：
   * 当前工作区路径（跟随 setWorkspace 动态变化）+ 当前工作文件 + 工作区记忆摘要
   */
  writeContextFile(file) {
    try {
      const ws = getWorkspace();
      const memCtx = readMemoryContext();
      const ctx = [
        "# Open Plan（规聚）Workspace",
        "",
        `- **当前工作区（绝对路径）**: ${ws}`,
        "- Office files live in the current workspace folder above. ALWAYS operate on office documents through the `officecli` tool — it resolves file names relative to the current workspace. NEVER try to run `officecli` via the bash tool.",
        "- The bash tool may run inside WSL: Windows paths like `F:\\...` are not directly valid there; prefer the officecli tool for documents and `read`/`write` for text.",
        "- **写文件规范**: 创建任何新文件（HTML/文档/图表等）时，必须写入当前工作区（绝对路径见上），禁止写入项目目录。否则产物不会被前端检测到。",
        "- **地图（GIS）**: 地图项目位于 `" + ws + "/maps/{project}/`（默认项目 zhejiang-map 浙江省交通地图）。用户在地图模式下对话时用 map_read/map_edit/map_import 工具。",
        "",
        "## 当前工作文件（用户正在查看/编辑的文档）",
        file ? `- 当前工作文件: ${file}` : "- 当前没有打开文档",
        file
          ? "- 用户的操作默认针对此文件。修改它时直接用 officecli 操作（文件名相对工作区根目录，含子目录路径）。完成后告知用户已修改。"
          : "- 如果用户提到要修改某个文档，先用 officecli view 确认内容再操作。",
        "",
        memCtx ? "## 工作区记忆（每次任务开始前阅读；沉淀新经验请用 memory_update 工具，勿直接写文件）\n" + memCtx : "",
        "",
        "- When the user asks to modify a document, make the changes, then confirm what changed. Files are auto-refreshed in the browser.",
      ].join("\n");
      fs.writeFileSync(path.join(PROJECT_DIR, ".agent-context.md"), ctx, "utf8");
    } catch {}
  }

  async setCurrentFile(clientId, file) {
    let entry = this.sessions.get(clientId);
    if (!entry) entry = await this.getOrCreate(clientId);
    entry.currentFile = file || null;
    this.writeContextFile(entry.currentFile);
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

  /** 重新扫描模型：重置 ModelRuntime 缓存并重新构建（模型配置变更后调用） */
  async refreshModels() {
    this.modelRuntimePromise = null;
    const mr = await this.modelRuntime();
    try {
      await mr.refresh({ allowNetwork: false });
    } catch {}
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
// ===== API Key 管理（auth.json，pi 原生格式） =====
function authFilePath() {
  return path.join(AGENT_DIR, "auth.json");
}

/** 读取全部 provider key（掩码展示用） */
export function listAuth() {
  try {
    return JSON.parse(fs.readFileSync(authFilePath(), "utf8"));
  } catch {
    return {};
  }
}

/** 保存/更新 provider 的 API Key（写 auth.json + 运行时注入） */
export async function setApiKey(provider, key) {
  const auth = listAuth();
  auth[provider] = { type: "api_key", key: String(key).trim() };
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  fs.writeFileSync(authFilePath(), JSON.stringify(auth, null, 2));
  try {
    const mr = await agentManager.modelRuntime();
    await mr.setRuntimeApiKey(provider, String(key).trim(), { allowNetwork: false });
  } catch { /* 运行时注入失败不阻断保存 */ }
  return { ok: true, providers: Object.keys(auth) };
}

/** 删除 provider 的 API Key */
export async function removeApiKey(provider) {
  const auth = listAuth();
  if (auth[provider]) delete auth[provider];
  fs.writeFileSync(authFilePath(), JSON.stringify(auth, null, 2));
  return { ok: true, providers: Object.keys(auth) };
}

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
