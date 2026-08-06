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

export const listModels = () => api("/api/models");
export const setAgentModel = (client, model) =>
  api("/api/agent/model", { method: "POST", body: JSON.stringify({ client, model }) });

export const listSessions = () => api("/api/sessions");
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
