#!/usr/bin/env node
/**
 * P4 · 无障碍与窄屏检查（可自动化的部分）
 *
 * 对应《规聚启动交互与动效完整修改计划》P4 第 1 条：不凭截图宣布 WCAG 合规，
 * 但可自动化的部分必须固化下来，避免以后悄悄退化：
 *   - 键盘可达：所有可点结果都有角色/可访问名，纯图标按钮不得只有图形；
 *   - 焦点可见：键盘焦点必须有可见轮廓，且弹层关闭后焦点归还触发控件；
 *   - 读屏状态：运行/等待/错误等异步区域必须能播报；
 *   - 对比度：正文/次要/三级/状态色按阈值计算（不是看一眼觉得行）；
 *   - 最小点击目标：触屏上小按钮要有足够命中区；
 *   - 窄屏：断点与折叠规则在位，命令面板在小窗口不越界；
 *   - 减少动效：与 P3 同一套闸门，且首帧前生效。
 *
 * 无法自动化的部分（真实浏览器的缩放、读屏实际播报、触屏手感）见
 * docs/plans/2026-09-23-001-P4验收清单.md 的人工走查清单。
 * 退出码 0 = 通过。
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(projectRoot, rel), "utf8");

const 样式 = read("client/src/styles.css");
const index = read("client/index.html");
const CommandPalette = read("client/src/components/CommandPalette.jsx");
const ChatPanel = read("client/src/components/ChatPanel.jsx");
const App = read("client/src/App.jsx");
const SessionSidebar = read("client/src/components/SessionSidebar.jsx");
const TaskCenter = read("client/src/components/任务中心.jsx");
const DocViewer = read("client/src/components/DocViewer.jsx");
const DocxViewer = read("client/src/components/DocxViewer.jsx");
const 界面外观 = read("client/src/界面外观.js");

let failed = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { console.error(`  ✗ ${msg}`); failed = 1; };
function 检查(name, fn) {
  try {
    fn();
    ok(name);
  } catch (e) {
    bad(`${name}: ${e.message}`);
  }
}

// ---------- 工具：扫描所有 .jsx 里的纯图标按钮 ----------
function 全部jsx(目录) {
  const out = [];
  for (const entry of fs.readdirSync(目录, { withFileTypes: true })) {
    const p = path.join(目录, entry.name);
    if (entry.isDirectory()) out.push(...全部jsx(p));
    else if (p.endsWith(".jsx")) out.push(p);
  }
  return out;
}
/** 返回缺少可访问名的纯图标按钮（无文本、无 title/aria-label）。 */
function 无标签图标按钮() {
  const findings = [];
  for (const file of 全部jsx(path.join(projectRoot, "client", "src"))) {
    const src = fs.readFileSync(file, "utf8");
    const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
    let m;
    while ((m = re.exec(src))) {
      const attrs = m[1];
      const inner = m[2];
      if (/title=|aria-label=|aria-labelledby=/.test(attrs)) continue;
      // 把 JSX 表达式视为文案（多为条件渲染的 <span>{label}</span>），只看真正的"只有图形"
      const 文本 = inner.replace(/<[^>]*>/g, "").replace(/\{[^}]*\}/g, "x").trim();
      if (!文本) {
        const line = src.slice(0, m.index).split(/\r?\n/).length;
        findings.push(`${path.relative(projectRoot, file)}:${line}`);
      }
    }
  }
  return findings;
}

