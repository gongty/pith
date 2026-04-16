import { $, h, api, put, apiDel, toast, go, skelLines } from '../utils.js';
import state from '../state.js';
import { renderMd, html2md } from '../markdown.js';

export async function rArticle(c, p) {
  c.innerHTML = '<div class="page-article"><div class="page-article-inner">' + skelLines(8) + '</div></div>';
  state.artPath = p;
  try {
    const res = await api('/api/wiki/article?path=' + encodeURIComponent(p));
    state.artMd = res.content || '';
    const lines = state.artMd.split('\n');
    let title = '', bodyStart = 0;
    if (lines[0] && lines[0].startsWith('#')) { title = lines[0].replace(/^#+\s*/, ''); bodyStart = 1; while (bodyStart < lines.length && !lines[bodyStart].trim()) bodyStart++; }
    const bodyLines = lines.slice(bodyStart);
    const cleanLines = []; let skipMeta = true;
    for (const line of bodyLines) {
      if (skipMeta) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (/^\d+\s*(字|个来源|个引用)/.test(trimmed)) continue;
        if (/^(创建|更新|Created|Updated|Published)\s*[:：]/.test(trimmed)) continue;
        if (/^\d+\s*字\s*·/.test(trimmed)) continue;
        if (/^>\s*(来源|原文|Source|Raw)[：:]/.test(trimmed)) { cleanLines.push(line); continue; }
        if (/^#{1,4}\s/.test(trimmed) || (!trimmed.startsWith('>') && trimmed.length > 0)) { skipMeta = false; cleanLines.push(line); continue; }
        continue;
      }
      cleanLines.push(line);
    }
    const bodyMd = cleanLines.join('\n');
    const rendered = renderMd(bodyMd, p);

    let s = '<div class="page-article"><div class="page-article-inner">';
    s += '<div class="article-title" contenteditable="true" id="artTitle" oninput="onArtChange()">' + h(title) + '</div>';
    s += '<div class="article-body" contenteditable="true" id="artBody" oninput="onArtChange()">' + rendered + '</div>';
    s += await buildRelated(p);
    s += '</div>';
    s += buildArticleTOC(state.artMd);
    s += '</div>';
    s += '<div class="article-save-indicator" id="saveInd"></div>';
    c.innerHTML = s;

    const topActs = $('topbarActions');
    if (topActs && !document.getElementById('topbarDel')) {
      const delBtn = document.createElement('button');
      delBtn.id = 'topbarDel'; delBtn.className = 'topbar-btn'; delBtn.style.color = 'var(--fg-tertiary)';
      delBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';
      delBtn.title = '删除文章'; delBtn.onclick = showDel;
      topActs.insertBefore(delBtn, topActs.firstChild);
    }
    setupFormatToolbar();
  } catch (e) { c.innerHTML = '<div style="text-align:center;padding:60px;color:var(--fg-tertiary)">加载失败: ' + h(e.message) + '</div>'; }
}

async function buildRelated(curPath) {
  try {
    const tree = state.td || await api('/api/wiki/tree'); state.td = tree;
    const parts = curPath.split('/'); if (parts.length < 2) return '';
    const topic = parts[0];
    const topicNode = (tree || []).find(t => t.name === topic);
    if (!topicNode) return '';
    const siblings = topicNode.children.filter(c => c.path !== curPath);
    if (!siblings.length) return '';
    let s = '<div class="article-related"><div class="article-related-title">同主题文章</div>';
    siblings.forEach(c => {
      s += '<div class="article-related-item" onclick="go(\'#/article/' + h(c.path) + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' + h(c.title || c.file) + '</div>';
    });
    s += '</div>'; return s;
  } catch { return ''; }
}

function buildArticleTOC(md) {
  const headings = []; const lines = md.split('\n'); let inCode = false;
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) { inCode = !inCode; continue; }
    if (inCode) continue;
    const m = line.match(/^(#{1,4})\s+(.+)/);
    if (m && m[1].length > 1) headings.push({ level: m[1].length, text: m[2].trim() });
  }
  if (headings.length < 2) return '';
  const collapsed = localStorage.getItem('kb-toc-collapsed') === '1' ? ' collapsed' : '';
  let s = '<div class="article-toc' + collapsed + '" id="articleToc">';
  s += '<div class="article-toc-head" onclick="toggleToc()"><span class="article-toc-label">目录</span><span class="article-toc-toggle"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></span></div>';
  s += '<div class="article-toc-body">';
  headings.forEach(heading => {
    const cls = 'article-toc-item lvl' + heading.level;
    const id = heading.text.replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '');
    s += '<div class="' + cls + '" onclick="scrollToH(\'' + h(id) + '\')">' + h(heading.text) + '</div>';
  });
  s += '</div></div>'; return s;
}

export function toggleToc() {
  const t = $('articleToc'); if (!t) return;
  t.classList.toggle('collapsed');
  localStorage.setItem('kb-toc-collapsed', t.classList.contains('collapsed') ? '1' : '0');
}

export function scrollToH(id) {
  const body = $('artBody'); if (!body) return;
  for (const el of body.querySelectorAll('h1,h2,h3,h4')) {
    if (el.textContent.trim().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '') === id) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' }); break;
    }
  }
}

