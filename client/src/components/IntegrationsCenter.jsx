import React, { useCallback, useEffect, useState } from "react";
import Icon from "./Icon.jsx";
import {
  addPiExtension,
  checkPiExtension,
  deleteMcpServer,
  deletePiExtension,
  listMcpServers,
  listPiExtensions,
  registerInstalledPiPackage,
  searchPiPackageCatalog,
  saveMcpServer,
  testMcpServer,
  updateMcpServer,
  updatePiExtension,
} from "../api.js";

const PI_CANDIDATES_KEY = "oaw_pi_package_candidates_v1";

function readPiCandidates() {
  try {
    const value = JSON.parse(window.localStorage.getItem(PI_CANDIDATES_KEY) || "[]");
    return Array.isArray(value) ? value.filter((item) => item?.name).slice(0, 50) : [];
  } catch { return []; }
}

function parseJsonObject(raw, label) {
  if (!String(raw || "").trim()) return {};
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象`);
  return value;
}

export default function IntegrationsCenter({ kind = "mcp", open = false, onClose }) {
  const [servers, setServers] = useState([]);
  const [extensions, setExtensions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [transport, setTransport] = useState("stdio");
  const [mcpForm, setMcpForm] = useState({ name: "", command: "", args: "", cwd: "", env: "", endpoint: "", headers: "" });
  const [piForm, setPiForm] = useState({ name: "", path: "" });
  const [catalogQuery, setCatalogQuery] = useState("subagent");
  const [catalog, setCatalog] = useState({ items: [], total: 0, page: 0 });
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [selectedPackages, setSelectedPackages] = useState(readPiCandidates);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [mcp, pi] = await Promise.all([listMcpServers(), listPiExtensions()]);
      setServers(mcp.servers || []);
      setExtensions(pi.extensions || []);
    } catch (err) { setError(err.message || "读取集成配置失败"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (open) refresh(); }, [open, refresh]);
  useEffect(() => {
    try { window.localStorage.setItem(PI_CANDIDATES_KEY, JSON.stringify(selectedPackages)); } catch {}
  }, [selectedPackages]);
  useEffect(() => {
    if (!open || kind !== "piPlugins") return;
    setCatalogLoading(true);
    setCatalogError("");
    searchPiPackageCatalog("subagent", 0)
      .then(setCatalog)
      .catch((err) => setCatalogError(err.message || "读取 Pi 包目录失败"))
      .finally(() => setCatalogLoading(false));
  }, [open, kind]);

  if (!open) return null;

  const saveMcp = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const payload = {
        name: mcpForm.name,
        transport,
        ...(transport === "stdio" ? {
          command: mcpForm.command,
          args: mcpForm.args.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
          cwd: mcpForm.cwd,
          env: parseJsonObject(mcpForm.env, "环境变量"),
        } : {
          endpoint: mcpForm.endpoint,
          headers: parseJsonObject(mcpForm.headers, "请求头"),
        }),
      };
      await saveMcpServer(payload);
      setMcpForm({ name: "", command: "", args: "", cwd: "", env: "", endpoint: "", headers: "" });
      setNotice("MCP 配置已保存。点击「测试并读取工具」后，启用它并新建会话即可接入。 ");
      await refresh();
    } catch (err) { setError(err.message || "保存 MCP 配置失败"); }
    finally { setSaving(false); }
  };

  const testMcp = async (server) => {
    const action = server.transport === "stdio" ? "将启动这个本地 MCP 命令，并保持连接供会话调用。继续吗？" : `将连接到该 MCP 地址：\n${server.endpoint}\n继续吗？`;
    if (!window.confirm(action)) return;
    setBusyId(server.id); setError(""); setNotice("");
    try {
      const result = await testMcpServer(server.id);
      if (!result.ok) throw new Error(result.error || "MCP 测试失败");
      setNotice(`连接成功，发现 ${result.server?.tools?.length || 0} 个工具。${result.server?.lastTest?.serverInfo ? ` 服务：${result.server.lastTest.serverInfo}。` : ""}启用后新会话会加载这些工具。`);
      await refresh();
    } catch (err) { setError(err.message || "MCP 测试失败"); await refresh(); }
    finally { setBusyId(""); }
  };

  const toggleMcp = async (server) => {
    if (!server.enabled && !window.confirm("启用后，新建的 Agent 会话可以调用此 MCP 服务；未标记只读的工具会按现有权限策略请求审批。继续吗？")) return;
    setBusyId(server.id); setError(""); setNotice("");
    try {
      await updateMcpServer(server.id, { enabled: !server.enabled });
      setNotice("MCP 启用状态已更新；该变更从新建会话开始生效。");
      await refresh();
    } catch (err) { setError(err.message || "更新 MCP 状态失败"); }
    finally { setBusyId(""); }
  };

  const removeMcp = async (server) => {
    if (!window.confirm(`删除 MCP 配置「${server.name}」？不会删除它的程序或远端数据。`)) return;
    setBusyId(server.id); setError("");
    try { await deleteMcpServer(server.id); await refresh(); setNotice("MCP 配置已删除。"); }
    catch (err) { setError(err.message || "删除失败"); }
    finally { setBusyId(""); }
  };

  const savePi = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      await addPiExtension(piForm);
      setPiForm({ name: "", path: "" });
      setNotice("扩展路径已登记为未启用状态。检查只验证路径，不会执行扩展代码。");
      await refresh();
    } catch (err) { setError(err.message || "登记 Pi 扩展失败"); }
    finally { setSaving(false); }
  };

  const loadCatalog = async (query = catalogQuery, page = 0, append = false) => {
    setCatalogLoading(true); setCatalogError("");
    try {
      const result = await searchPiPackageCatalog(query, page);
      setCatalog((previous) => append ? { ...result, items: [...previous.items, ...result.items] } : result);
    } catch (err) { setCatalogError(err.message || "读取 Pi 包目录失败"); }
    finally { setCatalogLoading(false); }
  };

  const togglePackageCandidate = (pkg) => {
    setSelectedPackages((previous) => {
      const exists = previous.some((item) => item.name === pkg.name);
      if (exists) return previous.filter((item) => item.name !== pkg.name);
      return [{ name: pkg.name, version: pkg.version, description: pkg.description, selectedAt: new Date().toISOString() }, ...previous].slice(0, 50);
    });
  };

  const copyPiInstallCommand = async (name) => {
    const command = `pi install npm:${name}`;
    try {
      await navigator.clipboard.writeText(command);
      setNotice(`已复制安装命令：${command}。执行前请先审阅包源码。`);
    } catch {
      setNotice(`请手动复制安装命令：${command}。执行前请先审阅包源码。`);
    }
  };

  const registerCatalogPackage = async (pkg) => {
    if (!pkg.installed || !pkg.hasExtensions) return;
    setBusyId(`package:${pkg.name}`); setError(""); setNotice("");
    try {
      await registerInstalledPiPackage(pkg.name);
      setNotice(`已把本机已安装的 ${pkg.name} 登记为停用扩展；当前没有执行它，启用时还会再次确认。`);
      await refresh();
    } catch (err) { setError(err.message || "登记本机 Pi 扩展失败"); }
    finally { setBusyId(""); }
  };

  const togglePi = async (extension) => {
    if (!extension.enabled && !window.confirm(`启用「${extension.name}」会在新建会话时执行该路径中的 Pi 扩展代码。扩展拥有服务进程权限，只启用你信任的代码。\n\n${extension.path}\n\n确认启用？`)) return;
    setBusyId(extension.id); setError(""); setNotice("");
    try {
      await updatePiExtension(extension.id, { enabled: !extension.enabled });
      setNotice("Pi 扩展状态已更新；为避免影响当前对话，它从新建会话开始加载。");
      await refresh();
    } catch (err) { setError(err.message || "更新扩展状态失败"); }
    finally { setBusyId(""); }
  };

  const checkPi = async (extension) => {
    setBusyId(extension.id); setError(""); setNotice("");
    try {
      const result = await checkPiExtension(extension.id);
      setNotice(result.extension?.lastCheck?.message || (result.extension?.exists ? "路径有效。" : "路径无效。"));
      await refresh();
    } catch (err) { setError(err.message || "检查扩展路径失败"); }
    finally { setBusyId(""); }
  };

  const removePi = async (extension) => {
    if (!window.confirm(`移除扩展登记「${extension.name}」？不会删除扩展文件。`)) return;
    setBusyId(extension.id); setError("");
    try { await deletePiExtension(extension.id); await refresh(); setNotice("扩展登记已移除，文件保留在原位置。"); }
    catch (err) { setError(err.message || "删除失败"); }
    finally { setBusyId(""); }
  };

  return (
    <div className="module-view integration-center">
      <div className="module-head">
        <button className="module-back" onClick={onClose} title="返回对话"><Icon name="back" size={15} /></button>
        <div className="module-brand-heading"><span className="integration-mark"><Icon name={kind === "mcp" ? "plug" : "package"} size={19} /></span><span><h2>{kind === "mcp" ? "MCP" : "Pi 插件"}</h2><p>{kind === "mcp" ? "连接外部工具与服务，按权限策略接入对话" : "发现、选择并管理 Pi 扩展能力"}</p></span></div>
      </div>
      <div className="module-body integration-body">
        {error && <div className="integration-alert error" role="alert">{error}</div>}
        {notice && <div className="integration-alert success" role="status">{notice}</div>}
        {kind === "mcp" ? (
          <div className="integration-layout">
            <section className="integration-panel">
              <div className="integration-section-head"><span><h3>已配置的 MCP 服务</h3><p>工具定义在连通测试后缓存；启用并新建会话才会注入到模型工具集。</p></span><button className="btn-xs" onClick={refresh} disabled={loading}><Icon name="refresh" size={12} /> 刷新</button></div>
              {loading ? <div className="integration-empty">正在读取…</div> : servers.length === 0 ? <div className="integration-empty">还没有 MCP 服务。可添加本地 stdio 服务或远程 Streamable HTTP 服务。</div> : (
                <div className="integration-list">
                  {servers.map((server) => (
                    <article className={`integration-card ${server.enabled ? "enabled" : ""}`} key={server.id}>
                      <div className="integration-card-top">
                        <span className="integration-status-dot" data-enabled={server.enabled} />
                        <div className="integration-card-title"><strong>{server.name}</strong><small>{server.transport === "stdio" ? `${server.command}${server.argsCount ? ` · ${server.argsCount} 个参数` : ""}` : server.endpoint}</small></div>
                        <label className="integration-switch"><input type="checkbox" checked={server.enabled} onChange={() => toggleMcp(server)} disabled={busyId === server.id} /><span>{server.enabled ? "已启用" : "已停用"}</span></label>
                      </div>
                      <div className="integration-card-meta">
                        {server.tools?.length ? <span>{server.tools.length} 个工具</span> : <span>尚未读取工具</span>}
                        {server.envKeys?.length > 0 && <span>环境变量 {server.envKeys.length} 项（已隐藏）</span>}
                        {server.headerNames?.length > 0 && <span>请求头 {server.headerNames.length} 项（值已隐藏）</span>}
                        {server.lastTest && <span className={server.lastTest.ok ? "tone-ok" : "tone-error"}>{server.lastTest.ok ? "最近连通成功" : `测试失败：${server.lastTest.error || "未知错误"}`}</span>}
                      </div>
                      {!!server.tools?.length && <div className="integration-tools">{server.tools.map((tool) => <span key={tool.name} title={`${tool.description || tool.name}${tool.annotations?.readOnlyHint ? "（服务端声明只读，仅供参考；调用仍按审批策略处理）" : "（调用按审批策略处理）"}`}><i data-readonly={tool.annotations?.readOnlyHint === true} />{tool.name}{tool.annotations?.readOnlyHint ? " · 服务端标注只读，仍审批" : " · 需审批"}</span>)}</div>}
                      <div className="integration-card-actions">
                        <button className="btn-xs primary" onClick={() => testMcp(server)} disabled={busyId === server.id}><Icon name={busyId === server.id ? "loading" : "plug"} size={12} className={busyId === server.id ? "icon-loading" : ""} /> 测试并读取工具</button>
                        <button className="btn-xs danger" onClick={() => removeMcp(server)} disabled={busyId === server.id}><Icon name="trash" size={12} /> 删除配置</button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
            <section className="integration-panel integration-form-panel">
              <div className="integration-section-head"><span><h3>添加 MCP 服务</h3><p>stdio 适合本机 MCP 程序；HTTP 适合远程 Streamable HTTP 端点。</p></span></div>
              <form className="integration-form" onSubmit={saveMcp}>
                <label>服务名称<input value={mcpForm.name} onChange={(e) => setMcpForm({ ...mcpForm, name: e.target.value })} placeholder="例如：本地文件检索" required /></label>
                <div className="integration-field-row"><label>传输方式<select value={transport} onChange={(e) => setTransport(e.target.value)}><option value="stdio">本地 stdio</option><option value="http">Streamable HTTP</option></select></label></div>
                {transport === "stdio" ? <>
                  <label>启动命令<input value={mcpForm.command} onChange={(e) => setMcpForm({ ...mcpForm, command: e.target.value })} placeholder="例如：npx" required /></label>
                  <label>命令参数 <small>每行一个参数，不经过 Shell 拼接</small><textarea rows={3} value={mcpForm.args} onChange={(e) => setMcpForm({ ...mcpForm, args: e.target.value })} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/允许访问的目录'} /></label>
                  <label>工作目录（可选）<input value={mcpForm.cwd} onChange={(e) => setMcpForm({ ...mcpForm, cwd: e.target.value })} placeholder="留空时使用服务默认目录" /></label>
                  <label>环境变量 JSON（可选）<small>敏感值仅保存在本机，不会回显；格式如 {`{"API_KEY":"…"}`}</small><textarea rows={4} value={mcpForm.env} onChange={(e) => setMcpForm({ ...mcpForm, env: e.target.value })} placeholder={'{"API_KEY":"在此粘贴密钥"}'} /></label>
                </> : <>
                  <label>服务地址<input type="url" value={mcpForm.endpoint} onChange={(e) => setMcpForm({ ...mcpForm, endpoint: e.target.value })} placeholder="https://example.com/mcp" required /></label>
                  <label>请求头 JSON（可选）<small>适用于 API Key/Bearer Token；保存后不会回显。</small><textarea rows={4} value={mcpForm.headers} onChange={(e) => setMcpForm({ ...mcpForm, headers: e.target.value })} placeholder={'{"Authorization":"Bearer …"}'} /></label>
                </>}
                <div className="integration-security-note"><Icon name="shield" size={13} /> 添加后默认停用。测试会启动本地程序或连接远端服务。MCP 工具的“只读”注解来自服务端，仅作提示；每次调用都按规聚的审批策略处理。</div>
                <button type="submit" className="btn primary" disabled={saving}><Icon name={saving ? "loading" : "plus"} size={13} className={saving ? "icon-loading" : ""} /> 保存 MCP 配置</button>
              </form>
            </section>
          </div>
        ) : (
          <>
          <section className="pi-ecosystem-intro">
            <div className="pi-ecosystem-heading"><span className="integration-mark"><Icon name="package" size={18} /></span><span><strong>Pi 官方生态</strong><small>核心仓库与官方包目录分开浏览</small></span></div>
            <div className="pi-ecosystem-links">
              <a className="btn-xs" href="https://github.com/badlogic/pi-mono" target="_blank" rel="noreferrer"><Icon name="code" size={12} /> 官方源码仓库</a>
              <a className="btn-xs" href="https://pi.dev/packages" target="_blank" rel="noreferrer"><Icon name="globe" size={12} /> Pi 包目录</a>
            </div>
          </section>
          <section className="integration-panel pi-catalog-panel">
            <div className="integration-section-head"><span><h3>Pi 包目录 · Subagent</h3><p>实时搜索 npm 中带有 pi-package 标签的 Pi 包；先加入候选，再审阅来源。</p></span><span className="pi-catalog-count">{catalog.total ? `${catalog.total.toLocaleString()} 个结果` : "官方目录"}</span></div>
            <form className="pi-catalog-search" onSubmit={(event) => { event.preventDefault(); loadCatalog(catalogQuery, 0); }}>
              <input aria-label="搜索 Pi 包目录" value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} placeholder="搜索 subagent、MCP、browser…" />
              <button type="submit" className="btn primary" disabled={catalogLoading}><Icon name={catalogLoading ? "loading" : "search"} size={13} className={catalogLoading ? "icon-loading" : ""} /> 搜索目录</button>
            </form>
            {catalogError && <div className="integration-alert error" role="alert">{catalogError}<button className="btn-xs" type="button" onClick={() => loadCatalog(catalogQuery, 0)}>重试</button></div>}
            {catalogLoading && catalog.items.length === 0 ? <div className="integration-empty">正在读取官方目录…</div> : catalog.items.length === 0 ? <div className="integration-empty">没有找到匹配的 Pi 包。</div> : (
              <div className="pi-catalog-list">
                {catalog.items.map((pkg) => {
                  const selected = selectedPackages.some((item) => item.name === pkg.name);
                  const registered = extensions.some((extension) => extension.name === pkg.name);
                  return (
                    <article className="pi-catalog-card" key={pkg.name}>
                      <div className="pi-catalog-card-main">
                        <div className="pi-catalog-title"><strong>{pkg.name}</strong><span>v{pkg.version}</span>{pkg.installed && <span className="pi-catalog-badge installed">本机已安装 {pkg.installedVersion}</span>}{registered && <span className="pi-catalog-badge">已登记</span>}</div>
                        <p>{pkg.description || "暂无简介"}</p>
                        <div className="pi-catalog-meta">{pkg.publisher && <span>{pkg.publisher}</span>}<span>{pkg.keywords.slice(0, 5).join(" · ")}</span></div>
                      </div>
                      <div className="pi-catalog-links">
                        <a href={pkg.galleryUrl} target="_blank" rel="noreferrer">Pi 目录</a>
                        <a href={pkg.npmUrl} target="_blank" rel="noreferrer">npm 信息</a>
                        {pkg.repositoryUrl && <a href={pkg.repositoryUrl} target="_blank" rel="noreferrer">源码仓库</a>}
                      </div>
                      <div className="pi-catalog-actions">
                        <button className={`btn-xs ${selected ? "" : "primary"}`} type="button" onClick={() => togglePackageCandidate(pkg)}>{selected ? "已加入候选 · 移除" : "加入候选"}</button>
                        {pkg.installed && pkg.hasExtensions && !registered
                          ? <button className="btn-xs" type="button" disabled={busyId === `package:${pkg.name}`} onClick={() => registerCatalogPackage(pkg)}>{busyId === `package:${pkg.name}` ? "登记中…" : "登记为停用扩展"}</button>
                          : !pkg.installed && <button className="btn-xs" type="button" onClick={() => copyPiInstallCommand(pkg.name)}>复制 Pi 安装命令</button>}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
            {catalog.items.length < catalog.total && catalog.items.length > 0 && <button className="btn-xs pi-catalog-more" type="button" disabled={catalogLoading} onClick={() => loadCatalog(catalogQuery, catalog.page + 1, true)}>{catalogLoading ? "读取中…" : "加载更多"}</button>}
            <div className="integration-security-note warning"><Icon name="shield" size={13} /> 加入候选只保存在此浏览器，不会安装或运行代码。本机已安装的包登记后仍为停用状态；启用会再次要求确认。</div>
          </section>
          {selectedPackages.length > 0 && <section className="integration-panel pi-selected-panel">
            <div className="integration-section-head"><span><h3>已选候选包（{selectedPackages.length}）</h3><p>仅记录选择，尚未接入当前 Agent。</p></span></div>
            <div className="pi-selected-list">{selectedPackages.map((pkg) => <div className="pi-selected-row" key={pkg.name}><span><strong>{pkg.name}</strong><small>{pkg.description || `npm:${pkg.name}`}</small></span><button className="btn-xs" type="button" onClick={() => copyPiInstallCommand(pkg.name)}>复制安装命令</button><button className="btn-xs danger" type="button" onClick={() => togglePackageCandidate(pkg)}>移除</button></div>)}</div>
          </section>}
          <div className="integration-layout">
            <section className="integration-panel">
              <div className="integration-section-head"><span><h3>已登记的 Pi 扩展</h3><p>扩展工具可以从模型对话调用；启用操作需要显式确认。</p></span><button className="btn-xs" onClick={refresh} disabled={loading}><Icon name="refresh" size={12} /> 刷新</button></div>
              {loading ? <div className="integration-empty">正在读取…</div> : extensions.length === 0 ? <div className="integration-empty">尚无 Pi 扩展。登记一个本机的扩展 JS/TS 文件或包含扩展的目录。</div> : (
                <div className="integration-list">
                  {extensions.map((extension) => (
                    <article className={`integration-card ${extension.enabled ? "enabled" : ""}`} key={extension.id}>
                      <div className="integration-card-top">
                        <span className="integration-status-dot" data-enabled={extension.enabled && extension.exists} />
                        <div className="integration-card-title"><strong>{extension.name}</strong><small title={extension.path}>{extension.path}</small></div>
                        <label className="integration-switch"><input type="checkbox" checked={extension.enabled} onChange={() => togglePi(extension)} disabled={busyId === extension.id || !extension.exists} /><span>{extension.enabled ? "已启用" : "已停用"}</span></label>
                      </div>
                      <div className="integration-card-meta"><span>{extension.exists ? `可读取 · ${extension.files?.length || 0} 个 JS/TS 文件` : "路径无效"}</span><span>仅新会话加载</span>{extension.lastCheck?.message && <span>{extension.lastCheck.message}</span>}</div>
                      {extension.files?.length > 0 && <div className="integration-tools">{extension.files.slice(0, 8).map((file) => <span key={file}><i data-readonly="true" />{file}</span>)}{extension.files.length > 8 && <span>另有 {extension.files.length - 8} 个文件</span>}</div>}
                      <div className="integration-card-actions"><button className="btn-xs" onClick={() => checkPi(extension)} disabled={busyId === extension.id}><Icon name={busyId === extension.id ? "loading" : "refresh"} size={12} className={busyId === extension.id ? "icon-loading" : ""} /> 检查路径</button><button className="btn-xs danger" onClick={() => removePi(extension)} disabled={busyId === extension.id}><Icon name="trash" size={12} /> 移除登记</button></div>
                    </article>
                  ))}
                </div>
              )}
            </section>
            <section className="integration-panel integration-form-panel">
              <div className="integration-section-head"><span><h3>登记 Pi 扩展</h3><p>可接入 Pi extension SDK 编写的本地扩展。</p></span></div>
              <form className="integration-form" onSubmit={savePi}>
                <label>显示名称<input value={piForm.name} onChange={(e) => setPiForm({ ...piForm, name: e.target.value })} placeholder="例如：代码审阅 subagent" /></label>
                <label>扩展文件或目录路径<input value={piForm.path} onChange={(e) => setPiForm({ ...piForm, path: e.target.value })} placeholder="/Users/you/.pi/agent/extensions/example" required /></label>
                <div className="integration-security-note warning"><Icon name="shield" size={13} /> Pi 扩展是可执行代码，可获得规聚服务进程的系统权限。检查路径不会运行代码；只启用你审阅并信任的扩展。</div>
                <button type="submit" className="btn primary" disabled={saving}><Icon name={saving ? "loading" : "plus"} size={13} className={saving ? "icon-loading" : ""} /> 登记为未启用</button>
              </form>
            </section>
          </div>
          </>
        )}
      </div>
    </div>
  );
}
