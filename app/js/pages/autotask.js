import { $, h, relTime, api, post, put, apiDel, toast, go, skelLines } from '../utils.js';
import state from '../state.js';

/* ── Local state ── */
let currentTab = 'tasks';
let tasks = [];
let history = [];
let topicsList = [];
let historyRange = 7; // days: 7 | 30 | 0(all)

/* ── Wizard state ── */
let wizardStep = 1;       // 1 (templates+NL) | 2 (confirm)
let wizardDraft = null;   // current config draft
let wizardPreview = null; // { items: [...], error?: string, loading: bool }
let wizardTaskId = null;  // taskId in edit mode, null = create
let wizardBusy = false;   // submit lock
let wizardWarnings = [];  // warnings from parse-nl
let wizardFailCount = 0;  // consecutive parse-nl failures
let wizardAdvancedOpen = false;
let wizardNLValue = '';   // cached textarea input
let settingsCache = null; // /api/settings cache
let inlineEditingField = null;  // field name being inline-edited
let previewDebounceTimer = null;

/* ── Source labels ── */
const SOURCE_LABELS = { rss: 'RSS', webpage: '网页', api: 'API' };
const SOURCE_TYPE_LABELS = SOURCE_LABELS;
const SCHEDULE_LABELS = { daily: '每日', hourly: '每小时', manual: '仅手动' };
const STATUS_COLORS = { success: 'var(--green)', error: 'var(--red)', partial: 'var(--yellow)', running: 'var(--accent)' };

/* ── Templates ── */
const TEMPLATES = [
  { id: 'hn', name: 'Hacker News', icon: '🟠', desc: '前沿技术讨论',
    config: { name: 'Hacker News 精选', sourceType: 'rss',
              sourceConfig: { url: 'https://hnrss.org/frontpage', maxItems: 10 },
              schedule: 'daily', scheduleTime: '09:00', topic: 'auto',
              filters: { keywords: [], excludeKeywords: [] } } },
  { id: 'arxiv', name: 'arXiv cs.AI', icon: '📄', desc: 'AI 论文每日更新',
    config: { name: 'arXiv AI 论文', sourceType: 'rss',
              sourceConfig: { url: 'https://export.arxiv.org/rss/cs.AI', maxItems: 5 },
              schedule: 'daily', scheduleTime: '08:00', topic: 'auto',
              filters: { keywords: [], excludeKeywords: [] } } },
  { id: 'hfpapers', name: 'HF Papers', icon: '🤗', desc: '精选 AI 论文',
    config: { name: 'Hugging Face Papers', sourceType: 'webpage',
              sourceConfig: { url: 'https://huggingface.co/papers', maxItems: 5 },
              schedule: 'daily', scheduleTime: '10:00', topic: 'auto',
              filters: { keywords: [], excludeKeywords: [] } } },
  { id: '36kr', name: '36氪', icon: '🟢', desc: '创投与商业',
    config: { name: '36氪资讯', sourceType: 'rss',
              sourceConfig: { url: 'https://36kr.com/feed', maxItems: 5 },
              schedule: 'daily', scheduleTime: '09:30', topic: 'auto',
              filters: { keywords: [], excludeKeywords: [] } } },
  { id: 'sspai', name: '少数派', icon: '🔵', desc: '效率与生活',
    config: { name: '少数派精选', sourceType: 'rss',
              sourceConfig: { url: 'https://sspai.com/feed', maxItems: 5 },
              schedule: 'daily', scheduleTime: '12:00', topic: 'auto',
              filters: { keywords: [], excludeKeywords: [] } } },
  { id: 'ruanyf', name: '阮一峰周刊', icon: '📬', desc: '科技爱好者周刊（每周五）',
    config: { name: '阮一峰科技周刊', sourceType: 'rss',
              sourceConfig: { url: 'https://www.ruanyifeng.com/blog/atom.xml', maxItems: 3 },
              schedule: 'daily', scheduleTime: '20:00', topic: 'auto',
              filters: { keywords: [], excludeKeywords: [] } } }
];

/* ── Helpers ── */
function statusDot(enabled) {
  return '<span class="autotask-status-dot" style="background:' + (enabled ? 'var(--green)' : 'var(--fg-tertiary)') + '"></span>';
}

function badge(type) {
  return '<span class="autotask-badge">' + h(SOURCE_LABELS[type] || type) + '</span>';
}

function scheduleText(task) {
  let s = SCHEDULE_LABELS[task.schedule] || task.schedule;
  if (task.schedule === 'daily' && task.scheduleTime) s += ' ' + task.scheduleTime;
  return s;
}

function runStatusText(run) {
  if (run.status === 'running') return '<span style="color:var(--accent)">运行中</span>';
  if (run.status === 'success') return '<span style="color:var(--green)">成功</span>';
  if (run.status === 'error') return '<span style="color:var(--red)">失败</span>';
  if (run.status === 'partial') return '<span style="color:var(--yellow)">部分成功</span>';
  return h(run.status || '');
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
  if (task.schedule === 'daily') {
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
  if (mins < 60) return `${mins} 分钟后`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `约 ${hours} 小时后`;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `今天 ${hh}:${mm}`;
  const tmr = new Date(now); tmr.setDate(tmr.getDate() + 1);
  if (d.toDateString() === tmr.toDateString()) return `明天 ${hh}:${mm}`;
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
    const t = r.startedAt ? new Date(r.startedAt).getTime() : 0;
    if (t < cutoff) return;
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
    // Load topics for the form
    try {
      const tree = state.td || await api('/api/wiki/tree');
      state.td = tree;
      topicsList = (tree || []).map(t => t.name);
    } catch (_) { topicsList = []; }
    renderPage(c);
  } catch (e) {
    c.innerHTML = '<div style="text-align:center;padding:60px;color:var(--fg-tertiary)">加载失败: ' + h(e.message) + '</div>';
  }
}

