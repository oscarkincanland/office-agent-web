# 对话流与派 SDK 服务端事件故障诊断报告

日期：2026-09-07
版本：0.10.0
范围：Agent 首次响应、派 SDK 事件、服务端事件流、前端消息恢复、模型连接超时

## 一、结论

这次“没有回复”不是单一的前端渲染问题。已核实的主因是：某次 Agent 请求使用 `minimax-cn/MiniMax-M3` 时，派已开始一轮 Agent turn，但在 20 秒首个 assistant 事件 watchdog 内没有收到 assistant 内容，服务主动 abort 了派回合；原代码又把 `MODEL_TIMEOUT` 排除在备用模型切换之外，因此该 Run 直接失败。

证据来自运行记录：

- 失败 Run：`run_5d9a530c-6cd2-4520-9df3-33dd4e3a28f4`
- 事件顺序：`model_request_started` → `agent_started` → `turn_started` → 用户消息开始/结束 → 超时
- 超时前没有 `assistant message_start`、文本、思考或工具开始事件
- 错误码：`MODEL_TIMEOUT`，原配置为 20 秒

因此，旧故障不是“模型已经回复但服务端事件流丢失”。当时模型响应流本身没有进入派的 assistant 阶段。

同时，直连 MiniMax 官方 Anthropic 端点验证返回 HTTP 200，响应时间约 2.2 秒；重启当前服务后，用同一模型进行最小 Agent 端到端测试成功，运行记录为 `run_e8c3aae4-67ce-412e-a62b-a7e259e0e8fc`：

- `assistant message_start`：请求后约 8 秒
- `assistant_final`：约 17 秒
- `run_finished`：约 19 秒
- 运行状态：`completed`
- 派版本：`0.84.3`

这说明派 SDK、MiniMax 配置和当前服务端事件流传输链路能够正常工作，问题表现为 provider/运行时首响应延迟叠加了过早失败和前端恢复缺口。

## 二、当前链路

```text
前端 ChatPanel
  ├─ POST /api/agent/prompt：提交任务，立即返回 accepted/runId
  └─ EventSource /api/agent/stream：接收按 client + thread 的服务端事件
        ↓
server/index.mjs
  ├─ 建立 run、能力计划、工作区快照
  └─ 后台执行 executeAgentRun
        ↓
server/agent.mjs
  ├─ 设置派 model/tools/thinking level
  ├─ session.prompt()
  ├─ session.subscribe() 将派事件归一化为工作台事件
  └─ assistant_final / agent_end / run_finished
        ↓
派 AgentSessionRuntime → 派 Agent Loop → provider stream
```

派的正常顺序是先发 `agent_start`、`turn_start` 和用户消息事件，之后才等待 provider；真正代表模型响应开始的是 assistant `message_start`、`text_start`、`thinking_start`、`toolcall_start` 或对应 delta。仅看到 `agent_started` 不能证明模型已经返回内容。

## 三、发现的问题与处理

### 1. 首响应 watchdog 会把慢但仍可用的模型直接判死

原逻辑在 20 秒内没有文本 delta 或工具事件就 timeout，而且 `MODEL_TIMEOUT` 被设置为不可重试，备用模型切换条件还明确排除了它。

已处理：

- 超时后等待派 abort 收尾，再执行一次备用模型切换
- 备用模型优先使用派全局默认模型，再尝试已确认可用的其他模型
- 保留失败原因和切换事件，前端可以显示“已切换模型”，不再无提示地卡在“连接模型”

### 2. 派已经开始 assistant 流时，边界事件可能被 watchdog 忽略

已处理：`text_start`、`thinking_start`、`toolcall_start` 以及 assistant `message_start` 现在会将当前 entry 标记为已收到首响应。只要 provider 已经返回 assistant 流，就允许后续长思考或工具任务继续执行。

### 3. 新建或切换子对话可能复用旧服务端事件游标

已处理：前端服务端事件游标由单一全局值改为 `client + thread` 分组。切换子对话、新建对话和断线重连不会再拿旧对话的序号跳过新事件。

