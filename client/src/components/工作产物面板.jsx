import React, { useEffect, useMemo, useRef, useState } from "react";
import { confirmArtifactAcceptance, getRunAcceptance, listPublishedArtifacts, listRuns, publishArtifact, rollbackPublishedArtifact } from "../api.js";
import Icon from "./Icon.jsx";

const statusText = { running: "执行中", queued: "排队中", waiting_user: "等待回答", recovering: "恢复中", completed: "已完成", failed: "失败", cancelled: "已取消", aborted: "已中断" };

function eventText(event) {
  const data = event?.data || event?.payload || {};
  return String(data.summary || data.message || data.detail || data.toolName || data.stepName || data.status || "事件已记录").slice(0, 220);
}

function eventTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function artifactName(path) {
  return String(path || "").split(/[\\/]/).pop() || "未命名产物";
}

function artifactStatusLabel({ publication, result, resultStatus }) {
  if (publication) return `v${publication.version} 已固定`;
  if (resultStatus === "failed") return "验收失败";
  if (result?.readyToPublish) return "验收通过";
  if (resultStatus === "accepted") return "已确认";
  return "待验收";
}

function EventStream({ clientId, threadId }) {
  const [events, setEvents] = useState([]);
  const [connected, setConnected] = useState(false);
  const eventsRef = useRef(new Map());
  const cursorRef = useRef(0);
  const flushTimerRef = useRef(null);

  useEffect(() => {
    setEvents([]);
    setConnected(false);
    eventsRef.current = new Map();
    cursorRef.current = 0;
    if (!clientId || !threadId) return undefined;
    let source = null;
    let retryTimer = null;
    let stopped = false;
    let retryDelay = 800;

    const flush = () => {
      flushTimerRef.current = null;
      const next = [...eventsRef.current.values()]
        .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0))
        .slice(-120);
      setEvents(next);
    };
    const scheduleFlush = () => {
      if (!flushTimerRef.current) flushTimerRef.current = window.setTimeout(flush, 80);
    };
    const scheduleReconnect = () => {
      if (stopped || retryTimer) return;
      setConnected(false);
      try { source?.close(); } catch {}
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        connect();
      }, retryDelay);
      retryDelay = Math.min(5000, retryDelay * 2);
    };
    const connect = () => {
      if (stopped) return;
      const after = cursorRef.current || 0;
      source = new EventSource(`/api/agent/events?client=${encodeURIComponent(clientId)}&thread=${encodeURIComponent(threadId)}&after=${after}&limit=400`);
      source.onopen = () => {
        retryDelay = 800;
        setConnected(true);
      };
      source.onmessage = (message) => {
        try {
          const payload = JSON.parse(message.data || "{}");
          const event = payload.event || payload;
          if (!event?.type) return;
          const seq = Number(event.seq || 0);
          if (seq && seq <= cursorRef.current) return;
          if (seq) cursorRef.current = seq;
          eventsRef.current.set(seq || `${event.type}:${event.at || Date.now()}`, event);
          while (eventsRef.current.size > 160) eventsRef.current.delete(eventsRef.current.keys().next().value);
          scheduleFlush();
        } catch {}
      };
      source.onerror = scheduleReconnect;
    };
    connect();
    return () => {
      stopped = true;
      try { source?.close(); } catch {}
      if (retryTimer) clearTimeout(retryTimer);
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, [clientId, threadId]);

  return (
    <div className="preview-event-stream">
      <div className="preview-data-meta"><span>本轮事件流</span><span className={connected ? "preview-live" : "preview-muted"}>{connected ? "实时连接" : "等待连接"}</span></div>
      {!events.length && <div className="preview-empty"><Icon name="flow" size={20} />暂无当前会话事件</div>}
      {events.slice().reverse().map((event) => (
        <details className="preview-event" key={`${event.seq || "event"}-${event.type}`}>
          <summary>
            <i className={event.type.includes("error") || event.type.includes("fail") ? "error" : event.type.includes("run") ? "running" : ""} />
            <strong>{event.type}</strong>
            <span>{eventTime(event.timestamp || event.createdAt || event.time)}</span>
            <Icon name="chevronRight" size={11} />
          </summary>
          <div className="preview-event-detail">{eventText(event)}</div>
        </details>
      ))}
    </div>
  );
}

