#!/usr/bin/env node
/**
 * 清理历史 Run 产物列表里的临时/调试噪音文件。
 * 默认只报告；加 --apply 执行清理（清理前把原 Run JSON 备份到 .backup-产物清理/）。
 *
 *   node scripts/清理历史产物噪音.mjs
 *   node scripts/清理历史产物噪音.mjs --apply
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECT_DIR } from "../server/workspace.mjs";
import { isNoiseArtifactPath } from "../server/runs.mjs";

const RUNS_DIR = path.join(PROJECT_DIR, ".oaw", "runs");
const BACKUP_DIR = path.join(RUNS_DIR, ".backup-产物清理");
const apply = process.argv.includes("--apply");

if (!fs.existsSync(RUNS_DIR)) {
  console.log("未找到 Run 目录：", RUNS_DIR);
  process.exit(0);
}

let scanned = 0;
let hitRuns = 0;
const samples = [];
let removedTotal = 0;

for (const name of fs.readdirSync(RUNS_DIR).filter((item) => item.endsWith(".json"))) {
  const fullPath = path.join(RUNS_DIR, name);
  let run = null;
  try {
    run = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  } catch {
    continue;
  }
  scanned += 1;
  const artifacts = Array.isArray(run.artifacts) ? run.artifacts : [];
  const noise = artifacts.filter((item) => isNoiseArtifactPath(item?.path));
  if (!noise.length) continue;
  hitRuns += 1;
  removedTotal += noise.length;
  if (samples.length < 8) {
    samples.push(`${run.id}（${run.status}）：${noise.slice(0, 5).map((item) => item.path).join(", ")}${noise.length > 5 ? ` …共 ${noise.length} 个` : ""}`);
  }
  if (apply) {
    try {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      fs.writeFileSync(path.join(BACKUP_DIR, name), JSON.stringify(run, null, 2));
      run.artifacts = artifacts.filter((item) => !isNoiseArtifactPath(item?.path));
      fs.writeFileSync(fullPath, JSON.stringify(run, null, 2));
    } catch (error) {
      console.error(`清理失败：${run.id} ${error.message}`);
    }
  }
}

console.log(`扫描 Run：${scanned} 个；含噪音产物的 Run：${hitRuns} 个；噪音条目：${removedTotal} 条`);
for (const line of samples) console.log("  -", line);
if (apply) {
  console.log(hitRuns ? `已清理（备份在 .oaw/runs/.backup-产物清理/）` : "无需清理");
} else if (hitRuns) {
  console.log("仅为报告模式：确认后执行 node scripts/清理历史产物噪音.mjs --apply");
}
