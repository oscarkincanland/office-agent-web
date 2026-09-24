import React from "react";
import Icon from "./Icon.jsx";
import { toolIdentity } from "../事件展示.js";

/**
 * 工具语义图标（P3）：按 tool.name 渲染“能力类别”图标。
 *
 * 与状态徽记分工：语义图标表达“用的是什么能力”（思维/搜索/读文件/写文件/终端/
 * 浏览器/Office/知识库/审批/通用图标）；运行中/成功/失败仍由 ToolCard 的状态徽记表达。
 * 映射集中在 事件展示.js 的 toolIdentity，未知工具回退通用图标并保留文字名称。
 */
export default function ToolIdentityIcon({ name, size = 13, className = "" }) {
  const { icon, category } = toolIdentity(name);
  return (
    <Icon
      name={icon}
      size={size}
      className={`tool-identity tool-identity-${category}${className ? ` ${className}` : ""}`}
    />
  );
}
