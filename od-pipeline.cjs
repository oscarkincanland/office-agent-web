// OD数据分析管道 (Demo) — 龙港市公交
// 输入: OD分析Demo-龙港公交/OD数据_原始.json
// 输出: OD数据_清洗后.json / OD清洗报告.json / OD分析数据.json / OD距离分布.json / OD高流量OD对.json / OD热门起终点.json
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'OD分析Demo-龙港公交');
const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'OD数据_原始.json'), 'utf8'));

// ---------- 工具 ----------
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const round1 = x => Math.round(x * 10) / 10;

// ---------- Step 1: 完整性校验与清洗 ----------
const issues = [];
const cleaned = [];
const seen = new Set();
const stationMap = new Map(raw.stations.map(s => [s.name, s]));

for (const [idx, r] of raw.records.entries()) {
  const rec = { ...r };
  const rid = `#${idx + 1}`;
  // 1) 缺失字段
  const missing = [];
  if (!rec.o || !String(rec.o).trim()) missing.push('起点(o)');
  if (!rec.d || !String(rec.d).trim()) missing.push('终点(d)');
  if (rec.flow === undefined || rec.flow === null || rec.flow === '') missing.push('流量(flow)');
  if (missing.length) { issues.push({ 记录: rid, 类型: '缺失字段', 详情: `缺少 ${missing.join('、')}`, 处理: '剔除' }); continue; }
  // 2) 流量非法
  if (typeof rec.flow !== 'number' || rec.flow <= 0) { issues.push({ 记录: rid, 类型: '非法流量', 详情: `flow=${rec.flow}`, 处理: '剔除' }); continue; }
  // 3) 坐标越界（站点必须在龙港范围）
  const bad = [];
  for (const [k, v] of [['起点', rec.o], ['终点', rec.d]]) {
    const st = stationMap.get(v);
    if (!st) { bad.push(`${k}「${v}」不在站点表`); continue; }
    if (st.lon < 120.40 || st.lon > 120.70 || st.lat < 27.50 || st.lat > 27.65) bad.push(`${k}「${v}」坐标越界`);
  }
  if (bad.length) { issues.push({ 记录: rid, 类型: '站点异常', 详情: bad.join('；'), 处理: '剔除' }); continue; }
  // 4) 重复记录
  const key = `${rec.o}|${rec.d}`;
  if (seen.has(key)) { issues.push({ 记录: rid, 类型: '重复记录', 详情: `${rec.o}→${rec.d}`, 处理: '去重(保留首条)' }); continue; }
  seen.add(key);
  cleaned.push(rec);
}

// ---------- Step 2: 统计分析 ----------
const stations = raw.stations;
const idxOf = name => stationMap.get(name);
const totalTrips = cleaned.reduce((s, r) => s + r.flow, 0);

// 距离（按站点坐标）
const withDist = cleaned.map(r => {
  const o = idxOf(r.o), d = idxOf(r.d);
  return { ...r, dist: round1(haversine(o.lat, o.lon, d.lat, d.lon)) };
});

// 距离分布
const distBins = [
  { bin: '0~2km', min: 0, max: 2 },
  { bin: '2~5km', min: 2, max: 5 },
  { bin: '5~10km', min: 5, max: 10 },
  { bin: '10~20km', min: 10, max: 20 },
  { bin: '>20km', min: 20, max: Infinity },
];
const distDist = distBins.map(b => {
  const rows = withDist.filter(r => r.dist >= b.min && r.dist < b.max);
  const trips = rows.reduce((s, r) => s + r.flow, 0);
  return { 距离段: b.bin, 人次: trips, 占比: Math.round(trips / totalTrips * 1000) / 10 };
});
const weightedAvgDist = round1(withDist.reduce((s, r) => s + r.dist * r.flow, 0) / totalTrips);
const sortedDist = [...withDist].sort((a, b) => a.dist - b.dist);
let acc = 0, medianDist = 0;
for (const r of sortedDist) { acc += r.flow; if (acc >= totalTrips / 2) { medianDist = r.dist; break; } }

// 高流量OD对 TOP15
const topOD = [...withDist].sort((a, b) => b.flow - a.flow).slice(0, 15)
  .map(r => ({ 起点: r.o, 终点: r.d, 人次: r.flow, 距离km: r.dist }));

// 热门起终点 TOP10
const agg = (fn) => {
  const m = new Map();
  for (const r of cleaned) { const k = fn(r); m.set(k, (m.get(k) || 0) + r.flow); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ 站点: k, 人次: v }));
};
const topOrigins = agg(r => r.o);
const topDest = agg(r => r.d);

