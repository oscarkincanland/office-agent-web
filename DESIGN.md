# Office Agent Web - 前端设计文档

## 架构概览

```
浏览器 (React SPA)
┌─────────────────────────────────────────────────────┐
│  左侧栏 (SessionSidebar)  │  中间 (DocViewer)  │ 右侧 (ChatPanel) │
│  - 文件标签页              │  - Word/PPT iframe  │  - 模型选择器     │
│  - 历史标签页              │  - Excel 可编辑表格 │  - 消息流         │
│  - 文件列表               │                     │  - 思考过程折叠    │
│  - 会话列表(重命名/删除)   │                     │  - 工具调用卡片    │
│                            │                     │  - 图片粘贴/上传   │
└────────────┬───────────────┴──────────┬────────────┘
             │ 三栏可拖拽 (Resizer)      │ SSE + POST
┌────────────┴──────────────────────────┴────────────┐
│  Express 后端 (localhost:3001)                      │
│  ├─ /api/files     文件管理                          │
│  ├─ /api/doc/:f    officecli 渲染/Excel数据          │
│  ├─ /api/sessions  会话历史(CRUD)                    │
│  ├─ /api/models    模型列表                          │
│  └─ /api/agent     Pi SDK Agent 会话 (SSE 流式)     │
│       └─ officecli 自定义工具 (Windows native spawn) │
└─────────────────────────────────────────────────────┘
```

## 通信机制

### 网页端 ↔ 后端
- **POST /api/agent/prompt** — 发送用户指令（含图片 base64）
- **GET /api/agent/stream?client=xxx** — SSE 长连接，实时推送事件流

### 后端 ↔ Pi Agent
- 后端进程内调用 `@earendil-works/pi-coding-agent` SDK
- `createAgentSession()` 创建常驻会话，自动发现 167 个 skills
- `session.prompt()` 发送指令，`session.subscribe()` 接收事件流
- agent 拥有完整的工具链：read/bash/edit/write + 自定义 officecli 工具

### 文件定位机制
1. **当前文件注入**：用户打开文件后，发送消息时前端自动附加 `[当前打开文件: xxx.docx]`
2. **officecli 工具**：agent 通过自定义 `officecli` 工具操作文档，文件名相对于 workspace 目录
3. **agent 上下文**：agent.mjs 的 ResourceLoader 注入了 workspace 指令，告诉 agent 文件在哪里

## SSE 事件流

```
SSE Event Types:
├── token        → 文本输出 token（流式追加）
├── thinking     → 思考过程 token（可折叠显示）
├── tool_start   → 工具调用开始 {name, input}
├── tool_output  → 工具执行输出流 {name, output}
├── tool_end     → 工具调用结束 {name, isError, result}
├── message_start/end → 消息生命周期
├── agent_end    → agent 完成（关闭 busy 状态）
├── agent_error  → 错误
└── file_changed → 文件变更通知 {files: [...]}
```

## 消息渲染

### 思考过程
- 折叠块：默认只显示前 100 字符预览
- 点击展开/收起
- 左边框 accent 色标记

### 工具调用卡片
- 状态着色：pending(黄) / success(绿) / error(红)
- 点击展开显示：输入参数 + 执行输出/结果
- 输出超过 200 字符自动截断预览

### 文件上下文标记
- 用户消息气泡顶部显示 `[当前文件: xxx]` 小标签
- 同时注入到发送给 agent 的 prompt 文本中

## 模型选择
- 下拉菜单显示所有 30 个可用模型
- `[V]` 前缀标记 13 个视觉模型（支持图片输入）
- 选择后实时切换 agent 会话的模型
- 附图片时若当前模型不支持视觉，显示黄色提示条

## 设计规范

### 配色（pi dark 主题）
```
--body-bg:   #1a1a2e
--panel-bg:  #16162a
--accent:    #8abeb7
--text:      #d4d4d4
--muted:     #808080
--dim:       #666666
--border:    #3a3a5c
--error:     #cc6666
--success:   #b5bd68
--warning:   #f0c674
```

### 字体
```
font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
```

### 间距
- 基准字号 12px，行高 18px
- 按钮圆角 3px，padding 2-8px
- 卡片圆角 3-4px
