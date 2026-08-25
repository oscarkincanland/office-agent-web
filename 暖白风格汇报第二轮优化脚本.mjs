import fs from 'node:fs';

const file = '规聚项目完整介绍汇报-暖白展示风格-视频整合处理中.html';
let html = fs.readFileSync(file, 'utf8');

function getSection(title) {
  const match = html.match(new RegExp(`<section\\b[^>]*data-title="${title}"[^>]*>[\\s\\S]*?<\\/section>`));
  if (!match) throw new Error(`找不到页面：${title}`);
  return match[0];
}

function getTopbar(section) {
  const match = section.match(/<div class="topbar">[\s\S]*?<\/div>/);
  if (!match) throw new Error('找不到页面顶部结构');
  return match[0];
}

const processOld = getSection('实现流程');
const analysisOld = getSection('M2与M3分析');
const closingOld = getSection('项目价值与下一步');

const processNew = `<section class="slide blue" data-layout="S07" data-title="实现流程">${getTopbar(processOld)}<div class="main"><div class="section-title" data-anim style="--i:1"><span class="eyebrow">我们的实现流程</span><h2>一次任务，经过六个连续步骤</h2><p class="lead" style="margin-top:1.7vh">从输入资料，到调用能力，再到形成可继续编辑的成果，每一步都能被看见、被理解、被恢复。</p></div><div class="media-layout process-video-layout"><div class="media-slot process-video-mount" data-anim="media" style="--i:2" data-media-slot="完整OD工作流-视频"><div class="media-content"><div class="media-icon">▶</div><span class="slot-label">完整工作流视频</span><span class="slot-file">选择工作区 → 引用资料 → Agent 执行 → 成果回写</span></div><span class="media-ratio">16:9</span></div><div class="feature-list process-summary" data-anim style="--i:3"><div class="feature-row"><b>01</b><div><strong>选择工作区</strong><span>确定项目和文件范围。</span></div></div><div class="feature-row"><b>02</b><div><strong>建立会话</strong><span>保留本轮任务和历史上下文。</span></div></div><div class="feature-row"><b>03</b><div><strong>引用资料</strong><span>把文件、知识库或模板加入任务。</span></div></div><div class="feature-row"><b>04</b><div><strong>理解上下文</strong><span>读取规则、当前文件和项目记忆。</span></div></div><div class="feature-row"><b>05</b><div><strong>调用能力</strong><span>选择文档、知识、地图或技能工具。</span></div></div><div class="feature-row"><b>06</b><div><strong>形成成果</strong><span>返回结果，并保存文件和经验。</span></div></div></div></div><p class="foot">视频建议：完整展示一次从 OD 数据处理、分析到成果输出的连续过程。</p></div></section>`;

const analysisNew = `<section class="slide blue" data-layout="S17" data-title="M2与M3分析">${getTopbar(analysisOld)}<div class="main"><div class="section-title" data-anim style="--i:1"><span class="eyebrow">功能十 · 已跑通案例参考</span><h2>三个已经跑通的案例，说明平台可以继续向前走</h2><p class="lead" style="margin-top:1.5vh">从公交数据处理、地图可视化，到跨区域 OD 分析，案例说明“数据—分析—表达”的工作链已经能够闭环。</p></div><div class="case-summary" data-anim style="--i:2"><div class="analysis-card"><h3>案例一 · 公交数据</h3><span>数据处理与可视化展示</span></div><div class="analysis-card"><h3>案例二 · 地图专题</h3><span>热力图与空间分析</span></div><div class="analysis-card"><h3>案例三 · OD 分析</h3><span>跨区域出行关系分析</span></div></div><div class="case-video-grid" data-anim="media" style="--i:3"></div><p class="foot">这些案例不是终点，而是后续继续蒸馏经验、沉淀技能和扩展 Agent 的参考样本。</p></div></section>`;

