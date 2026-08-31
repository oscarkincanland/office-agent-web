export async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const listFiles = (dir) => api(`/api/files${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`);
export const uploadFile = (name, base64) => api("/api/files/upload", { method: "POST", body: JSON.stringify({ name, base64 }) });
export const deleteFile = (name) => api("/api/files/delete", { method: "POST", body: JSON.stringify({ name }) });
export const openDoc = (name) => api(`/api/doc/${encodeURIComponent(name)}`);
export const saveCells = (name, sheet, cells) =>
  api(`/api/doc/${encodeURIComponent(name)}/cells`, { method: "POST", body: JSON.stringify({ sheet, cells }) });

export const agentAuth = () => api("/api/agent/auth");
export const agentAuthSave = (provider, key) =>
  api("/api/agent/auth", { method: "POST", body: JSON.stringify({ provider, key }) });
export const agentAuthRemove = (provider) =>
  api("/api/agent/auth/remove", { method: "POST", body: JSON.stringify({ provider }) });

export const listModels = () => api("/api/models");
export const refreshModels = () => api("/api/models/refresh", { method: "POST" });
export const setAgentModel = (client, model, thread) =>
  api("/api/agent/model", { method: "POST", body: JSON.stringify({ client, thread, model }) });
export const setAgentModelForThread = (client, thread, model) =>
  api("/api/agent/model", { method: "POST", body: JSON.stringify({ client, thread, model }) });
export const compactAgentContext = (client, thread, instructions = "") =>
  api("/api/agent/compact", { method: "POST", body: JSON.stringify({ client, thread, instructions }) });
export const createAgentThread = (client, thread, cwd, options = {}) =>
  api("/api/agent/new", { method: "POST", body: JSON.stringify({ client, thread, cwd, ...options }) });
export const resumeAgentThread = (client, thread, sessionId, cwd) =>
  api("/api/agent/resume", { method: "POST", body: JSON.stringify({ client, thread, sessionId, cwd }) });

