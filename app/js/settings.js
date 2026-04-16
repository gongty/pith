import { $, api, put, post, toast } from './utils.js';
import state from './state.js';
import { renderMemory } from './memory.js';

export function openSettings() { $('settingsModal').classList.add('open'); loadSett(); }
export function closeSettings() { $('settingsModal').classList.remove('open'); }

export function switchSettingsTab(tab) {
  document.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $('settingsTabGeneral').style.display = tab === 'general' ? '' : 'none';
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
    $('sLang').value = s.wikiLang || 'zh';
    onProvChange();
  } catch {}
  // Load profile
  try {
    const p = await api('/api/profile');
    $('sNickname').value = p.nickname || '';
  } catch { $('sNickname').value = ''; }
}

export function onProvChange() {
  const p = $('sProv').value; const ms = $('sModel'); ms.innerHTML = '';
  if (state.sCache && state.sCache.providers && state.sCache.providers[p]) state.sCache.providers[p].models.forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = m; ms.appendChild(o); });
  if (state.sCache && state.sCache.model) ms.value = state.sCache.model;
}

export async function saveSett() {
  const b = { provider: $('sProv').value, model: $('sModel').value, wikiLang: $('sLang').value }; const k = $('sKey').value; if (k) b.apiKey = k;
  try {
    await put('/api/settings', b); state.sCache = null;
    // Save nickname via profile API (preserve existing bio)
    const nickname = $('sNickname').value.trim();
    let existingBio = '';
    try { const p = await api('/api/profile'); existingBio = p.bio || ''; } catch {}
    await put('/api/profile', { nickname, bio: existingBio });
    updateSidebarTitle(nickname);
    toast('已保存'); closeSettings();
  } catch (e) { toast('失败: ' + e.message); }
}

export async function testConn() {
  try { await saveSett(); const r = await post('/api/settings/test', {}); toast(r.ok ? '连接成功' : '失败: ' + r.message); } catch (e) { toast('测试失败'); }
}

/* ── Sidebar title with username ── */
export function updateSidebarTitle(nickname) {
  const el = $('sidebarTitle');
  if (el) el.textContent = nickname ? nickname + ' 的知识库' : '知识库';
  document.title = nickname ? nickname + ' 的知识库' : '知识库';
}

export async function initSidebarTitle() {
  try {
    const p = await api('/api/profile');
    if (p && p.nickname) updateSidebarTitle(p.nickname);
  } catch {}
}
