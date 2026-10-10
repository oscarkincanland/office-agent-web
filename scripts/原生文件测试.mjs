#!/usr/bin/env node
/**
 * 本机原生能力回归（macOS Finder / Windows 资源管理器）：
 *   1. 选择器脚本构造与输出解析（纯函数，不弹窗）；
 *   2. 安全约定：全程 execFile + 参数数组、不经 shell；旧的可拼接 shell 命令必须已移除；
 *   3. 路径白名单：原生打开/显示只允许工作区内的路径或刚选中的路径；
 *   4. 命令探测：对不存在的路径必须失败（不会真的打开任何东西）；
 *   5. 前端接入：文件树右键菜单、工具栏选择器入口、预览面板原生操作条。
 * 用法: node scripts/原生文件测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appleScriptString,
  buildPickFilesScript,
  buildPickFolderScript,
  buildWindowsPickFilesScript,
  buildWindowsPickFolderScript,
  isAppleScriptCancel,
  nativeCapabilities,
  normalizeExtensions,
  openWithDefaultApp,
  parseAppleScriptOutput,
  revealInFileManager,
} from "../server/原生文件.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let failed = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { console.error(`  ✗ ${msg}`); failed = 1; };
async function test(name, fn) {
  try { await fn(); ok(name); } catch (error) { bad(`${name}: ${error.message}`); }
}

console.log("\n▶ 选择器脚本构造（纯函数）");

await test("平台能力描述正确（本机为 macOS）", () => {
  const cap = nativeCapabilities();
  assert.ok(["darwin", "win32", "linux"].includes(cap.platform));
  if (process.platform === "darwin") {
    assert.equal(cap.pickerKind, "osascript");
    assert.equal(cap.fileManagerName, "Finder");
    assert.equal(cap.picker, true);
  }
  assert.equal(cap.open, true);
});

await test("扩展名归一化与 AppleScript 转义", () => {
  assert.deepEqual(normalizeExtensions(["docx", ".xlsx", "*.md", "DOCX", "", "bad/../ext"]), ["docx", "xlsx", "md"]);
  assert.equal(appleScriptString('a"b\\c'), '"a\\"b\\\\c"');
});

await test("单文件/多文件选择脚本语法正确", () => {
  const single = buildPickFilesScript({ prompt: "选择文件", multiple: false, extensions: ["docx", "xlsx"] }).join(" ");
  assert.match(single, /choose file with prompt "选择文件" of type \{"docx", "xlsx"\}/);
  assert.match(single, /return POSIX path of theChoice/);
  assert.doesNotMatch(single, /multiple selections allowed/);

  const multi = buildPickFilesScript({ prompt: "选择文件", multiple: true }).join(" ");
  assert.match(multi, /with multiple selections allowed/);
  assert.match(multi, /repeat with theFile in theChoices/);
  // 提示语中的引号必须转义，不能破坏脚本
  const quoted = buildPickFilesScript({ prompt: '选择"要"打开的文件' }).join(" ");
  assert.match(quoted, /选择\\"要\\"打开的文件/);
});

await test("文件夹选择脚本与输出解析", () => {
  assert.match(buildPickFolderScript({ prompt: "选择工作区" }).join(" "), /choose folder with prompt "选择工作区"/);
  assert.deepEqual(parseAppleScriptOutput("/a/b.docx\n/c/中文 名字.md\n\n"), ["/a/b.docx", "/c/中文 名字.md"]);
  assert.deepEqual(parseAppleScriptOutput("\uFEFF/a/b.txt\n"), ["/a/b.txt"]);
  assert.deepEqual(parseAppleScriptOutput(""), []);
});

await test("取消识别（AppleScript -128）", () => {
  assert.equal(isAppleScriptCancel({ stderr: "execution error: User canceled. (-128)" }), true);
  assert.equal(isAppleScriptCancel({ message: "Command failed", stderr: "some other error" }), false);
});

await test("Windows 脚本包含过滤器与多选开关", () => {
  const script = buildWindowsPickFilesScript({ prompt: "选择文件", multiple: true, extensions: ["docx"] });
  assert.match(script, /OpenFileDialog/);
  assert.match(script, /\*\.docx/);
  assert.match(script, /Multiselect = \$\(true\)/);
  assert.match(buildWindowsPickFolderScript({ prompt: "选目录" }), /FolderBrowserDialog/);
});

await test("Windows 对话框必须置顶显示（否则会被浏览器窗口挡住，看起来像选择文件夹失效）", () => {
  for (const [label, script] of [["文件", buildWindowsPickFilesScript({})], ["文件夹", buildWindowsPickFolderScript({})]]) {
    assert.match(script, /TopMost = \$true/, `${label}对话框应使用 TopMost owner`);
    assert.match(script, /ShowDialog\(\$owner\)/, `${label}对话框应把 owner 传给 ShowDialog`);
    assert.match(script, /\$owner\.Close\(\)/, `${label}对话框结束后应释放 owner 窗体`);
  }
});

await test("选择器可取消：重复发起会先收掉上一个对话框", () => {
  const src = read("server/原生文件.mjs");
  assert.match(src, /export function cancelActivePicker\(\)/, "应导出取消函数供接口调用");
  assert.match(src, /export function activePickerInfo\(\)/, "应导出等待状态供界面显示");
  assert.match(src, /function runPicker\(file, args, \{ timeout = PICKER_TIMEOUT_MS, kind = "" \} = \{\}\)/, "选择器走统一的可取消执行器");
  assert.match(src, /cancelActivePicker\(\);\s*\r?\n\s*return new Promise/, "新的选择请求先收掉上一个");
  assert.match(src, /entry\?\.cancelled\) return reject\(nativeError\("已取消等待系统选择器", "PICKER_CANCELLED"\)\)/, "取消要区分于失败");
  // 六个选择入口（文件/文件夹 × mac/win/linux）都必须走可取消执行器
  assert.equal((src.match(/await runPicker\(/g) || []).length, 6, "所有平台选择器都应可取消");
  // 请求被中断（关面板/离开页面）时要收掉弹窗
  const indexSrc = read("server/index.mjs");
  assert.match(indexSrc, /if \(!res\.writableEnded\) cancelActivePicker\(\);/, "客户端放弃等待时应关掉对话框");
  assert.match(indexSrc, /app\.post\("\/api\/workspace\/pick\/cancel"/, "应提供取消等待接口");
  assert.match(indexSrc, /app\.get\("\/api\/workspace\/pick\/state"/, "应提供等待状态接口");
});

await test("界面必须说明在等系统对话框，并给取消入口", () => {
  const sidebar = read("client/src/components/SessionSidebar.jsx");
  assert.match(sidebar, /picking \? "等待选择…" : "选择文件夹"/, "选择按钮要显示等待态");
  assert.match(sidebar, /已打开系统文件夹对话框：请在弹出的窗口里选择文件夹/, "要说明已打开系统对话框");
  assert.match(sidebar, /onClick=\{cancelPick\}>取消等待</, "要提供取消等待按钮");
  assert.match(sidebar, /cancelWorkspacePick/, "取消走服务端接口（真的关掉对话框）");
  assert.match(read("client/src/styles.css"), /\.workspace-pick-notice \{/, "等待提示需要样式");
});

console.log("\n▶ 安全约定");

await test("原生命令全部走 execFile + 参数数组，不经 shell", () => {
  const src = read("server/原生文件.mjs");
  assert.match(src, /import \{ execFile \} from "node:child_process"/, "应使用 execFile");
  assert.doesNotMatch(src, /require\("child_process"\)\.exec\(/, "不得使用 exec");
  assert.doesNotMatch(src, /exec\(`/, "不得用模板字符串拼命令");
  assert.doesNotMatch(src, /child_process"\)\.exec\(/, "不得使用 exec");
  // 打开/显示只接受绝对路径，绝对路径不可能被当成命令行选项
  assert.match(src, /path\.isAbsolute\(target\)/, "必须校验绝对路径");
});

await test("旧的可注入端点已移除", () => {
  const src = read("server/index.mjs");
  assert.doesNotMatch(src, /cmd = `open "\$\{fullPath\}"`/, "不得再拼接 open 命令");
  assert.doesNotMatch(src, /cmd = `explorer "\$\{fullPath\}"`/, "不得再拼接 explorer 命令");
  assert.doesNotMatch(src, /await import\("child_process"\)/, "旧实现应已整体替换");
});

await test("原生操作有路径白名单（工作区 / 文件根 / 项目 / 最近选择）", () => {
  const src = read("server/index.mjs");
  assert.match(src, /function assertNativeTargetAllowed\(/, "应有白名单校验函数");
  assert.match(src, /function nativeAllowedRoots\(\)/, "应汇总允许的根目录");
  assert.match(src, /recentNativePicks/, "应记录最近通过原生选择器选中的路径");
  assert.match(src, /listFileRoots\(\)/, "白名单应包含文件根");
  assert.match(src, /projectManager\.listProjects/, "白名单应包含项目根");
  assert.match(src, /PATH_OUTSIDE_WORKSPACE/, "越界应返回明确的错误码");
  // 端点注册
  for (const route of ['"/api/system/open"', '"/api/system/reveal"', '"/api/system/pick-files"']) {
    assert.ok(src.includes(route), `缺少端点 ${route}`);
  }
  assert.match(src, /app\.post\("\/api\/open-in-explorer", handleRevealInFileManager\)/, "旧入口应复用安全的显示实现");
  assert.match(src, /platform: process\.platform/, "/api/status 应暴露平台");
  assert.match(src, /native: nativeCapabilities\(\)/, "/api/status 应暴露原生能力");
});

await test("工作区选择器已支持 macOS（不再仅 Windows）", () => {
  const src = read("server/index.mjs");
  assert.doesNotMatch(src, /if \(process\.platform !== "win32"\) \{\s*return res\.status\(501\)\.json\(\{ error: "当前平台没有可用的原生文件夹选择器"/, "不应再仅限 Windows");
  assert.match(src, /const picked = await pickFolder\(\{ prompt: "选择 Open Plan 可写工作区" \}\)/, "应调用跨平台选择器");
});

console.log("\n▶ 命令探测（对不存在的路径必须失败，不会真的打开任何东西）");

await test("打开/显示不存在的路径应当报错", async () => {
  const missing = "/nonexistent-oaw-native-test/文件.docx";
  await assert.rejects(() => openWithDefaultApp(missing), /打开失败|does not exist|not exist|No such file/i);
  await assert.rejects(() => revealInFileManager(missing), /显示失败|does not exist|not exist|No such file/i);
});

await test("拒绝相对路径（防被当作命令行选项）", async () => {
  await assert.rejects(() => openWithDefaultApp("relative/path.docx"), /绝对路径/);
  await assert.rejects(() => revealInFileManager("-rf"), /绝对路径/);
});

console.log("\n▶ 前端接入");

await test("API 封装与图标齐备", () => {
  const api = read("client/src/api.js");
  assert.match(api, /export const pickNativeFiles = /, "应有 pickNativeFiles");
  assert.match(api, /export const openInSystem = /, "应有 openInSystem");
  assert.match(api, /export const revealInSystem = /, "应有 revealInSystem");
  assert.match(api, /"\/api\/system\/pick-files"/, "应指向原生选择器端点");
  assert.match(read("client/src/components/Icon.jsx"), /externalLink:/, "应有 externalLink 图标");
});

await test("文件树：右键菜单 + 工具栏原生选择器入口", () => {
  const src = read("client/src/components/SessionSidebar.jsx");
  assert.match(src, /label: "用系统默认应用打开"/, "右键菜单应有“用系统默认应用打开”");
  assert.match(src, /label: "在文件管理器中显示"/, "右键菜单应有“在文件管理器中显示”");
  assert.match(src, /const handlePickNativeFiles = async/, "应有原生选择器处理函数");
  assert.match(src, /section-pick-native/, "工具栏应有原生选择器按钮");
  assert.match(src, /pickNativeFiles\(\{ multiple: true/, "应支持多选");
  assert.match(src, /if \(!result\?\.ok\) \{\s*if \(!result\?\.canceled\) alert/, "用户取消应静默");
  assert.doesNotMatch(src, /handleOpenInExplorer/, "旧实现应已替换");
  assert.doesNotMatch(src, /fetch\("\/api\/open-in-explorer"/, "不应再直连旧端点");
});

await test("预览面板：原生操作条（任何格式可用）", () => {
  const src = read("client/src/components/DocViewer.jsx");
  assert.match(src, /import \{ openInSystem, revealInSystem \} from "\.\.\/api\.js"/, "应引入原生 API");
  assert.match(src, /className="doc-native-actions"/, "应有原生操作条");
  assert.match(src, /用系统应用打开/, "应有“用系统应用打开”");
  assert.match(src, /在文件管理器中显示/, "应有“在文件管理器中显示”");
  assert.match(read("client/src/styles.css"), /\.doc-native-actions/, "原生操作条应有样式");
});

console.log(failed ? "\n原生文件测试：失败" : "\n原生文件测试：通过");
process.exit(failed ? 1 : 0);
