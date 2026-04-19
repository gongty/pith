import { $, h, jsAttr, api, put, toast, rotatePH } from './utils.js';
import { t } from './i18n.js';
import state from './state.js';

// localStorage key for "尚未创建会话时用户选的模型"
// convId 存在时模型存后端，无 convId 时持久化到这里，刷新后依然生效
const ASK_MODEL_KEY = 'wiki.askModel';
function loadAskModel() {
  try { const raw = localStorage.getItem(ASK_MODEL_KEY); if (!raw) return null; const v = JSON.parse(raw); if (v && v.provider && v.model) return v; } catch {}
  return null;
}
function saveAskModel(provider, model) { try { localStorage.setItem(ASK_MODEL_KEY, JSON.stringify({ provider, model })); } catch {} }

export function buildComposer(ctx) {
  let s = '<div class="chat-composer-wrap"><div class="chat-composer">';
  s += '<textarea class="chat-textarea" id="' + ctx + 'In" placeholder="' + h(t('ph.ask1')) + '" rows="1"></textarea>';
  s += '<div class="chat-toolbar"><div class="chat-toolbar-left">';
  s += '<button class="chat-attach-btn" title="' + h(t('composer.attach')) + '"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>';
  s += '</div><div class="chat-toolbar-right">';
  s += '<span class="chat-model-tag" id="' + ctx + 'ModelTag" onclick="toggleDD(\'' + jsAttr(ctx) + 'ModelDD\')"><span id="' + ctx + 'ModelName">' + h(t('settings.selectModel')) + '</span> <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></span>';
  s += '<button class="chat-send-btn" id="' + ctx + 'SendBtn" disabled><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>';
  s += '</div></div></div>';
  s += '<div class="chat-model-dropdown" id="' + ctx + 'ModelDD"></div>';
  s += '</div>';
  return s;
}

// 每个 ctx 只允许一个 placeholder 轮换定时器；重新 init 时先清掉老的，避免路由切换累积
const __phTimers = {};
export function initComposer(ctx, sendFn, override) {
  loadModels(ctx + 'ModelDD', ctx + 'ModelTag', override);
  const inp = $(ctx + 'In'), btn = $(ctx + 'SendBtn');
  if (!inp || !btn) return;
  const send = () => { btn.classList.add('bounce'); setTimeout(() => btn.classList.remove('bounce'), 260); sendFn(); };
  inp.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  inp.oninput = () => { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 160) + 'px'; btn.disabled = !inp.value.trim(); };
  btn.onclick = send;
  if (__phTimers[ctx]) clearInterval(__phTimers[ctx]);
  rotatePH(ctx + 'In');
  __phTimers[ctx] = setInterval(() => rotatePH(ctx + 'In'), 5000);
}

export async function loadModels(ddId, tagId, override) {
  try {
    const s = state.sCache || await api('/api/settings'); state.sCache = s;
    const dd = $(ddId); const tag = $(tagId); if (!dd || !tag) return;
    // override 存在时用它决定 dropdown 的 active 项和 tag 文案；
    // 否则无 convId 时读 localStorage 里的 ask 模型；再 fallback 全局默认
    let askSaved = null;
    if (!override && !state.convId) {
      askSaved = loadAskModel();
      // 同步补回 state.pendingModel，让 chat.js 首条消息 body 带上这个模型
      if (askSaved && !state.pendingModel) state.pendingModel = { provider: askSaved.provider, model: askSaved.model };
    }
    const effProv = (override && override.provider) || (askSaved && askSaved.provider) || s.provider || 'local';
    const effModel = (override && override.model) || (askSaved && askSaved.model) || s.model;
    let html = '';
    const prov = s.providers && s.providers[effProv];
    if (prov) {
      prov.models.filter(m => !(m && typeof m === 'object' && m.use === 'embed')).forEach(m => {
        const id = (m && typeof m === 'object') ? m.id : m;
        const label = (m && typeof m === 'object') ? (m.label || m.id) : m;
        const active = (effModel === id) ? ' active' : '';
        html += '<div class="chat-model-opt' + active + '" data-v="' + effProv + '|' + id + '" data-id="' + h(id) + '" onclick="pickModel(this,\'' + jsAttr(ddId) + '\',\'' + jsAttr(tagId) + '\')">' + h(label) + '</div>';
      });
    }
    dd.innerHTML = html;
    // 从 prov.models 里查 label 展示，找不到 fallback 到原始 id
    let displayText = effModel || t('settings.selectModel');
    if (prov && effModel) {
      const found = prov.models.find(m => {
        const id = (m && typeof m === 'object') ? m.id : m;
        return id === effModel;
      });
      if (found) displayText = (found && typeof found === 'object') ? (found.label || found.id) : found;
    }
    const nameEl = document.getElementById(tagId.replace('Tag', 'Name'));
    if (nameEl) nameEl.textContent = displayText;
    else tag.firstChild.textContent = displayText;
  } catch {}
}

export function toggleDD(id) { $(id).classList.toggle('open'); }

export function pickModel(el, ddId, tagId) {
  $(ddId).querySelectorAll('.chat-model-opt').forEach(o => o.classList.remove('active'));
  el.classList.add('active');
  const nameEl = document.getElementById(tagId.replace('Tag', 'Name'));
  if (nameEl) nameEl.textContent = el.textContent;
  $(ddId).classList.remove('open');
  // 持久化：有会话则写后端（乐观更新，失败只 toast 不回滚 DOM）；否则暂存到 pendingModel
  const v = el.dataset && el.dataset.v;
  if (!v) return;
  const sep = v.indexOf('|');
  if (sep <= 0) return;
  const provider = v.slice(0, sep);
  const model = v.slice(sep + 1);
  if (state.convId) {
    // 同步更新 override，避免下次 loadModels 读到旧值
    state.currentConvOverride = { provider, model };
    put('/api/chat/' + state.convId + '/model', { provider, model }).catch(() => toast(t('chat.modelSwitchFailed')));
  } else {
    state.pendingModel = { provider, model };
    // 同时落盘，下次刷新 / 回到 dashboard 仍保留这个选择
    saveAskModel(provider, model);
  }
}
