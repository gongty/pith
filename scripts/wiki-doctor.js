#!/usr/bin/env node
// data/wiki 健康体检。只读不改，一次扫出所有一致性问题。输出按严重度分档，
// 有对应修复命令的给出提示。
//
//   node scripts/wiki-doctor.js
//
// 检查项：
//   [critical] 零字节文件、index.md↔disk 不同步、文件名含脏字符
//   [warning]  文章内死链（wiki 内 / raw / hash 路由）、shell 文章（编译失败僵尸）
//   [info]     缺 frontmatter 的 legacy 文章、index.md/log.md 残留 emoji

'use strict';
const fs = require('fs');
const path = require('path');

const WIKI = path.join(__dirname, '..', 'data', 'wiki');
const RAW = path.join(__dirname, '..', 'data', 'raw');

function walk(d) {
  const o = [];
  if (!fs.existsSync(d)) return o;
  for (const n of fs.readdirSync(d)) {
    if (n === 'brief') continue;
    const f = path.join(d, n);
    const s = fs.statSync(f);
    if (s.isDirectory()) o.push(...walk(f));
    else if (n.endsWith('.md') && n !== 'index.md' && n !== 'log.md') o.push(f);
  }
  return o;
}

const wikiFiles = walk(WIKI);
const rawFiles = walk(RAW);
const wikiRel = new Set(wikiFiles.map(f => path.relative(WIKI, f)));
const rawRel = new Set(rawFiles.map(f => path.relative(RAW, f)));

const reports = { critical: [], warning: [], info: [] };
function push(level, title, items, fix) { reports[level].push({ title, items, fix }); }

// ── [critical] 零字节 ──
const zeroBytes = wikiFiles.filter(f => fs.statSync(f).size === 0).map(f => path.relative(WIKI, f));
if (zeroBytes.length) push('critical', '零字节僵尸文件', zeroBytes, `rm ${zeroBytes.map(x => `data/wiki/${x}`).join(' ')}`);

// ── [critical] disk↔index 同步 ──
let idx = '';
try { idx = fs.readFileSync(path.join(WIKI, 'index.md'), 'utf-8'); } catch { idx = ''; }
const idxRefs = new Set();
for (const m of idx.matchAll(/\]\(([^)]+\.md)\)/g)) idxRefs.add(m[1]);
const onDiskNotIdx = [...wikiRel].filter(x => !idxRefs.has(x)).sort();
const inIdxNotDisk = [...idxRefs].filter(x => !wikiRel.has(x)).sort();
if (onDiskNotIdx.length) push('critical', 'disk 上有但 index.md 缺失', onDiskNotIdx, '手动补 index 行 或 重跑 compile');
if (inIdxNotDisk.length) push('critical', 'index.md 指向已消失的文件 (dangling)', inIdxNotDisk, 'node scripts/dedupe-wiki.js --shells --apply  或手动清 index');

