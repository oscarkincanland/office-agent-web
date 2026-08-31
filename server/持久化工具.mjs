import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * 规聚本地运行数据的安全持久化工具。
 * 先写同目录临时文件并尽力完成 fsync，再替换目标文件，避免服务异常时直接截断原文件。
 */
export function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function temporaryPath(file, suffix = "tmp") {
  return `${file}.${process.pid}.${crypto.randomUUID()}.${suffix}`;
}

function closeQuietly(fd) {
  try { if (fd !== undefined && fd !== null) fs.closeSync(fd); } catch {}
}

function replaceFile(temp, file) {
  try {
    fs.renameSync(temp, file);
    return;
  } catch (error) {
    // Windows 不允许 rename 覆盖已存在目标；先移动旧文件，失败时尽力恢复。
    if (!fs.existsSync(file) || !["EEXIST", "EPERM", "ENOTEMPTY"].includes(error?.code)) throw error;
  }
  const backup = temporaryPath(file, "bak");
  fs.renameSync(file, backup);
  try {
    fs.renameSync(temp, file);
    try { fs.rmSync(backup, { force: true }); } catch {}
  } catch (error) {
    try {
      if (!fs.existsSync(file) && fs.existsSync(backup)) fs.renameSync(backup, file);
    } catch {}
    throw error;
  }
}

export function atomicWriteFile(file, data, encoding = "utf8") {
  const target = path.resolve(file);
  ensureDirectory(path.dirname(target));
  const temp = temporaryPath(target);
  let fd;
  try {
    fd = fs.openSync(temp, "w");
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), encoding);
    fs.writeFileSync(fd, buffer);
    try { fs.fsyncSync(fd); } catch {}
    closeQuietly(fd);
    fd = undefined;
    replaceFile(temp, target);
  } catch (error) {
    closeQuietly(fd);
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
  return target;
}

export function atomicWriteJson(file, value) {
  return atomicWriteFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** 使用 O_APPEND 写入一条完整 JSONL，并在可用时 flush 到磁盘。 */
export function appendJsonLine(file, value) {
  const target = path.resolve(file);
  ensureDirectory(path.dirname(target));
  const fd = fs.openSync(target, "a");
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + "\n", "utf8");
    try { fs.fsyncSync(fd); } catch {}
  } finally {
    closeQuietly(fd);
  }
  return target;
}

export function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
