# Office Agent Web - 前端设计文档

当前基线：**v0.8.34**（feature/phase1-safety-baseline）

## 架构概览

```
浏览器 (React SPA)
── App.jsx: kbMode ? KnowledgeBase(全屏) : 三栏办公布局 ──

┌─ 三栏办公模式（kbMode=false）─────────────────────────────────────────────────┐
│ 左栏 (SessionSidebar)    │ 中栏 (DocViewer)      │ 右栏 (ChatPanel)  │
│ - 文件标签页             │ - DocxViewer (docx-preview)│ - 模型选择器+推理强度 │
│ - 历史标签页(按文档过滤) │ - PptxViewer (pptxviewjs)  │ - 最近会话栏        │
│ - 文件列表(右键菜单)     │ - ExcelGrid (可编辑表格)   │ - 消息流            │
│ - 会话列表(重命名/删除)  │ - MarkdownBody(+目录浮窗)  │ - 思考过程(默认展开) │
│ - 技能广场/智能体广场    │ - HTML/TXT 预览           │ - 工具调用卡片       │
│                          │ - 批注面板(CommentMarker) │ - PlanBoard 任务板   │
│                          │                           │ - 图片粘贴/上传      │
└──────────────────────────┴───────────────────────────┴──────────────────────┘

┌─ 知识库全屏模式（kbMode=true）────────────────────────────────────────────────┐
│ 左: 目录树/搜索结果/IMA │ 中: Markdown 预览 + G6 知识图谱│ 右: 文档信息面板  │
│ - 根目录选择/添加/移除   │ - KnowledgeGraph (G6 力导向图)│ - 双向链接 [[link]]│
│ - 搜索框(全文子串)      │   节点=文档/标签/目录          │ - 反向链接         │
│ - 树节点展开/收起       │   边=内容相似/链接/标签/目录   │ - 标签、标题结构   │
│ - IMA 云端知识库标签    │   点击节点 → 打开预览         │ - @ 到对话按钮     │
│ - 模式切换: 浏览/图谱   │   缩放/拖拽/图例/布局控制    │                   │
└──────────────────────────┴───────────────────────────┴──────────────────────┘
           │ 三栏可拖拽 (Resizer)      │ SSE + POST               │
┌──────────┴──────────────────────────┴──────────────────────────┴─────────┐
│  Express 后端 (localhost:3001)                                           │
│  ├─ /api/files*        文件管理(上传/删除/列表)                          │
│  ├─ /api/doc/:file*    raw/html/comments/watch/cells（正则路由）          │
│  ├─ /api/office        officecli 操作                                   │
│  ├─ /api/sessions*     会话历史(CRUD + ?file= 过滤)                      │
│  ├─ /api/runs*         TaskEnvelope/run manifest/产物 diff/回滚           │
│  ├─ /api/workflows*    声明式技能工作流与依赖校验                        │
│  ├─ /api/models        模型列表 /api/agent/model 切换                    │
│  ├─ /api/skills*       技能列表/导出/导入                                │
│  ├─ /api/workspaces*   工作区管理(切换/校验)                             │
│  ├─ /api/agent*        Pi SDK Agent 会话 (SSE 流式 + prompt/abort)      │
│  │     └─ officecli 自定义工具 + kb_search/kb_read 自定义工具           │
│  ├─ /api/kb/*          知识库索引(状态/树/搜索/图谱/文档) + IMA 代理     │
│  └─ /api/open-in-explorer  文件管理器定位                                 │
└──────────────────────────────────────────────────────────────────────────┘
```

## 组件树

