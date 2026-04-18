import { $, h, api, put, post, toast } from './utils.js';
import { t, setLang, getLang } from './i18n.js';
import state from './state.js';
import { renderMemory } from './memory.js';

/* ── tab switching ── */

export function openSettings() { $('settingsModal').classList.add('open'); loadSett(); }
export function closeSettings() { $('settingsModal').classList.remove('open'); }

export function switchSettingsTab(tab) {
  document.querySelectorAll('.settings-tab').forEach(te => te.classList.toggle('active', te.dataset.tab === tab));
  $('settingsTabGeneral').style.display  = tab === 'general'  ? '' : 'none';
  $('settingsTabProvider').style.display = tab === 'provider' ? '' : 'none';
  $('settingsTabMemory').style.display   = tab === 'memory'   ? '' : 'none';
  const pipe = $('settingsTabPipeline'); if (pipe) pipe.style.display = tab === 'pipeline' ? '' : 'none';
  if (tab === 'memory') renderMemory($('settingsTabMemory'));
  if (tab === 'pipeline') loadPipeline();
}

/* ── helpers: normalize model list across old/new schemas ── */

// Old schema: prov.models = ['id1','id2']
// New schema: prov.models = [{id,label,use,thinkingCapable,defaultThinking,isBuiltin}, ...]
function normalizeModels(list) {
  if (!Array.isArray(list)) return [];
  return list.map(m => {
    if (typeof m === 'string') return { id: m, label: m, use: 'main', thinkingCapable: false, defaultThinking: false, isBuiltin: true };
    return {
      id: m.id || '',
      label: m.label || m.id || '',
      use: m.use || 'main',
      thinkingCapable: !!m.thinkingCapable,
      defaultThinking: !!m.defaultThinking,
      isBuiltin: m.isBuiltin !== false,
    };
  });
}

function currentProvKey() { return $('sProv') ? $('sProv').value : (state.sCache && state.sCache.provider) || 'local'; }

function getWorkingModels(provKey) {
  // state.sModels is the editable working copy keyed by provider
  if (!state.sModels) state.sModels = {};
  if (!state.sModels[provKey]) {
    const p = state.sCache && state.sCache.providers && state.sCache.providers[provKey];
    state.sModels[provKey] = normalizeModels(p && p.models);
  }
  return state.sModels[provKey];
}

/* ── custom select helpers ── */

function buildCustomSelect(wrapId, hiddenId, options, currentValue) {
  const wrap = $(wrapId);
  const trigger = wrap && wrap.querySelector('.custom-select-trigger');
  const list = wrap && wrap.querySelector('.custom-select-list');
  const hidden = $(hiddenId);
  if (!wrap || !trigger || !list || !hidden) return;
  hidden.value = currentValue;
  let s = '';
  let label = '';
  options.forEach(o => {
    const active = o.value === currentValue ? ' active' : '';
    if (o.value === currentValue) label = o.label;
    s += '<div class="custom-select-opt' + active + '" data-value="' + h(o.value) + '">' + h(o.label) + '</div>';
  });
  list.innerHTML = s;
  trigger.textContent = label;
  if (!wrap.__wired) {
    trigger.addEventListener('click', () => {
      document.querySelectorAll('.custom-select.open').forEach(cs => { if (cs !== wrap) cs.classList.remove('open'); });
      wrap.classList.toggle('open');
    });
    list.addEventListener('click', ev => {
      const opt = ev.target.closest('.custom-select-opt');
      if (!opt) return;
      const val = opt.dataset.value;
      hidden.value = val;
      trigger.textContent = opt.textContent;
      list.querySelectorAll('.custom-select-opt').forEach(o => o.classList.toggle('active', o.dataset.value === val));
      wrap.classList.remove('open');
    });
    document.addEventListener('click', ev => {
      if (!wrap.contains(ev.target)) wrap.classList.remove('open');
    });
    wrap.__wired = true;
  }
}

/* ── load ── */