export function onArtChange() {
  clearTimeout(state.saveT);
  const ind = $('saveInd'); if (ind) { ind.textContent = '编辑中...'; ind.classList.add('show'); }
  state.saveT = setTimeout(autoSave, 1500);
}

async function autoSave() {
  const titleEl = $('artTitle'), bodyEl = $('artBody'), ind = $('saveInd');
  if (!titleEl || !bodyEl) return;
  if (ind) { ind.textContent = '保存中...'; ind.classList.add('show'); }
  const title = titleEl.innerText.trim();
  const bodyHtml = bodyEl.innerHTML;
  const bodyMd = html2md(bodyHtml);
  const fullMd = (title ? '# ' + title + '\n\n' : '') + bodyMd;
  try {
    await put('/api/wiki/article', { path: state.artPath, content: fullMd });
    state.artMd = fullMd; state.td = null;
    if (ind) { ind.textContent = '已保存'; setTimeout(() => ind.classList.remove('show'), 2000); }
  } catch { if (ind) { ind.textContent = '保存失败'; ind.style.color = 'var(--red)'; } }
}

/* ── Format toolbar ── */
function setupFormatToolbar() {
  const body = $('artBody'); if (!body) return;
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed || !body.contains(sel.anchorNode)) { hideFormatToolbar(); return; }
    const range = sel.getRangeAt(0); const rect = range.getBoundingClientRect();
    const tb = $('formatToolbar');
    tb.style.top = (rect.top + window.scrollY - 42) + 'px';
    tb.style.left = (rect.left + rect.width / 2 - tb.offsetWidth / 2) + 'px';
    tb.classList.add('show');
  });
}

export function hideFormatToolbar() { $('formatToolbar').classList.remove('show'); }

export function fmtCmd(cmd) {
  if (cmd === 'bold') document.execCommand('bold');
  else if (cmd === 'italic') document.execCommand('italic');
  else if (cmd === 'code') {
    const sel = window.getSelection();
    if (sel.rangeCount) { const text = sel.toString(); document.execCommand('insertHTML', '<code>' + h(text) + '</code>'); }
  }
  else if (cmd === 'link') {
    const url = prompt('链接地址:', 'https://');
    if (url) document.execCommand('createLink', false, url);
  }
  else if (cmd === 'h2') document.execCommand('formatBlock', false, 'h2');
  else if (cmd === 'h3') document.execCommand('formatBlock', false, 'h3');
  hideFormatToolbar(); onArtChange();
}

let delPath = '';
function showDel() { delPath = state.artPath; $('delConfirm').classList.add('open'); }
export function closeDel() { $('delConfirm').classList.remove('open'); }
export async function doDel() {
  closeDel();
  const path = delPath;
  let savedContent = state.artMd;
  try {
    await apiDel('/api/wiki/article?path=' + encodeURIComponent(path)); state.td = null;
    go('#/browse');
    toast('已删除', async () => {
      try { await put('/api/wiki/article', { path, content: savedContent }); state.td = null; toast('已恢复'); go('#/article/' + path); } catch { toast('恢复失败'); }
    });
  } catch (e) { toast('删除失败'); }
}

export async function newArticle() {
  const title = prompt('文章标题:'); if (!title) return;
  const tree = state.td || await api('/api/wiki/tree'); state.td = tree;
  const topic = (tree && tree.length) ? tree[0].name : 'general';
  const slug = title.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '');
  const path = topic + '/' + slug + '.md';
  try {
    await put('/api/wiki/article', { path, content: '# ' + title + '\n\n' }); state.td = null;
    go('#/article/' + path); toast('已创建');
  } catch (e) { toast('创建失败: ' + e.message); }
}
