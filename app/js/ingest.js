import { $, h, api, toast, go } from './utils.js';
import state from './state.js';

// ── 文件类型检测 ──

const FILE_TYPE_MAP = {
  pdf:  { type: 'pdf',   icon: '\u{1F4C4}', label: 'PDF' },
  png:  { type: 'image', icon: '\u{1F5BC}', label: '\u56FE\u7247' },
  jpg:  { type: 'image', icon: '\u{1F5BC}', label: '\u56FE\u7247' },
  jpeg: { type: 'image', icon: '\u{1F5BC}', label: '\u56FE\u7247' },
  webp: { type: 'image', icon: '\u{1F5BC}', label: '\u56FE\u7247' },
  gif:  { type: 'image', icon: '\u{1F5BC}', label: '\u56FE\u7247' },
  mp3:  { type: 'audio', icon: '\u{1F3B5}', label: '\u97F3\u9891' },
  wav:  { type: 'audio', icon: '\u{1F3B5}', label: '\u97F3\u9891' },
  m4a:  { type: 'audio', icon: '\u{1F3B5}', label: '\u97F3\u9891' },
  ogg:  { type: 'audio', icon: '\u{1F3B5}', label: '\u97F3\u9891' },
  mp4:  { type: 'video', icon: '\u{1F3AC}', label: '\u89C6\u9891' },
  webm: { type: 'video', icon: '\u{1F3AC}', label: '\u89C6\u9891' },
  txt:  { type: 'text',  icon: '\u{1F4DD}', label: '\u6587\u672C' },
  md:   { type: 'text',  icon: '\u{1F4DD}', label: '\u6587\u672C' },
  html: { type: 'text',  icon: '\u{1F4DD}', label: '\u6587\u672C' },
  json: { type: 'text',  icon: '\u{1F4DD}', label: '\u6587\u672C' },
  csv:  { type: 'text',  icon: '\u{1F4DD}', label: '\u6587\u672C' },
  xml:  { type: 'text',  icon: '\u{1F4DD}', label: '\u6587\u672C' },
  zip:  { type: 'zip',   icon: '\u{1F4E6}', label: 'ZIP' },
};

function detectFileType(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  return FILE_TYPE_MAP[ext] || { type: 'text', icon: '\u{1F4DD}', label: '\u6587\u672C' };
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
  if (_ingestUrls.length >= MAX_URLS) { toast('最多 ' + MAX_URLS + ' 个链接'); return false; }
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
    ta.placeholder = '粘贴文本、拖入文件、或输入 https:// 链接...';
    ta.style.minHeight = '200px';
    $('ingestBtn').textContent = '开始编译';
    return;
  }
  wrap.style.display = 'flex';
  wrap.innerHTML = _ingestUrls.map((u, i) => {
    const short = u.replace(/^https?:\/\//, '').slice(0, 45) + (u.length > 55 ? '...' : '');
    return '<div class="url-chip"><span class="url-chip-icon">🔗</span><span class="url-chip-text" title="' + h(u) + '">' + h(short) + '</span><button class="url-chip-del" onclick="removeIngestUrl(' + i + ')">×</button></div>';
  }).join('');
  ta.placeholder = _ingestUrls.length < MAX_URLS ? '继续粘贴链接，或输入补充说明...' : '已达上限 ' + MAX_URLS + ' 个链接';
  ta.style.minHeight = '60px';
  $('ingestBtn').textContent = _ingestUrls.length > 1 ? '开始编译 (' + _ingestUrls.length + ' 个链接)' : '开始编译';
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
  $('ingestBtn').textContent = '开始编译';
  $('ingestBatchPreview').style.display = 'none';
  $('ingestBatchList').innerHTML = '';
  $('ingestFileName').textContent = '';
  $('ingestUrlChips').innerHTML = '';
  $('ingestUrlChips').style.display = 'none';
  $('ingestContent').placeholder = '粘贴文本、拖入文件、或输入 https:// 链接...';
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
  $('ingestContent').placeholder = ft.icon + ' ' + ft.label + ' \u6587\u4EF6\u5DF2\u9009\u62E9\uFF0C\u70B9\u51FB\u201C\u5F00\u59CB\u7F16\u8BD1\u201D\u5904\u7406...';
  try {
    const b64 = await readFileAsBase64(f);
    state.pendingBinaryFile = { type: ft.type, content: b64, filename: f.name };
  } catch (e) {
    toast('\u6587\u4EF6\u8BFB\u53D6\u5931\u8D25: ' + e.message);
    $('ingestFileName').textContent = '';
  }
}