async function loadSett() {
  try {
    const s = await api('/api/settings'); state.sCache = s;
    state.sModels = {}; // reset working copy on each load
    const prov = $('sProv'); prov.innerHTML = '';
    if (s.providers) for (const [k, v] of Object.entries(s.providers)) { const o = document.createElement('option'); o.value = k; o.textContent = v.name; prov.appendChild(o); }
    prov.value = s.provider || 'local'; $('sKey').value = ''; $('sKey').placeholder = s.hasKey ? t('settings.apiKeySet') : t('settings.apiKeyPH');
    buildCustomSelect('sLangWrap', 'sLang', [
      { value: 'zh', label: t('settings.langZh') },
      { value: 'en', label: t('settings.langEn') },
      { value: 'ja', label: t('settings.langJa') },
      { value: 'ko', label: t('settings.langKo') },
      { value: 'auto', label: t('settings.langAuto') },
    ], s.wikiLang || 'zh');
    buildCustomSelect('sUiLangWrap', 'sUiLang', [
      { value: 'en', label: 'English' },
      { value: 'ja', label: '\u65E5\u672C\u8A9E' },
      { value: 'ko', label: '\uD55C\uAD6D\uC5B4' },
      { value: 'zh', label: '\u4E2D\u6587' },
    ], getLang());
    // customBaseUrl 回填：仅 custom provider 才显示该字段，其它 provider 保持值但隐藏
    const cbu = $('sCustomBaseUrl'); if (cbu) cbu.value = s.customBaseUrl || '';
    onProvChange();
    wireProviderSection();
  } catch {}
  // Load profile
  try {
    const p = await api('/api/profile');
    $('sNickname').value = p.nickname || '';
  } catch { $('sNickname').value = ''; }
}

/* ── provider change: refresh main-model dropdown + model-list table ── */

export function onProvChange() {
  const p = currentProvKey();
  const models = getWorkingModels(p);
  const ms = $('sModel'); ms.innerHTML = '';
  models.forEach(m => {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label || m.id;
    ms.appendChild(o);
  });
  if (state.sCache && state.sCache.model) ms.value = state.sCache.model;
  // custom provider 才露出 Base URL 输入框；其它 provider 隐藏不删（保留已填值）
  const row = $('sCustomBaseUrlRow'); if (row) row.style.display = (p === 'custom') ? '' : 'none';
  renderModelList();
}

function renderModelList() {
  const tbl = $('modelListTable'); if (!tbl) return;
  const p = currentProvKey();
  const models = getWorkingModels(p);
  if (!models.length) {
    tbl.innerHTML = '<div class=”model-list-empty”>' + h(t('settings.modelEmpty')) + '</div>';
    return;
  }
  // 表头 + 行（仅 3 列：ID / 显示名 / 删除）
  const header = `
    <div class="model-row model-row-head">
      <div class="mr-col-head">${h(t('settings.modelId'))}</div>
      <div class="mr-col-head">${h(t('settings.modelLabel'))}</div>
      <div class="mr-col-head"></div>
    </div>`;
  tbl.innerHTML = header + models.map((m, i) => `
    <div class="model-row" data-idx="${i}">
      <input class="mr-id" data-f="id" value="${h(m.id)}" placeholder="model id">
      <input class="mr-label" data-f="label" value="${h(m.label)}" placeholder="${h(t('settings.modelLabel'))}">
      <button class="mr-delete" type="button" data-action="del" title="${h(t('common.delete'))}" aria-label="${h(t('common.delete'))}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
      </button>
    </div>
  `).join('');
  // wire input/select/checkbox changes
  tbl.querySelectorAll('.model-row').forEach(row => {
    const idx = parseInt(row.dataset.idx, 10);
    row.querySelectorAll('[data-f]').forEach(el => {
      el.addEventListener('change', () => updateModelField(idx, el.dataset.f, el.type === 'checkbox' ? el.checked : el.value));
      if (el.tagName === 'INPUT' && el.type !== 'checkbox') {
        el.addEventListener('input', () => updateModelField(idx, el.dataset.f, el.value));
      }
    });
    const del = row.querySelector('[data-action="del"]');
    if (del) del.addEventListener('click', () => { deleteModel(idx); });
  });
}

function updateModelField(idx, field, value) {
  const models = getWorkingModels(currentProvKey());
  if (!models[idx]) return;
  models[idx][field] = value;
  // If id/label changed, the main-model dropdown labels may need refresh
  if (field === 'id' || field === 'label') {
    const ms = $('sModel'); if (ms) {
      const prev = ms.value;
      ms.innerHTML = '';
      models.forEach(m => { const o = document.createElement('option'); o.value = m.id; o.textContent = m.label || m.id; ms.appendChild(o); });
      ms.value = prev || (models[0] && models[0].id) || '';
    }
  }
}

