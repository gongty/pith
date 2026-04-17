# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Personal knowledge base app — AI-assisted wiki with chat, knowledge graph, content ingestion, and automated task scheduling. Chinese UI. Zero external dependencies on frontend.

## Running

```bash
./start.sh                                          # 推荐，内含环境变量（若存在）
WIKI_API_KEY=$(cat .api-key) node server.js        # .api-key 是本地便利文件（gitignored），内容为 sk-xxx
WIKI_API_KEY=sk-xxx node server.js                 # 手动指定
PORT=3000 WIKI_API_KEY=sk-xxx node server.js       # 自定义端口
WIKI_ADMIN_TOKEN=<至少 16 字符随机串> WIKI_API_KEY=sk-xxx node server.js  # 启用鉴权（生产/上云必需）
```

Default port: 3456. First run `npm install` to install dependencies (pdf-parse, @mozilla/readability, jsdom). No build step. Node.js stdlib + vanilla JS frontend.

**环境变量**
- `WIKI_API_KEY`（必需）：LLM provider 密钥。**server 只从此环境变量读，绝不落盘**。`.api-key` 是用户本地便利文件（gitignored），仅用于手动 `cat` 后喂给环境变量，server 不直接读取。
- `WIKI_ADMIN_TOKEN`（可选，生产必需）：≥16 字符启用 auth 中间件，所有写端点 + 敏感 GET 要求 `Authorization: Bearer <token>` 或 `wiki_admin_token` cookie。未设置或 <16 字符启动时 `console.warn` 提示，行为回到"所有端点匿名可访问"（仅限本地开发）。
- `AGGREGATOR_SCRIPT`（可选）：覆盖 autotask `aggregator` 源类型调用的 python 脚本路径。默认 `path.resolve(__dirname, '../../plugins/news-skills/news-aggregator-skill/scripts/fetch_news.py')`。
- `PORT`：默认 3456。

`start.sh` gitignored，丢了就用上面手动命令。

**No tests, no lint, no CI.** `package.json` 只有 `start` 脚本，`npm test` 返回 `exit 1`。验证改动靠浏览器手测 + 服务端日志 + `node test-persist-retry.js`（持久层单测，22 个断言）。

**运行时外部依赖（PATH 上需要）**：音视频本地转录路径需要 `ffmpeg` + `whisper`（失败时若 provider 是 openai 会 fallback 到 Whisper API）；autotask `aggregator` 源类型需要 `python3` 和 `AGGREGATOR_SCRIPT` 指向的脚本（**缺失时显式 reject 错误，不再静默返回空**）。图片 OCR / 文本/URL/PDF ingest 全走云 API，无本地二进制依赖。**本地 `claude` CLI 不再是运行依赖**：`callLLM` / `queryWiki` / `compileArticle` 遇到 `provider.format === 'cli'` 直接抛错，要求切换到云端 provider。

## Architecture

### Server (`server.js`)

Single-file raw Node.js HTTP server (~5400 lines). Key subsystems:

