# Office Agent Web - 需求文档

## 项目概述
基于 Pi Agent SDK 和 officecli 的 Web 端 Office 文档编辑 + AI Agent 协作工具。

## 核心需求

### R1. Office 文档在线查看与编辑
- 支持 .docx / .xlsx / .pptx 文件上传、删除
- Word/PPT：HTML 预览（officecli 渲染）
- Excel：可编辑表格（x-spreadsheet），支持直接修改单元格并保存

### R2. AI Agent 对话协作
- 通过右侧聊天面板与 Pi Agent 对话
- Agent 可通过 officecli 工具读取、修改 Office 文档
- 支持所有 Pi Agent 能力：skills、插件、工具、图片输入
- 30+ 模型可切换，13 个视觉模型支持图片理解

### R3. 对话流完整展示
- **思考过程**：显示 agent 的推理过程（可折叠）
- **工具调用详情**：显示 bash/officecli/read 等工具的输入参数和执行结果（可折叠展开）
- **流式输出**：实时显示 agent 回复

### R4. 文件上下文自动注入
- 用户打开文件后，发送消息时自动附加 `[当前打开文件: xxx]` 上下文
- Agent 知道用户正在看哪个文件，可以直接定位操作

### R5. 会话历史管理
- 会话列表：按时间倒序，支持重命名和删除
- 文件/历史标签页切换

## 非功能需求
- 中文界面
- 暗色主题（pi 风格等宽字体）
- 三栏可拖拽布局

## 技术约束
- Pi Agent SDK（@earendil-works/pi-coding-agent v0.83.0）
- officecli（v1.0.143，本地安装）
- Node.js >= 22 + React 18 + Vite 5