function deleteModel(idx) {
  const p = currentProvKey();
  const models = getWorkingModels(p);
  if (!models[idx]) return;
  models.splice(idx, 1);
  renderModelList();
  // refresh main-model select
  onProvChange.refreshOnly = true; // no-op flag; just re-run
  const ms = $('sModel'); if (ms) {
    const prev = ms.value;
    ms.innerHTML = '';
    models.forEach(m => { const o = document.createElement('option'); o.value = m.id; o.textContent = m.label || m.id; ms.appendChild(o); });
    if (models.find(m => m.id === prev)) ms.value = prev;
  }
}

function addModel() {
  const p = currentProvKey();
  const models = getWorkingModels(p);
  models.push({ id: '', label: '', use: 'main', thinkingCapable: false, defaultThinking: false, isBuiltin: false });
  renderModelList();
}

async function restoreDefaults() {
  const p = currentProvKey();
  try {
    const resp = await api('/api/models/defaults?provider=' + encodeURIComponent(p));
    // Tolerate either a bare array OR {models:[...]} wrapping
    const list = Array.isArray(resp) ? resp : (resp && Array.isArray(resp.models) ? resp.models : []);
    state.sModels[p] = normalizeModels(list);
    renderModelList();
    onProvChange();
    toast(t('settings.restoredDefaults'));
  } catch (e) {
    // fallback: re-read from cache
    const pc = state.sCache && state.sCache.providers && state.sCache.providers[p];
    state.sModels[p] = normalizeModels(pc && pc.models);
    renderModelList();
    onProvChange();
    toast(t('settings.restoredCache'));
  }
}

function wireProviderSection() {
  const addBtn = $('addModelBtn');
  const restoreBtn = $('restoreDefaultsBtn');
  if (addBtn && !addBtn.__wired) { addBtn.addEventListener('click', addModel); addBtn.__wired = true; }
  if (restoreBtn && !restoreBtn.__wired) { restoreBtn.addEventListener('click', restoreDefaults); restoreBtn.__wired = true; }
}

/* ── save ── */

// 核心保存逻辑；silent=true 时不 toast、不关弹窗（用于"测试连接"前静默保存）
async function doSave({ silent = false } = {}) {
  const prov = $('sProv').value;
  const uiLangEl = $('sUiLang'); const uiLangValue = uiLangEl ? uiLangEl.value : '';
  const body = { provider: prov, model: $('sModel').value, wikiLang: $('sLang').value };
  if (uiLangValue) body.uiLang = uiLangValue;
  const k = $('sKey').value; if (k) body.apiKey = k;
  // customBaseUrl 始终带上（后端只在 provider=custom 时生效，保留值在其它 provider 下也 OK）
  const cbu = $('sCustomBaseUrl'); if (cbu) body.customBaseUrl = (cbu.value || '').trim();
  if (state.sModels && Object.keys(state.sModels).length) {
    body.providers = {};
    for (const [pk, models] of Object.entries(state.sModels)) {
      body.providers[pk] = { models };
    }
  }
  await put('/api/settings', body); state.sCache = null;
  const nickname = $('sNickname').value.trim();
  let existingBio = '';
  try { const p = await api('/api/profile'); existingBio = p.bio || ''; } catch {}
  await put('/api/profile', { nickname, bio: existingBio });
  if (uiLangValue) { setLang(uiLangValue); if (window.render) window.render(); }
  updateSidebarTitle(nickname);
  if (!silent) { toast(t('common.saved')); closeSettings(); }
}

export async function saveSett() {
  try { await doSave({ silent: false }); }
  catch (e) { toast(t('common.saveFailed', { msg: e.message })); }
}

export async function testConn() {
  const btn = $('testConnBtn');
  if (btn) { btn.disabled = true; btn.textContent = t('settings.testing'); }
  try {
    await doSave({ silent: true });
    const r = await post('/api/settings/test', {});
    if (r.ok) {
      toast(r.message ? t('settings.connOkMsg', { msg: r.message }) : t('settings.connOk'));
    } else {
      toast(t('settings.connFail', { msg: r.message || 'unknown' }));
    }
  } catch (e) {
    toast(t('settings.testFail', { msg: e.message }));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('settings.testConn'); }
  }
}

/* ── Sidebar title with username ── */
export function updateSidebarTitle(nickname) {
  const el = $('sidebarTitle');
  const title = nickname ? t('nav.kbOf', { name: nickname }) : t('nav.kb');
  if (el) el.textContent = title;
  document.title = title;
}

