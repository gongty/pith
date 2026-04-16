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
    initTocSpy();
    setupSlashMenu();
    setupImageToolbar();
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
  const fullMd = (title ? '# ' + title + '\n\n' : '') + bodyMd;
  try {
    await put('/api/wiki/article', { path: state.artPath, content: fullMd });
    state.artMd = fullMd; state.td = null;
    if (ind) { ind.textContent = '已保存'; setTimeout(() => ind.classList.remove('show'), 2000); }
  } catch { if (ind) { ind.textContent = '保存失败'; ind.style.color = 'var(--red)'; } }
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
  { icon: '💡', label: '高亮块', cat: 'block', insert: () => insertHtmlBlock('<blockquote><p><strong>提示：</strong>内容</p></blockquote>') },
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
