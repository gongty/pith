// lib/vectors.js — 向量索引核心（团队 A / M1）
//
// 本模块负责：把 data/wiki/ 下的 Markdown 切块 → 调 embedding provider → 存成 JSONL 索引 →
// 提供 cosine 相似度检索。所有输入/输出都围绕 chunk 级别，article 级聚合由调用方负责。
//
// 关键约定（与 CLAUDE.md 对齐）：
//   1. API Key 只从环境变量 process.env.WIKI_API_KEY 读（经 loadApiKey），绝不落盘。
//   2. 只支持 bailian / openai / custom 三种 provider；anthropic / deepseek / local /
//      openrouter 遇到会抛 NoEmbeddingProviderError。
//   3. 写 data/vectors/index.jsonl 与 meta.json 时先写 .tmp 再 fs.renameSync 原子替换；
//      并发写通过内存 Promise 链 __vectorWriteLock 串行化，不写 .lock 文件。
//   4. 严禁 emoji（红线）。
//
// 导出（API_FROZEN 见 README 末尾）：
//   callEmbedding(texts, overrides?) -> Promise<Float32Array[]>
//   buildVectorIndex({ force?, paths? }?) -> Promise<{ total, added, updated, removed, skipped, durationMs, errors }>
//   vectorSearch(query, { topK? }?) -> Promise<Array<{ path, title, chunkId, chunkText, score, heading, byteRange }>>
//   vectorStats() -> { chunks, articles, coverage, lastBuildAt, embedModel, dim }
//   isVectorReady() -> boolean
//
// 手工验证：见 test-vectors.sh。

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

// ── 错误类型 ──
class NoEmbeddingProviderError extends Error {
  constructor(provider) {
    super(`embedding provider not supported: ${provider}`);
    this.code = 'NO_EMBEDDING_PROVIDER';
    this.provider = provider;
  }
}
class VectorIndexEmpty extends Error {
  constructor() {
    super('vector index is empty or not built yet');
    this.code = 'VECTOR_INDEX_EMPTY';
  }
}

// ── 路径常量（server.js 的 ROOT 是 wiki-app/，lib/ 是其子目录） ──
const ROOT = path.resolve(__dirname, '..');
const WIKI_DIR = path.join(ROOT, 'data', 'wiki');
const VEC_DIR = path.join(ROOT, 'data', 'vectors');
const INDEX_PATH = path.join(VEC_DIR, 'index.jsonl');
const META_PATH = path.join(VEC_DIR, 'meta.json');

const SUPPORTED_PROVIDERS = new Set(['bailian', 'openai', 'custom']);

// ── 写锁（模仿 server.js 的 withAutotaskWriteLock） ──
let __vectorWriteLock = Promise.resolve();
function withVectorWriteLock(fn) {
  const next = __vectorWriteLock.then(() => fn(), () => fn());
  __vectorWriteLock = next.catch(() => {});
  return next;
}

// ── 帮助：延迟引入 server.js 的配置函数（避免循环 require） ──
function getServerConfig() {
  // server.js 不把自己 exports 出来，所以用 process-level 注入。
  // 调用方（server.js）必须在启动时调用 __setConfigProvider() 注入回调。
  if (!__configProvider) {
    throw new Error('vectors.js: config provider not registered; call __setConfigProvider first');
  }
  return __configProvider();
}
let __configProvider = null;
function __setConfigProvider(fn) { __configProvider = fn; }

// ── Embedding 模型解析 ──
// 从配置拿 provider 的 embed 模型 id，不做 chat 模型回退。
function resolveEmbedModel(providerKey, cfg) {
  const providerCfg = cfg.providers && cfg.providers[providerKey];
  const list = (providerCfg && Array.isArray(providerCfg.models)) ? providerCfg.models : [];
  const pref = list.find(m => m && m.use === 'embed');
  if (pref && pref.id) return pref.id;
  // 默认兜底：bailian/openai 的内置默认 embed
  if (providerKey === 'bailian') return 'text-embedding-v3';
  if (providerKey === 'openai') return 'text-embedding-3-small';
  return '';
}

