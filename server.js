const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const os = require('os');

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
const CHATS = path.join(ROOT, 'data', 'chats');
fs.mkdirSync(CHATS, { recursive: true });

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

const PROVIDERS = {
  bailian: {
    name: '百炼 (阿里云)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long', 'qwen3.6-plus'],
    defaultModel: 'qwen-plus',
    format: 'openai'
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-sonnet-4', 'google/gemini-2.5-pro', 'openai/gpt-4o', 'meta-llama/llama-3.1-70b-instruct'],
    defaultModel: 'anthropic/claude-sonnet-4',
    format: 'openai'
  },
  anthropic: {
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-20250514', 'claude-haiku-4-20250414'],
    defaultModel: 'claude-sonnet-4-20250514',
    format: 'anthropic'
  },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
    defaultModel: 'gpt-4o',
    format: 'openai'
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    format: 'openai'
  },
  custom: {
    name: '自定义 (OpenAI 兼容)',
    baseUrl: '',
    models: [],
    defaultModel: '',
    format: 'openai'
  },
  local: {
    name: '本地 Claude CLI',
    baseUrl: '',
    models: ['claude'],
    defaultModel: 'claude',
    format: 'cli'
  }
};

function loadConfig() {
  let cfg = { provider: 'local', apiKey: '', model: '', customBaseUrl: '' };
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      cfg.provider = saved.provider || 'local';
      cfg.model = saved.model || '';
      cfg.customBaseUrl = saved.customBaseUrl || '';
      // config.json 不再存 key，仅作兼容读取
      if (saved.apiKey) cfg.apiKey = saved.apiKey;
    }
  } catch {}
  // 环境变量优先级最高
  if (process.env.WIKI_API_KEY) cfg.apiKey = process.env.WIKI_API_KEY;
  return cfg;
}

function saveConfig(cfg) {
  // 只存 provider/model/customBaseUrl，不存 apiKey
  const toSave = { provider: cfg.provider, model: cfg.model, customBaseUrl: cfg.customBaseUrl || '' };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2), 'utf-8');
}

// apiKey 单独存储到 .api-key 文件（不进 git）
const API_KEY_PATH = path.join(ROOT, '.api-key');
function saveApiKey(key) {
  fs.writeFileSync(API_KEY_PATH, key, 'utf-8');
  fs.chmodSync(API_KEY_PATH, 0o600); // 仅 owner 可读写
}
function loadApiKey() {
  try { return fs.readFileSync(API_KEY_PATH, 'utf-8').trim(); } catch { return ''; }
}
// 加载时合并 .api-key
function getFullConfig() {
  const cfg = loadConfig();
  if (!cfg.apiKey) cfg.apiKey = loadApiKey();
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
      return JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf-8'));
    }
  } catch {}
  return { items: [] };
}

function saveMemory(memory) {
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(memory, null, 2), 'utf-8');
}

function genMemoryId() {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function buildMemoryContext() {
  const memory = loadMemory();
  const active = memory.items.filter(m => m.active);
  if (active.length === 0) return null;
  const categoryLabels = { personal: '个人信息', expertise: '专业领域', preference: '偏好设置', context: '背景上下文' };
  const grouped = {};
  for (const item of active) {
    const cat = item.category || 'personal';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(item);
  }
  let text = '## 用户背景';
  for (const cat of ['personal', 'expertise', 'preference', 'context']) {
    if (!grouped[cat]) continue;
    for (const item of grouped[cat]) {
      text += `\n【${categoryLabels[cat] || cat}】${item.label}：${item.content}`;
    }
  }
  return text;
}

// Migration: create memory.json from profile.bio if it doesn't exist
function migrateMemory() {
  if (fs.existsSync(MEMORY_PATH)) return;
  const profile = loadProfile();
  const now = new Date().toISOString();
  const items = [];
  if (profile && profile.bio) {
    items.push({
      id: genMemoryId(),
      category: 'personal',
      label: '职业角色',
      content: profile.bio,
      active: true,
      createdAt: now,
      updatedAt: now
    });
  }
  saveMemory({ items });
}

// ── LLM 调用层 ──

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
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(300000, () => { req.destroy(); reject(new Error('请求超时 (300s)')); });
    req.write(body);
    req.end();
  });
}

