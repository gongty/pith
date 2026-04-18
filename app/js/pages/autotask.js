import { $, h, relTime, api, post, put, apiDel, toast, skelLines } from '../utils.js';
import state from '../state.js';
import { t } from '../i18n.js';

/* ── Local state ── */
const TAB_STORAGE_KEY = 'autotask.tab';
function readStoredTab() {
  try {
    const v = localStorage.getItem(TAB_STORAGE_KEY);
    return (v === 'history' || v === 'tasks') ? v : 'tasks';
  } catch (_) { return 'tasks'; }
}
let currentTab = readStoredTab();
let tasks = [];
let history = [];
let topicsList = [];
let historyRange = 7; // days: 7 | 30 | 0(all)
let watchingRunId = null;
let pollTimer = null;

/* ── Wizard (AI-driven) state ── */
let wizardStep = 1;          // 1 = intent input, 2 = preview AI draft
let wizardDraft = null;      // { name, intent, sources:[], preferences:{}, schedule, scheduleTime, topic, maxPerRun }
let wizardTaskId = null;     // taskId in edit mode
let wizardBusy = false;
let wizardIntent = '';       // textarea value cache

/* ── Source picker state ── */
let sourceLibrary = null;    // [{ id, name, description, tags:[] }]
let sourceLibraryLoaded = false;
let sourceLibraryError = null;
let sourcePickerSearch = '';
let sourcePickerSelected = new Set();
let sourcePickerOpen = false;

/* ── Per-run expansion state ── */
let expandedRuns = new Set();
let expandedTasks = new Set();
let feedbackPending = new Set(); // `${runId}:${itemUrl}` keys disabled after submit

let wizardAdvancedOpen = false;

/* ── Labels ── */
function getSourceLabels() { return { rss: t('autotask.sourceType.rss'), webpage: t('autotask.sourceType.webpage'), api: t('autotask.sourceType.api') }; }
function getScheduleLabels() { return { daily: t('autotask.schedule.daily'), hourly: t('autotask.schedule.hourly'), manual: t('autotask.schedule.manual') }; }
const STATUS_COLORS = { success: 'var(--green)', error: 'var(--red)', partial: 'var(--yellow)', running: 'var(--accent)' };

/* ── Intent presets: one-click fill common task templates
   Called as function so t() runs at render time, not import time ── */
function getIntentPresets() { return [
  { group: t('autotask.preset.group.aiMusic'), label: t('autotask.preset.aiMusicProducts'), text: t('autotask.preset.aiMusicProductsText') },
  { group: t('autotask.preset.group.aiMusic'), label: t('autotask.preset.audioVoiceModels'), text: t('autotask.preset.audioVoiceModelsText') },
  { group: t('autotask.preset.group.aiMusic'), label: t('autotask.preset.musicCreationTools'), text: t('autotask.preset.musicCreationToolsText') },
  { group: t('autotask.preset.group.aiMusic'), label: t('autotask.preset.musicIndustryCopyright'), text: t('autotask.preset.musicIndustryCopyrightText') },
  { group: t('autotask.preset.group.prodOps'), label: t('autotask.preset.aiProductReleases'), text: t('autotask.preset.aiProductReleasesText') },
  { group: t('autotask.preset.group.prodOps'), label: t('autotask.preset.aiStartupsFunding'), text: t('autotask.preset.aiStartupsFundingText') },
  { group: t('autotask.preset.group.prodOps'), label: t('autotask.preset.overseasGrowth'), text: t('autotask.preset.overseasGrowthText') },
  { group: t('autotask.preset.group.prodOps'), label: t('autotask.preset.socialAlgorithms'), text: t('autotask.preset.socialAlgorithmsText') },
  { group: t('autotask.preset.group.aiResearch'), label: t('autotask.preset.bigLabResearch'), text: t('autotask.preset.bigLabResearchText') },
  { group: t('autotask.preset.group.aiResearch'), label: t('autotask.preset.openSourceModels'), text: t('autotask.preset.openSourceModelsText') },
  { group: t('autotask.preset.group.aiResearch'), label: t('autotask.preset.agentRagMultimodal'), text: t('autotask.preset.agentRagMultimodalText') },
  { group: t('autotask.preset.group.aiResearch'), label: t('autotask.preset.videoImageAI'), text: t('autotask.preset.videoImageAIText') },
  { group: t('autotask.preset.group.tech'), label: t('autotask.preset.arxivTracking'), text: t('autotask.preset.arxivTrackingText') },
  { group: t('autotask.preset.group.tech'), label: t('autotask.preset.frontendToolchain'), text: t('autotask.preset.frontendToolchainText') }
]; }

/* ── Helpers ── */
function statusDot(enabled) {
  return '<span class="autotask-status-dot" style="background:' + (enabled ? 'var(--green)' : 'var(--fg-tertiary)') + '"></span>';
}

function scheduleText(task) {
  const labels = getScheduleLabels();
  let s = labels[task.schedule] || task.schedule || t('autotask.schedule.daily');
  if (task.schedule === 'daily' && task.scheduleTime) s += ' ' + task.scheduleTime;
  return s;
}

function runStatusText(run) {
  if (run.status === 'running') return '<span style="color:var(--accent)">' + h(t('autotask.status.running')) + '</span>';
  if (run.status === 'success') return '<span style="color:var(--green)">' + h(t('autotask.status.success')) + '</span>';
  if (run.status === 'error') return '<span style="color:var(--red)">' + h(t('autotask.status.error')) + '</span>';
  if (run.status === 'partial') return '<span style="color:var(--yellow)">' + h(t('autotask.status.partial')) + '</span>';
  return h(run.status || '');
}

