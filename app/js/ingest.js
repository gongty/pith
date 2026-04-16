import { $, h, api, toast } from './utils.js';
import state from './state.js';

const svgPending = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/></svg>';
const svgProcessing = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>';
const svgDone = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
const svgError = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';

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

export function openIngest() { $('ingestOverlay').classList.add('open'); loadTopics(); loadModels2('ingestModel'); resetIngestUI(); }
export function closeIngest() { $('ingestOverlay').classList.remove('open'); if (state.ipt) { clearInterval(state.ipt); state.ipt = null; } }

function resetIngestUI() {
  state.batchFiles = [];
  state.pendingBinaryFile = null;
  $('ingestContent').value = ''; $('ingestBtn').disabled = false; $('ingestBtn').textContent = '\u5F00\u59CB\u7F16\u8BD1';
  $('ingestSteps').style.display = 'none'; $('ingestResult').style.display = 'none';
  $('ingestBatchPreview').style.display = 'none'; $('ingestBatchProgress').style.display = 'none';
  $('ingestBatchList').innerHTML = ''; $('ingestBatchStatusList').innerHTML = '';
  $('ingestFileName').textContent = '';
  $('ingestContent').placeholder = '\u7C98\u8D34\u6587\u672C\u3001\u62D6\u5165\u6587\u4EF6\u3001\u6216\u8F93\u5165 https:// \u94FE\u63A5...';
  $('ingestSteps').querySelectorAll('.ingest-step').forEach(s => { s.classList.remove('active', 'done'); });
  $('ingestFile').value = '';
}

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
        state.batchFiles.push({
          name: f.name, content: b64, checked: true,
          fileType: ft.type, isBinary: true, filename: f.name
        });
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
  $('ingestBtn').textContent = '\u5F00\u59CB\u7F16\u8BD1 (' + state.batchFiles.filter(f => f.checked).length + ' \u4E2A\u6587\u4EF6)';
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
    const s = state.sCache || await api('/api/settings'); state.sCache = s; const sel = $(id); if (!sel) return; sel.innerHTML = '';
    if (s.providers) for (const [k, v] of Object.entries(s.providers)) { if (k === 'custom') continue; v.models.forEach(m => { const o = document.createElement('option'); o.value = k + '|' + m; o.textContent = m; sel.appendChild(o); }); }
    if (s.provider && s.model) sel.value = s.provider + '|' + s.model;
  } catch {}
}

