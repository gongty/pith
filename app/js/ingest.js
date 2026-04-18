import { $, h, api, toast, go } from './utils.js';
import { t } from './i18n.js';
import state from './state.js';
import { updSidebarPages } from './sidebar.js';
import { openIngestQueue } from './ingest-queue.js';

// ── 文件类型检测 ──

const FILE_TYPE_MAP = {
  pdf:  { type: 'pdf',   icon: '\u{1F4C4}', labelKey: null },
  png:  { type: 'image', icon: '\u{1F5BC}', labelKey: 'file.image' },
  jpg:  { type: 'image', icon: '\u{1F5BC}', labelKey: 'file.image' },
  jpeg: { type: 'image', icon: '\u{1F5BC}', labelKey: 'file.image' },
  webp: { type: 'image', icon: '\u{1F5BC}', labelKey: 'file.image' },
  gif:  { type: 'image', icon: '\u{1F5BC}', labelKey: 'file.image' },
  mp3:  { type: 'audio', icon: '\u{1F3B5}', labelKey: 'file.audio' },
  wav:  { type: 'audio', icon: '\u{1F3B5}', labelKey: 'file.audio' },
  m4a:  { type: 'audio', icon: '\u{1F3B5}', labelKey: 'file.audio' },
  ogg:  { type: 'audio', icon: '\u{1F3B5}', labelKey: 'file.audio' },
  mp4:  { type: 'video', icon: '\u{1F3AC}', labelKey: 'file.video' },
  webm: { type: 'video', icon: '\u{1F3AC}', labelKey: 'file.video' },
  txt:  { type: 'text',  icon: '\u{1F4DD}', labelKey: 'file.text' },
  md:   { type: 'text',  icon: '\u{1F4DD}', labelKey: 'file.text' },
  html: { type: 'text',  icon: '\u{1F4DD}', labelKey: 'file.text' },
  json: { type: 'text',  icon: '\u{1F4DD}', labelKey: 'file.text' },
  csv:  { type: 'text',  icon: '\u{1F4DD}', labelKey: 'file.text' },
  xml:  { type: 'text',  icon: '\u{1F4DD}', labelKey: 'file.text' },
  zip:  { type: 'zip',   icon: '\u{1F4E6}', labelKey: null },
};

function detectFileType(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const entry = FILE_TYPE_MAP[ext] || { type: 'text', icon: '\u{1F4DD}', labelKey: 'file.text' };
  return { ...entry, label: entry.labelKey ? t(entry.labelKey) : (ext === 'pdf' ? 'PDF' : 'ZIP') };
}

function isBinaryType(type) {
  return ['pdf', 'image', 'audio', 'video'].includes(type);
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1] || reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

// ── URL chips ──

const MAX_URLS = 10;
let _ingestUrls = [];

function isUrl(s) { return /^https?:\/\/.{3,}/.test(s.trim()); }

function addIngestUrl(url) {
  url = url.trim();
  if (!url || !isUrl(url)) return false;
  if (_ingestUrls.length >= MAX_URLS) { toast(t('ingest.maxUrls', {n: MAX_URLS})); return false; }
  if (_ingestUrls.includes(url)) return false;
  _ingestUrls.push(url);
  renderUrlChips();
  return true;
}

export function removeIngestUrl(i) {
  _ingestUrls.splice(i, 1);
  renderUrlChips();
}

