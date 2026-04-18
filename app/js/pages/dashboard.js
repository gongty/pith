import { $, h, relTime, api, toast, go, skelLines } from '../utils.js';
import state from '../state.js';
import { buildComposer, initComposer } from '../composer.js';
import { initFG } from './graph.js';
import { t } from '../i18n.js';

export async function rDash(c) {
  c.innerHTML = '<div class="page-dashboard">' + skelLines(4) + '</div>';
  try {
    const [stats, graph, recent] = await Promise.all([api('/api/wiki/stats'), api('/api/wiki/graph'), api('/api/wiki/recent')]);
    state.sd = stats; state.gd = graph;
    let s = '<div class="page-dashboard">';

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
function buildSuggestChips(stats, graph, recent) {
  const out = [];
  const seen = new Set();
  const push = (label, q) => { if (label && q && !seen.has(q)) { seen.add(q); out.push({ label, q }); } };

  const nodes = (graph && graph.nodes) || [];
  // 两层图谱：concept 节点已在后端聚合，articleCount 直接可用
  const concepts = nodes.filter(n => n.kind === 'concept');
  const articleNodes = nodes.filter(n => n.kind === 'article');
  const entries = (recent && recent.entries) || [];

  // 1) 最新收录的文章：short label，点击发送带标题的完整问题
  const latest = entries.find(e => e.type === 'ingest' && e.title);
  if (latest) push(t('dash.chipLatest'), t('dash.chipLatestQ', { title: latest.title }));

  // 2) 最热 concept (tag)：用 articleCount 聚合
  const topConcept = concepts.slice().sort((a, b) => (b.articleCount || 0) - (a.articleCount || 0))[0];
  if (topConcept && (topConcept.articleCount || 0) >= 2) {
    const label = topConcept.label || topConcept.name || '';
    if (label) push(label, t('dash.chipContentSummary', { label }));
  }

  // 3) 最大主题：从 article 节点（每篇文章有 topic）统计
  const topicCount = {};
  for (const n of articleNodes) if (n.topic) topicCount[n.topic] = (topicCount[n.topic] || 0) + 1;
  // fallback：若文章节点没有 topic，就用 concept 节点的 topic 字段计 article 加权
  if (!Object.keys(topicCount).length) {
    for (const c of concepts) if (c.topic) topicCount[c.topic] = (topicCount[c.topic] || 0) + (c.articleCount || 1);
  }
  const topTopic = Object.entries(topicCount).sort((a, b) => b[1] - a[1])[0];
  if (topTopic) push(t('dash.chipTopic', { topic: topTopic[0] }), t('dash.chipTopicQ', { topic: topTopic[0] }));

  // 数据不足兜底
  if (out.length < 2) {
    push(t('dash.chipWhat'), t('dash.chipWhatQ'));
    push(t('dash.chipTopics'), t('dash.chipTopicsQ'));
  }

  return out.slice(0, 3);
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