async function handleMultipleFiles(fileList) {
  state.batchFiles = [];
  state.pendingBinaryFile = null;
  let loaded = 0;
  const total = fileList.length;
  $('ingestFileName').textContent = total + ' \u4E2A\u6587\u4EF6\u5DF2\u9009\u62E9';
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
  $('ingestFileName').textContent = f.name + ' (\u89E3\u538B\u4E2D...)';
  $('ingestBtn').disabled = true;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const base64 = reader.result.split(',')[1];
      const resp = await fetch('/api/ingest/extract-zip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: base64 }) });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || '\u89E3\u538B\u5931\u8D25');
      state.batchFiles = result.files.map(f => ({ ...f, checked: true, fileType: 'text', isBinary: false }));
      $('ingestFileName').textContent = f.name + ' (' + state.batchFiles.length + ' \u4E2A\u6587\u4EF6)';
      showBatchPreview();
    } catch (e) {
      toast('ZIP \u89E3\u538B\u5931\u8D25: ' + e.message);
      $('ingestFileName').textContent = '';
    }
    $('ingestBtn').disabled = false;
  };
  reader.readAsDataURL(f);
}

function showBatchPreview() {
  const preview = $('ingestBatchPreview'); const list = $('ingestBatchList'); const summary = $('ingestBatchSummary');
  preview.style.display = 'block';
  summary.textContent = '\u5171 ' + state.batchFiles.length + ' \u4E2A\u6587\u4EF6';
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
  $('ingestBatchSummary').textContent = '\u5DF2\u9009 ' + checked + ' / ' + state.batchFiles.length + ' \u4E2A\u6587\u4EF6';
  $('ingestBtn').textContent = '\u5F00\u59CB\u7F16\u8BD1' + (checked > 1 ? ' (' + checked + ' \u4E2A\u6587\u4EF6)' : '');
}

async function loadTopics() {
  try { const tree = state.td || await api('/api/wiki/tree'); state.td = tree; const s = $('ingestTopic'); const v = s.value; s.innerHTML = '<option value="auto">\u81EA\u52A8\u5206\u7C7B</option>'; if (tree) tree.forEach(t => { const o = document.createElement('option'); o.value = t.name; o.textContent = t.name; s.appendChild(o); }); if (v) s.value = v; } catch {}
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
      toast('\u8BF7\u5148\u5728\u8BBE\u7F6E\u4E2D\u914D\u7F6E API Key'); return;
    }
  } catch {}

  const checkedBatch = state.batchFiles.filter(f => f.checked);
  const content = $('ingestContent').value.trim();
  const hasPendingBinary = !!state.pendingBinaryFile && !content;
  const hasUrls = _ingestUrls.length > 0;
  const isBatch = checkedBatch.length > 1 || _ingestUrls.length > 1;

  if (!isBatch && !hasUrls && !content && !hasPendingBinary && checkedBatch.length === 0) { toast('请输入内容'); return; }

  const topic = $('ingestTopic').value;
  const model = $('ingestModel');
  const btn = $('ingestBtn');
  btn.disabled = true;
  btn.textContent = '提交中...';

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
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || '\u63D0\u4EA4\u5931\u8D25');
    }

    // 成功 → 立即关闭面板，启动后台进度追踪
    const totalItems = hasUrls ? _ingestUrls.length + checkedBatch.length : checkedBatch.length;
    const trackBatch = isBatch || totalItems > 1;
    closeIngest();
    startProgressTracking(trackBatch, trackBatch ? totalItems : 0);
  } catch (e) {
    toast('\u63D0\u4EA4\u5931\u8D25: ' + e.message);
    btn.disabled = false;
    btn.textContent = '\u5F00\u59CB\u7F16\u8BD1';
  }
}

// ── 全局进度追踪（面板关闭后持续运行） ──

const STAGE_ICONS = { pending:'○', running:'▶', done:'✓', error:'✕', skipped:'⊘' };
const STAGE_ORDER = ['title','topic','filename','content','summary','seealso','persist'];
const STAGE_NUM   = ['①','②','③','④','⑤','⑥','⑦'];

function stageMeta(st) {
  const parts = [];
  if (st.source) {
    if (st.source.startsWith('llm:')) parts.push(st.source.slice(4));
    else if (st.source === 'code') parts.push('代码');
    else if (st.source === 'user') parts.push('用户');
    else if (st.source === 'llm')  parts.push('LLM');
    else if (st.source === 'code_plus_llm') parts.push('代码+LLM');
    else parts.push(st.source);
  }
  if (typeof st.durationMs === 'number') parts.push(st.durationMs + 'ms');
  return parts.join(' · ');
}

