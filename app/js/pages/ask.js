/* ── Ask 页面（M4） ──
 * 提问页：问题输入 → 澄清 → 流式答案（SSE）
 * 冻结事件协议（与团队 C 约定）：plan / retrieve / delta / cite / done / error
 * 冻结端点：POST /api/wiki/ask  body: { question, clarifyAnswers? }
 *   clarifyAnswers == null → JSON: { stage:'clarify', clarifyQuestions:[{id,text,options[]}] }
 *   clarifyAnswers 有值   → SSE 流
 */

import { $, h, api, toast, go, jsAttr } from '../utils.js';
import { renderMd } from '../markdown.js';
import { openSSE } from '../sse.js';

// 单例：页面离开时清理
let current = null;

export function rAsk(container, initialQuery = '') {
  // 中止上一次
  if (current && current.state.abortHandle) {
    try { current.state.abortHandle.abort(); } catch {}
  }

  const state = {
    stage: 'idle',              // idle | asking | clarify | answering | done | error | aborted
    question: initialQuery || '',
    clarifyQuestions: [],
    clarifyAnswers: {},
    hops: [],                   // [{hop, query, reason, refs: []}]
    answerMd: '',
    cites: [],
    error: null,
    abortHandle: null,
    startedAt: null,
    doneMeta: null,
    retrieveCollapsed: false,
    indexWarning: null          // { chunks:0 } → 提示索引未建
  };
  current = { state, container };

  // 静默查一下向量索引状态（失败不阻塞）
  api('/api/wiki/vectors/stats').then(r => {
    if (!r) return;
    const chunks = r.chunks ?? r.count ?? r.total ?? null;
    if (chunks === 0) {
      state.indexWarning = { chunks: 0 };
      render();
    }
  }).catch(() => {});

  function render() {
    const s = state;
    let html = '<div class="page-article"><div class="page-article-inner page-ask">';

    // 顶部：标题 + 简述
    html += '<div class="ask-head">';
    html += '<h1 class="ask-title">提问</h1>';
    html += '<p class="ask-sub">基于知识库做多跳检索 + 流式作答，引用可点进原文</p>';
    html += '</div>';

    // 输入区
    const busy = s.stage === 'asking' || s.stage === 'answering' || s.stage === 'clarify';
    html += '<div class="ask-input-card">';
    html += '<textarea id="askQuestion" class="ask-textarea" rows="2" placeholder="例如：视频生成最近有什么进展？"'
      + (busy ? ' disabled' : '') + '>' + h(s.question) + '</textarea>';
    html += '<div class="ask-input-foot">';
    if (s.stage === 'idle' || s.stage === 'done' || s.stage === 'error' || s.stage === 'aborted') {
      html += '<button class="btn-sm-fill" onclick="submitAsk()">' + (s.stage === 'done' ? '重新提问' : '提问') + '</button>';
    } else {
      html += '<button class="btn-sm-fill" disabled>处理中...</button>';
    }
    html += '</div>';
    if (s.indexWarning && s.indexWarning.chunks === 0) {
      html += '<div class="ask-index-warn">';
      html += '<span class="ask-warn-dot"></span>';
      html += '<span>索引尚未建立，结果可能仅基于关键词</span>';
      html += '<button class="btn-outline btn-xs" onclick="askBuildIndex()">立即建立索引</button>';
      html += '</div>';
    }
    html += '</div>';

    // 澄清区
    if (s.stage === 'clarify' && s.clarifyQuestions.length) {
      html += '<div class="ask-section ask-clarify">';
      html += '<div class="ask-section-head"><span class="ask-section-title">澄清</span><span class="ask-section-sub">先对齐再作答，效果更好</span></div>';
      html += '<div class="ask-clarify-list">';
      for (const q of s.clarifyQuestions) {
        html += '<div class="ask-clarify-item">';
        html += '<div class="ask-clarify-text">' + h(q.text || '') + '</div>';
        html += '<div class="ask-clarify-options">';
        const picked = s.clarifyAnswers[q.id] || '';
        for (const opt of (q.options || [])) {
          const active = opt === picked ? ' active' : '';
          // q.id 和 opt 都来自 LLM，可能含 `'` / U+2028 等会击穿 JS 字符串字面量的字符。
          // 把字符串参数编成 JS-level `\uXXXX` 转义而非 HTML 实体（后者会被 HTML
          // attribute 解码回原字符，破坏 JS 解析）。
          html += '<button class="ask-chip' + active + '" onclick="pickClarifyOption(\'' + jsAttr(q.id) + '\', \'' + jsAttr(opt) + '\')">' + h(opt) + '</button>';
        }
        html += '</div></div>';
      }
      html += '</div>';
      html += '<div class="ask-clarify-foot"><button class="btn-sm-fill" onclick="submitClarify()">继续</button></div>';
      html += '</div>';
    }

    // 检索轨迹
    if (s.hops.length) {
      const collapsed = s.retrieveCollapsed;
      html += '<div class="ask-section ask-retrieve' + (collapsed ? ' collapsed' : '') + '">';
      html += '<div class="ask-section-head ask-retrieve-head" onclick="toggleAskRetrieve()">';
      html += '<span class="ask-section-title">检索轨迹</span>';
      html += '<span class="ask-section-sub">' + s.hops.length + ' 跳</span>';
      html += '<span class="ask-fold-ind">' + (collapsed ? '展开' : '收起') + '</span>';
      html += '</div>';
      if (!collapsed) {
        html += '<div class="ask-hop-list">';
        for (const hop of s.hops) {
          html += '<div class="ask-hop">';
          html += '<div class="ask-hop-head">第 ' + hop.hop + ' 跳 · <span class="ask-hop-q">' + h(hop.query || '') + '</span></div>';
          if (hop.reason) html += '<div class="ask-hop-reason">' + h(hop.reason) + '</div>';
          if (hop.refs && hop.refs.length) {
            html += '<div class="ask-hop-refs">';
            for (const r of hop.refs) {
              const href = '#/article/' + encodeURI(r.path || '');
              const scoreTxt = typeof r.score === 'number' ? ' · ' + r.score.toFixed(2) : '';
              html += '<a class="ask-ref" href="' + href + '">';
              html += '<span class="ask-ref-title">' + h(r.title || r.path || '') + '</span>';
              html += '<span class="ask-ref-score">' + h(scoreTxt) + '</span>';
              if (r.chunkExcerpt) html += '<div class="ask-ref-excerpt">' + h(r.chunkExcerpt) + '</div>';
              html += '</a>';
            }
            html += '</div>';
          }
          html += '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }

    // 答案区
    if (s.stage === 'answering' || s.stage === 'done' || s.stage === 'error' || s.stage === 'aborted' || s.answerMd) {
      html += '<div class="ask-section ask-answer">';
      html += '<div class="ask-section-head">';
      html += '<span class="ask-section-title">答案</span>';
      if (s.stage === 'answering') {
        html += '<span class="ask-status ask-status-live"><span class="ask-status-dot"></span>生成中</span>';
        html += '<button class="btn-outline btn-xs ask-abort-btn" onclick="abortAsk()">中止</button>';
      } else if (s.stage === 'done') {
        html += '<span class="ask-status ask-status-ok"><span class="ask-status-dot ok"></span>已完成</span>';
      } else if (s.stage === 'aborted') {
        html += '<span class="ask-status ask-status-warn"><span class="ask-status-dot warn"></span>已中止</span>';
      } else if (s.stage === 'error') {
        html += '<span class="ask-status ask-status-err"><span class="ask-status-dot err"></span>失败</span>';
      }
      html += '</div>';

      html += '<div class="ask-answer-body markdown-body" id="askAnswerBody">';
      if (s.answerMd) html += renderMd(s.answerMd);
      else if (s.stage === 'answering') html += '<div class="ask-placeholder">等待第一个 token...</div>';
      html += '</div>';

      if (s.cites.length) {
        html += '<div class="ask-cites"><div class="ask-cites-title">引用</div><div class="ask-cites-list">';
        const seen = new Set();
        for (const c of s.cites) {
          if (seen.has(c.path)) continue;
          seen.add(c.path);
          const href = '#/article/' + encodeURI(c.path || '');
          html += '<a class="ask-cite" href="' + href + '">' + h(c.title || c.path) + '</a>';
        }
        html += '</div></div>';
      }

      if (s.stage === 'error' && s.error) {
        html += '<div class="ask-err-box">' + h(s.error) + '</div>';
      }

      if (s.doneMeta) {
        html += '<div class="ask-meta">';
        if (typeof s.doneMeta.durationMs === 'number') html += '耗时 ' + (s.doneMeta.durationMs / 1000).toFixed(1) + 's';
        if (typeof s.doneMeta.totalTokens === 'number') html += ' · ' + s.doneMeta.totalTokens + ' tokens';
        if (s.doneMeta.partial) html += ' · <span class="ask-meta-warn">部分结果</span>';
        html += '</div>';
      }

      html += '</div>'; // ask-answer
    }

    html += '</div></div>'; // page-article-inner / page-article

    container.innerHTML = html;

    // 保持 textarea 的光标位置与 auto-grow
    const ta = document.getElementById('askQuestion');
    if (ta) {
      ta.addEventListener('input', onTextareaInput);
      autoGrow(ta);
      if (s.stage === 'idle' && !s.question) ta.focus();
    }
  }

  function onTextareaInput(e) {
    state.question = e.target.value;
    autoGrow(e.target);
  }

  function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(220, Math.max(44, ta.scrollHeight)) + 'px';
  }

  // ── 节流重渲（流式 delta 用） ──
  let renderPending = false;
  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    setTimeout(() => {
      renderPending = false;
      if (current && current.state === state) render();
    }, 50);
  }

  // 增量更新答案区（仅 innerHTML，避免整页重绘打断滚动）
  let answerUpdatePending = false;
  function scheduleAnswerRepaint() {
    if (answerUpdatePending) return;
    answerUpdatePending = true;
    setTimeout(() => {
      answerUpdatePending = false;
      const el = document.getElementById('askAnswerBody');
      if (el) el.innerHTML = renderMd(state.answerMd);
    }, 50);
  }

  // ── Actions ──
  async function doSubmit() {
    const inp = document.getElementById('askQuestion');
    const q = (inp ? inp.value : state.question || '').trim();
    if (!q) { toast('请输入问题'); return; }
    // 重置
    state.question = q;
    state.clarifyQuestions = [];
    state.clarifyAnswers = {};
    state.hops = [];
    state.answerMd = '';
    state.cites = [];
    state.error = null;
    state.doneMeta = null;
    state.retrieveCollapsed = false;
    state.stage = 'asking';
    state.startedAt = Date.now();
    render();

    const body = { question: q, clarifyAnswers: null };
    const onJsonClarify = (data) => {
      if (!data) return;
      if (data.stage === 'clarify' && Array.isArray(data.clarifyQuestions) && data.clarifyQuestions.length) {
        state.clarifyQuestions = data.clarifyQuestions;
        state.stage = 'clarify';
        render();
      } else {
        // 空澄清 → 直接进答案阶段
        startAnswering();
      }
    };

    state.abortHandle = startRequest(body, {
      onJson: onJsonClarify,
      onEvent: null,
      onError: (err) => {
        state.stage = 'error';
        state.error = err && err.message ? err.message : '请求失败';
        render();
      },
      onDone: () => { /* JSON 阶段在 onJsonClarify 内已处理 */ }
    });
  }

  function pickClarifyOption(id, value) {
    state.clarifyAnswers[id] = value;
    render();
  }

  function doSubmitClarify() {
    startAnswering();
  }

  function startAnswering() {
    state.stage = 'answering';
    state.answerMd = '';
    state.cites = [];
    state.hops = [];
    state.retrieveCollapsed = false;
    state.doneMeta = null;
    state.error = null;
    render();

    const body = {
      question: state.question,
      clarifyAnswers: state.clarifyQuestions.length ? state.clarifyAnswers : {}
    };
    let firstDelta = true;
    state.abortHandle = startRequest(body, {
      onJson: (data) => {
        // 理论上 clarifyAnswers 不为 null 时不应走 JSON 分支；兜底
        if (data && data.stage === 'clarify' && Array.isArray(data.clarifyQuestions)) {
          state.clarifyQuestions = data.clarifyQuestions;
          state.stage = 'clarify';
          render();
        }
      },
      onEvent: (name, data) => {
        if (name === 'plan') {
          state.hops.push({ hop: data.hop, query: data.query || '', reason: data.reason || '', refs: [] });
          scheduleRender();
        } else if (name === 'retrieve') {
          const hop = state.hops.find(hh => hh.hop === data.hop);
          if (hop) hop.refs = data.refs || [];
          else state.hops.push({ hop: data.hop, query: '', reason: '', refs: data.refs || [] });
          scheduleRender();
        } else if (name === 'delta') {
          state.answerMd += data.text || '';
          if (firstDelta) {
            firstDelta = false;
            state.retrieveCollapsed = true; // 答案开始后自动折叠轨迹
            render();
          } else {
            scheduleAnswerRepaint();
          }
        } else if (name === 'cite') {
          state.cites.push(data);
          scheduleRender();
        } else if (name === 'done') {
          state.stage = 'done';
          state.doneMeta = data || {};
          render();
        } else if (name === 'error') {
          state.stage = 'error';
          state.error = (data && data.message) || '未知错误';
          render();
        }
      },
      onError: (err) => {
        if (state.stage === 'aborted') return;
        state.stage = 'error';
        state.error = err && err.message ? err.message : '流式请求失败';
        render();
      },
      onDone: () => {
        // 若没收到 done 事件，兜底切到 done
        if (state.stage === 'answering') {
          state.stage = 'done';
          state.doneMeta = state.doneMeta || { durationMs: Date.now() - (state.startedAt || Date.now()), partial: true };
          render();
        }
      }
    });
  }

  function startRequest(body, { onJson, onEvent, onError, onDone }) {
    const dispatcher = {
      onEvent: (name, data) => {
        if (name === '__json__') { if (onJson) onJson(data); return; }
        if (onEvent) onEvent(name, data);
      },
      onError: onError,
      onDone: onDone
    };
    return openSSE('/api/wiki/ask', {
      method: 'POST',
      body,
      onEvent: dispatcher.onEvent,
      onError: dispatcher.onError,
      onDone: dispatcher.onDone
    });
  }

  function doAbort() {
    if (state.abortHandle) {
      try { state.abortHandle.abort(); } catch {}
    }
    state.stage = 'aborted';
    if (!state.doneMeta) state.doneMeta = { durationMs: Date.now() - (state.startedAt || Date.now()), partial: true };
    render();
  }

  function doRestart() {
    if (state.abortHandle) { try { state.abortHandle.abort(); } catch {} }
    state.stage = 'idle';
    state.clarifyQuestions = [];
    state.clarifyAnswers = {};
    state.hops = [];
    state.answerMd = '';
    state.cites = [];
    state.error = null;
    state.doneMeta = null;
    state.startedAt = null;
    render();
  }

  function toggleRetrieve() {
    state.retrieveCollapsed = !state.retrieveCollapsed;
    render();
  }

  async function buildIndex() {
    toast('索引建立中...');
    try {
      await api('/api/wiki/reindex-vectors', { method: 'POST' });
      state.indexWarning = null;
      toast('索引已建立');
      render();
    } catch (e) {
      toast('建立索引失败: ' + (e && e.message ? e.message : '未知错误'));
    }
  }

  // ── 暴露给 window（供 HTML onclick 调用） ──
  window.submitAsk = () => doSubmit();
  window.submitClarify = () => doSubmitClarify();
  window.pickClarifyOption = (id, val) => pickClarifyOption(id, val);
  window.abortAsk = () => doAbort();
  window.restartAsk = () => doRestart();
  window.toggleAskRetrieve = () => toggleRetrieve();
  window.askBuildIndex = () => buildIndex();

  // 初次渲染
  render();

  // 若挂了初始 query：光标放结尾（不自动提交，给用户确认机会）
  if (initialQuery) {
    setTimeout(() => {
      const ta = document.getElementById('askQuestion');
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }, 0);
  }
}