- **LLM Integration** — 6 cloud providers (Bailian/阿里云, OpenRouter, Anthropic, OpenAI, DeepSeek, custom) + 一个 `local` Claude CLI provider（**仅保留配置定义，实际不可用**：`callLLM` 和 `compileArticle` 都会对 `provider.format === 'cli'` 直接抛错）。`callLLM()` is the universal entry point. `getFullConfig()` merges `loadConfig()` (provider/model) + `loadApiKey()` (env var only). `pickModelByUse(provider, use, cfg)` resolves use-key ('fast' / 'main' / 'strong') to concrete model id with fallback. **默认 provider 是 `bailian`**（不再是 local），`loadConfig()` 在 config.json 缺失或未指定 provider 时回落到 bailian。`callLocalCLI` 函数体保留未删，但无调用方。
- **Compilation Engine** — `runCompilePipeline()` is the 7-stage pipeline: title → topic → content+summary(parallel) → tags → filename → seealso → persist. Each stage tracked via `startStage`/`doneStage`/`errorStage`. Tags are piggybacked: LLM content stage emits `<!-- tags: a, b, c -->` trailer, extracted after content, stripped from body. **只有 API compile 模式可用**（server-driven JSON 生成）；`compileArticle` 入口若 `provider.format === 'cli'` 会抛"文章编译不支持本地 CLI 模式，请切换到云端 provider"。Embedded rules in `COMPILE_RULES` constant. **失败契约**：content stage 空返回 / LLM 错误 → 把原始 rawBody 归档到 `data/raw/<topic>/failed/<ts>-<slug>.raw.md` 并 throw `content-stage-failed: ...`；persist 阶段任何 throw 都**冒泡到 caller**（不再 return-with-status）；**绝不**构造占位正文落盘。调用方（`_defaultProcessTask` / `executeAutotask` / chat 沉淀）都必须 try/catch；外层看 `task.status === 'done'` 二次校验。**Defensive guards at persist**: (1) `slugifyTitle()` 清洗 emoji / 弯引号 / 箭头 / 控制符，避免脏字符击穿前端 inline onclick；(2) filename 阶段若同 topic 下已存在同名文件，自动追加 `-2/-3/...` 避让，不覆盖他人文章；(3) persist 拒绝写入 `articleContent.trim().length < 200` 的近空文章（MIN_ARTICLE_BYTES，宁抛错也不留僵尸；之前是 40 字节门槛但占位兜底正文能超过，现在拉到 200 作第二道防线）；(4) 写 index.md / log.md 的显示文本走 `sanitizeDisplayText()` 剥 emoji / 转义管道符。
- **Tag System** — Articles store tags as YAML frontmatter: `---\ntags: [a, b, c]\n---\n`. Core functions around line 1290-1410: `parseFrontmatter(content)` / `serializeFrontmatter(data)` / `extractTitle(fp)` (skips fm) / `extractTags(fp)` (frontmatter first; falls back to `extractKeywords` with `TAG_FALLBACK_STOP` filter for legacy articles) / `collectExistingTags(limit)` (frequency-sorted, fed to LLM prompts for semantic convergence). `runBackfillTags({force, useModel})` regenerates tags for articles missing them; exposed via `POST /api/wiki/backfill-tags?force=1&useModel=main`. **Any code that writes .md files must preserve frontmatter** — use `parseFrontmatter` + `serializeFrontmatter`, never raw string concat.
- **Chat System** — JSON file storage in `data/chats/`. Per-conversation files `conv_*.json` + `_index.json` index. Supports context retrieval from wiki for RAG.
- **Wiki Data & Graph** — `searchWiki()` for full-text (BM25-ish 关键词) search. `retrieveContext(question)` for chat RAG：**lex + vec RRF 融合**——`searchWiki` 走词法、`vectors.vectorSearch` 走语义（cosine topK），RRF 合并后取前 N。融合参数读 `config.json` 的 `ask.{topK,rrfK,fuseTopN}`，默认 20/60/5。向量若未 ready 或 provider 不支持就 fallback 纯词法。`/api/wiki/tree` returns topic → children with `{title, tags, mtime}`. `/api/wiki/graph` 构两层图：**concept 节点（canonical tag，经 `lib/concepts.js` 的 stopword + hapax 双档过滤：`articleCount < 2` 的 tag 直接丢，命中 stopword 列表也丢）+ article 节点**。边：`co-concept`（两个 concept 在 ≥2 篇文章共现，权重 = 共现次数 × IDF）、`link`（markdown 里的 see-also / reference 显式链接，dangling target 过 `fs.existsSync`）、`contains`（article → parent concept，topic 同名优先，否则用最高频 tag）。**topic 已降级为 layout metadata（cluster 着色用）**，不再是独立 concept 节点。老的独立 `buildGraph()` 函数是 legacy（被保留但不被端点调用），修边权重 / 边类型改端点内联逻辑，不要改老函数。
- **Vector Retrieval (`lib/vectors.js`)** — 独立模块，`server.js` 加载。导出 `callEmbedding / buildVectorIndex / vectorSearch / vectorStats / isVectorReady / getBuildStatus`。索引落 `data/vectors/index.jsonl`（每行一个 chunk：`{path, chunkId, vec, heading, byteRange}`）+ `data/vectors/meta.json`（`{embedModel, dim, lastBuildAt, coverage}`）。**写策略**：先写 `.tmp` 再 `fs.renameSync` 原子替换，并发经 `__vectorWriteLock` 链式 Promise 串行化，不写 `.lock` 文件。**Provider 限制**：embedding 仅支持 `bailian / openai / custom`，其它（anthropic / deepseek / local / openrouter）抛 `NoEmbeddingProviderError`；`retrieveContext` 捕获后 fallback 到纯 lex。**增量索引**：`runCompilePipeline` 持久化后 fire-and-forget 调 `vectors.buildVectorIndex({paths:[relPath]})`；全量重建走 `POST /api/wiki/reindex-vectors?force=1`，状态 `GET /api/wiki/vectors/stats` 返回 `{..., build: {running, startedAt, finishedAt, error, result}}`，fire-and-forget 构建失败可通过此字段感知。新加 embedding provider 需在模块内白名单 + `__setConfigProvider(getFullConfig)` 已在启动时注入。
- **Ingest Pipeline** — Single-task queue. Accepts text/URL/PDF/image/audio/video/ZIP. Multi-format extraction: pdf-parse for PDF, Readability+jsdom for URL, LLM Vision for images, OpenAI Whisper or local ffmpeg+whisper for audio/video. Batch mode with progress tracking via `batchProgress` object polled by frontend.
- **Automated Tasks (AI 研究助手)** — 任务模型 v3：`{intent (NL 描述用户想要什么), sources[] (从 catalog 选), preferences{topics, deny}, feedback[] (up/down 历史)}`。Source 适配器在 `lib/sources.js`，五种类型：rss / changelog / aggregator (spawn `python3 fetch_news.py`) / webpage / api。**SSRF 防护** (`assertSafeUrl()`)：协议白名单 (http/https) + DNS 解析 + 私网/loopback/link-local/IPv4-mapped-IPv6/bracketed-IPv6 全拦截 + 重定向重新校验 + 响应硬上限 10 MB。assertSafeUrl 抛的 Error 带 `err.code='BLOCKED_URL'`，`isBlockedUrlError(e)` 辅助判别，`/api/autotask/test-source` 在 catch 中识别后返回 **HTTP 400** + 可读原因（如 `blocked private ip: 10.0.0.1`），非 BLOCKED_URL 错误仍走 500 脱敏。**覆盖范围**：rss / webpage / changelog / api 入口均显式 `await assertSafeUrl(url)`；aggregator 通过 `VALID_SUBSOURCES` 白名单 + python 脚本参数化，无 user-controlled URL。**Pipeline 阶段**: fetch → dedup (跨源 URL 规范化, `dedup.json` 30 天窗口) → prefilter (关键词) → gating (LLM relevance, 并发 5, 每条 15s race timeout + fail-open, 每条后 `setImmediate` 让 event loop 喘气) → smart_fill (前 7 天补抓) → processing (compile per item, **同 host 串行抓取 500ms 最小间隔**防反爬) → brief (LLM 生成简报 .md 写入 `data/wiki/`) → finalize。**Relevance gate 不硬编码 provider**：读 `config.provider` + `pickModelByUse(provider, 'fast', cfg)`，fallback 到 `config.model`。Item dedup 用复合键 `(url||title)+sourceId`，避免同一 URL 在不同 source 下被错杀。**`persistRun` 节流**：history.json 体量大（单 run 可达几百 KB），每条 gate 完成同步写会把 event loop 压垮（曾真实卡死 gating 17/65 不动 >3 min）；`persistRun()` 默认 1s debounce，phase 切换 / 初始化 / 终态必须 `persistRun({force:true})` 立即落盘，其它 progress tick 走节流。写本身仍过 `withAutotaskWriteLock(fn)` 串行化，**不要绕开直接 fs.writeFileSync**。**启动时 `reconcileOrphanRuns()`**：server 进程非正常退出留下 `status:'running'` 的孤儿 run，下次启动会被扫一遍改成 `error` 并追加 `errors[]` 说明，不会卡在运行中永远不动。**history.json 容量保底**：`saveHistory()` 用 `tmp+rename` 原子写；>100 条时按 `startedAt` 降序保留最近 100 条，其余按 YYYY-MM 分组 append 到 `data/autotasks/history-archive-<YYYY-MM>.jsonl`；**归档失败保全量不截断**（磁盘/权限问题时宁多留也不丢记录，console.error 大字报）。**run.items[] 的 status 值**：`ingested`（成功入库）/ `smart_fill`（补抓命中）/ `compile_error`（编译失败，`rec.reason` 带错误消息、`rec.rawArchivePath` 指向 failed 归档，失败 URL 不进 dedup 可下次重试）/ `fetch_error`（抓取阶段失败）/ `skipped` / `gated_out` / `kept_pending` / `brief`（简报 rec，`type:'brief'` + `articlePath` 指向 `data/wiki/brief/`，与 `run.briefPath` 并存作双保险，确保 wiki 树和队列对账一致）。Scheduler 每 5 min `setInterval`，支持 daily(HH:MM)/hourly/manual。
- **Autotask API** — `POST /api/autotask/configure` (envelope `{ok, config, warnings[]}` 创建/更新任务)、`POST /api/autotask/feedback` (action 映射：前端 `up`/`down` → 后端持久化为 `keep`/`drop`，喂 LLM gate)、`GET /api/autotask/sources` (列 catalog)、`POST /api/autotask/run/:id` (手动触发)、`GET /api/autotask/history` (默认只读主文件；`?includeArchive=1` 合并归档 cap 500 条 + >50MB 文件跳过)、`GET /api/autotask/history/:runId` (主文件未命中穿透扫 `history-archive-*.jsonl`，streaming readline)、`DELETE /api/autotask/history/:runId` (整块包 `withAutotaskWriteLock`)。
- **system-sources.json** — `data/system-sources.json` 是 51 个内置源 catalog (arxiv RSS, github changelogs, news aggregators 等)，`.gitignore` 用 `data/* + !data/system-sources.json` 例外放行（**唯一被 git 跟踪的 data/ 文件**）。新建任务 UI 从这里挑源；新增源直接编辑这个 JSON。
- **Static Files** — Serves `app/` directory. Path: `GET / → app/index.html`, `GET /css/base.css → app/css/base.css`, etc. `/login.html` 显式匿名可访问（即使 auth 启用）。
- **Auth & Hardening 中间件** — 主 request handler 入口（路由分派前）依次穿三层：**(1) CSRF**：`method !== 'GET'` 且 `Origin` 头存在时，要求 `Origin` host 与 `Host` header 一致，否则 403 `CSRF: Origin mismatch`。`Origin` 缺失不拦（允许同源无 Origin 的 fetch）。**(2) Rate limit**：按 `IP + 路径归一化键` 分桶（`conv_xxx` 之类的可变 id 段归一化为 `:id`），默认 30 req/min；`EXPENSIVE_PREFIXES` 命中（`/api/chat/:id/{message,regenerate}`、`/api/ingest*`、`/api/settings/test`、`/api/autotask/run/*`、`/api/auth/login`）10 req/min，超限 429。bucket Map 超 2000 条时清理。**(3) Auth**：顶部模块常量 `AUTH_ENABLED = (process.env.WIKI_ADMIN_TOKEN||'').trim().length >= 16`。启用后所有 `method !== 'GET'` 的 `/api/*` 以及敏感 GET（`/api/settings`、`/api/autotask/*`、`/api/wiki/backfill-tags`）要求 `Authorization: Bearer <ADMIN_TOKEN>` 或 `Cookie: wiki_admin_token=<ADMIN_TOKEN>`，否则 401。白名单：`/api/auth/login` `/api/auth/status` `/api/auth/logout` `/login.html`。启动时若 `WIKI_ADMIN_TOKEN` 未设置或 <16 字符，两条独立 `console.warn` 区分，视同未启用。**Auth 端点**：`POST /api/auth/login {token}` → 200 + `Set-Cookie: wiki_admin_token=...; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`；`POST /api/auth/logout` 清 cookie；`GET /api/auth/status` 匿名可访问，返回 `{authRequired, authenticated}`。**前端闭环**：`app/js/utils.js` 的 `api()` 捕获 401 后跳 `/login.html`（避免在登录页自身递归跳）；`app/login.html` 极简登录页，无模块依赖。

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
data/autotasks/     → tasks.json (intent+sources[]+preferences+feedback[] 配置), history.json (最近 100 条 runs), dedup.json (跨任务跨源 URL+hash 30 天窗口), history-archive-YYYY-MM.jsonl (超出 100 条后自动归档, 每行一个 JSON, append 模式)
data/system-sources.json → 51 个内置源 catalog (git 跟踪，via .gitignore !data/system-sources.json 例外)
data/vectors/       → 向量索引：index.jsonl (每行一个 chunk 的 vec + byteRange) + meta.json (embedModel/dim/coverage/lastBuildAt)
data/reports/       → Lint/health check reports
data/uploads/       → Uploaded files
```

## Maintenance Scripts (`scripts/`)

一次性 / 按需运行的知识库维护脚本。全都是 `node scripts/xxx.js`，默认 dry-run，加 `--apply` 才落盘。跑之前和跑之后都建议走一遍 `wiki-doctor.js` 核对。

- **`wiki-doctor.js`** — 统一健康体检，只读。按 critical / warning / info 分档扫 6 类问题：零字节僵尸、disk↔index.md 不同步、脏文件名、shell 文章（编译失败占位，历史遗留；修复后 pipeline 不再产出新 shell）、文章内死链（wiki 内 / `../../raw/` / `#/article/`）、legacy 缺 frontmatter。每项给出对应 fix 命令。退出码 = critical 数，可进 CI / cron。
- **`dedupe-wiki.js`** — 两种模式：默认按 `> 原文：[...]` 聚合找重复（保留 mtime 最早的）；`--shells` 模式按关键词 regex (`/正文编译失败/`、`/采集状态说明/` 等) 扫编译失败占位。`--apply` 删文件并同步清 `index.md` 里指向它们的表格行。
- **`clean-seealso.js`** — 扫文章 body 里的 markdown 链接，按 wiki 内 / `../../raw/` / `#/article/` 三路分类校验。dead 链接若在列表项里整行删，否则降级为纯文本 `[x]`；删完若 `## See Also` / `## 相关阅读` section 整段空了把标题也干掉。保留 frontmatter。
- **`rename-dirty-wiki.js`** — 把文件名里含 `'` / `"` / emoji / 弯引号 / 长破折号等脏字符的 .md 重命名为 slug 化版本（与 `slugifyTitle` 同口径），同时更新 `index.md` / `log.md` / 所有文章 body 里的 markdown 链接引用。冲突时追加 `-2/-3/...`。
- **`bench.js`** — 向量语义检索 vs BM25 关键词检索并发 A/B 测试（对照 commit `bench 脚本: 向量 vs 关键词并发 A/B 测试`）。

