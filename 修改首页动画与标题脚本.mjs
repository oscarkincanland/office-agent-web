import fs from 'node:fs';

const htmlPath = '规聚项目完整介绍汇报-暖白展示风格-视频整合处理中.html';
const html = fs.readFileSync(htmlPath, 'utf8');

const oldHero = '<h1 class="hero-title" style="margin-top:3vh">把规划工作<br><em>聚</em>到一起</h1>';
const newHero = '<h1 class="hero-title" style="margin-top:3vh"><em>规</em>划工作，<br><em>聚</em>到一起</h1>';
const oldRouteTitle = '这不是功能清单，而是一条完整的工作叙事';
const newRouteTitle = '从最基本的规划工作流程出发';
const oldHint = '点击查看事件流';
const newHint = '自动循环演示 · 点击可重播';
const oldDemo = "if(demoSubmit){let timers=[];demoSubmit.onclick=()=>{timers.forEach(clearTimeout);demoItems.forEach(item=>item.classList.remove('show'));demoSubmit.disabled=true;demoSubmit.textContent='执行中';demoStatus.textContent='执行中';timers=demoItems.map((item,i)=>setTimeout(()=>item.classList.add('show'),i*520));timers.push(setTimeout(()=>{demoStatus.textContent='已完成';demoSubmit.textContent='再次演示';demoSubmit.disabled=false},demoItems.length*520+450))}}const kbSlide=";
const newDemo = "if(demoSubmit){let timers=[];const playDemoSequence=()=>{timers.forEach(clearTimeout);demoItems.forEach(item=>item.classList.remove('show'));demoSubmit.disabled=true;demoSubmit.textContent='执行中';demoStatus.textContent='执行中';timers=demoItems.map((item,i)=>setTimeout(()=>item.classList.add('show'),i*520));timers.push(setTimeout(()=>{demoStatus.textContent='已完成';demoSubmit.textContent='再次演示';demoSubmit.disabled=false},demoItems.length*520+450))};demoSubmit.onclick=playDemoSequence;setTimeout(playDemoSequence,900);setInterval(playDemoSequence,demoItems.length*520+2400)}const kbSlide=";

if (!html.includes(oldHero)) throw new Error('未找到首页标题');
if (!html.includes(oldRouteTitle)) throw new Error('未找到第二页标题');
if (!html.includes(oldDemo)) throw new Error('未找到首页任务演示逻辑');

let next = html.replace(oldHero, newHero).replace(oldRouteTitle, newRouteTitle).replace(oldHint, newHint).replace(oldDemo, newDemo);
fs.writeFileSync(htmlPath, next, 'utf8');
console.log('已更新首页标题、自动循环演示和第二页标题');
