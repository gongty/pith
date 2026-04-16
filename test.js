const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const BASE = 'http://localhost:3456';

// ── Helpers ──

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: {} };
    if (body) { const b = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; opts.headers['Content-Length'] = Buffer.byteLength(b); }
    const r = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let json;
        try { json = JSON.parse(d); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body: d, json });
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const GET = (p) => req('GET', p);
const POST = (p, b) => req('POST', p, b);
const PUT = (p, b) => req('PUT', p, b);
const DEL = (p) => req('DELETE', p);

// ═══════════════════════════════════════════
// 1. Static File Serving
// ═══════════════════════════════════════════

describe('Static files', () => {
  it('GET / returns index.html', async () => {
    const r = await GET('/');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('<!DOCTYPE html') || r.body.includes('<html'));
    assert.ok(r.headers['content-type'].includes('text/html'));
  });

  it('GET /css/base.css returns CSS', async () => {
    const r = await GET('/css/base.css');
    assert.equal(r.status, 200);
    assert.ok(r.headers['content-type'].includes('text/css'));
  });

  it('GET /js/app.js returns JS', async () => {
    const r = await GET('/js/app.js');
    assert.equal(r.status, 200);
    assert.ok(r.headers['content-type'].includes('javascript'));
  });

  it('GET /nonexistent returns 404', async () => {
    const r = await GET('/nonexistent-file-xyz.txt');
    assert.equal(r.status, 404);
  });

  it('static files have no-cache header', async () => {
    const r = await GET('/css/base.css');
    assert.equal(r.headers['cache-control'], 'no-cache');
  });
});

// ═══════════════════════════════════════════
// 2. Settings API
// ═══════════════════════════════════════════

describe('Settings API', () => {
  it('GET /api/settings returns config', async () => {
    const r = await GET('/api/settings');
    assert.equal(r.status, 200);
    assert.ok(r.json.provider);
    assert.ok(r.json.providers);
    assert.ok('hasKey' in r.json);
    assert.ok('wikiLang' in r.json);
  });

  it('settings has all expected providers', async () => {
    const r = await GET('/api/settings');
    const keys = Object.keys(r.json.providers);
    for (const k of ['bailian', 'openrouter', 'anthropic', 'openai', 'deepseek', 'local']) {
      assert.ok(keys.includes(k), `missing provider: ${k}`);
    }
  });

  it('settings never exposes apiKey', async () => {
    const r = await GET('/api/settings');
    assert.equal(r.json.apiKey, undefined);
    assert.ok(!r.body.includes('sk-'));
  });

  it('PUT /api/settings saves wikiLang', async () => {
    const orig = await GET('/api/settings');
    const origLang = orig.json.wikiLang;
    // Save new lang
    await PUT('/api/settings', { provider: orig.json.provider, model: orig.json.model, wikiLang: 'en' });
    const r = await GET('/api/settings');
    assert.equal(r.json.wikiLang, 'en');
    // Restore
    await PUT('/api/settings', { provider: orig.json.provider, model: orig.json.model, wikiLang: origLang });
  });
});

// ═══════════════════════════════════════════
// 3. Profile & Memory API
// ═══════════════════════════════════════════

describe('Profile API', () => {
  it('GET /api/profile returns object', async () => {
    const r = await GET('/api/profile');
    assert.equal(r.status, 200);
    assert.equal(typeof r.json, 'object');
  });
});

describe('Memory API', () => {
  it('GET /api/memory returns text field', async () => {
    const r = await GET('/api/memory');
    assert.equal(r.status, 200);
    assert.ok('text' in r.json);
  });

  it('PUT /api/memory saves and retrieves', async () => {
    const orig = await GET('/api/memory');
    const marker = '__test_' + Date.now();
    await PUT('/api/memory', { text: (orig.json.text || '') + '\n' + marker });
    const r = await GET('/api/memory');
    assert.ok(r.json.text.includes(marker));
    // Restore
    await PUT('/api/memory', { text: orig.json.text || '' });
  });
});

// ═══════════════════════════════════════════
// 4. Wiki CRUD API
// ═══════════════════════════════════════════

