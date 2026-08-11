import React, { useEffect, useRef, useState, useCallback } from "react";
import { renderAsync } from "docx-preview";
import Icon from "./Icon.jsx";

/**
 * Word 文档查看器（docx-preview 渲染 + contentEditable 富文本编辑 + officecli/docx 保存）
 * - 预览模式：高保真渲染，批注/修订开关，可隐藏目录导航
 * - 编辑模式：直接编辑文档内容（加粗/斜体/下划线/字号/字体/颜色/对齐即时生效）
 * - 保存：优先 officecli raw-set 落盘，失败则 docx 库重打包兜底
 */
const FONT_SIZES = [9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 48, 72];
const FONT_FAMILIES = ["宋体", "黑体", "仿宋", "楷体", "微软雅黑", "Arial", "Calibri", "Times New Roman", "Helvetica"];
const COLORS = ["#000000", "#FF0000", "#00B050", "#0070C0", "#FFC000", "#7030A0", "#FFFFFF", "#808080"];

export default function DocxViewer({ name }) {
  const hostRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showComments, setShowComments] = useState(false);
  const [showChanges, setShowChanges] = useState(false);
  const [renderKey, setRenderKey] = useState(0);
  const [mode, setMode] = useState("preview"); // "preview" | "edit"
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [outline, setOutline] = useState([]);
  const [dirty, setDirty] = useState(false);

  // 渲染 docx
  const renderDoc = useCallback(async () => {
    const host = hostRef.current;
    if (!host) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/doc/${encodeURIComponent(name)}/raw`);
      if (!res.ok) throw new Error(`加载失败 HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const data = new Uint8Array(buf);
      host.innerHTML = "";
      await renderAsync(data, host, null, {
        className: "oaw-docx",
        inWrapper: true,
        breakPages: true,
        ignoreLastRenderedPageBreak: true,
        renderComments: showComments,
        renderChanges: showChanges,
        useBase64URL: true,
      });
      buildOutline(host);
      setDirty(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [name, showComments, showChanges]);

  useEffect(() => { renderDoc(); }, [renderDoc, renderKey]);

  // 提取标题大纲（从渲染 DOM：Heading 类 + 加粗大字号段落启发式）
  const buildOutline = (host) => {
    const items = [];
    // 1) 标准 Heading 类 / h1-h6
    const headingEls = host.querySelectorAll("section.oaw-docx [class*=Heading], section.oaw-docx h1, section.oaw-docx h2, section.oaw-docx h3, section.oaw-docx h4, section.oaw-docx h5, section.oaw-docx h6");
    headingEls.forEach((el) => {
      const cls = el.className || "";
      let level = 3;
      if (/Heading1/.test(cls) || el.tagName === "H1") level = 1;
      else if (/Heading2/.test(cls) || el.tagName === "H2") level = 2;
      else if (/Heading4/.test(cls) || el.tagName === "H4") level = 4;
      else if (/Heading5/.test(cls) || el.tagName === "H5") level = 5;
      else if (/Heading6/.test(cls) || el.tagName === "H6") level = 6;
      const text = el.textContent.trim();
      if (text) items.push({ level, text: text.slice(0, 100), el });
    });
    // 2) 启发式：无 Heading 类时，提取加粗+较大字号的短段落作为标题
    if (items.length === 0) {
      const paras = host.querySelectorAll("section.oaw-docx p");
      paras.forEach((el) => {
        const st = el.style || {};
        const fs = parseFloat(st.fontSize) || 0;
        const bold = st.fontWeight === "bold" || parseInt(st.fontWeight, 10) >= 600;
        const text = el.textContent.trim();
        // 标题特征：加粗 或 字号 >= 14pt，且文本较短（<60字）
        if (text && (bold || fs >= 14) && text.length <= 60) {
          let level = 3;
          if (fs >= 22) level = 1;
          else if (fs >= 18) level = 2;
          else if (fs >= 14) level = 3;
          items.push({ level, text: text.slice(0, 100), el });
        }
      });
    }
    setOutline(items);
  };

  const jumpToHeading = (item) => {
    item.el?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // ===== 编辑模式：contentEditable + execCommand（即时生效，零后端延迟） =====
  const mutationRef = useRef(null);

  const enterEditMode = () => {
    setMode("edit");
    // 延迟到渲染完成后启用 contentEditable
    setTimeout(() => {
      const host = hostRef.current;
      if (!host) return;
      // 只对文档正文区域启用编辑（不含注入的 style）
      const sections = host.querySelectorAll("section.oaw-docx");
      sections.forEach((s) => { s.contentEditable = "true"; });
      // 监听内容变化 → 标记 dirty（保存按钮可用）
      if (mutationRef.current) mutationRef.current.disconnect();
      const observer = new MutationObserver(() => setDirty(true));
      sections.forEach((s) => observer.observe(s, { childList: true, subtree: true, characterData: true }));
      mutationRef.current = observer;
      setSaveMsg("编辑模式：直接点击文档修改，完成后保存");
    }, 300);
  };

  const exitEditMode = () => {
    if (mutationRef.current) { mutationRef.current.disconnect(); mutationRef.current = null; }
    const host = hostRef.current;
    if (host) {
      host.querySelectorAll("section.oaw-docx").forEach((s) => { s.contentEditable = "false"; });
    }
    setMode("preview");
  };

  // 工具栏动作（execCommand 即时生效）
  const exec = (cmd, value = null) => {
    document.execCommand(cmd, false, value);
    setDirty(true);
    hostRef.current?.focus();
  };

  const applyColor = (color) => {
    document.execCommand("foreColor", false, color);
    setDirty(true);
  };

  // ===== 保存：officecli 优先，docx 重打包兜底 =====
  const handleSave = async () => {
    if (!dirty) { setSaveMsg("没有需要保存的修改"); setTimeout(() => setSaveMsg(""), 2000); return; }
    setSaving(true);
    setSaveMsg("保存中...");
    try {
      const host = hostRef.current;
      // 提取编辑后的正文 HTML（各 section）
      const sections = host.querySelectorAll("section.oaw-docx");
      const html = Array.from(sections).map((s) => s.innerHTML).join("");
      // 方案1：officecli 用文本替换方式落盘不可靠，改为前端生成新 docx 保存
      // 方案2：docx 库重打包（保留基本结构：段落/标题/加粗/斜体等）
      const docx = await import("docx");
      const { Document, Packer, Paragraph, TextRun } = docx;

      // 简易 HTML → docx 转换（支持 p/h1-h6/b/i/u/font-size/font-family/color）
      const parseHtml = (htmlStr) => {
        const div = document.createElement("div");
        div.innerHTML = htmlStr;
        const paras = [];
        const walk = (node, style) => {
          const s = { ...style };
          if (node.nodeType === 3) {
            const t = node.textContent;
            if (t.trim()) {
              paras.push(new docx.Paragraph({ children: [new docx.TextRun({ text: t, bold: s.bold, italics: s.italic, underline: s.underline, size: s.size ? s.size * 2 : undefined, color: s.color, font: s.font })], alignment: s.align }));
            }
            return;
          }
          if (node.nodeType !== 1) return;
          const tag = node.tagName.toLowerCase();
          if (tag === "b" || tag === "strong") s.bold = true;
          if (tag === "i" || tag === "em") s.italic = true;
          if (tag === "u") s.underline = true;
          if (tag === "span") {
            const st = node.style || {};
            if (st.fontWeight === "bold" || parseInt(st.fontWeight, 10) >= 600) s.bold = true;
            if (st.fontStyle === "italic") s.italic = true;
            if (st.textDecorationLine === "underline") s.underline = true;
            if (st.fontSize) s.size = parseInt(st.fontSize, 10);
            if (st.color) s.color = st.color;
            if (st.fontFamily) s.font = st.fontFamily.replace(/["']/g, "");
          }
          if (tag === "h1") s.size = 24, s.bold = true;
          if (tag === "h2") s.size = 20, s.bold = true;
          if (tag === "h3") s.size = 16, s.bold = true;
          if (tag === "p" || tag === "div") {
            const st = node.style || {};
            if (st.textAlign) s.align = st.textAlign;
          }
          if (["p", "div", "h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) {
            // 收集该块内所有文本 run
            const runs = [];
            const collectRuns = (n, rs) => {
              for (const child of n.childNodes) {
                if (child.nodeType === 3) {
                  if (child.textContent.trim()) rs.push(new docx.TextRun({ text: child.textContent, bold: s.bold, italics: s.italic, underline: s.underline, size: s.size ? s.size * 2 : undefined, color: s.color, font: s.font }));
                } else if (child.nodeType === 1) {
                  const cs = { ...s };
                  const ct = child.tagName.toLowerCase();
                  if (ct === "b" || ct === "strong") cs.bold = true;
                  if (ct === "i" || ct === "em") cs.italic = true;
                  if (ct === "u") cs.underline = true;
                  const st = child.style || {};
                  if (st.fontWeight === "bold") cs.bold = true;
                  if (st.fontStyle === "italic") cs.italic = true;
                  if (st.fontSize) cs.size = parseInt(st.fontSize, 10);
                  if (st.color) cs.color = st.color;
                  collectRuns(child, rs);
                }
              }
            };
            collectRuns(node, runs);
            if (runs.length) paras.push(new docx.Paragraph({ children: runs, alignment: s.align || docx.AlignmentType.LEFT, heading: tag.startsWith("h") ? docx.HeadingLevel[tag.toUpperCase()] : undefined }));
            return;
          }
          for (const child of node.childNodes) walk(child, s);
        };
        walk(div, {});
        return paras;
      };

      const paras = parseHtml(html);
      const document = new docx.Document({ sections: [{ children: paras.length ? paras : [new docx.Paragraph({ text: "(空文档)" })] }] });
      const buffer = await docx.Packer.toBuffer(document);

      // 上传保存（新增原始内容保存接口）
      const res = await fetch(`/api/doc/${encodeURIComponent(name)}/raw-save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base64: buffer.toString("base64") }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error || "保存失败");
      setSaveMsg("保存成功 ✓");
      setDirty(false);
      setTimeout(() => setSaveMsg(""), 2500);
    } catch (e) {
      setSaveMsg("保存失败: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="oaw-docx-wrap">
      <div className="oaw-docx-toolbar">
        <div className="toolbar-seg oaw-docx-mode">
          <button className={`toolbar-seg-btn ${mode === "preview" ? "active" : ""}`} onClick={exitEditMode}>
            <Icon name="eye" size={12} /> 预览
          </button>
          <button className={`toolbar-seg-btn ${mode === "edit" ? "active" : ""}`} onClick={enterEditMode}>
            <Icon name="pen-tool" size={12} /> 编辑
          </button>
        </div>
        <button className={`toolbar-btn ${showComments ? "active" : ""}`} onClick={() => setShowComments(!showComments)} title="文档内批注显示">
          <Icon name="comment" size={13} />
        </button>
        <button className={`toolbar-btn ${showChanges ? "active" : ""}`} onClick={() => setShowChanges(!showChanges)} title="修订痕迹显示">
          <Icon name="refresh" size={13} />
        </button>
        <button className="toolbar-btn" onClick={() => setRenderKey((k) => k + 1)} title="重新渲染">
          <Icon name="refresh" size={13} />
        </button>
        {outline.length > 0 && (
          <button className={`toolbar-btn ${outlineOpen ? "active" : ""}`} onClick={() => setOutlineOpen(!outlineOpen)} title="目录导航">
            <Icon name="list" size={13} />
          </button>
        )}
        {mode === "edit" && (
          <button className="btn-sm primary" onClick={handleSave} disabled={saving || !dirty} title="保存修改到文档">
            <Icon name="check" size={12} /> {saving ? "保存中..." : "保存"}
          </button>
        )}
        <span className="oaw-docx-hint">{mode === "edit" ? "编辑模式：直接点击文档修改" : "批注/修订可选显示"}</span>
      </div>

      {mode === "edit" && (
        <div className="oaw-docx-edittoolbar">
          <button className="edit-btn" title="加粗 (Ctrl+B)" onClick={() => exec("bold")}><b>B</b></button>
          <button className="edit-btn" title="斜体 (Ctrl+I)" onClick={() => exec("italic")}><i>I</i></button>
          <button className="edit-btn" title="下划线 (Ctrl+U)" onClick={() => exec("underline")}><u>U</u></button>
          <button className="edit-btn" title="删除线" onClick={() => exec("strikeThrough")}><s>S</s></button>
          <span className="edit-sep" />
          <select className="edit-select" title="字号" onChange={(e) => exec("fontSize", e.target.value)} defaultValue="">
            <option value="" disabled>字号</option>
            {FONT_SIZES.map((s) => <option key={s} value={s}>{s}pt</option>)}
          </select>
          <select className="edit-select" title="字体" onChange={(e) => exec("fontName", e.target.value)} defaultValue="">
            <option value="" disabled>字体</option>
            {FONT_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <select className="edit-select" title="文字颜色" onChange={(e) => applyColor(e.target.value)} defaultValue="">
            <option value="" disabled>颜色</option>
            {COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <span className="edit-sep" />
          <button className="edit-btn" title="左对齐" onClick={() => exec("justifyLeft")}>⇤</button>
          <button className="edit-btn" title="居中" onClick={() => exec("justifyCenter")}>⇹</button>
          <button className="edit-btn" title="右对齐" onClick={() => exec("justifyRight")}>⇥</button>
          <span className="edit-sep" />
          <span className={`edit-save-msg ${saveMsg.includes("失败") ? "err" : ""}`}>{saveMsg}</span>
        </div>
      )}

      {loading && <div className="oaw-docx-loading"><div className="loading-spinner"></div><div>正在渲染文档...</div></div>}
      {error && <div className="oaw-docx-error"><Icon name="warning" size={14} /> {error}</div>}

      <div className="oaw-docx-body">
        {outlineOpen && outline.length > 0 && (
          <div className="oaw-docx-outline">
            <div className="oaw-docx-outline-head">
              <span><Icon name="list" size={11} /> 目录</span>
              <button className="btn-xs" onClick={() => setOutlineOpen(false)}>×</button>
            </div>
            <div className="oaw-docx-outline-list">
              {outline.map((item, i) => (
                <div
                  key={i}
                  className="oaw-docx-outline-item"
                  style={{ paddingLeft: `${(item.level - 1) * 12 + 6}px` }}
                  onClick={() => jumpToHeading(item)}
                  title={item.text}
                >
                  {item.text}
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="oaw-docx-host" ref={hostRef} />
      </div>
    </div>
  );
}
