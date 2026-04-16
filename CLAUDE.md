# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Personal knowledge base app — AI-assisted wiki with chat, knowledge graph, and content ingestion. Chinese UI. Zero external dependencies on both server and frontend.

## Running

```bash
node server.js              # starts on http://localhost:3456
PORT=3000 node server.js     # custom port
```

No npm install, no build step, no package.json. Pure Node.js stdlib + vanilla JS.

## Architecture

### Server (`server.js`, ~1700 lines)

Raw Node.js HTTP server. Key subsystems:

- **LLM Integration** — 7 providers (Bailian/阿里云, OpenRouter, Anthropic, OpenAI, DeepSeek, custom, local Claude CLI). Provider/model in `config.json`, API key in `.api-key` file or `WIKI_API_KEY` env var. `callLLM()` is the universal entry point; `getFullConfig()` merges all config sources.
- **Compilation Engine** — `compileArticle()` takes raw content, calls LLM to produce structured wiki articles. Two modes: local CLI (spawns `claude` with tools) and API (server-driven JSON generation). Embedded rules in `COMPILE_RULES` constant.
- **Chat System** — JSON file storage in `data/chats/`. Per-conversation files `conv_*.json` + `_index.json` index. Supports context retrieval from wiki for RAG.
- **Wiki Data** — `buildGraph()` creates 3-layer knowledge graph (explicit links → keyword co-occurrence → topic affinity). `searchWiki()` for full-text search. `retrieveContext()` for chat RAG.
- **Ingest Pipeline** — Single-task queue. Accepts text/URL/files/ZIP. Batch mode with progress tracking via `batchProgress` object polled by frontend.
- **Static Files** — Serves `app/` directory. MIME map at line ~428. Path: `GET / → app/index.html`, `GET /css/base.css → app/css/base.css`, etc.

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

**Window globals:** Since HTML uses inline `onclick` handlers, `app.js` exposes ~30 functions to `window.*` (go, toggleSidebar, openSearch, dashAsk, chatSend, etc.).

**CSS structure:**
- `css/base.css` — Design tokens (`:root` variables), reset. **All colors, radii, transitions defined here.** "Warm Ink" design language with `--accent: #5B5BD6` indigo.
- `css/layout.css` — App shell: sidebar (with tabs for chat/pages), topbar, main area
- `css/components.css` — Composer, search overlay, modals, toast, format toolbar
- `css/pages.css` — Per-page styles: dashboard, chat, article (flex layout with left TOC), graph, browse
- `css/ingest.css` — Ingest panel (slide-in right)

### Data (`data/`)

```
data/wiki/          → Compiled markdown articles, grouped by topic subdirectory
data/wiki/index.md  → Master index (topic tables)
data/wiki/log.md    → Activity log
data/raw/           → Immutable source materials (fetched/pasted content)
data/chats/         → JSON conversation files + _index.json
```

## Key Patterns

- **No build system.** Edit CSS/JS files → refresh browser. Server restart only needed for `server.js` changes.
- **Inline onclick handlers** in HTML reference `window.*` functions. When adding new functions callable from HTML, export from your module AND add `window.xxx = xxx` in `app.js`.
- **ES module imports must use relative paths** with `.js` extension (`'./utils.js'`, `'../state.js'`). If any import in the chain fails, the entire module tree silently fails (blank page).
- **Article page uses flex layout** with TOC as `order:-1` child (renders left). TOC HTML must be inside `.page-article` div, not outside it.
- **Force graph** parameters in `pages/graph.js`: repulsion `2500/(d²)`, spring length `160`, center gravity `0.005`. Tune these if node count changes significantly.
- **LLM provider switching** happens in `config.json`. The `callLLM()` function normalizes all providers to a common interface. Bailian uses OpenAI-compatible API at `dashscope.aliyuncs.com`.
- **Ingest is single-threaded** — one compilation at a time. Batch mode processes items sequentially and updates `batchProgress` which frontend polls via `/api/ingest/batch/status`.

## Secrets & Config

API keys are **never** returned by any API endpoint. `GET /api/settings` only returns `hasKey: true/false`.

Key storage (highest priority wins):
1. `WIKI_API_KEY` environment variable
2. `.api-key` file (chmod 600, created by settings save)

`config.json` only stores provider/model/customBaseUrl — **never** API keys. The key is written to `.api-key` with `0o600` permissions.

`loadConfig()` reads provider/model. `loadApiKey()` reads the key. `getFullConfig()` merges both. Never put key logic in `loadConfig()`.

Files excluded from git (`.gitignore`): `config.json`, `.api-key`, `profile.json`.

## Conventions

- UI language: Chinese (中文)
- Wiki articles written in Chinese; raw materials preserve original language
- Design tokens use CSS custom properties — change colors/radius in `base.css :root`, they cascade everywhere
- Dark mode: `[data-theme="dark"]` overrides in each CSS file. Token overrides in `base.css`.
- Never commit secrets — `config.json`, `.api-key`, `profile.json` are gitignored
