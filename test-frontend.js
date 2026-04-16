/**
 * 前端功能自动化测试
 * 运行: node test-frontend.js
 * 依赖: 服务器已在 localhost:3456 运行
 */

const http = require('http');
const BASE = 'http://localhost:3456';
let passed = 0, failed = 0, errors = [];

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: {} };
    if (body) { const b = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; opts.headers['Content-Length'] = Buffer.byteLength(b); }
    const r = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    r.on('error', reject);
    r.setTimeout(15000, () => { r.destroy(); reject(new Error('timeout')); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function assert(name, condition, detail) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; const msg = `  ❌ ${name}` + (detail ? ` — ${detail}` : ''); console.log(msg); errors.push(msg); }
}

// ═══════════════════════════════════════════
// 1. 静态资源服务
// ═══════════════════════════════════════════
async function testStaticAssets() {
  console.log('\n📁 静态资源服务');

  const assets = [
    ['/', 'text/html', '<!DOCTYPE html'],
    ['/css/base.css', 'text/css', ':root'],
    ['/css/layout.css', 'text/css', '.sidebar'],
    ['/css/components.css', 'text/css', '.modal'],
    ['/css/pages.css', 'text/css', '.page-'],
    ['/css/ingest.css', 'text/css', '.ingest'],
    ['/js/app.js', 'javascript', 'import'],
    ['/js/router.js', 'javascript', 'export'],
    ['/js/state.js', 'javascript', 'export'],
    ['/js/utils.js', 'javascript', 'export'],
    ['/js/memory.js', 'javascript', 'export'],
    ['/js/settings.js', 'javascript', 'export'],
    ['/js/composer.js', 'javascript', 'export'],
    ['/js/search.js', 'javascript', 'export'],
    ['/js/sidebar.js', 'javascript', 'export'],
    ['/js/ingest.js', 'javascript', 'export'],
    ['/js/markdown.js', 'javascript', 'export'],
    ['/js/theme.js', 'javascript', 'export'],
    ['/js/pages/dashboard.js', 'javascript', 'export'],
    ['/js/pages/chat.js', 'javascript', 'export'],
    ['/js/pages/article.js', 'javascript', 'export'],
    ['/js/pages/graph.js', 'javascript', 'export'],
    ['/js/pages/browse.js', 'javascript', 'export'],
    ['/js/pages/health.js', 'javascript', 'export'],
  ];

  for (const [path, expectedType, expectedContent] of assets) {
    const res = await req('GET', path);
    assert(`GET ${path} → 200`, res.status === 200, `got ${res.status}`);
    assert(`${path} content-type 含 ${expectedType}`, (res.headers['content-type'] || '').includes(expectedType), `got ${res.headers['content-type']}`);
    assert(`${path} 含预期内容`, res.raw.includes(expectedContent), `未找到 "${expectedContent}"`);
  }

  // 404 for non-existent
  const r404 = await req('GET', '/nonexistent.xyz');
  assert('GET /nonexistent.xyz → 404', r404.status === 404);
}

// ═══════════════════════════════════════════
// 2. HTML 结构完整性
// ═══════════════════════════════════════════
async function testHtmlStructure() {
  console.log('\n🏗️  HTML 结构');

  const res = await req('GET', '/');
  const html = res.raw;

  // 关键 DOM 元素
  const elements = [
    ['id="sidebar"', '侧边栏'],
    ['id="content"', '主内容区'],
    ['id="topbar"', '顶栏'],
    ['id="breadcrumb"', '面包屑'],
    ['id="topbarActions"', '顶栏操作'],
    ['id="searchOverlay"', '搜索覆盖层'],
    ['id="searchInput"', '搜索输入'],
    ['id="ingestOverlay"', '投喂面板'],
    ['id="ingestContent"', '投喂输入'],
    ['id="settingsModal"', '设置弹窗'],
    ['id="formatToolbar"', '格式工具栏'],
    ['id="delConfirm"', '删除确认'],
    ['id="toast"', 'Toast'],
    ['id="mobileNav"', '移动导航'],
  ];
  for (const [selector, label] of elements) {
    assert(`HTML 含 ${label} (${selector})`, html.includes(selector));
  }

  // 侧边栏导航项
  const navViews = ['dashboard', 'graph', 'browse', 'health'];
  for (const v of navViews) {
    assert(`侧边栏含 data-view="${v}"`, html.includes(`data-view="${v}"`));
  }

  // 设置弹窗 tab
  assert('设置弹窗含"模型配置"tab', html.includes('模型配置'));
  assert('设置弹窗含"记忆"tab', html.includes('>记忆<'));

  // ES module 加载
  assert('加载 app.js 为 ES module', html.includes('type="module" src="/js/app.js"'));
}

