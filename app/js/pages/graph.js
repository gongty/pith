import { $, h, api, go } from '../utils.js';
import state from '../state.js';

const TC = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#14b8a6', '#6366f1'];
const ACCENT = '#5B5BD6';

export function cancelGA() { if (state.gaf) { cancelAnimationFrame(state.gaf); state.gaf = null; } }

/* ── Close keyword panel ── */
function closeKwPanel() {
  const p = document.getElementById('kwPanel');
  if (p) p.remove();
}

/* ── Show keyword detail panel ── */
function showKwPanel(node) {
  closeKwPanel();
  const wrap = document.getElementById('fgWrap');
  if (!wrap) return;
  let s = '<div class="kw-panel" id="kwPanel">';
  s += '<div class="kw-panel-head"><span class="kw-panel-title">' + h(node.label) + '</span>';
  s += '<button class="kw-panel-close" id="kwPanelClose">&times;</button></div>';
  s += '<div class="kw-panel-count">出现在 ' + node.articles.length + ' 篇文章</div>';
  s += '<div class="kw-panel-list">';
  for (const a of node.articles) {
    const name = a.split('/').pop().replace('.md', '');
    s += '<a class="kw-panel-item" href="#/article/' + h(a) + '">' + h(name) + '<span class="kw-panel-path">' + h(a) + '</span></a>';
  }
  s += '</div></div>';
  wrap.insertAdjacentHTML('beforeend', s);
  document.getElementById('kwPanelClose').onclick = closeKwPanel;
  // Close on click outside panel or Esc
  setTimeout(() => {
    const handler = e => {
      const panel = document.getElementById('kwPanel');
      if (!panel) { document.removeEventListener('mousedown', handler); return; }
      if (!panel.contains(e.target)) { closeKwPanel(); document.removeEventListener('mousedown', handler); }
    };
    document.addEventListener('mousedown', handler);
  }, 50);
}

/* ── Main render ── */
export async function rGraph(c) {
  c.innerHTML = '<div style="padding:60px;text-align:center;color:var(--fg-tertiary)">加载中...</div>';
  const mode = state.graphMode || 'keyword';
  try {
    let data;
    if (mode === 'keyword') {
      data = state.gkd || await api('/api/wiki/graph/keywords'); state.gkd = data;
    } else {
      data = state.gd || await api('/api/wiki/graph'); state.gd = data;
    }
    const topics = mode === 'article' ? [...new Set(data.nodes.map(n => n.topic).filter(Boolean))] : [];
    let s = '<div class="page-graph"><div class="graph-toolbar">';
    s += '<button class="graph-toolbar-btn" onclick="gZoom(1.2)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg></button>';
    s += '<button class="graph-toolbar-btn" onclick="gZoom(0.8)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg></button>';
    // View toggle
    s += '<div class="graph-view-toggle">';
    s += '<button class="graph-toggle-btn' + (mode === 'keyword' ? ' active' : '') + '" onclick="switchGraphView(\'keyword\')">关键词</button>';
    s += '<button class="graph-toggle-btn' + (mode === 'article' ? ' active' : '') + '" onclick="switchGraphView(\'article\')">文章</button>';
    s += '</div>';
    // Topic filters (article mode only)
    if (mode === 'article') {
      topics.forEach(t => { s += '<label class="graph-filter-label"><input type="checkbox" checked data-topic="' + h(t) + '" onchange="applyGF()">' + h(t) + '</label>'; });
    }
    s += '<span class="graph-count">' + data.nodes.length + ' 节点</span></div>';
    s += '<div class="graph-canvas-wrap" id="fgWrap">';
    if (data.nodes.length < 2) s += '<div class="graph-empty-msg">需要更多内容</div>';
    else s += '<canvas id="fgCanvas"></canvas>';
    s += '</div></div>';
    c.innerHTML = s;
    if (data.nodes.length >= 2) requestAnimationFrame(() => { const cv = document.getElementById('fgCanvas'); if (cv) initFG(cv, data, true, mode); });
  } catch { c.innerHTML = '<div style="text-align:center;padding:60px;color:var(--fg-tertiary)">加载失败</div>'; }
}

