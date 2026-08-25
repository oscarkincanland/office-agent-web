import fs from 'node:fs';

const sourcePath = '规聚项目完整介绍汇报-暖白展示风格-视频整合处理中.html';
const outputPath = '规聚项目完整介绍汇报-离线视频版.html';
let html = fs.readFileSync(sourcePath, 'utf8');
html = html.replaceAll('../交通报告写作规范知识库.html', '交通报告写作规范知识库.html');
fs.writeFileSync(outputPath, html, 'utf8');
console.log('已生成离线视频版HTML');
