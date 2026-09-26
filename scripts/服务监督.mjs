#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = path.join(ROOT, "server", "index.mjs");
const LOG_DIR = path.join(ROOT, "运行日志");
const LOG_FILE = path.join(LOG_DIR, "服务监督.log");
const HOST = String(process.env.HOST || "127.0.0.1");
const PORT = Number.parseInt(String(process.env.PORT || "3002"), 10);
const HEALTH_INTERVAL_MS = 15_000;
const HEALTH_TIMEOUT_MS = 4_000;
const HEALTH_FAILURE_LIMIT = 3;
const STARTUP_GRACE_MS = 60_000;
const CHILD_STOP_TIMEOUT_MS = 12_000;
const RAPID_RESTART_WINDOW_MS = 30_000;
const RAPID_RESTART_LIMIT = 5;
const RESTART_DELAY_MS = 3_000;
const RESTART_COOLDOWN_MS = 30_000;

export function isHealthyPayload(payload, expectedVersion = "") {
  if (!payload || typeof payload !== "object" || payload.ok !== true) return false;
  return !expectedVersion || String(payload.version || "") === String(expectedVersion);
}

export function restartDelayFor({ uptimeMs, rapidFailures }) {
  const failures = uptimeMs < RAPID_RESTART_WINDOW_MS ? rapidFailures + 1 : 0;
  return {
    failures,
    delayMs: failures >= RAPID_RESTART_LIMIT ? RESTART_COOLDOWN_MS : RESTART_DELAY_MS,
  };
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${line}\n`, "utf8");
  } catch (error) {
    process.stderr.write(`${line} (日志写入失败：${error.message})\n`);
  }
  if (process.env.OAW_SUPERVISOR_QUIET !== "1") process.stdout.write(`${line}\n`);
}

function probeHost() {
  if (HOST === "0.0.0.0" || HOST === "::") return HOST === "::" ? "::1" : "127.0.0.1";
  return HOST;
}

function getHealth({ timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const request = http.get({
      hostname: probeHost(),
      port: PORT,
      path: "/api/status",
      timeout: timeoutMs,
      headers: { Accept: "application/json", Connection: "close" },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 32_768) request.destroy(new Error("health response too large"));
      });
      response.on("end", () => {
        try {
          resolve({ statusCode: response.statusCode, payload: JSON.parse(body) });
        } catch {
          resolve(null);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("health check timeout")));
    request.on("error", () => resolve(null));
  });
}

function portIsOccupied() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: probeHost(), port: PORT });
    let settled = false;
    const finish = (occupied) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(800, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function readPackageVersion() {
  const pkg = JSON.parse(await fs.promises.readFile(path.join(ROOT, "package.json"), "utf8"));
  return String(pkg.version || "");
}

async function inspectExistingService(expectedVersion) {
  const health = await getHealth();
  if (health && health.statusCode >= 200 && health.statusCode < 300 && health.payload?.ok === true) {
    const version = String(health.payload.version || "unknown");
    if (expectedVersion && version !== expectedVersion) {
      throw new Error(`端口 ${PORT} 上已有 Open Plan 服务（${version}），本地代码为 ${expectedVersion}；为避免前后端版本混用，请先关闭旧服务。`);
    }
    return { running: true, version };
  }
  if (await portIsOccupied()) {
    throw new Error(`端口 ${PORT} 已被其他程序占用，但未返回 Open Plan 健康状态；为避免误停其他程序，未启动新实例。`);
  }
  return { running: false };
}

async function launchBackground() {
  const version = await readPackageVersion();
  const existing = await inspectExistingService(version);
  if (existing.running) {
    log(`Open Plan 已运行：http://${HOST}:${PORT}（${existing.version}）`);
    return;
  }

  await fs.promises.mkdir(LOG_DIR, { recursive: true });
  const logFd = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--foreground"], {
    cwd: ROOT,
    env: { ...process.env, OAW_SUPERVISOR_QUIET: "1" },
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);
  log(`已启动后台监督进程（PID ${child.pid ?? "unknown"}），等待健康检查。`);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const health = await getHealth();
    if (health && health.statusCode >= 200 && health.statusCode < 300 && isHealthyPayload(health.payload, version)) {
      log(`Open Plan 已就绪：http://${HOST}:${PORT}（${version}）`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`启动等待超时。请检查 ${LOG_FILE} 获取服务和监督器日志。`);
}

