import { $, h, api, go, jsAttr } from '../utils.js';
import state from '../state.js';

// Apple SF 软系统色（去饱和、米底上更耐看）
const TC = ['#64A8FF', '#FF7A7A', '#67C18A', '#FFB460', '#AF8FE8', '#FF8CB6', '#5DC1D3', '#FF9B6E', '#5DD0B7', '#8892E0'];
// hex → rgba helper
function rgba(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

// 标签最长 14 字符，超了 ellipsis —— 后端已规范化，这里只兜底
function clipLabel(s) {
  s = String(s || '');
  return s.length > 14 ? s.slice(0, 13) + '…' : s;
}

export function cancelGA() { if (state.gaf) { cancelAnimationFrame(state.gaf); state.gaf = null; } }

/* ── Main render ── */
export async function rGraph(c) {
  c.innerHTML = '<div style="padding:60px;text-align:center;color:var(--fg-tertiary)">加载中...</div>';
  try {
    const data = state.gd || await api('/api/wiki/graph'); state.gd = data;
    const ns = data.nodes || [];
    const hasKind = ns.some(n => n.kind);
    const conceptCount = hasKind ? ns.filter(n => n.kind === 'concept').length : ns.length;
    const topics = [...new Set(ns.map(n => n.topic).filter(Boolean))];
    let s = '<div class="page-graph"><div class="graph-toolbar">';
    s += '<button class="graph-toolbar-btn" onclick="gZoom(1.2)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg></button>';
    s += '<button class="graph-toolbar-btn" onclick="gZoom(0.8)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg></button>';
    topics.forEach(t => { s += '<label class="graph-filter-label"><input type="checkbox" checked data-topic="' + h(t) + '" onchange="applyGF()">' + h(t) + '</label>'; });
    s += '<span class="graph-count">' + conceptCount + ' 概念</span></div>';
    s += '<div class="graph-canvas-wrap" id="fgWrap">';
    if (conceptCount < 2) s += '<div class="graph-empty-msg">需要更多内容</div>';
    else s += '<canvas id="fgCanvas"></canvas>';
    s += '</div>';
    s += '<div class="graph-footer" id="fgLegend"></div>';
    s += '</div>';
    c.innerHTML = s;
    if (conceptCount >= 2) requestAnimationFrame(() => { const cv = document.getElementById('fgCanvas'); if (cv) initFG(cv, data, true); });
  } catch { c.innerHTML = '<div style="text-align:center;padding:60px;color:var(--fg-tertiary)">加载失败</div>'; }
}

/* ── Force-directed graph ── */
export function initFG(canvas, data, full) {
  cancelGA();
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const dashH = 440;
  canvas.width = rect.width * dpr; canvas.height = (full ? rect.height : dashH) * dpr;
  canvas.style.width = rect.width + 'px'; canvas.style.height = (full ? rect.height : dashH) + 'px';
  ctx.scale(dpr, dpr);
  const W = rect.width, H = full ? rect.height : dashH;

  // Dashboard 小画布下限制单概念最多展开的文章数，避免挤爆视觉
  const MAX_CHILDREN_ON_DASH = 6;

  const rawNodes = data.nodes || [];
  const rawEdges = data.edges || [];

  // 归一化：兼容有/没 kind 字段的数据。
  // 新契约：nodes 显式带 kind。若一个 node 都没 kind，按老格式处理 —— 每个 node 当作一个 concept，
  // 让旧后端过渡期不至于整页空白。等后端升级就自然走 concept/article 分层。
  const hasKind = rawNodes.some(n => n.kind);
  if (!hasKind) {
    for (const n of rawNodes) {
      n.kind = 'concept';
      n.label = n.label || n.name || n.id;
      n.articleCount = n.articleCount || 1;
    }
  }
  const concepts = rawNodes.filter(n => n.kind === 'concept');
  const articles = rawNodes.filter(n => n.kind === 'article');

  // topic color map
  const topics = [...new Set(rawNodes.map(n => n.topic).filter(Boolean))];
  const tcm = {}; topics.forEach((t, i) => tcm[t] = TC[i % TC.length]);

  // concept ↔ article parent map
  const childrenByConcept = {};
  for (const a of articles) {
    if (a.parent) {
      if (!childrenByConcept[a.parent]) childrenByConcept[a.parent] = [];
      childrenByConcept[a.parent].push(a);
    }
  }

  // concept 度数（co-concept 边）
  const conceptDeg = {}; concepts.forEach(n => conceptDeg[n.id] = 0);
  for (const e of rawEdges) {
    if (e.kind === 'co-concept') {
      if (conceptDeg[e.source] !== undefined) conceptDeg[e.source]++;
      if (conceptDeg[e.target] !== undefined) conceptDeg[e.target]++;
    }
  }

  const orphans = concepts.filter(n => (conceptDeg[n.id] || 0) === 0);

  // 初始摆位：concept 在大圆上，article 紧跟 parent
  const nodeMap = {};
  const simNodes = [];

  concepts.forEach((n, i) => {
    const a = (i / Math.max(1, concepts.length)) * Math.PI * 2;
    const r = Math.min(W, H) * 0.36;
    const articleCount = typeof n.articleCount === 'number' ? n.articleCount : (childrenByConcept[n.id] || []).length;
    const radius = Math.max(6, Math.min(18, 6 + Math.log2(articleCount + 1) * 2.5));
    const color = tcm[n.topic] || '#94a3b8';
    const node = {
      ...n,
      kind: 'concept',
      x: W / 2 + Math.cos(a) * r * (0.7 + Math.random() * 0.3),
      y: H / 2 + Math.sin(a) * r * (0.7 + Math.random() * 0.3),
      vx: 0, vy: 0, radius, color,
      articleCount,
      sparse: articleCount === 1,
      dPhX: Math.random() * Math.PI * 2,
      dPhY: Math.random() * Math.PI * 2,
      dFqX: 0.0011 + Math.random() * 0.0006,
      dFqY: 0.0011 + Math.random() * 0.0006,
      dAmp: 3 + Math.random() * 3,
      opacity: 1,
      opacityTarget: 1
    };
    nodeMap[n.id] = node;
    simNodes.push(node);
  });

  // Dashboard 模式下对每个 concept 限制最多 N 个可展开子节点
  const articleNodes = [];
  for (const a of articles) {
    const parent = a.parent ? nodeMap[a.parent] : null;
    const color = tcm[a.topic] || '#94a3b8';
    const node = {
      ...a,
      kind: 'article',
      x: parent ? parent.x + (Math.random() - 0.5) * 40 : W / 2 + (Math.random() - 0.5) * 60,
      y: parent ? parent.y + (Math.random() - 0.5) * 40 : H / 2 + (Math.random() - 0.5) * 60,
      vx: 0, vy: 0,
      radius: 4,
      color,
      opacity: 0,
      opacityTarget: 0
    };
    nodeMap[a.id] = node;
    articleNodes.push(node);
  }

  // 限制 dashboard 下单 concept 子节点数量（超过的不进入 sim / 不可被展开）
  const allowedArticleIds = new Set();
  for (const c of concepts) {
    const kids = childrenByConcept[c.id] || [];
    const cap = !full ? Math.min(kids.length, MAX_CHILDREN_ON_DASH) : kids.length;
    for (let i = 0; i < cap; i++) {
      allowedArticleIds.add(kids[i].id);
    }
  }
  const effArticleNodes = articleNodes.filter(n => allowedArticleIds.has(n.id));

  // 可见 article 集合（受 hover 驱动）
  const visible = new Set();

  // 边过滤：按 kind 分类
  const coEdges = [];
  const containsEdges = [];
  const linkEdges = [];
  for (const e of rawEdges) {
    const s = nodeMap[e.source], t = nodeMap[e.target];
    if (!s || !t) continue;
    const kind = e.kind || 'co-concept';
    const rec = { source: s, target: t, weight: e.weight || 1, kind };
    if (kind === 'co-concept') coEdges.push(rec);
    else if (kind === 'contains') {
      if (allowedArticleIds.has(e.target) || allowedArticleIds.has(e.source)) containsEdges.push(rec);
    } else linkEdges.push(rec);
  }

  let zoom = 1, px = 0, py = 0, hov = null, drag = null, dsx = 0, dsy = 0, pan = false, psx = 0, psy = 0, pox = 0, poy = 0;
  let fc = 0, settled = false;
  let lastTickT = performance.now();

  state.gs = { zoom, px, py, nodes: simNodes, concepts, articleNodes: effArticleNodes, edges: coEdges, canvas, full, data, tcm };

  // Legend (底部：topic 色图例 + 孤岛列表)
  const legendId = full ? 'fgLegend' : 'dgLegend';
  function renderLegend() {
    const lg = document.getElementById(legendId);
    if (!lg) return;
    let s = '';
    topics.forEach(t => {
      s += '<span class="graph-footer-item"><span class="graph-footer-dot" style="background:' + tcm[t] + '"></span>' + h(t) + '</span>';
    });
    if (orphans.length) {
      const show = orphans.slice(0, 6);
      const extra = orphans.length - show.length;
      s += '<span class="graph-orphan-hint"><span class="graph-orphan-label">知识孤岛:</span>';
      show.forEach(o => {
        s += ' <a class="graph-orphan-chip" data-tag="' + h(o.label) + '" href="#/browse?tag=' + encodeURIComponent(o.label) + '">' + h(o.label) + '</a>';
      });
      if (extra > 0) s += ' <span class="graph-orphan-more">+' + extra + '</span>';
      s += '</span>';
    }
    lg.innerHTML = s;
  }
  renderLegend();

  function s2w(sx, sy) { return { x: (sx - px) / zoom, y: (sy - py) / zoom }; }

  function activeNodes() {
    const out = simNodes.slice();
    for (const a of effArticleNodes) if (visible.has(a.id) || a.opacity > 0.02) out.push(a);
    return out;
  }
  function activeEdges() {
    const out = coEdges.slice();
    for (const e of containsEdges) {
      const ov = edgeOpacity(e);
      if (ov > 0.02) out.push(e);
    }
    return out;
  }
  function edgeOpacity(e) {
    // contains 边透明度跟随其 article 端 opacity
    if (e.kind === 'contains') {
      const art = e.source.kind === 'article' ? e.source : e.target;
      return art ? (art.opacity || 0) : 0;
    }
    return 1;
  }

  // 命中测试用的可视坐标 —— 画面上节点在 drift，hit test 必须跟着 drift 走
  function nodeVis(n) {
    if (n === drag) return [n.x, n.y];
    if (n.kind === 'article') return [n.x, n.y]; // article 不 drift
    const t = performance.now();
    return [n.x + Math.sin(t * n.dFqX + n.dPhX) * n.dAmp, n.y + Math.sin(t * n.dFqY + n.dPhY) * n.dAmp];
  }

  // hover 状态变更：设定可见 article 的 opacityTarget
  function updateVisibility(newHov) {
    const want = new Set();
    if (newHov && newHov.kind === 'concept') {
      for (const a of effArticleNodes) {
        if (a.parent === newHov.id) want.add(a.id);
      }
    }
    // incoming
    for (const id of want) {
      if (!visible.has(id)) {
        const a = nodeMap[id];
        if (a) {
          // 重置初始位置到 parent 附近（若此前被拖走）
          const p = nodeMap[a.parent];
          if (p) {
            // 只有上次完全隐藏时才 reposition，避免 cross-fade 闪跳
            if (a.opacity < 0.05) {
              const ang = Math.random() * Math.PI * 2;
              a.x = p.x + Math.cos(ang) * 50;
              a.y = p.y + Math.sin(ang) * 50;
              a.vx = 0; a.vy = 0;
            }
          }
          a.opacityTarget = 1;
          visible.add(id);
        }
      }
    }
    // outgoing
    for (const id of Array.from(visible)) {
      if (!want.has(id)) {
        const a = nodeMap[id];
        if (a) a.opacityTarget = 0;
        visible.delete(id);
      }
    }
    // 只要有 fade 在进行就重启 sim loop
    settled = false;
  }

  function sim(dtMs) {
    if (settled) return;
    const nodesNow = activeNodes();
    const al = Math.max(0.01, 1 - fc / 250);

    // 概念节点互斥（只在 concept 之间做 N² 斥力，避免引入 article 把图撑散）
    for (let i = 0; i < simNodes.length; i++) for (let j = i + 1; j < simNodes.length; j++) {
      const a = simNodes[i], b = simNodes[j];
      let dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = 2500 / (d * d) * al;
      a.vx -= dx / d * f; a.vy -= dy / d * f; b.vx += dx / d * f; b.vy += dy / d * f;
    }
    // co-concept 弹簧
    for (const e of coEdges) {
      const dx = e.target.x - e.source.x, dy = e.target.y - e.source.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - 160) * 0.015 * al;
      e.source.vx += dx / d * f; e.source.vy += dy / d * f;
      e.target.vx -= dx / d * f; e.target.vy -= dy / d * f;
    }
    // contains 弹簧 —— 仅对可见 article 生效，spring length 60
    for (const e of containsEdges) {
      const art = e.source.kind === 'article' ? e.source : e.target;
      const con = e.source.kind === 'concept' ? e.source : e.target;
      if (!art || !con) continue;
      if (!visible.has(art.id)) continue;
      const dx = con.x - art.x, dy = con.y - art.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - 60) * 0.02 * al;
      // 只拽 article，不要回拉 concept 布局（concept 层已稳定）
      art.vx += dx / d * f; art.vy += dy / d * f;
    }

    let mv = 0;
    for (const n of nodesNow) {
      // center gravity 只对 concept 生效，避免 article 被拽向中心
      if (n.kind === 'concept') {
        n.vx += (W / 2 - n.x) * 0.005 * al;
        n.vy += (H / 2 - n.y) * 0.005 * al;
      }
      if (n === drag) continue;
      // 隐藏的 article 冻结：不积分速度
      if (n.kind === 'article' && !visible.has(n.id) && n.opacity < 0.02) {
        n.vx = 0; n.vy = 0;
        continue;
      }
      n.vx *= 0.85; n.vy *= 0.85;
      n.x += n.vx; n.y += n.vy;
      const pad = n.radius + 10;
      n.x = Math.max(pad, Math.min(W - pad, n.x));
      n.y = Math.max(pad, Math.min(H - pad, n.y));
      mv += Math.abs(n.vx) + Math.abs(n.vy);
    }

    // opacity tween (180ms)
    const tweenStep = Math.min(1, dtMs / 180);
    let fading = false;
    for (const a of effArticleNodes) {
      const d = a.opacityTarget - a.opacity;
      if (Math.abs(d) > 0.005) {
        a.opacity += d * tweenStep;
        fading = true;
      } else {
        a.opacity = a.opacityTarget;
      }
    }

    fc++;
    if (fc > 250 && mv < 0.1 && !fading) settled = true;
  }

  function draw() {
    const dk = document.documentElement.getAttribute('data-theme') === 'dark';
    const t = performance.now();
    const DX = n => (n === drag ? n.x : (n.kind === 'concept' ? n.x + Math.sin(t * n.dFqX + n.dPhX) * n.dAmp : n.x));
    const DY = n => (n === drag ? n.y : (n.kind === 'concept' ? n.y + Math.sin(t * n.dFqY + n.dPhY) * n.dAmp : n.y));

    ctx.clearRect(0, 0, W, H); ctx.save(); ctx.translate(px, py); ctx.scale(zoom, zoom);

    // ── concept 层边（co-concept）
    for (const e of coEdges) {
      ctx.beginPath(); ctx.moveTo(DX(e.source), DY(e.source)); ctx.lineTo(DX(e.target), DY(e.target));
      const hl = hov && (e.source === hov || e.target === hov);
      ctx.strokeStyle = hl ? (dk ? 'rgba(255,255,255,0.28)' : 'rgba(28,28,28,0.22)') : (dk ? 'rgba(255,255,255,0.06)' : 'rgba(28,28,28,0.08)');
      ctx.lineWidth = hl ? 1.2 : 0.8;
      ctx.stroke();
    }

    // ── contains 边（淡入/淡出）
    for (const e of containsEdges) {
      const op = edgeOpacity(e);
      if (op < 0.02) continue;
      ctx.save();
      ctx.globalAlpha = op * 0.6;
      ctx.beginPath(); ctx.moveTo(DX(e.source), DY(e.source)); ctx.lineTo(DX(e.target), DY(e.target));
      ctx.strokeStyle = dk ? 'rgba(255,255,255,0.14)' : 'rgba(28,28,28,0.14)';
      ctx.lineWidth = 0.7;
      ctx.setLineDash([]);
      ctx.stroke();
      ctx.restore();
    }

    // ── concept 节点
    for (const n of simNodes) {
      const isH = n === hov;
      const isC = hov && coEdges.some(e => (e.source === hov && e.target === n) || (e.target === hov && e.source === n));
      const dim = hov && !isH && !isC;
      const cx = DX(n), cy = DY(n);
      ctx.save();
      ctx.shadowColor = dk ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.10)';
      ctx.shadowBlur = isH ? 8 : 4;
      ctx.shadowOffsetY = isH ? 2 : 1;
      ctx.beginPath(); ctx.arc(cx, cy, n.radius, 0, Math.PI * 2);
      const fillA = dim ? 0.06 : (isH ? 0.55 : 0.32);
      ctx.fillStyle = rgba(n.color, fillA);
      ctx.fill();
      ctx.restore();
      // stroke —— sparse 用虚线
      ctx.beginPath(); ctx.arc(cx, cy, n.radius, 0, Math.PI * 2);
      const strokeA = dim ? 0.18 : (isH ? 1 : 0.78);
      ctx.lineWidth = isH ? 1.8 : 1.2;
      ctx.strokeStyle = rgba(n.color, strokeA);
      if (n.sparse) ctx.setLineDash([3, 3]);
      ctx.stroke();
      if (n.sparse) ctx.setLineDash([]);
    }

    // ── article 节点（淡入淡出）
    for (const a of effArticleNodes) {
      if (a.opacity < 0.02) continue;
      const isH = a === hov;
      ctx.save();
      ctx.globalAlpha = a.opacity;
      ctx.shadowColor = dk ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.08)';
      ctx.shadowBlur = isH ? 6 : 2;
      ctx.shadowOffsetY = 1;
      ctx.beginPath(); ctx.arc(a.x, a.y, a.radius, 0, Math.PI * 2);
      ctx.fillStyle = rgba(a.color, isH ? 0.6 : 0.4);
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = a.opacity * 0.7;
      ctx.beginPath(); ctx.arc(a.x, a.y, a.radius, 0, Math.PI * 2);
      ctx.lineWidth = isH ? 1.3 : 0.9;
      ctx.strokeStyle = rgba(a.color, isH ? 0.9 : 0.55);
      ctx.stroke();
      ctx.restore();
    }

    // ── 标签
    const ff = getComputedStyle(document.body).fontFamily;
    // concept 标签（11.5px）
    ctx.font = '500 11.5px ' + ff; ctx.textAlign = 'center';
    for (const n of simNodes) {
      const text = clipLabel(n.label || n.name || n.id);
      if (!text) continue;
      const isH = n === hov;
      const isC = hov && coEdges.some(e => (e.source === hov && e.target === n) || (e.target === hov && e.source === n));
      const dim = hov && !isH && !isC;
      ctx.globalAlpha = dim ? 0.18 : (isH || isC ? 0.95 : 0.68);
      ctx.fillStyle = dk ? '#fff' : '#1C1C1C';
      ctx.fillText(text, DX(n), DY(n) + n.radius + 12);
    }
    // article 标签（10.5px，跟随 opacity）
    ctx.font = '500 10.5px ' + ff;
    for (const a of effArticleNodes) {
      if (a.opacity < 0.1) continue;
      const text = clipLabel(a.label || a.name || '');
      if (!text) continue;
      ctx.globalAlpha = a.opacity * 0.85;
      ctx.fillStyle = dk ? '#fff' : '#1C1C1C';
      ctx.fillText(text, a.x, a.y + a.radius + 11);
    }
    ctx.globalAlpha = 1; ctx.textAlign = 'start';

    // hover tooltip
    if (hov) {
      const text = hov.label || hov.name || hov.id;
      ctx.font = '500 12px ' + ff;
      const tw = ctx.measureText(text).width;
      const hx = DX(hov), hy = DY(hov);
      const tx = hx - tw / 2, ty = hy - hov.radius - 14;
      ctx.fillStyle = dk ? 'rgba(28,28,28,0.92)' : 'rgba(28,28,28,0.88)';
      ctx.beginPath(); ctx.roundRect(tx - 8, ty - 16, tw + 16, 22, 6); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(text, tx, ty);
    }
    ctx.restore();
  }

  function loop() {
    const now = performance.now();
    const dt = now - lastTickT;
    lastTickT = now;
    sim(dt);
    draw();
    state.gaf = requestAnimationFrame(loop);
  }

  function hitTest(w) {
    // 先测 article（在上层），再测 concept
    for (const a of effArticleNodes) {
      if (a.opacity < 0.2) continue;
      const [vx, vy] = nodeVis(a);
      const dx = w.x - vx, dy = w.y - vy;
      if (dx * dx + dy * dy < (a.radius + 5) ** 2) return a;
    }
    for (const n of simNodes) {
      const [vx, vy] = nodeVis(n);
      const dx = w.x - vx, dy = w.y - vy;
      if (dx * dx + dy * dy < (n.radius + 4) ** 2) return n;
    }
    return null;
  }

  canvas.onmousemove = e => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    if (drag) { const w = s2w(mx, my); drag.x = w.x; drag.y = w.y; drag.vx = 0; drag.vy = 0; return; }
    if (pan) { px = pox + (mx - psx); py = poy + (my - psy); state.gs.px = px; state.gs.py = py; return; }
    const w = s2w(mx, my);
    const found = hitTest(w);
    if (found !== hov) {
      const prev = hov;
      hov = found;
      canvas.style.cursor = found ? 'pointer' : 'grab';
      // 只对 concept 变化触发 children 展开；如果是 article ↔ concept 同一 parent 则保持
      const newConcept = found && found.kind === 'concept' ? found : (found && found.kind === 'article' ? nodeMap[found.parent] : null);
      const prevConcept = prev && prev.kind === 'concept' ? prev : (prev && prev.kind === 'article' ? nodeMap[prev.parent] : null);
      if (newConcept !== prevConcept) {
        updateVisibility(newConcept);
      }
      if (settled) { settled = false; state.gaf = requestAnimationFrame(loop); }
    }
  };

  canvas.onmousedown = e => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const w = s2w(mx, my);
    const n = hitTest(w);
    if (n) {
      drag = n;
      const [vx, vy] = nodeVis(n);
      n.x = vx; n.y = vy;
      dsx = mx; dsy = my;
      canvas.style.cursor = 'grabbing';
      return;
    }
    pan = true; psx = mx; psy = my; pox = px; poy = py;
  };

  canvas.onmouseup = e => {
    if (drag) {
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (Math.sqrt((mx - dsx) ** 2 + (my - dsy) ** 2) < 4) {
        if (drag.kind === 'concept') {
          go('#/browse?tag=' + encodeURIComponent(drag.label || drag.name || ''));
        } else if (drag.kind === 'article') {
          go('#/article/' + (drag.path || drag.id));
        }
      }
      drag = null; canvas.style.cursor = hov ? 'pointer' : 'grab';
    }
    if (pan) { pan = false; canvas.style.cursor = 'grab'; }
  };

  canvas.onmouseleave = () => {
    hov = null; drag = null; pan = false;
    updateVisibility(null);
    if (settled) { settled = false; state.gaf = requestAnimationFrame(loop); }
  };

  // Touch support for mobile
  let lastTouchDist = 0;
  canvas.ontouchstart = e => {
    e.preventDefault();
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastTouchDist = Math.sqrt(dx * dx + dy * dy);
      return;
    }
    const t = e.touches[0]; const r = canvas.getBoundingClientRect();
    const mx = t.clientX - r.left, my = t.clientY - r.top;
    const w = s2w(mx, my);
    const n = hitTest(w);
    if (n) {
      drag = n;
      const [vx, vy] = nodeVis(n);
      n.x = vx; n.y = vy;
      dsx = mx; dsy = my;
      // touch 下也触发展开
      if (n.kind === 'concept') {
        updateVisibility(n);
        if (settled) { settled = false; state.gaf = requestAnimationFrame(loop); }
      }
      return;
    }
    pan = true; psx = mx; psy = my; pox = px; poy = py;
  };
  canvas.ontouchmove = e => {
    e.preventDefault();
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (lastTouchDist > 0) {
        const d = dist / lastTouchDist;
        const nz = Math.max(0.3, Math.min(5, zoom * d));
        const r = canvas.getBoundingClientRect();
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
        px = cx - (cx - px) * (nz / zoom); py = cy - (cy - py) * (nz / zoom);
        zoom = nz; state.gs.zoom = zoom; state.gs.px = px; state.gs.py = py;
      }
      lastTouchDist = dist;
      return;
    }
    const t = e.touches[0]; const r = canvas.getBoundingClientRect();
    const mx = t.clientX - r.left, my = t.clientY - r.top;
    if (drag) { const w = s2w(mx, my); drag.x = w.x; drag.y = w.y; drag.vx = 0; drag.vy = 0; return; }
    if (pan) { px = pox + (mx - psx); py = poy + (my - psy); state.gs.px = px; state.gs.py = py; }
  };
  canvas.ontouchend = e => {
    if (e.touches.length < 2) lastTouchDist = 0;
    if (drag) {
      const ct = e.changedTouches[0]; const r = canvas.getBoundingClientRect();
      const mx = ct.clientX - r.left, my = ct.clientY - r.top;
      if (Math.sqrt((mx - dsx) ** 2 + (my - dsy) ** 2) < 8) {
        if (drag.kind === 'concept') {
          go('#/browse?tag=' + encodeURIComponent(drag.label || drag.name || ''));
        } else if (drag.kind === 'article') {
          go('#/article/' + (drag.path || drag.id));
        }
      }
      drag = null;
    }
    if (pan) pan = false;
  };

  if (full) canvas.onwheel = e => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const d = e.deltaY > 0 ? 0.9 : 1.1;
    const nz = Math.max(0.3, Math.min(5, zoom * d));
    px = mx - (mx - px) * (nz / zoom); py = my - (my - py) * (nz / zoom);
    zoom = nz; state.gs.zoom = zoom; state.gs.px = px; state.gs.py = py;
  };

  state.gaf = requestAnimationFrame(loop);
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
  if (el) initFG(el, state.gs.data, state.gs.full);
}

/* ── Filter ── */
export function applyGF() {
  if (!state.gs) return;
  const cbs = document.querySelectorAll('.graph-filter-label input');
  const en = new Set(); cbs.forEach(cb => { if (cb.checked) en.add(cb.dataset.topic); });
  const raw = state.gs.data;
  const f = {
    nodes: (raw.nodes || []).filter(n => !n.topic || en.has(n.topic)),
    edges: (raw.edges || []).filter(e => {
      const s = (raw.nodes || []).find(n => n.id === e.source);
      const t = (raw.nodes || []).find(n => n.id === e.target);
      return s && t && (!s.topic || en.has(s.topic)) && (!t.topic || en.has(t.topic));
    })
  };
  const conceptCount = f.nodes.filter(n => n.kind === 'concept').length;
  const ct = document.querySelector('.graph-count'); if (ct) ct.textContent = conceptCount + ' 概念';
  cancelGA(); const cv = document.getElementById('fgCanvas'); if (cv) initFG(cv, f, true);
}