function renderUrlChips() {
  const wrap = $('ingestUrlChips');
  const ta = $('ingestContent');
  if (!_ingestUrls.length) {
    wrap.style.display = 'none';
    ta.placeholder = t('ingest.placeholder');
    ta.style.minHeight = '200px';
    $('ingestBtn').textContent = t('ingest.compile');
    return;
  }
  wrap.style.display = 'flex';
  wrap.innerHTML = _ingestUrls.map((u, i) => {
    const short = u.replace(/^https?:\/\//, '').slice(0, 45) + (u.length > 55 ? '...' : '');
    return '<div class="url-chip"><span class="url-chip-icon">🔗</span><span class="url-chip-text" title="' + h(u) + '">' + h(short) + '</span><button class="url-chip-del" onclick="removeIngestUrl(' + i + ')">×</button></div>';
  }).join('');
  ta.placeholder = _ingestUrls.length < MAX_URLS ? t('ingest.moreUrls') : t('ingest.urlLimit', {n: MAX_URLS});
  ta.style.minHeight = '60px';
  $('ingestBtn').textContent = _ingestUrls.length > 1 ? t('ingest.compileN', {n: _ingestUrls.length}) : t('ingest.compile');
}

function initIngestUrlDetect() {
  const ta = $('ingestContent'); if (!ta) return;
  ta.addEventListener('paste', e => {
    const text = (e.clipboardData || window.clipboardData).getData('text').trim();
    // Check if pasted text contains one or more URLs
    const lines = text.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean);
    const urls = lines.filter(l => isUrl(l));
    if (urls.length > 0 && urls.length === lines.length) {
      // All lines are URLs — add as chips
      e.preventDefault();
      urls.forEach(u => addIngestUrl(u));
      ta.value = '';
    } else if (urls.length === 1 && lines.length === 1) {
      // Single URL pasted
      e.preventDefault();
      addIngestUrl(urls[0]);
      ta.value = '';
    }
  });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const val = ta.value.trim();
      if (isUrl(val)) {
        e.preventDefault();
        addIngestUrl(val);
        ta.value = '';
      }
    }
  });
}

// ── 面板开关 ──

export function openIngest() { $('ingestOverlay').classList.add('open'); loadTopics(); loadModels2('ingestModel'); resetIngestUI(); initIngestUrlDetect(); }
export function closeIngest() { $('ingestOverlay').classList.remove('open'); }

function resetIngestUI() {
  state.batchFiles = [];
  state.pendingBinaryFile = null;
  _ingestUrls = [];
  $('ingestContent').value = '';
  $('ingestBtn').disabled = false;
  $('ingestBtn').textContent = t('ingest.compile');
  $('ingestBatchPreview').style.display = 'none';
  $('ingestBatchList').innerHTML = '';
  $('ingestFileName').textContent = '';
  $('ingestUrlChips').innerHTML = '';
  $('ingestUrlChips').style.display = 'none';
  $('ingestContent').placeholder = t('ingest.placeholder');
  $('ingestFile').value = '';
}

// ── 拖拽 & 文件处理 ──

export function initIngestDragDrop() {
  const dz = $('ingestDropZone'); if (!dz) return;
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 1) { handleMultipleFiles(files); }
    else if (files.length === 1) {
      const ft = detectFileType(files[0].name);
      if (ft.type === 'zip') { handleZipFile(files[0]); }
      else if (isBinaryType(ft.type)) { handleBinaryFile(files[0]); }
      else { readIngestFile(files[0]); }
    }
  });
  const fi = $('ingestFile');
  if (fi) fi.addEventListener('change', e => {
    const files = e.target.files;
    if (!files.length) return;
    if (files.length > 1) { handleMultipleFiles(files); }
    else {
      const ft = detectFileType(files[0].name);
      if (ft.type === 'zip') { handleZipFile(files[0]); }
      else if (isBinaryType(ft.type)) { handleBinaryFile(files[0]); }
      else { readIngestFile(files[0]); }
    }
  });
}

function readIngestFile(f) {
  state.batchFiles = [];
  state.pendingBinaryFile = null;
  $('ingestBatchPreview').style.display = 'none';
  const reader = new FileReader();
  reader.onload = () => { $('ingestContent').value = reader.result; $('ingestFileName').textContent = f.name; };
  reader.readAsText(f);
}

