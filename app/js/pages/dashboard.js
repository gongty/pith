import { $, h, relTime, api, toast, go, skelLines } from '../utils.js';
import state from '../state.js';
import { buildComposer, initComposer } from '../composer.js';
import { initFG } from './graph.js';
import { t } from '../i18n.js';

export async function rDash(c) {
  c.innerHTML = '<div class="page-dashboard">' + skelLines(4) + '</div>';
  try {
    const [stats, graph, recent, settings] = await Promise.all([api('/api/wiki/stats'), api('/api/wiki/graph'), api('/api/wiki/recent'), api('/api/settings').catch(() => null)]);
    state.sd = stats; state.gd = graph;
    let s = '<div class="page-dashboard">';

    // Setup banner for new users without API key
    if (settings && !settings.hasKey) {
      s += '<div class="dash-setup-banner">';
      s += '<div class="dash-setup-text">';
      s += '<div class="dash-setup-title">' + t('dash.setupTitle') + '</div>';
      s += '<div class="dash-setup-desc">' + t('dash.setupDesc') + '</div>';
      s += '</div>';
      s += '<button class="dash-setup-btn" onclick="openSettings()">' + t('dash.setupBtn') + '</button>';
      s += '</div>';
    }

    // Greeting + suggestion cards + composer
    s += '<div class="chat-area">';
    s += '<div class="chat-greeting">' + t('dash.greeting') + '</div>';
    s += '<div class="chat-sub">' + t('dash.sub', { articles: stats.articles, topics: stats.topics }) + '</div>';
    s += buildComposer('dash');
    const chips = buildSuggestChips(stats, graph, recent);
    if (chips.length) {
      s += '<div class="suggestion-chips">';
      for (const c of chips) {
        s += '<button class="suggestion-chip" onclick="dashAsk(this)" data-q="' + h(c.q) + '" title="' + h(c.q) + '">' + h(c.label) + '</button>';
      }
      s += '</div>';
    }
    s += '</div>';

    // Graph
    s += '<div class="section-head"><span class="section-label">' + t('dash.graphLabel') + '</span></div>';
    s += '<div class="graph-card" id="dgWrap">';
    if (graph.nodes.length < 2) s += '<div class="graph-empty-msg">' + t('dash.graphEmpty') + '</div>';
    else s += '<canvas id="dgCanvas"></canvas><div class="graph-focus-card" hidden></div>';
    s += '<div class="graph-footer" id="dgLegend"></div></div>';

    // Recent
    const ent = recent.entries || [];
    s += '<div class="section-head"><span class="section-label">' + t('dash.recentLabel') + '</span></div>';
    s += '<div class="activity-card">';
    if (!ent.length) s += '<div class="activity-none">' + t('dash.recentEmpty') + '</div>';
    else ent.slice(0, 6).forEach(a => {
      const icon = a.type === 'ingest' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12l7 7 7-7"/></svg>' : a.type === 'query' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
      s += '<div class="activity-row" onclick="searchFor(this.dataset.q)" data-q="' + h(a.title) + '"><span class="activity-icon">' + icon + '</span><span class="activity-time">' + relTime(a.date) + '</span><span class="activity-label">' + h(a.title) + '</span></div>';
    });
    s += '</div>';
    s += '</div>';
    c.innerHTML = s;
    initComposer('dash', dashSend);
    if (graph.nodes.length >= 2) requestAnimationFrame(() => { const cv = document.getElementById('dgCanvas'); if (cv) initFG(cv, graph, false); });
  } catch (e) { c.innerHTML = '<div style="text-align:center;padding:60px;color:var(--fg-tertiary)">' + t('common.loadFailedMsg', { msg: h(e.message) }) + '</div>'; }
}

// 基于实际知识库数据生成推荐气泡
// 每个 chip 有 label（显示用，短）和 q（点击发送的完整问题）
function pickRandom(arr, n) {
  const pool = arr.slice();
  const out = [];
  while (out.length < n && pool.length) {
    const i = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

function buildSuggestChips(stats, graph, recent) {
  const pool = [];
  const add = (label, q) => { if (label && q) pool.push({ label, q }); };

  const nodes = (graph && graph.nodes) || [];
  const concepts = nodes.filter(n => n.kind === 'concept');
  const articleNodes = nodes.filter(n => n.kind === 'article');
  const edges = (graph && graph.edges) || [];
  const entries = (recent && recent.entries) || [];

  // A) 最近文章
  for (const e of entries.filter(e => e.type === 'ingest' && e.title).slice(0, 5)) {
    add(e.title, t('dash.chipLatestQ', { title: e.title }));
  }

  // B) 热门 concept
  const hotConcepts = concepts.slice().sort((a, b) => (b.articleCount || 0) - (a.articleCount || 0))
    .filter(c => (c.articleCount || 0) >= 2).slice(0, 8);
  for (const c of hotConcepts) {
    const label = c.label || c.name || '';
    if (label) add(label, t('dash.chipContentSummary', { label }));
  }

  // C) 主题
  const topicCount = {};
  for (const n of articleNodes) if (n.topic) topicCount[n.topic] = (topicCount[n.topic] || 0) + 1;
  if (!Object.keys(topicCount).length) {
    for (const c of concepts) if (c.topic) topicCount[c.topic] = (topicCount[c.topic] || 0) + (c.articleCount || 1);
  }
  for (const [topic] of Object.entries(topicCount).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    add(t('dash.chipTopic', { topic }), t('dash.chipTopicQ', { topic }));
  }

  // D) 两个 concept 对比
  if (hotConcepts.length >= 2) {
    const [a, b] = pickRandom(hotConcepts, 2);
    const la = a.label || a.name, lb = b.label || b.name;
    if (la && lb) add(t('dash.chipCompare', { a: la, b: lb }), t('dash.chipCompareQ', { a: la, b: lb }));
  }

  // E) 随机文章深读
  if (articleNodes.length) {
    const [art] = pickRandom(articleNodes.slice(0, 20), 1);
    const title = art.label || art.name || '';
    if (title) add(t('dash.chipDeep', { title }), t('dash.chipDeepQ', { title }));
  }

  // F) 图谱关联发现
  const coEdges = edges.filter(e => e.type === 'co-concept' && (e.weight || 1) >= 2);
  if (coEdges.length) {
    const [e] = pickRandom(coEdges, 1);
    const sn = concepts.find(n => n.id === e.source), tn = concepts.find(n => n.id === e.target);
    if (sn && tn) {
      const sl = sn.label || sn.name, tl = tn.label || tn.name;
      if (sl && tl) add(t('dash.chipLink', { a: sl, b: tl }), t('dash.chipLinkQ', { a: sl, b: tl }));
    }
  }

  if (pool.length < 2) {
    add(t('dash.chipWhat'), t('dash.chipWhatQ'));
    add(t('dash.chipTopics'), t('dash.chipTopicsQ'));
  }

  const picked = pickRandom(pool, 3);
  const seen = new Set();
  return picked.filter(c => { if (seen.has(c.q)) return false; seen.add(c.q); return true; });
}

export async function dashAsk(el) { $('dashIn').value = el.dataset.q || el.textContent; $('dashSendBtn').disabled = false; dashSend(); }

async function dashSend() {
  const inp = $('dashIn'); const txt = inp.value.trim(); if (!txt || state.chatBusy) return;
  // Navigate immediately, let chat page handle the API call
  state.pendingChat = txt;
  state.convId = null;
  state.msgs = [];
  go('#/chat');
}

