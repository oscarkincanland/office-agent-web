#!/usr/bin/env node
/**
 * M2 宏观交通分析数据生成器
 * 
 * 生成：
 * 1. 高速公路流量数据（模拟 flow_avg/flow_max/flow_min）
 * 2. OD 期望线数据（模拟市 - 县区间）
 * 3. 区域交换量数据（桑基图用）
 */
import fs from "node:fs";
import path from "node:path";

const LAYERS_DIR = "office-workspace/maps/zhejiang-map/layers";

// 浙江 11 地市坐标（近似中心）
const CITIES = [
  { code: "330100", name: "杭州市", center: [120.15, 30.28] },
  { code: "330200", name: "宁波市", center: [121.55, 29.87] },
  { code: "330300", name: "温州市", center: [120.67, 28.00] },
  { code: "330400", name: "嘉兴市", center: [120.76, 30.75] },
  { code: "330500", name: "湖州市", center: [120.09, 30.89] },
  { code: "330600", name: "绍兴市", center: [120.58, 30.03] },
  { code: "330700", name: "金华市", center: [119.65, 29.08] },
  { code: "330800", name: "衢州市", center: [118.87, 28.96] },
  { code: "330900", name: "舟山市", center: [122.11, 30.02] },
  { code: "331000", name: "台州市", center: [121.42, 28.66] },
  { code: "331100", name: "丽水市", center: [119.92, 28.43] },
];

function seededRange(seed, min, max) {
  let hash = 2166136261;
  for (const char of String(seed)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const ratio = (hash >>> 0) / 0x100000000;
  return Math.floor(min + ratio * (max - min + 1));
}

function assertCoordinate([lng, lat]) {
  if (lng < 73 || lng > 135 || lat < 18 || lat > 54) {
    throw new Error(`坐标超出中国范围: ${lng},${lat}`);
  }
}

// 生成高速流量数据（基于现有 highways.geojson）
function generateTrafficData() {
  const hwPath = path.join(LAYERS_DIR, "highways.geojson");
  if (!fs.existsSync(hwPath)) {
    console.log("⚠ highways.geojson 不存在，跳过流量数据生成");
    return null;
  }
  
  const hw = JSON.parse(fs.readFileSync(hwPath, "utf8"));
  let generated = 0;
  let preserved = 0;

  for (const f of hw.features) {
    const p = f.properties || {};
    const existingFlow = p.flow_avg === "" || p.flow_avg === null || p.flow_avg === undefined
      ? Number.NaN
      : Number(p.flow_avg);
    if (Number.isFinite(existingFlow) && existingFlow >= 0) {
      preserved++;
      continue;
    }
    // 演示流量数据：使用稳定种子，避免重复生成导致 Git 文件无意义变化。
    const seed = p.osm_id || `${p.ref || "road"}-${generated}`;
    const baseFlow = p.highway === "motorway"
      ? seededRange(seed, 8000, 25000)
      : seededRange(seed, 3000, 12000);
    p.flow_avg = baseFlow;
    p.flow_max = Math.floor(baseFlow * 1.5);
    p.flow_min = Math.floor(baseFlow * 0.6);
    generated++;
  }

  fs.writeFileSync(hwPath, JSON.stringify(hw));
  console.log(`✓ 高速流量数据：新增 ${generated}，保留 ${preserved} 要素`);
  return generated + preserved;
}

// 生成 OD 期望线（市 - 县区间）
function generateODLines() {
  const features = [];
  CITIES.forEach((city) => assertCoordinate(city.center));
  
  // 模拟主要城市间的 OD（杭州 - 宁波、杭州 - 温州等）
  const pairs = [
    [0, 1], [0, 2], [0, 3], [0, 5], [0, 6], // 杭州→宁波/温州/嘉兴/绍兴/金华
    [1, 5], [1, 6], [1, 9], // 宁波→绍兴/金华/台州
    [2, 6], [2, 9], // 温州→金华/台州
    [3, 4], [3, 5], // 嘉兴→湖州/绍兴
    [6, 7], [6, 10], // 金华→衢州/丽水
  ];
  
  for (const [i, j] of pairs) {
    const from = CITIES[i];
    const to = CITIES[j];
    const volume = seededRange(`${from.code}-${to.code}`, 5000, 50000);
    
    // 生成 3 条弧线（不同高度）模拟流量分级
    for (let k = 0; k < 3; k++) {
      const midLng = (from.center[0] + to.center[0]) / 2;
      const midLat = (from.center[1] + to.center[1]) / 2;
      const offset = (k - 1) * 0.3; // 弧线偏移
      
      features.push({
        type: "Feature",
        properties: {
          from_code: from.code,
          from_name: from.name,
          to_code: to.code,
          to_name: to.name,
          volume: Math.floor(volume / (k + 1)),
          level: k === 0 ? "high" : k === 1 ? "medium" : "low",
        },
        geometry: {
          type: "LineString",
          coordinates: [
            from.center,
            [midLng, midLat + offset],
            to.center,
          ],
        },
      });
    }
  }
  
  const geojson = { type: "FeatureCollection", features };
  fs.writeFileSync(path.join(LAYERS_DIR, "OD期望线.geojson"), JSON.stringify(geojson, null, 2));
  console.log(`✓ OD 期望线：${features.length} 要素（${pairs.length} 对城市）`);
  return features.length;
}

// 生成区域交换量数据（桑基图用）
function generateExchangeData() {
  const nodes = CITIES.map(c => ({ name: c.name, code: c.code }));
  const links = [];
  
  // 模拟主要交换流
  const pairs = [
    [0, 1, 45000], [0, 2, 32000], [0, 3, 28000],
    [1, 5, 18000], [1, 9, 15000],
    [2, 9, 12000],
  ];
  
  for (const [i, j, v] of pairs) {
    links.push({
      source: nodes[i].name,
      target: nodes[j].name,
      value: v,
    });
  }
  
  const data = { nodes, links };
  fs.writeFileSync(path.join(LAYERS_DIR, "区域交换量.json"), JSON.stringify(data, null, 2));
  console.log(`✓ 区域交换量：${links.length} 条流`);
  return links.length;
}

// 主函数
function main() {
  fs.mkdirSync(LAYERS_DIR, { recursive: true });
  
  console.log("生成 M2 宏观交通分析数据...");
  const traffic = generateTrafficData();
  const od = generateODLines();
  const exchange = generateExchangeData();
  
  console.log("\n完成。");
}

main();