// ── [critical] 脏文件名 ──
const DIRTY_RE = /[\u2018\u2019\u201C\u201D\u2014\u2013'"`\u2600-\u27BF\u2B00-\u2BFF\uFE0F]|[\u{1F000}-\u{1FFFF}]|→/u;
const dirtyNames = wikiFiles.filter(f => DIRTY_RE.test(path.basename(f))).map(f => path.relative(WIKI, f));
if (dirtyNames.length) push('critical', '文件名含脏字符（会击穿 inline onclick）', dirtyNames, 'node scripts/rename-dirty-wiki.js --apply');

// ── [warning] shell 文章 ──
const SHELL_PATTERNS = [
  /采集状态说明/, /内容获取状态/, /触发.*反爬/, /Cloudflare.*拦截/i, /仅返回验证/,
  /受限于原始素材[^\n]{0,20}(抓取失败|未能获取|未获取)/, /自动化采集仅获取到标题/,
  /正文编译失败[^\n]{0,20}以下为原始素材/, /^\s*>\s*注意：正文编译失败/m,
];
const shells = [];
for (const f of wikiFiles) {
  const t = fs.readFileSync(f, 'utf-8');
  if (SHELL_PATTERNS.some(p => p.test(t))) shells.push(path.relative(WIKI, f));
}
if (shells.length) push('warning', 'shell 文章（编译失败的占位）', shells, 'node scripts/dedupe-wiki.js --shells --apply');

// ── [warning] 死链 ──
const LINK_RE = /\]\(([^)]+\.md)(?:#[^)]*)?\)/g;
const deadLinks = [];
for (const f of wikiFiles) {
  const rel = path.relative(WIKI, f);
  const dir = path.dirname(rel);
  const t = fs.readFileSync(f, 'utf-8');
  LINK_RE.lastIndex = 0;
  let m;
  while ((m = LINK_RE.exec(t))) {
    const link = m[1];
    if (/^https?:/.test(link)) continue;
    let ok;
    if (link.startsWith('#/article/')) ok = wikiRel.has(link.replace(/^#\/article\//, ''));
    else if (link.includes('../../raw/')) ok = rawRel.has(link.split('../../raw/')[1]);
    else {
      let res;
      if (link.startsWith('../')) res = path.posix.normalize(path.posix.join(dir, link));
      else if (link.includes('/')) res = link;
      else res = path.posix.join(dir, link);
      ok = wikiRel.has(res);
    }
    if (!ok) deadLinks.push(`${rel}  ->  ${link}`);
  }
}
if (deadLinks.length) push('warning', '文章内死链', deadLinks, 'node scripts/clean-seealso.js --apply');

// ── [info] 缺 frontmatter ──
const noFm = [];
for (const f of wikiFiles) {
  const t = fs.readFileSync(f, 'utf-8');
  if (!/^---\n[\s\S]*?\n---\n/.test(t)) noFm.push(path.relative(WIKI, f));
}
if (noFm.length) push('info', 'legacy 文章缺 frontmatter（走 extractKeywords fallback）', noFm, 'curl -X POST "http://localhost:3456/api/wiki/backfill-tags?useModel=main"');

// ── [info] index/log 残留 emoji ──
const EMOJI = /[\u2600-\u27BF\u2B00-\u2BFF\uFE0F]|[\u{1F000}-\u{1FFFF}]|→/u;
const dirtyDisplay = [];
try {
  if (EMOJI.test(fs.readFileSync(path.join(WIKI, 'index.md'), 'utf-8'))) dirtyDisplay.push('data/wiki/index.md');
} catch {}
try {
  if (EMOJI.test(fs.readFileSync(path.join(WIKI, 'log.md'), 'utf-8'))) dirtyDisplay.push('data/wiki/log.md');
} catch {}
if (dirtyDisplay.length) push('info', 'index.md/log.md 残留 emoji/箭头', dirtyDisplay, '手动 sanitize 或重跑 compile（新写入走 sanitizeDisplayText）');

// ── 渲染 ──
const LEVEL_LABEL = { critical: '[CRIT]', warning: '[WARN]', info: '[INFO]' };
function render(level) {
  const list = reports[level];
  if (!list.length) return;
  for (const r of list) {
    console.log(`\n${LEVEL_LABEL[level]} ${r.title}  (${r.items.length})`);
    const show = r.items.slice(0, 30);
    show.forEach(x => console.log('  ' + x));
    if (r.items.length > show.length) console.log(`  ... and ${r.items.length - show.length} more`);
    if (r.fix) console.log(`  fix: ${r.fix}`);
  }
}
render('critical'); render('warning'); render('info');

const total = reports.critical.length + reports.warning.length + reports.info.length;
console.log(`\n── summary ──`);
console.log(`articles: ${wikiFiles.length}   index entries: ${idxRefs.size}`);
console.log(`critical: ${reports.critical.length}   warning: ${reports.warning.length}   info: ${reports.info.length}`);
if (total === 0) console.log('wiki 健康，无需维护。');
process.exit(reports.critical.length ? 1 : 0);