const closingNew = `<section class="slide tint" data-layout="S20" data-title="项目价值与下一步">${getTopbar(closingOld)}<div class="closing"><div data-anim style="--i:1"><span class="pill">PROJECT TAKEAWAY</span><div class="closing-title" style="margin-top:3vh">从项目工作台<br><em>走向规划知识基础设施</em></div><p class="lead" style="margin-top:3vh">规聚的下一阶段，不是重新做一个更大的软件，而是围绕真实案例持续做加法，让知识、插件和 Agent 越用越强。</p></div><div class="takeaways future-list" data-anim style="--i:2"><div class="takeaway"><b>01</b><span><strong>进一步蒸馏优秀案例经验</strong><small>把已跑通的工作链转成模板、技能和可复用方法。</small></span></div><div class="takeaway"><b>02</b><span><strong>做加法，而不是重构</strong><small>优先做插件和能力接入，而不是重新做一个孤立软件。</small></span></div><div class="takeaway"><b>03</b><span><strong>构建规划院知识体系</strong><small>把规范、项目、案例、方法和经验连接成院级资产。</small></span></div><div class="takeaway"><b>04</b><span><strong>商业化拓展</strong><small>协助外部单位拓展各行各业的聚合 Agent。</small></span></div></div></div></section>`;

html = html.replace(getSection('实现流程'), processNew);
html = html.replace(getSection('M2与M3分析'), analysisNew);
html = html.replace(getSection('项目价值与下一步'), closingNew);

