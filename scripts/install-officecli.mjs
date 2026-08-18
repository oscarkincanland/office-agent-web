/**
 * OfficeCLI 内置安装器（scripts/install-officecli.mjs）
 *
 * 从 iOfficeAI/OfficeCLI（开源，单二进制，免 Office 安装）下载当前平台二进制
 * 到项目 bin/officecli，校验 SHA256，处理 macOS quarantine/签名。
 *
 * 用法：node scripts/install-officecli.mjs
 * 支持环境变量：OFFICECLI_VERSION（固定版本，默认 latest）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const BIN_DIR = path.join(PROJECT_DIR, "bin");
const BIN_PATH = path.join(BIN_DIR, "officecli");

const REPO = "iOfficeAI/OfficeCLI";
const MIRROR_BASE = "https://d.officecli.ai";
const GITHUB_BASE = `https://github.com/${REPO}`;

function assetName() {
  const osName = os.platform();
  const arch = os.arch();
  if (osName === "darwin") return arch === "arm64" ? "officecli-mac-arm64" : "officecli-mac-x64";
  if (osName === "linux") {
    const musl = fs.existsSync("/etc/alpine-release");
    if (arch === "x64") return musl ? "officecli-linux-alpine-x64" : "officecli-linux-x64";
    if (arch === "arm64") return musl ? "officecli-linux-alpine-arm64" : "officecli-linux-arm64";
  }
  if (osName === "win32") return "officecli-win-x64.exe";
  throw new Error(`不支持的平台: ${osName}/${arch}`);
}

async function resolveVersion() {
  try {
    const r = await fetch(`${MIRROR_BASE}/releases/latest`, { redirect: "follow" });
    const m = /\/tag\/(v[^\s/]+)/.exec(r.url);
    if (m) return m[1];
  } catch {}
  try {
    const r = await fetch(`${GITHUB_BASE}/releases/latest`, { redirect: "follow" });
    const m = /\/tag\/(v[^\s/]+)/.exec(r.url);
    if (m) return m[1];
  } catch {}
  return null;
}

async function fetchWithFallback(primary, fallback) {
  try {
    const r = await fetch(primary, { signal: AbortSignal.timeout(120000) });
    if (r.ok) return Buffer.from(await r.arrayBuffer());
  } catch {}
  const r = await fetch(fallback, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`下载失败: ${fallback} -> HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function main() {
  console.log("OfficeCLI 安装器（内置到项目 bin/）");
  const asset = assetName();
  const win = asset.endsWith(".exe");
  console.log(`平台资产: ${asset}`);

  const version = process.env.OFFICECLI_VERSION || (await resolveVersion());
  const base = version
    ? `${MIRROR_BASE}/releases/download/${version}`
    : `${MIRROR_BASE}/releases/latest/download`;
  const ghBase = version
    ? `${GITHUB_BASE}/releases/download/${version}`
    : `${GITHUB_BASE}/releases/latest/download`;

  console.log(`下载中: ${base}/${asset}${version ? `（版本 ${version}）` : ""}`);
  const buf = await fetchWithFallback(`${base}/${asset}`, `${ghBase}/${asset}`);
  console.log(`已下载 ${(buf.length / 1024 / 1024).toFixed(1)} MB`);

  // 校验 SHA256（可选）
  try {
    const sums = (await fetchWithFallback(`${base}/SHA256SUMS`, `${ghBase}/SHA256SUMS`)).toString("utf8");
    const line = sums.split("\n").find((l) => l.trim().endsWith(`  ${asset}`) || l.trim().endsWith(` ${asset}`));
    if (line) {
      const expected = line.trim().split(/\s+/)[0];
      const actual = sha256(buf);
      if (expected !== actual) throw new Error(`SHA256 不匹配: 期望 ${expected}，实际 ${actual}`);
      console.log("SHA256 校验通过");
    }
  } catch (e) {
    if (e.message.includes("SHA256 不匹配")) throw e;
    console.log("（无校验和文件，跳过校验）");
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(BIN_PATH, buf);
  fs.chmodSync(BIN_PATH, 0o755);

  // macOS：清除 quarantine + 校验签名（Apple Silicon 要求签名，CI 已签名则保留）
  if (os.platform() === "darwin") {
    try {
      const { execSync } = await import("node:child_process");
      execSync(`xattr -d com.apple.quarantine "${BIN_PATH}" 2>/dev/null || true`);
      try {
        execSync(`codesign -v --strict "${BIN_PATH}"`, { stdio: "ignore" });
      } catch {
        execSync(`codesign -s - -f "${BIN_PATH}"`);
        console.log("已 ad-hoc 签名");
      }
    } catch {}
  }

  // 验证
  try {
    const { execSync } = await import("node:child_process");
    const out = execSync(`"${BIN_PATH}" --version 2>&1 || "${BIN_PATH}" version 2>&1`, { encoding: "utf8" }).trim();
    console.log(`验证: ${out}`);
  } catch {
    console.log("二进制已安装，但 --version 验证失败（可能是 CLI 用法差异，忽略）");
  }
  console.log(`已安装到: ${BIN_PATH}`);
  console.log("运行验证: officecli --help");
}

main().catch((e) => {
  console.error("安装失败:", e.message);
  process.exit(1);
});
