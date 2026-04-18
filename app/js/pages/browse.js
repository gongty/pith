import { h, api, go, skelLines, jsAttr, isUnread, markAllRead } from '../utils.js';
import state from '../state.js';
import { t } from '../i18n.js';

function relTime(ms) {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return t('time.justNow');
  const min = Math.floor(sec / 60); if (min < 60) return t('time.minAgo', { n: min });
  const hr = Math.floor(min / 60); if (hr < 24) return t('time.hrAgo', { n: hr });
  const d = Math.floor(hr / 24); if (d < 30) return t('time.dayAgo', { n: d });
  const mo = Math.floor(d / 30); if (mo < 12) return t('time.monthAgo', { n: mo });
  return t('time.yearAgo', { n: Math.floor(mo / 12) });
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

export function markAllArticlesRead() {
  const tree = state.td;
  if (!tree) return;
  const all = [];
  tree.forEach(tp => (tp.children || []).forEach(ch => all.push(ch.path)));
  markAllRead(all);
  document.querySelectorAll('.unread-dot').forEach(el => el.remove());
  document.querySelectorAll('.unread').forEach(el => el.classList.remove('unread'));
  const link = document.querySelector('.browse-mark-all-read');
  if (link) {
    const prev = link.previousElementSibling;
    if (prev && prev.classList.contains('browse-stat-sep')) prev.remove();
    link.remove();
  }
}

export async function rBrowse(c, tagFilter) {
  c.innerHTML = '<div class="page-browse">' + skelLines(5) + '</div>';
  try {
    const tree = state.td || await api('/api/wiki/tree'); state.td = tree;
    if (!tree || !tree.length) {
      c.innerHTML = '<div class="page-browse"><div class="browse-header"><h1 class="browse-heading">' + t('browse.title') + '</h1></div>'
        + '<div class="browse-empty"><p>' + t('browse.empty') + '</p>'
        + '<button class="btn-fill" style="width:auto;padding:10px 24px" onclick="openIngest()">' + t('browse.ingestFirst') + '</button></div></div>';
      return;
    }
    // 如果有 tag 过滤，先筛选每个 topic 的 children
    let view = tree;
    if (tagFilter) {
      view = tree.map(tp => ({
        ...tp,
        children: tp.children.filter(ch => Array.isArray(ch.tags) && ch.tags.includes(tagFilter))
      })).filter(tp => tp.children.length);
    }
    const totalArticles = view.reduce((n, tp) => n + tp.children.length, 0);
    let s = '<div class="page-browse">';
    // Header with stats
    s += '<div class="browse-header"><h1 class="browse-heading">' + (tagFilter ? t('browse.tag', { tag: h(tagFilter) }) : t('browse.title')) + '</h1>'
      + '<div class="browse-stats"><span class="browse-stat">' + t('unit.articles', { n: totalArticles }) + '</span>'
      + '<span class="browse-stat-sep">·</span><span class="browse-stat">' + t('unit.topics', { n: view.length }) + '</span>';
    if (tagFilter) {
      s += '<span class="browse-stat-sep">·</span><a class="browse-clear-tag" href="#/browse">' + t('browse.clearFilter') + '</a>';
    }
    const hasUnread = tree.some(tp => tp.children.some(ch => isUnread(ch.path)));
    if (hasUnread) {
      s += '<span class="browse-stat-sep">·</span><a class="browse-mark-all-read" onclick="markAllArticlesRead()">' + t('browse.markAllRead') + '</a>';
    }
    s += '</div></div>';

    if (!totalArticles) {
      s += '<div class="browse-empty"><p>' + t('browse.noTag') + '</p><a class="btn-fill" style="width:auto;padding:10px 24px;text-decoration:none" href="#/browse">' + t('browse.backAll') + '</a></div></div>';
      c.innerHTML = s;
      return;
    }

    // Topic groups
    view.forEach((tp, ti) => {
      const color = TOPIC_COLORS[ti % TOPIC_COLORS.length];
      s += '<div class="browse-group">'
        + '<div class="browse-group-head" onclick="this.parentElement.classList.toggle(\'closed\')">'
        + '<span class="browse-topic-dot" style="background:' + color.fg + '"></span>'
        + '<span class="browse-topic-name">' + h(tp.name) + '</span>'
        + '<span class="browse-group-count">' + t('unit.article', { n: tp.children.length }) + '</span>'
        + '<span class="browse-arr"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></span>'
        + '</div>';
      s += '<div class="browse-group-grid">';
      tp.children.forEach(ch => {
        const unreadCls = isUnread(ch.path) ? ' unread' : '';
        s += '<div class="browse-card' + unreadCls + '" onclick="go(\'#/article/' + jsAttr(ch.path) + '\')">'
          + (unreadCls ? '<span class="unread-dot"></span>' : '')
          + '<div class="browse-card-title">' + h(ch.title || ch.name) + '</div>'
          + '<div class="browse-card-meta">'
          + '<span class="browse-card-topic" style="color:' + color.fg + ';background:' + color.bg + '">' + h(tp.name) + '</span>'
          + '<span class="browse-card-time">' + relTime(ch.mtime) + '</span>'
          + '</div></div>';
      });
      s += '</div></div>';
    });
    s += '</div>';
    c.innerHTML = s;
  } catch { c.innerHTML = '<div style="text-align:center;padding:60px;color:var(--fg-tertiary)">' + t('common.loadFailed') + '</div>'; }
}
