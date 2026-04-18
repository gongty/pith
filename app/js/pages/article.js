import { $, h, api, put, apiDel, toast, go, skelLines, jsAttr, markRead } from '../utils.js';
import state from '../state.js';
import { renderMd, html2md, parseFrontmatter, initTableResize, fmtChat } from '../markdown.js';

export async function rArticle(c, p) {
  c.innerHTML = '<div class="page-article"><div class="page-article-inner">' + skelLines(8) + '</div></div>';
  state.artPath = p;
  markRead(p);
  try {
    const res = await api('/api/wiki/article?path=' + encodeURIComponent(p));
    state.artMd = res.content || '';
    // 安全兜底：内容过大或存在超长单行（通常是二进制/PDF 残留），切换为只读安全视图
    const md = state.artMd;
    const MAX_CHARS = 300000;
    let maxLine = 0;
    for (let i = 0, j = 0; i <= md.length; i++) {
      if (i === md.length || md.charCodeAt(i) === 10) {
        if (i - j > maxLine) maxLine = i - j;
        j = i + 1;
        if (maxLine > 20000) break;
      }
    }
    if (md.length > MAX_CHARS || maxLine > 20000) {
      const firstLine = md.split('\n', 1)[0] || '';
      const title = firstLine.startsWith('#') ? firstLine.replace(/^#+\s*/, '') : (p.split('/').pop() || '').replace(/\.md$/, '');
      let safe = '<div class="page-article"><div class="page-article-inner">';
      safe += '<div class="article-title" style="pointer-events:none">' + h(title) + '</div>';
      safe += '<div style="padding:12px 16px;margin:12px 0;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-hover);color:var(--fg-secondary);font-size:13px;line-height:1.6">'
        + '此文章内容异常（约 ' + Math.round(md.length / 1024) + ' KB，可能包含未提取成功的二进制素材），已切换为只读安全视图，前 5000 字预览如下。建议删除并重新投喂来源。'
        + '</div>';
      safe += '<pre style="white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.55;color:var(--fg-secondary);max-height:70vh;overflow:auto;padding:12px;border:1px solid var(--border);border-radius:var(--radius)">'
        + h(md.slice(0, 5000))
        + (md.length > 5000 ? '\n\n…（已截断）' : '')
        + '</pre>';
      safe += '</div></div>';
      c.innerHTML = safe;
      // 顶栏删除按钮照常提供
      const topActs = $('topbarActions');
      if (topActs && !document.getElementById('topbarDel')) {
        const delBtn = document.createElement('button');
        delBtn.id = 'topbarDel'; delBtn.className = 'topbar-btn'; delBtn.style.color = 'var(--fg-tertiary)';
        delBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';
        delBtn.title = '删除文章'; delBtn.onclick = showDel;
        topActs.insertBefore(delBtn, topActs.firstChild);
      }
      return;
    }
    // 先剥离 YAML frontmatter，拿到 tags 等元数据
    const fm = parseFrontmatter(md);
    const mdNoFm = fm.body;
    const tags = Array.isArray(fm.data && fm.data.tags) ? fm.data.tags.filter(t => typeof t === 'string' && t.trim()) : [];
    const lines = mdNoFm.split('\n');
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
    s += '<div class="article-title" contenteditable="true" spellcheck="false" autocorrect="off" autocapitalize="off" id="artTitle" oninput="onArtChange()">' + h(title) + '</div>';
    if (tags.length) {
      s += '<div class="article-tags" id="artTags">';
      for (const t of tags) {
        s += '<a class="article-tag-chip" href="#/browse?tag=' + encodeURIComponent(t) + '">' + h(t) + '</a>';
      }
      s += '</div>';
    }
    s += '<div class="article-body" contenteditable="true" spellcheck="false" autocorrect="off" autocapitalize="off" id="artBody" oninput="onArtChange()">' + rendered + '</div>';
    s += await buildRelated(p);
    s += '</div>';
    s += buildArticleTOC(mdNoFm);
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
    setupTitlePlainPaste();
    setupBodyPasteSanitize();
    setupFormatToolbar();
    initTocSpy();
    setupSlashMenu();
    setupImageToolbar();
    setupLinkNav();
    initTableResize($('artBody'));
    setupArticleQA(p);
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
      s += '<div class="article-related-item" onclick="go(\'#/article/' + jsAttr(c.path) + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' + h(c.title || c.file) + '</div>';
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
    s += '<div class="' + cls + '" data-hid="' + h(id) + '" onclick="scrollToH(\'' + h(id) + '\')">' + h(heading.text) + '</div>';
  });
  s += '</div></div>'; return s;
}

let _tocObserver = null;
function initTocSpy() {
  if (_tocObserver) _tocObserver.disconnect();
  const body = $('artBody'); if (!body) return;
  const headings = body.querySelectorAll('h1,h2,h3,h4');
  if (!headings.length) return;
  const scroller = document.querySelector('.content');
  if (!scroller) return;
  // Map heading element → its id string (same logic as buildArticleTOC)
  const hMap = new Map();
  headings.forEach(el => {
    const id = el.textContent.trim().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '');
    hMap.set(el, id);
  });
  // Track which headings are above the viewport top
  const visibleSet = new Set();
  _tocObserver = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) visibleSet.add(e.target); else visibleSet.delete(e.target); });
    // Find the last heading that has scrolled past the top (or first visible)
    let activeId = null;
    for (const el of headings) {
      const rect = el.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      if (rect.top <= scrollerRect.top + 80) activeId = hMap.get(el);
    }
    if (!activeId && visibleSet.size) activeId = hMap.get(visibleSet.values().next().value);
    // Update TOC
    const tocBody = document.querySelector('.article-toc-body');
    if (!tocBody) return;
    tocBody.querySelectorAll('.article-toc-item').forEach(item => {
      item.classList.toggle('active', item.dataset.hid === activeId);
    });
  }, { root: scroller, rootMargin: '-20px 0px -70% 0px', threshold: 0 });
  headings.forEach(el => _tocObserver.observe(el));
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
  // 保留原文件的 YAML frontmatter（tags 等元数据），避免编辑正文时被吞掉
  // 用 parseFrontmatter 验证：仅在能成功解析出闭合 --- 的 frontmatter 时才保留原字节
  let fmBlock = '';
  const origMd = state.artMd || '';
  const fm = parseFrontmatter(origMd);
  if (fm.body !== origMd) {
    const origLines = origMd.split('\n');
    const bodyLines = fm.body.split('\n');
    const fmLen = origLines.length - bodyLines.length;
    fmBlock = origLines.slice(0, fmLen).join('\n') + '\n';
  }
  const fullMd = fmBlock + (title ? '# ' + title + '\n\n' : '') + bodyMd;
  try {
    await put('/api/wiki/article', { path: state.artPath, content: fullMd });
    state.artMd = fullMd; state.td = null;
    if (ind) { ind.textContent = '已保存'; setTimeout(() => ind.classList.remove('show'), 2000); }
  } catch { if (ind) { ind.textContent = '保存失败'; ind.style.color = 'var(--red)'; } }
}

