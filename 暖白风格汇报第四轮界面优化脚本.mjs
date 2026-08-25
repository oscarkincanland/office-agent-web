import fs from 'node:fs';

const file = '规聚项目完整介绍汇报-暖白展示风格-视频整合处理中.html';
let html = fs.readFileSync(file, 'utf8');

if (html.includes('class="brand-logo"')) throw new Error('第四轮界面优化已经执行过');

let logoIndex = 0;
html = html.replace(/<i class="brand-mark"><\/i>/g, () => {
  const id = `op-bg-${logoIndex++}`;
  return `<svg class="brand-logo" width="22" height="22" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Open Plan 规聚"><defs><linearGradient id="${id}" x1="4" y1="4" x2="44" y2="44" gradientUnits="userSpaceOnUse"><stop stop-color="#2a8c82"/><stop offset="1" stop-color="#14535c"/></linearGradient></defs><rect x="2" y="2" width="44" height="44" rx="12" fill="url(#${id})"/><g stroke="#fff" stroke-opacity=".22" stroke-width="1"><path d="M2 16h44M2 32h44M16 2v44M32 2v44"/></g><g stroke="#fff" stroke-opacity=".55" stroke-width="1.4"><line x1="12.5" y1="12.5" x2="19.5" y2="19.5"/><line x1="35.5" y1="12.5" x2="28.5" y2="19.5"/><line x1="12.5" y1="35.5" x2="19.5" y2="28.5"/><line x1="35.5" y1="35.5" x2="28.5" y2="28.5"/></g><circle cx="10" cy="10" r="2.6" fill="#fff" fill-opacity=".9"/><circle cx="38" cy="10" r="2.6" fill="#fff" fill-opacity=".9"/><circle cx="10" cy="38" r="2.6" fill="#fff" fill-opacity=".9"/><circle cx="38" cy="38" r="2.6" fill="#fff" fill-opacity=".9"/><circle cx="24" cy="24" r="9" stroke="#fff" stroke-width="3"/><circle cx="24" cy="24" r="3.6" fill="#fff"/></svg>`;
});

const stackBlock = `const target=slide.querySelector('.video-slot');\n      if(target){\n        const existing=document.createElement('div'); existing.className='video-slot stack-item';\n        const existingVideo=target.querySelector(':scope > video'); const existingCaption=target.querySelector(':scope > .video-caption');\n        if(existingVideo)existing.appendChild(existingVideo); if(existingCaption)existing.appendChild(existingCaption);\n        target.className=target.className.replace('video-slot','video-stack-shell'); target.innerHTML=''; target.append(existing,makeExternalVideo(item));\n      }`;
const templateStack = `const target=slide.querySelector('.video-slot');\n      if(target){\n        const existing=document.createElement('div'); existing.className='video-slot template-video-card';\n        const existingVideo=target.querySelector(':scope > video'); const existingCaption=target.querySelector(':scope > .video-caption');\n        if(existingVideo)existing.appendChild(existingVideo); if(existingCaption)existing.appendChild(existingCaption);\n        const assetLayout=slide.querySelector('.asset-layout'); const assetGrid=assetLayout&&assetLayout.querySelector('.asset-grid');\n        const layout=document.createElement('div'); layout.className='template-media-layout';\n        if(assetGrid)layout.append(existing,assetGrid,makeExternalVideo(item));\n        else layout.append(existing,makeExternalVideo(item));\n        if(assetLayout)assetLayout.replaceWith(layout);\n      }`;
if (!html.includes(stackBlock)) throw new Error('找不到模板双视频挂载逻辑');
html = html.replace(stackBlock, `if(item.title==='规范库与模板库'){\n      ${templateStack}\n    }else{\n      ${stackBlock}\n    }`);

const css = `
    .brand-logo{display:block;width:22px;height:22px;flex:0 0 auto}
    section[data-title="平台整体形态"] .section-title .eyebrow{font-size:13px}
    section[data-title="平台整体形态"] .section-title h2{font-size:min(5.8vw,10vh)}
    section[data-title="平台整体形态"] .interface-map{grid-template-columns:1.28fr .72fr;gap:3.5vw}
    section[data-title="平台整体形态"] .interface-legend h3{font-size:clamp(32px,3.3vw,54px);margin:14px 0 20px}
    section[data-title="平台整体形态"] .legend-item{font-size:14px;line-height:1.55;padding:13px 0;grid-template-columns:30px 1fr;gap:10px}
    section[data-title="平台整体形态"] .legend-item b{font-size:12px}
    section[data-title="平台整体形态"] .legend-item strong{font-size:15px}
    section[data-title="平台整体形态"] .interface-box b{font-size:12px}
    section[data-title="平台整体形态"] .interface-box span{font-size:10px}
    .template-media-layout{display:grid;grid-template-columns:1fr 1.05fr 1fr;gap:16px;align-items:start}
    .template-media-layout .asset-grid{display:grid;grid-template-columns:1fr;gap:8px;align-content:start}
    .template-media-layout .asset{min-height:0;padding:12px 14px}
    .template-media-layout>.template-video-card,.template-media-layout>.external-video-slot{height:330px;min-height:330px}
    .template-media-layout>.template-video-card video,.template-media-layout>.external-video-slot video{height:100%;min-height:inherit;object-fit:contain;background:#17172b}
    section[data-title="智能体广场"] .agent-layout{align-items:start;margin-top:-1.5vh}
    section[data-title="智能体广场"] .video-stack-shell{grid-template-rows:repeat(2,minmax(245px,1fr));gap:14px;margin-top:-1vh}
    section[data-title="智能体广场"] .video-stack-shell>.video-slot,section[data-title="智能体广场"] .video-stack-shell>.external-video-slot{height:245px;min-height:245px}
    section[data-title="智能体广场"] .video-stack-shell>.video-slot video,section[data-title="智能体广场"] .video-stack-shell>.external-video-slot video{object-fit:contain;background:#17172b}
    section[data-title="技术架构"] .arch{grid-template-columns:1.02fr .98fr;gap:4vw;align-items:start}
    section[data-title="技术架构"] .arch-list{padding-top:4px}
    section[data-title="技术架构"] .arch-row{grid-template-columns:120px 1fr;gap:20px;padding:18px 0}
    section[data-title="技术架构"] .arch-row b{font-size:12px}
    section[data-title="技术架构"] .arch-row span{font-size:16px;line-height:1.6}
    @media(max-width:950px){.template-media-layout{grid-template-columns:1fr}.template-media-layout>.template-video-card,.template-media-layout>.external-video-slot{height:220px;min-height:220px}.template-media-layout>.template-video-card video,.template-media-layout>.external-video-slot video{height:100%}section[data-title="智能体广场"] .video-stack-shell>.video-slot,section[data-title="智能体广场"] .video-stack-shell>.external-video-slot{height:190px;min-height:190px}section[data-title="技术架构"] .arch{grid-template-columns:1fr}.brand-logo{width:20px;height:20px}}
`;
html = html.replace('</style>', `${css}\n  </style>`);
fs.writeFileSync(file, html);
console.log(JSON.stringify({file, bytes:Buffer.byteLength(html), logos:logoIndex, templateLayout:true}, null, 2));
