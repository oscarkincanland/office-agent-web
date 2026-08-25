import fs from 'node:fs';

const source = '规聚项目完整介绍汇报-暖白展示风格.html';
const staging = '规聚项目完整介绍汇报-暖白展示风格-视频整合处理中.html';

const css = `
    .external-video-slot{min-height:190px;background:#efe9e2;border:1px solid var(--line);border-radius:18px;position:relative;overflow:hidden;box-shadow:0 12px 28px rgba(73,56,42,.05)}
    .external-video-slot video{display:block;width:100%;height:100%;min-height:inherit;object-fit:cover;background:#ddd6cd}
    .external-video-slot .video-caption{position:absolute;left:16px;top:14px;z-index:2;background:rgba(255,253,250,.9);border:1px solid rgba(222,216,207,.9);border-radius:999px;padding:6px 10px;color:#6e665f;font-size:10px}
    .external-video-slot .video-caption::before{content:"▶";color:var(--accent);margin-right:6px}
    .external-video-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .external-video-grid .external-video-slot{min-height:155px;height:155px}
    .external-video-stack{display:grid;gap:12px}
    .external-video-stack .external-video-slot{min-height:175px;height:175px}
    .flow-video{margin-top:1px;min-height:165px;height:165px}
    .map-video{height:100%;min-height:325px;border:0;border-radius:0;box-shadow:none}
    .map-video video{object-fit:cover}
    .analysis-video-grid{margin-top:1px}
    .analysis-video-grid .external-video-slot{min-height:135px;height:135px}
    .full-width-video{width:100%}
    @media(max-width:950px){.external-video-grid{grid-template-columns:1fr}.external-video-grid .external-video-slot{height:190px}.map-video{min-height:220px}.flow-video{height:180px}}
`;

const externalCode = String.raw`
const externalVideoConfig=[
  {title:'实现流程',file:'视频/完整OD工作流3倍速播放.webm',speed:3,kind:'flow'},
  {title:'AI Agent协作',file:'视频/agent提问.webm',speed:1,kind:'standard'},
  {title:'Office文档工作台',file:'视频/各种文件打开.webm',speed:1,kind:'standard'},
  {title:'规范库与模板库',file:'视频/模版库查看2倍数.webm',speed:2,kind:'stack'},
  {title:'技能集合工作流',file:'视频/技能集合.webm',speed:1,kind:'standard'},
  {title:'智能体广场',file:'视频/智能体.webm',speed:1,kind:'stack'},
  {title:'GIS地图工作台',file:'视频/地图功能介绍.webm',speed:1,kind:'map'},
  {title:'M2与M3分析',file:'视频/生成热力图demo.webm',speed:1,kind:'analysis'},
  {title:'M2与M3分析',file:'视频/案例1：新昌公交数据处理及可视化展示.webm',speed:1,kind:'analysis'},
  {title:'M2与M3分析',file:'视频/案例2：柬埔寨OD分析.webm',speed:1,kind:'analysis'}
];
function makeExternalVideo(item){
  const slot=document.createElement('div');
  slot.className='external-video-slot';
  if(item.kind==='flow')slot.classList.add('flow-video');
  if(item.kind==='map')slot.classList.add('map-video');
  const video=document.createElement('video');
  video.autoplay=true; video.muted=true; video.controls=true; video.playsInline=true; video.preload='metadata';
  video.dataset.speed=String(item.speed||1);
  const source=document.createElement('source'); source.src=item.file; source.type='video/webm'; video.appendChild(source);
  const caption=document.createElement('div'); caption.className='video-caption'; caption.textContent=item.label||item.file.split('/').pop().replace(/\.webm$/i,'');
  slot.append(video,caption);
  return slot;
}
function findSlide(title){return [...document.querySelectorAll('.slide')].find(slide=>slide.dataset.title===title)}
function addInto(slide,selector,item,mode){
  const target=slide&&slide.querySelector(selector); if(!target)return;
  const video=makeExternalVideo(item);
  if(mode==='replace'){target.replaceWith(video);return}
  if(mode==='append'){target.append(video);return}
  target.classList.add('external-video-stack'); target.append(video);
}
function mountExternalVideos(){
  for(const item of externalVideoConfig){
    const slide=findSlide(item.title); if(!slide)continue;
    if(item.kind==='flow'){
      const video=makeExternalVideo(item); video.classList.add('full-width-video');
      const flow=slide.querySelector('.flow'); if(flow)flow.insertAdjacentElement('afterend',video);
    }else if(item.kind==='map'){
      const target=slide.querySelector('.map-screen'); if(target){target.innerHTML='';target.appendChild(makeExternalVideo(item));}
    }else if(item.kind==='analysis'){
      let grid=slide.querySelector('.analysis-video-grid');
      if(!grid){grid=document.createElement('div');grid.className='external-video-grid analysis-video-grid';const reserve=slide.querySelector('[data-media-slot="M2-M3分析-仪表盘视频"]');if(reserve)reserve.replaceWith(grid);}
      grid.appendChild(makeExternalVideo(item));
    }else if(item.kind==='stack'){
      const target=slide.querySelector('.video-slot');
      if(target){target.classList.add('external-video-stack');target.appendChild(makeExternalVideo(item));}
    }else if(item.title==='技能集合工作流'){
      const workflow=slide.querySelector('.workflow-grid');
      if(workflow)workflow.insertAdjacentElement('afterend',makeExternalVideo(item));
    }else{
      const reserve=slide.querySelector('.media-slot');
      if(reserve)reserve.replaceWith(makeExternalVideo(item));
    }
  }
}
mountExternalVideos();
go(0);
`;

let html = fs.readFileSync(staging, 'utf8');
if (!html.includes('暖白展示版')) throw new Error('底稿不是暖白展示版，停止写入');
if (html.includes('externalVideoConfig')) throw new Error('已整合过视频，避免重复注入');
html = html.replace('</style>', `${css}\n  </style>`);
const marker = 'go(0)})();';
if (!html.includes(marker)) throw new Error('找不到页面初始化入口');
html = html.replace(marker, `${externalCode}\n${marker}`);
fs.writeFileSync(staging, html);
console.log(JSON.stringify({source, staging, bytes:Buffer.byteLength(html), externalSources:html.split("file:'视频/").length-1}, null, 2));
