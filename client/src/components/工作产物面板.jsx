import React, { useEffect, useMemo, useState } from "react";
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

function EventStream({ clientId, threadId }) {
  const [events, setEvents] = useState([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setEvents([]);
    setConnected(false);
    if (!clientId || !threadId) return undefined;
    const source = new EventSource(`/api/agent/events?client=${encodeURIComponent(clientId)}&thread=${encodeURIComponent(threadId)}&after=0`);
    source.onopen = () => setConnected(true);
    source.onmessage = (message) => {
      try {
        const payload = JSON.parse(message.data || "{}");
        const event = payload.event || payload;
        if (!event?.type) return;
        setEvents((previous) => {
          const next = [...previous.filter((item) => item.seq !== event.seq), event];
          return next.slice(-120);
        });
      } catch {}
    };
    source.onerror = () => setConnected(false);
    return () => source.close();
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

function ArtifactPanel({ workspace, projectId, currentSessionId, onOpenFile }) {
  const [runs, setRuns] = useState([]);
  const [published, setPublished] = useState([]);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState("");
  const [acceptance, setAcceptance] = useState({});

  const refresh = async () => {
    setLoading(true);
    try {
      const [runData, publishedData] = await Promise.all([
        listRuns("", 100, { cwd: workspace, projectId }),
        listPublishedArtifacts(workspace, projectId),
      ]);
      const nextRuns = (runData.runs || []).filter((run) => run?.artifacts?.length && (!currentSessionId || run.sessionId === currentSessionId));
      setRuns(nextRuns);
      setPublished(publishedData.artifacts || []);
      const acceptanceEntries = await Promise.all(nextRuns.slice(0, 12).map(async (run) => {
        try { const result = await getRunAcceptance(run.id); return [run.id, result.run?.acceptance || result.acceptance || null]; } catch { return [run.id, null]; }
      }));
      setAcceptance(Object.fromEntries(acceptanceEntries.filter(([, value]) => value)));
    } catch {}
    setLoading(false);
  };

  useEffect(() => { refresh(); }, [workspace, projectId, currentSessionId]);

  const entries = useMemo(() => runs.flatMap((run) => (run.artifacts || []).filter((item) => item.status !== "deleted").map((artifact) => ({ artifact, run }))), [runs]);
  const publishedByArtifact = useMemo(() => new Map(published.map((item) => [item.artifactId, item])), [published]);

  const runAction = async (key, callback) => {
    setAction(key);
    try { await callback(); await refresh(); } catch (error) { alert(error.message || "成果操作失败"); }
    setAction("");
  };

  return (
    <div className="preview-artifact-panel">
      <div className="preview-data-meta"><span>当前会话工作产物</span><button className="btn-icon" onClick={refresh} title="刷新产物"><Icon name="refresh" size={12} /></button></div>
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
            <button className="preview-artifact-main" onClick={() => onOpenFile?.(artifact.path)} title={artifact.path}>
              <Icon name="file" size={14} />
              <span><strong>{name}</strong><small>{statusText[run.status] || run.status || "已完成"} · Run {String(run.id || "").slice(-8)}</small></span>
            </button>
            <span className={`preview-artifact-status ${publication ? "published" : resultStatus === "failed" ? "failed" : ""}`}>{publication ? `v${publication.version} 已固定` : result?.readyToPublish ? "验收通过" : "可回滚"}</span>
            {canConfirm && <button className="btn-xs" disabled={action === `confirm-${artifact.artifactId}`} onClick={() => runAction(`confirm-${artifact.artifactId}`, async () => { const note = window.prompt("请输入人工确认说明（可选）", "已检查内容、格式和页面显示"); if (note !== null) await confirmArtifactAcceptance(run.id, artifact.artifactId, note); })}>人工确认</button>}
            {canPublish && <button className="btn-xs" disabled={action === `publish-${artifact.artifactId}`} onClick={() => runAction(`publish-${artifact.artifactId}`, () => publishArtifact(run.id, artifact.artifactId))}>固定成果</button>}
          </div>
        );
      })}
      {published.length > 0 && <div className="preview-publications"><div className="preview-data-meta">正式成果版本</div>{published.map((item) => <div className="preview-publication" key={item.id}><span title={item.path}>{artifactName(item.path)} · v{item.version}</span>{item.status !== "rolled_back" && item.rollbackTarget && <button className="btn-xs" onClick={() => runAction(`rollback-${item.id}`, () => rollbackPublishedArtifact(item.id))}>回滚</button>}</div>)}</div>}
    </div>
  );
}

export default function WorkProductPanel({ tab, clientId, threadId, workspace, projectId, currentSessionId, onOpenFile, children }) {
  if (tab === "events") return <EventStream clientId={clientId} threadId={threadId} />;
  if (tab === "artifacts") return <ArtifactPanel workspace={workspace} projectId={projectId} currentSessionId={currentSessionId} onOpenFile={onOpenFile} />;
  return children;
}
