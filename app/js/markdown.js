import { h } from './utils.js';

/* ── YAML Frontmatter Parser ──
 * 支持极简 YAML：仅处理 `key: value` 和 `tags: [a, b, c]` 单行数组。
 * 幂等：若 md 不以 `---\n` 开头或前 ~10 行内未找到闭合 `---`，原样返回 body。
 */
export function parseFrontmatter(md) {
  if (typeof md !== 'string' || !md.startsWith('---\n')) return { data: {}, body: md || '' };
  const lines = md.split('\n');
  // 找闭合 --- (仅在前 10 行内查找，避免误伤正文分割线或代码块中的 ---)
  let end = -1;
  const MAX_SCAN = Math.min(lines.length, 12);
  for (let i = 1; i < MAX_SCAN; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return { data: {}, body: md };
  const fmLines = lines.slice(1, end);
  const data = {};
  for (const raw of fmLines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    // 数组语法: [a, b, c]
    const arrM = val.match(/^\[(.*)\]$/);
    if (arrM) {
      const inner = arrM[1].trim();
      if (!inner) { data[key] = []; continue; }
      data[key] = inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    } else {
      // 去掉两端引号
      val = val.replace(/^['"]|['"]$/g, '');
      data[key] = val;
    }
  }
  const body = lines.slice(end + 1).join('\n');
  return { data, body };
}

/* ── Markdown Renderer ── */
export function renderMd(md, ap) {
  // 先剥离 frontmatter，避免 YAML 块被当成正文渲染
  const fm = parseFrontmatter(md || '');
  md = fm.body;
  const lines = md.split('\n'); let html = '', inCode = false, cLines = [];
  let inList = false, lt = '', inBq = false, bqL = [], inTbl = false, tRows = [];
  const aDir = ap ? ap.split('/').slice(0, -1).join('/') : '';
  function resLink(href) {
    if (/^https?:\/\//.test(href)) return href;
    if (href.startsWith('#/article/')) return href;
    if (!href.endsWith('.md')) return href;
    if (href.startsWith('../../raw/')) return '#/raw/' + href.slice('../../raw/'.length);
    if (href.startsWith('../raw/')) return '#/raw/' + href.slice('../raw/'.length);
    if (href.startsWith('raw/')) return '#/raw/' + href.slice(4);
    const rawIdx = href.indexOf('/raw/');
    if (rawIdx >= 0) return '#/raw/' + href.slice(rawIdx + 5);
    let r = href;
    if (href.startsWith('../') || href.startsWith('./')) {
      const b = aDir ? aDir.split('/') : []; const p = href.split('/'); const c = [...b];
      for (const x of p) { if (x === '..') c.pop(); else if (x !== '.') c.push(x); }
      r = c.join('/');
    } else if (href.includes('/')) {
      r = href;
    } else if (aDir) {
      r = aDir + '/' + href;
    }
    return '#/article/' + r;
  }
  function inl(t) {
    t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, src) => {
      const trimmed = (src || '').trim();
      // 占位符 / 空 src 直接不渲染（LLM 偶尔写出 images/xxx 这类假路径）
      if (!trimmed) return '';
      const fname = trimmed.split('/').pop() || '';
      if (/^(x{2,}|example|placeholder|your[-_]?image|filename|image[-_]?url|todo|tbd)(\.[a-z0-9]+)?$/i.test(fname)) return '';
      // 真图加 onerror：404 时整张图自隐藏，避免显示 "alt=图片" 破图占位
      return '<img src="' + trimmed + '" alt="' + alt + '" onerror="this.style.display=\'none\'">';
    });
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, l, u) => { const r = resLink(u); const ext = /^https?:/.test(r); return '<a href="' + h(r) + '"' + (ext ? ' target="_blank"' : '') + '>' + h(l) + '</a>'; });
    t = t.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    return t;
  }
  function fBq() { if (bqL.length) { html += '<blockquote>' + bqL.map(l => '<p>' + inl(l) + '</p>').join('') + '</blockquote>'; bqL = []; } inBq = false; }
  function fTbl() { if (tRows.length >= 2) { html += '<div class="table-wrap"><table><thead><tr>' + tRows[0].map(c => '<th>' + inl(c.trim()) + '</th>').join('') + '</tr></thead><tbody>'; for (let i = 2; i < tRows.length; i++) html += '<tr>' + tRows[i].map(c => '<td>' + inl(c.trim()) + '</td>').join('') + '</tr>'; html += '</tbody></table></div>'; } tRows = []; inTbl = false; }
  function fList() { if (inList) { html += lt === 'ol' ? '</ol>' : '</ul>'; inList = false; } }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      if (inCode) { html += '<pre><code>' + h(cLines.join('\n')) + '</code></pre>'; inCode = false; cLines = []; continue; }
      else { fBq(); fTbl(); fList(); inCode = true; continue; }
    }
    if (inCode) { cLines.push(line); continue; }
    if (/^\|(.+)\|$/.test(line.trim())) { fBq(); fList(); tRows.push(line.trim().slice(1, -1).split('|')); inTbl = true; continue; }
    else if (inTbl) fTbl();
    if (/^>\s?/.test(line)) { fList(); fTbl(); bqL.push(line.replace(/^>\s?/, '')); inBq = true; continue; }
    else if (inBq) fBq();
    const hm = line.match(/^(#{1,4})\s+(.+)/);
    if (hm) { fList(); fTbl(); fBq(); html += '<h' + hm[1].length + '>' + inl(hm[2].trim()) + '</h' + hm[1].length + '>'; continue; }
    if (/^---+$/.test(line.trim())) { fList(); fTbl(); fBq(); html += '<hr>'; continue; }
    if (/^\s*[-*+]\s+/.test(line)) { fTbl(); fBq(); if (!inList || lt !== 'ul') { fList(); html += '<ul>'; inList = true; lt = 'ul'; } html += '<li>' + inl(line.replace(/^\s*[-*+]\s+/, '')) + '</li>'; continue; }
    if (/^\s*\d+\.\s+/.test(line)) { fTbl(); fBq(); if (!inList || lt !== 'ol') { fList(); html += '<ol>'; inList = true; lt = 'ol'; } html += '<li>' + inl(line.replace(/^\s*\d+\.\s+/, '')) + '</li>'; continue; }
    if (inList && !line.trim()) fList();
    if (!line.trim()) continue;
    fList(); fTbl(); fBq();
    if (/^\s*<img\s/.test(line)) { html += line; continue; }
    html += '<p>' + inl(line) + '</p>';
  }
  if (inCode) html += '<pre><code>' + h(cLines.join('\n')) + '</code></pre>';
  fList(); fTbl(); fBq();
  return html;
}

