# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Personal knowledge base app — AI-assisted wiki with chat, knowledge graph, and content ingestion. Chinese UI. Zero external dependencies on both server and frontend.

## Running

```bash
./start.sh                              # 推荐，内含环境变量
WIKI_API_KEY=sk-xxx node server.js      # 手动指定
PORT=3000 WIKI_API_KEY=sk-xxx node server.js  # 自定义端口
```

Default port: 3456. First run `npm install` to install dependencies (pdf-parse, @mozilla/readability, jsdom). No build step. Node.js stdlib + vanilla JS frontend.

## Architecture

### Server (`server.js`)

Raw Node.js HTTP server. Key subsystems:

- **LLM Integration** — 7 providers (Bailian/阿里云, OpenRouter, Anthropic, OpenAI, DeepSeek, custom, local Claude CLI). `callLLM()` is the universal entry point. `getFullConfig()` merges `loadConfig()` (provider/model) + `loadApiKey()` (env var only).
- **Compilation Engine** — `compileArticle()` takes raw content, calls LLM to produce structured wiki articles. Two modes: local CLI (spawns `claude` with tools) and API (server-driven JSON generation). Embedded rules in `COMPILE_RULES` constant.
- **Chat System** — JSON file storage in `data/chats/`. Per-conversation files `conv_*.json` + `_index.json` index. Supports context retrieval from wiki for RAG.
- **Wiki Data** — `buildGraph()` creates 3-layer knowledge graph (explicit links → keyword co-occurrence → topic affinity). `searchWiki()` for full-text search. `retrieveContext()` for chat RAG.
- **Ingest Pipeline** — Single-task queue. Accepts text/URL/PDF/image/audio/video/ZIP. Multi-format extraction: pdf-parse for PDF, Readability+jsdom for URL, LLM Vision for images, OpenAI Whisper or local ffmpeg+whisper for audio/video. Batch mode with progress tracking via `batchProgress` object polled by frontend. Files sent as base64 in JSON body (max 100MB).
- **Static Files** — Serves `app/` directory. Path: `GET / → app/index.html`, `GET /css/base.css → app/css/base.css`, etc.

### Frontend (`app/`)

Vanilla JS with ES modules (`<script type="module">`). No framework, no bundler.

**Module dependency graph** (entry: `js/app.js`):
```
app.js → router.js → pages/{dashboard,chat,article,graph,browse}.js
       → sidebar.js, composer.js, search.js, settings.js, ingest.js
       → state.js (shared mutable state), utils.js (DOM/$, API, toast)
       → theme.js, markdown.js
```

**Routing:** Hash-based. `#/` dashboard, `#/chat/:id` chat, `#/article/:path` article, `#/graph` graph, `#/browse` browse. Router in `js/router.js`, `render()` is the main dispatch.

**Global state:** `js/state.js` exports a single mutable object. All modules import and mutate it directly.

**Window globals:** Since HTML uses inline `onclick` handlers, `app.js` exposes functions to `window.*`. When adding new functions callable from HTML, export from your module AND add `window.xxx = xxx` in `app.js`.

**CSS structure:**
- `css/base.css` — Design tokens (`:root` variables), reset. **All colors, radii, transitions defined here.** "Warm Ink" design language with `--accent: #5B5BD6` indigo.
- `css/layout.css` — App shell: sidebar (with tabs for chat/pages), topbar, main area
- `css/components.css` — Composer, search overlay, modals, toast, format toolbar
- `css/pages.css` — Per-page styles: dashboard, chat, article (flex layout with left TOC), graph, browse
- `css/ingest.css` — Ingest panel (slide-in right)

### Data (`data/`)

Not tracked by git. Created automatically on first run.

```
data/wiki/          → Compiled markdown articles, grouped by topic subdirectory
data/wiki/index.md  → Master index (topic tables)
data/wiki/log.md    → Activity log
data/raw/           → Immutable source materials (fetched/pasted content)
data/chats/         → JSON conversation files + _index.json
```

## Secrets — 安全红线

**API Key 只从环境变量 `WIKI_API_KEY` 读取，绝不落盘。**

- `loadApiKey()` → 只读 `process.env.WIKI_API_KEY`，没有文件读取
- `loadConfig()` → 只读 `config.json` 里的 provider/model，不碰密钥
- `getFullConfig()` → 合并以上两者
- `GET /api/settings` → 只返回 `hasKey: true/false`，绝不返回密钥内容
- `PUT /api/settings` → 只保存 provider/model，不接受密钥参数
- `start.sh` → 含密钥的启动脚本，已 gitignore

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

## Conventions

- UI language: Chinese (中文)
- Wiki articles written in Chinese; raw materials preserve original language
- Design tokens use CSS custom properties — change colors/radius in `base.css :root`, they cascade everywhere
- Dark mode: `[data-theme="dark"]` overrides in each CSS file. Token overrides in `base.css`.