```
App.jsx
├── ThemeProvider (theme.jsx: dark/light, localStorage 记忆)
├── KnowledgeBase.jsx      知识库全屏模式（kbMode=true 时渲染）
│   ├── KnowledgeGraph.jsx  antv G6 力导向图（节点/边/缩放/拖拽/图例）
│   ├── MarkdownBody.jsx    文档内容预览（GFM/KaTeX/高亮，复用）
│   └── Icon.jsx            back/cloud/backlink 等图标
├── TemplateLibrary.jsx    模版库全屏模式（tplMode=true 时渲染）
│   ├── MarkdownBody.jsx    模版内容预览（.md 渲染）
│   └── Icon.jsx            文件类型图标
├── SessionSidebar.jsx     左栏：文件/历史标签、技能广场、智能体广场
│   ├── FileSidebar.jsx    文件列表 + ContextMenu 右键菜单
│   └── SkillsManager.jsx  技能管理（@调用/导入/导出）
├── AgentMarket.jsx        智能体广场（4 个交通规划助手，@ 注入对话）
├── DocViewer.jsx          中栏文件分派（按 kind 选择渲染器）
│   ├── DocxViewer.jsx     docx-preview 高保真渲染（批注/修订开关、翻页）
│   ├── PptxViewer.jsx     pptxviewjs Canvas 渲染（翻页/跳页/页码）
│   ├── ExcelGrid.jsx      x-spreadsheet 可编辑表格（多 sheet）
│   ├── MarkdownBody.jsx   GFM + KaTeX + 高亮 + 锚点
│   │   └── MarkdownToc.jsx 目录浮窗（滚动高亮当前标题）
│   └── CommentMarker.jsx  批注面板（定位段落/黄底高亮/编号徽标）
└── ChatPanel.jsx          右栏：模型选择、推理强度、消息流、输入区
    ├── PlanBoard.jsx      任务板（解析 - [ ] 列表，进度条）
    └── Resizer.jsx        三栏拖拽
```

## 通信机制

### 网页端 ↔ 后端
- **POST /api/agent/prompt** — 发送用户指令（含图片 base64）
- **GET /api/agent/stream?client=xxx** — SSE 长连接，实时推送事件流
- **GET /api/agent/abort** — 中断当前 agent 处理
- **POST /api/agent/model** — 切换当前会话模型

### 后端 API 路由表（server/index.mjs）

| 方法 | 路由 | 用途 |
|------|------|------|
| GET | /api/status | 健康检查 |
| GET | /api/files | 文件列表 |
| POST | /api/files/upload, /api/files/delete | 上传/删除 |
| GET | /api/doc/:file/raw | 原始文件流（docx-preview/pptxviewjs 拉取） |
| GET | /api/doc/:file | 渲染 HTML / Excel 数据 / 文本内容 |
| GET | /api/doc/:file/html | officecli 渲染 HTML（Word/PPT 备用预览） |
| GET | /api/doc/:file/comments | 批注列表（md/txt 返回会话衍生修订） |
| GET | /api/doc/:file/watch | 文件 watch（实时预览） |
| POST | /api/doc/:file/cells | Excel 单元格保存 |
| POST | /api/office | officecli 操作（agent 工具） |
| GET | /api/models | 模型列表（30+，含视觉标记） |
| GET | /api/skills, /api/skills/export, /api/skills/import | 技能管理 |
| GET | /api/workspaces, /api/workspace/switch, /api/workspace/validate | 工作区管理 |
| GET/POST | /api/sessions, /api/sessions/:id, /rename, /fork | 会话历史 CRUD、分支（?file= 过滤） |
| GET/POST | /api/runs, /api/runs/:id, /rollback | 执行记录、产物清单、显式回滚 |
| GET | /api/workflows, /api/workflows/:id/validate | 工作流注册表与技能依赖校验 |
| POST | /api/agent/prompt, /api/agent/abort, GET /api/agent/stream | agent 会话 |
| **GET** | **/api/kb/status** | 知识库索引状态（roots/fileCount/ima配置） |
| **POST/DELETE** | **/api/kb/roots** | 添加/移除知识库根目录 |
| **GET** | **/api/kb/tree?root=N** | 某根目录的文件树（递归目录结构） |
| **GET** | **/api/kb/search?q=...&root=N** | 全文搜索（加权打分：标题10/标签6/标题行4/正文1） |
| **GET** | **/api/kb/graph?include=...** | 知识图谱数据（nodes+edges，可选 links/similar/tags/folders） |
| **GET** | **/api/kb/doc?path=...&root=N** | 文档详情（内容+标签+headings+links+backlinks） |
| **GET** | **/api/kb/ima/status** | IMA 凭证状态 |
| **GET** | **/api/kb/ima/bases** | IMA 知识库列表 |
| **GET** | **/api/kb/ima/search?q=...&kb=...** | IMA 云端搜索 |
| **GET** | **/api/kb/ima/doc?media_id=...** | IMA 文档详情（笔记/文件原文） |
| **GET** | **/api/templates** | 模版库列表（?category= 分类筛选） |
| **GET** | **/api/templates/content?path=...** | 模版内容预览（md返回text，其他返回binary） |
| **POST** | **/api/templates/refresh** | 重新扫描模版目录 |
| POST | /api/open-in-explorer | 文件管理器定位 |

> 文档路由全部为**正则路由**（`/^\/api\/doc\/([^\/]+)\/(raw|html|comments|watch|cells)$/`），修复 Express 5 中 `:file` 参数吞掉后缀导致中文文件名匹配失败的问题。

