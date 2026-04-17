import { h, api } from '../utils.js';
import state from '../state.js';

// Apple SF 软系统色（去饱和、米底上更耐看）
const TC = ['#64A8FF', '#FF7A7A', '#67C18A', '#FFB460', '#AF8FE8', '#FF8CB6', '#5DC1D3', '#FF9B6E', '#5DD0B7', '#8892E0'];
// hex → rgba helper
function rgba(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

// 标签最长 14 字符，超了 ellipsis
function clipLabel(s) {
  s = String(s || '');
  return s.length > 14 ? s.slice(0, 13) + '…' : s;
}

export function cancelGA() {
  if (state.gaf) { cancelAnimationFrame(state.gaf); state.gaf = null; }
  if (state.gs && state.gs._escHandler) {
    document.removeEventListener('keydown', state.gs._escHandler);
    state.gs._escHandler = null;
  }
}

/* ── Main render ── */
export async function rGraph(c) {
  c.innerHTML = '<div style="padding:60px;text-align:center;color:var(--fg-tertiary)">加载中...</div>';
  try {
    const data = state.gd || await api('/api/wiki/graph'); state.gd = data;
    const ns = data.nodes || [];
    const hasKind = ns.some(n => n.kind);
    const conceptCount = hasKind ? ns.filter(n => n.kind === 'concept').length : ns.length;
    const articleCount = hasKind ? ns.filter(n => n.kind === 'article').length : 0;
    const stats = data.stats || {};
    const droppedNoise = (stats.droppedHapax || 0) + (stats.droppedStopword || 0);

    let s = '<div class="page-graph"><div class="graph-toolbar">';
    s += '<button class="graph-toolbar-btn" onclick="gZoom(1.2)" title="放大"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg></button>';
    s += '<button class="graph-toolbar-btn" onclick="gZoom(0.8)" title="缩小"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg></button>';
    s += '<input type="search" class="graph-search-box" id="graphSearchBox" placeholder="搜索概念…" autocomplete="off">';
    s += '<span class="graph-count">' + conceptCount + ' 概念</span></div>';
    s += '<div class="graph-canvas-wrap" id="fgWrap">';
    if (conceptCount < 2) s += '<div class="graph-empty-msg">需要更多内容</div>';
    else s += '<canvas id="fgCanvas"></canvas><div class="graph-focus-card" id="graphFocusCard" hidden></div>';
    s += '</div>';
    s += '<div class="graph-stats-footer" id="fgLegend">';
    s += conceptCount + ' 概念 · ' + articleCount + ' 文章';
    if (droppedNoise) s += ' · 已过滤 ' + droppedNoise + ' 个噪声标签';
    s += '</div>';
    s += '</div>';
    c.innerHTML = s;
    if (conceptCount >= 2) requestAnimationFrame(() => {
      const cv = document.getElementById('fgCanvas');
      if (cv) initFG(cv, data, true);
      const sb = document.getElementById('graphSearchBox');
      if (sb) sb.addEventListener('input', () => applyGF());
    });
  } catch { c.innerHTML = '<div style="text-align:center;padding:60px;color:var(--fg-tertiary)">加载失败</div>'; }
}

/* ── Force-directed graph (cluster-based layout) ── */
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

  const rawNodes = data.nodes || [];
  const rawEdges = data.edges || [];

  // 归一化：兼容 legacy / 未升级后端 —— 若没 kind 字段，全部当 concept，单簇
  const hasKind = rawNodes.some(n => n.kind);
  if (!hasKind) {
    for (const n of rawNodes) {
      n.kind = 'concept';
      n.label = n.label || n.name || n.id;
      n.articleCount = n.articleCount || 1;
      n.cluster = n.cluster || '_all';
    }
  }
  const concepts = rawNodes.filter(n => n.kind === 'concept');
  // articles 保留给 popup 列表用，但不再参与 canvas 仿真/绘制
  const articles = rawNodes.filter(n => n.kind === 'article');

  // ── Cluster 定义 & 中心点布局 ──
  const rawClusters = Array.isArray(data.clusters) ? data.clusters.slice() : [];
  // 合并：以 concept 实际出现的 cluster 为准（后端给的 clusters 可能包含 0 concept 的鬼影）
  const clusterConceptCount = {};
  for (const cn of concepts) {
    const cid = cn.cluster || '_none';
    clusterConceptCount[cid] = (clusterConceptCount[cid] || 0) + 1;
  }
  let clusters = rawClusters.filter(c => (clusterConceptCount[c.id] || 0) > 0);
  // 补齐未声明的 cluster
  for (const cid of Object.keys(clusterConceptCount)) {
    if (!clusters.find(c => c.id === cid)) {
      clusters.push({ id: cid, label: cid === '_all' ? '' : cid, articleCount: 0, conceptCount: clusterConceptCount[cid] });
    }
  }
  // legacy 退化：单簇 _all 不绘制 cluster 标签
  if (clusters.length === 0) clusters = [{ id: '_all', label: '', conceptCount: concepts.length, articleCount: 0 }];

  // 分配颜色 + centroid
  const clusterMap = {};
  const N = clusters.length;
  const baseR = Math.min(W, H) * 0.35;
  clusters.forEach((cl, i) => {
    let cx, cy;
    if (N === 1) {
      cx = W / 2; cy = H / 2;
    } else if (N === 2) {
      cx = W / 2 + (i === 0 ? -baseR * 0.6 : baseR * 0.6);
      cy = H / 2;
    } else {
      const ang = (i / N) * Math.PI * 2 - Math.PI / 2;
      cx = W / 2 + Math.cos(ang) * baseR;
      cy = H / 2 + Math.sin(ang) * baseR;
    }
    clusterMap[cl.id] = {
      ...cl,
      color: TC[i % TC.length],
      cx, cy,
      index: i
    };
  });

  // ── 构建节点 ──
  const nodeMap = {};
  const simNodes = [];

  concepts.forEach((n, i) => {
    const cl = clusterMap[n.cluster] || clusterMap[Object.keys(clusterMap)[0]];
    const articleCount = typeof n.articleCount === 'number' ? n.articleCount : 1;
    const radius = 8 + Math.log2(Math.max(2, articleCount)) * 4;
    const labelPx = 11 + Math.log2(Math.max(2, articleCount)) * 1.2;
    const labelWeight = articleCount >= 5 ? 600 : 500;
    // 按 concept 自身 index 分色 —— 当前 corpus 几乎全落在同一 cluster，按 cluster 染色会一片灰蓝
    const color = TC[i % TC.length];
    // 初始摆位：绕 cluster 中心撒点
    const jitterR = 30 + Math.random() * 50;
    const jitterA = Math.random() * Math.PI * 2;
    const node = {
      ...n,
      kind: 'concept',
      x: (cl ? cl.cx : W / 2) + Math.cos(jitterA) * jitterR,
      y: (cl ? cl.cy : H / 2) + Math.sin(jitterA) * jitterR,
      vx: 0, vy: 0,
      radius, color, clusterId: n.cluster,
      articleCount,
      labelPx, labelWeight,
      dPhX: Math.random() * Math.PI * 2,
      dPhY: Math.random() * Math.PI * 2,
      dFqX: 0.0011 + Math.random() * 0.0006,
      dFqY: 0.0011 + Math.random() * 0.0006,
      dAmp: 2.5 + Math.random() * 2.5,
      opacity: 1,
      opacityTarget: 1
    };
    nodeMap[n.id] = node;
    simNodes.push(node);
  });

  // 边：只保留 concept ↔ concept 的 co-concept 边；article 间的 link 边、
  // 以及 concept→article 的 contains 边在 popup-list 模式下都不渲染。
  const coEdges = [];
  for (const e of rawEdges) {
    const s = nodeMap[e.source], t = nodeMap[e.target];
    if (!s || !t) continue;
    const kind = e.kind || 'co-concept';
    if (kind !== 'co-concept') continue;
    coEdges.push({ source: s, target: t, weight: e.weight || 1, kind });
  }

  // 每个 concept 的邻居集合（co-concept）—— focus 模式用
  const conceptNeighbors = {};
  for (const n of simNodes) conceptNeighbors[n.id] = new Set();
  for (const e of coEdges) {
    conceptNeighbors[e.source.id].add(e.target.id);
    conceptNeighbors[e.target.id].add(e.source.id);
  }

  let zoom = 1, px = 0, py = 0, hov = null, drag = null, dsx = 0, dsy = 0, pan = false, psx = 0, psy = 0, pox = 0, poy = 0;
  let fc = 0, settled = false;
  let lastTickT = performance.now();

  // Focus state
  let focused = null; // concept node or null
  let searchQuery = '';

  state.gs = { zoom, px, py, nodes: simNodes, concepts, edges: coEdges, canvas, full, data, clusterMap };

  function s2w(sx, sy) { return { x: (sx - px) / zoom, y: (sy - py) / zoom }; }

  // drift 可视坐标（concept 节点呼吸式漂移）
  function nodeVis(n) {
    if (n === drag) return [n.x, n.y];
    const t = performance.now();
    return [n.x + Math.sin(t * n.dFqX + n.dPhX) * n.dAmp, n.y + Math.sin(t * n.dFqY + n.dPhY) * n.dAmp];
  }

  // 判断 concept 是否通过搜索过滤
  function matchesSearch(n) {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const lbl = String(n.label || n.name || n.id).toLowerCase();
    return lbl.indexOf(q) !== -1;
  }

  // focus 透明度：concept
  function conceptAlpha(n) {
    if (!matchesSearch(n)) return 0.1;
    if (!focused) return 1;
    if (n === focused) return 1;
    if (conceptNeighbors[focused.id] && conceptNeighbors[focused.id].has(n.id)) return 1;
    return 0.15;
  }

  // focus 透明度：co-concept 边
  function coEdgeAlpha(e) {
    if (!focused) return 1;
    if (e.source === focused || e.target === focused) return 1;
    return 0.08;
  }

  // ── 进入/退出 focus —— 不再把 article 作为卫星节点散到画布，直接在 popup 铺列表 ──
  function setFocus(newF) {
    focused = newF;
    settled = false;
    if (!state.gaf) state.gaf = requestAnimationFrame(loop);
    rebuildFocusCard();
    positionFocusCard();
  }

  // hover 驱动的 focus：延迟关闭，让鼠标有机会穿到 popup 上
  let unfocusTimer = null;
  function cancelUnfocus() {
    if (unfocusTimer) { clearTimeout(unfocusTimer); unfocusTimer = null; }
  }
  function scheduleUnfocus(delay) {
    cancelUnfocus();
    unfocusTimer = setTimeout(() => { unfocusTimer = null; if (focused) setFocus(null); }, delay == null ? 180 : delay);
  }

  // 取当前 focus 概念下所有相关文章（按 tags 包含 concept.label 匹配, 不只看 parent）
  function articlesForConcept(c) {
    if (!c) return [];
    const lbl = c.label || c.name || '';
    return articles.filter(a => Array.isArray(a.tags) && a.tags.indexOf(lbl) !== -1);
  }

  // 缓存已测量的 card 尺寸；focus 不变时不重测 DOM，避免每帧 reflow
  let cardSize = { w: 320, h: 0 };
  // card 挂在 canvas 的父容器里，避免用全局 ID 冲突（dashboard 和 graph 页可能同时存在）
  const cardHost = canvas.parentElement;

  // 重建 card 内容（只在 focus 切换时做）
  function rebuildFocusCard() {
    const card = cardHost && cardHost.querySelector('.graph-focus-card');
    if (!card) return null;
    if (!focused) { card.hidden = true; card.innerHTML = ''; cardSize = { w: 320, h: 0 }; return null; }
    const label = focused.label || focused.name || focused.id;
    const list = articlesForConcept(focused);
    const count = list.length || focused.articleCount || 0;
    card.hidden = false;
    let inner = '<div class="graph-focus-card-head">';
    inner += '<div class="graph-focus-card-title">' + h(label) + '</div>';
    inner += '<div class="graph-focus-card-meta">' + count + ' 篇文章</div>';
    inner += '</div>';
    inner += '<div class="graph-focus-card-list">';
    if (list.length) {
      for (const a of list) {
        const title = a.label || a.name || a.id;
        inner += '<a class="graph-focus-card-item" href="#/article/' + encodeURIComponent(a.id) + '" title="' + h(title) + '">' + h(title) + '</a>';
      }
    } else {
      inner += '<div class="graph-focus-card-empty">暂无关联文章</div>';
    }
    inner += '</div>';
    inner += '<a class="graph-focus-card-link" href="#/browse?tag=' + encodeURIComponent(label) + '">在浏览页筛选 →</a>';
    // 小画布（dashboard 440px）上限制 card 高度别超出 canvas 高度 —— max-height CSS 用的是
    // 70vh 不知道 canvas 实际尺寸, 小屏/小组件里会溢出到容器外被 overflow:hidden 裁掉。
    card.style.maxHeight = Math.max(120, Math.floor(H * 0.85)) + 'px';
    card.innerHTML = inner;
    // 一次性测量尺寸
    card.style.visibility = 'hidden';
    card.style.left = '0px'; card.style.top = '0px';
    cardSize = { w: card.offsetWidth || 320, h: card.offsetHeight };
    card.style.visibility = '';
    return card;
  }

  // 只更新 card 定位（轻量，可每帧调）
  function positionFocusCard() {
    const card = cardHost && cardHost.querySelector('.graph-focus-card');
    if (!card || card.hidden || !focused) return;
    const [vx, vy] = nodeVis(focused);
    const sx = vx * zoom + px;
    const sy = vy * zoom + py;
    const cw = cardSize.w, ch = cardSize.h;
    let left = sx + (focused.radius + 14) * zoom;
    let top = sy - ch / 2;
    if (left + cw > W) left = sx - cw - (focused.radius + 14) * zoom;
    card.style.left = Math.max(4, Math.min(W - cw - 4, left)) + 'px';
    card.style.top = Math.max(4, Math.min(H - ch - 4, top)) + 'px';
  }

  // ── 物理仿真 ──
  function sim(dtMs) {
    if (settled) return;
    const al = Math.max(0.02, 1 - fc / 300);

    // concept 互斥
    for (let i = 0; i < simNodes.length; i++) for (let j = i + 1; j < simNodes.length; j++) {
      const a = simNodes[i], b = simNodes[j];
      let dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = 1800 / (d * d) * al;
      a.vx -= dx / d * f; a.vy -= dy / d * f; b.vx += dx / d * f; b.vy += dy / d * f;
    }
    // co-concept 弹簧
    for (const e of coEdges) {
      const dx = e.target.x - e.source.x, dy = e.target.y - e.source.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - 110) * 0.02 * al;
      e.source.vx += dx / d * f; e.source.vy += dy / d * f;
      e.target.vx -= dx / d * f; e.target.vy -= dy / d * f;
    }
    // concept → cluster centroid（软吸引）
    for (const n of simNodes) {
      const cl = clusterMap[n.clusterId];
      if (!cl) continue;
      const dx = cl.cx - n.x, dy = cl.cy - n.y;
      n.vx += dx * 0.008 * al;
      n.vy += dy * 0.008 * al;
    }

    let mv = 0;
    for (const n of simNodes) {
      if (n === drag) continue;
      n.vx *= 0.85; n.vy *= 0.85;
      n.x += n.vx; n.y += n.vy;
      const pad = n.radius + 10;
      n.x = Math.max(pad, Math.min(W - pad, n.x));
      n.y = Math.max(pad, Math.min(H - pad, n.y));
      mv += Math.abs(n.vx) + Math.abs(n.vy);
    }

    fc++;
    if (fc > 300 && mv < 0.1) settled = true;
  }

  // 字体在 canvas 外获取一次就够了，getComputedStyle 每帧调是昂贵的
  const ff = getComputedStyle(document.body).fontFamily;

  function draw() {
    const dk = document.documentElement.getAttribute('data-theme') === 'dark';
    const t = performance.now();
    const DX = n => (n === drag ? n.x : n.x + Math.sin(t * n.dFqX + n.dPhX) * n.dAmp);
    const DY = n => (n === drag ? n.y : n.y + Math.sin(t * n.dFqY + n.dPhY) * n.dAmp);

    ctx.clearRect(0, 0, W, H); ctx.save(); ctx.translate(px, py); ctx.scale(zoom, zoom);

    // ── cluster labels（最底层，低透明度）
    if (Object.keys(clusterMap).length > 1) {
      ctx.save();
      ctx.font = '600 14px ' + ff;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const cid in clusterMap) {
        const cl = clusterMap[cid];
        if (!cl.label) continue;
        if ((clusterConceptCount[cid] || 0) === 0) continue;
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = rgba(cl.color, 1);
        ctx.fillText(String(cl.label), cl.cx, cl.cy);
      }
      ctx.restore();
    }

    // ── co-concept 边
    for (const e of coEdges) {
      const a = coEdgeAlpha(e);
      if (a < 0.02) continue;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.beginPath(); ctx.moveTo(DX(e.source), DY(e.source)); ctx.lineTo(DX(e.target), DY(e.target));
      const hl = hov && (e.source === hov || e.target === hov);
      ctx.strokeStyle = hl ? (dk ? 'rgba(255,255,255,0.28)' : 'rgba(28,28,28,0.22)') : (dk ? 'rgba(255,255,255,0.08)' : 'rgba(28,28,28,0.10)');
      ctx.lineWidth = hl ? 1.2 : 0.8;
      ctx.stroke();
      ctx.restore();
    }

    // ── concept 节点
    for (const n of simNodes) {
      const isH = n === hov;
      const alpha = conceptAlpha(n);
      const cx = DX(n), cy = DY(n);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.shadowColor = dk ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.10)';
      ctx.shadowBlur = isH ? 10 : 4;
      ctx.shadowOffsetY = isH ? 2 : 1;
      ctx.beginPath(); ctx.arc(cx, cy, n.radius, 0, Math.PI * 2);
      ctx.fillStyle = rgba(n.color, isH ? 0.55 : 0.32);
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.beginPath(); ctx.arc(cx, cy, n.radius, 0, Math.PI * 2);
      ctx.lineWidth = isH ? 2 : 1.3;
      ctx.strokeStyle = rgba(n.color, isH ? 1 : 0.78);
      ctx.stroke();
      ctx.restore();
    }

    // ── concept 标签
    for (const n of simNodes) {
      const text = clipLabel(n.label || n.name || n.id);
      if (!text) continue;
      const alpha = conceptAlpha(n);
      if (alpha < 0.05) continue;
      const isH = n === hov;
      ctx.font = n.labelWeight + ' ' + n.labelPx.toFixed(1) + 'px ' + ff;
      ctx.textAlign = 'center';
      ctx.globalAlpha = alpha * (isH ? 1 : 0.85);
      ctx.fillStyle = dk ? '#fff' : '#1C1C1C';
      ctx.fillText(text, DX(n), DY(n) + n.radius + n.labelPx + 2);
    }

    ctx.globalAlpha = 1; ctx.textAlign = 'start';

    // hover tooltip（非 focus 模式下给 hover node 一点 hint）
    if (hov && !focused) {
      const text = hov.label || hov.name || hov.id;
      ctx.font = '500 12px ' + ff;
      const tw = ctx.measureText(text).width;
      const hx = DX(hov), hy = DY(hov);
      const tx = hx - tw / 2, ty = hy - hov.radius - 14;
      ctx.fillStyle = dk ? 'rgba(28,28,28,0.92)' : 'rgba(28,28,28,0.88)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(tx - 8, ty - 16, tw + 16, 22, 6);
      else ctx.rect(tx - 8, ty - 16, tw + 16, 22);
      ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(text, tx, ty);
    }
    ctx.restore();

    // 同步 focus card 位置（只改 left/top，不重建 innerHTML）
    if (focused) positionFocusCard();
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
      hov = found;
      canvas.style.cursor = found ? 'pointer' : 'grab';
      if (settled) { settled = false; if (!state.gaf) state.gaf = requestAnimationFrame(loop); }
    }
    // hover-driven focus：鼠标压在 concept 上立刻弹，移到空白处延迟关闭
    if (found && found.kind === 'concept') {
      cancelUnfocus();
      if (focused !== found) setFocus(found);
    } else if (!found && focused) {
      scheduleUnfocus();
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
      // hover 已管 focus，click 节点不再做切换；只收尾 drag 状态
      drag = null; canvas.style.cursor = hov ? 'pointer' : 'grab';
    }
    if (pan) {
      // 空白点击立即退出 focus（不等 hover 超时）
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const click = Math.sqrt((mx - psx) ** 2 + (my - psy) ** 2) < 4;
      if (click && focused) { cancelUnfocus(); setFocus(null); }
      pan = false; canvas.style.cursor = 'grab';
    }
  };

  canvas.onmouseleave = () => {
    hov = null; drag = null; pan = false;
    if (focused) scheduleUnfocus();
    if (settled) { settled = false; if (!state.gaf) state.gaf = requestAnimationFrame(loop); }
  };

  // popup 自身也是 hover 敏感区 —— 鼠标移进去时撤销关闭，否则用户想点列表链接就被抢走了
  const cardEl = cardHost && cardHost.querySelector('.graph-focus-card');
  if (cardEl) {
    cardEl.addEventListener('mouseenter', cancelUnfocus);
    cardEl.addEventListener('mouseleave', () => scheduleUnfocus());
  }

  // ESC 退出 focus
  const escHandler = e => {
    if (e.key === 'Escape' && focused) { setFocus(null); }
  };
  document.addEventListener('keydown', escHandler);
  state.gs._escHandler = escHandler;

  // Touch support
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
      const click = Math.sqrt((mx - dsx) ** 2 + (my - dsy) ** 2) < 8;
      if (click && drag.kind === 'concept') {
        if (focused === drag) setFocus(null);
        else setFocus(drag);
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

  // 暴露给 applyGF / gZoom 用
  state.gs._setSearch = q => { searchQuery = (q || '').trim(); settled = false; if (!state.gaf) state.gaf = requestAnimationFrame(loop); };
  state.gs._clearFocus = () => setFocus(null);
  state.gs._applyZoom = (nz, cx, cy) => {
    // 以 (cx, cy) 为锚点把 zoom 从 zoom → nz
    px = cx - (cx - px) * (nz / zoom);
    py = cy - (cy - py) * (nz / zoom);
    zoom = nz;
    state.gs.zoom = zoom; state.gs.px = px; state.gs.py = py;
    // focus card 贴着 focus node 屏幕坐标，zoom 变了要跟
    if (focused) positionFocusCard();
    if (settled) { settled = false; }
    if (!state.gaf) state.gaf = requestAnimationFrame(loop);
  };

  state.gaf = requestAnimationFrame(loop);
}

