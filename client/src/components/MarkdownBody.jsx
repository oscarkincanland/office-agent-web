import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import rehypeSlug from "rehype-slug";
import "highlight.js/styles/github-dark.css";
import "katex/dist/katex.min.css";

/**
 * 统一 Markdown 渲染组件（聊天消息 + MD 文档共用）
 * 插件：GFM 表格/任务列表、数学公式(KaTeX)、代码高亮(highlight.js)、标题锚点
 */
export default function MarkdownBody({ children, className = "" }) {
  return (
    <div className={`markdown-body ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeHighlight, rehypeSlug]}
        components={{
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
          // 链接：新窗口打开
          a: ({ href, children: kids }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">{kids}</a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
