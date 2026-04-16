import { $, h, api } from './utils.js';
import state from './state.js';

export function toggleSidebar() {
  const sb = $('sidebar'); sb.classList.toggle('collapsed');
  localStorage.setItem('kb-sidebar', sb.classList.contains('collapsed') ? 'collapsed' : '');
}

export function initSidebar() {
  if (localStorage.getItem('kb-sidebar') === 'collapsed') $('sidebar').classList.add('collapsed');
  const saved = localStorage.getItem('kb-sidebar-tab') || 'chat';
  switchSidebarTab(saved);
  // Auto-hide scrollbar on sidebar lists
  document.querySelectorAll('.sidebar-chat-list, .sidebar-pages').forEach(el => {
    let t;
    el.addEventListener('scroll', () => {
      el.classList.add('is-scrolling');
      clearTimeout(t);
      t = setTimeout(() => el.classList.remove('is-scrolling'), 300);
    }, { passive: true });
  });
}

export function switchSidebarTab(tab) {
  document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const chatPanel = $('sidebarPanelChat');
  const pagesPanel = $('sidebarPanelPages');
  if (chatPanel) chatPanel.style.display = tab === 'chat' ? '' : 'none';
  if (pagesPanel) pagesPanel.style.display = tab === 'pages' ? '' : 'none';
  localStorage.setItem('kb-sidebar-tab', tab);
}

function fmtPageDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return mm + '-' + dd;
}

function dateBucketKey(ms) {
  if (!ms) return 'unknown';
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function dateBucketLabel(key) {
  if (key === 'unknown') return '未知时间';
  const [y, m, day] = key.split('-').map(Number);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(y, m - 1, day);
  const diffDays = Math.round((today - target) / 86400000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays > 1 && diffDays < 7) return diffDays + ' 天前';
  if (y === today.getFullYear()) return m + '月' + day + '日';
  return y + '年' + m + '月' + day + '日';
}

export async function updSidebarPages() {
  const sp = $('sidebarPages'); if (!sp) return;
  try {
    const tree = state.td || await api('/api/wiki/tree'); state.td = tree;
    const all = [];
    (tree || []).forEach(t => (t.children || []).forEach(c => all.push(c)));
    all.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    // group by date bucket, preserve sort order
    const buckets = [];
    const bucketMap = new Map();
    all.forEach(c => {
      const key = dateBucketKey(c.mtime);
      let b = bucketMap.get(key);
      if (!b) { b = { key, items: [] }; bucketMap.set(key, b); buckets.push(b); }
      b.items.push(c);
    });
    let s = '';
    buckets.forEach(b => {
      const folded = state.foldedDates.has(b.key) ? ' folded' : '';
      s += '<div class="sidebar-date-head' + folded + '" onclick="toggleDateFold(this,\'' + h(b.key) + '\')">'
        + '<span class="sidebar-date-label">' + h(dateBucketLabel(b.key)) + '</span>'
        + '<span class="sidebar-date-count">' + b.items.length + ' 篇</span>'
        + '<span class="sidebar-date-arr"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>'
        + '</div>';
      b.items.forEach(c => {
        const active = state.artPath === c.path ? ' active' : '';
        const hidden = state.foldedDates.has(b.key) ? ' style="display:none"' : '';
        s += '<div class="sidebar-page' + active + '" data-date="' + h(b.key) + '"' + hidden + ' onclick="go(\'#/article/' + h(c.path) + '\')" title="' + h(c.title || c.file) + '">'
          + '<span class="page-title">' + h(c.title || c.file) + '</span>'
          + '</div>';
      });
    });
    sp.innerHTML = s;
  } catch {}
}

export function toggleDateFold(el, key) {
  const folded = el.classList.toggle('folded');
  if (folded) state.foldedDates.add(key); else state.foldedDates.delete(key);
  const sp = $('sidebarPages'); if (!sp) return;
  sp.querySelectorAll('.sidebar-page[data-date="' + key.replace(/"/g, '\\"') + '"]').forEach(p => {
    p.style.display = folded ? 'none' : '';
  });
}

let previewTimer = null;
export function initSidebarPreview() {
  const sp = $('sidebarPages'); if (!sp) return;
  sp.addEventListener('mouseover', e => {
    const page = e.target.closest('.sidebar-page'); if (!page) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const title = page.getAttribute('title') || '';
      const preview = $('sidebarPreview');
      $('spTitle').textContent = title;
      $('spSummary').textContent = '加载中...';
      $('spTime').textContent = '';
      const rect = page.getBoundingClientRect();
      preview.style.top = Math.min(rect.top, window.innerHeight - 160) + 'px';
      preview.style.left = (rect.right + 8) + 'px';
      preview.classList.add('show');
      try {
        const path = page.getAttribute('onclick')?.match(/article\/(.*?)'/)?.[1];
        if (path) {
          const res = await api('/api/wiki/article?path=' + encodeURIComponent(path));
          const lines = (res.content || '').split('\n').filter(l => l.trim() && !l.startsWith('#'));
          $('spSummary').textContent = lines.slice(0, 3).join(' ').slice(0, 80) + '…';
        }
      } catch { $('spSummary').textContent = title; }
    }, 300);
  });
  sp.addEventListener('mouseout', e => {
    const page = e.target.closest('.sidebar-page');
    if (page) { clearTimeout(previewTimer); $('sidebarPreview').classList.remove('show'); }
  });
}

export function toggleFold(el, topic) {
  el.classList.toggle('folded');
  if (state.foldedTopics.has(topic)) state.foldedTopics.delete(topic); else state.foldedTopics.add(topic);
  const folded = el.classList.contains('folded');
  const pages = el.parentElement.querySelectorAll('.sidebar-page[data-topic="' + topic + '"]');
  pages.forEach(p => p.style.display = folded ? 'none' : '');
}

export async function updSidebarChats() {
  const sc = $('sidebarChats'); if (!sc) return;
  try {
    const raw = state.chatList || await api('/api/chat/list');
    const list = Array.isArray(raw) ? raw : (raw && raw.conversations) || [];
    state.chatList = list;
    const items = list.slice(0, 15);
    if (!items.length) { sc.innerHTML = ''; return; }
    let s = '';
    items.forEach(c => {
      const active = (state.cv === 'chat' && state.convId === c.id) ? ' active' : '';
      s += '<div class="sidebar-chat-item' + active + '" onclick="go(\'#/chat/' + h(c.id) + '\')" title="' + h(c.title) + '"><span class="chat-title">' + h(c.title) + '</span>'
        + '<button class="sidebar-chat-archive" onclick="event.stopPropagation();archiveChat(\'' + h(c.id) + '\')" title="归档"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg></button>'
        + '</div>';
    });
    sc.innerHTML = s;
  } catch { sc.innerHTML = ''; }
}
