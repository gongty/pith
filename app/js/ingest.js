import { $, h, api, toast } from './utils.js';
import state from './state.js';

const svgPending = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/></svg>';
const svgProcessing = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>';
const svgDone = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
const svgError = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';

export function openIngest() { $('ingestOverlay').classList.add('open'); loadTopics(); loadModels2('ingestModel'); resetIngestUI(); }
export function closeIngest() { $('ingestOverlay').classList.remove('open'); if (state.ipt) { clearInterval(state.ipt); state.ipt = null; } }

function resetIngestUI() {
  state.batchFiles = [];
  $('ingestContent').value = ''; $('ingestBtn').disabled = false; $('ingestBtn').textContent = '开始编译';
  $('ingestSteps').style.display = 'none'; $('ingestResult').style.display = 'none';
  $('ingestBatchPreview').style.display = 'none'; $('ingestBatchProgress').style.display = 'none';
  $('ingestBatchList').innerHTML = ''; $('ingestBatchStatusList').innerHTML = '';
  $('ingestFileName').textContent = '';
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
      if (files[0].name.toLowerCase().endsWith('.zip')) { handleZipFile(files[0]); }
      else { readIngestFile(files[0]); }
    }
  });
  const fi = $('ingestFile');
  if (fi) fi.addEventListener('change', e => {
    const files = e.target.files;
    if (!files.length) return;
    if (files.length > 1) { handleMultipleFiles(files); }
    else if (files[0].name.toLowerCase().endsWith('.zip')) { handleZipFile(files[0]); }
    else { readIngestFile(files[0]); }
  });
}

function readIngestFile(f) {
  state.batchFiles = [];
  $('ingestBatchPreview').style.display = 'none';
  const reader = new FileReader();
  reader.onload = () => { $('ingestContent').value = reader.result; $('ingestFileName').textContent = f.name; };
  reader.readAsText(f);
}

function handleMultipleFiles(fileList) {
  state.batchFiles = [];
  let loaded = 0;
  const total = fileList.length;
  $('ingestFileName').textContent = total + ' 个文件已选择';
  $('ingestContent').value = '';
  for (let i = 0; i < total; i++) {
    const f = fileList[i];
    if (f.name.toLowerCase().endsWith('.zip')) { handleZipFile(f); return; }
    const reader = new FileReader();
    reader.onload = (function (name) { return function (e) {
      state.batchFiles.push({ name: name, content: e.target.result, checked: true });
      loaded++;
      if (loaded === total) showBatchPreview();
    }; })(f.name);
    reader.readAsText(f);
  }
}

async function handleZipFile(f) {
  $('ingestFileName').textContent = f.name + ' (解压中...)';
  $('ingestBtn').disabled = true;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const base64 = reader.result.split(',')[1];
      const resp = await fetch('/api/ingest/extract-zip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: base64 }) });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || '解压失败');
      state.batchFiles = result.files.map(f => ({ ...f, checked: true }));
      $('ingestFileName').textContent = f.name + ' (' + state.batchFiles.length + ' 个文件)';
      showBatchPreview();
    } catch (e) {
      toast('ZIP 解压失败: ' + e.message);
      $('ingestFileName').textContent = '';
    }
    $('ingestBtn').disabled = false;
  };
  reader.readAsDataURL(f);
}

function showBatchPreview() {
  const preview = $('ingestBatchPreview'); const list = $('ingestBatchList'); const summary = $('ingestBatchSummary');
  preview.style.display = 'block';
  summary.textContent = '共 ' + state.batchFiles.length + ' 个文件';
  list.innerHTML = state.batchFiles.map((f, i) => '<div class="ingest-batch-item"><input type="checkbox" ' + (f.checked ? 'checked' : '') + ' onchange="batchFileToggle(' + i + ',this.checked)"><span class="batch-file-name" title="' + h(f.name) + '">' + h(f.name) + '</span></div>').join('');
  updateBatchSummary();
  $('ingestBtn').textContent = '开始编译 (' + state.batchFiles.filter(f => f.checked).length + ' 个文件)';
}

export function batchFileToggle(i, checked) { state.batchFiles[i].checked = checked; updateBatchSummary(); }

export function batchToggleAll(v) {
  state.batchFiles.forEach(f => f.checked = v);
  $('ingestBatchList').querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = v);
  updateBatchSummary();
}

function updateBatchSummary() {
  const checked = state.batchFiles.filter(f => f.checked).length;
  $('ingestBatchSummary').textContent = '已选 ' + checked + ' / ' + state.batchFiles.length + ' 个文件';
  $('ingestBtn').textContent = '开始编译' + (checked > 1 ? ' (' + checked + ' 个文件)' : '');
}

async function loadTopics() {
  try { const tree = state.td || await api('/api/wiki/tree'); state.td = tree; const s = $('ingestTopic'); const v = s.value; s.innerHTML = '<option value="auto">自动分类</option>'; if (tree) tree.forEach(t => { const o = document.createElement('option'); o.value = t.name; o.textContent = t.name; s.appendChild(o); }); if (v) s.value = v; } catch {}
}

