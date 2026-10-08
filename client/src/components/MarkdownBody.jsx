import React, { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeSlug from "rehype-slug";
import remarkToc from "remark-toc";
import Icon from "./Icon.jsx";
import { buildArtifactIndex, resolveArtifactTarget, normalizeLocalFileHref } from "../产物类型.js";

/**
 * 统一 Markdown 渲染组件（聊天消息 + MD 文档共用）
 * 插件：GFM 表格/任务列表、数学公式(KaTeX)、代码高亮(highlight.js)、标题锚点、自动目录
 * onTagClick：可选，提供时把行内 #tag 渲染为可点击元素（知识库文档预览用）
 * onWikilinkHover：可选，提供时把 [[目标]] 渲染为可悬浮预览的链接（知识库文档预览用）
 * onOpenFile / artifacts：可选，提供时把本轮产物内嵌到正文里 —— 产物的文件名、
 *   指向本地文件的 Markdown 链接与行内代码都渲染为可点击文件条，点击直接打开预览。
 *
 * 性能：KaTeX 与 highlight.js 体积大（约 1MB+），改为异步加载并按需启用：
 * 首屏先用轻量 Markdown 渲染，插件就绪后再补齐公式与代码高亮，避免拖慢启动。
 */
let heavyPluginsPromise = null;
function loadHeavyPlugins() {
  if (!heavyPluginsPromise) {
    heavyPluginsPromise = Promise.all([
      import("rehype-katex"),
      import("rehype-highlight"),
      import("highlight.js/styles/github-dark.css"),
      import("katex/dist/katex.min.css"),
    ])
      .then(([katexModule, highlightModule]) => ({
        katex: katexModule.default,
        highlight: highlightModule.default,
      }))
      .catch(() => null);
  }
  return heavyPluginsPromise;
}

/**
 * 把正文里提到的产物名（文件名或相对路径）转成 `[名称](#artifact:路径)`。
 * 只处理“散文”段：围栏代码、行内代码、已有链接/图片、HTML 标签、数学公式都跳过；
 * 行内代码里若整个内容就是一个产物名，也转成文件条（常见于 `report.docx` 写法）。
 * 匹配带边界检查，避免把 `总数据.docx` 里的 `数据.docx` 误判成本轮产物。
 */
function linkifyArtifactMentions(source, index) {
  if (!source || !index?.list.length) return source;
  const candidates = [];
  for (const item of index.list) {
    candidates.push(item.path, item.name);
  }
  const unique = [...new Set(candidates.filter(Boolean))].sort((a, b) => b.length - a.length);
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(unique.map(escapeRegExp).join("|"), "gi");
  const asLink = (item, label) => `[${label || item.name}](#artifact:${encodeURIComponent(item.path)})`;
  const replaceInProse = (text) => text.replace(matcher, (match, offset, whole) => {
    const before = whole[offset - 1] || "";
    const after = whole[offset + match.length] || "";
    // 前后是路径/标识符延续字符时不替换：属于更长的一段名字或路径
    if (/[A-Za-z0-9_\-.]/.test(before)) return match;
    if (/[A-Za-z0-9_\-.]/.test(after)) return match;
    const item = resolveArtifactTarget(match, index);
    return item ? asLink(item, match) : match;
  });
  // 单次扫描切分：token = 需要原样保留（或整段替换）的 markdown 结构
  const token = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|!\[[^\]]*\]\([^)\n]*\)|\[[^\]\n]*\]\([^)\n]*\)|<[^>\n]*>|\$\$[\s\S]*?\$\$|\$[^$\n]*\$)/g;
  let result = "";
  let lastIndex = 0;
  let match;
  while ((match = token.exec(source))) {
    result += replaceInProse(source.slice(lastIndex, match.index));
    const piece = match[0];
    const inlineCode = piece.length > 1 && piece.startsWith("`") && piece.endsWith("`") && !piece.startsWith("```") && !piece.startsWith("~~~");
    const codeBody = inlineCode ? piece.slice(1, -1).trim() : "";
    const artifact = codeBody ? resolveArtifactTarget(codeBody, index) : null;
    result += artifact ? asLink(artifact, artifact.name) : piece;
    lastIndex = match.index + piece.length;
  }
  result += replaceInProse(source.slice(lastIndex));
  return result;
}

/** 行内产物文件条：图标 + 名称 + 大小，点击交给调用方打开预览。 */
function ArtifactFileChip({ path, label, artifact, onOpenFile }) {
  const item = artifact || { path, name: label, typeLabel: "", sizeText: "" };
  const name = label || item.name || item.path;
  const title = item.path ? `${item.path}${item.typeLabel ? ` · ${item.typeLabel}` : ""}` : name;
  return (
    <button
      type="button"
      className="artifact-inline"
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); onOpenFile?.(item.path || path); }}
      title={`打开 ${title}`}
    >
      <Icon name={item.icon || "file"} size={12} className={`artifact-kind-${item.icon || "file"}`} />
      <span className="artifact-inline-name">{name}</span>
      {item.sizeText && <span className="artifact-inline-size">{item.sizeText}</span>}
    </button>
  );
}

