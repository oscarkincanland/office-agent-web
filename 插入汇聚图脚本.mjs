import fs from 'node:fs';

const htmlPath = '规聚项目完整介绍汇报-暖白展示风格-视频整合处理中.html';
const html = fs.readFileSync(htmlPath, 'utf8');

const oldSolution = '<div class="solution-visual" data-anim="media" style="--i:3" data-media-slot="解决方案-平台总览视频"><span class="orbit-label ol1">资料</span><span class="orbit-label ol2">知识</span><span class="orbit-label ol3">技能</span><span class="orbit-label ol4">成果</span><div class="orbit"></div><div class="orbit two"></div><div class="solution-core">规聚<br>工作台</div></div>';
const newSolution = '<div class="solution-visual convergence-visual" data-anim="media" style="--i:3;height:360px;min-height:360px;padding:0;overflow:hidden" data-media-slot="资料知识技能成果汇聚图"><img class="generated-image convergence-image" src="图片/资料知识技能成果汇聚图.png" alt="资料、知识、技能、成果汇聚图"><span class="generated-caption">资料 · 知识 · 技能 · 成果</span></div>';

const oldArch = '<div class="arch-visual" data-anim="media" style="--i:2" data-media-slot="技术架构-系统图或演示"><span class="arch-label al1">React / Vite</span><span class="arch-label al2">Pi Agent SDK</span><span class="arch-label al3">OfficeCLI</span><span class="arch-label al4">MapLibre / G6</span><div class="arch-visual::before"></div><div class="arch-core">规聚<br>工作台</div></div>';
const newArch = '<div class="arch-visual arch-image-visual" data-anim="media" style="--i:2;height:360px;min-height:360px;padding:0;overflow:hidden" data-media-slot="前端后端Agent数据架构图"><img class="generated-image arch-image" src="图片/前端后端Agent数据架构图.png" alt="前端、后端、Agent、数据架构图"><span class="generated-caption">前端 · 后端 · Agent · 数据</span></div>';

if (!html.includes(oldSolution)) throw new Error('未找到项目解决方案原图结构');
if (!html.includes(oldArch)) throw new Error('未找到技术架构原图结构');

let next = html.replace(oldSolution, newSolution).replace(oldArch, newArch);
next = next.replace('</style>', 'section[data-title="项目解决方案"] .convergence-image{object-fit:contain;background:#fffdfa} section[data-title="技术架构"] .arch-image{object-fit:contain;background:#fffdfa} section[data-title="项目解决方案"] .convergence-visual::before,section[data-title="技术架构"] .arch-image-visual::before{display:none} </style>');
fs.writeFileSync(htmlPath, next, 'utf8');
console.log('已插入两张带中文标注的汇聚图');