function truncate(s, n) {
  s = String(s || '');
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

/* ── Next-run computation ── */
function computeNextRun(task) {
  if (!task || task.enabled === false) return null;
  if (task.schedule === 'manual') return null;
  const now = new Date();
  if (task.schedule === 'hourly') {
    const n = new Date(now);
    n.setMinutes(0, 0, 0);
    n.setHours(n.getHours() + 1);
    return n;
  }
  if (task.schedule === 'daily' || !task.schedule) {
    const [hh, mm] = String(task.scheduleTime || '08:00').split(':').map(x => parseInt(x) || 0);
    const n = new Date(now);
    n.setHours(hh, mm, 0, 0);
    if (n <= now) n.setDate(n.getDate() + 1);
    return n;
  }
  return null;
}

function formatNextRun(d) {
  if (!d) return '';
  const now = new Date();
  const diffMs = d - now;
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return t('autotask.nextMinutes', { n: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t('autotask.nextHours', { n: hours });
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return t('autotask.nextToday', { time: `${hh}:${mm}` });
  const tmr = new Date(now); tmr.setDate(tmr.getDate() + 1);
  if (d.toDateString() === tmr.toDateString()) return t('autotask.nextTomorrow', { time: `${hh}:${mm}` });
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

/* ── Recent ingested items for a task (from history) ── */
function lastRunIngested(taskId, limit) {
  const runs = history.filter(r => r.taskId === taskId && r.status !== 'error');
  for (const run of runs) {
    const items = (run.items || []).filter(it => it.status === 'ingested');
    if (items.length) return items.slice(0, limit || 3);
  }
  return [];
}

/* ── History stats over a window ── */
function computeHistoryStats(rangeDays) {
  const cutoff = rangeDays > 0 ? (Date.now() - rangeDays * 86400000) : 0;
  let runs = 0, ingested = 0, errors = 0;
  history.forEach(r => {
    const ts = r.startedAt ? new Date(r.startedAt).getTime() : 0;
    if (ts < cutoff) return;
    runs += 1;
    if (typeof r.itemsIngested === 'number') ingested += r.itemsIngested;
    if (r.status === 'error') errors += 1;
  });
  return { runs, ingested, errors };
}

/* ── Page render ── */
export async function rAutotask(c) {
  c.innerHTML = '<div class="page-autotask">' + skelLines(4) + '</div>';
  try {
    const [taskRes, histRes] = await Promise.all([
      api('/api/autotask/list'),
      api('/api/autotask/history')
    ]);
    tasks = taskRes.tasks || [];
    history = Array.isArray(histRes) ? histRes : (histRes.history || []);
    try {
      const tree = state.td || await api('/api/wiki/tree');
      state.td = tree;
      topicsList = (tree || []).map(tp => tp.name);
    } catch (_) { topicsList = []; }
    renderPage(c);
  } catch (e) {
    c.innerHTML = '<div style="text-align:center;padding:60px;color:var(--fg-tertiary)">' + h(t('autotask.loadFailed', { msg: e.message })) + '</div>';
  }
}

function renderPage(c) {
  let s = '<div class="page-autotask">';
  s += '<div class="autotask-header">';
  s += '<h1 class="autotask-title">' + h(t('autotask.title')) + '</h1>';
  const showHeaderBtn = !(currentTab === 'tasks' && tasks.length === 0) && currentTab !== 'history';
  if (showHeaderBtn) {
    s += '<button class="btn-fill" style="width:auto;padding:8px 20px;font-size:13px" onclick="openAutotaskModal()">' + h(t('autotask.createBtn')) + '</button>';
  } else {
    s += '<span></span>';
  }
  s += '</div>';
  s += '<div class="autotask-tabs">';
  s += '<button class="autotask-tab' + (currentTab === 'tasks' ? ' active' : '') + '" onclick="switchAutotaskTab(\'tasks\')">' + h(t('autotask.tabTasks')) + '</button>';
  s += '<button class="autotask-tab' + (currentTab === 'history' ? ' active' : '') + '" onclick="switchAutotaskTab(\'history\')">' + h(t('autotask.tabHistory')) + '</button>';
  s += '</div>';
  if (currentTab === 'tasks') s += renderTaskList();
  else s += renderHistory();
  s += '</div>';
  c.innerHTML = s;
}

/* ── Task list ── */
function renderTaskList() {
  if (!tasks.length) {
    return '<div class="autotask-empty">'
      + '<div class="autotask-empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg></div>'
      + '<p class="autotask-empty-title">' + h(t('autotask.emptyTitle')) + '</p>'
      + '<p class="autotask-empty-desc">' + h(t('autotask.emptyDesc')) + '</p>'
      + '<button class="btn-fill" style="width:auto;padding:10px 24px" onclick="openAutotaskModal()">' + h(t('autotask.createBtn')) + '</button>'
      + '</div>';
  }
  let s = '<div class="autotask-cards">';
  tasks.forEach(tk => {
    const sources = Array.isArray(tk.sources) ? tk.sources : [];
    const tagSet = new Set();
    sources.forEach(src => {
      const tags = Array.isArray(src && src.tags) ? src.tags : [];
      tags.forEach(tg => tagSet.add(tg));
    });
    const tagsArr = Array.from(tagSet);
    const recent = lastRunIngested(tk.id, 3);
    const hasExpandable = recent.length || tagsArr.length || (tk.provider && tk.model);
    const isExpanded = expandedTasks.has(tk.id);
    const intent = tk.intent || (tk.sourceConfig && tk.sourceConfig.url) || '';

    s += '<div class="autotask-card' + (isExpanded ? ' expanded' : '') + '">';

    s += '<div class="autotask-card-head">';
    s += statusDot(tk.enabled !== false);
    s += '<span class="autotask-card-name">' + h(tk.name || t('autotask.unnamed')) + '</span>';
    if (sources.length) {
      s += '<span class="autotask-card-srcbadge" title="' + h(t('autotask.sourceCountTitle', { n: sources.length })) + '">' + h(t('autotask.sourceCount', { n: sources.length })) + '</span>';
    } else if (tk.sourceType) {
      const srcLabels = getSourceLabels();
      s += '<span class="autotask-card-srcbadge">' + h(srcLabels[tk.sourceType] || tk.sourceType) + '</span>';
    }
    s += '<label class="autotask-toggle" onclick="event.stopPropagation()">';
    s += '<input type="checkbox"' + (tk.enabled !== false ? ' checked' : '') + ' onchange="toggleAutotaskEnabled(\'' + h(tk.id) + '\')">';
    s += '<span class="autotask-toggle-slider"></span>';
    s += '</label>';
    s += '</div>';

    if (intent) {
      s += '<div class="autotask-card-intent" title="' + h(intent) + '">' + h(intent) + '</div>';
    }

    const nr = computeNextRun(tk);
    const nextText = nr ? t('autotask.nextPrefix', { time: formatNextRun(nr) })
      : (tk.schedule === 'manual' ? t('autotask.status.manualOnly') : (tk.enabled === false ? t('autotask.status.disabled') : ''));
    if (tk.lastRunAt || nextText) {
      s += '<div class="autotask-card-health">';
      if (tk.lastRunAt) {
        const stColor = tk.lastRunStatus === 'success' ? 'var(--green)' : tk.lastRunStatus === 'error' ? 'var(--red)' : tk.lastRunStatus === 'partial' ? 'var(--yellow)' : 'var(--fg-tertiary)';
        const statusKey = 'autotask.status.' + (tk.lastRunStatus || 'unknown');
        const stLabel = t(statusKey);
        s += '<span class="autotask-card-health-run"><span class="autotask-card-health-dot" style="background:' + stColor + '"></span>'
          + h(stLabel) + ' · ' + h(relTime(tk.lastRunAt)) + '</span>';
      } else {
        s += '<span class="autotask-card-health-run autotask-card-health-idle">' + h(t('autotask.neverRun')) + '</span>';
      }
      if (nextText) {
        s += '<span class="autotask-card-health-sep">·</span>';
        s += '<span class="autotask-card-health-next">' + h(nextText) + '</span>';
      }
      s += '</div>';
    }

    if (hasExpandable) {
      s += '<div class="autotask-card-expand">';
      if (recent.length) {
        s += '<div class="autotask-card-preview">';
        s += '<div class="autotask-card-preview-label">' + h(t('autotask.lastIngested', { n: recent.length })) + '</div>';
        s += '<ul class="autotask-card-preview-list">';
        recent.forEach(it => {
          const title = h(it.title || t('autotask.noTitle'));
          if (it.articlePath) {
            s += '<li><a href="#/article/' + h(it.articlePath) + '" onclick="event.stopPropagation()">' + title + '</a></li>';
          } else {
            s += '<li>' + title + '</li>';
          }
        });
        s += '</ul>';
        s += '</div>';
      }
      if (tagsArr.length) {
        s += '<div class="autotask-card-expand-row"><span class="autotask-card-expand-label">' + h(t('autotask.labelTags')) + '</span>';
        tagsArr.forEach(tg => { s += '<span class="autotask-source-chip">' + h(tg) + '</span>'; });
        s += '</div>';
      }
      if (tk.provider && tk.model) {
        s += '<div class="autotask-card-expand-row"><span class="autotask-card-expand-label">' + h(t('autotask.labelModel')) + '</span>'
          + '<span class="autotask-model-badge" title="' + h(t('autotask.modelBadgeTitle')) + '">' + h(tk.model) + '</span></div>';
      }
      s += '</div>';
    }

    s += '<div class="autotask-card-actions">';
    if (hasExpandable) {
      s += '<button class="autotask-action-btn autotask-action-expand' + (isExpanded ? ' is-open' : '') + '" onclick="toggleTaskExpand(\'' + h(tk.id) + '\')" title="' + (isExpanded ? h(t('autotask.collapse')) : h(t('autotask.expand'))) + '">'
        + (isExpanded ? h(t('autotask.collapse')) : h(t('autotask.expand')))
        + '<svg class="autotask-action-expand-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
        + '</button>';
    }
    s += '<button class="autotask-action-btn" onclick="runAutotask(\'' + h(tk.id) + '\')" title="' + h(t('autotask.actionRunTitle')) + '">' + h(t('autotask.actionRun')) + '</button>';
    s += '<button class="autotask-action-btn" onclick="openAutotaskModal(\'' + h(tk.id) + '\')" title="' + h(t('autotask.actionEdit')) + '">' + h(t('autotask.actionEdit')) + '</button>';
    s += '<button class="autotask-action-btn autotask-action-del" onclick="deleteAutotask(\'' + h(tk.id) + '\')" title="' + h(t('autotask.actionDelete')) + '">' + h(t('autotask.actionDelete')) + '</button>';
    s += '</div>';
    s += '</div>';
  });
  s += '</div>';
  return s;
}

export function toggleTaskExpand(taskId) {
  if (expandedTasks.has(taskId)) expandedTasks.delete(taskId);
  else expandedTasks.add(taskId);
  const c = $('content');
  if (c) renderPage(c);
}

/* ── History list ── */
function renderHistory() {
  if (!history.length) {
    return '<div class="autotask-empty">'
      + '<div class="autotask-empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg></div>'
      + '<p class="autotask-empty-title">' + h(t('autotask.emptyHistoryTitle')) + '</p>'
      + '<p class="autotask-empty-desc">' + h(t('autotask.emptyHistoryDesc')) + '</p>'
      + '</div>';
  }
  const stats = computeHistoryStats(historyRange);
  const rangeLabelKey = historyRange === 7 ? 'autotask.historyRangeLabel7' : historyRange === 30 ? 'autotask.historyRangeLabel30' : 'autotask.historyRangeLabelAll';
  const rangeLabel = t(rangeLabelKey);
  let s = '<div class="autotask-history-summary">';
  s += '<div class="autotask-history-summary-stats">';
  s += '<span class="autotask-history-stat"><span class="autotask-history-stat-num">' + stats.runs + '</span><span class="autotask-history-stat-lbl">' + h(rangeLabel) + h(t('autotask.historyRuns')) + '</span></span>';
  s += '<span class="autotask-history-stat"><span class="autotask-history-stat-num">' + stats.ingested + '</span><span class="autotask-history-stat-lbl">' + h(t('autotask.historyIngested')) + '</span></span>';
  s += '<span class="autotask-history-stat"><span class="autotask-history-stat-num" style="color:' + (stats.errors > 0 ? 'var(--red)' : 'var(--fg-secondary)') + '">' + stats.errors + '</span><span class="autotask-history-stat-lbl">' + h(t('autotask.historyErrors')) + '</span></span>';
  s += '</div>';
  s += '<div class="autotask-history-range">';
  [[7, t('autotask.historyRange7')], [30, t('autotask.historyRange30')], [0, t('autotask.historyRangeAll')]].forEach(([v, lbl]) => {
    s += '<button class="autotask-history-range-btn' + (historyRange === v ? ' active' : '') + '" onclick="switchHistoryRange(' + v + ')">' + h(lbl) + '</button>';
  });
  s += '</div>';
  s += '</div>';

  const cutoff = historyRange > 0 ? (Date.now() - historyRange * 86400000) : 0;
  const rows = history.filter(r => {
    const ts = r.startedAt ? new Date(r.startedAt).getTime() : 0;
    return ts >= cutoff;
  });
  if (!rows.length) {
    s += '<div class="autotask-empty" style="padding:40px 20px"><p class="autotask-empty-desc">' + h(t('autotask.emptyRange', { range: rangeLabel })) + '</p></div>';
    return s;
  }
  rows.sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (b.status === 'running' && a.status !== 'running') return 1;
    return new Date(b.startedAt || 0) - new Date(a.startedAt || 0);
  });
  s += '<div class="autotask-history-list">';
  rows.forEach(run => {
    s += renderRunSummaryCard(run);
  });
  s += '</div>';
  return s;
}

function renderRunSummaryCard(run) {
  const runId = run.id || run.runId;
  const isRunning = run.status === 'running';
  const isWatching = isRunning && runId === watchingRunId;
  const dotColor = STATUS_COLORS[run.status] || 'var(--fg-tertiary)';
  const dimClass = (!isRunning && (run.status === 'error' || run.itemsIngested === 0)) ? ' dim' : '';
  const runningClass = isRunning ? ' running' : '';
  const watchingClass = isWatching ? ' watching' : '';
  const expanded = expandedRuns.has(runId);

  // Time + duration
  const ts = run.startedAt ? new Date(run.startedAt) : null;
  const tsStr = ts ? `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')} ${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}` : '-';
  let durStr = '';
  if (run.startedAt && run.finishedAt) {
    const ms = new Date(run.finishedAt) - new Date(run.startedAt);
    if (ms > 0) durStr = (ms / 1000).toFixed(1) + 's';
  }
  const statusLabelMap = { success: t('autotask.status.success'), error: t('autotask.status.error'), partial: t('autotask.status.partial'), running: t('autotask.status.running') };
  const statusLabel = statusLabelMap[run.status] || (run.status || t('autotask.status.unknown'));

  // Precompute counts / sources / reasons for non-running rows
  const found = run.itemsFound != null ? run.itemsFound : (run.items ? run.items.length : 0);
  const ingested = run.itemsIngested != null ? run.itemsIngested : (run.items || []).filter(x => x.status === 'ingested').length;
  const skipped = run.itemsSkipped != null ? run.itemsSkipped : (run.items || []).filter(x => x.status === 'skipped' || x.status === 'gated_out').length;
  let okCount = 0, failed = [], totalSrc = 0;
  if (run.sourceStatus && typeof run.sourceStatus === 'object') {
    const entries = Object.entries(run.sourceStatus);
    totalSrc = entries.length;
    okCount = entries.filter(([, v]) => v && v.status === 'ok').length;
    failed = entries.filter(([, v]) => v && v.status === 'error');
  }
  const topReasons = isRunning ? [] : computeTopReasons(run);

  let s = '<div class="autotask-history-row' + dimClass + runningClass + watchingClass + (expanded ? ' expanded' : '') + '" data-run-id="' + h(runId || '') + '">';

  // Head row: 状态点 · 任务名 · 状态文案 · 入库大号 · 时间/耗时 · 展开
  s += '<div class="autotask-history-head">';
  if (isRunning) {
    s += '<span class="autotask-status-dot pulsing" style="background:' + dotColor + '"></span>';
  } else {
    s += '<span class="autotask-status-dot" style="background:' + dotColor + '"></span>';
  }
  if (isRunning) {
    s += '<span class="autotask-running-badge">' + h(t('autotask.runBadge')) + '</span>';
  }
  s += '<span class="autotask-history-name">' + h(run.taskName || t('autotask.unknownTask'));
  if (run.status !== 'success' && !isRunning) {
    s += ' <span class="autotask-history-status" style="color:' + dotColor + '">· ' + h(statusLabel) + '</span>';
  }
  s += '</span>';
  if (!isRunning && ingested > 0) {
    s += '<span class="autotask-history-ingested">' + h(t('autotask.ingestedCount', { n: ingested })) + '</span>';
  }
  s += '<span class="autotask-history-time">' + h(relTime(run.startedAt));
  if (durStr && !isRunning) s += ' · ' + h(durStr);
  s += '</span>';
  // Expand chevron (non-running only) - 移动到头行末尾而不是单独的 actions 行
  if (!isRunning) {
    s += '<button class="autotask-history-chevron' + (expanded ? ' is-open' : '') + '" onclick="toggleRunExpand(\'' + h(runId) + '\')" title="' + (expanded ? h(t('autotask.collapse')) : h(t('autotask.expand'))) + '">'
      + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
      + '</button>';
  }
  s += '</div>';

  if (isRunning) {
    // 保持原有 running UI
    const prog = run.progress || { phase: 'fetching', current: 0, total: 0, currentTitle: null };
    const phaseLabel = prog.phase === 'fetching' ? t('autotask.phaseFetching') : prog.phase === 'filtering' ? t('autotask.phaseFiltering') : t('autotask.phaseProcessing');
    const total = prog.total || 0;
    const cur = prog.current || 0;
    const pct = total > 0 ? Math.min(100, Math.round((cur / total) * 100)) : (prog.phase === 'fetching' ? 10 : 5);
    s += '<div class="autotask-progress-bar"><div class="autotask-progress-fill" style="width:' + pct + '%"></div></div>';
    s += '<div class="autotask-history-meta">';
    if (prog.phase === 'processing' && total > 0) s += h(phaseLabel) + ' ' + cur + '/' + total;
    else s += h(phaseLabel);
    if (run.itemsIngested) s += ' · ' + h(t('autotask.progressIngested', { n: run.itemsIngested }));
    if (run.itemsSkipped) s += ' · ' + h(t('autotask.progressSkipped', { n: run.itemsSkipped }));
    if (prog.currentTitle) s += '<div class="autotask-progress-current">' + h(t('autotask.progressCurrent', { title: prog.currentTitle.length > 80 ? prog.currentTitle.slice(0, 78) + '...' : prog.currentTitle })) + '</div>';
    s += '</div>';
  } else {
    // 失败或需要一眼看到信息时才渲染副行（非 noise）
    const subParts = [];
    // 错误消息：折叠态截断显示，展开看完整
    if (run.error) {
      const errShort = truncate(run.error, 120);
      subParts.push('<span class="autotask-history-sub-err">' + h(t('autotask.errorPrefix', { msg: errShort })) + '</span>');
    }
    // 有过滤/跳过数据时展示
    if (!run.error && (found > 0 || skipped > 0)) {
      const parts = [];
      parts.push(t('autotask.considered', { n: found }));
      if (skipped > 0) parts.push(t('autotask.skipped', { n: skipped }));
      subParts.push('<span class="autotask-history-sub-counts">' + h(parts.join(' · ')) + '</span>');
    }
    // 源状态：仅当有失败或部分失败时才展示，全 OK 不占位置
    if (failed.length > 0) {
      subParts.push('<span class="autotask-history-sub-src autotask-history-sub-src-bad">' + h(t('autotask.sourceStat', { ok: okCount, total: totalSrc })) + ' · ' + h(t('autotask.sourceStatFailed', { n: failed.length })) + '</span>');
    }
    // brief link
    if (run.briefPath) {
      subParts.push('<a class="autotask-history-sub-brief" href="#/article/' + h(run.briefPath) + '">' + h(t('autotask.briefLink')) + '</a>');
    }
    if (subParts.length) {
      s += '<div class="autotask-history-sub">' + subParts.join('<span class="autotask-history-sub-sep">·</span>') + '</div>';
    }

    // Expand area
    if (expanded) {
      s += '<div class="autotask-history-expand">';
      s += '<div class="autotask-history-expand-line"><span class="autotask-history-expand-lbl">' + h(t('autotask.expandTime')) + '</span>' + h(tsStr) + (durStr ? ' · ' + h(t('autotask.expandDuration', { dur: durStr })) : '') + '</div>';
      s += '<div class="autotask-history-expand-line"><span class="autotask-history-expand-lbl">' + h(t('autotask.expandCounts')) + '</span>' + h(t('autotask.expandCountDetail', { found, ingested, skipped })) + '</div>';
      if (run.error) {
        s += '<div class="autotask-history-expand-line autotask-history-expand-err"><span class="autotask-history-expand-lbl">' + h(t('autotask.expandError')) + '</span>' + h(run.error) + '</div>';
      }
      if (topReasons.length) {
        s += '<div class="autotask-history-expand-line"><span class="autotask-history-expand-lbl">' + h(t('autotask.expandSkipReasons')) + '</span>';
        s += topReasons.map(r => '<span class="autotask-source-chip">' + h(r.label) + ' · ' + r.count + '</span>').join('');
        s += '</div>';
      }
      if (failed.length > 0) {
        s += '<div class="autotask-history-expand-line"><span class="autotask-history-expand-lbl">' + h(t('autotask.expandFailedSources')) + '</span><ul class="autotask-history-expand-sources">';
        failed.forEach(([id, v]) => {
          s += '<li>' + h(id) + ': ' + h(truncate(v.error || t('autotask.expandUnknownError'), 120)) + '</li>';
        });
        s += '</ul></div>';
      }
      if (totalSrc > 0 && failed.length === 0) {
        s += '<div class="autotask-history-expand-line"><span class="autotask-history-expand-lbl">' + h(t('autotask.expandSourcesOk')) + '</span>' + okCount + '/' + totalSrc + ' OK</div>';
      }
      // per-item
      if ((run.items || []).length) s += renderRunItems(run);
      s += '</div>';
    }
  }

  s += '</div>';
  return s;
}

function computeTopReasons(run) {
  // Prefer server-supplied list (server writes `topGatedReasons` with `{reason, count}`).
  // Tolerate the older `gatedOutTopReasons` / `r.label` shapes for back-compat.
  const serverList = run.topGatedReasons || run.gatedOutTopReasons;
  if (Array.isArray(serverList) && serverList.length) {
    return serverList.slice(0, 3).map(r => ({
      label: r.reason || r.label || t('autotask.otherReason'),
      count: r.count || 0
    }));
  }
  // Client-side cluster from items
  const items = run.items || [];
  const counter = new Map();
  items.forEach(it => {
    if (it.status === 'skipped' || it.status === 'gated_out') {
      const k = (it.reason || t('autotask.otherReason')).slice(0, 40);
      counter.set(k, (counter.get(k) || 0) + 1);
    }
  });
  const arr = Array.from(counter.entries()).map(([label, count]) => ({ label, count }));
  arr.sort((a, b) => b.count - a.count);
  return arr.slice(0, 3);
}

function renderRunItems(run) {
  const items = run.items || [];
  if (!items.length) return '';
  const runId = run.id || run.runId;
  const taskId = run.taskId;
  let s = '<div class="autotask-run-items">';
  items.forEach(it => {
    const status = it.status || 'unknown';
    const isBrief = status === 'brief' || it.type === 'brief';
    const isCompileError = status === 'compile_error';
    const isPending = status === 'kept_pending' || status === 'smart_fill_pending';
    // Treat as smart_fill (terminal/visible row) only when actually finalized,
    // not while still pending — otherwise the pending-branch below is unreachable
    // because isSmartFill catches first.
    const isSmartFill = (!!it.smartFill || status === 'smart_fill') && !isPending;
    const isGated = status === 'skipped' || status === 'gated_out';
    const isIngested = status === 'ingested';
    const titleStr = h(it.title || t('autotask.noTitle'));
    // Brief row: title 指向简报文章; compile_error: 可点原 URL; 其他沿用现有逻辑
    let titleHtml;
    if (isBrief && it.articlePath) {
      titleHtml = '<a href="#/article/' + h(it.articlePath) + '">' + titleStr + '</a>';
    } else if (isCompileError) {
      titleHtml = it.url
        ? '<a href="' + h(it.url) + '" target="_blank" rel="noopener">' + titleStr + '</a>'
        : titleStr;
    } else {
      titleHtml = it.articlePath
        ? '<a href="#/article/' + h(it.articlePath) + '">' + titleStr + '</a>'
        : (it.url ? '<a href="' + h(it.url) + '" target="_blank" rel="noopener">' + titleStr + '</a>' : titleStr);
    }
    const itemKey = (taskId || '') + ':' + (runId || '') + ':' + (it.url || it.title || '');
    const fbKey = runId + ':' + (it.url || it.title || '');
    const fbDisabled = feedbackPending.has(fbKey);
    const upKey = fbDisabled ? ' disabled' : '';

    let rowClass = 'autotask-run-item';
    if (isBrief) rowClass += ' brief';
    else if (isCompileError) rowClass += ' error';
    else if (isGated) rowClass += ' gated';
    else if (isSmartFill) rowClass += ' smart-fill';

    s += '<div class="' + rowClass + '">';

    // Brief 分支最优先:只渲染 badge + title,不走任何反馈/后续逻辑
    if (isBrief) {
      s += '<span class="autotask-run-item-badge-brief">' + h(t('autotask.badgeBrief')) + '</span>';
      s += '<span class="autotask-run-item-title">' + titleHtml + '</span>';
      s += '</div>';
      void itemKey;
      return;
    }

    // compile_error:红字错误文案 + 可选原始素材链接,不渲染反馈按钮
    if (isCompileError) {
      s += '<span class="autotask-run-item-title">' + titleHtml + '</span>';
      let errText = it.reason ? t('autotask.compileFailedReason', { reason: truncate(it.reason, 60) }) : t('autotask.compileFailed');
      s += '<span class="autotask-run-item-reason" style="color:var(--red)">' + h(errText) + '</span>';
      if (it.rawArchivePath) {
        s += '<a class="autotask-run-item-raw" href="/raw/' + h(it.rawArchivePath) + '" target="_blank" rel="noopener">' + h(t('autotask.viewRawMaterial')) + '</a>';
      }
      s += '</div>';
      void itemKey;
      return;
    }

    if (isSmartFill) s += '<span class="autotask-item-badge">' + h(t('autotask.badgeSmartFill')) + '</span>';
    s += '<span class="autotask-run-item-title">' + titleHtml + '</span>';

    if (isIngested) {
      if (typeof it.confidence === 'number') {
        s += '<span class="autotask-run-item-conf">confidence: ' + it.confidence.toFixed(2) + '</span>';
      }
      // Up + Down buttons
      s += '<span class="autotask-feedback-actions">';
      s += '<button class="autotask-fb-btn" title="' + h(t('autotask.feedbackWantMore')) + '"' + upKey + ' onclick="submitFeedback(\'' + h(taskId || '') + '\',\'' + h(runId || '') + '\',\'' + escapeAttr(it.url || it.title || '') + '\',\'up\',this)">\u2191</button>';
      s += '<button class="autotask-fb-btn" title="' + h(t('autotask.feedbackDontWant')) + '"' + upKey + ' onclick="submitFeedback(\'' + h(taskId || '') + '\',\'' + h(runId || '') + '\',\'' + escapeAttr(it.url || it.title || '') + '\',\'down\',this)">\u2193</button>';
      s += '</span>';
    } else if (isGated) {
      if (it.reason) s += '<span class="autotask-run-item-reason">' + h(truncate(it.reason, 40)) + '</span>';
      s += '<span class="autotask-feedback-actions">';
      s += '<button class="autotask-fb-btn"' + upKey + ' title="' + h(t('autotask.feedbackActuallyWant')) + '" onclick="submitFeedback(\'' + h(taskId || '') + '\',\'' + h(runId || '') + '\',\'' + escapeAttr(it.url || it.title || '') + '\',\'up\',this)">\u2191 ' + h(t('autotask.feedbackActuallyWant')) + '</button>';
      s += '</span>';
    } else if (isSmartFill) {
      s += '<span class="autotask-feedback-actions">';
      s += '<button class="autotask-fb-btn"' + upKey + ' title="' + h(t('autotask.feedbackDontWant')) + '" onclick="submitFeedback(\'' + h(taskId || '') + '\',\'' + h(runId || '') + '\',\'' + escapeAttr(it.url || it.title || '') + '\',\'down\',this)">\u2193</button>';
      s += '</span>';
    } else if (status === 'kept_pending' || status === 'smart_fill_pending') {
      // In-flight: gate passed, processing not done yet
      s += '<span class="autotask-run-item-reason autotask-run-item-pending">' + h(t('autotask.itemPending')) + '</span>';
      if (typeof it.confidence === 'number') {
        s += '<span class="autotask-run-item-conf">confidence: ' + it.confidence.toFixed(2) + '</span>';
      }
    } else if (status === 'fetch_error') {
      s += '<span class="autotask-run-item-reason" style="color:var(--red)">' + (it.reason ? h(t('autotask.fetchFailedReason', { reason: truncate(it.reason, 40) })) : h(t('autotask.fetchFailed'))) + '</span>';
    } else {
      // unknown
      if (it.reason) s += '<span class="autotask-run-item-reason">' + h(truncate(it.reason, 40)) + '</span>';
    }
    s += '</div>';
    void itemKey;
  });
  s += '</div>';
  return s;
}

// Escape a string so it is safe inside an inline-onclick JS single-quoted
// string literal whose *host* is an HTML double-quoted attribute. Browsers
// HTML-decode attribute values before the JS is parsed, so entity-encoding
// a `'` as `&#39;` is NOT sufficient — it decodes back to `'` and breaks
// out of the JS string. We therefore emit *JS-level* Unicode escapes, which
// survive HTML decoding and remain inert inside a JS string literal.
// Also escape `\`, CR, LF, `<`/`>` (latter to prevent any attribute parser
// oddities if the value is ever rendered in an HTML attribute elsewhere).
function escapeAttr(s) {
  return String(s || '')
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
}

/* ── Toggle expand ── */
export function toggleRunExpand(runId) {
  if (expandedRuns.has(runId)) expandedRuns.delete(runId);
  else expandedRuns.add(runId);
  const c = $('content');
  if (c) renderPage(c);
}

/* ── Feedback submit ── */
export async function submitFeedback(taskId, runId, itemUrl, action, btnEl) {
  const fbKey = runId + ':' + itemUrl;
  if (feedbackPending.has(fbKey)) return;
  feedbackPending.add(fbKey);
  // Disable both buttons in the row
  if (btnEl && btnEl.parentElement) {
    btnEl.parentElement.querySelectorAll('button').forEach(b => { b.disabled = true; });
  }
  try {
    await post('/api/autotask/feedback', { taskId, runId, itemUrl, action });
    toast(t('autotask.feedbackRecorded'));
  } catch (e) {
    toast(t('autotask.feedbackNotReady'));
    feedbackPending.delete(fbKey);
    if (btnEl && btnEl.parentElement) {
      btnEl.parentElement.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
  }
}

export function switchHistoryRange(days) {
  historyRange = days;
  const c = $('content');
  if (c) renderPage(c);
}

export function switchAutotaskTab(tab) {
  currentTab = tab;
  try { localStorage.setItem(TAB_STORAGE_KEY, tab); } catch (_) {}
  const c = $('content');
  if (c) renderPage(c);
}

/* ── Modal: open/close ── */
export function openAutotaskModal(taskId) {
  wizardTaskId = taskId || null;
  wizardStep = 1;
  wizardDraft = null;
  wizardBusy = false;
  wizardIntent = '';

  const modal = $('autotaskModal');
  const title = $('autotaskModalTitle');
  if (!modal) return;

  if (taskId) {
    const task = tasks.find(tk => tk.id === taskId);
    title.textContent = t('autotask.wizard.editTitle');
    if (task) {
      // Pre-fill draft from task to land on step 2 directly
      wizardIntent = task.intent || '';
      wizardDraft = {
        name: task.name || '',
        intent: task.intent || '',
        sources: Array.isArray(task.sources) ? JSON.parse(JSON.stringify(task.sources)) : [],
        preferences: task.preferences ? JSON.parse(JSON.stringify(task.preferences)) : { expanded_keywords: [], style_hint: '', must_exclude: [] },
        schedule: task.schedule || 'daily',
        scheduleTime: task.scheduleTime || '09:00',
        topic: task.topic || 'auto',
        maxPerRun: task.maxPerRun || (task.sourceConfig && task.sourceConfig.maxItems) || 10,
        provider: task.provider || null,
        model: task.model || null
      };
      wizardStep = 2;
    }
  } else {
    title.textContent = t('autotask.wizard.createTitle');
  }

  if (wizardStep === 2 && wizardDraft) renderWizardStep2();
  else renderWizardStep1();
  modal.classList.add('open');
}

export function closeAutotaskModal() {
  const modal = $('autotaskModal');
  if (modal) modal.classList.remove('open');
  wizardStep = 1;
  wizardDraft = null;
  wizardTaskId = null;
  wizardBusy = false;
  wizardIntent = '';
  // Also close source picker if open
  if (sourcePickerOpen) closeSourcePicker();
}

/* ── Step 1: intent textarea ── */
function renderWizardStep1() {
  const wiz = $('autotaskWizard');
  if (!wiz) return;
  let s = '<div class="autotask-wizard-step1">';
  s += '<div class="autotask-intent-label">' + h(t('autotask.wizard.intentLabel')) + '</div>';
  s += '<div class="autotask-nl-section">';
  s += '<textarea class="autotask-nl-textarea" id="autotaskIntentInput" rows="4" placeholder="' + h(t('autotask.wizard.intentPlaceholder')) + '" oninput="window._autotaskIntentChange&&window._autotaskIntentChange(this.value)">' + h(wizardIntent) + '</textarea>';
  s += '</div>';

  // Preset chips: one-click fill the textarea. Grouped by topic.
  s += '<div class="autotask-intent-presets">';
  s += '<div class="autotask-intent-presets-label">' + h(t('autotask.wizard.presetHint')) + '</div>';
  // Preserve original order while grouping by `group` field
  const _groupOrder = [];
  const _grouped = new Map();
  getIntentPresets().forEach((p, i) => {
    const g = p.group || t('autotask.source.otherGroup');
    if (!_grouped.has(g)) { _grouped.set(g, []); _groupOrder.push(g); }
    _grouped.get(g).push({ p, i });
  });
  _groupOrder.forEach(g => {
    s += '<div class="autotask-intent-presets-group">';
    s += '<div class="autotask-intent-presets-group-title">' + h(g) + '</div>';
    s += '<div class="autotask-intent-presets-row">';
    _grouped.get(g).forEach(({ p, i }) => {
      s += '<button class="autotask-intent-preset-chip" type="button"' + (wizardBusy ? ' disabled' : '') + ' onclick="pickAutotaskIntentPreset(' + i + ')">' + h(p.label) + '</button>';
    });
    s += '</div>';
    s += '</div>';
  });
  s += '</div>';

  if (wizardBusy) {
    s += '<div class="autotask-loading-msg">' + h(t('autotask.wizard.aiPickingSources')) + '</div>';
  }

  s += '</div>';

  // Footer
  s += '<div class="autotask-wizard-footer">';
  s += '<button class="btn-outline" onclick="closeAutotaskModal()">' + h(t('common.cancel')) + '</button>';
  s += '<button class="btn-sm-fill" id="autotaskConfigureBtn"' + (wizardBusy ? ' disabled' : '') + ' onclick="submitConfigureIntent()">' + (wizardBusy ? h(t('autotask.wizard.configuring')) : h(t('autotask.wizard.configureBtn'))) + '</button>';
  s += '</div>';

  wiz.innerHTML = s;
  window._autotaskIntentChange = (v) => { wizardIntent = v; };

  // Also disable textarea when busy
  if (wizardBusy) {
    const ta = $('autotaskIntentInput');
    if (ta) ta.disabled = true;
  }
}

/* ── Pick a preset: fill textarea + sync state ── */
export function pickAutotaskIntentPreset(idx) {
  if (wizardBusy) return;
  const preset = getIntentPresets()[idx];
  if (!preset) return;
  wizardIntent = preset.text;
  const ta = $('autotaskIntentInput');
  if (ta) {
    ta.value = preset.text;
    ta.focus();
    // Move caret to end so user sees full text + can continue editing
    try { ta.setSelectionRange(preset.text.length, preset.text.length); } catch (_) {}
  }
}

/* ── Step 1 → Step 2: AI configure ── */
export async function submitConfigureIntent() {
  if (wizardBusy) return;
  const intent = (wizardIntent || '').trim();
  if (!intent) { toast(t('autotask.wizard.describeEmpty')); return; }
  wizardBusy = true;
  renderWizardStep1();
  try {
    const body = { intent };
    if (wizardTaskId && wizardDraft) body.current = wizardDraft;
    const res = await postRaw('/api/autotask/configure', body);
    if (!res || !res.ok) throw new Error((res && res.error) || t('autotask.wizard.aiConfigError'));
    const cfg = res.config || res;
    wizardDraft = {
      name: cfg.name || t('autotask.wizard.defaultName'),
      intent,
      sources: Array.isArray(cfg.sources) ? cfg.sources : [],
      preferences: cfg.preferences || { expanded_keywords: [], style_hint: '', must_exclude: [] },
      schedule: cfg.schedule || 'daily',
      scheduleTime: cfg.scheduleTime || '09:00',
      topic: cfg.topic || 'auto',
      maxPerRun: cfg.maxPerRun || 10,
      provider: cfg.provider || null,
      model: cfg.model || null
    };
    wizardBusy = false;
    wizardStep = 2;
    renderWizardStep2();
  } catch (e) {
    wizardBusy = false;
    toast(t('autotask.wizard.configureFailed', { msg: e.message || '' }));
    renderWizardStep1();
  }
}

/* ── Step 2: preview AI's draft ── */
function renderWizardStep2() {
  const wiz = $('autotaskWizard');
  if (!wiz || !wizardDraft) return;
  const d = wizardDraft;

  let s = '<div class="autotask-wizard-step2">';

  // Task name
  s += '<div class="autotask-section">';
  s += '<label class="autotask-section-label">' + h(t('autotask.wizard.taskName')) + '</label>';
  s += '<input class="autotask-input" id="autotaskNameInput" type="text" value="' + h(d.name || '') + '" oninput="window._autotaskNameChange&&window._autotaskNameChange(this.value)">';
  s += '</div>';

  // Sources chips
  s += '<div class="autotask-section">';
  s += '<label class="autotask-section-label">' + h(t('autotask.wizard.matchedSources', { n: (d.sources || []).length })) + '</label>';
  s += '<div class="autotask-source-list">';
  (d.sources || []).forEach((src, idx) => {
    const name = src.label || src.name || src.id || t('autotask.wizard.unnamedSource');
    s += '<span class="autotask-source-tag">';
    s += '<span class="autotask-source-tag-name">' + h(name) + '</span>';
    s += '<button class="autotask-source-tag-x" title="' + h(t('autotask.wizard.removeSource')) + '" onclick="removeSourceFromDraft(' + idx + ')">×</button>';
    s += '</span>';
  });
  s += '<button class="autotask-add-source-btn" onclick="openSourcePicker()">' + h(t('autotask.wizard.addMoreSources')) + '</button>';
  s += '</div>';
  s += '</div>';

  // LLM smart filter (locked ON)
  s += '<div class="autotask-section autotask-section-row">';
  s += '<label class="autotask-section-label">' + h(t('autotask.wizard.llmFilter')) + '</label>';
  s += '<span class="autotask-toggle-locked"><span class="autotask-toggle-locked-dot"></span>ON</span>';
  s += '</div>';

  // Expanded keywords (info-only chips)
  const exKw = (d.preferences && d.preferences.expanded_keywords) || [];
  if (exKw.length) {
    s += '<div class="autotask-section">';
    s += '<label class="autotask-section-label">' + h(t('autotask.wizard.expandedKeywords')) + '</label>';
    s += '<div class="autotask-keyword-chips">';
    exKw.forEach(kw => {
      s += '<span class="autotask-keyword-chip">' + h(kw) + '</span>';
    });
    s += '</div>';
    s += '</div>';
  }

  // Schedule
  s += '<div class="autotask-section autotask-section-row">';
  s += '<label class="autotask-section-label">' + h(t('autotask.wizard.schedule')) + '</label>';
  s += '<span class="autotask-schedule-row">';
  s += '<span>' + h(t('autotask.wizard.everyDay')) + '</span>';
  s += '<input class="autotask-input-sm" type="time" value="' + h(d.scheduleTime || '09:00') + '" oninput="window._autotaskScheduleTimeChange&&window._autotaskScheduleTimeChange(this.value)">';
  s += '<select class="autotask-input-sm" onchange="window._autotaskScheduleChange&&window._autotaskScheduleChange(this.value)">';
  ['daily', 'hourly', 'manual'].forEach(v => {
    s += '<option value="' + v + '"' + (d.schedule === v ? ' selected' : '') + '>' + h(getScheduleLabels()[v]) + '</option>';
  });
  s += '</select>';
  s += '<span>' + h(t('autotask.wizard.executeLabel')) + '</span>';
  s += '</span>';
  s += '</div>';

  // More settings (collapsed)
  s += '<div class="autotask-section">';
  s += '<button class="autotask-advanced-toggle" onclick="toggleWizardAdvanced()">\u25BE ' + h(t('autotask.wizard.moreSettings')) + '</button>';
  if (wizardAdvancedOpen) {
    s += '<div class="autotask-advanced-panel">';
    // Topic
    s += '<div class="autotask-adv-row">';
    s += '<label class="autotask-section-label">' + h(t('autotask.wizard.topicClassify')) + '</label>';
    s += '<select class="autotask-input-sm" onchange="window._autotaskTopicChange&&window._autotaskTopicChange(this.value)">';
    s += '<option value="auto"' + (d.topic === 'auto' ? ' selected' : '') + '>' + h(t('autotask.wizard.topicAuto')) + '</option>';
    topicsList.forEach(tp => {
      s += '<option value="' + h(tp) + '"' + (d.topic === tp ? ' selected' : '') + '>' + h(tp) + '</option>';
    });
    s += '</select>';
    s += '</div>';
    // maxPerRun
    s += '<div class="autotask-adv-row">';
    s += '<label class="autotask-section-label">' + h(t('autotask.wizard.maxPerRun')) + '</label>';
    s += '<input class="autotask-input-sm" type="number" min="1" max="50" value="' + (d.maxPerRun || 10) + '" oninput="window._autotaskMaxPerRunChange&&window._autotaskMaxPerRunChange(this.value)">';
    s += '</div>';
    // Must exclude (chips + add)
    const mustExc = (d.preferences && d.preferences.must_exclude) || [];
    s += '<div class="autotask-adv-row autotask-adv-row-block">';
    s += '<label class="autotask-section-label">' + h(t('autotask.wizard.mustExclude')) + '</label>';
    s += '<div class="autotask-keyword-chips" id="autotaskMustExcChips">';
    mustExc.forEach((kw, idx) => {
      s += '<span class="autotask-keyword-chip removable">' + h(kw) + '<button class="autotask-keyword-chip-x" onclick="removeMustExclude(' + idx + ')">×</button></span>';
    });
    s += '</div>';
    s += '<input class="autotask-input-sm" type="text" placeholder="' + h(t('autotask.wizard.mustExcludePH')) + '" onkeydown="window._autotaskMustExcKey&&window._autotaskMustExcKey(event,this)">';
    s += '</div>';
    s += '</div>';
  }
  s += '</div>';

  s += '</div>'; // step2

  // Footer
  s += '<div class="autotask-wizard-footer">';
  s += '<button class="btn-outline" onclick="backToWizardStep1()">' + h(t('autotask.wizard.backBtn')) + '</button>';
  s += '<button class="btn-sm-fill" id="autotaskConfirmBtn"' + (wizardBusy ? ' disabled' : '') + ' onclick="confirmCreateTask()">' + (wizardTaskId ? h(t('autotask.wizard.confirmEdit')) : h(t('autotask.wizard.confirmCreate'))) + '</button>';
  s += '</div>';

  wiz.innerHTML = s;

  // Wire callbacks
  window._autotaskNameChange = (v) => { if (wizardDraft) wizardDraft.name = v; };
  window._autotaskScheduleTimeChange = (v) => { if (wizardDraft) wizardDraft.scheduleTime = v; };
  window._autotaskScheduleChange = (v) => { if (wizardDraft) wizardDraft.schedule = v; };
  window._autotaskTopicChange = (v) => { if (wizardDraft) wizardDraft.topic = v; };
  window._autotaskMaxPerRunChange = (v) => {
    if (!wizardDraft) return;
    const n = parseInt(v);
    wizardDraft.maxPerRun = (Number.isFinite(n) && n >= 1 && n <= 50) ? n : 10;
  };
  window._autotaskMustExcKey = (ev, inputEl) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    const v = String(inputEl.value || '').trim();
    if (!v) return;
    if (!wizardDraft.preferences) wizardDraft.preferences = { expanded_keywords: [], style_hint: '', must_exclude: [] };
    if (!wizardDraft.preferences.must_exclude) wizardDraft.preferences.must_exclude = [];
    wizardDraft.preferences.must_exclude.push(v);
    inputEl.value = '';
    renderWizardStep2();
  };
}

export function toggleWizardAdvanced() {
  wizardAdvancedOpen = !wizardAdvancedOpen;
  renderWizardStep2();
}

export function backToWizardStep1() {
  wizardStep = 1;
  renderWizardStep1();
}

export function removeSourceFromDraft(idx) {
  if (!wizardDraft || !Array.isArray(wizardDraft.sources)) return;
  wizardDraft.sources.splice(idx, 1);
  renderWizardStep2();
}

export function removeMustExclude(idx) {
  if (!wizardDraft || !wizardDraft.preferences || !Array.isArray(wizardDraft.preferences.must_exclude)) return;
  wizardDraft.preferences.must_exclude.splice(idx, 1);
  renderWizardStep2();
}

export function addSourceToDraft(srcId) {
  if (!wizardDraft || !sourceLibrary) return;
  if (!Array.isArray(wizardDraft.sources)) wizardDraft.sources = [];
  const exists = wizardDraft.sources.some(s => s.id === srcId);
  if (exists) return;
  const src = sourceLibrary.find(s => s.id === srcId);
  if (!src) return;
  wizardDraft.sources.push({ id: src.id, label: src.label || src.name, name: src.label || src.name, description: src.description, tags: src.tags || [] });
}

/* ── Source Picker Modal ── */
export async function openSourcePicker() {
  sourcePickerOpen = true;
  sourcePickerSearch = '';
  sourcePickerSelected = new Set();
  // Pre-mark already-added sources so user sees them as not addable
  if (wizardDraft && Array.isArray(wizardDraft.sources)) {
    wizardDraft.sources.forEach(s => { if (s && s.id) sourcePickerSelected.add(s.id); });
  }
  // Load library if not loaded
  if (!sourceLibraryLoaded) {
    try {
      const res = await api('/api/autotask/sources');
      if (Array.isArray(res)) sourceLibrary = res;
      else if (res && Array.isArray(res.sources)) sourceLibrary = res.sources;
      else sourceLibrary = [];
      sourceLibraryError = null;
    } catch (e) {
      sourceLibrary = [];
      sourceLibraryError = t('autotask.source.loadError');
    }
    sourceLibraryLoaded = true;
  }
  renderSourcePicker();
}

export function closeSourcePicker() {
  sourcePickerOpen = false;
  const modal = $('autotaskSourcePicker');
  if (modal) modal.remove();
}

function renderSourcePicker() {
  let modal = $('autotaskSourcePicker');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'autotaskSourcePicker';
    modal.className = 'autotask-modal-bg open';
    modal.onclick = (ev) => { if (ev.target === modal) closeSourcePicker(); };
    document.body.appendChild(modal);
  }

  const lib = sourceLibrary || [];
  const q = sourcePickerSearch.trim().toLowerCase();
  const filtered = lib.filter(s => {
    if (!q) return true;
    const hay = (s.label || s.name || '') + ' ' + (s.description || '') + ' ' + (s.tags || []).join(' ');
    return hay.toLowerCase().includes(q);
  });
  // Group by first tag
  const groups = new Map();
  filtered.forEach(s => {
    const tag = (s.tags && s.tags[0]) || t('autotask.source.otherGroup');
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag).push(s);
  });

  let s = '<div class="autotask-modal autotask-source-picker-modal">';
  s += '<div class="modal-top"><h3>' + h(t('autotask.source.title')) + '</h3><button onclick="closeSourcePicker()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>';
  s += '<div class="autotask-source-picker-search">';
  s += '<input class="autotask-input" type="text" placeholder="' + h(t('autotask.source.searchPH')) + '" value="' + h(sourcePickerSearch) + '" oninput="window._autotaskSrcSearchChange&&window._autotaskSrcSearchChange(this.value)" autofocus>';
  s += '</div>';
  s += '<div class="autotask-source-picker-body">';

  if (sourceLibraryError) {
    s += '<div class="autotask-source-picker-empty">' + h(sourceLibraryError) + '</div>';
  } else if (!lib.length) {
    s += '<div class="autotask-source-picker-empty">' + h(t('autotask.source.empty')) + '</div>';
  } else if (!filtered.length) {
    s += '<div class="autotask-source-picker-empty">' + h(t('autotask.source.noMatch')) + '</div>';
  } else {
    Array.from(groups.entries()).forEach(([tag, items]) => {
      s += '<div class="autotask-source-picker-group">';
      s += '<div class="autotask-source-picker-group-title">' + h(tag) + '</div>';
      items.forEach(item => {
        const checked = sourcePickerSelected.has(item.id);
        s += '<label class="autotask-source-picker-item">';
        s += '<input type="checkbox"' + (checked ? ' checked' : '') + ' onchange="window._autotaskSrcToggle&&window._autotaskSrcToggle(\'' + escapeAttr(item.id) + '\',this.checked)">';
        s += '<span class="autotask-source-picker-item-text">';
        s += '<span class="autotask-source-picker-item-name">' + h(item.label || item.name || item.id) + '</span>';
        if (item.description) s += '<span class="autotask-source-picker-item-desc"><i>' + h(item.description) + '</i></span>';
        s += '</span>';
        s += '</label>';
      });
      s += '</div>';
    });
  }

  s += '</div>';
  s += '<div class="autotask-wizard-footer">';
  s += '<button class="btn-outline" onclick="closeSourcePicker()">' + h(t('common.cancel')) + '</button>';
  s += '<button class="btn-sm-fill" onclick="confirmSourcePicker()">' + h(t('common.confirm')) + '</button>';
  s += '</div>';
  s += '</div>';

  modal.innerHTML = s;

  window._autotaskSrcSearchChange = (v) => {
    sourcePickerSearch = v;
    renderSourcePicker();
  };
  window._autotaskSrcToggle = (id, checked) => {
    if (checked) sourcePickerSelected.add(id);
    else sourcePickerSelected.delete(id);
  };
}