export async function submitIngest(renderFn) {
  // Pre-check: API key configured?
  try {
    const settings = state.sCache || await api('/api/settings');
    state.sCache = settings;
    if (!settings.hasKey && settings.provider !== 'local') {
      toast('请先在设置中配置 API Key'); return;
    }
  } catch {}

  const checkedBatch = state.batchFiles.filter(f => f.checked);
  const content = $('ingestContent').value.trim();
  const hasPendingBinary = !!state.pendingBinaryFile && !content;
  const isBatch = checkedBatch.length > 1;
  if (!isBatch && !content && !hasPendingBinary && checkedBatch.length === 0) { toast('\u8BF7\u8F93\u5165\u5185\u5BB9'); return; }
  const topic = $('ingestTopic').value; const model = $('ingestModel');
  const btn = $('ingestBtn'); const steps = $('ingestSteps'); const result = $('ingestResult');
  btn.disabled = true; result.style.display = 'none';
  let modelBody = {};
  if (model && model.value) { const p = model.value.split('|'); if (p.length === 2) { modelBody.provider = p[0]; modelBody.model = p[1]; } }

  if (isBatch) {
    steps.style.display = 'none';
    const batchProg = $('ingestBatchProgress');
    batchProg.style.display = 'block';
    $('ingestBatchPreview').style.display = 'none';
    const statusList = $('ingestBatchStatusList');
    statusList.innerHTML = checkedBatch.map(f => {
      const ft = detectFileType(f.name);
      const typeIcon = f.isBinary ? ft.icon + ' ' : '';
      return '<div class="ingest-batch-item status-pending"><span class="batch-status-icon">' + svgPending + '</span><span class="batch-file-name">' + typeIcon + h(f.name) + '</span></div>';
    }).join('');
    const items = checkedBatch.map(f => {
      if (f.isBinary) {
        return { type: f.fileType, content: f.content, topic: topic, name: f.name, filename: f.filename || f.name };
      }
      return { type: 'text', content: f.content, topic: topic, name: f.name };
    });
    const body = { items, ...modelBody };
    try {
      await fetch('/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      state.ipt = setInterval(async () => {
        try {
          const s = await api('/api/ingest/batch/status');
          if (s.status === 'idle') return;
          const pct = s.total > 0 ? Math.round(s.completed / s.total * 100) : 0;
          $('ingestProgressFill').style.width = pct + '%';
          $('ingestProgressStats').textContent = s.completed + ' / ' + s.total + ' \u5DF2\u5B8C\u6210' + (s.failed > 0 ? ' (' + s.failed + ' \u5931\u8D25)' : '');
          if (s.estimatedRemaining !== null && s.status === 'processing') {
            const mins = Math.floor(s.estimatedRemaining / 60); const secs = s.estimatedRemaining % 60;
            $('ingestProgressETA').textContent = '\u9884\u8BA1\u5269\u4F59 ' + (mins > 0 ? mins + '\u5206' : '') + (secs > 0 ? secs + '\u79D2' : '');
          } else { $('ingestProgressETA').textContent = ''; }
          if (s.files) {
            const sitems = statusList.querySelectorAll('.ingest-batch-item');
            s.files.forEach((f, i) => {
              if (!sitems[i]) return;
              sitems[i].className = 'ingest-batch-item status-' + f.status;
              const icon = sitems[i].querySelector('.batch-status-icon');
              if (f.status === 'done') icon.innerHTML = svgDone;
              else if (f.status === 'processing') icon.innerHTML = svgProcessing;
              else if (f.status === 'error') icon.innerHTML = svgError;
              else icon.innerHTML = svgPending;
            });
          }
          if (s.status === 'done') {
            clearInterval(state.ipt); state.ipt = null;
            btn.disabled = false; state.gd = null; state.td = null; state.sd = null; state.chatList = null;
            result.style.display = 'flex'; result.className = 'ingest-result done';
            result.innerHTML = svgDone + ' \u6279\u91CF\u7F16\u8BD1\u5B8C\u6210: ' + s.completed + ' \u4E2A\u6587\u4EF6' + (s.failed > 0 ? ', ' + s.failed + ' \u4E2A\u5931\u8D25' : '');
            result.onclick = () => { closeIngest(); renderFn(); };
            toast('\u77E5\u8BC6\u5E93\u5DF2\u66F4\u65B0');
          }
        } catch {}
      }, 2000);
    } catch (e) {
      batchProg.style.display = 'none';
      result.style.display = 'flex'; result.className = 'ingest-result error';
      result.innerHTML = '\u63D0\u4EA4\u5931\u8D25: ' + h(e.message); result.onclick = null;
      btn.disabled = false;
    }
  } else {
    // 单文件或文本/URL
    let type, bodyData;
    if (hasPendingBinary) {
      const bf = state.pendingBinaryFile;
      type = bf.type;
      bodyData = { type, content: bf.content, filename: bf.filename, topic, ...modelBody };
    } else if (checkedBatch.length === 1 && checkedBatch[0].isBinary) {
      const bf = checkedBatch[0];
      type = bf.fileType;
      bodyData = { type, content: bf.content, filename: bf.name, topic, ...modelBody };
    } else if (checkedBatch.length === 1) {
      type = 'text';
      bodyData = { type, content: checkedBatch[0].content, topic, ...modelBody };
    } else {
      if (!content) { toast('\u8BF7\u8F93\u5165\u5185\u5BB9'); btn.disabled = false; return; }
      type = /^https?:\/\//.test(content) ? 'url' : 'text';
      bodyData = { type, content, topic, ...modelBody };
    }

    steps.style.display = 'flex';
    setStep('fetch');
    try {
      await fetch('/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyData) });
      setStep('parse');
      let pollCount = 0;
      state.ipt = setInterval(async () => {
        try {
          pollCount++;
          if (pollCount > 3) setStep('compile');
          const s = await api('/api/ingest/status');
          if (s.status === 'done') {
            clearInterval(state.ipt); state.ipt = null; setStep('done');
            btn.disabled = false; state.gd = null; state.td = null; state.sd = null; state.chatList = null;
            state.pendingBinaryFile = null;
            const artTitle = s.article?.title || '\u65B0\u6587\u7AE0';
            const artPathVal = s.article?.path || '';
            result.style.display = 'flex'; result.className = 'ingest-result done';
            result.innerHTML = svgDone + ' \u5DF2\u521B\u5EFA: ' + h(artTitle) + ' ->';
            result.onclick = () => { closeIngest(); if (artPathVal) window.location.hash = '#/article/' + artPathVal; else renderFn(); };
            toast('\u77E5\u8BC6\u5E93\u5DF2\u66F4\u65B0');
          } else if (s.status === 'error' || s.status === 'failed') {
            clearInterval(state.ipt); state.ipt = null;
            steps.querySelectorAll('.ingest-step').forEach(s => s.classList.remove('active'));
            result.style.display = 'flex'; result.className = 'ingest-result error';
            result.innerHTML = '\u7F16\u8BD1\u5931\u8D25: ' + (s.message || '\u672A\u77E5\u9519\u8BEF') + ' <button class="btn-outline" style="margin-left:8px;font-size:12px;padding:2px 10px" onclick="event.stopPropagation();retryIngest()">重试</button>';
            result.onclick = null;
            btn.disabled = false;
          }
        } catch {}
      }, 2000);
    } catch (e) {
      steps.style.display = 'none';
      result.style.display = 'flex'; result.className = 'ingest-result error';
      result.innerHTML = '\u63D0\u4EA4\u5931\u8D25: ' + h(e.message) + ' <button class="btn-outline" style="margin-left:8px;font-size:12px;padding:2px 10px" onclick="event.stopPropagation();retryIngest()">重试</button>';
      result.onclick = null;
      btn.disabled = false;
    }
  }
}

window.retryIngest = function () {
  $('ingestResult').style.display = 'none';
  $('ingestSteps').style.display = 'none';
  $('ingestBatchProgress').style.display = 'none';
  $('ingestBtn').disabled = false;
  $('ingestBtn').textContent = '\u5F00\u59CB\u7F16\u8BD1';
  // Re-show batch preview if batch files exist
  if (state.batchFiles && state.batchFiles.filter(f => f.checked).length > 1) {
    $('ingestBatchPreview').style.display = 'block';
    $('ingestBtn').textContent = '\u5F00\u59CB\u7F16\u8BD1 (' + state.batchFiles.filter(f => f.checked).length + ' \u4E2A\u6587\u4EF6)';
  }
};

function setStep(name) {
  const order = ['fetch', 'parse', 'compile', 'done'];
  const idx = order.indexOf(name);
  $('ingestSteps').querySelectorAll('.ingest-step').forEach((el, i) => {
    el.classList.remove('active', 'done');
    if (i < idx) el.classList.add('done');
    else if (i === idx) el.classList.add('active');
  });
}