function resolveBaseUrl(providerKey, cfg) {
  if (providerKey === 'bailian') return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  if (providerKey === 'openai') return 'https://api.openai.com/v1';
  if (providerKey === 'custom') {
    let base = (cfg.customBaseUrl || '').trim();
    if (!base) throw new Error('custom provider 未配置 customBaseUrl');
    return base.replace(/\/+$/, '');
  }
  throw new NoEmbeddingProviderError(providerKey);
}

// ── callEmbedding：批量把文本丢给 provider，拿回 Float32Array[] ──
async function callEmbedding(texts, overrides = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const cfg = getServerConfig();
  const provider = (overrides.provider || cfg.provider || 'bailian');
  if (!SUPPORTED_PROVIDERS.has(provider)) throw new NoEmbeddingProviderError(provider);
  const model = overrides.model || resolveEmbedModel(provider, cfg);
  if (!model) throw new Error(`no embed model configured for provider ${provider}`);
  const baseUrl = resolveBaseUrl(provider, cfg);
  const apiKey = cfg.apiKey || '';
  if (!apiKey) throw new Error('WIKI_API_KEY 未设置，无法调用 embedding');

  const url = `${baseUrl}/embeddings`;
  const body = JSON.stringify({ model, input: texts });
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  };

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, { method: 'POST', headers, body });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        // 401/400 不重试
        if (resp.status === 400 || resp.status === 401) {
          throw new Error(`embedding ${resp.status}: ${text.slice(0, 300)}`);
        }
        throw new Error(`embedding http ${resp.status}: ${text.slice(0, 300)}`);
      }
      const data = await resp.json();
      const arr = (data && data.data) || [];
      if (!Array.isArray(arr) || arr.length !== texts.length) {
        throw new Error(`embedding 返回条数不匹配: ${arr.length} vs ${texts.length}`);
      }
      return arr.map(row => {
        const v = row.embedding;
        if (!Array.isArray(v)) throw new Error('embedding 响应缺少 embedding 字段');
        return Float32Array.from(v);
      });
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message || e);
      if (/\b(400|401)\b/.test(msg)) throw e;
      if (attempt < 2) {
        const delay = 500 * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('embedding 未知错误');
}

// ── 切块算法 ──
// 目标 600 字符 / 硬上限 900 / 段间 overlap 80 字；按 H1/H2/H3 切节区；代码块 / 表格不拆。
// 返回 [{ heading: string[], text, byteRange: [start,end] }]，text 为纯正文（未拼前置头）。

function splitSections(body) {
  // 把 body 按 heading 切出若干段；保留每段的 heading 路径。
  const lines = body.split('\n');
  const sections = [];
  let buf = [];
  let bufStart = 0;
  let cursor = 0;  // 字节偏移（Buffer.byteLength(..., 'utf8')）
  let lineStart = 0;
  const headingStack = [null, null, null]; // h1, h2, h3
  let currentHeading = [];

  function flush(endCursor) {
    if (buf.length === 0) return;
    const text = buf.join('\n');
    sections.push({
      heading: currentHeading.slice(),
      text,
      byteRange: [bufStart, endCursor]
    });
    buf = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    lineStart = cursor;
    const lineBytes = Buffer.byteLength(line, 'utf8') + (i < lines.length - 1 ? 1 : 0);
    const hm = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (hm) {
      flush(lineStart);
      const level = hm[1].length;
      const title = hm[2].trim();
      headingStack[level - 1] = title;
      for (let k = level; k < 3; k++) headingStack[k] = null;
      currentHeading = headingStack.filter(Boolean);
      bufStart = lineStart;
      buf.push(line);
    } else {
      if (buf.length === 0) bufStart = lineStart;
      buf.push(line);
    }
    cursor += lineBytes;
  }
  flush(cursor);
  return sections;
}