export function confirmSourcePicker() {
  if (!wizardDraft) { closeSourcePicker(); return; }
  if (!Array.isArray(wizardDraft.sources)) wizardDraft.sources = [];
  // Re-build from selected ids, preserving order: existing first, then new
  const existingIds = new Set(wizardDraft.sources.map(s => s.id));
  sourcePickerSelected.forEach(id => {
    if (!existingIds.has(id)) {
      const src = (sourceLibrary || []).find(x => x.id === id);
      if (src) wizardDraft.sources.push({ id: src.id, label: src.label || src.name, name: src.label || src.name, description: src.description, tags: src.tags || [] });
    }
  });
  // Remove sources that are no longer selected (only if their id was in library)
  const libIds = new Set((sourceLibrary || []).map(s => s.id));
  wizardDraft.sources = wizardDraft.sources.filter(s => !libIds.has(s.id) || sourcePickerSelected.has(s.id));
  closeSourcePicker();
  renderWizardStep2();
}

/* ── Step 2 confirm: create task ── */
export async function confirmCreateTask() {
  if (wizardBusy) return;
  if (!wizardDraft) { toast(t('autotask.wizard.noConfig')); return; }
  const d = wizardDraft;
  if (!d.name || !d.name.trim()) { toast(t('autotask.wizard.nameRequired')); return; }
  if (!Array.isArray(d.sources) || !d.sources.length) { toast(t('autotask.wizard.sourceRequired')); return; }

  wizardBusy = true;
  const btn = $('autotaskConfirmBtn');
  if (btn) { btn.disabled = true; btn.textContent = t('autotask.wizard.saving'); }

  const body = {
    name: d.name.trim(),
    intent: d.intent || wizardIntent || '',
    sources: d.sources,
    preferences: d.preferences || { expanded_keywords: [], style_hint: '', must_exclude: [] },
    schedule: d.schedule || 'daily',
    scheduleTime: d.schedule === 'daily' ? (d.scheduleTime || '09:00') : undefined,
    topic: d.topic || 'auto',
    maxPerRun: d.maxPerRun || 10,
    provider: d.provider || null,
    model: d.model || null
  };

  try {
    if (wizardTaskId) {
      await put('/api/autotask/' + wizardTaskId, body);
      toast(t('autotask.wizard.taskUpdated'));
    } else {
      await post('/api/autotask', body);
      toast(t('autotask.wizard.taskCreated'));
    }
    closeAutotaskModal();
    const c = $('content');
    if (c) await rAutotask(c);
  } catch (e) {
    toast(t('autotask.wizard.saveFailed', { msg: e.message }));
    if (btn) { btn.disabled = false; btn.textContent = wizardTaskId ? t('autotask.wizard.confirmEdit') : t('autotask.wizard.confirmCreate'); }
  } finally {
    wizardBusy = false;
  }
}

