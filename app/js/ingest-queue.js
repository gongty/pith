import { $, h, api, relTime, go, toast } from './utils.js';

/**
 * 投喂队列 topbar 入口。
 * - 轮询 /api/ingest/overview
 * - 按钮常驻（方便看历史）
 * - 面板展示：summary + 正在处理（带阶段进度） + 排队 + 最近完成（失败可重试）
 * - 完成项点击 → 跳转文章页
 * - 失败项点击"重试"按钮 → POST /api/ingest/retry/:id
 */

let pollTimer = null;
let currentInterval = 0;
let latestOverview = { running: [], queued: [], recent: [], batch: null, hasActivity: false, phaseTotal: 5 };
let panelOpen = false;
let panelOutsideHandler = null;
let panelKeyHandler = null;
let lastRunningIds = new Set();

const FAST_INTERVAL = 2000;
const SLOW_INTERVAL = 10000;
const PANEL_RECENT_LIMIT = 20;

export function initIngestQueue() {
  tick();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; currentInterval = 0; }
    } else {
      tick();
    }
  });
  window.refreshIngestQueue = () => tick(true);
}

async function tick(forceFast) {
  try {
    const data = await api('/api/ingest/overview');
    applyOverview(data);
  } catch {
    // 静默失败，下次再试
  }
  const desired = (forceFast || latestOverview.hasActivity) ? FAST_INTERVAL : SLOW_INTERVAL;
  if (desired !== currentInterval) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(tick, desired);
    currentInterval = desired;
  }
}

function applyOverview(data) {
  const prev = latestOverview;
  latestOverview = data || { running: [], queued: [], recent: [], batch: null, hasActivity: false, phaseTotal: 5 };

  const btn = $('ingestQueueBtn');
  if (btn) {
    const running = latestOverview.running || [];
    const queued = latestOverview.queued || [];
    const total = running.length + queued.length;
    btn.hidden = false;
    btn.classList.toggle('iq-active', running.length > 0);
    const badge = $('ingestQueueBadge');
    if (badge) {
      if (total > 0) { badge.textContent = String(total); badge.hidden = false; }
      else { badge.hidden = true; }
    }
  }

  if (panelOpen) renderPanel();

  const wasBusy = (prev.running && prev.running.length > 0) || (prev.batch && prev.batch.status === 'processing');
  const nowIdle = !latestOverview.hasActivity;
  if (wasBusy && nowIdle && prev.batch && prev.batch.total) {
    const b = prev.batch;
    const msg = `投喂完成：成功 ${b.completed - b.failed} / ${b.total}` + (b.failed ? `，失败 ${b.failed}` : '');
    import('./utils.js').then(u => u.toast(msg));
  }

  lastRunningIds = new Set((latestOverview.running || []).map(r => r.id || r.idx));
}

export function toggleIngestQueue() {
  if (panelOpen) closePanel();
  else openPanel();
}

function openPanel() {
  const panel = $('ingestQueuePanel');
  if (!panel) return;
  panel.hidden = false;
  panelOpen = true;
  renderPanel();
  tick(true);
  setTimeout(() => {
    panelOutsideHandler = (e) => {
      if (!panel.contains(e.target) && !e.target.closest('#ingestQueueBtn')) closePanel();
    };
    panelKeyHandler = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closePanel(); }
    };
    document.addEventListener('mousedown', panelOutsideHandler);
    document.addEventListener('keydown', panelKeyHandler, true);
  }, 0);
}

function closePanel() {
  const panel = $('ingestQueuePanel');
  if (panel) panel.hidden = true;
  panelOpen = false;
  if (panelOutsideHandler) {
    document.removeEventListener('mousedown', panelOutsideHandler);
    panelOutsideHandler = null;
  }
  if (panelKeyHandler) {
    document.removeEventListener('keydown', panelKeyHandler, true);
    panelKeyHandler = null;
  }
}

// 渲染阶段进度（N/5 + 进度条）
function phaseBlock(item, phaseTotal) {
  const idx = typeof item.phaseIndex === 'number' ? item.phaseIndex : 0;
  const total = item.phaseTotal || phaseTotal || 5;
  const label = item.phaseLabel || item.stage || '';
  // 展示为 (idx+1)/total — 索引 0=排队，所以正在"第 1 阶段/5 阶段"
  const display = Math.min(idx + 1, total);
  const pct = Math.round(((idx + 1) / total) * 100);
  return `
    <div class="iq-phase">
      <div class="iq-phase-text">
        <span class="iq-phase-num">${display}/${total}</span>
        <span class="iq-phase-label">${h(label)}</span>
      </div>
      <div class="iq-phase-bar"><div class="iq-phase-fill" style="width:${pct}%"></div></div>
    </div>`;
}