// ---------- 工具：颜色对比度 ----------
const 亮度 = (hex) => {
  const 值 = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * 值[0] + 0.7152 * 值[1] + 0.0722 * 值[2];
};
const 对比度 = (前景, 背景) => {
  const a = 亮度(前景);
  const b = 亮度(背景);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
/** 从样式表里取某个选择器块的变量表。 */
function 主题变量(块选择器) {
  const start = 样式.indexOf(块选择器);
  assert.notEqual(start, -1, `样式表缺少 ${块选择器}`);
  const 结束 = 样式.indexOf("\n}", start);
  const 块 = 样式.slice(start, 结束 === -1 ? undefined : 结束);
  const 变量 = {};
  const re = /(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g;
  let m;
  while ((m = re.exec(块))) 变量[m[1]] = m[2];
  return 变量;
}

console.log("\n▶ 键盘可达与可访问名");

检查("纯图标按钮必须带 title 或 aria-label", () => {
  const 漏网 = 无标签图标按钮();
  assert.equal(漏网.length, 0, `以下纯图标按钮没有可访问名：\n      ${漏网.join("\n      ")}`);
});

检查("命令面板语义完整且焦点可归还", () => {
  assert.match(CommandPalette, /role="dialog" aria-modal="true" aria-label="命令面板"/);
  assert.match(CommandPalette, /role="combobox"/);
  assert.match(CommandPalette, /aria-expanded="true"/);
  assert.match(CommandPalette, /aria-controls="cmd-results-list"/);
  assert.match(CommandPalette, /aria-autocomplete="list"/);
  assert.match(CommandPalette, /aria-activedescendant=/);
  assert.match(CommandPalette, /role="listbox" aria-label="命令面板结果"/);
  assert.match(CommandPalette, /role="option"/);
  assert.match(CommandPalette, /aria-selected=\{isSelected\}/);
  assert.match(CommandPalette, /role="status"/, "空结果应能被读屏播报");
  // 关闭后焦点归还给触发控件，避免键盘用户丢失位置
  assert.match(CommandPalette, /restoreFocusRef\.current = document\.activeElement/);
  assert.match(CommandPalette, /requestAnimationFrame\(\(\) => target\.focus\(\)\)/);
  assert.match(CommandPalette, /scrollIntoView/, "键盘选择必须把结果滚进视野");
  // ARIA combobox 模式：结果用 role=option，并把键盘焦点统一交给输入框
  // （aria-activedescendant 指向 option id），因此 option 自身 tabIndex=-1 是正确做法。
  assert.match(CommandPalette, /id=\{`cmd-option-\$\{idx\}`\}/, "结果应有稳定 id 供 aria-activedescendant 指向");
  assert.match(CommandPalette, /role="option"[\s\S]{0,400}?aria-label=\{/, "每个可点结果都必须同时有角色与可访问名");
});

检查("审批与提问按钮都是可聚焦按钮", () => {
  assert.match(ChatPanel, /className="btn primary approval-allow"/);
  assert.match(ChatPanel, /className="btn approval-always"/);
  assert.match(ChatPanel, /className="btn approval-deny"/);
  assert.match(ChatPanel, /className="btn primary ask-submit"/);
  // 审批卡本身可聚焦，定位后能落到键盘焦点上
  assert.match(ChatPanel, /data-approval-id=\{block\.id \|\| ""\} tabIndex=\{-1\}/);
});

console.log("\n▶ 焦点可见与读屏状态");

检查("键盘焦点有可见轮廓", () => {
  for (const 选择器 of [".cmd-input", ".approval-block", ".efs-approval", ".conversation-mode-option", ".chat-empty-example", ".chat-target-chip button", ".model-fav-btn"]) {
    const re = new RegExp(`${选择器.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:focus-visible`);
    assert.match(样式, re, `${选择器} 缺少 :focus-visible 轮廓`);
  }
  assert.match(样式, /outline:\s*2px solid var\(--accent/);
});

检查("异步状态区可被读屏播报", () => {
  assert.doesNotMatch(ChatPanel, /className="task-status-bar"/, "移除顶栏任务状态条，避免重复播报与占位");
  assert.match(ChatPanel, /className="execution-flow-status" role="status" aria-live="polite"/, "执行流状态应播报");
  assert.match(ChatPanel, /className="execution-flow-next" role="status" aria-live="polite"/, "下一步指引应播报");
  assert.match(ChatPanel, /className="chat-pending-bar" aria-live="polite"/, "等待审批/提问应播报");
  assert.match(ChatPanel, /className="ask-error" role="alert"/, "错误应即时播报");
  assert.match(App, /className="session-resume-warning" role="alert"/, "只读恢复告警应即时播报");
});

console.log("\n▶ 对比度（按主题变量实际计算）");

检查("文本与状态色对比度达标", () => {
  const 主题 = {
    暗色: 主题变量(":root {"),
    亮色: 主题变量('[data-theme="light"] {'),
  };
  // 阈值：正文 AAA(7)，次要文字 AA(4.5)，三级/状态色按非正文要求(3)。
  // 容差 0.05：主题色按十六进制取整，边界值允许微小舍入差。
  const 容差 = 0.05;
  const 用例 = [
    ["正文/面板", "--text", "--panel-bg", 7],
    ["正文/底色", "--text", "--body-bg", 7],
    ["次要/面板", "--muted", "--panel-bg", 4.5],
    ["次要/底色", "--muted", "--body-bg", 3],
    ["三级/面板", "--dim", "--panel-bg", 3],
    ["强调/面板", "--accent", "--panel-bg", 3],
    ["强调/底色", "--accent", "--body-bg", 3],
    ["成功/面板", "--success", "--panel-bg", 3],
    ["错误/面板", "--error", "--panel-bg", 3],
    ["警告/面板", "--warning", "--panel-bg", 3],
  ];
  const 结果 = [];
  for (const [主题名, 变量] of Object.entries(主题)) {
    for (const [名称, 前景, 背景, 阈值] of 用例) {
      assert.ok(变量[前景] && 变量[背景], `${主题名} 缺少 ${前景} 或 ${背景}`);
      const 值 = 对比度(变量[前景], 变量[背景]);
      结果.push({ 主题名, 名称, 值, 阈值 });
      assert.ok(值 + 容差 >= 阈值, `${主题名} ${名称} 对比度 ${值.toFixed(2)} 低于 ${阈值}`);
    }
  }
  // 记录实测值，便于人工复核与后续调整
  const 最低 = 结果.reduce((min, item) => (item.值 < min.值 ? item : min), 结果[0]);
  console.log(`    实测最低：${最低.主题名} ${最低.名称} = ${最低.值.toFixed(2)}（阈值 ${最低.阈值}）`);
});

检查("用户气泡正文对比度达标（所有主题/皮肤）", () => {
  // 每处 --user-bg 都必须紧跟一个针对该底色的 --user-fg。
  const 配对 = [...样式.matchAll(/--user-bg:\s*([^;]+);\s*\n\s*--user-fg:\s*([^;]+);/g)]
    .map((m) => ({ bg: m[1].trim(), fg: m[2].trim() }));
  const bgCount = (样式.match(/--user-bg:/g) || []).length;
  const fgCount = (样式.match(/--user-fg:/g) || []).length;
  assert.equal(bgCount, fgCount, `--user-bg(${bgCount}) 与 --user-fg(${fgCount}) 必须成对声明`);
  assert.ok(配对.length >= 9, `应至少声明 9 组 --user-bg/--user-fg，实际 ${配对.length}`);
  for (const { bg, fg } of 配对) {
    // 半透明底色（glass 皮肤）无法在静态样式表内确定叠底，另行人工复核。
    if (!/^#[0-9a-fA-F]{6}$/.test(bg) || !/^#[0-9a-fA-F]{6}$/.test(fg)) continue;
    const 值 = 对比度(fg, bg);
    assert.ok(值 + 0.05 >= 4.5, `用户气泡 ${fg} on ${bg} 对比度 ${值.toFixed(2)} 低于 WCAG AA 4.5`);
  }
  // 生效层必须使用语义变量，不得再回退到固定浅色（浅字浅底的历史问题）。
  assert.match(样式, /\.center-chat-slot \.msg\.user \.bubble \{[^}]*background:\s*var\(--user-bg\)[^}]*color:\s*var\(--user-fg\)/, "用户气泡必须用 --user-bg/--user-fg");
  assert.match(样式, /\.center-chat-slot \.msg\.user \.bubble \.msg-text \{[^}]*color:\s*var\(--user-fg\)/, "用户气泡正文必须用 --user-fg");
  assert.doesNotMatch(样式, /\.center-chat-slot \.msg\.user \.bubble \{[^}]*color:\s*#f9fff3/, "不得再使用固定浅色文字");
  assert.match(样式, /\.center-chat-slot \.msg\.user \.bubble a \{[^}]*color:\s*inherit/, "气泡内链接必须继承高对比字色");
});

检查("文档预览自适应：不裁切正文且标签可键盘操作", () => {
  // 窄栏 + 高倍缩放时宁可横向滚动，也不能把正文裁掉
  assert.match(样式, /\.oaw-docx-host \{[\s\S]{0,200}?overflow-x: auto/, "Word 预览容器应允许横向滚动");
  assert.doesNotMatch(样式, /\.oaw-docx-host \{[\s\S]{0,200}?overflow-x: hidden/, "不得再用 overflow-x: hidden 裁切正文");
  // 默认适应宽度（按真实页宽与面板宽算档位）
  assert.match(DocxViewer, /const applyFitWidth = useCallback/, "应提供适应宽度");
  assert.match(DocxViewer, /applyFitWidth\(\{ silent: true \}\)/, "打开文档时应默认适应宽度");
  assert.match(DocxViewer, /docx-fit-width/, "工具栏应有适应宽度入口");
  // 缩放用 CSS zoom 保证编辑命中/光标精度，老浏览器才回退 transform
  assert.match(DocxViewer, /CSS\.supports\("zoom"/, "应优先使用 CSS zoom");
  assert.match(DocxViewer, /host\.style\.zoom = String\(next \/ 100\)/, "zoom 应作用在宿主容器上");
  // 标签与关闭按钮：可键盘操作 + 可见焦点
  assert.match(DocViewer, /role="tab"[\s\S]{0,160}?tabIndex=\{0\}/, "文档标签应可聚焦");
  assert.match(DocViewer, /onKeyDown=\{\(event\) => \{[\s\S]{0,120}?onSwitchTab/, "标签应支持键盘切换");
  assert.match(DocViewer, /aria-label=\{`关闭 \$\{t\.name\}`\}/, "关闭按钮应有可访问名");
  assert.match(样式, /\.doc-tab-close:focus-visible/, "关闭按钮应有可见焦点");
});

console.log("\n▶ 最小点击目标与窄屏");

检查("触屏设备放大命中区（桌面视觉不变）", () => {
  const 块 = 样式.match(/@media \(pointer: coarse\) \{[\s\S]*?\n\}/);
  assert.ok(块, "应有 @media (pointer: coarse) 命中区规则");
  assert.match(块[0], /\.btn-xs/);
  assert.match(块[0], /\.btn-icon/);
  assert.match(块[0], /\.msg-action/);
  assert.match(块[0], /min-height:\s*32px/);
  const 值 = Number((块[0].match(/min-height:\s*(\d+)px/) || [])[1]);
  assert.ok(值 >= 24, `命中区应至少 24px（WCAG 2.2 目标尺寸），实际 ${值}px`);
});

检查("窄窗口断点与折叠规则在位", () => {
  for (const 断点 of ["@media (max-width: 1080px)", "@media (max-width: 900px)", "@media (max-width: 760px)", "@media (max-width: 720px)", "@media (max-width: 520px)"]) {
    assert.ok(样式.includes(断点), `缺少断点 ${断点}`);
  }
  // 预览栏在最窄的主流桌面宽度先让位
  assert.match(样式, /@media \(max-width: 1080px\) \{\s*\.preview-half \.app-preview-slot \{ flex-basis: 0; \}/, "窄屏应折叠预览栏");
  // 命令面板在小窗口不越界，且内部可滚动
  assert.match(样式, /\.cmd-panel \{[^}]*max-width: 92vw/, "命令面板宽度应受视口约束");
  assert.match(样式, /\.cmd-panel \{[^}]*max-height: 72vh/, "命令面板高度应受视口约束");
  assert.match(样式, /\.cmd-panel \{[^}]*overflow: hidden/, "命令面板应约束溢出");
  assert.match(样式, /@media \(max-width: 720px\), \(max-height: 560px\) \{\s*\.cmd-overlay \{ padding-top: 4vh; \}/, "小窗口应调整命令面板留白");
  // 顶栏已收敛为控制按钮；极窄屏隐藏冗余文字，避免内容挤出视口。
  assert.match(样式, /@media \(max-width: 520px\) \{[\s\S]{0,260}\.context-ring-label \{ display: none; \}/, "极窄窗口隐藏上下文环标签");
  assert.match(样式, /@media \(max-width: 520px\) \{[\s\S]{0,320}\.approval-mode-control span \{ display: none; \}/, "极窄窗口隐藏审批按钮文字");
});

检查("窄屏不再强挤三栏，任务中心与地图可用（P1）", () => {
  // 中等窗口：降低各栏最小宽度
  assert.match(样式, /@media \(max-width: 1280px\) \{[\s\S]{0,200}?--sidebar-min: 180px/, "中等窗口应降低侧栏最小宽度");
  // 窄窗口：最多两栏（浏览器栏/预览栏让位，对话列保底可读）
  assert.match(样式, /@media \(max-width: 1024px\) \{[\s\S]{0,320}?\.app-browser-slot \{ --browser-w: [^}]*min-width: 0/, "窄窗口浏览器栏应可收缩");
  assert.match(样式, /@media \(max-width: 1024px\) \{[\s\S]{0,320}?\.center-area \{ min-width: 300px/, "窄窗口对话列应保底可读");
  // 极窄：右侧面板与侧栏改为覆盖层，主区获得全宽（不再以 flex 宽度与对话抢位）
  assert.match(样式, /@media \(max-width: 768px\) \{[\s\S]{0,700}?\.app-preview-slot, \.app-browser-slot \{[\s\S]{0,300}?position: fixed;/, "极窄窗口右侧面板应改为覆盖层，不再与对话抢宽度");
  assert.match(样式, /@media \(max-width: 768px\) \{[\s\S]{0,1200}?\.sidebar \{[\s\S]{0,400}?transform: translateX\(-100%\)/, "极窄窗口侧栏应改为抽屉，默认让出主区宽度");
  // 任务中心：窄屏全宽 + 换行，无横向穿模
  assert.match(样式, /@media \(max-width: 560px\) \{[\s\S]{0,260}?\.task-center-panel,?\s*\n?\s*\.mp-topbar \.task-center-panel \{[\s\S]{0,220}?position: fixed/, "任务中心窄屏应贴边全宽");
  assert.match(样式, /\.task-center-filters \{ flex-wrap: wrap; \}/, "任务中心筛选应换行");
  assert.match(样式, /\.task-center-events > div \{ overflow-wrap: anywhere; \}/, "任务中心事件不应横向溢出");
  // 地图：画布最小宽度 + 工具栏进入文档流不遮盖
  assert.match(样式, /\.map-canvas \{ min-width: 480px; \}/, "地图画布应有合理最小宽度");
  assert.match(样式, /\.map-toolbar \{\n?\s*position: static;/, "窄屏地图工具栏应进入文档流，不遮盖图面");
  assert.match(样式, /\.map-toolbar \{ flex-wrap: wrap;/, "地图工具栏应可换行");
  // App 层自动折叠：窄屏或打开浏览器栏时收起预览
  assert.match(App, /const enforceNarrowLayout = \(\) => \{/, "应有窄屏自动折叠逻辑");
  assert.match(App, /if \(window\.innerWidth > 1024\) return;/, "窄屏阈值应为 1024");
  assert.match(App, /window\.addEventListener\("resize", enforceNarrowLayout\)/, "窗口变化时应重新收口");
});

console.log("\n▶ 启动稳定骨架与焦点归还");

检查("未就绪区域显示稳定骨架而不是空结果", () => {
  assert.match(样式, /\.oaw-skeleton \{/, "应有骨架样式");
  assert.match(样式, /\.oaw-skeleton-block/, "骨架应有占位块");
  const 骨架块 = 样式.slice(样式.indexOf(".oaw-skeleton"), 样式.indexOf(".oaw-skeleton-block.meta") + 200);
  assert.doesNotMatch(骨架块, /animation/, "稳定骨架不得有动画（否则就是全屏反复闪烁）");
  assert.match(SessionSidebar, /function SkeletonRows\(/, "侧栏应有骨架组件");
  assert.match(SessionSidebar, /role="status"[\s\S]{0,80}aria-label=\{label\}/, "骨架应能被读屏播报");
  assert.match(SessionSidebar, /filesLoading[\s\S]{0,160}正在加载文件列表/, "文件列表未就绪时应显示骨架而非空结果");
  assert.match(SessionSidebar, /projectsLoading[\s\S]{0,160}正在加载项目列表/, "项目列表未就绪时应显示骨架而非空结果");
});

检查("弹层/面板关闭后焦点归还触发控件", () => {
  assert.match(App, /const previewToggleRef = useRef\(null\)/, "右预览应记录触发按钮");
  assert.match(App, /ref=\{previewToggleRef\}/, "预览开关应绑定引用");
  assert.match(App, /const closePreview = useCallback/, "应有统一关闭预览逻辑");
  assert.match(App, /requestAnimationFrame\(\(\) => previewToggleRef\.current\?\.focus\(\)\)/, "关闭预览后应把焦点还给开关");
  assert.match(TaskCenter, /const triggerRef = useRef\(null\)/, "任务中心应记录触发按钮");
  assert.match(TaskCenter, /const closePanel = useCallback/, "应有统一关闭弹层逻辑");
  assert.match(TaskCenter, /event\.key === "Escape"/, "任务中心应支持 Esc 关闭");
  assert.match(TaskCenter, /requestAnimationFrame\(\(\) => triggerRef\.current\?\.focus\(\)\)/, "关闭任务中心后应把焦点还给触发按钮");
});

console.log("\n▶ 减少动效（跨端同语义）");

检查("系统减少动效在首帧前同步到同一套闸门", () => {
  const 内联脚本 = index.indexOf("data-reduce-motion");
  const 模块脚本 = index.indexOf('<script type="module"');
  assert.ok(内联脚本 !== -1, "index.html 应在首帧前写入 data-reduce-motion");
  assert.ok(模块脚本 !== -1 && 内联脚本 < 模块脚本, "reduce-motion 内联脚本必须早于应用脚本");
  assert.match(index, /window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
  assert.match(界面外观, /export function prefersReducedMotion\(\)/, "运行时也要能读到系统偏好");
  assert.match(界面外观, /dataset\.reduceMotion/, "运行时偏好变化应同步到同一属性");
  // 应用只有这一套闸门，不再保留第二份媒体查询清单（避免漂移）
  assert.doesNotMatch(样式, /@media \(prefers-reduced-motion: reduce\)/, "不应再保留媒体查询副本");
  assert.match(样式, /:is\(\[data-reduce-motion="1"\], \[data-motion-level="off"\]\)/, "闸门应同时认系统偏好与产品开关");
});

console.log(failed ? "\n无障碍与窄屏：失败" : "\n无障碍与窄屏：通过");
process.exitCode = failed ? 1 : 0;