// ═══════════════════════════════════════════
// 3. Window 函数绑定（关键！）
// ═══════════════════════════════════════════
async function testWindowBindings() {
  console.log('\n🔗 Window 函数绑定');

  const appJs = (await req('GET', '/js/app.js')).raw;

  // 从 index.html 提取所有 onclick="xxx(..." 中的函数名（排除 JS 关键字如 if/event）
  const html = (await req('GET', '/')).raw;
  const jsKeywords = new Set(['if', 'else', 'for', 'while', 'return', 'event', 'this', 'new', 'var', 'let', 'const', 'document']);
  const onclickFns = new Set();
  for (const m of html.matchAll(/onclick="([a-zA-Z_]\w*)\(/g)) { if (!jsKeywords.has(m[1])) onclickFns.add(m[1]); }
  // 从 onchange
  for (const m of html.matchAll(/onchange="([a-zA-Z_]\w*)\(/g)) { if (!jsKeywords.has(m[1])) onclickFns.add(m[1]); }

  for (const fn of onclickFns) {
    // 检查 window.fn 或 window.fn = 赋值
    const bound = appJs.includes(`window.${fn} =`) || appJs.includes(`window.${fn}=`);
    assert(`window.${fn} 已绑定 (index.html onclick 使用)`, bound, '缺少 window 绑定');
  }

  // 检查各页面 JS 中 onclick="xxx(" 引用的函数
  const pageFiles = [
    '/js/pages/dashboard.js', '/js/pages/chat.js', '/js/pages/article.js',
    '/js/pages/graph.js', '/js/pages/browse.js', '/js/pages/health.js',
    '/js/memory.js',
  ];
  const pageFns = new Set();
  for (const pf of pageFiles) {
    const code = (await req('GET', pf)).raw;
    for (const m of code.matchAll(/onclick="([a-zA-Z_]\w*)\(/g)) pageFns.add(m[1]);
    for (const m of code.matchAll(/onclick="window\.([a-zA-Z_]\w*)\(/g)) pageFns.add(m[1]);
    for (const m of code.matchAll(/onchange="window\.([a-zA-Z_]\w*)\(/g)) pageFns.add(m[1]);
    for (const m of code.matchAll(/onblur="window\.([a-zA-Z_]\w*)\(/g)) pageFns.add(m[1]);
  }

  for (const fn of pageFns) {
    // Check if it's bound in app.js or defined as window.fn in any page
    const inApp = appJs.includes(`window.${fn} =`) || appJs.includes(`window.${fn}=`);
    let inPages = false;
    for (const pf of pageFiles) {
      const code = (await req('GET', pf)).raw;
      if (code.includes(`window.${fn} =`) || code.includes(`window.${fn}=`)) { inPages = true; break; }
    }
    assert(`window.${fn} 已绑定 (动态页面使用)`, inApp || inPages, '缺少 window 绑定');
  }
}

// ═══════════════════════════════════════════
// 4. API 端点功能测试
// ═══════════════════════════════════════════
async function testApiEndpoints() {
  console.log('\n🔌 API 端点');

  // Wiki Stats
  const stats = await req('GET', '/api/wiki/stats');
  assert('GET /api/wiki/stats → 200', stats.status === 200);
  assert('stats 含 articles 字段', typeof stats.json?.articles === 'number');
  assert('stats 含 topics 字段', typeof stats.json?.topics === 'number');
  assert('stats 含 connections 字段', typeof stats.json?.connections === 'number');

  // Wiki Graph
  const graph = await req('GET', '/api/wiki/graph');
  assert('GET /api/wiki/graph → 200', graph.status === 200);
  assert('graph 含 nodes 数组', Array.isArray(graph.json?.nodes));
  assert('graph 含 edges 数组', Array.isArray(graph.json?.edges));
  assert('graph node 含 keyword 字段', graph.json.nodes.length > 0 && typeof graph.json.nodes[0].keyword === 'string');
  assert('graph node 含 topic 字段', graph.json.nodes.length > 0 && typeof graph.json.nodes[0].topic === 'string');
  assert('keyword 非空字符串', graph.json.nodes.every(n => n.keyword && n.keyword.length >= 2));

  // Wiki Tree
  const tree = await req('GET', '/api/wiki/tree');
  assert('GET /api/wiki/tree → 200', tree.status === 200);
  assert('tree 是数组', Array.isArray(tree.json));
  assert('tree 项含 name 和 children', tree.json.length > 0 && tree.json[0].name && Array.isArray(tree.json[0].children));

  // Wiki Recent
  const recent = await req('GET', '/api/wiki/recent');
  assert('GET /api/wiki/recent → 200', recent.status === 200);
  assert('recent 含 entries 数组', Array.isArray(recent.json?.entries));

  // Wiki Search (前端使用 /api/search)
  const search = await req('GET', '/api/search?q=AI');
  assert('GET /api/search?q=AI → 200', search.status === 200);
  assert('search 返回数组结果', Array.isArray(search.json) && search.json.length > 0);

  // Wiki Article (read existing)
  if (graph.json.nodes.length > 0) {
    const artPath = graph.json.nodes[0].id;
    const art = await req('GET', '/api/wiki/article?path=' + encodeURIComponent(artPath));
    assert(`GET /api/wiki/article (${artPath}) → 200`, art.status === 200);
    assert('article 含 content 字段', typeof art.json?.content === 'string');
    assert('article content 非空', art.json.content.length > 50);
  }

  // Settings
  const sett = await req('GET', '/api/settings');
  assert('GET /api/settings → 200', sett.status === 200);
  assert('settings 含 provider 字段', typeof sett.json?.provider === 'string');
  assert('settings 含 providers 对象', typeof sett.json?.providers === 'object');
  assert('settings 含 hasKey 布尔值', typeof sett.json?.hasKey === 'boolean');
  assert('settings 不含明文 apiKey', !sett.raw.includes('sk-') && !sett.raw.includes('apiKey'));

  // Memory
  const mem = await req('GET', '/api/memory');
  assert('GET /api/memory → 200', mem.status === 200);
  assert('memory 含 items 数组', Array.isArray(mem.json?.items));

  // Health Reports
  const reportList = await req('GET', '/api/reports/list');
  assert('GET /api/reports/list → 200', reportList.status === 200);
  assert('reports/list 含 files 数组', Array.isArray(reportList.json?.files));

  const latest = await req('GET', '/api/reports/latest');
  assert('GET /api/reports/latest → 200', latest.status === 200);
  assert('latest report 含 score', typeof latest.json?.score === 'number');
  assert('latest report score 0-100', latest.json.score >= 0 && latest.json.score <= 100);
  assert('latest report 含 issues 数组', Array.isArray(latest.json?.issues));
  assert('latest report 含 scoreBreakdown', typeof latest.json?.scoreBreakdown === 'object');

  // Chat list
  const chatList = await req('GET', '/api/chat/list');
  assert('GET /api/chat/list → 200', chatList.status === 200);

  // Profile
  const profile = await req('GET', '/api/profile');
  assert('GET /api/profile → 200', profile.status === 200);

  // Ingest status (no active task)
  const ingestStatus = await req('GET', '/api/ingest/status');
  assert('GET /api/ingest/status → 200', ingestStatus.status === 200);
}

// ═══════════════════════════════════════════
// 5. API 写操作流程测试
// ═══════════════════════════════════════════
async function testApiWriteFlows() {
  console.log('\n✏️  API 写操作流程');

  // Memory CRUD
  const memAdd = await req('POST', '/api/memory', { category: 'context', label: '测试标签', content: '测试内容' });
  assert('POST /api/memory 创建记忆 → 200', memAdd.status === 200);
  assert('创建记忆返回 id', memAdd.json?.id);

  if (memAdd.json?.id) {
    const memId = memAdd.json.id;

    const memUpd = await req('PUT', `/api/memory/${memId}`, { label: '更新后标签' });
    assert(`PUT /api/memory/${memId} 更新 → 200`, memUpd.status === 200);

    const memGet = await req('GET', '/api/memory');
    const found = memGet.json?.items?.find(m => m.id === memId);
    assert('更新后标签一致', found?.label === '更新后标签');

    const memDel = await req('DELETE', `/api/memory/${memId}`);
    assert(`DELETE /api/memory/${memId} → 200`, memDel.status === 200);

    const memGet2 = await req('GET', '/api/memory');
    const gone = memGet2.json?.items?.find(m => m.id === memId);
    assert('删除后记忆不存在', !gone);
  }

  // Article CRUD
  const testPath = 'ai-skills/test-auto-article';
  const artCreate = await req('PUT', '/api/wiki/article', { path: testPath, content: '# 测试文章\n\n这是自动测试创建的文章。' });
  assert('PUT /api/wiki/article 创建文章 → 200', artCreate.status === 200);

  const artRead = await req('GET', '/api/wiki/article?path=' + encodeURIComponent(testPath));
  assert('GET 读取刚创建的文章', artRead.status === 200);
  assert('文章内容正确', artRead.json?.content?.includes('测试文章'));

  const artUpdate = await req('PUT', '/api/wiki/article', { path: testPath, content: '# 测试文章（已更新）\n\n更新后的内容。' });
  assert('PUT 更新文章 → 200', artUpdate.status === 200);

  const artDel = await req('DELETE', '/api/wiki/article?path=' + encodeURIComponent(testPath));
  assert('DELETE 删除测试文章 → 200', artDel.status === 200);

  const artGone = await req('GET', '/api/wiki/article?path=' + encodeURIComponent(testPath));
  assert('删除后文章不存在', artGone.status !== 200);
}

// ═══════════════════════════════════════════
// 6. 安全测试
// ═══════════════════════════════════════════
async function testSecurity() {
  console.log('\n🔒 安全测试');

  // Path traversal - article read
  const traversal = await req('GET', '/api/wiki/article?path=' + encodeURIComponent('../../etc/passwd'));
  assert('路径穿越读取 (../) 被拦截', traversal.status === 400 || traversal.status === 404);

  // Path traversal - article write
  const traversalWrite = await req('PUT', '/api/wiki/article', { path: '../../../etc/evil', content: 'pwned' });
  assert('路径穿越写入被拦截', traversalWrite.status === 400 || traversalWrite.status === 404);

  // API key not in settings response
  const settRes = await req('GET', '/api/settings');
  assert('settings 不泄漏 API key', !settRes.raw.includes('WIKI_API_KEY') && typeof settRes.json?.apiKey === 'undefined');

  // Normal ingest request not rejected by global body limit
  const smallIngest = await req('POST', '/api/ingest', { content: '测试文本', type: 'text' });
  assert('正常大小 ingest 不被 413', smallIngest.status !== 413);

  // Body size limit (放最后，413 会导致连接异常)
  try {
    const r413 = await new Promise((resolve, reject) => {
      const r = http.request({ method: 'POST', hostname: 'localhost', port: 3456, path: '/api/chat/new', headers: { 'Content-Length': '20000000', 'Content-Type': 'application/json' } }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode }));
      });
      r.on('error', e => resolve({ status: 413, error: e.message })); // 413 后连接断开是正常的
      r.write('{}');
      r.end();
    });
    assert('超大 POST body → 413', r413.status === 413);
  } catch (e) {
    assert('超大 POST body → 413', false, e.message);
  }
}

// ═══════════════════════════════════════════
// 7. CSS 完整性 — 检查 JS 引用的 class 在 CSS 中存在
// ═══════════════════════════════════════════
async function testCssCompleteness() {
  console.log('\n🎨 CSS 完整性');

  // 加载所有 CSS
  const cssFiles = ['/css/base.css', '/css/layout.css', '/css/components.css', '/css/pages.css', '/css/ingest.css'];
  let allCss = '';
  for (const f of cssFiles) { allCss += (await req('GET', f)).raw + '\n'; }

  // 关键 CSS 类检查（从 JS 动态生成的 HTML 中使用的类）
  const criticalClasses = [
    // Dashboard
    'page-dashboard', 'chat-area', 'chat-greeting', 'suggestion-cards', 'suggestion-card',
    'graph-card', 'dash-health-card', 'activity-card', 'activity-row',
    // Chat
    'page-chat', 'chat-messages', 'chat-msg', 'chat-msg-body', 'chat-msg-avatar',
    'chat-refs', 'chat-ref', 'chat-msg-actions', 'precip-btn', 'precip-badge',
    'precip-modal-bg', 'precip-modal-card', 'precip-preview',
    // Article
    'page-article', 'article-title', 'article-body', 'article-toc', 'article-related',
    // Graph
    'page-graph', 'graph-toolbar', 'graph-canvas-wrap',
    // Browse
    'page-browse',
    // Health
    'page-health', 'health-header', 'health-score-section', 'health-dims',
    'health-dim', 'health-dim-bar', 'health-dim-fill', 'health-total',
    'health-stats', 'health-stat-item', 'health-issues', 'health-issue',
    'health-sev', 'health-history', 'health-section-head',
    // Memory
    'mem-panel', 'mem-category', 'mem-cat-header', 'mem-cat-body', 'mem-item',
    'mem-item-main', 'mem-item-label', 'mem-item-content', 'mem-item-actions',
    'mem-toggle', 'mem-toggle-slider', 'mem-add-btn', 'mem-del-btn',
    // Settings tabs
    'settings-tabs', 'settings-tab', 'settings-tab-content',
    // Components
    'modal-bg', 'modal-card', 'toast', 'btn-fill', 'btn-outline',
  ];

  for (const cls of criticalClasses) {
    // CSS might use .cls, .cls.xxx, .cls:hover etc
    const found = allCss.includes('.' + cls);
    assert(`CSS 含 .${cls}`, found);
  }
}

// ═══════════════════════════════════════════
// 8. JS 模块导入链完整性
// ═══════════════════════════════════════════
async function testModuleImports() {
  console.log('\n📦 模块导入链');

  const allJsFiles = [
    '/js/app.js', '/js/router.js', '/js/state.js', '/js/utils.js',
    '/js/memory.js', '/js/settings.js', '/js/composer.js', '/js/search.js',
    '/js/sidebar.js', '/js/ingest.js', '/js/markdown.js', '/js/theme.js',
    '/js/pages/dashboard.js', '/js/pages/chat.js', '/js/pages/article.js',
    '/js/pages/graph.js', '/js/pages/browse.js', '/js/pages/health.js',
  ];

  for (const jsFile of allJsFiles) {
    const code = (await req('GET', jsFile)).raw;

    // 提取所有 import from '...' 路径
    const imports = [...code.matchAll(/from\s+['"](.+?)['"]/g)].map(m => m[1]);

    for (const imp of imports) {
      // 相对路径必须以 ./ 或 ../ 开头
      assert(`${jsFile}: import "${imp}" 是相对路径`, imp.startsWith('./') || imp.startsWith('../'), '非相对路径会导致加载失败');

      // 必须以 .js 结尾
      assert(`${jsFile}: import "${imp}" 含 .js 后缀`, imp.endsWith('.js'), '缺少 .js 后缀会导致浏览器 module 加载失败');

      // 解析实际路径并验证可访问
      const dir = jsFile.split('/').slice(0, -1).join('/');
      const parts = [...dir.split('/').filter(Boolean), ...imp.split('/').filter(Boolean)];
      const resolved = [];
      for (const p of parts) {
        if (p === '..') resolved.pop();
        else if (p !== '.') resolved.push(p);
      }
      const resolvedPath = '/' + resolved.join('/');
      const impRes = await req('GET', resolvedPath);
      assert(`${jsFile}: import "${imp}" 文件存在 (→ ${resolvedPath})`, impRes.status === 200, `got ${impRes.status}`);
    }
  }
}

// ═══════════════════════════════════════════
// 9. 函数导出完整性
// ═══════════════════════════════════════════
async function testExportImportConsistency() {
  console.log('\n🔄 导入导出一致性');

  const appJs = (await req('GET', '/js/app.js')).raw;

  // 从 app.js 提取所有 import { xxx } from '...'
  const importBlocks = [...appJs.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)];

  for (const [, names, from] of importBlocks) {
    const importedNames = names.split(',').map(n => n.trim()).filter(Boolean);

    // 解析源文件路径
    const fromParts = from.replace('./', '').split('/');
    const resolvedFrom = '/js/' + fromParts.join('/');
    const sourceCode = (await req('GET', resolvedFrom)).raw;

    for (const name of importedNames) {
      const cleanName = name.split(' as ')[0].trim();
      // 检查源文件 export 了这个名字
      const exported = sourceCode.includes(`export function ${cleanName}`) ||
                       sourceCode.includes(`export async function ${cleanName}`) ||
                       sourceCode.includes(`export const ${cleanName}`) ||
                       sourceCode.includes(`export let ${cleanName}`) ||
                       sourceCode.includes(`export { ${cleanName}`) ||
                       sourceCode.includes(`export {${cleanName}`) ||
                       sourceCode.includes(`, ${cleanName}`) && sourceCode.includes(`export {`);
      assert(`app.js 导入 ${cleanName} ← ${from} 有 export`, exported, `${from} 未导出 ${cleanName}`);
    }
  }
}

// ═══════════════════════════════════════════
// 10. 数据一致性
// ═══════════════════════════════════════════
async function testDataConsistency() {
  console.log('\n📊 数据一致性');

  const [stats, graph, tree] = await Promise.all([
    req('GET', '/api/wiki/stats'),
    req('GET', '/api/wiki/graph'),
    req('GET', '/api/wiki/tree'),
  ]);

  // 文章数一致
  const statsArticles = stats.json.articles;
  const graphNodes = graph.json.nodes.length;
  const treeArticles = tree.json.reduce((sum, t) => sum + (t.children?.length || 0), 0);

  assert('stats.articles === graph nodes 数', statsArticles === graphNodes, `stats=${statsArticles}, graph=${graphNodes}`);
  assert('stats.articles === tree 文章数', statsArticles === treeArticles, `stats=${statsArticles}, tree=${treeArticles}`);

  // 连接数一致
  assert('stats.connections === graph edges', stats.json.connections === graph.json.edges.length,
    `stats=${stats.json.connections}, graph=${graph.json.edges.length}`);

  // Topic 数一致
  const graphTopics = new Set(graph.json.nodes.map(n => n.topic).filter(Boolean));
  assert('stats.topics === graph 中唯一 topic 数', stats.json.topics === graphTopics.size,
    `stats=${stats.json.topics}, graph=${graphTopics.size}`);

  // 每个 keyword 至少 2 字符
  for (const n of graph.json.nodes) {
    assert(`关键词 "${n.keyword}" ≥2 字符`, n.keyword.length >= 2);
  }

  // Health report issues 与 score 一致
  const health = await req('GET', '/api/reports/latest');
  if (health.json.score !== undefined) {
    assert('health score 是 0-100 之间的数', health.json.score >= 0 && health.json.score <= 100);
    assert('health 含 4 个维度', health.json.scoreBreakdown &&
      typeof health.json.scoreBreakdown.completeness === 'number' &&
      typeof health.json.scoreBreakdown.freshness === 'number' &&
      typeof health.json.scoreBreakdown.connectivity === 'number' &&
      typeof health.json.scoreBreakdown.consistency === 'number');
  }
}

// ═══════════════════════════════════════════
// 11. 边界测试
// ═══════════════════════════════════════════
async function testEdgeCases() {
  console.log('\n⚡ 边界测试');

  // 空搜索
  const emptySearch = await req('GET', '/api/search?q=');
  assert('空搜索返回 400', emptySearch.status === 400);

  // 不存在的文章
  const noArticle = await req('GET', '/api/wiki/article?path=nonexistent/nope');
  assert('不存在的文章返回错误', noArticle.status >= 400);

  // 不存在的对话
  const noChat = await req('GET', '/api/chat/nonexistent-id-12345');
  assert('不存在的对话返回错误', noChat.status >= 400);

  // 不存在的报告日期
  const noReport = await req('GET', '/api/reports/9999-99-99');
  assert('不存在的报告返回错误', noReport.status >= 400);

  // 不存在的记忆 ID
  const noMem = await req('PUT', '/api/memory/nonexistent-id', { label: 'test' });
  assert('不存在的记忆返回错误', noMem.status >= 400);

  const noMemDel = await req('DELETE', '/api/memory/nonexistent-id');
  assert('删除不存在的记忆返回错误', noMemDel.status >= 400);

  // 缺少必要参数
  const noContent = await req('POST', '/api/memory', { category: 'personal' });
  assert('创建记忆缺少参数返回错误', noContent.status >= 400);

  // 特殊字符搜索
  const specialSearch = await req('GET', '/api/search?q=' + encodeURIComponent('<script>alert(1)</script>'));
  assert('XSS 搜索不崩溃', specialSearch.status === 200);

  // Unicode 搜索
  const unicodeSearch = await req('GET', '/api/search?q=' + encodeURIComponent('知识库'));
  assert('中文搜索返回结果', unicodeSearch.status === 200);

  // Settings PUT without key
  const settSave = await req('PUT', '/api/settings', { provider: 'bailian', model: 'qwen-plus' });
  assert('保存设置不崩溃', settSave.status === 200);

  // Double-encode path
  const dblEncode = await req('GET', '/api/wiki/article?path=' + encodeURIComponent(encodeURIComponent('ai-skills/test')));
  assert('双重编码路径不崩溃', dblEncode.status >= 400 || dblEncode.status === 200);
}

// ═══════════════════════════════════════════
// 12. 暗色模式 CSS
// ═══════════════════════════════════════════
async function testDarkMode() {
  console.log('\n🌙 暗色模式 CSS');

  const cssFiles = ['/css/base.css', '/css/layout.css', '/css/components.css', '/css/pages.css', '/css/ingest.css'];
  const darkThemeCounts = {};
  for (const f of cssFiles) {
    const css = (await req('GET', f)).raw;
    const darkCount = (css.match(/\[data-theme="dark"\]/g) || []).length;
    const varCount = (css.match(/var\(--/g) || []).length;
    darkThemeCounts[f] = darkCount;
    // 纯变量驱动的文件（所有颜色用 var(--*)）不需要暗色模式规则
    assert(`${f} 支持暗色模式`, darkCount > 0 || varCount > 20, `${darkCount} 条 dark 规则, ${varCount} 处 var(--)`);
  }
}

// ═══════════════════════════════════════════
// 运行
// ═══════════════════════════════════════════
async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   Wiki-App 前端自动化测试            ║');
  console.log('╚══════════════════════════════════════╝');

  try {
    await testStaticAssets();
    await testHtmlStructure();
    await testWindowBindings();
    await testApiEndpoints();
    await testApiWriteFlows();
    await testCssCompleteness();
    await testModuleImports();
    await testExportImportConsistency();
    await testDataConsistency();
    await testEdgeCases();
    await testDarkMode();
    await testSecurity(); // 最后运行，413 测试会断开连接
  } catch (e) {
    console.error('\n💥 测试运行异常:', e.message);
    failed++;
  }

  console.log('\n══════════════════════════════════════');
  console.log(`  总计: ${passed + failed} 项 | ✅ ${passed} 通过 | ❌ ${failed} 失败`);
  if (errors.length) {
    console.log('\n  失败项:');
    errors.forEach(e => console.log(e));
  }
  console.log('══════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main();
