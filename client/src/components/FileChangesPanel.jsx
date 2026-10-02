import React, { useCallback, useMemo, useState } from "react";
import Icon from "./Icon.jsx";
import { getRunChangeDiff } from "../api.js";
import { openInSystem, revealInSystem } from "../api.js";

/**
 * 本轮文件改动面板（W3/C02 + C03）
 *
 * 语义约定：
 *   - 按 runId 归属：只显示这一轮的真实改动（面板由上层按 selectedRunId 传入）；
 *   - 单一文件集合：列表只显示名称/类型/状态与打开入口，验收与版本进详情；
 *   - 内容差异按需加载（分页），不在 run_finished 时同步解析全部文件；
 *   - 非文本（Office/PDF/图片/二进制）只给大小与哈希摘要，并明确“暂不支持精确对齐”；
 *   - 删除记录必须可见；内部文件（缓存/临时/运行记录）默认折叠到末尾并可展开。
 */
const CHANGE_LABEL = { added: "新增", modified: "修改", deleted: "删除", renamed: "重命名", unclassified: "变更" };
const KIND_LABEL = { text: "文本", office: "Office", pdf: "PDF", image: "图片", binary: "二进制" };
const ROLE_LABEL = { deliverable: "交付", supporting: "支撑", unclassified: "待定", internal: "内部" };

function changeTone(change) {
  if (change.changeType === "deleted") return "danger";
  if (change.confidence === "suspected") return "warn";
  if (change.role === "internal") return "muted";
  return "";
}