function renderPage(c) {
  let s = '<div class="page-autotask">';
  // Header
  s += '<div class="autotask-header">';
  s += '<h1 class="autotask-title">自动化任务</h1>';
  // Hide top-right button on tasks tab when empty (empty-state has its own CTA), or on history tab
  const showHeaderBtn = !(currentTab === 'tasks' && tasks.length === 0) && currentTab !== 'history';
  if (showHeaderBtn) {
    s += '<button class="btn-fill" style="width:auto;padding:8px 20px;font-size:13px" onclick="openAutotaskModal()">+ 新建任务</button>';
  } else {
    s += '<span></span>';
  }
  s += '</div>';
  // Tabs
  s += '<div class="autotask-tabs">';
  s += '<button class="autotask-tab' + (currentTab === 'tasks' ? ' active' : '') + '" onclick="switchAutotaskTab(\'tasks\')">任务列表</button>';
  s += '<button class="autotask-tab' + (currentTab === 'history' ? ' active' : '') + '" onclick="switchAutotaskTab(\'history\')">执行历史</button>';
  s += '</div>';
  // Content
  if (currentTab === 'tasks') s += renderTaskList();
  else s += renderHistory();
  s += '</div>';
  c.innerHTML = s;
}

function renderTaskList() {
  if (!tasks.length) {
    return '<div class="autotask-empty">'
      + '<div class="autotask-empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg></div>'
      + '<p class="autotask-empty-title">还没有自动化任务</p>'
      + '<p class="autotask-empty-desc">创建你的第一个自动任务，让知识库自动增长</p>'
      + '<button class="btn-fill" style="width:auto;padding:10px 24px" onclick="openAutotaskModal()">+ 新建任务</button>'
      + '</div>';
  }
  let s = '<div class="autotask-cards">';
  tasks.forEach(t => {
    s += '<div class="autotask-card">';
    // Head row
    s += '<div class="autotask-card-head">';
    s += statusDot(t.enabled !== false);
    s += '<span class="autotask-card-name">' + h(t.name) + '</span>';
    s += '<label class="autotask-toggle" onclick="event.stopPropagation()">';
    s += '<input type="checkbox"' + (t.enabled !== false ? ' checked' : '') + ' onchange="toggleAutotaskEnabled(\'' + h(t.id) + '\')">';
    s += '<span class="autotask-toggle-slider"></span>';
    s += '</label>';
    s += '</div>';
    // Meta
    s += '<div class="autotask-card-meta">';
    s += badge(t.sourceType);
    s += '<span>' + h(scheduleText(t)) + '</span>';
    s += '<span>主题: ' + h(t.topic || 'auto') + '</span>';
    s += '</div>';
    // Model badge (only when non-global override set)
    if (t.provider && t.model) {
      s += '<div class="autotask-card-modelrow"><span class="autotask-model-badge" title="此任务使用独立模型">' + h(t.model) + '</span></div>';
    }
    // Last run
    if (t.lastRunAt) {
      const stColor = t.lastRunStatus === 'success' ? 'var(--green)' : t.lastRunStatus === 'error' ? 'var(--red)' : t.lastRunStatus === 'partial' ? 'var(--yellow)' : 'var(--fg-tertiary)';
      const stLabel = t.lastRunStatus === 'success' ? '成功' : t.lastRunStatus === 'error' ? '失败' : t.lastRunStatus === 'partial' ? '部分成功' : (t.lastRunStatus || '');
      s += '<div class="autotask-card-status">';
      s += '最近执行: ' + relTime(t.lastRunAt) + ' · <span style="color:' + stColor + '">' + h(stLabel) + '</span>';
      s += '</div>';
    }
    // Recent ingested preview (up to 3 titles)
    const recent = lastRunIngested(t.id, 3);
    if (recent.length) {
      s += '<div class="autotask-card-preview">';
      s += '<div class="autotask-card-preview-label">📥 上次抓到 ' + recent.length + ' 篇</div>';
      s += '<ul class="autotask-card-preview-list">';
      recent.forEach(it => {
        const title = h(it.title || '无标题');
        if (it.articlePath) {
          s += '<li><a href="#/article/' + h(it.articlePath) + '" onclick="event.stopPropagation()">' + title + '</a></li>';
        } else {
          s += '<li>' + title + '</li>';
        }
      });
      s += '</ul>';
      s += '</div>';
    }
    // Next run
    const nr = computeNextRun(t);
    if (nr) {
      s += '<div class="autotask-card-nextrun">下次执行: ' + h(formatNextRun(nr)) + '</div>';
    }
    // Actions
    s += '<div class="autotask-card-actions">';
    s += '<button class="autotask-action-btn" onclick="testAutotaskSource(\'' + h(t.id) + '\')" title="测试数据源">测试</button>';
    s += '<button class="autotask-action-btn" onclick="runAutotask(\'' + h(t.id) + '\')" title="立即执行">执行</button>';
    s += '<button class="autotask-action-btn" onclick="openAutotaskModal(\'' + h(t.id) + '\')" title="编辑">编辑</button>';
    s += '<button class="autotask-action-btn autotask-action-del" onclick="deleteAutotask(\'' + h(t.id) + '\')" title="删除">删除</button>';
    s += '</div>';
    s += '</div>';
  });
  s += '</div>';
  return s;
}

