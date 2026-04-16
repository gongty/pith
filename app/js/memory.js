import { $, h, api, post, put, apiDel, toast } from './utils.js';

const CATEGORIES = [
  { key: 'personal', label: '个人信息', desc: '身份、职业、团队、公司' },
  { key: 'expertise', label: '专业领域', desc: '擅长什么、了解多少' },
  { key: 'preference', label: '偏好设置', desc: '语言、风格、习惯' },
  { key: 'context', label: '背景上下文', desc: '当前在做什么、关注什么' }
];

let memoryData = { items: [] };

async function loadMemoryData() {
  try {
    memoryData = await api('/api/memory');
  } catch { memoryData = { items: [] }; }
}

function itemsByCategory(cat) {
  return memoryData.items.filter(m => m.category === cat);
}

function renderCategorySection(cat) {
  const items = itemsByCategory(cat.key);
  const isOpen = items.length > 0;
  let s = `<div class="mem-category" data-cat="${cat.key}">`;
  s += `<div class="mem-cat-header" onclick="window._memToggleCat('${cat.key}')">`;
  s += `<svg class="mem-cat-arrow${isOpen ? ' open' : ''}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;
  s += `<span class="mem-cat-title">${h(cat.label)}</span>`;
  s += `<span class="mem-cat-desc">${h(cat.desc)}</span>`;
  s += `<span class="mem-cat-count">${items.length}</span>`;
  s += `</div>`;
  s += `<div class="mem-cat-body${isOpen ? ' open' : ''}">`;
  for (const item of items) {
    s += renderItem(item);
  }
  s += `<div class="mem-add-row" id="memAddRow_${cat.key}" style="display:none">`;
  s += `<input class="field-input mem-inline-input" id="memAddLabel_${cat.key}" placeholder="标签（如：职业角色）">`;
  s += `<input class="field-input mem-inline-input" id="memAddContent_${cat.key}" placeholder="内容（如：产品经理）">`;
  s += `<div class="mem-add-actions">`;
  s += `<button class="btn-sm-fill" onclick="window._memConfirmAdd('${cat.key}')">确认</button>`;
  s += `<button class="btn-outline" onclick="window._memCancelAdd('${cat.key}')">取消</button>`;
  s += `</div></div>`;
  s += `<button class="mem-add-btn" id="memAddBtn_${cat.key}" onclick="window._memShowAdd('${cat.key}')">+ 添加</button>`;
  s += `</div></div>`;
  return s;
}

function renderItem(item) {
  let s = `<div class="mem-item" data-id="${h(item.id)}">`;
  s += `<div class="mem-item-main">`;
  s += `<span class="mem-item-label" contenteditable="true" data-field="label" data-id="${h(item.id)}" onblur="window._memEditField(this)">${h(item.label)}</span>`;
  s += `<span class="mem-item-sep">:</span>`;
  s += `<span class="mem-item-content" contenteditable="true" data-field="content" data-id="${h(item.id)}" onblur="window._memEditField(this)">${h(item.content)}</span>`;
  s += `</div>`;
  s += `<div class="mem-item-actions">`;
  s += `<label class="mem-toggle"><input type="checkbox" ${item.active ? 'checked' : ''} onchange="window._memToggleActive('${h(item.id)}', this.checked)"><span class="mem-toggle-slider"></span></label>`;
  s += `<button class="mem-del-btn" onclick="window._memDelete('${h(item.id)}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>`;
  s += `</div></div>`;
  return s;
}

export async function renderMemory(container) {
  await loadMemoryData();
  let s = '<div class="mem-panel">';
  s += '<div class="mem-header">';
  s += '<h3>记忆</h3>';
  s += '<p class="mem-desc">AI 对话时会参考这些信息来个性化回答</p>';
  s += '</div>';
  for (const cat of CATEGORIES) {
    s += renderCategorySection(cat);
  }
  s += '</div>';
  container.innerHTML = s;
}

// ── 交互函数（挂到 window） ──

window._memToggleCat = function (catKey) {
  const el = document.querySelector(`.mem-category[data-cat="${catKey}"]`);
  if (!el) return;
  const arrow = el.querySelector('.mem-cat-arrow');
  const body = el.querySelector('.mem-cat-body');
  arrow.classList.toggle('open');
  body.classList.toggle('open');
};

window._memShowAdd = function (catKey) {
  const row = $('memAddRow_' + catKey);
  const btn = $('memAddBtn_' + catKey);
  if (row) row.style.display = '';
  if (btn) btn.style.display = 'none';
  const labelInput = $('memAddLabel_' + catKey);
  if (labelInput) labelInput.focus();
};

window._memCancelAdd = function (catKey) {
  const row = $('memAddRow_' + catKey);
  const btn = $('memAddBtn_' + catKey);
  if (row) { row.style.display = 'none'; $('memAddLabel_' + catKey).value = ''; $('memAddContent_' + catKey).value = ''; }
  if (btn) btn.style.display = '';
};

window._memConfirmAdd = async function (catKey) {
  const label = ($('memAddLabel_' + catKey).value || '').trim();
  const content = ($('memAddContent_' + catKey).value || '').trim();
  if (!label || !content) { toast('标签和内容不能为空'); return; }
  try {
    await post('/api/memory', { category: catKey, label, content });
    toast('已添加');
    const container = document.querySelector('.mem-panel')?.parentElement;
    if (container) await renderMemory(container);
  } catch (e) { toast('添加失败: ' + e.message); }
};

window._memEditField = async function (el) {
  const id = el.dataset.id;
  const field = el.dataset.field;
  const value = el.textContent.trim();
  if (!value) { toast('内容不能为空'); await reloadMemoryUI(); return; }
  try {
    await put('/api/memory/' + id, { [field]: value });
  } catch { toast('更新失败'); await reloadMemoryUI(); }
};

window._memToggleActive = async function (id, active) {
  try {
    await put('/api/memory/' + id, { active });
    toast(active ? '已启用' : '已停用');
  } catch { toast('更新失败'); }
};

window._memDelete = async function (id) {
  try {
    await apiDel('/api/memory/' + id);
    toast('已删除');
    await reloadMemoryUI();
  } catch { toast('删除失败'); }
};

async function reloadMemoryUI() {
  const container = document.querySelector('.mem-panel')?.parentElement;
  if (container) await renderMemory(container);
}
