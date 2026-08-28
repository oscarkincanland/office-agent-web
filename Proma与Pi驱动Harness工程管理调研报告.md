# Proma 与 Pi 驱动 Harness 工程管理调研报告

**调研对象**：`office-agent-web`（Open Plan / 规聚 Web 工作台）及公开项目 [Proma](https://github.com/proma-ai/Proma)

**调研时间**：2026-08-28

**调研性质**：本地代码静态审计 + Proma 开源代码结构对照 + Pi 官方 SDK / 模型配置文档研究

**结论先行**：你的项目已经具备一个“面向 Office、知识库和 GIS 的 Pi Agent 工作台”雏形，真正有差异化的地方不是再做一个通用聊天框，而是把它升级成“面向规划生产的 Harness”：围绕一次任务，把会话、运行过程、文件变化、模型、权限、验证和最终工作产物固定成一条可追溯链路。

Proma 最值得借鉴的是它对 Chat、Agent、会话、工作区、事件和运行时的分层；不建议直接照搬它的界面，也不建议现在修改 Pi 源码。更稳妥的方向是：在 Pi 外面增加一层 `PiRuntimeManager + Harness 控制平面`，将 Pi 作为可替换的 Agent Runtime。这样后期完全可以管理 Pi 的会话、模型、工具、资源、队列和运行状态，同时把 Pi 本身不负责的安全、权限、产物、任务恢复和工程验证放到你的 Harness 层解决。

---

## 一、调研范围与证据边界

### 1.1 项目识别

当前工作目录下没有名为 `proma` 的本地目录。本次将 `F:\Claude code本地文件\office-agent-web` 作为被审计项目，因为它的 [README.md](<F:/Claude code本地文件/office-agent-web/README.md>) 明确写明：前端设计参考 Proma 与 SiYuan，并且当前使用 Pi Agent SDK。

因此，本报告中的“你的项目”均指 `office-agent-web`；Proma 指公开的 [proma-ai/Proma](https://github.com/proma-ai/Proma)。如果你指的是其他本地目录，后续可以再按实际目录重新核对。

### 1.2 已覆盖的范围

本次审计覆盖以下方面：

- 对话流：消息发送、流式输出、思考块、工具块、追问、排队、重试、中止、压缩和恢复。
- 会话管理：会话列表、命名、置顶、删除、分支、恢复、历史重建、会话与工作区关系。
- 文件与工作区：工作区切换、文件树、外部目录、Office 文件、知识库、地图和文件变更。
- 事件流：SSE、事件类型、重连、内存回放、事件与 Run 的关系、前端消费方式。
- 前端：三栏布局、Chat/Agent 模式、任务中心、产物入口、Proma 风格交互、状态组织和可访问性。
- 底层架构：Express、Pi SDK、JSONL、Run manifest、快照、回滚、内存、工具注册和并发。
- 模型配置：Pi provider/model catalog、模型选择、刷新、API Key 和 thinking level。
- Harness 工程管理：任务控制、权限、队列、产物、验证、可观测性和运行时治理。
- Pi 内核管理边界：哪些可以通过 SDK 管理，哪些必须由应用层、Host 或 Sidecar 完成。

### 1.3 证据限制

- 本次以代码阅读和公开资料对照为主，没有改动业务代码。
- 没有启动开发服务，也没有执行最终 `npm.cmd run verify`；因此文中静态发现需要在运行时回归测试中确认。
- 当前工作树本身已有较多修改、删除和未提交内容，本报告不将这些变化归因于本次调研。
- Proma 的 README 和部分依赖版本可能随上游变化，涉及实现细节时应以对应源码链接和当前分支为准。

---

## 二、现有项目的总体判断

### 2.1 现在的产品定位

你的项目不是单纯的“Pi Web UI”，而是一个具有明确领域能力的工作台：

```text
规划/办公工作台
├─ 文件管理与 Office 文档预览/编辑
├─ Pi Agent 对话与工具调用
├─ 本地知识库、双向链接、图谱
├─ MapLibre 地图与 GIS 分析
├─ 模板库、记忆、工作区
└─ Run 快照、文件差异、回滚和任务中心
```

这个定位是合理的。与 Proma 相比，你的优势在 Office、地图、知识库和规划生产；与普通 Agent UI 相比，你已经开始记录任务、文件和产物。真正的短板是这些能力还没有被统一成一个强一致的工程对象模型。

### 2.2 现状强项

| 领域 | 已有基础 | 判断 |
|---|---|---|
| 领域工作台 | Office + KB + GIS + 模板 + 记忆 | 这是最重要的差异化资产 |
| Pi 接入 | `createAgentSession`、`ModelRuntime`、`SessionManager`、自定义工具 | 足以构建自己的 Runtime 控制层 |
| 对话表现 | 思考块、工具卡、最终回复、追问、任务卡、流式输出 | 已经超过普通聊天 UI |
| 任务追踪 | TaskEnvelope、Run manifest、前后快照、差异、部分回滚 | 具备 Harness 雏形 |
| 本地优先 | JSONL、本地工作区、文件系统、项目内运行记录 | 适合规划资料和离线场景 |
| 前端骨架 | 左会话/文件，中工作区，右对话；地图复用 ChatPanel | 产品结构清楚，具有延展性 |

### 2.3 当前最关键的结构性问题

当前不是“功能少”，而是“同一件事情有多个事实来源”：

| 对象 | 当前事实来源 | 主要问题 |
|---|---|---|
| 会话 | Pi JSONL、工作台会话目录、前端状态、localStorage | 会话元数据、分支和 UI 状态没有统一模型 |
| 工作区 | 后端全局 `currentWorkspace`、前端状态、Pi `cwd` | Pi 内置文件工具与自定义工具可能写入不同目录 |
| 运行 | AgentManager 状态、SSE、`.oaw/runs` | 运行过程部分持久化，不能稳定恢复和重放 |
| 产物 | 当前工作区文件列表、Run artifacts | 产物入口并不总是来自 Run manifest，来源关系不够可信 |
| 模式 | ChatPanel 的 `office/agent` 前缀和 UI 状态 | 目前更像提示词模式，而不是能力边界模式 |
| 事件 | 内存事件历史、JSONL、前端消息数组 | 缺少统一协议、幂等键和全局事件接收层 |

建议把核心关系收敛成：

```text
Conversation（对话）
    └─ Run（一次执行）
         ├─ Event Timeline（完整事件时间线）
         ├─ Workspace Snapshot（执行前后快照）
         ├─ Artifact（可交付产物）
         └─ Verification（验证结果）
```

这会是你从“Agent 工作台”升级为“Harness 工程管理系统”的核心转折。

---

## 三、按能力域审计现状

## 3.1 对话流

### 当前实现

后端 `AgentManager` 以 `clientId::threadId` 作为运行实例键，每个实例维护 busy、activeRunId、当前文件和任务状态；前端 [ChatPanel.jsx](<F:/Claude code本地文件/office-agent-web/client/src/components/ChatPanel.jsx>) 通过 SSE 接收 token、thinking、tool_start、tool_output、tool_end、assistant_final、agent_end、agent_error、file_changed、agent_summary 和 run_finished 等事件。

发送请求时，前端会携带文本、图片、附件、引用、模型、thinking level、任务模式和工作流；忙碌时可以注入上下文或排队，后端在特定条件下使用 steer、重试或等待当前运行结束。这个设计已经有 Agent 交互的基本骨架。

### 做得好的地方

- 将 thinking、工具执行和最终答复拆成独立块，适合长任务审阅。
- 具备 `ask_user`，不是把所有不确定性都交给模型自行猜测。
- 有 abort、compact、retry、steer 和队列，说明你已经考虑了真实运行时竞争。
- 通过 TaskEnvelope 对任务目标、上下文、引用、产出和验收进行结构化约束。
- 地图模式复用同一个 ChatPanel，避免 Office、地图和 Agent 各自维护一套对话协议。

### 需要修正的地方

1. **工具流的前端归属不稳定**：实时 `tool_output/tool_end` 主要按“最后一个工具块”更新，而不是始终按 `toolCallId` 定位。并发或延迟事件到达时，工具结果可能写入错误卡片。
2. **SSE 仍是内存优先**：有内存回放和 `Last-Event-ID`，但不是完整的持久化事件日志；没有统一的幂等语义、bootId、心跳和客户端确认。
3. **重连后的状态恢复不完整**：token、工具块、任务状态和最终产物没有通过同一套事件投影重建，前端消息数组和后端运行状态可能出现偏差。
4. **模式切换不是能力切换**：Office/创作模式和 Agent 模式目前主要靠提示词告诉 Pi“优先使用 officecli”或“可以使用所有工具”，不是工具级权限隔离。
5. **运行仍与 HTTP 请求生命周期绑定**：服务进程中断后，任务状态、队列和未完成工具调用难以自动恢复。

### 推荐的事件封装

建议所有前端可见和工程可审计事件都使用统一信封：

```json
{
  "protocolVersion": 1,
  "eventId": "evt_xxx",
  "bootId": "boot_xxx",
  "sequence": 128,
  "sessionId": "session_xxx",
  "threadId": "thread_xxx",
  "runId": "run_xxx",
  "turnId": "turn_xxx",
  "toolCallId": "tool_xxx",
  "type": "tool_output",
  "status": "streaming",
  "replayable": true,
  "timestamp": "2026-08-28T00:00:00.000Z",
  "payload": {}
}
```

其中 `eventId` 解决重复接收，`sequence` 解决顺序，`bootId` 解决服务重启，`runId/turnId/toolCallId` 解决归属，`replayable` 解决哪些事件可以重新投影。这个协议是 Harness 的地基。

---

## 3.2 文件管理与工作区

### 当前实现

项目已经有文件树、上传、删除、搜索、子目录、下载、Office 文档查看、工作区切换、外部文件根、知识库导入和文件变化通知。`workspace.mjs` 有路径解析、真实路径和工作区边界控制；Run 系统会在任务前后扫描工作区并计算新增、删除、修改和重命名文件。

### 关键风险

#### A. Pi `cwd` 与当前工作区不一致

`createAgentSession` 使用项目根作为 `cwd`，而 `SessionManager` 和自定义工具大量使用后端当前工作区。结果可能是：

- Pi 内置 `read/write/edit/bash` 看到的是项目根。
- `officecli`、KB、地图和部分自定义工具看到的是用户选定工作区。
- 提示词虽然要求“把文件写入当前工作区”，但提示词不是安全边界。

这是当前最优先修复的问题，因为它同时影响数据正确性、安全性、产物统计和用户信任。

#### B. 当前工作区是进程级全局状态

多个会话或多个浏览器标签共享一个 `currentWorkspace`。切换工作区时，一个会话可能还在执行另一个工作区的任务。工作区应当至少绑定到 `workspaceId`，并在 Run 开始时冻结成 `workspaceSnapshot.root`，不能只依赖实时全局变量。

#### C. 路径边界并不完全统一

普通文件 API 的路径解析相对完整，但地图导入、知识库 DOCX 导入、记忆路径和技能导入存在不同程度的独立拼接或弱校验。建议所有文件相关能力只调用一个 `WorkspaceBroker.resolve()`，统一处理绝对路径、`..`、realpath、符号链接、外部根和读写权限。

### Harness 化建议

把工作区从一个字符串升级为对象：

```json
{
  "workspaceId": "ws_xxx",
  "name": "水运规划项目",
  "slug": "shuiyun-guihua",
  "rootPath": "F:/水运规划项目",
  "status": "available",
  "allowedRoots": [],
  "attachedDirectories": [],
  "attachedFiles": [],
  "skills": [],
  "memoryPolicy": "approval_required",
  "createdAt": "...",
  "updatedAt": "..."
}
```

每个 Conversation、Run、Artifact 都只保存 `workspaceId` 和执行时的根目录快照，避免任务执行中被用户切换工作区影响。

---

## 3.3 会话管理与“固定化”

这是你新增要求中最值得单独抽出来的部分。会话固定化不能只理解为“左侧置顶”，至少要分成四层。

### 当前已有能力

- 会话 JSONL 持久化。
- 左侧列表、搜索、置顶、重命名、删除。
- 历史消息重建。
- 会话恢复。
- Fork 入口。
- Run 与会话有关联。
- 前端 localStorage 保存部分界面状态。

### 当前不足

1. **置顶是 UI 行为，不是工程固定**：置顶存于 localStorage，换设备或换前端实例不一定保留，也不能表达“固定上下文”和“固定成果”。
2. **Fork 不是 Pi 原生分支**：当前主要是复制 JSONL、改 header id/parentSessionId，不能完整继承 Pi 的 entry binding、分支点和工作台文件语义。
3. **会话、执行和产物没有独立生命周期**：一个会话可以有多个 Run，一个 Run 可以生成多个产物，但当前界面经常把当前文件列表当成产物列表。
4. **恢复路径需加强文件校验**：Pi 的 `SessionManager.open()` 必须拿到具体 JSONL 文件，不能拿到 `.规聚会话` 目录或失效路径。恢复前应显式检查 `exists + stat.isFile()`，并覆盖目录、合法文件、缺失文件三类测试。
5. **会话列表存在工作目录过滤风险**：如果只按项目目录或旧 Pi cwd 过滤，外部工作区会话可能无法显示。

### 建议的固定化模型

| 固定化层级 | 用户看到的动作 | 系统应保存什么 |
|---|---|---|
| 置顶 | 固定在侧栏 | `pinnedAt`、排序和跨端持久化状态 |
| 会话快照 | 固定一个可复现的对话状态 | 消息入口、模型、thinking、工具清单、上下文引用、工作区版本 |
| Run 快照 | 固定一次执行过程 | 事件日志、前后文件快照、权限决定、验证结果、错误和耗时 |
| 产物发布 | 固定工作成果 | 文件 hash、来源 Run、版本、预览、审批状态、回滚点 |
| 分支 | 从某条消息继续另一个方向 | 原生 Pi branch entry、父子关系、分支工作区或 worktree |

建议增加一个“固定为工作成果”的动作，而不是只有“置顶会话”：

```text
对话消息 / 工具调用
        ↓
选择一次 Run 或一个文件
        ↓
生成 Artifact 记录
        ↓
预览、命名、标记版本、审批
        ↓
发布到工作区成果区 / 导出 / 继续编辑
```

Artifact 最少应包含：`artifactId、runId、sessionId、workspaceId、path、mime、title、hash、size、status、preview、createdAt、reversible、publishedAt`。这样“产物”才不再是当前目录里恰好存在的文件，而是有来源、可追溯、可回滚的工作成果。

---

## 3.4 事件流与任务执行

### 当前实现

后端有事件历史上限、SSE、`Last-Event-ID` 回放和 Run event 记录；Run 系统位于 `.oaw/runs`，会记录开始时间、任务信息、前后快照、步骤、事件、差异、产物和部分 blob。

### 当前优势

- 已经有“执行前快照—执行—执行后扫描—差异”的工程闭环雏形。
- 能识别新增、修改、删除和重命名文件。
- 小文件支持可逆存储和回滚。
- 任务中心可以看到运行状态、步骤、事件和产物数量。

### 当前不足

- 任务中心基本是轮询观察面板，没有暂停、继续、取消、重试、回滚、重新执行等控制动作。
- `rollback` 主要是文件复制/删除，不会自动创建一条新的 Run 或回滚事件；审计上难以说明“谁在什么时候撤销了什么”。
- 超过 blob 大小上限或快照总量上限的文件无法完整恢复。
- Run 仍是同步 HTTP 请求中的执行，不是可恢复的持久化 Job。
- 事件和 Run 状态没有统一状态机，例如 `waiting_user、cancel_requested、recovering` 等中间态不够清晰。

### 推荐的 Run 状态机

```text
queued → running → waiting_user → running
             │          │
             │          └→ cancelled / failed
             ├→ cancel_requested → cancelled
             ├→ completed
             └→ recovering → running / failed
```

Harness 的任务中心应该是“控制中心”，至少提供：

- 查看当前步骤和工具调用。
- 查看待审批权限和待回答问题。
- 暂停/取消/继续。
- 从失败步骤重试，而不是整轮盲目重放。
- 查看文件差异和产物来源。
- 回滚并产生新的审计 Run。
- 复制 Run 为新任务，保留上下文但不重复副作用。

---

## 3.5 前端设计与交互

### 值得保留的设计

当前“左侧会话与文件—中间工作区—右侧对话”的骨架非常适合你的场景。它把对话放在生产资料旁边，而不是让用户在聊天和文件之间来回跳转。地图模式继续复用 ChatPanel，也保持了上下文连续性。

可以继续保留和强化：

- Proma 式无气泡长回答、思考块、工具块和动作条。
- 左侧会话、文件、产物入口。
- 中间 Office、Markdown、模板和 GIS 画布。
- 右侧对话、任务卡、审批卡和 Run 状态。
- 针对规划工作的 Office/GIS/KB 专用动作，而不是只做通用 AI 对话。

### 前端问题

- `App.jsx` 承担过多全局编排，文件、会话、工作区、地图、模型、Run、模式和弹窗状态集中在一个组件中，后续接入持久化事件和后台任务会越来越难。
- ChatPanel 的 SSE effect 使用的回调存在旧闭包风险，文件、地图和完成回调可能不是最新版本。
- 实时工具事件按位置更新，和后端 `toolCallId` 没有完全贯通。
- Chat/Agent/KB/模板/地图由多个布尔值表示，可能出现多个全屏模式同时为真的状态；应改成单一 `activeWorkspaceMode` 状态机。
- 任务中心只有监控，不是控制中心。
- 产物弹窗列出当前工作区文件，而不是严格读取 Run manifest，用户无法确认文件由哪次任务生成。
- 命令面板点击结果后主要打开模块首页，没有把选中的会话、文件或 Run 直接定位过去。
- 部分交互使用 div + onClick，键盘焦点、回车、Esc 和屏幕阅读器语义不足。
- 固定宽度和 CSS 覆盖较多，窄窗口下三栏容易挤压；`styles.css` 已经很大，建议逐步建立组件级 token 和布局层。
- `DocViewer` 中 `showComments/setShowComments` 的静态引用需要优先运行验证，存在未定义状态导致运行时错误的可能。

### 推荐前端状态层

不一定要立刻引入复杂框架，但应按对象拆分状态：

```text
WorkspaceStore
SessionStore
RunStore
ArtifactStore
EventStore
ViewStore
```

高频 token、工具流和 Run 状态由全局事件监听器接入 Store，再由具体页面订阅当前 `sessionId/runId`。不要让每个 ChatPanel 自己订阅一遍 SSE，也不要让页面卸载导致后台 Agent 事件丢失。

---

## 3.6 底层架构与 Pi 接入

### 当前底层结构

- Node.js + Express 作为服务层。
- Pi SDK 提供 AgentSession、模型运行时、SessionManager、ResourceLoader 和工具机制。
- 自定义工具包括 Office、KB、地图、记忆和 ask_user。
- JSONL 保存会话，`.oaw/runs` 保存 Run。
- 动态上下文会注入工作区、当前文件、officecli、KB、地图、ask_user、todo 和记忆规则。
- `ModelRuntime` 合并 `auth.json`、`models.json` 和 `models-store.json`。

这个技术选择可以继续使用。当前更需要的是边界整理，而不是换内核。

### 应拆出的控制边界

当前 `AgentManager` 同时承担会话、模型、上下文、工具、事件、重试、记忆和 Run 关联，建议逐步拆成：

```text
Harness API
├─ PiRuntimeManager       Pi 生命周期和 SDK 适配
├─ ConversationManager    Chat 对话与历史
├─ AgentSessionManager    Agent 会话、恢复、分支
├─ RunManager              任务状态、队列、重试、恢复
├─ EventBus/EventLog       事件协议、持久化、重放
├─ WorkspaceBroker        路径、根目录、快照和文件权限
├─ PermissionService       工具审批和策略
├─ ArtifactManager         产物、版本、预览、发布、回滚
├─ ModelChannelManager     Provider、Key、模型能力、刷新
└─ VerificationManager     任务验收、脚本检查、回归评估
```

这不是要求一次性大重构，而是给后续代码放置一个正确的位置。第一步可以只是把这些对象定义成模块接口，内部仍然调用现有函数。

---

## 3.7 模型配置与 Provider 管理

### 当前实现

当前从 Pi 的本地配置读取 provider/model/auth，前端定时刷新模型目录，支持选择模型和 thinking level；后端也支持模型切换、刷新、设置 API Key 和本地缓存回退。

### 当前问题

- Provider、模型、凭据和 UI 选择状态混在一起，缺少一个明确的 Channel/Provider 层。
- `auth.json` 直接写入明文配置，桌面化或多用户化后风险很高。
- API Key 的设置、验证、刷新和失败回退没有统一的权限与审计入口。
- 模型是否支持图片、reasoning、上下文窗口、最大输出、费用和工具调用等能力，没有完整形成前端可消费的 capability contract。
- `AGENT_DIR` 默认路径是硬编码的 Windows 用户目录，应改为可配置的运行时目录，并支持临时目录测试。

### 建议模型对象

```json
{
  "channelId": "deepseek-main",
  "provider": "deepseek",
  "modelId": "deepseek-chat",
  "label": "DeepSeek Chat",
  "capabilities": {
    "vision": false,
    "reasoning": true,
    "toolCall": true,
    "stream": true,
    "contextWindow": 128000
  },
  "profiles": ["chat", "office-agent", "research-agent"],
  "status": "available",
  "credentialRef": "cred_xxx"
}
```

Pi 官方 `models.json` 的 provider/model 语义已经足够支撑自定义兼容接口、API 类型、base URL、header、模型能力、thinking level 映射和成本配置。你的 Harness 应该复用这套语义，而不是再发明一套完全不同的模型配置格式。

---

## 3.8 Chat 与 Agent 模式

### 当前判断

当前的 Office/创作模式与 Agent 模式共用同一个 Pi Agent Runtime、同一批工具和同一种会话，只是通过前缀、编辑模式和 UI 状态改变行为。因此它们是“提示词分流”，还不是“产品能力分流”。

### 推荐定义

| 模式 | 默认能力 | 是否允许副作用 | 适用任务 |
|---|---|---:|---|
| Chat | 读取上下文、解释、总结、问答、引用附件 | 否 | 快速问答、翻译、材料分析、方案讨论 |
| Agent | 读取、写入、执行工具、修改文档、生成成果 | 是，需策略/审批 | 生成报告、改文档、跑分析、整理资料 |
| Office Agent | Agent 的受限配置 | 仅允许 Office 工作区和 officecli | 文档校核、表格分析、PPT/Word 生成 |
| Research Agent | Agent 的研究配置 | 允许检索、KB、附件写入成果区 | 调研、资料整理、证据表和报告 |
| GIS Agent | Agent 的 GIS 配置 | 允许地图分析和空间成果写入 | 图层处理、空间分析、地图报告 |

实现上建议是：

- Chat 使用单独的 ConversationService 和只读工具注册表。
- Agent 使用 Pi AgentSession 和完整工具注册表。
- Office Agent / Research Agent / GIS Agent 是 Agent Profile，不再复制运行时。
- 每个 Profile 明确允许的工具、读写根目录、模型能力、审批策略、最大 Run 时长和产物目录。

这样用户切换模式时改变的是“能力合同”，而不仅是发送一段隐藏提示词。

---

## 四、Proma 最值得借鉴的内容

Proma 的借鉴重点不是颜色、圆角或某个组件，而是它把通用 Agent 产品拆成多个可以治理的服务。

### 4.1 ChatService 与 AgentOrchestrator 分离

Proma 对 Chat 有独立的 ConversationManager、消息 JSONL、Provider adapter、工具注册和上下文长度控制；Agent 则由 AgentOrchestrator、Pi adapter、SessionManager、权限服务和工作区管理器负责。

对你的价值：可以真正解决“Chat 只是问答，Agent 才能改文件”的边界问题，也能让 Office 对话不必承受完整 Agent 的复杂状态。

### 4.2 AgentEventBus + 全局监听器

Proma 的主进程通过 EventBus 发出有类型的 Agent 事件，渲染层在顶层挂全局监听器，把事件写入 Jotai atom families。页面切换不等于事件监听被销毁。

对你的价值：正好解决当前 ChatPanel 自己订阅 SSE、回调旧闭包、后台事件丢失和状态分散问题。

### 4.3 丰富的 AgentSessionManager

Proma 的会话元数据不仅有标题和 Pi session file，还包括 workspaceId、modelId、channelId、Pi entry binding、父子分支、根会话、工作区模式、附件、权限和 delegation 状态；分支使用 Pi 原生 `createBranchedSession(entryId)`，而不是简单复制 JSONL。

对你的价值：会话固定化、从任意消息分支、成果复现和多工作区关联都可以有真正的数据模型。

### 4.4 WorkspaceManager

Proma 为工作区建立稳定 ID、slug、项目根路径和 `available/missing/not_directory/unavailable` 状态，并管理 Skills、MCP、记忆、附件目录和 worktree。

对你的价值：你的工作区不能只是一条全局路径；规划项目尤其需要“资料根、成果根、附件根、临时分析根”和状态诊断。

### 4.5 PermissionService 与 AskUserService

Proma 将工具审批和用户追问做成主进程服务，用 pending request Map 保存等待项；即使渲染层刷新，也可以恢复待处理请求。

对你的价值：`ask_user`、Office 写入、bash、地图修改、记忆更新和外部文件访问都可以进入统一审批，而不是散落在工具代码和前端卡片中。

### 4.6 QueueCoordinator 与后台任务

Proma 把排队、取消、移动和去重放在主进程，渲染层只是投影。你的当前队列主要属于 ChatPanel，适合短期使用，但不适合后台长任务和多窗口。

### 4.7 WorkspaceWatcher 与文件变更归属

Proma 对工作区和附件目录做递归监听、去抖、自动修复和噪声过滤，并把变更关联到会话文件。你的 Run 快照已经有差异计算，可以在此基础上补充实时 watcher 和 Artifact attribution。

### 4.8 ChannelManager 与能力协商

Proma 将 provider、API key、OAuth、模型刷新、连接测试和可用能力集中管理；Pi 本身提供了模型配置和运行时能力，但不替你设计产品级 Channel 管理。

### 4.9 协议版本与 Runtime Host

Proma 使用带 protocolVersion、boot/status、requestId、sessionId、sequence 和 capability 的运行时协议，把 Agent Runtime 与 Electron UI 解耦。你将来从 Web 迁移到桌面端时，这比直接把 Pi 对象暴露给前端更稳。

### 4.10 许可证注意事项

Proma 仓库采用 AGPL-3.0。可以借鉴其架构思想、数据模型方向和公开 API 设计；如果直接复制源码、组件或形成衍生分发，需要先进行许可证合规评估。建议优先做独立实现，并保留清晰的来源记录。

---

## 五、你的项目适合做哪些 Harness 工程管理能力

这里按“收益高、与你已有能力贴合、实现风险可控”排序。

### 5.1 任务运行控制中心：最适合先做

把现在的任务中心从“运行列表”升级为 Run Console：

- 创建任务、选择 Profile、模型和工作区。
- 查看当前步骤、工具、耗时、token、费用和等待原因。
- 待审批项和待回答问题集中处理。
- 暂停、取消、继续、重试、复制 Run。
- 失败时从最后安全 checkpoint 继续。
- 查看文件 diff、产物、验证和回滚。

这是在现有 `runs.mjs`、SSE 和任务中心上增量实现，难度中等、产品收益很高。

### 5.2 规划工作流模板：最有领域差异化

利用现有 Office、KB、地图和模板能力做可复用 Harness Workflow：

```text
资料整理 → 知识库检索 → 数据/地图分析 → 草稿生成
       → Office 校验 → 人工审批 → 成果发布 → 生成证据清单
```

适合先做的模板：

- 调研报告生成：资料目录 + KB 检索 + 引用表 + Markdown/DOCX 成果。
- 规划材料审校：文档解析 + 结构/格式检查 + 修改建议 + 版本差异。
- GIS 分析报告：地图数据 + 空间分析 + 图表/地图截图 + 报告章节。
- 会议/项目资料归档：文件归类 + 摘要 + 标签 + 任务清单 + 知识库链接。
- 方案比选：多方案资料固定 + 指标表 + 差异分析 + 结论卡片。

每个 Workflow 应声明输入、步骤、允许工具、审批点、输出 Artifact 和验收脚本，而不是只保存一段 Prompt。

### 5.3 会话与工作成果固定化：最能提升长期使用价值

重点做四个动作：

1. 固定会话：跨刷新、跨工作区列表和设备状态保存。
2. 固定上下文：把引用文件、目录、模型、Profile 和规则冻结。
3. 固定 Run：保存事件、快照、权限决定和验证结果。
4. 固定成果：把文件发布成有版本和来源的 Artifact。

这会让用户能够说：“沿着上周这个会话和这次 Run，继续生成第二版”，而不是重新解释背景。

### 5.4 模型与能力路由：较容易形成实用价值

可以做模型 Profile，而不是只做模型下拉框：

- 快速 Chat：低延迟、只读、低成本。
- Office Agent：支持长上下文、文件工具和结构化输出。
- Research Agent：支持附件、知识库和长任务。
- GIS Agent：工具调用稳定、适合结构化 JSON 和空间分析。
- 高质量发布：更强模型 + 必须验证 + 必须人工确认。

模型选择时同时显示 vision、tool call、contextWindow、thinking、费用、可用状态和失败回退策略。

### 5.5 权限与安全 Harness：必须做，且可以逐步做

至少提供四种权限模式：

| 模式 | 允许范围 |
|---|---|
| 只读 | 读取工作区、KB、地图和附件，不写文件、不执行命令 |
| 受限编辑 | 只能写成果目录或当前文档，不能 bash，记忆需审批 |
| 项目编辑 | 可使用项目内工具和脚本，越界路径需审批 |
| 管理员 | 可扩展外部根和运行高风险工具，每次操作留痕 |

Pi 不是 Sandbox。内置 bash、write、edit 和未知 Skill/Extension 不能天然隔离，需要 WorkspaceBroker、PermissionService 和必要时的 Sidecar/独立进程。

### 5.6 Harness 评测与回归：容易被忽略，但非常适合你的领域

可以把规划生产任务做成固定评测集：

- 能否读取指定资料而不越界。
- 能否把成果写到正确工作区。
- Word/PPT/Excel 是否可打开、结构是否完整。
- 地图分析是否生成预期图层和统计字段。
- 工具调用失败后能否恢复。
- Chat 是否真的不能修改文件。
- 同一 Run 重放是否不产生重复副作用。
- 模型切换后成果质量、耗时、费用和错误率。

Harness 的价值最终应由“可复现、可验收、可回归”证明，而不是由聊天演示证明。

---

## 六、哪些内容现在适合做，哪些应暂缓

| 能力 | 近期可做性 | 建议 |
|---|---:|---|
| 统一事件协议和前端全局监听 | 高 | 立即做，是所有后台能力的基础 |
| Artifact manifest、来源和发布 | 高 | 在现有 Run 快照上增量增加 |
| Run 控制：取消、重试、回滚审计 | 中高 | 先改任务中心和后端状态机 |
| Chat/Agent 工具权限分离 | 中高 | 可先用两套工具注册表，不必换 Pi |
| 工作区对象和 cwd 统一 | 中高 | 优先级最高，先解决数据边界 |
| 模型 Profile、能力和回退 | 高 | 复用 Pi catalog，增加 Harness 层 |
| 会话固定、上下文快照 | 中高 | 先做元数据，再做原生分支 |
| Pi 原生 branch/fork | 中 | 需要仔细适配 SessionManager 和工作台文件 |
| 实时 workspace watcher | 中 | 适合 P1，和 Artifact attribution 一起做 |
| 后台长任务、进程重启恢复 | 中低 | 需要独立 Worker/Host 和持久队列 |
| Subagent、多 Agent 协作 | 中低 | 先做应用层 Workflow，不要立即改 Pi 内核 |
| 插件沙箱和多租户 | 低 | 需要 Sidecar、权限代理和更严的身份体系 |
| 直接修改 Pi 源码 | 不建议 | 维护成本高，优先通过 adapter 和应用层扩展 |

---

## 七、建议的目标架构

### 7.1 Web 形态

```text
React Renderer
  ├─ ViewStore / SessionStore / RunStore / ArtifactStore
  └─ Global Event Listener
          │ typed API / SSE
          ▼
Harness API
  ├─ ConversationService
  ├─ AgentService
  ├─ RunQueueCoordinator
  ├─ PermissionService
  ├─ WorkspaceBroker
  ├─ ArtifactManager
  ├─ ModelChannelManager
  └─ EventLog
          │ adapter boundary
          ▼
PiRuntimeManager
  ├─ create/resume/fork session
  ├─ prompt/steer/abort/compact
  ├─ setModel/thinking
  ├─ tools/resources/skills
  └─ Pi AgentSession
```

### 7.2 以后桌面形态

如果后续迁移 Electron，不要让 Renderer 直接控制 Pi：

```text
Renderer
   │ preload / versioned IPC
   ▼
Main Process
   │ JSON-RPC / typed protocol
   ▼
Agent Host / Worker
   ├─ Pi Runtime
   ├─ Permission Broker
   ├─ Workspace Broker
   ├─ Event Log
   └─ Sidecar（高风险工具或不可信插件）
```

这样可以实现：窗口关闭后任务继续、前端刷新不丢事件、凭据不暴露给渲染层、不同工作区相互隔离、Pi SDK 升级只影响适配器。

### 7.3 `PiRuntimeManager` 建议接口

建议把原始 Pi 对象藏在适配层后面，对 Harness 暴露稳定接口：

```ts
interface PiRuntimeManager {
  createSession(input): Promise<SessionHandle>;
  resumeSession(input): Promise<SessionHandle>;
  forkSession(input): Promise<SessionHandle>;
  prompt(input): Promise<RunHandle>;
  steer(input): Promise<void>;
  abort(input): Promise<void>;
  compact(input): Promise<void>;
  setModel(input): Promise<ModelState>;
  setThinkingLevel(input): Promise<void>;
  listModels(input): Promise<ModelCatalog>;
  refreshModels(input): Promise<ModelCatalog>;
  listTools(input): Promise<ToolDescriptor[]>;
  reloadResources(input): Promise<ResourceState>;
  dispose(input): Promise<void>;
}
```

以后换 Pi 版本、换另一种 Agent Runtime，或者把运行时移到独立进程，只需要替换实现，不必重写会话和前端。

---

## 八、分阶段实施路线

### 阶段 P0：先把边界和事实来源统一

目标：不增加大量新功能，先让现有能力可靠。

1. 统一 `workspaceCwd`：Pi `cwd`、officecli、KB、地图、memory、Run snapshot 使用同一个已校验根目录。
2. 所有路径进入 `WorkspaceBroker.resolve()`，修复 `map_import`、KB ingest、memory 和 Skill 入口的独立拼接。
3. 增加非本机访问的强制认证，补充 session/run/rollback 的所有权校验。
4. 凭据改为安全存储或 broker 引用，不在普通 JSON 中直接写 API Key。
5. 统一事件信封，前端按 `eventId/sequence/runId/toolCallId` 幂等投影。
6. 修复恢复时的文件类型校验、取消状态和 DocViewer 静态风险。
7. 产物入口改为读取 Run manifest，不再把当前目录文件列表直接当成产物。

验收重点：两个工作区并行运行不串写；断线重连不重复工具卡；恢复不会把目录传给 Pi；回滚有完整审计记录。

### 阶段 P1：把 Chat、Agent、会话和 Run 变成产品对象

1. 抽出 ConversationService 和 AgentSessionService。
2. 建立 `Session / Conversation / Run / Artifact / Workspace` 数据模型。
3. Chat 使用只读工具注册表，Agent 使用权限控制的副作用工具。
4. 任务中心加入取消、重试、继续、回滚和复制 Run。
5. 增加会话固定、上下文快照、成果发布和版本标签。
6. 把 ChatPanel 的 SSE 提升到应用根部全局监听，页面只订阅 Store。
7. 将三个模式布尔值改为单一工作区模式状态机。

验收重点：用户可以固定一次会话和一次成果，刷新页面后继续；Chat 无法触发写入；Agent 运行可以等待用户回答并回到同一个 Run。

### 阶段 P2：Harness 工程化

1. 使用 Pi 原生 branch/fork 能力，保存 entry binding 和父子分支。
2. 引入 QueueCoordinator、持久化事件日志和 Run checkpoint。
3. 增加 WorkspaceWatcher 和文件变更归属。
4. 建立 ModelChannelManager、模型 Profile、能力协商和连接测试。
5. 增加 Workflow 模板、审批节点、验证脚本和评测集。
6. 增加 token、耗时、工具失败率、文件变化、产物质量和费用指标。

验收重点：服务重启后可恢复 queued/running/waiting 状态；从指定消息分支不会破坏原会话；每个产物能反查到 Run、事件和验证结果。

### 阶段 P3：Pi Runtime 管理与桌面化

1. 将 `PiRuntimeManager` 移入 Agent Host/Worker。
2. 通过版本化 JSON-RPC 或 IPC 连接前端。
3. 凭据进入系统安全存储，前端只拿 credentialRef。
4. 高风险工具和未知插件进入 Sidecar 或独立权限进程。
5. 做干净机器安装、离线运行、Pi 版本升级和长任务恢复测试。

验收重点：关闭窗口不影响任务；重启后能看到完整事件和产物；不同工作区、不同会话和不同用户不会互相越权。

---

## 九、建议的最小数据模型

```text
Workspace
  id, rootPath, allowedRoots, status, policy

Conversation
  id, workspaceId, title, mode, pinnedAt, rootSessionId, createdAt

AgentSession
  id, conversationId, piSessionFile, modelId, channelId
  parentSessionId, forkEntryId, attachedFiles, profileId

Run
  id, conversationId, sessionId, workspaceId, status
  taskEnvelope, modelSnapshot, policySnapshot, checkpointId
  startedAt, endedAt, error

Event
  eventId, bootId, sequence, runId, turnId, toolCallId
  type, payload, replayable, timestamp

Artifact
  id, runId, workspaceId, path, hash, mime, title
  status, preview, reversible, publishedAt

Verification
  id, runId, artifactId, checkName, status, report, createdAt
```

核心原则：执行时保存快照，显示时读取投影，审计时读取事件，交付时读取 Artifact，而不是让某一个 React 组件同时充当所有事实来源。

---

## 十、必须建立的验收用例

### 对话和事件

- 发送普通 Chat，能收到完整消息、thinking、结束和统计事件。
- Agent 调用两个并发或交错工具，工具输出始终回到正确的 `toolCallId`。
- SSE 断线重连后不会重复最终答复、工具卡或文件变更。
- 服务重启后，已有 Run 能显示准确状态，而不是永久 busy。
- `ask_user` 等待期间刷新前端，问题仍然存在，回答后继续原 Run。

### 工作区和安全

- 两个会话绑定两个工作区并行运行，不发生串写。
- `../`、符号链接、外部根、缺失目录和目录型 session path 均被正确处理。
- Chat 不能调用写文件、bash、Office 写入和地图修改工具。
- 未审批的 memory_update、外部根访问和高风险命令不能执行。
- 非 loopback 访问必须认证，Run 和 rollback 不能跨用户访问。

### 会话和产物

- 固定会话后关闭/刷新页面仍能恢复。
- 从指定消息分支，父会话不改变，子会话继承正确的上下文。
- Run 生成的每个产物都能显示来源、hash、版本和差异。
- 回滚后产生新的审计记录，不覆盖原 Run。
- 大文件超出可逆限制时明确提示，而不是伪装成可恢复。

### 模型和运行时

- 模型目录能反映 provider、vision、tool call、thinking 和上下文能力。
- 临时 `PI_AGENT_DIR` 下可以完成模型读取、刷新和 session 测试。
- Provider 失败时能显示原因、回退策略和最终使用的模型。
- Pi SDK 升级只需修改 adapter，业务数据模型和前端协议不变。

---

## 十一、最终回答：以后能否做 Pi 内核管理？

**可以，而且可行性较高；但应理解为“管理 Pi Runtime”，不是把 Pi 改造成整个工程平台。**

你可以管理：

- Pi session 的创建、恢复、销毁和分支。
- prompt、steer、abort、compact、重试和 thinking level。
- 模型、Provider、模型目录、刷新和能力选择。
- ResourceLoader、Skills、工具注册和自定义工具。
- Pi 的事件流、token、thinking、tool call 和结束状态。
- 每个 Session 使用哪个工作区、模型、Profile 和工具集合。

你不能只依赖 Pi 获得：

- 安全的文件系统、命令、网络和凭据隔离。
- 多用户身份、配额、成本、租户和所有权。
- exactly-once 事件、持久队列、进程重启恢复和 Run checkpoint。
- 工程工作流、审批节点、产物发布、验证、版本和回滚审计。
- 不可信插件或 Skill 的沙箱。

所以推荐的长期定位是：

```text
Pi = Agent Runtime
你的 Harness = Runtime Control Plane + Workspace/Artifact/Policy/Eval
```

这条路线既能最大化利用 Pi 的能力，又不会因为过早 fork Pi 内核而承担长期维护成本。只有当你明确需要 Pi 官方 API 无法提供的核心语义，并且应用层 adapter、Workflow 和 Host 都无法解决时，才考虑维护 Pi fork。

---

## 十二、建议的第一批落地顺序

如果现在只做一轮最有价值的工程工作，建议按下面顺序：

1. **先修工作区边界**：统一 Pi cwd 和自定义工具 cwd，这是数据安全底线。
2. **再修事件协议**：统一 eventId、sequence、runId、toolCallId 和全局监听。
3. **把 Artifact 做成一等对象**：产物必须来自 Run manifest，有 hash、版本、来源和发布动作。
4. **把任务中心变成控制中心**：取消、继续、重试、回滚、待审批和待回答。
5. **真正拆 Chat/Agent**：用工具策略和 Profile 实现能力隔离。
6. **固定会话和上下文**：置顶、快照、分支、引用资料和模型配置可复现。
7. **再做 PiRuntimeManager**：隐藏 Pi 细节，为未来桌面 Agent Host 做准备。
8. **最后做 Workflow 和评测**：把规划报告、Office 审校、GIS 分析变成可重复的工程流程。

一句话概括：你最适合做的不是“再做一个 Proma”，而是做一个**规划生产场景的 Proma + Pi Harness**——Proma 提供通用 Agent 产品的分层经验，Pi 提供执行内核，你的项目负责把资料、知识、分析、对话、文件和成果固定成可靠的工程链路。

---

## 附录 A：本地代码证据入口

- [项目说明与架构概览](<F:/Claude code本地文件/office-agent-web/README.md>)
- [Pi Agent 管理、工具、事件和模型运行时](<F:/Claude code本地文件/office-agent-web/server/agent.mjs>)
- [HTTP API、SSE、会话、文件和 Run 路由](<F:/Claude code本地文件/office-agent-web/server/index.mjs>)
- [Run 快照、差异、产物和回滚](<F:/Claude code本地文件/office-agent-web/server/runs.mjs>)
- [工作区、路径和 Pi Agent 目录配置](<F:/Claude code本地文件/office-agent-web/server/workspace.mjs>)
- [前端对话、SSE、工具块、任务状态和模型选择](<F:/Claude code本地文件/office-agent-web/client/src/components/ChatPanel.jsx>)
- [前端总编排、会话恢复、工作区和模式状态](<F:/Claude code本地文件/office-agent-web/client/src/App.jsx>)
- [会话、文件树和产物入口](<F:/Claude code本地文件/office-agent-web/client/src/components/SessionSidebar.jsx>)
- [任务中心](<F:/Claude code本地文件/office-agent-web/client/src/components/任务中心.jsx>)

## 附录 B：外部参考资料

- [Proma README](https://github.com/proma-ai/Proma/blob/main/README.md)
- [Proma main/lib](https://github.com/proma-ai/Proma/tree/main/apps/electron/src/main/lib)
- [Proma Agent Event Bus](https://github.com/proma-ai/Proma/blob/main/apps/electron/src/main/lib/agent-event-bus.ts)
- [Proma Agent Session Manager](https://github.com/proma-ai/Proma/blob/main/apps/electron/src/main/lib/agent-session-manager.ts)
- [Proma Agent Workspace Manager](https://github.com/proma-ai/Proma/blob/main/apps/electron/src/main/lib/agent-workspace-manager.ts)
- [Proma Pi Agent Adapter](https://github.com/proma-ai/Proma/blob/main/apps/electron/src/main/lib/adapters/pi-agent-adapter.ts)
- [Proma Chat Service](https://github.com/proma-ai/Proma/blob/main/apps/electron/src/main/lib/chat-service.ts)
- [Proma Channel Manager](https://github.com/proma-ai/Proma/blob/main/apps/electron/src/main/lib/channel-manager.ts)
- [Proma Workspace Watcher](https://github.com/proma-ai/Proma/blob/main/apps/electron/src/main/lib/workspace-watcher.ts)
- [Proma Global Agent Listeners](https://github.com/proma-ai/Proma/blob/main/apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts)
- [Proma Agent Atoms](https://github.com/proma-ai/Proma/blob/main/apps/electron/src/renderer/atoms/agent-atoms.ts)
- [Proma Chat Atoms](https://github.com/proma-ai/Proma/blob/main/apps/electron/src/renderer/atoms/chat-atoms.ts)
- [Proma Runtime Shared Protocol](https://github.com/proma-ai/Proma/blob/main/packages/shared/src/types/agent-runtime.ts)
- [Proma LICENSE（AGPL-3.0）](https://github.com/proma-ai/Proma/blob/main/LICENSE)
- [Pi Custom Models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)
- [Pi SDK exports](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/index.ts)

## 十三、第二阶段落地状态

本报告提出的第一阶段和第二阶段修改已经在以下分支完成到当前范围：

`codex/规聚项目稳定性第二阶段`

第二阶段实际落地的重点是稳定性，不是重做界面：

- Agent 每轮先形成能力计划，识别是否需要文档读取、知识库、地图、Skills / 工作流和 Office CLI。
- 显式工作流或 `@技能[...]` 调用先做 Skills 预检，缺失或不可读时在模型调用前返回原因。
- 文档引用读取按文件版本和读取范围做有界缓存，并记录解析器、读取时间、来源版本、命中状态和截断状态。
- 读取异常在 `context_read` 工具内结构化返回，避免单个损坏文件直接拖垮整轮 Agent 对话。
- Word/Excel/PPT 任务先检查 Office CLI 是否可用；PDF 和普通文本读取不会被错误要求 Office CLI。
- Run 绑定项目、能力计划和产物；新增/修改产物带稳定 ID、校验状态和验证信息。
- 前端沿用现有对话事件流展示本轮能力，任务完成后保留产物校验状态。

当前产物校验是轻量结构校验：能检查文件是否存在、非空、Office ZIP 文件头、PDF 文件头、文本可读和 JSON 可解析；它还不等同于 Office 内容级审校或视觉验收。后续应继续做 Chat/Agent 工具白名单隔离、事件 Store/未读、任务恢复与取消、产物版本发布，以及项目级记忆和成果管理。

## 十四、第三阶段落地状态

第三阶段已在分支 `codex/规聚项目稳定性第三阶段` 完成当前范围的模式和前端交互改造：

- Chat、Office、Agent / 创作统一为三种 Task 模式。Chat 面向知识库、Skills 和工作区资料检索；Office 面向 Office CLI 精准编辑；Agent / 创作面向完整执行与产出。
- Pi 每轮 prompt 前根据模式重新设置活动工具，形成明确权限边界，并将模式策略作为事件流状态显示给用户。
- 对话工具栏、消息头、任务状态条和会话历史均显示当前模式；历史支持按执行中、已完成和失败筛选，并显示模式和产物数量。
- 项目列表继续按类型分组，同时在当前项目上下文中显示类型、状态，并提供项目记忆入口，方便后续把经验沉淀到项目级记忆。
- Office CLI 的“是否需要调用”仍由第二阶段的能力计划根据文件类型和任务意图自动判断；本阶段的 Office 模式是交互和权限边界，不要求用户自己判断底层工具。

本阶段验证：`npm.cmd run verify` 通过，包含服务端语法、Vite 构建、API 冒烟、第三阶段模式权限边界和 Chat 能力计划检查。当前仍未实现根级事件 Store、全局未读和任务恢复控制，这些属于第四阶段 Harness 控制能力。

## 十五、第四阶段落地状态

第四阶段开始把前面确定的“事件流 + Run + 会话管理”从页面级能力推进为 Harness 的控制平面：

- 重要事件持久化到 `.oaw/events/事件流.jsonl`，并通过 `/api/agent/events` 提供跨会话重放；事件包含序号、事件 ID、client、thread、Run 和时间，前端可以断线续接。
- App 级全局订阅负责接收后台任务状态，ChatPanel 只负责当前对话的高频展示。这样切换到新对话不会卸载后台任务的状态接收，也不会把“历史里没有生成文件”误判成“任务不存在”。
- 会话历史显示后台 Run 的未读状态；任务中心显示所有当前工作区 Run，并提供取消、继续和重试入口。Run 详情返回 `canCancel/canResume/canRetry`，前端不自行猜测按钮可用性。
- 服务重启会把旧活动 Run 标记为 `recovering`，而不是继续暴露失真的 `running`。用户确认后创建新的恢复 Run，关联来源 Run，并重新执行 Skills、引用和 Office CLI 预检。
- 取消流程先持久化 `cancel_requested`，再调用 Pi abort；主请求和恢复请求在结束时都会检查取消标志并落为 `cancelled`，减少“界面显示中断但 Run 最终写成 completed”的状态漂移。
- 任务封装记录恢复来源和动作，步骤更新进入同一事件 Store；这为后续的 checkpoint、产物版本、回滚审计和评测回放提供了数据基础。

这一阶段对 Proma 的借鉴不是复制 Electron 界面，而是把“全局 Agent 监听器、会话状态原子、运行时事件总线”转译为当前 Web 项目的 App 全局订阅、持久事件 Store 和任务中心控制。Pi 仍然是执行内核，恢复语义、权限边界、工作区安全和产物验证继续由 Harness 负责。

当前仍需明确的限制：恢复目前是基于 Pi JSONL 会话的“重新打开并发送继续提示”，尚未达到 Pi 内部 token 级 checkpoint；根级 Store 也暂不保存全部高频 token/thinking 流。下一阶段应优先做成果版本化、记忆审核/沉淀、项目级设置和真实长任务恢复评测。

## 十六、收尾修改后的产品闭环

本次收尾把前面规划中的三类长期对象补齐：

- 项目：按交通规划、GIS / 地图分析、调研报告、Office 文档、数据分析、综合项目和资料库分类，并显示项目状态、未完成 Run、成果数和待沉淀数量。
- 记忆：Agent 只能提出建议；用户在当前项目的记忆页确认后才写入 `memory/MEMORY.md`，知识库原文、会话记录和长期记忆继续分开。
- 成果：只有 Run manifest 中登记的文件才能进入成果区；成果固定前要通过工作区边界、文件存在性和基础格式验证，固定后记录版本、hash、来源 Run、会话和项目。

成果区现在可以形成如下回溯链：

```text
项目 → 成果版本 → 文件 hash / 校验 → 来源 Run → 来源会话 → 模型与模式
```

这使 Proma 的“工作区、Agent 状态和成果查看”经验与 Pi 的会话执行能力结合起来，同时把长期可依赖的工程语义留在 Harness 层，而不是依赖 Pi 内核自行承担。
