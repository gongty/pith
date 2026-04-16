import { $, h, relTime, api, post, put, apiDel, toast, go, skelLines } from '../utils.js';
import state from '../state.js';

/* ── Local state ── */
let currentTab = 'tasks';
let tasks = [];
let history = [];
let editingTaskId = null;
let topicsList = [];

/* ── Source type labels ── */
const SOURCE_LABELS = { rss: 'RSS', webpage: '网页', api: 'API' };
const SCHEDULE_LABELS = { daily: '每日', hourly: '每小时', manual: '仅手动' };
const STATUS_COLORS = { success: 'var(--green)', error: 'var(--red)', partial: 'var(--yellow)', running: 'var(--accent)' };

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

function runSummary(run) {
  if (!run) return '';
  let parts = [];
  if (run.itemsFound != null) parts.push(run.itemsFound + '/' + (run.itemsIngested != null ? (run.itemsIngested + ' 入库') : ''));
  if (run.itemsSkipped) parts.push(run.itemsSkipped + ' 跳过');
  return parts.join(' · ');
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
  s += '<button class="btn-fill" style="width:auto;padding:8px 20px;font-size:13px" onclick="openAutotaskModal()">+ 新建任务</button>';
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
      + '<button class="btn-fill" style="width:auto;padding:10px 24px" onclick="openAutotaskModal()">创建任务</button>'
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
    // Last run
    if (t.lastRunAt) {
      const stColor = t.lastRunStatus === 'success' ? 'var(--green)' : t.lastRunStatus === 'error' ? 'var(--red)' : t.lastRunStatus === 'partial' ? 'var(--yellow)' : 'var(--fg-tertiary)';
      const stLabel = t.lastRunStatus === 'success' ? '成功' : t.lastRunStatus === 'error' ? '失败' : t.lastRunStatus === 'partial' ? '部分成功' : (t.lastRunStatus || '');
      s += '<div class="autotask-card-status">';
      s += '最近执行: ' + relTime(t.lastRunAt) + ' · <span style="color:' + stColor + '">' + h(stLabel) + '</span>';
      s += '</div>';
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
  let s = '<div class="autotask-history-list">';
  history.forEach(run => {
    const dotColor = STATUS_COLORS[run.status] || 'var(--fg-tertiary)';
    s += '<div class="autotask-history-row">';
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
    s += '<div class="autotask-history-actions">';
    s += '<button class="autotask-action-btn" onclick="showRunDetail(\'' + h(run.id || run.runId) + '\')">详情</button>';
    s += '<button class="autotask-action-btn autotask-action-del" onclick="deleteRun(\'' + h(run.id || run.runId) + '\')">删除</button>';
    s += '</div>';
    s += '</div>';
  });
  s += '</div>';
  return s;
}

/* ── Tab switch ── */
export function switchAutotaskTab(tab) {
  currentTab = tab;
  const c = $('content');
  if (c) renderPage(c);
}

/* ── Modal: open/close/save ── */
export function openAutotaskModal(taskId) {
  editingTaskId = taskId || null;
  const modal = $('autotaskModal');
  const title = $('autotaskModalTitle');
  const form = $('autotaskForm');
  if (!modal || !form) return;

  const task = taskId ? tasks.find(t => t.id === taskId) : null;
  title.textContent = task ? '编辑任务' : '新建任务';

  // Build form
  let f = '';
  f += '<div><label class="field-label">任务名称</label>';
  f += '<input class="field-input" id="atName" placeholder="例如: Hacker News 精选" value="' + h(task ? task.name : '') + '"></div>';

  f += '<div><label class="field-label">数据源类型</label>';
  f += '<select class="field-select" id="atSourceType" onchange="document.getElementById(\'atSourceType\').dispatchEvent(new Event(\'_change\'))">';
  f += '<option value="rss"' + (task && task.sourceType === 'rss' ? ' selected' : '') + '>RSS</option>';
  f += '<option value="webpage"' + (task && task.sourceType === 'webpage' ? ' selected' : '') + '>网页</option>';
  f += '<option value="api"' + (task && task.sourceType === 'api' ? ' selected' : '') + '>API</option>';
  f += '</select></div>';

  f += '<div><label class="field-label">源地址 URL</label>';
  f += '<input class="field-input" id="atUrl" placeholder="https://..." value="' + h(task && task.sourceConfig ? (task.sourceConfig.url || '') : '') + '"></div>';

  f += '<div><label class="field-label">最大条数</label>';
  f += '<input class="field-input" id="atMaxItems" type="number" min="1" max="100" value="' + (task && task.sourceConfig ? (task.sourceConfig.maxItems || 5) : 5) + '"></div>';

  f += '<div style="display:flex;gap:10px">';
  f += '<div style="flex:1"><label class="field-label">执行频率</label>';
  f += '<select class="field-select" id="atSchedule" onchange="document.getElementById(\'atTimeRow\').style.display=this.value===\'daily\'?\'block\':\'none\'">';
  f += '<option value="daily"' + (task && task.schedule === 'daily' ? ' selected' : '') + '>每日</option>';
  f += '<option value="hourly"' + (task && task.schedule === 'hourly' ? ' selected' : '') + '>每小时</option>';
  f += '<option value="manual"' + (task && task.schedule === 'manual' ? ' selected' : '') + '>仅手动</option>';
  f += '</select></div>';
  f += '<div id="atTimeRow" style="flex:1' + (task && task.schedule !== 'daily' ? ';display:none' : '') + '">';
  f += '<label class="field-label">执行时间</label>';
  f += '<input class="field-input" id="atTime" type="time" value="' + h(task ? (task.scheduleTime || '08:00') : '08:00') + '"></div>';
  f += '</div>';

  f += '<div><label class="field-label">目标主题</label>';
  f += '<select class="field-select" id="atTopic">';
  f += '<option value="auto"' + (!task || task.topic === 'auto' ? ' selected' : '') + '>自动分类</option>';
  topicsList.forEach(tp => {
    f += '<option value="' + h(tp) + '"' + (task && task.topic === tp ? ' selected' : '') + '>' + h(tp) + '</option>';
  });
  f += '</select></div>';

  f += '<div><label class="field-label">包含关键词 (逗号分隔)</label>';
  f += '<input class="field-input" id="atInclude" placeholder="AI, LLM, transformer" value="' + h(task && task.filters && task.filters.keywords ? task.filters.keywords.join(', ') : '') + '"></div>';

  f += '<div><label class="field-label">排除关键词 (逗号分隔)</label>';
  f += '<input class="field-input" id="atExclude" placeholder="广告, 招聘" value="' + h(task && task.filters && task.filters.excludeKeywords ? task.filters.excludeKeywords.join(', ') : '') + '"></div>';

  form.innerHTML = f;

  // Fix timeRow visibility based on initial schedule value
  const schedEl = $('atSchedule');
  const timeRow = $('atTimeRow');
  if (schedEl && timeRow) {
    timeRow.style.display = schedEl.value === 'daily' ? 'block' : 'none';
  }

  modal.classList.add('open');
}

export function closeAutotaskModal() {
  const modal = $('autotaskModal');
  if (modal) modal.classList.remove('open');
  editingTaskId = null;
}

export async function saveAutotask() {
  const name = ($('atName') || {}).value || '';
  const sourceType = ($('atSourceType') || {}).value || 'rss';
  const url = ($('atUrl') || {}).value || '';
  const maxItems = parseInt(($('atMaxItems') || {}).value) || 5;
  const schedule = ($('atSchedule') || {}).value || 'daily';
  const scheduleTime = ($('atTime') || {}).value || '08:00';
  const topic = ($('atTopic') || {}).value || 'auto';
  const include = ($('atInclude') || {}).value || '';
  const exclude = ($('atExclude') || {}).value || '';

  if (!name.trim()) { toast('请输入任务名称'); return; }
  if (!url.trim()) { toast('请输入源地址'); return; }

  const body = {
    name: name.trim(),
    sourceType,
    sourceConfig: { url: url.trim(), maxItems },
    schedule,
    scheduleTime: schedule === 'daily' ? scheduleTime : undefined,
    topic,
    filters: {
      keywords: include.trim() ? include.split(',').map(s => s.trim()).filter(Boolean) : [],
      excludeKeywords: exclude.trim() ? exclude.split(',').map(s => s.trim()).filter(Boolean) : []
    }
  };

  try {
    const saveBtn = $('autotaskSaveBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中...'; }
    if (editingTaskId) {
      await put('/api/autotask/' + editingTaskId, body);
      toast('任务已更新');
    } else {
      await post('/api/autotask', body);
      toast('任务已创建');
    }
    closeAutotaskModal();
    // Refresh
    const c = $('content');
    if (c) await rAutotask(c);
  } catch (e) {
    toast('保存失败: ' + e.message);
    const saveBtn = $('autotaskSaveBtn');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存'; }
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
    // Items
    const items = run.items || [];
    if (items.length) {
      s += '<div class="autotask-detail-items-head">处理明细 (' + items.length + ')</div>';
      s += '<div class="autotask-detail-items">';
      items.forEach(it => {
        const stColor = it.status === 'ingested' ? 'var(--green)' : it.status === 'skipped' ? 'var(--fg-tertiary)' : 'var(--red)';
        const stLabel = it.status === 'ingested' ? '入库' : it.status === 'skipped' ? '跳过' : '错误';
        s += '<div class="autotask-detail-item">';
        s += '<div class="autotask-detail-item-title">' + h(it.title || '无标题') + '</div>';
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
    // Revert checkbox visually
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

export async function deleteRun(runId) {
  if (!confirm('确定要删除这条执行记录吗？')) return;
  try {
    await apiDel('/api/autotask/history/' + runId);
    history = history.filter(r => (r.id || r.runId) !== runId);
    toast('记录已删除');
    const c = $('content');
    if (c) renderPage(c);
  } catch (e) {
    toast('删除失败: ' + e.message);
  }
}

export async function testAutotaskSource(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) { toast('找不到任务'); return; }

  // Use detail modal for test results
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