/* ── Force-directed graph (supports both keyword and article mode) ── */
export function initFG(canvas, data, full, mode) {
  cancelGA();
  const isKw = mode === 'keyword';
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr; canvas.height = (full ? rect.height : 220) * dpr;
  canvas.style.width = rect.width + 'px'; canvas.style.height = (full ? rect.height : 220) + 'px';
  ctx.scale(dpr, dpr);
  const W = rect.width, H = full ? rect.height : 220;
  const topics = [...new Set(data.nodes.map(n => n.topic).filter(Boolean))];
  const tcm = {}; topics.forEach((t, i) => tcm[t] = TC[i % TC.length]);
  if (!full && !isKw) {
    const lg = document.getElementById('dgLegend');
    if (lg) lg.innerHTML = topics.map(t => '<span class="graph-footer-item"><span class="graph-footer-dot" style="background:' + tcm[t] + '"></span>' + h(t) + '</span>').join('');
  }
  if (!full && isKw) {
    const lg = document.getElementById('dgLegend');
    if (lg) lg.innerHTML = '<span class="graph-footer-item"><span class="graph-footer-dot" style="background:' + ACCENT + '"></span>关键词概念图</span>';
  }
  const cc = {}; data.nodes.forEach(n => cc[n.id] = 0);
  data.edges.forEach(e => { cc[e.source] = (cc[e.source] || 0) + 1; cc[e.target] = (cc[e.target] || 0) + 1; });
  const nodes = data.nodes.map((n, i) => {
    const a = (i / data.nodes.length) * Math.PI * 2;
    const r = Math.min(W, H) * 0.4;
    let radius, color;
    if (isKw) {
      radius = Math.max(6, Math.min(20, 6 + (n.count - 1) * 3));
      // Accent color with slight variation based on index
      const hueShift = (i * 17) % 40 - 20;
      color = hslAccent(hueShift, n.count);
    } else {
      radius = Math.max(4, Math.min(14, 4 + (cc[n.id] || 0) * 2));
      color = tcm[n.topic] || '#94a3b8';
    }
    return { ...n, x: W / 2 + Math.cos(a) * r * (0.6 + Math.random() * 0.4), y: H / 2 + Math.sin(a) * r * (0.6 + Math.random() * 0.4), vx: 0, vy: 0, radius, color };
  });
  const nm = {}; nodes.forEach(n => nm[n.id] = n);
  const edges = data.edges.filter(e => nm[e.source] && nm[e.target]).map(e => ({
    source: nm[e.source], target: nm[e.target], weight: e.weight || 1
  }));
  let zoom = 1, px = 0, py = 0, hov = null, drag = null, dsx = 0, dsy = 0, pan = false, psx = 0, psy = 0, pox = 0, poy = 0, fc = 0, settled = false;
  state.gs = { zoom, px, py, nodes, edges, canvas, full, data, tcm, mode };
  function s2w(sx, sy) { return { x: (sx - px) / zoom, y: (sy - py) / zoom }; }

  function sim() {
    if (settled) return;
    const al = Math.max(0.01, 1 - fc / 250);
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = 2500 / (d * d) * al;
      a.vx -= dx / d * f; a.vy -= dy / d * f; b.vx += dx / d * f; b.vy += dy / d * f;
    }
    for (const e of edges) {
      const dx = e.target.x - e.source.x, dy = e.target.y - e.source.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - 160) * 0.015 * al;
      e.source.vx += dx / d * f; e.source.vy += dy / d * f;
      e.target.vx -= dx / d * f; e.target.vy -= dy / d * f;
    }
    let mv = 0;
    for (const n of nodes) {
      n.vx += (W / 2 - n.x) * 0.005 * al; n.vy += (H / 2 - n.y) * 0.005 * al;
      if (n === drag) continue;
      n.vx *= 0.85; n.vy *= 0.85; n.x += n.vx; n.y += n.vy;
      n.x = Math.max(n.radius + 10, Math.min(W - n.radius - 10, n.x));
      n.y = Math.max(n.radius + 10, Math.min(H - n.radius - 10, n.y));
      mv += Math.abs(n.vx) + Math.abs(n.vy);
    }
    fc++; if (fc > 250 || mv < 0.1) settled = true;
  }

  function draw() {
    const dk = document.documentElement.getAttribute('data-theme') === 'dark';
    ctx.clearRect(0, 0, W, H); ctx.save(); ctx.translate(px, py); ctx.scale(zoom, zoom);
    // Edges
    for (const e of edges) {
      ctx.beginPath(); ctx.moveTo(e.source.x, e.source.y); ctx.lineTo(e.target.x, e.target.y);
      const hl = hov && (e.source === hov || e.target === hov);
      ctx.strokeStyle = hl ? (dk ? 'rgba(255,255,255,0.3)' : 'rgba(55,53,47,0.2)') : (dk ? 'rgba(255,255,255,0.05)' : 'rgba(55,53,47,0.06)');
      ctx.lineWidth = isKw ? (hl ? 2 : Math.max(0.5, (e.weight || 0.5) * 2)) : (hl ? 1.5 : 1);
      ctx.stroke();
    }
    // Nodes
    for (const n of nodes) {
      const isH = n === hov;
      const isC = hov && edges.some(e => (e.source === hov && e.target === n) || (e.target === hov && e.source === n));
      const dim = hov && !isH && !isC;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fillStyle = dim ? (dk ? 'rgba(255,255,255,0.06)' : 'rgba(55,53,47,0.06)') : n.color;
      ctx.globalAlpha = dim ? 0.25 : 1;
      ctx.fill(); ctx.globalAlpha = 1;
      if (isH) { ctx.strokeStyle = dk ? '#fff' : '#37352F'; ctx.lineWidth = 2; ctx.stroke(); }
    }
    // Labels
    const ff = getComputedStyle(document.body).fontFamily;
    ctx.font = (isKw ? '11px ' : '10px ') + ff; ctx.textAlign = 'center';
    for (const n of nodes) {
      const text = isKw ? n.label : (n.name || n.label || '');
      if (!text) continue;
      const dim = hov && n !== hov && !edges.some(e => (e.source === hov && e.target === n) || (e.target === hov && e.source === n));
      ctx.globalAlpha = dim ? 0.15 : 0.7;
      const short = isKw ? text : (text.length > 10 ? text.slice(0, 10) + '\u2026' : text);
      ctx.fillStyle = dk ? '#fff' : '#1a1a1a';
      ctx.fillText(short, n.x, n.y + n.radius + 12);
    }
    ctx.globalAlpha = 1; ctx.textAlign = 'start';
    // Hover tooltip
    if (hov) {
      const text = isKw ? (hov.label + ' (' + hov.count + ')') : (hov.name || hov.label || hov.id);
      ctx.font = '12px ' + ff;
      const tw = ctx.measureText(text).width;
      const tx = hov.x - tw / 2, ty = hov.y - hov.radius - 14;
      ctx.fillStyle = dk ? 'rgba(0,0,0,0.8)' : 'rgba(0,0,0,0.75)';
      ctx.beginPath(); ctx.roundRect(tx - 4, ty - 14, tw + 8, 20, 4); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(text, tx, ty);
    }
    ctx.restore();
  }

  function loop() { sim(); draw(); if (!settled || hov || drag) state.gaf = requestAnimationFrame(loop); }

  canvas.onmousemove = e => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    if (drag) { const w = s2w(mx, my); drag.x = w.x; drag.y = w.y; drag.vx = 0; drag.vy = 0; draw(); return; }
    if (pan) { px = pox + (mx - psx); py = poy + (my - psy); state.gs.px = px; state.gs.py = py; draw(); return; }
    const w = s2w(mx, my);
    let found = null;
    for (const n of nodes) { const dx = w.x - n.x, dy = w.y - n.y; if (dx * dx + dy * dy < (n.radius + 4) ** 2) { found = n; break; } }
    if (found !== hov) {
      hov = found; canvas.style.cursor = found ? 'pointer' : 'grab';
      if (!settled) return; draw();
      if (found && settled) { settled = false; state.gaf = requestAnimationFrame(loop); }
    }
  };

  canvas.onmousedown = e => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const w = s2w(mx, my);
    for (const n of nodes) { const dx = w.x - n.x, dy = w.y - n.y; if (dx * dx + dy * dy < (n.radius + 4) ** 2) { drag = n; dsx = mx; dsy = my; canvas.style.cursor = 'grabbing'; return; } }
    pan = true; psx = mx; psy = my; pox = px; poy = py;
  };

  canvas.onmouseup = e => {
    if (drag) {
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (Math.sqrt((mx - dsx) ** 2 + (my - dsy) ** 2) < 4) {
        if (isKw && full) showKwPanel(drag);
        else if (!isKw) go('#/article/' + drag.id);
      }
      drag = null; canvas.style.cursor = hov ? 'pointer' : 'grab';
    }
    if (pan) { pan = false; canvas.style.cursor = 'grab'; }
  };

  canvas.onmouseleave = () => { hov = null; drag = null; pan = false; if (settled) draw(); };

  if (full) canvas.onwheel = e => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const d = e.deltaY > 0 ? 0.9 : 1.1;
    const nz = Math.max(0.3, Math.min(5, zoom * d));
    px = mx - (mx - px) * (nz / zoom); py = my - (my - py) * (nz / zoom);
    zoom = nz; state.gs.zoom = zoom; state.gs.px = px; state.gs.py = py; draw();
  };

  state.gaf = requestAnimationFrame(loop);
}

