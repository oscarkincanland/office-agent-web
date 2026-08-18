const CENTERS = {
  "义乌市": [120.075, 29.306],
  "金华市": [119.647, 29.079],
  "杭州市": [120.155, 30.274],
  "新昌县": [120.903, 29.499],
  "暹粒市": [103.856, 13.363],
};

/** 生成可直接交给 MapViewer 的确定性演示分析结果。 */
export function createDemoAnalysis({ analysis = "heatmap", region = "义乌市", project = "zhejiang-map", count = 36 } = {}) {
  const center = CENTERS[region] || CENTERS["义乌市"];
  let geojson;
  let title;
  if (analysis === "isochrone") {
    const ranges = [15, 30, 45];
    geojson = {
      type: "FeatureCollection",
      features: ranges.map((range, index) => {
        const radius = 0.0045 * range;
        const points = Array.from({ length: 48 }, (_, i) => {
          const angle = (Math.PI * 2 * i) / 48;
          const wobble = 1 + 0.12 * Math.sin(i * 2.7 + index);
          return [center[0] + Math.cos(angle) * radius * wobble, center[1] + Math.sin(angle) * radius * 0.72 * wobble];
        });
        points.push(points[0]);
        return { type: "Feature", properties: { range, color: ["#c4b5fd", "#8b5cf6", "#6d28d9"][index] }, geometry: { type: "Polygon", coordinates: [points] } };
      }),
    };
    title = `${region}可达性等时圈`;
  } else {
    const total = Math.min(120, Math.max(12, Math.round(count || 36)));
    geojson = {
      type: "FeatureCollection",
      features: Array.from({ length: total }, (_, i) => {
        const angle = i * 2.39996;
        const radius = 0.008 + ((i * 17) % 29) / 1000;
        const value = 20 + ((i * 37) % 180);
        return {
          type: "Feature",
          properties: { name: `${region}演示点-${String(i + 1).padStart(2, "0")}`, value, category: i % 3 === 0 ? "枢纽" : i % 3 === 1 ? "商贸" : "居住" },
          geometry: { type: "Point", coordinates: [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius * 0.72] },
        };
      }),
    };
    title = `${region}点位热力图`;
  }
  return { action: "show_analysis", analysis, type: analysis, id: "agent-analysis", project, region, source: "demo", title, fitBounds: true, geojson, stats: { demo: true, region } };
}