## Secrets — 安全红线

**API Key 只从环境变量 `WIKI_API_KEY` 读取，绝不落盘。**（代码实现已与此声明对齐，`saveApiKey` 函数和 `.api-key` 文件读取路径都已删除）

- `loadApiKey()` → `return process.env.WIKI_API_KEY || ''`，**无任何文件读取**
- `loadConfig()` → 只读 `config.json` 里的 provider/model/customBaseUrl/wikiLang/providers 等，不碰密钥
- `getFullConfig()` → 合并以上两者
- `GET /api/settings` → 只返回 `hasKey: true/false`，绝不返回密钥内容
- `PUT /api/settings` → 只保存 provider/model/customBaseUrl 等配置字段，**静默忽略请求体里的 apiKey 字段**（即使前端传了也不持久化）

**绝对不能做的事：**
- 把密钥写入任何文件（config.json、.env、.api-key 都不行）
- 在 API 响应里返回密钥的任何部分（包括 mask 后的）
- 把 data/、config.json、profile.json、start.sh 加入 git
- 把 `err.message` / stack trace 回传到 5xx 响应体（通用 500 一律返回 `{error: '服务端错误'}`，详细信息只进 `console.error`；业务错误如"文件不存在""配置缺失"可保留具体文案）

`.gitignore` 排除: `config.json`, `profile.json`, `.api-key`, `data/*` (但 `!data/system-sources.json` 例外), `node_modules/`, `start.sh`, `.claude/` (运行时 lock 目录)