/* ── Title: 纯文本粘贴 ──
   标题 div 是 contenteditable，浏览器默认粘贴会保留 inline style（font-size 等），
   导致"首字母用 2.5em、粘入文字用源站小字号"的混排。标题本就只存 innerText，
   这里直接拦截 paste，只取 text/plain 并把换行压成空格。 */
function setupTitlePlainPaste() {
  const el = $('artTitle'); if (!el) return;
  el.addEventListener('paste', e => {
    e.preventDefault();
    const cd = e.clipboardData || window.clipboardData;
    const text = (cd && cd.getData('text/plain')) || '';
    const clean = text.replace(/[\r\n\t]+/g, ' ').trim();
    if (!clean) return;
    document.execCommand('insertText', false, clean);
  });
  // 阻止把富文本拖入标题造成同样混排
  el.addEventListener('drop', e => {
    const cd = e.dataTransfer;
    const text = (cd && cd.getData('text/plain')) || '';
    if (!text) return;
    e.preventDefault();
    const clean = text.replace(/[\r\n\t]+/g, ' ').trim();
    document.execCommand('insertText', false, clean);
  });
}

/* ── Body: 富文本粘贴清洗 ──
   保留结构/语义（段落、列表、标题、链接、代码、加粗、斜体、图片、表格、引用），
   剥掉所有 inline style / class / 颜色 / font-* / mso-* 等 attribute 垃圾，
   展开 span / font 这类纯样式壳，删 script / style / meta 节点，
   防 XSS：<a href> 剥 javascript: 协议，所有 on* 事件属性清掉。 */
const BODY_KEEP_TAGS = new Set([
  'P','DIV','BR','H1','H2','H3','H4','H5','H6',
  'UL','OL','LI','BLOCKQUOTE','PRE','CODE','HR',
  'TABLE','THEAD','TBODY','TR','TH','TD',
  'STRONG','B','EM','I','U','S','DEL','A','IMG',
]);
const BODY_UNWRAP_TAGS = new Set(['SPAN','FONT','O:P','META']);
const BODY_DROP_TAGS = new Set(['SCRIPT','STYLE','LINK','HEAD','TITLE','NOSCRIPT','IFRAME','OBJECT','EMBED']);
const BODY_ATTR_WHITELIST = {
  A: new Set(['href','title']),
  IMG: new Set(['src','alt','title']),
};

function sanitizeBodyHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.body;
  function walk(node) {
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === 8) { child.remove(); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toUpperCase();
      if (BODY_DROP_TAGS.has(tag)) { child.remove(); continue; }
      if (BODY_UNWRAP_TAGS.has(tag) || !BODY_KEEP_TAGS.has(tag)) {
        walk(child);
        while (child.firstChild) child.parentNode.insertBefore(child.firstChild, child);
        child.remove();
        continue;
      }
      const whitelist = BODY_ATTR_WHITELIST[tag] || null;
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        // 没白名单：全删；有白名单：白名单外全删
        if (!whitelist || !whitelist.has(name)) child.removeAttribute(attr.name);
      }
      if (tag === 'A') {
        const href = child.getAttribute('href') || '';
        if (/^\s*javascript:/i.test(href) || /^\s*data:/i.test(href)) child.removeAttribute('href');
      }
      if (tag === 'IMG') {
        const src = child.getAttribute('src') || '';
        if (/^\s*javascript:/i.test(src)) child.removeAttribute('src');
      }
      walk(child);
    }
  }
  walk(root);
  return root.innerHTML;
}

function setupBodyPasteSanitize() {
  const el = $('artBody'); if (!el) return;
  el.addEventListener('paste', e => {
    const cd = e.clipboardData || window.clipboardData;
    if (!cd) return;
    const html = cd.getData('text/html');
    if (!html) return; // 纯文本交给浏览器默认行为，没有 style 问题
    e.preventDefault();
    const clean = sanitizeBodyHtml(html);
    if (!clean) return;
    document.execCommand('insertHTML', false, clean);
    onArtChange();
  });
}

/* ── Format toolbar ── */
let _selHandler = null;
function setupFormatToolbar() {
  const body = $('artBody'); if (!body) return;
  if (_selHandler) document.removeEventListener('selectionchange', _selHandler);
  _selHandler = () => {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed || !body.contains(sel.anchorNode)) { hideFormatToolbar(); return; }
    const range = sel.getRangeAt(0); const rect = range.getBoundingClientRect();
    const tb = $('formatToolbar');
    tb.style.top = (rect.top + window.scrollY - 42) + 'px';
    tb.style.left = (rect.left + rect.width / 2 - tb.offsetWidth / 2) + 'px';
    tb.classList.add('show');
  };
  document.addEventListener('selectionchange', _selHandler);
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