function renderHistory() {
  if (!history.length) {
    return '<div class="autotask-empty">'
      + '<div class="autotask-empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg></div>'
      + '<p class="autotask-empty-title">暂无执行记录</p>'
      + '<p class="autotask-empty-desc">任务执行后，记录会显示在这里</p>'
      + '</div>';
  }
  // Summary bar
  const stats = computeHistoryStats(historyRange);
  const rangeLabel = historyRange === 7 ? '近 7 天' : historyRange === 30 ? '近 30 天' : '全部';
  let s = '<div class="autotask-history-summary">';
  s += '<div class="autotask-history-summary-stats">';
  s += '<span class="autotask-history-stat"><span class="autotask-history-stat-num">' + stats.runs + '</span><span class="autotask-history-stat-lbl">' + h(rangeLabel) + '执行</span></span>';
  s += '<span class="autotask-history-stat"><span class="autotask-history-stat-num">' + stats.ingested + '</span><span class="autotask-history-stat-lbl">入库文章</span></span>';
  s += '<span class="autotask-history-stat"><span class="autotask-history-stat-num" style="color:' + (stats.errors > 0 ? 'var(--red)' : 'var(--fg-secondary)') + '">' + stats.errors + '</span><span class="autotask-history-stat-lbl">失败</span></span>';
  s += '</div>';
  s += '<div class="autotask-history-range">';
  [[7, '7 天'], [30, '30 天'], [0, '全部']].forEach(([v, lbl]) => {
    s += '<button class="autotask-history-range-btn' + (historyRange === v ? ' active' : '') + '" onclick="switchHistoryRange(' + v + ')">' + lbl + '</button>';
  });
  s += '</div>';
  s += '</div>';

  // Filtered rows
  const cutoff = historyRange > 0 ? (Date.now() - historyRange * 86400000) : 0;
  const rows = history.filter(r => {
    const t = r.startedAt ? new Date(r.startedAt).getTime() : 0;
    return t >= cutoff;
  });
  if (!rows.length) {
    s += '<div class="autotask-empty" style="padding:40px 20px"><p class="autotask-empty-desc">' + h(rangeLabel) + '内暂无记录</p></div>';
    return s;
  }
  s += '<div class="autotask-history-list">';
  rows.forEach(run => {
    const dotColor = STATUS_COLORS[run.status] || 'var(--fg-tertiary)';
    const dimClass = (run.status === 'error' || run.itemsIngested === 0) ? ' dim' : '';
    s += '<div class="autotask-history-row' + dimClass + '">';
    s += '<div class="autotask-history-head">';
    s += '<span class="autotask-status-dot" style="background:' + dotColor + '"></span>';
    s += '<span class="autotask-history-name">' + h(run.taskName || '未知任务') + '</span>';
    s += '<span class="autotask-history-time">' + relTime(run.startedAt) + '</span>';
    s += '</div>';
    s += '<div class="autotask-history-meta">';
    if (run.itemsFound != null) {
      s += '找到 ' + run.itemsFound + ' 项';
      if (run.itemsIngested != null) s += ' · 入库 ' + run.itemsIngested;
      if (run.itemsSkipped != null) s += ' · 跳过 ' + run.itemsSkipped;
    }
    if (run.error) s += '<span style="color:var(--red)"> · ' + h(run.error) + '</span>';
    s += '</div>';
    // Per-row ingested titles
    const ing = (run.items || []).filter(it => it.status === 'ingested').slice(0, 3);
    if (ing.length) {
      s += '<ul class="autotask-history-titles">';
      ing.forEach(it => {
        const title = h(it.title || '无标题');
        if (it.articlePath) {
          s += '<li><a href="#/article/' + h(it.articlePath) + '">' + title + '</a></li>';
        } else if (it.url) {
          s += '<li><a href="' + h(it.url) + '" target="_blank" rel="noopener">' + title + '</a></li>';
        } else {
          s += '<li>' + title + '</li>';
        }
      });
      s += '</ul>';
    }
    s += '<div class="autotask-history-actions">';
    s += '<button class="autotask-action-btn" onclick="showRunDetail(\'' + h(run.id || run.runId) + '\')">详情</button>';
    s += '</div>';
    s += '</div>';
  });
  s += '</div>';
  return s;
}

export function switchHistoryRange(days) {
  historyRange = days;
  const c = $('content');
  if (c) renderPage(c);
}

/* ── Tab switch ── */
export function switchAutotaskTab(tab) {
  currentTab = tab;
  const c = $('content');
  if (c) renderPage(c);
}

/* ── Settings cache ── */
async function loadSettingsCache() {
  if (settingsCache) return settingsCache;
  try {
    const s = state.sCache || await api('/api/settings');
    state.sCache = s;
    settingsCache = s;
  } catch (_) {
    settingsCache = { provider: 'local', model: '', providers: {} };
  }
  return settingsCache;
}

/* ── taskToNL: build natural-language summary from task ── */
function taskToNL(t) {
  if (t.nlSummary) return t.nlSummary;
  let s = `从 ${SOURCE_TYPE_LABELS[t.sourceType] || t.sourceType} 源 ${t.sourceConfig && t.sourceConfig.url || ''}，`;
  s += SCHEDULE_LABELS[t.schedule] || t.schedule;
  if (t.schedule === 'daily' && t.scheduleTime) s += ` ${t.scheduleTime}`;
  s += `执行，保存到主题 ${t.topic || 'auto'}`;
  if (t.filters && t.filters.keywords && t.filters.keywords.length) s += `，只要含 ${t.filters.keywords.join('/')}`;
  if (t.filters && t.filters.excludeKeywords && t.filters.excludeKeywords.length) s += `，排除 ${t.filters.excludeKeywords.join('/')}`;
  s += `，最多 ${(t.sourceConfig && t.sourceConfig.maxItems) || 5} 条`;
  return s;
}

/* ── Build simplest fallback draft ── */
function buildSimplestDraft() {
  return {
    name: '新任务',
    sourceType: 'rss',
    sourceConfig: { url: '', maxItems: 5 },
    schedule: 'daily',
    scheduleTime: '08:00',
    topic: 'auto',
    filters: { keywords: [], excludeKeywords: [] }
  };
}