// 把一个 section 的 text 按 600/900/overlap 80 切成多块，保留代码块/表格完整。
function chunkSection(sectionText) {
  const TARGET = 600;
  const HARD = 900;
  const OVERLAP = 80;
  const lines = sectionText.split('\n');

  // 先把行聚合成"原子块"：连续的代码块（```...```）是一个原子；连续的表格行（|...|）是一个原子；其他按单行。
  const atoms = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.trim().startsWith('```')) {
      // 找到对应的结束 ```
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith('```')) j++;
      const block = lines.slice(i, Math.min(j + 1, lines.length)).join('\n');
      atoms.push({ text: block, atomic: true });
      i = Math.min(j + 1, lines.length);
      continue;
    }
    if (/^\s*\|/.test(ln)) {
      let j = i;
      while (j < lines.length && /^\s*\|/.test(lines[j])) j++;
      const block = lines.slice(i, j).join('\n');
      atoms.push({ text: block, atomic: true });
      i = j;
      continue;
    }
    atoms.push({ text: ln, atomic: false });
    i++;
  }

  const chunks = [];
  let cur = '';
  let curAtoms = [];

  function flushChunk() {
    const t = cur.replace(/^\n+|\n+$/g, '');
    if (t.length > 0) chunks.push(t);
    cur = '';
    curAtoms = [];
  }

  for (const atom of atoms) {
    const addLen = atom.text.length + (cur.length > 0 ? 1 : 0);
    // 若原子本身就超过 HARD 且非原子，拆单行其实不会发生；原子 atomic 的就整体放进去（可能超 HARD，接受）。
    if (cur.length > 0 && cur.length + addLen > HARD) {
      flushChunk();
      // overlap：从刚 flush 的末尾取 OVERLAP 字符带到下一块起始
      const prev = chunks[chunks.length - 1] || '';
      const carry = prev.slice(Math.max(0, prev.length - OVERLAP));
      if (carry) cur = carry + '\n';
    } else if (cur.length >= TARGET && !atom.atomic) {
      flushChunk();
      const prev = chunks[chunks.length - 1] || '';
      const carry = prev.slice(Math.max(0, prev.length - OVERLAP));
      if (carry) cur = carry + '\n';
    }
    cur += (cur.length > 0 ? '\n' : '') + atom.text;
    curAtoms.push(atom);
  }
  flushChunk();
  return chunks;
}

// 最小 frontmatter 解析（与 server.js 保持一致的行为）
function parseFrontmatterLocal(content) {
  if (!content) return { data: {}, body: '' };
  const m = content.match(/^\uFEFF?\s*---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { data: {}, body: content };
  return { data: {}, body: content.slice(m[0].length) };
}

function extractTitleFromBody(body, fallbackName) {
  const m = body.match(/^#+\s+(.+)/m);
  return m ? m[1].trim() : fallbackName;
}

// 返回文章所有 chunk 记录（已带 id / heading / byteRange / text），未带 vec。
function buildChunksForArticle(absPath) {
  const rawText = fs.readFileSync(absPath, 'utf-8');
  const { body } = parseFrontmatterLocal(rawText);
  const title = extractTitleFromBody(body, path.basename(absPath, '.md'));
  const sections = splitSections(body);

  const out = [];
  let chunkIndex = 0;
  for (const sec of sections) {
    const pieces = chunkSection(sec.text);
    for (const piece of pieces) {
      // 前置 heading 信息（仅作嵌入用，不写入 byteRange；chunkText 是纯正文 piece）
      const id = crypto.createHash('sha1').update(relPath(absPath) + '#' + chunkIndex).digest('hex');
      out.push({
        id,
        path: relPath(absPath),
        title,
        heading: sec.heading.slice(),
        chunkIndex,
        byteRange: sec.byteRange.slice(),
        text: piece
      });
      chunkIndex++;
    }
  }
  return out;
}

function relPath(absPath) {
  return path.relative(WIKI_DIR, absPath).split(path.sep).join('/');
}

function prefixedEmbedText(chunk) {
  const headLine = chunk.heading.length ? `## ${chunk.heading.join(' / ')}\n\n` : '';
  return `# ${chunk.title}\n${headLine}${chunk.text}`;
}

// ── 索引读写 ──
function ensureVecDir() {
  if (!fs.existsSync(VEC_DIR)) fs.mkdirSync(VEC_DIR, { recursive: true });
}

function readMeta() {
  try {
    if (fs.existsSync(META_PATH)) return JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));
  } catch {}
  return null;
}

function writeMetaAtomic(meta) {
  ensureVecDir();
  const tmp = META_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf-8');
  fs.renameSync(tmp, META_PATH);
}