async function handleBinaryFile(f) {
  state.batchFiles = [];
  $('ingestBatchPreview').style.display = 'none';
  const ft = detectFileType(f.name);
  $('ingestFileName').textContent = ft.icon + ' ' + f.name;
  $('ingestContent').value = '';
  $('ingestContent').placeholder = ft.icon + ' ' + t('ingest.binarySelected', {label: ft.label});
  try {
    const b64 = await readFileAsBase64(f);
    state.pendingBinaryFile = { type: ft.type, content: b64, filename: f.name };
  } catch (e) {
    toast(t('ingest.readFailed', {msg: e.message}));
    $('ingestFileName').textContent = '';
  }
}

async function handleMultipleFiles(fileList) {
  state.batchFiles = [];
  state.pendingBinaryFile = null;
  let loaded = 0;
  const total = fileList.length;
  $('ingestFileName').textContent = t('ingest.filesSelected', {n: total});
  $('ingestContent').value = '';
  for (let i = 0; i < total; i++) {
    const f = fileList[i];
    const ft = detectFileType(f.name);
    if (ft.type === 'zip') { handleZipFile(f); return; }
    if (isBinaryType(ft.type)) {
      readFileAsBase64(f).then(b64 => {
        state.batchFiles.push({ name: f.name, content: b64, checked: true, fileType: ft.type, isBinary: true, filename: f.name });
        loaded++;
        if (loaded === total) showBatchPreview();
      }).catch(() => { loaded++; if (loaded === total) showBatchPreview(); });
    } else {
      readFileAsText(f).then(text => {
        state.batchFiles.push({ name: f.name, content: text, checked: true, fileType: 'text', isBinary: false });
        loaded++;
        if (loaded === total) showBatchPreview();
      }).catch(() => { loaded++; if (loaded === total) showBatchPreview(); });
    }
  }
}

async function handleZipFile(f) {
  $('ingestFileName').textContent = f.name + ' ' + t('ingest.extracting');
  $('ingestBtn').disabled = true;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const base64 = reader.result.split(',')[1];
      const resp = await fetch('/api/ingest/extract-zip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: base64 }) });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || t('ingest.zipFailed', {msg: ''}));
      state.batchFiles = result.files.map(f => ({ ...f, checked: true, fileType: 'text', isBinary: false }));
      $('ingestFileName').textContent = f.name + ' ' + t('ingest.zipFiles', {n: state.batchFiles.length});
      showBatchPreview();
    } catch (e) {
      toast(t('ingest.zipFailed', {msg: e.message}));
      $('ingestFileName').textContent = '';
    }
    $('ingestBtn').disabled = false;
  };
  reader.readAsDataURL(f);
}

function showBatchPreview() {
  const preview = $('ingestBatchPreview'); const list = $('ingestBatchList'); const summary = $('ingestBatchSummary');
  preview.style.display = 'block';
  summary.textContent = t('ingest.totalFiles', {n: state.batchFiles.length});
  list.innerHTML = state.batchFiles.map((f, i) => {
    const ft = detectFileType(f.name);
    const typeTag = f.isBinary ? '<span class="batch-type-tag type-' + ft.type + '">' + ft.icon + ' ' + ft.label + '</span>' : '';
    return '<div class="ingest-batch-item"><input type="checkbox" ' + (f.checked ? 'checked' : '') + ' onchange="batchFileToggle(' + i + ',this.checked)">' + typeTag + '<span class="batch-file-name" title="' + h(f.name) + '">' + h(f.name) + '</span></div>';
  }).join('');
  updateBatchSummary();
}

export function batchFileToggle(i, checked) { state.batchFiles[i].checked = checked; updateBatchSummary(); }

export function batchToggleAll(v) {
  state.batchFiles.forEach(f => f.checked = v);
  $('ingestBatchList').querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = v);
  updateBatchSummary();
}

function updateBatchSummary() {
  const checked = state.batchFiles.filter(f => f.checked).length;
  $('ingestBatchSummary').textContent = t('ingest.selectedFiles', {n: checked, total: state.batchFiles.length});
  $('ingestBtn').textContent = checked > 1 ? t('ingest.compileFiles', {n: checked}) : t('ingest.compile');
}

