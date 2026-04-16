import { $, api, put, post, toast } from './utils.js';
import state from './state.js';
import { renderMemory } from './memory.js';

export function openSettings() { $('settingsModal').classList.add('open'); loadSett(); }
export function closeSettings() { $('settingsModal').classList.remove('open'); }

export function switchSettingsTab(tab) {
  document.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $('settingsTabProvider').style.display = tab === 'provider' ? '' : 'none';
  $('settingsTabMemory').style.display = tab === 'memory' ? '' : 'none';
  if (tab === 'memory') renderMemory($('settingsTabMemory'));
}

async function loadSett() {
  try {
    const s = await api('/api/settings'); state.sCache = s;
    const prov = $('sProv'); prov.innerHTML = '';
    if (s.providers) for (const [k, v] of Object.entries(s.providers)) { const o = document.createElement('option'); o.value = k; o.textContent = v.name; prov.appendChild(o); }
    prov.value = s.provider || 'local'; $('sKey').value = ''; $('sKey').placeholder = s.hasKey ? '已配置 (输入覆盖)' : '输入 API Key...';
    onProvChange();
  } catch {}
}

export function onProvChange() {
  const p = $('sProv').value; const ms = $('sModel'); ms.innerHTML = '';
  if (state.sCache && state.sCache.providers && state.sCache.providers[p]) state.sCache.providers[p].models.forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = m; ms.appendChild(o); });
  if (state.sCache && state.sCache.model) ms.value = state.sCache.model;
}

export async function saveSett() {
  const b = { provider: $('sProv').value, model: $('sModel').value }; const k = $('sKey').value; if (k) b.apiKey = k;
  try { await put('/api/settings', b); state.sCache = null; toast('已保存'); closeSettings(); } catch (e) { toast('失败: ' + e.message); }
}

export async function testConn() {
  try { await saveSett(); const r = await post('/api/settings/test', {}); toast(r.ok ? '连接成功' : '失败: ' + r.message); } catch (e) { toast('测试失败'); }
}