/* ── Slash command menu (/ 块插入) ── */
const SLASH_BLOCKS = [
  { icon: 'H1', label: '一级标题', cat: 'basic', insert: () => execBlock('formatBlock', 'h1') },
  { icon: 'H2', label: '二级标题', cat: 'basic', insert: () => execBlock('formatBlock', 'h2') },
  { icon: 'H3', label: '三级标题', cat: 'basic', insert: () => execBlock('formatBlock', 'h3') },
  { icon: '•', label: '无序列表', cat: 'basic', insert: () => execBlock('insertUnorderedList') },
  { icon: '1.', label: '有序列表', cat: 'basic', insert: () => execBlock('insertOrderedList') },
  { icon: '☑', label: '待办', cat: 'block', insert: () => insertMdBlock('- [ ] 待办事项') },
  { icon: '❝', label: '引用块', cat: 'block', insert: () => insertMdBlock('> 引用内容') },
  { icon: '{}', label: '代码块', cat: 'block', insert: () => insertHtmlBlock('<pre><code>代码</code></pre>') },
  { icon: '┬', label: '表格', cat: 'block', insert: () => insertHtmlBlock('<div class="table-wrap"><table><thead><tr><th>列 1</th><th>列 2</th><th>列 3</th></tr></thead><tbody><tr><td></td><td></td><td></td></tr><tr><td></td><td></td><td></td></tr></tbody></table></div>') },
  { icon: '—', label: '分割线', cat: 'block', insert: () => insertHtmlBlock('<hr>') },
  { icon: '💡', label: '高亮块', cat: 'block', insert: () => insertHtmlBlock('<div class="callout"><p>内容</p></div>') },
];

function clearSlashTrigger() {
  if (_slashFromPlus) { _slashFromPlus = false; return; }
  // Remove the "/" character before inserting block
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const node = sel.anchorNode;
  if (node && node.nodeType === 3 && node.textContent.includes('/')) {
    const parent = node.parentElement;
    if (parent && /^(P|DIV)$/i.test(parent.tagName) && node.textContent.trim().replace(/\//g, '').length === 0) {
      // Whole paragraph is just "/" + maybe some filter chars — select & delete it
      const r = document.createRange();
      r.selectNodeContents(parent);
      sel.removeAllRanges(); sel.addRange(r);
      document.execCommand('delete');
    } else {
      // Inline: just remove from / to cursor
      const pos = sel.anchorOffset;
      const slashPos = node.textContent.lastIndexOf('/');
      if (slashPos >= 0) {
        const r = document.createRange();
        r.setStart(node, slashPos);
        r.setEnd(node, pos);
        sel.removeAllRanges(); sel.addRange(r);
        document.execCommand('delete');
      }
    }
  }
}

function execBlock(cmd, val) { clearSlashTrigger(); document.execCommand(cmd, false, val || null); closeSlashMenu(); onArtChange(); }

function insertHtmlBlock(html) {
  clearSlashTrigger();
  document.execCommand('insertHTML', false, html);
  closeSlashMenu();
  onArtChange();
}

function insertMdBlock(md) {
  const body = $('artBody'); if (!body) return;
  const html = renderMd(md, state.artPath);
  insertHtmlBlock(html);
}

export function closeSlashMenu() {
  const menu = $('slashMenu');
  if (menu) menu.classList.remove('open');
  _slashFilter = '';
  // Re-evaluate plus button after menu closes
  if (_plusBtn) setTimeout(() => { _plusBtn.classList.remove('show'); }, 50);
}

function showSlashMenu(anchorRect) {
  let menu = $('slashMenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'slashMenu';
    menu.className = 'slash-menu';
    document.body.appendChild(menu);
  }
  _slashFilter = '';
  _slashFromPlus = !!anchorRect;
  renderSlashItems(menu, '');
  // Position near cursor or anchor
  let rect = anchorRect;
  if (!rect) {
    const sel = window.getSelection();
    if (sel.rangeCount) rect = sel.getRangeAt(0).getBoundingClientRect();
  }
  if (rect) {
    const scroller = document.querySelector('.content');
    const scrollerRect = scroller ? scroller.getBoundingClientRect() : { top: 0, left: 0 };
    menu.style.top = (rect.bottom + 4) + 'px';
    menu.style.left = Math.max(rect.left, scrollerRect.left + 24) + 'px';
  }
  menu.classList.add('open');
  _slashIdx = 0;
  highlightSlashItem(menu);
}

let _slashFilter = '';
let _slashIdx = 0;
let _slashFromPlus = false;

function renderSlashItems(menu, filter) {
  const items = SLASH_BLOCKS.filter(b => !filter || b.label.includes(filter));
  let html = '<div class="slash-menu-head">插入块</div>';
  items.forEach((b, i) => {
    const absIdx = SLASH_BLOCKS.indexOf(b);
    html += '<div class="slash-menu-item' + (i === 0 ? ' active' : '') + '" data-abs="' + absIdx + '" onmousedown="pickSlash(' + absIdx + ')">'
      + '<span class="slash-menu-icon">' + b.icon + '</span>'
      + '<span class="slash-menu-label">' + h(b.label) + '</span></div>';
  });
  if (!items.length) html += '<div class="slash-menu-empty">无匹配项</div>';
  menu.innerHTML = html;
}

function highlightSlashItem(menu) {
  menu.querySelectorAll('.slash-menu-item').forEach((el, i) => el.classList.toggle('active', i === _slashIdx));
}

export function pickSlash(idx) {
  SLASH_BLOCKS[idx].insert();
}

let _slashKeyHandler = null;
function setupSlashMenu() {
  const body = $('artBody'); if (!body) return;
  if (_slashKeyHandler) body.removeEventListener('keydown', _slashKeyHandler);

  body.addEventListener('input', (e) => {
    const menu = $('slashMenu');
    if (menu && menu.classList.contains('open')) {
      // Filter as user types after /
      const sel = window.getSelection();
      if (sel.rangeCount) {
        const node = sel.anchorNode;
        if (node && node.nodeType === 3) {
          const text = node.textContent;
          const slashPos = text.lastIndexOf('/');
          if (slashPos >= 0) {
            _slashFilter = text.slice(slashPos + 1);
            _slashIdx = 0;
            renderSlashItems(menu, _slashFilter);
            return;
          }
        }
      }
      closeSlashMenu();
      return;
    }
    // Detect "/" typed on empty-ish line
    if (e.inputType === 'insertText' && e.data === '/') {
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      const node = sel.anchorNode;
      if (node && node.nodeType === 3) {
        const text = node.textContent.trim();
        if (text === '/') showSlashMenu();
      }
    }
  });

  _slashKeyHandler = (e) => {
    const menu = $('slashMenu');
    if (!menu || !menu.classList.contains('open')) return;
    const items = menu.querySelectorAll('.slash-menu-item');
    if (!items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); _slashIdx = (_slashIdx + 1) % items.length; highlightSlashItem(menu); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); _slashIdx = (_slashIdx - 1 + items.length) % items.length; highlightSlashItem(menu); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const activeItem = items[_slashIdx];
      if (activeItem) pickSlash(parseInt(activeItem.dataset.abs));
    }
    else if (e.key === 'Escape') { e.preventDefault(); closeSlashMenu(); }
  };
  body.addEventListener('keydown', _slashKeyHandler);

  // Close on click outside
  document.addEventListener('mousedown', (e) => {
    const menu = $('slashMenu');
    if (menu && menu.classList.contains('open') && !menu.contains(e.target) && !e.target.closest('.block-plus-btn')) closeSlashMenu();
  }, { once: false });

  // ── "+" button on empty lines ──
  setupBlockPlusBtn(body);
}