### 后端 ↔ Pi Agent
- 后端进程内调用 `@earendil-works/pi-coding-agent` SDK
- `createAgentSession()` 创建常驻会话，自动发现 skills
- `session.prompt()` 发送指令，`session.subscribe()` 接收事件流
- agent 拥有完整工具链：read/bash/edit/write + 自定义 officecli 工具 + **kb_search（知识库搜索）+ kb_read（知识库读取）**
- 推理强度：`setThinkingLevel(low|medium|high)` 对应 ⚡/⚖/🧠

### 文件定位机制
1. **当前文件注入**：用户打开文件后，发送消息时前端自动附加 `[当前打开文件: xxx.docx]`
2. **officecli 工具**：agent 通过自定义 `officecli` 工具操作文档，文件名相对于 workspace 目录
3. **agent 上下文**：每轮注入 TaskEnvelope、当前工作区、分层记忆和 KB 使用说明；输出固定总结读取来源、修改文件、产物、假设和下一步

## 知识库设计（KnowledgeBase + KnowledgeGraph）

### 知识库索引服务（server/kb.mjs）
- **配置**：`kb.json` 持久化（roots[] 根目录路径、imaSkillDir），前端可添加/移除根目录
- **扫描**：递归遍历 roots 下的 .md 文件（跳过 node_modules/.git/.venv 等），基于 mtime+size 增量缓存（8s 去重窗口，解析版本号强制失效）
- **解析**：frontmatter（title/tags）、第一个 `# 标题`、`[[wikilink]]`、内联 `#tag`（排除 hex 色值）、headings[]、links[]
- **全文索引**：子串匹配打分（标题×10 / 标签×6 / 标题行×4 / 正文×1），每项独立计数（上限10），返回排序结果 + 摘要片段（首次命中±60/140字符窗口）
- **图谱生成**：节点=文件/标签/目录（受 maxNodes 上限保护），边=wikilink 双向边 / 内容相似边 / 标签边 / 目录边，相似边算法：
  - 提取文档前6000字符的 CJK/字母数字字符二元组 Set
  - pair-wise overlap = |A∩B| / min(|A|,|B|)，阈值≥8 且 overlap≥0.16
  - 按 overlap 降序截断至 files×3 上限，simCache 按 rootIdx 缓存

### 前端 KnowledgeBase.jsx
- **状态管理**：roots/rootIdx/tree/searchQ/results/doc/graphData/graphInc/view(浏览|图谱)/imaOpen/imaResults
- **顶部工具栏**：返回办公模式、根目录下拉选择（含添加/移除）、搜索框（Enter 触发）、浏览/图谱切换、IMA 标签
- **浏览模式**：左树/右信息面板/中预览（MarkdownBody 复用），@ 到对话按钮（插入 `@知识库[路径@根目录名]`）
- **图谱模式**：KnowledgeGraph 全屏，顶栏控制（similar/links/tags/folders 复选框，重新布局按钮）

### KnowledgeGraph.jsx（antv G6 v5）
- `new Graph({data, node, edge, layout, behaviors})`，`graph.render()`
- 节点样式：文件青绿色(16px)、标签黄色(9px)、目录蓝色(7px)，标签下方显示
- 边样式：链接青绿色(1.4px)、相似蓝色(0.8px/0.45透明度)、标签/目录灰色
- 布局：force 力导向（linkDistance:130, nodeStrength:-320, preventOverlap, collideStrength:0.9）
- 行为：drag-canvas / zoom-canvas / drag-element / hover-activate / click-select
- 事件：node:click → 回传 onSelectNode（带 relPath/rootIdx），联动打开文档预览
- 高亮：graph.focusElement(highlightId) 聚焦当前打开文档节点

### @ 引用分析链路
1. 前端知识库文档「到对话」按钮 → `chatInputRef.insertText(`@知识库[${relPath}@${rootName}]`)`
2. agent 收到 prompt（含 `@知识库[...]` 格式文本），ResourceLoader 上下文告知 agent 这是知识库引用格式
3. agent 调用 `kb_read(path)` 工具（path=`相对路径@根目录名`）→ kb.mjs getDoc() 返回完整 Markdown 内容（含标签/反链）
4. agent 读取全文后进行分析/回答

## SSE 事件流

