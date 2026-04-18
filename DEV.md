# DEV.md

开发指南。

## What This Is

Personal knowledge base app — AI-assisted wiki with chat, knowledge graph, content ingestion, and automated task scheduling. Multilingual UI (English / Chinese / Japanese / Korean). Zero external dependencies on frontend.

## Running

```bash
WIKI_API_KEY=sk-xxx node server.js                 # 手动指定
PORT=3000 WIKI_API_KEY=sk-xxx node server.js       # 自定义端口
WIKI_ADMIN_TOKEN=<至少 16 字符随机串> WIKI_API_KEY=sk-xxx node server.js  # 启用鉴权（生产/上云必需）
```

Default port: 3456. First run `npm install` to install dependencies (pdf-parse, @mozilla/readability, jsdom). No build step. Node.js stdlib + vanilla JS frontend.

**环境变量**
- `WIKI_API_KEY`（必需）：LLM provider 密钥。server 只从此环境变量读取。
- `WIKI_ADMIN_TOKEN`（可选，生产必需）：>=16 字符启用 auth 中间件，所有写端点 + 敏感 GET 要求 `Authorization: Bearer <token>` 或 `wiki_admin_token` cookie。未设置时所有端点匿名可访问（仅限本地开发）。
- `AGGREGATOR_SCRIPT`（可选）：覆盖 autotask `aggregator` 源类型调用的 python 脚本路径。
- `PORT`：默认 3456。

**No tests, no lint, no CI.** `package.json` 只有 `start` 脚本。验证改动靠浏览器手测 + 服务端日志 + `node test-persist-retry.js`（持久层单测，22 个断言）。

**运行时外部依赖（PATH 上需要）**：音视频本地转录路径需要 `ffmpeg` + `whisper`（失败时若 provider 是 openai 会 fallback 到 Whisper API）；autotask `aggregator` 源类型需要 `python3`。图片 OCR / 文本/URL/PDF ingest 全走云 API，无本地二进制依赖。

## Architecture

### Server (`server.js`)

Single-file raw Node.js HTTP server (~6700 lines). Key subsystems:

- **LLM Integration** — 6 cloud providers (Bailian/阿里云, OpenRouter, Anthropic, OpenAI, DeepSeek, custom)。`callLLM()` is the universal entry point. `getFullConfig()` merges `loadConfig()` (provider/model) + `loadApiKey()` (env var only). `pickModelByUse(provider, use, cfg)` resolves use-key ('fast' / 'main' / 'strong') to concrete model id with fallback. 默认 provider 是 `bailian`。
- **Compilation Engine** — `runCompilePipeline()` is the 7-stage pipeline: title -> topic -> content+summary(parallel) -> tags -> filename -> seealso -> persist. Each stage tracked via `startStage`/`doneStage`/`errorStage`. 失败时把原始 rawBody 归档到 `data/raw/<topic>/failed/` 并抛错，绝不构造占位正文落盘。
- **Tag System** — Articles store tags as YAML frontmatter: `---\ntags: [a, b, c]\n---\n`. Core functions: `parseFrontmatter` / `serializeFrontmatter` / `extractTags` / `collectExistingTags`. **Any code that writes .md files must preserve frontmatter.**
- **Chat System** — JSON file storage in `data/chats/`. Per-conversation files `conv_*.json` + `_index.json` index. Supports context retrieval from wiki for RAG.
- **Wiki Data & Graph** — `searchWiki()` for full-text (BM25-ish) search. `retrieveContext(question)` for chat RAG: lex + vec RRF 融合. `/api/wiki/graph` 构两层图: concept 节点 + article 节点, 经 `lib/concepts.js` 的 stopword + hapax 双档过滤。
- **Vector Retrieval (`lib/vectors.js`)** — embedding 仅支持 `bailian / openai / custom`。索引落 `data/vectors/index.jsonl` + `meta.json`。写策略: 先写 `.tmp` 再 `fs.renameSync` 原子替换。
- **Ingest Pipeline** — Task queue with `enqueueTask` -> `tryDispatch` -> `processTask`. Accepts text/URL/PDF/image/audio/video/ZIP. Batch mode with progress tracking. URL dedup at submit time: `POST /api/ingest` checks `taskQueue` for pending/processing/done tasks with the same `normalizeUrl()`; all-duplicate -> 409. Overview endpoint (`GET /api/ingest/overview`): returns `{running, queued, recent, batch, hasActivity, phaseTotal}`.
- **Article Q&A** — `POST /api/wiki/article-ask` SSE 端点，读取文章全文 + 多轮对话历史，调 `callLLM` 流式返回。server 做 SSE 代理，re-emit `{t:content}` 和 `{r:reasoning_content}` 事件。前端在 `pages/article.js` 实现浮动面板，每个文章独立 session（上限 10，LRU 淘汰），session 持有自己的 DOM 容器，切文章只换挂载不丢 streaming 状态。
- **Automated Tasks** — Source 适配器五种类型: rss / changelog / aggregator / webpage / api. Pipeline: fetch -> dedup -> prefilter -> gating -> smart_fill -> processing -> brief -> finalize. SSRF 防护 via `assertSafeUrl()`.
- **Auth & Hardening** — 三层中间件: CSRF (Origin check) -> Rate limit (IP + endpoint bucketing) -> Auth (Bearer token / cookie).

