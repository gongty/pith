/* Utility functions */
import { t } from './i18n.js';

export const $ = id => document.getElementById(id);
export const h = s => s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '';
export const hRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Safe encoder for strings that get dropped into an inline `onclick="foo('...')"`
// handler. The host is a double-quoted HTML attribute whose value is
// HTML-decoded *before* the JS parser runs, so entity-encoding `'` as
// `&#39;` is not enough — it decodes back to `'` and terminates the JS
// string literal (classic cause of "links do nothing" when titles/paths
// contain apostrophes, e.g. `amazon's-...md`). We emit JS-level Unicode
// escapes instead; they survive HTML decoding and stay inert inside a JS
// string. See the same pattern in pages/autotask.js (escapeAttr).
export const jsAttr = s => String(s || '')
  .replace(/\\/g, '\\\\')
  .replace(/'/g, '\\u0027')
  .replace(/"/g, '\\u0022')
  .replace(/</g, '\\u003C')
  .replace(/>/g, '\\u003E')
  .replace(/&/g, '\\u0026')
  .replace(/\r/g, '\\u000D')
  .replace(/\n/g, '\\u000A')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

export function relTime(d) {
  if (!d) return '';
  const now = new Date(), then = new Date(d), diff = Math.floor((now - then) / 1000);
  if (diff < 60) return t('time.justNow');
  if (diff < 3600) return t('time.minAgo', {n: Math.floor(diff / 60)});
  if (diff < 86400) return t('time.hrAgo', {n: Math.floor(diff / 3600)});
  if (diff < 604800) return t('time.dayAgo', {n: Math.floor(diff / 86400)});
  return d.slice(5);
}

let phIdx = 0;
export function rotatePH(id) {
  const el = $(id);
  if (!el || el.value) return;
  const phs = [t('ph.ask1'), t('ph.ask2'), t('ph.ask3'), t('ph.ask4')];
  el.placeholder = phs[phIdx % phs.length];
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

export async function api(p, o) {
  const r = await fetch(p, o);
  if (r.status === 401) {
    // 未登录或 token 过期：跳登录页（登录页自身不会触发递归，静态资源直达）
    if (typeof location !== 'undefined' && location.pathname !== '/login.html') {
      location.href = '/login.html';
    }
    throw new Error('401');
  }
  if (!r.ok) throw new Error('' + r.status);
  return r.json();
}
export async function post(p, b) { return api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); }
export async function put(p, b) { return api(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); }
export async function apiDel(p) { return api(p, { method: 'DELETE' }); }

let undoTimer = null;
export function toast(m, undoFn) {
  const te = $('toast');
  te.innerHTML = h(m) + (undoFn ? '<span class="toast-undo" id="toastUndo">' + t('common.undo') + '</span>' : '');
  te.classList.add('show');
  if (undoFn) { const btn = $('toastUndo'); if (btn) btn.onclick = () => { undoFn(); te.classList.remove('show'); }; }
  clearTimeout(undoTimer); undoTimer = setTimeout(() => te.classList.remove('show'), undoFn ? 6000 : 2500);
}

export function go(hash) { location.hash = hash; }

export function skelLines(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += '<div class="skel skel-line" style="width:' + ((40 + Math.random() * 50) | 0) + '%"></div>';
  return '<div class="skel skel-title"></div>' + s;
}

const READ_KEY = 'kb-read-articles';
function _readSet() {
  try { return new Set(JSON.parse(localStorage.getItem(READ_KEY) || '[]')); } catch { return new Set(); }
}
export function markRead(path) {
  const s = _readSet(); s.add(path);
  localStorage.setItem(READ_KEY, JSON.stringify([...s]));
}
export function isUnread(path) {
  if (localStorage.getItem(READ_KEY) === null) return false;
  return !_readSet().has(path);
}
export function markAllRead(paths) {
  const s = _readSet();
  paths.forEach(p => s.add(p));
  localStorage.setItem(READ_KEY, JSON.stringify([...s]));
}
export function initReadState(paths) {
  if (localStorage.getItem(READ_KEY) !== null) return;
  localStorage.setItem(READ_KEY, JSON.stringify(paths));
}
