import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AGENT_DIR, OFFICECLI, PROJECT_DIR, getWorkspace, normalizeWorkspace } from "./workspace.mjs";
import { checkOfficecli } from "./office.mjs";
import { isProtectedMemoryTarget, withWriteLock, writeCoordinatorInfo, writeWorkspaceFile } from "./写入协调.mjs";
import { runtimeCapabilities } from "./Pi运行时管理.mjs";

const EVALUATION_VERSION = 2;

function check(id, label, status, message, details = {}) {
  return { id, label, status, message, details };
}

function skillRoots() {
  return [
    path.join(AGENT_DIR, "skills"),
    path.join(process.env.USERPROFILE || "C:\\Users\\admin", ".agents", "skills"),
    path.join(process.env.USERPROFILE || "C:\\Users\\admin", ".claude", "skills"),
    path.join(PROJECT_DIR, ".agents", "skills"),
    path.join(PROJECT_DIR, ".pi", "skills"),
    path.join(PROJECT_DIR, ".claude", "skills"),
    "F:\\Claude code本地文件\\.claude\\skills",
  ];
}

function countSkills() {
  const names = new Set();
  const roots = [];
  for (const root of skillRoots()) {
    if (!fs.existsSync(root)) continue;
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    let count = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !fs.existsSync(path.join(root, entry.name, "SKILL.md"))) continue;
      names.add(entry.name);
      count += 1;
    }
    roots.push({ root, count });
  }
  return { count: names.size, roots };
}

function evaluateRuntime(runtime) {
  if (!runtime) return check("runtime", "Pi Runtime", "warning", "当前没有活动 Runtime；创建对话后可查看模型、Profile 和工具策略快照。");
  const missing = ["runtimeId", "piPackageVersion", "profile", "toolPolicyVersion"].filter((key) => !runtime[key]);
  return missing.length
    ? check("runtime", "Pi Runtime", "failed", `Runtime 快照缺少字段：${missing.join("、")}`, { missing })
    : check("runtime", "Pi Runtime", runtime.health?.status === "failed" ? "failed" : "passed", runtime.health?.message || "Runtime 快照、模型、Profile 和工具策略可观测", {
      runtimeId: runtime.runtimeId,
      model: runtime.model,
      profile: runtime.profile,
      toolPolicyVersion: runtime.toolPolicyVersion,
      capabilities: runtime.capabilities || runtimeCapabilities,
    });
}

export function evaluateWorkspaceWrite(root) {
  const probeFile = path.join(root, `.规聚写入探针-${process.pid}-${crypto.randomUUID()}.tmp`);
  let created = false;
  let stage = "create";
  try {
writeWorkspaceFile({ workspace: root, targetPath: probeFile, content: "规聚工作区写入能力探针-初始", kind: "workspace_write_probe", skipExternalOverlap: true });
    created = true;
    stage = "modify";
    writeWorkspaceFile({ workspace: root, targetPath: probeFile, content: "规聚工作区写入能力探针-修改", kind: "workspace_write_probe", skipExternalOverlap: true });
    stage = "readback";
    if (fs.readFileSync(probeFile, "utf8") !== "规聚工作区写入能力探针-修改") {
      const error = new Error("写入后回读内容不一致");
      error.code = "WRITE_PROBE_MISMATCH";
      throw error;
    }
    stage = "delete";
    withWriteLock({ workspace: root, targetPath: probeFile, runId: `probe_${crypto.randomUUID().replaceAll("-", "")}`, kind: "workspace_write_probe", skipExternalOverlap: true }, () => fs.unlinkSync(probeFile));
    created = false;
    return check("workspace-write", "工作区写入", "passed", "当前服务进程已完成文件创建、修改、回读和删除探针", { probe: "create-modify-readback-delete", root, operations: ["create", "modify", "readback", "delete"] });
  } catch (error) {
    if (created) {
      try { fs.unlinkSync(probeFile); } catch {}
    }
    return check("workspace-write", "工作区写入", "failed", `当前服务进程在${stage}阶段无法完成工作区探针：${error.message}`, { probe: "create-modify-readback-delete", root, stage, code: error?.code || null });
  }
}