// 把一个 chunk 记录序列化成 JSONL 行（vec 4 位小数节省空间）
function chunkToLine(record) {
  const vec = Array.from(record.vec || []).map(v => {
    if (!Number.isFinite(v)) return 0;
    return Math.round(v * 10000) / 10000;
  });
  const out = {
    id: record.id,
    path: record.path,
    mtime: record.mtime,
    title: record.title,
    heading: record.heading || [],
    chunkIndex: record.chunkIndex,
    byteRange: record.byteRange,
    text: record.text,
    vec
  };
  return JSON.stringify(out);
}

function parseLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

// 读现有 index.jsonl 到 map: path -> records[]
async function loadExistingIndex() {
  const byPath = new Map();
  if (!fs.existsSync(INDEX_PATH)) return byPath;
  const stream = fs.createReadStream(INDEX_PATH, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const rec = parseLine(line);
    if (!rec || !rec.path) continue;
    if (!byPath.has(rec.path)) byPath.set(rec.path, []);
    byPath.get(rec.path).push(rec);
  }
  return byPath;
}

function writeIndexAtomic(allRecords) {
  ensureVecDir();
  const tmp = INDEX_PATH + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    for (const r of allRecords) {
      fs.writeSync(fd, chunkToLine(r) + '\n');
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, INDEX_PATH);
}

// ── walkMd（lib 自备一个小版本） ──
function walkMdLocal(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name.startsWith('.')) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) { out.push(...walkMdLocal(full)); continue; }
    if (d.name.endsWith('.md')) out.push(full);
  }
  return out;
}

// 跳过 index.md / log.md（与其他地方一致）
function shouldSkipArticle(relp) {
  if (relp === 'index.md' || relp === 'log.md') return true;
  if (relp.startsWith('_') ) return true;
  return false;
}