async function loadTopics() {
  try { const tree = state.td || await api('/api/wiki/tree'); state.td = tree; const s = $('ingestTopic'); const v = s.value; s.innerHTML = '<option value="auto">' + h(t('ingest.autoClassify')) + '</option>'; if (tree) tree.forEach(tp => { const o = document.createElement('option'); o.value = tp.name; o.textContent = tp.name; s.appendChild(o); }); if (v) s.value = v; } catch {}
}

async function loadModels2(id) {
  try {
    const s = state.sCache || await api('/api/settings'); state.sCache = s;
    const sel = $(id); if (!sel) return; sel.innerHTML = '';
    // 只显示当前配置的提供商的模型，没配 key 的渠道不展示
    const provKey = s.provider || 'local';
    const prov = s.providers && s.providers[provKey];
    if (prov && Array.isArray(prov.models)) prov.models.forEach(m => {
      const mid   = typeof m === 'string' ? m : (m && m.id) || '';
      const label = typeof m === 'string' ? m : (m && (m.label || m.id)) || '';
      if (!mid) return;
      const o = document.createElement('option');
      o.value = provKey + '|' + mid;
      o.textContent = label;
      sel.appendChild(o);
    });
    // 恢复上次选择，没有则用设置默认值
    const saved = localStorage.getItem('ingestModel');
    if (saved) sel.value = saved;
    if (!sel.value && s.provider && s.model) sel.value = s.provider + '|' + s.model;
    sel.onchange = () => localStorage.setItem('ingestModel', sel.value);
  } catch {}
}

// ── 提交 → 关闭面板 → 后台跟踪 ──