let delPath = '';
let delTitle = '';
function showDel() { delPath = state.artPath; delTitle = ''; $('delConfirmTitle').textContent = ''; $('delConfirm').classList.add('open'); }
// 从侧边栏等处发起删除：显式传入 path（当前不一定就是这篇）
export function requestDelArticle(path, title) {
  if (!path) return;
  delPath = path;
  delTitle = title || '';
  const tEl = $('delConfirmTitle');
  if (tEl) tEl.textContent = delTitle ? '《' + delTitle + '》' : path;
  $('delConfirm').classList.add('open');
}
export function closeDel() { $('delConfirm').classList.remove('open'); }
export async function doDel() {
  closeDel();
  const path = delPath;
  if (!path) return;
  const isCurrent = path === state.artPath;
  // 当前文章：content 已在内存里，undo 走内存；否则先抓一份，供 undo 恢复
  let savedContent = isCurrent ? state.artMd : null;
  if (!isCurrent) {
    try {
      const res = await api('/api/wiki/article?path=' + encodeURIComponent(path));
      savedContent = res.content || '';
    } catch { savedContent = null; }
  }
  try {
    await apiDel('/api/wiki/article?path=' + encodeURIComponent(path)); state.td = null;
    if (isCurrent) go('#/browse');
    // 不是当前文章：留在原页面，只刷新侧边栏
    const { updSidebarPages } = await import('../sidebar.js');
    updSidebarPages();
    const restore = savedContent == null ? null : async () => {
      try { await put('/api/wiki/article', { path, content: savedContent }); state.td = null; toast('已恢复'); go('#/article/' + path); } catch { toast('恢复失败'); }
    };
    toast('已删除', restore);
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

/* ── Block "+" button on empty lines ── */
let _plusBtn = null;
function setupBlockPlusBtn(body) {
  if (!_plusBtn) {
    _plusBtn = document.createElement('button');
    _plusBtn.className = 'block-plus-btn';
    _plusBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    _plusBtn.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      // Focus the empty line and open menu
      const line = _plusBtn._targetLine;
      if (line) {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(line);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      const rect = _plusBtn.getBoundingClientRect();
      showSlashMenu({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right });
    });
    document.body.appendChild(_plusBtn);
  }

  function isEmptyBlock(el) {
    if (!el || el.nodeType !== 1) return false;
    if (!/^(P|DIV|H[1-6])$/i.test(el.tagName)) return false;
    const text = el.textContent.trim();
    return text === '' || text === '\u200B';
  }

  function updatePlus() {
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) { _plusBtn.classList.remove('show'); return; }
    if (_qaPanel && _qaPanel.classList.contains('open')) { _plusBtn.classList.remove('show'); return; }
    // Find the block-level parent of the cursor
    let node = sel.anchorNode;
    if (node.nodeType === 3) node = node.parentElement;
    while (node && node !== body && !/^(P|DIV|H[1-6])$/i.test(node.tagName)) node = node.parentElement;
    if (!node || node === body || !isEmptyBlock(node)) { _plusBtn.classList.remove('show'); return; }
    // Slash menu already open? hide plus
    const menu = $('slashMenu');
    if (menu && menu.classList.contains('open')) { _plusBtn.classList.remove('show'); return; }
    // Position to the left of the empty block
    const rect = node.getBoundingClientRect();
    _plusBtn.style.top = (rect.top + rect.height / 2 - 14) + 'px';
    _plusBtn.style.left = (rect.left - 32) + 'px';
    _plusBtn._targetLine = node;
    _plusBtn.classList.add('show');
  }

  document.addEventListener('selectionchange', updatePlus);
  body.addEventListener('input', () => setTimeout(updatePlus, 10));
  body.addEventListener('blur', () => setTimeout(() => { if (!document.activeElement || !document.activeElement.closest('.block-plus-btn')) _plusBtn.classList.remove('show'); }, 100));
}

/* ── Link navigation inside contenteditable ── */
function setupLinkNav() {
  const body = $('artBody'); if (!body) return;
  body.addEventListener('click', e => {
    const a = e.target.closest('a'); if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href) return;
    // Internal hash route → navigate
    if (href.startsWith('#/')) { e.preventDefault(); location.hash = href.slice(1); return; }
    // External → open in new tab
    if (/^https?:\/\//.test(href)) { e.preventDefault(); window.open(href, '_blank', 'noopener'); return; }
  });
}

