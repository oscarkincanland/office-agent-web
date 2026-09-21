/**
 * docx 渲染后的"按 Word 页面高度重新分页"。
 *
 * 背景：docx-preview 的 breakPages 只会按文档里保存的 w:lastRenderedPageBreak（Word
 * 上次排版写入的提示）和显式分页符切分。由 Office CLI / python-docx 生成的文档通常没有
 * 这些提示，于是整段内容会挤在一张超长"纸"上（本项目的说明书实测 9645px、25333px），
 * 看起来完全不像 Word 分页。
 *
 * 这里在渲染完成后做一次二次排版：
 *  1. 保留文档原有的显式分页与每节页面尺寸（section 上由 docx-preview 写入的
 *     width/min-height/padding 决定），只拆不合并；
 *  2. 超过一页高度的段落流按块级元素边界拆进新页面，段落、图片不会被劈成两半；
 *  3. 超高表格按行拆分，并在续页重复表头（与 Word 的跨页表格一致）。
 *
 * 页面结构沿用 docx-preview 的形状：section（页）> article（正文容器）> 块级元素。
 */

const PAGE_TOLERANCE_PX = 2; // 允许 2px 误差，避免因为四舍五入多分出一张几乎空白的纸

/** 取一页的几何：页高、内边距、正文可用高度 */
function pageGeometry(section) {
  const cs = getComputedStyle(section);
  const pageHeight = parseFloat(cs.minHeight) || parseFloat(cs.height) || 1123;
  const padTop = parseFloat(cs.paddingTop) || 0;
  const padBottom = parseFloat(cs.paddingBottom) || 0;
  return { pageHeight, padTop, padBottom, contentHeight: Math.max(120, pageHeight - padTop - padBottom) };
}

/** 复制一个空白页面（结构与首页一致，保留 docx-preview 写入的内联样式） */
function createPageLike(template, articleTemplate) {
  const doc = template.ownerDocument;
  const section = doc.createElement("section");
  section.setAttribute("class", template.getAttribute("class") || "");
  section.setAttribute("style", template.getAttribute("style") || "");
  const article = doc.createElement("article");
  if (articleTemplate) article.setAttribute("style", articleTemplate.getAttribute("style") || "");
  section.appendChild(article);
  return { section, article };
}

/** 一次性读取所有块的高度与边距（读取期间不改动 DOM，避免反复强制排版） */
function measureBlocks(blocks) {
  return blocks.map((el) => {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      el,
      height: rect.height,
      marginTop: parseFloat(cs.marginTop) || 0,
      marginBottom: parseFloat(cs.marginBottom) || 0,
      absolute: cs.position === "absolute" || cs.position === "fixed",
    };
  });
}

/**
 * 把超高表格按行拆成多张表：第一张放在当前页剩余空间里，后续每张占满一页，
 * 并在每张表上重复表头（thead）与列宽（colgroup）。
 * @returns {{element: HTMLElement, height: number}[]}
 */
function splitTallTable(table, firstChunkBudget, pageContentHeight) {
  // 注意：docx-preview 生成的表格可能没有 tbody，行直接挂在 table 下，
  // 所以这里用 table.rows（含 thead 行）再排除表头，而不是只看 tBodies[0]。
  const bodyRows = [...table.rows].filter((row) => !row.closest("thead"));
  if (bodyRows.length === 0) return [{ element: table, height: table.getBoundingClientRect().height }];
  const thead = table.tHead;
  const headerHeight = thead ? thead.getBoundingClientRect().height : 0;
  const rowHeights = bodyRows.map((row) => row.getBoundingClientRect().height);
  const usesTbody = table.tBodies.length > 0;

  const shell = () => {
    const clone = table.cloneNode(false); // 只复制 table 标签本身的属性/内联样式
    for (const child of table.children) {
      if (child.tagName === "COLGROUP" || child.tagName === "THEAD") clone.appendChild(child.cloneNode(true));
    }
    let holder = clone;
    if (usesTbody) {
      holder = table.ownerDocument.createElement("tbody");
      clone.appendChild(holder);
    }
    return { table: clone, holder };
  };

  const pieces = [];
  let current = shell();
  let currentHeight = headerHeight;
  let currentRows = 0;
  let budget = Math.max(pageContentHeight * 0.35, firstChunkBudget);
  for (let i = 0; i < bodyRows.length; i += 1) {
    const rowHeight = rowHeights[i];
    if (currentRows > 0 && currentHeight + rowHeight > budget + PAGE_TOLERANCE_PX) {
      pieces.push({ element: current.table, height: currentHeight });
      current = shell();
      currentHeight = headerHeight;
      currentRows = 0;
      budget = pageContentHeight;
    }
    current.holder.appendChild(bodyRows[i]);
    currentHeight += rowHeight;
    currentRows += 1;
  }
  pieces.push({ element: current.table, height: currentHeight });
  return pieces;
}

