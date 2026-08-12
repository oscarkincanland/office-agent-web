import React, { useState, useCallback, useEffect } from "react";
import Icon from "./Icon.jsx";
import { useTheme, SKINS } from "../theme.jsx";
import { agentAuth, agentAuthSave, agentAuthRemove } from "../api.js";

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

export default function SettingsPanel({ onReset }) {
  const { theme, setTheme, skin, setSkin } = useTheme();
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
  const [version, setVersion] = useState("");

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
  }, []);

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
      <div className="sp-section">
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

      <div className="sp-section">
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

      <div className="sp-section">
        <div className="sp-section-title"><Icon name="robot" size={12} /> 模型</div>
        <div className="sp-note">默认模型在对话栏输入框下方选择（⚙ 图标），选择结果自动记忆。</div>
        <div className="sp-row">
          <span className="sp-label">API Key</span>
          <div className="sp-auth">
            <select className="sp-select" value={authProvider} onChange={(e) => setAuthProvider(e.target.value)}>
              <option value="anthropic">Anthropic（Claude）</option>
              <option value="openai">OpenAI</option>
              <option value="gemini">Gemini</option>
              <option value="deepseek">DeepSeek</option>
              <option value="moonshot">Moonshot</option>
              <option value="qwen">Qwen（通义）</option>
              <option value="custom">自定义</option>
            </select>
            <input
              className="sp-input"
              type="password"
              placeholder="sk-... 粘贴 API Key"
              value={authKey}
              onChange={(e) => setAuthKey(e.target.value)}
            />
            <button className="btn-sm primary" onClick={saveAuth} disabled={authLoading}>
              {authLoading ? "保存中…" : "保存"}
            </button>
            {authMsg && <span className="sp-auth-msg">{authMsg}</span>}
          </div>
        </div>
        {providers && Object.keys(providers).length > 0 && (
          <div className="sp-row">
            <span className="sp-label">已配置</span>
            <div className="sp-auth-list">
              {Object.entries(providers).map(([p, v]) => (
                <span key={p} className="sp-auth-item">
                  <code>{p}</code> {v.masked}
                  <button className="btn-xs" onClick={() => removeAuth(p)} title="删除">✕</button>
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="sp-note">保存后写入 agent 配置 auth.json 并注入运行时，支持 Anthropic/OpenAI/Gemini 等 pi 支持的 provider。</div>
      </div>

      <div className="sp-section">
        <div className="sp-section-title"><Icon name="cloud" size={12} /> 服务集成</div>
        <div className="sp-row">
          <span className="sp-label">officecli</span>
          <span className={`sp-badge ${integration?.officecli ? "ok" : "warn"}`}>
            {integration?.officecli ? integration.officecli : "未检测到"}
          </span>
        </div>
        <div className="sp-row">
          <span className="sp-label">高德等时圈</span>
          <span className="sp-badge warn">需 AMAP_KEY</span>
        </div>
        <div className="sp-row">
          <span className="sp-label">IMA 知识库</span>
          <span className="sp-badge warn">需凭证</span>
        </div>
        <div className="sp-note">等时圈/IMA 凭证通过环境变量（AMAP_KEY / IMA ClientID）配置，改后需重启服务。</div>
      </div>

      <div className="sp-section">
        <div className="sp-section-title"><Icon name="menu" size={12} /> 高级</div>
        <button className="sp-danger" onClick={resetAll}>重置界面状态与设置</button>
        <div className="sp-note">版本 {version || "v0.8.16"}</div>
      </div>
    </div>
  );
}