export async function initSidebarTitle() {
  try {
    const p = await api('/api/profile');
    updateSidebarTitle((p && p.nickname) || '');
  } catch {}
}

/* ──────────────────────────────────────────────────────────────────── */
/* Pipeline tab                                                         */
/* ──────────────────────────────────────────────────────────────────── */

const DEFAULT_PIPELINE = {
  preset: 'balanced',
  stages: {
    title:    { source: 'code' },
    topic:    { source: 'user' },
    filename: { source: 'code' },
    content:  { model: '', thinking: false, stream: true, retryModel: '', maxTokens: 16384 },
    summary:  { source: 'llm', model: '', maxLength: 30 },
    seealso:  { source: 'code_plus_llm', model: '', topK: 5 },
  },
};

// Preset recipes using placeholder tokens <fast>/<main>/<strong>
const PRESET_RECIPES = {
  fast: {
    content: { model: '<fast>',   thinking: false, stream: true, retryModel: '<main>',   maxTokens: 16384 },
    summary: { source: 'inline' },
    seealso: { source: 'code', topK: 3 },
  },
  balanced: {
    content: { model: '<main>',   thinking: false, stream: true, retryModel: '<fast>',   maxTokens: 16384 },
    summary: { source: 'llm', model: '<fast>', maxLength: 30 },
    seealso: { source: 'code_plus_llm', model: '<fast>', topK: 5 },
  },
  quality: {
    content: { model: '<strong>', thinking: false, stream: true, retryModel: '<main>',   maxTokens: 16384 },
    summary: { source: 'llm', model: '<main>', maxLength: 30 },
    seealso: { source: 'code_plus_llm', model: '<main>', topK: 5 },
  },
};

function resolveModelRef(ref, models, defaultModel) {
  if (!ref) return defaultModel || (models[0] && models[0].id) || '';
  if (ref === '<fast>' || ref === '<main>' || ref === '<strong>') {
    const use = ref.slice(1, -1);
    const hit = models.find(m => m.use === use);
    if (hit) return hit.id;
    return defaultModel || (models[0] && models[0].id) || '';
  }
  return ref; // concrete id
}

function resolvePreset(key) {
  const p = currentProvKey();
  const models = getWorkingModels(p);
  const defaultModel = (state.sCache && state.sCache.providers && state.sCache.providers[p] && state.sCache.providers[p].defaultModel) || '';
  const recipe = PRESET_RECIPES[key];
  if (!recipe) return null;
  // Deep clone with placeholder resolution
  const stages = {
    title:    { source: 'code' },
    topic:    { source: 'user' },
    filename: { source: 'code' },
    content: {
      ...recipe.content,
      model:      resolveModelRef(recipe.content.model,      models, defaultModel),
      retryModel: resolveModelRef(recipe.content.retryModel, models, defaultModel),
    },
    summary:  { ...recipe.summary },
    seealso:  { ...recipe.seealso },
  };
  if (stages.summary.model) stages.summary.model = resolveModelRef(stages.summary.model, models, defaultModel);
  if (stages.seealso.model) stages.seealso.model = resolveModelRef(stages.seealso.model, models, defaultModel);
  return stages;
}

async function loadPipeline() {
  // Initialize state.pipeline from server cache or defaults
  const cached = state.sCache && state.sCache.pipeline;
  if (cached && cached.stages) {
    state.pipeline = JSON.parse(JSON.stringify(cached));
  } else if (!state.pipeline) {
    state.pipeline = { preset: 'balanced', stages: resolvePreset('balanced') || DEFAULT_PIPELINE.stages };
  }
  renderPipeline();
  wirePipelineControls();
}

function modelOptions(selectedId) {
  const p = currentProvKey();
  const models = getWorkingModels(p);
  return models.map(m => `<option value="${h(m.id)}" ${m.id===selectedId?'selected':''}>${h(m.label || m.id)}</option>`).join('');
}

