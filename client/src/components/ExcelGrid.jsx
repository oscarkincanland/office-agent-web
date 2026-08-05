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
  const [sheet, setSheet] = useState(sheets?.[0] || "Sheet1");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const initialRef = useRef(null);

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

  useEffect(() => {
    if (!spread) return;
    const grid = grids[sheet] || {};
    initialRef.current = JSON.parse(JSON.stringify(grid));
    spread.loadData(grid);
    if (typeof spread.change === "function") spread.change(() => {});
  }, [spread, sheet, grids]);

  const handleSave = async () => {
    if (!spread) return;
    const current = spread.getData().rows || {};
    const initial = initialRef.current || {};
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
    if (!cells.length) { setMsg("no changes"); return; }
    setSaving(true);
    try {
      await saveCells(name, sheet, cells);
      setMsg(`saved ${cells.length} cells`);
      initialRef.current = JSON.parse(JSON.stringify(current));
    } catch (e) { setMsg("save failed: " + e.message); }
    setSaving(false);
    setTimeout(() => setMsg(""), 2500);
  };

  return (
    <div className="excel-wrap">
      <div className="excel-toolbar">
        <select value={sheet} onChange={(e) => setSheet(e.target.value)}>
          {sheets.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button className="btn primary" onClick={handleSave} disabled={saving}>
          {saving ? "saving..." : "save changes"}
        </button>
        {msg && <span className="save-msg">{msg}</span>}
      </div>
      <div ref={hostRef} className="excel-host" />
    </div>
  );
}