export async function submitIngest() {
  // Pre-check: API key
  try {
    const settings = state.sCache || await api('/api/settings');
    state.sCache = settings;
    if (!settings.hasKey && settings.provider !== 'local') {
      toast(t('ingest.configKey')); return;
    }
  } catch {}

  const checkedBatch = state.batchFiles.filter(f => f.checked);
  const content = $('ingestContent').value.trim();
  const hasPendingBinary = !!state.pendingBinaryFile && !content;
  const hasUrls = _ingestUrls.length > 0;
  const isBatch = checkedBatch.length > 1 || _ingestUrls.length > 1;

  if (!isBatch && !hasUrls && !content && !hasPendingBinary && checkedBatch.length === 0) { toast(t('ingest.enterContent')); return; }

  const topic = $('ingestTopic').value;
  const model = $('ingestModel');
  const btn = $('ingestBtn');
  btn.disabled = true;
  btn.textContent = t('ingest.submitting');

  let modelBody = {};
  if (model && model.value) { const p = model.value.split('|'); if (p.length === 2) { modelBody.provider = p[0]; modelBody.model = p[1]; } }

  // 构建请求体
  let bodyData;
  if (hasUrls) {
    // URL chips mode — single or batch
    if (_ingestUrls.length === 1 && !checkedBatch.length) {
      bodyData = { type: 'url', content: _ingestUrls[0], topic, ...modelBody };
    } else {
      const items = _ingestUrls.map(u => ({ type: 'url', content: u, url: u, topic, name: u.replace(/^https?:\/\//, '').slice(0, 40) }));
      // Also include any checked file batch items
      checkedBatch.forEach(f => {
        if (f.isBinary) items.push({ type: f.fileType, content: f.content, topic, name: f.name, filename: f.filename || f.name });
        else items.push({ type: 'text', content: f.content, topic, name: f.name });
      });
      bodyData = { items, ...modelBody };
    }
  } else if (isBatch) {
    const items = checkedBatch.map(f => {
      if (f.isBinary) return { type: f.fileType, content: f.content, topic, name: f.name, filename: f.filename || f.name };
      return { type: 'text', content: f.content, topic, name: f.name };
    });
    bodyData = { items, ...modelBody };
  } else if (hasPendingBinary) {
    const bf = state.pendingBinaryFile;
    bodyData = { type: bf.type, content: bf.content, filename: bf.filename, topic, ...modelBody };
  } else if (checkedBatch.length === 1 && checkedBatch[0].isBinary) {
    const bf = checkedBatch[0];
    bodyData = { type: bf.fileType, content: bf.content, filename: bf.name, topic, ...modelBody };
  } else if (checkedBatch.length === 1) {
    bodyData = { type: 'text', content: checkedBatch[0].content, topic, ...modelBody };
  } else {
    const type = isUrl(content) ? 'url' : 'text';
    bodyData = { type, content, topic, ...modelBody };
  }

  try {
    const resp = await fetch('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyData)
    });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(result.error || t('ingest.compileFailed'));
    }

    closeIngest();
    if (result.skippedDuplicates && result.skippedDuplicates.length > 0) {
      toast(t('ingest.dupSkipped', {n: result.skippedDuplicates.length}));
    }
    if (typeof window.refreshIngestQueue === 'function') window.refreshIngestQueue();
    openIngestQueue();
  } catch (e) {
    toast(t('ingest.submitFailed', {msg: e.message}));
    btn.disabled = false;
    btn.textContent = t('ingest.compile');
  }
}

// ── 全局进度追踪（面板关闭后持续运行） ──

const STAGE_ICONS = { pending:'○', running:'▶', done:'✓', error:'✕', skipped:'⊘' };
const STAGE_ORDER = ['title','topic','content','summary','filename','seealso','persist'];
const STAGE_NUM   = ['①','②','③','④','⑤','⑥','⑦'];

function stageMeta(st) {
  const parts = [];
  if (st.source) {
    if (st.source.startsWith('llm:')) parts.push(st.source.slice(4));
    else if (st.source === 'code') parts.push(t('stage.code'));
    else if (st.source === 'user') parts.push(t('stage.user'));
    else if (st.source === 'llm')  parts.push('LLM');
    else if (st.source === 'code_plus_llm') parts.push(t('stage.codePlusLlm'));
    else if (st.source === 'piggyback_on_content') parts.push(t('stage.piggyback'));
    else parts.push(st.source);
  }
  if (typeof st.durationMs === 'number') parts.push(st.durationMs + 'ms');
  return parts.join(' · ');
}

function renderStages(stages) {
  const host = $('itStages'); if (!host) return;
  host.innerHTML = renderStagesHtml(stages);
}

function renderStagesHtml(stages) {
  const sorted = (stages || []).slice().sort((a, b) => {
    const ia = STAGE_ORDER.indexOf(a.key); const ib = STAGE_ORDER.indexOf(b.key);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return sorted.map(st => {
    const ki = STAGE_ORDER.indexOf(st.key);
    const prefix = ki >= 0 ? STAGE_NUM[ki] + ' ' : '';
    const icon = STAGE_ICONS[st.status] || '○';
    return `<div class="stage-row" data-key="${h(st.key||'')}" data-status="${h(st.status||'pending')}">
      <span class="stage-icon">${icon}</span>
      <span class="stage-label">${prefix}${h(st.label || st.key || '')}</span>
      <span class="stage-meta">${h(stageMeta(st))}</span>
      <span class="stage-detail">${h(st.detail || '')}</span>
    </div>`;
  }).join('');
}

function renderMultiTasks(items) {
  const host = $('itStages'); if (!host) return;
  host.innerHTML = items.map((tk, i) => {
    const running = (tk.stages || []).find(st => st.status === 'running');
    const title = tk.article?.title || (running ? running.label : (tk.message || tk.id));
    const cls = tk.status === 'done' ? 'task-done' : (tk.status === 'error' ? 'task-error' : 'task-running');
    return `<div class="task-group ${cls}">
      <div class="task-group-head"><span class="task-group-num">#${i+1}</span><span class="task-group-title">${h(title)}</span><span class="task-group-status">${h(tk.status)}</span></div>
      <div class="task-group-stages">${renderStagesHtml(tk.stages)}</div>
    </div>`;
  }).join('');
}

function computeStagePct(stages) {
  if (!stages || !stages.length) return 0;
  const done = stages.filter(s => s.status === 'done' || s.status === 'skipped').length;
  const running = stages.some(s => s.status === 'running') ? 0.5 : 0;
  return Math.round((done + running) / stages.length * 100);
}

function startProgressTracking(isBatch, totalFiles) {
  const el = $('ingestToast');
  el.className = 'ingest-toast show';
  el.onclick = null;
  el.style.cursor = '';
  $('itTitle').textContent = isBatch ? t('ingest.compilingN', {done: 0, total: totalFiles}) : t('ingest.compiling');
  $('itDetail').textContent = '';
  $('itFill').style.width = '0%';
  // reset stages block (hidden by default)
  const stagesEl = $('itStages'); if (stagesEl) { stagesEl.innerHTML = ''; stagesEl.hidden = true; }
  const expandBtn = $('itExpand'); if (expandBtn) { expandBtn.textContent = '▾'; expandBtn.setAttribute('aria-expanded', 'false'); expandBtn.style.display = ''; }
  wireToastExpand();

  if (state.ipt) clearInterval(state.ipt);

  let fakeProgress = 5;
  // 单文件模式改用 /api/ingest/active 支持并发多任务；批量仍走 batch/status
  const endpoint = isBatch ? '/api/ingest/batch/status' : '/api/ingest/active';

  state.ipt = setInterval(async () => {
    try {
      const s = await api(endpoint);

      if (isBatch) {
        if (s.status === 'idle') return;
        const pct = s.total > 0 ? Math.round(s.completed / s.total * 100) : 0;
        $('itFill').style.width = pct + '%';
        $('itTitle').textContent = t('ingest.compilingN', {done: s.completed, total: s.total});
        if (s.estimatedRemaining != null && s.status === 'processing') {
          const mins = Math.floor(s.estimatedRemaining / 60); const secs = s.estimatedRemaining % 60;
          $('itDetail').textContent = mins > 0 && secs > 0 ? t('ingest.estTime', {min: mins, sec: secs}) : (mins > 0 ? t('ingest.estMin', {min: mins}) : t('ingest.estTime', {min: 0, sec: secs}));
        }
        if (s.status === 'done') {
          clearInterval(state.ipt); state.ipt = null;
          showProgressDone(true, s.failed > 0 ? t('ingest.doneFail', {n: s.completed, fail: s.failed}) : t('ingest.doneN', {n: s.completed}));
        }
      } else {
        // 多任务模式：/api/ingest/active 返回 {items:[]}
        const items = Array.isArray(s.items) ? s.items : [];
        const running = items.filter(tk => tk.status === 'compiling');
        const finished = items.filter(tk => tk.status === 'done' || tk.status === 'error');

        if (items.length === 0) {
          // 既无活跃任务也无最近完成 → 结束轮询
          clearInterval(state.ipt); state.ipt = null;
          return;
        }

        // 单任务：显示主任务摘要；多任务：显示计数
        if (items.length === 1) {
          const tk = items[0];
          const stgs = tk.stages || [];
          if (stgs.length) {
            renderStages(stgs);
            $('itFill').style.width = computeStagePct(stgs) + '%';
            if (stgs.some(st => st.status === 'error')) {
              const host = $('itStages'); const btn = $('itExpand');
              if (host && host.hidden) { host.hidden = false; if (btn) { btn.textContent = '▴'; btn.setAttribute('aria-expanded', 'true'); } }
            }
            const run = stgs.find(st => st.status === 'running');
            $('itDetail').textContent = run ? ((run.label || run.key) + '...') : '';
          }
          if (tk.status === 'done') {
            $('itTitle').textContent = (tk.article?.title || t('ingest.newArticle')) + ' ' + t('ingest.ingested');
            $('itFill').style.width = '100%';
          } else if (tk.status === 'error') {
            $('itTitle').textContent = tk.message || t('ingest.compileFailed');
          } else {
            $('itTitle').textContent = t('ingest.compiling');
          }
        } else {
          // 多任务并发
          renderMultiTasks(items);
          const allStages = items.flatMap(tk => tk.stages || []);
          $('itFill').style.width = computeStagePct(allStages) + '%';
          $('itTitle').textContent = t('iq.compilingN', {n: running.length, done: finished.length});
          $('itDetail').textContent = running.length > 0 ? (running[0].stages?.find(st=>st.status==='running')?.label || '') : '';
          // 多任务时默认展开
          const host = $('itStages'); const btn = $('itExpand');
          if (host && host.hidden) { host.hidden = false; if (btn) { btn.textContent = '▴'; btn.setAttribute('aria-expanded', 'true'); } }
        }

        // 全部结束：停止轮询 + 触发完成 UI
        if (running.length === 0 && finished.length > 0) {
          clearInterval(state.ipt); state.ipt = null;
          const lastDone = finished.filter(tk => tk.status === 'done').slice(-1)[0];
          const anyError = finished.some(tk => tk.status === 'error');
          if (items.length === 1 && lastDone) {
            showProgressDone(true, (lastDone.article?.title || t('ingest.newArticle')) + ' ' + t('ingest.ingested'), lastDone.article?.path || '');
          } else if (items.length > 1) {
            const doneCnt = finished.filter(tk => tk.status === 'done').length;
            const errCnt = finished.length - doneCnt;
            showProgressDone(!anyError, errCnt > 0 ? t('ingest.doneFail', {n: doneCnt, fail: errCnt}) : t('ingest.doneN', {n: doneCnt}));
          } else if (anyError) {
            const errTask = finished.find(tk => tk.status === 'error');
            showProgressDone(false, errTask?.message || t('ingest.compileFailed'));
          }
        }
      }
    } catch {}
  }, 2000);
}

function wireToastExpand() {
  const btn = $('itExpand'); if (!btn || btn.__wired) return;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const stg = $('itStages'); if (!stg) return;
    stg.hidden = !stg.hidden;
    btn.textContent = stg.hidden ? '▾' : '▴';
    btn.setAttribute('aria-expanded', stg.hidden ? 'false' : 'true');
  });
  btn.__wired = true;
}

function showProgressDone(success, msg, articlePath) {
  const el = $('ingestToast');
  $('itFill').style.width = '100%';
  el.classList.remove('show');
  el.classList.add(success ? 'done' : 'error');
  // Force reflow then re-add show for transition
  void el.offsetWidth;
  el.classList.add('show');
  $('itTitle').textContent = msg;
  $('itDetail').textContent = success && articlePath ? t('ingest.view') : '';

  state.gd = null; state.td = null; state.sd = null; state.chatList = null;
  state.pendingBinaryFile = null;
  if (success) {
    toast(t('ingest.kbUpdated'));
    updSidebarPages();
    if (state.cv === 'browse' || state.cv === 'dashboard') {
      if (typeof window.render === 'function') window.render();
    }
  }

  if (articlePath) {
    el.style.cursor = 'pointer';
    el.onclick = () => { hideProgress(); go('#/article/' + articlePath); };
  }

  setTimeout(hideProgress, 6000);
}

function hideProgress() {
  const el = $('ingestToast');
  el.className = 'ingest-toast';
  el.style.cursor = '';
  el.onclick = null;
}

// ── 页面加载时恢复进行中的编译进度 ──

export async function checkActiveIngest() {
  // 页面加载时不再自动弹出 ingest-toast；topbar 队列入口会显示进度
  // 仅触发一次队列刷新，让队列按钮/徽标尽快出现
  if (typeof window.refreshIngestQueue === 'function') window.refreshIngestQueue();
}
