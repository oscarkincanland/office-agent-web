#!/usr/bin/env node
/**
 * 成果可信度回归：
 * 1. 界面不得宣称“所有操作都可回滚”这类超出真实能力的说法；
 * 2. 是否可回滚必须由「未回滚 + 存在上一正式版本（rollbackTarget）」决定；
 * 3. 服务端继续拒绝没有历史版本的回滚请求；
 * 4. 「待固定 / 验收通过」必须同时满足：格式验收通过 + 所属任务成功结束 + 未固定（P0）；
 *    失败任务的文件不得被标成可固定的“验收通过”；两个界面必须消费同一份口径。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { artifactStatusInfo, artifactAcceptanceText, acceptanceSummaryText } from "../client/src/components/验收状态.js";
import { detectRecentWorkspaceFiles, mergeChangeLists, filterRunChanges, snapshotWorkspace } from "../server/runs.mjs";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const 面板 = read("../client/src/components/工作产物面板.jsx");
const 任务中心 = read("../client/src/components/任务中心.jsx");
const 成果管理 = read("../server/成果管理.mjs");

// 1. 不再承诺“所有操作都可回滚”
assert.doesNotMatch(面板, /所有操作都可回滚/, "不应宣称所有操作都可回滚");
assert.match(面板, /首个版本没有历史版本，需手动恢复/, "应说明首个版本不可回滚");

// 2. 回滚能力按真实条件生成
assert.match(面板, /const rollbackableCount = published\.filter\(\(item\) => item\.status !== "rolled_back" && item\.rollbackTarget\)\.length/, "可回滚数量应按真实条件统计");
assert.match(面板, /const canRollback = !rolledBack && !!item\.rollbackTarget/, "逐项回滚能力应按真实条件判定");
assert.match(面板, /首个版本 · 无历史版本可回滚/, "首个版本应显式说明不可回滚");
assert.match(面板, /当前没有可回滚的历史版本/, "无历史版本时不应暗示可回滚");

// 3. 服务端能力未被放宽
assert.match(成果管理, /if \(!current\.rollbackTarget\) return \{ ok: false, status: 409, error: "没有可回滚的历史版本" \}/, "服务端应继续拒绝没有历史版本的回滚");

console.log("\n▶ 验收状态语义（P0）");

// 4a. 只有「格式通过 + 任务成功 + 未固定」才是可固定的“待固定”
{
  const 可固定 = artifactStatusInfo({ publication: null, result: { readyToPublish: true }, resultStatus: "passed", runStatus: "completed" });
  assert.equal(可固定.canPublish, true, "任务成功 + 格式通过应可固定");
  assert.equal(可固定.label, "待固定");
  assert.equal(可固定.tone, "ready");

  const 失败任务 = artifactStatusInfo({ publication: null, result: { readyToPublish: true }, resultStatus: "passed", runStatus: "failed" });
  assert.equal(失败任务.canPublish, false, "失败任务的文件不得可固定");
  assert.match(失败任务.label, /任务未完成/, "失败任务的文件必须标明任务未完成");
  assert.doesNotMatch(失败任务.label, /^验收通过$/, "不得把失败任务的文件标成验收通过");

  const 已固定 = artifactStatusInfo({ publication: { version: 2 }, result: { readyToPublish: true }, resultStatus: "passed", runStatus: "completed" });
  assert.equal(已固定.canPublish, false, "已固定的成果不得再计入待固定");
  assert.match(已固定.label, /已固定/);

  const 格式失败 = artifactStatusInfo({ publication: null, result: { readyToPublish: false }, resultStatus: "failed", runStatus: "completed" });
  assert.equal(格式失败.canPublish, false);
  assert.match(格式失败.label, /格式验收失败/);
}

// 4b. 任务级汇总区分「文件格式验收」与「任务是否成功」
{
  assert.match(acceptanceSummaryText("passed", "completed"), /文件格式验收通过/);
  assert.doesNotMatch(acceptanceSummaryText("passed", "completed"), /任务未成功/);
  assert.match(acceptanceSummaryText("passed", "failed"), /文件格式验收通过/);
  assert.match(acceptanceSummaryText("passed", "failed"), /任务未成功结束/);
}

// 4c. 单文件状态文案覆盖所有状态
{
  assert.equal(artifactAcceptanceText("passed"), "格式通过");
  assert.equal(artifactAcceptanceText("manual_review"), "待人工确认");
  assert.equal(artifactAcceptanceText("warning"), "格式通过（有提示）");
  assert.equal(artifactAcceptanceText("failed"), "格式失败");
  assert.equal(artifactAcceptanceText("not_checked"), "未检查");
  assert.equal(artifactAcceptanceText(undefined), "未检查");
}

// 4d. 两个界面消费同一份口径（不允许各自复制规则）
{
  assert.match(面板, /import \{ artifactStatusInfo \} from "\.\/验收状态\.js"/, "产物面板应复用共享验收口径");
  assert.match(面板, /const info = artifactStatusInfo\(\{ publication, result, resultStatus, runStatus: run\.status \}\)/, "产物面板应把任务状态纳入判定");
  assert.match(面板, /return artifactStatusInfo\(\{ publication, result, resultStatus, runStatus: run\.status \}\)\.canPublish/, "待固定计数必须与可固定按钮同源");
  assert.doesNotMatch(面板, /artifactStatusLabel/, "不应保留旧的状态文案函数");
  assert.match(任务中心, /import \{ artifactAcceptanceText, acceptanceSummaryText \} from "\.\/验收状态\.js"/, "任务中心应复用共享验收口径");
  assert.match(任务中心, /acceptanceSummaryText\(detail\.acceptanceStatus, detail\.status\)/, "任务中心验收汇总应带上任务状态");
  assert.doesNotMatch(任务中心, /item\.status === "passed" \? "通过"/, "任务中心不得把文件直接标成“通过”");
}

console.log("\n▶ 产物检测：大工作区 / 无明确路径（P0 回归）");

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-artifacts-"));
  try {
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "old.md"), "old");
    const since = Date.now() - 60_000;
    // 运行开始后：根目录新产物 + 子目录新产物 + 修改既有文件
    fs.writeFileSync(path.join(root, "报告.md"), "new product");
    fs.writeFileSync(path.join(root, "sub", "数据.csv"), "a,b\n1,2");
    fs.writeFileSync(path.join(root, "old.md"), "old-updated");

    const recent = detectRecentWorkspaceFiles(root, since);
    const paths = recent.map((item) => item.path).sort();
    assert.deepEqual(paths, ["old.md", "sub/数据.csv", "报告.md"].sort(), `应检出运行窗口内的变更，实际 ${paths.join(",")}`);

    // 关键回归：touchedPaths 只有 "."（bash/officecli 写入拿不到具体文件）时，
    // 也必须保留检出的变更，而不是把产物全部过滤掉。
    const run = { cwd: root, touchedPaths: ["."], before: { files: { "old.md": { hash: "x" } } } };
    const filtered = filterRunChanges(run, mergeChangeLists([], recent.map((item) => ({ path: item.path, status: item.status || "modified" }))));
    assert.equal(filtered.length, 3, `只有 "." 时也应保留全部检出变更，实际 ${filtered.length}`);

    // 快照遍历顺序稳定，且带截断标记字段
    const a = snapshotWorkspace(root);
    const b = snapshotWorkspace(root);
    assert.deepEqual(Object.keys(a.files), Object.keys(b.files), "快照遍历顺序必须稳定，否则产物检测会时有时无");
    assert.equal(a.truncated, false, "小目录不应标记截断");
    assert.equal(typeof a.truncated, "boolean");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  // 快照上限可配置、触顶必须标记 truncated（避免"没看到就说没变更"）
  assert.match(成果管理, /export function saveRun|RUNS_DIR/); // 保持文件已被读取
  const runs源 = read("../server/runs.mjs");
  assert.match(runs源, /OAW_RUN_SNAPSHOT_MAX_FILES/, "快照上限应可配置");
  assert.match(runs源, /out\.truncated = true/, "触顶必须标记 truncated");
  assert.match(runs源, /detectRecentWorkspaceFiles\(run\.cwd, sinceMs\)/, "无明确路径时应启用运行窗口 mtime 扫描");
  assert.match(runs源, /mergeChangeLists\(snapshotChanges, recentChanges\)/, "两种变更来源应合并");
  assert.match(runs源, /snapshotTruncated: Boolean\(run\.snapshotTruncated\)/, "run_finished 应携带截断标记");
}

console.log("成果可信度回归：通过");
