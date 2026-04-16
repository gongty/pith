const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const os = require('os');
const crypto = require('crypto');

// ── 多格式导入依赖 ──
// pdf-parse v2 导出 { PDFParse } 类；v1 导出一个函数。这里兼容两者。
let PdfParseFn = null;   // v1 函数
let PdfParseCls = null;  // v2 类
let pdfParse = null;     // 仅做"是否可用"的标志位
try {
  const mod = require('pdf-parse');
  if (typeof mod === 'function') { PdfParseFn = mod; pdfParse = mod; }
  else if (mod && mod.PDFParse) { PdfParseCls = mod.PDFParse; pdfParse = mod; }
} catch {}
let Readability, JSDOM;
try { ({ Readability } = require('@mozilla/readability')); } catch {}
try { ({ JSDOM } = require('jsdom')); } catch {}

// 统一的 PDF 文本提取：兼容 v1 / v2
async function parsePdfBuffer(buf) {
  if (PdfParseCls) {
    const parser = new PdfParseCls({ data: buf });
    try {
      const [textRes, infoRes] = await Promise.all([parser.getText(), parser.getInfo().catch(() => null)]);
      return { text: textRes.text || '', info: (infoRes && infoRes.info) || {} };
    } finally {
      try { await parser.destroy(); } catch {}
    }
  }
  if (PdfParseFn) {
    const data = await PdfParseFn(buf);
    return { text: data.text || '', info: data.info || {} };
  }
  throw new Error('pdf-parse 未安装，请运行 npm install pdf-parse');
}

const ROOT = __dirname;  // wiki-app/ is the project root
const WIKI = path.join(ROOT, 'data', 'wiki');
const RAW = path.join(ROOT, 'data', 'raw');
const APP = path.join(ROOT, 'app');
const PORT = parseInt(process.env.PORT, 10) || 3456;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PROFILE_PATH = path.join(ROOT, 'profile.json');
const MEMORY_PATH = path.join(ROOT, 'data', 'memory.json');

// Ensure data directories exist
fs.mkdirSync(WIKI, { recursive: true });
fs.mkdirSync(RAW, { recursive: true });
const UPLOADS = path.join(ROOT, 'data', 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });
const CHATS = path.join(ROOT, 'data', 'chats');
fs.mkdirSync(CHATS, { recursive: true });
const AUTOTASKS_DIR = path.join(ROOT, 'data', 'autotasks');
fs.mkdirSync(AUTOTASKS_DIR, { recursive: true });
const QUEUE_DIR = path.join(ROOT, 'data', 'queue');
fs.mkdirSync(QUEUE_DIR, { recursive: true });
const QUEUE_FILE = path.join(QUEUE_DIR, 'tasks.json');

// ── 崩溃诊断 & 访问日志 ──
// 目的：进程挂掉时能还原现场（最近请求 + 堆栈 + 触发来源 + 信号）
const LOGS_DIR = path.join(ROOT, 'data', 'logs');
fs.mkdirSync(LOGS_DIR, { recursive: true });
const CRASH_LOG = path.join(LOGS_DIR, 'crash.log');
const ACCESS_LOG = path.join(LOGS_DIR, 'access.log');
const __recentRequests = []; // ring buffer，崩溃时全量 dump
function recordRequest(r) {
  __recentRequests.push(r);
  if (__recentRequests.length > 30) __recentRequests.shift();
}
function __diagAppend(file, msg) { try { fs.appendFileSync(file, msg + '\n'); } catch {} }
function crashLog(label, err) {
  const ts = new Date().toISOString();
  const stack = err && err.stack ? err.stack : (err && err.message ? err.message : String(err));
  const reqDump = __recentRequests.length
    ? __recentRequests.map(r => `  - ${r.startedAt} ${r.method} ${r.url} status=${r.status || '?'} dur=${r.duration != null ? r.duration + 'ms' : 'in-flight'}`).join('\n')
    : '  (none)';
  const body = `[${ts}] ${label}\nrecent requests:\n${reqDump}\nstack:\n${stack}\n---\n`;
  __diagAppend(CRASH_LOG, body);
  try { process.stderr.write(body); } catch {}
}
process.on('uncaughtException', err => { crashLog('UNCAUGHT_EXCEPTION', err); });
process.on('unhandledRejection', err => { crashLog('UNHANDLED_REJECTION', err); });
['SIGTERM','SIGINT','SIGHUP','SIGQUIT'].forEach(sig => {
  process.on(sig, () => {
    __diagAppend(CRASH_LOG, `[${new Date().toISOString()}] SIGNAL ${sig} received, exiting\n---\n`);
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
});
process.on('exit', code => { __diagAppend(CRASH_LOG, `[${new Date().toISOString()}] process exit code=${code}\n---\n`); });
__diagAppend(CRASH_LOG, `[${new Date().toISOString()}] STARTUP pid=${process.pid} node=${process.version}\n---\n`);

// ── 内置编译规则（原 SKILL.md） ──

const COMPILE_RULES = `
## 编译规则

将原始素材编译成结构化知识库文章。遵循以下规则：

### 合并 vs 新建

- **同一核心论点 → 合并**：新内容与已有文章论点一致时，合并到该文章，将新来源加入 Sources/Raw，更新相关章节。
- **新概念 → 新建**：在最相关的主题目录下创建新文章。文件名基于概念命名，不是原始文件名。
- **跨多主题 → 放最相关目录**：在 See Also 中添加跨主题交叉引用。
- 单个来源可能同时触发合并和新建。若新来源与已有内容矛盾，标注分歧并注明来源归属。

### 级联更新

编译主文章后，检查连锁影响：
1. 扫描同主题目录中受新来源影响的文章
2. 扫描 index.md 中其他主题的相关概念
3. 更新所有受实质影响的文章，刷新 Updated 日期

### 文章格式

\`\`\`
# 标题

> 来源：作者/机构，日期
> 原文：[文件名](../../raw/topic/file.md)

## 概述
一段话概括核心内容

## 正文章节
...

## See Also
- [相关文章](../topic/article.md)
\`\`\`

### 索引格式 (index.md)

按主题分组的 Markdown 表格：
\`\`\`
### topic-name

| 文章 | 摘要 | 更新 |
|------|------|------|
| [标题](topic/article.md) | 一句话摘要 | YYYY-MM-DD |
\`\`\`

### 日志格式 (log.md)

\`\`\`
## [YYYY-MM-DD] ingest | <文章标题>
- Updated: <级联更新的文章标题>
\`\`\`

### 约定

- **Wiki 输出语言为中文**
- wiki/ 下只有一层主题子目录，不更深嵌套
- 文件内链接使用相对路径
- topic 目录名使用英文 kebab-case
- 优先复用已有主题分类，只在真正不同的主题时新建目录
`;

// ── 缓存 ──

class SimpleCache {
  constructor(maxSize = 50, ttlMs = 60000) { this.map = new Map(); this.maxSize = maxSize; this.ttlMs = ttlMs; }
  get(key) { const e = this.map.get(key); if (!e) return null; if (Date.now() - e.ts > this.ttlMs) { this.map.delete(key); return null; } return e.value; }
  set(key, value) { if (this.map.size >= this.maxSize) { const first = this.map.keys().next().value; this.map.delete(first); } this.map.set(key, { value, ts: Date.now() }); }
  invalidate(key) { if (key) this.map.delete(key); else this.map.clear(); }
}

const wikiCache = new SimpleCache(50, 120000);  // article content cache
const indexCache = new SimpleCache(1, 60000);    // wiki index cache

// ── 模型配置 ──

// ── 内置 Provider 定义（模型对象格式） ──
// 每个 model 对象: { id, label, use?, thinkingCapable?, defaultThinking?, streamOnly? }
const BUILTIN_PROVIDERS = {
  bailian: {
    name: '百炼 (阿里云)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    format: 'openai',
    defaultModel: 'qwen3.6-plus',
    // 精简为 5 个主力模型（strong ×2 + main ×2 + fast ×1）
    // 视觉 qwen-vl-max-latest 在 compileArticle 里硬编码兜底，无需列在这里
    models: [
      { id: 'qwen3-max',        label: 'Qwen3 Max',        use: 'strong', thinkingCapable: true, defaultThinking: false },
      { id: 'glm-5.1',          label: 'GLM-5.1',          use: 'strong', thinkingCapable: true, defaultThinking: true  },
      { id: 'qwen3.6-plus',     label: 'Qwen 3.6 Plus',    use: 'main',   thinkingCapable: true, defaultThinking: false },
      { id: 'kimi-k2.5',        label: 'Kimi K2.5',        use: 'main',   thinkingCapable: true, defaultThinking: false },
      { id: 'qwen-plus-latest', label: 'Qwen Plus (快/省)', use: 'fast',   thinkingCapable: true, defaultThinking: false }
    ]
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    format: 'openai',
    defaultModel: 'anthropic/claude-sonnet-4',
    models: [
      { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4', use: 'main' },
      { id: 'openai/gpt-4o', label: 'GPT-4o', use: 'main' },
      { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', use: 'main' },
      { id: 'meta-llama/llama-3.1-70b-instruct', label: 'Llama 3.1 70B', use: 'fast' }
    ]
  },
  anthropic: {
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    format: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    models: [
      { id: 'claude-opus-4-6',              label: 'Claude Opus 4.6',   use: 'strong' },
      { id: 'claude-sonnet-4-6',            label: 'Claude Sonnet 4.6', use: 'main'   },
      { id: 'claude-haiku-4-5-20251001',    label: 'Claude Haiku 4.5',  use: 'fast'   }
    ]
  },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    format: 'openai',
    defaultModel: 'gpt-4o',
    models: [
      { id: 'gpt-4o',      label: 'GPT-4o',       use: 'main' },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini',  use: 'fast' },
      { id: 'o3-mini',     label: 'o3-mini',      use: 'reasoning' }
    ]
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    format: 'openai',
    defaultModel: 'deepseek-chat',
    models: [
      { id: 'deepseek-chat',     label: 'DeepSeek Chat',     use: 'main' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', use: 'reasoning' }
    ]
  },
  custom: {
    name: '自定义 (OpenAI 兼容)',
    baseUrl: '',
    format: 'openai',
    defaultModel: '',
    models: []
  },
  local: {
    name: '本地 Claude CLI',
    baseUrl: '',
    format: 'cli',
    defaultModel: 'claude',
    models: [
      { id: 'claude', label: 'Local Claude CLI', use: 'main' }
    ]
  }
};

// 向后兼容的只读视图：PROVIDERS[k].models 是 id 字符串数组
const PROVIDERS = Object.fromEntries(
  Object.entries(BUILTIN_PROVIDERS).map(([k, p]) => [k, {
    ...p,
    models: (p.models || []).map(m => m.id)
  }])
);

// 返回 provider 的合并后模型列表（用户覆盖 > builtin）
function getProviderModels(providerKey, cfg) {
  const config = cfg || loadConfig();
  const builtin = (BUILTIN_PROVIDERS[providerKey] && BUILTIN_PROVIDERS[providerKey].models) || [];
  const userOverride = config && config.providers && config.providers[providerKey] && config.providers[providerKey].models;
  const builtinIds = new Set(builtin.map(m => m.id));
  if (Array.isArray(userOverride) && userOverride.length >= 0 && (config.providers && config.providers[providerKey])) {
    // user override replaces builtin list
    return userOverride.map(m => ({ ...m, isBuiltin: builtinIds.has(m.id) }));
  }
  return builtin.map(m => ({ ...m, isBuiltin: true }));
}

// 查找单个模型的 meta（不存在则返回 null）
function findModelMeta(providerKey, modelId, cfg) {
  const list = getProviderModels(providerKey, cfg);
  return list.find(m => m.id === modelId) || null;
}

// 根据 use 类型选第一个模型 id，fallback 到 defaultModel
function pickModelByUse(providerKey, useKey, cfg) {
  const list = getProviderModels(providerKey, cfg);
  const pref = list.find(m => m.use === useKey);
  if (pref) return pref.id;
  // fallbacks
  const fallbackOrder = useKey === 'strong'
    ? ['strong', 'main', 'fast']
    : useKey === 'fast'
      ? ['fast', 'main', 'strong']
      : ['main', 'strong', 'fast'];
  for (const u of fallbackOrder) {
    const m = list.find(x => x.use === u);
    if (m) return m.id;
  }
  return (BUILTIN_PROVIDERS[providerKey] && BUILTIN_PROVIDERS[providerKey].defaultModel) || (list[0] && list[0].id) || '';
}

// Pipeline 预设（在运行时用 pickModelByUse 解析到具体 id）
const PIPELINE_PRESETS = {
  fast: {
    content: { use: 'fast',   thinking: false, stream: true, retryUse: 'main',  maxTokens: 16384 },
    summary: { source: 'inline' },
    seealso: { source: 'code', topK: 3 }
  },
  balanced: {
    content: { use: 'main',   thinking: false, stream: true, retryUse: 'fast',  maxTokens: 16384 },
    summary: { source: 'llm', use: 'fast', maxLength: 30 },
    seealso: { source: 'code_plus_llm', use: 'fast', topK: 5 }
  },
  quality: {
    content: { use: 'strong', thinking: false, stream: true, retryUse: 'main',  maxTokens: 16384 },
    summary: { source: 'llm', use: 'main', maxLength: 30 },
    seealso: { source: 'code_plus_llm', use: 'main', topK: 5 }
  }
};

// 把 preset 解析为具体 stages（填入真实 model id）
function resolvePresetForProvider(presetKey, providerKey, cfg) {
  const preset = PIPELINE_PRESETS[presetKey] || PIPELINE_PRESETS.balanced;
  const contentModel = pickModelByUse(providerKey, preset.content.use, cfg);
  const retryModel   = pickModelByUse(providerKey, preset.content.retryUse, cfg);
  const stages = {
    title:    { source: 'code' },
    topic:    { source: 'user' },
    filename: { source: 'code' },
    content:  {
      model: contentModel,
      thinking: preset.content.thinking,
      stream: preset.content.stream,
      retryModel,
      maxTokens: preset.content.maxTokens
    }
  };
  if (preset.summary.source === 'inline') {
    stages.summary = { source: 'inline' };
  } else {
    stages.summary = {
      source: 'llm',
      model: pickModelByUse(providerKey, preset.summary.use, cfg),
      maxLength: preset.summary.maxLength
    };
  }
  if (preset.seealso.source === 'code') {
    stages.seealso = { source: 'code', topK: preset.seealso.topK };
  } else if (preset.seealso.source === 'skip') {
    stages.seealso = { source: 'skip' };
  } else {
    stages.seealso = {
      source: 'code_plus_llm',
      model: pickModelByUse(providerKey, preset.seealso.use, cfg),
      topK: preset.seealso.topK
    };
  }
  return stages;
}

function loadConfig() {
  let cfg = {
    provider: 'local',
    model: '',
    customBaseUrl: '',
    wikiLang: 'zh',
    providers: {},
    pipeline: null
  };
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      cfg.provider = saved.provider || 'local';
      cfg.model = saved.model || '';
      cfg.customBaseUrl = saved.customBaseUrl || '';
      cfg.wikiLang = saved.wikiLang || 'zh';
      cfg.providers = saved.providers && typeof saved.providers === 'object' ? saved.providers : {};
      cfg.pipeline = saved.pipeline && typeof saved.pipeline === 'object' ? saved.pipeline : null;
    }
  } catch {}
  // migration: initialize pipeline to balanced preset if missing
  if (!cfg.pipeline || !cfg.pipeline.stages) {
    cfg.pipeline = {
      preset: 'balanced',
      stages: resolvePresetForProvider('balanced', cfg.provider, cfg)
    };
  }
  return cfg;
}

function saveConfig(cfg) {
  // 只存 provider/model/customBaseUrl/wikiLang/providers/pipeline，不存 apiKey
  const toSave = {
    provider: cfg.provider,
    model: cfg.model,
    customBaseUrl: cfg.customBaseUrl || '',
    wikiLang: cfg.wikiLang || 'zh'
  };
  if (cfg.providers && typeof cfg.providers === 'object') toSave.providers = cfg.providers;
  if (cfg.pipeline && typeof cfg.pipeline === 'object') toSave.pipeline = cfg.pipeline;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2), 'utf-8');
}

// apiKey 单独存储到 .api-key 文件（不进 git）
const API_KEY_PATH = path.join(ROOT, '.api-key');
function saveApiKey(key) {
  fs.writeFileSync(API_KEY_PATH, key, 'utf-8');
  fs.chmodSync(API_KEY_PATH, 0o600); // 仅 owner 可读写
}
function loadApiKey() {
  if (process.env.WIKI_API_KEY) return process.env.WIKI_API_KEY;
  try { return fs.readFileSync(API_KEY_PATH, 'utf-8').trim(); } catch { return ''; }
}

function getFullConfig() {
  const cfg = loadConfig();
  cfg.apiKey = loadApiKey();
  return cfg;
}

function loadProfile() {
  try {
    if (fs.existsSync(PROFILE_PATH)) {
      return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8'));
    }
  } catch {}
  return null;
}

function saveProfile(profile) {
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2), 'utf-8');
}

// ── Memory 系统 ──

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_PATH)) {
      const data = JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf-8'));
      // 兼容旧格式：items 数组 → 纯文本
      if (data.items && !data.text) {
        const lines = data.items.filter(m => m.active !== false).map(m => m.label + '：' + m.content);
        data.text = lines.join('\n');
        delete data.items;
        saveMemory(data);
      }
      return data;
    }
  } catch {}
  return { text: '' };
}

function saveMemory(memory) {
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(memory, null, 2), 'utf-8');
}

function buildMemoryContext() {
  const memory = loadMemory();
  const text = (memory.text || '').trim();
  if (!text) return null;
  return '## 用户背景\n' + text;
}

// Migration: create memory.json from profile.bio if it doesn't exist
function migrateMemory() {
  if (fs.existsSync(MEMORY_PATH)) return;
  const profile = loadProfile();
  if (profile && profile.bio) {
    saveMemory({ text: '职业角色：' + profile.bio });
  } else {
    saveMemory({ text: '' });
  }
}

// ── LLM 调用层 ──

function humanizeHttpError(status, body) {
  const detail = body.slice(0, 200);
  if (status === 401 || status === 403) return 'API Key 无效或已过期，请在设置中重新配置';
  if (status === 429) return '请求过于频繁，已被限流，请稍后再试';
  if (status === 402) return '账户额度已用完，请充值或更换服务商';
  if (status === 404) return '模型不存在或 API 地址错误，请检查设置';
  if (status === 500 || status === 502 || status === 503) return '服务商暂时不可用 (' + status + ')，请稍后再试';
  if (status === 413) return '请求内容过大，请减少输入内容';
  return 'HTTP ' + status + ': ' + detail;
}

function httpPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = mod.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Invalid JSON: ${data.slice(0, 300)}`)); }
        } else {
          const friendly = humanizeHttpError(res.statusCode, data);
          reject(new Error(friendly));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(300000, () => { req.destroy(); reject(new Error('请求超时 (300s)')); });
    req.write(body);
    req.end();
  });
}

// 流式 OpenAI-compatible chat completions。累积 delta.content，忽略 reasoning_content。
// 返回完整拼接后的字符串。onChunk 回调每收到一段 content 时触发。
function streamChatCompletion(url, headers, bodyObj, onChunk) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'text/event-stream'
      }
    };
    const req = mod.request(options, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let errData = '';
        res.on('data', c => errData += c);
        res.on('end', () => reject(new Error(humanizeHttpError(res.statusCode, errData))));
        return;
      }
      let buf = '';
      let full = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => {
        buf += chunk;
        // SSE events separated by \n\n
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const event = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          // Each event has lines; collect "data: ..." lines
          const lines = event.split('\n').filter(l => l.startsWith('data:'));
          for (const line of lines) {
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const obj = JSON.parse(payload);
              const choice = obj.choices && obj.choices[0];
              if (!choice) continue;
              const delta = choice.delta || {};
              // Ignore reasoning_content (thinking tokens); only accumulate content
              if (typeof delta.content === 'string' && delta.content.length > 0) {
                full += delta.content;
                try { if (onChunk) onChunk(delta.content); } catch {}
              }
            } catch {}
          }
        }
      });
      res.on('end', () => resolve(full));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(600000, () => { req.destroy(); reject(new Error('流式请求超时 (600s)')); });
    req.write(body);
    req.end();
  });
}

async function callLLM(systemPrompt, messages, overrides, opts = {}) {
  // If messages is a string, convert to single-message array for backward compat
  const msgArray = typeof messages === 'string'
    ? [{ role: 'user', content: messages }]
    : messages;

  const temperature = (opts && typeof opts.temperature === 'number') ? opts.temperature : 0.3;
  const maxTokens = (opts && typeof opts.maxTokens === 'number') ? opts.maxTokens : 8192;

  const config = getFullConfig();
  const providerKey = (overrides && overrides.provider) || config.provider || 'local';
  const providerBuiltin = BUILTIN_PROVIDERS[providerKey] || BUILTIN_PROVIDERS.local;
  const model = (overrides && overrides.model) || config.model || providerBuiltin.defaultModel;
  const apiKey = config.apiKey;

  if (providerBuiltin.format === 'cli') {
    const combined = msgArray.map(m => `${m.role}: ${m.content}`).join('\n\n');
    return callLocalCLI(systemPrompt + '\n\n' + combined);
  }

  if (!apiKey) throw new Error('未配置 API Key，请在设置中配置');

  const baseUrl = (providerKey === 'custom' && config.customBaseUrl) ? config.customBaseUrl : providerBuiltin.baseUrl;
  const modelMeta = findModelMeta(providerKey, model, config) || {};

  if (providerBuiltin.format === 'anthropic') {
    // Anthropic path unchanged (thinking/streaming not implemented here)
    const result = await httpPost(`${baseUrl}/v1/messages`, {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }, JSON.stringify({ model, max_tokens: maxTokens, system: systemPrompt, messages: msgArray }));
    return result.content[0].text;
  }

  // OpenAI-compatible (百炼, OpenRouter, OpenAI, DeepSeek, custom)
  const headers = { 'Authorization': `Bearer ${apiKey}` };
  if (providerKey === 'openrouter') {
    headers['HTTP-Referer'] = `http://localhost:${PORT}`;
    headers['X-Title'] = 'Wiki Knowledge Base';
  }

  // Resolve thinking + stream
  const canThink = providerKey === 'bailian' && !!modelMeta.thinkingCapable;
  let wantThinking;
  if (opts && typeof opts.thinking === 'boolean') wantThinking = opts.thinking;
  else if (typeof modelMeta.defaultThinking === 'boolean') wantThinking = modelMeta.defaultThinking;
  else wantThinking = false;
  if (!canThink) wantThinking = false;

  const wantStream = !!(opts && opts.stream) || wantThinking || !!modelMeta.streamOnly;

  const body = {
    model,
    messages: [{ role: 'system', content: systemPrompt }, ...msgArray],
    temperature,
    max_tokens: maxTokens
  };

  // 百炼 enable_thinking 必须放在 body 顶层
  if (canThink) body.enable_thinking = wantThinking;

  if (wantStream) {
    body.stream = true;
    return await streamChatCompletion(`${baseUrl}/chat/completions`, headers, body, opts && opts.onChunk);
  }

  const result = await httpPost(`${baseUrl}/chat/completions`, headers, JSON.stringify(body));
  return result.choices[0].message.content;
}

function callLocalCLI(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', prompt, '--allowedTools', 'Read,Write,Edit,Glob,Grep'], { cwd: ROOT });
    let output = '';
    child.stdout.on('data', d => output += d);
    child.stderr.on('data', d => output += d);
    child.on('close', code => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`CLI exited ${code}: ${output.slice(-300)}`));
    });
  });
}

// ── 编译引擎 ──

async function compileArticle(topicDir, filename, filePath, task, overrides) {
  const config = getFullConfig();
  const providerKey = (overrides && overrides.provider) || config.provider || 'local';
  const provider = PROVIDERS[providerKey] || PROVIDERS.local;

  const beforeFiles = new Set(walkMd(WIKI).map(f => path.relative(WIKI, f)));

  // 本地 CLI 模式
  if (provider.format === 'cli') {
    return new Promise((resolve) => {
      const memCtxCli = buildMemoryContext();
      const bioPart = memCtxCli ? ` ${memCtxCli}。请根据用户背景调整文章深度和侧重点。` : (() => { const profile = loadProfile(); return profile && profile.bio ? ` 用户背景：${profile.bio}。请根据用户背景调整文章深度和侧重点。` : ''; })();
      const prompt = `你是知识库编译助手。${COMPILE_RULES}\n\n请对刚存入的原始素材 data/raw/${topicDir}/${filename} 执行编译：\n1. 读取素材内容\n2. 读取 data/wiki/index.md 了解已有文章\n3. 编译成文章写入 data/wiki/ 对应主题目录\n4. 更新 data/wiki/index.md 和 data/wiki/log.md\nWiki 语言使用中文。${bioPart}`;
      const child = spawn('claude', ['-p', prompt, '--allowedTools', 'Read,Write,Edit,Glob,Grep'], { cwd: ROOT });
      let output = '';
      child.stdout.on('data', d => output += d);
      child.stderr.on('data', d => output += d);
      child.on('close', code => {
        if (code === 0) {
          const afterFiles = walkMd(WIKI).map(f => path.relative(WIKI, f));
          const created = afterFiles.filter(f => !beforeFiles.has(f) && f !== 'index.md' && f !== 'log.md')
            .map(f => ({ path: f, title: extractTitle(path.join(WIKI, f)) }));
          task.status = 'done'; task.message = '编译完成'; task.created = created;
          indexCache.invalidate('index');
          wikiCache.invalidate();
        } else {
          task.status = 'error'; task.message = `编译失败: ${output.slice(-200)}`;
        }
        resolve();
      });
    });
  }

  // API 模式：管线编译
  return await runCompilePipeline(topicDir, filename, filePath, task, overrides);
}

