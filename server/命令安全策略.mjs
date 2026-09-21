const DEFAULT_BASH_TIMEOUT_SECONDS = 120;
const MAX_BASH_TIMEOUT_SECONDS = 600;

// Git Bash 的 `/` 可能映射到整台 Windows 主机。Agent 只应检索当前工作区，
// 禁止 find/rg/grep 等命令从系统根目录开始扫描，避免任务无限占用工具通道。
const GLOBAL_SEARCH_PATTERN = /\b(?:find|rg|grep|ls|du|tree)\s+(?:-[^\s]+\s+)*\/(?:\s|$)/i;

export function isGlobalSearchCommand(command) {
  return GLOBAL_SEARCH_PATTERN.test(String(command || ""));
}

export function normalizeBashOptions(options = {}) {
  const requested = Number(options.timeout);
  const timeout = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, MAX_BASH_TIMEOUT_SECONDS)
    : DEFAULT_BASH_TIMEOUT_SECONDS;
  return { ...options, timeout };
}

export const bashTimeoutPolicy = Object.freeze({
  defaultSeconds: DEFAULT_BASH_TIMEOUT_SECONDS,
  maxSeconds: MAX_BASH_TIMEOUT_SECONDS,
});