/* ── Image toolbar (resize + alignment) ── */
let _activeImg = null;
let _imgToolbar = null;
let _imgOverlay = null;
let _imgScrollCb = null;

function setupImageToolbar() {
  const body = $('artBody'); if (!body) return;
  body.addEventListener('click', e => {
    if (e.target.tagName === 'IMG') { e.preventDefault(); selectImg(e.target); }
  });
  document.addEventListener('mousedown', e => {
    if (!_activeImg) return;
    if (e.target.tagName === 'IMG' && e.target.closest('#artBody')) return;
    if (e.target.closest('.img-toolbar') || e.target.closest('.img-resize-handle')) return;
    deselectImg();
  });
}

function selectImg(img) {
  if (_activeImg === img) return;
  deselectImg();
  _activeImg = img;
  img.classList.add('img-selected');
  ensureImgToolbar();
  ensureImgOverlay();
  repositionImgUI();
  _imgToolbar.classList.add('show');
  _imgOverlay.classList.add('show');
  syncImgToolbarState();
  const scroller = document.querySelector('.content');
  if (scroller) { _imgScrollCb = () => repositionImgUI(); scroller.addEventListener('scroll', _imgScrollCb, { passive: true }); }
}

export function deselectImg() {
  if (_activeImg) { _activeImg.classList.remove('img-selected'); _activeImg = null; }
  if (_imgToolbar) _imgToolbar.classList.remove('show');
  if (_imgOverlay) _imgOverlay.classList.remove('show');
  const scroller = document.querySelector('.content');
  if (scroller && _imgScrollCb) { scroller.removeEventListener('scroll', _imgScrollCb); _imgScrollCb = null; }
}

function ensureImgToolbar() {
  if (_imgToolbar) return;
  const d = document.createElement('div');
  d.className = 'img-toolbar';
  d.innerHTML =
    '<div class="img-tb-group">' +
      '<button class="img-tb-btn" data-align="left" title="左对齐" onmousedown="event.preventDefault();imgAlign(\'left\')">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/></svg>' +
      '</button>' +
      '<button class="img-tb-btn" data-align="center" title="居中" onmousedown="event.preventDefault();imgAlign(\'center\')">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="10" x2="6" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="18" y1="18" x2="6" y2="18"/></svg>' +
      '</button>' +
      '<button class="img-tb-btn" data-align="right" title="右对齐" onmousedown="event.preventDefault();imgAlign(\'right\')">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="21" y1="10" x2="7" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="7" y2="18"/></svg>' +
      '</button>' +
    '</div>' +
    '<div class="img-tb-sep"></div>' +
    '<div class="img-tb-group">' +
      '<button class="img-tb-btn img-tb-size" data-size="25" onmousedown="event.preventDefault();imgSize(25)">S</button>' +
      '<button class="img-tb-btn img-tb-size" data-size="50" onmousedown="event.preventDefault();imgSize(50)">M</button>' +
      '<button class="img-tb-btn img-tb-size" data-size="75" onmousedown="event.preventDefault();imgSize(75)">L</button>' +
      '<button class="img-tb-btn img-tb-size" data-size="100" onmousedown="event.preventDefault();imgSize(100)">全</button>' +
    '</div>';
  document.body.appendChild(d);
  _imgToolbar = d;
}

function ensureImgOverlay() {
  if (_imgOverlay) return;
  const d = document.createElement('div');
  d.className = 'img-resize-overlay';
  ['nw','ne','sw','se'].forEach(p => {
    const h = document.createElement('div');
    h.className = 'img-resize-handle ' + p;
    h.addEventListener('mousedown', startImgResize);
    d.appendChild(h);
  });
  document.body.appendChild(d);
  _imgOverlay = d;
}

function repositionImgUI() {
  if (!_activeImg) return;
  const r = _activeImg.getBoundingClientRect();
  if (_imgToolbar && _imgToolbar.classList.contains('show')) {
    const tw = _imgToolbar.offsetWidth || 240;
    _imgToolbar.style.top = (r.top - 44) + 'px';
    _imgToolbar.style.left = Math.max(8, r.left + r.width / 2 - tw / 2) + 'px';
  }
  if (_imgOverlay && _imgOverlay.classList.contains('show')) {
    _imgOverlay.style.top = r.top + 'px';
    _imgOverlay.style.left = r.left + 'px';
    _imgOverlay.style.width = r.width + 'px';
    _imgOverlay.style.height = r.height + 'px';
  }
}

function syncImgToolbarState() {
  if (!_imgToolbar || !_activeImg) return;
  const s = _activeImg.style;
  let align = 'left';
  if (s.marginLeft === 'auto' && s.marginRight === 'auto') align = 'center';
  else if (s.marginLeft === 'auto') align = 'right';
  _imgToolbar.querySelectorAll('[data-align]').forEach(b => b.classList.toggle('active', b.dataset.align === align));
  const w = parseInt(s.width) || 100;
  _imgToolbar.querySelectorAll('[data-size]').forEach(b => b.classList.toggle('active', parseInt(b.dataset.size) === w));
}

export function imgAlign(align) {
  if (!_activeImg) return;
  const img = _activeImg;
  if (align === 'center') {
    img.style.display = 'block'; img.style.marginLeft = 'auto'; img.style.marginRight = 'auto';
  } else if (align === 'right') {
    img.style.display = 'block'; img.style.marginLeft = 'auto'; img.style.marginRight = '0';
  } else {
    img.style.display = ''; img.style.marginLeft = ''; img.style.marginRight = '';
    if (img.style.width && img.style.width !== '100%') img.style.display = 'block';
  }
  syncImgToolbarState();
  repositionImgUI();
  onArtChange();
}