/**
 * 项目级运行评测是确定性的合同检查，不主动调用模型；写入能力使用创建后立即
 * 删除的临时探针验证，避免把“协调器存在”误报成“工作区实际可写”。
 * 它用于回答“能不能可靠读、能不能找到 Skills、Office 是否可用、记忆是否受治理、
 * 并发和写入协调是否存在”，不能替代真实模型回合验收。
 */
export async function runRuntimeEvaluation({ workspace = getWorkspace(), runtime = null, probeOffice = false } = {}) {
  const root = normalizeWorkspace(workspace) || path.resolve(workspace || PROJECT_DIR);
  const checks = [];

  const contextFile = path.join(root, ".agent-context.md");
  try {
    const content = fs.readFileSync(contextFile, "utf8");
    const hasWorkspace = content.includes(root);
    checks.push(check("read-reliability", "工作区读取", hasWorkspace ? "passed" : "warning", hasWorkspace ? "工作区上下文文件可读取且包含当前绝对路径" : "上下文文件可读取，但没有确认当前工作区绝对路径", { file: contextFile, bytes: Buffer.byteLength(content) }));
  } catch (error) {
    const notInitialized = error?.code === "ENOENT";
    checks.push(check("read-reliability", "工作区读取", notInitialized ? "warning" : "failed", notInitialized ? "工作区尚未初始化 .agent-context.md；首次创建 Runtime 时会自动生成" : `无法读取 .agent-context.md：${error.message}`, { file: contextFile, code: error?.code || null }));
  }

  const workspaceWrite = evaluateWorkspaceWrite(root);
  checks.push(workspaceWrite);

  const skills = countSkills();
  checks.push(check("skills", "Skills 读取", skills.count > 0 ? "passed" : "warning", skills.count > 0 ? `已发现 ${skills.count} 个可读取的 Skill` : "没有发现可读取的 SKILL.md；Skills 调用会明确返回未找到", skills));

  let office = { available: path.isAbsolute(OFFICECLI) ? fs.existsSync(OFFICECLI) : true, path: OFFICECLI };
  if (probeOffice) office = await checkOfficecli();
  const officeReady = office.available && workspaceWrite.status === "passed";
  checks.push(check("office-output", "Office 产出", officeReady ? "passed" : "warning", officeReady ? "Office CLI 可执行，且当前服务进程可以写入工作区" : office.available ? "Office CLI 可执行，但当前服务进程不能写入工作区" : `Office CLI 当前不可用：${office.message || "未找到可执行文件"}`, office));

  const proposalFile = path.join(PROJECT_DIR, ".oaw", "memory-proposals.json");
  const memoryGuard = isProtectedMemoryTarget(root, path.join(root, "memory")) && isProtectedMemoryTarget(root, path.join(root, "AGENTS.md"));
  checks.push(check("memory-governance", "记忆治理", memoryGuard ? "passed" : "failed", memoryGuard ? "memory/ 与 AGENTS.md 被识别为受保护目标，长期记忆通过建议审核链" : "记忆保护目标检查未通过", { proposalFile, proposalsFileExists: fs.existsSync(proposalFile) }));

  const coordinator = writeCoordinatorInfo();
  checks.push(check("concurrency-write", "并发与写入协调", coordinator?.lockDir && coordinator?.stagedRunsDir ? "passed" : "failed", coordinator?.lockDir && coordinator?.stagedRunsDir ? "模型/Office 并发闸门与写入协调器已注册；实际写入结果见工作区探针" : "写入协调器信息不完整", coordinator));

  checks.push(evaluateRuntime(runtime));
  const failed = checks.filter((item) => item.status === "failed").length;
  const warnings = checks.filter((item) => item.status === "warning").length;
  return {
    version: EVALUATION_VERSION,
    generatedAt: new Date().toISOString(),
    workspace: root,
    ok: failed === 0,
    status: failed ? "failed" : warnings ? "warning" : "passed",
    checks,
    note: "这是 Runtime/工作区合同评测；真实 Agent/Office 任务仍需结合 Run 产物验收。",
  };
}