function DiffView({ diff }) {
  if (!diff) return null;
  const { summary } = diff;
  const isText = diff.kind === "text";
  return (
    <div className="file-diff">
      <div className="file-diff-summary">
        <span className={`file-diff-kind kind-${diff.kind}`}>{KIND_LABEL[diff.kind] || diff.kind}</span>
        {isText ? (
          <>
            <span className="diff-added">+{summary.added} 行</span>
            <span className="diff-removed">-{summary.removed} 行</span>
            {diff.identical && <span className="file-diff-flag">内容一致（仅元数据变化）</span>}
            {diff.eol?.changed && <span className="file-diff-flag">换行风格变化（CRLF/LF）</span>}
            {diff.degraded && <span className="file-diff-flag warn">文件过长，已退化为整体替换视图</span>}
            {diff.inputTruncated && <span className="file-diff-flag warn">输入超出上限，仅比对前 {Math.round((diff.limits?.maxInputBytes || 0) / 1024)}KB</span>}
          </>
        ) : (
          <>
            {summary.beforeSize != null && summary.afterSize != null && (
              <span className="file-diff-size">{summary.beforeSize} → {summary.afterSize} 字节{summary.sizeDelta ? `（${summary.sizeDelta > 0 ? "+" : ""}${summary.sizeDelta}）` : ""}</span>
            )}
            {summary.hashChanged === true && <span className="file-diff-flag">内容哈希已变化</span>}
            {summary.hashChanged === false && <span className="file-diff-flag">内容哈希未变化</span>}
          </>
        )}
      </div>
      {diff.note && <div className="file-diff-note">{diff.note}</div>}
      {isText && diff.hunks?.length > 0 && (
        <div className="file-diff-hunks">
          {diff.hunks.map((hunk, hunkIndex) => (
            <div className="file-diff-hunk" key={`${hunk.beforeStart}-${hunk.afterStart}-${hunkIndex}`}>
              <div className="file-diff-hunk-head">@@ -{hunk.beforeStart} +{hunk.afterStart} @@</div>
              {hunk.ops.map((op, opIndex) => (
                <div className={`file-diff-line ${op.type}`} key={`${op.type}-${opIndex}`}>
                  <span className="file-diff-gutter">{op.type === "insert" ? "+" : op.type === "delete" ? "-" : " "}</span>
                  <span className="file-diff-lineno">{op.beforeLine ?? op.afterLine ?? ""}</span>
                  <code>{op.text || " "}</code>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {isText && !diff.hunks?.length && <div className="file-diff-note">没有行级差异（可能只是元数据或换行风格变化）。</div>}
    </div>
  );
}

export default function FileChangesPanel({ runId, changes = [], detection = null, onOpenFile, className = "" }) {
  const [openId, setOpenId] = useState(null);
  const [diffs, setDiffs] = useState({});
  const [showInternal, setShowInternal] = useState(false);

  const { visible, internalCount, suspectedCount, deletedCount } = useMemo(() => {
    const list = Array.isArray(changes) ? changes : [];
    return {
      visible: list.filter((change) => change.role !== "internal" || showInternal),
      internalCount: list.filter((change) => change.role === "internal").length,
      suspectedCount: list.filter((change) => change.confidence === "suspected").length,
      deletedCount: list.filter((change) => change.changeType === "deleted").length,
    };
  }, [changes, showInternal]);

  const loadDiff = useCallback(async (change, page = 0) => {
    if (!runId || !change?.changeId) return;
    setDiffs((state) => ({ ...state, [change.changeId]: { ...(state[change.changeId] || {}), loading: true, error: null } }));
    try {
      const result = await getRunChangeDiff(runId, change.changeId, page);
      setDiffs((state) => ({ ...state, [change.changeId]: { loading: false, error: null, data: result.diff, limits: result.limits, page } }));
    } catch (error) {
      setDiffs((state) => ({ ...state, [change.changeId]: { loading: false, error: error.message || String(error) } }));
    }
  }, [runId]);

  const toggleDiff = useCallback((change) => {
    if (!change?.changeId) return;
    const isOpen = openId === change.changeId;
    setOpenId(isOpen ? null : change.changeId);
    if (!isOpen && !diffs[change.changeId]?.data) loadDiff(change, 0);
  }, [diffs, loadDiff, openId]);

  const handleOpen = useCallback((change) => {
    if (onOpenFile) onOpenFile(change.relativePath);
    else openInSystem(change.relativePath).catch((error) => alert(`打开失败：${error.message}`));
  }, [onOpenFile]);

  const handleReveal = useCallback((change) => {
    revealInSystem(change.relativePath).catch((error) => alert(`在文件管理器中显示失败：${error.message}`));
  }, []);

  return (
    <div className={`file-changes-panel ${className}`}>
      <div className="file-changes-head">
        <span className="file-changes-title"><Icon name="edit" size={12} /> 本轮文件改动 {changes.length ? `（${changes.length}）` : ""}</span>
        {deletedCount > 0 && <span className="file-changes-flag danger">删除 {deletedCount}</span>}
        {suspectedCount > 0 && <span className="file-changes-flag warn">疑似 {suspectedCount}</span>}
        {internalCount > 0 && (
          <button type="button" className="btn-xs" onClick={() => setShowInternal((value) => !value)} title="内部文件（运行记录/缓存/临时）默认折叠">
            {showInternal ? "隐藏内部文件" : `显示内部文件（${internalCount}）`}
          </button>
        )}
      </div>

      {!changes.length && (
        <div className="preview-empty">
          <Icon name="file" size={20} />
          本轮没有文件改动
          {detection?.truncated ? "（工作区过大，改动检测可能不完整）" : ""}
        </div>
      )}

      <div className="file-changes-list">
        {visible.map((change) => {
          const open = openId === change.changeId;
          const state = diffs[change.changeId] || {};
          return (
            <div className={`file-change-row ${changeTone(change)}`} key={change.changeId || change.relativePath}>
              <div className="file-change-main">
                <button
                  type="button"
                  className="file-change-name"
                  onClick={() => toggleDiff(change)}
                  aria-expanded={open}
                  title={`${change.relativePath}（点击查看内容差异）`}
                >
                  <Icon name={change.changeType === "deleted" ? "trash" : "file"} size={12} />
                  <span className="file-change-path">{change.relativePath}</span>
                  <span className={`file-change-type ${change.changeType}`}>{CHANGE_LABEL[change.changeType] || change.changeType}</span>
                  {change.role === "deliverable" && <span className="file-change-role">交付</span>}
                  {change.confidence === "suspected" && <span className="file-change-role warn" title="由运行窗口的修改时间推测，未做内容比对">疑似</span>}
                </button>
                <span className="file-change-meta">{ROLE_LABEL[change.role] || ""}</span>
                <span className="file-change-actions">
                  <button type="button" className="btn-xs" onClick={() => handleOpen(change)} title="在应用内/系统应用打开"><Icon name="externalLink" size={11} /> 打开</button>
                  <button type="button" className="btn-xs" onClick={() => handleReveal(change)} title="在文件管理器中显示"><Icon name="folderOpen" size={11} /></button>
                </span>
              </div>
              {open && (
                <div className="file-change-detail">
                  {state.loading && <div className="file-diff-note">正在计算内容差异…</div>}
                  {state.error && <div className="file-diff-note warn">差异读取失败：{state.error}</div>}
                  {state.data && <DiffView diff={{ ...state.data, limits: state.limits }} />}
                  {state.data?.kind === "text" && state.data.pageCount > 1 && (
                    <div className="file-diff-pager">
                      <button type="button" className="btn-xs" disabled={state.page <= 0} onClick={() => loadDiff(change, Math.max(0, (state.page || 0) - 1))}>上一页</button>
                      <span>第 {(state.page || 0) + 1}/{state.data.pageCount} 页</span>
                      <button type="button" className="btn-xs" disabled={(state.page || 0) + 1 >= state.data.pageCount} onClick={() => loadDiff(change, (state.page || 0) + 1)}>下一页</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
