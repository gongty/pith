import { $, h, hRe, api, go, jsAttr } from './utils.js';
import state from './state.js';

export function openSearch() {
  $('searchOverlay').classList.add('open');
  const i = $('searchInput'); i.value = ''; i.focus();
  state.searchIdx = -1;
  $('searchResults').innerHTML = '<div class="search-empty-msg">搜索文章，或输入问题直接提问 AI</div>';
}

export function closeSearch() { $('searchOverlay').classList.remove('open'); }

export function searchFor(q) {
  openSearch();
  setTimeout(() => { $('searchInput').value = q; $('searchInput').dispatchEvent(new Event('input')); }, 50);
}

function updSearchFocus(items) {
  items.forEach((el, i) => el.classList.toggle('focused', i === state.searchIdx));
}

function aiRow(q) {
  return '<div class="search-ask-ai" onclick="askFromSearch()">' +
    '<span class="search-ask-ai-icon">AI</span>' +
    '<span class="search-ask-ai-text">提问「' + h(q) + '」</span>' +
    '<kbd class="search-ask-ai-hint">\u21B5</kbd></div>';
}

export function handleSearchKeydown(e) {
  if (!$('searchOverlay').classList.contains('open')) return;
  const items = $('searchResults').querySelectorAll('.search-result, .search-ask-ai');
  if (e.key === 'ArrowDown') { e.preventDefault(); state.searchIdx = Math.min(state.searchIdx + 1, items.length - 1); updSearchFocus(items); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); state.searchIdx = Math.max(state.searchIdx - 1, 0); updSearchFocus(items); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (state.searchIdx >= 0 && items[state.searchIdx]) {
      items[state.searchIdx].click();
    } else {
      // No selection — Enter triggers AI ask
      const q = $('searchInput').value.trim();
      if (q) askFromSearch();
    }
  }
}

export function initSearchInput() {
  $('searchInput').addEventListener('input', e => {
    clearTimeout(state.st); const q = e.target.value.trim(); state.searchIdx = -1;
    if (!q) { $('searchResults').innerHTML = '<div class="search-empty-msg">搜索文章，或输入问题直接提问 AI</div>'; return; }
    state.st = setTimeout(async () => {
      try {
        const r = await api('/api/search?q=' + encodeURIComponent(q)); const c = $('searchResults');
        if (!r || !r.length) {
          c.innerHTML = '<div class="search-empty-msg">未找到「' + h(q) + '」的文章</div>' + aiRow(q);
          return;
        }
        const shown = Math.min(r.length, 8);
        const countHint = '<div class="search-count">' + shown + ' / ' + r.length + ' 篇文章</div>';
        c.innerHTML = countHint + r.slice(0, 8).map(x => {
          const ctx = x.matches && x.matches.length ? '<div class="search-result-ctx">' + h(x.matches[0].text).replace(new RegExp(hRe(q), 'gi'), '<mark>$&</mark>') + '</div>' : '';
          return '<div class="search-result" onclick="closeSearch();go(\'#/article/' + jsAttr(x.path) + '\')"><div class="search-result-title">' + h(x.title) + '</div><div class="search-result-path">' + h(x.path) + '</div>' + ctx + '</div>';
        }).join('') + aiRow(q);
      } catch { $('searchResults').innerHTML = '<div class="search-empty-msg">搜索出错</div>'; }
    }, 200);
  });
}

/* ── Ask AI from search overlay ── */
window.askFromSearch = async function () {
  const query = $('searchInput').value.trim();
  if (!query || state.chatBusy) return;
  closeSearch();
  state.pendingChat = query;
  state.convId = null;
  state.msgs = [];
  go('#/chat');
};
