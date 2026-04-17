#!/usr/bin/env node
// data/wiki/ 文件名清理工具。把带 `'` `'` `"` `"` emoji `—` `—` 等"脏字符"的
// 文件重命名为 slug 化版本，同时更新 index.md / log.md 里的 markdown 链接。
//
// 背景：前端 inline `onclick="go('#/article/...')"` 会被文件名里的 `'` 击穿
// JS 字符串字面量（h() 只转义 `& < > "`，不转义 `'`），导致这些文章点击失效。
// 另外用户红线严禁 emoji（包括文件名）。
//
// 默认 dry-run；加 --apply 才真改。
//   node scripts/rename-dirty-wiki.js           扫描 + 预览映射
//   node scripts/rename-dirty-wiki.js --apply   执行 rename + 更新引用

'use strict';
const fs = require('fs');
const path = require('path');

const WIKI_DIR = path.join(__dirname, '..', 'data', 'wiki');
const APPLY = process.argv.includes('--apply');

// 与 server.js slugifyTitle 保持同口径，不带 .md 扩展
function slugifyBase(title) {
  if (!title) return `article-${Date.now()}`;
  let s = String(title).trim();
  s = s.replace(/[\u2018\u2019\u201C\u201D\u2014\u2013'"`]/g, ' ');
  s = s.replace(/[\u2600-\u27BF\u2B00-\u2BFF\uFE0E\uFE0F\u200D]/g, '');
  s = s.replace(/[\u{1F000}-\u{1FFFF}]/gu, '');
  s = s.replace(/[\u2190-\u21FF]/g, ' ');
  s = s.replace(/[\/\\:*?<>|#~!@$%^&()+=\[\]{};,.]/g, ' ');
  s = s.replace(/[^a-zA-Z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\s-]/g, '');
  s = s.replace(/\s+/g, '-');
  s = s.replace(/-+/g, '-');
  s = s.replace(/^-|-$/g, '');
  s = s.toLowerCase();
  if (!s) s = `article-${Date.now()}`;
  if (s.length > 80) {
    const head = s.slice(0, 80);
    const lastDash = head.lastIndexOf('-');
    if (lastDash >= 40) s = head.slice(0, lastDash);
    else s = head;
    s = s.replace(/-$/, '');
  }
  return s;
}

// 脏字符判定：只要 basename 里还有 `'`、emoji、弯引号、长破折号等就算脏
const DIRTY_RE = /[\u2018\u2019\u201C\u201D\u2014\u2013'"`\u2600-\u27BF\u2B00-\u2BFF\uFE0F]|[\u{1F000}-\u{1FFFF}]|→/u;

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

const allFiles = walk(WIKI_DIR);
const dirty = allFiles.filter(f => DIRTY_RE.test(path.basename(f)));

if (!dirty.length) {
  console.log('No dirty filenames found.');
  process.exit(0);
}

// 构造 rename 映射：old relPath (topic/file.md) → new relPath
// 冲突处理：新名已存在（或同批内多条映射到同名）时追加 -2, -3 ...
const renames = new Map(); // oldRel → newRel
const usedNewNames = new Set();

// 先把所有未受影响的现有文件名也占住，避免冲突
for (const f of allFiles) {
  const rel = path.relative(WIKI_DIR, f);
  if (!dirty.includes(f)) usedNewNames.add(rel);
}

for (const f of dirty) {
  const rel = path.relative(WIKI_DIR, f);
  const dir = path.dirname(rel);
  const base = path.basename(rel, '.md');
  let newBase = slugifyBase(base);
  let candidate = path.join(dir, newBase + '.md');
  let n = 2;
  while (usedNewNames.has(candidate)) {
    candidate = path.join(dir, `${newBase}-${n}.md`);
    n += 1;
  }
  usedNewNames.add(candidate);
  renames.set(rel, candidate);
}

console.log(`Found ${dirty.length} dirty filenames.\n`);
for (const [oldRel, newRel] of renames) {
  console.log(`  ${oldRel}`);
  console.log(`→ ${newRel}\n`);
}

if (!APPLY) {
  console.log('Mode: DRY-RUN. Re-run with --apply to perform the rename + update index.md/log.md.');
  process.exit(0);
}

// ── Apply ──
// 1) 物理 rename
for (const [oldRel, newRel] of renames) {
  const oldAbs = path.join(WIKI_DIR, oldRel);
  const newAbs = path.join(WIKI_DIR, newRel);
  fs.renameSync(oldAbs, newAbs);
  console.log(`renamed: ${oldRel} → ${newRel}`);
}

// 2) 更新 markdown 里的引用。扫描 index.md / log.md / 所有 .md 文章。
//    匹配：`](oldRel)` 或 `](../topic/oldBase.md)` 这类 markdown 链接。
//    用全字面量替换更稳（文件名里有特殊正则字符时，用 indexOf/replace split 模式）。
function replaceAll(haystack, needle, replacement) {
  if (!needle) return haystack;
  return haystack.split(needle).join(replacement);
}

const mdFiles = [path.join(WIKI_DIR, 'index.md'), path.join(WIKI_DIR, 'log.md')];
for (const f of allFiles) {
  // 物理 rename 过的用新路径读
  const rel = path.relative(WIKI_DIR, f);
  const newRel = renames.get(rel);
  const actual = newRel ? path.join(WIKI_DIR, newRel) : f;
  mdFiles.push(actual);
}
// 去重
const uniqueMd = [...new Set(mdFiles)].filter(f => fs.existsSync(f));

let rewroteCount = 0;
for (const f of uniqueMd) {
  let txt = fs.readFileSync(f, 'utf-8');
  const before = txt;
  for (const [oldRel, newRel] of renames) {
    // 完整 topic/file.md 形式
    txt = replaceAll(txt, oldRel, newRel);
    // 相对形式 ../topic/file.md（see-also 块常见）
    txt = replaceAll(txt, '../' + oldRel, '../' + newRel);
    // 同目录裸文件名 file.md（只在同一 topic 内会这样写）
    const oldBase = path.basename(oldRel);
    const newBase = path.basename(newRel);
    if (oldBase !== newBase) {
      // 只在 markdown link 括号里替换裸文件名，避免误伤正文中的普通文本
      const re = new RegExp('\\(' + oldBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\)', 'g');
      txt = txt.replace(re, '(' + newBase + ')');
    }
  }
  if (txt !== before) {
    fs.writeFileSync(f, txt, 'utf-8');
    rewroteCount += 1;
    console.log(`rewrote refs in: ${path.relative(WIKI_DIR, f)}`);
  }
}

console.log(`\nDone. Renamed ${renames.size} files, rewrote refs in ${rewroteCount} files.`);
