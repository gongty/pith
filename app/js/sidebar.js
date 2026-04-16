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
}

export function switchSidebarTab(tab) {
  document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const chatPanel = $('sidebarPanelChat');
  const pagesPanel = $('sidebarPanelPages');
  if (chatPanel) chatPanel.style.display = tab === 'chat' ? '' : 'none';
  if (pagesPanel) pagesPanel.style.display = tab === 'pages' ? '' : 'none';
  localStorage.setItem('kb-sidebar-tab', tab);
}

export async function updSidebarPages() {
  const sp = $('sidebarPages'); if (!sp) return;
  try {
    const tree = state.td || await api('/api/wiki/tree'); state.td = tree;
    let s = '';
    (tree || []).forEach(t => {
      const folded = state.foldedTopics.has(t.name) ? 'folded' : '';
      s += '<div class="sidebar-topic ' + folded + '" onclick="toggleFold(this,\'' + h(t.name) + '\')" title="' + h(t.name) + '">' + h(t.name) + ' <span class="topic-count">' + t.children.length + '</span></div>';
      t.children.forEach(c => {
        const active = state.artPath === c.path ? ' active' : '';
        const display = folded ? ' style="display:none"' : '';
        s += '<div class="sidebar-page' + active + '" data-topic="' + h(t.name) + '"' + display + ' onclick="go(\'#/article/' + h(c.path) + '\')" title="' + h(c.title || c.file) + '"><span class="page-title">' + h(c.title || c.file) + '</span></div>';
      });
    });
    sp.innerHTML = s;
  } catch {}
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
      s += '<div class="sidebar-chat-item' + active + '" onclick="go(\'#/chat/' + h(c.id) + '\')" title="' + h(c.title) + '"><span class="chat-title">' + h(c.title) + '</span></div>';
    });
    sc.innerHTML = s;
  } catch { sc.innerHTML = ''; }
}
