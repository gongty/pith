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
const dns = require('dns').promises;
const net = require('net');
const { spawn } = require('child_process');

const AGGREGATOR_SCRIPT = process.env.AGGREGATOR_SCRIPT ||
  path.resolve(__dirname, '../../plugins/news-skills/news-aggregator-skill/scripts/fetch_news.py');
const VALID_SUBSOURCES = new Set([
  'hackernews', 'github', '36kr', 'weibo', 'v2ex',
  'tencent', 'wallstreetcn', 'producthunt', 'all'
]);

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB hard cap to prevent OOM

// SSRF guard: block private / link-local / loopback ranges
function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;          // link-local / cloud metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] >= 224) return true;                            // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
    if (lower.startsWith('fe80')) return true;               // link-local
    if (lower.startsWith('::ffff:')) {                       // IPv4-mapped
      return isPrivateIp(lower.slice(7));
    }
    return false;
  }
  return true; // unparseable → treat as unsafe
}

// 所有 SSRF / URL 合法性校验抛出的 Error 都带 err.code = 'BLOCKED_URL'，
// 便于上层 HTTP 层把它映射成 400 而不是 500（给用户一个明确的"URL 不合法"提示）。
function blockedUrlError(msg) {
  const err = new Error(msg);
  err.code = 'BLOCKED_URL';
  return err;
}

function isBlockedUrlError(e) {
  return !!(e && e.code === 'BLOCKED_URL');
}

async function assertSafeUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch (e) { throw blockedUrlError('invalid url'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw blockedUrlError('blocked protocol: ' + parsed.protocol);
  }
  // URL.hostname for IPv6 returns bracketed form like "[::1]". net.isIP requires
  // bare form. Strip the brackets first, otherwise net.isIP returns 0, the code
  // falls through to dns.lookup() (which returns garbage for "[::1]"), and Node's
  // http client connects to the IPv6 anyway — full SSRF bypass.
  let host = parsed.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw blockedUrlError('blocked private ip: ' + host);
    return parsed;
  }
  // Otherwise resolve and check
  let resolved;
  try { resolved = await dns.lookup(host, { all: false }); } catch (e) {
    throw blockedUrlError('dns lookup failed for ' + host);
  }
  if (isPrivateIp(resolved.address)) {
    throw blockedUrlError('blocked private ip: ' + host + ' -> ' + resolved.address);
  }
  return parsed;
}

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

async function httpGetText(url, redirectsLeft = 5) {
  // SSRF guard: parse + protocol check + DNS resolve + private-IP block.
  // Re-runs on every redirect so attacker can't redirect through a public host into 169.254.169.254.
  const parsed = await assertSafeUrl(url);
  const mod = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.get(parsed.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 WikiBot/1.0',
        'Accept': 'text/html,application/xml,application/rss+xml,application/atom+xml,*/*'
      }
    }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirectsLeft > 0) {
        // Resolve relative redirect against current URL, then re-validate via assertSafeUrl.
        let next;
        try { next = new URL(r.headers.location, parsed).toString(); }
        catch (e) { r.resume(); return reject(blockedUrlError('invalid redirect target')); }
        r.resume(); // drain so the socket can be reused
        return httpGetText(next, redirectsLeft - 1).then(resolve, reject);
      }
      if (r.statusCode >= 400) {
        r.resume();
        return reject(new Error(`HTTP ${r.statusCode} fetching ${url}`));
      }
      // Enforce 10 MB hard cap so a hostile/oversized response can't OOM the server.
      let bytesReceived = 0;
      let aborted = false;
      const chunks = [];
      r.on('data', chunk => {
        bytesReceived += chunk.length;
        if (bytesReceived > MAX_RESPONSE_BYTES) {
          aborted = true;
          req.destroy();
          return reject(new Error('response exceeded 10MB cap from ' + url));
        }
        chunks.push(chunk);
      });
      r.on('end', () => {
        if (aborted) return;
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });
      r.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Fetch timeout')); });
  });
}

// ── RSS / Atom ──

async function fetchRss(source) {
  const url = source.url;
  if (!url) throw new Error('rss source missing url');
  // Defense in depth: httpGetText runs assertSafeUrl on every hop, but we also
  // gate here so any future direct-fetch refactor can't silently bypass SSRF checks.
  await assertSafeUrl(url);
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
  // All matchers MUST include the current year. Bare "May 3" / "5月3日" would
  // match last year's same-day entries too and flood the LLM gate with stale items.
  return [
    `${yyyy}-${mm}-${dd}`,
    `${yyyy}/${mm}/${dd}`,
    `${yyyy}.${mm}.${dd}`,
    `${monthLong} ${dayNum}, ${yyyy}`,
    `${monthLong} ${dayNum} ${yyyy}`,
    `${monthShort} ${dayNum}, ${yyyy}`,
    `${monthShort} ${dayNum} ${yyyy}`,
    `${mm}/${dd}/${yyyy}`,
    `${dd}/${mm}/${yyyy}`,
    `${yyyy}年${Number(mm)}月${dayNum}日`,
    `${yyyy}年${mm}月${dd}日`
  ];
}

