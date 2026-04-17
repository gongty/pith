// scripts/bench.js — 团队 F 基准测试：向量 vs 关键词 vs 融合
// 只读主干，不动 server.js / config.json。所有配置在本文件内。
// 运行：WIKI_API_KEY=$(cat .api-key) node scripts/bench.js

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const WIKI_DIR = path.join(ROOT, 'data', 'wiki');
const BENCH_DIR = path.join(ROOT, 'data', 'bench');
const VEC_DIR = path.join(ROOT, 'data', 'vectors');

if (!fs.existsSync(BENCH_DIR)) fs.mkdirSync(BENCH_DIR, { recursive: true });

// ── 基本校验 ──
const apiKey = process.env.WIKI_API_KEY;
if (!apiKey) {
  console.error('[bench] WIKI_API_KEY 未设置，中止');
  process.exit(2);
}

// ── 注入 config provider 给 lib/vectors.js ──
const vectors = require(path.join(ROOT, 'lib', 'vectors.js'));
const serverConfig = {
  provider: 'bailian',
  apiKey,
  // bailian embed 接口硬上限 batch=10
  ask: { embedBatchSize: 10 },
  providers: {
    bailian: {
      models: [{ id: 'text-embedding-v3', use: 'embed' }]
    }
  },
  customBaseUrl: ''
};
vectors.__setConfigProvider(() => serverConfig);