/* ── Accent color helper for keyword nodes ── */
function hslAccent(hueShift, count) {
  // Base: indigo 239 hue, vary slightly
  const hue = 239 + hueShift;
  const sat = Math.min(75, 50 + count * 5);
  const lit = Math.max(45, 65 - count * 3);
  return 'hsl(' + hue + ',' + sat + '%,' + lit + '%)';
}

/* ── Zoom ── */
export function gZoom(f) {
  if (!state.gs) return;
  const c = state.gs.canvas; const r = c.getBoundingClientRect(); const cx = r.width / 2, cy = r.height / 2;
  const nz = Math.max(0.3, Math.min(5, state.gs.zoom * f));
  state.gs.px = cx - (cx - state.gs.px) * (nz / state.gs.zoom);
  state.gs.py = cy - (cy - state.gs.py) * (nz / state.gs.zoom);
  state.gs.zoom = nz;
  cancelGA();
  const el = state.gs.full ? document.getElementById('fgCanvas') : document.getElementById('dgCanvas');
  if (el) initFG(el, state.gs.data, state.gs.full, state.gs.mode || 'article');
}

/* ── Filter (article mode only) ── */
export function applyGF() {
  if (!state.gs) return;
  const cbs = document.querySelectorAll('.graph-filter-label input');
  const en = new Set(); cbs.forEach(cb => { if (cb.checked) en.add(cb.dataset.topic); });
  const f = {
    nodes: state.gs.data.nodes.filter(n => !n.topic || en.has(n.topic)),
    edges: state.gs.data.edges.filter(e => { const s = state.gs.data.nodes.find(n => n.id === e.source); const t = state.gs.data.nodes.find(n => n.id === e.target); return s && t && (!s.topic || en.has(s.topic)) && (!t.topic || en.has(t.topic)); })
  };
  const ct = document.querySelector('.graph-count'); if (ct) ct.textContent = f.nodes.length + ' 节点';
  cancelGA(); const cv = document.getElementById('fgCanvas'); if (cv) initFG(cv, f, true, 'article');
}

/* ── View switch ── */
export function switchGraphView(mode) {
  state.graphMode = mode;
  // Clear cached data for fresh reload from state cache
  cancelGA();
  closeKwPanel();
  const c = $('content');
  if (c) rGraph(c);
}