export function imgSize(pct) {
  if (!_activeImg) return;
  const img = _activeImg;
  if (pct >= 100) {
    img.style.width = ''; img.style.display = ''; img.style.marginLeft = ''; img.style.marginRight = '';
  } else {
    img.style.width = pct + '%';
    if (!img.style.display) img.style.display = 'block';
  }
  setTimeout(() => { repositionImgUI(); syncImgToolbarState(); }, 20);
  onArtChange();
}

/* Drag-to-resize */
let _rsState = null;
function startImgResize(e) {
  e.preventDefault(); e.stopPropagation();
  if (!_activeImg) return;
  const r = _activeImg.getBoundingClientRect();
  const pos = e.target.classList.contains('nw') ? 'nw' : e.target.classList.contains('ne') ? 'ne' : e.target.classList.contains('sw') ? 'sw' : 'se';
  _rsState = { startX: e.clientX, startW: r.width, pos, parentW: ($('artBody') || _activeImg.parentElement).offsetWidth };
  document.addEventListener('mousemove', onImgResize);
  document.addEventListener('mouseup', endImgResize);
}
function onImgResize(e) {
  if (!_rsState || !_activeImg) return;
  const dx = e.clientX - _rsState.startX;
  const newW = (_rsState.pos === 'se' || _rsState.pos === 'ne') ? _rsState.startW + dx : _rsState.startW - dx;
  const pct = Math.max(10, Math.min(100, Math.round((newW / _rsState.parentW) * 100)));
  _activeImg.style.width = pct + '%';
  if (!_activeImg.style.display) _activeImg.style.display = 'block';
  repositionImgUI(); syncImgToolbarState();
}
function endImgResize() {
  _rsState = null;
  document.removeEventListener('mousemove', onImgResize);
  document.removeEventListener('mouseup', endImgResize);
  onArtChange();
}

/* ── Article Q&A floating panel ── */
let _qaPanel = null;
let _qaFab = null;
const _qaSessions = new Map();
let _qaPath = '';
let _qaModel = '';
let _qaModels = [];

const QA_MAX_SESSIONS = 10;

function _qaSession(p) {
  if (!_qaSessions.has(p)) {
    if (_qaSessions.size >= QA_MAX_SESSIONS) {
      for (const [k, s] of _qaSessions) {
        if (k === _qaPath) continue;
        if (s.abort) s.abort.abort();
        _qaSessions.delete(k);
        break;
      }
    }
    const el = document.createElement('div');
    el.className = 'article-qa-session';
    el.innerHTML = buildEmptyState();
    _qaSessions.set(p, { history: [], el, streaming: false, abort: null });
  }
  return _qaSessions.get(p);
}

function setupArticleQA(articlePath) {
  _qaPath = articlePath;
  const s = _qaSession(articlePath);
  ensureQAPanel();
  ensureQAFab();
  if (!_qaPanel.classList.contains('open')) _qaFab.classList.add('show');
  const msgsEl = _qaPanel.querySelector('.article-qa-messages');
  msgsEl.replaceChildren(s.el);
  const input = _qaPanel.querySelector('.article-qa-input');
  if (input) input.disabled = s.streaming;
  const btn = _qaPanel.querySelector('.article-qa-bottom');
  if (btn) btn.classList.remove('show');
  msgsEl.scrollTop = msgsEl.scrollHeight;
  loadQAModels();
}

function buildEmptyState() {
  return '<div class="article-qa-empty">' +
    '<div class="article-qa-empty-hint">针对当前文章提问</div>' +
    '<div class="article-qa-suggestions">' +
      '<button class="article-qa-chip" onclick="qaChip(this)">总结这篇文章的核心观点</button>' +
      '<button class="article-qa-chip" onclick="qaChip(this)">有哪些关键概念？</button>' +
      '<button class="article-qa-chip" onclick="qaChip(this)">这篇文章的实践建议是什么？</button>' +
    '</div>' +
  '</div>';
}

async function loadQAModels() {
  if (_qaModels.length) { renderModelSelect(); return; }
  try {
    const cfg = await api('/api/settings');
    const provKey = cfg.provider || 'bailian';
    const prov = cfg.providers && cfg.providers[provKey];
    if (prov && prov.models) {
      _qaModels = prov.models.map(m => ({ id: m.id, label: m.label || m.id }));
      const fast = prov.models.find(m => m.use === 'fast');
      _qaModel = fast ? fast.id : (cfg.model || prov.models[0].id);
    }
    renderModelSelect();
  } catch {}
}

function renderModelSelect() {
  if (!_qaPanel || !_qaModels.length) return;
  const label = _qaPanel.querySelector('.article-qa-model-label');
  const dd = _qaPanel.querySelector('.article-qa-model-dd');
  if (!label || !dd) return;
  const cur = _qaModels.find(m => m.id === _qaModel) || _qaModels[0];
  label.textContent = cur.label;
  dd.innerHTML = _qaModels.map(m =>
    '<div class="article-qa-model-opt' + (m.id === _qaModel ? ' active' : '') + '" onclick="qaModelPick(\'' + jsAttr(m.id) + '\')">' + h(m.label) + '</div>'
  ).join('');
}

export function toggleQAModelDD() {
  const dd = _qaPanel && _qaPanel.querySelector('.article-qa-model-dd');
  if (dd) dd.classList.toggle('open');
}

export function qaModelPick(id) {
  _qaModel = id;
  renderModelSelect();
  const dd = _qaPanel && _qaPanel.querySelector('.article-qa-model-dd');
  if (dd) dd.classList.remove('open');
}

const QA_FAB_KEY = 'qa.fab.pos';
const QA_SIZE_KEY = 'qa.panel.size';
const QA_PANEL_KEY = 'qa.panel.pos';

