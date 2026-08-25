import fs from 'node:fs';

const htmlPath = '规聚项目完整介绍汇报-暖白展示风格-视频整合处理中.html';
const templateDir = 'templates/traffic-material';
const html = fs.readFileSync(htmlPath, 'utf8');
const templateFiles = fs.readdirSync(templateDir)
  .filter(name => name.endsWith('.md'))
  .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));

if (templateFiles.length !== 14) throw new Error(`规划模板数量不是14个，而是${templateFiles.length}个`);

const docs = templateFiles.map((file, index) => ({
  id: `template-${index + 1}`,
  file,
  label: file.replace(/\.md$/i, '').replace(/^\d+_/, ''),
  md: fs.readFileSync(`${templateDir}/${file}`, 'utf8')
}));
const docsJson = JSON.stringify(docs).replace(/</g, '\\u003c');

const sourceSection = html.match(/<section[^>]*data-title="知识库是核心资产"[\s\S]*?<\/section>/)?.[0];
if (!sourceSection) throw new Error('未找到可复用的顶部品牌结构');
const sourceBrand = sourceSection.match(/<span class="brand">[\s\S]*?<\/span>/)?.[0];
if (!sourceBrand) throw new Error('未找到品牌结构');
const brand = sourceBrand.replace(/(<\/svg>)[\s\S]*?(<\/span>)$/, '$1前置说明 · 模板库$2').replace(/op-bg-6/g, 'op-bg-template');

const templateSection = `<section class="slide paper2 template-library-slide" data-layout="S15" data-title="规划素材库模板"><div class="topbar"><span class="brand">${brand.match(/<span class="brand">([\s\S]*)<\/span>/)?.[1] || ''}</span><span class="top-meta">素材库 · 08 / 25</span></div><div class="main template-library-main"><div class="section-title" data-anim style="--i:1"><span class="eyebrow">功能四 · 规划素材库</span><h2>14个模板，直接切换查看 Markdown 文件</h2><p class="lead" style="margin-top:1.2vh">把常用规划文本的框架、章节、格式和表达要求，整理成可复用、可检索、可被 Agent 调用的模板资产。</p></div><div class="template-library-shell" data-anim="media" style="--i:2"><aside class="template-library-nav" aria-label="规划模板目录"><div class="template-library-nav-head"><strong>模板目录</strong><span id="templateLibraryCount">14 份</span></div><div class="template-library-nav-list" id="templateLibraryNav"></div></aside><article class="template-library-preview"><div class="template-library-preview-head"><div><strong id="templateLibraryTitle">总览通用规范</strong><span id="templateLibraryFile">00_总览通用规范.md</span></div><span class="template-library-status">Markdown · 可滚动查看</span></div><div class="template-library-content" id="templateLibraryContent" tabindex="0"></div></article></div><p class="foot">点击左侧模板即可切换查看；内容已内嵌到汇报HTML中，离线打开也可以浏览14份 Markdown 文件。</p></div></section>`;

if (html.includes('data-title="规划素材库模板"')) throw new Error('规划模板库页面已经存在，停止重复插入');
const marker = '<section class="slide blue" data-layout="S04" data-title="规范与模板蒸馏">';
if (!html.includes(marker)) throw new Error('未找到第7页后的插入位置');

let next = html.replace(marker, `${templateSection}${marker}`);
const css = `<style>
.template-library-main{padding-top:3vh;gap:1.8vh}
.template-library-main .section-title{flex:0 0 auto}
.template-library-main .section-title h2{font-size:min(4.25vw,7.1vh)}
.template-library-shell{display:grid;grid-template-columns:245px minmax(0,1fr);gap:1.4vw;flex:1;min-height:0}
.template-library-nav,.template-library-preview{min-height:0;border:1px solid var(--line);background:rgba(255,253,250,.82);overflow:hidden}
.template-library-nav{display:flex;flex-direction:column}
.template-library-nav-head{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid var(--line);font-size:12px;color:var(--ink)}
.template-library-nav-head span{font-family:var(--mono);font-size:10px;color:var(--accent)}
.template-library-nav-list{overflow:auto;padding:8px}
.template-library-nav button{display:block;width:100%;border:0;border-left:3px solid transparent;background:transparent;color:var(--muted);text-align:left;padding:9px 10px;font-size:12px;line-height:1.25;cursor:pointer;transition:background .18s,color .18s,border-color .18s}
.template-library-nav button:hover{background:var(--accent-soft);color:var(--ink)}
.template-library-nav button.active{border-left-color:var(--accent);background:var(--accent-soft);color:#9d563f;font-weight:600}
.template-library-nav button small{display:block;font-family:var(--mono);font-size:9px;color:#a59c92;margin-bottom:3px}
.template-library-preview{display:flex;flex-direction:column;background:var(--paper2)}
.template-library-preview-head{display:flex;justify-content:space-between;align-items:center;gap:18px;padding:13px 18px;border-bottom:1px solid var(--line);flex:0 0 auto}
.template-library-preview-head strong{display:block;font-family:var(--serif);font-size:24px;font-weight:400;line-height:1.05}
.template-library-preview-head span{display:block;font-family:var(--mono);font-size:10px;color:var(--muted);margin-top:5px}
.template-library-status{white-space:nowrap;color:var(--accent)!important;margin-top:0!important}
.template-library-content{flex:1;min-height:0;overflow:auto;padding:20px 28px 38px;color:#514a44;font-size:13px;line-height:1.62}
.template-library-content h1,.template-library-content h2,.template-library-content h3,.template-library-content h4{font-family:var(--serif);color:var(--ink);letter-spacing:-.025em;line-height:1.2;border-bottom:1px solid var(--line);padding-bottom:8px;margin:0 0 12px}
.template-library-content h1{font-size:30px}.template-library-content h2{font-size:22px;margin-top:22px}.template-library-content h3{font-size:17px;margin-top:18px}.template-library-content h4{font-size:14px;margin-top:15px}
.template-library-content p{margin:0 0 10px;color:#5f5851}.template-library-content ul,.template-library-content ol{padding-left:22px;margin:0 0 12px}.template-library-content li{margin:0 0 4px}.template-library-content strong{color:#3f3934}.template-library-content em{color:#8b675b}.template-library-content code{font-family:var(--mono);font-size:11px;background:#f2ece5;color:#9d563f;padding:2px 5px;border-radius:4px}.template-library-content pre{background:#f3eee8;border:1px solid var(--line);padding:12px 14px;overflow:auto;margin:0 0 14px;font-family:var(--mono);font-size:11px;line-height:1.5}.template-library-content pre code{padding:0;background:transparent;color:#5d554e}.template-library-content blockquote{border-left:3px solid var(--accent);background:#fbf1eb;padding:7px 12px;margin:0 0 12px;color:#77695f}.template-library-content hr{border:0;border-top:1px solid var(--line);margin:18px 0}.template-library-content table{width:100%;border-collapse:collapse;margin:0 0 14px;font-size:11px}.template-library-content th,.template-library-content td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}.template-library-content th{background:#f7efe9;color:#9d563f;font-weight:600}.template-library-content tr:nth-child(even){background:#fdfaf7}
@media(max-width:950px){.template-library-shell{grid-template-columns:190px minmax(0,1fr)}.template-library-preview-head{display:block}.template-library-status{margin-top:7px!important}.template-library-content{padding:16px 18px 30px}}
@media(max-width:700px){.template-library-shell{grid-template-columns:1fr;grid-template-rows:160px minmax(0,1fr)}.template-library-nav-list{display:grid;grid-template-columns:repeat(2,1fr)}.template-library-main .section-title h2{font-size:28px}}
</style>`;
next = next.replace('</style>', `${css}</style>`);