function renderPanel() {
  const body = $('ingestQueueBody');
  if (!body) return;

  const { running = [], queued = [], recent = [], batch = null, phaseTotal = 5 } = latestOverview;

  let html = '';

  if (batch && batch.total) {
    const pct = Math.round((batch.completed / batch.total) * 100);
    const etaText = batch.estimatedRemaining != null
      ? (batch.estimatedRemaining < 60
          ? `约 ${batch.estimatedRemaining} 秒`
          : `约 ${Math.ceil(batch.estimatedRemaining / 60)} 分钟`)
      : '计算中…';
    html += `
      <div class="iq-summary">
        <div class="iq-summary-line">
          <span>总进度 ${batch.completed}/${batch.total}</span>
          <span class="iq-summary-eta">预计 ${etaText}</span>
        </div>
        <div class="iq-progress"><div class="iq-progress-fill" style="width:${pct}%"></div></div>
        ${batch.failed ? `<div class="iq-summary-fail">失败 ${batch.failed}</div>` : ''}
      </div>`;
  }

  if (running.length > 0) {
    html += `<div class="iq-section-title">正在处理 (${running.length})</div>`;
    html += running.map(r => `
      <div class="iq-item iq-item-running">
        <span class="iq-dot iq-dot-running"></span>
        <div class="iq-item-main">
          <div class="iq-item-name">${h(r.name || '(unnamed)')}</div>
          ${phaseBlock(r, phaseTotal)}
        </div>
      </div>
    `).join('');
  }

  if (queued.length > 0) {
    html += `<div class="iq-section-title">排队中 (${queued.length})</div>`;
    html += queued.map(q => `
      <div class="iq-item iq-item-queued">
        <span class="iq-dot iq-dot-queued"></span>
        <div class="iq-item-main">
          <div class="iq-item-name">${h(q.name || '(unnamed)')}</div>
          <div class="iq-item-sub">0/${phaseTotal} · 排队中</div>
        </div>
      </div>
    `).join('');
  }

  if (recent.length > 0) {
    const shown = recent.slice(0, PANEL_RECENT_LIMIT);
    html += `<div class="iq-section-title">最近完成</div>`;
    html += shown.map(r => {
      const isDone = r.status === 'done';
      const isError = r.status === 'error';
      const clickable = isDone && r.article;
      const canRetry = isError && r.retryable;
      const timeText = r.finishedAt ? relTime(r.finishedAt) : '';
      const retryBadge = r.retryCount > 0 ? `<span class="iq-retry-badge">第 ${r.retryCount} 次重试</span>` : '';
      const interruptedTag = r.interruptedByRestart ? `<span class="iq-retry-badge">进程重启中断</span>` : '';
      const inFlightTag = r.retryInFlight ? `<span class="iq-retry-badge iq-retry-inflight">重试进行中</span>` : '';
      return `
        <div class="iq-item iq-item-${r.status}${clickable ? ' iq-clickable' : ''}"
             ${clickable ? `data-article="${h(r.article)}"` : ''}>
          <span class="iq-dot iq-dot-${r.status}"></span>
          <div class="iq-item-main">
            <div class="iq-item-name">${h(r.name)} ${retryBadge}${interruptedTag}${inFlightTag}</div>
            ${isError ? `<div class="iq-item-sub iq-item-error">${h(r.error || '失败')}</div>` : ''}
            ${timeText ? `<div class="iq-item-time">${h(timeText)}</div>` : ''}
          </div>
          ${canRetry ? `<button class="iq-retry-btn" data-retry="${h(r.id)}">重试</button>` : ''}
        </div>
      `;
    }).join('');
  }

  if (!html) {
    html = '<div class="iq-empty">暂无投喂活动</div>';
  }

  body.innerHTML = html;

  body.querySelectorAll('.iq-clickable').forEach(el => {
    el.addEventListener('click', () => {
      const path = el.dataset.article;
      if (path) { go('#/article/' + path); closePanel(); }
    });
  });
  body.querySelectorAll('.iq-retry-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.retry;
      if (!id) return;
      btn.disabled = true;
      btn.textContent = '重试中…';
      try {
        const r = await fetch('/api/ingest/retry/' + encodeURIComponent(id), { method: 'POST' });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
        toast('已重新入队');
        tick(true);
      } catch (err) {
        toast(err.message || '重试失败');
        btn.disabled = false;
        btn.textContent = '重试';
      }
    });
  });
}
