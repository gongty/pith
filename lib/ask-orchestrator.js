// lib/ask-orchestrator.js — M3 多跳问答后端 + SSE 协议。
//
// 对外只暴露 handleAsk(req, res, deps)：
//   - 请求 body 含 clarifyAnswers(null/undefined) → 返回 JSON { stage:'clarify', clarifyQuestions:[...] }
//   - 请求 body 含 clarifyAnswers 为对象 → 走 SSE，事件名冻结为：
//       plan / retrieve / delta / cite / done / error
//
// deps 由 server.js 注入，避免 orchestrator 反向依赖 server.js：
//   { callLLM, pickModelByUse, getFullConfig, retrieveContext, WIKI_DIR, fs, path }
//
// 向量检索依赖延迟 require：仅使用 lib/vectors.js（团队 A 已产出）。
// isVectorReady() 为 false 时，orchestrator 会改走 lexical(retrieveContext) 降级。

let _vectorsMod = null;
function getVectorsMod() {
  if (_vectorsMod) return _vectorsMod;
  _vectorsMod = require('./vectors.js');
  return _vectorsMod;
}

// ── Prompt 模板（中文，无 emoji，冻结） ──
const CLARIFY_PROMPT = (question) => `你在帮用户查询一个本地中文知识库。用户原问题：${question}

判断该问题是否足够具体、可以直接检索。
- 如果具体（有明确主题、时间感、范围感），返回：{"clarifyQuestions": []}
- 如果有多种合理解读（话题宽泛、时间范围不清、深度预期不明），最多生成 3 条澄清问题，每条提供 2-4 个选项。

只返回 JSON，不解释，不加 Markdown 围栏。结构：
{"clarifyQuestions":[{"id":"<snake_case>","text":"<一句话>","options":["...","..."]}]}`;

const PLAN_PROMPT = (refined, currentQuery, refsBrief) => `用户原问题：${refined}
上次检索 query：${currentQuery}
已检索到的文章（标题 + 路径 + 摘录 300 字）：
${refsBrief}

判断是否需要额外一跳检索来补全答案。
- 若已充分：{"needMore": false}
- 若需补充（发现新角度 / 关键子主题未覆盖）：{"needMore": true, "nextQuery": "<中文短语>", "reason": "<一句话>"}

只返回 JSON，不解释。`;

const ANSWER_PROMPT = (chunksText, refined) => `基于下面的知识库摘录，回答用户问题。要求：
1. 中文作答
2. 每次引用某篇文章时，在句末用 Markdown 链接标注：[标题](相对路径)
3. 不编造摘录外的内容；信息不足直接说"知识库内未覆盖"
4. 结构化输出，合适时用小节标题
5. 答复末尾另起一行输出 "CITATIONS:" 接逗号分隔的所有实际引用的文章路径

摘录：
${chunksText}

用户问题：${refined}`;

// ── 默认预算 / 上限 ──
const DEFAULTS = {
  timeoutMs: 60000,
  maxHops: 3,
  topK: 6,
  maxAnswerTokens: 2048,
  clarifyMaxTokens: 512,
  planMaxTokens: 256
};

// ── 工具 ──
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1024 * 256) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

// 从 LLM 返回中提取 JSON 对象，容错 Markdown 围栏 / 前缀文字。
function extractJson(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  // 剥 ```json ... ``` 或 ``` ... ```
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : trimmed;
  // 取第一个 { ... }（贪婪到最后一个 }，配合 try）
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first < 0 || last < 0 || last <= first) return null;
  const slice = candidate.slice(first, last + 1);
  try { return JSON.parse(slice); } catch { return null; }
}

function sseWrite(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  try {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    res.write(`event: ${event}\n`);
    res.write(`data: ${payload}\n\n`);
  } catch {
    // socket 断了也别炸
  }
}

// 把一批 chunks 压成给 Plan prompt 用的 refsBrief：title + path + 300 字摘录
function formatRefsBrief(refs) {
  return refs.slice(0, 10).map((r, i) => {
    const excerpt = (r.chunkText || r.excerpt || '').replace(/\s+/g, ' ').slice(0, 300);
    return `[${i + 1}] ${r.title || r.path}（${r.path}）\n   ${excerpt}`;
  }).join('\n');
}

