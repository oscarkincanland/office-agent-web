import React, { useCallback, useEffect, useMemo, useState } from "react";
import { cancelRun, getRun, listRuns, resumeRun, retryRun } from "../api.js";
import Icon from "./Icon.jsx";

const ACTIVE = new Set(["running", "queued", "waiting_user", "recovering", "cancel_requested"]);
const statusText = {
  running: "执行中",
  queued: "排队中",
  waiting_user: "等待回答",
  recovering: "恢复中",
  cancel_requested: "正在中断",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  aborted: "已中断",
};

function modeText(run) {
  const mode = run?.task?.mode;
  return mode === "chat" ? "Chat" : mode === "office" ? "Office" : mode === "agent" ? "Agent" : "未标记";
}

function taskTitle(run) {
  return String(run?.task?.goal || run?.task?.title || run?.summary || "未命名任务")
    .replace(/^\[(?:模式|当前打开文件)[^\n]*\]\s*/g, "")
    .trim()
    .slice(0, 80);
}

function progressText(run) {
  const p = run?.progress || {};
  if (!p.total) {
    if (run?.status === "completed") return "已完成";
    if (run?.status === "failed") return "执行失败";
    if (run?.status === "cancelled") return "已取消";
    return run?.currentStep?.name || "正在处理";
  }
  return `${p.completed || 0}/${p.total} 步${run?.currentStep?.name ? ` · ${run.currentStep.name}` : ""}`;
}

function TaskCard({ run, selected, onSelect, projectName = "" }) {
  const status = run?.status || "completed";
  return (
    <button className={`task-center-item ${selected ? "selected" : ""}`} onClick={() => onSelect(run.id)}>
      <span className={`task-center-dot ${status}`} />
      <span className="task-center-item-main">
        <span className="task-center-item-title">{taskTitle(run)}</span>
      <span className="task-center-item-meta">{projectName ? `${projectName} · ` : ""}{modeText(run)} · {statusText[status] || status} · {progressText(run)}</span>
      </span>
      <Icon name="chevronRight" size={12} />
    </button>
  );
}