/* ── Modal: open/close ── */
export function openAutotaskModal(taskId) {
  wizardTaskId = taskId || null;
  wizardStep = 1;
  wizardDraft = null;
  wizardPreview = null;
  wizardBusy = false;
  wizardWarnings = [];
  wizardFailCount = 0;
  wizardAdvancedOpen = false;
  inlineEditingField = null;
  if (previewDebounceTimer) { clearTimeout(previewDebounceTimer); previewDebounceTimer = null; }

  const modal = $('autotaskModal');
  const title = $('autotaskModalTitle');
  if (!modal) return;

  if (taskId) {
    const task = tasks.find(t => t.id === taskId);
    title.textContent = '编辑任务';
    wizardNLValue = task ? taskToNL(task) : '';
    // Pre-populate draft from task so step2 can be reached without re-parsing
    if (task) {
      wizardDraft = {
        name: task.name || '',
        sourceType: task.sourceType || 'rss',
        sourceConfig: {
          url: (task.sourceConfig && task.sourceConfig.url) || '',
          maxItems: (task.sourceConfig && task.sourceConfig.maxItems) || 5
        },
        schedule: task.schedule || 'daily',
        scheduleTime: task.scheduleTime || '08:00',
        topic: task.topic || 'auto',
        filters: {
          keywords: (task.filters && task.filters.keywords) || [],
          excludeKeywords: (task.filters && task.filters.excludeKeywords) || []
        },
        provider: task.provider || null,
        model: task.model || null
      };
    }
  } else {
    title.textContent = '新建任务';
    wizardNLValue = '';
  }

  // Pre-load settings cache (don't block modal open)
  loadSettingsCache();

  renderWizardStep1();
  modal.classList.add('open');
}

export function closeAutotaskModal() {
  const modal = $('autotaskModal');
  if (modal) modal.classList.remove('open');
  wizardStep = 1;
  wizardDraft = null;
  wizardPreview = null;
  wizardTaskId = null;
  wizardBusy = false;
  wizardWarnings = [];
  wizardFailCount = 0;
  wizardAdvancedOpen = false;
  wizardNLValue = '';
  inlineEditingField = null;
  if (previewDebounceTimer) { clearTimeout(previewDebounceTimer); previewDebounceTimer = null; }
}

/* ── Step 1: templates + NL ── */
function renderWizardStep1() {
  const wiz = $('autotaskWizard');
  if (!wiz) return;
  const isEdit = !!wizardTaskId;

  let s = '<div class="autotask-wizard-step1">';

  // Template grid (only for create mode)
  if (!isEdit) {
    s += '<div class="autotask-templates-section">';
    s += '<div class="autotask-templates-label">快速开始</div>';
    s += '<div class="autotask-templates-grid">';
    TEMPLATES.forEach(t => {
      s += '<div class="autotask-template-card" onclick="pickTemplate(\'' + h(t.id) + '\')">';
      s += '<div class="autotask-template-icon">' + t.icon + '</div>';
      s += '<div class="autotask-template-name">' + h(t.name) + '</div>';
      s += '<div class="autotask-template-desc">' + h(t.desc) + '</div>';
      s += '</div>';
    });
    s += '</div>';
    s += '</div>';

    s += '<div class="autotask-divider-text"><span>或者描述你的需求</span></div>';
  } else {
    s += '<div class="autotask-templates-label" style="margin-bottom:8px">修改描述或直接点重新解析</div>';
  }

  // NL textarea
  s += '<div class="autotask-nl-section">';
  s += '<textarea class="autotask-nl-textarea" id="autotaskNLInput" placeholder="比如：每天早上 8 点抓 HN 上 AI 文章，最多 10 条" oninput="window._autotaskNLChange&&window._autotaskNLChange(this.value)">' + h(wizardNLValue) + '</textarea>';
  s += '</div>';

  // Fallback button (after first failure)
  if (wizardFailCount >= 1) {
    s += '<div style="margin-top:8px"><button class="autotask-fallback-btn" onclick="window._autotaskFallback()">用最简模板创建（自己填 URL）</button></div>';
  }

  s += '</div>'; // step1

  // Footer
  s += '<div class="autotask-wizard-footer">';
  s += '<button class="btn-outline" onclick="closeAutotaskModal()">取消</button>';
  s += '<button class="btn-sm-fill" id="autotaskNextBtn" onclick="submitWizardNL()">' + (isEdit ? '重新解析 →' : '让 AI 配置 →') + '</button>';
  s += '</div>';

  wiz.innerHTML = s;

  // Attach NL change handler (cache value)
  window._autotaskNLChange = (v) => { wizardNLValue = v; };
  window._autotaskFallback = () => {
    wizardDraft = buildSimplestDraft();
    wizardWarnings = ['使用最简模板创建，请在下一步手动填写 URL'];
    wizardStep = 2;
    renderWizardStep2();
    // No preview triggered (URL empty)
  };
}

/* ── Step 1 actions ── */
export async function pickTemplate(tplId) {
  const tpl = TEMPLATES.find(x => x.id === tplId);
  if (!tpl) return;
  // Deep copy
  wizardDraft = JSON.parse(JSON.stringify(tpl.config));
  wizardWarnings = [];
  wizardStep = 2;
  renderWizardStep2();
  // Trigger preview
  refreshPreview();
}