function renderPipeline() {
  const host = $('pipelineStages'); if (!host) return;
  const pl = state.pipeline; if (!pl || !pl.stages) return;
  const s = pl.stages;

  // Update preset buttons
  document.querySelectorAll('#pipelinePresetRow .preset-btn').forEach(b => b.classList.toggle('active', b.dataset.preset === pl.preset));
  // 自定义按钮：只要有自定义快照就显示；active 只在当前就是自定义态时亮
  const customBtn = document.querySelector('#pipelinePresetRow .preset-btn-custom');
  if (customBtn) customBtn.hidden = !(state.customPipeline && state.customPipeline.stages);

  host.innerHTML = `
    <div class="stage-card">
      <div class="stage-card-head">${h(t('pipeline.titleExtract'))}</div>
      <div class="stage-card-body">
        <span class="stage-hint">${h(t('pipeline.titleHint'))}</span>
      </div>
    </div>
    <div class="stage-card">
      <div class="stage-card-head">${h(t('pipeline.topicClassify'))}</div>
      <div class="stage-card-body">
        <label class="radio-line"><input type="radio" name="pl-topic" value="user" ${s.topic.source==='user'?'checked':''}> ${h(t('pipeline.userChoice'))}</label>
        <label class="radio-line"><input type="radio" name="pl-topic" value="llm"  ${s.topic.source==='llm'?'checked':''}> ${h(t('pipeline.llmAuto'))}</label>
        <select class="field-select stage-model" data-stage="topic" ${s.topic.source==='llm'?'':'disabled'}>${modelOptions(s.topic.model || '')}</select>
      </div>
    </div>
    <div class="stage-card">
      <div class="stage-card-head">${h(t('pipeline.contentCompile'))}</div>
      <div class="stage-card-body">
        <div class="stage-field"><label>${h(t('pipeline.model'))}</label><select class="field-select" id="plContentModel">${modelOptions(s.content.model || '')}</select></div>
        <div class="stage-field"><label><input type="checkbox" id="plContentThinking" ${s.content.thinking?'checked':''}> ${h(t('pipeline.enableThinking'))}</label></div>
        <div class="stage-field"><label><input type="checkbox" id="plContentStream"   ${s.content.stream?'checked':''}> ${h(t('pipeline.streaming'))}</label></div>
        <div class="stage-field"><label>${h(t('pipeline.maxTokens'))}</label><input class="field-input" type="number" id="plContentMaxTokens" value="${s.content.maxTokens||16384}" min="512" max="131072"></div>
        <div class="stage-field"><label>${h(t('pipeline.retryModel'))}</label><select class="field-select" id="plContentRetry">${modelOptions(s.content.retryModel || '')}</select></div>
      </div>
    </div>
    <div class="stage-card">
      <div class="stage-card-head">${h(t('pipeline.summaryGen'))}</div>
      <div class="stage-card-body">
        <label class="radio-line"><input type="radio" name="pl-summary" value="llm"    ${s.summary.source==='llm'?'checked':''}> ${h(t('pipeline.llmIndependent'))}</label>
        <label class="radio-line"><input type="radio" name="pl-summary" value="inline" ${s.summary.source==='inline'?'checked':''}> ${h(t('pipeline.mergeContent'))}</label>
        <label class="radio-line"><input type="radio" name="pl-summary" value="skip"   ${s.summary.source==='skip'?'checked':''}> ${h(t('pipeline.skip'))}</label>
        <div class="stage-field"><label>${h(t('pipeline.model'))}</label><select class="field-select" id="plSummaryModel" ${s.summary.source==='llm'?'':'disabled'}>${modelOptions(s.summary.model || '')}</select></div>
        <div class="stage-field"><label>${h(t('pipeline.wordLimit'))}</label><input class="field-input" type="number" id="plSummaryMax" value="${s.summary.maxLength||30}" min="10" max="200"></div>
      </div>
    </div>
    <div class="stage-card">
      <div class="stage-card-head">${h(t('pipeline.seeAlso'))}</div>
      <div class="stage-card-body">
        <label class="radio-line"><input type="radio" name="pl-seealso" value="code_plus_llm" ${s.seealso.source==='code_plus_llm'?'checked':''}> ${h(t('pipeline.codePlusLlm'))}</label>
        <label class="radio-line"><input type="radio" name="pl-seealso" value="code"          ${s.seealso.source==='code'?'checked':''}> ${h(t('pipeline.codeOnly'))}</label>
        <label class="radio-line"><input type="radio" name="pl-seealso" value="skip"          ${s.seealso.source==='skip'?'checked':''}> ${h(t('pipeline.skip'))}</label>
        <div class="stage-field"><label>${h(t('pipeline.topK'))}</label><input class="field-input" type="number" id="plSeeK" value="${s.seealso.topK||5}" min="1" max="20"></div>
        <div class="stage-field"><label>${h(t('pipeline.curateModel'))}</label><select class="field-select" id="plSeeModel" ${s.seealso.source==='code_plus_llm'?'':'disabled'}>${modelOptions(s.seealso.model || '')}</select></div>
      </div>
    </div>
  `;
  wireStageInputs();
}