export default function TaskCenter({ sessions = [], projects = [], currentProjectId = "", currentWorkspace = "", currentThreadId = "", currentSessionId = "", eventVersion = 0, unreadCount = 0, onSelectSession, onFocusRun, onOpenRun }) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [action, setAction] = useState("");
  const [projectScope, setProjectScope] = useState("current");
  const [statusFilter, setStatusFilter] = useState("all");
  const [modeFilter, setModeFilter] = useState("all");
  const [queryFilter, setQueryFilter] = useState("");

  const refresh = useCallback(async () => {
    try {
      const options = {
        cwd: projectScope === "current" ? currentWorkspace : "",
        projectId: projectScope !== "current" && projectScope !== "all" ? projectScope : "",
        status: statusFilter,
        mode: modeFilter,
        query: queryFilter.trim(),
      };
      const result = await listRuns("", 50, options);
      setRuns(Array.isArray(result.runs) ? result.runs.filter(Boolean) : []);
      setError("");
    } catch (e) {
      setError(e.message || "任务状态暂不可用");
    }
  }, [currentWorkspace, eventVersion, modeFilter, projectScope, queryFilter, statusFilter]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, open ? 1500 : 4000);
    return () => window.clearInterval(timer);
  }, [open, refresh]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const result = await getRun(selectedId);
        if (!cancelled) setDetail(result.run || result);
      } catch (e) {
        if (!cancelled) setError(e.message || "任务详情加载失败");
      }
    };
    load();
    const timer = window.setInterval(load, 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [selectedId, eventVersion]);

  const runAction = useCallback(async (type) => {
    if (!detail?.id || action) return;
    setAction(type);
    setError("");
    try {
      let result;
      if (type === "cancel") result = await cancelRun(detail.id);
      else if (type === "resume") result = await resumeRun(detail.id);
      else result = await retryRun(detail.id);
      await refresh();
      const nextRun = result?.run || result;
      setDetail(nextRun?.id ? nextRun : (await getRun(detail.id)).run);
      if (type !== "cancel" && nextRun?.id) onOpenRun?.(nextRun);
    } catch (e) {
      setError(e.message || "任务操作失败");
    } finally {
      setAction("");
    }
  }, [detail, action, onOpenRun, refresh]);

  const counts = useMemo(() => runs.filter(Boolean).reduce((acc, run) => {
    const status = run.status || "completed";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {}), [runs]);
  const activeCount = [...ACTIVE].reduce((total, status) => total + (counts[status] || 0), 0);
  const visibleRuns = runs.filter(Boolean).slice(0, 12);

  const openRunConversation = useCallback((run) => {
    const session = sessions.find((item) => item?.id && (
      item.id === run?.sessionId || item.id === run?.threadId
    ));
    if (session) {
      onSelectSession?.(session);
      setOpen(false);
      setSelectedId(null);
      setDetail(null);
      return;
    }
    // 运行中的任务在 session 文件尚未刷新时通常只有 threadId；
    // 如果正好是当前对话，直接聚焦即可。
    if (run?.threadId && (run.threadId === currentThreadId || run.sessionId === currentSessionId)) {
      onFocusRun?.(run);
      setOpen(false);
      setSelectedId(null);
      setDetail(null);
    }
    else if (run?.sessionId || run?.threadId) {
      onOpenRun?.(run);
      setOpen(false);
      setSelectedId(null);
      setDetail(null);
    }
  }, [sessions, currentThreadId, currentSessionId, onSelectSession, onFocusRun, onOpenRun]);

  const projectNameFor = (run) => projects.find((item) => item.id === run?.projectId)?.name || "";

  return (
    <div className="task-center-wrap">
      <button
        className={`btn-sm task-center-trigger ${open ? "active" : ""}`}
        onClick={() => { setOpen((value) => !value); setSelectedId(null); setDetail(null); }}
        title={`任务：执行中 ${counts.running || 0}，恢复中 ${counts.recovering || 0}，已完成 ${counts.completed || 0}`}
        aria-expanded={open}
      >
        <span className="task-center-trigger-icon"><Icon name="list" size={14} /></span>
        <span className="task-center-trigger-label">任务</span>
        {activeCount > 0 && <span className="task-center-badge">{activeCount}</span>}
        {unreadCount > 0 && <span className="task-center-unread" title="后台会话有新的任务状态">{unreadCount > 99 ? "99+" : unreadCount}</span>}
      </button>
      {open && (
        <div className="task-center-panel">
          <div className="task-center-head">
            <span><Icon name="list" size={13} /> 并行任务</span>
            <button className="btn-xs" onClick={refresh} title="刷新任务状态"><Icon name="refresh" size={11} /></button>
          </div>
          <div className="task-center-filters">
            <select value={projectScope} onChange={(e) => setProjectScope(e.target.value)} title="项目范围">
              <option value="current">当前项目</option>
              <option value="all">全部项目</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} title="任务状态">
              <option value="all">全部状态</option>
              {Object.entries(statusText).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
            <select value={modeFilter} onChange={(e) => setModeFilter(e.target.value)} title="任务模式">
              <option value="all">全部模式</option><option value="chat">Chat</option><option value="office">Office</option><option value="agent">Agent</option>
            </select>
            <input value={queryFilter} onChange={(e) => setQueryFilter(e.target.value)} placeholder="搜索任务或失败原因" title="搜索任务目标、摘要或失败原因" />
          </div>
          <div className="task-center-summary">
            <span>执行中 {counts.running || 0}</span>
            <span>排队中 {counts.queued || 0}</span>
            <span>已完成 {counts.completed || 0}</span>
          </div>
          {error && <div className="task-center-error">{error}</div>}
          {!detail ? (
            <div className="task-center-list">
              {visibleRuns.length ? visibleRuns.map((run) => <TaskCard key={run.id} run={run} projectName={projectNameFor(run)} onSelect={(id) => {
                setSelectedId(id);
              }} />) : <div className="task-center-empty">暂无任务记录</div>}
            </div>
          ) : (
            <div className="task-center-detail">
              <button className="task-center-back" onClick={() => { setSelectedId(null); setDetail(null); }}><Icon name="back" size={11} /> 返回任务列表</button>
              <div className="task-center-detail-title">{taskTitle(detail)}</div>
              <div className="task-center-detail-meta">{projectNameFor(detail) || "当前项目"} · {modeText(detail)} · {statusText[detail.status] || detail.status} · {progressText(detail)}</div>
              <button className="btn-xs task-center-open-chat" onClick={() => openRunConversation(detail)}>打开对应对话</button>
              <div className="task-center-actions">
                {detail.actions?.canCancel && <button className="btn-xs danger" onClick={() => runAction("cancel")} disabled={!!action}>{action === "cancel" ? "取消中…" : "取消任务"}</button>}
                {detail.actions?.canResume && <button className="btn-xs" onClick={() => runAction("resume")} disabled={!!action}>{action === "resume" ? "继续中…" : "继续任务"}</button>}
                {detail.actions?.canRetry && <button className="btn-xs" onClick={() => runAction("retry")} disabled={!!action}>{action === "retry" ? "重试中…" : "重试任务"}</button>}
              </div>
              {detail.error && <div className="task-center-detail-error">失败原因：{detail.error}</div>}
              <div className="task-center-steps">
                {(detail.steps || []).map((step) => (
                  <div className={`task-center-step ${step.status}`} key={step.id}>
                    <span>{step.status === "completed" ? "✓" : step.status === "running" ? "•" : "○"}</span>
                    <span>{step.name}</span>
                    {step.error && <small>{step.error}</small>}
                  </div>
                ))}
              </div>
              {!!detail.artifacts?.length && <div className="task-center-artifacts">产物 {detail.artifacts.length} 个</div>}
              <div className="task-center-events">
                {(detail.events || []).slice(-8).reverse().map((event, index) => <div key={`${event.seq || "event"}-${index}`}><span>{event.type}</span><small>{event.at ? new Date(event.at).toLocaleTimeString() : ""}</small></div>)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