// ── 编译管线（API 模式） ──

// 简单中英文 slug 化：去符号、空格→'-'、转小写（保留中文字符）
function slugifyTitle(title) {
  if (!title) return `article-${Date.now()}`;
  let s = String(title).trim();
  // 去掉常见符号
  s = s.replace(/[\/\\:*?"<>|#`~!@$%^&()+=\[\]{};,.]/g, ' ');
  s = s.replace(/\s+/g, '-');
  s = s.replace(/-+/g, '-');
  s = s.replace(/^-|-$/g, '');
  s = s.toLowerCase();
  if (!s) s = `article-${Date.now()}`;
  // 限长：优先在最近的词边界（'-'）切断，避免把词切到一半
  if (s.length > 80) {
    const head = s.slice(0, 80);
    const lastDash = head.lastIndexOf('-');
    // 只有切点不算太靠前（至少保留一半长度）时，才在词边界切
    if (lastDash >= 40) s = head.slice(0, lastDash);
    else s = head;
    s = s.replace(/-$/, '');
  }
  return s + '.md';
}

// 宽松地去掉外层 ```...``` fence；只在首尾都有 fence 时才剥
function stripOuterCodeFences(text) {
  if (!text) return text;
  const t = text.trim();
  if (!t.startsWith('```')) return text;
  const m = t.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```$/);
  return m ? m[1] : text;
}

// 从原始内容里去掉 "# Source" 头块（如有），返回内容体
function stripSourceHeader(raw) {
  if (!raw) return raw;
  // 如果前几行是 "# Source" 或 "Source:" 块，切到第一个空行后
  const lines = raw.split('\n');
  if (/^#\s*Source/i.test(lines[0] || '') || /^Source\s*[:：]/i.test(lines[0] || '')) {
    const idx = lines.findIndex((l, i) => i > 0 && l.trim() === '');
    if (idx > 0) return lines.slice(idx + 1).join('\n');
  }
  return raw;
}

// stage 辅助：开始/结束
function startStage(task, key, label, extra) {
  const s = { key, label, status: 'running', startedAt: Date.now(), ...(extra || {}) };
  task.stages = task.stages || [];
  task.stages.push(s);
  return s;
}
function doneStage(s, extra) {
  s.status = 'done';
  s.durationMs = Date.now() - s.startedAt;
  if (extra) Object.assign(s, extra);
}
function errorStage(s, err) {
  s.status = 'error';
  s.durationMs = Date.now() - s.startedAt;
  s.error = (err && err.message) ? err.message : String(err);
}
function skipStage(s, detail) {
  s.status = 'skipped';
  s.durationMs = Date.now() - s.startedAt;
  if (detail) s.detail = detail;
}

// 简单关键词匹配评分（和 searchWiki 类似的 ngram-ish）
function scoreArticleRelevance(queryText, articleTitle) {
  if (!queryText || !articleTitle) return 0;
  const q = queryText.toLowerCase();
  const t = articleTitle.toLowerCase();
  let score = 0;
  // title 出现完整包含
  if (q.includes(t) || t.includes(q)) score += 3;
  // 逐个 2-gram（中文）+ 空格 tokens
  const tokens = new Set();
  for (const tok of q.split(/[\s,，。、.;:；：!?？！"'()（）]+/)) {
    if (tok.length >= 2) tokens.add(tok);
  }
  for (let i = 0; i + 2 <= q.length; i++) {
    const g = q.slice(i, i + 2);
    if (/[\u4e00-\u9fa5]{2}/.test(g)) tokens.add(g);
  }
  for (const tok of tokens) {
    if (t.includes(tok)) score += 1;
  }
  return score;
}

async function runCompilePipeline(topicDir, filename, filePath, task, overrides) {
  const config = getFullConfig();
  const providerKey = (overrides && overrides.provider) || config.provider || 'local';

  // 解析当前管线：overrides.pipeline > config.pipeline > balanced 预设
  const pipelineCfg = (overrides && overrides.pipeline) || config.pipeline || {
    preset: 'balanced',
    stages: resolvePresetForProvider('balanced', providerKey, config)
  };
  const stagesCfg = pipelineCfg.stages || resolvePresetForProvider(pipelineCfg.preset || 'balanced', providerKey, config);

  task.stages = [];

  let rawContent = '';
  try { rawContent = fs.readFileSync(filePath, 'utf-8'); }
  catch (e) { task.status = 'error'; task.message = `读取原始内容失败: ${e.message}`; return; }

  const rawBody = stripSourceHeader(rawContent);

  // 收集已有主题/文章
  const existingTopics = [];
  const existingArticles = []; // {path, title}
  if (fs.existsSync(WIKI)) {
    for (const d of fs.readdirSync(WIKI, { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.startsWith('.')) {
        existingTopics.push(d.name);
        const topicPath = path.join(WIKI, d.name);
        for (const f of fs.readdirSync(topicPath)) {
          if (f.endsWith('.md')) {
            const title = extractTitle(path.join(topicPath, f));
            existingArticles.push({ path: `${d.name}/${f}`, title });
          }
        }
      }
    }
  }

  const wikiLang = config.wikiLang || 'zh';
  const LANG_MAP = { zh: '中文', en: 'English', ja: '日本語', ko: '한국어', auto: null };
  const langName = LANG_MAP[wikiLang] || wikiLang;
  const langInstruction = wikiLang === 'auto' ? '跟随原文语言（原文是什么语言就用什么语言输出）' : langName;

  // ─ 原文 H1（仅作为失败兜底；不作为最终标题，真正的标题由 content 阶段生成） ─
  const rawH1Match = rawBody.match(/^#\s+(.+)$/m);
  const rawH1 = rawH1Match ? rawH1Match[1].trim() : '';
  const fallbackTitle = rawH1 || path.basename(filename, path.extname(filename)) || 'untitled';

  // ─ Stage 1: title（占位，真正提取在 content 之后） ─
  {
    const s = startStage(task, 'title', '提取标题', { source: 'piggyback_on_content' });
    doneStage(s, { detail: '由 content 阶段 LLM 生成，content 完成后提取' });
  }

  // ─ Stage 2: topic（不依赖 articleTitle，只用 rawBody） ─
  let articleTopic = topicDir || 'general';
  {
    const cfgT = stagesCfg.topic || { source: 'user' };
    const s = startStage(task, 'topic', '确定主题', { source: cfgT.source });
    try {
      if (cfgT.source === 'llm' || (articleTopic === 'general' && cfgT.source !== 'user')) {
        const topicModel = cfgT.model || pickModelByUse(providerKey, 'fast', config);
        const resp = await callLLM(
          '你是一个主题分类助手。从候选主题中选择最合适的一个（返回 kebab-case 英文目录名，不加引号和解释）。若都不合适，返回一个新的 kebab-case 英文名。',
          `## 已有主题\n${existingTopics.join(', ') || '（暂无）'}\n\n## 内容摘要\n${rawBody.slice(0, 2000)}`,
          { ...(overrides || {}), model: topicModel },
          { maxTokens: 60, temperature: 0.2 }
        );
        const cand = (resp || '').trim().split(/\s+/)[0].replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
        if (cand) articleTopic = cand;
      }
      doneStage(s, { detail: articleTopic });
    } catch (e) {
      errorStage(s, e);
    }
  }

  // ─ Stage 3 + 4 并行：content + summary ─
  const cfgC = stagesCfg.content || { model: pickModelByUse(providerKey, 'main', config), thinking: false, stream: true, maxTokens: 16384 };
  const cfgS = stagesCfg.summary || { source: 'llm', model: pickModelByUse(providerKey, 'fast', config), maxLength: 30 };

  const memCtxApi = buildMemoryContext();
  const bioContext = memCtxApi ? `\n\n${memCtxApi}\n请根据用户背景调整文章深度和侧重点。` : '';

  // 收集已有 tags，引导 LLM 复用语义相近的词（让图谱能连起来）
  const existingTagsList = collectExistingTags(200);
  const existingTagsStr = existingTagsList.length
    ? existingTagsList.map(t => t.tag).join('、')
    : '（暂无，这是前几篇文章）';

  const contentSystemPrompt = `你是知识库编译助手。将原始素材编译为结构清晰、信息保真的纯 Markdown 知识库文章。

## 文章模板
# <你为这篇文章撰写的精炼标题>
> 来源：作者/机构，日期
> 原文：[${filename}](../../raw/${topicDir}/${filename})

## 概述
一段话概括核心论点和价值（3-5 句）。

## 正文
按逻辑分章节（## 二级标题）。章节内可用 ### 三级标题。

## 编译原则（重要）
1. 信息保真：原文的数据、数字、对比、决策理由必须保留，不可概括为"等"
2. 保留结构：原文中的表格、列表、对比矩阵照搬为 Markdown 表格，不要摊平成散文
3. 保留图片：原文中的 ![图片](images/xxx) 原样保留在对应位置，路径不要改
4. 保留引用：原文中有价值的原话用 > 引用块保留
5. 决策要有 Why：如果原文提到"做了 X"，必须保留"为什么做 X"的理由
6. 不要发明内容：只编译原文中有的信息，不添加原文没有的分析

## 标题要求（非常重要）
- 第一行必须是 "# <标题>" 格式的知识库文章标题
- 标题由你根据全文内容原创撰写，不是照抄原文 H1 或网页标题
- 标题语言：${langInstruction}
- 长度 ≤ 30 个字符，概括文章核心价值/主题
- 禁止包含：站点品牌名（如 "知乎 - "、"- CSDN博客"、"| Medium"）、URL 残片、作者前缀、"译"/"转载"等元信息
- 禁止以引号、书名号、括号包裹整个标题
- 好的标题：简洁、信息量大、读者一眼能看出在讲什么

## 标签要求（非常重要，用于图谱连接）
在文章最末尾追加一行 HTML 注释，格式严格如下：
\`<!-- tags: 标签1, 标签2, 标签3, 标签4, 标签5 -->\`

规则：
- 3-5 个标签，每个标签 ≤ 10 个字符
- 标签应精准、有区分度：能代表这篇文章最核心的概念/实体/方法（例如：分布式系统、Raft、Rust、共识协议、键值存储）
- 避免过于宽泛的词（如 "技术"、"科技"、"方法"、"分析"、"指南"）——这些词对建立有效关联没帮助
- 避免碎片（如 "据收集"、"能基准"）——必须是完整的、人能看懂的概念
- 不要用 emoji、引号、书名号包裹
- 标签语言：${langInstruction}

**已有标签词表**（按使用频次，从高到低）：
${existingTagsStr}

规则：如果已有标签里有语义相近的，必须优先用已有的；只有确实没合适的才新增标签。目的是让同一个概念在不同文章里用同一个词，图谱才能连成一片。

示例：
- 已有"大模型"，就不要新增"LLM"或"大语言模型"
- 已有"Rust"，就不要新增"rust 语言"或"Rustlang"

## 输出要求（重要）
- 输出**纯 Markdown 文章**，不要用 JSON 包裹、不要用代码块 fence 包裹整篇文章
- **不要写 See Also 章节**（系统会自动追加）
- 文章最后一行必须是 \`<!-- tags: ... -->\` 注释
- 输出语言：${langInstruction}
- 已有主题：${existingTopics.join(', ') || '（暂无）'}${bioContext}`;

  const contentP = (async () => {
    const s = startStage(task, 'content', '编译正文', { model: cfgC.model });
    let chosenModel = cfgC.model;
    try {
      const modelOverride = { ...(overrides || {}), model: cfgC.model };
      const maxTok = cfgC.maxTokens || 16384;
      const resp = await callLLM(contentSystemPrompt, rawBody, modelOverride, {
        stream: !!cfgC.stream,
        thinking: !!cfgC.thinking,
        maxTokens: maxTok
      });
      doneStage(s, { detail: `${(resp || '').length} chars` });
      return resp;
    } catch (e) {
      // 重试：retryModel
      if (cfgC.retryModel && cfgC.retryModel !== cfgC.model) {
        try {
          chosenModel = cfgC.retryModel;
          s.detail = `retry with ${cfgC.retryModel}`;
          const modelOverride2 = { ...(overrides || {}), model: cfgC.retryModel };
          const maxTok = cfgC.maxTokens || 16384;
          const resp2 = await callLLM(contentSystemPrompt, rawBody, modelOverride2, {
            stream: !!cfgC.stream,
            thinking: false,
            maxTokens: maxTok
          });
          doneStage(s, { detail: `retry ok (${cfgC.retryModel}), ${(resp2 || '').length} chars`, model: cfgC.retryModel });
          return resp2;
        } catch (e2) {
          errorStage(s, e2);
          return null;
        }
      } else {
        errorStage(s, e);
        return null;
      }
    }
  })();

  const summaryP = (async () => {
    const s = startStage(task, 'summary', '生成摘要', { source: cfgS.source });
    try {
      if (cfgS.source === 'inline' || cfgS.source === 'skip') {
        skipStage(s, 'inline/skip — 稍后从正文提取');
        return null;
      }
      const sumModel = cfgS.model || pickModelByUse(providerKey, 'fast', config);
      s.model = sumModel;
      const maxLen = cfgS.maxLength || 30;
      const resp = await callLLM(
        `你是摘要助手。用 1 句话（≤${maxLen} 字）概括以下内容的核心价值。只输出摘要本身，不要加前缀、引号或解释。`,
        rawBody.slice(0, 8000),
        { ...(overrides || {}), model: sumModel },
        { maxTokens: 120, temperature: 0.2 }
      );
      const summary = (resp || '').trim().replace(/^["'"'《]/, '').replace(/["'"'》]$/, '').split('\n')[0];
      doneStage(s, { detail: summary });
      return summary;
    } catch (e) {
      errorStage(s, e);
      return null;
    }
  })();

  const [contentResp, summaryResp] = await Promise.all([contentP, summaryP]);

  let articleContent = contentResp;
  let articleTitle = '';
  let contentErrored = !articleContent;

  // 如果 content 彻底失败，用 rawBody 作为 fallback（截断 + 去二进制）
  if (!articleContent) {
    const MAX_FALLBACK = 10000;
    // 去掉控制字符（PDF/二进制残留），保留常见空白
    let safeRaw = String(rawBody || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    // 如果出现 PDF magic 或大段非文本，视为不可用
    const looksBinary = /%PDF-|stream\s*\n.{500,}endstream/.test(safeRaw) || (safeRaw.length > 0 && (safeRaw.match(/[\u4e00-\u9fff\w\s]/g) || []).length / safeRaw.length < 0.5);
    if (looksBinary) {
      safeRaw = '[原始素材为二进制/无法识别的内容，已省略。请检查素材来源或改用其他格式重试]';
    } else if (safeRaw.length > MAX_FALLBACK) {
      safeRaw = safeRaw.slice(0, MAX_FALLBACK) + `\n\n[已截断：原始素材共 ${safeRaw.length} 字，仅保留前 ${MAX_FALLBACK} 字]`;
    }
    articleTitle = fallbackTitle;
    articleContent = `# ${articleTitle}\n\n> 注意：正文编译失败，以下为原始素材（已清理截断）。\n\n${safeRaw}`;
  } else {
    articleContent = stripOuterCodeFences(articleContent);
    // 从 content 第一行 "#..#### ..." 提取 LLM 生成的标题（优先 H1，兜底 H2-H6）
    const titleMatch = articleContent.match(/^\s*#{1,6}\s+(.+?)\s*$/m);
    if (titleMatch) {
      articleTitle = titleMatch[1]
        .trim()
        // 去掉常见站点品牌残留
        .replace(/^[《「『"'"']|[》」』"'"']$/g, '')
        .replace(/\s*[\-—|–]\s*(知乎|CSDN[^|]*|简书|掘金|博客园|Medium|Substack|微信公众号).*$/i, '')
        .replace(/\s*\|\s*.*$/, '')
        .trim();
      if (articleTitle.length > 80) articleTitle = articleTitle.slice(0, 80);
    }
    if (!articleTitle) articleTitle = fallbackTitle;
    // 规范化正文第一个标题行为 "# <articleTitle>"（无论原来是 H1-H6）
    if (titleMatch) {
      articleContent = articleContent.replace(/^\s*#{1,6}\s+.+\s*$/m, `# ${articleTitle}`);
    } else {
      // 没有任何标题行：在开头注入 H1
      articleContent = `# ${articleTitle}\n\n${articleContent.replace(/^\s+/, '')}`;
    }
  }

  // ─ Stage 5: tags（搭 content 阶段便车，从输出末尾的 <!-- tags: ... --> 注释里提取） ─
  let articleTags = [];
  {
    const s = startStage(task, 'tags', '提取标签', { source: 'piggyback_on_content' });
    try {
      const tagsMatch = articleContent.match(/<!--\s*tags\s*:\s*([^>]+?)\s*-->/i);
      if (tagsMatch) {
        articleTags = tagsMatch[1]
          .split(/[,，、]/)
          .map(t => t.trim().replace(/^["'《「『]+|["'》」』]+$/g, ''))
          .filter(t => t && t.length <= 10)
          .slice(0, 5);
        // 从正文移除 tags 注释（避免显示在正文里）
        articleContent = articleContent.replace(/<!--\s*tags\s*:\s*[^>]+?\s*-->\s*/gi, '').trimEnd() + '\n';
      }
      // 去重
      articleTags = [...new Set(articleTags)];
      if (articleTags.length > 0) {
        doneStage(s, { detail: articleTags.join('、') });
      } else {
        doneStage(s, { detail: '未生成（LLM 未输出 tags 注释）' });
      }
    } catch (e) {
      errorStage(s, e);
    }
  }

  // ─ Stage 5: filename（移到 content 之后，使用 LLM 生成的标题） ─
  let articleFilename;
  {
    const s = startStage(task, 'filename', '生成文件名', { source: 'code' });
    try {
      articleFilename = slugifyTitle(articleTitle);
      doneStage(s, { detail: articleFilename });
    } catch (e) {
      errorStage(s, e);
      articleFilename = `article-${Date.now()}.md`;
    }
  }

  // ─ 回填 title 阶段 detail（让前端 UI 能显示最终标题） ─
  {
    const titleStage = (task.stages || []).find(st => st.key === 'title');
    if (titleStage) titleStage.detail = articleTitle;
  }

  // summary fallback: 从正文第一段抽取
  let articleSummary = summaryResp;
  if (!articleSummary) {
    // 取正文第一段（H1 之后第一个非空段落）
    const m = articleContent.match(/^#\s+.+\n+([\s\S]+?)(?:\n\n|$)/m);
    if (m) {
      articleSummary = m[1].trim().replace(/\n/g, ' ').slice(0, 30);
    } else {
      articleSummary = articleTitle.slice(0, 30);
    }
  }

  // ─ Stage 6: seealso ─
  {
    const cfgSA = stagesCfg.seealso || { source: 'code_plus_llm', topK: 5 };
    const s = startStage(task, 'seealso', '推荐相关文章', { source: cfgSA.source });
    try {
      if (cfgSA.source === 'skip') {
        skipStage(s);
      } else {
        const topK = cfgSA.topK || 5;
        // 评分
        const queryText = `${articleTitle} ${articleSummary}`;
        const scored = existingArticles
          .map(a => ({ ...a, score: scoreArticleRelevance(queryText, a.title) }))
          .filter(a => a.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);

        let picked = [];
        if (cfgSA.source === 'code') {
          picked = scored.slice(0, 3);
        } else if (scored.length > 0) {
          // code_plus_llm
          const saModel = cfgSA.model || pickModelByUse(providerKey, 'fast', config);
          s.model = saModel;
          const candidatesStr = scored.map((a, i) => `${i + 1}. ${a.title} (${a.path})`).join('\n');
          try {
            const resp = await callLLM(
              '你是一个相关文章推荐助手。从候选列表中选出与目标文章真正相关的 0-3 篇（宁缺勿滥）。只输出选中的序号，用英文逗号分隔，例如 "1,3"。如果都不相关，输出 "none"。',
              `## 目标文章\n标题：${articleTitle}\n摘要：${articleSummary}\n\n## 候选\n${candidatesStr}`,
              { ...(overrides || {}), model: saModel },
              { maxTokens: 60, temperature: 0.2 }
            );
            const idxs = (resp || '').trim().toLowerCase();
            if (idxs !== 'none' && idxs !== '') {
              const nums = idxs.split(/[,，\s]+/).map(x => parseInt(x, 10)).filter(n => !isNaN(n) && n >= 1 && n <= scored.length);
              picked = nums.slice(0, 3).map(n => scored[n - 1]);
            }
          } catch {
            // LLM 失败时退回到 code 结果
            picked = scored.slice(0, 3);
          }
        }
        if (picked.length > 0) {
          // 追加 See Also 块（同 topic 用 filename.md，跨 topic 用 ../topic/filename.md）
          const lines = picked.map(a => {
            const [aTopic, aFile] = a.path.split('/');
            const rel = aTopic === articleTopic ? aFile : `../${aTopic}/${aFile}`;
            return `- [${a.title}](${rel})`;
          });
          // 避免重复的 See Also
          if (!/^##\s+See Also\s*$/m.test(articleContent)) {
            articleContent = articleContent.trimEnd() + `\n\n## See Also\n${lines.join('\n')}\n`;
          }
          doneStage(s, { detail: `${picked.length} 篇` });
        } else {
          doneStage(s, { detail: '无相关文章' });
        }
      }
    } catch (e) {
      errorStage(s, e);
    }
  }

  // ─ Stage 7: persist ─
  let relPath = '';
  const persistStage = startStage(task, 'persist', '写入文件', { source: 'code' });
  try {
    // 修正 images 路径
    articleContent = articleContent.replace(/!\[([^\]]*)\]\(images\/([^)]+)\)/g,
      `![$1](../../raw/${topicDir}/images/$2)`);

    const articleDir = path.join(WIKI, articleTopic);
    fs.mkdirSync(articleDir, { recursive: true });
    const articlePath = path.join(articleDir, articleFilename);
    // 把 tags 写成 YAML frontmatter 放文章最前面
    const frontmatter = serializeFrontmatter({ tags: articleTags });
    const fileContent = frontmatter ? `${frontmatter}${articleContent}` : articleContent;
    fs.writeFileSync(articlePath, fileContent, 'utf-8');
    relPath = `${articleTopic}/${articleFilename}`;
    const today = new Date().toISOString().slice(0, 10);

    await (writeLock = writeLock.catch(() => {}).then(() => {
      const indexPath = path.join(WIKI, 'index.md');
      let idx = ''; try { idx = fs.readFileSync(indexPath, 'utf-8'); } catch { idx = '# Knowledge Base Index\n'; }
      const newEntry = `| [${articleTitle}](${articleTopic}/${articleFilename}) | ${articleSummary || ''} | ${today} |`;
      const topicHeader = `### ${articleTopic}`;
      if (idx.includes(topicHeader)) {
        const lines = idx.split('\n');
        let inserted = false;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim() === topicHeader) {
            for (let j = i + 1; j < lines.length; j++) {
              if (lines[j].startsWith('|') && lines[j].includes('---')) {
                lines.splice(j + 1, 0, newEntry);
                inserted = true; break;
              }
            }
            if (!inserted) { lines.splice(i + 1, 0, '', '| 文章 | 摘要 | 更新 |', '|------|------|------|', newEntry); inserted = true; }
            break;
          }
        }
        idx = inserted ? lines.join('\n') : idx + '\n' + newEntry;
      } else {
        idx += `\n\n${topicHeader}\n\n| 文章 | 摘要 | 更新 |\n|------|------|------|\n${newEntry}\n`;
      }
      fs.writeFileSync(indexPath, idx, 'utf-8');

      const logPath = path.join(WIKI, 'log.md');
      let log = ''; try { log = fs.readFileSync(logPath, 'utf-8'); } catch { log = '# Wiki Log\n'; }
      log += `\n## [${today}] ingest | ${articleTitle}\n`;
      fs.writeFileSync(logPath, log, 'utf-8');

      indexCache.invalidate('index');
      wikiCache.invalidate();
    }));
    doneStage(persistStage, { detail: relPath });
  } catch (e) {
    errorStage(persistStage, e);
    task.status = 'error';
    task.message = `编译失败: ${e.message}`;
    return;
  }

  task.created = [{ path: relPath, title: articleTitle, tags: articleTags }];
  if (contentErrored) {
    task.status = 'partial';
    task.message = '编译完成（正文降级为原文）';
  } else {
    task.status = 'done';
    task.message = '编译完成';
  }
}

async function queryWiki(question) {
  const config = getFullConfig();
  const providerKey = config.provider || 'local';
  const provider = PROVIDERS[providerKey] || PROVIDERS.local;

  const memCtx = buildMemoryContext();
  const bioPart = memCtx ? ` ${memCtx}` : (() => { const profile = loadProfile(); return profile && profile.bio ? ` 用户背景：${profile.bio}。请根据用户背景调整回答的深度和专业程度。` : ''; })();

  // 本地 CLI 模式
  if (provider.format === 'cli') {
    return callLocalCLI(`读取 data/wiki/index.md，然后阅读相关文章来回答以下问题: ${question}。引用来源时使用 [文章标题](路径) 格式。用中文回答。${bioPart}`);
  }

  // API 模式：服务端收集上下文
  let indexContent = ''; try { indexContent = fs.readFileSync(path.join(WIKI, 'index.md'), 'utf-8'); } catch {}

  // Use shared retrieval
  const { articleContents } = retrieveContext(question);

  const bioQueryContext = memCtx ? `\n6. ${memCtx}` : (() => { const profile = loadProfile(); return profile && profile.bio ? `\n6. 用户背景：${profile.bio}。请根据用户背景调整回答的深度和专业程度` : ''; })();

  const systemPrompt = `你是一个知识库查询助手。基于提供的知识库文章回答用户问题。

规则：
1. 优先使用知识库内容，不要编造知识库中没有的信息
2. 引用来源时使用 [文章标题](路径) 格式
3. 如果知识库中没有相关内容，坦诚告知
4. 用中文回答
5. 回答要有条理，适当分段${bioQueryContext}`;

  const userMessage = `## 知识库索引\n\n${indexContent}\n\n## 相关文章内容\n\n${articleContents.join('\n\n---\n\n')}\n\n## 用户问题\n\n${question}`;

  return await callLLM(systemPrompt, userMessage);
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// ── 工具函数 ──

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function safe(base, rel) {
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) return null;
  const full = path.join(base, rel);
  if (!full.startsWith(base)) return null;
  return full;
}

function tree(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => !d.name.startsWith('.'))
    .map(d => {
      if (d.isDirectory()) {
        const topicDir = path.join(dir, d.name);
        const children = fs.readdirSync(topicDir, { withFileTypes: true })
          .filter(f => f.isFile() && f.name.endsWith('.md'))
          .map(f => {
            const fp = path.join(topicDir, f.name);
            return { name: f.name.replace('.md', ''), file: f.name, path: d.name + '/' + f.name, title: extractTitle(fp), mtime: fs.statSync(fp).mtimeMs };
          })
          .sort((a, b) => b.mtime - a.mtime);
        return { name: d.name, children };
      }
      return null;
    }).filter(Boolean);
}

function searchWiki(query) {
  const results = [];
  const q = query.toLowerCase();
  function walk(dir) {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { walk(full); continue; }
      if (!d.name.endsWith('.md')) continue;
      const content = fs.readFileSync(full, 'utf-8');
      const lines = content.split('\n');
      const title = (lines[0] || '').replace(/^#+\s*/, '') || d.name;
      const matches = [];
      lines.forEach((line, i) => {
        if (line.toLowerCase().includes(q)) {
          matches.push({ line: i + 1, text: line.trim(), context: lines.slice(Math.max(0, i - 1), i + 2).map(l => l.trim()) });
        }
      });
      if (matches.length > 0) {
        results.push({ title, path: path.relative(WIKI, full), matches });
      }
    }
  }
  walk(WIKI);
  return results;
}

// ── Wiki 辅助函数 ──

function walkMd(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) { files.push(...walkMd(full)); continue; }
    if (d.name.endsWith('.md')) files.push(full);
  }
  return files;
}

// 解析文章开头的 YAML frontmatter（极简：只支持 tags: [a, b, c] 形式）
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

// 序列化极简 frontmatter：只输出 tags 数组
function serializeFrontmatter(data) {
  if (!data || !data.tags || !data.tags.length) return '';
  const arr = data.tags.map(t => String(t).replace(/[,\n]/g, ' ').trim()).filter(Boolean);
  if (!arr.length) return '';
  return `---\ntags: [${arr.join(', ')}]\n---\n`;
}

function extractTitle(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const { body } = parseFrontmatter(content);
    const m = body.match(/^#+\s+(.+)/m);
    return m ? m[1].trim() : path.basename(filePath, '.md');
  } catch { return path.basename(filePath, '.md'); }
}

// 读文章的 tags：优先 frontmatter，没有就回退到 extractKeywords 筛选（兼容老文章）
const TAG_FALLBACK_STOP = new Set([
  '概述', '总结', '背景', '简介', '引言', '正文', '结论', '附录', '参考', '说明',
  '定义', '目标', '方法', '结果', '讨论', '核心', '架构', '总览', '分析', '指南',
  '原理', '实现', '优化', '要点', '要求', '技术', '方案', '过程', '流程', '步骤',
  '注意', '备注', '前言', '后记', '致谢', '摘要', '纲要', '概念', '详解', '详情',
  '内容', '功能', '特性', '示例', '案例', '场景', '用法', '介绍', '概要', '一览'
]);
function extractTags(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const { data } = parseFrontmatter(content);
    if (Array.isArray(data.tags) && data.tags.length > 0) {
      return data.tags.map(t => String(t).trim()).filter(t => t && t.length <= 20);
    }
  } catch {}
  // 兜底：老文章用 extractKeywords 并挑出相对像样的词（过滤通用段落词）
  try {
    const kws = extractKeywords(filePath);
    return [...kws]
      .filter(w => /^[\u4e00-\u9fff]{2,6}$/.test(w) || /^[A-Za-z][\w-]{2,}$/.test(w))
      .filter(w => !TAG_FALLBACK_STOP.has(w))
      .slice(0, 5);
  } catch { return []; }
}

// 扫全库收集已有 tags，按频次降序；用于 prompt 里引导 LLM 复用
function collectExistingTags(limit = 200) {
  const freq = {};
  try {
    const allFiles = walkMd(WIKI).filter(f => {
      const b = path.basename(f);
      return b !== 'index.md' && b !== 'log.md';
    });
    for (const f of allFiles) {
      for (const t of extractTags(f)) freq[t] = (freq[t] || 0) + 1;
    }
  } catch {}
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count }));
}