// ── buildVectorIndex ──
async function buildVectorIndex({ force = false, paths = null } = {}) {
  const started = Date.now();
  const cfg = getServerConfig();
  const provider = cfg.provider || 'bailian';
  if (!SUPPORTED_PROVIDERS.has(provider)) throw new NoEmbeddingProviderError(provider);
  const embedModel = resolveEmbedModel(provider, cfg);
  if (!embedModel) throw new Error(`provider ${provider} 未配置 embed 模型`);
  // bailian dashscope embeddings 硬上限 batch<=10，其他 provider 按 config
  const rawBatch = (cfg.ask && cfg.ask.embedBatchSize) || 64;
  const batchSize = provider === 'bailian' ? Math.min(rawBatch, 10) : rawBatch;

  return withVectorWriteLock(async () => {
    ensureVecDir();
    const meta = readMeta();
    const providerChanged = !meta || meta.embedProvider !== provider || meta.embedModel !== embedModel;
    const fullRebuild = !!force || providerChanged;

    // 扫源文件
    // 语义说明：
    //   - fullRebuild：扫全库，existing 清空，全部重算
    //   - paths 非空（isIncremental）：只重建 paths 白名单里的文件，existing 里其他 path 的记录原样保留
    //   - 其余（paths=null/空）：扫全库，按 mtime 增量判断
    const isIncremental = !fullRebuild && Array.isArray(paths) && paths.length > 0;
    const allowSet = isIncremental
      ? new Set(paths.map(p => p.replace(/^\.?\/+/, '')))
      : null;
    let absFiles = walkMdLocal(WIKI_DIR);
    if (isIncremental) {
      absFiles = absFiles.filter(f => allowSet.has(relPath(f)));
    }
    absFiles = absFiles.filter(f => !shouldSkipArticle(relPath(f)));

    // 当前 index
    const existing = fullRebuild ? new Map() : await loadExistingIndex();
    const allRecords = []; // 最终要写回的全部记录
    let added = 0, updated = 0, removed = 0, skipped = 0;
    const errors = [];

    // 增量模式：把 existing 中不在 paths 白名单的记录原样保留到 allRecords，
    // 这部分文件本轮不碰（不计 skipped/added/updated/removed）
    let preservedFiles = 0;
    if (isIncremental) {
      for (const [p, recs] of existing.entries()) {
        if (allowSet.has(p)) continue; // 白名单内的文件交给下面 mtime 判断走正常流程
        for (const r of recs) allRecords.push(r);
        preservedFiles++;
      }
    }

    // 构建目标文件集合，顺便判断哪些文件需要重建
    const targetRel = new Set(absFiles.map(f => relPath(f)));

    // 先把"现有且仍存在、且 mtime 未变"的文件直接沿用
    for (const [p, recs] of existing.entries()) {
      if (!targetRel.has(p)) continue;  // 删除的文件后面统一剔除
      const abs = path.join(WIKI_DIR, p);
      let mtime = 0;
      try { mtime = Math.floor(fs.statSync(abs).mtimeMs); } catch { continue; }
      if (recs.length > 0 && recs[0].mtime === mtime && !fullRebuild) {
        for (const r of recs) allRecords.push(r);
        skipped++;
        targetRel.delete(p); // 标记已处理
      }
    }

    // 剩下的 targetRel 是需要重建的（新增 + 变更 + 全量模式下的全部）
    const toEmbed = []; // { chunk, prefixedText }
    const chunkOwnerIndex = []; // 用于回填 vec：allRecords 的下标（填 chunk 占位后）
    const perFileChunks = new Map(); // relp -> [{ chunk, idxInAll }]

    for (const relp of targetRel) {
      const abs = path.join(WIKI_DIR, relp);
      let mtime = 0;
      try { mtime = Math.floor(fs.statSync(abs).mtimeMs); } catch { continue; }
      let chunks;
      try {
        chunks = buildChunksForArticle(abs);
      } catch (e) {
        errors.push({ path: relp, error: e.message });
        continue;
      }
      const wasExisting = existing.has(relp);
      if (wasExisting) updated++; else added++;
      const arr = [];
      for (const c of chunks) {
        const record = {
          id: c.id,
          path: c.path,
          mtime,
          title: c.title,
          heading: c.heading,
          chunkIndex: c.chunkIndex,
          byteRange: c.byteRange,
          text: c.text,
          vec: null
        };
        const idxInAll = allRecords.push(record) - 1;
        arr.push({ record, idxInAll });
        toEmbed.push({ text: prefixedEmbedText(c), idxInAll });
      }
      perFileChunks.set(relp, arr);
    }

    // 计算删除数：
    //   - 增量模式：只统计 paths 白名单内、原本在 existing 里、但磁盘上已不存在的文件
    //     （白名单外的文件本轮不处理，不能算作 removed）
    //   - 全量/无 paths 模式：index 中存在但 absFiles 里没有的都算 removed
    if (isIncremental) {
      const diskTargetRel = new Set(absFiles.map(f => relPath(f)));
      for (const p of existing.keys()) {
        if (!allowSet.has(p)) continue; // 白名单外不统计
        if (!diskTargetRel.has(p)) removed++;
      }
    } else {
      for (const p of existing.keys()) {
        const stillTarget = absFiles.some(f => relPath(f) === p);
        if (!stillTarget) removed++;
      }
    }

    // 批量 embed
    for (let start = 0; start < toEmbed.length; start += batchSize) {
      const batch = toEmbed.slice(start, start + batchSize);
      const texts = batch.map(b => b.text);
      let vecs;
      try {
        vecs = await callEmbedding(texts);
      } catch (e) {
        errors.push({ phase: 'embed', batchStart: start, error: e.message });
        // 对失败批次的 chunk，填 null vec 的记录不能进 index；从 allRecords 中剔除它们
        for (const b of batch) {
          allRecords[b.idxInAll] = null;
        }
        continue;
      }
      for (let k = 0; k < batch.length; k++) {
        const rec = allRecords[batch[k].idxInAll];
        if (rec) rec.vec = vecs[k];
      }
    }

    // 过滤掉 null（embed 失败的）
    const finalRecords = allRecords.filter(r => r && r.vec && r.vec.length > 0);

    // 推断维度
    let dim = 0;
    if (finalRecords.length > 0) dim = finalRecords[0].vec.length;

    // Safety：增量模式下若 chunkCount 相对旧 meta 下降 > 20%，极可能是语义错误或
    // paths 传了过大范围把绝大多数文件"缩没了"。不 throw，仅 stderr 告警给运维看。
    if (isIncremental && meta && typeof meta.chunkCount === 'number' && meta.chunkCount > 0) {
      const oldCount = meta.chunkCount;
      const newCount = finalRecords.length;
      if (newCount < oldCount * 0.8) {
        const drop = ((1 - newCount / oldCount) * 100).toFixed(1);
        console.error(
          `[vectors][WARN] incremental buildVectorIndex caused chunkCount drop ${drop}% ` +
          `(old=${oldCount} → new=${newCount}, paths=${paths.length}, removed=${removed}). ` +
          `可能是 paths 参数覆盖了过多文件或 existing 未被保留，请排查调用方。`
        );
      }
    }

    writeIndexAtomic(finalRecords);

    const articleSet = new Set(finalRecords.map(r => r.path));
    const durationMs = Date.now() - started;
    const newMeta = {
      version: 1,
      dim,
      embedProvider: provider,
      embedModel,
      articleCount: articleSet.size,
      chunkCount: finalRecords.length,
      lastBuildAt: new Date().toISOString(),
      lastBuildDurationMs: durationMs,
      skippedPaths: []
    };
    writeMetaAtomic(newMeta);

    return {
      total: finalRecords.length,
      added,
      updated,
      removed,
      skipped,
      durationMs,
      errors
    };
  });
}

