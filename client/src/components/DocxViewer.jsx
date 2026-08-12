import React, { useEffect, useRef, useState, useCallback } from "react";
import { renderAsync } from "docx-preview";
import { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel } from "docx";
import Icon from "./Icon.jsx";
import CommentMarker from "./CommentMarker.jsx";

/**
 * Word 文档查看器（增强版）
 * - 更多字体和颜色选项，颜色直接显示色块
 * - 标注颜色（高亮）支持
 * - 批注显示优化
 * - 表格支持
 * - 目录导航
 */
const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 48, 72];
const FONT_FAMILIES = [
  "宋体", "黑体", "仿宋", "楷体", "微软雅黑", "Arial", "Calibri", "Times New Roman", 
  "Helvetica", "Georgia", "Verdana", "Tahoma", "Trebuchet MS", "Courier New", "Monaco"
];
const COLORS = [
  { name: "黑色", value: "#000000" }, { name: "深灰", value: "#404040" }, { name: "灰色", value: "#808080" }, 
  { name: "浅灰", value: "#C0C0C0" }, { name: "白色", value: "#FFFFFF" }, { name: "红色", value: "#FF0000" }, 
  { name: "橙红", value: "#FF4500" }, { name: "橙色", value: "#FFA500" }, { name: "金色", value: "#FFD700" }, 
  { name: "黄色", value: "#FFFF00" }, { name: "绿色", value: "#00FF00" }, { name: "深绿", value: "#008000" }, 
  { name: "蓝绿", value: "#00CED1" }, { name: "蓝色", value: "#0000FF" }, { name: "天蓝", value: "#87CEEB" }, 
  { name: "紫色", value: "#800080" }, { name: "紫罗兰", value: "#EE82EE" }, { name: "粉色", value: "#FFC0CB" }, 
  { name: "棕色", value: "#A52A2A" }, { name: "海军蓝", value: "#000080" }
];
const HIGHLIGHT_COLORS = [
  { name: "黄色", value: "#FFFF00" }, { name: "绿色", value: "#00FF00" }, { name: "青色", value: "#00FFFF" }, 
  { name: "粉色", value: "#FFC0CB" }, { name: "蓝色", value: "#87CEEB" }, { name: "紫色", value: "#DDA0DD" }, 
  { name: "橙色", value: "#FFD700" }, { name: "红色", value: "#FF6347" }, { name: "白色", value: "#FFFFFF" }, 
  { name: "无", value: "transparent" }
];
const HEADING_OPTIONS = [
  { label: "正文", value: "p" },
  { label: "标题 1", value: "h1" },
  { label: "标题 2", value: "h2" },
  { label: "标题 3", value: "h3" },
  { label: "标题 4", value: "h4" },
];
const ZOOM_LEVELS = [50, 75, 100, 125, 150, 200];