export async function submitWizardNL() {
  if (wizardBusy) return;
  const nl = (wizardNLValue || '').trim();
  if (!nl) { toast('请描述你的需求或选择模板'); return; }
  wizardBusy = true;
  const btn = $('autotaskNextBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'AI 解析中...'; }
  try {
    const body = { nl };
    // In edit mode, include current config so AI keeps unmodified fields
    if (wizardTaskId && wizardDraft) {
      body.current = wizardDraft;
    }
    const res = await postRaw('/api/autotask/parse-nl', body);
    if (!res || !res.ok || !res.config) {
      throw new Error((res && res.error) || 'AI 解析失败');
    }
    wizardDraft = res.config;
    wizardWarnings = Array.isArray(res.warnings) ? res.warnings : [];
    wizardFailCount = 0;
    wizardStep = 2;
    renderWizardStep2();
    refreshPreview();
  } catch (e) {
    wizardFailCount += 1;
    toast('AI 解析失败: ' + (e.message || ''));
    if (btn) { btn.disabled = false; btn.textContent = wizardTaskId ? '重新解析 →' : '让 AI 配置 →'; }
    // Re-render step1 to show fallback button
    renderWizardStep1();
  } finally {
    wizardBusy = false;
  }
}

/* ── Step 2: confirm ── */
function renderWizardStep2() {
  const wiz = $('autotaskWizard');
  if (!wiz || !wizardDraft) return;
  const d = wizardDraft;

  let s = '<div class="autotask-wizard-step2">';
  s += '<div style="padding:14px 20px 8px;font-size:13px;color:var(--fg-secondary)">AI 已帮你解析，请确认：</div>';

  // Warnings
  if (wizardWarnings && wizardWarnings.length) {
    s += '<div style="padding:0 20px"><div class="autotask-warnings">';
    s += '⚠️ ' + wizardWarnings.map(w => h(w)).join('<br>⚠️ ');
    s += '</div></div>';
  }

  // Confirm fields
  s += '<div class="autotask-confirm-fields">';
  s += renderConfirmRow('name', '任务名称', h(d.name || ''));
  s += renderConfirmRow('sourceType', '数据源', h(SOURCE_TYPE_LABELS[d.sourceType] || d.sourceType));
  s += renderConfirmRow('url', 'URL', h((d.sourceConfig && d.sourceConfig.url) || ''));
  s += renderConfirmRow('schedule', '频率', h(SCHEDULE_LABELS[d.schedule] || d.schedule));
  if (d.schedule === 'daily') {
    s += renderConfirmRow('scheduleTime', '执行时间', h(d.scheduleTime || '08:00'));
  }
  s += renderConfirmRow('topic', '主题', h(d.topic || 'auto'));
  s += renderConfirmRow('maxItems', '最大条数', String((d.sourceConfig && d.sourceConfig.maxItems) || 5));
  const kw = (d.filters && d.filters.keywords) || [];
  s += renderConfirmRow('keywords', '关键词', kw.length ? h(kw.join(', ')) : '<span style="color:var(--fg-tertiary)">（无）</span>');
  const xkw = (d.filters && d.filters.excludeKeywords) || [];
  s += renderConfirmRow('excludeKeywords', '排除关键词', xkw.length ? h(xkw.join(', ')) : '<span style="color:var(--fg-tertiary)">（无）</span>');
  s += '</div>';

  // Advanced (collapsible)
  s += '<div style="padding:8px 20px">';
  s += '<button class="autotask-advanced-toggle" onclick="toggleWizardAdvanced()">⚙️ 高级 ' + (wizardAdvancedOpen ? '▲' : '▼') + '</button>';
  if (wizardAdvancedOpen) {
    s += '<div class="autotask-advanced-panel">';
    s += '<div class="autotask-confirm-row"><span class="autotask-confirm-label">模型</span>';
    s += '<span class="autotask-confirm-value" style="cursor:default">' + renderModelSelect() + '</span>';
    s += '</div>';
    s += '</div>';
  }
  s += '</div>';

  // Preview
  s += '<div class="autotask-preview-section">';
  s += '<div class="autotask-preview-label">预览（前 3 条）</div>';
  s += renderPreviewBlock();
  s += '</div>';

  // Iterate
  s += '<div class="autotask-iterate-section">';
  s += '<div class="autotask-iterate-label">不满意？继续描述</div>';
  s += '<textarea class="autotask-iterate-textarea" id="autotaskIterateInput" placeholder="比如：把频率改成每小时，加一个关键词 transformer"></textarea>';
  s += '<div style="margin-top:8px;text-align:right">';
  s += '<button class="btn-outline" id="autotaskIterateBtn" onclick="submitWizardIterate()">再次解析</button>';
  s += '</div>';
  s += '</div>';

  s += '</div>'; // step2

  // Footer
  s += '<div class="autotask-wizard-footer">';
  s += '<button class="btn-outline" onclick="backToWizardStep1()">← 返回</button>';
  s += '<button class="btn-sm-fill" id="autotaskConfirmBtn" onclick="confirmWizardCreate()">' + (wizardTaskId ? '保存修改' : '确认创建') + '</button>';
  s += '</div>';

  wiz.innerHTML = s;
}

function renderConfirmRow(field, label, valueHtml) {
  // If currently inline-editing this field, render input/select
  if (inlineEditingField === field) {
    return '<div class="autotask-confirm-row"><span class="autotask-confirm-label">' + label + '</span>'
      + '<span class="autotask-confirm-value" style="cursor:default">' + renderInlineEditor(field) + '</span></div>';
  }
  return '<div class="autotask-confirm-row"><span class="autotask-confirm-label">' + label + '</span>'
    + '<span class="autotask-confirm-value" onclick="editFieldInline(\'' + field + '\')">' + valueHtml + '</span></div>';
}

function renderInlineEditor(field) {
  const d = wizardDraft;
  const commit = `window._autotaskInlineCommit('${field}', this)`;
  const cancel = `window._autotaskInlineCancel()`;
  const onkey = `if(event.key==='Enter'){event.preventDefault();${commit};}else if(event.key==='Escape'){${cancel};}`;

  if (field === 'name') {
    return '<input class="autotask-confirm-value-input" type="text" value="' + h(d.name || '') + '" onblur="' + commit + '" onkeydown="' + onkey + '" autofocus>';
  }
  if (field === 'sourceType') {
    let sel = '<select class="autotask-confirm-value-input" onchange="' + commit + '" onblur="' + commit + '" autofocus>';
    ['rss', 'webpage', 'api'].forEach(v => {
      sel += '<option value="' + v + '"' + (d.sourceType === v ? ' selected' : '') + '>' + SOURCE_TYPE_LABELS[v] + '</option>';
    });
    sel += '</select>';
    return sel;
  }
  if (field === 'url') {
    const url = (d.sourceConfig && d.sourceConfig.url) || '';
    return '<input class="autotask-confirm-value-input" type="text" value="' + h(url) + '" onblur="' + commit + '" onkeydown="' + onkey + '" autofocus>';
  }
  if (field === 'schedule') {
    let sel = '<select class="autotask-confirm-value-input" onchange="' + commit + '" onblur="' + commit + '" autofocus>';
    ['daily', 'hourly', 'manual'].forEach(v => {
      sel += '<option value="' + v + '"' + (d.schedule === v ? ' selected' : '') + '>' + SCHEDULE_LABELS[v] + '</option>';
    });
    sel += '</select>';
    return sel;
  }
  if (field === 'scheduleTime') {
    return '<input class="autotask-confirm-value-input" type="time" value="' + h(d.scheduleTime || '08:00') + '" onblur="' + commit + '" onkeydown="' + onkey + '" autofocus>';
  }
  if (field === 'topic') {
    let sel = '<select class="autotask-confirm-value-input" onchange="' + commit + '" onblur="' + commit + '" autofocus>';
    sel += '<option value="auto"' + (d.topic === 'auto' ? ' selected' : '') + '>auto (自动分类)</option>';
    topicsList.forEach(tp => {
      sel += '<option value="' + h(tp) + '"' + (d.topic === tp ? ' selected' : '') + '>' + h(tp) + '</option>';
    });
    sel += '</select>';
    return sel;
  }
  if (field === 'maxItems') {
    const v = (d.sourceConfig && d.sourceConfig.maxItems) || 5;
    return '<input class="autotask-confirm-value-input" type="number" min="1" max="50" value="' + v + '" onblur="' + commit + '" onkeydown="' + onkey + '" autofocus>';
  }
  if (field === 'keywords') {
    const v = ((d.filters && d.filters.keywords) || []).join(', ');
    return '<input class="autotask-confirm-value-input" type="text" placeholder="逗号分隔" value="' + h(v) + '" onblur="' + commit + '" onkeydown="' + onkey + '" autofocus>';
  }
  if (field === 'excludeKeywords') {
    const v = ((d.filters && d.filters.excludeKeywords) || []).join(', ');
    return '<input class="autotask-confirm-value-input" type="text" placeholder="逗号分隔" value="' + h(v) + '" onblur="' + commit + '" onkeydown="' + onkey + '" autofocus>';
  }
  return '';
}

function renderModelSelect() {
  const s = settingsCache;
  const d = wizardDraft;
  const inheritLabel = s && s.provider && s.model ? `继承全局 (${s.model})` : '继承全局';
  let sel = '<select class="autotask-confirm-value-input" onchange="window._autotaskModelChange(this.value)">';
  sel += '<option value=""' + (!d.model ? ' selected' : '') + '>' + h(inheritLabel) + '</option>';
  if (s && s.providers) {
    Object.keys(s.providers).forEach(provKey => {
      const prov = s.providers[provKey];
      if (!prov || !Array.isArray(prov.models)) return;
      prov.models.forEach(m => {
        const val = provKey + '|' + m;
        const isSel = d.provider === provKey && d.model === m;
        sel += '<option value="' + h(val) + '"' + (isSel ? ' selected' : '') + '>' + h(provKey) + ' / ' + h(m) + '</option>';
      });
    });
  }
  sel += '</select>';
  return sel;
}

function renderPreviewBlock() {
  if (!wizardPreview) {
    return '<div class="autotask-preview-loading">尚未测试</div>';
  }
  if (wizardPreview.loading) {
    return '<div class="autotask-preview-loading">测试中...</div>';
  }
  if (wizardPreview.error) {
    return '<div class="autotask-preview-error">⚠️ ' + h(wizardPreview.error)
      + ' <button class="autotask-action-btn" style="margin-left:8px" onclick="window._autotaskRefreshPreview()">重试</button></div>';
  }
  const items = wizardPreview.items || [];
  if (!items.length) {
    return '<div class="autotask-preview-loading" style="color:var(--fg-tertiary)">未找到任何条目</div>';
  }
  let s = '<ul class="autotask-preview-list">';
  items.slice(0, 3).forEach(it => {
    s += '<li class="autotask-preview-item">';
    s += '<div>' + h(it.title || '无标题') + '</div>';
    if (it.url) s += '<div style="font-size:11px;color:var(--fg-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + h(it.url) + '</div>';
    s += '</li>';
  });
  s += '</ul>';
  return s;
}

/* ── Inline edit handlers (registered on window for inline events) ── */
window._autotaskInlineCommit = function (field, el) {
  if (!el || !wizardDraft) return;
  const v = el.value;
  setDraftField(field, v);
};
window._autotaskInlineCancel = function () {
  inlineEditingField = null;
  renderWizardStep2();
};
window._autotaskRefreshPreview = function () { refreshPreview(); };
window._autotaskModelChange = function (v) {
  if (!wizardDraft) return;
  if (!v) { wizardDraft.provider = null; wizardDraft.model = null; }
  else {
    const idx = v.indexOf('|');
    wizardDraft.provider = v.slice(0, idx);
    wizardDraft.model = v.slice(idx + 1);
  }
};

export function editFieldInline(fieldName) {
  inlineEditingField = fieldName;
  renderWizardStep2();
  // Focus the new input
  setTimeout(() => {
    const wiz = $('autotaskWizard');
    if (!wiz) return;
    const inp = wiz.querySelector('.autotask-confirm-value-input');
    if (inp) {
      inp.focus();
      if (inp.select && inp.tagName === 'INPUT') inp.select();
    }
  }, 10);
}

export function setDraftField(fieldName, value) {
  if (!wizardDraft) return;
  let urlChanged = false;
  let typeChanged = false;
  if (fieldName === 'name') {
    wizardDraft.name = String(value || '').trim();
  } else if (fieldName === 'sourceType') {
    if (wizardDraft.sourceType !== value) typeChanged = true;
    wizardDraft.sourceType = value;
  } else if (fieldName === 'url') {
    const newUrl = String(value || '').trim();
    if (!wizardDraft.sourceConfig) wizardDraft.sourceConfig = {};
    if (wizardDraft.sourceConfig.url !== newUrl) urlChanged = true;
    wizardDraft.sourceConfig.url = newUrl;
  } else if (fieldName === 'schedule') {
    wizardDraft.schedule = value;
  } else if (fieldName === 'scheduleTime') {
    wizardDraft.scheduleTime = value;
  } else if (fieldName === 'topic') {
    wizardDraft.topic = value;
  } else if (fieldName === 'maxItems') {
    const n = parseInt(value);
    if (!wizardDraft.sourceConfig) wizardDraft.sourceConfig = {};
    wizardDraft.sourceConfig.maxItems = (Number.isFinite(n) && n >= 1 && n <= 50) ? n : 5;
  } else if (fieldName === 'keywords') {
    if (!wizardDraft.filters) wizardDraft.filters = { keywords: [], excludeKeywords: [] };
    wizardDraft.filters.keywords = String(value || '').split(',').map(s => s.trim()).filter(Boolean);
  } else if (fieldName === 'excludeKeywords') {
    if (!wizardDraft.filters) wizardDraft.filters = { keywords: [], excludeKeywords: [] };
    wizardDraft.filters.excludeKeywords = String(value || '').split(',').map(s => s.trim()).filter(Boolean);
  }
  inlineEditingField = null;
  renderWizardStep2();
  // Auto-refresh preview only when URL changed (debounced); type change does NOT auto-trigger
  if (urlChanged && wizardDraft.sourceConfig && wizardDraft.sourceConfig.url) {
    if (previewDebounceTimer) clearTimeout(previewDebounceTimer);
    previewDebounceTimer = setTimeout(() => { refreshPreview(); }, 600);
  }
}

/* ── Preview ── */
async function refreshPreview() {
  if (!wizardDraft) return;
  const url = wizardDraft.sourceConfig && wizardDraft.sourceConfig.url;
  if (!url) {
    wizardPreview = { items: [], error: '请先填写 URL' };
    if (wizardStep === 2) renderWizardStep2();
    return;
  }
  wizardPreview = { loading: true };
  if (wizardStep === 2) renderWizardStep2();
  try {
    const res = await post('/api/autotask/test-source', {
      sourceType: wizardDraft.sourceType,
      sourceConfig: wizardDraft.sourceConfig
    });
    wizardPreview = { items: res.items || [], total: res.total };
  } catch (e) {
    wizardPreview = { items: [], error: '测试失败: ' + (e.message || '') };
  }
  if (wizardStep === 2) renderWizardStep2();
}

/* ── Step 2 actions ── */
export async function submitWizardIterate() {
  if (wizardBusy) return;
  const ta = $('autotaskIterateInput');
  const instruction = ta ? (ta.value || '').trim() : '';
  if (!instruction) { toast('请描述要修改的地方'); return; }
  wizardBusy = true;
  const btn = $('autotaskIterateBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'AI 解析中...'; }
  try {
    const res = await postRaw('/api/autotask/parse-nl', {
      current: wizardDraft,
      instruction
    });
    if (!res || !res.ok || !res.config) {
      throw new Error((res && res.error) || 'AI 解析失败');
    }
    wizardDraft = res.config;
    wizardWarnings = Array.isArray(res.warnings) ? res.warnings : [];
    renderWizardStep2();
    refreshPreview();
  } catch (e) {
    toast('AI 解析失败: ' + (e.message || ''));
    if (btn) { btn.disabled = false; btn.textContent = '再次解析'; }
  } finally {
    wizardBusy = false;
  }
}

export function backToWizardStep1() {
  wizardStep = 1;
  // Don't drop wizardDraft — user may go forward again
  renderWizardStep1();
}

export function toggleWizardAdvanced() {
  wizardAdvancedOpen = !wizardAdvancedOpen;
  renderWizardStep2();
}

export async function confirmWizardCreate() {
  if (wizardBusy) return;
  if (!wizardDraft) { toast('没有可保存的配置'); return; }
  const d = wizardDraft;
  if (!d.name || !d.name.trim()) { toast('请填写任务名称'); return; }
  if (!d.sourceConfig || !d.sourceConfig.url) { toast('请填写 URL'); return; }

  wizardBusy = true;
  const btn = $('autotaskConfirmBtn');
  if (btn) { btn.disabled = true; btn.textContent = '保存中...'; }

  const body = {
    name: d.name.trim(),
    sourceType: d.sourceType,
    sourceConfig: { url: d.sourceConfig.url, maxItems: d.sourceConfig.maxItems || 5 },
    schedule: d.schedule,
    scheduleTime: d.schedule === 'daily' ? d.scheduleTime : undefined,
    topic: d.topic || 'auto',
    filters: {
      keywords: (d.filters && d.filters.keywords) || [],
      excludeKeywords: (d.filters && d.filters.excludeKeywords) || []
    },
    nlSummary: wizardNLValue || null,
    templateId: d._templateId || null,
    provider: d.provider || null,
    model: d.model || null
  };

  try {
    if (wizardTaskId) {
      await put('/api/autotask/' + wizardTaskId, body);
      toast('任务已更新');
    } else {
      await post('/api/autotask', body);
      toast('任务已创建');
    }
    closeAutotaskModal();
    const c = $('content');
    if (c) await rAutotask(c);
  } catch (e) {
    toast('保存失败: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = wizardTaskId ? '保存修改' : '确认创建'; }
  } finally {
    wizardBusy = false;
  }
}

/* ── Detail modal ── */
export function closeAutotaskDetail() {
  const modal = $('autotaskDetailModal');
  if (modal) modal.classList.remove('open');
}

export async function showRunDetail(runId) {
  const modal = $('autotaskDetailModal');
  const content = $('autotaskDetailContent');
  if (!modal || !content) return;
  modal.classList.add('open');
  content.innerHTML = '<div style="padding:20px;text-align:center;color:var(--fg-tertiary)">加载中...</div>';
  try {
    const run = await api('/api/autotask/history/' + runId);
    let s = '<div class="autotask-detail-info">';
    s += '<div class="autotask-detail-row"><span class="autotask-detail-label">任务</span><span>' + h(run.taskName || '未知') + '</span></div>';
    s += '<div class="autotask-detail-row"><span class="autotask-detail-label">状态</span><span>' + runStatusText(run) + '</span></div>';
    s += '<div class="autotask-detail-row"><span class="autotask-detail-label">开始时间</span><span>' + (run.startedAt ? new Date(run.startedAt).toLocaleString('zh-CN') : '-') + '</span></div>';
    if (run.finishedAt) {
      s += '<div class="autotask-detail-row"><span class="autotask-detail-label">结束时间</span><span>' + new Date(run.finishedAt).toLocaleString('zh-CN') + '</span></div>';
    }
    if (run.itemsFound != null) {
      s += '<div class="autotask-detail-row"><span class="autotask-detail-label">找到</span><span>' + run.itemsFound + ' 项</span></div>';
    }
    if (run.error) {
      s += '<div class="autotask-detail-row"><span class="autotask-detail-label">错误</span><span style="color:var(--red)">' + h(run.error) + '</span></div>';
    }
    s += '</div>';
    const items = run.items || [];
    if (items.length) {
      s += '<div class="autotask-detail-items-head">处理明细 (' + items.length + ')</div>';
      s += '<div class="autotask-detail-items">';
      items.forEach(it => {
        const stColor = it.status === 'ingested' ? 'var(--green)' : it.status === 'skipped' ? 'var(--fg-tertiary)' : 'var(--red)';
        const stLabel = it.status === 'ingested' ? '入库' : it.status === 'skipped' ? '跳过' : '错误';
        const titleStr = h(it.title || '无标题');
        const titleHtml = it.articlePath
          ? '<a href="#/article/' + h(it.articlePath) + '" onclick="closeAutotaskDetail()">' + titleStr + '</a>'
          : titleStr;
        s += '<div class="autotask-detail-item">';
        s += '<div class="autotask-detail-item-title">' + titleHtml + '</div>';
        if (it.url) s += '<div class="autotask-detail-item-url"><a href="' + h(it.url) + '" target="_blank" rel="noopener">' + h(it.url.length > 60 ? it.url.slice(0, 58) + '...' : it.url) + '</a></div>';
        s += '<div class="autotask-detail-item-status"><span style="color:' + stColor + '">' + stLabel + '</span>';
        if (it.reason) s += ' · ' + h(it.reason);
        s += '</div></div>';
      });
      s += '</div>';
    }
    content.innerHTML = s;
  } catch (e) {
    content.innerHTML = '<div style="padding:20px;text-align:center;color:var(--red)">加载失败: ' + h(e.message) + '</div>';
  }
}

/* ── Actions ── */
export async function runAutotask(taskId) {
  try {
    await post('/api/autotask/' + taskId + '/run', {});
    toast('任务已触发执行');
  } catch (e) {
    toast('执行失败: ' + e.message);
  }
}

export async function toggleAutotaskEnabled(taskId) {
  try {
    const res = await api('/api/autotask/' + taskId + '/toggle');
    const t = tasks.find(x => x.id === taskId);
    if (t) t.enabled = res.enabled;
    toast(res.enabled ? '任务已启用' : '任务已暂停');
  } catch (e) {
    toast('操作失败: ' + e.message);
    const c = $('content');
    if (c) renderPage(c);
  }
}

export async function deleteAutotask(taskId) {
  if (!confirm('确定要删除这个任务吗？')) return;
  try {
    await apiDel('/api/autotask/' + taskId);
    tasks = tasks.filter(t => t.id !== taskId);
    toast('任务已删除');
    const c = $('content');
    if (c) renderPage(c);
  } catch (e) {
    toast('删除失败: ' + e.message);
  }
}

export async function testAutotaskSource(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) { toast('找不到任务'); return; }

  const modal = $('autotaskDetailModal');
  const titleEl = $('autotaskDetailTitle');
  const content = $('autotaskDetailContent');
  if (!modal || !content) return;
  if (titleEl) titleEl.textContent = '测试结果 - ' + (task.name || '');
  modal.classList.add('open');
  content.innerHTML = '<div style="padding:20px;text-align:center;color:var(--fg-tertiary)">测试中...</div>';

  try {
    const res = await post('/api/autotask/test-source', {
      sourceType: task.sourceType,
      sourceConfig: task.sourceConfig
    });
    const items = res.items || [];
    if (!items.length) {
      content.innerHTML = '<div style="padding:20px;text-align:center;color:var(--fg-tertiary)">未找到任何条目</div>';
      return;
    }
    let s = '<div class="autotask-test-summary">找到 ' + items.length + ' 条内容</div>';
    s += '<div class="autotask-detail-items">';
    items.forEach(it => {
      s += '<div class="autotask-detail-item">';
      s += '<div class="autotask-detail-item-title">' + h(it.title || '无标题') + '</div>';
      if (it.url) s += '<div class="autotask-detail-item-url"><a href="' + h(it.url) + '" target="_blank" rel="noopener">' + h(it.url.length > 60 ? it.url.slice(0, 58) + '...' : it.url) + '</a></div>';
      s += '</div>';
    });
    s += '</div>';
    content.innerHTML = s;
  } catch (e) {
    content.innerHTML = '<div style="padding:20px;text-align:center;color:var(--red)">测试失败: ' + h(e.message) + '</div>';
  }
}

/* ── Internal: postRaw — POST returning parsed body even on non-2xx (for parse-nl error detail) ── */
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
