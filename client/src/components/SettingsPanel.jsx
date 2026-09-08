import React, { useState, useCallback, useEffect } from "react";
import Icon from "./Icon.jsx";
import { useTheme, SKINS } from "../theme.jsx";
import { agentAuth, agentAuthSave, agentAuthRemove, archiveProject, classifyProjects, createProject, mapSettings, mapSettingsSave, pinProject, probeAgentModel, refreshModels, updateProject, updateProjectSettings } from "../api.js";

/**
 * 设置面板（左侧栏底部 tab）
 * 外观 / 对话行为 / 模型 / 服务集成 / 高级
 * 持久化到 localStorage `oaw_settings`（组件通过 useSetting 读取）
 */
const SETTINGS_KEY = "oaw_settings";
const DEFAULT_SETTINGS = {
  theme: null, // null = 跟随当前主题按钮
  msgFontSize: "medium", // small | medium | large
  commentHighlightMs: 20000, // 批注高亮时长
  thinkingDefaultOpen: false, // 思考块默认展开
  showTimeline: true, // 消息目录栏
};

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function useSetting(key) {
  const [v, setV] = useState(() => loadSettings()[key]);
  const set = useCallback((next) => {
    setV(next);
    try {
      const s = loadSettings();
      s[key] = next;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch {}
  }, [key]);
  return [v, set];
}

const FONT_OPTIONS = [
  { id: "small", label: "小", size: 12 },
  { id: "medium", label: "中", size: 13 },
  { id: "large", label: "大", size: 14 },
];

const PROJECT_TYPES = ["交通规划", "GIS / 地图分析", "调研报告", "Office 文档", "数据分析", "综合项目", "资料库"];
const PROJECT_STATUSES = ["进行中", "待整理", "已完成", "已归档", "模板项目"];
const PROJECT_PROFILES = ["通用 Agent", "创作", "研究", "Office", "GIS", "数据分析"];
const PROVIDER_LABELS = {
  anthropic: "Anthropic（Claude）",
  openai: "OpenAI",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  moonshot: "Moonshot",
  qwen: "Qwen（通义）",
  "opencode-go": "OpenCode Go",
  "minimax-cn": "MiniMax 国内",
  "xiaomi-token-plan-cn": "小米 Token Plan",
  "openai-codex": "OpenAI Codex",
  custom: "自定义",
};
const PROFILE_POLICY_HINTS = {
  "通用 Agent": "完整工具链 · 标准推理 · 64K 上下文",
  "创作": "模板与 Office 产出优先 · 48K 上下文",
  "研究": "知识库与引用优先 · 深度推理 · 96K 上下文",
  Office: "Office CLI 优先 · 文档写入前确认",
  GIS: "地图与空间分析优先 · 图层写入前确认",
  "数据分析": "数据校验与图表产出优先 · 深度推理",
};

function ProjectSettingsSection({ project, projects = [], currentWorkspace = "", models = [], onProjectUpdated, onProjectSelect }) {
  const [projectDraft, setProjectDraft] = useState({ name: "", type: "综合项目", status: "进行中", description: "" });
  const [settingsDraft, setSettingsDraft] = useState({ defaultModel: "", agentProfile: "通用 Agent", skills: [], memoryPolicy: "approval_required", artifactPolicy: "validation_required" });
  const [projectFilter, setProjectFilter] = useState({ query: "", type: "", status: "", pinned: false, pending: false, sort: "recent" });
  const [createOpen, setCreateOpen] = useState(false);
  const [newProject, setNewProject] = useState({ name: "", rootPath: currentWorkspace, type: "综合项目", status: "进行中", description: "" });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [classifying, setClassifying] = useState(false);

  useEffect(() => {
    setProjectDraft({
      name: project?.name || "",
      type: project?.type || "综合项目",
      status: project?.status || "进行中",
      description: project?.description || "",
    });
    setSettingsDraft({
      defaultModel: project?.settings?.defaultModel || "",
      agentProfile: project?.settings?.agentProfile || "通用 Agent",
      skills: Array.isArray(project?.settings?.skills) ? project.settings.skills : [],
      memoryPolicy: project?.settings?.memoryPolicy || "approval_required",
      artifactPolicy: project?.settings?.artifactPolicy || "validation_required",
    });
  }, [project]);

  useEffect(() => {
    setNewProject((value) => ({ ...value, rootPath: value.rootPath || currentWorkspace }));
  }, [currentWorkspace]);

  const visibleProjects = projects
    .filter((item) => !projectFilter.query || `${item.name} ${item.description} ${item.rootPath}`.toLowerCase().includes(projectFilter.query.toLowerCase()))
    .filter((item) => !projectFilter.type || item.type === projectFilter.type)
    .filter((item) => !projectFilter.status || item.status === projectFilter.status)
    .filter((item) => !projectFilter.pinned || item.pinned)
    .filter((item) => !projectFilter.pending || item.pendingMemoryCount > 0 || item.unresolvedRunCount > 0)
    .sort((a, b) => projectFilter.sort === "name"
      ? String(a.name || "").localeCompare(String(b.name || ""))
      : String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  const saveProject = async () => {
    if (!project?.id || !projectDraft.name.trim() || saving) return;
    setSaving(true);
    setMessage("");
    try {
      await updateProject(project.id, projectDraft);
      await updateProjectSettings(project.id, { ...settingsDraft, skills: settingsDraft.skills });
      setMessage("项目设置已保存");
      onProjectUpdated?.();
    } catch (error) {
      setMessage(`保存失败：${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleProjectArchive = async () => {
    if (!project?.id || saving) return;
    setSaving(true);
    try {
      await archiveProject(project.id, project.status !== "已归档");
      setMessage(project.status === "已归档" ? "项目已恢复" : "项目已归档");
      onProjectUpdated?.();
    } catch (error) { setMessage(`状态更新失败：${error.message}`); }
    finally { setSaving(false); }
  };

  const toggleProjectPin = async () => {
    if (!project?.id || saving) return;
    setSaving(true);
    try {
      await pinProject(project.id, !project.pinned);
      setMessage(project.pinned ? "项目已取消置顶" : "项目已置顶");
      onProjectUpdated?.();
    } catch (error) { setMessage(`置顶失败：${error.message}`); }
    finally { setSaving(false); }
  };

  const create = async () => {
    if (!newProject.name.trim() || !newProject.rootPath.trim() || saving) return;
    setSaving(true);
    setMessage("");
    try {
      const result = await createProject(newProject);
      setCreateOpen(false);
      setNewProject({ name: "", rootPath: currentWorkspace, type: "综合项目", status: "进行中", description: "" });
      onProjectUpdated?.();
      if (result.project?.id) onProjectSelect?.(result.project.id);
      setMessage(result.existing ? "该工作区已有项目，已切换到现有项目" : "项目已创建");
    } catch (error) { setMessage(`创建失败：${error.message}`); }
    finally { setSaving(false); }
  };

  const classify = async () => {
    if (classifying) return;
    setClassifying(true);
    setMessage("");
    try {
      const preview = await classifyProjects(false);
      const changes = (preview.changes || []).filter((item) => item.changed);
      if (!changes.length) {
        setMessage("没有可自动判断的项目，已保留现有分类");
        return;
      }
      const result = await classifyProjects(true);
      setMessage(`已按项目名称归类 ${result.changed || changes.length} 个项目`);
      onProjectUpdated?.();
    } catch (error) {
      setMessage(`自动归类失败：${error.message}`);
    } finally {
      setClassifying(false);
    }
  };

  return (
    <div className="project-settings-section">
      <div className="sp-section-title"><Icon name="folder" size={12} /> 项目管理</div>
      <div className="project-management-toolbar">
        <input className="sp-input" placeholder="搜索项目、描述或路径" value={projectFilter.query} onChange={(e) => setProjectFilter((value) => ({ ...value, query: e.target.value }))} />
        <select className="sp-select" value={projectFilter.type} onChange={(e) => setProjectFilter((value) => ({ ...value, type: e.target.value }))}><option value="">全部类型</option>{PROJECT_TYPES.map((item) => <option key={item}>{item}</option>)}</select>
        <select className="sp-select" value={projectFilter.status} onChange={(e) => setProjectFilter((value) => ({ ...value, status: e.target.value }))}><option value="">全部状态</option>{PROJECT_STATUSES.map((item) => <option key={item}>{item}</option>)}</select>
            <select className="sp-select" value={projectFilter.sort} onChange={(e) => setProjectFilter((value) => ({ ...value, sort: e.target.value }))}><option value="recent">最近活跃</option><option value="name">名称</option></select>
            <label className="sp-check-label"><input type="checkbox" checked={projectFilter.pinned} onChange={(e) => setProjectFilter((value) => ({ ...value, pinned: e.target.checked }))} /> 置顶</label>
            <label className="sp-check-label"><input type="checkbox" checked={projectFilter.pending} onChange={(e) => setProjectFilter((value) => ({ ...value, pending: e.target.checked }))} /> 待处理</label>
        <button className="btn-sm" onClick={classify} disabled={classifying}><Icon name="flow" size={12} /> {classifying ? "归类中…" : "自动归类"}</button>
        <button className="btn-sm primary" onClick={() => setCreateOpen((value) => !value)}><Icon name="plus" size={12} /> 新建项目</button>
      </div>
      {createOpen && (
        <div className="project-create-form">
          <input className="sp-input" placeholder="项目名称" value={newProject.name} onChange={(e) => setNewProject((value) => ({ ...value, name: e.target.value }))} />
          <input className="sp-input" placeholder="项目工作区绝对路径" value={newProject.rootPath} onChange={(e) => setNewProject((value) => ({ ...value, rootPath: e.target.value }))} />
          <select className="sp-select" value={newProject.type} onChange={(e) => setNewProject((value) => ({ ...value, type: e.target.value }))}>{PROJECT_TYPES.map((item) => <option key={item}>{item}</option>)}</select>
          <select className="sp-select" value={newProject.status} onChange={(e) => setNewProject((value) => ({ ...value, status: e.target.value }))}>{PROJECT_STATUSES.map((item) => <option key={item}>{item}</option>)}</select>
          <input className="sp-input" placeholder="项目说明（可选）" value={newProject.description} onChange={(e) => setNewProject((value) => ({ ...value, description: e.target.value }))} />
          <button className="btn-sm primary" onClick={create} disabled={saving}>创建</button>
        </div>
      )}
      <div className="project-management-list">
        {visibleProjects.map((item) => (
          <button key={item.id} className={`project-management-item ${item.id === project?.id ? "active" : ""}`} onClick={() => onProjectSelect?.(item.id)}>
            <span className="project-management-item-main"><strong>{item.pinned ? "★ " : ""}{item.name}</strong><small>{item.type} · {item.status} · 会话 {item.sessionCount || 0} · 任务 {item.runCount || 0}</small></span>
            <span className="project-management-item-count">{item.pendingMemoryCount ? `待沉淀 ${item.pendingMemoryCount}` : ""}</span>
          </button>
        ))}
        {!visibleProjects.length && <div className="empty">没有匹配的项目</div>}
      </div>
      {project ? (
        <>
          <div className="sp-row project-settings-row"><span className="sp-label">当前项目</span><strong>{project.name}</strong><button className="btn-xs" onClick={toggleProjectPin} disabled={saving}>{project.pinned ? "取消置顶" : "置顶"}</button><button className="btn-xs" onClick={toggleProjectArchive} disabled={saving}>{project.status === "已归档" ? "恢复项目" : "归档项目"}</button></div>
          <div className="sp-row"><span className="sp-label">项目名称</span><input className="sp-input" value={projectDraft.name} onChange={(e) => setProjectDraft((value) => ({ ...value, name: e.target.value }))} /></div>
          <div className="sp-row"><span className="sp-label">项目类型</span><select className="sp-select" value={projectDraft.type} onChange={(e) => setProjectDraft((value) => ({ ...value, type: e.target.value }))}>{PROJECT_TYPES.map((item) => <option key={item}>{item}</option>)}</select><span className="sp-label">项目状态</span><select className="sp-select" value={projectDraft.status} onChange={(e) => setProjectDraft((value) => ({ ...value, status: e.target.value }))}>{PROJECT_STATUSES.map((item) => <option key={item}>{item}</option>)}</select></div>
          <div className="sp-row"><span className="sp-label">项目说明</span><textarea className="sp-textarea" value={projectDraft.description} onChange={(e) => setProjectDraft((value) => ({ ...value, description: e.target.value }))} /></div>
          <div className="sp-section-title project-runtime-title"><Icon name="robot" size={12} /> 项目运行设置</div>
          <div className="sp-row"><span className="sp-label">默认模型</span><select className="sp-select" value={settingsDraft.defaultModel} onChange={(e) => setSettingsDraft((value) => ({ ...value, defaultModel: e.target.value }))}><option value="">跟随系统默认</option>{models.map((item) => <option key={`${item.provider || "model"}/${item.id}`} value={item.id}>{item.id}</option>)}</select></div>
           <div className="sp-row"><span className="sp-label">Agent Profile</span><select className="sp-select" value={settingsDraft.agentProfile} onChange={(e) => setSettingsDraft((value) => ({ ...value, agentProfile: e.target.value }))}>{PROJECT_PROFILES.map((item) => <option key={item}>{item}</option>)}</select><span className="sp-note-inline">{PROFILE_POLICY_HINTS[settingsDraft.agentProfile] || "按任务选择工具链"}</span></div>
          <div className="sp-row"><span className="sp-label">允许 Skills</span><input className="sp-input" placeholder="skill-a, skill-b（留空表示按需）" value={settingsDraft.skills.join(", ")} onChange={(e) => setSettingsDraft((value) => ({ ...value, skills: e.target.value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean) }))} /></div>
          <div className="sp-row"><span className="sp-label">记忆策略</span><select className="sp-select" value={settingsDraft.memoryPolicy} onChange={(e) => setSettingsDraft((value) => ({ ...value, memoryPolicy: e.target.value }))}><option value="approval_required">必须审核后沉淀</option><option value="manual">仅手动维护</option></select><span className="sp-label">成果策略</span><select className="sp-select" value={settingsDraft.artifactPolicy} onChange={(e) => setSettingsDraft((value) => ({ ...value, artifactPolicy: e.target.value }))}><option value="validation_required">校验通过后固定</option><option value="manual">仅手动固定</option></select></div>
          <div className="sp-row"><span className="sp-label">操作</span><button className="btn-sm primary" onClick={saveProject} disabled={saving}>{saving ? "保存中…" : "保存项目设置"}</button>{message && <span className="sp-auth-msg">{message}</span>}</div>
        </>
      ) : <div className="empty">请选择一个项目查看设置</div>}
    </div>
  );
}

export default function SettingsPanel({ onReset, project = null, projects = [], currentWorkspace = "", models = [], defaultModel = "", activeModel = "", initialSection = "model", onModelChange, onModelsRefresh, onProjectUpdated, onProjectSelect }) {
  const { theme, setTheme, skin, setSkin } = useTheme();
  const [settingsSection, setSettingsSection] = useState("model");
  const [msgFontSize, setMsgFontSize] = useSetting("msgFontSize");
  const [commentHighlightMs, setCommentHighlightMs] = useSetting("commentHighlightMs");
  const [thinkingDefaultOpen, setThinkingDefaultOpen] = useSetting("thinkingDefaultOpen");
  const [showTimeline, setShowTimeline] = useSetting("showTimeline");
  const [integration, setIntegration] = useState(null);
  const [providers, setProviders] = useState(null);      // {provider: {masked, set}}
  const [authProvider, setAuthProvider] = useState("anthropic");
  const [authKey, setAuthKey] = useState("");
  const [authMsg, setAuthMsg] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [probeLoading, setProbeLoading] = useState(false);
  const [probeMsg, setProbeMsg] = useState("");
  const [modelList, setModelList] = useState(models);
  const [modelRefreshLoading, setModelRefreshLoading] = useState(false);
  const [modelRefreshMsg, setModelRefreshMsg] = useState("");
  const [version, setVersion] = useState("");
  // 底图服务 Key（服务端不回传明文，仅状态）
  const [basemapKeys, setBasemapKeys] = useState({ tianditu: "", maptiler: "", geoapify: "" });
  const [basemapStatus, setBasemapStatus] = useState({ tianditu: false, maptiler: false, geoapify: false });
  const [basemapMsg, setBasemapMsg] = useState("");
  const [basemapSaving, setBasemapSaving] = useState(false);

  useEffect(() => { setModelList(models); }, [models]);
  useEffect(() => {
    if (["appearance", "model", "services", "project", "advanced"].includes(initialSection)) setSettingsSection(initialSection);
  }, [initialSection]);

  const availableModels = modelList.length ? modelList : models;
  const selectedModelInfo = availableModels.find((item) => item.id === (activeModel || defaultModel)) || null;
  const configuredProviderCount = providers ? Object.keys(providers).length : 0;

  // 消息字体大小 → CSS 变量（.msg 生效）
  useEffect(() => {
    const size = FONT_OPTIONS.find((f) => f.id === msgFontSize)?.size || 13;
    document.documentElement.style.setProperty("--msg-font-size", size + "px");
  }, [msgFontSize]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/status").then((x) => x.json());
        setIntegration(r);
        if (r.version) setVersion("v" + r.version);
      } catch {}
    })();
    // 已配置的 API Key（掩码）
    agentAuth().then((r) => setProviders(r.providers || {})).catch(() => {});
    // 底图服务 Key 状态
    mapSettings()
      .then((r) => {
        const b = r?.basemaps || {};
        setBasemapStatus({ tianditu: !!b.tiandituKey, maptiler: !!b.maptilerKey, geoapify: !!b.geoapifyKey });
      })
      .catch(() => {});
  }, []);

  const saveBasemaps = async () => {
    setBasemapSaving(true);
    try {
      const r = await mapSettingsSave({
        tiandituKey: basemapKeys.tianditu.trim(),
        maptilerKey: basemapKeys.maptiler.trim(),
        geoapifyKey: basemapKeys.geoapify.trim(),
      });
      const b = r?.basemaps || {};
      setBasemapStatus({ tianditu: !!b.tiandituKey, maptiler: !!b.maptilerKey, geoapify: !!b.geoapifyKey });
      setBasemapKeys({ tianditu: "", maptiler: "", geoapify: "" });
      setBasemapMsg("已保存 ✓ 底图列表已更新，地图需刷新样式（切一次底图或重进地图）");
    } catch (e) {
      setBasemapMsg("保存失败: " + e.message);
    }
    setBasemapSaving(false);
    setTimeout(() => setBasemapMsg(""), 4000);
  };

  const saveAuth = async () => {
    const key = authKey.trim();
    if (!key) { setAuthMsg("请输入 API Key"); return; }
    setAuthLoading(true);
    try {
      await agentAuthSave(authProvider, key);
      const r = await agentAuth();
      setProviders(r.providers || {});
      setAuthKey("");
      setAuthMsg("已保存 ✓");
    } catch (e) {
      setAuthMsg("保存失败: " + e.message);
    }
    setAuthLoading(false);
    setTimeout(() => setAuthMsg(""), 2500);
  };

  const removeAuth = async (provider) => {
    if (!confirm(`删除 ${provider} 的 API Key？`)) return;
    await agentAuthRemove(provider).catch(() => {});
    const r = await agentAuth();
    setProviders(r.providers || {});
  };

  const providerOptions = [...new Set([
    ...availableModels.map((item) => item.provider).filter(Boolean),
    ...Object.keys(providers || {}),
    "anthropic", "openai", "gemini", "deepseek", "moonshot", "qwen", "custom",
  ])];

  useEffect(() => {
    if (!providerOptions.includes(authProvider)) setAuthProvider(providerOptions[0] || "custom");
  }, [authProvider, providerOptions.join("|")]);

  const refreshModelCatalog = async () => {
    if (modelRefreshLoading) return;
    setModelRefreshLoading(true);
    setModelRefreshMsg("正在读取 Pi 模型目录…");
    try {
      const result = onModelsRefresh ? await onModelsRefresh() : await refreshModels();
      const nextModels = result?.models || [];
      setModelList(nextModels);
      setModelRefreshMsg(`已更新 · ${nextModels.length} 个模型`);
    } catch (error) {
      setModelRefreshMsg(`读取失败 · ${error.message}`);
    } finally {
      setModelRefreshLoading(false);
    }
  };

  const probe = async () => {
    const target = String(activeModel || defaultModel || "").trim();
    if (!target || probeLoading) {
      if (!target) setProbeMsg("请先选择模型");
      return;
    }
    setProbeLoading(true);
    setProbeMsg("正在测试真实模型链路…");
    try {
      const result = await probeAgentModel(target, 15000);
      if (result.ok) {
        setProbeMsg(`连接成功 · ${result.latencyMs} ms${result.response?.preview ? ` · ${result.response.preview}` : ""}`);
      } else {
        const detail = result.diagnostic || {};
        setProbeMsg(`连接失败 · ${detail.category || "unknown"} · ${detail.message || "未返回错误"}`);
      }
    } catch (error) {
      setProbeMsg(`连接测试请求失败 · ${error.message}`);
    } finally {
      setProbeLoading(false);
    }
  };

  const resetAll = () => {
    if (!confirm("确定恢复默认设置并清空界面状态？将刷新页面。")) return;
    try {
      localStorage.removeItem("oaw_settings");
      localStorage.removeItem("oaw_ui_state_v1");
    } catch {}
    onReset?.();
    window.location.reload();
  };

  return (
    <div className="settings-panel">
      <div className="settings-overview">
        <div className="settings-overview-heading">
          <div>
            <span className="settings-eyebrow">工作台配置中心</span>
            <h3>设置与运行状态</h3>
            <p>模型、外观、项目记忆和服务能力在这里统一管理。</p>
          </div>
          <span className="settings-runtime-badge"><Icon name="robot" size={12} /> Pi 内核 {integration?.piPackageVersion || "0.85.1"}</span>
        </div>
        <div className="settings-status-grid">
          <button type="button" className={`settings-status-card ${settingsSection === "model" ? "active" : ""}`} onClick={() => setSettingsSection("model")}>
            <span className="settings-status-icon"><Icon name="robot" size={15} /></span>
            <span><small>Agent 模型</small><strong>{selectedModelInfo?.name || selectedModelInfo?.id || activeModel || defaultModel || "未选择"}</strong><em>{selectedModelInfo?.provider || "等待配置"}</em></span>
          </button>
          <button type="button" className={`settings-status-card ${settingsSection === "appearance" ? "active" : ""}`} onClick={() => setSettingsSection("appearance")}>
            <span className="settings-status-icon"><Icon name="sun" size={15} /></span>
            <span><small>界面外观</small><strong>{theme === "dark" ? "暗色" : "亮色"} · {SKINS.find((item) => item.id === skin)?.label || "默认"}</strong><em>字体与对话显示</em></span>
          </button>
          <button type="button" className={`settings-status-card ${settingsSection === "project" ? "active" : ""}`} onClick={() => setSettingsSection("project")}>
            <span className="settings-status-icon"><Icon name="folder" size={15} /></span>
            <span><small>当前项目</small><strong>{project?.name || "未建立项目"}</strong><em>{configuredProviderCount ? `${configuredProviderCount} 个凭据已配置` : "项目与记忆策略"}</em></span>
          </button>
        </div>
      </div>
      <nav className="settings-section-nav" aria-label="设置分类">
        {[
          ["appearance", "外观与对话"],
          ["model", "模型与连接"],
          ["services", "服务集成"],
          ["project", "项目设置与记忆"],
          ["advanced", "命令面板与高级"],
        ].map(([id, label]) => (
          <button key={id} className={settingsSection === id ? "active" : ""} onClick={() => setSettingsSection(id)}>{label}</button>
        ))}
      </nav>

      {settingsSection === "project" && <ProjectSettingsSection
        project={project}
        projects={projects}
        currentWorkspace={currentWorkspace}
        models={models}
        onProjectUpdated={onProjectUpdated}
        onProjectSelect={onProjectSelect}
      />}

      {settingsSection === "appearance" && <>
      <div className="sp-section" id="settings-appearance">
        <div className="sp-section-title"><Icon name="sun" size={12} /> 外观</div>
        <div className="sp-row">
          <span className="sp-label">主题</span>
          <div className="sp-options">
            <button className={`sp-opt ${theme === "dark" ? "active" : ""}`} onClick={() => setTheme("dark")}>暗色</button>
            <button className={`sp-opt ${theme === "light" ? "active" : ""}`} onClick={() => setTheme("light")}>亮色</button>
          </div>
        </div>
        <div className="sp-row">
          <span className="sp-label">皮肤</span>
          <div className="sp-options sp-skins">
            {SKINS.map((s) => (
              <button
                key={s.id}
                className={`sp-opt sp-skin ${skin === s.id ? "active" : ""}`}
                onClick={() => setSkin(s.id)}
                title={s.label}
              >
                <i className={`skin-dot skin-${s.id}`} />
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div className="sp-row">
          <span className="sp-label">消息字体</span>
          <div className="sp-options">
            {FONT_OPTIONS.map((f) => (
              <button key={f.id} className={`sp-opt ${msgFontSize === f.id ? "active" : ""}`} onClick={() => setMsgFontSize(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="sp-row">
          <span className="sp-label">批注高亮</span>
          <input
            type="range"
            min={5}
            max={60}
            step={5}
            value={Math.round(commentHighlightMs / 1000)}
            onChange={(e) => setCommentHighlightMs(Number(e.target.value) * 1000)}
            className="sp-range"
          />
          <span className="sp-val">{Math.round(commentHighlightMs / 1000)}s</span>
        </div>
      </div>

      <div className="sp-section" id="settings-conversation">
        <div className="sp-section-title"><Icon name="tool" size={12} /> 对话行为</div>
        <div className="sp-row">
          <span className="sp-label">思考块默认展开</span>
          <input type="checkbox" checked={!!thinkingDefaultOpen} onChange={(e) => setThinkingDefaultOpen(e.target.checked)} />
        </div>
        <div className="sp-row">
          <span className="sp-label">消息目录栏</span>
          <input type="checkbox" checked={showTimeline !== false} onChange={(e) => setShowTimeline(e.target.checked)} />
        </div>
      </div>
      </>}

      {settingsSection === "model" && <div className="sp-section model-settings-section" id="settings-model">
        <div className="sp-section-title"><Icon name="robot" size={12} /> 模型与连接</div>
        <div className="model-settings-intro">
          <div><strong>让 Agent 先连通，再开始工作</strong><p>模型目录由 Pi 运行时提供。切换模型只影响当前会话，不会改动历史会话。</p></div>
          <button className="btn-sm" onClick={refreshModelCatalog} disabled={modelRefreshLoading}><Icon name="refresh" size={12} /> {modelRefreshLoading ? "刷新中…" : "刷新目录"}</button>
        </div>
        <div className="model-control-grid">
          <div className="model-control-card">
            <span className="model-card-label">当前 Agent 模型</span>
            <select className="sp-select model-select" value={activeModel || ""} onChange={(e) => onModelChange?.(e.target.value)}>
              {!availableModels.length && <option value="">模型列表加载中…</option>}
              {availableModels.length > 0 && <option value="">跟随系统默认 · {defaultModel || "未设置"}</option>}
              {availableModels.map((item) => <option key={`${item.provider || "model"}/${item.id}`} value={item.id} disabled={item.available === false}>{item.provider ? `${PROVIDER_LABELS[item.provider] || item.provider} / ` : ""}{item.name || item.id}{item.available === false ? "（不可用）" : item.vision ? " · 支持图片" : ""}</option>)}
            </select>
            <div className="model-card-meta">
              <span className={`sp-badge ${selectedModelInfo?.available === false ? "warn" : selectedModelInfo ? "ok" : "warn"}`}>{selectedModelInfo?.available === false ? "不可用" : selectedModelInfo ? "目录可用" : "待配置"}</span>
              {selectedModelInfo?.contextWindow && <span>上下文 {Number(selectedModelInfo.contextWindow).toLocaleString()} tokens</span>}
              {selectedModelInfo?.vision && <span>支持图片</span>}
            </div>
            <button className="btn-sm primary model-probe-btn" onClick={probe} disabled={!(activeModel || defaultModel) || probeLoading}><Icon name="flow" size={12} /> {probeLoading ? "测试中…" : "测试真实连接"}</button>
          </div>
          <div className="model-runtime-card">
            <span className="model-card-label">运行时状态</span>
            <div className="model-runtime-status"><i className="status-dot" /> <strong>Pi Agent Runtime</strong><span>嵌入式</span></div>
            <p>凭据保存在服务端安全边界内，页面只显示掩码；模型请求不会把 API Key 写入会话。</p>
            <div className="model-runtime-version">SDK {integration?.piPackageVersion || "0.85.1"} · Node 22+</div>
          </div>
        </div>
        {(probeMsg || modelRefreshMsg) && <div className="model-feedback">{probeMsg || modelRefreshMsg}</div>}
        <div className="model-credentials-card">
          <div className="model-credentials-head"><div><strong>供应商凭据</strong><p>仅填写当前使用的 Provider；保存后可用“测试真实连接”验证。</p></div><span className={`sp-badge ${configuredProviderCount ? "ok" : "warn"}`}>{configuredProviderCount ? `${configuredProviderCount} 个已配置` : "尚未配置"}</span></div>
          <div className="sp-auth model-auth-row">
            <select className="sp-select" value={authProvider} onChange={(e) => setAuthProvider(e.target.value)}>
              {providerOptions.map((provider) => <option key={provider} value={provider}>{PROVIDER_LABELS[provider] || provider}</option>)}
            </select>
            <input className="sp-input" type="password" placeholder="粘贴 API Key（不会回显）" value={authKey} onChange={(e) => setAuthKey(e.target.value)} />
            <button className="btn-sm primary" onClick={saveAuth} disabled={authLoading}>{authLoading ? "保存中…" : "保存凭据"}</button>
            {authMsg && <span className="sp-auth-msg">{authMsg}</span>}
          </div>
          {providers && Object.keys(providers).length > 0 && <div className="sp-auth-list model-auth-list">{Object.entries(providers).map(([p, v]) => <span key={p} className="sp-auth-item"><Icon name="check" size={11} /><code>{PROVIDER_LABELS[p] || p}</code> {v.masked}<button className="btn-xs" onClick={() => removeAuth(p)} title={`删除 ${p} 凭据`}>删除</button></span>)}</div>}
        </div>
        <div className="sp-note">模型目录来自 Pi；连接测试只发送最小请求，不写入会话。若出现“已接收信息”长时间无响应，先在这里刷新目录并测试真实连接，再开始 Agent 任务。</div>
      </div>}

      {settingsSection === "services" && <>
      <div className="sp-section" id="settings-basemap">
        <div className="sp-section-title"><Icon name="map" size={12} /> 底图服务</div>
        <div className="sp-row">
          <span className="sp-label">天地图 Key</span>
          <input
            className="sp-input"
            type="password"
            placeholder="天地图 tk（https://console.tianditu.gov.cn 申请）"
            value={basemapKeys.tianditu}
            onChange={(e) => setBasemapKeys((s) => ({ ...s, tianditu: e.target.value }))}
          />
          <span className={`sp-badge ${basemapStatus.tianditu ? "ok" : "warn"}`}>
            {basemapStatus.tianditu ? "已配置" : "未配置"}
          </span>
        </div>
        <div className="sp-row">
          <span className="sp-label">MapTiler Key</span>
          <input
            className="sp-input"
            type="password"
            placeholder="MapTiler key（https://cloud.maptiler.com 申请）"
            value={basemapKeys.maptiler}
            onChange={(e) => setBasemapKeys((s) => ({ ...s, maptiler: e.target.value }))}
          />
          <span className={`sp-badge ${basemapStatus.maptiler ? "ok" : "warn"}`}>
            {basemapStatus.maptiler ? "已配置" : "未配置"}
          </span>
        </div>
        <div className="sp-row">
          <span className="sp-label">Geoapify Key</span>
          <input
            className="sp-input"
            type="password"
            placeholder="Geoapify API key（用于等时圈）"
            value={basemapKeys.geoapify}
            onChange={(e) => setBasemapKeys((s) => ({ ...s, geoapify: e.target.value }))}
          />
          <span className={`sp-badge ${basemapStatus.geoapify ? "ok" : "warn"}`}>
            {basemapStatus.geoapify ? "已配置" : "未配置"}
          </span>
        </div>
        <div className="sp-row">
          <span className="sp-label">操作</span>
          <button className="btn-sm primary" onClick={saveBasemaps} disabled={basemapSaving}>
            {basemapSaving ? "保存中…" : "保存底图配置"}
          </button>
          {basemapMsg && <span className="sp-auth-msg">{basemapMsg}</span>}
        </div>
        <div className="sp-note">
          输入 Key 后保存即启用对应底图或等时圈服务；输入框留空保存 = 清除该 Key（对应功能随之停用）。
          高德（路网/卫星/注记）与 Esri（卫星/街道）始终可用，无需 Key。
        </div>
      </div>

      <div className="sp-section" id="settings-services">
        <div className="sp-section-title"><Icon name="cloud" size={12} /> 服务集成</div>
        <div className="sp-row">
          <span className="sp-label">officecli</span>
          <span className={`sp-badge ${integration?.officecli ? "ok" : "warn"}`}>
            {integration?.officecli ? integration.officecli : "未检测到"}
          </span>
        </div>
        <div className="sp-row">
          <span className="sp-label">Geoapify 等时圈</span>
          <span className={`sp-badge ${basemapStatus.geoapify ? "ok" : "warn"}`}>
            {basemapStatus.geoapify ? "已配置" : "未配置"}
          </span>
        </div>
        <div className="sp-row">
          <span className="sp-label">IMA 知识库</span>
          <span className="sp-badge warn">需凭证</span>
        </div>
        <div className="sp-note">等时圈优先使用 Geoapify Key，也兼容服务端 AMAP_KEY；Key 保存后立即生效。</div>
      </div>
      </>}

      {settingsSection === "advanced" && <div className="sp-section" id="settings-advanced">
        <div className="sp-section-title"><Icon name="menu" size={12} /> 高级</div>
        <div className="sp-note">命令面板：按 Ctrl/Cmd+K，或点击左侧顶部搜索按钮打开。</div>
        <button className="sp-danger" onClick={resetAll}>重置界面状态与设置</button>
        <div className="sp-note">版本 {version || "v0.10.0"}</div>
      </div>
      }
    </div>
  );
}
