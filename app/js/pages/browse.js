import { h, api, go, skelLines } from '../utils.js';
import state from '../state.js';

function relTime(ms) {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60); if (min < 60) return min + ' 分钟前';
  const hr = Math.floor(min / 60); if (hr < 24) return hr + ' 小时前';
  const d = Math.floor(hr / 24); if (d < 30) return d + ' 天前';
  const mo = Math.floor(d / 30); if (mo < 12) return mo + ' 个月前';
  return Math.floor(mo / 12) + ' 年前';
}

const TOPIC_COLORS = [
  { bg: 'rgba(91,91,214,0.08)', fg: '#5B5BD6', border: 'rgba(91,91,214,0.15)' },
  { bg: 'rgba(68,131,97,0.08)', fg: '#449961', border: 'rgba(68,131,97,0.15)' },
  { bg: 'rgba(235,87,87,0.08)', fg: '#E55', border: 'rgba(235,87,87,0.15)' },
  { bg: 'rgba(200,130,50,0.08)', fg: '#C88232', border: 'rgba(200,130,50,0.15)' },
  { bg: 'rgba(90,100,200,0.08)', fg: '#5A64C8', border: 'rgba(90,100,200,0.15)' },
  { bg: 'rgba(180,80,150,0.08)', fg: '#B45096', border: 'rgba(180,80,150,0.15)' },
];

function extractSummary(title) {
  if (!title) return '';
  // Use first sentence or truncate
  const s = title.replace(/^[#\s]+/, '');
  return s.length > 60 ? s.slice(0, 58) + '…' : s;
}

export async function rBrowse(c) {
  c.innerHTML = '<div class="page-browse">' + skelLines(5) + '</div>';
  try {
    const tree = state.td || await api('/api/wiki/tree'); state.td = tree;
    if (!tree || !tree.length) {
      c.innerHTML = '<div class="page-browse"><div class="browse-header"><h1 class="browse-heading">全部文章</h1></div>'
        + '<div class="browse-empty"><div class="browse-empty-icon">📚</div><p>知识库还是空的</p>'
        + '<button class="btn-fill" style="width:auto;padding:10px 24px" onclick="openIngest()">投喂第一篇</button></div></div>';
      return;
    }
    const totalArticles = tree.reduce((n, t) => n + t.children.length, 0);
    let s = '<div class="page-browse">';
    // Header with stats
    s += '<div class="browse-header"><h1 class="browse-heading">全部文章</h1>'
      + '<div class="browse-stats"><span class="browse-stat">' + totalArticles + ' 篇文章</span>'
      + '<span class="browse-stat-sep">·</span><span class="browse-stat">' + tree.length + ' 个主题</span></div></div>';

    // Topic groups
    tree.forEach((t, ti) => {
      const color = TOPIC_COLORS[ti % TOPIC_COLORS.length];
      s += '<div class="browse-group">'
        + '<div class="browse-group-head" onclick="this.parentElement.classList.toggle(\'closed\')">'
        + '<span class="browse-topic-dot" style="background:' + color.fg + '"></span>'
        + '<span class="browse-topic-name">' + h(t.name) + '</span>'
        + '<span class="browse-group-count">' + t.children.length + ' 篇</span>'
        + '<span class="browse-arr"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></span>'
        + '</div>';
      s += '<div class="browse-group-grid">';
      t.children.forEach(ch => {
        s += '<div class="browse-card" onclick="go(\'#/article/' + h(ch.path) + '\')">'
          + '<div class="browse-card-title">' + h(ch.title || ch.name) + '</div>'
          + '<div class="browse-card-meta">'
          + '<span class="browse-card-topic" style="color:' + color.fg + ';background:' + color.bg + '">' + h(t.name) + '</span>'
          + '<span class="browse-card-time">' + relTime(ch.mtime) + '</span>'
          + '</div></div>';
      });
      s += '</div></div>';
    });
    s += '</div>';
    c.innerHTML = s;
  } catch { c.innerHTML = '<div style="text-align:center;padding:60px;color:var(--fg-tertiary)">加载失败</div>'; }
}