// ── chat LLM 调用（用于 query 生成 + judge） ──
// 直接走 bailian DashScope OpenAI-compatible /chat/completions
async function callChatLLM(systemPrompt, userPrompt, { model = 'qwen-turbo', temperature = 0.3, maxTokens = 2048, retries = 2 } = {}) {
  const url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature,
    max_tokens: maxTokens
  });
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };
  let lastErr;
  for (let a = 0; a <= retries; a++) {
    try {
      const resp = await fetch(url, { method: 'POST', headers, body });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        // 429 / 5xx 重试
        if (resp.status === 429 || resp.status >= 500) throw new Error(`chat ${resp.status}: ${text.slice(0, 200)}`);
        throw new Error(`chat ${resp.status}: ${text.slice(0, 300)}`);
      }
      const data = await resp.json();
      const content = (((data || {}).choices || [])[0] || {}).message?.content || '';
      return content;
    } catch (e) {
      lastErr = e;
      if (a < retries) {
        await new Promise(r => setTimeout(r, 800 * Math.pow(2, a)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ── 文件扫描 / frontmatter ──
function walkMd(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name.startsWith('.') || d.name.startsWith('_')) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) { out.push(...walkMd(full)); continue; }
    if (!d.name.endsWith('.md')) continue;
    if (d.name === 'index.md' || d.name === 'log.md') continue;
    out.push(full);
  }
  return out;
}

function parseFrontmatter(content) {
  if (!content) return { body: '' };
  const m = content.match(/^\uFEFF?\s*---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { body: content };
  return { body: content.slice(m[0].length) };
}

function relWiki(abs) {
  return path.relative(WIKI_DIR, abs).split(path.sep).join('/');
}

function extractTitleAndBody(abs) {
  const raw = fs.readFileSync(abs, 'utf-8');
  const { body } = parseFrontmatter(raw);
  const m = body.match(/^#+\s+(.+)/m);
  return { title: m ? m[1].trim() : path.basename(abs, '.md'), body };
}

// ── 关键词切词（bench 内临时实现）──
// 中英混合：中文按字 2-gram 切，英文/数字按空白+标点切
function tokenize(s) {
  if (!s) return [];
  const out = [];
  // 英文 / 数字 token
  const enMatches = s.toLowerCase().match(/[a-z0-9_]+/g) || [];
  for (const t of enMatches) if (t.length >= 2) out.push(t);
  // 中文按 2-gram
  const zh = s.replace(/[a-z0-9_\s\p{P}]/giu, '').replace(/[\u0000-\u007F]/g, '');
  for (let i = 0; i < zh.length - 1; i++) {
    const bg = zh.slice(i, i + 2);
    // 过滤纯空白
    if (/\S/.test(bg)) out.push(bg);
  }
  return out;
}

// ── 1. 确保索引 ──
async function ensureIndex() {
  const stats0 = vectors.vectorStats();
  if (vectors.isVectorReady() && stats0.chunks > 0) {
    console.log('[bench] 向量索引已存在:', stats0);
    return stats0;
  }
  console.log('[bench] 开始构建向量索引（batch=10，绕过 config.json 的 64）…');
  const t0 = Date.now();
  const result = await vectors.buildVectorIndex({ force: true });
  const dt = Date.now() - t0;
  console.log('[bench] 索引构建完成:', { ...result, totalMs: dt });
  const stats = vectors.vectorStats();
  console.log('[bench] stats:', stats);
  return stats;
}

// ── 2. 查询集生成 ──
async function generateQueries() {
  const qPath = path.join(BENCH_DIR, 'queries.json');
  if (fs.existsSync(qPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(qPath, 'utf-8'));
      if (Array.isArray(cached) && cached.length > 0) {
        console.log(`[bench] 复用已缓存查询集 ${cached.length} 条: ${qPath}`);
        return cached;
      }
    } catch {}
  }
  const all = walkMd(WIKI_DIR);
  // 固定 seed 采样
  const seed = 42;
  const pseudo = (n) => {
    // xorshift-ish deterministic shuffle
    const arr = all.slice();
    let s = seed;
    for (let i = arr.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const j = s % (i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, n);
  };
  const sampled = pseudo(25);
  console.log(`[bench] 从 ${all.length} 篇文章采样 ${sampled.length} 篇生成查询`);

  const queries = [];
  for (let i = 0; i < sampled.length; i++) {
    const abs = sampled[i];
    const rel = relWiki(abs);
    const { title, body } = extractTitleAndBody(abs);
    const snippet = body.replace(/\s+/g, ' ').slice(0, 1200);
    const sys = '你是一个帮助生成检索查询的助手。只返回严格 JSON，不要任何解释文字。';
    const user = `阅读下面这篇文章的标题和正文片段，为它生成 3 类中文查询问题。

标题：${title}
路径：${rel}
正文片段：
${snippet}

生成 3 个查询：
1. exact（精确类）：从文中抽一句关键事实，改写成疑问句，保留原文中的关键词
2. semantic（语义类）：同主题但换用同义词或英文/中文互译（例如 attention ↔ 注意力，scale ↔ 缩放），不用原文关键词
3. thematic（主题类）：不指向某个事实，而是提出这个主题层面的宏观问题

只返回 JSON：{"exact":"...","semantic":"...","thematic":"..."}`;
    try {
      const out = await callChatLLM(sys, user, { model: 'qwen-turbo', temperature: 0.3, maxTokens: 400 });
      const m = out.match(/\{[\s\S]*\}/);
      if (!m) { console.log(`[bench] [${i + 1}/${sampled.length}] 解析失败，跳过: ${rel}`); continue; }
      const j = JSON.parse(m[0]);
      if (j.exact) queries.push({ id: `q-${i}-exact`, kind: 'exact', query: j.exact.trim(), sourcePath: rel, sourceTitle: title });
      if (j.semantic) queries.push({ id: `q-${i}-semantic`, kind: 'semantic', query: j.semantic.trim(), sourcePath: rel, sourceTitle: title });
      if (j.thematic) queries.push({ id: `q-${i}-thematic`, kind: 'thematic', query: j.thematic.trim(), sourcePath: rel, sourceTitle: title });
      console.log(`[bench] [${i + 1}/${sampled.length}] 生成 3 条 / ${rel}`);
    } catch (e) {
      console.log(`[bench] [${i + 1}/${sampled.length}] 生成失败 ${rel}: ${e.message}`);
    }
  }
  fs.writeFileSync(qPath, JSON.stringify(queries, null, 2), 'utf-8');
  console.log(`[bench] 共 ${queries.length} 条查询写入 ${qPath}`);
  return queries;
}

// ── 3. 三路召回 ──

// L: 关键词（在内存中扫 body.toLowerCase + tokenize + substring 命中计数）
let _lexCache = null;
function getLexCache() {
  if (_lexCache) return _lexCache;
  const files = walkMd(WIKI_DIR);
  const docs = [];
  for (const f of files) {
    try {
      const { title, body } = extractTitleAndBody(f);
      const text = (title + '\n' + body).toLowerCase();
      docs.push({ path: relWiki(f), title, text });
    } catch {}
  }
  _lexCache = docs;
  return docs;
}

function lexSearch(query, topK = 5) {
  const t0 = Date.now();
  const toks = Array.from(new Set(tokenize(query)));
  const docs = getLexCache();
  const scored = [];
  for (const d of docs) {
    let score = 0;
    for (const tk of toks) {
      // substring 命中次数
      let cnt = 0;
      let idx = 0;
      while ((idx = d.text.indexOf(tk, idx)) !== -1) { cnt++; idx += tk.length; if (cnt > 200) break; }
      if (cnt > 0) score += cnt;
    }
    if (score > 0) scored.push({ path: d.path, title: d.title, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topK).map(s => s.path);
  return { paths: top, durationMs: Date.now() - t0 };
}

// V: 向量（vectorSearch(topK=20) → aggregate by article → top5）
async function vecSearch(query, topK = 5) {
  const t0 = Date.now();
  const raw = await vectors.vectorSearch(query, { topK: 20 });
  // aggregate by article — 取该文章最高 chunk score
  const byArt = new Map();
  for (const r of raw) {
    const prev = byArt.get(r.path);
    if (!prev || r.score > prev.score) byArt.set(r.path, { path: r.path, title: r.title, score: r.score });
  }
  const arr = Array.from(byArt.values()).sort((a, b) => b.score - a.score).slice(0, topK);
  return { paths: arr.map(a => a.path), durationMs: Date.now() - t0, raw };
}

// F: RRF 融合（lex top20 + vec top20 → RRF → top5）
function rrfFuse(lists, k = 60, topK = 5) {
  const score = new Map();
  for (const list of lists) {
    list.forEach((pth, i) => {
      score.set(pth, (score.get(pth) || 0) + 1 / (k + i + 1));
    });
  }
  return Array.from(score.entries()).sort((a, b) => b[1] - a[1]).slice(0, topK).map(([p]) => p);
}

async function fusedSearch(query, topK = 5) {
  const t0 = Date.now();
  // 取更大的 top 进 RRF
  const toks = Array.from(new Set(tokenize(query)));
  const docs = getLexCache();
  const lexScored = [];
  for (const d of docs) {
    let score = 0;
    for (const tk of toks) {
      let cnt = 0, idx = 0;
      while ((idx = d.text.indexOf(tk, idx)) !== -1) { cnt++; idx += tk.length; if (cnt > 200) break; }
      if (cnt > 0) score += cnt;
    }
    if (score > 0) lexScored.push({ path: d.path, score });
  }
  lexScored.sort((a, b) => b.score - a.score);
  const lexTop = lexScored.slice(0, 20).map(s => s.path);

  const vRaw = await vectors.vectorSearch(query, { topK: 20 });
  const vByArt = new Map();
  for (const r of vRaw) {
    const prev = vByArt.get(r.path);
    if (!prev || r.score > prev.score) vByArt.set(r.path, r.score);
  }
  const vecTop = Array.from(vByArt.entries()).sort((a, b) => b[1] - a[1]).map(([p]) => p).slice(0, 20);

  const fused = rrfFuse([lexTop, vecTop], 60, topK);
  return { paths: fused, durationMs: Date.now() - t0 };
}

// ── 4. 并发 worker pool ──
async function pool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let idx = 0;
  let fail = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= tasks.length) return;
      try {
        results[i] = await tasks[i]();
      } catch (e) {
        fail++;
        results[i] = { error: e.message };
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return { results, fail };
}

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor(p / 100 * s.length)));
  return s[idx];
}

// ── 5. 质量评测（judge） ──
const articleSummaryCache = new Map();
function readSummary(relPath) {
  if (articleSummaryCache.has(relPath)) return articleSummaryCache.get(relPath);
  const abs = path.join(WIKI_DIR, relPath);
  try {
    const { title, body } = extractTitleAndBody(abs);
    const s = body.replace(/\s+/g, ' ').slice(0, 800);
    const entry = { title, summary: s };
    articleSummaryCache.set(relPath, entry);
    return entry;
  } catch {
    const entry = { title: relPath, summary: '(读文件失败)' };
    articleSummaryCache.set(relPath, entry);
    return entry;
  }
}

async function judgeOne(query, candidates) {
  if (candidates.length === 0) return {};
  const letters = 'ABCDEFGHIJKLMNO'.split('');
  const listText = candidates.map((p, i) => {
    const { title, summary } = readSummary(p);
    return `[${letters[i]}] ${p} :: ${title}\n${summary}`;
  }).join('\n\n');
  const sys = '你是严格的相关性评审员。只返回 JSON，不解释。';
  const user = `用户问题：${query}

下面是候选文章（字母编号 + 路径 + 标题 + 前 800 字摘要）：

${listText}

请对每篇相对于问题的相关性打分 1-5：
5 = 直接回答问题 / 核心相关
4 = 明确相关但不全面
3 = 相关但需要推断
2 = 弱相关
1 = 无关

只返回 JSON，键为字母：{"A": 5, "B": 3, ...}`;
  try {
    const out = await callChatLLM(sys, user, { model: 'qwen-plus', temperature: 0, maxTokens: 400, retries: 1 });
    const m = out.match(/\{[\s\S]*\}/);
    if (!m) return {};
    const j = JSON.parse(m[0]);
    const byPath = {};
    candidates.forEach((p, i) => {
      const v = j[letters[i]];
      byPath[p] = Number.isFinite(v) ? Math.max(1, Math.min(5, v)) : null;
    });
    return byPath;
  } catch (e) {
    console.log(`[bench] judge 失败: ${e.message}`);
    return {};
  }
}

// nDCG@k with gains g = 2^rel - 1（rel 按 1-5；把 null 当 1）
function ndcgAt(paths, scoresMap, k = 5) {
  const rels = paths.slice(0, k).map(p => (scoresMap[p] ?? 1));
  const gains = rels.map(r => Math.pow(2, r) - 1);
  const dcg = gains.reduce((s, g, i) => s + g / Math.log2(i + 2), 0);
  // ideal: 把 scoresMap 里的分从高到低取前 k
  const allRels = Object.values(scoresMap).map(v => v ?? 1).sort((a, b) => b - a).slice(0, k);
  const igains = allRels.map(r => Math.pow(2, r) - 1);
  const idcg = igains.reduce((s, g, i) => s + g / Math.log2(i + 2), 0);
  return idcg > 0 ? dcg / idcg : 0;
}

// ── main ──
async function main() {
  const envStart = Date.now();
  const indexStats = await ensureIndex();

  const queries = await generateQueries();
  const qByKind = { exact: [], semantic: [], thematic: [] };
  for (const q of queries) if (qByKind[q.kind]) qByKind[q.kind].push(q);
  console.log('[bench] 查询集分布：', Object.fromEntries(Object.entries(qByKind).map(([k, v]) => [k, v.length])));

  // ── 串行 baseline ──
  console.log('\n[bench] ===== 串行 baseline =====');
  const serial = { L: [], V: [], F: [] };
  const retrieval = {}; // query.id -> { L, V, F }  (paths)
  let vecFail = 0;
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const rL = lexSearch(q.query, 5); serial.L.push(rL.durationMs);
    let rV, rF;
    try { rV = await vecSearch(q.query, 5); serial.V.push(rV.durationMs); }
    catch (e) { vecFail++; rV = { paths: [], durationMs: 0, error: e.message }; }
    try { rF = await fusedSearch(q.query, 5); serial.F.push(rF.durationMs); }
    catch (e) { rF = { paths: [], durationMs: 0, error: e.message }; }
    retrieval[q.id] = { L: rL.paths, V: rV.paths, F: rF.paths };
    if (i % 10 === 0) console.log(`[bench] serial ${i + 1}/${queries.length}`);
  }
  const serialStats = {
    L: { p50: pct(serial.L, 50), p95: pct(serial.L, 95), p99: pct(serial.L, 99), n: serial.L.length },
    V: { p50: pct(serial.V, 50), p95: pct(serial.V, 95), p99: pct(serial.V, 99), n: serial.V.length },
    F: { p50: pct(serial.F, 50), p95: pct(serial.F, 95), p99: pct(serial.F, 99), n: serial.F.length }
  };
  console.log('[bench] serial latency:', serialStats);

  // ── 并发压测 ──
  async function concurrentRun(concurrency) {
    const shuffled = queries.map(q => q).sort(() => Math.random() - 0.5);
    // 每个查询都跑 L / V / F 三次
    const mkTasks = (kind) => shuffled.map(q => async () => {
      const t0 = Date.now();
      let paths = [];
      try {
        if (kind === 'L') paths = lexSearch(q.query, 5).paths;
        else if (kind === 'V') paths = (await vecSearch(q.query, 5)).paths;
        else paths = (await fusedSearch(q.query, 5)).paths;
      } catch (e) { return { ms: Date.now() - t0, err: e.message }; }
      return { ms: Date.now() - t0, paths };
    });
    const report = {};
    for (const kind of ['L', 'V', 'F']) {
      const tStart = Date.now();
      const { results, fail } = await pool(mkTasks(kind), concurrency);
      const totalMs = Date.now() - tStart;
      const okMs = results.filter(r => r && !r.err).map(r => r.ms);
      const errs = results.filter(r => r && r.err);
      report[kind] = {
        total: results.length,
        fail,
        errCount: errs.length,
        p50: pct(okMs, 50),
        p95: pct(okMs, 95),
        p99: pct(okMs, 99),
        totalMs,
        sampleErrs: errs.slice(0, 3).map(e => e.err)
      };
    }
    return report;
  }

  console.log('\n[bench] ===== 并发 20 =====');
  const conc20 = await concurrentRun(20);
  console.log('[bench] conc20:', conc20);
  console.log('\n[bench] ===== 并发 40 =====');
  const conc40 = await concurrentRun(40);
  console.log('[bench] conc40:', conc40);

  // ── Judge 打分 ──
  console.log('\n[bench] ===== judge =====');
  const judgeRes = {}; // query.id -> pathScores
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const r = retrieval[q.id];
    const merged = Array.from(new Set([...(r.L || []), ...(r.V || []), ...(r.F || [])]));
    if (merged.length === 0) { judgeRes[q.id] = {}; continue; }
    const scores = await judgeOne(q.query, merged);
    judgeRes[q.id] = scores;
    if (i % 10 === 0) console.log(`[bench] judged ${i + 1}/${queries.length}`);
  }

  // ── 汇总质量 ──
  function aggQuality(qs) {
    const metrics = { L: { ndcg: [], top1: [], avgTop5: [] }, V: { ndcg: [], top1: [], avgTop5: [] }, F: { ndcg: [], top1: [], avgTop5: [] } };
    for (const q of qs) {
      const r = retrieval[q.id];
      const sc = judgeRes[q.id] || {};
      for (const kind of ['L', 'V', 'F']) {
        const paths = r[kind] || [];
        const ndcg = ndcgAt(paths, sc, 5);
        const top1 = paths[0] ? (sc[paths[0]] ?? 1) : 0;
        const top5 = paths.slice(0, 5).map(p => sc[p] ?? 1);
        const avg5 = top5.length ? top5.reduce((a, b) => a + b, 0) / top5.length : 0;
        metrics[kind].ndcg.push(ndcg);
        metrics[kind].top1.push(top1);
        metrics[kind].avgTop5.push(avg5);
      }
    }
    const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    return {
      L: { ndcg: mean(metrics.L.ndcg), top1: mean(metrics.L.top1), avgTop5: mean(metrics.L.avgTop5), n: qs.length },
      V: { ndcg: mean(metrics.V.ndcg), top1: mean(metrics.V.top1), avgTop5: mean(metrics.V.avgTop5), n: qs.length },
      F: { ndcg: mean(metrics.F.ndcg), top1: mean(metrics.F.top1), avgTop5: mean(metrics.F.avgTop5), n: qs.length }
    };
  }

  const quality = {
    exact: aggQuality(qByKind.exact),
    semantic: aggQuality(qByKind.semantic),
    thematic: aggQuality(qByKind.thematic),
    all: aggQuality(queries)
  };

  // ── 找典型案例 ──
  const cases = { vWins: [], fWins: [], lWins: [] };
  for (const q of queries) {
    const sc = judgeRes[q.id] || {};
    const r = retrieval[q.id];
    const ndcgL = ndcgAt(r.L || [], sc, 5);
    const ndcgV = ndcgAt(r.V || [], sc, 5);
    const ndcgF = ndcgAt(r.F || [], sc, 5);
    if (ndcgV - ndcgL > 0.15 && ndcgV >= ndcgF) cases.vWins.push({ q, ndcgL, ndcgV, ndcgF, sc, r });
    else if (ndcgF - ndcgL > 0.15) cases.fWins.push({ q, ndcgL, ndcgV, ndcgF, sc, r });
    if (ndcgL - Math.max(ndcgV, ndcgF) > 0.1) cases.lWins.push({ q, ndcgL, ndcgV, ndcgF, sc, r });
  }

  // ── 写报告 ──
  const envMs = Date.now() - envStart;
  const summary = {
    indexStats,
    envMs,
    queryCount: queries.length,
    kinds: Object.fromEntries(Object.entries(qByKind).map(([k, v]) => [k, v.length])),
    serial: serialStats,
    conc20,
    conc40,
    quality,
    vecFail,
    cases: {
      vWins: cases.vWins.length,
      fWins: cases.fWins.length,
      lWins: cases.lWins.length
    }
  };
  fs.writeFileSync(path.join(BENCH_DIR, 'summary.json'), JSON.stringify({ summary, retrieval, judgeRes }, null, 2), 'utf-8');

  writeReport(summary, queries, retrieval, judgeRes, cases);

  console.log('\n[bench] DONE. 报告：data/bench/report.md');
}