async function callLLM(systemPrompt, messages, overrides) {
  // If messages is a string, convert to single-message array for backward compat
  const msgArray = typeof messages === 'string'
    ? [{ role: 'user', content: messages }]
    : messages;

  const config = getFullConfig();
  const providerKey = (overrides && overrides.provider) || config.provider || 'local';
  const provider = PROVIDERS[providerKey] || PROVIDERS.local;
  const model = (overrides && overrides.model) || config.model || provider.defaultModel;
  const apiKey = config.apiKey;

  if (provider.format === 'cli') {
    const combined = msgArray.map(m => `${m.role}: ${m.content}`).join('\n\n');
    return callLocalCLI(systemPrompt + '\n\n' + combined);
  }

  if (!apiKey) throw new Error('未配置 API Key，请在设置中配置');

  const baseUrl = (providerKey === 'custom' && config.customBaseUrl) ? config.customBaseUrl : provider.baseUrl;

  if (provider.format === 'anthropic') {
    const result = await httpPost(`${baseUrl}/v1/messages`, {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }, JSON.stringify({ model, max_tokens: 8192, system: systemPrompt, messages: msgArray }));
    return result.content[0].text;
  }

  // OpenAI-compatible (百炼, OpenRouter, OpenAI, DeepSeek, custom)
  const headers = { 'Authorization': `Bearer ${apiKey}` };
  if (providerKey === 'openrouter') {
    headers['HTTP-Referer'] = `http://localhost:${PORT}`;
    headers['X-Title'] = 'Wiki Knowledge Base';
  }
  const result = await httpPost(`${baseUrl}/chat/completions`, headers, JSON.stringify({
    model,
    messages: [{ role: 'system', content: systemPrompt }, ...msgArray],
    temperature: 0.3
  }));
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

  // API 模式：服务端驱动编译
  try {
    const rawContent = fs.readFileSync(filePath, 'utf-8');
    let indexContent = ''; try { indexContent = fs.readFileSync(path.join(WIKI, 'index.md'), 'utf-8'); } catch {}

    const existingTopics = [];
    if (fs.existsSync(WIKI)) {
      for (const d of fs.readdirSync(WIKI, { withFileTypes: true })) {
        if (d.isDirectory() && !d.name.startsWith('.')) existingTopics.push(d.name);
      }
    }

    const memCtxApi = buildMemoryContext();
    const bioContext = memCtxApi ? `\n\n${memCtxApi}\n\n请根据用户背景调整文章深度和侧重点，使内容更贴合用户的知识水平和兴趣领域。` : (() => { const profile = loadProfile(); return profile && profile.bio ? `\n\n## 用户背景\n\n${profile.bio}\n\n请根据用户背景调整文章深度和侧重点，使内容更贴合用户的知识水平和兴趣领域。` : ''; })();

    const systemPrompt = `你是一个知识库编译助手。将原始素材编译成结构化的知识库文章。

${COMPILE_RULES}

## 输出格式（严格遵守）

输出一个纯 JSON 对象，不要用 markdown 代码块包裹，不要有任何额外文字：
{"title":"文章标题（中文）","topic":"主题目录名（英文kebab-case）","filename":"文件名.md（英文kebab-case，基于概念命名）","content":"完整Markdown文章内容（中文）","summary":"一句话摘要（中文，20字以内）"}

要求：
- 文章语言中文
- content 是完整 Markdown：# 标题、> 来源/原文、正文、## See Also
- 来源原文路径: ../../raw/${topicDir}/${filename}
- topic 优先复用已有分类: ${existingTopics.join(', ') || '（暂无已有分类）'}${bioContext}`;

    const userMessage = `## 当前知识库索引\n\n${indexContent || '（空知识库）'}\n\n## 待编译素材\n\n文件: raw/${topicDir}/${filename}\n\n${rawContent}`;
    const response = await callLLM(systemPrompt, userMessage, overrides);

    // 解析 JSON（兼容代码块包裹）
    let jsonStr = response.trim();
    const cbMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (cbMatch) jsonStr = cbMatch[1].trim();
    const result = JSON.parse(jsonStr);

    // 写入文章
    const articleTopic = result.topic || topicDir || 'general';
    const articleDir = path.join(WIKI, articleTopic);
    fs.mkdirSync(articleDir, { recursive: true });
    const articleFilename = result.filename || `${Date.now()}.md`;
    const articlePath = path.join(articleDir, articleFilename);
    fs.writeFileSync(articlePath, result.content, 'utf-8');

    // 更新 index.md
    const today = new Date().toISOString().slice(0, 10);
    const indexPath = path.join(WIKI, 'index.md');
    let idx = ''; try { idx = fs.readFileSync(indexPath, 'utf-8'); } catch { idx = '# Knowledge Base Index\n'; }
    const newEntry = `| [${result.title}](${articleTopic}/${articleFilename}) | ${result.summary || ''} | ${today} |`;
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

    // 更新 log.md
    const logPath = path.join(WIKI, 'log.md');
    let log = ''; try { log = fs.readFileSync(logPath, 'utf-8'); } catch { log = '# Wiki Log\n'; }
    log += `\n## [${today}] ingest | ${result.title}\n`;
    fs.writeFileSync(logPath, log, 'utf-8');

    const relPath = `${articleTopic}/${articleFilename}`;
    task.status = 'done'; task.message = '编译完成'; task.created = [{ path: relPath, title: result.title }];
    indexCache.invalidate('index');
    wikiCache.invalidate();
  } catch (e) {
    task.status = 'error'; task.message = `编译失败: ${e.message}`;
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

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

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
        const children = fs.readdirSync(path.join(dir, d.name), { withFileTypes: true })
          .filter(f => f.isFile() && f.name.endsWith('.md'))
          .map(f => ({ name: f.name.replace('.md', ''), file: f.name, path: d.name + '/' + f.name, title: extractTitle(path.join(dir, d.name, f.name)) }));
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

function fetchUrlContent(url) {
  try {
    const html = execSync(`curl -sL -m 30 "${url.replace(/"/g, '\\"')}"`, { encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 });
    const text = stripHtml(html);
    if (text.length > 100) return text;
    return `[Fetched content too short]\n\nURL: ${url}\n\n${text}`;
  } catch (e) {
    return `[Fetch failed: ${e.message}]\n\nURL: ${url}`;
  }
}

// ── 服务器 ──

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const params = url.searchParams;

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
      nodes.push({ id: rel, name: extractTitle(f), topic });

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
      try {
        const { data } = JSON.parse(body); // base64 encoded zip
        const tmpDir = path.join(os.tmpdir(), 'wiki-zip-' + Date.now());
        const zipPath = tmpDir + '.zip';
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(zipPath, Buffer.from(data, 'base64'));
        try { execSync(`unzip -o "${zipPath}" -d "${tmpDir}"`, { stdio: 'pipe' }); } catch (e) {
          fs.unlinkSync(zipPath);
          fs.rmSync(tmpDir, { recursive: true, force: true });
          return json(res, 400, { error: 'ZIP 解压失败: ' + (e.stderr ? e.stderr.toString().slice(0, 200) : e.message) });
        }
        const files = [];
        function walkDir(dir) {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walkDir(full); continue; }
            if (/\.(md|txt|html|json|csv|xml)$/i.test(entry.name)) {
              const content = fs.readFileSync(full, 'utf-8');
              files.push({ name: entry.name, content });
            }
          }
        }
        walkDir(tmpDir);
        // Cleanup
        fs.unlinkSync(zipPath);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return json(res, 200, { files });
      } catch (e) { return json(res, 400, { error: e.message }); }
    });
    return;
  }

  if (p === '/api/ingest' && req.method === 'POST') {
    const running = taskQueue.find(t => t.status === 'compiling');
    if (running) return json(res, 409, { error: '已有编译任务进行中' });
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const items = parsed.items || [{ type: parsed.type, content: parsed.content, topic: parsed.topic }];
        const modelOverrides = (parsed.provider && parsed.model) ? { provider: parsed.provider, model: parsed.model } : null;
        const isBatch = items.length > 1;

        if (isBatch) {
          batchProgress = {
            id: Date.now().toString(36),
            total: items.length,
            completed: 0,
            failed: 0,
            currentFile: items[0].name || items[0].content.slice(0, 40),
            status: 'processing',
            startedAt: new Date().toISOString(),
            files: items.map(it => ({ name: it.name || it.content.slice(0, 40), status: 'pending' }))
          };
        }

        async function processItem(idx) {
          if (idx >= items.length) {
            if (isBatch) batchProgress.status = 'done';
            return;
          }
          const { type, content, topic, name } = items[idx];
          if (isBatch) {
            batchProgress.currentFile = name || content.slice(0, 40);
            batchProgress.files[idx].status = 'processing';
          }
          const topicDir = topic && topic !== 'auto' ? topic : 'general';
          const dir = path.join(RAW, topicDir);
          fs.mkdirSync(dir, { recursive: true });
          const date = new Date().toISOString().slice(0, 10);
          let slug = 'source';
          if (type === 'url') slug = content.replace(/https?:\/\//, '').replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-').slice(0, 40);
          else slug = (content.slice(0, 40).replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-') || 'text');
          const filename = `${date}-${slug}.md`;
          const filePath = path.join(dir, filename);
          let rawContent;
          if (type === 'url') {
            const fetched = fetchUrlContent(content);
            rawContent = `# Source\n\n> Source: ${content}\n> Collected: ${date}\n> Published: Unknown\n\n${fetched}`;
          } else {
            rawContent = `# Source\n\n> Source: user input\n> Collected: ${date}\n\n${content}`;
          }
          fs.writeFileSync(filePath, rawContent, 'utf-8');

          const task = pushTask(type);
          try {
            await compileArticle(topicDir, filename, filePath, task, modelOverrides);
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
          await processItem(idx + 1);
        }

        processItem(0);

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
    if (task.created) resp.created = task.created;
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

  // GET /api/wiki/lint — Health Check
  if (p === '/api/wiki/lint') {
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

    const brokenLinks = [];
    for (const f of allFiles) {
      const rel = path.relative(WIKI, f);
      const links = extractLinks(f);
      for (const link of links) {
        const target = resolveLink(f, link);
        if (!target) continue;
        if (excluded.has(path.basename(target))) continue;
        if (!allRels.has(target)) {
          brokenLinks.push({ source: rel, link, target });
        } else {
          if (inboundMap[target]) inboundMap[target].push(rel);
          totalConnections++;
        }
      }
    }

    const orphans = [];
    const missingFromIndex = [];
    for (const rel of allRels) {
      if ((inboundMap[rel] || []).length === 0) {
        orphans.push({ path: rel, title: extractTitle(path.join(WIKI, rel)) });
      }
      if (!indexLinked.has(rel)) {
        missingFromIndex.push({ path: rel, title: extractTitle(path.join(WIKI, rel)) });
      }
    }

    // Extra stats
    const rawFiles = walkMd(RAW);
    let totalWords = 0;
    for (const f of allFiles) {
      try {
        const c = fs.readFileSync(f, 'utf-8').replace(/```[\s\S]*?```/g, '').replace(/[#*_`>\[\]\(\)!|~-]/g, '').replace(/\s+/g, '');
        totalWords += c.length;
      } catch {}
    }
    const config = getFullConfig();
    const providerName = (PROVIDERS[config.provider] || {}).name || config.provider;

    return json(res, 200, { orphans, brokenLinks, missingFromIndex, totalArticles: allRels.size, totalConnections, rawCount: rawFiles.length, totalWords, provider: providerName, hasKey: !!(config.apiKey) || config.provider === 'local' });
  }

  // GET /api/settings — 获取当前配置
  if (p === '/api/settings' && req.method === 'GET') {
    const config = getFullConfig();
    return json(res, 200, {
      provider: config.provider,
      model: config.model,
      customBaseUrl: config.customBaseUrl || '',
      providers: PROVIDERS,
      hasKey: !!config.apiKey
    });
  }

  // PUT /api/settings — 保存配置
  if (p === '/api/settings' && req.method === 'PUT') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { provider, apiKey, model, customBaseUrl } = JSON.parse(body);
        const config = loadConfig();
        if (provider) config.provider = provider;
        if (typeof model === 'string') config.model = model;
        if (typeof customBaseUrl === 'string') config.customBaseUrl = customBaseUrl;
        saveConfig(config);
        // apiKey 单独存储到 .api-key 文件
        if (typeof apiKey === 'string' && apiKey.trim()) saveApiKey(apiKey.trim());
        return json(res, 200, { ok: true });
      } catch (e) { return json(res, 400, { error: e.message }); }
    });
    return;
  }

  // POST /api/settings/test — 测试连接
  if (p === '/api/settings/test' && req.method === 'POST') {
    (async () => {
      try {
        const answer = await callLLM('你是一个测试助手。', '请回复"连接成功"四个字。');
        return json(res, 200, { ok: true, message: answer.trim().slice(0, 100) });
      } catch (e) {
        return json(res, 200, { ok: false, message: e.message.slice(0, 300) });
      }
    })();
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
        if (!nickname || !nickname.trim()) return json(res, 400, { error: '昵称不能为空' });
        saveProfile({ nickname: nickname.trim(), bio: (bio || '').trim() });
        return json(res, 200, { ok: true });
      } catch (e) { return json(res, 400, { error: e.message }); }
    });
    return;
  }

  // GET /api/memory — 获取所有记忆
  if (p === '/api/memory' && req.method === 'GET') {
    return json(res, 200, loadMemory());
  }

  // POST /api/memory — 新增记忆
  if (p === '/api/memory' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { category, label, content } = JSON.parse(body);
        if (!label || !content) return json(res, 400, { error: '标签和内容不能为空' });
        const now = new Date().toISOString();
        const item = { id: genMemoryId(), category: category || 'personal', label: label.trim(), content: content.trim(), active: true, createdAt: now, updatedAt: now };
        const memory = loadMemory();
        memory.items.push(item);
        saveMemory(memory);
        return json(res, 200, item);
      } catch (e) { return json(res, 400, { error: e.message }); }
    });
    return;
  }

  // PUT /api/memory/:id — 更新记忆
  const memPutMatch = p.match(/^\/api\/memory\/(.+)$/);
  if (memPutMatch && req.method === 'PUT') {
    const memId = memPutMatch[1];
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const updates = JSON.parse(body);
        const memory = loadMemory();
        const item = memory.items.find(m => m.id === memId);
        if (!item) return json(res, 404, { error: '记忆项不存在' });
        if (typeof updates.label === 'string') item.label = updates.label.trim();
        if (typeof updates.content === 'string') item.content = updates.content.trim();
        if (typeof updates.category === 'string') item.category = updates.category;
        if (typeof updates.active === 'boolean') item.active = updates.active;
        item.updatedAt = new Date().toISOString();
        saveMemory(memory);
        return json(res, 200, item);
      } catch (e) { return json(res, 400, { error: e.message }); }
    });
    return;
  }

  // DELETE /api/memory/:id — 删除记忆
  const memDelMatch = p.match(/^\/api\/memory\/(.+)$/);
  if (memDelMatch && req.method === 'DELETE') {
    const memId = memDelMatch[1];
    const memory = loadMemory();
    const idx = memory.items.findIndex(m => m.id === memId);
    if (idx < 0) return json(res, 404, { error: '记忆项不存在' });
    memory.items.splice(idx, 1);
    saveMemory(memory);
    return json(res, 200, { ok: true });
  }

  // 静态文件
  let filePath = p === '/' ? path.join(APP, 'index.html') : path.join(APP, p);
  if (!filePath.startsWith(APP)) { res.writeHead(403); return res.end(); }
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
});

migrateMemory();
server.listen(PORT, () => console.log(`Wiki 应用已启动：http://localhost:${PORT}`));
