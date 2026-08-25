import React, { useCallback, useEffect, useMemo, useState } from "react";
import { getRun, listRuns } from "../api.js";
import Icon from "./Icon.jsx";

const ACTIVE = new Set(["running", "queued"]);
const statusText = {
  running: "执行中",
  queued: "排队中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

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

function TaskCard({ run, selected, onSelect }) {
  const status = run?.status || "completed";
  return (
    <button className={`task-center-item ${selected ? "selected" : ""}`} onClick={() => onSelect(run.id)}>
      <span className={`task-center-dot ${status}`} />
      <span className="task-center-item-main">
        <span className="task-center-item-title">{taskTitle(run)}</span>
        <span className="task-center-item-meta">{statusText[status] || status} · {progressText(run)}</span>
      </span>
      <Icon name="chevronRight" size={12} />
    </button>
  );
}

export default function TaskCenter() {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const result = await listRuns("", 30);
      setRuns(Array.isArray(result.runs) ? result.runs.filter(Boolean) : []);
      setError("");
    } catch (e) {
      setError(e.message || "任务状态暂不可用");
    }
  }, []);

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
        if (!cancelled) setDetail(result);
      } catch (e) {
        if (!cancelled) setError(e.message || "任务详情加载失败");
      }
    };
    load();
    const timer = window.setInterval(load, 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [selectedId]);

  const counts = useMemo(() => runs.filter(Boolean).reduce((acc, run) => {
    const status = run.status || "completed";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {}), [runs]);
  const activeCount = (counts.running || 0) + (counts.queued || 0);
  const visibleRuns = runs.filter(Boolean).slice(0, 12);

  return (
    <div className="task-center-wrap">
      <button
        className={`btn-sm task-center-trigger ${open ? "active" : ""}`}
        onClick={() => { setOpen((value) => !value); setSelectedId(null); setDetail(null); }}
        title={`并行任务：执行中 ${counts.running || 0}，排队中 ${counts.queued || 0}，已完成 ${counts.completed || 0}`}
        aria-expanded={open}
      >
        <span className="task-center-trigger-icon"><Icon name="list" size={14} /></span>
        <span className="task-center-trigger-label">任务</span>
        {activeCount > 0 && <span className="task-center-badge">{activeCount}</span>}
      </button>
      {open && (
        <div className="task-center-panel">
          <div className="task-center-head">
            <span><Icon name="list" size={13} /> 并行任务</span>
            <button className="btn-xs" onClick={refresh} title="刷新任务状态"><Icon name="refresh" size={11} /></button>
          </div>
          <div className="task-center-summary">
            <span>执行中 {counts.running || 0}</span>
            <span>排队中 {counts.queued || 0}</span>
            <span>已完成 {counts.completed || 0}</span>
          </div>
          {error && <div className="task-center-error">{error}</div>}
          {!detail ? (
            <div className="task-center-list">
              {visibleRuns.length ? visibleRuns.map((run) => <TaskCard key={run.id} run={run} onSelect={setSelectedId} />) : <div className="task-center-empty">暂无任务记录</div>}
            </div>
          ) : (
            <div className="task-center-detail">
              <button className="task-center-back" onClick={() => { setSelectedId(null); setDetail(null); }}><Icon name="back" size={11} /> 返回任务列表</button>
              <div className="task-center-detail-title">{taskTitle(detail)}</div>
              <div className="task-center-detail-meta">{statusText[detail.status] || detail.status} · {progressText(detail)}</div>
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