function _positionPanel() {
  if (!_qaPanel) return;
  const pw = _qaPanel.offsetWidth, ph = _qaPanel.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let x, y, used = false;
  try {
    const s = localStorage.getItem(QA_PANEL_KEY);
    if (s) { const p = JSON.parse(s); x = p.x; y = p.y; used = true; }
  } catch {}
  if (!used && _qaFab) {
    const fab = _qaFab.getBoundingClientRect();
    const cx = fab.left + fab.width / 2, cy = fab.top + fab.height / 2;
    x = cx > vw / 2 ? fab.left - pw - 12 : fab.right + 12;
    y = cy > vh / 2 ? fab.bottom - ph : fab.top;
  }
  x = Math.max(8, Math.min(vw - pw - 8, x || 0));
  y = Math.max(8, Math.min(vh - ph - 8, y || 0));
  _qaPanel.style.left = x + 'px'; _qaPanel.style.top = y + 'px';
  _qaPanel.style.right = 'auto'; _qaPanel.style.bottom = 'auto';
}

function ensureQAFab() {
  if (_qaFab) return;
  const btn = document.createElement('button');
  btn.className = 'article-qa-fab';
  btn.title = '提问';
  btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>';
  document.body.appendChild(btn);
  _qaFab = btn;

  try {
    const s = localStorage.getItem(QA_FAB_KEY);
    if (s) { const p = JSON.parse(s); btn.style.right = 'auto'; btn.style.bottom = 'auto'; btn.style.left = p.x + 'px'; btn.style.top = p.y + 'px'; }
  } catch {}

  let sx, sy, ex, ey, dragged;
  btn.addEventListener('mousedown', e => {
    e.preventDefault();
    sx = e.clientX; sy = e.clientY;
    const r = btn.getBoundingClientRect(); ex = r.left; ey = r.top;
    dragged = false;
    const onMove = ev => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!dragged && Math.abs(dx) + Math.abs(dy) < 4) return;
      dragged = true;
      btn.style.right = 'auto'; btn.style.bottom = 'auto';
      btn.style.left = (ex + dx) + 'px'; btn.style.top = (ey + dy) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (dragged) {
        const vw = window.innerWidth, vh = window.innerHeight, r = btn.getBoundingClientRect();
        btn.style.left = Math.max(0, Math.min(vw - r.width, r.left)) + 'px';
        btn.style.top = Math.max(0, Math.min(vh - r.height, r.top)) + 'px';
        localStorage.setItem(QA_FAB_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
      } else {
        toggleQAPanel();
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function ensureQAPanel() {
  if (_qaPanel) return;
  const panel = document.createElement('div');
  panel.className = 'article-qa-panel';
  panel.innerHTML =
    '<div class="article-qa-resize"></div>' +
    '<div class="article-qa-head">' +
      '<span class="article-qa-title">文章提问</span>' +
      '<div class="article-qa-model-wrap">' +
        '<span class="article-qa-model-tag" onclick="toggleQAModelDD()">' +
          '<span class="article-qa-model-label"></span>' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>' +
        '</span>' +
        '<div class="article-qa-model-dd"></div>' +
      '</div>' +
      '<button class="article-qa-close" onclick="closeArticleQA()">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
      '</button>' +
    '</div>' +
    '<div class="article-qa-messages"></div>' +
    '<div class="article-qa-input-wrap">' +
      '<input class="article-qa-input" type="text" placeholder="输入问题，回车发送..." />' +
      '<button class="article-qa-send" onclick="sendArticleQA()">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' +
      '</button>' +
    '</div>';
  document.body.appendChild(panel);
  _qaPanel = panel;

  try {
    const sz = JSON.parse(localStorage.getItem(QA_SIZE_KEY));
    if (sz) { panel.style.width = sz.w + 'px'; panel.style.height = sz.h + 'px'; }
  } catch {}

  const input = panel.querySelector('.article-qa-input');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendArticleQA();
    }
  });

  const head = panel.querySelector('.article-qa-head');
  let hsx, hsy, hex, hey, hdragged;
  head.addEventListener('mousedown', e => {
    if (e.target.closest('button, .article-qa-model-tag, .article-qa-model-dd')) return;
    e.preventDefault();
    hsx = e.clientX; hsy = e.clientY;
    const r = panel.getBoundingClientRect(); hex = r.left; hey = r.top;
    hdragged = false;
    const onMove = ev => {
      const dx = ev.clientX - hsx, dy = ev.clientY - hsy;
      if (!hdragged && Math.abs(dx) + Math.abs(dy) < 4) return;
      hdragged = true;
      const vw = window.innerWidth, vh = window.innerHeight;
      const nx = Math.max(0, Math.min(vw - panel.offsetWidth, hex + dx));
      const ny = Math.max(0, Math.min(vh - panel.offsetHeight, hey + dy));
      panel.style.left = nx + 'px'; panel.style.top = ny + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (hdragged) {
        const r = panel.getBoundingClientRect();
        localStorage.setItem(QA_PANEL_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  const rh = panel.querySelector('.article-qa-resize');
  let rStartX, rStartY, rStartW, rStartH, rStartLeft, rStartTop;
  rh.addEventListener('mousedown', e => {
    e.preventDefault();
    rStartX = e.clientX; rStartY = e.clientY;
    rStartW = panel.offsetWidth; rStartH = panel.offsetHeight;
    const rect = panel.getBoundingClientRect();
    rStartLeft = rect.right; rStartTop = rect.bottom;
    const onMove = ev => {
      const w = Math.max(320, Math.min(rStartLeft, rStartW - (ev.clientX - rStartX)));
      const h = Math.max(360, Math.min(rStartTop, rStartH - (ev.clientY - rStartY)));
      panel.style.width = w + 'px'; panel.style.height = h + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      panel.style.left = (rStartLeft - w) + 'px'; panel.style.top = (rStartTop - h) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      localStorage.setItem(QA_SIZE_KEY, JSON.stringify({ w: panel.offsetWidth, h: panel.offsetHeight }));
      const pr = panel.getBoundingClientRect();
      localStorage.setItem(QA_PANEL_KEY, JSON.stringify({ x: Math.round(pr.left), y: Math.round(pr.top) }));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

export function toggleQAPanel() {
  ensureQAPanel();
  const opening = !_qaPanel.classList.contains('open');
  _qaPanel.classList.toggle('open');
  if (opening) {
    _positionPanel();
    _qaFab.classList.remove('show');
    setTimeout(() => _qaPanel.querySelector('.article-qa-input').focus(), 100);
  } else {
    _qaFab.classList.add('show');
  }
}

export function closeArticleQA() {
  if (_qaPanel) _qaPanel.classList.remove('open');
  if (_qaFab) _qaFab.classList.add('show');
  if (_plusBtn) _plusBtn.classList.remove('show');
}

export function hideArticleQA() {
  if (_qaFab) _qaFab.classList.remove('show');
  if (_qaPanel) _qaPanel.classList.remove('open');
}

export function qaChip(btn) {
  const sess = _qaSession(_qaPath);
  if (sess.streaming) return;
  const input = _qaPanel.querySelector('.article-qa-input');
  input.value = btn.textContent;
  sendArticleQA();
}

export async function sendArticleQA() {
  const sess = _qaSession(_qaPath);
  if (sess.streaming) return;
  const sentPath = _qaPath;
  const input = _qaPanel.querySelector('.article-qa-input');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';

  const container = sess.el;
  const empty = container.querySelector('.article-qa-empty');
  if (empty) empty.remove();

  const userDiv = document.createElement('div');
  userDiv.className = 'article-qa-msg user';
  userDiv.innerHTML = '<div class="article-qa-msg-body">' + h(q).replace(/\n/g, '<br>') + '</div>';
  container.appendChild(userDiv);

  const aiDiv = document.createElement('div');
  aiDiv.className = 'article-qa-msg assistant';
  aiDiv.innerHTML = '<div class="article-qa-avatar">AI</div><div class="article-qa-msg-body"><div class="article-qa-loading"><span></span><span></span><span></span></div></div>';
  container.appendChild(aiDiv);

  const msgsEl = _qaPanel.querySelector('.article-qa-messages');
  const isVisible = () => _qaPath === sentPath;
  if (isVisible()) msgsEl.scrollTop = msgsEl.scrollHeight;

  let _userScrolledUp = false;
  const _nearBottom = () => msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 40;
  const _scrollIfPinned = () => { if (!_userScrolledUp && isVisible()) msgsEl.scrollTop = msgsEl.scrollHeight; };
  let _bottomBtn = _qaPanel.querySelector('.article-qa-bottom');
  if (!_bottomBtn) {
    _bottomBtn = document.createElement('button');
    _bottomBtn.className = 'article-qa-bottom';
    _bottomBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
    _bottomBtn.addEventListener('click', () => { _userScrolledUp = false; msgsEl.scrollTop = msgsEl.scrollHeight; });
    msgsEl.parentElement.appendChild(_bottomBtn);
  }
  const _onScroll = () => {
    if (!isVisible()) return;
    _userScrolledUp = !_nearBottom();
    _bottomBtn.classList.toggle('show', _userScrolledUp);
  };
  msgsEl.addEventListener('scroll', _onScroll);

  sess.history.push({ role: 'user', content: q });
  sess.streaming = true;
  sess.abort = new AbortController();
  input.disabled = true;

  const aiBody = aiDiv.querySelector('.article-qa-msg-body');
  let full = '';

  try {
    const reqBody = { path: sentPath, question: q, history: sess.history.slice(-11, -1) };
    if (_qaModel) reqBody.model = _qaModel;

    const resp = await fetch('/api/wiki/article-ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
      signal: sess.abort.signal
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || '请求失败');
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let reasoning = '';
    let thinkEl = null;
    let cleared = false;
    const clearLoading = () => { if (!cleared) { cleared = true; aiBody.textContent = ''; } };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload);
          if (obj.error) throw new Error(obj.error);
          if (obj.r) {
            reasoning += obj.r;
            if (!thinkEl) {
              clearLoading();
              aiBody.innerHTML = '<div class="article-qa-thinking-label">思考中</div><div class="article-qa-thinking"></div>';
              thinkEl = aiBody.querySelector('.article-qa-thinking');
            }
            thinkEl.textContent = reasoning;
            thinkEl.scrollTop = thinkEl.scrollHeight;
            _scrollIfPinned();
          }
          if (obj.t) {
            clearLoading();
            if (thinkEl && !full) {
              const details = document.createElement('details');
              details.className = 'article-qa-thinking-wrap';
              details.innerHTML = '<summary class="article-qa-thinking-label">思考过程</summary><div class="article-qa-thinking">' + h(reasoning) + '</div>';
              aiBody.innerHTML = '';
              aiBody.appendChild(details);
            }
            full += obj.t;
            const contentEl = thinkEl ? (aiBody.querySelector('.article-qa-content') || (() => { const d = document.createElement('div'); d.className = 'article-qa-content'; aiBody.appendChild(d); return d; })()) : aiBody;
            contentEl.innerHTML = fmtChat(full);
            _scrollIfPinned();
          }
        } catch (e) {
          if (e.message && e.message !== 'Unexpected end of JSON input') throw e;
        }
      }
    }

    if (!full && !reasoning) aiBody.textContent = '(无回复)';
    if (!full && reasoning) {
      aiBody.innerHTML = '<div class="article-qa-thinking-label">思考完成，未生成回复</div>';
    }
    sess.history.push({ role: 'assistant', content: full });
  } catch (e) {
    if (e.name === 'AbortError') return;
    aiBody.textContent = '出错: ' + (e.message || '未知错误');
  }

  sess.abort = null;
  sess.streaming = false;
  if (isVisible()) {
    input.disabled = false;
    input.focus();
    _scrollIfPinned();
    if (_nearBottom()) _bottomBtn.classList.remove('show');
  }
  msgsEl.removeEventListener('scroll', _onScroll);
}
