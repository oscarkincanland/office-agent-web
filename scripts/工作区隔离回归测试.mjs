#!/usr/bin/env node
/**
 * 工作区隔离回归测试（阶段四/六）：
 * 1. 源码接入点：Runtime 工作区归属校验、会话恢复校验、线程级上下文文件；
 * 2. 地图项目生命周期：复制 / 重命名 / 归档 / 删除（真实文件系统，测试后清理）。
 * 用法: node scripts/工作区隔离回归测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_DIR } from "../server/workspace.mjs";
import { archiveProject, createProject, deleteProject, duplicateProject, getProject, renameProject } from "../server/map.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let failed = 0;
function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); failed = 1; }
function test(name, fn) {
  try { fn(); ok(name); } catch (e) { fail(`${name}: ${e.message}`); }
}

console.log("\n▶ 源码接入点");

const agentSource = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
const indexSource = fs.readFileSync(path.join(ROOT, "server", "index.mjs"), "utf8");

test("Runtime 拒绝静默跨工作区复用", () => {
  assert.match(agentSource, /同一 client::thread 不允许静默跨工作区复用运行时/);
  assert.match(agentSource, /code = "WORKSPACE_BUSY"/);
});

test("会话恢复校验 JSONL 头工作区", () => {
  assert.match(indexSource, /SESSION_WORKSPACE_MISMATCH/);
  assert.match(indexSource, /readSessionHeader\(found\)/);
});

test("上下文文件按线程隔离（兼容旧文件名）", () => {
  assert.match(agentSource, /\.agent-context\.\$\{entry\.threadId\}\.md/);
  assert.match(agentSource, /旧版 \.agent-context\.md 可能被其他会话覆盖/);
});

console.log("\n▶ 地图项目生命周期（真实文件系统）");

const stamp = Date.now().toString(36);
const baseId = `zz-iso-${stamp}`;
const copyId = `${baseId}-copy`;
const renamedId = `${baseId}-renamed`;
const mapsRoot = path.join(WORKSPACE_DIR, "maps");

function cleanup() {
  for (const id of [baseId, copyId, renamedId]) {
    try { fs.rmSync(path.join(mapsRoot, id), { recursive: true, force: true }); } catch {}
  }
  try {
    const trash = path.join(mapsRoot, ".trash");
    if (fs.existsSync(trash)) {
      for (const entry of fs.readdirSync(trash)) {
        if (entry.startsWith(baseId) || entry.startsWith(renamedId)) {
          fs.rmSync(path.join(trash, entry), { recursive: true, force: true });
        }
      }
    }
  } catch {}
}

try {
  test("创建测试项目并写入图层", () => {
    createProject({ project: baseId, name: "隔离测试项目", baseProject: "zhejiang-map" });
    const layerPath = path.join(mapsRoot, baseId, "layers", "test-layer.geojson");
    fs.writeFileSync(layerPath, JSON.stringify({ type: "FeatureCollection", features: [] }));
    const project = getProject(baseId);
    assert.ok(project, "项目应可读取");
    assert.ok(project.files.some((item) => item.id === "test-layer"), "图层应被列出");
  });

  test("复制项目保留图层且相互独立", () => {
    duplicateProject({ project: baseId, name: copyId });
    const copy = getProject(copyId);
    assert.ok(copy, "副本应存在");
    assert.ok(copy.files.some((item) => item.id === "test-layer"), "副本应保留图层");
    assert.equal(copy.config.duplicatedFrom, baseId);
    // 修改副本不影响原项目
    fs.writeFileSync(path.join(mapsRoot, copyId, "layers", "copy-only.geojson"), JSON.stringify({ type: "FeatureCollection", features: [] }));
    const original = getProject(baseId);
    assert.ok(!original.files.some((item) => item.id === "copy-only"), "原项目不应出现副本新增图层");
  });

  test("归档切换状态且不移动目录", () => {
    const config = archiveProject(baseId, true);
    assert.equal(config.archived, true);
    assert.ok(fs.existsSync(path.join(mapsRoot, baseId, "map.config.json")), "归档不应删除目录");
    archiveProject(baseId, false);
    assert.equal(getProject(baseId).config.archived, false);
  });

  test("重命名保留图层并更新配置", () => {
    renameProject({ project: copyId, name: renamedId });
    assert.ok(!fs.existsSync(path.join(mapsRoot, copyId)), "旧目录应不存在");
    const renamed = getProject(renamedId);
    assert.equal(renamed.config.project, renamedId);
    assert.ok(renamed.files.some((item) => item.id === "test-layer"), "重命名后图层保留");
  });

  test("默认项目受保护（不可删除/重命名）", () => {
    assert.throws(() => deleteProject("zhejiang-map"), /不能删除/);
    assert.throws(() => renameProject({ project: "zhejiang-map", name: "x" }), /不能重命名/);
  });

  test("删除移入回收目录而不是物理删除", () => {
    const result = deleteProject(renamedId);
    assert.ok(result.trash, "应返回回收目录名");
    assert.ok(!fs.existsSync(path.join(mapsRoot, renamedId)), "原目录应已移走");
    const trashed = path.join(mapsRoot, ".trash", result.trash);
    assert.ok(fs.existsSync(trashed), "回收目录中应存在");
  });
} catch (error) {
  fail(`地图项目测试异常: ${error.message}`);
} finally {
  cleanup();
}

console.log(failed ? "\n工作区隔离回归：失败" : "\n工作区隔离回归：通过");
process.exit(failed ? 1 : 0);
