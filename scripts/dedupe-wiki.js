#!/usr/bin/env node
// data/wiki/ 清理工具。两种模式（默认都走 dry-run，加 --apply 才真删）：
//
//   node scripts/dedupe-wiki.js            扫"同一原文多篇"的重复组（保留 mtime 最早的）
//   node scripts/dedupe-wiki.js --shells   扫"LLM 在原素材抓取失败时硬编出来"的空壳文章
//
// 加 --apply 执行删除。不处理 brief/ 子目录（简报独立存在）。

'use strict';
const fs = require('fs');
const path = require('path');

const WIKI_DIR = path.join(__dirname, '..', 'data', 'wiki');
const APPLY = process.argv.includes('--apply');
const MODE_SHELLS = process.argv.includes('--shells');

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === 'brief') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.md') && name !== 'index.md' && name !== 'log.md') out.push(full);
  }
  return out;
}

const ORIGIN_RE = /^>\s*原文[:：]\s*\[([^\]]+)\]/m;

const files = walk(WIKI_DIR);

// ── Shells 模式：找 LLM 在原素材抓取失败时硬编的空壳文章 ──
if (MODE_SHELLS) {
  // 命中任意一条即视为空壳（这些短语在正常文章里不会出现，是 LLM 在空素材下的"自供"模式，
  // 以及新增的 "正文编译失败" fallback——extract 内容过短/抓取失败时 compile 直接降级）
  const SHELL_PATTERNS = [
    /采集状态说明/,
    /内容获取状态/,
    /触发.*反爬/,
    /Cloudflare.*拦截/i,
    /仅返回验证/,
    /受限于原始素材[^\n]{0,20}(抓取失败|未能获取|未获取)/,
    /自动化采集仅获取到标题/,
    /正文编译失败[^\n]{0,20}以下为原始素材/,  // 新增：compile fallback 的固定话术
    /^\s*>\s*注意：正文编译失败/m,
  ];
  const shells = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf-8');
    const hit = SHELL_PATTERNS.find(p => p.test(text));
    if (hit) shells.push({ file: f, pattern: hit });
  }
  if (!shells.length) { console.log('No shell articles found.'); process.exit(0); }
  console.log(`Found ${shells.length} shell articles:\n`);
  for (const s of shells) {
    console.log(`  ${path.relative(WIKI_DIR, s.file)}   (hit: ${s.pattern})`);
  }
  console.log(`\nMode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  if (!APPLY) { console.log('Re-run with --apply to delete + clean index.md.'); process.exit(0); }

  // 删文件
  for (const s of shells) {
    fs.unlinkSync(s.file);
    console.log(`deleted: ${path.relative(WIKI_DIR, s.file)}`);
  }

  // 清 index.md：删掉所有指向这些 shell 的表格行
  const idxPath = path.join(WIKI_DIR, 'index.md');
  if (fs.existsSync(idxPath)) {
    const shellRels = new Set(shells.map(s => path.relative(WIKI_DIR, s.file)));
    const before = fs.readFileSync(idxPath, 'utf-8');
    const kept = before.split('\n').filter(line => {
      // 表格行形如 "| [Title](topic/file.md) | summary | 2026-04-17 |"
      // 只要 link 目标命中 shell 就整行丢掉
      const m = line.match(/\]\(([^)]+\.md)\)/);
      return !(m && shellRels.has(m[1]));
    });
    const after = kept.join('\n');
    if (after !== before) {
      fs.writeFileSync(idxPath, after, 'utf-8');
      console.log(`cleaned ${before.split('\n').length - kept.length} rows from index.md`);
    }
  }
  console.log('Done.');
  process.exit(0);
}

// ── Dedupe 模式（默认）：按"原文"聚合找重复 ──
const groups = new Map();  // raw filename → [{ file, mtime }]

for (const f of files) {
  const text = fs.readFileSync(f, 'utf-8');
  const m = text.match(ORIGIN_RE);
  if (!m) continue;
  const raw = m[1].trim();
  const mtime = fs.statSync(f).mtimeMs;
  if (!groups.has(raw)) groups.set(raw, []);
  groups.get(raw).push({ file: f, mtime });
}

const dups = [...groups.entries()].filter(([, arr]) => arr.length > 1);
if (!dups.length) { console.log('No duplicate groups found.'); process.exit(0); }

let toDelete = 0;
for (const [raw, arr] of dups) {
  arr.sort((a, b) => a.mtime - b.mtime);
  const keep = arr[0];
  const remove = arr.slice(1);
  toDelete += remove.length;
  console.log(`\n原文: ${raw}  (${arr.length} 篇)`);
  console.log(`  KEEP    ${path.relative(WIKI_DIR, keep.file)}  (mtime ${new Date(keep.mtime).toISOString()})`);
  for (const r of remove) {
    console.log(`  DELETE  ${path.relative(WIKI_DIR, r.file)}  (mtime ${new Date(r.mtime).toISOString()})`);
  }
}

console.log(`\nGroups: ${dups.length}   Files to delete: ${toDelete}   Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
if (!APPLY) { console.log('Re-run with --apply to actually delete.'); process.exit(0); }

for (const [, arr] of dups) {
  for (const r of arr.slice(1)) {
    fs.unlinkSync(r.file);
    console.log(`deleted: ${path.relative(WIKI_DIR, r.file)}`);
  }
}
console.log('Done.');
