import React, { useEffect, useRef, useState } from "react";
import Spreadsheet from "x-data-spreadsheet";
import "x-data-spreadsheet/dist/xspreadsheet.css";
import { saveCells } from "../api.js";

function indexToCol(i) { let s = ""; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - r) / 26); } return s; }

export default function ExcelGrid({ name, sheets, grids }) {
  const hostRef = useRef(null);
  const [spread, setSpread] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const sheetNames = Array.isArray(sheets) ? sheets : [];
  const hasSheets = sheetNames.length > 0;
  // 保存时记录每个 sheet 的初始数据
  const initialRef = useRef({});

  useEffect(() => {
    if (!hostRef.current || !hasSheets) return undefined;
    const s = new Spreadsheet(hostRef.current, {
      showToolbar: true,
      showGrid: true,
      view: { height: () => Math.max(200, hostRef.current?.clientHeight - 40) },
    });
    setSpread(s);
    return () => { if (typeof s.destroy === "function") try { s.destroy(); } catch {} };
  }, [hasSheets]);

  // 一次加载所有 sheets（带 name），x-spreadsheet 底部标签栏可切换
  useEffect(() => {
    if (!spread || !hasSheets) return;
    const allSheets = sheetNames.map((s) => ({
      name: s,
      rows: grids?.[s]?.rows || grids?.[s] || {},
    }));
    initialRef.current = {};
    for (const s of sheetNames) {
      initialRef.current[s] = JSON.parse(JSON.stringify(grids?.[s]?.rows || grids?.[s] || {}));
    }
    spread.loadData(allSheets);
    if (typeof spread.change === "function") spread.change(() => {});
  }, [spread, hasSheets, sheetNames, grids]);

  // sheets 为空（文件读取失败）时显示错误。放在 hooks 之后，避免文件从加载中
  // 变为可读时触发 React 的 hooks 顺序错误。
  if (!hasSheets) {
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
