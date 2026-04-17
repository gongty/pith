#!/usr/bin/env node
// scripts/seed-concepts.js — 从现有 data/wiki 聚合 tag，提议 canonical alias 映射。
//
//   node scripts/seed-concepts.js           # dry-run，打印提议，不落盘
//   node scripts/seed-concepts.js --apply   # 写入 data/concepts.json
//
// 策略：
//   1. 遍历 data/wiki/**/*.md，解析 frontmatter 收集所有 tags（跳过 index.md / log.md）。
//   2. 用 canonicalizeKey（去空格差异 + lowercase + 去除非字母数字 CJK 的分隔符）分组。
//   3. 对每个 cluster 挑 canonical：频次最高，同频取最长。
//   4. cluster 内所有非 canonical 的原始 tag（以及它们的 lowercased key）都登记为 alias。
//   5. dry-run 只打印，--apply 通过 lib/concepts.js 的 saveConcepts 写盘。
//
// 重复运行安全：每次从 0 构建，不 merge 用户手动改过的映射（如果用户在 concepts.json
// 里加过自定义 alias，运行这个脚本会覆盖 aliases 字段）。想保留自定义 alias 请在 apply
// 前手动备份。

'use strict';

const fs = require('fs');
const path = require('path');
const concepts = require('../lib/concepts.js');
const { canonicalizeKey } = concepts._internal;

const ROOT = path.resolve(__dirname, '..');
const WIKI = path.join(ROOT, 'data', 'wiki');

function walkMd(d) {
  const o = [];
  if (!fs.existsSync(d)) return o;
  for (const n of fs.readdirSync(d)) {
    const f = path.join(d, n);
    let s;
    try { s = fs.statSync(f); } catch { continue; }
    if (s.isDirectory()) o.push(...walkMd(f));
    else if (n.endsWith('.md') && n !== 'index.md' && n !== 'log.md') o.push(f);
  }
  return o;
}

// 极简 frontmatter 解析（与 server.js 的 parseFrontmatter 同口径）
function parseFrontmatter(content) {
  if (!content) return { data: {}, body: '' };
  const m = content.match(/^\uFEFF?\s*---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { data: {}, body: content };
  const block = m[1];
  const data = {};
  for (const line of block.split('\n')) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1], val = kv[2].trim();
    if (/^\[.*\]$/.test(val)) {
      data[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      data[key] = val.replace(/^["']|["']$/g, '');
    }
  }
  return { data, body: content.slice(m[0].length) };
}

// 聚类的 cluster key：更激进的归一化——去掉所有非字母数字 CJK 的字符，lowercased
// 让 "AI-Safety" / "AI Safety" / "ai safety" / "AI 安全" / "AI-安全" 中三者收敛
// 注意：中文/英文不会被硬揉在一起，因为字符集不同（例如 "AI安全" 与 "ai-safety" 归不到一起）
function clusterKey(tag) {
  if (!tag) return '';
  return String(tag)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
}

const apply = process.argv.includes('--apply');

const files = walkMd(WIKI);
const freq = new Map();           // rawTag -> count
const rawByCluster = new Map();   // clusterKey -> Set(rawTag)

for (const f of files) {
  let content;
  try { content = fs.readFileSync(f, 'utf-8'); } catch { continue; }
  const { data } = parseFrontmatter(content);
  const tags = Array.isArray(data.tags) ? data.tags : [];
  for (const rawT of tags) {
    const t = String(rawT).trim();
    if (!t) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
    const ck = clusterKey(t);
    if (!ck) continue;
    if (!rawByCluster.has(ck)) rawByCluster.set(ck, new Set());
    rawByCluster.get(ck).add(t);
  }
}

const proposals = [];  // { cluster, canonical, variants: [{tag, count}] }
for (const [ck, set] of rawByCluster.entries()) {
  const variants = [...set].map(t => ({ tag: t, count: freq.get(t) || 0 }));
  variants.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (b.tag.length !== a.tag.length) return b.tag.length - a.tag.length;
    return a.tag.localeCompare(b.tag);
  });
  const canonical = variants[0].tag;
  proposals.push({ cluster: ck, canonical, variants });
}

// 只输出真正有 ≥2 种写法、或写法本身需要做 key 收敛的 cluster
const interesting = proposals.filter(p => {
  if (p.variants.length >= 2) return true;
  // 单一 variant 但它的 lowercased/去空格 key 与自身不同，值得存一个 alias（方便后来新写入收敛）
  const only = p.variants[0].tag;
  return canonicalizeKey(only) !== only;
});

console.log(`[seed-concepts] scanned ${files.length} files; found ${freq.size} distinct tags across ${rawByCluster.size} clusters.`);
console.log(`[seed-concepts] ${interesting.length} cluster(s) proposed for alias map.\n`);

const aliasesOut = {};
for (const p of interesting) {
  console.log(`cluster ${p.cluster}  ->  canonical "${p.canonical}"`);
  for (const v of p.variants) {
    console.log(`    variant "${v.tag}" x${v.count}`);
    // 注册两种 key 形式：原 canonicalizeKey（含 ASCII 空格），以及 cluster key（不含分隔）
    aliasesOut[canonicalizeKey(v.tag)] = p.canonical;
  }
  // 额外：cluster key 本身作为 alias 键，方便未来用户输入 "aisafety" 也能命中
  aliasesOut[p.cluster] = p.canonical;
}

console.log(`\n[seed-concepts] total alias entries proposed: ${Object.keys(aliasesOut).length}`);

if (!apply) {
  console.log('[seed-concepts] dry-run only. Re-run with --apply to write data/concepts.json.');
  process.exit(0);
}

const existing = concepts.loadConcepts();
const saved = concepts.saveConcepts({
  version: existing.version || 1,
  aliases: aliasesOut
});
console.log(`[seed-concepts] wrote data/concepts.json (${Object.keys(saved.aliases).length} alias entries).`);