// ── vectorSearch ──
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function vectorSearch(query, { topK = 20 } = {}) {
  if (!isVectorReady()) throw new VectorIndexEmpty();
  const q = (query || '').toString().trim();
  if (!q) return [];
  const [qvec] = await callEmbedding([q]);
  if (!qvec || qvec.length === 0) return [];

  // 简单 topK：用数组维护，长度超过 topK 时按 score 排序截断
  const top = [];
  const stream = fs.createReadStream(INDEX_PATH, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let threshold = -Infinity;
  for await (const line of rl) {
    if (!line) continue;
    const rec = parseLine(line);
    if (!rec || !Array.isArray(rec.vec)) continue;
    const vec = Float32Array.from(rec.vec);
    const score = cosine(qvec, vec);
    if (top.length < topK) {
      top.push({ rec, score });
      if (top.length === topK) {
        top.sort((a, b) => a.score - b.score);
        threshold = top[0].score;
      }
    } else if (score > threshold) {
      top[0] = { rec, score };
      // 重新冒泡维护最小堆（小数据量，直接 sort 即可）
      top.sort((a, b) => a.score - b.score);
      threshold = top[0].score;
    }
  }

  top.sort((a, b) => b.score - a.score);
  return top.map(({ rec, score }) => ({
    path: rec.path,
    title: rec.title,
    chunkId: rec.id,
    chunkText: rec.text,
    score,
    heading: rec.heading || [],
    byteRange: rec.byteRange
  }));
}

// ── vectorStats / isVectorReady ──
function isVectorReady() {
  const meta = readMeta();
  if (!meta || !meta.chunkCount || meta.chunkCount <= 0) return false;
  if (!fs.existsSync(INDEX_PATH)) return false;
  try {
    const st = fs.statSync(INDEX_PATH);
    if (st.size <= 0) return false;
  } catch { return false; }
  return true;
}

function vectorStats() {
  const meta = readMeta();
  const chunks = meta ? (meta.chunkCount || 0) : 0;
  const articles = meta ? (meta.articleCount || 0) : 0;
  // coverage = 已索引文章 / 当前 wiki 目录下应索引的文章
  let totalArticles = 0;
  try {
    totalArticles = walkMdLocal(WIKI_DIR).filter(f => !shouldSkipArticle(relPath(f))).length;
  } catch {}
  const coverage = totalArticles > 0 ? Math.min(1, articles / totalArticles) : 0;
  return {
    chunks,
    articles,
    coverage,
    lastBuildAt: meta ? (meta.lastBuildAt || null) : null,
    embedModel: meta ? (meta.embedModel || '') : '',
    dim: meta ? (meta.dim || 0) : 0
  };
}

module.exports = {
  callEmbedding,
  buildVectorIndex,
  vectorSearch,
  vectorStats,
  isVectorReady,
  NoEmbeddingProviderError,
  VectorIndexEmpty,
  __setConfigProvider
};