/* ── Detail modal (unchanged behavior; kept for back-compat with older runs) ── */
export function closeAutotaskDetail() {
  const modal = $('autotaskDetailModal');
  if (modal) modal.classList.remove('open');
}

/* ── Run / Toggle / Delete ── */
export async function runAutotask(taskId) {
  try {
    const res = await post('/api/autotask/' + taskId + '/run', {});
    const runId = res && res.runId;
    if (!runId) { toast(t('autotask.triggered')); return; }
    watchingRunId = runId;
    currentTab = 'history';
    try { localStorage.setItem(TAB_STORAGE_KEY, 'history'); } catch (_) {}
    await refreshData();
    const c = $('content');
    if (c) renderPage(c);
    startPolling();
    toast(t('autotask.runStarted'));
  } catch (e) {
    toast(t('autotask.runFailed', { msg: e.message }));
  }
}

async function refreshData() {
  try {
    const [taskRes, histRes] = await Promise.all([
      api('/api/autotask/list'),
      api('/api/autotask/history')
    ]);
    tasks = taskRes.tasks || [];
    history = Array.isArray(histRes) ? histRes : (histRes.history || []);
  } catch (_) { /* ignore */ }
}

function startPolling() {
  stopPolling();
  pollTimer = setTimeout(pollOnce, 1500);
}

function stopPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

function isOnAutotaskPage() {
  // Only re-render / keep polling while user is still on the autotask page.
  // Avoids overwriting whatever page they navigated to while a run was live.
  const hash = (location.hash || '').replace(/^#/, '');
  return hash === '/autotask' || hash.startsWith('/autotask');
}

// 就地 patch 运行中卡片的动态部分（进度条 / 进度文字 / 相对时间）。
// 返回 true 表示命中目标卡并完成 patch；返回 false 时调用方需回退到 renderPage 全量重建。
// 动机：原实现每 1.5s 整页 innerHTML 重建，视觉上就是不停刷新闪烁。
function patchRunningCardInPlace(run) {
  if (!run || run.status !== 'running') return false;
  const runId = run.id || run.runId;
  if (!runId) return false;
  const row = document.querySelector('.autotask-history-row[data-run-id="' + (window.CSS && CSS.escape ? CSS.escape(runId) : runId.replace(/"/g, '\\"')) + '"]');
  if (!row || !row.classList.contains('running')) return false;

  const prog = run.progress || { phase: 'fetching', current: 0, total: 0, currentTitle: null };
  const total = prog.total || 0;
  const cur = prog.current || 0;
  const pct = total > 0 ? Math.min(100, Math.round((cur / total) * 100)) : (prog.phase === 'fetching' ? 10 : 5);

  const fill = row.querySelector('.autotask-progress-fill');
  if (fill) fill.style.width = pct + '%';

  const phaseLabel = prog.phase === 'fetching' ? t('autotask.phaseFetching') : prog.phase === 'filtering' ? t('autotask.phaseFiltering') : t('autotask.phaseProcessing');
  const meta = row.querySelector('.autotask-history-meta');
  if (meta) {
    let metaHtml;
    if (prog.phase === 'processing' && total > 0) {
      metaHtml = h(phaseLabel) + ' ' + cur + '/' + total;
    } else {
      metaHtml = h(phaseLabel);
    }
    if (run.itemsIngested) metaHtml += ' \u00B7 ' + h(t('autotask.progressIngested', { n: run.itemsIngested }));
    if (run.itemsSkipped) metaHtml += ' \u00B7 ' + h(t('autotask.progressSkipped', { n: run.itemsSkipped }));
    if (prog.currentTitle) {
      const titleTrunc = prog.currentTitle.length > 80 ? prog.currentTitle.slice(0, 78) + '...' : prog.currentTitle;
      metaHtml += '<div class="autotask-progress-current">' + h(t('autotask.progressCurrent', { title: titleTrunc })) + '</div>';
    }
    meta.innerHTML = metaHtml;
  }

  const timeEl = row.querySelector('.autotask-history-time');
  if (timeEl) timeEl.textContent = relTime(run.startedAt);
  return true;
}

async function pollOnce() {
  pollTimer = null;
  if (!watchingRunId) return;
  if (!isOnAutotaskPage()) { watchingRunId = null; return; }
  try {
    const histRes = await api('/api/autotask/history');
    history = Array.isArray(histRes) ? histRes : (histRes.history || []);
    const run = history.find(r => r.id === watchingRunId);
    const c = $('content');
    const onHistoryTab = c && currentTab === 'history' && isOnAutotaskPage();

    if (run && run.status === 'running') {
      // 就地 patch，不全量重建，避免整页闪烁。命中失败（如新加的 run 还没 render 过）时回退到全量重建。
      if (onHistoryTab) {
        const patched = patchRunningCardInPlace(run);
        if (!patched) renderPage(c);
      }
      if (isOnAutotaskPage()) pollTimer = setTimeout(pollOnce, 1500);
      else watchingRunId = null;
    } else {
      // 状态迁移（running → 完成/失败）时卡片形态变化较大，仍走全量重建。
      watchingRunId = null;
      try {
        const tres = await api('/api/autotask/list');
        tasks = tres.tasks || [];
      } catch (_) {}
      if (onHistoryTab) renderPage(c);
      if (run) {
        const label = run.status === 'success' ? t('autotask.runDoneSuccess') : run.status === 'partial' ? t('autotask.runDonePartial') : t('autotask.runDoneError');
        toast(t('autotask.runDone', { label, ingested: run.itemsIngested || 0, skipped: run.itemsSkipped || 0 }));
      }
    }
  } catch (_) {
    if (watchingRunId && isOnAutotaskPage()) pollTimer = setTimeout(pollOnce, 3000);
    else watchingRunId = null;
  }
}

export async function toggleAutotaskEnabled(taskId) {
  try {
    const res = await api('/api/autotask/' + taskId + '/toggle');
    const tk = tasks.find(x => x.id === taskId);
    if (tk) tk.enabled = res.enabled;
    toast(res.enabled ? t('autotask.taskEnabled') : t('autotask.taskPaused'));
  } catch (e) {
    toast(t('autotask.opFailed', { msg: e.message }));
    const c = $('content');
    if (c) renderPage(c);
  }
}

export async function deleteAutotask(taskId) {
  if (!confirm(t('autotask.confirmDelete'))) return;
  try {
    await apiDel('/api/autotask/' + taskId);
    tasks = tasks.filter(tk => tk.id !== taskId);
    toast(t('autotask.taskDeleted'));
    const c = $('content');
    if (c) renderPage(c);
  } catch (e) {
    toast(t('autotask.deleteFailed', { msg: e.message }));
  }
}

/* ── postRaw — POST returning parsed body even on non-2xx ── */
async function postRaw(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let data = null;
  try { data = await r.json(); } catch (_) { data = null; }
  if (!r.ok) {
    const msg = (data && (data.error || data.detail)) || ('HTTP ' + r.status);
    throw new Error(msg);
  }
  return data;
}
