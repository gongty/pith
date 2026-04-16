# Wiki App — AI 驱动的个人知识库

受 [Andrej Karpathy](https://x.com/karpathy) 启发：让 LLM 写和维护 wiki，人来读和提问。wiki 是一个持续复利的知识资产。

把资料丢进来，AI 自动整理成 wiki，越积越多越好用。

## 截图

```
┌─────────┬──────────────────────────────────┐
│ 侧边栏   │  基于知识库提问                     │
│          │  ┌─────┐ ┌─────┐ ┌─────┐        │
│ 对话 文章 │  │ 卡片 │ │ 卡片 │ │ 卡片 │        │
│          │  └─────┘ └─────┘ └─────┘        │
│ 新对话    │  [____________________ 发送]     │
│          │                                  │
│ 历史对话  │  知识图谱        最近活动           │
│ ...      │  ◉──◉──◉        · 文章标题        │
│          │  ◉──◉            · 文章标题        │
└─────────┴──────────────────────────────────┘
```

## 特性

- **投喂** — 粘贴文本、拖入文件、输入 URL、上传 ZIP，AI 自动编译成结构化文章
- **对话** — 基于知识库内容的 RAG 问答，引用来源可追溯
- **知识图谱** — 力导向图可视化文章关联（链接、关键词共现、主题亲和）
- **编辑器** — Notion 风格 contenteditable，浮动格式工具栏，自动保存
- **多 LLM** — 百炼/OpenRouter/Anthropic/OpenAI/DeepSeek/本地 Claude CLI

## 快速开始

```bash
git clone https://github.com/gongty/wiki-app.git
cd wiki-app
node server.js
# 打开 http://localhost:3456
```

无需 `npm install`。零外部依赖，只用 Node.js 内置模块。

## 配置 LLM

首次使用需在设置中配置 AI 提供商。打开页面后点击左下角「设置」：

| 提供商 | 说明 |
|--------|------|
| 百炼 (Bailian) | 阿里云 DashScope，默认选项 |
| OpenRouter | 聚合多家模型 |
| Anthropic | Claude 系列 |
| OpenAI | GPT 系列 |
| DeepSeek | 国产大模型 |
| 本地 Claude CLI | 需安装 claude 命令行 |

## 项目结构

```
wiki-app/
├── server.js          ← Node.js HTTP 服务器（API + 静态文件）
├── config.json        ← LLM 提供商配置
├── profile.json       ← 用户信息
├── app/
│   ├── index.html     ← HTML 骨架
│   ├── css/           ← 5 个样式文件（Warm Ink 设计系统）
│   └── js/            ← 16 个 ES Module
│       ├── app.js     ← 入口，事件绑定
│       ├── router.js  ← Hash 路由
│       ├── state.js   ← 全局状态
│       └── pages/     ← 页面组件（dashboard, chat, article, graph, browse）
└── data/
    ├── wiki/          ← 编译后的知识库文章（Markdown）
    ├── raw/           ← 原始素材（不可变）
    └── chats/         ← 对话历史（JSON）
```

## 技术栈

| 层 | 选型 | 说明 |
|----|------|------|
| 后端 | Node.js stdlib | 零依赖，原生 HTTP 服务器 |
| 前端 | Vanilla JS + ES Modules | 零框架，零构建工具 |
| 样式 | CSS Custom Properties | 主题变量级联，支持 dark mode |
| 存储 | 文件系统 | Markdown + JSON，无数据库 |
| AI | 多 LLM 提供商 | 统一 callLLM() 接口 |

## API 概览

| 路径 | 说明 |
|------|------|
| `GET /api/wiki/tree` | 文章目录树 |
| `GET /api/wiki/graph` | 知识图谱数据 |
| `GET /api/search?q=` | 全文搜索 |
| `POST /api/ingest` | 投喂内容（文本/URL/文件） |
| `POST /api/chat/new` | 新建对话 |
| `POST /api/chat/:id/message` | 发送消息 |
| `GET /api/settings` | 获取配置 |

完整 API 见 `server.js`。

## 设计系统：Warm Ink

温暖、克制、有质感。知识库不是工具，是你的书房。

- 主色：`#5B5BD6` 墨水紫
- 背景：`#FAFAF8` 暖白纸感
- 圆角：8px / 12px 两档
- 字体：系统字体栈（SF Pro + PingFang SC）

所有设计 token 在 `app/css/base.css` 的 `:root` 中定义。

## License

MIT
