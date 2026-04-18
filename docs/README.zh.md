# Pith

丢进一个链接、一份 PDF、一张截图，或者直接粘贴文字 -- AI 阅读、整理、归档到你的个人知识库。下次需要时，搜索或直接用自然语言提问。

设好 RSS 和网页源，AI 每天自动监控、过滤你关心的内容、撰写文章。你睡觉的时候，知识库在生长。

几小时纯 vibe coding 搭建，使用 [Claude Code](https://claude.ai/code)。零框架、零构建、零数据库 -- 只有 Node.js 和原生 JS。界面支持中文、英语、日语、韩语。灵感来自 [Andrej Karpathy](https://x.com/karpathy)：让 LLM 维护一个复利增长的知识库。

**中文 | [English](../README.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Espanol](README.es.md) | [Portugues](README.pt.md) | [Deutsch](README.de.md)**

## 截图

| 仪表盘 | 知识图谱 |
|:-:|:-:|
| ![仪表盘](../docs/screenshots/dashboard.png) | ![知识图谱](../docs/screenshots/graph.png) |

| 文章阅读 | 浏览文章 |
|:-:|:-:|
| ![文章](../docs/screenshots/article.png) | ![浏览](../docs/screenshots/browse.png) |

| 自动化任务 | 深色模式 |
|:-:|:-:|
| ![自动化任务](../docs/screenshots/autotask.png) | ![深色模式](../docs/screenshots/dark-mode.png) |

## 下载

**[macOS (Apple Silicon) DMG](https://github.com/gongty/pith/releases/latest)**

未签名构建 -- 首次启动：右键 > 打开，或终端执行 `xattr -cr /Applications/Pith.app`。

## 解决什么问题？

**信息分散，看过就忘。** 笔记在一个 app 里，书签在另一个，PDF 扔在桌面上。Pith 把它们全部变成可搜索、互相关联的文章 -- 自动完成。

**想基于自己的知识提问，而不是通用 AI。** 内置聊天使用 RAG（检索增强生成）从你的 wiki 中检索上下文来回答问题。每个回答都基于你积累的文章。

**想让 AI 每天帮你盯感兴趣的领域。** 设置自动化任务，以 RSS、网页和 API 作为信息源。AI 按计划抓取、筛选并整理成新文章 -- 你的私人研究助手。

## 功能

- **吃下任何格式** -- 粘贴文本、拖入文件（PDF、图片、音频、视频、ZIP）或输入 URL。AI 自动整理成带标签、摘要和交叉引用的结构化文章。
- **和知识对话** -- 基于 RAG 的问答，从你的 wiki 中检索上下文。混合检索：BM25 关键词 + 向量嵌入（RRF 融合）。
- **知识图谱** -- 力导向可视化，展示概念与文章之间的关联。一眼看清知识脉络。
- **文章问答** -- 每篇文章上的浮动面板，在文章语境下提问。每篇文章独立会话，流式响应。
- **自动化任务** -- AI 研究助手，按计划监控 RSS / 网页 / API 信息源。LLM 相关性筛选、去重、每日简报。
- **富文本编辑** -- 类 Notion 的 contenteditable 编辑器，浮动工具栏、自动保存、标签管理、目录导航。
- **多 LLM 支持** -- 百炼（阿里云）、OpenRouter、Anthropic、OpenAI、DeepSeek，或自定义 provider。
- **深色模式** -- 完整的深色主题，精心调校的设计变量。
- **零框架** -- 原生 JS 前端，无构建步骤。改完刷新即可。

## 快速开始

```bash
git clone https://github.com/gongty/pith.git
cd pith
npm install
WIKI_API_KEY=your-api-key node server.js
# 打开 http://localhost:3456
```

默认端口：3456。首次启动后在设置页面配置 LLM provider。

## 配置

### 环境变量

| 变量 | 是否必需 | 说明 |
|------|---------|------|
| `WIKI_API_KEY` | 是 | LLM provider 的 API 密钥 |
| `WIKI_ADMIN_TOKEN` | 生产环境必需 | 鉴权令牌（不少于 16 个字符），保护写入接口 |
| `PORT` | 否 | 服务端口（默认：3456） |

### LLM Provider

启动后在设置页面配置：

| Provider | 说明 |
|----------|------|
| 百炼（阿里云） | 默认。DashScope API |
| OpenRouter | 多模型聚合平台 |
| Anthropic | Claude 系列模型 |
| OpenAI | GPT 系列模型 |
| DeepSeek | 国产大模型 |
| Custom | 任何 OpenAI 兼容的端点 |

## 技术栈

| 层 | 选型 | 理由 |
|----|------|------|
| 后端 | Node.js 标准库 | 单文件服务器，零后端依赖 |
| 前端 | 原生 JS + ES Modules | 无框架、无打包器、无构建步骤 |
| 样式 | CSS Custom Properties | 设计变量级联，内置深色模式 |
| 存储 | 文件系统 | Markdown + JSON，不用数据库 |
| AI | 多 Provider | 统一的 `callLLM()` 调用接口 |

## 项目结构

```
pith/
├── server.js          # Node.js HTTP 服务器（约 6700 行，API + 静态文件）
├── app/
│   ├── index.html     # HTML 外壳
│   ├── css/           # 设计系统（"Warm Ink"：靛蓝主色调，暖色纸面）
│   └── js/            # ES Modules
│       ├── app.js     # 入口
│       ├── router.js  # 基于 hash 的路由
│       └── pages/     # dashboard, chat, article, graph, browse, autotask
└── data/              # 自动创建，不纳入版本管理
    ├── wiki/          # 按主题分目录的 Markdown 文章
    ├── raw/           # 不可变的原始素材
    ├── chats/         # 对话历史（JSON）
    ├── autotasks/     # 任务配置、运行历史、去重索引
    └── vectors/       # 语义检索的向量索引
```

## 参与贡献

欢迎提 Issue 和 Pull Request。

## 许可证

MIT
