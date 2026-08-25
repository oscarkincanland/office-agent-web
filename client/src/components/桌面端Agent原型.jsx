import React, { useMemo, useState } from "react";
import Icon from "./Icon.jsx";
import "./桌面端Agent原型.css";

const NAV_ITEMS = [
  { id: "workbench", label: "工作台", icon: "grid", hint: "当前任务" },
  { id: "runs", label: "运行记录", icon: "history", hint: "可恢复执行" },
  { id: "providers", label: "模型与供应商", icon: "globe", hint: "连接状态" },
  { id: "plugins", label: "插件中心", icon: "tool", hint: "能力与权限" },
];

const SKINS = [
  { id: "night", label: "夜航控制台", desc: "深色运行视图", colors: ["#d8ff4d", "#091018"] },
  { id: "paper", label: "暖白规划稿", desc: "适合长时间阅读", colors: ["#577c3c", "#f4f0e6"] },
  { id: "blueprint", label: "蓝图地图作业", desc: "偏 GIS 和数据分析", colors: ["#73c7ff", "#081725"] },
  { id: "terminal", label: "终端信号站", desc: "高密度工程操作", colors: ["#9cff59", "#061312"] },
];

const SESSIONS = [
  { id: "transport", title: "县域综合交通规划", meta: "报告 · 12分钟前", status: "running", accent: "lime" },
  { id: "map", title: "浙江省路网诊断", meta: "地图 · 昨天 16:40", status: "done", accent: "cyan" },
  { id: "od", title: "龙港公交 OD 分析", meta: "数据 · 周一", status: "done", accent: "orange" },
];

const INITIAL_EVENTS = [
  { id: "e1", type: "user", title: "我", body: "请基于现有资料，整理县域综合交通规划的现状诊断章节，并标出还缺哪些数据。", time: "10:42" },
  { id: "e2", type: "assistant", title: "规划研究 Agent", body: "我先读取工作区中的规划资料，再按“资料—知识—分析—成果”拆解任务。当前使用 Office + 知识库工具包。", time: "10:42", tags: ["任务拆解", "资料检索"] },
  { id: "e3", type: "tool", title: "读取工作区", body: "已扫描 28 个文件，识别出 6 份核心资料、3 个数据表和 2 个历史成果。", time: "10:43", tool: "workspace.scan", result: "28 个文件", tone: "cyan" },
  { id: "e4", type: "tool", title: "检索知识库", body: "命中《交通报告写作规范》和 4 条相关规划案例，正在生成章节结构。", time: "10:43", tool: "knowledge.search", result: "5 条引用", tone: "lime" },
];

const PLANS = [
  { label: "扫描工作区和当前文件", done: true },
  { label: "检索报告规范与历史案例", done: true },
  { label: "建立现状诊断章节骨架", done: false, active: true },
  { label: "标注缺失数据和待核实假设", done: false },
  { label: "输出 Markdown 初稿", done: false },
];

const FILES = [
  { name: "项目资料", type: "folder", count: "18项" },
  { name: "交通调查数据.xlsx", type: "xls", count: "已引用" },
  { name: "交通报告写作规范知识库.html", type: "html", count: "已引用" },
  { name: "现状诊断章节.md", type: "md", count: "生成中" },
];

const ARTIFACTS = [
  { title: "现状诊断章节.md", meta: "Markdown · 24 KB", icon: "md", tone: "paper" },
  { title: "资料引用清单.xlsx", meta: "Excel · 8 KB", icon: "xls", tone: "cyan" },
];

function StatusDot({ tone = "lime" }) {
  return <span className={`dp-status-dot dp-status-${tone}`} aria-hidden="true" />;
}

function WindowButton({ label, children }) {
  return <button className="dp-window-button" aria-label={label}>{children}</button>;
}

