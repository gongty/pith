# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Personal knowledge base app — AI-assisted wiki with chat, knowledge graph, content ingestion, and automated task scheduling. Chinese UI. Zero external dependencies on frontend.

## Running

```bash
./start.sh                              # 推荐，内含环境变量
WIKI_API_KEY=sk-xxx node server.js      # 手动指定
PORT=3000 WIKI_API_KEY=sk-xxx node server.js  # 自定义端口
```

Default port: 3456. First run `npm install` to install dependencies (pdf-parse, @mozilla/readability, jsdom). No build step. Node.js stdlib + vanilla JS frontend.

## Architecture

### Server (`server.js`)

Single-file raw Node.js HTTP server (~3000 lines). Key subsystems:

- **LLM Integration** — 7 providers (Bailian/阿里云, OpenRouter, Anthropic, OpenAI, DeepSeek, custom, local Claude CLI). `callLLM()` is the universal entry point. `getFullConfig()` merges `loadConfig()` (provider/model) + `loadApiKey()` (env var only).
- **Compilation Engine** — `compileArticle()` takes raw content, calls LLM to produce structured wiki articles. Two modes: local CLI (spawns `claude` with tools) and API (server-driven JSON generation). Embedded rules in `COMPILE_RULES` constant.
- **Chat System** — JSON file storage in `data/chats/`. Per-conversation files `conv_*.json` + `_index.json` index. Supports context retrieval from wiki for RAG.
- **Wiki Data** — `buildGraph()` creates 3-layer knowledge graph (explicit links → keyword co-occurrence → topic affinity). `searchWiki()` for full-text search. `retrieveContext()` for chat RAG.
- **Ingest Pipeline** — Single-task queue. Accepts text/URL/PDF/image/audio/video/ZIP. Multi-format extraction: pdf-parse for PDF, Readability+jsdom for URL, LLM Vision for images, OpenAI Whisper or local ffmpeg+whisper for audio/video. Batch mode with progress tracking via `batchProgress` object polled by frontend.
- **Automated Tasks** — `data/autotasks/` stores task configs, execution history, and dedup index. `executeAutotask()` engine: fetch source (RSS/webpage/API) → keyword filter → 3-layer dedup (URL normalization + content SHA-256 + existing check) → `extractContent()` + `compileArticle()` reuse. Scheduler runs every 5 min via `setInterval`, supports daily (with HH:MM), hourly, and manual schedules.
- **Static Files** — Serves `app/` directory. Path: `GET / → app/index.html`, `GET /css/base.css → app/css/base.css`, etc.

### Frontend (`app/`)

Vanilla JS with ES modules (`<script type="module">`). No framework, no bundler.

**Module dependency graph** (entry: `js/app.js`):
```
app.js → router.js → pages/{dashboard,chat,article,graph,browse,autotask,health}.js
       → sidebar.js, composer.js, search.js, settings.js, ingest.js
       → state.js (shared mutable state), utils.js (DOM/$, API, toast)
       → theme.js, markdown.js
```

**Routing:** Hash-based. `#/` dashboard, `#/chat/:id` chat, `#/article/:path` article, `#/graph` graph, `#/browse` browse, `#/autotask` automated tasks. Router in `js/router.js`, `render()` is the main dispatch.

**Global state:** `js/state.js` exports a single mutable object. All modules import and mutate it directly.

**Window globals:** Since HTML uses inline `onclick` handlers, `app.js` exposes functions to `window.*`. When adding new functions callable from HTML, export from your module AND add `window.xxx = xxx` in `app.js`.

**CSS structure:**
- `css/base.css` — Design tokens (`:root` variables), reset. **All colors, radii, transitions defined here.** "Warm Ink" design language with `--accent: #5B5BD6` indigo.
- `css/layout.css` — App shell: sidebar (with tabs for chat/pages), topbar, main area
- `css/components.css` — Composer, search overlay, modals, toast, format toolbar
- `css/pages.css` — Per-page styles: dashboard, chat, article (flex layout with left TOC), graph, browse
- `css/ingest.css` — Ingest panel (slide-in right)
- `css/autotask.css` — Automated tasks page, cards, toggle, modals

### Adding a New Page

1. Create `app/js/pages/<name>.js` — export `rXxx(container)` render function
2. Create `app/css/<name>.css` (optional) — add `<link>` in `index.html`
3. `router.js` — add import, route match in `route()`, breadcrumb in `updBC()`, dispatch in `render()`
4. `app.js` — import onclick-callable functions, register on `window.*`, add to Escape handler if modal
5. `index.html` — add sidebar nav `<div class="sidebar-item">`, modal HTML shells if needed

