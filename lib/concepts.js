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
//   { version: 1, aliases: { "ai-safety": "AI安全", ... }, stopwords: ["hackernews", ...] }
//
// 导出：
//   loadConcepts()            -> { version, aliases, stopwords }
//   saveConcepts(obj)         -> void
//   normalizeTag(tag, obj?)   -> string   // 返回 canonical（无命中返回 trim 后的原值）
//   conceptIdFromLabel(label) -> string   // "concept:" + slugify
//   addAlias(alias, canonical)-> { version, aliases, stopwords }
//   isStopConcept(label, obj?)-> boolean  // 是否结构噪声 / 过度泛化 / 源元数据，不应做 concept 节点
//   DEFAULT_STOPWORDS         -> string[]

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

// 结构噪声 / 源元数据 / 过度泛化 tag：不应升级为 concept 节点。
// 匹配用 lowercased 后 exact。用户可在 data/concepts.json 的 stopwords 字段追加自定义项。
const DEFAULT_STOPWORDS = [
  // Article structure noise (from extractKeywords fallback on legacy articles)
  '什么是', '的四原则', '核心摘要', '先澄清', '正文章节', '画布承载量',
  '按来源分组', '三层记忆', '核心定位', '核心范式转变', '正文编译失败',
  // Too-generic
  '研究', '工具', '方法', '概念', '定义', '域', '问题定义', '信息整合',
  '开发', '开发工具', '测试', '验证', '不确定性', '轻量化', 'example', 'examples',
  'before', 'think', 'coding',
  // Source metadata (these are where content came from, not what it's about)
  'hackernews', 'arxiv-cs-ai', 'deepmind-blog', 'tldr-tech',
  'openai研究', 'openai-research', 'deepmind', 'tunee',
  // Test/placeholder
  'test', 'hello', 'frontier', 'brief',
  // Ultra-short / meaningless
  'ehr', 'cvpr',
];

function defaultShape() {
  return { version: 1, aliases: {}, stopwords: [] };
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
        aliases: (parsed.aliases && typeof parsed.aliases === 'object') ? parsed.aliases : {},
        stopwords: Array.isArray(parsed.stopwords) ? parsed.stopwords.filter(x => typeof x === 'string') : []
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
    aliases: (obj && obj.aliases && typeof obj.aliases === 'object') ? obj.aliases : {},
    stopwords: (obj && Array.isArray(obj.stopwords)) ? obj.stopwords.filter(x => typeof x === 'string') : []
  };
  const tmp = CONCEPTS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(shape, null, 2), 'utf-8');
  fs.renameSync(tmp, CONCEPTS_PATH);
  __cache = shape;
  return shape;
}

function isStopConcept(label, conceptsObj) {
  if (label == null) return true;
  const norm = String(label).trim().toLowerCase();
  if (!norm) return true;
  const extra = (conceptsObj && Array.isArray(conceptsObj.stopwords))
    ? conceptsObj.stopwords
    : [];
  const stop = new Set([
    ...DEFAULT_STOPWORDS.map(s => String(s).toLowerCase()),
    ...extra.map(s => String(s).toLowerCase()),
  ]);
  return stop.has(norm);
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
  return saveConcepts({ version: obj.version || 1, aliases, stopwords: obj.stopwords || [] });
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
  isStopConcept,
  DEFAULT_STOPWORDS,
  __invalidateCache,
  // 内部工具也导出，seed 脚本用
  _internal: { canonicalizeKey, slugify }
};
