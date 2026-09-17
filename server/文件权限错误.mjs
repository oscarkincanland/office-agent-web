const LOCKED_FILE_PATTERN = /sharing violation|error_sharing_violation|used by another process|being used by another process|file is locked|another process.*(?:lock|open)|文件.*(?:占用|锁定)|(?:占用|锁定).*文件/i;
const PERMISSION_PATTERN = /operation not permitted|permission denied|access denied|access to (?:the )?(?:path|file|directory)\b[^\r\n]{0,500}\b(?:is|was) denied|拒绝访问|权限不足|没有权限/i;

export function normalizeWorkspaceWriteError(error, fallbackMessage = "工作区文件操作失败") {
  const raw = String(error?.message || error || fallbackMessage).trim();
  if (String(error?.code || "").toUpperCase() === "EBUSY" || LOCKED_FILE_PATTERN.test(raw)) {
    const normalized = new Error(`目标文件正被其他程序占用，保存未完成。请先保存并关闭占用该文件的 WPS/Word/Excel 或预览窗口，再重试。原始信息：${raw.slice(0, 400)}`);
    normalized.code = "OFFICE_DOCUMENT_LOCKED";
    normalized.cause = raw;
    return normalized;
  }
  if (["EPERM", "EACCES"].includes(String(error?.code || "").toUpperCase()) || PERMISSION_PATTERN.test(raw)) {
    const normalized = new Error(`操作系统拒绝了当前规聚服务进程对目标的写操作，常见原因是沙箱、挂载方式或目录权限；仅凭此错误不能归因于 Office CLI 版本。请核对服务运行身份与目标目录权限。原始信息：${raw.slice(0, 400)}`);
    normalized.code = "WORKSPACE_PERMISSION_DENIED";
    normalized.cause = raw;
    return normalized;
  }
  return error instanceof Error ? error : Object.assign(new Error(raw || fallbackMessage), { code: "WORKSPACE_FILE_OPERATION_FAILED" });
}

export function normalizeOfficeFailure(error, args = [], result = null) {
  const messages = [];
  const codes = [];
  const seen = new Set();
  const collect = (value, depth = 0) => {
    if (value == null || depth > 8 || messages.length >= 32) return;
    if (typeof value === "string") {
      const text = value.trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        messages.push(text);
        if (text.startsWith("{") || text.startsWith("[")) {
          try { collect(JSON.parse(text), depth + 1); } catch {}
        }
      }
      return;
    }
    if (typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) collect(item, depth + 1);
      return;
    }
    if (value.code) codes.push(String(value.code));
    for (const key of ["message", "error", "stderr", "text", "detail", "details", "data", "results"]) {
      if (value[key] != null) collect(value[key], depth + 1);
    }
  };
  collect(error?.message);
  collect(result?.stderr);
  collect(result?.text);
  collect(result?.json);
  const raw = messages.join("\n").slice(0, 1600) || "Office CLI 执行失败";
  const source = Object.assign(new Error(raw), { code: error?.code || codes.find((code) => ["EPERM", "EACCES", "EBUSY"].includes(code.toUpperCase())) || undefined });
  const normalized = normalizeWorkspaceWriteError(source, "Office CLI 执行失败");
  if (["WORKSPACE_PERMISSION_DENIED", "OFFICE_DOCUMENT_LOCKED"].includes(normalized.code)) {
    normalized.args = Array.isArray(args) ? args.slice(0, 8) : [];
    return normalized;
  }
  if (error?.code) return error;
  const failure = new Error(raw || "Office CLI 执行失败");
  failure.code = "OFFICECLI_FAILED";
  failure.args = Array.isArray(args) ? args.slice(0, 8) : [];
  return failure;
}

export function workspaceWriteHttpStatus(error) {
  if (["WRITE_CONFLICT", "OFFICE_DOCUMENT_LOCKED"].includes(error?.code)) return 409;
  if (["WRITE_SCOPE_ERROR", "WORKSPACE_INVALID", "MEMORY_WRITE_REQUIRES_PROPOSAL"].includes(error?.code)) return 400;
  if (["WORKSPACE_PERMISSION_DENIED", "EPERM", "EACCES"].includes(error?.code)) return 403;
  if (error?.code === "WORKSPACE_WRITE_UNAVAILABLE") return 503;
  return 500;
}