export default function MarkdownBody({ children, className = "", withToc = false, onTagClick, onWikilinkHover, onOpenFile, artifacts }) {
  const [heavyPlugins, setHeavyPlugins] = useState(null);

  useEffect(() => {
    let cancelled = false;
    loadHeavyPlugins().then((plugins) => {
      if (!cancelled && plugins) setHeavyPlugins(plugins);
    });
    return () => { cancelled = true; };
  }, []);

  const artifactIndex = useMemo(() => (onOpenFile && artifacts?.length ? buildArtifactIndex(artifacts) : null), [onOpenFile, artifacts]);

  // 预处理：[[目标]] → 内部 wikilink 标记链接（保留显示文本，供 a 组件拦截渲染）
  // 以及把正文里提到的本轮产物转成 #artifact: 链接（同样由 a 组件渲染为文件条）。
  const processed = useMemo(() => {
    const source = String(children ?? "");
    const withWikilinks = onWikilinkHover
      ? source.replace(/\[\[([^\]]+)\]\]/g, (_, target) => {
        const label = target.split("|")[0] || target;
        return `[${label}](#wikilink:${encodeURIComponent(target)})`;
      })
      : source;
    if (!artifactIndex?.list.length) return withWikilinks;
    return linkifyArtifactMentions(withWikilinks, artifactIndex);
  }, [children, onWikilinkHover, artifactIndex]);

  const rehypePlugins = useMemo(() => {
    const plugins = [];
    if (heavyPlugins?.katex) plugins.push(heavyPlugins.katex);
    if (heavyPlugins?.highlight) plugins.push(heavyPlugins.highlight);
    plugins.push(rehypeSlug);
    return plugins;
  }, [heavyPlugins]);

  return (
    <div className={`markdown-body ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, ...(withToc ? [[remarkToc, { maxDepth: 3 }]] : [])]}
        rehypePlugins={rehypePlugins}
        components={{
          // 行内 #tag → 可点击（仅知识库模式启用，排除 hex 颜色/纯数字）
          text: ({ children: kids }) => {
            if (!onTagClick) return kids;
            const text = String(kids);
            const parts = text.split(/(#[\p{L}\p{N}_-]+)/gu);
            if (parts.length === 1) return text;
            return parts.map((p, i) => {
              if (i % 2 === 1) {
                const t = p.slice(1);
                if (/^\d/.test(t) || /^[0-9a-fA-F]{3,8}$/.test(t)) return p; // 排除颜色/数字
                return <span key={i} className="md-tag" onClick={(e) => { e.stopPropagation(); onTagClick(t); }}>{p}</span>;
              }
              return p;
            });
          },
          // 表格容器：允许横向滚动
          table: ({ children: kids }) => (
            <div className="md-table-wrap">
              <table>{kids}</table>
            </div>
          ),
          // 图片：最大宽度 + 圆角
          img: ({ src, alt }) => (
            <img src={src} alt={alt} loading="lazy" className="md-img" />
          ),
          // 链接：[[目标]] 悬浮预览（知识库）；本轮产物 → 行内文件条；普通链接新窗口打开
          a: ({ href, children: kids }) => {
            if (href?.startsWith("#wikilink:")) {
              const target = decodeURIComponent(href.slice(10));
              return (
                <span
                  className="kb-wikilink"
                  onMouseEnter={(e) => onWikilinkHover?.(target, e)}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onWikilinkHover?.(target, e); }}
                >{kids}</span>
              );
            }
            if (onOpenFile) {
              if (href?.startsWith("#artifact:")) {
                const target = decodeURIComponent(href.slice(10));
                const artifact = resolveArtifactTarget(target, artifactIndex);
                return <ArtifactFileChip path={target} artifact={artifact} onOpenFile={onOpenFile} />;
              }
              // 指向工作区文件的普通链接（模型自己写的相对路径）也走预览，不再新开标签页 404。
              const localTarget = normalizeLocalFileHref(href);
              if (localTarget) {
                const artifact = resolveArtifactTarget(localTarget, artifactIndex);
                const label = typeof kids === "string" ? kids : "";
                return <ArtifactFileChip path={localTarget} artifact={artifact} label={label} onOpenFile={onOpenFile} />;
              }
            }
            return <a href={href} target="_blank" rel="noopener noreferrer">{kids}</a>;
          },
          // 行内代码：整段就是一个本地产物文件名时，同样渲染为文件条（正常内容保持不变）。
          code: ({ node, children: kids, ...props }) => {
            const text = typeof kids === "string"
              ? kids
              : Array.isArray(kids) && kids.every((k) => typeof k === "string") ? kids.join("") : "";
            if (onOpenFile && text && !String(props.className || "").includes("language-")) {
              const artifact = resolveArtifactTarget(text.trim(), artifactIndex);
              if (artifact) return <ArtifactFileChip artifact={artifact} onOpenFile={onOpenFile} />;
            }
            return <code {...props}>{kids}</code>;
          },
          // 代码块：复制按钮
          pre: ({ children: kids }) => (
            <div className="md-code-wrap">
              {kids}
            </div>
          ),
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
}
