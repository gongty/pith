// lib/sources.js — Source adapter dispatcher for autotask redesign.
// Exports fetchSource(source) -> Promise<{ items: [{ url, title, summary, publishedAt, raw }] }>
// Source types: 'rss' | 'changelog' | 'aggregator' | 'webpage' | 'api' (legacy)
//
// All adapters are defensive: on failure they throw with a clear message; the caller
// is responsible for catching and recording the error per source.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const AGGREGATOR_SCRIPT = '/Users/blank/BLANK_work/plugins/news-skills/news-aggregator-skill/scripts/fetch_news.py';
const VALID_SUBSOURCES = new Set([
  'hackernews', 'github', '36kr', 'weibo', 'v2ex',
  'tencent', 'wallstreetcn', 'producthunt', 'all'
]);

function stripHtml(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function httpGetText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let mod;
    try { mod = url.startsWith('https') ? https : http; } catch (e) { return reject(e); }
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 WikiBot/1.0',
        'Accept': 'text/html,application/xml,application/rss+xml,application/atom+xml,*/*'
      }
    }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirectsLeft > 0) {
        const next = new URL(r.headers.location, url).toString();
        return httpGetText(next, redirectsLeft - 1).then(resolve, reject);
      }
      if (r.statusCode >= 400) {
        return reject(new Error(`HTTP ${r.statusCode} fetching ${url}`));
      }
      let data = '';
      r.setEncoding('utf-8');
      r.on('data', c => data += c);
      r.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Fetch timeout')); });
  });
}

// ── RSS / Atom ──

async function fetchRss(source) {
  const url = source.url;
  if (!url) throw new Error('rss source missing url');
  const xml = await httpGetText(url);

  const items = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1] || '';
    const link = (block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1]
              || (block.match(/<link[^>]*href="([^"]*)"[^>]*\/?>/i) || [])[1] || '';
    const desc = (block.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i) || [])[1] || '';
    const pubDate = (block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1] || '';
    items.push({
      title: stripHtml(title),
      url: link.trim(),
      summary: stripHtml(desc),
      publishedAt: pubDate.trim(),
      raw: { kind: 'rss' }
    });
  }

  if (!items.length) {
    const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    while ((match = entryRegex.exec(xml)) !== null) {
      const block = match[1];
      const title = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1] || '';
      const link = (block.match(/<link[^>]*href="([^"]*)"[^>]*\/?>/i) || [])[1] || '';
      const summary = (block.match(/<summary[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/summary>/i) || [])[1] || '';
      const updated = (block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) || [])[1]
                   || (block.match(/<published[^>]*>([\s\S]*?)<\/published>/i) || [])[1] || '';
      items.push({
        title: stripHtml(title),
        url: link.trim(),
        summary: stripHtml(summary),
        publishedAt: updated.trim(),
        raw: { kind: 'atom' }
      });
    }
  }

  return { items };
}

// ── Changelog (date-anchored entries on a single page) ──

function todayMatchers() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const monthsLong = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const monthsShort = monthsLong.map(m => m.slice(0, 3));
  const monthLong = monthsLong[now.getMonth()];
  const monthShort = monthsShort[now.getMonth()];
  const dayNum = String(now.getDate());
  return [
    `${yyyy}-${mm}-${dd}`,
    `${monthLong} ${dayNum}, ${yyyy}`,
    `${monthLong} ${dayNum} ${yyyy}`,
    `${monthShort} ${dayNum}, ${yyyy}`,
    `${monthShort} ${dayNum} ${yyyy}`,
    `${monthLong} ${dayNum}`,
    `${monthShort} ${dayNum}`,
    `${mm}/${dd}/${yyyy}`,
    `${dd}/${mm}/${yyyy}`
  ];
}

