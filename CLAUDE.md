# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Personal knowledge base app — AI-assisted wiki with chat, knowledge graph, content ingestion, and automated task scheduling. Chinese UI. Zero external dependencies on frontend.

## Running

```bash
./start.sh                                          # 推荐，内含环境变量（若存在）
WIKI_API_KEY=$(cat .api-key) node server.js        # .api-key 是本地密钥文件（gitignored），内容为 sk-xxx
WIKI_API_KEY=sk-xxx node server.js                 # 手动指定
PORT=3000 WIKI_API_KEY=sk-xxx node server.js       # 自定义端口
```

Default port: 3456. First run `npm install` to install dependencies (pdf-parse, @mozilla/readability, jsdom). No build step. Node.js stdlib + vanilla JS frontend.

`.api-key` 是本地便利文件（gitignored），仅用于手动 `cat` 后喂给环境变量；server 本身只读 `process.env.WIKI_API_KEY`，从不直接读 `.api-key`。`start.sh` 也 gitignored，丢了就用上面第二行等价命令。

**No tests, no lint, no CI.** `package.json` 只有 `start` 脚本，`npm test` 返回 `exit 1`。验证改动靠浏览器手测 + 服务端日志。

**运行时外部依赖（PATH 上需要）**：本地 CLI compile 模式需要 `claude`；音视频本地转录路径需要 `ffmpeg` + `whisper`；autotask `aggregator` 源类型需要 `python3`（subprocess 调用 `../plugins/news-skills/news-aggregator-skill/scripts/fetch_news.py`）。缺失时 ingest/compile 会尝试 fallback 到云端 API，失败时看 stderr。

## Architecture

### Server (`server.js`)

Single-file raw Node.js HTTP server (~5400 lines). Key subsystems:

- **LLM Integration** — 7 providers (Bailian/阿里云, OpenRouter, Anthropic, OpenAI, DeepSeek, custom, local Claude CLI). `callLLM()` is the universal entry point. `getFullConfig()` merges `loadConfig()` (provider/model) + `loadApiKey()` (env var only). `pickModelByUse(provider, use, cfg)` resolves use-key ('fast' / 'main' / 'strong') to concrete model id with fallback.
- **Compilation Engine** — `runCompilePipeline()` is the 7-stage pipeline: title → topic → content+summary(parallel) → tags → filename → seealso → persist. Each stage tracked via `startStage`/`doneStage`/`errorStage`. Tags are piggybacked: LLM content stage emits `<!-- tags: a, b, c -->` trailer, extracted after content, stripped from body. Two compile modes: local CLI (spawns `claude` with tools) and API (server-driven JSON generation). Embedded rules in `COMPILE_RULES` constant.
- **Tag System** — Articles store tags as YAML frontmatter: `---\ntags: [a, b, c]\n---\n`. Core functions around line 1290-1410: `parseFrontmatter(content)` / `serializeFrontmatter(data)` / `extractTitle(fp)` (skips fm) / `extractTags(fp)` (frontmatter first; falls back to `extractKeywords` with `TAG_FALLBACK_STOP` filter for legacy articles) / `collectExistingTags(limit)` (frequency-sorted, fed to LLM prompts for semantic convergence). `runBackfillTags({force, useModel})` regenerates tags for articles missing them; exposed via `POST /api/wiki/backfill-tags?force=1&useModel=main`. **Any code that writes .md files must preserve frontmatter** — use `parseFrontmatter` + `serializeFrontmatter`, never raw string concat.
- **Chat System** — JSON file storage in `data/chats/`. Per-conversation files `conv_*.json` + `_index.json` index. Supports context retrieval from wiki for RAG.
- **Wiki Data & Graph** — `searchWiki()` for full-text search. `retrieveContext()` for chat RAG. `/api/wiki/tree` returns topic → children with `{title, tags, mtime}`. `/api/wiki/graph` builds 2-layer graph: explicit markdown links (see-also / reference edges) + tag co-occurrence edges with IDF weighting (tags shared by >50% of articles are dropped as too-common; dangling targets filtered via `fs.existsSync`). The standalone `buildGraph()` function (line ~1703) is legacy — the live graph API has its own inline logic.
- **Ingest Pipeline** — Single-task queue. Accepts text/URL/PDF/image/audio/video/ZIP. Multi-format extraction: pdf-parse for PDF, Readability+jsdom for URL, LLM Vision for images, OpenAI Whisper or local ffmpeg+whisper for audio/video. Batch mode with progress tracking via `batchProgress` object polled by frontend.
- **Automated Tasks (AI 研究助手)** — 任务模型 v3：`{intent (NL 描述用户想要什么), sources[] (从 catalog 选), preferences{topics, deny}, feedback[] (up/down 历史)}`。Source 适配器在 `lib/sources.js`，五种类型：rss / changelog / aggregator (spawn `python3 fetch_news.py`) / webpage / api。**SSRF 防护** (`assertSafeUrl()`)：协议白名单 (http/https) + DNS 解析 + 私网/loopback/link-local/IPv4-mapped-IPv6/bracketed-IPv6 全拦截 + 重定向重新校验 + 响应硬上限 10 MB。**9 阶段 pipeline**: fetch → 跨源 URL 规范化去重 (`dedup.json` 30 天窗口) → 关键词预过滤 → LLM relevance gate (qwen-turbo / 廉价快速模型) → smart_fill (前 3 天补抓机制) → process (compile per item) → brief (LLM 生成本次简报 .md，写入 `data/wiki/`)。Item dedup 用复合键 `(url||title)+sourceId`，避免同一 URL 在不同 source 下被错杀。`history.json` 写入用 `withAutotaskWriteLock(fn)` 链式 Promise 串行化。Scheduler 每 5 min `setInterval`，支持 daily(HH:MM)/hourly/manual。
- **Autotask API** — `POST /api/autotask/configure` (envelope `{ok, config, warnings[]}` 创建/更新任务)、`POST /api/autotask/feedback` (action 映射：前端 `up`/`down` → 后端持久化为 `keep`/`drop`，喂 LLM gate)、`GET /api/autotask/sources` (列 catalog)、`POST /api/autotask/run/:id` (手动触发)、`GET /api/autotask/history` (含 sourceStatus / topGatedReasons / items[].confidence)。
- **system-sources.json** — `data/system-sources.json` 是 51 个内置源 catalog (arxiv RSS, github changelogs, news aggregators 等)，`.gitignore` 用 `data/* + !data/system-sources.json` 例外放行（**唯一被 git 跟踪的 data/ 文件**）。新建任务 UI 从这里挑源；新增源直接编辑这个 JSON。
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

**Routing:** Hash-based. `#/` dashboard, `#/chat/:id` chat, `#/article/:path` article, `#/graph` graph, `#/browse` browse (supports `?tag=xxx` filter), `#/autotask` automated tasks. Router in `js/router.js`, `render()` is the main dispatch. Router parses query string; add new query params by extending the block in `route()`.

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
data/autotasks/     → tasks.json (intent+sources[]+preferences+feedback[] 配置), history.json (runs，含 sourceStatus / topGatedReasons / items[].confidence), dedup.json (跨任务跨源 URL+hash 30 天窗口)
data/system-sources.json → 51 个内置源 catalog (git 跟踪，via .gitignore !data/system-sources.json 例外)
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

`.gitignore` 排除: `config.json`, `profile.json`, `.api-key`, `data/*` (但 `!data/system-sources.json` 例外), `node_modules/`, `start.sh`, `.claude/` (运行时 lock 目录)

## Key Patterns