### Frontend (`app/`)

Vanilla JS with ES modules (`<script type="module">`). No framework, no bundler.

**Module dependency graph** (entry: `js/app.js`):
```
app.js -> router.js -> pages/{dashboard,chat,article,graph,browse,autotask,health,raw}.js
       -> sidebar.js, composer.js, search.js, settings.js (-> memory.js), ingest.js, ingest-queue.js
       -> state.js (shared mutable state), utils.js (DOM/$, API, toast)
       -> theme.js
```
`markdown.js` is not directly imported by app.js; page modules (article/chat/dashboard etc.) import it themselves.

**Routing:** Hash-based. `#/` dashboard, `#/chat/:id` chat, `#/article/:path` article, `#/graph` graph, `#/browse` browse (supports `?tag=xxx` filter), `#/autotask` automated tasks. Router in `js/router.js`.

**Window globals:** HTML uses inline `onclick` handlers, `app.js` exposes functions to `window.*`.

**CSS structure:**
- `css/base.css` — Design tokens (`:root` variables), reset. "Warm Ink" design language with `--accent: #5B5BD6` indigo.
- `css/layout.css` — App shell: sidebar, topbar, main area
- `css/components.css` — Composer, search overlay, modals, toast
- `css/pages.css` — Per-page styles
- `css/ingest.css` — Ingest panel
- `css/ingest-queue.css` — Ingest queue panel
- `css/autotask.css` — Automated tasks page

### Adding a New Page

1. Create `app/js/pages/<name>.js` — export `rXxx(container)` render function
2. Create `app/css/<name>.css` (optional) — add `<link>` in `index.html`
3. `router.js` — add import, route match in `route()`, breadcrumb in `updBC()`, dispatch in `render()`
4. `app.js` — import onclick-callable functions, register on `window.*`, add to Escape handler if modal
5. `index.html` — add sidebar nav `<div class="sidebar-item">`, modal HTML shells if needed

### Data (`data/`)

Not tracked by git. Created automatically on first run.

```
data/wiki/          -> Compiled markdown articles, grouped by topic subdirectory
data/raw/           -> Immutable source materials
data/chats/         -> JSON conversation files + _index.json
data/autotasks/     -> tasks.json, history.json, dedup.json, history-archive-*.jsonl
data/system-sources.json -> 内置源 catalog (唯一被 git 跟踪的 data/ 文件)
data/vectors/       -> 向量索引
data/uploads/       -> Uploaded files
```

## Maintenance Scripts (`scripts/`)

全都是 `node scripts/xxx.js`，默认 dry-run，加 `--apply` 才落盘。

