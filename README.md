# Office Agent Web

基于 [pi agent SDK](https://github.com/nicepkg/pi-coding-agent) 和 [officecli](https://officecli.ai) 的 Web 端 Office 文档编辑 + AI Agent 协作工具。

## 功能

- **文档查看**：左侧显示 Word/PPT 渲染的 HTML 预览、Excel 可编辑表格（x-spreadsheet）
- **Agent 对话**：右侧 Pi Agent 聊天面板，支持所有 pi 能力（skills、插件、工具、图片输入）
- **文件管理**：上传、删除、打开 Office 文件（.docx/.xlsx/.pptx）
- **模型切换**：30+ 模型可选，13 个视觉模型支持图片理解
- **实时更新**：Agent 修改文件后自动检测变更并刷新视图

## 快速开始

### 前置条件

- **Node.js** >= 22
- **officecli** 已安装（`powershell -c "irm https://d.officecli.ai/install.ps1 | iex"`）
- **Pi agent** 已配置（`C:\Users\<你>\.pi\agent\settings.json` 中配置好模型和 API Key）

### 安装与启动

```bash
cd "F:\Claude code本地文件\office-agent-web"

# 安装服务端依赖（已完成）
npm install

# 安装前端依赖并构建（已完成）
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
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ 文件列表      │  │ 文档查看/编辑 │  │ Agent 对话    │
│ (左侧栏)     │  │ (iframe/表格) │  │ (SSE 流式)   │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │ REST            │ REST            │ SSE/POST
┌──────┴─────────────────┴─────────────────┴───────┐
│            Node.js Express (localhost:3001)       │
├──────────────────────────────────────────────────┤
│  /api/files    文件管理                           │
│  /api/doc/:f   文档打开 (html渲染/Excel数据)      │
│  /api/models   模型列表                           │
│  /api/agent    Pi Agent SDK 会话 (SSE 流式)       │
└───────────┬───────────────┬──────────────────────┘
            │               │
    officecli (spawn)   Pi SDK (in-process)
```

### 关键文件

| 文件 | 说明 |
|------|------|
| `server/index.mjs` | Express 主服务，REST API + SSE |
| `server/agent.mjs` | Pi SDK 会话管理，自定义 officecli 工具 |
| `server/office.mjs` | officecli CLI 封装 |
| `server/workspace.mjs` | 工作区文件管理 |
| `client/src/components/ChatPanel.jsx` | Agent 聊天面板（SSE 流式、图片、模型切换） |
| `client/src/components/ExcelGrid.jsx` | x-spreadsheet 表格编辑器 |
| `client/src/components/DocViewer.jsx` | 文档查看器（HTML iframe + Excel grid） |
| `office-workspace/` | 受管 Office 文件目录 |

## 使用方式

1. 打开 http://localhost:3001
2. 左侧点击文件打开，或上传新文件
3. 右侧 Agent 面板输入指令，例如：
   - "把 test-report.docx 标题改成红色加粗"
   - "在 test-data.xlsx 的 B3 填 88"
   - "给我创建一份季度报告 PPT"
4. 附带图片可辅助说明（需选择 🖼️ 视觉模型，如 `minimax-cn/MiniMax-M3`）

## 图片支持

当前默认模型可能不支持图片。支持图片理解的模型（标注 🖼️）：
- `minimax-cn/MiniMax-M3` ✅
- `xiaomi-token-plan-cn/mimo-v2.5` ✅
- `opencode-go/kimi-k3`
- `opencode-go/qwen3.7-plus`
- 等 13 个模型

在聊天面板顶部的下拉菜单中选择 🖼️ 模型即可。

## 配置

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务器端口 | 3001 |
| `OFFICECLI_BIN` | officecli 路径 | `%LOCALAPPDATA%\OfficeCLI\officecli.exe` |
| `PI_AGENT_DIR` | pi agent 配置目录 | `C:\Users\admin\.pi\agent` |

### Pi Skills

Agent 自动加载 pi agent 配置目录下的所有 skills（167 个），包括：
- `officecli`：Office 文档操作
- `docx` / `xlsx` / `pptx`：专业格式技能
- `baoyu-*`：创意设计技能
- 其他已安装的 skills

## 技术栈

- **后端**：Node.js + Express 5 + Pi SDK (v0.83.0)
- **前端**：React 18 + Vite 5 + x-data-spreadsheet
- **文档引擎**：officecli (v1.0.143)
- **AI 引擎**：Pi Agent SDK（支持多模型切换）

## 注意事项

- Excel 网格直接编辑后需点击「保存修改」按钮
- officecli 驻留进程会自动刷新文件，Agent 修改后有 2-10 秒延迟落盘
- 图片输入需要选择视觉模型，文本模型会忽略图片
- 中文路径在 WSL 环境下可能有编码问题，建议使用 Windows 原生 Node.js
