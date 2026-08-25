import fs from 'node:fs';

const file = '规聚项目完整介绍汇报-暖白展示风格-视频整合处理中.html';
let html = fs.readFileSync(file, 'utf8');

if (html.includes("file:'视频/知识图谱.webm'")) throw new Error('第三轮视频优化已经执行过');

html = html.replace('视频/知识库的整理汇聚.webm', '视频/知识图谱.webm');
html = html.replace('知识库整理汇聚 · 标签、索引与关联', '知识图谱 · 知识库切换');

const configMarker = `{title:'技能集合工作流',file:'视频/技能集合.webm',speed:1,kind:'standard'},`;
const configAddition = `${configMarker}\n  {title:'Skills技能体系',file:'视频/知识库的整理汇聚.webm',speed:1,kind:'skills'},`;
if (!html.includes(configMarker)) throw new Error('找不到技能视频配置位置');
html = html.replace(configMarker, configAddition);

const mountMarker = `}else if(item.title==='技能集合工作流'){`;
const mountAddition = `}else if(item.kind==='skills'){\n      const target=slide.querySelector('.skills-panel');\n      if(target){const video=makeExternalVideo(item);video.classList.add('skills-video');target.replaceWith(video);}\n    }else if(item.title==='技能集合工作流'){`;
if (!html.includes(mountMarker)) throw new Error('找不到技能视频挂载位置');
html = html.replace(mountMarker, mountAddition);

const css = `
    .asset-layout{grid-template-columns:.76fr 1.24fr;gap:3vw;align-items:start}
    .asset-layout .asset-grid{grid-template-columns:1fr;gap:8px;align-content:start}
    .asset-layout .asset{min-height:0;padding:10px 14px}
    .asset-layout .video-stack-shell{grid-template-rows:repeat(2,minmax(220px,1fr));gap:12px}
    .asset-layout .video-stack-shell>.video-slot,.asset-layout .video-stack-shell>.external-video-slot{height:220px;min-height:220px}
    .asset-layout .video-stack-shell>.video-slot video,.asset-layout .video-stack-shell>.external-video-slot video{height:100%;min-height:inherit;object-fit:contain;background:#17172b}
    .knowledge .video-slot{height:50vh;min-height:440px}
    .knowledge .video-slot video{object-fit:contain;background:#17172b}
    .skills .skills-video{height:42vh;min-height:335px;border:1px solid var(--line);border-radius:18px;background:#17172b;position:relative;overflow:hidden;box-shadow:0 12px 28px rgba(73,56,42,.05)}
    .skills .skills-video video{display:block;width:100%;height:100%;object-fit:contain;background:#17172b}
    @media(max-width:950px){.asset-layout{grid-template-columns:1fr}.asset-layout .video-stack-shell>.video-slot,.asset-layout .video-stack-shell>.external-video-slot{height:190px;min-height:190px}.knowledge .video-slot{height:38vh;min-height:260px}.skills .skills-video{height:34vh;min-height:230px}}
`;
html = html.replace('</style>', `${css}\n  </style>`);

fs.writeFileSync(file, html);
console.log(JSON.stringify({file, bytes:Buffer.byteLength(html), addedVideo:'视频/知识库的整理汇聚.webm',replacementVideo:'视频/知识图谱.webm'}, null, 2));
