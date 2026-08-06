import React, { useEffect, useRef, useState } from "react";
import Spreadsheet from "x-data-spreadsheet";
import "x-data-spreadsheet/dist/xspreadsheet.css";
import { saveCells } from "../api.js";

const COL_RE = /^([A-Z]+)(\d+)$/;
function colToIndex(col) { let n = 0; for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }
function indexToCol(i) { let s = ""; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - r) / 26); } return s; }

export default function ExcelGrid({ name, sheets, grids }) {
  const hostRef = useRef(null);
  const [spread, setSpread] = useState(null);
  const [activeSheet, setActiveSheet] = useState(sheets?.[0] || "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  // 保存时记录每个 sheet 的初始数据
  const initialRef = useRef({});

  // sheets 为空（文件读取失败）时显示错误
  if (!sheets || sheets.length === 0) {
    return (
      <div className="excel-wrap">
        <div className="excel-toolbar">
          <span className="badge">可编辑</span>
        </div>
        <div className="excel-empty">
          <div>⚠ 无法读取工作表</div>
          <div className="hint">文件可能已损坏、被占用（Excel 打开中），或格式不受支持</div>
        </div>
      </div>
    );
  }

  useEffect(() => {
    if (!hostRef.current) return;
    const s = new Spreadsheet(hostRef.current, {
      showToolbar: true,
      showGrid: true,
      view: { height: () => Math.max(200, hostRef.current?.clientHeight - 40) },
    });
    setSpread(s);
    return () => { if (typeof s.destroy === "function") try { s.destroy(); } catch {} };
  }, []);

  // 一次加载所有 sheets（带 name），x-spreadsheet 底部标签栏可切换
  useEffect(() => {
    if (!spread) return;
    const allSheets = sheets.map((s) => ({
      name: s,
      rows: grids[s]?.rows || grids[s] || {},
    }));
    initialRef.current = {};
    for (const s of sheets) {
      initialRef.current[s] = JSON.parse(JSON.stringify(grids[s]?.rows || grids[s] || {}));
    }
    spread.loadData(allSheets);
    if (typeof spread.change === "function") spread.change(() => {});
    // 记录当前激活的 sheet（x-spreadsheet 切换 sheet 时触发）
    try {
      spread.on("change", () => {});
    } catch {}
  }, [spread, sheets, grids]);

  const handleSave = async () => {
    if (!spread) return;
    // getData 返回所有 sheet 的数据数组
    const allData = spread.getData(); // [{ name, rows }]
    const changedBySheet = {};
    for (const sd of allData) {
      const sname = sd.name;
      const current = sd.rows || {};
      const initial = initialRef.current[sname] || {};
      const cells = [];
      const allKeys = new Set([...Object.keys(current), ...Object.keys(initial)]);
      for (const ri of allKeys) {
        const cur = current[ri]?.cells || {};
        const ini = initial[ri]?.cells || {};
        for (const ci of new Set([...Object.keys(cur), ...Object.keys(ini)])) {
          const cv = cur[ci]?.text ?? "";
          const iv = ini[ci]?.text ?? "";
          if (cv !== iv) cells.push({ ref: indexToCol(Number(ci)) + ri, value: cv });
        }
      }
      if (cells.length) changedBySheet[sname] = cells;
    }
    const total = Object.values(changedBySheet).reduce((a, b) => a + b.length, 0);
    if (!total) { setMsg("no changes"); return; }
    setSaving(true);
    try {
      for (const [sname, cells] of Object.entries(changedBySheet)) {
        await saveCells(name, sname, cells);
      }
      setMsg(`saved ${total} cells`);
      // 更新初始数据
      for (const sd of allData) {
        initialRef.current[sd.name] = JSON.parse(JSON.stringify(sd.rows || {}));
      }
    } catch (e) { setMsg("save failed: " + e.message); }
    setSaving(false);
    setTimeout(() => setMsg(""), 2500);
  };

  return (
    <div className="excel-wrap">
      <div className="excel-toolbar">
        <span className="badge">工作簿 · {sheets.length} 个工作表</span>
        <span className="excel-sheet-hint">底部标签栏可切换工作表</span>
        <button className="btn primary" onClick={handleSave} disabled={saving}>
          {saving ? "saving..." : "save changes"}
        </button>
        {msg && <span className="save-msg">{msg}</span>}
      </div>
      <div ref={hostRef} className="excel-host" />
    </div>
  );
}