function extractLinks(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const links = [];
    const re = /\[([^\]]*)\]\(([^)]+\.md)\)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      links.push(m[2]);
    }
    return links;
  } catch { return []; }
}

function resolveLink(fromFile, link) {
  const abs = path.resolve(path.dirname(fromFile), link);
  const rel = path.relative(WIKI, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

function extractSources(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const sources = [];
    const re = /\[([^\]]*)\]\(((?:\.\.\/)*.+?raw\/.+?\.md)\)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const abs = path.resolve(path.dirname(filePath), m[2]);
      const rel = path.relative(ROOT, abs);
      if (rel.startsWith('data/raw/') || rel.startsWith('raw/')) sources.push({ path: rel, title: m[1] || path.basename(abs, '.md') });
    }
    return sources;
  } catch { return []; }
}

// ── 关键词提取（零依赖） ──
const STOP_ZH = new Set('的了是在和有不这我他她它们你也就都还把被让给又才能要会可以应该已经但是而且或者如果虽然因为所以那个一个什么怎么为什么多少这个那些这些概述参考来源参见更新'.split(''));
const STOP_EN = new Set(['see', 'also', 'the', 'and', 'for', 'from', 'with', 'this', 'that', 'not', 'are', 'was', 'were', 'has', 'have', 'had', 'but', 'will', 'can', 'its', 'all', 'by', 'an', 'as', 'or', 'if', 'be', 'to', 'in', 'on', 'at', 'of', 'md', 'raw', 'sources', 'updated']);

function extractKeywords(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const kw = new Set();
    // 1. h2/h3/h4 标题词
    const headings = content.match(/^#{2,4}\s+(.+)/gm) || [];
    for (const h of headings) {
      const text = h.replace(/^#+\s+/, '').trim();
      // 中文 2-6 字词
      const zhWords = text.match(/[\u4e00-\u9fff]{2,6}/g) || [];
      zhWords.forEach(w => { if (!STOP_ZH.has(w)) kw.add(w); });
      // 英文词 (2+ chars)
      const enWords = text.match(/[A-Za-z][\w-]{1,}/g) || [];
      enWords.forEach(w => { const lw = w.toLowerCase(); if (!STOP_EN.has(lw) && lw.length > 1) kw.add(lw); });
    }
    // 2. 加粗文本 **xxx**
    const bolds = content.match(/\*\*(.+?)\*\*/g) || [];
    for (const b of bolds) {
      const text = b.replace(/\*\*/g, '');
      const zhWords = text.match(/[\u4e00-\u9fff]{2,6}/g) || [];
      zhWords.forEach(w => { if (!STOP_ZH.has(w)) kw.add(w); });
      const enWords = text.match(/[A-Za-z][\w-]{1,}/g) || [];
      enWords.forEach(w => { const lw = w.toLowerCase(); if (!STOP_EN.has(lw) && lw.length > 1) kw.add(lw); });
    }
    // 3. 标题（h1）
    const h1 = content.match(/^#\s+(.+)/m);
    if (h1) {
      const zhWords = h1[1].match(/[\u4e00-\u9fff]{2,6}/g) || [];
      zhWords.forEach(w => { if (!STOP_ZH.has(w)) kw.add(w); });
      const enWords = h1[1].match(/[A-Za-z][\w-]{1,}/g) || [];
      enWords.forEach(w => { const lw = w.toLowerCase(); if (!STOP_EN.has(lw) && lw.length > 1) kw.add(lw); });
    }
    return kw;
  } catch { return new Set(); }
}

// ── Context Retrieval ──

function retrieveContext(question) {
  const searchResults = searchWiki(question);
  const articleContents = [];
  const references = [];
  const seen = new Set();

  // Only include actual articles (skip index.md / log.md), max 5
  const filtered = searchResults.filter(r => !['index.md', 'log.md'].includes(r.path.split('/').pop()));
  for (const r of filtered.slice(0, 5)) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    try {
      let content = wikiCache.get(r.path);
      if (!content) { content = fs.readFileSync(path.join(WIKI, r.path), 'utf-8'); wikiCache.set(r.path, content); }
      // Truncate long articles to avoid blowing up the context
      const truncated = content.length > 4000 ? content.slice(0, 4000) + '\n\n...(内容已截断)' : content;
      articleContents.push(`### ${r.title} (${r.path})\n\n${truncated}`);
      references.push({ path: r.path, title: r.title });
    } catch {}
  }

  // No fallback — if nothing matches, the AI answers from its own knowledge
  return { articleContents, references };
}

// ── Token Estimation ──

function estimateTokens(text) {
  return Math.ceil((text || '').length / 2.5);
}

// ── Chat Helpers ──

function genId(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`; }

function loadChatIndex() {
  const p = path.join(CHATS, '_index.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return { conversations: [] }; }
}

function saveChatIndex(index) {
  fs.writeFileSync(path.join(CHATS, '_index.json'), JSON.stringify(index, null, 2), 'utf-8');
}

function loadChat(id) {
  const p = path.join(CHATS, `${id}.json`);
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function saveChat(conv) {
  fs.writeFileSync(path.join(CHATS, `${conv.id}.json`), JSON.stringify(conv, null, 2), 'utf-8');
}

function updateChatIndex(conv) {
  const index = loadChatIndex();
  const existing = index.conversations.findIndex(c => c.id === conv.id);
  const entry = {
    id: conv.id, title: conv.title, updatedAt: conv.updatedAt,
    messageCount: conv.messages.length,
    preview: (conv.messages.find(m => m.role === 'user') || {}).content?.slice(0, 60) || ''
  };
  if (existing >= 0) index.conversations[existing] = entry;
  else index.conversations.unshift(entry);
  // Sort by updatedAt desc
  index.conversations.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  saveChatIndex(index);
}

function removeChatFromIndex(id) {
  const index = loadChatIndex();
  index.conversations = index.conversations.filter(c => c.id !== id);
  saveChatIndex(index);
}

// ── Context Window Management ──
// Sliding window: keep recent messages up to ~80K tokens.
// If total conversation exceeds 100K tokens, compress older messages into a summary.

const WINDOW_TOKEN_LIMIT = 80000;   // sliding window size
const COMPRESS_THRESHOLD = 100000;  // trigger compression above this

function trimMessages(messages, _unused) {
  const total = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  // Under window limit — return all
  if (total <= WINDOW_TOKEN_LIMIT) return messages;

  // Sliding window: always keep first message (context) + recent messages that fit
  const first = messages[0];
  let budget = WINDOW_TOKEN_LIMIT - estimateTokens(first.content);
  const recent = [];
  for (let i = messages.length - 1; i >= 1; i--) {
    const cost = estimateTokens(messages[i].content);
    if (budget - cost < 0) break;
    recent.unshift(messages[i]);
    budget -= cost;
  }
  return [first, ...recent];
}

async function compressHistory(conv, overrides) {
  const total = conv.messages.reduce((s, m) => s + estimateTokens(m.content), 0);
  if (total < COMPRESS_THRESHOLD) return;

  // Compress the older half of messages into a summary
  const mid = Math.floor(conv.messages.length / 2);
  const oldMsgs = conv.messages.slice(0, mid);
  const recentMsgs = conv.messages.slice(mid);

  const summaryText = oldMsgs.map(m => `${m.role}: ${m.content.slice(0, 300)}`).join('\n');
  try {
    const summary = await callLLM(
      '你是一个对话压缩器。把以下对话历史压缩成一段简洁的摘要（200字以内），保留关键信息和结论。只输出摘要，不要其他内容。',
      summaryText,
      overrides
    );
    const summaryMsg = {
      id: genId('msg'), role: 'system', content: `[历史摘要] ${summary}`,
      timestamp: new Date().toISOString()
    };
    conv.messages = [summaryMsg, ...recentMsgs];
    conv.totalTokenEstimate = conv.messages.reduce((s, m) => s + estimateTokens(m.content), 0);
    saveChat(conv);
  } catch {
    // Compression failed — just truncate to recent half
    conv.messages = recentMsgs;
    saveChat(conv);
  }
}

// ── Chat Message Handler ──

async function handleChatMessage(conv, userContent, overrides) {
  const now = new Date().toISOString();
  const userMsg = { id: genId('msg'), role: 'user', content: userContent, timestamp: now };
  conv.messages.push(userMsg);

  // Retrieve wiki context
  const { articleContents, references } = retrieveContext(userContent);

  // Get wiki index (cached)
  let wikiIndex = indexCache.get('index');
  if (!wikiIndex) {
    try { wikiIndex = fs.readFileSync(path.join(WIKI, 'index.md'), 'utf-8'); indexCache.set('index', wikiIndex); } catch { wikiIndex = ''; }
  }

  const memoryContext = buildMemoryContext();
  const bioContext = memoryContext || (() => { const profile = loadProfile(); return profile && profile.bio ? `\n用户背景：${profile.bio}` : ''; })();

  const articleSection = articleContents.length > 0
    ? `## 相关文章内容（共 ${articleContents.length} 篇匹配）\n${articleContents.join('\n\n---\n\n')}`
    : '## 相关文章内容\n无匹配文章。请用你自己的知识回答。';

  const systemPrompt = `你是一个个人知识库助手。用户有一个包含文章的知识库，你可以引用其中的内容来回答问题。

## 知识库索引
${wikiIndex}

${articleSection}

## 规则
1. 如果有匹配的文章，优先使用文章内容回答，引用时用 [文章标题](路径) 格式
2. 如果没有匹配的文章，直接用你自己的知识回答即可，不需要特别说明
3. 不要编造知识库中没有的文章
4. 用中文回答
5. 自然对话风格，简洁有条理
${bioContext}`;

  // Build messages array for multi-turn (sliding window)
  const historyMsgs = conv.messages.map(m => ({ role: m.role, content: m.content }));
  const trimmed = trimMessages(historyMsgs);

  // Call LLM
  const response = await callLLM(systemPrompt, trimmed, overrides);

  const assistantMsg = {
    id: genId('msg'), role: 'assistant', content: response, timestamp: new Date().toISOString(),
    references: references
  };
  conv.messages.push(assistantMsg);
  conv.updatedAt = new Date().toISOString();
  conv.totalTokenEstimate = conv.messages.reduce((s, m) => s + estimateTokens(m.content), 0);

  saveChat(conv);
  updateChatIndex(conv);

  // Auto-compress if conversation exceeds 100K tokens (non-blocking)
  compressHistory(conv, overrides).catch(() => {});

  return assistantMsg;
}

function buildGraph() {
  const allFiles = walkMd(WIKI);
  const nodes = [];
  const edges = [];
  const edgeSet = new Set(); // 去重: "source|target"
  const excluded = new Set(['index.md', 'log.md']);
  const tagMap = {}; // rel -> Set of tags

  // 统计全局 tag 频次，用作共现打分（过度常见的 tag 降权）
  const globalTagFreq = {};
  for (const f of allFiles) {
    const rel = path.relative(WIKI, f);
    if (excluded.has(path.basename(f))) continue;
    const tags = extractTags(f);
    tagMap[rel] = new Set(tags);
    for (const t of tags) globalTagFreq[t] = (globalTagFreq[t] || 0) + 1;
  }

  for (const f of allFiles) {
    const rel = path.relative(WIKI, f);
    if (excluded.has(path.basename(f))) continue;
    const parts = rel.split(path.sep);
    const topic = parts.length > 1 ? parts[0] : '';
    nodes.push({ id: rel, label: extractTitle(f), topic });

    // Layer 1: 显式链接 (weight=1.0)
    const links = extractLinks(f);
    for (const link of links) {
      const target = resolveLink(f, link);
      if (target && !excluded.has(path.basename(target))) {
        const key = [rel, target].sort().join('|');
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({ source: rel, target, type: 'link', weight: 1.0 });
        }
      }
    }
  }

  // Layer 2: tag 共现 — 用文章的 tags 集合求交集，阈值 ≥1（tag 已经是语义级别的精准词）
  const totalArticles = Object.keys(tagMap).length || 1;
  const rels = Object.keys(tagMap);
  for (let i = 0; i < rels.length; i++) {
    for (let j = i + 1; j < rels.length; j++) {
      const a = rels[i], b = rels[j];
      const tA = tagMap[a], tB = tagMap[b];
      if (!tA.size || !tB.size) continue;
      const shared = [];
      for (const t of tA) { if (tB.has(t)) shared.push(t); }
      if (shared.length < 1) continue;
      // 过滤只通过"太宽泛"的 tag 连起来的边：全部共享 tag 都覆盖 >50% 文章时丢弃
      const allTooCommon = shared.every(t => (globalTagFreq[t] || 0) / totalArticles > 0.5);
      if (allTooCommon) continue;
      const key = [a, b].sort().join('|');
      const existing = edges.find(e => [e.source, e.target].sort().join('|') === key);
      // IDF 打分：越稀有的 tag 权重越高
      const idfScore = shared.reduce((sum, t) => {
        const f = globalTagFreq[t] || 1;
        return sum + Math.log((totalArticles + 1) / (f + 1));
      }, 0);
      const weight = Math.min(0.9, 0.25 + idfScore * 0.15);
      if (existing) {
        existing.keywords = shared.slice(0, 5);
      } else {
        edgeSet.add(key);
        edges.push({ source: a, target: b, type: 'keyword', weight, keywords: shared.slice(0, 5) });
      }
    }
  }

  // Layer 3: 同主题弱连接 (weight=0.15)
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (!nodes[i].topic || nodes[i].topic !== nodes[j].topic) continue;
      const key = [nodes[i].id, nodes[j].id].sort().join('|');
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({ source: nodes[i].id, target: nodes[j].id, type: 'topic', weight: 0.15 });
    }
  }

  return { nodes, edges };
}

function parseLogEntries() {
  const logPath = path.join(WIKI, 'log.md');
  if (!fs.existsSync(logPath)) return [];
  const content = fs.readFileSync(logPath, 'utf-8');
  const activities = [];
  const re = /^## \[(\d{4}-\d{2}-\d{2})\]\s+(\w+)\s*\|\s*(.+)$/gm;
  let m;
  // Build title→path map for matching
  const titleMap = {};
  for (const f of walkMd(WIKI)) {
    const bn = path.basename(f);
    if (bn === 'index.md' || bn === 'log.md') continue;
    const rel = path.relative(WIKI, f);
    const title = extractTitle(f);
    titleMap[title] = rel;
  }
  while ((m = re.exec(content)) !== null) {
    const title = m[3].trim();
    activities.push({ date: m[1], action: m[2], title, path: titleMap[title] || '', details: {} });
  }
  return activities.reverse();
}

// ── Ingest 状态 ──
let taskQueue = [];
let writeLock = Promise.resolve(); // 串行锁：保护 index.md/log.md 并发写入

// ── Tags 批量回填状态 ──
let backfillProgress = {
  running: false,
  total: 0,
  done: 0,
  skipped: 0,
  failed: 0,
  currentFile: '',
  startedAt: null,
  finishedAt: null,
  error: null,
  recent: []
};