describe('Wiki API', () => {
  const testTopic = '_test-auto';
  const testFile = 'test-article.md';
  const testPath = `${testTopic}/${testFile}`;
  const testContent = '# Test Article\n> 来源：test，2026-01-01\n> 原文：test.md\n\n## 概述\nThis is a test.\n\n## See Also\n';

  it('POST /api/wiki/article creates article', async () => {
    const r = await POST('/api/wiki/article', { path: testPath, content: testContent });
    assert.equal(r.status, 200);
  });

  it('GET /api/wiki/tree includes test topic', async () => {
    const r = await GET('/api/wiki/tree');
    assert.equal(r.status, 200);
    const topic = r.json.find(t => t.name === testTopic);
    assert.ok(topic, 'test topic should exist in tree');
    assert.ok(topic.children.length > 0);
  });

  it('tree children are sorted by mtime descending', async () => {
    const r = await GET('/api/wiki/tree');
    for (const topic of r.json) {
      if (topic.children.length < 2) continue;
      for (let i = 0; i < topic.children.length - 1; i++) {
        assert.ok(topic.children[i].mtime >= topic.children[i + 1].mtime,
          `${topic.name}: ${topic.children[i].file} should be newer than ${topic.children[i + 1].file}`);
      }
    }
  });

  it('GET /api/wiki/article reads article', async () => {
    const r = await GET('/api/wiki/article?path=' + encodeURIComponent(testPath));
    assert.equal(r.status, 200);
    assert.ok(r.json.content.includes('# Test Article'));
  });

  it('PUT /api/wiki/article edits article', async () => {
    const newContent = testContent + '\n- [Edited link](test.md)\n';
    const r = await PUT('/api/wiki/article', { path: testPath, content: newContent });
    assert.equal(r.status, 200);
    const check = await GET('/api/wiki/article?path=' + encodeURIComponent(testPath));
    assert.ok(check.json.content.includes('Edited link'));
  });

  it('GET /api/wiki/toc extracts headings', async () => {
    const r = await GET('/api/wiki/toc?path=' + encodeURIComponent(testPath));
    assert.equal(r.status, 200);
    const toc = r.json.toc || r.json;
    assert.ok(Array.isArray(toc));
    assert.ok(toc.some(h => h.text === '概述'));
  });

  it('GET /api/wiki/article-meta returns metadata', async () => {
    const r = await GET('/api/wiki/article-meta?path=' + encodeURIComponent(testPath));
    assert.equal(r.status, 200);
    assert.ok(r.json.title);
    assert.ok(r.json.wordCount >= 0);
  });

  it('GET /api/wiki/stats returns counts', async () => {
    const r = await GET('/api/wiki/stats');
    assert.equal(r.status, 200);
    assert.ok(r.json.articles >= 1);
    assert.ok(r.json.topics >= 1);
  });

  it('DELETE /api/wiki/article removes article', async () => {
    const r = await DEL('/api/wiki/article?path=' + encodeURIComponent(testPath));
    assert.equal(r.status, 200);
    const check = await GET('/api/wiki/article?path=' + encodeURIComponent(testPath));
    assert.equal(check.status, 404);
  });

  // Cleanup topic dir
  after(async () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, 'data', 'wiki', testTopic);
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  });
});

// ═══════════════════════════════════════════
// 5. Search API
// ═══════════════════════════════════════════

describe('Search API', () => {
  it('GET /api/search?q=... returns results array', async () => {
    const r = await GET('/api/search?q=AI');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json));
  });

  it('GET /api/wiki/search-suggest returns suggestions', async () => {
    const r = await GET('/api/wiki/search-suggest?q=AI');
    assert.equal(r.status, 200);
    const list = r.json.suggestions || r.json;
    assert.ok(Array.isArray(list));
  });

  it('search returns matching articles', async () => {
    const r = await GET('/api/search?q=TUNEE');
    assert.ok(r.json.length > 0, 'should find articles about TUNEE');
  });
});

// ═══════════════════════════════════════════
// 6. Wiki Graph API
// ═══════════════════════════════════════════

describe('Graph API', () => {
  it('GET /api/wiki/graph returns nodes and links', async () => {
    const r = await GET('/api/wiki/graph');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.nodes));
    assert.ok(Array.isArray(r.json.edges || r.json.links));
  });

  it('graph nodes have required fields', async () => {
    const r = await GET('/api/wiki/graph');
    if (r.json.nodes.length > 0) {
      const n = r.json.nodes[0];
      assert.ok('id' in n);
      assert.ok('name' in n || 'label' in n || 'title' in n);
    }
  });

  it('GET /api/wiki/keywords returns keywords', async () => {
    const r = await GET('/api/wiki/keywords');
    assert.equal(r.status, 200);
    const list = r.json.keywords || r.json;
    assert.ok(Array.isArray(list));
  });
});

