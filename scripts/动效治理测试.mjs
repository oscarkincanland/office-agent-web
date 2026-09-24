#!/usr/bin/env node
/**
 * 动效治理回归（P3）：
 * 1. 跑马灯：滚动层与灯效层分离，修复"流光/霓虹覆盖滚动导致长名字不滚动"；
 *    短名/长名、6 种样式、3 个动效档、系统减少动效的组合都有静态回退。
 * 2. 尺寸稳定性：测量用独立隐藏元素，字体晚到/侧栏开合/面板动画期间补算。
 * 3. 统一动效闸门：系统 prefers-reduced-motion 与产品"关闭动效"覆盖
 *    全局旋转、blink/pulse、扫描线、流式揭示、弹层入场；不误杀地图模块过渡。
 * 4. 一次性反馈：发送/阶段/审批/结果/面板都由真实状态驱动，可中断、不阻塞。
 * 5. 快速连续事件/断线重连/历史回放：立即落定、不重播旧动画。
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const 存在 = (rel) => fs.existsSync(new URL(rel, import.meta.url));
const 样式 = read("../client/src/styles.css");
const 对话面板 = read("../client/src/components/ChatPanel.jsx");
const 跑马灯 = read("../client/src/components/跑马灯文本.jsx");
const 界面外观 = read("../client/src/界面外观.js");
const 入口页 = read("../client/index.html");

// ============================ 1. 跑马灯：层次分离 ============================
// 组件必须渲染两个层次：滚动层（.marquee-inner）+ 灯效层（.marquee-text）
assert.match(
  跑马灯,
  /<span className="marquee-inner">\s*<span className="marquee-text">\{content\}<\/span>\s*<\/span>/,
  "跑马灯应把滚动层与灯效层拆成两个元素",
);
// 滚动动画只能写在滚动层，灯效不能再写在与滚动同一个元素上（旧 bug 根因）
assert.match(
  样式,
  /\.marquee\.is-scrolling \.marquee-inner \{[^}]*animation: marquee-scroll/,
  "滚动动画应写在滚动层 .marquee-inner",
);
assert.doesNotMatch(
  样式,
  /\[data-marquee-style="[a-z]+"\] \.marquee\.is-active \.marquee-inner \{/,
  "灯效不得再写在与滚动动画同一个元素上（否则会覆盖滚动）",
);
// 滚动时灯效层必须解除省略号，否则长名字只滚出省略号
assert.match(
  样式,
  /\.marquee\.is-scrolling \.marquee-text \{[^}]*width: max-content/,
  "滚动时灯效层应放开宽度限制",
);
assert.match(样式, /\.marquee-text \{[\s\S]*?text-overflow: ellipsis/, "短名字应静态省略号显示");
assert.match(样式, /\.marquee \{[\s\S]*?overflow: hidden/, "跑马灯容器负责裁剪");

// 组合测试矩阵：6 种样式 × 动效档，逐一确认灯效宿主与档位处理都在
const 样式档 = ["shine", "neon", "rainbow", "terminal", "stripe", "static"];
for (const 样式名 of 样式档) {
  const 有灯效层 = 样式.includes(`[data-marquee-style="${样式名}"] .marquee.is-active .marquee-text`);
  const 有遮罩层 = 样式.includes(`[data-marquee-style="${样式名}"] .marquee.is-active::after`);
  assert.ok(有灯效层 || 有遮罩层, `样式 ${样式名} 应有明确的灯效宿主`);
}
// "克制"档：只关灯效，不能连滚动一起关掉
const 克制段 = 样式.slice(样式.indexOf('[data-motion-level="calm"] [data-marquee-style="terminal"]'), 样式.indexOf(".session-label-text"));
assert.ok(克制段.length > 0, "应有跑马灯克制档规则");
for (const 样式名 of ["terminal", "stripe"]) {
  assert.match(克制段, new RegExp(`\\[data-marquee-style="${样式名}"\\] \\.marquee\\.is-active::after`), `克制档应关掉 ${样式名} 的扫描/条纹`);
}
assert.match(克制段, /\[data-marquee-style="neon"\] \.marquee\.is-active \.marquee-text \{[\s\S]*?animation: none/, "克制档应把霓虹呼吸落定为静态描边");
assert.doesNotMatch(克制段, /\.marquee-inner \{[^}]*animation: none/, "克制档不得关掉滚动");

// 尺寸稳定性：独立测量元素 + 字体晚到 + 侧栏开合 + 面板动画期间补算
assert.match(跑马灯, /probe\.scrollWidth - wrap\.clientWidth/, "测量应读独立隐藏元素的 scrollWidth");
assert.match(跑马灯, /const scrolling = active && animate && marqueeStyle !== "static" && overflow > 4/, "只有真溢出才滚动");
assert.match(跑马灯, /document\.fonts\?\.ready\?\.then/, "字体晚到应重算尺寸");
assert.match(跑马灯, /new ResizeObserver\(measure\)/, "容器宽度变化（侧栏收起/展开）应重算");
assert.match(跑马灯, /\[120, 400, 1200\]\.map\(\(delay\) => window\.setTimeout\(measure, delay\)\)/, "面板开合动画期间应补算几次");
assert.match(跑马灯, /title=\{title \?\? content\}/, "关闭/减少动效时必须有完整 title 作为静态回退");
assert.match(跑马灯, /const reduceMotion = useReducedMotion\(\)/, "应复用统一系统偏好 hook");
assert.doesNotMatch(跑马灯, /window\.matchMedia/, "不应各自维护一份 matchMedia 监听");

// ============================ 2. 统一动效闸门 ============================
assert.match(入口页, /prefers-reduced-motion: reduce/, "index.html 应在首帧前读取系统减少动效偏好");
assert.match(入口页, /dataset\.reduceMotion = reduceQuery\.matches \? "1" : ""/, "首帧前应把系统偏好写到 <html data-reduce-motion>");
for (const 名称 of ["prefersReducedMotion", "isMotionReduced", "motionScrollBehavior", "useReducedMotion", "useMotionGate"]) {
  assert.match(界面外观, new RegExp(`export function ${名称}`), `界面外观应导出 ${名称}`);
}
assert.match(界面外观, /root\.dataset\.reduceMotion = prefersReducedMotion\(\) \? "1" : ""/, "applyAppearance 也应兜底同步系统偏好");

const 闸门标记 = "P3 · 统一动效闸门与一次性反馈";
const 闸门起点 = 样式.indexOf(闸门标记);
assert.ok(闸门起点 > 0, "样式表应包含 P3 统一动效闸门");
const 闸门块 = 样式.slice(闸门起点);
assert.ok(
  样式.indexOf(".marquee.is-scrolling .marquee-inner") < 闸门起点,
  "闸门必须排在所有动画定义之后，才能靠层叠覆盖它们",
);
assert.match(闸门块, /animation: none !important/, "关闭持续动画必须用 !important 压过局部样式");

// 闸门只认两个属性：系统减少动效 与 产品关闭动效（单份清单，避免两处漂移）
assert.match(闸门块, /:is\(\[data-reduce-motion="1"\], \[data-motion-level="off"\]\)/, "闸门应同时覆盖系统偏好与产品开关");

// 持续动画清单：从样式表推导，防止新增无限动画时漏进闸门
const 全部关键帧 = [...样式.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
const 动画声明 = [...样式.matchAll(/animation\s*:[^;{}]*/g)].map((m) => m[0]);
const 无限动画 = new Set();
for (const 名称 of 全部关键帧) {
  const 命中 = new RegExp(`(^|[\\s,])${名称}(?=[\\s,])`);
  if (动画声明.some((d) => /infinite/.test(d) && 命中.test(d.replace(/^animation\s*:/, " ")))) 无限动画.add(名称);
}
const 期望持续动画 = [
  "blink", "brain-pulse", "dot-breathe", "dot-breathe-soft", "ldot-bounce",
  "marquee-neon", "marquee-scroll", "marquee-scan", "marquee-shine", "marquee-stripe",
  "mp-spin", "pulse", "pulse-status", "pulse-status-soft", "session-pulse", "spin",
];
assert.deepEqual(
  [...无限动画].sort(),
  [...期望持续动画].sort(),
  "持续动画清单发生变化：新增无限动画时必须同时加进统一闸门与 scripts/动效治理测试.mjs",
);