async function runBackfillTags() {
  backfillProgress = {
    running: true, total: 0, done: 0, skipped: 0, failed: 0,
    currentFile: '', startedAt: new Date().toISOString(), finishedAt: null,
    error: null, recent: []
  };
  const excluded = new Set(['index.md', 'log.md']);
  const allFiles = walkMd(WIKI).filter(f => !excluded.has(path.basename(f)));
  const todo = [];
  for (const f of allFiles) {
    try {
      const content = fs.readFileSync(f, 'utf-8');
      const { data } = parseFrontmatter(content);
      if (!Array.isArray(data.tags) || data.tags.length === 0) todo.push(f);
    } catch {}
  }
  backfillProgress.total = todo.length;

  const config = getFullConfig();
  const providerKey = config.provider || 'local';
  const fastModel = pickModelByUse(providerKey, 'fast', config);

  for (const f of todo) {
    const rel = path.relative(WIKI, f);
    backfillProgress.currentFile = rel;
    try {
      const content = fs.readFileSync(f, 'utf-8');
      const { body } = parseFrontmatter(content);
      const core = body.replace(/\n##\s+See\s+Also[\s\S]*$/i, '').slice(0, 6000);
      const existingTagsCol = collectExistingTags(200);
      const existingTagsStr = existingTagsCol.length ? existingTagsCol.map(t => t.tag).join('、') : '（暂无）';

      const sys = `你是知识库标签助手。根据文章内容输出 3-5 个精准标签，用于知识图谱连接。
规则：
- 每个标签 ≤ 10 字，精准、有区分度
- 优先从"已有标签"里选语义相近的，让同一概念在不同文章里复用
- 避免过宽的词（如"技术"、"方法"、"分析"）和碎片（如"据收集"）
- 不要 emoji、引号、书名号
- 只输出一行：标签1, 标签2, 标签3，不要加任何解释或前缀

已有标签（频次降序）：${existingTagsStr}`;

      const user = `文章标题：${extractTitle(f)}\n\n文章正文（截断）：\n${core}`;

      const resp = await callLLM(sys, user, { model: fastModel }, { maxTokens: 120, temperature: 0.2 });
      const tagsLine = (resp || '').trim().split('\n')[0].replace(/^[-*•]\s*/, '').replace(/^标签[:：]\s*/, '');
      const tags = tagsLine
        .split(/[,，、]/)
        .map(t => t.trim().replace(/^["'《「『]+|["'》」』]+$/g, ''))
        .filter(t => t && t.length <= 10)
        .slice(0, 5);

      if (tags.length === 0) {
        backfillProgress.failed++;
        continue;
      }

      const existing = parseFrontmatter(content);
      const newData = { ...existing.data, tags };
      const newContent = serializeFrontmatter(newData) + existing.body;
      fs.writeFileSync(f, newContent, 'utf-8');
      backfillProgress.done++;
      backfillProgress.recent.unshift({ file: rel, tags });
      if (backfillProgress.recent.length > 10) backfillProgress.recent.pop();
    } catch (e) {
      backfillProgress.failed++;
      backfillProgress.recent.unshift({ file: rel, error: e.message });
      if (backfillProgress.recent.length > 10) backfillProgress.recent.pop();
    }
  }
  backfillProgress.running = false;
  backfillProgress.finishedAt = new Date().toISOString();
  backfillProgress.currentFile = '';
  if (typeof wikiCache !== 'undefined' && wikiCache && wikiCache.invalidate) wikiCache.invalidate();
}

// 全局并发池：默认 10，环境变量覆盖
const INGEST_CONCURRENCY = Number(process.env.WIKI_INGEST_CONCURRENCY) || 10;
let activeCount = 0;

// 测试 hook：允许用 __test.setProcessTask 覆盖真实 processTask
let _processTaskImpl = null;

function genTaskId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');
}

function latestTask() {
  return taskQueue.length ? taskQueue[taskQueue.length - 1] : null;
}

// 只用于 autotask / precipitate：直接创建 processing 状态的 task，不走并发池（调用方自己 await compileArticle）
function pushTask(type, opts) {
  opts = opts || {};
  const task = {
    id: genTaskId(),
    status: 'processing',
    message: 'AI 编译',
    type: type || 'ingest',
    kind: type || 'ingest',
    name: opts.name || type || 'ingest',
    created: null,
    submittedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    batchId: null,
    stages: [],
    // autotask 直接进入 compiling（提取/保存已在 autotask runner 内完成）
    phase: 'compiling',
    phaseIndex: 3,
    phaseTotal: PHASE_TOTAL,
    phaseLabel: 'AI 编译',
    retryable: false,
    retryOf: opts.retryOf || null,
    retryCount: opts.retryCount || 0,
  };
  taskQueue.push(task);
  _trimQueue();
  scheduleSaveQueue();
  return task;
}

// 新的 enqueue：入队为 pending，由 tryDispatch 调度
function enqueueTask(payload, opts) {
  opts = opts || {};
  const kind = opts.kind || 'ingest';
  // payload 是否可用于重试：默认有 payload 就可重试；大 base64 在 persist 时会被 strip 掉
  const retryable = !!payload && payload._contentStripped !== true;
  const task = {
    id: genTaskId(),
    kind,
    type: kind,
    status: 'pending',
    name: opts.name || kind,
    submittedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    batchId: opts.batchId || null,
    batchIndex: typeof opts.batchIndex === 'number' ? opts.batchIndex : null,
    message: '排队中',
    stages: [],
    created: null,
    payload,
    phase: 'queued',
    phaseIndex: 0,
    phaseTotal: PHASE_TOTAL,
    phaseLabel: '排队中',
    retryable,
    retryOf: opts.retryOf || null,
    retryCount: opts.retryCount || 0,
  };
  taskQueue.push(task);
  _trimQueue();
  scheduleSaveQueue();
  tryDispatch();
  return task;
}

// cap 200，pending/processing 永不剔除；超过时只剔除最老的 done/error/partial
function _trimQueue() {
  if (taskQueue.length <= 200) return;
  const keep = taskQueue.filter(t => t.status === 'pending' || t.status === 'processing');
  const done = taskQueue
    .filter(t => t.status !== 'pending' && t.status !== 'processing')
    .slice(-(Math.max(200 - keep.length, 0)));
  taskQueue = keep.concat(done);
}

function tryDispatch() {
  while (activeCount < INGEST_CONCURRENCY) {
    const next = taskQueue.find(t => t.status === 'pending');
    if (!next) break;
    activeCount++;
    next.status = 'processing';
    next.startedAt = new Date().toISOString();
    // 先进入 extracting 阶段（真正的子步骤由 _defaultProcessTask 推进）
    setPhase(next, 'extracting');
    Promise.resolve()
      .then(() => processTask(next))
      .catch(e => {
        console.error('[ingest] processTask 异常', e);
        next.status = 'error';
        next.message = String(e && e.message || e);
        next.phase = 'error';
        next.phaseLabel = '失败';
        next.finishedAt = new Date().toISOString();
      })
      .finally(() => {
        if (!next.finishedAt) next.finishedAt = new Date().toISOString();
        if (next.status === 'done') {
          setPhase(next, 'done', '已完成');
        } else if (next.status === 'error' || next.status === 'partial') {
          next.phase = next.status;
          next.phaseLabel = next.status === 'error' ? '失败' : '部分完成';
        }
        activeCount--;
        scheduleSaveQueue();
        tryDispatch();
      });
  }
}

// processTask：模块级 dispatcher，默认走 _defaultProcessTask，测试可覆盖
async function processTask(task) {
  if (_processTaskImpl) return _processTaskImpl(task);
  return _defaultProcessTask(task);
}

// _defaultProcessTask：从 task.payload 提取内容 → 写 raw → compileArticle
async function _defaultProcessTask(task) {
  task.status = 'processing';
  if (!task.startedAt) task.startedAt = new Date().toISOString();
  setPhase(task, 'extracting');

  const payload = task.payload || {};
  const { type, content, topic, filename, url: itemUrl, modelOverrides } = payload;
  const topicDir = topic && topic !== 'auto' ? topic : 'general';
  const dir = path.join(RAW, topicDir);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    task.status = 'error';
    task.message = 'mkdir 失败: ' + e.message;
    task.finishedAt = new Date().toISOString();
    return;
  }

  const date = new Date().toISOString().slice(0, 10);
  const isBinaryType = ['pdf', 'image', 'audio', 'video'].includes(type);

  let extractedText;
  try {
    extractedText = await extractContent(type, content, filename, itemUrl, dir);
  } catch (extractErr) {
    task.status = 'error';
    task.message = '内容提取失败: ' + extractErr.message;
    task.finishedAt = new Date().toISOString();
    return;
  }

  setPhase(task, 'saving');

  let slug = 'source';
  if (type === 'url') {
    slug = (itemUrl || content || '').replace(/https?:\/\//, '').replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-').slice(0, 40);
  } else if (isBinaryType && filename) {
    slug = filename.replace(/\.[^.]+$/, '').replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-').slice(0, 40) || type;
  } else {
    slug = (extractedText.slice(0, 40).replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-') || 'text');
  }
  const rawFilename = `${date}-${slug}.md`;
  const filePath = path.join(dir, rawFilename);

  const sourceLabel = isBinaryType
    ? `${type} file: ${filename || 'unknown'}`
    : (type === 'url' ? (itemUrl || content) : 'user input');
  const rawContent = `# Source\n\n> Source: ${sourceLabel}\n> Collected: ${date}\n> Type: ${type}\n\n${extractedText}`;
  try {
    fs.writeFileSync(filePath, rawContent, 'utf-8');
  } catch (e) {
    task.status = 'error';
    task.message = '写入 raw 失败: ' + e.message;
    task.finishedAt = new Date().toISOString();
    return;
  }

  setPhase(task, 'compiling');

  try {
    await compileArticle(topicDir, rawFilename, filePath, task, modelOverrides);
  } catch (e) {
    task.status = 'error';
    task.message = '编译失败: ' + (e && e.message || e);
  }
  task.finishedAt = new Date().toISOString();
}

// 对外暴露的 status 映射：pending/processing 对外显示为 compiling，兼容前端判定
function externalStatus(s) {
  if (s === 'pending' || s === 'processing') return 'compiling';
  return s;
}

// ── 任务阶段模型 ──
// 5 个高层阶段，便于前端展示 N/5 进度
const PHASES = [
  { key: 'queued',     label: '排队中' },
  { key: 'extracting', label: '提取内容' },
  { key: 'saving',     label: '保存原文' },
  { key: 'compiling',  label: 'AI 编译' },
  { key: 'done',       label: '已完成' },
];
const PHASE_TOTAL = PHASES.length; // 5
function setPhase(task, phaseKey, msg) {
  const idx = PHASES.findIndex(p => p.key === phaseKey);
  if (idx < 0) return;
  task.phase = phaseKey;
  task.phaseIndex = idx;
  task.phaseTotal = PHASE_TOTAL;
  task.phaseLabel = PHASES[idx].label;
  if (msg) task.message = msg;
  else task.message = PHASES[idx].label;
  scheduleSaveQueue();
}

// ── 任务队列持久化 ──
// 设计：debounced 300ms 全量写盘；启动时加载，pending/processing 标记为中断可重试
let _saveTimer = null;
function scheduleSaveQueue() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      const snapshot = taskQueue.map(serializeTaskForPersist);
      // 原子写：先写 .tmp 再 rename，避免中途崩溃留下半截 JSON
      const tmp = QUEUE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8');
      fs.renameSync(tmp, QUEUE_FILE);
    } catch (e) {
      console.error('[queue] save failed', e.message);
    }
  }, 300);
}
function serializeTaskForPersist(t) {
  const out = Object.assign({}, t);
  // 二进制类型的大 base64 不落盘（PDF/图片/音频/视频）；stripped 后 retry 失效
  if (out.payload && ['pdf', 'image', 'audio', 'video'].includes(out.payload.type)) {
    if (out.payload.content && String(out.payload.content).length > 10000) {
      out.payload = Object.assign({}, out.payload, { content: null, _contentStripped: true });
      out.retryable = false;
    }
  }
  return out;
}
function loadQueue() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return;
    const raw = fs.readFileSync(QUEUE_FILE, 'utf-8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    const now = new Date().toISOString();
    taskQueue = arr.map(t => {
      // 进程重启前未结束的任务一律标记为错误，可重试
      if (t.status === 'pending' || t.status === 'processing') {
        t.status = 'error';
        t.message = '进程重启前中断，可重试';
        t.interruptedByRestart = true;
        t.finishedAt = t.finishedAt || now;
        t.phase = 'error';
        t.phaseLabel = '已中断';
      }
      return t;
    });
    console.log('[queue] 已加载 ' + taskQueue.length + ' 条历史记录');
    // 立即 debounced save 一次，把中断恢复状态落盘
    if (arr.some(t => t.interruptedByRestart)) scheduleSaveQueue();
  } catch (e) {
    console.error('[queue] load failed', e.message);
  }
}


function getBatchSummary(batchId) {
  const tasks = taskQueue.filter(t => t.batchId === batchId);
  if (!tasks.length) return null;
  const total = tasks.length;
  const completed = tasks.filter(t => ['done', 'error', 'partial'].includes(t.status)).length;
  const failed = tasks.filter(t => t.status === 'error').length;
  const status = completed < total ? 'processing' : 'done';
  const startedAt = tasks.map(t => t.submittedAt).sort()[0];
  const current = tasks.find(t => t.status === 'processing');
  const currentFile = current ? current.name : tasks[tasks.length - 1].name;
  const files = tasks.map(t => ({
    name: t.name,
    status: t.status === 'partial' ? 'done' : (t.status === 'pending' ? 'pending' : t.status),
    error: t.status === 'error' ? t.message : undefined,
  }));
  const elapsed = Date.now() - new Date(startedAt).getTime();
  const avgPerFile = completed > 0 ? elapsed / completed : 0;
  const estimatedRemaining = completed > 0
    ? Math.round(avgPerFile * (total - completed) / 1000)
    : null;
  return { id: batchId, total, completed, failed, status, startedAt, currentFile, files, estimatedRemaining };
}

function findLatestBatchId() {
  for (let i = taskQueue.length - 1; i >= 0; i--) {
    if (taskQueue[i].batchId) return taskQueue[i].batchId;
  }
  return null;
}