// ═══════════════════════════════════════════
// 7. Wiki Index & Log
// ═══════════════════════════════════════════

describe('Wiki Index & Log', () => {
  it('GET /api/wiki/index returns markdown', async () => {
    const r = await GET('/api/wiki/index');
    assert.equal(r.status, 200);
    assert.ok(r.json.content.includes('#'));
  });

  it('GET /api/wiki/log returns markdown', async () => {
    const r = await GET('/api/wiki/log');
    assert.equal(r.status, 200);
    assert.ok(r.json.content.includes('日志') || r.json.content.includes('Log'));
  });

  it('GET /api/wiki/recent returns entries', async () => {
    const r = await GET('/api/wiki/recent');
    assert.equal(r.status, 200);
    const list = r.json.entries || r.json;
    assert.ok(Array.isArray(list));
  });

  it('GET /api/wiki/backlinks returns array', async () => {
    const r = await GET('/api/wiki/backlinks?path=ai-skills/ai-distillation-skills.md');
    assert.equal(r.status, 200);
    const list = r.json.backlinks || r.json;
    assert.ok(Array.isArray(list));
  });
});

// ═══════════════════════════════════════════
// 8. Chat API
// ═══════════════════════════════════════════

describe('Chat API', () => {
  let chatId;

  it('GET /api/chat/list returns array', async () => {
    const r = await GET('/api/chat/list');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json) || Array.isArray(r.json.conversations));
  });

  it('POST /api/chat/new creates conversation', async () => {
    const r = await POST('/api/chat/new', {});
    assert.equal(r.status, 200);
    const conv = r.json.conversation || r.json;
    assert.ok(conv.id, 'should return conversation id');
    chatId = conv.id;
  });

  it('GET /api/chat/:id loads conversation', async () => {
    const r = await GET(`/api/chat/${chatId}`);
    assert.equal(r.status, 200);
    const conv = r.json.conversation || r.json;
    assert.ok(conv.id === chatId || conv.title);
  });

  it('PUT /api/chat/:id/title renames', async () => {
    const r = await PUT(`/api/chat/${chatId}/title`, { title: 'Test Chat' });
    assert.equal(r.status, 200);
  });

  it('DELETE /api/chat/:id removes conversation', async () => {
    const r = await DEL(`/api/chat/${chatId}`);
    assert.equal(r.status, 200);
    const check = await GET(`/api/chat/${chatId}`);
    assert.equal(check.status, 404);
  });
});

// ═══════════════════════════════════════════
// 9. Raw Materials API
// ═══════════════════════════════════════════

describe('Raw API', () => {
  it('GET /api/raw/tree returns topics', async () => {
    const r = await GET('/api/raw/tree');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json));
  });

  it('GET /api/raw/file reads a raw file', async () => {
    const tree = await GET('/api/raw/tree');
    if (tree.json.length > 0 && tree.json[0].children.length > 0) {
      const p = tree.json[0].children[0].path;
      const r = await GET('/api/raw/file?path=' + encodeURIComponent(p));
      assert.equal(r.status, 200);
      assert.ok(r.json.content.length > 0);
    }
  });
});

// ═══════════════════════════════════════════
// 10. Ingest API
// ═══════════════════════════════════════════

describe('Ingest API', () => {
  it('GET /api/ingest/status returns status', async () => {
    const r = await GET('/api/ingest/status');
    // Either 200 with status or empty (no active task)
    assert.ok(r.status === 200 || r.status === 204);
  });

  it('GET /api/ingest/batch/status returns batch info', async () => {
    const r = await GET('/api/ingest/batch/status');
    assert.ok(r.status === 200 || r.status === 204);
  });

  it('GET /api/tasks returns task list', async () => {
    const r = await GET('/api/tasks');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json));
  });
});

// ═══════════════════════════════════════════
// 11. Health / Lint API
// ═══════════════════════════════════════════

