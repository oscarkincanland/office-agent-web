import React, { useMemo, useState } from "react";
import Icon from "./Icon.jsx";
import { completionLabel } from "../运行轨迹.js";

// 工具 → 脑图分支分类
const TOOL_CATEGORY = {
  read: "读取", grep: "读取", find: "读取", ls: "读取",
  kb_search: "读取", kb_read: "读取", skills_search: "读取", skills_read: "读取", context_read: "读取", map_read: "读取",
  write: "写入", edit: "写入", officecli: "写入", map_edit: "写入", map_import: "写入",
  bash: "命令",
  map_analyze: "分析", map_save_analysis: "分析", map_clear_analysis: "分析",
  ask_user: "协作", todo: "协作", memory_update: "协作", complete_task: "协作",
};
const CATEGORY_ORDER = ["读取", "写入", "命令", "分析", "协作"];
const CATEGORY_ICON = { 读取: "file", 写入: "edit", 命令: "terminal", 分析: "chart", 协作: "comment" };

const PHASE_LABEL = {
  idle: "等待",
  planning: "理解任务",
  preparing: "理解任务",
  executing: "执行中",
  verifying: "验收中",
  delivering: "整理产物",
  finishing: "整理产物",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function categoryOf(tool) {
  return TOOL_CATEGORY[String(tool?.name || "").toLowerCase()] || "协作";
}

function branchStatus(tools) {
  if (tools.some((tool) => tool.status !== "done")) return "running";
  if (tools.some((tool) => tool.isError)) return "error";
  return "ok";
}

function formatElapsed(trace, running) {
  const start = trace?.startedAt ? Date.parse(trace.startedAt) : 0;
  const end = trace?.endedAt ? Date.parse(trace.endedAt) : (running ? Date.now() : 0);
  if (!start || !end || end < start) return "";
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60 ? `${seconds % 60}s` : ""}`;
}

/**
 * Agent 脑回路执行图：把 RunTrace 渲染为“脑核 + 分支”的执行轨迹。
 * 只展示真实事件（工具调用、错误、完成状态），不展示模型隐藏思维链原文；
 * 点击分支展开工具列表，点击工具可在消息流中定位到对应工具卡。
 */
export default function AgentBrainGraph({ trace, running = false, onFocusTool }) {
  const [openBranch, setOpenBranch] = useState(null);

  const branches = useMemo(() => {
    const tools = Array.isArray(trace?.tools) ? trace.tools : [];
    const groups = new Map();
    for (const tool of tools) {
      const category = categoryOf(tool);
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(tool);
    }
    return CATEGORY_ORDER
      .filter((category) => groups.has(category))
      .map((category) => ({ category, tools: groups.get(category), status: branchStatus(groups.get(category)) }));
  }, [trace]);

  if (!trace) return null;
  const hasContent = branches.length > 0 || (trace.errors || []).length > 0 || trace.completion || trace.startedAt;
  if (!hasContent) return null;

  const completion = trace.completion;
  const phaseLabel = completion
    ? completionLabel(completion.status)
    : PHASE_LABEL[trace.phase] || trace.phase;
  const elapsed = formatElapsed(trace, running);

  return (
    <div className={`brain-graph ${running ? "live" : ""}`}>
      <div className="brain-row">
        <div className={`brain-core ${completion ? completion.status : (running ? "running" : "idle")}`}>
          <span className="brain-core-dot" />
          <span className="brain-core-label">{phaseLabel}</span>
          {elapsed && <span className="brain-core-time">{elapsed}</span>}
        </div>
        <div className="brain-arrows" aria-hidden="true">→</div>
        <div className="brain-branches">
          {branches.map(({ category, tools, status }) => (
            <button
              type="button"
              key={category}
              className={`brain-branch ${status} ${openBranch === category ? "open" : ""}`}
              onClick={() => setOpenBranch(openBranch === category ? null : category)}
              title={`${category}类工具 ${tools.length} 次`}
            >
              <Icon name={CATEGORY_ICON[category] || "flow"} size={11} />
              <span>{category}</span>
              <b>×{tools.length}</b>
            </button>
          ))}
          {(trace.errors || []).length > 0 && (
            <span className="brain-branch static error" title={(trace.errors || []).map((item) => item.message).join("\n")}>
              <Icon name="x" size={11} /><span>错误</span><b>×{trace.errors.length}</b>
            </span>
          )}
          {(trace.files || []).length > 0 && (
            <span className="brain-branch static ok" title={(trace.files || []).join("\n")}>
              <Icon name="folder" size={11} /><span>文件</span><b>×{trace.files.length}</b>
            </span>
          )}
        </div>
        <div className="brain-arrows" aria-hidden="true">→</div>
        <div className={`brain-outcome ${completion ? completion.status : (running ? "running" : "idle")}`}>
          {completion ? completionLabel(completion.status) : (running ? "执行中…" : "待收尾")}
        </div>
      </div>
      {openBranch && (
        <div className="brain-tool-list">
          {(branches.find((item) => item.category === openBranch)?.tools || []).map((tool) => (
            <button
              type="button"
              key={tool.id}
              className={`brain-tool ${tool.status !== "done" ? "running" : tool.isError ? "error" : "ok"}`}
              onClick={() => onFocusTool?.(tool.toolCallId || tool.id)}
              title={tool.result || tool.output || tool.input || ""}
            >
              {tool.name}
              {tool.startMissing ? "（已恢复）" : ""}
              {tool.status !== "done" ? "…" : tool.isError ? " ✕" : " ✓"}
            </button>
          ))}
        </div>
      )}
      {completion?.summary && (
        <div className="brain-summary" title={completion.summary}>
          {completion.source === "inferred" ? "（推断）" : ""}{completion.summary}
        </div>
      )}
    </div>
  );
}
