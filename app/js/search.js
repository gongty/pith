import { $, h, hRe, api } from './utils.js';
import state from './state.js';

export function openSearch() {
  $('searchOverlay').classList.add('open');
  const i = $('searchInput'); i.value = ''; i.focus();
  state.searchIdx = -1;
  $('searchResults').innerHTML = '<div class="search-empty-msg">输入关键词搜索 · ↑↓ 导航 · ↵ 打开</div>';
}

export function closeSearch() { $('searchOverlay').classList.remove('open'); }

export function searchFor(q) {
  openSearch();
  setTimeout(() => { $('searchInput').value = q; $('searchInput').dispatchEvent(new Event('input')); }, 50);
}

function updSearchFocus(items) {
  items.forEach((el, i) => el.classList.toggle('focused', i === state.searchIdx));
}

export function handleSearchKeydown(e) {
  if (!$('searchOverlay').classList.contains('open')) return;
  const items = $('searchResults').querySelectorAll('.search-result');
  if (e.key === 'ArrowDown') { e.preventDefault(); state.searchIdx = Math.min(state.searchIdx + 1, items.length - 1); updSearchFocus(items); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); state.searchIdx = Math.max(state.searchIdx - 1, 0); updSearchFocus(items); }
  else if (e.key === 'Enter' && state.searchIdx >= 0 && items[state.searchIdx]) { e.preventDefault(); items[state.searchIdx].click(); }
}

export function initSearchInput() {
  $('searchInput').addEventListener('input', e => {
    clearTimeout(state.st); const q = e.target.value.trim(); state.searchIdx = -1;
    if (!q) { $('searchResults').innerHTML = '<div class="search-empty-msg">输入关键词搜索 · ↑↓ 导航 · ↵ 打开</div>'; return; }
    state.st = setTimeout(async () => {
      try {
        const r = await api('/api/search?q=' + encodeURIComponent(q)); const c = $('searchResults');
        if (!r || !r.length) { c.innerHTML = '<div class="search-empty-msg">未找到结果</div>'; return; }
        c.innerHTML = r.slice(0, 8).map(x => {
          const ctx = x.matches && x.matches.length ? '<div class="search-result-ctx">' + h(x.matches[0].text).replace(new RegExp(hRe(q), 'gi'), '<mark>$&</mark>') + '</div>' : '';
          return '<div class="search-result" onclick="closeSearch();go(\'#/article/' + h(x.path) + '\')"><div class="search-result-title">' + h(x.title) + '</div><div class="search-result-path">' + h(x.path) + '</div>' + ctx + '</div>';
        }).join('');
      } catch { $('searchResults').innerHTML = '<div class="search-empty-msg">搜索出错</div>'; }
    }, 200);
  });
}