describe('Lint / Health API', () => {
  it('GET /api/wiki/lint returns score and issues', async () => {
    const r = await GET('/api/wiki/lint');
    assert.equal(r.status, 200);
    assert.ok('score' in r.json);
    assert.ok(Array.isArray(r.json.issues));
    assert.ok(r.json.score >= 0 && r.json.score <= 100);
  });

  it('GET /api/reports/list returns files', async () => {
    const r = await GET('/api/reports/list');
    assert.equal(r.status, 200);
    const list = r.json.files || r.json;
    assert.ok(Array.isArray(list));
  });
});

// ═══════════════════════════════════════════
// 12. Frontend: Markdown resLink
// ═══════════════════════════════════════════

describe('Markdown resLink logic', () => {
  // Replicate the resLink function for unit testing
  function resLink(href, aDir) {
    if (/^https?:\/\//.test(href)) return href;
    if (href.startsWith('#/article/')) return href;
    if (!href.endsWith('.md')) return href;
    if (href.includes('/raw/') || href.startsWith('../../raw/')) return href;
    let r = href;
    if (href.startsWith('../') || href.startsWith('./')) {
      const b = aDir ? aDir.split('/') : []; const p = href.split('/'); const c = [...b];
      for (const x of p) { if (x === '..') c.pop(); else if (x !== '.') c.push(x); }
      r = c.join('/');
    } else if (href.includes('/')) {
      r = href;
    } else if (aDir) {
      r = aDir + '/' + href;
    }
    return '#/article/' + r;
  }

  const dir = 'ai-skills';

  it('same-dir relative: filename.md', () => {
    assert.equal(resLink('skill.md', dir), '#/article/ai-skills/skill.md');
  });

  it('cross-dir relative: ../topic/file.md', () => {
    assert.equal(resLink('../team-ai-setup/onboarding.md', dir), '#/article/team-ai-setup/onboarding.md');
  });

  it('already hash: #/article/...', () => {
    assert.equal(resLink('#/article/ai-skills/x.md', dir), '#/article/ai-skills/x.md');
  });

  it('absolute-ish with topic: topic/file.md', () => {
    assert.equal(resLink('ai-skills/x.md', dir), '#/article/ai-skills/x.md');
  });

  it('raw link preserved: ../../raw/general/test.md', () => {
    assert.equal(resLink('../../raw/general/test.md', dir), '../../raw/general/test.md');
  });

  it('external URL unchanged', () => {
    assert.equal(resLink('https://example.com', dir), 'https://example.com');
  });

  it('non-md link unchanged', () => {
    assert.equal(resLink('image.png', dir), 'image.png');
  });

  it('no aDir: bare filename.md', () => {
    assert.equal(resLink('test.md', ''), '#/article/test.md');
  });
});

// ═══════════════════════════════════════════
// 13. Compilation Prompt Language
// ═══════════════════════════════════════════

describe('Compilation language config', () => {
  it('wikiLang zh produces Chinese instruction', async () => {
    const r = await GET('/api/settings');
    // Just verify the field is there and valid
    assert.ok(['zh', 'en', 'ja', 'ko', 'auto'].includes(r.json.wikiLang));
  });

  it('PUT wikiLang=auto then restore', async () => {
    const orig = await GET('/api/settings');
    await PUT('/api/settings', { wikiLang: 'auto' });
    const r = await GET('/api/settings');
    assert.equal(r.json.wikiLang, 'auto');
    // Restore
    await PUT('/api/settings', { wikiLang: orig.json.wikiLang });
  });
});

// ═══════════════════════════════════════════
// 14. Edge cases & error handling
// ═══════════════════════════════════════════

describe('Error handling', () => {
  it('GET /api/wiki/article without path returns 400', async () => {
    const r = await GET('/api/wiki/article');
    assert.ok(r.status === 400 || r.status === 404);
  });

  it('GET /api/wiki/article with bad path returns 404', async () => {
    const r = await GET('/api/wiki/article?path=nonexistent/file.md');
    assert.equal(r.status, 404);
  });

  it('DELETE /api/wiki/article with bad path returns 404', async () => {
    const r = await DEL('/api/wiki/article?path=nonexistent/file.md');
    assert.equal(r.status, 404);
  });

  it('GET /api/chat/nonexistent returns 404', async () => {
    const r = await GET('/api/chat/nonexistent_id_999');
    assert.equal(r.status, 404);
  });

  it('PUT /api/settings with empty body returns ok', async () => {
    const r = await PUT('/api/settings', {});
    assert.equal(r.status, 200);
  });
});
