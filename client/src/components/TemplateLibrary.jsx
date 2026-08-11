import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Icon from "./Icon.jsx";
import MarkdownBody from "./MarkdownBody.jsx";
import { tplList, tplContent } from "../api.js";

/**
 * 模版库全屏模式（交通规划产出文件模板）
 *
 * 左栏：分类列表
 * 中栏：模板卡片网格/列表（支持搜索+排序）
 * 右栏：模板预览（Markdown/HTML/Word/Excel/PDF/PPT 渲染）
 */

// 文件类型排序权重
const TYPE_ORDER = { markdown: 0, html: 1, word: 2, pdf: 3, ppt: 4, xls: 5, other: 9 };

export default function TemplateLibrary({ onExit, onOpenFile }) {
  const [categories, setCategories] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [activeCategory, setActiveCategory] = useState("all");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [viewMode, setViewMode] = useState("grid");
  const [sortBy, setSortBy] = useState("type");
  const [search, setSearch] = useState("");
  const previewSeq = useRef(0); // 竞态保护

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const r = await tplList();
        setCategories(r.categories || []);
        setTemplates(r.items || []);
      } catch (e) { console.error(e); }
      setLoading(false);
    })();
  }, []);

  // 排序 + 过滤 + 搜索
  const filtered = useMemo(() => {
    let list = activeCategory === "all" ? templates : templates.filter((t) => t.category === activeCategory);
    // 搜索
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((t) => t.title.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.ext.toLowerCase().includes(q));
    }
    // 排序
    list = [...list].sort((a, b) => {
      if (sortBy === "type") {
        const oa = TYPE_ORDER[a.type] ?? 9;
        const ob = TYPE_ORDER[b.type] ?? 9;
        if (oa !== ob) return oa - ob;
        return a.title.localeCompare(b.title, "zh");
      }
      if (sortBy === "name") return a.title.localeCompare(b.title, "zh");
      if (sortBy === "size") return (b.size || 0) - (a.size || 0);
      return 0;
    });
    return list;
  }, [templates, activeCategory, sortBy, search]);

  const openPreview = useCallback(async (tpl) => {
    const seq = ++previewSeq.current; // 每次点击递增
    setPreviewLoading(true);
    setPreview(tpl); // 先显示标题信息
    try {
      const c = await tplContent(tpl.relPath);
      if (seq !== previewSeq.current) return; // 已过期，丢弃
      setPreview({ ...tpl, ...c });
    } catch (e) {
      if (seq !== previewSeq.current) return;
      setPreview({ ...tpl, type: "error", content: "加载失败: " + e.message });
    }
    setPreviewLoading(false);
  }, []);

  const closePreview = useCallback(() => setPreview(null), []);

  // 文件类型图标
  const extIcon = (ext) => {
    const map = { md: "md", docx: "doc", doc: "doc", pdf: "pdf", pptx: "ppt", ppt: "ppt", html: "html", xlsx: "xls", xls: "xls" };
    return map[ext] || "file";
  };

  // 文件大小格式化
  const formatSize = (bytes) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  // 文件类型中文名
  const typeName = (type) => {
    const map = { markdown: "Markdown", html: "HTML", word: "Word", pdf: "PDF", ppt: "PPT", xls: "Excel", binary: "二进制", error: "错误", text: "文本" };
    return map[type] || type;
  };

  // 预览内容渲染
  const renderPreview = () => {
    if (previewLoading) return <div className="tpl-loading">加载预览…</div>;
    if (!preview) return <div className="tpl-empty">选择模板查看预览</div>;
    if (preview.type === "error") return <div className="tpl-empty">{preview.content}</div>;

    // Markdown / 文本
    if (preview.type === "markdown" || preview.type === "text") {
      if (preview.ext === "html") {
        return (
          <div className="tpl-preview-body">
            <div className="tpl-html-note">HTML 模版（源码预览）</div>
            <pre className="tpl-preview-pre">{preview.content}</pre>
          </div>
        );
      }
      return (
        <div className="tpl-preview-body">
          <MarkdownBody>{preview.content || ""}</MarkdownBody>
        </div>
      );
    }

    // Word / PDF / PPT / Excel - iframe 渲染
    if (preview.type === "word" || preview.ext === "docx" || preview.ext === "doc" ||
        preview.type === "pdf" || preview.ext === "pdf" ||
        preview.type === "ppt" || preview.ext === "pptx" || preview.ext === "ppt" ||
        preview.type === "xls" || preview.ext === "xlsx" || preview.ext === "xls") {
      // 用 relPath 作为 key，确保切换文件时 iframe 重新加载
      return (
        <div className="tpl-preview-body tpl-docx-preview">
          <iframe
            key={preview.relPath}
            src={`/api/doc/${encodeURIComponent(preview.relPath)}/raw`}
            className="tpl-preview-iframe"
            title={preview.title}
          />
        </div>
      );
    }

    // 其他二进制文件
    return (
      <div className="tpl-preview-body tpl-binary-note">
        <Icon name={extIcon(preview.ext)} size={48} />
        <p><b>{preview.ext?.toUpperCase()}</b> 文件（{formatSize(preview.size)}）</p>
        <p>{typeName(preview.type)} 格式</p>
        {onOpenFile && (
          <button className="btn-sm primary" onClick={() => { onOpenFile(preview.relPath); onExit?.(); }}>
            在办公模式中打开
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="tpl">
      {/* 顶栏 */}
      <div className="tpl-topbar">
        <button className="btn-sm" onClick={onExit}><Icon name="back" size={14} /> 返回</button>
        <span className="tpl-title">📋 模版库</span>
        <span className="tpl-count">{filtered.length} 个模版</span>
        <div className="tpl-search">
          <Icon name="search" size={12} />
          <input
            type="text"
            className="tpl-search-input"
            placeholder="搜索模板名称…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && <button className="tpl-search-clear" onClick={() => setSearch("")}>×</button>}
        </div>
        <div className="tpl-sort">
          <label className="tpl-sort-label">排序：</label>
          <select className="tpl-sort-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            <option value="type">按类型</option>
            <option value="name">按名称</option>
            <option value="size">按大小</option>
          </select>
        </div>
        <div className="tpl-view-toggle">
          <button className={"btn-sm" + (viewMode === "grid" ? " active" : "")} onClick={() => setViewMode("grid")}><Icon name="grid" size={14} /></button>
          <button className={"btn-sm" + (viewMode === "list" ? " active" : "")} onClick={() => setViewMode("list")}><Icon name="list" size={14} /></button>
        </div>
      </div>

      <div className="tpl-body">
        {/* 左栏：分类 */}
        <div className="tpl-left">
          <div className="tpl-cat-title">分类</div>
          <div className={"tpl-cat-item" + (activeCategory === "all" ? " active" : "")} onClick={() => setActiveCategory("all")}>
            <span className="tpl-cat-icon">📁</span>
            <span>全部</span>
            <span className="tpl-cat-count">{templates.length}</span>
          </div>
          {categories.map((c) => {
            const count = templates.filter((t) => t.category === c.id).length;
            return (
              <div key={c.id} className={"tpl-cat-item" + (activeCategory === c.id ? " active" : "")} onClick={() => setActiveCategory(c.id)}>
                <span className="tpl-cat-icon">{c.icon}</span>
                <span>{c.name}</span>
                <span className="tpl-cat-count">{count}</span>
              </div>
            );
          })}
        </div>

        {/* 中栏：模板网格/列表 */}
        <div className="tpl-center">
          {loading && <div className="tpl-loading">加载中…</div>}
          {!loading && filtered.length === 0 && <div className="tpl-empty">{search ? "无匹配结果" : "该分类暂无模版"}</div>}
          {viewMode === "grid" ? (
            <div className="tpl-grid">
              {filtered.map((t) => (
                <div key={t.id} className={"tpl-card" + (preview?.relPath === t.relPath ? " active" : "")} onClick={() => openPreview(t)}>
                  <div className="tpl-card-icon"><Icon name={extIcon(t.ext)} size={32} /></div>
                  <div className="tpl-card-title">{t.title}</div>
                  <div className="tpl-card-meta">
                    <span className="tpl-card-ext">{t.ext.toUpperCase()}</span>
                    <span className="tpl-card-size">{formatSize(t.size)}</span>
                  </div>
                  <div className="tpl-card-cat">{categories.find((c) => c.id === t.category)?.name || t.category}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="tpl-list">
              {filtered.map((t) => (
                <div key={t.id} className={"tpl-list-item" + (preview?.relPath === t.relPath ? " active" : "")} onClick={() => openPreview(t)}>
                  <Icon name={extIcon(t.ext)} size={16} />
                  <span className="tpl-list-title">{t.title}</span>
                  <span className="tpl-list-ext">{t.ext.toUpperCase()}</span>
                  <span className="tpl-list-size">{formatSize(t.size)}</span>
                  <span className="tpl-list-cat">{categories.find((c) => c.id === t.category)?.icon}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 右栏：预览 */}
        {preview && (
          <div className="tpl-preview">
            <div className="tpl-preview-head">
              <div className="tpl-preview-title">{preview.title}</div>
              <div className="tpl-preview-meta">
                <span className="tpl-preview-ext">{preview.ext?.toUpperCase()}</span>
                <span>{formatSize(preview.size || 0)}</span>
                <span>{categories.find((c) => c.id === preview.category)?.name}</span>
              </div>
              <button className="btn-sm" onClick={closePreview}><Icon name="close" size={14} /></button>
            </div>
            {renderPreview()}
          </div>
        )}
      </div>
    </div>
  );
}