function EventItem({ event }) {
  return (
    <article className={`dp-event dp-event-${event.type}`}>
      <div className="dp-event-rail">
        <span className={`dp-event-icon dp-event-icon-${event.type}`}>
          <Icon name={event.type === "user" ? "user" : event.type === "tool" ? "tool" : "robot"} size={14} />
        </span>
        <span className="dp-event-line" />
      </div>
      <div className="dp-event-content">
        <div className="dp-event-head">
          <span className="dp-event-title">{event.title}</span>
          {event.tool && <code>{event.tool}</code>}
          <time>{event.time}</time>
        </div>
        <p>{event.body}</p>
        {event.tags && (
          <div className="dp-event-tags">
            {event.tags.map((tag) => <span key={tag}>{tag}</span>)}
          </div>
        )}
        {event.result && (
          <div className={`dp-tool-result dp-tool-result-${event.tone || "lime"}`}>
            <StatusDot tone={event.tone || "lime"} />
            <span>{event.result}</span>
            <span className="dp-result-arrow">↗</span>
          </div>
        )}
      </div>
    </article>
  );
}

function WorkbenchView({ session, events, runState, onRun, input, setInput, selectedModel, setSelectedModel, rightTab, setRightTab }) {
  const [profile, setProfile] = useState("规划研究 Agent");
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const profileOptions = ["规划研究 Agent", "数据分析 Agent", "报告写作 Agent"];

  return (
    <div className="dp-workbench-view">
      <section className="dp-task-banner">
        <div className="dp-eyebrow"><span className="dp-kicker">01</span> CURRENT WORKFLOW</div>
        <div className="dp-task-copy">
          <div>
            <h1>把复杂的规划任务，<em>变成可交付链路。</em></h1>
            <p>从资料读取、知识检索到成果归档，每一步都可见、可停、可恢复。</p>
          </div>
          <div className="dp-task-stat">
            <span>本次运行</span>
            <strong>04:18</strong>
            <small><StatusDot tone="lime" /> 正在执行</small>
          </div>
        </div>
        <div className="dp-task-meta">
          <span><Icon name="folderOpen" size={13} /> {session.title}</span>
          <span><Icon name="map" size={13} /> 浙江省 · 综合交通</span>
          <span><Icon name="info" size={13} /> 本地工作区</span>
        </div>
      </section>

      <div className="dp-content-grid">
        <section className="dp-panel dp-conversation-panel">
          <header className="dp-panel-header dp-agent-header">
            <div className="dp-agent-identity">
              <div className="dp-agent-mark"><Icon name="robot" size={20} /></div>
              <div>
                <div className="dp-panel-title">{profile}</div>
                <div className="dp-panel-subtitle"><StatusDot tone="lime" /> Pi Runtime · 本地会话</div>
              </div>
            </div>
            <div className="dp-agent-actions">
              <div className="dp-profile-select-wrap">
                <button className="dp-ghost-button" onClick={() => setShowProfileMenu((v) => !v)}>
                  <Icon name="layers" size={14} /> Profile <Icon name="chevronDown" size={12} />
                </button>
                {showProfileMenu && (
                  <div className="dp-profile-menu">
                    {profileOptions.map((option) => (
                      <button key={option} className={option === profile ? "is-selected" : ""} onClick={() => { setProfile(option); setShowProfileMenu(false); }}>
                        <StatusDot tone={option === profile ? "lime" : "muted"} /> {option}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button className="dp-icon-button" aria-label="更多操作"><Icon name="menu" size={16} /></button>
            </div>
          </header>

          <div className="dp-run-strip">
            <div><span className="dp-run-label">RUN</span><strong>run_20260821_1042</strong></div>
            <span className="dp-run-time"><Icon name="history" size={12} /> 04:18</span>
            <button className="dp-stop-button" disabled={runState !== "running"}><Icon name="stop" size={12} /> 停止运行</button>
          </div>

          <div className="dp-timeline" aria-live="polite">
            {events.map((event) => <EventItem event={event} key={event.id} />)}
            {runState === "running" && (
              <div className="dp-thinking"><span className="dp-thinking-pulse" /><span>Agent 正在整理章节结构</span><span className="dp-typing"><i /><i /><i /></span></div>
            )}
          </div>

          <div className="dp-composer-wrap">
            <div className="dp-composer-context">
              <span><Icon name="at" size={13} /> 现状诊断章节.md</span>
              <span><Icon name="book" size={13} /> 交通报告规范</span>
              <span className="dp-context-add">+ 添加上下文</span>
            </div>
            <div className="dp-composer">
              <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onRun(); }} placeholder="描述下一步任务，或按 Ctrl + Enter 发送…" rows={2} />
              <div className="dp-composer-footer">
                <div className="dp-composer-tools">
                  <button className="dp-composer-tool"><Icon name="upload" size={14} /> 附件</button>
                  <label className="dp-model-select"><Icon name="cloud" size={13} /><select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)}><option>DeepSeek V3</option><option>GPT-5</option><option>MiniMax M2.5</option></select></label>
                </div>
                <button className="dp-send-button" onClick={onRun} disabled={!input.trim() || runState === "running"}><Icon name="send" size={15} /> {runState === "running" ? "执行中" : "开始执行"}</button>
              </div>
            </div>
            <div className="dp-composer-hint">Agent 可以读取工作区文件并生成成果，敏感操作会在执行前请求确认。</div>
          </div>
        </section>

        <aside className="dp-panel dp-inspector-panel">
          <div className="dp-inspector-tabs">
            {["执行计划", "工作区", "产物"].map((tab) => <button key={tab} className={rightTab === tab ? "is-active" : ""} onClick={() => setRightTab(tab)}>{tab}{tab === "产物" && <span className="dp-tab-count">2</span>}</button>)}
          </div>
          {rightTab === "执行计划" && <div className="dp-inspector-body"><div className="dp-inspector-heading"><div><span className="dp-eyebrow">TASK PLAN</span><h2>现状诊断章节</h2></div><span className="dp-progress-count">2 / 5</span></div><div className="dp-progress-bar"><span style={{ width: "40%" }} /></div><div className="dp-plan-list">{PLANS.map((item) => <div className={`dp-plan-item ${item.done ? "is-done" : ""} ${item.active ? "is-active" : ""}`} key={item.label}><span className="dp-plan-check">{item.done ? <Icon name="check" size={12} /> : item.active ? <span className="dp-plan-pulse" /> : null}</span><span>{item.label}</span></div>)}</div><div className="dp-note-card"><span className="dp-note-index">NOTE</span><p>发现 2 个数据口径需要确认，暂不阻塞章节骨架生成。</p><button>查看问题 <Icon name="chevronRight" size={12} /></button></div></div>}
          {rightTab === "工作区" && <div className="dp-inspector-body"><div className="dp-inspector-heading"><div><span className="dp-eyebrow">WORKSPACE</span><h2>规聚项目</h2></div><button className="dp-icon-button"><Icon name="refresh" size={14} /></button></div><div className="dp-file-list">{FILES.map((file) => <div className="dp-file-item" key={file.name}><Icon name={file.type} size={16} /><div><strong>{file.name}</strong><small>{file.count}</small></div><Icon name="chevronRight" size={12} /></div>)}</div><div className="dp-workspace-foot"><StatusDot tone="cyan" /> 已同步 · 28 个文件</div></div>}
          {rightTab === "产物" && <div className="dp-inspector-body"><div className="dp-inspector-heading"><div><span className="dp-eyebrow">ARTIFACTS</span><h2>本次运行产物</h2></div><span className="dp-progress-count">2 files</span></div><div className="dp-artifact-list">{ARTIFACTS.map((artifact) => <div className={`dp-artifact-card dp-artifact-${artifact.tone}`} key={artifact.title}><div className="dp-artifact-icon"><Icon name={artifact.icon} size={18} /></div><div><strong>{artifact.title}</strong><small>{artifact.meta}</small></div><button className="dp-icon-button"><Icon name="download" size={14} /></button></div>)}</div><div className="dp-paper-preview"><div className="dp-paper-topline" /><div className="dp-paper-title">现状诊断</div><div className="dp-paper-line long" /><div className="dp-paper-line" /><div className="dp-paper-line short" /><div className="dp-paper-chart"><span /><span /><span /><span /><span /></div><div className="dp-paper-line" /></div></div>}
        </aside>
      </div>
    </div>
  );
}

function WebWorkspaceView({ session, events, runState, onRun, input, setInput, selectedModel, setSelectedModel, notify }) {
  const [activeFile, setActiveFile] = useState("现状诊断章节.md");
  const recentEvents = events.slice(-3);

  return (
    <div className="dp-web-workspace">
      <aside className="dp-web-sidebar">
        <div className="dp-web-sidebar-head"><div><span className="dp-eyebrow">WEB WORKSPACE</span><h2>规聚项目</h2></div><button className="dp-icon-button" onClick={() => notify("工作区设置将在桌面版接入")}><Icon name="gear" size={15} /></button></div>
        <div className="dp-web-search"><Icon name="search" size={13} /><input placeholder="搜索文件和会话" /></div>
        <div className="dp-web-session-card"><div className="dp-web-section-label">当前会话 <StatusDot tone="lime" /></div><strong>{session.title}</strong><small>规划研究 Agent · {selectedModel}</small><div className="dp-web-session-progress"><span style={{ width: "58%" }} /></div><small>已完成 3 / 5 个步骤</small></div>
        <div className="dp-web-section-label dp-web-files-label"><span>工作区文件</span><button onClick={() => notify("新建文件入口已预留")}>+</button></div>
        <div className="dp-web-file-tree">{FILES.map((file) => <button key={file.name} className={activeFile === file.name ? "is-active" : ""} onClick={() => setActiveFile(file.name)}><Icon name={file.type} size={15} /><span><strong>{file.name}</strong><small>{file.count}</small></span></button>)}</div>
        <div className="dp-web-side-tools"><button onClick={() => notify("知识库模块已关联")}><Icon name="book" size={14} /> 知识库 <span>12</span></button><button onClick={() => notify("模板库模块已关联")}><Icon name="doc" size={14} /> 模板库 <span>8</span></button><button onClick={() => notify("地图模块已关联")}><Icon name="map" size={14} /> 地图分析 <span>3</span></button></div>
      </aside>

      <section className="dp-web-document">
        <div className="dp-web-doc-tabs"><button className="is-active"><Icon name="md" size={14} /> {activeFile}</button><button onClick={() => notify("可继续打开其他文档")}>+ 打开文档</button></div>
        <div className="dp-web-doc-toolbar"><div><span className="dp-web-doc-mode"><Icon name="doc" size={13} /> 文档预览</span><span className="dp-web-doc-divider" /><span className="dp-web-doc-muted">已同步到工作区</span></div><div><button className="dp-icon-button" onClick={() => notify("文档已定位到当前章节")}><Icon name="locate" size={14} /></button><button className="dp-icon-button" onClick={() => notify("导出入口已预留")}><Icon name="download" size={14} /></button></div></div>
        <article className="dp-web-paper">
          <div className="dp-paper-kicker">县域综合交通运输规划 · 现状诊断</div>
          <h1>现状诊断章节</h1>
          <p className="dp-paper-lead">本章基于现有交通调查数据、路网资料和历史规划成果，对区域交通发展基础、问题特征及后续数据需求进行系统梳理。</p>
          <div className="dp-paper-rule" />
          <h3>1. 区域交通发展基础</h3>
          <p>区域路网整体形成以干线公路为骨架、县乡道路为补充的网络结构。现有资料显示，主要通道承担了跨组团通勤、产业运输和旅游出行等复合需求。</p>
          <div className="dp-paper-insight"><span className="dp-paper-insight-label">AGENT NOTE</span><strong>当前段落有 2 条引用，1 个数据口径待确认。</strong><button onClick={() => notify("已打开引用检查器")}>查看引用 <Icon name="chevronRight" size={12} /></button></div>
          <h3>2. 主要问题与数据缺口</h3>
          <div className="dp-paper-metrics"><div><span>核心资料</span><strong>6</strong><small>已读取</small></div><div><span>关联数据表</span><strong>3</strong><small>已引用</small></div><div><span>待核实口径</span><strong className="is-warn">2</strong><small>不阻塞初稿</small></div></div>
          <p>下一步需要补充高峰小时断面流量、公交站点服务半径和重点片区出行分布数据，以支撑问题诊断从定性描述进入定量判断。</p>
          <div className="dp-paper-chart"><div className="dp-chart-y"><span>100</span><span>50</span><span>0</span></div><div className="dp-chart-bars"><i style={{ height: "42%" }} /><i style={{ height: "67%" }} /><i style={{ height: "55%" }} /><i style={{ height: "82%" }} /><i style={{ height: "61%" }} /></div><div className="dp-chart-x"><span>东片区</span><span>中心区</span><span>南片区</span><span>西片区</span><span>北片区</span></div></div>
          <div className="dp-paper-footer"><span>Open Plan · 规划研究 Agent</span><span>第 01 页</span></div>
        </article>
      </section>

      <aside className="dp-web-chat">
        <header className="dp-web-chat-head"><div className="dp-agent-identity"><div className="dp-agent-mark"><Icon name="robot" size={17} /></div><div><div className="dp-panel-title">规划研究 Agent</div><div className="dp-panel-subtitle"><StatusDot tone="lime" /> 对话与执行</div></div></div><button className="dp-icon-button" onClick={() => notify("会话操作已打开")}><Icon name="menu" size={15} /></button></header>
        <div className="dp-web-chat-context"><span><Icon name="md" size={12} /> {activeFile}</span><span><Icon name="book" size={12} /> 规范库</span></div>
        <div className="dp-web-chat-body">{recentEvents.map((event) => <EventItem event={event} key={event.id} />)}{runState === "running" && <div className="dp-thinking"><span className="dp-thinking-pulse" /><span>正在整理…</span></div>}</div>
        <div className="dp-web-composer"><textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onRun(); }} placeholder="继续和 Agent 工作…" rows={2} /><div className="dp-web-composer-foot"><label className="dp-model-select"><Icon name="cloud" size={13} /><select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)}><option>DeepSeek V3</option><option>GPT-5</option><option>MiniMax M2.5</option></select></label><button className="dp-send-button" onClick={onRun} disabled={!input.trim() || runState === "running"}><Icon name="send" size={14} /></button></div></div>
      </aside>
    </div>
  );
}