async function launchForeground() {
  const version = await readPackageVersion();
  const existing = await inspectExistingService(version);
  if (existing.running) {
    log(`Open Plan 已运行：http://${HOST}:${PORT}（${existing.version}）`);
    return;
  }

  let child = null;
  let stopping = false;
  let restartRequested = false;
  let healthFailures = 0;
  let healthCheckRunning = false;
  let rapidFailures = 0;
  let childStartedAt = 0;
  let stopTimer = null;
  let restartTimer = null;

  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    clearInterval(healthTimer);
    clearTimeout(restartTimer);
    log(`收到 ${signal}，正在停止监督器。`);
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      process.exit(0);
      return;
    }
    child.kill("SIGTERM");
    stopTimer = setTimeout(() => {
      if (child && child.exitCode === null && child.signalCode === null) {
        log("服务未能在宽限期内退出，发送 SIGKILL。 ");
        child.kill("SIGKILL");
      }
    }, CHILD_STOP_TIMEOUT_MS);
    stopTimer.unref();
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  const requestRestart = (reason) => {
    if (stopping || restartRequested || !child) return;
    restartRequested = true;
    log(`健康检查连续失败，正在重启服务：${reason}`);
    child.kill("SIGTERM");
    stopTimer = setTimeout(() => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, CHILD_STOP_TIMEOUT_MS);
    stopTimer.unref();
  };

  const healthTimer = setInterval(async () => {
    if (healthCheckRunning || stopping || restartRequested || !child) return;
    if (Date.now() - childStartedAt < STARTUP_GRACE_MS) return;
    healthCheckRunning = true;
    try {
      const health = await getHealth();
      const isHealthy = health && health.statusCode >= 200 && health.statusCode < 300 && isHealthyPayload(health.payload, version);
      if (isHealthy) {
        healthFailures = 0;
        return;
      }
      healthFailures += 1;
      log(`健康检查失败（${healthFailures}/${HEALTH_FAILURE_LIMIT}）。`);
      if (healthFailures >= HEALTH_FAILURE_LIMIT) requestRestart("/api/status 不可用或服务版本不匹配");
    } finally {
      healthCheckRunning = false;
    }
  }, HEALTH_INTERVAL_MS);
  healthTimer.unref();

  const startChild = () => {
    if (stopping) return;
    restartRequested = false;
    healthFailures = 0;
    childStartedAt = Date.now();
    log(`启动服务进程（${process.execPath} ${path.relative(ROOT, SERVER_ENTRY)}，版本 ${version}）。`);
    child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: ROOT,
      env: process.env,
      windowsHide: true,
      stdio: "inherit",
    });
    child.once("error", (error) => log(`服务进程启动错误：${error.message}`));
    child.once("close", async (code, signal) => {
      clearTimeout(stopTimer);
      if (stopping) {
        process.exit(0);
        return;
      }
      const uptimeMs = Date.now() - childStartedAt;
      const exitStatus = signal ? `signal ${signal}` : `exit ${code}`;
      if (code === 0 && !signal && !restartRequested) {
        log("服务正常退出，监督器停止。 ");
        process.exit(0);
        return;
      }
      try {
        const other = await getHealth();
        if (other && other.statusCode >= 200 && other.statusCode < 300 && other.payload?.ok === true) {
          log(`服务进程已退出（${exitStatus}），端口上检测到另一个 Open Plan 实例；监督器停止以避免重复启动。`);
          process.exit(1);
          return;
        }
        if (await portIsOccupied()) {
          log(`服务进程已退出（${exitStatus}），端口被其他程序占用；监督器停止以避免反复重启。`);
          process.exit(1);
          return;
        }
      } catch (error) {
        log(`端口冲突检查失败：${error.message}`);
      }
      const policy = restartDelayFor({ uptimeMs, rapidFailures });
      rapidFailures = policy.failures;
      const delay = restartRequested ? 1_000 : policy.delayMs;
      log(`服务异常退出（${exitStatus}，运行 ${Math.round(uptimeMs / 1000)} 秒），${Math.round(delay / 1000)} 秒后重试。`);
      restartTimer = setTimeout(startChild, delay);
    });
  };

  startChild();
}

async function main() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`无效 PORT：${process.env.PORT}`);
  const foreground = process.argv.includes("--foreground");
  if (foreground) await launchForeground();
  else await launchBackground();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    log(`启动失败：${error.message}`);
    process.exitCode = 1;
  });
}