async function fetchChangelog(source) {
  const url = source.url;
  if (!url) throw new Error('changelog source missing url');
  // Defense in depth：httpGetText 内部已经跑 assertSafeUrl，但这里显式兜一道，
  // 保证任何改动（比如未来换 fetch 实现）不会绕开 SSRF 检查。
  await assertSafeUrl(url);
  let html;
  try {
    html = await httpGetText(url);
  } catch (e) {
    // 透传 BLOCKED_URL，保持上层 4xx 映射能力
    if (e && e.code === 'BLOCKED_URL') throw e;
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
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(AGGREGATOR_SCRIPT)) {
      return reject(new Error(
        `aggregator 源需要系统 PATH 上有 python3，且需要 ${AGGREGATOR_SCRIPT} 文件存在；` +
        `请设置 AGGREGATOR_SCRIPT 环境变量或安装依赖`
      ));
    }
    const subsource = source.subsource || source.source || 'all';
    if (!VALID_SUBSOURCES.has(subsource)) {
      return reject(new Error(`aggregator subsource invalid: ${subsource}`));
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
      reject(new Error('aggregator timeout'));
    }, 90000);
    child.stdout.on('data', c => stdout += c);
    child.stderr.on('data', c => stderr += c);
    child.on('error', e => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (e && e.code === 'ENOENT') {
        return reject(new Error(
          `aggregator 源需要系统 PATH 上有 python3，且需要 ${AGGREGATOR_SCRIPT} 文件存在；` +
          `请设置 AGGREGATOR_SCRIPT 环境变量或安装依赖`
        ));
      }
      reject(new Error(`aggregator spawn error: ${e.message}`));
    });
    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`aggregator exit ${code}: ${stderr.slice(-300)}`));
      }
      let parsed;
      try {
        // Find first '[' or '{' to be tolerant of leading log lines
        const idx = stdout.search(/[\[{]/);
        const slice = idx >= 0 ? stdout.slice(idx) : stdout;
        parsed = JSON.parse(slice);
      } catch (e) {
        return reject(new Error(`aggregator JSON parse failed: ${e.message}`));
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
  await assertSafeUrl(url);
  const html = await httpGetText(url);

  let baseHost;
  try { baseHost = new URL(url).hostname; } catch { baseHost = ''; }

  // Navigation / boilerplate path patterns to skip. These are page-level links
  // (login, search, tag clouds, footer) — never an article.
  const navPathRe = /^\/?(login|signup|signin|register|search|about|contact|terms|privacy|tag|tags|category|categories|user|users|profile|settings|rss|atom|feed|sitemap|404|home)(\/|$|\?|#)/i;

  const items = [];
  const seenUrls = new Set();
  const seenTitles = new Set();
  const linkRegex = /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    const hrefRaw = m[1];
    const title = stripHtml(m[2]);
    if (!hrefRaw || !title || title.length <= 2) continue;

    // Resolve relative → absolute against the source URL
    let abs;
    try { abs = new URL(hrefRaw, url); } catch { continue; }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;

    // Same-host filter: a "webpage" source is a list of its own articles, not
    // a portal of arbitrary outlinks. Without this, HuggingFace Papers would
    // emit dozens of arxiv.org links with HF tagged as the sourceId.
    if (baseHost && abs.hostname !== baseHost) continue;

    // Skip the source page itself and bare hash/query-only anchors
    if (abs.pathname === '/' || abs.pathname === '') continue;
    if (navPathRe.test(abs.pathname)) continue;

    const absStr = abs.toString();
    const titleKey = title.toLowerCase();
    if (seenUrls.has(absStr) || seenTitles.has(titleKey)) continue;
    seenUrls.add(absStr);
    seenTitles.add(titleKey);

    items.push({
      title,
      url: absStr,
      summary: '',
      publishedAt: '',
      raw: { kind: 'webpage' }
    });
  }
  return { items };
}

async function fetchApi(source) {
  const url = source.url;
  if (!url) throw new Error('api source missing url');
  // Defense in depth：httpGetText 内部已经跑 assertSafeUrl，但这里显式兜一道，
  // 与其它 source 类型（rss / webpage / changelog）保持一致。
  await assertSafeUrl(url);
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

module.exports = { fetchSource, AGGREGATOR_SCRIPT, assertSafeUrl, isBlockedUrlError };