/* ── Chat message formatter ── */
export function fmtChat(t) {
  if (!t) return '';
  let s = t;
  s = s.replace(/```[\s\S]*?```/g, m => { const c = m.replace(/```\w*\n?/, '').replace(/\n?```$/, ''); return '<pre><code>' + h(c) + '</code></pre>'; });
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, l, u) => {
    if (/^https?:/.test(u)) return '<a href="' + h(u) + '" target="_blank">' + h(l) + '</a>';
    if (u.endsWith('.md')) { const p = u.replace(/^(\.\.\/)+/, ''); return '<a href="#/article/' + h(p) + '">' + h(l) + '</a>'; }
    return '<a href="' + h(u) + '">' + h(l) + '</a>';
  });
  s = s.replace(/\n/g, '<br>');
  return s;
}

/* ── HTML to Markdown ── */
export function html2md(html) { const div = document.createElement('div'); div.innerHTML = html; return node2md(div).trim(); }

function node2md(node) {
  let md = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) { md += child.textContent; continue; }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName;
    if (tag === 'BR') { md += '\n'; continue; }
    if (tag === 'P') { md += '\n\n' + node2md(child); continue; }
    if (tag === 'DIV') { md += '\n' + node2md(child); continue; }
    if (/^H[1-6]$/.test(tag)) { const lvl = tag[1]; md += '\n\n' + '#'.repeat(+lvl) + ' ' + child.innerText; continue; }
    if (tag === 'STRONG' || tag === 'B') { md += '**' + node2md(child) + '**'; continue; }
    if (tag === 'EM' || tag === 'I') { md += '*' + node2md(child) + '*'; continue; }
    if (tag === 'CODE') { if (child.parentElement && child.parentElement.tagName === 'PRE') continue; md += '`' + child.textContent + '`'; continue; }
    if (tag === 'PRE') { const code = child.querySelector('code'); md += '\n\n```\n' + (code ? code.textContent : child.textContent) + '\n```'; continue; }
    if (tag === 'A') { const href = child.getAttribute('href') || ''; md += '[' + child.innerText + '](' + href + ')'; continue; }
    if (tag === 'IMG') {
      const src = child.getAttribute('src') || child.src;
      const alt = child.getAttribute('alt') || '';
      const style = child.getAttribute('style') || '';
      if (style) { md += '\n\n<img src="' + src + '" alt="' + alt + '" style="' + style + '">'; }
      else { md += '![' + alt + '](' + src + ')'; }
      continue;
    }
    if (tag === 'BLOCKQUOTE') { const lines = node2md(child).split('\n'); md += '\n\n' + lines.map(l => '> ' + l).join('\n'); continue; }
    if (tag === 'UL') { for (const li of child.children) { if (li.tagName === 'LI') md += '\n- ' + node2md(li); } md += '\n'; continue; }
    if (tag === 'OL') { let n = 1; for (const li of child.children) { if (li.tagName === 'LI') { md += '\n' + n + '. ' + node2md(li); n++; } } md += '\n'; continue; }
    if (tag === 'HR') { md += '\n\n---'; continue; }
    if (tag === 'TABLE') { md += '\n\n' + table2md(child); continue; }
    md += node2md(child);
  }
  return md;
}