/* ── Zoom ──
 * 早先版本每次 gZoom 都调 initFG 重建整张图：focus 状态被清掉、drift 相位重摇、
 * cluster 中心点重算一次。按钮点两次就会有明显"图谱跳了一下"的闪。
 * 新实现：走 state.gs._applyZoom 原地改 zoom/px/py，交给现有 loop 自然重绘。 */
export function gZoom(f) {
  if (!state.gs) return;
  const c = state.gs.canvas; const r = c.getBoundingClientRect(); const cx = r.width / 2, cy = r.height / 2;
  const nz = Math.max(0.3, Math.min(5, state.gs.zoom * f));
  if (state.gs._applyZoom) { state.gs._applyZoom(nz, cx, cy); return; }
  // fallback：旧路径，万一 _applyZoom 没就绪
  state.gs.px = cx - (cx - state.gs.px) * (nz / state.gs.zoom);
  state.gs.py = cy - (cy - state.gs.py) * (nz / state.gs.zoom);
  state.gs.zoom = nz;
}

/* ── Search filter（replaces old topic-checkbox filter）── */
export function applyGF() {
  if (!state.gs) return;
  const sb = document.getElementById('graphSearchBox');
  const q = sb ? sb.value : '';
  if (state.gs._setSearch) state.gs._setSearch(q);
}