## Key Patterns

- **No build system.** Edit CSS/JS files → refresh browser. Server restart only needed for `server.js` changes.
- **ES module imports must use relative paths** with `.js` extension (`'./utils.js'`, `'../state.js'`). If any import in the chain fails, the entire module tree silently fails (blank page).
- **Article page uses flex layout** with TOC as `order:-1` child (renders left). TOC HTML must be inside `.page-article` div, not outside it.
- **Force graph** parameters in `pages/graph.js`: repulsion `2500/(d²)`, spring length `160`, center gravity `0.005`. Tune these if node count changes significantly.
- **Ingest is single-threaded** — one compilation at a time. Batch mode processes items sequentially and updates `batchProgress` which frontend polls via `/api/ingest/batch/status`.
- **Autotask execution** reuses the ingest pipeline (`extractContent()` + `compileArticle()`). Each task run records to `history.json`。**dedup 顺序**：`markIngestedTimed(url)` 只在 compile 成功之后调用，失败 URL **不进 dedup** 保留下次重试机会。**run 结束收口**：`persistRun({force:true})` 前后各 `await withAutotaskWriteLock(()=>{})` 一次，确保所有 pending 节流写完成后再 `__persistRunState.delete(runId)`。
- **Autotask 写锁**：`history.json` 高频并发写（LLM gate / smart_fill / process 各阶段并发完成）必须经过 `withAutotaskWriteLock(fn)` 链式 Promise 串行化，**不要绕开直接 fs.writeFileSync**，否则会撕扯并发结果。
- **Autotask persistRun 节流**：`persistRun()` 默认 1s debounce，频繁 progress tick（gate 每条完成、processing 每条完成）走节流；**phase 切换 / 初始化 / 终态必须 `persistRun({force:true})` 立即落盘**，否则前端进度条跳动不连贯或终态丢失。在 mapLimit worker 内部 persistRun 后追加 `await new Promise(r => setImmediate(r))`，避免连续同步写把 `setTimeout`（race timeout）饿死。
- **server.js 无热加载** — 改 `server.js` 必须重启进程。`data/` 下 JSON 在进程内有内存缓存（如 autotasks 调度器、聊天索引），手改磁盘文件不会被感知，必须通过 API 改或重启。
- **CSS overflow rule**: When `overflow-y` is non-`visible`, browsers force `overflow-x` from `visible` to `auto`. Always set `overflow-x:hidden` explicitly on scroll containers to prevent unwanted horizontal scrollbars.
- **Article frontmatter 必须保留**：所有 `data/wiki/**/*.md` 都有 `---\ntags: [...]\n---\n` 开头。编辑代码（前后端）动 .md 内容时，先用 `parseFrontmatter` 拆分 → 改 body → 用 `serializeFrontmatter` + body 拼回。前端 `markdown.js` 也导出了 `parseFrontmatter`，`renderMd` 会自动剥离 fm。直接字符串拼接或 regex 截断会丢失元数据。
- **Graph 端点 vs buildGraph**：`/api/wiki/graph` 端点有自己的内联 concept + 边生成逻辑（hapax + stopword 双档过滤走 `lib/concepts.js` 的 `isStopConcept` / `normalizeTag`），不调用老的 `buildGraph()` 函数（legacy，保留未删）。修边权重 / 边类型 / 过滤规则都改端点内联块，不要改老函数也不要 fall back 用它。
- **inline `onclick` 字符串必须用 `jsAttr()` 不能用 `h()`**：`h()` 只转义 `& < > "`，**不转义 `'`**。HTML attribute 解码发生在 JS 解析之前，所以用 `&#39;` 之类 entity 也救不了 — 文件名里一个 `'` 就能击穿 `onclick="go('#/article/...')"` 的字符串字面量。`utils.js` 导出的 `jsAttr(s)` 用 JS 级 `\u0027 \u0022 \u2028 \u2029 ...` 转义，HTML 解码后仍是合法 JS 字符串。规则：**凡是要塞进 `onclick="foo('...')"` 里 `'` 或 `"` 之间的变量，全用 `jsAttr()`**。`h()` 只适合放在 HTML 内容或 `title="..."` / `data-x="..."` 这种纯 attribute 场景。机器生成的 ID（`genId` 前缀 + 时间戳 + 随机字母数字）是安全的，但文件路径 / 用户输入 / 标题 slug 一律走 jsAttr。
- **Article API 写入校验**：`POST /api/wiki/article` (新建) 会拒绝空 content（400）和同名已存在（409）。`PUT` (编辑) 允许覆盖但同样拒绝空 content。任何绕过这两个接口直接 `fs.writeFileSync` 到 `data/wiki/` 的代码都要自己做相同的防御。
- **向量索引写入不走 fs.writeFileSync**：`data/vectors/index.jsonl` 和 `meta.json` 的写入必须经 `lib/vectors.js` 导出的 API（`buildVectorIndex` 内部已用 `.tmp → rename` + `__vectorWriteLock` 串行化）。手动 `fs.writeFileSync` 会撕裂与 `meta.json` 的一致性且可能造成部分写。手删索引想强制重建用 `POST /api/wiki/reindex-vectors?force=1`，不要 rm 文件。
- **Contenteditable paste 清洗**：`app/js/pages/article.js` 里 `.article-title` 走 `setupTitlePlainPaste()` 强制纯文本粘贴（`innerText` 保存时会丢 HTML，但编辑态若带 inline style 会出现"首字母大其余小"的混排）；`.article-body` 走 `setupBodyPasteSanitize()` 通过 `sanitizeBodyHtml()` 按白/灰/黑三张表清洗（KEEP 标签 + 剥属性 / UNWRAP span·font / DROP script·style），只保留结构语义、剥所有 inline style / class / 颜色，并防 `javascript:` 协议。新增 contenteditable 区域要走同款处理。
- **`safe(base, rel)` 路径穿越校验**：所有拼 `data/wiki/<path>` 之类的文件操作必须过 `safe()`。实现用 `path.resolve(base, rel)` 得到绝对路径后，校验 `full === baseResolved || full.startsWith(baseResolved + path.sep)`；拒 `path.isAbsolute(rel)` 和空值。不要用朴素 `startsWith(base)` 防穿越（`/data/wiki` vs `/data/wiki-backup` 边界会被误判放行）。
- **新增会改服务器状态的路由**：默认自动进 auth / CSRF / rate limit 三层中间件。如果新路由需要**绕过鉴权**（例如公开只读端点），加到 auth 白名单数组里；如果是**高成本 LLM 端点**，加到 `EXPENSIVE_PREFIXES` 让它吃 10 req/min 的严格配额；路径归一化键若含可变 id（conv_xxx / at-xxx 等）确保被归一化，否则等于不限速。
- **前端 tab / 视图状态持久化**：需要跨刷新保留的 tab / 筛选状态，**不要**走 hash query（`?tab=xxx`）—— 切 tab 会触发 `hashchange` → router 全量重 render → 重新拉所有 API。用 localStorage（参考 `app/js/pages/autotask.js` 的 `TAB_STORAGE_KEY = 'autotask.tab'`：模块加载时从 localStorage 读初始值，切 tab 的回调里 `localStorage.setItem` + 页内 `renderPage(c)` 局部重绘，不动路由）。hash query 只用于需要分享 URL 的场景（如 `#/browse?tag=xxx`）。

