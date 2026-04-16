import { $, h, api, skelLines } from '../utils.js';
import { renderMd } from '../markdown.js';

export async function rRaw(c, p) {
  c.innerHTML = '<div class="page-article"><div class="page-article-inner">' + skelLines(8) + '</div></div>';
  try {
    const res = await api('/api/raw/file?path=' + encodeURIComponent(p));
    const content = res.content || '';
    const parts = p.split('/');
    const fname = parts[parts.length - 1];
    const isMd = /\.md$/i.test(fname);
    const rendered = isMd ? renderMd(content, 'raw/' + p) : '<pre class="raw-pre"><code>' + h(content) + '</code></pre>';

    let s = '<div class="page-article"><div class="page-article-inner">';
    s += '<div class="raw-badge">原始素材 · ' + h(p) + '</div>';
    s += '<div class="article-title">' + h(fname) + '</div>';
    s += '<div class="article-body raw-body">' + rendered + '</div>';
    s += '</div></div>';
    c.innerHTML = s;
  } catch (e) {
    c.innerHTML = '<div style="text-align:center;padding:60px;color:var(--fg-tertiary)">加载失败: ' + h(e.message) + '</div>';
  }
}