function markCustom() {
  if (!state.pipeline) return;
  state.pipeline.preset = 'custom';
  // 快照保留，方便用户切到预设后再点"自定义"回到本次改动
  state.customPipeline = JSON.parse(JSON.stringify(state.pipeline));
  document.querySelectorAll('#pipelinePresetRow .preset-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.preset === 'custom');
  });
  const customBtn = document.querySelector('#pipelinePresetRow .preset-btn-custom');
  if (customBtn) customBtn.hidden = false; // 有快照才走到这里
}

function wireStageInputs() {
  const s = state.pipeline.stages;
  // Topic
  document.querySelectorAll('input[name="pl-topic"]').forEach(r => r.addEventListener('change', e => {
    s.topic.source = e.target.value;
    const sel = document.querySelector('.stage-model[data-stage="topic"]'); if (sel) sel.disabled = s.topic.source !== 'llm';
    markCustom();
  }));
  document.querySelectorAll('.stage-model').forEach(sel => sel.addEventListener('change', e => {
    const stage = e.target.dataset.stage;
    s[stage].model = e.target.value;
    markCustom();
  }));
  // Content
  const wire = (id, stageKey, field, type) => {
    const el = $(id); if (!el) return;
    el.addEventListener('change', () => {
      let v = type === 'checkbox' ? el.checked : (type === 'number' ? parseInt(el.value, 10) : el.value);
      s[stageKey][field] = v;
      markCustom();
    });
  };
  wire('plContentModel',     'content', 'model',      'text');
  wire('plContentThinking',  'content', 'thinking',   'checkbox');
  wire('plContentStream',    'content', 'stream',     'checkbox');
  wire('plContentMaxTokens', 'content', 'maxTokens',  'number');
  wire('plContentRetry',     'content', 'retryModel', 'text');
  // Summary
  document.querySelectorAll('input[name="pl-summary"]').forEach(r => r.addEventListener('change', e => {
    s.summary.source = e.target.value;
    const m = $('plSummaryModel'); if (m) m.disabled = s.summary.source !== 'llm';
    markCustom();
  }));
  wire('plSummaryModel', 'summary', 'model',     'text');
  wire('plSummaryMax',   'summary', 'maxLength', 'number');
  // See also
  document.querySelectorAll('input[name="pl-seealso"]').forEach(r => r.addEventListener('change', e => {
    s.seealso.source = e.target.value;
    const m = $('plSeeModel'); if (m) m.disabled = s.seealso.source !== 'code_plus_llm';
    markCustom();
  }));
  wire('plSeeK',     'seealso', 'topK',  'number');
  wire('plSeeModel', 'seealso', 'model', 'text');
}

function applyPreset(key) {
  if (key === 'custom') {
    // 恢复用户上次的自定义快照；没有就不动
    if (state.customPipeline && state.customPipeline.stages) {
      state.pipeline = JSON.parse(JSON.stringify(state.customPipeline));
      state.pipeline.preset = 'custom';
      renderPipeline();
    }
    return;
  }
  const stages = resolvePreset(key);
  if (!stages) return;
  state.pipeline = { preset: key, stages };
  renderPipeline();
}

async function savePipeline() {
  if (!state.pipeline) return;
  try {
    await put('/api/settings', { pipeline: state.pipeline });
    state.sCache = null;
    toast(t('settings.pipelineSaved'));
  } catch (e) {
    toast(t('common.saveFailed', { msg: e.message }));
  }
}

function wirePipelineControls() {
  document.querySelectorAll('#pipelinePresetRow .preset-btn').forEach(b => {
    if (b.__wired) return;
    b.addEventListener('click', () => applyPreset(b.dataset.preset));
    b.__wired = true;
  });
  const saveBtn = $('pipelineSaveBtn');
  const resetBtn = $('pipelineResetBtn');
  if (saveBtn && !saveBtn.__wired) { saveBtn.addEventListener('click', savePipeline); saveBtn.__wired = true; }
  if (resetBtn && !resetBtn.__wired) {
    resetBtn.addEventListener('click', () => {
      const cur = state.pipeline && state.pipeline.preset;
      applyPreset(cur && cur !== 'custom' ? cur : 'balanced');
    });
    resetBtn.__wired = true;
  }
}
