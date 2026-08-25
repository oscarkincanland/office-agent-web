import fs from 'node:fs';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  LevelFormat,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  TextRun
} from 'docx';

const sourcePath = '规聚项目完整介绍汇报-25页口播稿.md';
const outputPath = '规聚项目完整介绍汇报-25页口播稿.docx';
const markdown = fs.readFileSync(sourcePath, 'utf8').replace(/\r/g, '');

function inlineRuns(text, base = {}) {
  const runs = [];
  const pattern = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) runs.push(new TextRun({ text: text.slice(cursor, match.index), ...base }));
    if (match[1]) runs.push(new TextRun({ text: match[1], bold: true, ...base }));
    else runs.push(new TextRun({ text: match[2], italics: true, ...base }));
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) runs.push(new TextRun({ text: text.slice(cursor), ...base }));
  return runs.length ? runs : [new TextRun({ text, ...base })];
}

const children = [
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 900, after: 260 },
    children: [new TextRun({ text: '《规聚：把规划工作聚到一起》', bold: true, size: 36, color: 'C45D3F', font: 'Microsoft YaHei UI' })]
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 180 },
    children: [new TextRun({ text: '25页汇报口播稿｜约10分钟', size: 22, color: '77716A', font: 'Microsoft YaHei UI' })]
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 720 },
    children: [new TextRun({ text: '交通规划 · AI一体化工作台', size: 20, color: '99928A', font: 'Microsoft YaHei UI' })]
  }),
  new Paragraph({
    border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'D97757', space: 10 } },
    shading: { fill: 'FBF1EB' },
    spacing: { before: 200, after: 400 },
    indent: { left: 240, right: 180 },
    children: [new TextRun({ text: '使用说明：PPT页面只呈现核心观点，视频页让视频承担主要展示；现场可根据视频长度调整停留时间。', italics: true, size: 21, color: '6F665E', font: 'Microsoft YaHei UI' })]
  }),
  new Paragraph({ children: [new PageBreak()] })
];

for (const line of markdown.split('\n')) {
  if (!line.trim() || line.startsWith('# 《规聚')) continue;
  if (line.startsWith('> 使用建议') || line.startsWith('> 建议时长')) continue;
  if (line.startsWith('## ')) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: inlineRuns(line.slice(3).trim()) }));
    continue;
  }
  if (line.startsWith('### ')) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: inlineRuns(line.slice(4).trim()) }));
    continue;
  }
  if (line.startsWith('---')) continue;
  if (line.startsWith('> ')) {
    children.push(new Paragraph({
      border: { left: { style: BorderStyle.SINGLE, size: 8, color: 'D97757', space: 8 } },
      indent: { left: 180 },
      spacing: { after: 150 },
      children: inlineRuns(line.slice(2), { italics: true, color: '77716A' })
    }));
    continue;
  }
  const bullet = line.match(/^\s*[-*]\s+(.+)$/);
  if (bullet) {
    children.push(new Paragraph({ numbering: { reference: '口播稿要点', level: 0 }, children: inlineRuns(bullet[1]) }));
    continue;
  }
  const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
  if (ordered) {
    children.push(new Paragraph({ numbering: { reference: '现场提示', level: 0 }, children: inlineRuns(ordered[1]) }));
    continue;
  }
  children.push(new Paragraph({ spacing: { after: 140, line: 300 }, children: inlineRuns(line) }));
}

const doc = new Document({
  creator: '规聚项目组',
  title: '规聚项目完整介绍汇报25页口播稿',
  description: '规聚交通规划AI一体化工作台汇报口播稿',
  styles: {
    default: { document: { run: { font: 'Microsoft YaHei UI', size: 22, color: '4D4843' } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Microsoft YaHei UI', size: 28, bold: true, color: '2B2927' }, paragraph: { spacing: { before: 300, after: 150 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Microsoft YaHei UI', size: 24, bold: true, color: '8E513F' }, paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 } }
    ]
  },
  numbering: {
    config: [
      { reference: '口播稿要点', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 600, hanging: 300 } } } }] },
      { reference: '现场提示', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 600, hanging: 300 } } } }] }
    ]
  },
  sections: [{
    properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '规聚 · 汇报口播稿  |  ', color: '99928A', size: 18 }), new TextRun({ children: [PageNumber.CURRENT], color: '99928A', size: 18 })] })] }) },
    children
  }]
});

const buffer = await Packer.toBuffer(doc);
fs.writeFileSync(outputPath, buffer);
console.log(`已生成 ${outputPath}`);
