import { $, h, api, put, toast } from './utils.js';
import { t } from './i18n.js';

let memText = '';

async function loadMemoryText() {
  try {
    const data = await api('/api/memory');
    memText = data.text || '';
  } catch { memText = ''; }
}

export async function renderMemory(container) {
  await loadMemoryText();
  let s = '<div class="mem-panel">';
  s += '<div class="mem-header">';
  s += '<h3>' + h(t('memory.title')) + '</h3>';
  s += '<p class="mem-desc">' + h(t('memory.desc')) + '</p>';
  s += '</div>';
  s += '<textarea class="mem-textarea" id="memTextarea" placeholder="' + h(t('memory.placeholder')) + '">' + h(memText) + '</textarea>';
  s += '<div class="mem-footer">';
  s += '<span class="mem-hint" id="memHint"></span>';
  s += '<button class="btn-sm-fill" id="memSaveBtn" onclick="window._memSave()">' + h(t('common.save')) + '</button>';
  s += '</div>';
  s += '</div>';
  container.innerHTML = s;

  const ta = $('memTextarea');
  ta.addEventListener('input', () => {
    const hint = $('memHint');
    if (ta.value !== memText) hint.textContent = t('memory.unsaved');
    else hint.textContent = '';
  });
}

window._memSave = async function () {
  const ta = $('memTextarea');
  if (!ta) return;
  const text = ta.value;
  try {
    await put('/api/memory', { text });
    memText = text;
    $('memHint').textContent = '';
    toast(t('common.saved'));
  } catch (e) { toast(t('common.saveFailed', { msg: e.message })); }
};
