import React, { useEffect, useState, useCallback, useRef } from "react";
import Icon from "./Icon.jsx";
import { approveMemoryProposal, editMemoryProposal, listMemoryProposals, memoryProposalHistory, mergeMemoryProposals, rejectMemoryProposal } from "../api.js";

const MEMORY_CATEGORY_LABELS = {
  project_fact: "项目事实",
  work_rule: "工作规则",
  user_preference: "用户偏好",
  lesson: "经验教训",
  resource_index: "资料索引",
};

export default function MemoryTab({ workspace = "" }) {
  const [files, setFiles] = useState([]);
  const [active, setActive] = useState(null); // rel path
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [changes, setChanges] = useState([]); // {file, preview, time}
  const [loading, setLoading] = useState(false);
  const [proposals, setProposals] = useState([]);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [proposalStatus, setProposalStatus] = useState("pending");
  const [selectedProposals, setSelectedProposals] = useState([]);
  const [editingProposal, setEditingProposal] = useState(null);
  const [proposalDraft, setProposalDraft] = useState("");
  const [history, setHistory] = useState(null);
  const [proposalMsg, setProposalMsg] = useState("");
  const saveTimer = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const [r, p] = await Promise.all([
        fetch("/api/memory"),
        listMemoryProposals(workspace, proposalStatus).catch(() => ({ proposals: [] })),
      ]);
      const d = await r.json();
      setFiles(d.files || []);
      setProposals(p.proposals || []);
    } catch {}
  }, [workspace, proposalStatus]);

  useEffect(() => { refresh(); }, [refresh]);

  // SSE 记忆变更监听
  useEffect(() => {
    const es = new EventSource("/api/memory/stream");
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        setChanges((prev) => {
          const next = [data, ...prev.filter((c) => c.file !== data.file)].slice(0, 8);
          return next;
        });
        // 如果正在查看变更的文件，自动刷新
        if (active === data.file && !dirty) loadFile(active);
      } catch {}
    };
    es.onerror = () => {};
    return () => es.close();
  }, [active, dirty]);

  const loadFile = useCallback(async (rel) => {
    try {
      const r = await fetch(`/api/memory/${encodeURIComponent(rel)}`);
      const d = await r.json();
      setActive(rel);
      setContent(d.content || "");
      setEditing(false);
      setDirty(false);
    } catch {}
  }, []);

  const saveFile = useCallback(async () => {
    if (!active || !dirty) return;
    setLoading(true);
    try {
      await fetch(`/api/memory/${encodeURIComponent(active)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      setDirty(false);
    } catch {}
    setLoading(false);
  }, [active, content, dirty]);

  // 自动保存防抖
  useEffect(() => {
    if (!dirty) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(saveFile, 800);
    return () => clearTimeout(saveTimer.current);
  }, [dirty, saveFile]);

  const handleInit = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/memory/init", { method: "POST" });
      const d = await r.json();
      if (d.files) setFiles(d.files);
    } catch {}
    setLoading(false);
  };

  const dismissChange = (file) => {
    setChanges((prev) => prev.filter((c) => c.file !== file));
  };

  const handleApproveProposal = async (id) => {
    if (proposalLoading) return;
    setProposalLoading(true);
    setProposalMsg("");
    try {
      await approveMemoryProposal(id);
      setSelectedProposals((prev) => prev.filter((item) => item !== id));
      refresh();
    } catch (error) { setProposalMsg(`批准失败：${error.message}`); }
    setProposalLoading(false);
  };

  const handleRejectProposal = async (id) => {
    const reason = window.prompt("拒绝原因（可选）", "用户拒绝该记忆建议");
    if (reason === null || proposalLoading) return;
    setProposalLoading(true);
    setProposalMsg("");
    try {
      await rejectMemoryProposal(id, reason);
      setSelectedProposals((prev) => prev.filter((item) => item !== id));
      refresh();
    } catch (error) { setProposalMsg(`拒绝失败：${error.message}`); }
    setProposalLoading(false);
  };

  const startProposalEdit = (proposal) => {
    setEditingProposal(proposal.id);
    setProposalDraft(proposal.content || "");
    setProposalMsg("");
  };

  const saveProposalEdit = async (proposal) => {
    if (proposalLoading) return;
    setProposalLoading(true);
    setProposalMsg("");
    try {
      await editMemoryProposal(proposal.id, { content: proposalDraft, category: proposal.category });
      setEditingProposal(null);
      refresh();
    } catch (error) { setProposalMsg(`编辑失败：${error.message}`); }
    setProposalLoading(false);
  };

  const toggleProposal = (id) => {
    setSelectedProposals((prev) => prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]);
  };

  const handleMerge = async () => {
    if (selectedProposals.length < 2 || proposalLoading) return;
    setProposalLoading(true);
    setProposalMsg("");
    try {
      await mergeMemoryProposals(selectedProposals[0], selectedProposals.slice(1));
      setSelectedProposals([]);
      refresh();
    } catch (error) { setProposalMsg(`合并失败：${error.message}`); }
    setProposalLoading(false);
  };

  const loadProposalHistory = async (id) => {
    if (history?.id === id) { setHistory(null); return; }
    try { setHistory(await memoryProposalHistory(id)); } catch (error) { setProposalMsg(`历史读取失败：${error.message}`); }
  };

  return (
    <div className="memory-tab">
      {/* 记忆变更 Dock（Proma MemoryChangeDock 风格） */}
      {changes.length > 0 && (
        <div className="memory-dock">
          <div className="memory-dock-head"><Icon name="info" size={10} /> 记忆已更新</div>
          {changes.map((c) => (
            <div key={c.file} className="memory-change-item" onClick={() => loadFile(c.file)}>
              <Icon name="file" size={10} />
              <span className="memory-change-file">{c.file}</span>
              <button className="memory-change-dismiss" onClick={(e) => { e.stopPropagation(); dismissChange(c.file); }}>
                <Icon name="x" size={9} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 待沉淀卡片：长期记忆必须经过用户确认 */}
      <div className="memory-proposals">
          <div className="memory-proposals-head">
            <span><Icon name="bookmark" size={11} /> 记忆治理（{proposals.length}）</span>
            <select value={proposalStatus} onChange={(e) => { setProposalStatus(e.target.value); setSelectedProposals([]); }}>
              <option value="pending">待审核</option>
              <option value="all">全部历史</option>
              <option value="approved">已批准</option>
              <option value="rejected">已拒绝</option>
              <option value="merged">已合并</option>
            </select>
          </div>
          {selectedProposals.length >= 2 && <button className="btn-xs" onClick={handleMerge} disabled={proposalLoading}>合并所选（首条为主建议）</button>}
          {proposalMsg && <div className="memory-proposal-msg">{proposalMsg}</div>}
          {proposals.length === 0 && <div className="memory-proposal-empty">当前筛选下没有记忆建议。</div>}
          {proposals.map((proposal) => (
            <div className="memory-proposal-row" key={proposal.id}>
              {proposal.status === "pending" && <input type="checkbox" checked={selectedProposals.includes(proposal.id)} onChange={() => toggleProposal(proposal.id)} title="选择合并" />}
              <div className="memory-proposal-copy">
                <strong>{proposal.section || MEMORY_CATEGORY_LABELS[proposal.category] || proposal.category} · {proposal.status === "pending" ? "待审核" : proposal.status}</strong>
                {editingProposal === proposal.id ? (
                  <textarea className="memory-proposal-edit" value={proposalDraft} onChange={(e) => setProposalDraft(e.target.value)} />
                ) : <span>{proposal.content}</span>}
                <small>来源：{proposal.source?.label || "Agent"} · Run：{proposal.runId || "无"} · v{proposal.version || 1}</small>
                {history?.id === proposal.id && <div className="memory-proposal-history">{(history.history || []).map((item) => <div key={`${item.version}-${item.action}`}><b>v{item.version} {item.action}</b><span>{item.at}</span></div>)}</div>}
              </div>
              <div className="memory-proposal-actions">
                {proposal.status === "pending" && (editingProposal === proposal.id ? <><button className="btn-xs primary" onClick={() => saveProposalEdit(proposal)} disabled={proposalLoading}>保存</button><button className="btn-xs" onClick={() => setEditingProposal(null)}>取消</button></> : <><button className="btn-xs primary" onClick={() => handleApproveProposal(proposal.id)} disabled={proposalLoading}>确认写入</button><button className="btn-xs" onClick={() => startProposalEdit(proposal)}>编辑</button><button className="btn-xs" onClick={() => handleRejectProposal(proposal.id)} disabled={proposalLoading}>拒绝</button></>)}
                <button className="btn-xs" onClick={() => loadProposalHistory(proposal.id)}>历史</button>
              </div>
            </div>
          ))}
      </div>

      {/* 工具栏 */}
      <div className="memory-toolbar">
        <button className="btn-sm" onClick={refresh}>刷新</button>
        <button className="btn-sm" onClick={handleInit} disabled={loading}>
          {loading ? "创建中..." : "初始化记忆"}
        </button>
      </div>

      {/* 文件列表 + 内容区 */}
      <div className="memory-layout">
        <div className="memory-file-list">
          {files.length === 0 && <div className="empty">暂无记忆文件，点击「初始化记忆」</div>}
          {files.map((f) => (
            <div
              key={f.rel}
              className={`memory-file-item ${active === f.rel ? "active" : ""}`}
              onClick={() => loadFile(f.rel)}
            >
              <Icon name={f.type === "agents" ? "doc" : "file"} size={11} />
              <span className="memory-file-name">{f.rel}</span>
              <span className="memory-file-size">{(f.size / 1024).toFixed(1)}k</span>
            </div>
          ))}
        </div>
        {active && (
          <div className="memory-editor">
            <div className="memory-editor-head">
              <span className="memory-editor-name">{active}</span>
              <div className="memory-editor-actions">
                <button className={`btn-xs ${editing ? "active" : ""}`} onClick={() => setEditing(!editing)}>
                  {editing ? "预览" : "编辑"}
                </button>
                {dirty && <button className="btn-xs" onClick={saveFile}>保存</button>}
              </div>
            </div>
            <textarea
              className="memory-textarea"
              value={content}
              readOnly={!editing}
              onChange={(e) => { setContent(e.target.value); setDirty(true); }}
              placeholder="在此编辑记忆文件..."
            />
          </div>
        )}
      </div>
    </div>
  );
}
