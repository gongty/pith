import { $, h, api, go, relTime } from '../utils.js';

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
  if (n >= 10000) return (n / 10000).toFixed(1) + ' 万';
  return n.toLocaleString();
}

function scoreBar(label, value) {
  const color = scoreColor(value);
  return '<div class="health-dim">' +
    '<div class="health-dim-head"><span class="health-dim-label">' + h(label) + '</span><span class="health-dim-val" style="color:' + color + '">' + value + '</span></div>' +
    '<div class="health-dim-bar"><div class="health-dim-fill" style="width:' + value + '%;background:' + color + '"></div></div>' +
    '</div>';
}

export async function rHealth(c) {
  c.innerHTML = '<div class="page-health"><div style="text-align:center;padding:60px;color:var(--fg-tertiary)">加载中...</div></div>';

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
    s += '<h1 class="health-title">知识库健康报告</h1>';
    s += '<span class="health-time">最后检查: ' + (data.timestamp ? relTime(data.timestamp) : '未知') + '</span>';
    s += '</div>';

    // Score + dimensions
    s += '<div class="health-score-section">';
    s += '<div class="health-dims">';
    s += scoreBar('完整性', bd.completeness || 0);
    s += scoreBar('新鲜度', bd.freshness || 0);
    s += scoreBar('连通性', bd.connectivity || 0);
    s += scoreBar('一致性', bd.consistency || 0);
    s += '</div>';
    s += '<div class="health-total">';
    s += '<div class="health-total-val" style="color:' + scoreColor(data.score || 0) + '">' + (data.score || 0) + '</div>';
    s += '<div class="health-total-label">总分</div>';
    s += '</div>';
    s += '</div>';

    // Stats overview
    s += '<div class="health-stats">';
    s += '<div class="health-stat-item"><span class="health-stat-icon">&#128196;</span><span class="health-stat-num">' + (sm.totalArticles || 0) + '</span> 篇文章</div>';
    s += '<div class="health-stat-item"><span class="health-stat-icon">&#128230;</span><span class="health-stat-num">' + (sm.totalRaw || 0) + '</span> 个源</div>';
    s += '<div class="health-stat-item"><span class="health-stat-icon">&#128221;</span><span class="health-stat-num">' + fmtWords(sm.totalWords || 0) + '</span> 字</div>';
    s += '<div class="health-stat-item"><span class="health-stat-icon">&#128279;</span><span class="health-stat-num">' + (sm.totalConnections || 0) + '</span> 条链接</div>';
    s += '</div>';

    // Issues
    s += '<div class="health-section-head">问题列表 (' + issues.length + ')</div>';
    if (issues.length === 0) {
      s += '<div class="health-empty">没有发现问题，知识库状态良好</div>';
    } else {
      s += '<div class="health-issues">';
      for (const issue of issues) {
        const clickPath = issue.path || (issue.paths && issue.paths[0]) || '';
        const clickable = clickPath ? ' onclick="go(\'#/article/' + h(clickPath) + '\')"' : '';
        const cursor = clickPath ? ' style="cursor:pointer"' : '';

        let desc = '';
        if (issue.type === 'broken_link') desc = '断开链接: ' + h(issue.path) + ' → ' + h(issue.message.replace('链接目标不存在: ', ''));
        else if (issue.type === 'missing_index') desc = '索引缺失: ' + h(issue.path);
        else if (issue.type === 'orphan') desc = '无入站链接: ' + h(issue.path);
        else if (issue.type === 'stale') desc = '超过 30 天未更新: ' + h(issue.path);
        else if (issue.type === 'mergeable') desc = '建议合并: ' + h((issue.paths || []).join(' + ')) + ' (' + h(issue.message) + ')';
        else desc = h(issue.message || issue.type);

        s += '<div class="health-issue"' + clickable + cursor + '>' + severityIcon(issue.severity) + '<span class="health-issue-text">' + desc + '</span></div>';
      }
      s += '</div>';
    }

    // History
    s += '<div class="health-section-head">历史记录</div>';
    if (files.length === 0) {
      s += '<div class="health-empty">暂无历史报告</div>';
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

    // Load history details asynchronously
    const historyItems = c.querySelectorAll('.health-history-item');
    for (const item of historyItems) {
      const date = item.dataset.date;
      try {
        const rpt = await api('/api/reports/' + date);
        const issueCount = (rpt.issues || []).length;
        const loading = item.querySelector('.health-history-loading');
        if (loading) {
          loading.outerHTML = '<span class="health-history-score" style="color:' + scoreColor(rpt.score || 0) + '">' + (rpt.score || 0) + ' 分</span>' +
            '<span class="health-history-issues">' + issueCount + ' 个问题</span>';
        }
      } catch {}
    }

  } catch (e) {
    c.innerHTML = '<div class="page-health"><div style="text-align:center;padding:60px;color:var(--fg-tertiary)">加载失败: ' + h(e.message) + '</div></div>';
  }
}