// ── HTML 文本提取 ──
function stripHtml(html) {
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

// ── 多格式提取函数 ──

async function extractPDF(b64) {
  const buf = Buffer.from(b64, 'base64');
  const { text } = await parsePdfBuffer(buf);
  if (!text || text.trim().length < 10) {
    throw new Error('PDF 文本提取结果为空，该文件可能是扫描件（需要 OCR）');
  }
  return text;
}

function fetchBuffer(url) {
  const isWechat = /mp\.weixin\.qq\.com/.test(url);
  const args = ['-sL', '-m', '30'];
  if (isWechat) {
    // Full browser headers to avoid WeChat anti-scraping
    args.push('-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    args.push('-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    args.push('-H', 'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8');
    args.push('-H', 'Cache-Control: no-cache');
  } else {
    // 通用浏览器头，避免部分站点直接 403；Accept 包含 PDF
    args.push('-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    args.push('-H', 'Accept: text/html,application/xhtml+xml,application/pdf,application/xml;q=0.9,*/*;q=0.8');
  }
  args.push(url);
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const proc = spawn('curl', args, { timeout: 35000 });
    const chunks = []; let size = 0;
    // 20MB 上限，足以容纳一般 PDF / 网页
    proc.stdout.on('data', d => { size += d.length; if (size < 20 * 1024 * 1024) chunks.push(d); });
    proc.stderr.on('data', () => {});
    proc.on('error', reject);
    proc.on('close', () => resolve(Buffer.concat(chunks)));
  });
}

async function fetchHTML(url) {
  const buf = await fetchBuffer(url);
  return buf.toString('utf-8');
}

function isPdfBuffer(buf) {
  return buf && buf.length >= 5 && buf.slice(0, 5).toString('latin1') === '%PDF-';
}

function downloadImage(imgUrl) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const proc = spawn('curl', [
      '-sL', '-m', '20',
      '-H', 'Referer: https://mp.weixin.qq.com/',
      '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      imgUrl
    ], { timeout: 25000 });
    const chunks = []; let size = 0;
    proc.stdout.on('data', d => { size += d.length; if (size < 10 * 1024 * 1024) chunks.push(d); });
    proc.stderr.on('data', () => {});
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('curl exit ' + code));
      resolve(Buffer.concat(chunks));
    });
  });
}

function htmlToMd(el) {
  let md = '';
  for (const node of el.childNodes) {
    if (node.nodeType === 3) { const t = node.textContent.replace(/\n/g, ' ').trim(); if (t) md += t; continue; }
    if (node.nodeType !== 1) continue;
    const tag = node.tagName;
    if (tag === 'BR') { md += '\n'; continue; }
    if (tag === 'IMG') {
      const src = node.getAttribute('src') || node.getAttribute('data-src') || '';
      if (src) md += '\n\n![图片](' + src + ')\n\n';
      continue;
    }
    if (/^H[1-6]$/.test(tag)) { md += '\n\n' + '#'.repeat(+tag[1]) + ' ' + node.textContent.trim() + '\n\n'; continue; }
    if (tag === 'P' || tag === 'SECTION') {
      const inner = htmlToMd(node).trim();
      if (inner) md += '\n\n' + inner;
      continue;
    }
    if (tag === 'STRONG' || tag === 'B') { const t = htmlToMd(node).trim(); if (t) md += '**' + t + '**'; continue; }
    if (tag === 'EM' || tag === 'I') { const t = htmlToMd(node).trim(); if (t) md += '*' + t + '*'; continue; }
    if (tag === 'BLOCKQUOTE') { const t = htmlToMd(node).trim(); if (t) md += '\n\n> ' + t.replace(/\n/g, '\n> ') + '\n\n'; continue; }
    if (tag === 'A') { const href = node.getAttribute('href') || ''; const t = node.textContent.trim(); if (t && href) md += '[' + t + '](' + href + ')'; else if (t) md += t; continue; }
    if (tag === 'UL' || tag === 'OL') {
      let i = 1;
      for (const li of node.children) {
        if (li.tagName === 'LI') { const t = htmlToMd(li).trim(); md += '\n' + (tag === 'OL' ? i++ + '. ' : '- ') + t; }
      }
      md += '\n'; continue;
    }
    if (tag === 'PRE' || tag === 'CODE') { md += '\n\n```\n' + node.textContent + '\n```\n\n'; continue; }
    md += htmlToMd(node);
  }
  return md;
}

async function extractWechat(url, rawDir) {
  if (!JSDOM) throw new Error('jsdom 未安装，无法提取微信文章');
  const html = await fetchHTML(url);
  if (!html || html.length < 200) throw new Error('微信文章抓取失败（返回内容为空）');
  if (html.includes('环境异常') || html.includes('请在微信客户端打开')) {
    throw new Error('微信文章抓取被拦截（需要验证或仅限微信客户端打开）');
  }

  // WeChat lazy-loads ALL images via data-src; swap every data-src to src
  const fixed = html.replace(/\bdata-src\s*=\s*"([^"]+)"/g, (_, u) => 'src="' + u.replace(/&amp;/g, '&') + '"');
  const dom = new JSDOM(fixed, { url });
  const doc = dom.window.document;

  // Title: og:title > #activity-name > fallback
  const title = doc.querySelector('meta[property="og:title"]')?.content?.trim()
    || doc.querySelector('#activity-name')?.textContent?.trim()
    || '微信文章';
  // Author: meta author > #js_name (公众号名称)
  const author = doc.querySelector('meta[name="author"]')?.content?.trim()
    || doc.querySelector('#js_name')?.textContent?.trim() || '';

  const content = doc.querySelector('#js_content');
  if (!content || content.textContent.trim().length < 50) {
    throw new Error('微信文章内容提取失败（可能需要验证或文章已过期）');
  }

  // Convert to markdown
  let mdBody = htmlToMd(content);
  mdBody = mdBody.replace(/\n{3,}/g, '\n\n').trim();

  // Collect ALL image URLs from markdown (not just mmbiz — WeChat can use various CDNs)
  const imgRegex = /!\[图片\]\((https?:\/\/[^)]+)\)/g;
  const imgUrls = []; const seen = new Set();
  let m;
  while ((m = imgRegex.exec(mdBody)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); imgUrls.push(m[1]); }
  }

  if (imgUrls.length > 0 && rawDir) {
    const imgDir = path.join(rawDir, 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    const ts = Date.now();
    const downloads = imgUrls.map(async (imgUrl, i) => {
      // Try up to 2 times
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const buf = await downloadImage(imgUrl);
          if (buf.length < 100) { if (attempt === 0) continue; return null; }
          const ext = /wx_fmt=(\w+)/.exec(imgUrl)?.[1] || (/\.(png|jpg|jpeg|gif|webp|svg)/i.exec(imgUrl)?.[1]) || 'jpg';
          const fname = `img_${ts}_${String(i).padStart(3, '0')}.${ext}`;
          fs.writeFileSync(path.join(imgDir, fname), buf);
          return { url: imgUrl, local: `images/${fname}` };
        } catch { if (attempt === 1) return null; }
      }
      return null;
    });
    const results = await Promise.all(downloads);
    for (const r of results) {
      if (r) mdBody = mdBody.split(r.url).join(r.local); // replace ALL occurrences
    }
  }

  return `# ${title}\n\n> 作者：${author}\n> 来源：微信公众号\n> 链接：${url}\n\n${mdBody}`;
}

async function extractURLReadability(url, rawDir) {
  // 微信公众号文章走专用提取
  if (/mp\.weixin\.qq\.com/.test(url)) {
    return await extractWechat(url, rawDir);
  }
  try {
    const buf = await fetchBuffer(url);
    // 1) PDF：按魔数或扩展名识别，走 pdf-parse
    const urlIsPdf = /\.pdf(\?|$)/i.test(url);
    if (isPdfBuffer(buf) || urlIsPdf) {
      if (!isPdfBuffer(buf)) {
        // URL 看起来是 PDF 但抓回来不是，可能被网关拦截了
        throw new Error('URL 看似 PDF，但响应不是 PDF 内容（可能被重定向或拦截）');
      }
      let parsed;
      try { parsed = await parsePdfBuffer(buf); } catch (e) { throw new Error('PDF 解析失败: ' + e.message); }
      const text = (parsed.text || '').replace(/\r/g, '').trim();
      if (text.length < 10) {
        return `[PDF 文本提取为空，可能是扫描件（需要 OCR）]\n\nURL: ${url}`;
      }
      // 从 URL 文件名猜标题
      const fname = (() => {
        try { return decodeURIComponent((new URL(url)).pathname.split('/').pop() || '').replace(/\.pdf$/i, ''); } catch { return ''; }
      })();
      const title = (parsed.info && (parsed.info.Title || parsed.info.title)) || fname || 'PDF Document';
      return `# ${title}\n\n${text}`;
    }
    // 2) HTML：原有流程
    const html = buf.toString('utf-8');
    if (Readability && JSDOM) {
      try {
        const dom = new JSDOM(html, { url });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();
        if (article && article.textContent && article.textContent.trim().length > 100) {
          return `# ${article.title || '未知标题'}\n\n${article.textContent}`;
        }
      } catch {}
    }
    const text = stripHtml(html);
    if (text.length > 100) return text;
    return `[Fetched content too short]\n\nURL: ${url}\n\n${text}`;
  } catch (e) {
    return `[Fetch failed: ${e.message}]\n\nURL: ${url}`;
  }
}

async function ocrImage(b64, filename) {
  const config = getFullConfig();
  const providerKey = config.provider || 'local';
  const provider = PROVIDERS[providerKey];
  const model = config.model || provider.defaultModel;

  if (providerKey === 'local') {
    throw new Error('本地 CLI 模式不支持图片识别，请切换到支持 Vision 的 provider（如 OpenAI gpt-4o、Anthropic Claude、百炼 qwen-vl）');
  }
  if (!config.apiKey) throw new Error('未配置 API Key，请在设置中配置');

  const ext = (filename || '').split('.').pop().toLowerCase();
  const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  const mediaType = mimeMap[ext] || 'image/png';

  const baseUrl = (providerKey === 'custom' && config.customBaseUrl) ? config.customBaseUrl : provider.baseUrl;
  const systemPrompt = '你是一个 OCR 和图片内容提取助手。请详细描述图片中的所有文字内容和关键视觉信息。如果图片包含文字，请完整准确地提取所有文字。如果是截图，请描述界面内容和文字。输出使用中文。';

  if (provider.format === 'anthropic') {
    const result = await httpPost(`${baseUrl}/v1/messages`, {
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01'
    }, JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
          { type: 'text', text: '请提取并整理这张图片中的所有内容。' }
        ]
      }]
    }));
    return result.content[0].text;
  }

  // OpenAI-compatible Vision API
  const headers = { 'Authorization': `Bearer ${config.apiKey}` };
  if (providerKey === 'openrouter') {
    headers['HTTP-Referer'] = `http://localhost:${PORT}`;
    headers['X-Title'] = 'Wiki Knowledge Base';
  }

  let visionModel = model;
  if (providerKey === 'bailian' && !model.startsWith('qwen-vl') && !model.startsWith('qwen3-vl')) {
    visionModel = 'qwen-vl-max-latest';
  }
  if (providerKey === 'openai' && !model.startsWith('gpt-4o') && !model.startsWith('gpt-4-turbo')) {
    visionModel = 'gpt-4o';
  }

  const result = await httpPost(`${baseUrl}/chat/completions`, headers, JSON.stringify({
    model: visionModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${mediaType};base64,${b64}` } },
        { type: 'text', text: '请提取并整理这张图片中的所有内容。' }
      ]}
    ],
    max_tokens: 4096
  }));
  return result.choices[0].message.content;
}

async function transcribeMedia(b64, filename) {
  const config = getFullConfig();
  const providerKey = config.provider || 'local';

  if (providerKey === 'openai' && config.apiKey) {
    const ext = (filename || 'audio.mp3').split('.').pop().toLowerCase();
    const buf = Buffer.from(b64, 'base64');
    const boundary = '----WikiAppBoundary' + Date.now();
    const parts = [];
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename || 'audio.' + ext}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(buf);
    parts.push(Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1`));
    parts.push(Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\ntext`));
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const bodyBuf = Buffer.concat(parts);

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.openai.com',
        port: 443,
        path: '/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': bodyBuf.length
        }
      };
      const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`Whisper API HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(600000, () => { req.destroy(); reject(new Error('转写超时 (600s)')); });
      req.write(bodyBuf);
      req.end();
    });
    return result;
  }

  try {
    spawnSync('which', ['ffmpeg'], { stdio: 'pipe' }).status === 0 || (() => { throw new Error(); })();
    const ext = (filename || 'media.mp3').split('.').pop().toLowerCase();
    const tmpFile = path.join(os.tmpdir(), `wiki-media-${crypto.randomBytes(8).toString('hex')}.${ext}`);
    const wavFile = path.join(os.tmpdir(), `wiki-media-${crypto.randomBytes(8).toString('hex')}.wav`);
    fs.writeFileSync(tmpFile, Buffer.from(b64, 'base64'));
    try {
      const ffResult = spawnSync('ffmpeg', ['-i', tmpFile, '-ar', '16000', '-ac', '1', '-f', 'wav', wavFile, '-y'], { stdio: 'pipe', timeout: 120000 });
      if (ffResult.status !== 0) throw new Error('ffmpeg failed');
      try {
        const whichWhisper = spawnSync('which', ['whisper'], { stdio: 'pipe' });
        if (whichWhisper.status !== 0) throw new Error('whisper not found');
        const whisperResult = spawnSync('whisper', [wavFile, '--model', 'base', '--output_format', 'txt', '--output_dir', os.tmpdir()], { encoding: 'utf-8', timeout: 300000 });
        if (whisperResult.status !== 0) throw new Error('whisper failed');
        const txtFile = wavFile.replace('.wav', '.txt');
        if (fs.existsSync(txtFile)) {
          const text = fs.readFileSync(txtFile, 'utf-8');
          try { fs.unlinkSync(txtFile); } catch {}
          try { fs.unlinkSync(tmpFile); } catch {}
          try { fs.unlinkSync(wavFile); } catch {}
          return text;
        }
      } catch {}
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
      try { fs.unlinkSync(wavFile); } catch {}
    }
  } catch {}

  throw new Error('当前配置不支持音视频转写。可选方案：\n1. 切换到 OpenAI provider（使用 Whisper API）\n2. 安装 ffmpeg + whisper CLI 进行本地转写\n3. 手动转写后粘贴文本导入');
}

async function extractContent(type, content, filename, urlVal, rawDir) {
  switch (type) {
    case 'text': return content;
    case 'url': return await extractURLReadability(urlVal || content, rawDir);
    case 'pdf': return await extractPDF(content);
    case 'image': return await ocrImage(content, filename);
    case 'audio':
    case 'video': return await transcribeMedia(content, filename);
    default: return content;
  }
}

// ── 自动化任务 ──

const { fetchSource: fetchSourceAdapter, AGGREGATOR_SCRIPT: AGG_SCRIPT_PATH } = require('./lib/sources.js');
const SYSTEM_SOURCES_PATH = path.join(ROOT, 'data', 'system-sources.json');

function loadSystemSources() {
  try {
    return JSON.parse(fs.readFileSync(SYSTEM_SOURCES_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'task';
}

function normalizeTask(t) {
  // Migrate legacy v1/v2 single-URL tasks into v3 schema, in-memory only.
  // Keep all original fields so legacy code paths still see what they expect.
  const base = { ...t };
  base.model = t.model || null;
  base.provider = t.provider || null;
  base.nlSummary = t.nlSummary || null;
  base.templateId = t.templateId || null;
  base.maxPerRun = (typeof t.maxPerRun === 'number' && t.maxPerRun > 0) ? t.maxPerRun
                 : (t.sourceConfig && t.sourceConfig.maxItems) || 5;

  // intent: derived from name if missing
  base.intent = (typeof t.intent === 'string' && t.intent) ? t.intent
              : (t.nlSummary || t.name || '');

  // sources array
  if (!Array.isArray(t.sources) || t.sources.length === 0) {
    if (t.sourceType && t.sourceConfig) {
      base.sources = [{
        id: 'legacy',
        type: t.sourceType,
        url: t.sourceConfig.url || '',
        label: t.name || 'legacy source',
        ...t.sourceConfig
      }];
    } else {
      base.sources = [];
    }
  } else {
    base.sources = t.sources.map((s, i) => ({
      id: s.id || `src_${i}`,
      type: s.type || 'rss',
      ...s
    }));
  }

  // preferences
  const prefIn = t.preferences && typeof t.preferences === 'object' ? t.preferences : {};
  const legacyKw = (t.filters && Array.isArray(t.filters.keywords)) ? t.filters.keywords : [];
  const legacyExc = (t.filters && Array.isArray(t.filters.excludeKeywords)) ? t.filters.excludeKeywords : [];
  base.preferences = {
    expanded_keywords: Array.isArray(prefIn.expanded_keywords) ? prefIn.expanded_keywords : legacyKw,
    must_exclude: Array.isArray(prefIn.must_exclude) ? prefIn.must_exclude : legacyExc,
    style_hint: typeof prefIn.style_hint === 'string' ? prefIn.style_hint : ''
  };

  // feedback
  base.feedback = Array.isArray(t.feedback) ? t.feedback : [];

  // Stamp current schema version (v3). Preserve any future-higher version untouched.
  base.version = (typeof t.version === 'number' && t.version > 3) ? t.version : 3;
  return base;
}
function loadAutotasks() { try { const tasks = JSON.parse(fs.readFileSync(path.join(AUTOTASKS_DIR, 'tasks.json'), 'utf-8')); return tasks.map(normalizeTask); } catch { return []; } }
function saveAutotasks(tasks) { fs.writeFileSync(path.join(AUTOTASKS_DIR, 'tasks.json'), JSON.stringify(tasks, null, 2), 'utf-8'); }
function loadHistory() { try { return JSON.parse(fs.readFileSync(path.join(AUTOTASKS_DIR, 'history.json'), 'utf-8')); } catch { return []; } }
function saveHistory(hist) { fs.writeFileSync(path.join(AUTOTASKS_DIR, 'history.json'), JSON.stringify(hist, null, 2), 'utf-8'); if (hist.length > 200) saveHistory(hist.slice(-200)); }
function loadDedup() { try { return JSON.parse(fs.readFileSync(path.join(AUTOTASKS_DIR, 'dedup.json'), 'utf-8')); } catch { return { urls: {}, hashes: {} }; } }
function saveDedup(d) { fs.writeFileSync(path.join(AUTOTASKS_DIR, 'dedup.json'), JSON.stringify(d, null, 2), 'utf-8'); }

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.searchParams.delete('utm_source');
    u.searchParams.delete('utm_medium');
    u.searchParams.delete('utm_campaign');
    u.searchParams.delete('utm_content');
    u.searchParams.delete('utm_term');
    u.searchParams.sort();
    return u.toString().replace(/\/+$/, '');
  } catch { return url; }
}

function contentHash(text) {
  return crypto.createHash('sha256').update(text.slice(0, 5000)).digest('hex');
}

function isDuplicate(url, content) {
  const dedup = loadDedup();
  const normUrl = normalizeUrl(url);
  if (url && dedup.urls[normUrl]) return { dup: true, reason: 'URL 已入库' };
  if (content) {
    const hash = contentHash(content);
    if (dedup.hashes[hash]) return { dup: true, reason: '内容重复' };
  }
  return { dup: false };
}

function markIngested(url, content, runId) {
  const dedup = loadDedup();
  if (url) dedup.urls[normalizeUrl(url)] = runId;
  if (content) dedup.hashes[contentHash(content)] = runId;
  saveDedup(dedup);
}

async function fetchRSS(url) {
  const xml = await new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'WikiBot/1.0' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        return fetchRSS(r.headers.location).then(resolve).catch(reject);
      }
      let data = ''; r.on('data', c => data += c); r.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('RSS fetch timeout')); });
  });

  const items = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1] || '';
    const link = (block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] ||
                 (block.match(/<link[^>]*href="([^"]*)"[^>]*\/?>/i) || [])[1] || '';
    const desc = (block.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i) || [])[1] || '';
    const pubDate = (block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1] || '';
    items.push({ title: title.trim(), url: link.trim(), description: stripHtml(desc).trim(), pubDate: pubDate.trim() });
  }

  // Also try Atom <entry> format
  if (!items.length) {
    const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    while ((match = entryRegex.exec(xml)) !== null) {
      const block = match[1];
      const title = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1] || '';
      const link = (block.match(/<link[^>]*href="([^"]*)"[^>]*\/?>/i) || [])[1] || '';
      const summary = (block.match(/<summary[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/summary>/i) || [])[1] || '';
      items.push({ title: title.trim(), url: link.trim(), description: stripHtml(summary).trim(), pubDate: '' });
    }
  }

  return items;
}

async function fetchWebpageLinks(url, selector) {
  const html = await new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 WikiBot/1.0' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        return fetchWebpageLinks(r.headers.location, selector).then(resolve).catch(reject);
      }
      let data = ''; r.on('data', c => data += c); r.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Webpage fetch timeout')); });
  });

  const links = [];
  const linkRegex = /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    const href = m[1];
    const title = stripHtml(m[2]).trim();
    if (href && title && href.startsWith('http') && title.length > 2) {
      links.push({ title, url: href, description: '' });
    }
  }
  return links;
}

// ── Dedup helpers (30-day rolling) ──

function pruneDedup(dedup) {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const prune = (bucket) => {
    if (!bucket || typeof bucket !== 'object') return {};
    const out = {};
    for (const k of Object.keys(bucket)) {
      const v = bucket[k];
      // Legacy entries are runId strings without timestamp — keep them (conservative).
      if (typeof v === 'object' && v && typeof v.ts === 'number') {
        if (v.ts >= cutoff) out[k] = v;
      } else {
        out[k] = v;
      }
    }
    return out;
  };
  return { urls: prune(dedup.urls), hashes: prune(dedup.hashes) };
}

// In-process serialization for autotask state files (dedup.json, history.json).
// Multiple concurrent autotask runs (scheduler + manual) all do read-modify-write;
// without this lock the latter writer would clobber the former's updates.
let __autotaskWriteLock = Promise.resolve();
function withAutotaskWriteLock(fn) {
  const next = __autotaskWriteLock.then(() => fn(), () => fn());
  __autotaskWriteLock = next.catch(() => {});
  return next;
}

function markIngestedTimed(url, content, runId) {
  return withAutotaskWriteLock(() => {
    const dedup = pruneDedup(loadDedup());
    const ts = Date.now();
    if (url) dedup.urls[normalizeUrl(url)] = { runId, ts };
    if (content) dedup.hashes[contentHash(content)] = { runId, ts };
    saveDedup(dedup);
  });
}

// ── Concurrency limiter ──

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { results[i] = await worker(items[i], i); }
      catch (e) { results[i] = { __error: e.message }; }
    }
  });
  await Promise.all(runners);
  return results;
}

// ── LLM relevance gate (qwen-turbo for cheap) ──

async function llmRelevanceGate(task, item) {
  const intent = task.intent || task.name || '';
  const styleHint = (task.preferences && task.preferences.style_hint) || '';
  const feedback = Array.isArray(task.feedback) ? task.feedback.slice(-5) : [];
  const feedbackStr = feedback.length
    ? feedback.map(f => `- ${f.action === 'keep' ? '保留' : '淘汰'}: ${f.url}${f.note ? ` // ${f.note}` : ''}`).join('\n')
    : '(无历史反馈)';

  const systemPrompt = `你是内容相关性判断助手。给定用户关注意图和一条候选条目，判断是否相关。只输出 JSON：
{"relevant": true/false, "reason": "一句话理由", "confidence": 0.0-1.0}
不要任何其他文字，不要 markdown 围栏。`;

  const userPrompt = `# 用户意图
${intent}

# 风格偏好
${styleHint || '(无)'}

# 历史反馈（最近 5 条）
${feedbackStr}

# 候选条目
标题: ${item.title || '(无)'}
摘要: ${(item.summary || '').slice(0, 500)}
来源: ${item.sourceId || 'unknown'}`;

  // Use qwen-turbo for cheap gating
  const overrides = { provider: 'bailian', model: 'qwen-turbo' };
  try {
    const raw = await Promise.race([
      callLLM(systemPrompt, userPrompt, overrides, { temperature: 0, maxTokens: 256 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('gate timeout')), 20000))
    ]);
    let cleaned = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      relevant: !!parsed.relevant,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5
    };
  } catch (e) {
    // Fail-open: treat as relevant with low confidence so we don't lose items silently
    return { relevant: true, reason: `gate_error: ${e.message}`, confidence: 0.3 };
  }
}

// ── Brief writer ──

async function generateBrief(task, keptItems, gatedOut, runDate) {
  const intent = task.intent || task.name || '';
  const itemsBySource = {};
  for (const it of keptItems) {
    const sid = it.sourceId || 'other';
    (itemsBySource[sid] = itemsBySource[sid] || []).push(it);
  }

  const systemPrompt = `你是一个简报编辑。根据用户意图和今日入库的条目，输出一份 markdown 简报。严格按以下结构：
# <任务名> · <日期>

## TL;DR
- 3-5 条最关键要点

## 按来源分组
### <source-id>
- [标题](url) — 一句话概括

严禁 emoji。用中文。不要围栏。`;

  const itemBlocks = keptItems.map(it => `- source=${it.sourceId || 'unknown'} | title=${it.title} | url=${it.url} | summary=${(it.summary || '').slice(0, 300)}`).join('\n');
  const userPrompt = `# 任务
${task.name}

# 用户意图
${intent}

# 日期
${runDate}

# 今日入库条目
${itemBlocks || '(空)'}`;

  try {
    const raw = await Promise.race([
      callLLM(systemPrompt, userPrompt, null, { temperature: 0.3, maxTokens: 2048 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('brief timeout')), 60000))
    ]);
    return String(raw || '').trim().replace(/^```(?:markdown)?\s*/i, '').replace(/\s*```$/i, '').trim();
  } catch (e) {
    // Fallback brief without LLM
    let md = `# ${task.name} · ${runDate}\n\n## TL;DR\n`;
    md += (keptItems.length ? keptItems.slice(0, 5).map(it => `- ${it.title}`).join('\n') : '- (无)') + '\n\n';
    for (const sid of Object.keys(itemsBySource)) {
      md += `## ${sid}\n`;
      for (const it of itemsBySource[sid]) {
        md += `- [${it.title}](${it.url})\n`;
      }
      md += '\n';
    }
    return md;
  }
}

async function executeAutotask(taskId, isManual = false, presetRunId = null) {
  const tasks = loadAutotasks();
  const rawTask = tasks.find(t => t.id === taskId);
  if (!rawTask) throw new Error('任务不存在');
  const task = normalizeTask(rawTask);

  const modelOverrides = (task.provider && task.model) ? { provider: task.provider, model: task.model } : null;

  const runId = presetRunId || genId('run');
  const run = {
    id: runId, taskId: task.id, taskName: task.name,
    startedAt: new Date().toISOString(), finishedAt: null,
    status: 'running',
    itemsFound: 0, itemsConsidered: 0, itemsKept: 0, itemsIngested: 0, itemsSkipped: 0,
    items: [], error: null, manual: isManual,
    sourceStatus: {},          // { sourceId: 'ok'|'error', error?: string, count?: number }
    topGatedReasons: [],
    briefPath: null,
    progress: { phase: 'fetching', current: 0, total: (task.sources || []).length, currentTitle: null }
  };

  // Serialize history.json writes under the same in-process lock so concurrent runs
  // do not clobber each other's updates. Snapshot the current run state at call time
  // so a later persistRun() does not lose intermediate updates from before this write completes.
  const persistRun = () => {
    const snapshot = JSON.parse(JSON.stringify(run));
    withAutotaskWriteLock(() => {
      try {
        const h = loadHistory();
        const i = h.findIndex(r => r.id === runId);
        if (i >= 0) h[i] = snapshot; else h.push(snapshot);
        saveHistory(h);
      } catch (e) { console.error('[AutoTask] persist run failed:', e.message); }
    });
  };
  persistRun();

  try {
    // 1. Fetch all sources in parallel
    const sources = Array.isArray(task.sources) ? task.sources : [];
    if (sources.length === 0) throw new Error('任务未配置任何 source');

    const fetchResults = await Promise.all(sources.map(async (src, idx) => {
      try {
        const { items } = await fetchSourceAdapter(src);
        run.sourceStatus[src.id] = { status: 'ok', count: items.length };
        return items.map(it => ({ ...it, sourceId: src.id }));
      } catch (e) {
        run.sourceStatus[src.id] = { status: 'error', error: e.message };
        console.warn(`[AutoTask] source ${src.id} failed: ${e.message}`);
        return [];
      } finally {
        run.progress.current = idx + 1;
        persistRun();
      }
    }));

    let items = fetchResults.flat();
    run.itemsFound = items.length;

    // 2. Dedup (cross-source by URL + content hash, plus rolling 30-day file)
    run.progress = { phase: 'dedup', current: 0, total: items.length, currentTitle: null };
    persistRun();

    const dedup = pruneDedup(loadDedup());
    saveDedup(dedup);
    const seenUrls = new Set();
    const dedupedItems = [];
    for (const it of items) {
      const nUrl = it.url ? normalizeUrl(it.url) : '';
      if (nUrl && seenUrls.has(nUrl)) continue;
      if (nUrl && dedup.urls[nUrl]) continue;
      if (nUrl) seenUrls.add(nUrl);
      dedupedItems.push(it);
    }
    items = dedupedItems;
    run.itemsConsidered = items.length;

    // 3. Keyword pre-filter
    run.progress = { phase: 'prefilter', current: 0, total: items.length, currentTitle: null };
    persistRun();

    const expanded = (task.preferences && task.preferences.expanded_keywords) || [];
    const mustExclude = (task.preferences && task.preferences.must_exclude) || [];
    const passesPrefilter = (it) => {
      const text = ((it.title || '') + ' ' + (it.summary || '')).toLowerCase();
      if (mustExclude.some(kw => kw && text.includes(String(kw).toLowerCase()))) return false;
      if (!expanded.length) return true;
      return expanded.some(kw => kw && text.includes(String(kw).toLowerCase()));
    };
    let preGateItems = items.filter(passesPrefilter);
    const preGateDropped = items.filter(it => !passesPrefilter(it));

    // Hard cap: at most 200 items go to the LLM gate per run.
    // Without this, a misconfigured/abusive feed returning thousands of items
    // would burn unbounded LLM cost. 200 is well above any realistic per-run need.
    const GATE_CANDIDATE_CAP = 200;
    let gateOverflowDropped = [];
    if (preGateItems.length > GATE_CANDIDATE_CAP) {
      gateOverflowDropped = preGateItems.slice(GATE_CANDIDATE_CAP);
      preGateItems = preGateItems.slice(0, GATE_CANDIDATE_CAP);
      console.warn(`[AutoTask] gate candidate cap hit: dropping ${gateOverflowDropped.length} items beyond ${GATE_CANDIDATE_CAP}`);
    }

    // 4. LLM relevance gate (concurrency 5)
    run.progress = { phase: 'gating', current: 0, total: preGateItems.length, currentTitle: null };
    persistRun();

    let processed = 0;
    const gateResults = await mapLimit(preGateItems, 5, async (it) => {
      const r = await llmRelevanceGate(task, it);
      processed += 1;
      run.progress.current = processed;
      run.progress.currentTitle = it.title || it.url || '';
      persistRun();
      return { item: it, gate: r };
    });

    const relevant = gateResults.filter(r => r && r.gate && r.gate.relevant);
    const gatedOut = gateResults.filter(r => r && r.gate && !r.gate.relevant);

    // Sort by confidence desc
    relevant.sort((a, b) => (b.gate.confidence || 0) - (a.gate.confidence || 0));

    const maxPerRun = task.maxPerRun || 5;
    let kept = relevant.slice(0, maxPerRun).map(r => ({ ...r.item, __gate: r.gate, __smartFill: false }));
    const overflow = relevant.slice(maxPerRun).map(r => ({ item: r.item, gate: r.gate, reason: 'over_cap' }));

    // 5. Smart Fill from past 7 days' history if sparse
    if (kept.length < Math.floor(maxPerRun / 2)) {
      try {
        const hist = loadHistory();
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const candidates = [];
        for (const h of hist) {
          if (h.taskId !== task.id) continue;
          const started = new Date(h.startedAt || 0).getTime();
          if (!started || started < weekAgo) continue;
          for (const hi of (h.items || [])) {
            // Respect both in-run seenUrls AND the persistent 30-day dedup file,
            // otherwise smart_fill could re-feed URLs already ingested in a prior run.
            const nu = hi.url ? normalizeUrl(hi.url) : '';
            if (hi.status === 'gated_out' && nu && !seenUrls.has(nu) && !dedup.urls[nu]) {
              candidates.push({
                title: hi.title,
                url: hi.url,
                summary: hi.reason || '',
                sourceId: hi.sourceId || 'smart_fill',
                publishedAt: h.startedAt,
                __gate: { confidence: 0.4, reason: 'smart_fill from past 7d' },
                __smartFill: true
              });
            }
          }
        }
        const need = Math.floor(maxPerRun / 2) - kept.length;
        kept = kept.concat(candidates.slice(0, need));
      } catch (e) {
        console.warn(`[AutoTask] smart_fill failed: ${e.message}`);
      }
    }
    run.itemsKept = kept.length;

    // Record all decisions into run.items now (pre-processing)
    const itemRecords = [];
    for (const it of kept) {
      itemRecords.push({
        title: it.title, url: it.url, sourceId: it.sourceId,
        status: it.__smartFill ? 'smart_fill_pending' : 'kept_pending',
        confidence: it.__gate.confidence, reason: it.__gate.reason,
        articlePath: null
      });
    }
    for (const g of gatedOut) {
      itemRecords.push({
        title: g.item.title, url: g.item.url, sourceId: g.item.sourceId,
        status: 'gated_out', confidence: g.gate.confidence, reason: g.gate.reason
      });
    }
    for (const o of overflow) {
      itemRecords.push({
        title: o.item.title, url: o.item.url, sourceId: o.item.sourceId,
        status: 'gated_out', confidence: o.gate.confidence, reason: 'over maxPerRun cap'
      });
    }
    for (const d of preGateDropped) {
      itemRecords.push({
        title: d.title, url: d.url, sourceId: d.sourceId,
        status: 'gated_out', reason: 'prefilter keyword mismatch'
      });
    }
    for (const d of gateOverflowDropped) {
      itemRecords.push({
        title: d.title, url: d.url, sourceId: d.sourceId,
        status: 'gated_out', reason: 'gate candidate cap exceeded'
      });
    }
    run.items = itemRecords;
    persistRun();

    // 6. Process kept items (extract + compile)
    run.progress = { phase: 'processing', current: 0, total: kept.length, currentTitle: null };
    persistRun();

    let processedIdx = 0;
    for (const item of kept) {
      run.progress.current = processedIdx;
      run.progress.currentTitle = item.title || item.url || '';
      persistRun();
      processedIdx += 1;

      // Composite key (url||title + sourceId): two pending items with empty URLs from the same source
      // would otherwise collide on the same record and one's processing result would overwrite the other's.
      const itemKey = (item.url || item.title || '') + '::' + (item.sourceId || '');
      const recIdx = itemRecords.findIndex(r => {
        if (!(r.status === 'kept_pending' || r.status === 'smart_fill_pending')) return false;
        const rKey = (r.url || r.title || '') + '::' + (r.sourceId || '');
        return rKey === itemKey;
      });
      const rec = recIdx >= 0 ? itemRecords[recIdx] : null;

      try {
        const topicDir = task.topic && task.topic !== 'auto' ? task.topic : 'general';
        const rawDir = path.join(RAW, topicDir);
        fs.mkdirSync(rawDir, { recursive: true });

        const extractedText = await extractContent('url', null, null, item.url, rawDir);

        // Content-level dedup
        if (extractedText) {
          const hash = contentHash(extractedText);
          if (dedup.hashes[hash]) {
            if (rec) { rec.status = 'skipped'; rec.reason = '内容重复'; }
            run.itemsSkipped++;
            continue;
          }
        }

        const date = new Date().toISOString().slice(0, 10);
        const slug = (item.url || item.title).replace(/https?:\/\//, '').replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-').slice(0, 40);
        const rawFilename = `${date}-${slug}.md`;
        const filePath = path.join(rawDir, rawFilename);
        const rawContent = `# Source\n\n> Source: ${item.url}\n> Title: ${item.title}\n> Collected: ${date}\n> Type: autotask\n> Task: ${task.name}\n> SourceId: ${item.sourceId || 'unknown'}${item.__smartFill ? '\n> SmartFill: yes' : ''}\n\n${extractedText}`;
        fs.writeFileSync(filePath, rawContent, 'utf-8');

        const compileTask = pushTask('autotask');
        await compileArticle(topicDir, rawFilename, filePath, compileTask, modelOverrides);

        await markIngestedTimed(item.url, extractedText, runId);

        if (rec) {
          rec.status = item.__smartFill ? 'smart_fill' : 'ingested';
          if (compileTask.created && compileTask.created.length > 0) {
            rec.articlePath = compileTask.created[0].path;
          }
        }
        run.itemsIngested++;
        indexCache.invalidate('index');
        wikiCache.invalidate();
      } catch (e) {
        if (rec) { rec.status = 'fetch_error'; rec.reason = e.message; }
      }
      persistRun();
    }

    // 7. Compute top-3 gated_out reasons (cluster by first 40 chars of reason)
    const reasonCounts = {};
    for (const r of itemRecords) {
      if (r.status === 'gated_out' && r.reason) {
        const key = String(r.reason).slice(0, 60);
        reasonCounts[key] = (reasonCounts[key] || 0) + 1;
      }
    }
    run.topGatedReasons = Object.entries(reasonCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([reason, count]) => ({ reason, count }));

    // 8. Write brief
    try {
      const runDate = new Date().toISOString().slice(0, 10);
      const keptForBrief = itemRecords.filter(r => r.status === 'ingested' || r.status === 'smart_fill');
      if (keptForBrief.length) {
        const brief = await generateBrief(task, keptForBrief, itemRecords.filter(r => r.status === 'gated_out'), runDate);
        const briefDir = path.join(WIKI, 'brief');
        fs.mkdirSync(briefDir, { recursive: true });
        const briefFile = `${runDate}-${slugify(task.name)}.md`;
        const briefPath = path.join(briefDir, briefFile);
        fs.writeFileSync(briefPath, brief, 'utf-8');
        run.briefPath = path.relative(WIKI, briefPath);
      }
    } catch (e) {
      console.warn(`[AutoTask] brief generation failed: ${e.message}`);
    }

    // 9. Status
    const anyFetchFail = Object.values(run.sourceStatus).some(s => s.status === 'error');
    const allFetchFail = sources.length > 0 && Object.values(run.sourceStatus).every(s => s.status === 'error');
    if (allFetchFail) run.status = 'error';
    else if (run.itemsIngested === 0 && (run.itemsKept > 0 || anyFetchFail)) run.status = 'partial';
    else if (run.itemsIngested > 0 && anyFetchFail) run.status = 'partial';
    else if (run.itemsIngested > 0) run.status = 'success';
    else run.status = 'partial';
  } catch (e) {
    run.status = 'error';
    run.error = e.message;
  }

  run.finishedAt = new Date().toISOString();
  run.progress = null;

  const updatedTasks = loadAutotasks();
  const tIdx = updatedTasks.findIndex(t => t.id === taskId);
  if (tIdx >= 0) {
    updatedTasks[tIdx].lastRunAt = run.finishedAt;
    updatedTasks[tIdx].lastRunStatus = run.status;
    saveAutotasks(updatedTasks);
  }

  persistRun();
  return run;
}

// ── 服务器 ──

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const params = url.searchParams;

  // 请求打点：写入 ring buffer + 结束时落 access.log
  const __reqStart = Date.now();
  const __reqRec = {
    startedAt: new Date(__reqStart).toISOString(),
    method: req.method,
    url: req.url,
    status: null,
    duration: null,
  };
  recordRequest(__reqRec);
  res.on('finish', () => {
    __reqRec.status = res.statusCode;
    __reqRec.duration = Date.now() - __reqStart;
    __diagAppend(ACCESS_LOG, `${__reqRec.startedAt} ${req.method} ${p} ${res.statusCode} ${__reqRec.duration}ms`);
  });
  res.on('close', () => {
    if (__reqRec.status == null) {
      __reqRec.status = 'aborted';
      __reqRec.duration = Date.now() - __reqStart;
      __diagAppend(ACCESS_LOG, `${__reqRec.startedAt} ${req.method} ${p} ABORTED ${__reqRec.duration}ms`);
    }
  });

  // ── Global POST/PUT body size guard (10 MB default; /api/ingest has its own 100 MB limit) ──
  if (req.method === 'POST' || req.method === 'PUT') {
    const cl = parseInt(req.headers['content-length'] || '0', 10);
    if (p !== '/api/ingest' && p !== '/api/ingest/batch' && cl > 10 * 1024 * 1024) {
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '请求体过大' }));
    }
  }

  // ── Chat API ──
  const chatMatch = p.match(/^\/api\/chat(?:\/(.*))?$/);
  if (chatMatch) {
    const chatPath = chatMatch[1] || '';

    // GET /api/chat/list
    if (chatPath === 'list' && req.method === 'GET') {
      return json(res, 200, loadChatIndex());
    }

    // POST /api/chat/new
    if (chatPath === 'new' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          const config = getFullConfig();
          const conv = {
            id: genId('conv'),
            title: '新对话',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            provider: parsed.provider || config.provider,
            model: parsed.model || config.model,
            summary: null,
            totalTokenEstimate: 0,
            messages: []
          };

          if (parsed.firstMessage) {
            saveChat(conv);
            const overrides = { provider: conv.provider, model: conv.model };
            const assistantMsg = await handleChatMessage(conv, parsed.firstMessage, overrides);

            // Auto-generate title from first exchange (non-blocking)
            (async () => {
              try {
                const titlePrompt = `根据以下对话生成一个简短的中文标题（10字以内），只返回标题文字，不要引号或其他内容：\n用户：${parsed.firstMessage}\nAI：${assistantMsg.content.slice(0, 200)}`;
                const title = await callLLM('你是一个标题生成器。', titlePrompt, overrides);
                const cleanTitle = title.trim().replace(/["""'']/g, '').slice(0, 20);
                if (cleanTitle) {
                  conv.title = cleanTitle;
                  saveChat(conv);
                  updateChatIndex(conv);
                }
              } catch {}
            })();

            return json(res, 200, { conversation: { id: conv.id, title: conv.title }, message: assistantMsg });
          } else {
            saveChat(conv);
            updateChatIndex(conv);
            return json(res, 200, { conversation: { id: conv.id, title: conv.title } });
          }
        } catch (e) { return json(res, 400, { error: e.message }); }
      });
      return;
    }

    // Routes with conversation ID: /api/chat/{id}[/...]
    const idMatch = chatPath.match(/^([^/]+)(?:\/(.*))?$/);
    if (idMatch && idMatch[1] !== 'list' && idMatch[1] !== 'new') {
      const convId = idMatch[1];
      const subPath = idMatch[2] || '';

      // GET /api/chat/:id — load conversation
      if (!subPath && req.method === 'GET') {
        const conv = loadChat(convId);
        if (!conv) return json(res, 404, { error: '对话不存在' });
        return json(res, 200, conv);
      }

      // DELETE /api/chat/:id — delete conversation
      if (!subPath && req.method === 'DELETE') {
        try { fs.unlinkSync(path.join(CHATS, `${convId}.json`)); } catch {}
        removeChatFromIndex(convId);
        return json(res, 200, { ok: true });
      }

      // PUT /api/chat/:id/title — rename
      if (subPath === 'title' && req.method === 'PUT') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          try {
            const { title } = JSON.parse(body);
            const conv = loadChat(convId);
            if (!conv) return json(res, 404, { error: '对话不存在' });
            conv.title = title;
            saveChat(conv);
            updateChatIndex(conv);
            return json(res, 200, { ok: true });
          } catch (e) { return json(res, 400, { error: e.message }); }
        });
        return;
      }

      // POST /api/chat/:id/message — send message
      if (subPath === 'message' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
          try {
            const { content } = JSON.parse(body);
            if (!content) return json(res, 400, { error: '消息不能为空' });
            const conv = loadChat(convId);
            if (!conv) return json(res, 404, { error: '对话不存在' });
            const overrides = { provider: conv.provider, model: conv.model };
            const assistantMsg = await handleChatMessage(conv, content, overrides);
            return json(res, 200, { message: assistantMsg });
          } catch (e) { return json(res, 500, { error: `对话失败: ${e.message}` }); }
        });
        return;
      }

      // POST /api/chat/:id/regenerate — regenerate last response
      if (subPath === 'regenerate' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
          try {
            const conv = loadChat(convId);
            if (!conv) return json(res, 404, { error: '对话不存在' });
            // Remove last assistant message
            if (conv.messages.length && conv.messages[conv.messages.length - 1].role === 'assistant') {
              conv.messages.pop();
            }
            // Get last user message and remove it (handleChatMessage will re-add it)
            const lastUserIdx = conv.messages.length - 1;
            if (lastUserIdx < 0 || conv.messages[lastUserIdx].role !== 'user') {
              return json(res, 400, { error: '没有用户消息' });
            }
            const lastUserContent = conv.messages[lastUserIdx].content;
            conv.messages.pop();
            const overrides = { provider: conv.provider, model: conv.model };
            const assistantMsg = await handleChatMessage(conv, lastUserContent, overrides);
            return json(res, 200, { message: assistantMsg });
          } catch (e) { return json(res, 500, { error: `重新生成失败: ${e.message}` }); }
        });
        return;
      }

      // POST /api/chat/:id/precipitate — 沉淀对话为知识
      if (subPath === 'precipitate' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
          try {
            const conv = loadChat(convId);
            if (!conv) return json(res, 404, { error: '对话不存在' });
            const parsed = body ? JSON.parse(body) : {};
            const messageIds = parsed.messageIds || [];

            // Extract messages
            let selected;
            if (messageIds.length > 0) {
              selected = conv.messages.filter(m => messageIds.includes(m.id));
              if (selected.length === 0) return json(res, 400, { error: '未找到指定消息' });
            } else {
              selected = conv.messages.filter(m => m.role === 'user' || m.role === 'assistant');
            }

            // Assemble Q&A content
            let qaContent = '';
            for (let i = 0; i < selected.length; i++) {
              const m = selected[i];
              if (m.role === 'user') {
                qaContent += `### Q: ${m.content}\n\n`;
              } else if (m.role === 'assistant') {
                qaContent += `**A:**\n\n${m.content}\n\n---\n\n`;
              }
            }

            const date = new Date().toISOString().slice(0, 10);
            const slug = (conv.title || 'chat').replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-').slice(0, 40) || 'chat';
            const filename = `${date}-${slug}.md`;
            const topicDir = 'chat-precipitate';
            const dir = path.join(RAW, topicDir);
            fs.mkdirSync(dir, { recursive: true });
            const filePath = path.join(dir, filename);

            const rawContent = `# ${conv.title || '对话'} — 沉淀\n\n> Source: 对话沉淀 (${convId})\n> Collected: ${date}\n\n${qaContent}`;
            fs.writeFileSync(filePath, rawContent, 'utf-8');

            // Compile via engine
            const task = pushTask('precipitate');
            const config = getFullConfig();
            const modelOverrides = { provider: conv.provider || config.provider, model: conv.model || config.model };
            try {
              await compileArticle(topicDir, filename, filePath, task, modelOverrides);
              if (task.status === 'done' && task.created && task.created.length > 0) {
                const article = task.created[0];
                return json(res, 200, { success: true, article: { path: article.path, title: article.title, action: 'created' }, rawPath: `${topicDir}/${filename}` });
              } else {
                return json(res, 500, { error: task.message || '编译失败' });
              }
            } catch (e) {
              return json(res, 500, { error: `沉淀失败: ${e.message}` });
            }
          } catch (e) { return json(res, 400, { error: e.message }); }
        });
        return;
      }

      // PUT /api/chat/:id/message/:msgId/mark — 标记消息元数据
      const markMatch = subPath.match(/^message\/([^/]+)\/mark$/);
      if (markMatch && req.method === 'PUT') {
        const msgId = markMatch[1];
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          try {
            const conv = loadChat(convId);
            if (!conv) return json(res, 404, { error: '对话不存在' });
            const msg = conv.messages.find(m => m.id === msgId);
            if (!msg) return json(res, 404, { error: '消息不存在' });
            const { precipitated } = JSON.parse(body);
            if (precipitated) msg.precipitated = precipitated;
            saveChat(conv);
            return json(res, 200, { ok: true });
          } catch (e) { return json(res, 400, { error: e.message }); }
        });
        return;
      }

      // DELETE /api/chat/:id/message/:msgId — delete message and all after it
      const msgMatch = subPath.match(/^message\/(.+)$/);
      if (msgMatch && req.method === 'DELETE') {
        const msgId = msgMatch[1];
        const conv = loadChat(convId);
        if (!conv) return json(res, 404, { error: '对话不存在' });
        const idx = conv.messages.findIndex(m => m.id === msgId);
        if (idx < 0) return json(res, 404, { error: '消息不存在' });
        conv.messages = conv.messages.slice(0, idx);
        conv.updatedAt = new Date().toISOString();
        saveChat(conv);
        updateChatIndex(conv);
        return json(res, 200, { ok: true });
      }
    }
  }

  // API 路由
  if (p === '/api/wiki/tree') return json(res, 200, tree(WIKI).map(t => ({ ...t, children: t.children.filter(c => c.file !== 'index.md' && c.file !== 'log.md') })).filter(t => t.children.length > 0));

  if (p === '/api/wiki/article') {
    // PUT — 编辑保存
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { path: relPath, content } = JSON.parse(body);
          const fp = safe(WIKI, relPath);
          if (!fp) return json(res, 400, { error: '无效路径' });
          fs.writeFileSync(fp, content, 'utf-8');
          return json(res, 200, { ok: true });
        } catch (e) { return json(res, 400, { error: e.message }); }
      });
      return;
    }
    // POST — 新建文章
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { path: relPath, content } = JSON.parse(body);
          const fp = safe(WIKI, relPath);
          if (!fp) return json(res, 400, { error: '无效路径' });
          fs.mkdirSync(path.dirname(fp), { recursive: true });
          fs.writeFileSync(fp, content, 'utf-8');
          return json(res, 200, { ok: true, path: relPath });
        } catch (e) { return json(res, 400, { error: e.message }); }
      });
      return;
    }
    // DELETE — 删除文章
    if (req.method === 'DELETE') {
      const relPath = params.get('path');
      const fp = safe(WIKI, relPath);
      if (!fp) return json(res, 400, { error: '无效路径' });
      try {
        fs.unlinkSync(fp);
        // Remove from index.md
        const indexPath = path.join(WIKI, 'index.md');
        try {
          let idx = fs.readFileSync(indexPath, 'utf-8');
          const lines = idx.split('\n');
          const filtered = lines.filter(l => !l.includes(`(${relPath})`) && !l.includes(`(${relPath.replace(/^.*?\//, '')})`) );
          fs.writeFileSync(indexPath, filtered.join('\n'), 'utf-8');
        } catch {}
        // Remove empty topic directory
        try { const dir = path.dirname(fp); if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {}
        return json(res, 200, { ok: true });
      } catch { return json(res, 404, { error: '文件不存在' }); }
    }
    // GET — 读取文章（原逻辑）
    const fp = safe(WIKI, params.get('path'));
    if (!fp) return json(res, 400, { error: '无效路径' });
    try { return json(res, 200, { content: fs.readFileSync(fp, 'utf-8') }); }
    catch { return json(res, 404, { error: '文件不存在' }); }
  }

  if (p === '/api/wiki/index') {
    try { return json(res, 200, { content: fs.readFileSync(path.join(WIKI, 'index.md'), 'utf-8') }); }
    catch { return json(res, 404, { error: 'index.md 不存在' }); }
  }

  if (p === '/api/wiki/log') {
    try { return json(res, 200, { content: fs.readFileSync(path.join(WIKI, 'log.md'), 'utf-8') }); }
    catch { return json(res, 404, { error: 'log.md 不存在' }); }
  }

  if (p === '/api/wiki/graph/keywords') {
    const excluded = new Set(['index.md', 'log.md']);
    const allFiles = walkMd(WIKI).filter(f => !excluded.has(path.basename(f)));
    const kwArticles = {};
    for (const f of allFiles) {
      const rel = path.relative(WIKI, f);
      // 优先用 LLM 生成的 tags；老文章没 tags 时用 extractKeywords 兜底
      const tags = extractTags(f);
      const kws = tags.length > 0 ? tags : [...extractKeywords(f)];
      for (const w of kws) {
        if (!kwArticles[w]) kwArticles[w] = [];
        kwArticles[w].push(rel);
      }
    }
    let minCount = 2;
    let filtered = Object.entries(kwArticles).filter(([, a]) => a.length >= minCount);
    if (filtered.length < 10) {
      minCount = 1;
      filtered = Object.entries(kwArticles).filter(([, a]) => a.length >= minCount);
    }
    const nodes = filtered.map(([word, articles]) => ({
      id: 'kw_' + word, type: 'keyword', label: word, count: articles.length, articles
    }));
    const edges = [];
    const edgeSet = new Set();
    for (let i = 0; i < filtered.length; i++) {
      const [w1, arts1] = filtered[i];
      const set1 = new Set(arts1);
      for (let j = i + 1; j < filtered.length; j++) {
        const [w2, arts2] = filtered[j];
        const shared = arts2.filter(a => set1.has(a));
        if (shared.length > 0) {
          const key = w1 < w2 ? w1 + '|' + w2 : w2 + '|' + w1;
          if (!edgeSet.has(key)) {
            edgeSet.add(key);
            edges.push({ source: 'kw_' + w1, target: 'kw_' + w2, weight: Math.round(shared.length / Math.min(arts1.length, arts2.length) * 100) / 100, sharedArticles: shared });
          }
        }
      }
    }
    return json(res, 200, { nodes, edges });
  }

  if (p === '/api/wiki/graph') {
    const excluded = new Set(['index.md', 'log.md']);
    const allFiles = walkMd(WIKI).filter(f => !excluded.has(path.basename(f)));
    const nodes = [];
    const edges = [];
    const edgeSet = new Set();

    for (const f of allFiles) {
      const rel = path.relative(WIKI, f);
      const parts = rel.split(path.sep);
      const topic = parts.length > 1 ? parts[0] : '';
      const title = extractTitle(f);
      const tags = extractTags(f);
      // 图谱节点显示的标签：优先用 LLM 生成的 tags[0]；老文章走兜底 regex 切词
      let keyword;
      if (tags.length > 0) {
        keyword = tags[0];
      } else {
        const genericKw = new Set(['概述', '总结', '背景', '简介', '引言', '正文', '结论', '附录', '参考', '说明', '定义', '目标', '方法', '结果', '讨论', '核心', '架构', '总览']);
        const cnSegments = title.split(/[^一-\u9fff]+|[与和的及或从到在]+/).filter(s => s.length >= 2);
        const prefixChars = '非不无多';
        const titleKw = cnSegments.map(s => {
          if (s.length <= 4) return s;
          return (s.length >= 3 && prefixChars.includes(s[0])) ? s.slice(0, 3) : s.slice(0, 2);
        }).filter(w => !genericKw.has(w));
        const kwArr = [...extractKeywords(f)];
        const bodyKw = kwArr.filter(w => !genericKw.has(w) && w.length >= 2 && w.length <= 4 && !/^[a-z]{1,3}$/i.test(w));
        keyword = titleKw[0] || bodyKw[0] || title.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '').slice(0, 4) || topic;
      }
      nodes.push({ id: rel, name: title, topic, keyword, tags });

      // Read file content to distinguish See Also links from inline references
      let content = '';
      try { content = fs.readFileSync(f, 'utf-8'); } catch { continue; }
      const lines = content.split('\n');

      // Find See Also section start
      let seeAlsoStart = -1;
      for (let i = 0; i < lines.length; i++) {
        if (/^##\s+See\s+Also/i.test(lines[i])) { seeAlsoStart = i; break; }
      }

      const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
      for (let i = 0; i < lines.length; i++) {
        let m;
        while ((m = linkRe.exec(lines[i])) !== null) {
          const linkPath = m[2];
          // Skip external URLs
          if (/^https?:\/\//.test(linkPath)) continue;
          // Skip raw/ links
          if (/(?:^|\/)raw\//.test(linkPath)) continue;
          // Only .md files
          if (!linkPath.endsWith('.md')) continue;

          const resolved = resolveLink(f, linkPath);
          if (!resolved) continue;
          if (excluded.has(path.basename(resolved))) continue;

          const key = `${rel}|${resolved}`;
          if (edgeSet.has(key)) continue;
          edgeSet.add(key);

          const edgeType = (seeAlsoStart >= 0 && i > seeAlsoStart) ? 'see-also' : 'reference';
          edges.push({ source: rel, target: resolved, type: edgeType });
        }
      }
    }

    // Layer 2: tag 共现边 — 两篇文章若共享至少 1 个 tag 则连边
    // 权重由 IDF 打分：稀有 tag 权重高；全部通过"过宽泛"tag（>50% 文章覆盖）连起来的丢弃
    const totalArticles = nodes.length || 1;
    const tagFreq = {};
    for (const n of nodes) for (const t of (n.tags || [])) tagFreq[t] = (tagFreq[t] || 0) + 1;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      if (!a.tags || !a.tags.length) continue;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        if (!b.tags || !b.tags.length) continue;
        const shared = a.tags.filter(t => b.tags.includes(t));
        if (!shared.length) continue;
        const allTooCommon = shared.every(t => (tagFreq[t] || 0) / totalArticles > 0.5);
        if (allTooCommon) continue;
        const key = `${a.id}|${b.id}`;
        const keyRev = `${b.id}|${a.id}`;
        if (edgeSet.has(key) || edgeSet.has(keyRev)) continue;
        edgeSet.add(key);
        const idf = shared.reduce((s, t) => s + Math.log((totalArticles + 1) / ((tagFreq[t] || 1) + 1)), 0);
        const weight = Math.min(0.9, 0.25 + idf * 0.15);
        edges.push({ source: a.id, target: b.id, type: 'tag', weight, keywords: shared.slice(0, 5) });
      }
    }

    return json(res, 200, { nodes, edges });
  }

  if (p === '/api/wiki/stats') {
    const excluded = new Set(['index.md', 'log.md']);
    const allFiles = walkMd(WIKI).filter(f => !excluded.has(path.basename(f)));
    const rawFiles = walkMd(RAW);
    const topics = new Set();
    for (const d of (fs.existsSync(WIKI) ? fs.readdirSync(WIKI, { withFileTypes: true }) : [])) {
      if (d.isDirectory() && !d.name.startsWith('.')) topics.add(d.name);
    }

    // Count connections: walk all files and count resolved wiki-internal links
    let connections = 0;
    for (const f of allFiles) {
      let content = '';
      try { content = fs.readFileSync(f, 'utf-8'); } catch { continue; }
      const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
      let m;
      while ((m = linkRe.exec(content)) !== null) {
        const linkPath = m[2];
        if (/^https?:\/\//.test(linkPath)) continue;
        if (/(?:^|\/)raw\//.test(linkPath)) continue;
        if (!linkPath.endsWith('.md')) continue;
        const resolved = resolveLink(f, linkPath);
        if (resolved && !excluded.has(path.basename(resolved))) connections++;
      }
    }

    // Parse lastUpdate from log.md
    let lastUpdate = '';
    try {
      const logContent = fs.readFileSync(path.join(WIKI, 'log.md'), 'utf-8');
      const dateRe = /^## \[(\d{4}-\d{2}-\d{2})\]/gm;
      let dm;
      while ((dm = dateRe.exec(logContent)) !== null) {
        if (!lastUpdate || dm[1] > lastUpdate) lastUpdate = dm[1];
      }
    } catch {}

    return json(res, 200, { articles: allFiles.length, sources: rawFiles.length, connections, topics: topics.size, lastUpdate: lastUpdate || '' });
  }

  if (p === '/api/wiki/backlinks') {
    const target = params.get('path');
    if (!target) return json(res, 400, { error: '缺少 path 参数' });

    const excluded = new Set(['index.md', 'log.md']);
    const allFiles = walkMd(WIKI).filter(f => !excluded.has(path.basename(f)));
    const backlinks = [];
    for (const f of allFiles) {
      const rel = path.relative(WIKI, f);
      if (rel === target) continue;
      let content = '';
      try { content = fs.readFileSync(f, 'utf-8'); } catch { continue; }
      const lines = content.split('\n');
      for (const line of lines) {
        const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
        let m;
        let found = false;
        while ((m = linkRe.exec(line)) !== null) {
          const linkPath = m[2];
          if (/^https?:\/\//.test(linkPath)) continue;
          if (!linkPath.endsWith('.md')) continue;
          const resolved = resolveLink(f, linkPath);
          if (resolved === target) {
            backlinks.push({ name: extractTitle(f), path: rel, context: line.trim() });
            found = true;
            break;
          }
        }
        if (found) break;
      }
    }

    return json(res, 200, { backlinks });
  }

  if (p === '/api/wiki/recent') {
    const logPath = path.join(WIKI, 'log.md');
    const entries = [];
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf-8');
      const lines = content.split('\n');
      const headRe = /^## \[(\d{4}-\d{2}-\d{2})\]\s+(\w+)\s*\|\s*(.+)$/;
      let current = null;
      for (const line of lines) {
        const hm = headRe.exec(line);
        if (hm) {
          if (current) entries.push(current);
          current = { date: hm[1], type: hm[2], title: hm[3].trim(), details: [] };
        } else if (current && /^\s*-\s+/.test(line)) {
          current.details.push(line.replace(/^\s*-\s+/, '').trim());
        }
      }
      if (current) entries.push(current);
    }
    return json(res, 200, { entries: entries.reverse() });
  }

  if (p === '/api/wiki/toc') {
    const fp = safe(WIKI, params.get('path'));
    if (!fp) return json(res, 400, { error: '无效路径' });
    try {
      const content = fs.readFileSync(fp, 'utf-8');
      const lines = content.split('\n');
      const toc = [];
      let inCodeBlock = false;
      for (const line of lines) {
        if (line.trimStart().startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
        if (inCodeBlock) continue;
        const m = line.match(/^(#{1,4})\s+(.+)/);
        if (m) {
          const text = m[2].trim();
          const id = text.replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '');
          toc.push({ level: m[1].length, text, id });
        }
      }
      const plainText = content.replace(/```[\s\S]*?```/g, '').replace(/[#*_`>\[\]\(\)!|~-]/g, '').replace(/\s+/g, '');
      const wordCount = plainText.length;
      const readingTime = Math.ceil(wordCount / 300);
      return json(res, 200, { toc, wordCount, readingTime });
    } catch { return json(res, 404, { error: '文件不存在' }); }
  }

  if (p === '/api/wiki/article-meta') {
    const relPath = params.get('path');
    const fp = safe(WIKI, relPath);
    if (!fp) return json(res, 400, { error: '无效路径' });
    try {
      const stat = fs.statSync(fp);
      const content = fs.readFileSync(fp, 'utf-8');
      const title = extractTitle(fp);
      const plainText = content.replace(/```[\s\S]*?```/g, '').replace(/[#*_`>\[\]\(\)!|~-]/g, '').replace(/\s+/g, '');
      const wordCount = plainText.length;
      const stale = (Date.now() - stat.mtime.getTime()) > 30 * 24 * 60 * 60 * 1000;
      return json(res, 200, { title, created: stat.birthtime.toISOString(), modified: stat.mtime.toISOString(), wordCount, stale });
    } catch { return json(res, 404, { error: '文件不存在' }); }
  }

  if (p === '/api/wiki/keywords') {
    const excluded = new Set(['index.md', 'log.md']);
    const allFiles = walkMd(WIKI).filter(f => !excluded.has(path.basename(f)));
    const freq = {};
    for (const f of allFiles) {
      const rel = path.relative(WIKI, f);
      // 优先用 LLM tags；老文章兜底
      const tags = extractTags(f);
      const kw = tags.length > 0 ? tags : [...extractKeywords(f)];
      for (const w of kw) {
        if (!freq[w]) freq[w] = { word: w, count: 0, articles: [] };
        freq[w].count++;
        freq[w].articles.push(rel);
      }
    }
    const keywords = Object.values(freq).sort((a, b) => b.count - a.count).slice(0, 30);
    return json(res, 200, { keywords });
  }

  // 批量回填旧文章的 tags — 启动（异步）
  if (p === '/api/wiki/backfill-tags' && req.method === 'POST') {
    if (backfillProgress.running) {
      return json(res, 409, { error: '已有回填任务在进行中', progress: backfillProgress });
    }
    runBackfillTags().catch(e => {
      backfillProgress.running = false;
      backfillProgress.error = e.message;
    });
    return json(res, 200, { ok: true, message: '已启动', progress: backfillProgress });
  }
  // 回填进度查询
  if (p === '/api/wiki/backfill-tags' && req.method === 'GET') {
    return json(res, 200, backfillProgress);
  }

  if (p === '/api/wiki/search-suggest') {
    const q = (params.get('q') || '').toLowerCase();
    if (!q) return json(res, 400, { error: '缺少 q 参数' });
    const allFiles = walkMd(WIKI);
    const excluded = new Set(['index.md', 'log.md']);
    const suggestions = [];
    for (const f of allFiles) {
      if (excluded.has(path.basename(f))) continue;
      const rel = path.relative(WIKI, f);
      const title = extractTitle(f);
      if (title.toLowerCase().includes(q)) {
        const parts = rel.split('/');
        suggestions.push({ title, path: rel, topic: parts.length > 1 ? parts[0] : '' });
      }
      if (suggestions.length >= 8) break;
    }
    return json(res, 200, { suggestions });
  }

  if (p === '/api/raw/tree') return json(res, 200, tree(RAW));

  if (p === '/api/raw/file') {
    const fp = safe(RAW, params.get('path'));
    if (!fp) return json(res, 400, { error: '无效路径' });
    try { return json(res, 200, { content: fs.readFileSync(fp, 'utf-8') }); }
    catch { return json(res, 404, { error: '文件不存在' }); }
  }

  if (p === '/api/search') {
    const q = params.get('q');
    if (!q || q.length < 1) return json(res, 400, { error: '搜索词不能为空' });
    return json(res, 200, searchWiki(q));
  }

  if (p === '/api/ingest/extract-zip' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let zipPath, tmpDir;
      try {
        const { data } = JSON.parse(body); // base64 encoded zip
        tmpDir = path.join(os.tmpdir(), 'wiki-zip-' + crypto.randomBytes(8).toString('hex'));
        zipPath = tmpDir + '.zip';
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(zipPath, Buffer.from(data, 'base64'));
        const unzipResult = spawnSync('unzip', ['-o', zipPath, '-d', tmpDir], { stdio: 'pipe' });
        if (unzipResult.status !== 0) throw new Error('ZIP 解压失败: ' + (unzipResult.stderr ? unzipResult.stderr.toString().slice(0, 200) : 'unzip failed'));
        const files = [];
        function walkDir(dir) {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
            const full = path.join(dir, entry.name);
            if (!path.resolve(full).startsWith(path.resolve(tmpDir))) continue; // path traversal guard
            if (entry.isDirectory()) { walkDir(full); continue; }
            if (/\.(md|txt|html|json|csv|xml)$/i.test(entry.name)) {
              const content = fs.readFileSync(full, 'utf-8');
              files.push({ name: entry.name, content });
            }
          }
        }
        walkDir(tmpDir);
        return json(res, 200, { files });
      } catch (e) { return json(res, 400, { error: e.message }); } finally {
        try { if (zipPath) fs.unlinkSync(zipPath); } catch {}
        try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    });
    return;
  }

  if (p === '/api/ingest' && req.method === 'POST') {
    // 全局并发池：所有 task 走 enqueueTask → tryDispatch
    const chunks = [];
    let totalSize = 0;
    const MAX_BODY = 100 * 1024 * 1024;
    req.on('data', c => { totalSize += c.length; if (totalSize <= MAX_BODY) chunks.push(c); });
    req.on('end', () => {
      if (totalSize > MAX_BODY) return json(res, 413, { error: '请求体过大，最大支持 100MB' });
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        const parsed = JSON.parse(body);
        const items = parsed.items || [{
          type: parsed.type, content: parsed.content, topic: parsed.topic,
          filename: parsed.filename, url: parsed.url
        }];
        const modelOverrides = (parsed.provider && parsed.model) ? { provider: parsed.provider, model: parsed.model } : null;
        const batchId = items.length > 1 ? genTaskId() : null;

        const tasks = items.map((item, i) => {
          const name = item.name || item.filename || (item.content ? item.content.slice(0, 40) : '') || (item.url || 'ingest');
          return enqueueTask(
            {
              type: item.type,
              content: item.content,
              topic: item.topic,
              filename: item.filename,
              url: item.url,
              modelOverrides,
            },
            { kind: item.type, name, batchId, batchIndex: i }
          );
        });

        json(res, 200, {
          taskId: tasks[0] ? tasks[0].id : 'unknown',
          taskIds: tasks.map(t => t.id),
          batch: !!batchId,
          batchId,
        });
      } catch (e) { json(res, 400, { error: e.message }); }
    });
    return;
  }

  if (p === '/api/ingest/status') {
    // 支持 ?id=xxx 精确查询某个任务；否则返回最新
    const reqId = url.searchParams.get('id');
    const task = reqId ? taskQueue.find(t => t.id === reqId) : latestTask();
    if (!task) return json(res, 200, { status: 'idle' });
    const resp = { id: task.id, status: externalStatus(task.status), message: task.message };
    if (task.stages) resp.stages = task.stages;
    if (task.created) {
      resp.created = task.created;
      if (task.created.length > 0) resp.article = task.created[0];
    }
    return json(res, 200, resp);
  }

  // 所有当前 pending/processing + 最近 30s 内完成的任务（便于前端展示/收尾）
  if (p === '/api/ingest/active') {
    const now = Date.now();
    const items = taskQueue.filter(t => {
      if (t.status === 'pending' || t.status === 'processing') return true;
      if (['done', 'error', 'partial'].includes(t.status)) {
        const ts = t.finishedAt ? new Date(t.finishedAt).getTime()
          : (t.startedAt ? new Date(t.startedAt).getTime() : 0);
        return (now - ts) < 30000;
      }
      return false;
    }).map(t => ({
      id: t.id,
      status: externalStatus(t.status),
      message: t.message,
      stages: t.stages || [],
      article: t.created && t.created.length > 0 ? t.created[0] : null,
      type: t.type,
      startedAt: t.startedAt
    }));
    return json(res, 200, { items });
  }

  if (p === '/api/ingest/batch/status') {
    const reqId = url.searchParams.get('id') || findLatestBatchId();
    if (!reqId) return json(res, 200, { status: 'idle' });
    const summary = getBatchSummary(reqId);
    if (!summary) return json(res, 200, { status: 'idle' });
    return json(res, 200, summary);
  }

  // 投喂队列总览：running / queued / recent / batch 汇总，供 topbar 入口使用
  if (p === '/api/ingest/overview') {
    const running = taskQueue.filter(t => t.status === 'processing').map(t => ({
      id: t.id,
      name: t.name,
      stage: t.phaseLabel || t.message || '',
      kind: t.kind || t.type,
      startedAt: t.startedAt,
      status: 'running',
      batchId: t.batchId,
      phase: t.phase || 'compiling',
      phaseIndex: typeof t.phaseIndex === 'number' ? t.phaseIndex : 3,
      phaseTotal: t.phaseTotal || PHASE_TOTAL,
      phaseLabel: t.phaseLabel || 'AI 编译',
    }));
    const queued = taskQueue.filter(t => t.status === 'pending').map(t => ({
      id: t.id,
      name: t.name,
      kind: t.kind || t.type,
      status: 'queued',
      batchId: t.batchId,
      phase: 'queued',
      phaseIndex: 0,
      phaseTotal: PHASE_TOTAL,
      phaseLabel: '排队中',
    }));
    const recent = taskQueue
      .filter(t => ['done', 'error', 'partial'].includes(t.status))
      .slice()
      .sort((a, b) => new Date(b.finishedAt || 0) - new Date(a.finishedAt || 0))
      .slice(0, 20)
      .map(t => {
        const firstCreated = t.created && t.created.length > 0 ? t.created[0] : null;
        const articlePath = (firstCreated && typeof firstCreated === 'object') ? firstCreated.path : firstCreated;
        const displayName = (typeof articlePath === 'string' && articlePath)
          ? path.basename(articlePath, '.md')
          : (t.name || t.kind || t.type || 'ingest');
        return {
          id: t.id,
          status: t.status === 'partial' ? 'done' : t.status,
          name: displayName,
          article: articlePath,
          error: t.status === 'error' ? (t.message || '').slice(0, 200) : null,
          kind: t.kind || t.type,
          finishedAt: t.finishedAt,
          retryable: !!t.retryable && !!t.payload,
          interruptedByRestart: !!t.interruptedByRestart,
          retryOf: t.retryOf || null,
          retryCount: t.retryCount || 0,
        };
      });

    const latestBatchId = findLatestBatchId();
    let batch = null;
    if (latestBatchId) {
      const s = getBatchSummary(latestBatchId);
      if (s && s.status === 'processing') batch = s;
    }
    const hasActivity = !!(running.length > 0 || queued.length > 0 || (batch && batch.status === 'processing'));
    return json(res, 200, { running, queued, recent, batch, hasActivity, phaseTotal: PHASE_TOTAL });
  }

  // POST /api/ingest/retry/:id —— 根据原任务的 payload 重新入队
  if (p.startsWith('/api/ingest/retry/') && req.method === 'POST') {
    const oldId = p.slice('/api/ingest/retry/'.length);
    const orig = taskQueue.find(t => t.id === oldId);
    if (!orig) return json(res, 404, { error: '任务不存在' });
    if (!orig.payload) {
      return json(res, 400, {
        error: orig.kind === 'autotask'
          ? '自动任务无法从队列重试，请到自动任务页重新执行'
          : '该任务缺少重试所需的原始载荷（可能是大文件投喂，重启后不可重试）'
      });
    }
    if (orig.payload._contentStripped) {
      return json(res, 400, { error: '该任务是大文件投喂，原始内容未持久化，无法重试' });
    }
    const newTask = enqueueTask(orig.payload, {
      kind: orig.kind || orig.type,
      name: orig.name,
      batchId: null,
      retryOf: orig.id,
      retryCount: (orig.retryCount || 0) + 1,
    });
    return json(res, 200, {
      taskId: newTask.id,
      retryOf: orig.id,
      retryCount: newTask.retryCount,
    });
  }

  // GET /api/ingest/queue/all —— 完整历史（查看 + 管理用）
  if (p === '/api/ingest/queue/all') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
    const items = taskQueue
      .slice()
      .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0))
      .slice(0, limit)
      .map(t => ({
        id: t.id,
        name: t.name,
        kind: t.kind || t.type,
        status: externalStatus(t.status),
        rawStatus: t.status,
        phase: t.phase || null,
        phaseIndex: typeof t.phaseIndex === 'number' ? t.phaseIndex : null,
        phaseTotal: t.phaseTotal || PHASE_TOTAL,
        phaseLabel: t.phaseLabel || null,
        message: t.message || '',
        submittedAt: t.submittedAt,
        startedAt: t.startedAt,
        finishedAt: t.finishedAt,
        batchId: t.batchId || null,
        error: t.status === 'error' ? (t.message || '').slice(0, 300) : null,
        retryable: !!t.retryable && !!t.payload && !t.payload._contentStripped,
        retryOf: t.retryOf || null,
        retryCount: t.retryCount || 0,
        interruptedByRestart: !!t.interruptedByRestart,
        article: t.created && t.created.length > 0
          ? (typeof t.created[0] === 'object' ? t.created[0].path : t.created[0])
          : null,
      }));
    return json(res, 200, { items, total: taskQueue.length });
  }

  if (p === '/api/tasks') {
    return json(res, 200, taskQueue.slice(-20));
  }

  // POST /api/wiki/query — Wiki Chat
  if (p === '/api/wiki/query' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { question } = JSON.parse(body);
        if (!question) return json(res, 400, { error: '缺少 question 参数' });
        const answer = await queryWiki(question);
        return json(res, 200, { answer });
      } catch (e) {
        return json(res, 500, { error: `查询失败: ${e.message}` });
      }
    });
    return;
  }

  // ── runLint: 综合健康检查 ──
  function runLint() {
    try {
      const excluded = new Set(['index.md', 'log.md']);
      const allFiles = walkMd(WIKI).filter(f => !excluded.has(path.basename(f)));
      const allRels = new Set(allFiles.map(f => path.relative(WIKI, f)));

      // Read index.md to check which articles are listed
      let indexContent = '';
      try { indexContent = fs.readFileSync(path.join(WIKI, 'index.md'), 'utf-8'); } catch {}
      const indexLinked = new Set();
      const indexLinkRe = /\[([^\]]*)\]\(([^)]+\.md)\)/g;
      let im;
      while ((im = indexLinkRe.exec(indexContent)) !== null) {
        const resolved = resolveLink(path.join(WIKI, 'index.md'), im[2]);
        if (resolved) indexLinked.add(resolved);
      }

      // Build inbound link map
      const inboundMap = {};
      for (const rel of allRels) inboundMap[rel] = [];
      let totalConnections = 0;

      const issues = [];
      const now = Date.now();
      const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
      let totalWords = 0;
      let freshCount = 0;
      let linkedCount = 0;
      let lastUpdate = null;

      for (const f of allFiles) {
        const rel = path.relative(WIKI, f);
        try {
          const links = extractLinks(f);
          for (const link of links) {
            const target = resolveLink(f, link);
            if (!target) continue;
            if (excluded.has(path.basename(target))) continue;
            if (!allRels.has(target)) {
              issues.push({ type: 'broken_link', severity: 'error', path: rel, message: '链接目标不存在: ' + link });
            } else {
              if (inboundMap[target]) inboundMap[target].push(rel);
              totalConnections++;
            }
          }
          if (links.length > 0) linkedCount++;
        } catch {}

        // Word count
        try {
          const c = fs.readFileSync(f, 'utf-8').replace(/```[\s\S]*?```/g, '').replace(/[#*_`>\[\]\(\)!|~-]/g, '').replace(/\s+/g, '');
          totalWords += c.length;
        } catch {}

        // Stale detection: parse Updated/Modified from first 10 lines
        try {
          const content = fs.readFileSync(f, 'utf-8');
          const first10 = content.split('\n').slice(0, 10).join('\n');
          const dateMatch = first10.match(/(?:Updated|Modified)\s*[:：]\s*(\d{4}[-/]\d{2}[-/]\d{2})/i);
          if (dateMatch) {
            const artDate = new Date(dateMatch[1].replace(/\//g, '-'));
            if (!isNaN(artDate.getTime())) {
              if (!lastUpdate || artDate > lastUpdate) lastUpdate = artDate;
              if (now - artDate.getTime() > THIRTY_DAYS) {
                issues.push({ type: 'stale', severity: 'info', path: rel, message: '超过 30 天未更新' });
              } else {
                freshCount++;
              }
            } else { freshCount++; } // Can't parse date, assume fresh
          } else {
            // No date field — use file mtime
            const stat = fs.statSync(f);
            if (!lastUpdate || stat.mtime > lastUpdate) lastUpdate = stat.mtime;
            if (now - stat.mtime.getTime() > THIRTY_DAYS) {
              issues.push({ type: 'stale', severity: 'info', path: rel, message: '超过 30 天未更新' });
            } else {
              freshCount++;
            }
          }
        } catch { freshCount++; }
      }

      // Orphan + missing from index
      for (const rel of allRels) {
        if ((inboundMap[rel] || []).length === 0) {
          issues.push({ type: 'orphan', severity: 'warning', path: rel, message: '无入站链接' });
        }
        if (!indexLinked.has(rel)) {
          issues.push({ type: 'missing_index', severity: 'error', path: rel, message: '未在 index.md 中列出' });
        }
      }

      // Mergeable detection: keyword overlap within same topic
      const kwCache = {};
      for (const f of allFiles) {
        const rel = path.relative(WIKI, f);
        try { kwCache[rel] = extractKeywords(f); } catch { kwCache[rel] = new Set(); }
      }
      const topics = {};
      for (const rel of allRels) {
        const parts = rel.split(path.sep);
        const topic = parts.length > 1 ? parts[0] : '_root';
        if (!topics[topic]) topics[topic] = [];
        topics[topic].push(rel);
      }
      for (const topic of Object.keys(topics)) {
        const arts = topics[topic];
        for (let i = 0; i < arts.length; i++) {
          for (let j = i + 1; j < arts.length; j++) {
            const kwA = kwCache[arts[i]] || new Set();
            const kwB = kwCache[arts[j]] || new Set();
            if (kwA.size === 0 || kwB.size === 0) continue;
            let overlap = 0;
            for (const w of kwA) { if (kwB.has(w)) overlap++; }
            const minSize = Math.min(kwA.size, kwB.size);
            if (minSize > 0) {
              const pct = Math.round(overlap / minSize * 100);
              if (pct > 60) {
                issues.push({ type: 'mergeable', severity: 'info', paths: [arts[i], arts[j]], message: '关键词重叠度 ' + pct + '%，建议合并' });
              }
            }
          }
        }
      }

      // Raw files
      const rawFiles = walkMd(RAW);

      // Score calculation
      const totalArticles = allRels.size;
      const completeness = totalArticles > 0 ? Math.round(linkedCount / totalArticles * 100) : 0;
      const freshness = totalArticles > 0 ? Math.round(freshCount / totalArticles * 100) : 0;
      const avgInbound = totalArticles > 0 ? totalConnections / totalArticles : 0;
      const connectivity = Math.min(100, Math.round(avgInbound / 3 * 100));
      const issueCount = issues.filter(i => i.severity === 'error' || i.severity === 'warning').length;
      const consistency = totalArticles > 0 ? Math.round(Math.max(0, (totalArticles - issueCount) / totalArticles * 100)) : 0;
      const score = Math.round((completeness + freshness + connectivity + consistency) / 4);

      return {
        timestamp: new Date().toISOString(),
        score,
        summary: {
          totalArticles,
          totalRaw: rawFiles.length,
          totalWords,
          totalConnections,
          lastUpdate: lastUpdate ? lastUpdate.toISOString() : null
        },
        issues,
        scoreBreakdown: { completeness, freshness, connectivity, consistency }
      };
    } catch (e) {
      return { timestamp: new Date().toISOString(), score: 0, summary: { totalArticles: 0, totalRaw: 0, totalWords: 0, totalConnections: 0, lastUpdate: null }, issues: [{ type: 'error', severity: 'error', path: '', message: '检查失败: ' + e.message }], scoreBreakdown: { completeness: 0, freshness: 0, connectivity: 0, consistency: 0 } };
    }
  }

  // ── 报告存储 ──
  const REPORTS_DIR = path.join(ROOT, 'data', 'reports');

  function ensureReportsDir() {
    if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  function saveLintReport(report) {
    ensureReportsDir();
    const dateStr = report.timestamp.slice(0, 10);
    fs.writeFileSync(path.join(REPORTS_DIR, 'lint-' + dateStr + '.json'), JSON.stringify(report, null, 2), 'utf-8');
    // 清理旧报告，保留最近 30 份
    try {
      const files = fs.readdirSync(REPORTS_DIR).filter(f => f.startsWith('lint-') && f.endsWith('.json')).sort().reverse();
      for (let i = 30; i < files.length; i++) {
        try { fs.unlinkSync(path.join(REPORTS_DIR, files[i])); } catch {}
      }
    } catch {}
  }

  function runAndSaveLint() {
    const report = runLint();
    saveLintReport(report);
    return report;
  }

  // GET /api/wiki/lint — 即时健康检查
  if (p === '/api/wiki/lint') {
    return json(res, 200, runLint());
  }

  // GET /api/reports/list — 报告列表
  if (p === '/api/reports/list') {
    ensureReportsDir();
    try {
      const files = fs.readdirSync(REPORTS_DIR).filter(f => f.startsWith('lint-') && f.endsWith('.json')).sort().reverse();
      return json(res, 200, { files });
    } catch { return json(res, 200, { files: [] }); }
  }

  // GET /api/reports/latest — 最新报告
  if (p === '/api/reports/latest') {
    ensureReportsDir();
    try {
      const files = fs.readdirSync(REPORTS_DIR).filter(f => f.startsWith('lint-') && f.endsWith('.json')).sort().reverse();
      if (files.length === 0) {
        // 没有历史报告，即时生成一份
        const report = runAndSaveLint();
        return json(res, 200, report);
      }
      const content = fs.readFileSync(path.join(REPORTS_DIR, files[0]), 'utf-8');
      return json(res, 200, JSON.parse(content));
    } catch (e) { return json(res, 500, { error: '读取报告失败: ' + e.message }); }
  }

  // GET /api/reports/:date — 指定日期报告
  if (p.startsWith('/api/reports/') && p !== '/api/reports/list' && p !== '/api/reports/latest') {
    const date = p.slice('/api/reports/'.length);
    const filePath = path.join(REPORTS_DIR, 'lint-' + date + '.json');
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return json(res, 200, JSON.parse(content));
    } catch { return json(res, 404, { error: '报告不存在: ' + date }); }
  }

  // GET /api/settings — 获取当前配置
  if (p === '/api/settings' && req.method === 'GET') {
    const config = getFullConfig();
    // 构造 providers 视图：合并 builtin + 用户覆盖，带 isBuiltin
    const providersOut = {};
    for (const key of Object.keys(BUILTIN_PROVIDERS)) {
      const bp = BUILTIN_PROVIDERS[key];
      providersOut[key] = {
        name: bp.name,
        baseUrl: bp.baseUrl,
        format: bp.format,
        defaultModel: bp.defaultModel,
        models: getProviderModels(key, config)
      };
    }
    return json(res, 200, {
      provider: config.provider,
      model: config.model,
      customBaseUrl: config.customBaseUrl || '',
      wikiLang: config.wikiLang || 'zh',
      providers: providersOut,
      pipeline: config.pipeline || { preset: 'balanced', stages: resolvePresetForProvider('balanced', config.provider, config) },
      hasKey: !!config.apiKey
    });
  }

  // GET /api/models/defaults?provider=xxx — 返回该 provider 的 builtin 默认列表
  if (p === '/api/models/defaults' && req.method === 'GET') {
    const url = new URL(req.url, `http://localhost`);
    const providerKey = url.searchParams.get('provider');
    if (!providerKey || !BUILTIN_PROVIDERS[providerKey]) {
      return json(res, 400, { error: 'invalid provider' });
    }
    const bp = BUILTIN_PROVIDERS[providerKey];
    return json(res, 200, {
      provider: providerKey,
      name: bp.name,
      baseUrl: bp.baseUrl,
      format: bp.format,
      defaultModel: bp.defaultModel,
      models: (bp.models || []).map(m => ({ ...m, isBuiltin: true }))
    });
  }

  // PUT /api/settings — 保存配置（支持 providers / pipeline 浅合并）
  if (p === '/api/settings' && req.method === 'PUT') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const { provider, apiKey, model, customBaseUrl, wikiLang, providers, pipeline } = parsed;
        const config = loadConfig();
        if (provider) config.provider = provider;
        if (typeof model === 'string') config.model = model;
        if (typeof customBaseUrl === 'string') config.customBaseUrl = customBaseUrl;
        if (typeof wikiLang === 'string') config.wikiLang = wikiLang;
        if (providers && typeof providers === 'object') {
          config.providers = { ...(config.providers || {}), ...providers };
        }
        if (pipeline && typeof pipeline === 'object') {
          const merged = { ...(config.pipeline || {}), ...pipeline };
          if (pipeline.stages && typeof pipeline.stages === 'object') {
            merged.stages = { ...((config.pipeline && config.pipeline.stages) || {}), ...pipeline.stages };
          }
          // 如果只传了 preset 没传 stages，按 preset 重新解析
          if (pipeline.preset && !pipeline.stages) {
            merged.stages = resolvePresetForProvider(pipeline.preset, config.provider, config);
          }
          config.pipeline = merged;
        }
        saveConfig(config);
        // apiKey 单独存储到 .api-key 文件
        if (typeof apiKey === 'string' && apiKey.trim()) saveApiKey(apiKey.trim());
        return json(res, 200, { ok: true });
      } catch (e) { return json(res, 400, { error: e.message }); }
    });
    return;
  }

  // POST /api/settings/test — 测试连接（可接受 {provider, model, thinking}）
  if (p === '/api/settings/test' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      (async () => {
        let overrides = {};
        let opts = {};
        try {
          if (body && body.trim()) {
            const parsed = JSON.parse(body);
            if (parsed.provider) overrides.provider = parsed.provider;
            if (parsed.model) overrides.model = parsed.model;
            if (typeof parsed.thinking === 'boolean') opts.thinking = parsed.thinking;
          }
        } catch {}
        try {
          const answer = await callLLM('你是一个测试助手。', '请回复"连接成功"四个字。', overrides, opts);
          return json(res, 200, { ok: true, message: (answer || '').trim().slice(0, 100) });
        } catch (e) {
          return json(res, 200, { ok: false, message: e.message.slice(0, 300) });
        }
      })();
    });
    return;
  }

  // GET /api/profile — 获取用户资料
  if (p === '/api/profile' && req.method === 'GET') {
    const profile = loadProfile();
    if (!profile) return json(res, 404, { error: '未设置用户资料' });
    return json(res, 200, profile);
  }

  // PUT /api/profile — 保存用户资料
  if (p === '/api/profile' && req.method === 'PUT') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { nickname, bio } = JSON.parse(body);
        saveProfile({ nickname: (nickname || '').trim(), bio: (bio || '').trim() });
        return json(res, 200, { ok: true });
      } catch (e) { return json(res, 400, { error: e.message }); }
    });
    return;
  }

  // GET /api/memory — 获取记忆文本
  if (p === '/api/memory' && req.method === 'GET') {
    return json(res, 200, loadMemory());
  }

  // PUT /api/memory — 保存记忆文本
  if (p === '/api/memory' && req.method === 'PUT') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body);
        saveMemory({ text: typeof text === 'string' ? text : '' });
        return json(res, 200, { ok: true });
      } catch (e) { return json(res, 400, { error: e.message }); }
    });
    return;
  }

  // ── 自动化任务 API ──
  if (p.startsWith('/api/autotask')) {
    const subPath = p.slice('/api/autotask'.length);

    // GET /api/autotask/list — list all tasks
    if (subPath === '/list' && req.method === 'GET') {
      return json(res, 200, { tasks: loadAutotasks() });
    }

    // GET /api/autotask/sources — return system source library
    if (subPath === '/sources' && req.method === 'GET') {
      try {
        const sources = loadSystemSources();
        if (sources === null || sources === undefined) {
          return json(res, 503, { error: 'system-sources.json 未就绪，请稍后重试' });
        }
        return json(res, 200, sources);
      } catch (e) {
        return json(res, 500, { error: 'Failed to load sources: ' + e.message });
      }
    }

    // GET /api/autotask/history — get execution history
    if (subPath === '/history' && req.method === 'GET') {
      let hist = loadHistory();
      const filterTaskId = params.get('taskId');
      if (filterTaskId) hist = hist.filter(h => h.taskId === filterTaskId);
      return json(res, 200, { history: hist.reverse() });
    }

    // GET /api/autotask/history/:runId — single run detail
    const histDetailMatch = subPath.match(/^\/history\/(.+)$/);
    if (histDetailMatch && req.method === 'GET') {
      const runId = histDetailMatch[1];
      const hist = loadHistory();
      const run = hist.find(h => h.id === runId);
      if (!run) return json(res, 404, { error: '记录不存在' });
      return json(res, 200, run);
    }

    // DELETE /api/autotask/history/:runId — delete history record
    if (histDetailMatch && req.method === 'DELETE') {
      const runId = histDetailMatch[1];
      let hist = loadHistory();
      const idx = hist.findIndex(h => h.id === runId);
      if (idx < 0) return json(res, 404, { error: '记录不存在' });
      hist.splice(idx, 1);
      saveHistory(hist);
      return json(res, 200, { ok: true });
    }

    // POST /api/autotask/test-source — test a source URL
    if (subPath === '/test-source' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { sourceType, sourceConfig } = JSON.parse(body);
          let items = [];
          if (sourceType === 'rss') {
            items = await fetchRSS(sourceConfig.url);
          } else if (sourceType === 'webpage') {
            items = await fetchWebpageLinks(sourceConfig.url, sourceConfig.selector);
          } else if (sourceType === 'api') {
            const raw = await new Promise((resolve, reject) => {
              const mod = sourceConfig.url.startsWith('https') ? https : http;
              const r = mod.get(sourceConfig.url, { headers: { 'User-Agent': 'WikiBot/1.0' } }, resp => {
                let data = ''; resp.on('data', c => data += c); resp.on('end', () => resolve(data));
              });
              r.on('error', reject);
              r.setTimeout(30000, () => { r.destroy(); reject(new Error('API fetch timeout')); });
            });
            try {
              const parsed = JSON.parse(raw);
              const arr = parsed.items || parsed.articles || parsed.data || parsed.results || (Array.isArray(parsed) ? parsed : []);
              items = arr.map(it => ({
                title: it.title || it.name || '',
                url: it.url || it.link || '',
                description: it.description || it.summary || ''
              })).filter(it => it.title || it.url);
            } catch { items = []; }
          }
          const maxItems = (sourceConfig && sourceConfig.maxItems) || 10;
          return json(res, 200, { items: items.slice(0, maxItems), total: items.length });
        } catch (e) { return json(res, 500, { error: e.message }); }
      });
      return;
    }

    // POST /api/autotask/parse-nl — parse natural-language task description into config
    if (subPath === '/parse-nl' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const data = JSON.parse(body || '{}');
          const { nl, current, instruction } = data;
          if (!nl && !(current && instruction)) {
            return json(res, 400, { error: '缺少描述' });
          }

          // Collect available topics from wiki dir
          let topics = [];
          try {
            for (const d of (fs.existsSync(WIKI) ? fs.readdirSync(WIKI, { withFileTypes: true }) : [])) {
              if (d.isDirectory() && !d.name.startsWith('.')) topics.push(d.name);
            }
          } catch {}
          const topicListStr = topics.length ? topics.join(', ') : '(暂无)';

          const systemPrompt = `你是任务配置解析器。把用户的中文自然语言转成严格 JSON。

输出 schema:
{
  "name": string,
  "sourceType": "rss" | "webpage" | "api",
  "sourceConfig": { "url": string, "maxItems": number 1-50 },
  "schedule": "daily" | "hourly" | "manual",
  "scheduleTime": "HH:MM",
  "topic": string,
  "filters": { "keywords": string[], "excludeKeywords": string[] },
  "_warnings": string[]
}

强制要求:
1. 只输出 JSON。不带 \`\`\` 围栏，不带任何解释。
2. 不确定的字段填默认值，并在 _warnings 里说明。
3. 若 input 含 current 配置，只修改用户明确要改的字段，其他保持。

已知数据源（首选 RSS）:
- Hacker News -> https://hnrss.org/frontpage (rss)
- arXiv cs.AI -> https://export.arxiv.org/rss/cs.AI (rss)
- Hugging Face Papers -> https://huggingface.co/papers (webpage)
- 36氪 -> https://36kr.com/feed (rss)
- 少数派 -> https://sspai.com/feed (rss)
- 阮一峰科技周刊 -> https://www.ruanyifeng.com/blog/atom.xml (rss)

可用主题列表（topic 字段必须从这里挑，否则用 'auto'）:
${topicListStr}`;

          const userParts = [];
          if (nl) userParts.push(`# 自然语言描述\n${nl}`);
          if (current) userParts.push(`# 当前配置\n${JSON.stringify(current, null, 2)}`);
          if (instruction) userParts.push(`# 修改指令\n${instruction}`);
          const userPrompt = userParts.join('\n\n');

          // Call LLM with 30s timeout, force global config (no user-supplied model)
          let raw;
          try {
            raw = await Promise.race([
              callLLM(systemPrompt, userPrompt, null, { temperature: 0, maxTokens: 1024 }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('LLM 超时')), 30000))
            ]);
          } catch (e) {
            if (/超时|timeout/i.test(e.message)) return json(res, 504, { error: 'AI 解析超时', detail: e.message });
            return json(res, 502, { error: 'LLM 调用失败', detail: e.message });
          }

          // Strip ```json fences if present
          let cleaned = String(raw || '').trim();
          cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

          let parsed;
          try { parsed = JSON.parse(cleaned); }
          catch {
            return json(res, 502, { error: 'AI 解析失败', raw: String(raw || '').slice(0, 500) });
          }

          // Local validator
          const warnings = Array.isArray(parsed._warnings) ? parsed._warnings.slice() : [];
          const validSourceTypes = ['rss', 'webpage', 'api'];
          const validSchedules = ['daily', 'hourly', 'manual'];

          let sourceType = parsed.sourceType;
          if (!validSourceTypes.includes(sourceType)) {
            warnings.push(`sourceType 无效 (${sourceType})，回退到 rss`);
            sourceType = 'rss';
          }

          let schedule = parsed.schedule;
          if (!validSchedules.includes(schedule)) {
            warnings.push(`schedule 无效 (${schedule})，回退到 daily`);
            schedule = 'daily';
          }

          let scheduleTime = parsed.scheduleTime;
          if (typeof scheduleTime !== 'string' || !/^\d{2}:\d{2}$/.test(scheduleTime)) {
            warnings.push(`scheduleTime 无效 (${scheduleTime})，回退到 08:00`);
            scheduleTime = '08:00';
          }

          const sc = parsed.sourceConfig && typeof parsed.sourceConfig === 'object' ? parsed.sourceConfig : {};
          let maxItems = Number(sc.maxItems);
          if (!Number.isFinite(maxItems) || maxItems < 1 || maxItems > 50) {
            warnings.push(`maxItems 无效 (${sc.maxItems})，回退到 5`);
            maxItems = 5;
          } else {
            maxItems = Math.floor(maxItems);
          }

          let url = typeof sc.url === 'string' ? sc.url : '';
          if (url && !/^https?:\/\//i.test(url)) {
            warnings.push(`url 不以 http(s) 开头：${url}`);
          }

          const filtersIn = parsed.filters && typeof parsed.filters === 'object' ? parsed.filters : {};
          let keywords = Array.isArray(filtersIn.keywords) ? filtersIn.keywords.filter(x => typeof x === 'string') : [];
          if (!Array.isArray(filtersIn.keywords)) {
            if (filtersIn.keywords !== undefined) warnings.push('keywords 非数组，已重置');
            keywords = [];
          }
          let excludeKeywords = Array.isArray(filtersIn.excludeKeywords) ? filtersIn.excludeKeywords.filter(x => typeof x === 'string') : [];
          if (!Array.isArray(filtersIn.excludeKeywords)) {
            if (filtersIn.excludeKeywords !== undefined) warnings.push('excludeKeywords 非数组，已重置');
            excludeKeywords = [];
          }

          let topic = typeof parsed.topic === 'string' ? parsed.topic : 'auto';
          if (topic !== 'auto' && !topics.includes(topic)) {
            warnings.push(`topic '${topic}' 不在可用列表，回退到 auto`);
            topic = 'auto';
          }

          const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : '未命名任务';

          const config = {
            name,
            sourceType,
            sourceConfig: { url, maxItems },
            schedule,
            scheduleTime,
            topic,
            filters: { keywords, excludeKeywords }
          };

          return json(res, 200, { ok: true, config, warnings });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      });
      return;
    }

    // POST /api/autotask/configure — AI-pick sources from system library
    if (subPath === '/configure' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const data = JSON.parse(body || '{}');
          const intent = String(data.intent || '').trim();
          if (!intent) return json(res, 400, { error: '缺少 intent' });

          const library = loadSystemSources();
          if (!library || !Array.isArray(library) || library.length === 0) {
            return json(res, 503, { error: 'system-sources.json 未就绪，请稍后重试' });
          }

          const libBrief = library.map(s => ({
            id: s.id, label: s.label || s.id, type: s.type,
            tags: s.tags || [], description: s.description || '', lang: s.lang || ''
          }));

          const systemPrompt = `你是任务配置生成器。基于用户意图与系统数据源库，输出一个 JSON 草案。
严格只输出 JSON：
{
  "name": "短任务名（10-20 字）",
  "selectedSourceIds": ["id1", "id2", ...],   // 5-12 个，必须来自 library
  "expanded_keywords": ["kw1", ...],           // 6-15 个相关词
  "style_hint": "一句话风格偏好",
  "schedule": "daily" | "hourly" | "manual",
  "scheduleTime": "HH:MM",
  "topic": "auto"
}
不要 markdown 围栏，不要解释。`;

          const userPrompt = `# 用户意图
${intent}

# 可用数据源库（${libBrief.length} 个）
${JSON.stringify(libBrief, null, 2)}`;

          let raw;
          try {
            raw = await Promise.race([
              callLLM(systemPrompt, userPrompt, null, { temperature: 0.2, maxTokens: 1024 }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('configure timeout')), 30000))
            ]);
          } catch (e) {
            return json(res, 502, { error: 'LLM 调用失败', detail: e.message });
          }

          let cleaned = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
          let parsed;
          try { parsed = JSON.parse(cleaned); }
          catch { return json(res, 502, { error: 'AI 解析失败', raw: String(raw || '').slice(0, 500) }); }

          const libIds = new Set(library.map(s => s.id));
          let selected = Array.isArray(parsed.selectedSourceIds) ? parsed.selectedSourceIds : [];
          selected = selected.filter(id => libIds.has(id)).slice(0, 12);
          const sources = selected.map(id => {
            const s = library.find(x => x.id === id);
            return {
              id: s.id,
              type: s.type,
              url: s.url || '',
              label: s.label || s.id,
              ...(s.subsource ? { subsource: s.subsource } : {})
            };
          });

          let expanded = Array.isArray(parsed.expanded_keywords)
            ? parsed.expanded_keywords.filter(x => typeof x === 'string').slice(0, 20)
            : [];
          const styleHint = typeof parsed.style_hint === 'string' ? parsed.style_hint.slice(0, 200) : '';
          let schedule = ['daily', 'hourly', 'manual'].includes(parsed.schedule) ? parsed.schedule : 'daily';
          let scheduleTime = (typeof parsed.scheduleTime === 'string' && /^\d{2}:\d{2}$/.test(parsed.scheduleTime))
            ? parsed.scheduleTime : '08:00';
          const name = (typeof parsed.name === 'string' && parsed.name.trim()) ? parsed.name.trim().slice(0, 60) : intent.slice(0, 30);
          const topic = (typeof parsed.topic === 'string' && parsed.topic) ? parsed.topic : 'auto';

          return json(res, 200, {
            ok: true,
            config: {
              name,
              sources,
              preferences: { expanded_keywords: expanded, must_exclude: [], style_hint: styleHint },
              schedule, scheduleTime, topic
            },
            warnings: []
          });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      });
      return;
    }

    // POST /api/autotask/feedback — append per-item feedback
    if (subPath === '/feedback' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          const { taskId, runId, itemUrl, action: rawAction, note } = data;
          // Frontend uses up/down (UX), persisted as keep/drop (intent semantics).
          const ACTION_MAP = { up: 'keep', down: 'drop', keep: 'keep', drop: 'drop' };
          const action = ACTION_MAP[rawAction];
          if (!taskId || !itemUrl || !action) {
            return json(res, 400, { error: '参数无效' });
          }
          const tasks = loadAutotasks();
          const idx = tasks.findIndex(t => t.id === taskId);
          if (idx < 0) return json(res, 404, { error: '任务不存在' });
          const t = tasks[idx];
          if (!Array.isArray(t.feedback)) t.feedback = [];
          t.feedback.push({
            url: itemUrl, action, note: typeof note === 'string' ? note : '',
            runId: runId || null, ts: new Date().toISOString()
          });
          if (t.feedback.length > 50) t.feedback = t.feedback.slice(-50);
          saveAutotasks(tasks);
          return json(res, 200, { ok: true, feedbackCount: t.feedback.length });
        } catch (e) { return json(res, 400, { error: e.message }); }
      });
      return;
    }

    // POST /api/autotask/:id/run — manual trigger
    const runMatch = subPath.match(/^\/([^/]+)\/run$/);
    if (runMatch && req.method === 'POST') {
      const taskId = runMatch[1];
      const tasks = loadAutotasks();
      if (!tasks.find(t => t.id === taskId)) return json(res, 404, { error: '任务不存在' });
      // Run-lock: reject if a run for this task is currently running.
      // Treat runs older than 10 min (matches startup zombie cutoff) as stale and allow override,
      // otherwise a crashed run would block manual re-trigger until the next process restart.
      try {
        const hist = loadHistory();
        const STALE_MS = 10 * 60 * 1000;
        const now = Date.now();
        const active = hist.find(h => {
          if (h.taskId !== taskId || h.status !== 'running') return false;
          const startedAt = new Date(h.startedAt || 0).getTime();
          if (!startedAt) return false;
          return (now - startedAt) < STALE_MS;
        });
        if (active) {
          return json(res, 409, { error: '该任务已在运行中', runId: active.id });
        }
      } catch {}
      const runId = genId('run');
      executeAutotask(taskId, true, runId).catch(e => console.error('[AutoTask] 手动执行失败:', e.message));
      return json(res, 200, { ok: true, runId, message: '任务已触发' });
    }

    // GET /api/autotask/:id/toggle — toggle enabled/disabled
    const toggleMatch = subPath.match(/^\/([^/]+)\/toggle$/);
    if (toggleMatch && req.method === 'GET') {
      const taskId = toggleMatch[1];
      const tasks = loadAutotasks();
      const idx = tasks.findIndex(t => t.id === taskId);
      if (idx < 0) return json(res, 404, { error: '任务不存在' });
      tasks[idx].enabled = !tasks[idx].enabled;
      saveAutotasks(tasks);
      return json(res, 200, { ok: true, enabled: tasks[idx].enabled });
    }

    // POST /api/autotask — create task
    if ((subPath === '' || subPath === '/') && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const isV3 = Array.isArray(data.sources) || data.intent || data.preferences;
          const task = {
            id: genId('at'),
            name: data.name || '未命名任务',
            // Legacy fields (kept for back-compat reads)
            sourceType: data.sourceType || (isV3 ? null : 'rss'),
            sourceConfig: data.sourceConfig || (isV3 ? null : { url: '', maxItems: 5 }),
            // New v3 fields
            intent: typeof data.intent === 'string' ? data.intent : (data.nlSummary || data.name || ''),
            sources: Array.isArray(data.sources) ? data.sources : [],
            preferences: (data.preferences && typeof data.preferences === 'object') ? {
              expanded_keywords: Array.isArray(data.preferences.expanded_keywords) ? data.preferences.expanded_keywords : [],
              must_exclude: Array.isArray(data.preferences.must_exclude) ? data.preferences.must_exclude : [],
              style_hint: typeof data.preferences.style_hint === 'string' ? data.preferences.style_hint : ''
            } : { expanded_keywords: [], must_exclude: [], style_hint: '' },
            feedback: [],
            maxPerRun: (typeof data.maxPerRun === 'number' && data.maxPerRun > 0) ? data.maxPerRun : 5,
            // Existing
            schedule: data.schedule || 'daily',
            scheduleTime: data.scheduleTime || '08:00',
            topic: data.topic || 'auto',
            enabled: data.enabled !== false,
            filters: {
              keywords: (data.filters && data.filters.keywords) || [],
              excludeKeywords: (data.filters && data.filters.excludeKeywords) || []
            },
            model: typeof data.model === 'string' && data.model ? data.model : null,
            provider: typeof data.provider === 'string' && data.provider ? data.provider : null,
            nlSummary: typeof data.nlSummary === 'string' ? data.nlSummary : null,
            templateId: typeof data.templateId === 'string' ? data.templateId : null,
            version: isV3 ? 3 : 2,
            createdAt: new Date().toISOString(),
            lastRunAt: null,
            lastRunStatus: null
          };
          const tasks = loadAutotasks();
          tasks.push(task);
          saveAutotasks(tasks);
          return json(res, 201, task);
        } catch (e) { return json(res, 400, { error: e.message }); }
      });
      return;
    }

    // PUT /api/autotask/:id — update task
    const idMatch = subPath.match(/^\/([^/]+)$/);
    if (idMatch && req.method === 'PUT') {
      const taskId = idMatch[1];
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const tasks = loadAutotasks();
          const idx = tasks.findIndex(t => t.id === taskId);
          if (idx < 0) return json(res, 404, { error: '任务不存在' });
          const t = tasks[idx];
          if (data.name !== undefined) t.name = data.name;
          if (data.sourceType !== undefined) t.sourceType = data.sourceType;
          if (data.sourceConfig !== undefined) t.sourceConfig = data.sourceConfig;
          if (data.schedule !== undefined) t.schedule = data.schedule;
          if (data.scheduleTime !== undefined) t.scheduleTime = data.scheduleTime;
          if (data.topic !== undefined) t.topic = data.topic;
          if (data.enabled !== undefined) t.enabled = data.enabled;
          if (data.filters !== undefined) t.filters = data.filters;
          if (data.model !== undefined) t.model = data.model || null;
          if (data.provider !== undefined) t.provider = data.provider || null;
          if (data.nlSummary !== undefined) t.nlSummary = data.nlSummary || null;
          if (data.templateId !== undefined) t.templateId = data.templateId || null;
          // v3 fields
          if (data.intent !== undefined) t.intent = data.intent;
          if (data.sources !== undefined) t.sources = Array.isArray(data.sources) ? data.sources : t.sources;
          if (data.preferences !== undefined && data.preferences) {
            t.preferences = {
              expanded_keywords: Array.isArray(data.preferences.expanded_keywords) ? data.preferences.expanded_keywords : (t.preferences && t.preferences.expanded_keywords) || [],
              must_exclude: Array.isArray(data.preferences.must_exclude) ? data.preferences.must_exclude : (t.preferences && t.preferences.must_exclude) || [],
              style_hint: typeof data.preferences.style_hint === 'string' ? data.preferences.style_hint : (t.preferences && t.preferences.style_hint) || ''
            };
          }
          if (data.maxPerRun !== undefined && typeof data.maxPerRun === 'number' && data.maxPerRun > 0) t.maxPerRun = data.maxPerRun;
          if (Array.isArray(data.sources) || data.intent !== undefined || data.preferences !== undefined) {
            t.version = 3;
          } else if (!t.version || t.version < 2) {
            t.version = 2;
          }
          saveAutotasks(tasks);
          return json(res, 200, t);
        } catch (e) { return json(res, 400, { error: e.message }); }
      });
      return;
    }

    // DELETE /api/autotask/:id — delete task
    if (idMatch && req.method === 'DELETE') {
      const taskId = idMatch[1];
      let tasks = loadAutotasks();
      const idx = tasks.findIndex(t => t.id === taskId);
      if (idx < 0) return json(res, 404, { error: '任务不存在' });
      tasks.splice(idx, 1);
      saveAutotasks(tasks);
      return json(res, 200, { ok: true });
    }
  }

  // raw 目录图片（wiki 文章中的 ../../raw/... 解析后变成 /raw/...）
  if (p.startsWith('/raw/')) {
    const rel = p.slice(5); // strip /raw/
    if (rel.includes('..') || path.isAbsolute(rel)) { res.writeHead(403); return res.end(); }
    const rawFile = path.join(RAW, rel);
    if (!rawFile.startsWith(RAW)) { res.writeHead(403); return res.end(); }
    try {
      const data = fs.readFileSync(rawFile);
      const ext = path.extname(rawFile);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'max-age=86400' });
      return res.end(data);
    } catch { res.writeHead(404); return res.end('Not Found'); }
  }

  // 静态文件
  let filePath = p === '/' ? path.join(APP, 'index.html') : path.join(APP, p);
  if (!filePath.startsWith(APP)) { res.writeHead(403); return res.end(); }
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
});

migrateMemory();

// ── Autotask 崩溃恢复：把卡在 running 状态超过 10 分钟的 run 标记为 interrupted ──
try {
  const hist = loadHistory();
  const cutoff = Date.now() - 10 * 60 * 1000;
  let changed = 0;
  for (const r of hist) {
    if (r.status === 'running') {
      const startedAt = new Date(r.startedAt || 0).getTime();
      if (!startedAt || startedAt < cutoff) {
        r.status = 'interrupted';
        r.finishedAt = r.finishedAt || new Date().toISOString();
        r.progress = null;
        r.error = r.error || '服务器重启时该任务正在运行，被标记为中断';
        changed += 1;
      }
    }
  }
  if (changed > 0) {
    saveHistory(hist);
    console.log(`[AutoTask] 启动恢复：标记 ${changed} 个 stale 运行为 interrupted`);
  }
} catch (e) {
  console.warn('[AutoTask] 启动恢复失败:', e.message);
}

// ── 定时健康检查 ──
const REPORTS_DIR_INIT = path.join(ROOT, 'data', 'reports');
if (!fs.existsSync(REPORTS_DIR_INIT)) fs.mkdirSync(REPORTS_DIR_INIT, { recursive: true });

// 启动时清理旧报告
try {
  const oldFiles = fs.readdirSync(REPORTS_DIR_INIT).filter(f => f.startsWith('lint-') && f.endsWith('.json')).sort().reverse();
  for (let i = 30; i < oldFiles.length; i++) {
    try { fs.unlinkSync(path.join(REPORTS_DIR_INIT, oldFiles[i])); } catch {}
  }
} catch {}

// 启动时运行一次 lint（仅在直接运行时，被 require 时不启动）
if (require.main === module) setTimeout(() => {
  try {
    // 内联 runLint 逻辑用于启动检查
    const handler = server.listeners('request')[0];
    // 直接调用 server.js 内的 runAndSaveLint 不可行（在闭包内），
    // 所以我们用 http 请求自身来触发
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: '/api/wiki/lint', method: 'GET' }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const report = JSON.parse(body);
          const dateStr = report.timestamp ? report.timestamp.slice(0, 10) : new Date().toISOString().slice(0, 10);
          fs.writeFileSync(path.join(REPORTS_DIR_INIT, 'lint-' + dateStr + '.json'), JSON.stringify(report, null, 2), 'utf-8');
          console.log('健康检查完成，评分: ' + report.score);
        } catch {}
      });
    });
    req.on('error', () => {});
    req.end();
  } catch {}
}, 2000);

// 每 24 小时运行一次
setInterval(() => {
  try {
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: '/api/wiki/lint', method: 'GET' }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const report = JSON.parse(body);
          const dateStr = report.timestamp ? report.timestamp.slice(0, 10) : new Date().toISOString().slice(0, 10);
          fs.writeFileSync(path.join(REPORTS_DIR_INIT, 'lint-' + dateStr + '.json'), JSON.stringify(report, null, 2), 'utf-8');
          console.log('定时健康检查完成，评分: ' + report.score);
        } catch {}
      });
    });
    req.on('error', () => {});
    req.end();
  } catch {}
}, 24 * 60 * 60 * 1000);

// ── 自动化任务调度器 ──（仅在直接运行时）
if (require.main === module) setInterval(() => {
  try {
    const tasks = loadAutotasks();
    const now = new Date();
    tasks.forEach(task => {
      if (!task.enabled || task.schedule === 'manual') return;

      const lastRun = task.lastRunAt ? new Date(task.lastRunAt) : null;
      let shouldRun = false;

      if (task.schedule === 'hourly') {
        shouldRun = !lastRun || (now - lastRun) >= 55 * 60 * 1000;
      } else if (task.schedule === 'daily') {
        const [hh, mm] = (task.scheduleTime || '08:00').split(':').map(Number);
        const targetToday = new Date(now); targetToday.setHours(hh, mm, 0, 0);
        shouldRun = !lastRun || (now >= targetToday && (!lastRun || lastRun < targetToday));
      }

      if (shouldRun) {
        console.log(`[AutoTask] 执行任务: ${task.name}`);
        __diagAppend(CRASH_LOG, `[${new Date().toISOString()}] AUTOTASK_START id=${task.id} name=${task.name} schedule=${task.schedule}`);
        executeAutotask(task.id, false)
          .then(() => __diagAppend(CRASH_LOG, `[${new Date().toISOString()}] AUTOTASK_DONE id=${task.id} name=${task.name}`))
          .catch(e => {
            console.error(`[AutoTask] 任务失败: ${task.name}`, e.message);
            crashLog(`AUTOTASK_REJECT id=${task.id} name=${task.name}`, e);
          });
      }
    });
  } catch (e) {
    console.error('[AutoTask] 调度器错误:', e.message);
    crashLog('AUTOTASK_SCHEDULER_ERROR', e);
  }
}, 5 * 60 * 1000);

if (require.main === module) {
  loadQueue();
  server.listen(PORT, () => {
    console.log(`Wiki 应用已启动：http://localhost:${PORT}`);
    console.log(`[ingest] concurrency=${INGEST_CONCURRENCY} queueCap=200`);
    __diagAppend(CRASH_LOG, `[${new Date().toISOString()}] LISTEN port=${PORT}\n---\n`);
  });
  server.on('error', e => crashLog('SERVER_ERROR', e));
  server.on('clientError', e => __diagAppend(ACCESS_LOG, `${new Date().toISOString()} CLIENT_ERROR ${e.code || ''} ${e.message || ''}`));
}

// 测试 hook：测试脚本 require 后通过 __test.* 访问内部状态与函数
module.exports = {
  __test: {
    setProcessTask: (fn) => { _processTaskImpl = fn; },
    resetProcessTask: () => { _processTaskImpl = null; },
    getActiveCount: () => activeCount,
    getTaskQueue: () => taskQueue,
    clearTaskQueue: () => { taskQueue = []; },
    enqueueTask,
    tryDispatch,
    getBatchSummary,
    findLatestBatchId,
    pushTask,
    genTaskId,
    externalStatus,
    INGEST_CONCURRENCY,
    setPhase,
    loadQueue,
    scheduleSaveQueue,
    serializeTaskForPersist,
    QUEUE_FILE,
    PHASES,
    PHASE_TOTAL,
  },
  server,
};