function table2md(table) {
  const rows = []; table.querySelectorAll('tr').forEach(tr => {
    const cells = []; tr.querySelectorAll('th,td').forEach(c => cells.push(c.innerText.trim())); rows.push(cells);
  });
  if (!rows.length) return '';
  let md = '| ' + rows[0].join(' | ') + ' |\n| ' + rows[0].map(() => '---').join(' | ') + ' |';
  for (let i = 1; i < rows.length; i++) md += '\n| ' + rows[i].join(' | ') + ' |';
  return md;
}

/* ── Table column resize ── */
export function initTableResize(root) {
  if (!root) return;
  root.querySelectorAll('.table-wrap').forEach(wrap => {
    const table = wrap.querySelector('table');
    if (!table || table.__resizeInit) return;
    table.__resizeInit = true;
    table.style.tableLayout = 'fixed';
    wrap.style.position = 'relative';
    const ths = table.querySelectorAll('thead th');
    if (!ths.length) return;
    ths.forEach(th => { th.style.width = th.offsetWidth + 'px'; });

    const handles = [];
    const updateAllPos = () => {
      handles.forEach((hd, hi) => {
        let left = 0;
        for (let j = 0; j <= hi; j++) left += ths[j].offsetWidth;
        hd.style.left = (left - 3) + 'px';
        hd.style.height = table.offsetHeight + 'px';
      });
    };

    ths.forEach((th, i) => {
      if (i === ths.length - 1) return;
      const handle = document.createElement('div');
      handle.className = 'col-resize-handle';
      wrap.appendChild(handle);
      handles.push(handle);

      handle.addEventListener('mousedown', e => {
        e.preventDefault(); e.stopPropagation();
        const startX = e.clientX;
        const startW = th.offsetWidth;
        const nextTh = ths[i + 1];
        const nextW = nextTh.offsetWidth;
        handle.classList.add('active');
        const onMove = ev => {
          const dx = ev.clientX - startX;
          th.style.width = Math.max(40, startW + dx) + 'px';
          nextTh.style.width = Math.max(40, nextW - dx) + 'px';
          updateAllPos();
        };
        const onUp = () => {
          handle.classList.remove('active');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
    updateAllPos();
  });
}