function SecondaryView({ activeNav }) {
  const viewData = {
    runs: { eyebrow: "RUN HISTORY", title: "每一次执行，都可以被找回。", body: "查看运行耗时、工具链、修改文件和产物；失败任务从中断节点恢复。", cards: ["县域综合交通规划 · 04:18 · 运行中", "浙江省路网诊断 · 12:32 · 已完成", "龙港公交 OD 分析 · 08:46 · 已完成"] },
    providers: { eyebrow: "MODEL REGISTRY", title: "模型和供应商，应该是可管理的基础设施。", body: "统一展示 Pi 模型目录、凭据状态、默认模型和连接测试，不把密钥暴露给前端。", cards: ["DeepSeek V3 · deepseek · 已连接", "GPT-5 · openai · 待配置", "MiniMax M2.5 · minimax-cn · 已连接"] },
    plugins: { eyebrow: "CAPABILITY LAYER", title: "能力按 Profile 组合，权限按风险控制。", body: "把 Office、知识库、地图、报告和数据分析做成可观察的 Tool Pack。", cards: ["规划研究 Agent · 6 个工具", "报告写作 Agent · 4 个工具", "地图分析 Pack · 需要审批"] },
  }[activeNav] || { eyebrow: "OPEN PLAN", title: "工作台", body: "选择左侧模块查看桌面端信息架构。", cards: [] };

  return <section className="dp-secondary-view"><div className="dp-secondary-copy"><span className="dp-eyebrow">{viewData.eyebrow}</span><h1>{viewData.title}</h1><p>{viewData.body}</p><button className="dp-primary-button"><Icon name="plus" size={15} /> 新建配置</button></div><div className="dp-secondary-grid">{viewData.cards.map((card, index) => <div className="dp-secondary-card" key={card}><span className="dp-card-number">0{index + 1}</span><div><strong>{card.split(" · ")[0]}</strong><p>{card.split(" · ").slice(1).join(" · ")}</p></div><Icon name="chevronRight" size={16} /></div>)}</div></section>;
}

