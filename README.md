# Open Plan（规聚）

基于 [Pi Agent SDK](https://github.com/nicepkg/pi-coding-agent) 的 Web 端规划工作台 + AI Agent 协作工具（Office 文档编辑、知识库、地图可视化、脑图）。前端设计参考 [Proma](https://github.com/proma-ai/Proma) 项目。

**规聚**：规划 + 聚集——为交通规划工程师提供"规划成果 + 知识汇聚 + 智能协作"的一体化工作台。

## 功能

- **文档查看**：左侧显示 Word/PPT 客户端渲染（docx-preview/pptxjs）、Excel 可编辑表格（x-spreadsheet）
- **Agent 对话**：右侧 Pi Agent 聊天面板，支持所有 pi 能力（skills、插件、工具、图片输入）
- **文件管理**：上传、删除、打开 Office 文件（.docx/.xlsx/.pptx）
- **模型切换**：90+ 模型可选，支持视觉模型图片理解
- **实时更新**：Agent 修改文件后自动检测变更并刷新视图
- **会话历史**：日期分组（今天/昨天/更早）、置顶、搜索
- **记忆系统**：工作区 AGENTS.md + memory/ 目录，支持实时变更监控
- **跨平台**：Windows（officecli）+ macOS/Linux（xlsx 原生读取 + docx-preview 客户端渲染）

## 快速开始

### 前置条件

- **Node.js** >= 22
- **Pi agent** 已配置（`~/.pi/agent/settings.json` 中配置好模型和 API Key）
- **officecli**（可选，Windows 专用）：`powershell -c "irm https://d.officecli.ai/install.ps1 | iex"`

### 安装与启动

```bash
# 安装依赖
npm install

# 安装前端依赖并构建
cd client && npm install && npm run build && cd ..

# 启动服务器
npm start
# → http://localhost:3001
```

### 开发模式

```bash
# 终端1：启动后端
npm start

# 终端2：启动前端开发服务器（热更新）
cd client && npm run dev
# → http://localhost:5173（自动代理 /api 到后端）
```

## 架构

```
浏览器 (React)
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ 文件列表      │  │ 文档查看/编辑 │  │ Agent 对话    │  │ 记忆系统      │
│ (左侧栏)     │  │ (客户端渲染)  │  │ (SSE 流式)   │  │ (AGENTS.md)  │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │ REST            │ REST            │ SSE/POST        │ REST/SSE
┌──────┴─────────────────┴─────────────────┴─────────────────┴─────────┐
│                    Node.js Express (localhost:3001)                   │
├──────────────────────────────────────────────────────────────────────┤
│  /api/files       文件管理                                           │
│  /api/doc/:f      文档打开 (客户端渲染/Excel数据)                    │
│  /api/models      模型列表                                           │
│  /api/agent       Pi Agent SDK 会话 (SSE 流式)                      │
│  /api/sessions    会话历史管理                                       │
│  /api/memory      工作区记忆 (CRUD + SSE 变更流)                    │
└─────────────────────┬─────────────────────┬──────────────────────────┘
                      │                     │
              officecli (可选)         Pi SDK (in-process)
```

### 关键文件

| 文件 | 说明 |
|------|------|
| `server/index.mjs` | Express 主服务，REST API + SSE + 记忆系统 |
| `server/agent.mjs` | Pi SDK 会话管理，自定义 officecli 工具 |
| `server/office.mjs` | officecli CLI 封装 |
| `server/workspace.mjs` | 工作区文件管理 + AGENT_DIR 自动检测 |
| `client/src/components/ChatPanel.jsx` | Agent 聊天面板（Proma 风格消息流） |
| `client/src/components/SessionSidebar.jsx` | 会话历史（日期分组 + 置顶 + 搜索） |
| `client/src/components/MemoryTab.jsx` | 记忆系统 UI（文件列表 + 预览/编辑） |
| `client/src/components/DocViewer.jsx` | 文档查看器（DocxViewer/PptxViewer/ExcelGrid） |
| `office-workspace/` | 受管 Office 文件目录 |

## 对话流设计（参考 Proma）

- **消息样式**：用户淡色气泡 + AI 无气泡长文 markdown
- **流式渲染**：呼吸脉冲圆点指示器 + 思考自动折叠（结束后 1s）+ 思考耗时
- **执行过程分组**：工具调用自动归组，流式展开 → 结束后 3s 自动收起
- **工具语义短语**：显示"读取文件"/"执行命令"等语义描述，替代原始参数
- **任务进度卡**：从 markdown 任务列表解析，显示进度条 + 状态图标
- **操作条常显**：复制/重发按钮微透明，hover 加深

## 使用方式

1. 打开 http://localhost:3001
2. 左侧点击文件打开，或上传新文件
3. 右侧 Agent 面板输入指令，例如：
   - "把 test-report.docx 标题改成红色加粗"
   - "在 test-data.xlsx 的 B3 填 88"
   - "给我创建一份季度报告 PPT"
4. 附带图片可辅助说明（需选择 🖼️ 视觉模型）

## 配置

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务器端口 | 3001 |
| `OFFICECLI_BIN` | officecli 路径（可选） | 自动检测 |
| `PI_AGENT_DIR` | pi agent 配置目录 | `~/.pi/agent` |

### Pi Skills

Agent 自动加载 pi agent 配置目录下的所有 skills，包括：
- `officecli`：Office 文档操作
- `docx` / `xlsx` / `pptx`：专业格式技能
- `baoyu-*`：创意设计技能
- 其他已安装的 skills

## 技术栈

- **后端**：Node.js + Express 5 + Pi SDK
- **前端**：React 18 + Vite 5 + x-data-spreadsheet + docx-preview + pptxjs
- **文档引擎**：officecli（Windows）+ xlsx 包（macOS/Linux）+ docx-preview/pptxjs（客户端渲染）
- **AI 引擎**：Pi Agent SDK（支持 90+ 模型切换）

## 分支说明

| 分支 | 说明 |
|------|------|
| `develop` | 主开发分支（最新功能） |
| `feature/knowledge-base` | 原始版本 |
| `feature/frontend-design-optimization` | 前端设计优化（Proma 风格） |
| `feature/frontend-polish-v2` | 字体放大 + 会话修复 + Office 兼容 |
