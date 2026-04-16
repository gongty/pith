import { $, h, relTime, api, post, toast, go, skelLines } from '../utils.js';
import state from '../state.js';
import { buildComposer, initComposer } from '../composer.js';
import { initFG } from './graph.js';

export async function rDash(c) {
  c.innerHTML = '<div class="page-dashboard">' + skelLines(4) + '</div>';
  try {
    const [stats, graph, recent] = await Promise.all([api('/api/wiki/stats'), api('/api/wiki/graph'), api('/api/wiki/recent')]);
    state.sd = stats; state.gd = graph;
    let s = '<div class="page-dashboard">';

    // Greeting + suggestion cards + composer
    s += '<div class="chat-area">';
    s += '<div class="chat-greeting">基于知识库提问</div>';
    s += '<div class="chat-sub">已积累 <strong>' + stats.articles + '</strong> 篇文章 · <strong>' + stats.topics + '</strong> 个主题 · 持续生长中</div>';
    s += '<div class="suggestion-cards">';
    s += '<div class="suggestion-card" onclick="dashAsk(this)" data-q="知识库里有什么？"><div class="suggestion-card-icon" style="background:var(--accent-bg);color:var(--accent)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg></div><div><div class="suggestion-card-title">知识库里有什么？</div><div class="suggestion-card-desc">浏览所有收录的内容</div></div></div>';
    s += '<div class="suggestion-card" onclick="dashAsk(this)" data-q="总结最近内容"><div class="suggestion-card-icon" style="background:rgba(68,131,97,0.08);color:var(--green)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div><div><div class="suggestion-card-title">总结最近内容</div><div class="suggestion-card-desc">了解最新收录的知识</div></div></div>';
    s += '<div class="suggestion-card" onclick="dashAsk(this)" data-q="有哪些主题？"><div class="suggestion-card-icon" style="background:rgba(144,101,176,0.08);color:var(--purple)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg></div><div><div class="suggestion-card-title">有哪些主题？</div><div class="suggestion-card-desc">探索知识库的结构</div></div></div>';
    s += '</div>';
    s += buildComposer('dash');
    s += '</div>';

    // Graph
    s += '<div class="section-head"><span class="section-label">知识图谱</span><a class="section-link" href="#/graph">查看全部 &rarr;</a></div>';
    s += '<div class="graph-card" id="dgWrap">';
    if (graph.nodes.length < 2) s += '<div class="graph-empty-msg">投喂更多知识，图谱会生长</div>';
    else s += '<canvas id="dgCanvas"></canvas>';
    s += '<div class="graph-footer" id="dgLegend"></div></div>';

    // Recent
    const ent = recent.entries || [];
    s += '<div class="section-head"><span class="section-label">最近活动</span></div>';
    s += '<div class="activity-card">';
    if (!ent.length) s += '<div class="activity-none">暂无记录，投喂知识开始使用</div>';
    else ent.slice(0, 6).forEach(a => {
      const icon = a.type === 'ingest' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12l7 7 7-7"/></svg>' : a.type === 'query' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
      s += '<div class="activity-row" onclick="searchFor(this.dataset.q)" data-q="' + h(a.title) + '"><span class="activity-icon">' + icon + '</span><span class="activity-time">' + relTime(a.date) + '</span><span class="activity-label">' + h(a.title) + '</span></div>';
    });
    s += '</div>';
    s += '</div>';
    c.innerHTML = s;
    initComposer('dash', dashSend);
    if (graph.nodes.length >= 2) requestAnimationFrame(() => { const cv = document.getElementById('dgCanvas'); if (cv) initFG(cv, graph, false); });
  } catch (e) { c.innerHTML = '<div style="text-align:center;padding:60px;color:var(--fg-tertiary)">加载失败: ' + h(e.message) + '</div>'; }
}

export async function dashAsk(el) { $('dashIn').value = el.dataset.q || el.textContent; $('dashSendBtn').disabled = false; dashSend(); }

async function dashSend() {
  const inp = $('dashIn'); const t = inp.value.trim(); if (!t || state.chatBusy) return;
  state.chatBusy = true; $('dashSendBtn').disabled = true;
  try {
    const res = await post('/api/chat/new', { firstMessage: t });
    state.convId = res.conversation.id; state.msgs = [{ role: 'user', content: t }, res.message];
    state.chatList = null;
    go('#/chat/' + state.convId);
  } catch (e) { toast('发送失败: ' + e.message); }
  state.chatBusy = false;
}

