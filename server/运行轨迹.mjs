/**
 * 运行完成语义：把“模型回答结束”与“任务真正完成”区分开。
 *
 * - 显式完成：模型调用 complete_task 工具，声明 success/partial/blocked/failed；
 * - 兼容推断：模型未调用时由 Run 终态推断，标记 source:"inferred"，
 *   不伪装成显式验收成功。
 */

export const COMPLETION_STATUSES = Object.freeze(["success", "partial", "blocked", "failed"]);

const STATUS_LABELS = Object.freeze({
  success: "已完成",
  partial: "部分完成",
  blocked: "受阻",
  failed: "失败",
  cancelled: "已取消",
});

export function completionStatusLabel(status) {
  return STATUS_LABELS[status] || "已结束";
}

/** 归一化 complete_task 工具参数；非法内容返回 null。 */
export function normalizeCompletion(raw = {}) {
  const status = String(raw?.status || "").trim().toLowerCase();
  if (!COMPLETION_STATUSES.includes(status)) return null;
  const summary = String(raw?.summary || "").trim().slice(0, 600);
  if (!summary) return null;
  const toList = (value) => (Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 10);
  return {
    status,
    source: "explicit",
    summary,
    incomplete: toList(raw?.incomplete),
    blockers: toList(raw?.blockers),
    verification: String(raw?.verification || "").trim().slice(0, 300) || null,
    at: new Date().toISOString(),
  };
}

/**
 * 模型未显式声明完成时，用 Run 终态推断。
 * 推断结果统一带 source:"inferred"，前端据此区分展示。
 */
export function inferCompletion({ runStatus = "completed", artifacts = 0, validations = [] } = {}) {
  const failedValidation = Array.isArray(validations) && validations.some((item) => item?.status === "failed");
  let status = "success";
  let summary = "";
  if (runStatus === "cancelled" || runStatus === "aborted") {
    status = "cancelled";
    summary = "任务在完成前被中断";
  } else if (runStatus === "failed") {
    status = "failed";
    summary = "任务执行失败";
  } else if (failedValidation) {
    status = "partial";
    summary = "任务结束，但部分产物未通过校验";
  } else {
    summary = artifacts ? `任务结束，产生 ${artifacts} 项文件变更` : "任务结束，未检测到文件变更";
  }
  return {
    status,
    source: "inferred",
    summary,
    incomplete: [],
    blockers: [],
    verification: failedValidation ? "failed" : null,
    at: new Date().toISOString(),
  };
}