```
SSE Event Types:
├── token        → 文本输出 token（流式追加，rAF 节流渲染）
├── thinking     → 思考过程 token（默认展开实时可见）
├── tool_start   → 工具调用开始 {name, input}
├── tool_output  → 工具执行输出流 {name, output}
├── tool_end     → 工具调用结束 {name, isError, result}
├── message_start/end → 消息生命周期
├── agent_end    → agent 完成（关闭 busy 状态）
├── agent_error  → 错误
└── file_changed → 文件变更通知 {files: [...]}
```

## Office 查看器设计

### DocxViewer（docx-preview）
- 高保真渲染：分页、表格、图片、样式完整还原
- 工具栏：批注开关（`renderComments`）、修订开关（`renderChanges`）、翻页
- 数据源：`/api/doc/:file/raw` 原始文件流（Buffer 直传，避免 HTML 中转失真）
- 样式容器：`.oaw-docx-wrap`，纸张白底、周围灰底（暗/亮主题适配）

### PptxViewer（pptxviewjs）
- Canvas 逐页渲染，工具栏：上一页/下一页/页码输入/总页数
- 数据源：`/api/doc/:file/raw`
- 样式容器：`.oaw-pptx-wrap`

### ExcelGrid（x-spreadsheet）
- 多 sheet 切换，单元格直接编辑
- 保存：POST /api/doc/:file/cells 写回文件，保存后触发预览刷新

### MarkdownBody
- rehype-slug 生成标题锚点，MarkdownToc 目录浮窗定位（ID+文本双重查找）
- KaTeX 公式、代码高亮、GFM 表格

## 消息渲染

### 思考过程
- 折叠块：默认展开（实时可见），点击收起/展开
- 左边框 accent 色标记

### 工具调用卡片
- 状态着色：pending(黄) / success(绿) / error(红)
- 点击展开显示：输入参数 + 执行输出/结果
- 输出超过 200 字符自动截断预览

### PlanBoard 任务板
- 从 agent 回复的 `- [ ]` / `- [x]` 解析为可勾选任务列表
- 顶部进度条（已完成/总数），勾选状态本地维护

### 文件上下文标记
- 用户消息气泡顶部显示 `[当前文件: xxx]` 小标签
- 同时注入到发送给 agent 的 prompt 文本中

### 批注定位（CommentMarker）
- Word 式批注：点击 → 定位段落 + 整段黄底高亮 + 段落旁编号徽标 + 滚动居中
- 关键词匹配：从批注指令提取关键词匹配正文（TreeWalker 文本级定位），失败回退首段
- md/txt 批注：服务端 `/api/doc/:file/comments` 返回会话衍生的修订记录（行号/段落匹配）
- 手动刷新按钮，文件修改后自动重新拉取

## 模型选择与推理强度
- 下拉菜单显示所有 30+ 可用模型，`[V]` 前缀标记 13 个视觉模型
- 选择后实时切换 agent 会话模型（POST /api/agent/model）
- 附图片时若当前模型不支持视觉，显示黄色提示条
- 推理强度：⚡快速(low) / ⚖标准(medium) / 🧠深度(high) 三档，映射 setThinkingLevel

## 设计规范

### 配色（pi dark 主题，默认）
```
:root (dark):
--body-bg:   #1a1a2e   --panel-bg:  #16162a
--panel2-bg: #1e1e3a   --surface:   #222240
--text:      #d4d4d4   --muted:     #808080
--dim:       #666666   --accent:    #8abeb7
--border:    #3a3a5c   --selected:  #3a3a4a
--error:     #cc6666   --success:   #b5bd68
--warning:   #f0c674   --user-bg:   #2a3a3a
```

### 亮色主题（[data-theme="light"]）
```
--body-bg:   #f5f6fa   --panel-bg:  #ffffff
--panel2-bg: #eef0f6   --surface:   #e4e7f0
--text:      #2d3142   --muted:     #5c6270
--dim:       #8a8fa3   --accent:    #2a8c82
--border:    #d4d8e4   --selected:  #dfe4ee
--error:     #c0392b   --success:   #5c7a1f
--warning:   #b7791f   --user-bg:   #e6f0ee
```
主题切换：ThemeProvider（theme.jsx），`document.documentElement.setAttribute("data-theme", ...)`，localStorage key `oaw_theme`。

### 字体
```
font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
```

### 间距与细节
- 基准字号 12px，行高 18px；按钮圆角 3px，padding 2-8px；卡片圆角 3-4px
- 全局滚动条：8px 细滚动条、圆角、hover 高亮，CSS 变量自动适配暗/亮主题
- 头像：圆形，用户蓝色系、agent 青绿色
