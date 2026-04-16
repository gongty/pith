const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const os = require('os');
const crypto = require('crypto');

// ── 多格式导入依赖 ──
let pdfParse, Readability, JSDOM;
try { pdfParse = require('pdf-parse'); } catch {}
try { ({ Readability } = require('@mozilla/readability')); } catch {}
try { ({ JSDOM } = require('jsdom')); } catch {}

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
    models: [
      { id: 'qwen3-max',          label: 'Qwen3 Max',          use: 'strong',  thinkingCapable: true,  defaultThinking: false },
      { id: 'qwen3.6-plus',       label: 'Qwen 3.6 Plus',      use: 'main',    thinkingCapable: true,  defaultThinking: false },
      { id: 'qwen-plus-latest',   label: 'Qwen Plus (latest)', use: 'main',    thinkingCapable: true,  defaultThinking: false },
      { id: 'qwen3.5-plus',       label: 'Qwen 3.5 Plus',      use: 'main',    thinkingCapable: true,  defaultThinking: false },
      { id: 'qwen3.5-flash',      label: 'Qwen 3.5 Flash',     use: 'fast',    thinkingCapable: true,  defaultThinking: false },
      { id: 'qwen-turbo-latest',  label: 'Qwen Turbo',         use: 'fast',    thinkingCapable: true,  defaultThinking: false },
      { id: 'qwen-flash',         label: 'Qwen Flash',         use: 'fast',    thinkingCapable: true,  defaultThinking: false },
      { id: 'qwen3-coder-plus',   label: 'Qwen3 Coder',        use: 'code' },
      { id: 'qwen-long',          label: 'Qwen Long (10M)',    use: 'longctx' },
      { id: 'qwen-vl-max-latest', label: 'Qwen VL Max',        use: 'vision' },
      { id: 'qwen3-vl-plus',      label: 'Qwen3 VL Plus',      use: 'vision' }
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
  // 限长
  if (s.length > 80) s = s.slice(0, 80).replace(/-$/, '');
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

  // ─ Stage 1: title ─
  let articleTitle = '';
  {
    const cfgT = stagesCfg.title || { source: 'code' };
    const s = startStage(task, 'title', '提取标题', { source: cfgT.source });
    try {
      if (cfgT.source === 'code' || !cfgT.source) {
        const m = rawBody.match(/^#\s+(.+)$/m);
        if (m) { articleTitle = m[1].trim(); doneStage(s, { detail: articleTitle }); }
        else {
          // Fallback: LLM pick
          const titleModel = cfgT.model || pickModelByUse(providerKey, 'fast', config);
          const resp = await callLLM(
            '你是一个标题提取助手。根据内容给一个简洁的中文标题（≤30 字），只输出标题本身，不要加引号或解释。',
            rawBody.slice(0, 4000),
            { ...(overrides || {}), model: titleModel },
            { maxTokens: 200, temperature: 0.2 }
          );
          articleTitle = (resp || '').trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 80);
          s.source = 'llm_fallback';
          doneStage(s, { detail: articleTitle });
        }
      } else if (cfgT.source === 'llm') {
        const titleModel = cfgT.model || pickModelByUse(providerKey, 'fast', config);
        const resp = await callLLM(
          '你是一个标题提取助手。根据内容给一个简洁的中文标题（≤30 字），只输出标题本身。',
          rawBody.slice(0, 4000),
          { ...(overrides || {}), model: titleModel },
          { maxTokens: 200, temperature: 0.2 }
        );
        articleTitle = (resp || '').trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 80);
        doneStage(s, { detail: articleTitle });
      }
    } catch (e) {
      errorStage(s, e);
      articleTitle = path.basename(filename, path.extname(filename)) || 'untitled';
    }
    if (!articleTitle) articleTitle = path.basename(filename, path.extname(filename)) || 'untitled';
  }

  // ─ Stage 2: topic ─
  let articleTopic = topicDir || 'general';
  {
    const cfgT = stagesCfg.topic || { source: 'user' };
    const s = startStage(task, 'topic', '确定主题', { source: cfgT.source });
    try {
      if (cfgT.source === 'llm' || (articleTopic === 'general' && cfgT.source !== 'user')) {
        const topicModel = cfgT.model || pickModelByUse(providerKey, 'fast', config);
        const resp = await callLLM(
          '你是一个主题分类助手。从候选主题中选择最合适的一个（返回 kebab-case 英文目录名，不加引号和解释）。若都不合适，返回一个新的 kebab-case 英文名。',
          `## 已有主题\n${existingTopics.join(', ') || '（暂无）'}\n\n## 内容标题\n${articleTitle}\n\n## 内容摘要\n${rawBody.slice(0, 1500)}`,
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

  // ─ Stage 3: filename ─
  let articleFilename = filename ? filename.replace(/\.(txt|md|json)$/i, '.md') : '';
  {
    const cfgF = stagesCfg.filename || { source: 'code' };
    const s = startStage(task, 'filename', '生成文件名', { source: cfgF.source });
    try {
      articleFilename = slugifyTitle(articleTitle);
      doneStage(s, { detail: articleFilename });
    } catch (e) {
      errorStage(s, e);
      articleFilename = `article-${Date.now()}.md`;
    }
  }

  // ─ Stage 4 + 5 并行：content + summary ─
  const cfgC = stagesCfg.content || { model: pickModelByUse(providerKey, 'main', config), thinking: false, stream: true, maxTokens: 16384 };
  const cfgS = stagesCfg.summary || { source: 'llm', model: pickModelByUse(providerKey, 'fast', config), maxLength: 30 };

  const memCtxApi = buildMemoryContext();
  const bioContext = memCtxApi ? `\n\n${memCtxApi}\n请根据用户背景调整文章深度和侧重点。` : '';
  const contentSystemPrompt = `你是知识库编译助手。将原始素材编译为结构清晰、信息保真的纯 Markdown 知识库文章。

## 文章模板
# ${articleTitle}
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

## 输出要求（重要）
- 输出**纯 Markdown 文章**，不要用 JSON 包裹、不要用代码块 fence 包裹整篇文章
- **不要写 See Also 章节**（系统会自动追加）
- 第一行就是 "# ${articleTitle}"
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
  let contentErrored = !articleContent;

  // 如果 content 彻底失败，用 rawBody 作为 fallback
  if (!articleContent) {
    articleContent = `# ${articleTitle}\n\n> 注意：正文编译失败，以下为原始素材。\n\n${rawBody}`;
  } else {
    articleContent = stripOuterCodeFences(articleContent);
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
    fs.writeFileSync(articlePath, articleContent, 'utf-8');
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

  task.created = [{ path: relPath, title: articleTitle }];
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

function extractTitle(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const m = content.match(/^#+\s+(.+)/m);
    return m ? m[1].trim() : path.basename(filePath, '.md');
  } catch { return path.basename(filePath, '.md'); }
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
  const kwMap = {}; // rel -> Set of keywords

  for (const f of allFiles) {
    const rel = path.relative(WIKI, f);
    if (excluded.has(path.basename(f))) continue;
    const parts = rel.split(path.sep);
    const topic = parts.length > 1 ? parts[0] : '';
    nodes.push({ id: rel, label: extractTitle(f), topic });
    kwMap[rel] = extractKeywords(f);

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

  // Layer 2: 关键词共现 — 即使已有显式链接也附加关键词信息
  const rels = Object.keys(kwMap);
  for (let i = 0; i < rels.length; i++) {
    for (let j = i + 1; j < rels.length; j++) {
      const a = rels[i], b = rels[j];
      const kwA = kwMap[a], kwB = kwMap[b];
      const shared = [];
      for (const w of kwA) { if (kwB.has(w)) shared.push(w); }
      if (shared.length < 2) continue;
      const key = [a, b].sort().join('|');
      const existing = edges.find(e => [e.source, e.target].sort().join('|') === key);
      if (existing) {
        // 把关键词附加到已有的显式链接边上
        existing.keywords = shared.slice(0, 5);
      } else {
        const minSize = Math.min(kwA.size, kwB.size) || 1;
        const weight = Math.min(0.8, 0.3 + (shared.length / minSize) * 0.5);
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
let batchProgress = null;
// Shape: { id, total, completed, failed, currentFile, status, startedAt, files: [{name, status, error?}] }
let writeLock = Promise.resolve(); // 串行锁：保护 index.md/log.md 并发写入

function latestTask() {
  return taskQueue.length ? taskQueue[taskQueue.length - 1] : null;
}

function pushTask(type) {
  const task = { id: Date.now().toString(36), status: 'compiling', message: '编译中...', type: type || 'ingest', created: null, startedAt: new Date().toISOString() };
  taskQueue.push(task);
  if (taskQueue.length > 20) taskQueue = taskQueue.slice(-20);
  return task;
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
  if (!pdfParse) throw new Error('pdf-parse 未安装，请运行 npm install pdf-parse');
  const buf = Buffer.from(b64, 'base64');
  const data = await pdfParse(buf);
  if (!data.text || data.text.trim().length < 10) {
    throw new Error('PDF 文本提取结果为空，该文件可能是扫描件（需要 OCR）');
  }
  return data.text;
}

function fetchHTML(url) {
  const isWechat = /mp\.weixin\.qq\.com/.test(url);
  const args = ['-sL', '-m', '30'];
  if (isWechat) {
    // Full browser headers to avoid WeChat anti-scraping
    args.push('-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    args.push('-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    args.push('-H', 'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8');
    args.push('-H', 'Cache-Control: no-cache');
  }
  args.push(url);
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const proc = spawn('curl', args, { timeout: 35000 });
    const chunks = []; let size = 0;
    proc.stdout.on('data', d => { size += d.length; if (size < 5 * 1024 * 1024) chunks.push(d); });
    proc.stderr.on('data', () => {});
    proc.on('error', reject);
    proc.on('close', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
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
    const html = await fetchHTML(url);
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

function normalizeTask(t) {
  return {
    ...t,
    model: t.model || null,
    provider: t.provider || null,
    nlSummary: t.nlSummary || null,
    templateId: t.templateId || null,
    version: t.version || 1
  };
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

async function executeAutotask(taskId, isManual = false) {
  const tasks = loadAutotasks();
  const task = tasks.find(t => t.id === taskId);
  if (!task) throw new Error('任务不存在');

  const modelOverrides = (task.provider && task.model) ? { provider: task.provider, model: task.model } : null;

  const runId = genId('run');
  const run = {
    id: runId, taskId: task.id, taskName: task.name,
    startedAt: new Date().toISOString(), finishedAt: null,
    status: 'running', itemsFound: 0, itemsIngested: 0, itemsSkipped: 0,
    items: [], error: null, manual: isManual
  };

  try {
    // 1. Fetch source items
    let sourceItems = [];
    if (task.sourceType === 'rss') {
      sourceItems = await fetchRSS(task.sourceConfig.url);
    } else if (task.sourceType === 'webpage') {
      sourceItems = await fetchWebpageLinks(task.sourceConfig.url, task.sourceConfig.selector);
    } else if (task.sourceType === 'api') {
      const raw = await new Promise((resolve, reject) => {
        const mod = task.sourceConfig.url.startsWith('https') ? https : http;
        const req = mod.get(task.sourceConfig.url, { headers: { 'User-Agent': 'WikiBot/1.0' } }, r => {
          let data = ''; r.on('data', c => data += c); r.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('API fetch timeout')); });
      });
      try {
        const parsed = JSON.parse(raw);
        const arr = parsed.items || parsed.articles || parsed.data || parsed.results || (Array.isArray(parsed) ? parsed : []);
        sourceItems = arr.map(it => ({
          title: it.title || it.name || '',
          url: it.url || it.link || '',
          description: it.description || it.summary || ''
        })).filter(it => it.title || it.url);
      } catch { sourceItems = []; }
    }

    // 2. Apply maxItems limit
    const maxItems = task.sourceConfig.maxItems || 5;
    sourceItems = sourceItems.slice(0, maxItems);
    run.itemsFound = sourceItems.length;

    // 3. Apply keyword filters
    if (task.filters && task.filters.keywords && task.filters.keywords.length) {
      sourceItems = sourceItems.filter(it => {
        const text = (it.title + ' ' + it.description).toLowerCase();
        return task.filters.keywords.some(kw => text.includes(kw.toLowerCase()));
      });
    }
    if (task.filters && task.filters.excludeKeywords && task.filters.excludeKeywords.length) {
      sourceItems = sourceItems.filter(it => {
        const text = (it.title + ' ' + it.description).toLowerCase();
        return !task.filters.excludeKeywords.some(kw => text.includes(kw.toLowerCase()));
      });
    }

    // 4. Process each item
    for (const item of sourceItems) {
      const itemResult = { title: item.title, url: item.url, status: 'pending', articlePath: null, reason: null };

      // Dedup check
      if (item.url) {
        const dupCheck = isDuplicate(item.url, null);
        if (dupCheck.dup) {
          itemResult.status = 'skipped';
          itemResult.reason = dupCheck.reason;
          run.itemsSkipped++;
          run.items.push(itemResult);
          continue;
        }
      }

      // Extract content
      try {
        const topicDir = task.topic && task.topic !== 'auto' ? task.topic : 'general';
        const rawDir = path.join(RAW, topicDir);
        fs.mkdirSync(rawDir, { recursive: true });

        const extractedText = await extractContent('url', null, null, item.url, rawDir);

        // Content-level dedup
        if (extractedText) {
          const dupCheck2 = isDuplicate(null, extractedText);
          if (dupCheck2.dup) {
            itemResult.status = 'skipped';
            itemResult.reason = dupCheck2.reason;
            run.itemsSkipped++;
            run.items.push(itemResult);
            continue;
          }
        }

        // Save raw file
        const date = new Date().toISOString().slice(0, 10);
        const slug = item.url.replace(/https?:\/\//, '').replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-').slice(0, 40);
        const rawFilename = `${date}-${slug}.md`;
        const filePath = path.join(rawDir, rawFilename);
        const rawContent = `# Source\n\n> Source: ${item.url}\n> Title: ${item.title}\n> Collected: ${date}\n> Type: autotask\n> Task: ${task.name}\n\n${extractedText}`;
        fs.writeFileSync(filePath, rawContent, 'utf-8');

        // Compile article
        const compileTask = pushTask('autotask');
        await compileArticle(topicDir, rawFilename, filePath, compileTask, modelOverrides);

        // Mark as ingested in dedup
        markIngested(item.url, extractedText, runId);

        itemResult.status = 'ingested';
        if (compileTask.created && compileTask.created.length > 0) {
          itemResult.articlePath = compileTask.created[0].path;
        }
        run.itemsIngested++;
        indexCache.invalidate('index');
        wikiCache.invalidate();
      } catch (e) {
        itemResult.status = 'error';
        itemResult.reason = e.message;
      }
      run.items.push(itemResult);
    }

    run.status = run.items.some(i => i.status === 'error') ? 'partial' : 'success';
  } catch (e) {
    run.status = 'error';
    run.error = e.message;
  }

  run.finishedAt = new Date().toISOString();

  // Update task lastRun info
  const updatedTasks = loadAutotasks();
  const tIdx = updatedTasks.findIndex(t => t.id === taskId);
  if (tIdx >= 0) {
    updatedTasks[tIdx].lastRunAt = run.finishedAt;
    updatedTasks[tIdx].lastRunStatus = run.status;
    saveAutotasks(updatedTasks);
  }

  // Save run to history
  const hist = loadHistory();
  hist.push(run);
  saveHistory(hist);

  return run;
}

// ── 服务器 ──

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const params = url.searchParams;

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
      const kws = extractKeywords(f);
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
      const kws = extractKeywords(f);
      const kwArr = [...kws];
      const genericKw = new Set(['概述', '总结', '背景', '简介', '引言', '正文', '结论', '附录', '参考', '说明', '定义', '目标', '方法', '结果', '讨论', '核心', '架构', '总览']);
      const title = extractTitle(f);
      // 按标点/空格/英文/中文连词分割标题，提取中文词汇
      const cnSegments = title.split(/[^一-\u9fff]+|[与和的及或从到在]+/).filter(s => s.length >= 2);
      // 短片段（≤4字）直接用；长片段用 2 字，但若首字是前缀（非/不/无/多）则取 3 字
      const prefixChars = '非不无多';
      const titleKw = cnSegments.map(s => {
        if (s.length <= 4) return s;
        return (s.length >= 3 && prefixChars.includes(s[0])) ? s.slice(0, 3) : s.slice(0, 2);
      }).filter(w => !genericKw.has(w));
      // 正文关键词（heading/bold）作备选
      const bodyKw = kwArr.filter(w => !genericKw.has(w) && w.length >= 2 && w.length <= 4 && !/^[a-z]{1,3}$/i.test(w));
      const keyword = titleKw[0] || bodyKw[0] || title.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '').slice(0, 4) || topic;
      nodes.push({ id: rel, name: extractTitle(f), topic, keyword });

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
      const kw = extractKeywords(f);
      for (const w of kw) {
        if (!freq[w]) freq[w] = { word: w, count: 0, articles: [] };
        freq[w].count++;
        freq[w].articles.push(rel);
      }
    }
    const keywords = Object.values(freq).sort((a, b) => b.count - a.count).slice(0, 30);
    return json(res, 200, { keywords });
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
    const running = taskQueue.find(t => t.status === 'compiling');
    if (running) return json(res, 409, { error: '已有编译任务进行中' });
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
        const isBatch = items.length > 1;

        if (isBatch) {
          batchProgress = {
            id: Date.now().toString(36),
            total: items.length,
            completed: 0,
            failed: 0,
            currentFile: items[0].name || items[0].filename || (items[0].content ? items[0].content.slice(0, 40) : ''),
            status: 'processing',
            startedAt: new Date().toISOString(),
            files: items.map(it => ({ name: it.name || it.filename || (it.content ? it.content.slice(0, 40) : ''), status: 'pending' }))
          };
        }

        async function processOneItem(idx) {
          const { type, content, topic, name, filename: itemFilename, url: itemUrl } = items[idx];
          if (isBatch) {
            batchProgress.currentFile = name || itemFilename || (content ? content.slice(0, 40) : '');
            batchProgress.files[idx].status = 'processing';
          }
          const topicDir = topic && topic !== 'auto' ? topic : 'general';
          const dir = path.join(RAW, topicDir);
          fs.mkdirSync(dir, { recursive: true });
          const date = new Date().toISOString().slice(0, 10);

          const isBinaryType = ['pdf', 'image', 'audio', 'video'].includes(type);
          let extractedText;
          try {
            extractedText = await extractContent(type, content, itemFilename || name, itemUrl, dir);
          } catch (extractErr) {
            if (isBatch) {
              batchProgress.files[idx].status = 'error';
              batchProgress.files[idx].error = extractErr.message;
              batchProgress.failed++;
              batchProgress.completed++;
            } else {
              const task = pushTask(type);
              task.status = 'error';
              task.message = `内容提取失败: ${extractErr.message}`;
            }
            return;
          }

          let slug = 'source';
          if (type === 'url') {
            slug = (itemUrl || content).replace(/https?:\/\//, '').replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-').slice(0, 40);
          } else if (isBinaryType && (itemFilename || name)) {
            slug = (itemFilename || name).replace(/\.[^.]+$/, '').replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-').slice(0, 40) || type;
          } else {
            slug = (extractedText.slice(0, 40).replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-') || 'text');
          }
          const rawFilename = `${date}-${slug}.md`;
          const filePath = path.join(dir, rawFilename);

          const sourceLabel = isBinaryType
            ? `${type} file: ${itemFilename || name || 'unknown'}`
            : (type === 'url' ? (itemUrl || content) : 'user input');
          const rawContent = `# Source\n\n> Source: ${sourceLabel}\n> Collected: ${date}\n> Type: ${type}\n\n${extractedText}`;
          fs.writeFileSync(filePath, rawContent, 'utf-8');

          const task = pushTask(type);
          try {
            await compileArticle(topicDir, rawFilename, filePath, task, modelOverrides);
            if (isBatch) {
              batchProgress.files[idx].status = 'done';
              batchProgress.completed++;
            }
          } catch (e) {
            if (isBatch) {
              batchProgress.files[idx].status = 'error';
              batchProgress.files[idx].error = e.message;
              batchProgress.failed++;
              batchProgress.completed++;
            }
          }
        }

        // 并发执行：批量最多 3 路并发，单文件 1 路
        const CONCURRENCY = isBatch ? 3 : 1;
        let cursor = 0;
        async function worker() {
          while (true) {
            const i = cursor++;
            if (i >= items.length) break;
            await processOneItem(i);
          }
        }
        Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker())
        ).then(() => { if (isBatch) batchProgress.status = 'done'; });

        const firstTask = latestTask();
        json(res, 200, { taskId: firstTask ? firstTask.id : 'unknown', batch: isBatch, batchId: isBatch ? batchProgress.id : null });
      } catch (e) { json(res, 400, { error: e.message }); }
    });
    return;
  }

  if (p === '/api/ingest/status') {
    const task = latestTask();
    if (!task) return json(res, 200, { status: 'idle' });
    const resp = { id: task.id, status: task.status, message: task.message };
    if (task.stages) resp.stages = task.stages;
    if (task.created) {
      resp.created = task.created;
      if (task.created.length > 0) resp.article = task.created[0];
    }
    return json(res, 200, resp);
  }

  if (p === '/api/ingest/batch/status') {
    if (!batchProgress) return json(res, 200, { status: 'idle' });
    const elapsed = Date.now() - new Date(batchProgress.startedAt).getTime();
    const avgPerFile = batchProgress.completed > 0 ? elapsed / batchProgress.completed : 0;
    const remaining = batchProgress.completed > 0 ? Math.round(avgPerFile * (batchProgress.total - batchProgress.completed) / 1000) : null;
    return json(res, 200, { ...batchProgress, estimatedRemaining: remaining });
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

    // POST /api/autotask/:id/run — manual trigger
    const runMatch = subPath.match(/^\/([^/]+)\/run$/);
    if (runMatch && req.method === 'POST') {
      const taskId = runMatch[1];
      const tasks = loadAutotasks();
      if (!tasks.find(t => t.id === taskId)) return json(res, 404, { error: '任务不存在' });
      executeAutotask(taskId, true).then(run => {
        // run result stored in history, no need to respond here
      }).catch(e => console.error('[AutoTask] 手动执行失败:', e.message));
      return json(res, 200, { ok: true, message: '任务已触发' });
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
          const task = {
            id: genId('at'),
            name: data.name || '未命名任务',
            sourceType: data.sourceType || 'rss',
            sourceConfig: data.sourceConfig || { url: '', maxItems: 5 },
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
            version: 2,
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
          t.version = 2;
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

// 启动时运行一次 lint
setTimeout(() => {
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

// ── 自动化任务调度器 ──
setInterval(() => {
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
        executeAutotask(task.id, false).catch(e => console.error(`[AutoTask] 任务失败: ${task.name}`, e.message));
      }
    });
  } catch (e) { console.error('[AutoTask] 调度器错误:', e.message); }
}, 5 * 60 * 1000);

server.listen(PORT, () => console.log(`Wiki 应用已启动：http://localhost:${PORT}`));