## Conventions

- **严禁 emoji**（红线）：UI 文案、按钮、卡片图标、警告/错误前缀、commit message 一律不用任何 emoji（🟠 📄 🤗 ⚠️ ⚙️ 📥 ✅ ❌ 等都不行）。用户原话："太AI了，我讨厌这些垃圾 emoji"。需要图标用 SVG；状态用 CSS 圆点 + 文字。仅用户主动要求时例外。
- UI language: Chinese (中文)
- Wiki articles written in Chinese; raw materials preserve original language
- Design tokens use CSS custom properties — change colors/radius in `base.css :root`, they cascade everywhere
- Dark mode: `[data-theme="dark"]` overrides in each CSS file. Token overrides in `base.css`.
- **提交流程**：本仓库是父仓库 `BLANK_work` 的 git submodule，但日常只在 `wiki-app/` 内 `commit && push`，**不要**再回到父仓库 `git add wiki-app` 更新 submodule 指针（用户偏好：父仓库 submodule ref 允许滞后，需要时由用户手动对齐）。Remote: `https://github.com/gongty/wiki-app.git`，branch `main`。

## UI 设计原则（红线）

这些是用户明确强调的关键原则，新写或修改 UI 时必须遵守。违反就是不合格。

- **多 Tab 弹窗必须同高度**：一个弹窗内有 N 个 Tab 切换时，弹窗高度不允许随 Tab 内容变化而跳动。固定弹窗高度，内容超出时在面板内上下滚动；底部按钮栏（保存/取消）吸底常驻。实现方式参考 `.modal-card-tabs` / `.settings-tab-content`：`height + max-height` 固定外框，内部 flex 列，主体 `overflow-y:auto`，foot `flex-shrink:0`。
- **长文内容宽度与位置要跟随视口自适应**：文章等阅读型页面不能在宽屏下右侧留大片空白。正文要有阅读友好的宽度上限（约 860–920px），但富余空间应左右均分让正文居中，而不是一律贴左。实现方式参考 `.page-article-inner`：`flex:1 + max-width + margin-left:auto + margin-right:auto`，超宽屏（≥1600px）可放宽 max-width。
