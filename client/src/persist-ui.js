/**
 * 界面状态持久化（localStorage）
 * 固化：打开的文档 tabs、激活 tab、全屏模式（知识库/模版库/地图）、
 *       当前工作区、子目录、侧栏开关、最后会话 id。
 * 刷新/重开浏览器后恢复到上次界面。
 */
const KEY = "oaw_ui_state_v1";

export function loadUIState() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (!s || typeof s !== "object") return null;
    return s;
  } catch {
    return null;
  }
}

export function saveUIState(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* localStorage 不可用时静默降级 */
  }
}

export function clearUIState() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}