export default function DocxViewer({ name }) {
  const hostRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showComments, setShowComments] = useState(true);
  const [showChanges, setShowChanges] = useState(true); // 修订模式默认开启
  const [renderKey, setRenderKey] = useState(0);
  const [mode, setMode] = useState("preview"); // "preview" | "edit"
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [outline, setOutline] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [comments, setComments] = useState([]);
  const [activeComment, setActiveComment] = useState(null);
  const [zoom, setZoom] = useState(100); // 缩放比例

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
        renderComments: showComments, // 批注显示跟随工具栏开关
        renderChanges: showChanges,   // 修订痕迹显示跟随工具栏开关
        useBase64URL: true,
      });
      buildOutline(host);
      setDirty(false);
      // 加载批注数据
      loadComments();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [name, showComments, showChanges]);

  const loadComments = async () => {
    try {
      const res = await fetch(`/api/doc/${encodeURIComponent(name)}/comments`);
      const d = await res.json();
      if (d.comments) setComments(d.comments);
    } catch (e) {
      console.error("加载批注失败:", e);
    }
  };

  useEffect(() => { renderDoc(); }, [renderDoc, renderKey]);

  // 提取标题大纲（从渲染 DOM：Heading 类 + 加粗大字号段落启发式）
  const buildOutline = (host) => {
    const items = [];
    // 1) 标准 Heading 类 / h1-h6（docx-preview 实际生成 oaw-docx_heading1 小写类名）
    const headingEls = host.querySelectorAll("section.oaw-docx [class*=heading], section.oaw-docx h1, section.oaw-docx h2, section.oaw-docx h3, section.oaw-docx h4, section.oaw-docx h5, section.oaw-docx h6");
    headingEls.forEach((el) => {
      const cls = el.className || "";
      let level = 3;
      if (/heading1/i.test(cls) || el.tagName === "H1") level = 1;
      else if (/heading2/i.test(cls) || el.tagName === "H2") level = 2;
      else if (/heading3/i.test(cls) || el.tagName === "H3") level = 3;
      else if (/heading4/i.test(cls) || el.tagName === "H4") level = 4;
      else if (/heading5/i.test(cls) || el.tagName === "H5") level = 5;
      else if (/heading6/i.test(cls) || el.tagName === "H6") level = 6;
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

  const applyHighlight = (color) => {
    if (color === "transparent") {
      document.execCommand("hiliteColor", false, "transparent");
    } else {
      document.execCommand("hiliteColor", false, color);
    }
    setDirty(true);
  };

  // 字号：execCommand 生成 font[size=7] 后替换为实际 pt 值（浏览器通用技巧）
  const execFontSize = (pt) => {
    document.execCommand("fontSize", false, "7");
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    // 找到 execCommand 生成的 font 元素并设置 style.fontSize
    const container = range.commonAncestorContainer;
    const root = container.nodeType === 3 ? container.parentElement : container;
    const fonts = root.querySelectorAll ? root.querySelectorAll('font[size="7"]') : [];
    fonts.forEach((f) => {
      f.style.fontSize = `${pt}pt`;
      f.removeAttribute("size");
    });
    setDirty(true);
  };

  // 标题格式
  const applyHeading = (tag) => {
    if (tag === "p") {
      document.execCommand("formatBlock", false, "p");
    } else {
      document.execCommand("formatBlock", false, tag);
    }
    setDirty(true);
    hostRef.current?.focus();
  };

  // 缩放
  const applyZoom = (level) => {
    setZoom(level);
    const host = hostRef.current;
    if (host) {
      host.style.transform = `scale(${level / 100})`;
      host.style.transformOrigin = "top left";
      host.style.width = `${10000 / level}%`;
    }
  };

  // ===== 保存：docx 库重打包 =====
  const handleSave = async () => {
    if (!dirty) { setSaveMsg("没有需要保存的修改"); setTimeout(() => setSaveMsg(""), 2000); return; }
    setSaving(true);
    setSaveMsg("保存中...");
    try {
      const host = hostRef.current;
      // 提取编辑后的正文 HTML（各 section）
      const sections = host.querySelectorAll("section.oaw-docx");
      const html = Array.from(sections).map((s) => s.innerHTML).join("");

      // 简易 HTML → docx 转换（支持 p/h1-h6/b/i/u/font-size/font-family/color/table）
      const parseHtml = (htmlStr) => {
        const div = document.createElement("div");
        div.innerHTML = htmlStr;
        const paras = [];
        const walk = (node, style) => {
          const s = { ...style };
          if (node.nodeType === 3) {
            const t = node.textContent;
            if (t.trim()) {
              paras.push(new Paragraph({ children: [new TextRun({ text: t, bold: s.bold, italics: s.italic, underline: s.underline, size: s.size ? s.size * 2 : undefined, color: s.color, font: s.font, highlighting: s.highlight })], alignment: s.align }));
            }
            return;
          }
          if (node.nodeType !== 1) return;
          const tag = node.tagName.toLowerCase();
          if (tag === "b" || tag === "strong") s.bold = true;
          if (tag === "i" || tag === "em") s.italic = true;
          if (tag === "u") s.underline = true;
          if (tag === "mark") s.highlight = "#FFFF00";
          if (tag === "span") {
            const st = node.style || {};
            if (st.fontWeight === "bold" || parseInt(st.fontWeight, 10) >= 600) s.bold = true;
            if (st.fontStyle === "italic") s.italic = true;
            if (st.textDecorationLine === "underline") s.underline = true;
            if (st.fontSize) s.size = parseInt(st.fontSize, 10);
            if (st.color) s.color = st.color;
            if (st.fontFamily) s.font = st.fontFamily.replace(/["']/g, "");
            if (st.backgroundColor && st.backgroundColor !== "transparent") s.highlight = st.backgroundColor;
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
                  if (child.textContent.trim()) rs.push(new TextRun({ text: child.textContent, bold: s.bold, italics: s.italic, underline: s.underline, size: s.size ? s.size * 2 : undefined, color: s.color, font: s.font, highlighting: s.highlight }));
                } else if (child.nodeType === 1) {
                  const cs = { ...s };
                  const ct = child.tagName.toLowerCase();
                  if (ct === "b" || ct === "strong") cs.bold = true;
                  if (ct === "i" || ct === "em") cs.italic = true;
                  if (ct === "u") cs.underline = true;
                  if (ct === "mark") cs.highlight = "#FFFF00";
                  const st = child.style || {};
                  if (st.fontWeight === "bold") cs.bold = true;
                  if (st.fontStyle === "italic") cs.italic = true;
                  if (st.fontSize) cs.size = parseInt(st.fontSize, 10);
                  if (st.color) cs.color = st.color;
                  if (st.backgroundColor && st.backgroundColor !== "transparent") cs.highlight = st.backgroundColor;
                  collectRuns(child, rs);
                }
              }
            };
            collectRuns(node, runs);
            if (runs.length) {
              const heading = tag.startsWith("h") ? { heading: HeadingLevel[tag.toUpperCase()] } : {};
              paras.push(new Paragraph({ children: runs, alignment: AlignmentType.LEFT, ...heading }));
            }
            return;
          }
          for (const child of node.childNodes) walk(child, s);
        };
        walk(div, {});
        return paras;
      };

      const paras = parseHtml(html);
      const doc = new Document({ sections: [{ children: paras.length ? paras : [new Paragraph({ text: "(空文档)" })] }] });
      const buffer = await Packer.toBuffer(doc);

      // 上传保存
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
      {/* 第一行：主工具栏 */}
      <div className="oaw-docx-toolbar">
        <div className="toolbar-seg oaw-docx-mode">
          <button className={`toolbar-seg-btn ${mode === "preview" ? "active" : ""}`} onClick={exitEditMode}>
            <Icon name="eye" size={12} /> 预览
          </button>
          <button className={`toolbar-seg-btn ${mode === "edit" ? "active" : ""}`} onClick={enterEditMode}>
            <Icon name="pen-tool" size={12} /> 编辑
          </button>
        </div>
        <button className={`toolbar-btn ${showComments ? "active" : ""}`} onClick={() => setShowComments(!showComments)} title="显示批注">
          <Icon name="comment" size={13} />
        </button>
        <button className={`toolbar-btn ${showChanges ? "active" : ""}`} onClick={() => setShowChanges(!showChanges)} title="显示修订">
          <Icon name="history" size={13} />
        </button>
        {outline.length > 0 && (
          <button className={`toolbar-btn ${outlineOpen ? "active" : ""}`} onClick={() => setOutlineOpen(!outlineOpen)} title="目录导航">
            <Icon name="list" size={13} />
          </button>
        )}
        <button className="toolbar-btn" onClick={() => setRenderKey((k) => k + 1)} title="刷新渲染">
          <Icon name="refresh" size={13} />
        </button>
        <span className="toolbar-sep" />
        {/* 缩放 */}
        <select className="edit-select zoom-select" value={zoom} onChange={(e) => applyZoom(Number(e.target.value))} title="缩放比例">
          {ZOOM_LEVELS.map((z) => <option key={z} value={z}>{z}%</option>)}
        </select>
        {mode === "edit" && (
          <>
            <span className="toolbar-sep" />
            <button className="btn-sm primary" onClick={handleSave} disabled={saving || !dirty} title="保存修改到文档">
              <Icon name="check" size={12} /> {saving ? "保存中..." : "保存"}
            </button>
          </>
        )}
        <span className="oaw-docx-hint">{mode === "edit" ? "编辑模式" : "预览模式"}</span>
      </div>

      {/* 第二行：编辑工具栏（仅编辑模式显示） */}
      {mode === "edit" && (
        <div className="oaw-docx-edittoolbar">
          <div className="edit-group">
            <select className="edit-select heading-select" title="标题格式" onChange={(e) => applyHeading(e.target.value)} defaultValue="">
              <option value="" disabled>标题格式</option>
              {HEADING_OPTIONS.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
            </select>
          </div>
          <span className="edit-sep" />
          <div className="edit-group">
            <select className="edit-select" title="字号" onChange={(e) => execFontSize(e.target.value)} defaultValue="">
              <option value="" disabled>字号</option>
              {FONT_SIZES.map((s) => <option key={s} value={s}>{s}pt</option>)}
            </select>
            <select className="edit-select" title="字体" onChange={(e) => exec("fontName", e.target.value)} defaultValue="">
              <option value="" disabled>字体</option>
              {FONT_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <span className="edit-sep" />
          <div className="edit-group">
            <button className="edit-btn" title="加粗 (Ctrl+B)" onClick={() => exec("bold")}><b>B</b></button>
            <button className="edit-btn" title="斜体 (Ctrl+I)" onClick={() => exec("italic")}><i>I</i></button>
            <button className="edit-btn" title="下划线 (Ctrl+U)" onClick={() => exec("underline")}><u>U</u></button>
            <button className="edit-btn" title="删除线" onClick={() => exec("strikeThrough")}><s>S</s></button>
          </div>
          <span className="edit-sep" />
          <div className="edit-group">
            <span className="edit-group-label">颜色</span>
            <div className="edit-color-picker">
              {COLORS.map((c) => (
                <button
                  key={c.value}
                  className="edit-color-swatch"
                  title={c.name}
                  style={{ backgroundColor: c.value }}
                  onClick={() => applyColor(c.value)}
                />
              ))}
            </div>
          </div>
          <span className="edit-sep" />
          <div className="edit-group">
            <span className="edit-group-label">标注</span>
            <div className="edit-color-picker">
              {HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c.value}
                  className={`edit-color-swatch highlight ${c.value === "transparent" ? "transparent" : ""}`}
                  title={c.name}
                  style={{ backgroundColor: c.value === "transparent" ? "transparent" : c.value }}
                  onClick={() => applyHighlight(c.value)}
                />
              ))}
            </div>
          </div>
          <span className="edit-sep" />
          <div className="edit-group">
            <button className="edit-btn" title="左对齐" onClick={() => exec("justifyLeft")}>⇤</button>
            <button className="edit-btn" title="居中" onClick={() => exec("justifyCenter")}>⇹</button>
            <button className="edit-btn" title="右对齐" onClick={() => exec("justifyRight")}>⇥</button>
          </div>
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
        {showComments && comments.length > 0 && (
          <CommentMarker
            comments={comments}
            containerRef={hostRef}
            activeComment={activeComment}
            setActiveComment={setActiveComment}
          />
        )}
      </div>
    </div>
  );
}
