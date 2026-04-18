import { $, h, go } from './utils.js';
import state from './state.js';
import { updSidebarPages, updSidebarChats, switchSidebarTab } from './sidebar.js';
import { hideFormatToolbar, closeSlashMenu, deselectImg, hideArticleQA } from './pages/article.js';
import { cancelGA } from './pages/graph.js';
import { rDash } from './pages/dashboard.js';
import { rChat } from './pages/chat.js';
import { rGraph } from './pages/graph.js';
import { rBrowse } from './pages/browse.js';
import { rArticle } from './pages/article.js';
import { rRaw } from './pages/raw.js';
import { rHealth } from './pages/health.js';
import { rAutotask } from './pages/autotask.js';

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function route() {
  const hash = location.hash || '#/';
  // 拆出查询字符串（例 #/browse?tag=xxx）
  const qIdx = hash.indexOf('?');
  const path = qIdx >= 0 ? hash.slice(0, qIdx) : hash;
  const query = {};
  if (qIdx >= 0) {
    for (const kv of hash.slice(qIdx + 1).split('&')) {
      if (!kv) continue;
      const eq = kv.indexOf('=');
      const k = eq >= 0 ? kv.slice(0, eq) : kv;
      const v = eq >= 0 ? kv.slice(eq + 1) : '';
      query[safeDecode(k)] = safeDecode(v);
    }
  }
  if (path === '#/' || path === '#/dashboard') return { v: 'dashboard' };
  if (path === '#/chat') return { v: 'chat', id: null };
  if (path.startsWith('#/chat/')) return { v: 'chat', id: path.slice(7) };
  if (path === '#/graph') return { v: 'graph' };
  if (path === '#/browse') return { v: 'browse', tag: query.tag || '' };
  if (path === '#/health') return { v: 'health' };
  if (path === '#/autotask') return { v: 'autotask' };
  if (path.startsWith('#/article/')) return { v: 'article', p: safeDecode(path.slice(10)) };
  if (path.startsWith('#/raw/')) return { v: 'raw', p: safeDecode(path.slice(6)) };
  return { v: 'dashboard' };
}

function updNav(v) {
  document.querySelectorAll('.sidebar-item[data-view]').forEach(el => {
    el.classList.toggle('active', el.dataset.view === v || (v === 'article' && el.dataset.view === 'browse'));
  });
  document.querySelectorAll('.mobile-nav-item[data-view]').forEach(el => {
    el.classList.toggle('active', el.dataset.view === v || (v === 'article' && el.dataset.view === 'browse'));
  });
}

function updBC(r) {
  const bc = $('breadcrumb');
  if (r.v === 'dashboard') bc.innerHTML = '';
  else if (r.v === 'chat') bc.innerHTML = '<a href="#/">知识库</a><span class="sep">/</span>对话';
  else if (r.v === 'graph') bc.innerHTML = '<a href="#/">知识库</a><span class="sep">/</span>知识图谱';
  else if (r.v === 'health') bc.innerHTML = '<a href="#/">知识库</a><span class="sep">/</span>健康报告';
  else if (r.v === 'browse') bc.innerHTML = r.tag
    ? '<a href="#/">知识库</a><span class="sep">/</span><a href="#/browse">全部文章</a><span class="sep">/</span>标签 · ' + h(r.tag)
    : '<a href="#/">知识库</a><span class="sep">/</span>全部文章';
  else if (r.v === 'autotask') bc.innerHTML = '<a href="#/">知识库</a><span class="sep">/</span>自动任务';
  else if (r.v === 'raw' && r.p) {
    const pts = r.p.split('/'); const f = pts[pts.length - 1];
    const ft = f.length > 30 ? f.slice(0, 30) + '…' : f;
    bc.innerHTML = '<a href="#/">知识库</a><span class="sep">/</span><a href="#/browse">全部文章</a><span class="sep">/</span>原文 · ' + h(ft);
  }
  else if (r.v === 'article' && r.p) {
    const pts = r.p.split('/'), topic = pts.length > 1 ? pts[0] : '', f = pts[pts.length - 1].replace('.md', '');
    const topicColors = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];
    const tci = topic ? Math.abs([...topic].reduce((a, c) => a + c.charCodeAt(0), 0)) % topicColors.length : 0;
    let s = '<a href="#/">知识库</a>';
    if (topic) s += '<span class="sep">/</span><span class="topic-dot" style="background:' + topicColors[tci] + '"></span><a href="#/browse">' + h(topic) + '</a>';
    const ft = f.length > 40 ? f.slice(0, 40) + '…' : f;
    s += '<span class="sep">/</span>' + h(ft); bc.innerHTML = s;
  }
}

export async function render() {
  const r = route(); state.cv = r.v; updNav(r.v); updBC(r); cancelGA(); hideFormatToolbar(); closeSlashMenu(); deselectImg(); if (r.v !== 'article') hideArticleQA();
  if (r.v === 'article' || r.v === 'browse') switchSidebarTab('pages');
  else if (r.v === 'chat') switchSidebarTab('chat');
  const delBtn = document.getElementById('topbarDel'); if (delBtn && r.v !== 'article') delBtn.remove();
  const precipBtn = document.getElementById('topbarPrecip'); if (precipBtn && r.v !== 'chat') precipBtn.remove();
  updSidebarPages(); updSidebarChats();
  const c = $('content'); c.scrollTop = 0;
  if (r.v === 'dashboard') await rDash(c);
  else if (r.v === 'chat') await rChat(c, r.id);
  else if (r.v === 'graph') await rGraph(c);
  else if (r.v === 'browse') await rBrowse(c, r.tag);
  else if (r.v === 'health') await rHealth(c);
  else if (r.v === 'autotask') await rAutotask(c);
  else if (r.v === 'article') await rArticle(c, r.p);
  else if (r.v === 'raw') await rRaw(c, r.p);
  updSidebarPages();
}

// Make render available globally for other modules
window.render = render;