// 时段分布（归一化到总出行量）
const hourBase = [0,0,0,0,0,0, 320,1850,1620,780,520,610, 780,640,560,620,840,1680, 1980,920,480,260,140,0];
const hourSum = hourBase.reduce((s, v) => s + v, 0);
const hourly = hourBase.map((v, h) => ({ 时段: `${String(h).padStart(2, '0')}:00`, 人次: Math.round(v * totalTrips / hourSum) }));
const morningPeak = hourly.slice(6, 10).reduce((s, x) => s + x.人次, 0);
const eveningPeak = hourly.slice(16, 20).reduce((s, x) => s + x.人次, 0);

// 出行目的 / 方式构成
const purpose = [
  { 类别: '通勤', 占比: 42.0 }, { 类别: '通学', 占比: 16.0 }, { 类别: '购物餐饮', 占比: 15.0 },
  { 类别: '就医', 占比: 9.5 }, { 类别: '休闲娱乐', 占比: 10.5 }, { 类别: '公务出行', 占比: 7.0 },
];
const mode = [
  { 类别: '公交直达', 占比: 64.0 }, { 类别: '换乘1次', 占比: 21.0 }, { 类别: '换乘2次及以上', 占比: 9.0 }, { 类别: '其他方式', 占比: 6.0 },
];

// ---------- 输出 ----------
fs.writeFileSync(path.join(DIR, 'OD数据_清洗后.json'), JSON.stringify({ meta: raw.meta, stations, records: cleaned }, null, 2), 'utf8');
fs.writeFileSync(path.join(DIR, 'OD清洗报告.json'), JSON.stringify({ 输入记录数: raw.records.length, 检出问题数: issues.length, 清洗后记录数: cleaned.length, 问题明细: issues }, null, 2), 'utf8');
const analysis = {
  项目: raw.meta['项目'], 数据性质: raw.meta['数据性质'], 口径: raw.meta['数据口径'],
  总OD对: cleaned.length, 总出行量人次: totalTrips,
  加权平均距离km: weightedAvgDist, 中位数距离km: medianDist,
  距离分布: distDist,
  高流量OD对TOP15: topOD,
  热门起点TOP10: topOrigins, 热门终点TOP10: topDest,
  时段分布: hourly,
  早高峰人次: morningPeak, 早高峰占比: Math.round(morningPeak / totalTrips * 1000) / 10,
  晚高峰人次: eveningPeak, 晚高峰占比: Math.round(eveningPeak / totalTrips * 1000) / 10,
  出行目的构成: purpose, 出行方式构成: mode,
  生成时间: new Date().toISOString()
};
fs.writeFileSync(path.join(DIR, 'OD分析数据.json'), JSON.stringify(analysis, null, 2), 'utf8');
fs.writeFileSync(path.join(DIR, 'OD距离分布.json'), JSON.stringify(distDist, null, 2), 'utf8');
fs.writeFileSync(path.join(DIR, 'OD高流量OD对.json'), JSON.stringify(topOD, null, 2), 'utf8');
fs.writeFileSync(path.join(DIR, 'OD热门起终点.json'), JSON.stringify({ 热门起点TOP10: topOrigins, 热门终点TOP10: topDest }, null, 2), 'utf8');

// 摘要打印
console.log('===== OD清洗报告 =====');
console.log('输入记录:', raw.records.length, '| 检出问题:', issues.length, '| 清洗后:', cleaned.length);
issues.forEach(i => console.log('  -', i.记录, i.类型, i.详情, '→', i.处理));
console.log('===== OD统计摘要 =====');
console.log('总OD对:', cleaned.length, '| 总出行量:', totalTrips, '人次/日');
console.log('加权平均距离:', weightedAvgDist, 'km | 中位数距离:', medianDist, 'km');
console.log('距离分布:', distDist.map(b => `${b.距离段}=${b.人次}(${b.占比}%)`).join(' '));
console.log('早高峰:', morningPeak, `(${analysis['早高峰占比']}%)`, '| 晚高峰:', eveningPeak, `(${analysis['晚高峰占比']}%)`);
console.log('TOP5 OD:', topOD.slice(0, 5).map(r => `${r.起点}→${r.终点} ${r.人次}`).join(' | '));
console.log('热门起点TOP5:', topOrigins.slice(0, 5).map(x => `${x.站点} ${x.人次}`).join(' | '));
console.log('热门终点TOP5:', topDest.slice(0, 5).map(x => `${x.站点} ${x.人次}`).join(' | '));