- **No build system.** Edit CSS/JS files → refresh browser. Server restart only needed for `server.js` changes.
- **ES module imports must use relative paths** with `.js` extension (`'./utils.js'`, `'../state.js'`). If any import in the chain fails, the entire module tree silently fails (blank page).
- **Article page uses flex layout** with TOC as `order:-1` child (renders left). TOC HTML must be inside `.page-article` div, not outside it.
- **Force graph** parameters in `pages/graph.js`: repulsion `2500/(d²)`, spring length `160`, center gravity `0.005`. Tune these if node count changes significantly.
- **Ingest is single-threaded** — one compilation at a time. Batch mode processes items sequentially and updates `batchProgress` which frontend polls via `/api/ingest/batch/status`.
- **Autotask execution** reuses the ingest pipeline (`extractContent()` + `compileArticle()`). Each task run records to `history.json` and marks URLs/hashes in `dedup.json`.
- **Autotask 写锁**：`history.json` 高频并发写（LLM gate / smart_fill / process 各阶段并发完成）必须经过 `withAutotaskWriteLock(fn)` 链式 Promise 串行化，**不要绕开直接 fs.writeFileSync**，否则会撕扯并发结果。
- **server.js 无热加载** — 改 `server.js` 必须重启进程。`data/` 下 JSON 在进程内有内存缓存（如 autotasks 调度器、聊天索引），手改磁盘文件不会被感知，必须通过 API 改或重启。
- **CSS overflow rule**: When `overflow-y` is non-`visible`, browsers force `overflow-x` from `visible` to `auto`. Always set `overflow-x:hidden` explicitly on scroll containers to prevent unwanted horizontal scrollbars.
- **Article frontmatter 必须保留**：所有 `data/wiki/**/*.md` 都有 `---\ntags: [...]\n---\n` 开头。编辑代码（前后端）动 .md 内容时，先用 `parseFrontmatter` 拆分 → 改 body → 用 `serializeFrontmatter` + body 拼回。前端 `markdown.js` 也导出了 `parseFrontmatter`，`renderMd` 会自动剥离 fm。直接字符串拼接或 regex 截断会丢失元数据。
- **Graph 端点 vs buildGraph**：`/api/wiki/graph` 端点有自己的内联边生成逻辑（line ~3737），不调用老的 `buildGraph()` 函数（line ~1703）。修边权重 / 边类型要改端点，不要改函数。

## Conventions

- **严禁 emoji**（红线）：UI 文案、按钮、卡片图标、警告/错误前缀、commit message 一律不用任何 emoji（🟠 📄 🤗 ⚠️ ⚙️ 📥 ✅ ❌ 等都不行）。用户原话："太AI了，我讨厌这些垃圾 emoji"。需要图标用 SVG；状态用 CSS 圆点 + 文字。仅用户主动要求时例外。
- UI language: Chinese (中文)
- Wiki articles written in Chinese; raw materials preserve original language
- Design tokens use CSS custom properties — change colors/radius in `base.css :root`, they cascade everywhere
- Dark mode: `[data-theme="dark"]` overrides in each CSS file. Token overrides in `base.css`.
- **Submodule 双提交流程**：本仓库是父仓库 `BLANK_work` 的 git submodule。改动后需要两次提交：先在 `wiki-app/` 内 `commit && push`，再回到父仓库 `git add wiki-app && commit` 更新 submodule 指针。Remote: `https://github.com/gongty/wiki-app.git`，branch `main`。

## UI 设计原则（红线）

这些是用户明确强调的关键原则，新写或修改 UI 时必须遵守。违反就是不合格。

- **多 Tab 弹窗必须同高度**：一个弹窗内有 N 个 Tab 切换时，弹窗高度不允许随 Tab 内容变化而跳动。固定弹窗高度，内容超出时在面板内上下滚动；底部按钮栏（保存/取消）吸底常驻。实现方式参考 `.modal-card-tabs` / `.settings-tab-content`：`height + max-height` 固定外框，内部 flex 列，主体 `overflow-y:auto`，foot `flex-shrink:0`。
- **长文内容宽度与位置要跟随视口自适应**：文章等阅读型页面不能在宽屏下右侧留大片空白。正文要有阅读友好的宽度上限（约 860–920px），但富余空间应左右均分让正文居中，而不是一律贴左。实现方式参考 `.page-article-inner`：`flex:1 + max-width + margin-left:auto + margin-right:auto`，超宽屏（≥1600px）可放宽 max-width。
