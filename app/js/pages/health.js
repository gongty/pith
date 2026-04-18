import { $, h, api, go, relTime, toast, jsAttr } from '../utils.js';
import { t } from '../i18n.js';

function scoreColor(score) {
  if (score >= 90) return 'var(--green)';
  if (score >= 70) return 'var(--orange)';
  return 'var(--red)';
}

function severityIcon(sev) {
  if (sev === 'error') return '<span class="health-sev health-sev-error"></span>';
  if (sev === 'warning') return '<span class="health-sev health-sev-warning"></span>';
  return '<span class="health-sev health-sev-info"></span>';
}

function severityOrder(sev) {
  if (sev === 'error') return 0;
  if (sev === 'warning') return 1;
  return 2;
}

function fmtWords(n) {
  if (n >= 10000) return t('unit.wordsTenK', { n: (n / 10000).toFixed(1) });
  return t('unit.words', { n: n.toLocaleString() });
}

function scoreBar(label, value) {
  const color = scoreColor(value);
  return '<div class="health-dim">' +
    '<div class="health-dim-head"><span class="health-dim-label">' + h(label) + '</span><span class="health-dim-val" style="color:' + color + '">' + value + '</span></div>' +
    '<div class="health-dim-bar"><div class="health-dim-fill" style="width:' + value + '%;background:' + color + '"></div></div>' +
    '</div>';
}

export async function rHealth(c) {
  c.innerHTML = '<div class="page-health"><div style="text-align:center;padding:60px;color:var(--fg-tertiary)">' + t('common.loading') + '</div></div>';

  try {
    const [data, listRes] = await Promise.all([
      api('/api/reports/latest'),
      api('/api/reports/list')
    ]);

    const bd = data.scoreBreakdown || {};
    const sm = data.summary || {};
    const issues = (data.issues || []).slice().sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity));
    const files = (listRes.files || []);

    let s = '<div class="page-health">';

    // Header
    s += '<div class="health-header">';
    s += '<h1 class="health-title">' + t('health.title') + '</h1>';
    s += '<div style="display:flex;align-items:center;gap:12px"><span class="health-time">' + t('health.lastCheck', { time: data.timestamp ? relTime(data.timestamp) : t('time.unknown') }) + '</span>';
    s += '<button class="btn-outline" style="font-size:12px;padding:4px 12px" onclick="runLintNow()">' + t('health.runNow') + '</button></div>';
    s += '</div>';

    // Score + dimensions
    s += '<div class="health-score-section">';
    s += '<div class="health-dims">';
    s += scoreBar(t('health.completeness'), bd.completeness || 0);
    s += scoreBar(t('health.freshness'), bd.freshness || 0);
    s += scoreBar(t('health.connectivity'), bd.connectivity || 0);
    s += scoreBar(t('health.consistency'), bd.consistency || 0);
    s += '</div>';
    s += '<div class="health-total">';
    s += '<div class="health-total-val" style="color:' + scoreColor(data.score || 0) + '">' + (data.score || 0) + '</div>';
    s += '<div class="health-total-label">' + t('health.totalScore') + '</div>';
    s += '</div>';
    s += '</div>';

    // Stats overview
    s += '<div class="health-stats">';
    s += '<div class="health-stat-item"><span class="health-stat-icon">&#128196;</span>' + t('unit.articles', { n: sm.totalArticles || 0 }) + '</div>';
    s += '<div class="health-stat-item"><span class="health-stat-icon">&#128230;</span>' + t('unit.sources', { n: sm.totalRaw || 0 }) + '</div>';
    s += '<div class="health-stat-item"><span class="health-stat-icon">&#128221;</span>' + fmtWords(sm.totalWords || 0) + '</div>';
    s += '<div class="health-stat-item"><span class="health-stat-icon">&#128279;</span>' + t('unit.links', { n: sm.totalConnections || 0 }) + '</div>';
    s += '</div>';

    // Issues
    s += '<div class="health-section-head">' + t('health.issueList', { n: issues.length }) + '</div>';
    if (issues.length === 0) {
      s += '<div class="health-empty">' + t('health.noIssues') + '</div>';
    } else {
      s += '<div class="health-issues">';
      for (const issue of issues) {
        const clickPath = issue.path || (issue.paths && issue.paths[0]) || '';
        const clickable = clickPath ? ' onclick="go(\'#/article/' + jsAttr(clickPath) + '\')"' : '';
        const cursor = clickPath ? ' style="cursor:pointer"' : '';

        let desc = '';
        if (issue.type === 'broken_link') desc = t('health.brokenLink', { path: h(issue.path), target: h(issue.message.replace(/^[^:]+:\s*/, '')) });
        else if (issue.type === 'missing_index') desc = t('health.missingIndex', { path: h(issue.path) });
        else if (issue.type === 'orphan') desc = t('health.orphan', { path: h(issue.path) });
        else if (issue.type === 'stale') desc = t('health.stale', { path: h(issue.path) });
        else if (issue.type === 'mergeable') desc = t('health.mergeable', { paths: h((issue.paths || []).join(' + ')), msg: h(issue.message) });
        else desc = h(issue.message || issue.type);

        s += '<div class="health-issue"' + clickable + cursor + '>' + severityIcon(issue.severity) + '<span class="health-issue-text">' + desc + '</span></div>';
      }
      s += '</div>';
    }

    // History
    s += '<div class="health-section-head">' + t('health.history') + '</div>';
    if (files.length === 0) {
      s += '<div class="health-empty">' + t('health.noHistory') + '</div>';
    } else {
      s += '<div class="health-history">';
      const historyFiles = files.slice(0, 10);
      for (const f of historyFiles) {
        const date = f.replace('lint-', '').replace('.json', '');
        s += '<div class="health-history-item" data-date="' + h(date) + '">';
        s += '<span class="health-history-date">' + h(date) + '</span>';
        s += '<span class="health-history-loading">...</span>';
        s += '</div>';
      }
      s += '</div>';
    }

    s += '</div>';
    c.innerHTML = s;

    // Load history details in parallel
    const historyItems = c.querySelectorAll('.health-history-item');
    const historyPromises = [...historyItems].map(item => {
      const date = item.dataset.date;
      return api('/api/reports/' + date).then(rpt => {
        const issueCount = (rpt.issues || []).length;
        const loading = item.querySelector('.health-history-loading');
        if (loading) {
          loading.outerHTML = '<span class="health-history-score" style="color:' + scoreColor(rpt.score || 0) + '">' + t('unit.pts', { n: rpt.score || 0 }) + '</span>' +
            '<span class="health-history-issues">' + t('unit.issues', { n: issueCount }) + '</span>';
        }
      }).catch(() => {});
    });
    await Promise.all(historyPromises);

  } catch (e) {
    c.innerHTML = '<div class="page-health"><div style="text-align:center;padding:60px;color:var(--fg-tertiary)">' + t('common.loadFailedMsg', { msg: h(e.message) }) + '</div></div>';
  }
}

// 手动触发检查并刷新页面
window.runLintNow = async function () {
  const btn = document.querySelector('.health-header .btn-outline');
  if (btn) { btn.disabled = true; btn.textContent = t('health.running'); }
  toast(t('health.running'));
  try {
    await api('/api/wiki/lint');
    toast(t('health.checkDone'));
    const c = $('content');
    if (c) await rHealth(c);
  } catch (e) {
    toast(t('health.checkFailed', { msg: e.message }));
    if (btn) { btn.disabled = false; btn.textContent = t('health.runNow'); }
  }
};