function renderStages(stages) {
  const host = $('itStages'); if (!host) return;
  // Sort by canonical order, fall back to array order if unknown keys
  const sorted = stages.slice().sort((a, b) => {
    const ia = STAGE_ORDER.indexOf(a.key); const ib = STAGE_ORDER.indexOf(b.key);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  host.innerHTML = sorted.map(st => {
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
  $('itTitle').textContent = isBatch ? '\u7F16\u8BD1\u4E2D... 0/' + totalFiles : '\u7F16\u8BD1\u4E2D...';
  $('itDetail').textContent = '';
  $('itFill').style.width = '0%';
  // reset stages block (hidden by default)
  const stagesEl = $('itStages'); if (stagesEl) { stagesEl.innerHTML = ''; stagesEl.hidden = true; }
  const expandBtn = $('itExpand'); if (expandBtn) { expandBtn.textContent = '▾'; expandBtn.setAttribute('aria-expanded', 'false'); expandBtn.style.display = isBatch ? 'none' : ''; }
  wireToastExpand();

  if (state.ipt) clearInterval(state.ipt);

  let fakeProgress = 5;
  const endpoint = isBatch ? '/api/ingest/batch/status' : '/api/ingest/status';

  state.ipt = setInterval(async () => {
    try {
      const s = await api(endpoint);

      if (isBatch) {
        if (s.status === 'idle') return;
        const pct = s.total > 0 ? Math.round(s.completed / s.total * 100) : 0;
        $('itFill').style.width = pct + '%';
        $('itTitle').textContent = '\u7F16\u8BD1\u4E2D... ' + s.completed + '/' + s.total;
        if (s.estimatedRemaining != null && s.status === 'processing') {
          const mins = Math.floor(s.estimatedRemaining / 60); const secs = s.estimatedRemaining % 60;
          $('itDetail').textContent = '\u9884\u8BA1 ' + (mins > 0 ? mins + '\u5206' : '') + (secs > 0 ? secs + '\u79D2' : '');
        }
        if (s.status === 'done') {
          clearInterval(state.ipt); state.ipt = null;
          showProgressDone(true, s.completed + ' \u7BC7\u5DF2\u5165\u5E93' + (s.failed > 0 ? '\uFF0C' + s.failed + ' \u5931\u8D25' : ''));
        }
      } else {
        // 单文件：优先使用 stages；没有则回退到 fakeProgress
        if (Array.isArray(s.stages) && s.stages.length) {
          renderStages(s.stages);
          $('itFill').style.width = computeStagePct(s.stages) + '%';
          // auto-expand on any error
          if (s.stages.some(st => st.status === 'error')) {
            const stgs = $('itStages'); const btn = $('itExpand');
            if (stgs && stgs.hidden) { stgs.hidden = false; if (btn) { btn.textContent = '▴'; btn.setAttribute('aria-expanded', 'true'); } }
          }
          const running = s.stages.find(st => st.status === 'running');
          if (running) $('itDetail').textContent = (running.label || running.key || '') + '...';
        } else {
          fakeProgress = Math.min(fakeProgress + 5 + Math.random() * 8, 85);
          $('itFill').style.width = fakeProgress + '%';
        }

        if (s.status === 'done') {
          clearInterval(state.ipt); state.ipt = null;
          const artPath = s.article?.path || '';
          const artTitle = s.article?.title || '\u65B0\u6587\u7AE0';
          showProgressDone(true, artTitle + ' \u5DF2\u5165\u5E93', artPath);
        } else if (s.status === 'error' || s.status === 'failed') {
          clearInterval(state.ipt); state.ipt = null;
          showProgressDone(false, s.message || '\u7F16\u8BD1\u5931\u8D25');
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
  $('itDetail').textContent = success && articlePath ? '\u67E5\u770B \u2192' : '';

  state.gd = null; state.td = null; state.sd = null; state.chatList = null;
  state.pendingBinaryFile = null;
  if (success) toast('\u77E5\u8BC6\u5E93\u5DF2\u66F4\u65B0');

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
  try {
    // 先检查批量任务
    const batch = await api('/api/ingest/batch/status');
    if (batch && batch.status === 'processing') {
      startProgressTracking(true, batch.total);
      // 立即同步当前进度到 UI
      const pct = batch.total > 0 ? Math.round(batch.completed / batch.total * 100) : 0;
      $('itFill').style.width = pct + '%';
      $('itTitle').textContent = '\u7F16\u8BD1\u4E2D... ' + batch.completed + '/' + batch.total;
      return;
    }
    // 再检查单文件任务
    const task = await api('/api/ingest/status');
    if (task && task.status === 'compiling') {
      startProgressTracking(false, 0);
    }
  } catch {}
}