### 4. 刷新/切换到正在运行的对话时，事件先到但消息气泡不存在

已处理：前端收到运行中的 `agent_started`、token、思考、工具或 `assistant_final` 事件时，会按运行态恢复 assistant 气泡；已完成历史不会重复创建。

### 5. token 流和最终文本可能产生短暂不一致

已处理：前端增加按帧文本队列；普通 token 逐帧显示，最终 `assistant_final` 作为权威文本校正遗漏 token，结束时等待队列排空。短文本和无 token 但有最终消息的 provider 也能正常显示。

### 6. Chat 每次发送都做完整工作区扫描，放大首响应延迟

已处理：无附件 Chat 使用 `snapshotMode: none`，不扫描和复制工作区；Agent、Office 和带附件的 Chat 仍保留完整快照及产物追踪。

### 7. 长上下文会让“连接模型”看起来更久

已处理：动态上下文按模式缩短；恢复已有 JSONL 会话时估算历史大小；达到预算后触发派原生 compact，并通过事件告知前端。工具输出保留首尾并限制长度，避免一次读取大文档吞掉后续上下文。

### 8. Bash 工具可以被模型带入全盘搜索

本次真实卡住任务暴露了新的工具层问题：Git Bash 中的 `/` 可能代表整台 Windows 主机，`find /` 会长时间扫描系统，且原工具没有默认超时。

已处理：

- 拒绝 `find/rg/grep/ls/du/tree` 从系统根目录开始的全盘搜索，并提示限定当前工作区
- Bash 默认超时 60 秒，最大允许 300 秒
- 超时和范围拦截都回传为工具错误，让 Agent 有机会调整命令或向用户说明

## 四、服务端事件流是否传输了所有派内容

当前实现不是把派的每一个原始内部事件原样透传，而是将有产品意义的事件归一化后通过服务端事件流发送，包括：任务受理、模型请求、Agent/turn、assistant 消息边界、文本/思考流、工具调用与输出、ask_user、队列、统计、压缩、错误、最终回复和结束状态。

这是一种有意的协议边界：原始派事件可能包含大对象、内部字段或高频细节，不适合直接作为前端协议。需要注意两点：

1. 实时服务端事件流会发送归一化后的 token/thinking 等事件；Run 持久化记录主要保留生命周期和诊断事件，不保存每个 token，避免历史文件膨胀。
2. 最终文本以 `assistant_final` 为准。即使某个 provider 没有产生可展示的 token delta，只要派得到 assistant 最终消息，前端仍会补建气泡并显示最终内容。

## 五、验证结果

- `node --check server/agent.mjs`：通过
- `npm.cmd run test:chat-flow`：通过
- `npm.cmd run build`：通过
- `npm.cmd run verify`：通过
- 3002 服务状态：`ok: true`，版本 `0.10.0`
- MiniMax-M3 直连探针：HTTP 200
- MiniMax-M3 经当前服务的派 → 服务端事件流 → Run 测试：`completed`，存在 `assistant_final` 和 `run_finished`
- 最终修复后的复测 Run：`run_839ee27d-a12d-42e5-bec5-4fc3bb62f1bb`，状态 `completed`；通过 `curl` 读取同一 `client + thread` 的原始服务端事件历史帧，直接看到 `assistant_final`（内容为“好”）和 `run_finished`
- 全盘搜索拦截与 Bash 超时策略回归：通过

构建仍提示少数前端 chunk 较大，这是性能优化项，不是本次无回复故障；它会影响首次加载速度，但不会阻止服务端事件流回复。

## 六、后续观察指标

建议继续关注以下四个时间点，而不是只看“连接模型”：

1. `model_request_started`：服务开始请求模型
2. `agent_started/turn_started`：派 Agent Loop 开始
3. assistant `message_start/text_start/thinking_start`：provider 首次返回 assistant 流
4. `assistant_final/run_finished`：回复和 Run 完成

如果第 2 到第 3 步长期没有事件，优先检查 provider 网络、授权、模型端点或模型冷启动；如果第 3 步已经出现但界面没有内容，则检查服务端事件游标、前端气泡恢复和最终文本处理。