const viewerScript = String.raw`<script>
(() => {
  const templateDocs = ${docsJson};
  const nav = document.getElementById('templateLibraryNav');
  const content = document.getElementById('templateLibraryContent');
  const title = document.getElementById('templateLibraryTitle');
  const file = document.getElementById('templateLibraryFile');
  const viewer = document.querySelector('.template-library-slide');
  if (!nav || !content || !title || !file || !viewer) return;
  const escapeHtml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = value => value.replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
  const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => inline(escapeHtml(cell.trim())));
  const isTableRule = line => /^\|?\s*:?-{3,}/.test(line.trim());
  function renderMarkdown(source) {
    const lines = source.replace(/\r/g, '').split('\n');
    const out = [];
    let inCode = false;
    let codeLines = [];
    let listType = null;
    const closeList = () => { if (listType) { out.push('</' + listType + '>'); listType = null; } };
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      const line = raw.trimEnd();
      if (/^\s*\x60\x60\x60/.test(line)) { if (inCode) { out.push('<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>'); codeLines = []; inCode = false; } else { closeList(); inCode = true; } continue; }
      if (inCode) { codeLines.push(raw); continue; }
      if (!line.trim()) { closeList(); continue; }
      const tableNext = lines[i + 1] || '';
      if (line.includes('|') && isTableRule(tableNext)) {
        closeList();
        const header = cells(line);
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(cells(lines[i])); i += 1; }
        i -= 1;
        out.push('<table><thead><tr>' + header.map(cell => '<th>' + cell + '</th>').join('') + '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map(cell => '<td>' + cell + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
        continue;
      }
      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      if (heading) { closeList(); const level = heading[1].length; out.push('<h' + level + '>' + inline(escapeHtml(heading[2])) + '</h' + level + '>'); continue; }
      if (/^\s*---+\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }
      const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (bullet || ordered) { const type = bullet ? 'ul' : 'ol'; if (listType !== type) { closeList(); out.push('<' + type + '>'); listType = type; } out.push('<li>' + inline(escapeHtml((bullet || ordered)[1])) + '</li>'); continue; }
      if (/^\s*>\s?/.test(line)) { closeList(); out.push('<blockquote>' + inline(escapeHtml(line.replace(/^\s*>\s?/, ''))) + '</blockquote>'); continue; }
      closeList();
      out.push('<p>' + inline(escapeHtml(line)) + '</p>');
    }
    if (inCode) out.push('<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>');
    closeList();
    return out.join('');
  }
  function selectTemplate(index) {
    const doc = templateDocs[index];
    if (!doc) return;
    title.textContent = doc.label;
    file.textContent = doc.file;
    content.innerHTML = renderMarkdown(doc.md);
    content.scrollTop = 0;
    nav.querySelectorAll('button').forEach((button, buttonIndex) => button.classList.toggle('active', buttonIndex === index));
  }
  templateDocs.forEach((doc, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.innerHTML = '<small>' + String(index + 1).padStart(2, '0') + '</small>' + doc.label;
    button.addEventListener('click', () => selectTemplate(index));
    nav.appendChild(button);
  });
  viewer.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
  viewer.addEventListener('touchstart', event => event.stopPropagation(), { passive: true });
  viewer.addEventListener('touchend', event => event.stopPropagation(), { passive: true });
  viewer.addEventListener('keydown', event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', ' '].includes(event.key)) event.stopPropagation(); });
  selectTemplate(1);
})();
</script>`;
next = next.replace('</body>', `${viewerScript}</body>`);
next = next.replace('24 页 · 暖白展示版', '25 页 · 暖白展示版');
fs.writeFileSync(htmlPath, next, 'utf8');
console.log(`已新增规划模板库页面，并内嵌${docs.length}份Markdown文件`);
