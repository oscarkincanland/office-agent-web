---
name: echart
description: ECharts 图表生成 - 根据需求自动识别图表类型并生成配置代码
metadata:
  type: skill
---

# ECharts 示例搜索与代码生成

根据用户需求，AI 自动识别适合的图表类型，用户确认后生成配置代码。

## 自动识别逻辑

当用户描述需求时，AI 自动推断图表类型：

| 需求关键词（模糊匹配） | 推断图表 | 备选 |
|----------------------|---------|-----|
| 趋势、变化、走势、随时间 | 折线图 | 面积图、柱状图 |
| 比较、大小、多少、高低 | 柱状图 | 环形图、条形图 |
| 占比、份额、比例、百分比、部分与整体 | 饼图 | 环形图、堆叠柱状图 |
| 分布、散开、聚集、相关性 | 散点图 | 折线图（带趋势线） |
| 最高、最低、股票、K线、涨跌 | K线图 | 柱状图（涨跌色） |
| 排名、排序、TOP、第一名 | 柱状图排名 | 条形图、堆叠图 |
| 流向、转化、桑基、能量 | 桑基图 | 旭日图、堆叠图 |
| 层次、包含、分类、构成 | 旭日图 | 矩形树图、饼图 |
| 仪表、进度、刻度、监测 | 仪表盘 | 环形进度条 |
| 地理、地图、区域、省份、城市 | 地图 | 散点图（带坐标） |
| 网络、关系、社交、连接 | 关系图 | 桑基图 |
| 日程、日历、时间、热力 | 日历热力图 | 热力图 |
| 统计、箱线、离散、异常值 | 箱线图 | 直方图 |

**模糊场景处理**：AI 列出 2-3 个候选图表（如"可能是折线图展示趋势，也可用柱状图对比"），让用户选。

## 支持的图表类型

### 折线图 (Line)
- `line-simple` - 简单折线图
- `line-stack` - 堆叠折线图
- `line-area` - 面积图
- `line-smooth` - 平滑曲线
- `line-gradient` - 渐变折线图
- `line-race` - 赛跑图
- `line-step` - 阶梯图
- `line-polar` - 极坐标折线图

### 柱状图 (Bar)
- `bar-simple` - 简单柱状图
- `bar-stack` - 堆叠柱状图
- `bar-negative` - 正负柱状图
- `bar-waterfall` - 瀑布图 (新建示例)
- `bar-histogram` - 直方图
- `bar-race` - 动态排名柱状图
- `bar-drilldown` - 下钻柱状图
- `bar-polar-stack` - 极坐标堆叠柱状图
- `bar-rich-text` - 富文本标签

### 饼图 (Pie)
- `pie-simple` - 简单饼图
- `pie-doughnut` - 环形图
- `pie-rose` - 南丁格尔玫瑰图
- `pie-label` - 标签显示
- `pie-rich-text` - 富文本标签
- `pie-nest` - 嵌套饼图

### 散点图 (Scatter)
- `scatter-simple` - 简单散点图
- `scatter-effect` - 涟漪效果散点图
- `scatter-large` - 大数据散点图
- `scatter-clustering` - 聚类散点图
- `scatter-map` - 地图散点图

### 雷达图 (Radar)
- `radar-custom` - 自定义雷达图
- `radar-multiple` - 多雷达图
- `radar-aqi` - 空气质量雷达

### 地图 (Map/Geo)
- `map-simple` - 简单地图
- `geo-choropleth` - 分级着色地图
- `geo-lines` - 地图飞线

### 树图 (Tree)
- `tree-basic` - 基础树图
- `tree-radial` - 径向树图
- `tree-orient` - 方向树图

### 矩形树图 (Treemap)
- `treemap-simple` - 简单矩形树图
- `treemap-drill-down` - 下钻矩形树图
- `treemap-obama` - 奥巴马预算案

### 旭日图 (Sunburst)
- `sunburst-simple` - 简单旭日图
- `sunburst-label` - 标签旋转

### 桑基图 (Sankey)
- `sankey-simple` - 简单桑基图
- `sankey-levels` - 多层桑基图

### 关系图 (Graph)
- `graph-simple` - 简单关系图
- `graph-force` - 力导向图
- `graph-circular` - 圆形布局

### 仪表盘 (Gauge)
- `gauge-simple` - 简单仪表盘
- `gauge-speed` - 速度仪表
- `gauge-clock` - 时钟
- `gauge-progress` - 进度条

### 漏斗图 (Funnel)
- `funnel-customize` - 自定义漏斗图
- `funnel-align` - 对齐漏斗图

### K线图/蜡烛图 (Candlestick)
- `candlestick-simple` - 简单K线图
- `candlestick-brush` - 选择刷

### 箱线图 (Boxplot)
- `boxplot-simple` - 简单箱线图
- `boxplot-multi` - 多维箱线图

### 热力图 (Heatmap)
- `heatmap-simple` - 简单热力图
- `heatmap-cartesian` - 直角坐标系热力图
- `heatmap-large` - 大数据热力图

### 日历图 (Calendar)
- `calendar-simple` - 简单日历图
- `calendar-heatmap` - 日历热力图

### 平行坐标系 (Parallel)
- `parallel-simple` - 简单平行坐标
- `parallel-aqi` - 空气质量

### 弦图 (Chord)
- `chord-simple` - 简单弦图
- `chord-style` - 样式弦图

## 使用方式

当用户描述需要某种图表时：
1. 识别图表类型
2. 根据需求特点匹配最适合的示例
3. 生成完整的 ECharts 配置代码
4. 提供可运行的 HTML 示例

## 示例匹配规则

| 需求关键词 | 推荐图表 |
|-----------|---------|
| 趋势、变化、随时间变化 | 折线图 (line-*) |
| 比较、大小排序 | 柱状图 (bar-*) |
| 占比、份额、部分与整体 | 饼图 (pie-*) |
| 关联、关系、网络 | 散点图 / 关系图 |
| 地理、位置、区域 | 地图 (geo-*) |
| 层次、包含、分类 | 矩形树图 / 旭日图 |
| 流向、转化、过程 | 桑基图 (sankey-*) |
| 仪表、刻度、监测 | 仪表盘 (gauge-*) |
| 最高最低收盘、股票 | K线图 (candlestick-*) |
| 分布、统计、集中度 | 热力图 / 箱线图 |
| 日程、计划、日历 | 日历图 (calendar-*) |

## 交互式问题收集

当用户描述不明确时，用 `AskUserQuestion` 依次提问：

1. **图表类型**：`bar` / `line` / `pie` / `scatter` / 其他
2. **数据维度**：一维（单系列） / 多维（多系列对比）
3. **是否时间序列**：是 / 否
4. **特殊需求**：堆叠 / 动画 / 深色模式 / 交互

**示例对话**：
```
用户："做个图展示数据"
Agent: "需要什么类型的图表？"
用户："柱状图"
Agent: "要展示几个系列的数据？"
用户："3个系列对比"
Agent: "时间轴还是固定类别？"
用户："时间轴"
Agent: 生成带时间轴的多系列堆叠柱状图
```

## 常见问题速查