async function loadModels2(id) {
  try {
    const s = state.sCache || await api('/api/settings'); state.sCache = s; const sel = $(id); if (!sel) return; sel.innerHTML = '';
    if (s.providers) for (const [k, v] of Object.entries(s.providers)) { if (k === 'custom') continue; v.models.forEach(m => { const o = document.createElement('option'); o.value = k + '|' + m; o.textContent = m; sel.appendChild(o); }); }
    if (s.provider && s.model) sel.value = s.provider + '|' + s.model;
  } catch {}
}

export async function submitIngest(renderFn) {
  const checkedBatch = state.batchFiles.filter(f => f.checked);
  const content = $('ingestContent').value.trim();
  const isBatch = checkedBatch.length > 1;
  if (!isBatch && !content) { toast('请输入内容'); return; }
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
    statusList.innerHTML = checkedBatch.map(f => '<div class="ingest-batch-item status-pending"><span class="batch-status-icon">' + svgPending + '</span><span class="batch-file-name">' + h(f.name) + '</span></div>').join('');
    const items = checkedBatch.map(f => ({ type: 'text', content: f.content, topic: topic, name: f.name }));
    const body = { items, ...modelBody };
    try {
      await fetch('/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      state.ipt = setInterval(async () => {
        try {
          const s = await api('/api/ingest/batch/status');
          if (s.status === 'idle') return;
          const pct = s.total > 0 ? Math.round(s.completed / s.total * 100) : 0;
          $('ingestProgressFill').style.width = pct + '%';
          $('ingestProgressStats').textContent = s.completed + ' / ' + s.total + ' 已完成' + (s.failed > 0 ? ' (' + s.failed + ' 失败)' : '');
          if (s.estimatedRemaining !== null && s.status === 'processing') {
            const mins = Math.floor(s.estimatedRemaining / 60); const secs = s.estimatedRemaining % 60;
            $('ingestProgressETA').textContent = '预计剩余 ' + (mins > 0 ? mins + '分' : '') + (secs > 0 ? secs + '秒' : '');
          } else { $('ingestProgressETA').textContent = ''; }
          if (s.files) {
            const items = statusList.querySelectorAll('.ingest-batch-item');
            s.files.forEach((f, i) => {
              if (!items[i]) return;
              items[i].className = 'ingest-batch-item status-' + f.status;
              const icon = items[i].querySelector('.batch-status-icon');
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
            result.innerHTML = svgDone + ' 批量编译完成: ' + s.completed + ' 个文件' + (s.failed > 0 ? ', ' + s.failed + ' 个失败' : '');
            result.onclick = () => { closeIngest(); renderFn(); };
            toast('知识库已更新');
          }
        } catch {}
      }, 2000);
    } catch (e) {
      batchProg.style.display = 'none';
      result.style.display = 'flex'; result.className = 'ingest-result error';
      result.innerHTML = '提交失败: ' + h(e.message); result.onclick = null;
      btn.disabled = false;
    }
  } else {
    if (!content) { toast('请输入内容'); return; }
    const type = /^https?:\/\//.test(content) ? 'url' : 'text';
    steps.style.display = 'flex';
    setStep('fetch');
    try {
      const body = { type, content, topic, ...modelBody };
      await fetch('/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
            const artTitle = s.article?.title || '新文章';
            const artPathVal = s.article?.path || '';
            result.style.display = 'flex'; result.className = 'ingest-result done';
            result.innerHTML = svgDone + ' 已创建: ' + h(artTitle) + ' ->';
            result.onclick = () => { closeIngest(); if (artPathVal) window.location.hash = '#/article/' + artPathVal; else renderFn(); };
            toast('知识库已更新');
          } else if (s.status === 'error' || s.status === 'failed') {
            clearInterval(state.ipt); state.ipt = null;
            steps.querySelectorAll('.ingest-step').forEach(s => s.classList.remove('active'));
            result.style.display = 'flex'; result.className = 'ingest-result error';
            result.innerHTML = '编译失败: ' + (s.message || '未知错误'); result.onclick = null;
            btn.disabled = false;
          }
        } catch {}
      }, 2000);
    } catch (e) {
      steps.style.display = 'none';
      result.style.display = 'flex'; result.className = 'ingest-result error';
      result.innerHTML = '提交失败: ' + h(e.message); result.onclick = null;
      btn.disabled = false;
    }
  }
}

function setStep(name) {
  const order = ['fetch', 'parse', 'compile', 'done'];
  const idx = order.indexOf(name);
  $('ingestSteps').querySelectorAll('.ingest-step').forEach((el, i) => {
    el.classList.remove('active', 'done');
    if (i < idx) el.classList.add('done');
    else if (i === idx) el.classList.add('active');
  });
}
