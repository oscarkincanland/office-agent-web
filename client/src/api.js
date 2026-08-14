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
export const setAgentModel = (client, model) =>
  api("/api/agent/model", { method: "POST", body: JSON.stringify({ client, model }) });

export const listSessions = (file) => api(`/api/sessions${file ? `?file=${encodeURIComponent(file)}` : ""}`);
export const listWorkspaces = () => api("/api/workspaces");
export const switchWorkspace = (path) =>
  api("/api/workspace/switch", { method: "POST", body: JSON.stringify({ path }) });
export const validateWorkspace = (path) =>
  api("/api/workspace/validate", { method: "POST", body: JSON.stringify({ path }) });

export const listSkills = () => api("/api/skills");
export const exportSkill = (name) =>
  api("/api/skills/export", { method: "POST", body: JSON.stringify({ name }) });
export const importSkill = (payload) =>
  api("/api/skills/import", { method: "POST", body: JSON.stringify(payload) });
export const getSession = (id) => api(`/api/sessions/${encodeURIComponent(id)}`);
export const deleteSession = (id) =>
  fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => r.json());
export const renameSession = (id, label) =>
  api(`/api/sessions/${encodeURIComponent(id)}/rename`, { method: "POST", body: JSON.stringify({ label }) });

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

// ---------- 模版库 ----------
export const tplList = (category) => api(`/api/templates${category ? `?category=${encodeURIComponent(category)}` : ""}`);
export const tplContent = (relPath) => api(`/api/templates/content?path=${encodeURIComponent(relPath)}`);
export const tplRefresh = () => api("/api/templates/refresh", { method: "POST" });

export function fileToBase64(file) {
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
