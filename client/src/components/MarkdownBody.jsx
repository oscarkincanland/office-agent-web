import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import rehypeSlug from "rehype-slug";
import remarkToc from "remark-toc";
import "highlight.js/styles/github-dark.css";
import "katex/dist/katex.min.css";

/**
 * 统一 Markdown 渲染组件（聊天消息 + MD 文档共用）
 * 插件：GFM 表格/任务列表、数学公式(KaTeX)、代码高亮(highlight.js)、标题锚点、自动目录
 * onTagClick：可选，提供时把行内 #tag 渲染为可点击元素（知识库文档预览用）
 * onWikilinkHover：可选，提供时把 [[目标]] 渲染为可悬浮预览的链接（知识库文档预览用）
 */
export default function MarkdownBody({ children, className = "", withToc = false, onTagClick, onWikilinkHover }) {
  // 预处理：[[目标]] → 内部 wikilink 标记链接（保留显示文本，供 a 组件拦截渲染）
  const processed = useMemo(() => {
    if (!onWikilinkHover) return children;
    return String(children).replace(/\[\[([^\]]+)\]\]/g, (_, target) => {
      const label = target.split("|")[0] || target;
      return `[${label}](#wikilink:${encodeURIComponent(target)})`;
    });
  }, [children, onWikilinkHover]);

  return (
    <div className={`markdown-body ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, ...(withToc ? [[remarkToc, { maxDepth: 3 }]] : [])]}
        rehypePlugins={[rehypeKatex, rehypeHighlight, rehypeSlug]}
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
          // 链接：[[目标]] 悬浮预览（知识库）；普通链接新窗口打开
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
            return <a href={href} target="_blank" rel="noopener noreferrer">{kids}</a>;
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
