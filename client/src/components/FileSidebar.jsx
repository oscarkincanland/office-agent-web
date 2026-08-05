import React, { useRef } from "react";
import { uploadFile, deleteFile, fileToBase64 } from "../api.js";

const EXT_LABELS = { docx: "W", xlsx: "X", pptx: "P" };

export default function FileSidebar({ files, currentName, onOpen, onRefresh, onUploaded }) {
  const fileRef = useRef(null);

  const handleUpload = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const { data } = await fileToBase64(f);
      await uploadFile(f.name, data);
      onUploaded();
    } catch (err) { alert("上传失败: " + err.message); }
    finally { e.target.value = ""; }
  };

  const handleDelete = async (name) => {
    if (!confirm(`删除 ${name} ?`)) return;
    try { await deleteFile(name); onRefresh(); } catch (err) { alert("删除失败: " + err.message); }
  };

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <span className="title">files</span>
        <button className="btn" onClick={onRefresh} title="刷新">refresh</button>
        <button className="btn" onClick={() => fileRef.current?.click()} title="上传">upload</button>
        <input ref={fileRef} type="file" accept=".docx,.xlsx,.pptx" hidden onChange={handleUpload} />
      </div>
      <div className="file-list">
        {files.length === 0 && <div className="empty">no files yet</div>}
        {files.map((f) => (
          <div key={f.name} className={`file-item ${f.name === currentName ? "active" : ""}`} onClick={() => onOpen(f.name)} title={f.name}>
            <span className="file-ext">{EXT_LABELS[f.ext] || "?"}</span>
            <span className="file-name">{f.name}</span>
            <span className="file-del" onClick={(e) => { e.stopPropagation(); handleDelete(f.name); }}>x</span>
          </div>
        ))}
      </div>
      <div className="sidebar-foot">office-workspace</div>
    </div>
  );
}
