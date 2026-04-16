/* Utility functions */

export const $ = id => document.getElementById(id);
export const h = s => s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '';
export const hRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function relTime(d) {
  if (!d) return '';
  const now = new Date(), then = new Date(d), diff = Math.floor((now - then) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
  if (diff < 604800) return Math.floor(diff / 86400) + '天前';
  return d.slice(5);
}

export const placeholders = ['输入问题...', '问问知识库的内容', '有什么想了解的？', '试试「总结最近的文章」'];
let phIdx = 0;
export function rotatePH(id) {
  const el = $(id);
  if (!el || el.value) return;
  el.placeholder = placeholders[phIdx % placeholders.length];
  phIdx++;
}

export function typeEffect(el, html, cb) {
  const tmp = document.createElement('div'); tmp.innerHTML = html; const text = tmp.textContent;
  let i = 0; const cursor = document.createElement('span'); cursor.className = 'typing-cursor';
  el.innerHTML = ''; el.appendChild(cursor);
  const step = () => {
    if (i >= text.length) { cursor.remove(); el.innerHTML = html; if (cb) cb(); return; }
    cursor.before(document.createTextNode(text[i])); i++;
    const delay = text[i - 1] === '\n' ? 40 : Math.random() * 20 + 10;
    setTimeout(step, delay);
  };
  step();
}

export async function api(p, o) { const r = await fetch(p, o); if (!r.ok) throw new Error('' + r.status); return r.json(); }
export async function post(p, b) { return api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); }
export async function put(p, b) { return api(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); }
export async function apiDel(p) { return api(p, { method: 'DELETE' }); }

let undoTimer = null;
export function toast(m, undoFn) {
  const t = $('toast');
  t.innerHTML = h(m) + (undoFn ? '<span class="toast-undo" id="toastUndo">撤销</span>' : '');
  t.classList.add('show');
  if (undoFn) { const btn = $('toastUndo'); if (btn) btn.onclick = () => { undoFn(); t.classList.remove('show'); }; }
  clearTimeout(undoTimer); undoTimer = setTimeout(() => t.classList.remove('show'), undoFn ? 6000 : 2500);
}

export function go(hash) { location.hash = hash; }

export function skelLines(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += '<div class="skel skel-line" style="width:' + ((40 + Math.random() * 50) | 0) + '%"></div>';
  return '<div class="skel skel-title"></div>' + s;
}