### Data (`data/`)

Not tracked by git. Created automatically on first run.

```
data/wiki/          → Compiled markdown articles, grouped by topic subdirectory
data/wiki/index.md  → Master index (topic tables)
data/wiki/log.md    → Activity log
data/raw/           → Immutable source materials (fetched/pasted content)
data/chats/         → JSON conversation files + _index.json
data/autotasks/     → tasks.json (configs), history.json (runs), dedup.json (URL+hash index)
data/reports/       → Lint/health check reports
data/uploads/       → Uploaded files
```

## Secrets — 安全红线

**API Key 只从环境变量 `WIKI_API_KEY` 读取，绝不落盘。**

- `loadApiKey()` → 只读 `process.env.WIKI_API_KEY`，没有文件读取
- `loadConfig()` → 只读 `config.json` 里的 provider/model，不碰密钥
- `getFullConfig()` → 合并以上两者
- `GET /api/settings` → 只返回 `hasKey: true/false`，绝不返回密钥内容
- `PUT /api/settings` → 只保存 provider/model，不接受密钥参数

**绝对不能做的事：**
- 把密钥写入任何文件（config.json、.env、.api-key 都不行）
- 在 API 响应里返回密钥的任何部分（包括 mask 后的）
- 把 data/、config.json、profile.json、start.sh 加入 git

`.gitignore` 排除: `config.json`, `profile.json`, `.api-key`, `data/`, `node_modules/`, `start.sh`

## Key Patterns

- **No build system.** Edit CSS/JS files → refresh browser. Server restart only needed for `server.js` changes.
- **ES module imports must use relative paths** with `.js` extension (`'./utils.js'`, `'../state.js'`). If any import in the chain fails, the entire module tree silently fails (blank page).
- **Article page uses flex layout** with TOC as `order:-1` child (renders left). TOC HTML must be inside `.page-article` div, not outside it.
- **Force graph** parameters in `pages/graph.js`: repulsion `2500/(d²)`, spring length `160`, center gravity `0.005`. Tune these if node count changes significantly.
- **Ingest is single-threaded** — one compilation at a time. Batch mode processes items sequentially and updates `batchProgress` which frontend polls via `/api/ingest/batch/status`.
- **Autotask execution** reuses the ingest pipeline (`extractContent()` + `compileArticle()`). Each task run records to `history.json` and marks URLs/hashes in `dedup.json`.
- **CSS overflow rule**: When `overflow-y` is non-`visible`, browsers force `overflow-x` from `visible` to `auto`. Always set `overflow-x:hidden` explicitly on scroll containers to prevent unwanted horizontal scrollbars.

## Conventions

- **严禁 emoji**（红线）：UI 文案、按钮、卡片图标、警告/错误前缀、commit message 一律不用任何 emoji（🟠 📄 🤗 ⚠️ ⚙️ 📥 ✅ ❌ 等都不行）。用户原话："太AI了，我讨厌这些垃圾 emoji"。需要图标用 SVG；状态用 CSS 圆点 + 文字。仅用户主动要求时例外。
- UI language: Chinese (中文)
- Wiki articles written in Chinese; raw materials preserve original language
- Design tokens use CSS custom properties — change colors/radius in `base.css :root`, they cascade everywhere
- Dark mode: `[data-theme="dark"]` overrides in each CSS file. Token overrides in `base.css`.

## UI 设计原则（红线）

这些是用户明确强调的关键原则，新写或修改 UI 时必须遵守。违反就是不合格。

- **多 Tab 弹窗必须同高度**：一个弹窗内有 N 个 Tab 切换时，弹窗高度不允许随 Tab 内容变化而跳动。固定弹窗高度，内容超出时在面板内上下滚动；底部按钮栏（保存/取消）吸底常驻。实现方式参考 `.modal-card-tabs` / `.settings-tab-content`：`height + max-height` 固定外框，内部 flex 列，主体 `overflow-y:auto`，foot `flex-shrink:0`。
- **长文内容宽度与位置要跟随视口自适应**：文章等阅读型页面不能在宽屏下右侧留大片空白。正文要有阅读友好的宽度上限（约 860–920px），但富余空间应左右均分让正文居中，而不是一律贴左。实现方式参考 `.page-article-inner`：`flex:1 + max-width + margin-left:auto + margin-right:auto`，超宽屏（≥1600px）可放宽 max-width。
