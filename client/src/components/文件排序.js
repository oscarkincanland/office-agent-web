/**
 * 文件树排序（时间 / 类型）。
 * 目录始终排在文件前面；时间=按修改时间倒序，类型=按扩展名分组（同组按名称）。
 * 目录通常没有 mtime，此时退回按名称排序，避免出现"看起来没反应"的排序。
 */

function timeOf(file) {
  const value = Date.parse(file?.mtime || 0);
  return Number.isFinite(value) ? value : 0;
}

function nameOf(file) {
  return String(file?.name || "");
}

function byName(a, b) {
  return nameOf(a).localeCompare(nameOf(b), "zh-Hans-CN");
}

export function sortFiles(list, mode = "time") {
  const items = Array.isArray(list) ? [...list] : [];
  const dirs = items.filter((item) => item?.isDir);
  const files = items.filter((item) => !item?.isDir);
  if (mode === "type") {
    dirs.sort((a, b) => byName(a, b) || timeOf(b) - timeOf(a));
    files.sort((a, b) => {
      const extA = String(a.ext || "").toLowerCase() || "zzzz";
      const extB = String(b.ext || "").toLowerCase() || "zzzz";
      return extA.localeCompare(extB) || byName(a, b);
    });
  } else {
    dirs.sort((a, b) => timeOf(b) - timeOf(a) || byName(a, b));
    files.sort((a, b) => timeOf(b) - timeOf(a) || byName(a, b));
  }
  return [...dirs, ...files];
}