// 把 chunks 汇总成 Answer prompt 中的摘录段
function formatChunksForAnswer(refs) {
  return refs.map((r, i) => {
    const excerpt = (r.chunkText || r.excerpt || '').slice(0, 1200);
    return `### 摘录 ${i + 1} — ${r.title || r.path}（${r.path}）\n${excerpt}`;
  }).join('\n\n');
}

// 把 wiki lexical retrieveContext 的结果映射到 vector 统一 shape
async function lexicalToRefs(question, retrieveContext) {
  try {
    const { articleContents, references } = await retrieveContext(question);
    const refs = [];
    for (let i = 0; i < references.length; i++) {
      const ref = references[i];
      const body = articleContents[i] || '';
      // articleContents 格式："### title (path)\n\ncontent"，需要剥标题行再给 chunkText
      const strippedBody = body.replace(/^###[^\n]*\n+/, '');
      refs.push({
        path: ref.path,
        title: ref.title,
        chunkId: `${ref.path}#lexical`,
        chunkText: strippedBody.slice(0, 1500),
        score: Math.max(0.1, 1 - i * 0.12),
        heading: '',
        byteRange: [0, 0]
      });
    }
    return refs;
  } catch {
    return [];
  }
}

// 主入口
async function handleAsk(req, res, deps) {
  const { callLLM, pickModelByUse, getFullConfig, retrieveContext } = deps || {};
  if (!callLLM || !pickModelByUse || !getFullConfig || !retrieveContext) {
    return sendJSON(res, 500, { error: 'ask orchestrator deps missing' });
  }

  let payload;
  try {
    const raw = await readBody(req);
    payload = raw ? JSON.parse(raw) : {};
  } catch (e) {
    return sendJSON(res, 400, { error: `bad body: ${e.message}` });
  }

  const question = (payload && typeof payload.question === 'string') ? payload.question.trim() : '';
  if (!question) return sendJSON(res, 400, { error: '缺少 question' });

  const clarifyAnswers = payload ? payload.clarifyAnswers : undefined;
  const hasAnswers = clarifyAnswers && typeof clarifyAnswers === 'object';

  const cfg = getFullConfig();
  const askCfg = (cfg && cfg.ask) || {};
  const budget = {
    timeoutMs: Number.isFinite(askCfg.timeoutMs) ? askCfg.timeoutMs : DEFAULTS.timeoutMs,
    maxHops: Number.isFinite(askCfg.maxHops) ? askCfg.maxHops : DEFAULTS.maxHops,
    topK: Number.isFinite(askCfg.topK) ? askCfg.topK : DEFAULTS.topK,
    maxAnswerTokens: Number.isFinite(askCfg.maxAnswerTokens) ? askCfg.maxAnswerTokens : DEFAULTS.maxAnswerTokens
  };
  const providerKey = cfg.provider;
  const fastModel = pickModelByUse(providerKey, 'fast', cfg);
  const mainModel = pickModelByUse(providerKey, 'main', cfg);

  if (!hasAnswers) {
    // ── 阶段 1：clarify（JSON 模式，fast model） ──
    try {
      const raw = await callLLM(
        '你是一个严格的 JSON 生成器，只输出合法 JSON。',
        [{ role: 'user', content: CLARIFY_PROMPT(question) }],
        { provider: providerKey, model: fastModel },
        { temperature: 0.2, maxTokens: DEFAULTS.clarifyMaxTokens, stream: false }
      );
      const parsed = extractJson(raw) || { clarifyQuestions: [] };
      let list = Array.isArray(parsed.clarifyQuestions) ? parsed.clarifyQuestions : [];
      // 硬裁剪：最多 3 条，每条 options 2–4
      list = list.slice(0, 3).map(q => ({
        id: String(q.id || '').slice(0, 40) || `q_${Math.random().toString(36).slice(2, 6)}`,
        text: String(q.text || '').slice(0, 200),
        options: Array.isArray(q.options) ? q.options.slice(0, 4).map(o => String(o).slice(0, 80)) : []
      })).filter(q => q.text && q.options.length >= 2);
      return sendJSON(res, 200, { stage: 'clarify', clarifyQuestions: list });
    } catch (e) {
      return sendJSON(res, 500, { error: `clarify 阶段失败: ${e.message}` });
    }
  }

  // ── 阶段 2：answer（SSE） ──
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  // 立即刷出初始冒号注释，提醒中间层别 buffer
  try { res.write(': ask-stream open\n\n'); } catch {}

  const startMs = Date.now();
  let totalTokensEst = 0;
  let partial = false;
  let finished = false;

  const deadline = startMs + budget.timeoutMs;
  const timeLeft = () => Math.max(0, deadline - Date.now());
  const timedOut = () => Date.now() >= deadline;

  // 全局超时：到点强制 done + 标 partial
  const timeoutTimer = setTimeout(() => {
    if (finished) return;
    partial = true;
    try {
      sseWrite(res, 'done', { totalTokens: totalTokensEst, durationMs: Date.now() - startMs, partial: true });
    } catch {}
    finished = true;
    try { res.end(); } catch {}
  }, budget.timeoutMs + 50);

  req.on('close', () => {
    // 客户端断开：不继续写，但 LLM 已发出的请求无法取消（不加 AbortController 以免动 callLLM 签名）
    finished = true;
    clearTimeout(timeoutTimer);
  });

  try {
    // 融合 refined question
    const answerEntries = Object.entries(clarifyAnswers)
      .filter(([, v]) => v != null && String(v).trim())
      .map(([k, v]) => `${k}: ${String(v).slice(0, 120)}`);
    const refined = answerEntries.length
      ? `${question}\n（澄清：${answerEntries.join('；')}）`
      : question;

    const vectors = getVectorsMod();
    const vectorReady = !!(vectors && typeof vectors.isVectorReady === 'function' && vectors.isVectorReady());

    const visitedPaths = new Set();
    const visitedChunks = new Set();
    const gatheredRefs = [];
    let currentQuery = refined;
    let currentQueryReason = '';
    let hop = 1;
    let fallbackLexical = !vectorReady;

    while (hop <= budget.maxHops) {
      if (timedOut() || finished) { partial = true; break; }

      const planReason = hop === 1
        ? (fallbackLexical ? 'fallback: lexical' : '初始检索')
        : (currentQueryReason || '继续补充');
      sseWrite(res, 'plan', { hop, query: currentQuery, reason: planReason });

      // 检索
      let chunks = [];
      try {
        if (fallbackLexical) {
          chunks = await lexicalToRefs(currentQuery, retrieveContext);
        } else {
          chunks = await vectors.vectorSearch(currentQuery, { topK: budget.topK });
        }
      } catch (e) {
        // 检索异常：emit error 但不直接终止整体，改降级到 lexical 再试一次
        sseWrite(res, 'plan', { hop, query: currentQuery, reason: `fallback: lexical (${e.message})` });
        fallbackLexical = true;
        chunks = await lexicalToRefs(currentQuery, retrieveContext);
      }

      // 去重：chunkId 优先，fallback 到 path
      const newChunks = [];
      for (const c of chunks) {
        const key = c.chunkId ? `chunk:${c.chunkId}` : `path:${c.path}`;
        if (visitedChunks.has(key)) continue;
        visitedChunks.add(key);
        visitedPaths.add(c.path);
        newChunks.push(c);
      }

      // emit retrieve：前 5 条
      const refsOut = newChunks.slice(0, 5).map(c => ({
        path: c.path,
        title: c.title || c.path,
        score: typeof c.score === 'number' ? Number(c.score.toFixed(3)) : null,
        chunkExcerpt: (c.chunkText || '').slice(0, 200)
      }));
      sseWrite(res, 'retrieve', { hop, refs: refsOut });

      for (const c of newChunks) gatheredRefs.push(c);

      if (hop >= budget.maxHops) break;
      if (timedOut() || finished) { partial = true; break; }

      // 计划下一跳
      let plan = null;
      try {
        const brief = formatRefsBrief(gatheredRefs);
        const raw = await callLLM(
          '你是一个严格的 JSON 生成器，只输出合法 JSON。',
          [{ role: 'user', content: PLAN_PROMPT(refined, currentQuery, brief) }],
          { provider: providerKey, model: fastModel },
          { temperature: 0.2, maxTokens: DEFAULTS.planMaxTokens, stream: false }
        );
        plan = extractJson(raw);
      } catch {
        plan = { needMore: false };
      }
      if (!plan || !plan.needMore || !plan.nextQuery) break;
      currentQuery = String(plan.nextQuery).slice(0, 200);
      currentQueryReason = String(plan.reason || '').slice(0, 200);
      hop++;
    }

    if (timedOut() || finished) { partial = true; }

    // ── 生成答复（main model，stream） ──
    if (!finished && !timedOut()) {
      const chunksText = formatChunksForAnswer(gatheredRefs.slice(0, 12));
      let answerText = '';

      const onChunk = (delta) => {
        if (!delta || finished) return;
        answerText += delta;
        totalTokensEst += Math.ceil(delta.length / 2.5);
        sseWrite(res, 'delta', { text: delta });
        // 硬截：超出 maxAnswerTokens 强停
        if (totalTokensEst >= budget.maxAnswerTokens) {
          partial = true;
        }
      };

      try {
        const full = await callLLM(
          '你是一个严谨的中文知识库助手，引用必须来自给定摘录，不编造路径。',
          [{ role: 'user', content: ANSWER_PROMPT(chunksText, refined) }],
          { provider: providerKey, model: mainModel },
          { temperature: 0.3, maxTokens: budget.maxAnswerTokens, stream: true, onChunk }
        );
        if (!answerText && typeof full === 'string') {
          // 兜底：stream 路径被 provider 忽略、callLLM 返回完整字符串
          answerText = full;
          sseWrite(res, 'delta', { text: full });
          totalTokensEst += Math.ceil(full.length / 2.5);
        }
      } catch (e) {
        sseWrite(res, 'error', { message: `answer LLM 失败: ${e.message}` });
      }

      // 解析 CITATIONS: 段，过滤仅 gatheredRefs 中真实存在的 path（防幻觉）
      const knownPaths = new Map();
      for (const r of gatheredRefs) {
        if (!knownPaths.has(r.path)) knownPaths.set(r.path, r);
      }
      const m = answerText.match(/CITATIONS\s*[:：]\s*([^\n]+)/i);
      const citedPaths = [];
      if (m) {
        const parts = m[1].split(/[,，;；]/).map(s => s.trim()).filter(Boolean);
        for (const p0 of parts) {
          // 容错 "[title](path)" 形式
          const mm = p0.match(/\(([^)]+)\)/);
          const pCandidate = mm ? mm[1] : p0;
          if (knownPaths.has(pCandidate) && !citedPaths.includes(pCandidate)) citedPaths.push(pCandidate);
        }
      }
      // 若 LLM 没给 CITATIONS，但答复里有 markdown [title](path)，从中提取作为兜底
      if (!citedPaths.length && answerText) {
        const re = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
        let mm2;
        while ((mm2 = re.exec(answerText)) !== null) {
          const p = mm2[2];
          if (knownPaths.has(p) && !citedPaths.includes(p)) citedPaths.push(p);
        }
      }

      for (const cp of citedPaths) {
        const r = knownPaths.get(cp);
        sseWrite(res, 'cite', {
          path: r.path,
          title: r.title || r.path,
          excerpt: (r.chunkText || '').slice(0, 200)
        });
      }
    }

    if (!finished) {
      sseWrite(res, 'done', {
        totalTokens: totalTokensEst,
        durationMs: Date.now() - startMs,
        partial: partial || timedOut()
      });
      finished = true;
      clearTimeout(timeoutTimer);
      try { res.end(); } catch {}
    }
  } catch (e) {
    if (!finished) {
      sseWrite(res, 'error', { message: String(e && e.message || e) });
      try {
        sseWrite(res, 'done', { totalTokens: totalTokensEst, durationMs: Date.now() - startMs, partial: true });
      } catch {}
      finished = true;
      clearTimeout(timeoutTimer);
      try { res.end(); } catch {}
    }
  }
}

module.exports = { handleAsk };