function fmtMs(ms) { if (!Number.isFinite(ms)) return '-'; return ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : Math.round(ms) + 'ms'; }
function fmt3(n) { return (Math.round(n * 1000) / 1000).toFixed(3); }

function writeReport(s, queries, retrieval, judgeRes, cases) {
  const lines = [];
  lines.push('# 向量 vs 关键词 vs 融合 — 基准测试报告');
  lines.push('');
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push(`工作目录：${ROOT}`);
  lines.push('');
  lines.push('## 1. 环境指标');
  lines.push('');
  lines.push(`- 向量索引：chunks=${s.indexStats.chunks}, articles=${s.indexStats.articles}, coverage=${fmt3(s.indexStats.coverage)}, dim=${s.indexStats.dim}, model=${s.indexStats.embedModel}`);
  lines.push(`- 最近一次 build：${s.indexStats.lastBuildAt}`);
  lines.push(`- 文章源：data/wiki/**/*.md，总数 ${_lexCache ? _lexCache.length : 'N/A'}`);
  lines.push(`- 总耗时：${fmtMs(s.envMs)}`);
  lines.push(`- 向量 provider：bailian / text-embedding-v3（绕开 config.json 的 embedBatchSize=64，bench 用 batch=10）`);
  lines.push(`- chat / judge provider：bailian qwen-turbo（生成查询）+ qwen-plus（judge）`);
  lines.push('');
  lines.push('## 2. 查询集');
  lines.push('');
  lines.push(`- 采样文章数：25（固定 seed=42 打散取前 25）`);
  lines.push(`- 每篇生成 exact / semantic / thematic 各 1 条，合计理论 75 条，实际 ${s.queryCount} 条`);
  lines.push('');
  lines.push('| 类别 | 数量 |');
  lines.push('|---|---|');
  for (const [k, v] of Object.entries(s.kinds)) lines.push(`| ${k} | ${v} |`);
  lines.push('');

  lines.push('## 3. 延迟对照表');
  lines.push('');
  lines.push('### 3.1 串行 baseline（单 query 耗时）');
  lines.push('');
  lines.push('| 策略 | n | p50 | p95 | p99 |');
  lines.push('|---|---|---|---|---|');
  for (const k of ['L', 'V', 'F']) {
    const r = s.serial[k];
    lines.push(`| ${k} | ${r.n} | ${fmtMs(r.p50)} | ${fmtMs(r.p95)} | ${fmtMs(r.p99)} |`);
  }
  lines.push('');
  lines.push('### 3.2 并发 20');
  lines.push('');
  lines.push('| 策略 | total | p50 | p95 | p99 | wall(全部完成) | 错误数 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const k of ['L', 'V', 'F']) {
    const r = s.conc20[k];
    lines.push(`| ${k} | ${r.total} | ${fmtMs(r.p50)} | ${fmtMs(r.p95)} | ${fmtMs(r.p99)} | ${fmtMs(r.totalMs)} | ${r.errCount} |`);
  }
  lines.push('');
  if (s.conc20.V.sampleErrs && s.conc20.V.sampleErrs.length) {
    lines.push('并发 20 错误样例（V）：');
    for (const e of s.conc20.V.sampleErrs) lines.push(`- ${e}`);
    lines.push('');
  }
  lines.push('### 3.3 并发 40');
  lines.push('');
  lines.push('| 策略 | total | p50 | p95 | p99 | wall | 错误数 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const k of ['L', 'V', 'F']) {
    const r = s.conc40[k];
    lines.push(`| ${k} | ${r.total} | ${fmtMs(r.p50)} | ${fmtMs(r.p95)} | ${fmtMs(r.p99)} | ${fmtMs(r.totalMs)} | ${r.errCount} |`);
  }
  lines.push('');
  if (s.conc40.V.sampleErrs && s.conc40.V.sampleErrs.length) {
    lines.push('并发 40 错误样例（V）：');
    for (const e of s.conc40.V.sampleErrs) lines.push(`- ${e}`);
    lines.push('');
  }

  lines.push('## 4. 质量对照表');
  lines.push('');
  function qualityTable(title, q) {
    lines.push(`### ${title}（n=${q.L.n}）`);
    lines.push('');
    lines.push('| 策略 | nDCG@5 | Top-1 rel | top-5 平均相关性 |');
    lines.push('|---|---|---|---|');
    for (const k of ['L', 'V', 'F']) {
      const r = q[k];
      lines.push(`| ${k} | ${fmt3(r.ndcg)} | ${fmt3(r.top1)} | ${fmt3(r.avgTop5)} |`);
    }
    lines.push('');
  }
  qualityTable('Q-exact（精确类）', s.quality.exact);
  qualityTable('Q-semantic（语义类）', s.quality.semantic);
  qualityTable('Q-thematic（主题类）', s.quality.thematic);
  qualityTable('All（合并）', s.quality.all);

  lines.push('## 5. 典型案例');
  lines.push('');
  function caseBlock(label, c, limit) {
    lines.push(`### ${label}`);
    lines.push('');
    const arr = c.slice(0, limit);
    if (arr.length === 0) { lines.push('（无典型案例）'); lines.push(''); return; }
    for (const x of arr) {
      lines.push(`- **查询**（${x.q.kind}）：${x.q.query}`);
      lines.push(`  - 源文章：${x.q.sourcePath}`);
      lines.push(`  - nDCG@5 — L: ${fmt3(x.ndcgL)}, V: ${fmt3(x.ndcgV)}, F: ${fmt3(x.ndcgF)}`);
      const fmtPaths = (paths) => paths.map(p => `${p}(${x.sc[p] ?? '-'})`).join(' / ');
      lines.push(`  - L top5: ${fmtPaths(x.r.L || [])}`);
      lines.push(`  - V top5: ${fmtPaths(x.r.V || [])}`);
      lines.push(`  - F top5: ${fmtPaths(x.r.F || [])}`);
      lines.push('');
    }
  }
  caseBlock('5.1 V 或 F 显著胜出 L（挑前 3 条）', [...cases.vWins, ...cases.fWins].sort((a, b) => (b.ndcgV + b.ndcgF - b.ndcgL * 2) - (a.ndcgV + a.ndcgF - a.ndcgL * 2)), 3);
  caseBlock('5.2 L 胜出 V/F（反例，挑前 2 条）', cases.lWins.sort((a, b) => (b.ndcgL - Math.max(b.ndcgV, b.ndcgF)) - (a.ndcgL - Math.max(a.ndcgV, a.ndcgF))), 2);

  lines.push('## 6. 数据结论');
  lines.push('');
  const qe = s.quality.exact, qs = s.quality.semantic, qt = s.quality.thematic;
  const rel = (a, b) => (a - b) / (b || 1);
  const semVoverL = qs.V.ndcg - qs.L.ndcg;
  const semFoverL = qs.F.ndcg - qs.L.ndcg;
  const exaVoverL = qe.V.ndcg - qe.L.ndcg;
  const exaFoverL = qe.F.ndcg - qe.L.ndcg;
  const themVoverL = qt.V.ndcg - qt.L.ndcg;
  const themFoverL = qt.F.ndcg - qt.L.ndcg;

  lines.push(`- **语义查询**：V 的 nDCG@5 比 L ${semVoverL >= 0 ? '高' : '低'} ${fmt3(Math.abs(semVoverL))}（绝对差），相对 ${fmt3(rel(qs.V.ndcg, qs.L.ndcg) * 100)}%；F 相对 L ${fmt3(rel(qs.F.ndcg, qs.L.ndcg) * 100)}%。`);
  lines.push(`- **精确查询**：V 相对 L 差 ${fmt3(Math.abs(exaVoverL))}（${fmt3(rel(qe.V.ndcg, qe.L.ndcg) * 100)}%），F 相对 L 差 ${fmt3(Math.abs(exaFoverL))}（${fmt3(rel(qe.F.ndcg, qe.L.ndcg) * 100)}%）。${exaVoverL < -0.05 ? '向量在精确查询上有退步，关键词命中被稀释。' : '向量在精确查询上未见明显退步。'}`);
  lines.push(`- **主题查询**：V 对 L 绝对差 ${fmt3(themVoverL)}，F 对 L 绝对差 ${fmt3(themFoverL)}。`);
  const c40V = s.conc40.V;
  lines.push(`- **并发上限**：并发 40 时 V 策略错误 ${c40V.errCount}/${c40V.total}（${fmt3(c40V.errCount / c40V.total * 100)}%）；p95 ${fmtMs(c40V.p95)}。${c40V.errCount / c40V.total > 0.03 ? 'API 在并发 40 下已显著限流/退化。' : '并发 40 仍可接受。'}`);
  lines.push('');
  // 推荐
  const semGainFusion = semFoverL > 0.1 && exaFoverL > -0.05;
  const exactLWin = exaFoverL < -0.1;
  let recommendation;
  if (semFoverL > 0.05 && exaFoverL > -0.05 && themFoverL > 0) {
    recommendation = '**保留融合（L + V via RRF）**：语义查询明显获益，精确查询未明显退步，主题查询改善。';
  } else if (semVoverL > 0.1 && exaVoverL > -0.05) {
    recommendation = '**可考虑单走向量**：V 已全面追平或超越 L。';
  } else if (exactLWin && semFoverL < 0.05) {
    recommendation = '**维持关键词**：向量成本未换来足够收益，且精确查询有退步。';
  } else {
    recommendation = '**保留融合，但调整权重**：可把 L / V 的 RRF 权重改为不对称（如语义查询 V 权重更高、精确查询 L 权重更高）。';
  }
  lines.push(`- **最终建议**：${recommendation}`);
  lines.push('');
  lines.push('## 7. 备注与局限');
  lines.push('');
  lines.push(`- bench 的 lex 路径是 bench 内临时实现（tokenize 中英混合 + substring 命中计数），与 server.js 的 searchWiki 行为接近但不完全等价。`);
  lines.push(`- judge 使用 qwen-plus（单一模型），存在评分偏差；每个查询只评一次，未做 judge-agreement 校验。`);
  lines.push(`- 并发压测受 bailian embedding API 速率限制，结果受网络波动影响。`);
  lines.push(`- 查询生成由 qwen-turbo 进行，对文章内容的覆盖度依赖采样质量。`);
  lines.push('');

  fs.writeFileSync(path.join(BENCH_DIR, 'report.md'), lines.join('\n'), 'utf-8');
  console.log('[bench] 报告写入 data/bench/report.md，长度', lines.length, '行');
}

main().catch(err => {
  console.error('[bench] FATAL', err);
  process.exit(1);
});