/**
 * 把一节的块级内容按页面高度排版成多页。
 * 注意：docx-preview 会在一个 section 里放多个 article（没有分页提示时会把几页内容
 * 堆进同一张纸），所以要按 DOM 顺序收集所有 article 的子元素再重排。
 * @returns {{section: HTMLElement, article: HTMLElement}[]} 页面（按顺序）
 */
function splitSection(section, geometry) {
  const articles = [...section.querySelectorAll(":scope > article")];
  const blocks = [];
  for (const article of articles.length ? articles : [section]) blocks.push(...article.children);
  if (blocks.length === 0) return [{ section, article: articles[0] || section }];

  const metrics = measureBlocks(blocks);
  const flowHeight = metrics.reduce((sum, item) => sum + (item.absolute ? 0 : item.height + Math.max(item.marginTop, item.marginBottom)), 0);
  // 一页装得下，且没有 docx-preview 多出来的 article：原样保留
  if (flowHeight <= geometry.contentHeight + PAGE_TOLERANCE_PX && articles.length <= 1) {
    return [{ section, article: articles[0] || section }];
  }

  const pages = [];
  let page = createPageLike(section, articles[0]);
  pages.push(page);
  let used = 0;
  let previousMarginBottom = 0;

  const newPage = () => {
    page = createPageLike(section, articles[0]);
    pages.push(page);
    used = 0;
    previousMarginBottom = 0;
  };

  const place = (el, height, marginTop, marginBottom) => {
    const gap = used > 0 ? Math.max(previousMarginBottom, marginTop) : Math.min(marginTop, 0);
    if (used > 0 && used + gap + height > geometry.contentHeight + PAGE_TOLERANCE_PX) {
      newPage();
      page.article.appendChild(el);
      used = height; // 新页页首：正的段前距与页边距折叠，不计入
      previousMarginBottom = marginBottom;
      return;
    }
    page.article.appendChild(el);
    used += gap + height;
    previousMarginBottom = marginBottom;
  };

  for (const item of metrics) {
    if (item.absolute) {
      // 浮动/绝对定位元素跟着当前页走，不占正文高度
      page.article.appendChild(item.el);
      continue;
    }
    if (item.el.tagName === "TABLE" && item.height > geometry.contentHeight + PAGE_TOLERANCE_PX) {
      // 一页放不下的表格按行拆；第一段用当前页剩余空间
      const remaining = geometry.contentHeight - (used > 0 ? used : Math.max(item.marginTop, 0));
      for (const piece of splitTallTable(item.el, remaining, geometry.contentHeight)) {
        place(piece.element, piece.height, item.marginTop, item.marginBottom);
      }
      continue;
    }
    place(item.el, item.height, item.marginTop, item.marginBottom);
  }

  return pages;
}

/**
 * 入口：重新分页整个预览容器。
 * @param {HTMLElement} host .oaw-docx-host
 * @returns {{before:number, after:number}} 分页前后的页数
 */
export function repaginateDocx(host) {
  const wrapper = host?.querySelector(".oaw-docx-wrapper");
  if (!wrapper) return { before: 0, after: 0 };
  const sections = [...wrapper.querySelectorAll(":scope > section")];
  if (sections.length === 0) return { before: 0, after: 0 };

  const nextPages = [];
  for (const section of sections) {
    // 每节的页面尺寸/页边距可能不同（横版、附录），按自己的几何拆分
    for (const page of splitSection(section, pageGeometry(section))) nextPages.push(page);
  }

  // 有变化时才重建 DOM：先挂新页再移除旧页，避免闪烁
  const changed = nextPages.length !== sections.length || nextPages.some((item, index) => item.section !== sections[index]);
  if (changed) {
    const fragment = wrapper.ownerDocument.createDocumentFragment();
    for (const item of nextPages) fragment.appendChild(item.section);
    wrapper.appendChild(fragment);
    for (const section of sections) {
      if (!nextPages.some((item) => item.section === section)) section.remove();
    }
  }

  const finalSections = [...wrapper.querySelectorAll(":scope > section")];
  finalSections.forEach((section, index) => { section.dataset.page = String(index + 1); });
  return { before: sections.length, after: finalSections.length };
}