export const listSessions = (fileOrOptions) => {
  const params = new URLSearchParams();
  if (typeof fileOrOptions === "string") {
    if (fileOrOptions) params.set("file", fileOrOptions);
  } else {
    const options = fileOrOptions || {};
    for (const key of ["file", "projectId", "mode", "runStatus"]) if (options[key]) params.set(key, options[key]);
    for (const key of ["pinned", "frozen"]) if (options[key] !== undefined && options[key] !== null) params.set(key, String(options[key]));
  }
  const query = params.toString();
  return api(`/api/sessions${query ? `?${query}` : ""}`);
};
export const listProjects = (options = {}) => {
  const params = new URLSearchParams();
  for (const key of ["type", "status", "sort"]) if (options[key]) params.set(key, options[key]);
  if (options.pinned !== undefined && options.pinned !== null) params.set("pinned", String(options.pinned));
  const query = params.toString();
  return api(`/api/projects${query ? `?${query}` : ""}`);
};
export const createProject = (payload) => api("/api/projects", { method: "POST", body: JSON.stringify(payload || {}) });
export const updateProject = (id, patch) => api(`/api/projects/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch || {}) });
export const pinProject = (id, pinned = true) => api(`/api/projects/${encodeURIComponent(id)}/pin`, { method: "POST", body: JSON.stringify({ pinned }) });
export const archiveProject = (id, archived = true) => api(`/api/projects/${encodeURIComponent(id)}/archive`, { method: "POST", body: JSON.stringify({ archived }) });
export const getProjectSettings = (id) => api(`/api/projects/${encodeURIComponent(id)}/settings`);
export const updateProjectSettings = (id, settings) => api(`/api/projects/${encodeURIComponent(id)}/settings`, { method: "PATCH", body: JSON.stringify(settings || {}) });
export const listWorkspaces = () => api("/api/workspaces");
export const switchWorkspace = (path) =>
  api("/api/workspace/switch", { method: "POST", body: JSON.stringify({ path }) });
export const validateWorkspace = (path) =>
  api("/api/workspace/validate", { method: "POST", body: JSON.stringify({ path }) });
export const deleteWorkspace = (path) =>
  api("/api/workspace/delete", { method: "POST", body: JSON.stringify({ path }) });
export const listFileRoots = () => api("/api/file-roots");
export const addFileRoot = (path, label) => api("/api/file-roots", { method: "POST", body: JSON.stringify({ path, label }) });
export const removeFileRoot = (id) => api(`/api/file-roots/${encodeURIComponent(id)}`, { method: "DELETE" });
export const resolveContext = (references, text) => api("/api/context/resolve", { method: "POST", body: JSON.stringify({ references, text }) });
export const readContext = (reference, query, range) => api("/api/context/read", { method: "POST", body: JSON.stringify({ reference, query, range }) });

export const listSkills = () => api("/api/skills");
export const preflightSkills = (workflowId, skills = []) => api("/api/skills/preflight", { method: "POST", body: JSON.stringify({ workflowId, skills }) });
export const listWorkflows = () => api("/api/workflows");
export const validateWorkflow = (id) => api(`/api/workflows/${encodeURIComponent(id)}/validate`);
export const exportSkill = (name) =>
  api("/api/skills/export", { method: "POST", body: JSON.stringify({ name }) });
export const importSkill = (payload) =>
  api("/api/skills/import", { method: "POST", body: JSON.stringify(payload) });
export const getSession = (id) => api(`/api/sessions/${encodeURIComponent(id)}`);
export const deleteSession = (id) =>
  fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => r.json());
export const renameSession = (id, label) =>
  api(`/api/sessions/${encodeURIComponent(id)}/rename`, { method: "POST", body: JSON.stringify({ label }) });
export const pinSession = (id, pinned = true) =>
  api(`/api/sessions/${encodeURIComponent(id)}/pin`, { method: "POST", body: JSON.stringify({ pinned }) });
export const freezeSession = (id, frozen = true, reason = "") =>
  api(`/api/sessions/${encodeURIComponent(id)}/freeze`, { method: "POST", body: JSON.stringify({ frozen, reason }) });
export const forkSession = (id, label, options = {}) =>
  api(`/api/sessions/${encodeURIComponent(id)}/fork`, { method: "POST", body: JSON.stringify({ label, ...options }) });
export const listRuns = (thread = "", limit = 50, options = {}) => {
  const params = new URLSearchParams();
  if (thread) params.set("thread", thread);
  if (options.sessionId) params.set("session", options.sessionId);
  if (options.cwd) params.set("cwd", options.cwd);
  if (options.projectId) params.set("projectId", options.projectId);
  if (options.status && options.status !== "all") params.set("status", options.status);
  if (options.mode && options.mode !== "all") params.set("mode", options.mode);
  if (options.query) params.set("query", options.query);
  params.set("limit", String(limit));
  return api(`/api/runs?${params.toString()}`);
};
export const getRun = (id) => api(`/api/runs/${encodeURIComponent(id)}`);
export const cancelRun = (id, reason = "用户请求取消") => api(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify({ reason }) });
export const resumeRun = (id) => api(`/api/runs/${encodeURIComponent(id)}/resume`, { method: "POST", body: JSON.stringify({}) });
export const retryRun = (id) => api(`/api/runs/${encodeURIComponent(id)}/retry`, { method: "POST", body: JSON.stringify({}) });
export const markAgentEventsRead = (client, seq) => api("/api/agent/events/read", { method: "POST", body: JSON.stringify({ client, seq }) });
export const listPublishedArtifacts = (cwd, projectId = "") => {
  const params = new URLSearchParams();
  if (cwd) params.set("cwd", cwd);
  if (projectId) params.set("projectId", projectId);
  return api(`/api/artifacts?${params.toString()}`);
};
export const publishArtifact = (runId, artifactId) => api(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/publish`, { method: "POST", body: JSON.stringify({}) });
export const rollbackRun = (id, paths) => api(`/api/runs/${encodeURIComponent(id)}/rollback`, { method: "POST", body: JSON.stringify({ confirm: true, paths }) });
export const updateRunStep = (id, stepId, patch) => api(`/api/runs/${encodeURIComponent(id)}/steps/${encodeURIComponent(stepId)}`, { method: "POST", body: JSON.stringify(patch || {}) });
export const listConnectors = () => api("/api/connectors");
export const beginConnectorAuth = (id, redirectUri) => api(`/api/connectors/${encodeURIComponent(id)}/auth/start`, { method: "POST", body: JSON.stringify({ redirectUri }) });
export const approveMemoryProposal = (id, payload = {}) => api(`/api/memory/proposals/${encodeURIComponent(id)}/approve`, { method: "POST", body: JSON.stringify(payload || {}) });
export const editMemoryProposal = (id, payload = {}) => api(`/api/memory/proposals/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload || {}) });
export const rejectMemoryProposal = (id, reason = "用户拒绝该记忆建议") => api(`/api/memory/proposals/${encodeURIComponent(id)}/reject`, { method: "POST", body: JSON.stringify({ reason }) });
export const mergeMemoryProposals = (targetId, sourceIds = []) => api(`/api/memory/proposals/${encodeURIComponent(targetId)}/merge`, { method: "POST", body: JSON.stringify({ sourceIds }) });
export const memoryProposalHistory = (id) => api(`/api/memory/proposals/${encodeURIComponent(id)}/history`);
export const listMemoryProposals = (workspace = "", status = "", projectId = "") => {
  const params = new URLSearchParams();
  if (workspace) params.set("workspace", workspace);
  if (status) params.set("status", status);
  if (projectId) params.set("projectId", projectId);
  return api(`/api/memory/proposals?${params.toString()}`);
};
export const listPendingQuestions = (client, thread) => api(`/api/agent/pending?client=${encodeURIComponent(client)}&thread=${encodeURIComponent(thread)}`);

export function getClientId() {
  let id = localStorage.getItem("oaw_client_id");
  if (!id) {
    id = "client-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("oaw_client_id", id);
  }
  return id;
}

// ---------- 知识库（本地索引 + IMA） ----------
export const kbStatus = () => api("/api/kb/status");
export const kbAddRoot = (path) => api("/api/kb/roots", { method: "POST", body: JSON.stringify({ path }) });
export const kbRemoveRoot = (path) => api("/api/kb/roots", { method: "DELETE", body: JSON.stringify({ path }) });
export const kbTree = (root, dir) =>
  api(`/api/kb/tree${root !== undefined ? `?root=${root}` : ""}${dir ? `&dir=${encodeURIComponent(dir)}` : ""}`);
export const kbSearch = (q, root, limit = 30) =>
  api(`/api/kb/search?q=${encodeURIComponent(q)}${root !== undefined ? `&root=${root}` : ""}&limit=${limit}`);
export const kbGraph = (root, include = ["links"], max = 800) =>
  api(`/api/kb/graph?${root !== undefined ? `root=${root}&` : ""}include=${encodeURIComponent(include.join(","))}&max=${max}`);
export const kbDoc = (path, root) =>
  api(`/api/kb/doc?path=${encodeURIComponent(path)}${root !== undefined ? `&root=${root}` : ""}`);
export const kbImaStatus = () => api("/api/kb/ima/status");
export const kbImaBases = () => api("/api/kb/ima/bases");
export const kbImaSearch = (q, kb) =>
  api(`/api/kb/ima/search?q=${encodeURIComponent(q)}${kb ? `&kb=${encodeURIComponent(kb)}` : ""}`);
export const kbImaDoc = (mediaId) => api(`/api/kb/ima/doc?media_id=${encodeURIComponent(mediaId)}`);

// ---------- 地图（GIS 项目） ----------
export const mapProjects = () => api("/api/map/projects");
export const mapProject = (name) => api(`/api/map/project${name ? `?name=${encodeURIComponent(name)}` : ""}`);
export const mapSaveStyle = (name, style) =>
  api("/api/map/style", { method: "POST", body: JSON.stringify({ name, style }) });
export const mapSaveConfig = (name, config) =>
  api("/api/map/config", { method: "POST", body: JSON.stringify({ name, config }) });
export const mapImportLayer = (name, layerId, geojson) =>
  api("/api/map/import", { method: "POST", body: JSON.stringify({ name, layerId, geojson }) });
export const mapImportBatch = (name, items) =>
  api("/api/map/import-batch", { method: "POST", body: JSON.stringify({ name, items }) });
export const mapPrepare = (srcDir) =>
  api("/api/map/prepare", { method: "POST", body: JSON.stringify({ srcDir }) });
export const mapRebuild = (name, layerIds) =>
  api("/api/map/rebuild", { method: "POST", body: JSON.stringify({ name, layerIds }) });
export const mapSettings = () => api("/api/map/settings");
export const mapSettingsSave = (basemaps) =>
  api("/api/map/settings", { method: "POST", body: JSON.stringify({ basemaps }) });
export const mapDeleteLayer = (name, layerId) =>
  api("/api/map/layer/delete", { method: "POST", body: JSON.stringify({ name, layerId }) });
export const mapGetLayer = (name, layerId) =>
  api(`/api/map/layer?name=${encodeURIComponent(name)}&layer=${encodeURIComponent(layerId)}`);
export const mapIsochrone = (params) =>
  api("/api/map/isochrone", { method: "POST", body: JSON.stringify(params) });
export const mapRoute = (params) =>
  api("/api/map/route", { method: "POST", body: JSON.stringify(params) });
export const mapDemoAnalysis = (params = {}) => {
  const query = new URLSearchParams({ analysis: params.analysis || "heatmap", region: params.region || "义乌市", project: params.project || "zhejiang-map", count: String(params.count || 36) });
  return api(`/api/map/demo-analysis?${query.toString()}`);
};
export const mapCambodiaOD = (minFlow = 0) => api(`/api/demo/cambodia-od?minFlow=${encodeURIComponent(minFlow)}`);
export const mapM3Routes = () => api("/api/m3/bus-routes");
export const mapM3Stations = () => api("/api/m3/station-heatmap");
export const mapM3OD = () => api("/api/m3/od-lines");
export const mapM3Stats = () => api("/api/m3/network-stats");

// ---------- 模版库 ----------
export const tplList = (category) => api(`/api/templates${category ? `?category=${encodeURIComponent(category)}` : ""}`);
export const tplContent = (relPath) => api(`/api/templates/content?path=${encodeURIComponent(relPath)}`);
export const tplRefresh = () => api("/api/templates/refresh", { method: "POST" });

export function fileToBase64(file) {
  // 大图先压缩，避免把高分辨率截图以超大 Base64 发送给视觉模型。
  if (file?.type?.startsWith("image/") && file.size > 2 * 1024 * 1024 && typeof Image !== "undefined") {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      const cleanup = () => URL.revokeObjectURL(url);
      img.onload = () => {
        try {
          const maxSide = 1800;
          const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
          canvas.height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => {
            if (!blob) { cleanup(); reject(new Error("图片压缩失败")); return; }
            const reader = new FileReader();
            reader.onload = () => {
              cleanup();
              const dataUrl = reader.result;
              const [head, b64] = dataUrl.split(",");
              resolve({ mediaType: head.match(/data:(.*?);/)?.[1] || "image/jpeg", data: b64 });
            };
            reader.onerror = (e) => { cleanup(); reject(e); };
            reader.readAsDataURL(blob);
          }, "image/jpeg", 0.82);
        } catch (e) { cleanup(); reject(e); }
      };
      img.onerror = (e) => { cleanup(); reject(e); };
      img.src = url;
    });
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const [head, b64] = dataUrl.split(",");
      const mediaType = head.match(/data:(.*?);/)?.[1] || "application/octet-stream";
      resolve({ mediaType, data: b64 });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
