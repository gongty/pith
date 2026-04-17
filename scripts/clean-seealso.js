#!/usr/bin/env node
// data/wiki/ 死链清理。扫所有文章里的 markdown 链接 `[x](foo.md)`，
// 分四类处理：
//   1) 指向 ../../raw/* 的 — 检 data/raw 是否存在，不存在整行删
//   2) 指向 wiki 内部 — 检文件存在，不存在整行删
//   3) 指向 #/article/* 的 hash 路由 — 检 wiki 存在，不存在整行删
//   4) http(s): — 跳过
//
// 整行删的判定：这些 see-also 链接绝大多数在 markdown 列表项里（`- [x](y.md)`
// 或 `* [x](y.md)`）。若所在行是列表项 → 删行；否则只把链接替换成纯文本
// `[x]`（保留人话不产生破链）。
//
// frontmatter 受保护：我们只改 body。
//
// 默认 dry-run；加 --apply 才真改。
//   node scripts/clean-seealso.js
//   node scripts/clean-seealso.js --apply

'use strict';
const fs = require('fs');
const path = require('path');

const WIKI = path.join(__dirname, '..', 'data', 'wiki');
const RAW = path.join(__dirname, '..', 'data', 'raw');
const APPLY = process.argv.includes('--apply');

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

// 把 link 解析成目标 key，判定存在性；null 表示存在/不用管
function classify(link, articleDir) {
  if (/^https?:/.test(link)) return { ok: true };
  if (link.startsWith('#/article/')) {
    const target = link.replace(/^#\/article\//, '');
    return { ok: wikiRel.has(target), target, kind: 'hash' };
  }
  if (link.includes('../../raw/')) {
    const target = link.split('../../raw/')[1];
    return { ok: rawRel.has(target), target, kind: 'raw' };
  }
  let resolved;
  if (link.startsWith('../')) resolved = path.posix.normalize(path.posix.join(articleDir, link));
  else if (link.includes('/')) resolved = link;
  else resolved = path.posix.join(articleDir, link);
  return { ok: wikiRel.has(resolved), target: resolved, kind: 'wiki' };
}

// 分 frontmatter
function splitFM(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { fm: '', body: text };
  return { fm: '---\n' + m[1] + '\n---\n', body: m[2] };
}

const LINK_RE = /\[([^\]]*)\]\(([^)]+\.md)(?:#[^)]*)?\)/g;
const LIST_ITEM_RE = /^\s*(?:[-*+]\s|\d+\.\s)/;

let totalLinesDeleted = 0;
let totalLinksRewritten = 0;
const perFile = [];

for (const f of wikiFiles) {
  const rel = path.relative(WIKI, f);
  const articleDir = path.dirname(rel);
  const raw = fs.readFileSync(f, 'utf-8');
  const { fm, body } = splitFM(raw);

  // 行级扫描
  const lines = body.split('\n');
  const actions = []; // {lineIdx, kind: 'delete'|'rewrite', newLine?}
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 收集本行所有 .md 链接及其 ok 状态
    const badLinks = [];
    let m;
    LINK_RE.lastIndex = 0;
    while ((m = LINK_RE.exec(line))) {
      const text = m[1], link = m[2];
      const c = classify(link, articleDir);
      if (!c.ok) badLinks.push({ full: m[0], text, link, target: c.target });
    }
    if (!badLinks.length) continue;
    // 列表项 → 整行删
    if (LIST_ITEM_RE.test(line)) {
      actions.push({ lineIdx: i, kind: 'delete' });
    } else {
      // 否则把每个死链 `[text](link)` 降级为纯文本 `text`
      let newLine = line;
      for (const b of badLinks) {
        newLine = newLine.split(b.full).join(b.text);
      }
      actions.push({ lineIdx: i, kind: 'rewrite', newLine });
    }
  }
  if (!actions.length) continue;

  // 应用动作
  const deleted = new Set(actions.filter(a => a.kind === 'delete').map(a => a.lineIdx));
  const rewritten = new Map();
  for (const a of actions) if (a.kind === 'rewrite') rewritten.set(a.lineIdx, a.newLine);

  let newLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (deleted.has(i)) continue;
    newLines.push(rewritten.has(i) ? rewritten.get(i) : lines[i]);
  }
  // 删完列表项后，可能留下空的 `## See Also` / `## 相关阅读` 标题，把这类孤儿标题也删掉
  // 规则：一个 heading 直到下一个同级或更浅的 heading / EOF 之间没有任何非空非空白行 → 删 heading
  const SEE_ALSO_RE = /^(#{1,6})\s+(see\s*also|相关阅读|延伸阅读|参考资料)\s*$/i;
  const pruned = [];
  for (let i = 0; i < newLines.length; i++) {
    const line = newLines[i];
    const m = line.match(SEE_ALSO_RE);
    if (m) {
      const level = m[1].length;
      // 找到 section 结束
      let hasContent = false;
      let j = i + 1;
      for (; j < newLines.length; j++) {
        const next = newLines[j];
        const nm = next.match(/^(#{1,6})\s+/);
        if (nm && nm[1].length <= level) break;
        if (next.trim() !== '') { hasContent = true; break; }
      }
      if (!hasContent) {
        // 跳过 heading 本身 + 它下面到 section 边界的空白
        i = j - 1;
        continue;
      }
    }
    pruned.push(line);
  }
  // 收缩连续空行
  const shrunk = [];
  for (const l of pruned) {
    if (l.trim() === '' && shrunk.length && shrunk[shrunk.length - 1].trim() === '') continue;
    shrunk.push(l);
  }
  const newBody = shrunk.join('\n');
  const deletedCount = deleted.size;
  const rewrittenCount = rewritten.size;
  totalLinesDeleted += deletedCount;
  totalLinksRewritten += rewrittenCount;
  perFile.push({ rel, deletedCount, rewrittenCount, fm, newBody });
}

console.log(`files affected: ${perFile.length}   lines deleted: ${totalLinesDeleted}   inline rewrites: ${totalLinksRewritten}\n`);
for (const p of perFile) {
  console.log(`  ${p.rel}   (del ${p.deletedCount}, rewrite ${p.rewrittenCount})`);
}
console.log(`\nMode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
if (!APPLY) { console.log('Re-run with --apply to persist.'); process.exit(0); }

for (const p of perFile) {
  const abs = path.join(WIKI, p.rel);
  fs.writeFileSync(abs, p.fm + p.newBody, 'utf-8');
}
console.log('Done.');