async function fetchChangelog(source) {
  const url = source.url;
  if (!url) throw new Error('changelog source missing url');
  let html;
  try {
    html = await httpGetText(url);
  } catch (e) {
    throw new Error(`changelog fetch failed: ${e.message}`);
  }
  const matchers = todayMatchers().map(s => s.toLowerCase());
  // Strip script/style first to avoid noise
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  // Heuristic: split on heading tags (h1-h4) or <li>/<article>/<section> blocks.
  const blocks = cleaned.split(/<(?=h[1-4][\s>]|article[\s>]|section[\s>]|li[\s>])/i);
  const items = [];
  for (const blockRaw of blocks) {
    const block = '<' + blockRaw;
    const blockText = stripHtml(block).toLowerCase();
    if (!blockText) continue;
    const hit = matchers.some(m => blockText.includes(m));
    if (!hit) continue;
    // Try to extract a title from first heading or link
    const titleMatch = block.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i)
                    || block.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
    const title = stripHtml(titleMatch ? titleMatch[1] : block).slice(0, 200);
    const linkMatch = block.match(/<a\s[^>]*href="([^"]+)"/i);
    let entryUrl = url;
    if (linkMatch) {
      try { entryUrl = new URL(linkMatch[1], url).toString(); } catch {}
    }
    const summary = stripHtml(block).slice(0, 1000);
    if (title && summary) {
      items.push({
        title,
        url: entryUrl,
        summary,
        publishedAt: new Date().toISOString(),
        raw: { kind: 'changelog' }
      });
    }
  }

  // Dedup by title
  const seen = new Set();
  const unique = items.filter(it => {
    const key = it.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { items: unique };
}

// ── Aggregator (python script wrapper) ──

function fetchAggregator(source) {
  return new Promise((resolve) => {
    if (!fs.existsSync(AGGREGATOR_SCRIPT)) {
      console.warn(`[sources] aggregator script not found at ${AGGREGATOR_SCRIPT}, returning empty`);
      return resolve({ items: [] });
    }
    const subsource = source.subsource || source.source || 'all';
    if (!VALID_SUBSOURCES.has(subsource)) {
      console.warn(`[sources] aggregator subsource invalid: ${subsource}`);
      return resolve({ items: [] });
    }
    const limit = String(source.limit || 15);
    const args = ['--source', subsource, '--limit', limit, '--deep'];
    if (source.keyword) args.push('--keyword', source.keyword);
    let stdout = '';
    let stderr = '';
    let done = false;
    const child = spawn('python3', [AGGREGATOR_SCRIPT, ...args], { cwd: path.dirname(AGGREGATOR_SCRIPT) });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch {}
      console.warn('[sources] aggregator timeout');
      resolve({ items: [] });
    }, 90000);
    child.stdout.on('data', c => stdout += c);
    child.stderr.on('data', c => stderr += c);
    child.on('error', e => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      console.warn(`[sources] aggregator spawn error: ${e.message}`);
      resolve({ items: [] });
    });
    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        console.warn(`[sources] aggregator exit ${code}: ${stderr.slice(-300)}`);
        return resolve({ items: [] });
      }
      let parsed;
      try {
        // Find first '[' or '{' to be tolerant of leading log lines
        const idx = stdout.search(/[\[{]/);
        const slice = idx >= 0 ? stdout.slice(idx) : stdout;
        parsed = JSON.parse(slice);
      } catch (e) {
        console.warn(`[sources] aggregator JSON parse failed: ${e.message}`);
        return resolve({ items: [] });
      }
      const arr = Array.isArray(parsed) ? parsed
                : (parsed && Array.isArray(parsed.items) ? parsed.items : []);
      const items = arr.map(it => ({
        title: it.title || it.name || '',
        url: it.url || it.link || '',
        summary: it.content || it.summary || it.description || '',
        publishedAt: it.time || it.publishedAt || it.date || '',
        raw: { kind: 'aggregator', subsource, score: it.score || it.heat || null }
      })).filter(it => it.title || it.url);
      resolve({ items });
    });
  });
}

// ── Legacy adapters ──

async function fetchWebpage(source) {
  const url = source.url;
  if (!url) throw new Error('webpage source missing url');
  const html = await httpGetText(url);
  const items = [];
  const linkRegex = /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    const href = m[1];
    const title = stripHtml(m[2]);
    if (href && title && href.startsWith('http') && title.length > 2) {
      items.push({
        title,
        url: href,
        summary: '',
        publishedAt: '',
        raw: { kind: 'webpage' }
      });
    }
  }
  return { items };
}

async function fetchApi(source) {
  const url = source.url;
  if (!url) throw new Error('api source missing url');
  const raw = await httpGetText(url);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { items: [] }; }
  const arr = parsed.items || parsed.articles || parsed.data || parsed.results || (Array.isArray(parsed) ? parsed : []);
  const items = arr.map(it => ({
    title: it.title || it.name || '',
    url: it.url || it.link || '',
    summary: it.description || it.summary || '',
    publishedAt: it.date || it.publishedAt || it.pubDate || '',
    raw: { kind: 'api' }
  })).filter(it => it.title || it.url);
  return { items };
}

// ── Dispatcher ──

async function fetchSource(source) {
  if (!source || !source.type) {
    throw new Error('source missing type');
  }
  switch (source.type) {
    case 'rss': return fetchRss(source);
    case 'changelog': return fetchChangelog(source);
    case 'aggregator': return fetchAggregator(source);
    case 'webpage': return fetchWebpage(source);
    case 'api': return fetchApi(source);
    default: throw new Error(`unknown source type: ${source.type}`);
  }
}

module.exports = { fetchSource, AGGREGATOR_SCRIPT };