- **`wiki-doctor.js`** — 统一健康体检，只读。扫 6 类问题: 零字节僵尸、disk<->index.md 不同步、脏文件名、shell 文章、死链、缺 frontmatter。
- **`dedupe-wiki.js`** — 按原文聚合找重复；`--shells` 模式扫编译失败占位。
- **`clean-seealso.js`** — 扫文章 body 里的 markdown 链接，修复死链。
- **`rename-dirty-wiki.js`** — 把脏字符文件名重命名为 slug 化版本。
- **`seed-concepts.js`** — 聚合文章 tags，按 normalize key 分组选 canonical + 注册 alias，写入 `data/concepts.json`。
- **`bench.js`** — 向量 vs 关键词检索 A/B 测试。

## Key Patterns

- **No build system.** Edit CSS/JS files -> refresh browser. Server restart only needed for `server.js` changes.
- **ES module imports must use relative paths** with `.js` extension. If any import in the chain fails, the entire module tree silently fails (blank page).
- **Article page uses flex layout** with TOC as `order:-1` child (renders left). TOC HTML must be inside `.page-article` div, not outside it.
- **Article frontmatter 必须保留**: 所有 `data/wiki/**/*.md` 都有 `---\ntags: [...]\n---\n` 开头。用 `parseFrontmatter` + `serializeFrontmatter` 操作，不要直接字符串拼接。
- **inline `onclick` 字符串必须用 `jsAttr()` 不能用 `h()`**: `h()` 不转义 `'`，文件名里的引号会击穿 onclick 字符串。`jsAttr()` 用 JS 级 unicode 转义。
- **`safe(base, rel)` 路径穿越校验**: 所有拼文件路径的操作必须过 `safe()`。
- **Autotask 写锁**: `history.json` 并发写必须经过 `withAutotaskWriteLock(fn)` 串行化。
- **向量索引写入**: 必须经 `lib/vectors.js` 导出的 API，不要直接 `fs.writeFileSync`。
- **CSS overflow rule**: `overflow-y` 非 `visible` 时浏览器强制 `overflow-x` 从 `visible` 变 `auto`。滚动容器必须显式 `overflow-x:hidden`。
- **Contenteditable paste 清洗**: `.article-title` 走纯文本粘贴；`.article-body` 走 `sanitizeBodyHtml()` 白/灰/黑三张表清洗。新增 contenteditable 区域要走同款处理。
- **新增写路由**: 默认进 auth / CSRF / rate limit 三层中间件。高成本 LLM 端点加到 `EXPENSIVE_PREFIXES`（10 req/min）。
- **Ingest queue 前端联动**: `ingest-queue.js` 轮询 overview（活跃 2s / 空闲 10s）。侧边栏刷新靠 `lastRecentIds` 差集检测新完成项 -> 清 `state.td/gd/sd` + `updSidebarPages()`。投喂提交成功后自动展开队列面板。
- **前端 tab 状态持久化**: 用 localStorage，不走 hash query（会触发 router 全量重 render）。

## Conventions

- **UI language**: Multilingual — English (en), Chinese (zh), Japanese (ja), Korean (ko). Default: English. All user-facing strings go through `t(key, params)` from `i18n.js`; static HTML uses `data-i18n` / `data-i18n-title` / `data-i18n-ph` attributes. Adding a new i18n key requires entries in all 4 language blocks in `i18n.js`.
- Wiki articles written in Chinese (configurable via `wikiLang` setting); raw materials preserve original language
- Design tokens use CSS custom properties — change colors/radius in `base.css :root`
- Dark mode: `[data-theme="dark"]` overrides in each CSS file

## UI 设计原则

- **多 Tab 弹窗必须同高度**: 弹窗高度不允许随 Tab 内容跳动。固定外框高度，内容超出时面板内滚动，底部按钮栏吸底常驻。
- **长文内容宽度自适应**: 正文有阅读友好的宽度上限（约 860-920px），富余空间左右均分居中，不一律贴左。
