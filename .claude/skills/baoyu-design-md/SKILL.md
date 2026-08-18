---
name: baoyu-design-md
description: DESIGN.md 设计风格库 - 从 73 个知名品牌中选取设计语言，生成风格一致的 UI
metadata:
  type: skill
---

# DESIGN.md 设计风格库

本 skills 收录了 73 个知名品牌/产品的 DESIGN.md 文件（来自 awesome-design-md 项目），可以直接套用主流品牌的设计语言来生成 UI。

## 文件位置

所有 DESIGN.md 文件位于当前 skill 的 `templates/design-md/<品牌名>/DESIGN.md`。

## 核心交互流程

当用户调用本 skill 且没有明确指定品牌时，**必须先通过 AskUserQuestion 收集需求**，再推荐风格。

### 第一步：收集需求（用 AskUserQuestion）

按顺序依次用 AskUserQuestion 提问，**每次只问一个问题**，等用户回答后再问下一个：

**Q1 — 项目类型**
```
header: 项目类型
question: 你的项目属于什么类型？
options:
  - AI / LLM 产品
  - 开发者工具 / IDE
  - SaaS / B2B 企业级应用
  - 电商 / 消费平台
  - 金融 / Crypto
  - 媒体 / 内容平台
  - 创意 / 设计工具
  - 个人博客 / 文档站
  - 企业官网 / 品牌站
  - 其他
```

**Q2 — 色调偏好**
```
header: 色调偏好
question: 想要的色调方向？
options:
  - 暗色（深色背景，酷感科技）
  - 亮色（浅色背景，通透干净）
  - 由你推荐（根据项目类型匹配最佳）
```

**Q3 — 风格气质**
```
header: 风格气质
question: 希望整体感觉偏哪种气质？
options:
  - 极简克制（简洁留白，信息清晰）
  - 温暖友好（柔和色彩，亲和力强）
  - 高冲击力（大胆用色，视觉张力）
  - 专业权威（沉稳可靠，企业感强）
  - 活泼有趣（插画/吉祥物，轻松氛围）
```

**Q4 — 使用场景（多选）**
```
header: 使用场景
multiSelect: true
question: 这份设计主要用于？(可多选)
options:
  - 官网 / 营销 landing page
  - 仪表盘 / 后台管理界面
  - 文档 / 博客
  - 移动端 UI
  - Landing page 转化优化
```

### 第二步：综合推荐品牌

根据用户回答，按以下规则推理出最匹配的品牌：

| 项目类型 | 暗色推荐 | 亮色推荐 | 混合/都可 |
|---------|---------|---------|----------|
| AI / LLM 产品 | minimax, elevenlabs, x.ai | claude, mistral.ai | cohere, replicate |
| 开发者工具 | cursor, raycast, warp | vercel, expo | lovable |
| SaaS / B2B | linear.app, sentry | mintlify, intercom | notion, zapier |
| 电商 / 消费 | shopify, uber | airbnb, nike | starbucks |
| 金融 / Crypto | binance, kraken | coinbase, stripe | revolut, wise |
| 媒体 / 内容 | wired, spacex | pinterest, theverge | playstation |
| 创意 / 设计 | framer, figma | webflow, airtable | clay, miro |
| 个人博客 / 文档 | resend | ollama, mintlify | notion |
| 企业官网 / 品牌站 | nvidia, bmw-m | apple, ibm | meta, bmw |

**风格气质修正映射：**
- 极简克制 → linear.app, vercel, ollama
- 温暖友好 → airbnb, intercom, notion, claude
- 高冲击力 → nike, nvidia, ferrari
- 专业权威 → stripe, ibm, hashicorp
- 活泼有趣 → posthog, miro, zapier

**推荐后，用 AskUserQuestion 让用户确认：**
```
header: 确认风格
question: 根据你的需求，我推荐 XXXX 风格，你觉得怎么样？
options:
  - 好的，就用这个
  - 换一个（我会再推荐一个同类型的备选）
  - 我自己选（展示品牌列表让用户选）
```

### 第三步：读取 DESIGN.md

用户确认后，读取对应品牌的 DESIGN.md 文件内容，总结关键设计要素给用户：

```
## 设计摘要：{品牌名}

**风格描述：** {description 前两句}
**主色：** {primary}
**主题：** {暗色/亮色/混合}
**字体：** {主要字体}
**圆角风格：** {锐利/圆润/全 pill}
**关键视觉特征：** {概括 2-3 个要点}
```

然后将 DESIGN.md 完整内容提供给需要生成 UI 的上下文。

## 快捷命令

如果用户直接指定品牌（如"用 Linear 风格"），跳过提问流程，直接执行第三步。

也可以通过以下命令快速操作：

- `design-md list` — 列出所有可用品牌
- `design-md show <brand>` — 快速预览某个品牌的设计摘要
- `design-md list --category AI` — 按类别筛选展示

## 设计系统结构

每个 DESIGN.md 包含：

```yaml
description: 设计风格详细描述（文风感受、视觉基调）
colors:
  primary: <品牌主色>
  # ... 完整色板
typography:
  # 字体层级定义
spacing:
  # 间距系统
  # 圆角定义
effects:
  # 阴影/效果
```