const order = ['封面','汇报路径','为什么做规聚','当前规划痛点','项目解决方案','AI赋能交通规划','知识库是核心资产','规范与模板蒸馏','轻量化协同','平台整体形态','实现流程','AI Agent协作','Office文档工作台','规范库与模板库','知识库与知识图谱','Skills技能体系','技能集合工作流','智能体广场','规则与记忆','GIS地图工作台','M2与M3分析','会话与工作区','技术架构','项目价值与下一步'];
const sections = [...html.matchAll(/<section\b[\s\S]*?<\/section>/g)].map(match => match[0]);
const sectionByTitle = new Map(sections.map(section => [section.match(/data-title="([^"]+)"/)?.[1], section]));
if (sectionByTitle.size !== order.length || order.some(title => !sectionByTitle.has(title))) throw new Error('页面顺序校验失败');
const deckStart = html.indexOf('<main id="deck">');
const deckEnd = html.indexOf('</main>', deckStart);
if (deckStart < 0 || deckEnd < 0) throw new Error('找不到 deck 容器');
const reorderedDeck = `<main id="deck">\n${order.map(title => sectionByTitle.get(title)).join('\n')}\n  `;
html = html.slice(0, deckStart) + reorderedDeck + html.slice(deckEnd + '</main>'.length);

const extraCss = `
    .process-video-layout{grid-template-columns:1.35fr .65fr;gap:4vw;align-items:start;margin-top:1vh}
    .process-video-layout .process-video-mount,.process-video-layout .external-video-slot{height:48vh;min-height:360px}
    .process-video-layout .external-video-slot video{object-fit:contain;background:#17172b}
    .process-summary{display:grid;gap:0;border-top:1px solid var(--line)}
    .process-summary .feature-row{padding:12px 0}
    .case-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
    .case-summary .analysis-card{min-height:95px;padding:16px;background:var(--paper2);border:1px solid var(--line);border-radius:15px}
    .case-summary .analysis-card h3{font-size:22px;margin-bottom:8px}
    .case-summary .analysis-card span{font-size:12px;color:var(--muted)}
    .case-video-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:1vh}
    .case-video-grid .external-video-slot{height:27vh;min-height:220px}
    .asset-layout .video-stack-shell{height:auto;min-height:0;display:grid;grid-template-rows:repeat(2,minmax(205px,1fr));gap:12px}
    .asset-layout .video-stack-shell>.video-slot,.asset-layout .video-stack-shell>.external-video-slot{height:205px;min-height:205px}
    .agent-layout .video-stack-shell{height:auto;min-height:0;display:grid;grid-template-rows:repeat(2,minmax(210px,1fr));gap:12px}
    .agent-layout .video-stack-shell>.video-slot,.agent-layout .video-stack-shell>.external-video-slot{height:210px;min-height:210px}
    .agent-layout .video-stack-shell>.video-slot video,.agent-layout .video-stack-shell>.external-video-slot video{height:100%;min-height:inherit;object-fit:cover}
    .future-list{display:grid;gap:0}
    .future-list .takeaway{align-items:start;padding:15px 0}
    .future-list .takeaway strong{display:block;font-family:var(--serif);font-size:21px;font-weight:400;color:var(--ink)}
    .future-list .takeaway small{display:block;margin-top:5px;font-size:12px;line-height:1.45;color:var(--muted)}
    @media(max-width:950px){.process-video-layout,.case-summary,.case-video-grid{grid-template-columns:1fr}.process-video-layout .process-video-mount,.process-video-layout .external-video-slot{height:34vh;min-height:240px}.case-video-grid .external-video-slot{height:190px;min-height:190px}.asset-layout .video-stack-shell,.agent-layout .video-stack-shell{grid-template-rows:repeat(2,190px)}.asset-layout .video-stack-shell>.video-slot,.asset-layout .video-stack-shell>.external-video-slot,.agent-layout .video-stack-shell>.video-slot,.agent-layout .video-stack-shell>.external-video-slot{height:190px;min-height:190px}}
`;
html = html.replace('</style>', `${extraCss}\n  </style>`);

html = html.replace(/<video(?![^>]*\bloop\b)/g, '<video loop');
html = html.replace('data-speed="3"><source src="视频/文本审查，打开编辑.webm"', 'data-speed="4"><source src="视频/文本审查，打开编辑.webm"');

const oldFlowBlock = `if(item.kind==='flow'){\n      const video=makeExternalVideo(item); video.classList.add('full-width-video');\n      const flow=slide.querySelector('.flow'); if(flow)flow.insertAdjacentElement('afterend',video);\n    }`;
const newFlowBlock = `if(item.kind==='flow'){\n      const reserve=slide.querySelector('.process-video-mount');\n      if(reserve)reserve.replaceWith(makeExternalVideo(item));\n    }`;
if (!html.includes(oldFlowBlock)) throw new Error('找不到流程视频挂载逻辑');
html = html.replace(oldFlowBlock, newFlowBlock);

const oldAnalysisBlock = `let grid=slide.querySelector('.analysis-video-grid');\n      if(!grid){grid=document.createElement('div');grid.className='external-video-grid analysis-video-grid';const reserve=slide.querySelector('[data-media-slot="M2-M3分析-仪表盘视频"]');if(reserve)reserve.replaceWith(grid);}`;
const newAnalysisBlock = `let grid=slide.querySelector('.case-video-grid');\n      if(!grid){grid=document.createElement('div');grid.className='external-video-grid case-video-grid';const reserve=slide.querySelector('.case-video-grid');if(reserve)grid=reserve;}`;
if (!html.includes(oldAnalysisBlock)) throw new Error('找不到案例视频挂载逻辑');
html = html.replace(oldAnalysisBlock, newAnalysisBlock);

const oldStackBlock = `const target=slide.querySelector('.video-slot');\n      if(target){target.classList.add('external-video-stack');target.appendChild(makeExternalVideo(item));}`;
const newStackBlock = `const target=slide.querySelector('.video-slot');\n      if(target){\n        const existing=document.createElement('div'); existing.className='video-slot stack-item';\n        const existingVideo=target.querySelector(':scope > video'); const existingCaption=target.querySelector(':scope > .video-caption');\n        if(existingVideo)existing.appendChild(existingVideo); if(existingCaption)existing.appendChild(existingCaption);\n        target.className=target.className.replace('video-slot','video-stack-shell'); target.innerHTML=''; target.append(existing,makeExternalVideo(item));\n      }`;
if (!html.includes(oldStackBlock)) throw new Error('找不到双视频挂载逻辑');
html = html.replace(oldStackBlock, newStackBlock);

html = html.replace('video.autoplay=true; video.muted=true; video.controls=true; video.playsInline=true; video.preload=\'metadata\';', 'video.autoplay=true; video.muted=true; video.loop=true; video.controls=true; video.playsInline=true; video.preload=\'metadata\';');
fs.writeFileSync(file, html);
console.log(JSON.stringify({file, bytes:Buffer.byteLength(html), sections:order.length, order, loops:(html.match(/<video loop/g)||[]).length}, null, 2));
