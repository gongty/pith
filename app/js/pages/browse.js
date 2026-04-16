import { h, api, skelLines } from '../utils.js';
import state from '../state.js';

export async function rBrowse(c) {
  c.innerHTML = '<div class="page-browse">' + skelLines(5) + '</div>';
  try {
    const tree = state.td || await api('/api/wiki/tree'); state.td = tree;
    if (!tree || !tree.length) { c.innerHTML = '<div class="page-browse"><div class="browse-heading">全部文章</div><div style="color:var(--fg-tertiary);font-size:14px;padding:20px 0;text-align:center">暂无文章<br><br><button class="btn-fill" style="width:auto;padding:8px 20px" onclick="openIngest()">投喂知识</button></div></div>'; return; }
    let s = '<div class="page-browse"><div class="browse-heading">全部文章</div>';
    tree.forEach(t => {
      s += '<div class="browse-group"><div class="browse-group-head" onclick="this.parentElement.classList.toggle(\'closed\')"><span class="arr">&#9660;</span> ' + h(t.name) + '<span class="browse-group-count">' + t.children.length + '</span></div><ul class="browse-group-list">';
      t.children.forEach(ch => { s += '<li><a href="#/article/' + h(ch.path) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' + h(ch.title || ch.file) + '</a></li>'; });
      s += '</ul></div>';
    });
    s += '</div>'; c.innerHTML = s;
  } catch { c.innerHTML = '<div style="text-align:center;padding:60px;color:var(--fg-tertiary)">加载失败</div>'; }
}