function ArtifactPanel({ workspace, projectId, currentSessionId, refreshToken = 0, onOpenFile }) {
  const [runs, setRuns] = useState([]);
  const [published, setPublished] = useState([]);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState("");
  const [acceptance, setAcceptance] = useState({});
  const refreshSeqRef = useRef(0);

  const refresh = async () => {
    const requestSeq = ++refreshSeqRef.current;
    setLoading(true);
    try {
      const [runData, publishedData] = await Promise.all([
        listRuns("", 100, { cwd: workspace, projectId }),
        listPublishedArtifacts(workspace, projectId),
      ]);
      if (requestSeq !== refreshSeqRef.current) return;
      const nextRuns = (runData.runs || []).filter((run) => run?.artifacts?.length && (!currentSessionId || run.sessionId === currentSessionId));
      setRuns(nextRuns);
      setPublished(publishedData.artifacts || []);
      const acceptanceEntries = await Promise.all(nextRuns.slice(0, 12).map(async (run) => {
        try { const result = await getRunAcceptance(run.id); return [run.id, result.run?.acceptance || result.acceptance || null]; } catch { return [run.id, null]; }
      }));
      if (requestSeq !== refreshSeqRef.current) return;
      setAcceptance(Object.fromEntries(acceptanceEntries.filter(([, value]) => value)));
    } catch {}
    if (requestSeq === refreshSeqRef.current) setLoading(false);
  };

  // 根级事件流每收到一次重要事件都会递增 refreshToken；任务完成后必须立即
  // 重新读取 Run 和固定成果，否则用户会看到旧的“暂无产物”，直到手动刷新。
  useEffect(() => { refresh(); }, [workspace, projectId, currentSessionId, refreshToken]);

  const entries = useMemo(() => runs.flatMap((run) => (run.artifacts || []).filter((item) => item.status !== "deleted").map((artifact) => ({ artifact, run }))), [runs]);
  const publishedByArtifact = useMemo(() => new Map(published.map((item) => [item.artifactId, item])), [published]);
  const readyCount = entries.filter(({ artifact, run }) => {
    const result = acceptance[run.id]?.artifacts?.find((item) => item.path === artifact.path) || artifact.acceptance;
    return result?.readyToPublish;
  }).length;
  // 只有「尚未回滚且存在上一正式版本」的成果才真正可回滚；首个版本没有历史版本。
  const rollbackableCount = published.filter((item) => item.status !== "rolled_back" && item.rollbackTarget).length;

  const runAction = async (key, callback) => {
    setAction(key);
    try { await callback(); await refresh(); } catch (error) { alert(error.message || "成果操作失败"); }
    setAction("");
  };

  return (
    <div className="preview-artifact-panel artifact-workspace">
      <div className="artifact-workspace-head">
        <div><span className="artifact-eyebrow">工作产物 · 当前会话</span><h3>产物验收与固定</h3><p>先打开预览确认内容，再固定为正式成果；固定后若存在上一正式版本可一键回滚，首个版本没有历史版本，需手动恢复。</p></div>
        <button className="btn-sm" onClick={refresh} disabled={loading} title="刷新当前会话产物"><Icon name="refresh" size={12} /> {loading ? "读取中…" : "刷新"}</button>
      </div>
      <div className="artifact-summary-grid">
        <div><strong>{entries.length}</strong><span>本轮产物</span></div>
        <div><strong>{readyCount}</strong><span>待固定</span></div>
        <div><strong>{published.length}</strong><span>正式版本</span></div>
      </div>
      <div className="artifact-list-card">
        <div className="artifact-list-head"><span>本轮文件</span><small>{currentSessionId ? "已按当前会话筛选" : "当前工作区"}</small></div>
        {loading && <div className="preview-empty">正在读取产物清单…</div>}
        {!loading && !entries.length && <div className="preview-empty"><Icon name="file" size={20} />本轮暂未生成产物</div>}
        {entries.map(({ artifact, run }, index) => {
        const name = artifactName(artifact.path);
        const publication = publishedByArtifact.get(artifact.artifactId);
        const result = acceptance[run.id]?.artifacts?.find((item) => item.path === artifact.path) || artifact.acceptance;
        const resultStatus = result?.status || artifact.acceptanceStatus || "not_checked";
        const canConfirm = run.status === "completed" && !publication && result && !result.readyToPublish && resultStatus !== "failed";
        const canPublish = run.status === "completed" && !publication && result?.readyToPublish;
        return (
          <div className="preview-artifact" key={`${artifact.artifactId || artifact.path}-${index}`}>
            <button className="preview-artifact-main" onClick={() => onOpenFile?.(artifact.path, undefined, run.cwd)} title={artifact.path}>
              <Icon name="file" size={14} />
              <span><strong>{name}</strong><small>{statusText[run.status] || run.status || "已完成"} · {String(artifact.path || "").replace(name, "").replace(/[\\/]$/, "") || "工作区根目录"}</small></span>
            </button>
            <span className={`preview-artifact-status ${publication ? "published" : resultStatus === "failed" ? "failed" : result?.readyToPublish ? "ready" : ""}`}>{artifactStatusLabel({ publication, result, resultStatus })}</span>
            {canConfirm && <button className="btn-xs" disabled={action === `confirm-${artifact.artifactId}`} onClick={() => runAction(`confirm-${artifact.artifactId}`, async () => { const note = window.prompt("请输入人工确认说明（可选）", "已检查内容、格式和页面显示"); if (note !== null) await confirmArtifactAcceptance(run.id, artifact.artifactId, note); })}>人工确认</button>}
            {canPublish && <button className="btn-xs" disabled={action === `publish-${artifact.artifactId}`} onClick={() => runAction(`publish-${artifact.artifactId}`, () => publishArtifact(run.id, artifact.artifactId))}>固定成果</button>}
          </div>
        );
        })}
      </div>
      {published.length > 0 && <div className="preview-publications artifact-publications"><div className="artifact-list-head"><span>正式成果版本</span><small>{rollbackableCount ? `可回滚 ${rollbackableCount} 个（回到上一正式版本）` : "当前没有可回滚的历史版本"}</small></div>{published.map((item) => {
        const rolledBack = item.status === "rolled_back";
        const canRollback = !rolledBack && !!item.rollbackTarget;
        return <div className="preview-publication" key={item.id}><span title={item.path}><Icon name="check" size={11} /> {artifactName(item.path)} · v{item.version}{rolledBack ? " · 已回滚" : ""}</span>{canRollback ? <button className="btn-xs" onClick={() => runAction(`rollback-${item.id}`, () => rollbackPublishedArtifact(item.id))}>回滚</button> : <small className="preview-publication-note">{rolledBack ? "已回滚" : "首个版本 · 无历史版本可回滚"}</small>}</div>;
      })}</div>}
    </div>
  );
}

export default function WorkProductPanel({ tab, clientId, threadId, workspace, projectId, currentSessionId, refreshToken = 0, onOpenFile, children }) {
  if (tab === "events") return <EventStream clientId={clientId} threadId={threadId} />;
  if (tab === "artifacts") return <ArtifactPanel workspace={workspace} projectId={projectId} currentSessionId={currentSessionId} refreshToken={refreshToken} onOpenFile={onOpenFile} />;
  return children;
}
