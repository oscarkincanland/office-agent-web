import fs from "node:fs";

const source = "规聚项目完整介绍汇报-单文件离线版-处理中.html";
const html = fs.readFileSync(source, "utf8");

const removeTitles = [
  "实现｜Agent 可以直接协作修改地图",
  "实现｜Pi Agent TUI 驱动二次开发",
  "实现｜前端工作台的二次开发",
  "实现｜后端控制面管理过程和能力",
  "实现｜从 Agent 对话到工具协议",
  "实现｜前后端二次开发的真实闭环",
  "实现｜为其他 Agent 预留接入能力",
  "实现｜AI 时代，工程师只做加法",
  "工程资产｜从版本迭代到系统能力"
];

let result = html;
for (const title of removeTitles) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<section\\b[^>]*data-title="${escaped}"[\\s\\S]*?<\\/section>\\s*`, "g");
  const before = result;
  result = result.replace(pattern, "");
  if (result === before) throw new Error(`未删除页面：${title}`);
}

const newStyles = `
    /* 新增外置视频：继续使用暖白 Claude 风格，媒体统一复用现有视频框。 */
    .external-video{min-height:220px;aspect-ratio:16/9;background:#181827;border-color:#403d50}
    .external-video video{display:block;width:100%;height:100%;object-fit:contain;background:#17172b}
    .external-video .video-note{position:absolute;left:20px;bottom:16px;z-index:3;max-width:68%;color:rgba(255,255,255,.78);font-size:14px;line-height:1.35;background:rgba(23,23,43,.7);padding:5px 8px;border-radius:8px}
    .video-stack{display:grid;gap:12px;min-width:0}
    .video-stack .video-frame{min-height:0;aspect-ratio:16/9}
    .video-stack .external-video{min-height:0}
    .architecture-media{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(270px,.7fr);gap:2.2vw;align-items:stretch}
    .architecture-media .architecture{min-width:0}
    .architecture-media .external-video{height:100%;min-height:260px}
    .map-media-stack{grid-column:2;grid-row:1;display:grid;grid-template-rows:minmax(0,1fr) auto;gap:12px;min-width:0}
    .map-media-stack .map-screen{min-height:0;height:100%}
    .map-media-stack .external-video{min-height:205px}
    .external-video-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;min-width:0}
    .external-video-grid .video-frame{min-height:0;aspect-ratio:16/9}
    @media(max-width:1000px){.architecture-media{grid-template-columns:1fr}.map-media-stack{grid-column:auto;grid-row:auto;grid-template-rows:auto auto}.external-video-grid{grid-template-columns:1fr}.external-video .video-note{display:none}}
`;
if (!result.includes(".external-video{min-height:220px")) {
  result = result.replace("</style>", `${newStyles}</style>`);
}

const externalCode = `
      const externalVideoConfig={
        "实现｜一次任务经过六个连续步骤":{file:"视频/完整OD工作流3倍速播放.webm",speed:3,label:"完整 OD 工作流",note:"导入 → 校验 → 分析 → 可视化 → 成果"},
        "实现｜GIS 从地图预览变成工程工作台":{file:"视频/地图功能介绍.webm",speed:1,label:"地图功能介绍",note:"图层 · 属性 · 工具 · 工程分析"},
        "实现｜地图专题分析从数据到成果":{file:"视频/生成热力图demo.webm",speed:1,label:"生成热力图 Demo",note:"数据进入地图，分析结果直接出图"},
        "方案｜工程师和 Agent 双向协作":{file:"视频/agent提问.webm",speed:1,label:"Agent 提问",note:"关键判断交回工程师确认"},
        "实现｜成果回到 Office 继续编辑":{file:"视频/各种文件打开.webm",speed:1,label:"各种文件打开",note:"报告、表格、地图和HTML成果继续编辑"},
        "工程资产｜四种工作流把复杂任务拆开":{file:"视频/技能集合.webm",speed:1,label:"技能集合",note:"把能力组合成可启动的工作流"},
        "方案｜模板把经验蒸馏成 Agent 行为":{file:"视频/模版库查看2倍数.webm",speed:2,label:"模板库查看",note:"模板筛选 · 预览 · 引用 · 复用"},
        "工程资产｜四个 Agent 角色提示词":{file:"视频/智能体.webm",speed:1,label:"智能体广场",note:"角色提示词 + 技能 + 输出规范"},
        "亮点｜地图、人机确认和成果回写形成闭环":{files:[{file:"视频/案例1：新昌公交数据处理及可视化展示.webm",speed:1,label:"案例1 · 新昌公交",note:"公交数据处理与可视化展示"},{file:"视频/案例2：柬埔寨OD分析.webm",speed:1,label:"案例2 · 柬埔寨 OD",note:"OD分析与规划表达"}]}
      };
      function createExternalVideo(config){
        const frame=document.createElement("div");frame.className="video-frame external-video";
        const video=document.createElement("video");video.controls=true;video.autoplay=true;video.muted=true;video.playsInline=true;video.preload="metadata";video.dataset.speed=String(config.speed||1);video.dataset.externalKey=config.file;
        const source=document.createElement("source");source.src=config.file;source.type="video/webm";video.appendChild(source);
        const label=document.createElement("span");label.className="video-label";label.textContent=config.label;
        const speed=document.createElement("span");speed.className="video-speed";speed.textContent=config.speed&&config.speed!==1?"静音自动播放 · "+config.speed+"×":"静音自动播放 · 1×";
        const note=document.createElement("span");note.className="video-note";note.textContent=config.note||"功能演示";
        frame.append(video,label,speed,note);
        video.addEventListener("loadedmetadata",()=>{video.muted=true;video.playbackRate=Number(video.dataset.speed||1);if(video.closest(".slide")===slides[current])video.play().catch(()=>{})});
        return frame;
      }
      function mountExternalVideo(title,mode){
        const section=slides.find(s=>s.dataset.title===title),config=externalVideoConfig[title];if(!section||!config)return;
        if(config.files){const reserve=section.querySelector(".media-reserve");if(!reserve)return;const grid=document.createElement("div");grid.className="external-video-grid";config.files.forEach(item=>grid.appendChild(createExternalVideo(item)));reserve.replaceWith(grid);return}
        const frame=createExternalVideo(config);
        if(mode==="stack"){
          const existing=section.querySelector(".video-frame");if(!existing)return;const stack=document.createElement("div");stack.className="video-stack";existing.replaceWith(stack);stack.append(existing,frame);return;
        }
        if(mode==="architecture"){
          const architecture=section.querySelector(".architecture");if(!architecture)return;const wrap=document.createElement("div");wrap.className="architecture-media";architecture.replaceWith(wrap);wrap.append(architecture,frame);return;
        }
        if(mode==="map"){
          const screen=section.querySelector(".map-screen");if(!screen)return;const stack=document.createElement("div");stack.className="map-media-stack";screen.replaceWith(stack);stack.append(screen,frame);return;
        }
        const reserve=section.querySelector(".media-reserve");if(reserve)reserve.replaceWith(frame);
        else{const placeholder=section.querySelector(".video-frame");if(placeholder)placeholder.replaceWith(frame)}
      }
      mountExternalVideo("实现｜一次任务经过六个连续步骤");
      mountExternalVideo("实现｜GIS 从地图预览变成工程工作台","map");
      mountExternalVideo("实现｜地图专题分析从数据到成果");
      mountExternalVideo("方案｜工程师和 Agent 双向协作","architecture");
      mountExternalVideo("实现｜成果回到 Office 继续编辑","stack");
      mountExternalVideo("工程资产｜四种工作流把复杂任务拆开");
      mountExternalVideo("方案｜模板把经验蒸馏成 Agent 行为","stack");
      mountExternalVideo("工程资产｜四个 Agent 角色提示词");
      mountExternalVideo("亮点｜地图、人机确认和成果回写形成闭环");
`;
result = result.replace('slides=[...document.querySelectorAll(".slide:not(.route-skip)")]', 'slides=[...document.querySelectorAll(".slide")]');
result = result.replace("      go(current);", `${externalCode}      go(current);`);
if (!result.includes("externalVideoConfig")) throw new Error("外置视频脚本插入失败");

fs.writeFileSync(source, result, "utf8");
console.log(JSON.stringify({sections:(result.match(/<section\\b/g)||[]).length,videos:(result.match(/<video\\b/g)||[]).length,bytes:Buffer.byteLength(result)}));
