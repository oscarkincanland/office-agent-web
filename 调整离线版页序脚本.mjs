import fs from 'node:fs';

const input = process.argv[2];
const output = process.argv[3] || input;
if (!input) throw new Error('请提供输入 HTML 路径');

let html = fs.readFileSync(input, 'utf8');
const slidePattern = /<section\b[^>]*>[\s\S]*?<\/section>/g;
const matches = [...html.matchAll(slidePattern)];
if (matches.length !== 25) {
  throw new Error(`预期 25 页，实际识别到 ${matches.length} 页，已停止修改`);
}

const firstStart = matches[0].index;
const lastEnd = matches.at(-1).index + matches.at(-1)[0].length;
const before = html.slice(0, firstStart);
const after = html.slice(lastEnd);
const slides = matches.map((match) => match[0]);

// 将原第 8 页移到原第 15 页之前。
const pageEight = slides.splice(7, 1)[0];
slides.splice(13, 0, pageEight);

const total = slides.length;
const normalized = slides.map((slide, index) => slide.replace(
  /(<span class="top-meta"[^>]*>)([\s\S]*?)(<\/span>)/g,
  (full, open, text, close) => {
    if (!/\d+\s*\/\s*\d+/.test(text)) return full;
    const nextText = text.replace(/\d+\s*\/\s*\d+/, `${String(index + 1).padStart(2, '0')} / ${total}`);
    return open + nextText + close;
  },
));

let result = before + normalized.join('') + after;
// 知识库和汇报 HTML 在同一目录，确保整个文件夹复制到 U 盘后仍能加载。
result = result.replaceAll('src="../交通报告写作规范知识库.html"', 'src="交通报告写作规范知识库.html"');
result = result.replaceAll("window.open('../交通报告写作规范知识库.html','_blank')", "window.open('交通报告写作规范知识库.html','_blank')");
fs.writeFileSync(output, result, 'utf8');
console.log(`已调整 ${output}：${total} 页`);
