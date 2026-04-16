import { $, h, api, relTime, go } from './utils.js';

/**
 * 投喂队列 topbar 入口。
 * - 轮询 /api/ingest/overview
 * - 按钮仅在有任务 / 有最近历史时显示
 * - 面板展示：summary + 正在处理 + 排队 + 最近完成
 * - 完成项点击 → 跳转文章页
 */

let pollTimer = null;
let currentInterval = 0;
let latestOverview = { running: [], queued: [], recent: [], batch: null, hasActivity: false };
let panelOpen = false;
let panelOutsideHandler = null;
let panelKeyHandler = null;
let lastRunningIds = new Set(); // 用于检测新完成项，触发轻量提醒

const FAST_INTERVAL = 2000;   // 有活动时的轮询频率
const SLOW_INTERVAL = 10000;  // 无活动（只展示历史）时
const PANEL_RECENT_LIMIT = 8;

export function initIngestQueue() {
  // 首次立即拉一次，然后启动自适应轮询
  tick();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; currentInterval = 0; }
    } else {
      tick();
    }
  });
  // 允许其他模块（ingest.js）在投喂后立刻刷新，不用等轮询
  window.refreshIngestQueue = () => tick(true);
}

async function tick(forceFast) {
  try {
    const data = await api('/api/ingest/overview');
    applyOverview(data);
  } catch {
    // 静默失败，下次再试
  }
  // 根据最新状态选择轮询频率
  const desired = (forceFast || latestOverview.hasActivity) ? FAST_INTERVAL : SLOW_INTERVAL;
  if (desired !== currentInterval) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(tick, desired);
    currentInterval = desired;
  }
}

function applyOverview(data) {
  const prev = latestOverview;
  latestOverview = data || { running: [], queued: [], recent: [], batch: null, hasActivity: false };

  // 更新 topbar 按钮状态：按钮常驻（用户可随时点开看历史），只靠红点反映进行中数量
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

  // 面板开着 → 实时重绘
  if (panelOpen) renderPanel();

  // 检测批次收尾：prev 有 running 但现在没了 → 提示
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
  // 打开时强制立刻刷一次
  tick(true);
  // 点外面关闭 + ESC 收起
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

function renderPanel() {
  const body = $('ingestQueueBody');
  if (!body) return;

  const { running = [], queued = [], recent = [], batch = null } = latestOverview;

  let html = '';

  // Summary bar（仅批次）
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

  // Running
  if (running.length > 0) {
    html += `<div class="iq-section-title">正在处理 (${running.length})</div>`;
    html += running.map(r => `
      <div class="iq-item iq-item-running">
        <span class="iq-dot iq-dot-running"></span>
        <div class="iq-item-main">
          <div class="iq-item-name">${h(r.name || '(unnamed)')}</div>
          ${r.stage ? `<div class="iq-item-sub">${h(r.stage)}</div>` : ''}
        </div>
      </div>
    `).join('');
  }

  // Queued
  if (queued.length > 0) {
    html += `<div class="iq-section-title">排队中 (${queued.length})</div>`;
    html += queued.map(q => `
      <div class="iq-item iq-item-queued">
        <span class="iq-dot iq-dot-queued"></span>
        <div class="iq-item-main">
          <div class="iq-item-name">${h(q.name || '(unnamed)')}</div>
        </div>
      </div>
    `).join('');
  }

  // Recent
  if (recent.length > 0) {
    const shown = recent.slice(0, PANEL_RECENT_LIMIT);
    html += `<div class="iq-section-title">最近完成</div>`;
    html += shown.map(r => {
      const isDone = r.status === 'done';
      const isError = r.status === 'error';
      const clickable = isDone && r.article;
      const timeText = r.finishedAt ? relTime(r.finishedAt) : '';
      return `
        <div class="iq-item iq-item-${r.status}${clickable ? ' iq-clickable' : ''}"
             ${clickable ? `data-article="${h(r.article)}"` : ''}>
          <span class="iq-dot iq-dot-${r.status}"></span>
          <div class="iq-item-main">
            <div class="iq-item-name">${h(r.name)}</div>
            ${isError ? `<div class="iq-item-sub iq-item-error">${h(r.error || '失败')}</div>` : ''}
            ${timeText ? `<div class="iq-item-time">${h(timeText)}</div>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  if (!html) {
    html = '<div class="iq-empty">暂无投喂活动</div>';
  }

  body.innerHTML = html;

  // 绑定点击跳转
  body.querySelectorAll('.iq-clickable').forEach(el => {
    el.addEventListener('click', () => {
      const path = el.dataset.article;
      if (path) { go('#/article/' + path); closePanel(); }
    });
  });
}
