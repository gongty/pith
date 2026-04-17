// lib/concepts.js — 概念（canonical tag）映射表
//
// 负责把同义 / 大小写 / 空格差异的 tag 收敛到同一个规范形式。Graph 的 concept 层
// 节点、以及 compile pipeline 写 frontmatter 时的 tag normalize 都用它。
//
// 约定：
//   1. 写入 data/concepts.json 走 .tmp + renameSync 原子替换。
//   2. 并发写频次极低（只在 seed / admin rebuild / addAlias 时触发），不额外加锁。
//   3. 查找键统一 lowercased；value 保留用户显示形式（可以含大小写混排 / 中英文混排）。
//   4. 严禁 emoji。
//
// 数据结构：
//   { version: 1, aliases: { "ai-safety": "AI安全", "ai safety": "AI安全", ... } }
//
// 导出：
//   loadConcepts()            -> { version, aliases }
//   saveConcepts(obj)         -> void
//   normalizeTag(tag, obj?)   -> string   // 返回 canonical（无命中返回 trim 后的原值）
//   conceptIdFromLabel(label) -> string   // "concept:" + slugify
//   addAlias(alias, canonical)-> { version, aliases }

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONCEPTS_PATH = path.join(ROOT, 'data', 'concepts.json');
const DATA_DIR = path.join(ROOT, 'data');

let __cache = null;

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

function defaultShape() {
  return { version: 1, aliases: {} };
}

function loadConcepts() {
  if (__cache) return __cache;
  ensureDataDir();
  if (!fs.existsSync(CONCEPTS_PATH)) {
    const init = defaultShape();
    try {
      const tmp = CONCEPTS_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(init, null, 2), 'utf-8');
      fs.renameSync(tmp, CONCEPTS_PATH);
    } catch (e) {
      // 初始化失败不致命，继续用内存对象
    }
    __cache = init;
    return __cache;
  }
  try {
    const raw = fs.readFileSync(CONCEPTS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      __cache = defaultShape();
    } else {
      __cache = {
        version: parsed.version || 1,
        aliases: (parsed.aliases && typeof parsed.aliases === 'object') ? parsed.aliases : {}
      };
    }
  } catch (e) {
    __cache = defaultShape();
  }
  return __cache;
}

function saveConcepts(obj) {
  ensureDataDir();
  const shape = {
    version: (obj && obj.version) || 1,
    aliases: (obj && obj.aliases && typeof obj.aliases === 'object') ? obj.aliases : {}
  };
  const tmp = CONCEPTS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(shape, null, 2), 'utf-8');
  fs.renameSync(tmp, CONCEPTS_PATH);
  __cache = shape;
  return shape;
}

// 规范化内部查找键：trim + 压缩空白 + 统一全角空格 + lowercased
function canonicalizeKey(s) {
  if (s == null) return '';
  let k = String(s).trim();
  k = k.replace(/\u3000/g, ' ');      // 全角空格 → 半角
  k = k.replace(/\s+/g, ' ');
  return k.toLowerCase();
}

function normalizeTag(tag, conceptsObj) {
  if (tag == null) return '';
  const trimmed = String(tag).trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  const obj = conceptsObj || loadConcepts();
  const aliases = (obj && obj.aliases) || {};
  const key = canonicalizeKey(trimmed);
  if (key && Object.prototype.hasOwnProperty.call(aliases, key)) {
    const v = aliases[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return trimmed;
}

function slugify(label) {
  if (!label) return '';
  let s = String(label).toLowerCase().trim();
  // 保留 a-z 0-9 和 CJK 统一汉字，其它替换成 -
  s = s.replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-');
  s = s.replace(/-+/g, '-');
  s = s.replace(/^-|-$/g, '');
  return s;
}

function conceptIdFromLabel(label) {
  const slug = slugify(label) || 'unknown';
  return 'concept:' + slug;
}

function addAlias(alias, canonical) {
  const obj = loadConcepts();
  const key = canonicalizeKey(alias);
  if (!key) return obj;
  const value = String(canonical || '').trim();
  if (!value) return obj;
  const aliases = { ...(obj.aliases || {}) };
  aliases[key] = value;
  return saveConcepts({ version: obj.version || 1, aliases });
}

// 测试 / 维护场景用：清空内存缓存强制下一次 load 读盘
function __invalidateCache() {
  __cache = null;
}

module.exports = {
  loadConcepts,
  saveConcepts,
  normalizeTag,
  conceptIdFromLabel,
  addAlias,
  __invalidateCache,
  // 内部工具也导出，seed 脚本用
  _internal: { canonicalizeKey, slugify }
};