// 每个持续动画的宿主选择器都必须在闸门清单里
const 持续动画宿主 = {
  spin: [".loading-spinner"],
  blink: [".typing", ".run-summary-dot.running"],
  "dot-breathe": [".streaming-dot"],
  "dot-breathe-soft": [".efp-pulse", ".streaming-dot"],
  "ldot-bounce": [".ldot"],
  pulse: [".tool-icon.run", ".todo-item.running .todo-num"],
  "brain-pulse": [".brain-core.running .brain-core-dot", ".browser-status.loading i"],
  "pulse-status": [".conversation-status.working i", ".browser-connection.offline i", ".execution-flow-live i"],
  "pulse-status-soft": [".execution-flow-live i"],
  "session-pulse": [".session-item .session-indicator", ".project-session-open > i"],
  "marquee-scroll": [".marquee-inner"],
  "marquee-shine": [".marquee-text"],
  "marquee-neon": [".marquee-text"],
  "marquee-scan": [".marquee.is-active::after"],
  "marquee-stripe": [".marquee.is-active::after"],
  "mp-spin": [".mp-spin"],
};
const 宿主清单 = new Set();
for (const 宿主们 of Object.values(持续动画宿主)) for (const 宿主 of 宿主们) 宿主清单.add(宿主);
for (const 宿主 of 宿主清单) {
  assert.ok(闸门块.includes(宿主), `闸门清单缺少持续动画宿主：${宿主}`);
  assert.ok(样式.slice(0, 闸门起点).includes(宿主), `闸门清单里的 ${宿主} 在样式表里找不到定义（可能是过期条目）`);
}
// 装饰性入场也要纳入闸门
for (const 宿主 of [".comment-anchor-badge", ".oa-anno-toolbar", ".comment-highlight", ".comment-highlight-active", ".ct-pop", ".cmd-panel", ".composer-suggestions", ".task-center-panel", ".run-result", ".run-artifact-row.fresh"]) {
  assert.ok(闸门块.includes(宿主), `闸门清单缺少装饰性入场宿主：${宿主}`);
}
// 跑马灯静态回退：去掉渐变文字与描边，保留状态色标
assert.match(闸门块, /background-image: none !important/, "闸门应移除跑马灯渐变文字");
assert.match(闸门块, /-webkit-text-fill-color: currentColor !important/, "闸门应让文字回到当前颜色，不能透明");
assert.match(闸门块, /\.marquee\.is-active::after \{\s*animation: none !important;\s*display: none;/, "闸门应关掉跑马灯扫描/条纹遮罩");
// 滚动与压感反馈立即落定
assert.match(闸门块, /\.chat-body \{ scroll-behavior: auto; \}/, "闸门应取消平滑滚动");
assert.match(闸门块, /:active \{\s*transform: none !important;/, "闸门应取消按钮按压缩放");
// 不误杀地图/浏览器模块的交互过渡
assert.doesNotMatch(闸门块, /leaflet|maplibregl|\.map-[a-z]/i, "闸门不得包含地图库/地图模块选择器");

// 闸门之后不允许再出现未纳管的持续动画
const 闸门内动画 = [...闸门块.matchAll(/animation\s*:\s*([^;{}]+)/g)].map((m) => m[1].trim());
for (const 值 of 闸门内动画) {
  assert.ok(
    /^none\b/.test(值) || /^oaw-(pop-in|result-in|file-flash)\b/.test(值),
    `闸门块里出现了未纳管的动画声明：${值}`,
  );
}
const 闸门内关键帧 = [...闸门块.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
for (const 名称 of 闸门内关键帧) {
  assert.ok(["oaw-pop-in", "oaw-result-in", "oaw-file-flash"].includes(名称), `闸门块里的关键帧应只是一次性反馈：${名称}`);
}

// ============================ 3. 一次性反馈 ============================
// 阶段/状态切换只过渡颜色，不做位移
assert.match(闸门块, /\.efp-phase, \.execution-flow-live, \.run-summary-dot, \.task-status-dot \{\s*transition: color 180ms/, "阶段/状态切换应有颜色过渡");
// 弹层：短位移 + 透明度，仅入场一次
assert.match(样式, /@keyframes oaw-pop-in \{[\s\S]*?translateY\(4px\)/, "弹层入场应使用短位移 + 透明度");
assert.match(闸门块, /\.ct-pop,\s*\.cmd-panel,\s*\.composer-suggestions,\s*\.task-center-panel:not\(\.task-center-page-panel\) \{ animation: oaw-pop-in/, "主要弹层/面板共用一次性入场");
// 结果卡一次性淡入（不用庆祝动画）
assert.match(样式, /@keyframes oaw-result-in/, "结果卡应一次性淡入");
assert.doesNotMatch(样式, /@keyframes\s+(confetti|fireworks|celebrate)/i, "不应出现庆祝类动画");
// 文件改动短时高亮，且只在"本轮刚结束"时触发
assert.match(闸门块, /@keyframes oaw-file-flash/, "被改文件应有短时高亮");
assert.match(闸门块, /\.run-artifact-row\.fresh:nth-child\(n\+7\) \{ animation: none; \}/, "长产物列表不应整屏闪动");
assert.match(对话面板, /flashFiles: data\.fresh === true \|\| previous\?\.flashFiles === true/, "只有本轮刚结束才标记文件高亮");
assert.match(对话面板, /fresh: Boolean\(data\.runId\) && data\.runId === knownRunId/, "run_finished 只在当前活跃 run 上标记 fresh");
assert.match(对话面板, /className=\{m\.flashFiles \? "run-artifact-row fresh" : "run-artifact-row"\}/, "结果卡按 fresh 标记文件行");

// ============================ 4. 立即落定（连续事件/重连/回放） ============================
// 流式揭示：闸门命中时一帧落定，不逐字重打
assert.match(对话面板, /instant: isMotionReduced\(\)/, "文本揭示应读取统一闸门");
assert.match(对话面板, /if \(!active\.instant && elapsedMs < 32 && active\.pending\.length < 24\)/, "闸门命中时应跳过节流");
assert.match(对话面板, /reducedMotion: active\.instant === true/, "闸门命中时应一次揭示完剩余文本");
assert.doesNotMatch(对话面板, /const reducedMotion = typeof window !== "undefined" && window\.matchMedia/, "不应每帧重新读 matchMedia");
assert.match(对话面板, /state\.instant = isMotionReduced\(\)/, "补齐权威全文时应刷新闸门标记");
// 所有程序化滚动都走统一行为，减少动效时立即落定
for (const 文件 of ["../client/src/components/ChatPanel.jsx", "../client/src/components/ChatTimeline.jsx", "../client/src/components/MarkdownToc.jsx", "../client/src/components/CommentMarker.jsx", "../client/src/components/DocxViewer.jsx"]) {
  assert.doesNotMatch(read(文件), /behavior: "smooth"/, `${文件} 不应硬编码平滑滚动`);
}
assert.match(对话面板, /pending\.scrollIntoView\(\{ behavior: motionScrollBehavior\(\), block: "center" \}\)/, "定位待审批应走统一滚动行为");

// ============================ 5. 动效清单（P3 交付物） ============================
const 清单路径 = "../docs/plans/2026-09-23-001-P3动效清单.md";
assert.ok(存在(清单路径), "应交付 P3 动效清单文档");
const 清单 = read(清单路径);
for (const 列 of ["触发条件", "持续时间", "可中断", "静态回退", "读屏播报"]) {
  assert.ok(清单.includes(列), `动效清单应包含「${列}」列`);
}
for (const 场景 of ["跑马灯", "首屏加载", "发送消息", "阶段变化", "工具审批", "文件改动", "运行结束", "面板", "模型 / 模式切换"]) {
  assert.ok(清单.includes(场景), `动效清单应覆盖「${场景}」场景`);
}

console.log("动效治理回归：通过");
