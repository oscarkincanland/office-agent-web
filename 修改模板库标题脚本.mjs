import fs from 'node:fs';

const htmlPath = '规聚项目完整介绍汇报-暖白展示风格-视频整合处理中.html';
const html = fs.readFileSync(htmlPath, 'utf8');
const oldTitle = '14个模板，直接切换查看 Markdown 文件';
const newTitle = '总结形成了14个规划所涉及的通用模板';
if (!html.includes(oldTitle)) throw new Error('未找到模板库页面标题');
fs.writeFileSync(htmlPath, html.replace(oldTitle, newTitle), 'utf8');
console.log('已更新模板库页面标题');