export default function DesktopAgentPrototype() {
  const [activeNav, setActiveNav] = useState("workbench");
  const [activeSession, setActiveSession] = useState(SESSIONS[0].id);
  const [railOpen, setRailOpen] = useState(true);
  const [workspaceMode, setWorkspaceMode] = useState("console");
  const [skin, setSkin] = useState(() => { try { return localStorage.getItem("open-plan-prototype-skin") || "night"; } catch { return "night"; } });
  const [skinOpen, setSkinOpen] = useState(false);
  const [events, setEvents] = useState(INITIAL_EVENTS);
  const [input, setInput] = useState("");
  const [selectedModel, setSelectedModel] = useState("DeepSeek V3");
  const [runState, setRunState] = useState("ready");
  const [rightTab, setRightTab] = useState("执行计划");
  const [toast, setToast] = useState("");
  const session = useMemo(() => SESSIONS.find((item) => item.id === activeSession) || SESSIONS[0], [activeSession]);

  const notify = (message) => { setToast(message); window.setTimeout(() => setToast(""), 2200); };

  const changeSkin = (nextSkin) => {
    setSkin(nextSkin);
    setSkinOpen(false);
    try { localStorage.setItem("open-plan-prototype-skin", nextSkin); } catch {}
    notify(`已切换到${SKINS.find((item) => item.id === nextSkin)?.label || "新皮肤"}`);
  };

  const handleRun = () => {
    if (!input.trim() || runState === "running") return;
    const content = input.trim();
    const now = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    setEvents((prev) => [...prev, { id: `user-${Date.now()}`, type: "user", title: "我", body: content, time: now }]);
    setInput("");
    setRunState("running");
    window.setTimeout(() => {
      setEvents((prev) => [...prev, { id: `assistant-${Date.now()}`, type: "assistant", title: "规划研究 Agent", body: `已接收任务。我会使用 ${selectedModel}，先检查当前工作区和相关引用，再给出可审计的执行结果。`, time: now, tags: ["新任务", selectedModel] }]);
      setRunState("ready");
      notify("任务已加入运行时间线");
    }, 850);
  };

  return (
    <div className={`desktop-prototype dp-skin-${skin}`}>
      <header className="dp-windowbar">
        <div className="dp-window-brand"><span className="dp-brand-glyph">O</span><span>OPEN PLAN</span><small>DESKTOP PREVIEW</small></div>
        <div className="dp-window-center"><span className="dp-window-dot" /> 本地工作区 · 规聚项目</div>
        <div className="dp-window-actions"><WindowButton label="最小化">−</WindowButton><WindowButton label="最大化">□</WindowButton><WindowButton label="关闭">×</WindowButton></div>
      </header>
      <div className="dp-app-shell">
        <aside className={`dp-rail ${railOpen ? "is-open" : "is-collapsed"}`}>
          <div className="dp-rail-top"><div className="dp-rail-logo">O<span>PLAN</span></div><button className="dp-rail-toggle" onClick={() => setRailOpen((v) => !v)}><Icon name={railOpen ? "back" : "menu"} size={15} /></button></div>
          <div className="dp-rail-nav">{NAV_ITEMS.map((item) => <button key={item.id} className={`dp-nav-item ${activeNav === item.id ? "is-active" : ""}`} onClick={() => setActiveNav(item.id)} title={item.label}><Icon name={item.icon} size={18} /><span><strong>{item.label}</strong><small>{item.hint}</small></span>{item.id === "runs" && <b>3</b>}</button>)}</div>
          <div className="dp-rail-divider" />
          {railOpen && <div className="dp-recent"><div className="dp-rail-label">最近会话 <button onClick={() => notify("已准备新会话")}>+</button></div>{SESSIONS.map((item) => <button key={item.id} className={`dp-session-item ${activeSession === item.id ? "is-active" : ""}`} onClick={() => { setActiveSession(item.id); setActiveNav("workbench"); }}><span className={`dp-session-bar dp-session-${item.accent}`} /><div><strong>{item.title}</strong><small>{item.meta}</small></div><StatusDot tone={item.status === "running" ? "lime" : "muted"} /></button>)}</div>}
          <div className="dp-rail-bottom"><button className="dp-user-card" onClick={() => notify("个人设置将在桌面版接入") }><span className="dp-avatar">林</span><span><strong>林工</strong><small>本地账户</small></span><Icon name="gear" size={15} /></button></div>
        </aside>
        <main className="dp-main">
          <header className="dp-main-header"><div className="dp-breadcrumb"><span>Open Plan</span><Icon name="chevronRight" size={13} /><strong>{activeNav === "workbench" ? session.title : NAV_ITEMS.find((item) => item.id === activeNav)?.label}</strong></div><div className="dp-main-actions"><div className="dp-view-switch" role="tablist"><button className={workspaceMode === "console" ? "is-active" : ""} onClick={() => setWorkspaceMode("console")}><Icon name="robot" size={13} /> Agent 控制台</button><button className={workspaceMode === "web" ? "is-active" : ""} onClick={() => setWorkspaceMode("web")}><Icon name="doc" size={13} /> 网页工作区</button></div><div className="dp-skin-picker"><button className="dp-skin-trigger" onClick={() => setSkinOpen((v) => !v)}><span className="dp-skin-swatch" style={{ background: SKINS.find((item) => item.id === skin)?.colors[0] }} /><span>{SKINS.find((item) => item.id === skin)?.label}</span><Icon name="chevronDown" size={12} /></button>{skinOpen && <div className="dp-skin-menu">{SKINS.map((item) => <button key={item.id} className={item.id === skin ? "is-selected" : ""} onClick={() => changeSkin(item.id)}><span className="dp-skin-pair"><i style={{ background: item.colors[0] }} /><i style={{ background: item.colors[1] }} /></span><span><strong>{item.label}</strong><small>{item.desc}</small></span>{item.id === skin && <Icon name="check" size={13} />}</button>)}</div>}</div><span className="dp-save-state"><StatusDot tone="lime" /> 已保存</span><button className="dp-icon-button" onClick={() => notify("命令面板快捷键：Ctrl + K")}><Icon name="search" size={16} /></button><button className="dp-icon-button" onClick={() => notify("设置中心将在下一阶段接入")}><Icon name="gear" size={16} /></button></div></header>
          {activeNav === "workbench" ? (workspaceMode === "console" ? <WorkbenchView session={session} events={events} runState={runState} onRun={handleRun} input={input} setInput={setInput} selectedModel={selectedModel} setSelectedModel={setSelectedModel} rightTab={rightTab} setRightTab={setRightTab} /> : <WebWorkspaceView session={session} events={events} runState={runState} onRun={handleRun} input={input} setInput={setInput} selectedModel={selectedModel} setSelectedModel={setSelectedModel} notify={notify} />) : <SecondaryView activeNav={activeNav} />}
        </main>
      </div>
      {toast && <div className="dp-toast"><StatusDot tone="lime" /> {toast}</div>}
    </div>
  );
}
