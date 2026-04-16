import { $, h, api, put, toast } from './utils.js';

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
  s += '<h3>记忆</h3>';
  s += '<p class="mem-desc">AI 对话时会参考这些信息来个性化回答，自由编辑即可</p>';
  s += '</div>';
  s += '<textarea class="mem-textarea" id="memTextarea" placeholder="写下任何你希望 AI 记住的信息...\n\n例如：\n我是产品经理，在做一款音乐 MV 工具\n偏好简洁的回答风格\n回答用中文">' + h(memText) + '</textarea>';
  s += '<div class="mem-footer">';
  s += '<span class="mem-hint" id="memHint"></span>';
  s += '<button class="btn-sm-fill" id="memSaveBtn" onclick="window._memSave()">保存</button>';
  s += '</div>';
  s += '</div>';
  container.innerHTML = s;

  const ta = $('memTextarea');
  ta.addEventListener('input', () => {
    const hint = $('memHint');
    if (ta.value !== memText) hint.textContent = '有未保存的更改';
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
    toast('已保存');
  } catch (e) { toast('保存失败: ' + e.message); }
};
