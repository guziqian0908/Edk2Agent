#!/usr/bin/env node
/**
 * Edk2Agent Web Q&A service (LAN-accessible, lightweight).
 *
 * Routes:
 *   GET  /               -> index.html (static UI)
 *   POST /api/ask        -> search KB via daemon /search, then LLM answer
 *   GET  /api/status     -> forward daemon /health
 *   GET  /healthz        -> this service's own liveness
 *
 * Config (env vars):
 *   PORT              web port (default 8080)
 *   HOST              web bind address (default 0.0.0.0)
 *   KB_HOST           daemon bind override (default 127.0.0.1)
 *   LLM_API_KEY       OpenAI-compatible API key (required for LLM answers)
 *   LLM_BASE_URL      base URL, e.g. https://open.bigmodel.cn/api/paas/v4
 *   LLM_MODEL         model name, e.g. glm-4-flash
 *   KB_DATA_DIR       override knowledge base root (default ~/.edk2-opencode/kb)
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const WEB_DIR = __dirname;
const DEFAULT_KB_DIR = path.join(os.homedir(), '.edk2-opencode', 'kb');
const RERANK_SCRIPT = path.join(WEB_DIR, 'rerank.py');
const RERANK_SERVER = process.env.RERANK_SERVER || 'http://127.0.0.1:18766';

// Context cache to reduce redundant searches (LRU with max 100 entries)
const contextCache = new Map();
const MAX_CACHE_SIZE = 100;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function normalizeQuery(q) {
  return q.toLowerCase().trim().replace(/\s+/g, ' ');
}

function getCachedContext(query) {
  const key = normalizeQuery(query);
  const cached = contextCache.get(key);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return cached.data;
  }
  contextCache.delete(key);
  return null;
}

function setCachedContext(query, data) {
  const key = normalizeQuery(query);
  
  // LRU eviction if cache is full
  if (contextCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = contextCache.keys().next().value;
    contextCache.delete(oldestKey);
  }
  
  contextCache.set(key, { data, timestamp: Date.now() });
}

// Rerank documents using BGE-reranker-v2-m3
function rerankDocuments(query, docs) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(docs) || docs.length === 0) {
      resolve(docs);
      return;
    }
    
    const fallback = () => docs.sort((a, b) => (b.score || 0) - (a.score || 0));
    
    // Call the persistent rerank HTTP service
    const body = JSON.stringify({ query, docs });
    const u = new URL(`${RERANK_SERVER}/rerank`);
    const protocol = u.protocol === 'https:' ? https : http;
    const req = protocol.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.results && Array.isArray(parsed.results)) {
            resolve(parsed.results);
          } else if (parsed.error) {
            console.error(`Rerank service error: ${parsed.error}`);
            resolve(fallback());
          } else {
            resolve(fallback());
          }
        } catch (e) {
          console.error(`Rerank parse error: ${e.message}`);
          resolve(fallback());
        }
      });
    });
    req.on('error', (e) => {
      console.error(`Rerank service unavailable: ${e.message}`);
      resolve(fallback());
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
      resolve(fallback());
    });
    req.write(body);
    req.end();
  });
}

// Minimal .env loader (no external dependency). Only sets variables that are
// not already present in the environment, so shell-set values win.
function loadDotEnv() {
  const envFile = path.join(WEB_DIR, '.env');
  let raw;
  try { raw = fs.readFileSync(envFile, 'utf-8'); } catch { return; }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(t);
    if (!m) continue;
    const [, name, value] = m;
    if (process.env[name] === undefined) {
      process.env[name] = value.replace(/^["']|["']$/g, '');
    }
  }
}
loadDotEnv();

// ---- rate limiting (per client IP, in-memory) ----
const ASK_LIMIT = parseInt(process.env.RATE_LIMIT_ASK || '10', 10);      // /api/ask per window
const STATUS_LIMIT = parseInt(process.env.RATE_LIMIT_STATUS || '60', 10); // /api/status per window
const RATE_WINDOW_MS = 60 * 1000;
const rateBuckets = new Map();

function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function rateLimit(ip, limit) {
  const now = Date.now();
  const key = ip;
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.reset < now) {
    bucket = { count: 0, reset: now + RATE_WINDOW_MS };
    rateBuckets.set(key, bucket);
  }
  bucket.count++;
  if (rateBuckets.size > 20000) {
    for (const [k, b] of rateBuckets) {
      if (b.reset < now) rateBuckets.delete(k);
    }
  }
  return bucket;
}

function getKbDir() {
  return process.env.KB_DATA_DIR || DEFAULT_KB_DIR;
}

function readDaemonState() {
  const stateFile = path.join(getKbDir(), 'daemon.json');
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  } catch {
    return null;
  }
}

function httpJson(url, { method = 'GET', payload = null, headers = null, timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const protocol = u.protocol === 'https:' ? https : http;
    const req = protocol.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
        ...(headers || {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(data); } catch { body = data; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (payload) req.write(JSON.stringify(payload));
    req.end();
  });
}

function getDaemonUrl() {
  const st = readDaemonState();
  if (st && st.url) return st.url;
  return null;
}

// The daemon may bind 0.0.0.0 (LAN / tunnel exposure); 0.0.0.0 is not a valid
// connect() destination, so rewrite it to the loopback interface for the web
// service's own outbound requests.
function normalizeDaemonUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === '0.0.0.0' || u.hostname === '::') u.hostname = '127.0.0.1';
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return url;
  }
}

// Resolve a daemon endpoint that is actually healthy. Unlike getDaemonUrl(),
// this does NOT trust a stale daemon.json: if the recorded endpoint is not
// responding, the daemon is (re)started and the fresh endpoint is returned.
// Returns null when the daemon could not be made healthy.
async function getHealthyDaemonUrl() {
  const recorded = getDaemonUrl();
  if (recorded) {
    const norm = normalizeDaemonUrl(recorded);
    try {
      const h = await httpJson(`${norm}/health`, { timeoutMs: 5000 });
      if (h.status >= 200 && h.status < 300) return norm;
    } catch {}
  }
  const r = await ensureDaemonRunning();
  if (r.status !== 0) return null;
  return normalizeDaemonUrl(getDaemonUrl());
}

function getModelPath(kbDir) {
  return path.join(os.homedir(), '.edk2-opencode', 'models');
}

async function ensureDaemonRunning() {
  const kbDir = getKbDir();
  const script = path.join(__dirname, '..', 'bin', 'edk2-opencode.js');
  const host = process.env.KB_HOST || '127.0.0.1';
  const env = { ...process.env };
  if (host !== '127.0.0.1') env.EDK2_KB_HOST = host;
  const r = spawnSync('node', [script, 'daemon', 'start'], {
    cwd: path.join(__dirname, '..'),
    env,
    encoding: 'utf-8',
    timeout: 120000,
  });
  return r;
}

// Chinese->English query expansion: the KB is indexed from English
// TianoCore wiki/docs pages, so a Chinese-only query finds few vector/BM25
// hits. Expanding common firmware terms keeps the high-value English
// documents (commit rules, coding standards, sign-off) reachable.
function expandChineseQuery(q) {
  const lower = q.toLowerCase();
  const terms = [];
  
  // === 核心流程类 ===
  if (/提交|commit|签off|签名/.test(lower)) 
    terms.push('commit requirements commit message format commit signature Signed-off-by code contribution');
  if (/编码规范|代码风格|代码格式|coding|style/.test(lower)) 
    terms.push('coding standards code style EDK II coding standards specification');
  if (/签名|signoff|sign-off|signed-off-by/.test(lower)) 
    terms.push('Signed-off-by commit signature format');
  
  // === 启动流程类 ===
  if (/pei|dxe|bds|sec|pei阶段|dxe阶段|启动阶段|启动流程/.test(lower)) 
    terms.push('PI boot flow PEI DXE BDS SEC phase boot sequence Platform Initialization');
  if (/启动|boot|引导|uefi启动/.test(lower)) 
    terms.push('boot flow boot sequence UEFI boot PI specification');
  
  // === 配置与模块类 ===
  if (/pcd|pcd配置|平台配置|动态配置/.test(lower)) 
    terms.push('PCD Platform Configuration Database PCD usage dynamic configuration');
  if (/protocol|协议|uefi协议|驱动协议/.test(lower)) 
    terms.push('UEFI protocol EFI protocol driver protocol protocol usage');
  if (/inf|dsc|dec|inf文件|dsc文件|dec文件|包配置/.test(lower)) 
    terms.push('EDK2 INF DSC DEC file format package module definition');
  
  // === 驱动开发类 ===
  if (/驱动|driver|uefi驱动|驱动开发/.test(lower)) 
    terms.push('UEFI driver driver model driver binding DriverBinding Protocol');
  if (/模块|module|uefi模块|驱动模块/.test(lower)) 
    terms.push('UEFI module driver module EDK II module');
  
  // === 构建编译类 ===
  if (/构建|build|编译|edk2编译|编译环境/.test(lower)) 
    terms.push('build toolchain GCC VS ICC compilation build process');
  if (/工具链|toolchain|编译器|编译工具/.test(lower)) 
    terms.push('toolchain GCC Visual Studio ICC compiler build tools');
  
  // === 测试调试类 ===
  if (/测试|test|单元测试|单元测试/.test(lower)) 
    terms.push('unit test testing test framework validation');
  if (/调试|debug|调试方法|调试工具/.test(lower)) 
    terms.push('debug debugging debug tools GDB WinDbg');
  
  // === 安全规范类 ===
  if (/安全|security|安全编码|安全规范/.test(lower)) 
    terms.push('security secure coding security guide security review');
  if (/漏洞|vulnerability|缓冲区|溢出/.test(lower)) 
    terms.push('vulnerability buffer overflow security mitigation DEP ASLR');
  
  // === 代码审查类 ===
  if (/审查|review|代码审查|代码review/.test(lower)) 
    terms.push('code review review process review guidelines');
  if (/patchcheck|patch检查|格式检查/.test(lower)) 
    terms.push('PatchCheck validation commit format check');
  
  // === 文档规范类 ===
  if (/文档|document|注释|comment/.test(lower)) 
    terms.push('documentation comments Doxygen documenting code');
  if (/许可|license|开源协议|bsd/.test(lower)) 
    terms.push('license BSD open source licensing contribution agreement');
  
  // === 平台包类 ===
  if (/ovmf|虚拟机|qemu|虚拟固件/.test(lower)) 
    terms.push('OVMF QEMU virtual firmware emulator');
  if (/emulatorpkg|模拟器|windows模拟/.test(lower)) 
    terms.push('EmulatorPkg Windows emulator simulation');
  
  return terms.length ? `${q} ${terms.join(' ')}` : q;
}

// Classify question intent to optimize retrieval and answering strategy
function classifyQuestion(question) {
  const q = question.toLowerCase();
  
  const patterns = {
    'howto': /^(如何|怎么|怎样|how to|how do i)/i,
    'what': /^(是什么|什么是|what is|what are)/i,
    'format': /^(格式|格式是什么|format|format of)/i,
    'error': /^(错误|报错|失败|error|fail|cannot|问题)/i,
    'example': /^(示例|例子|example|sample|demo)/i,
    'list': /^(列出|列举|有哪些|list|what are the)/i,
    'compare': /^(区别|差异|比较|compare|difference)/i,
    'best': /^(最佳|推荐|建议|best|recommend)/i
  };
  
  for (const [type, regex] of Object.entries(patterns)) {
    if (regex.test(q)) return type;
  }
  
  // Context-based classification
  if (/commit|提交|签名|sign/.test(q)) return 'format';
  if (/驱动|driver|protocol|协议/.test(q)) return 'howto';
  if (/pcd|inf|dsc|dec/.test(q)) return 'format';
  if (/启动|boot|pei|dxe/.test(q)) return 'what';
  
  return 'general';
}

// Strip the per-chunk metadata header (Title/URL/Source/Chunk/Position) that
// the embedder prepends to each stored chunk. It is useful for retrieval but
// is noise for the LLM and pushes it toward quoting raw fragments; the real
// section heading and body are enough.
function cleanChunk(block) {
  const lines = String(block || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^(Title|URL|Source|Chunk|Position):\s*/i.test(line)) continue;
    if (line === '') { if (out.length === 0) continue; out.push(line); continue; }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Same-topic aggregation: the /search endpoint already collapses chunks of
// the same document to its best chunk. Here we additionally drop low-value
// boilerplate docs (plain ReadMe/license files, duplicate per-repo
// CONTRIBUTIONS.txt copies) so the LLM is not distracted by unrelated
// fragments, and trim to a token budget that fits the model.
function aggregateContext(results) {
  const out = [];
  const seenKeys = new Set();
  const contributions = [];
  for (const r of results) {
    const file = String(r.file || '');
    const lower = (file + ' ' + (r.title || '')).toLowerCase();
    if (/contributions\.txt$/i.test(file)) {
      // CONTRIBUTIONS.txt carries the commit/contribution rules; all repos
      // ship mostly identical copies, so keep only the fullest one and drop
      // the rest to avoid inflating the prompt with near-duplicate text.
      contributions.push(r);
      continue;
    }
    if (/^readme|readme\.|license|copying|copyright/i.test(lower)
        && !/specification/i.test(lower)) {
      continue;
    }
    const body = cleanChunk(r.content || r.snippet || '');
    const key = (r.url || r.file || r.title || '');
    if (!body || seenKeys.has(key)) continue;
    seenKeys.add(key);
    out.push({
      title: r.title || r.file || 'Untitled',
      type: r.type || 'docs',
      source: r.source_display || r.source || '',
      url: r.url || '',
      section: r.section || '',
      body: body.substring(0, 4500),
    });
  }
  // Keep only the fullest CONTRIBUTIONS.txt (they are per-repo copies of the
  // same rules text, so one authoritative copy is enough for the LLM).
  contributions.sort((a, b) =>
    (String(b.content || b.snippet || '').length) -
    (String(a.content || a.snippet || '').length));
  const kept = contributions.slice(0, 1);
  for (const r of kept) {
    const body = cleanChunk(r.content || r.snippet || '');
    const key = (r.url || r.file || r.title || '');
    if (!body || seenKeys.has(key)) continue;
    seenKeys.add(key);
    out.push({
      title: r.file || 'Contribution Rules',
      type: r.type || 'docs',
      source: r.source_display || r.source || '',
      url: r.url || '',
      section: r.section || '',
      body: body.substring(0, 6000),
    });
  }
  return out;
}

// Enhanced context aggregation with topic clustering and priority ranking
function aggregateContextEnhanced(results) {
  const sourcePriority = {
    'tianocore-wiki': 100, 'wiki': 100, 'tianocore-docs': 80,
    'spec': 90, 'specification': 90, 'guide': 70, 'tutorial': 60, 'docs': 50, 'default': 40
  };
  
  const topicClusters = {
    'commit': ['commit', 'submit', '贡献', 'patch', 'pull request'],
    'signature': ['签名', 'signature', 'signed-off-by', 'signoff', 'dco'],
    'coding': ['编码', 'coding', 'code style', '格式', 'format', '规范'],
    'build': ['构建', 'build', '编译', 'compile', 'toolchain', '工具链'],
    'driver': ['驱动', 'driver', '模块', 'module', 'protocol', '协议'],
    'boot': ['启动', 'boot', 'pei', 'dxe', 'bds', 'sec', 'flow'],
    'security': ['安全', 'security', '漏洞', 'vulnerability', 'mitigation'],
    'test': ['测试', 'test', '调试', 'debug', '验证', 'validation']
  };
  
  function getTopic(text) {
    const lower = (text || '').toLowerCase();
    for (const [topic, keywords] of Object.entries(topicClusters)) {
      for (const kw of keywords) { if (lower.includes(kw)) return topic; }
    }
    return 'general';
  }
  
  function getSourcePriority(source) {
    const s = (source || '').toLowerCase();
    for (const [key, priority] of Object.entries(sourcePriority)) {
      if (s.includes(key)) return priority;
    }
    return sourcePriority['default'];
  }
  
  const out = [];
  const seenKeys = new Set();
  const contributions = [];
  const topicGroups = new Map();
  
  for (const r of results) {
    const topic = getTopic(r.title + ' ' + r.section + ' ' + (r.content || r.snippet || ''));
    if (!topicGroups.has(topic)) topicGroups.set(topic, []);
    topicGroups.get(topic).push(r);
  }
  
  for (const [topic, group] of topicGroups) {
    group.sort((a, b) => {
      const pa = getSourcePriority(a.source_display || a.source);
      const pb = getSourcePriority(b.source_display || b.source);
      if (pa !== pb) return pb - pa;
      return (b.score || 0) - (a.score || 0);
    });
    
    for (const r of group) {
      const file = String(r.file || '');
      const lower = (file + ' ' + (r.title || '')).toLowerCase();
      
      if (/contributions\.txt$/i.test(file)) { contributions.push(r); continue; }
      if (/^readme|readme\.|license|copying|copyright/i.test(lower) && !/specification/i.test(lower)) continue;
      
      const body = cleanChunk(r.content || r.snippet || '');
      const key = (r.url || r.file || r.title || '');
      if (!body || seenKeys.has(key)) continue;
      seenKeys.add(key);
      
      const priority = getSourcePriority(r.source_display || r.source);
      const maxLen = priority >= 90 ? 6000 : priority >= 70 ? 5000 : 4000;
      
      out.push({
        title: r.title || r.file || 'Untitled', type: r.type || 'docs',
        source: r.source_display || r.source || '', url: r.url || '',
        section: r.section || '', topic: topic, priority: priority,
        body: body.substring(0, maxLen),
      });
    }
  }
  
  contributions.sort((a, b) => (String(b.content || b.snippet || '').length) - (String(a.content || b.snippet || '').length));
  const kept = contributions.slice(0, 1);
  for (const r of kept) {
    const body = cleanChunk(r.content || r.snippet || '');
    const key = (r.url || r.file || r.title || '');
    if (!body || seenKeys.has(key)) continue;
    seenKeys.add(key);
    out.push({
      title: r.file || 'Contribution Rules', type: r.type || 'docs',
      source: r.source_display || r.source || '', url: r.url || '',
      section: r.section || '', topic: 'commit', priority: 95,
      body: body.substring(0, 6000),
    });
  }
  
  out.sort((a, b) => b.priority - a.priority);
  return out;
}

function buildMessages(question, results, history) {
  const ctx = aggregateContextEnhanced(results);
  const intent = classifyQuestion(question);
  
  // Add intent-specific guidance to system prompt
  let intentGuidance = '';
  if (intent === 'format') {
    intentGuidance = '\n\n**Question Intent**: The user is asking about format/specification. Focus on providing exact format templates, character limits, and validation tools.';
  } else if (intent === 'howto') {
    intentGuidance = '\n\n**Question Intent**: The user is asking for step-by-step instructions. Provide clear numbered steps, prerequisites, and command examples.';
  } else if (intent === 'error') {
    intentGuidance = '\n\n**Question Intent**: The user is facing an error. Focus on root cause analysis, common pitfalls, and troubleshooting steps.';
  } else if (intent === 'example') {
    intentGuidance = '\n\n**Question Intent**: The user wants examples. Prioritize showing complete, working code/config examples with explanations.';
  }
  
  const context = ctx.map((r, i) => (
    `[${i + 1}] ${r.title}\n` +
    (r.type ? `Type: ${r.type}\n` : '') +
    (r.source ? `Source: ${r.source}\n` : '') +
    (r.url ? `URL: ${r.url}\n` : '') +
    (r.section ? `Section: ${r.section}\n` : '') +
    `Content:\n${r.body}\n`
  )).join('\n');

  const system = [
    'You are an EDK2/TianoCore firmware development expert answering from the retrieved EDK2 documentation context.',
    intentGuidance,
    '',
    '## 全局统一改造规则（每条问答必须全部遵守）',
    '',
    '### 1. 开篇强制加一句话高度总结',
    '先用一句话提炼问题核心本质、底层设计目的，不直接罗列知识点。示例：',
    '- "UEFI驱动模型通过Driver Binding Protocol实现设备与驱动的动态绑定与生命周期管理。"',
    '- "Commit格式规范通过PatchCheck CI强制拦截不合规提交，确保代码追溯性与历史可维护性。"',
    '',
    '### 2. 措辞统一，区分强制/建议',
    '- 把模糊词汇「推荐、尽量、一般」替换为固件专业表述：**必须、禁止、红线、强制、不合规**',
    '- 所有规则分两级标注：',
    '  - **【强制要求】**：CI工具、代码评审直接驳回，不允许合入代码',
    '  - **【最佳实践】**：仅评审建议，不阻断提交，但工程规范推荐遵守',
    '',
    '### 3. 重构逻辑框架，脱离原文碎片化顺序',
    '- **禁止**照搬参考文档原有段落顺序',
    '- 站在固件开发者实操视角重新分层归类',
    '- 融合多条参考文档交叉信息，打通分散知识点关联',
    '- 杜绝"文档A说X，文档B说Y"的平铺罗列',
    '',
    '### 4. 补齐工程落地增值信息（每条按需补充）',
    '1) 区分高频常用、冷门类型，高频内容前置',
    '2) 配套完整可复制标准示例，用✅标记；违规错误示例用❌标记，成对对比展示',
    '3) 补充开发高频编译/CI/PR报错、根因与修复方案',
    '4) **仅编码规范、代码排版、提交规范类问题**，末尾补充校验工具（PatchCheck/Uncrustify/Stuart CI）',
    '',
    '### 5. 针对性专项补齐独有硬性规范',
    '根据问题类型选择性补充（不强行堆砌无关细节）：',
    '',
    '**编码/注释类问答**（提问为代码注释、函数排版、文件头规范时）：',
    '- 统一替换`@return`为EDK标准`@retval`',
    '- 文件头强制增加`@par Specification Reference`',
    '- 无参函数必须写`(VOID)`',
    '- 函数原型格式规范',
    '- 全局变量存放位置要求',
    '- `IN/IN OUT/OUT/OPTIONAL`参数书写顺序红线',
    '',
    '**INF/DSC/PCD/Depex类构建相关**：',
    '- 完善配置覆盖、继承、优先级底层逻辑',
    '',
    '**Driver Binding驱动相关**：',
    '- 严格划分Supported/Start/Stop职责边界',
    '- 明确各类OpenProtocol合法属性与禁用场景',
    '- 区分设备/总线驱动差异化实现',
    '',
    '**代码提交规范类**：',
    '- Commit长度阈值（标题≤76字符，正文每行≤72字符）',
    '- 多包Global前缀格式',
    '- Signed-off-by强制规则',
    '- 提交拆分bisect约束',
    '- 本地CI+PR全流程',
    '- Azure流水线检查项',
    '',
    '### 6. 禁止单纯摘抄、直译原文',
    '- **禁止**仅分段罗列文档片段并翻译',
    '- 必须完成信息归纳、提炼重点、补充工程实操解读',
    '- 体现LLM整合梳理价值',
    '',
    '## Citation rules',
    '- **强制要求**：每条【强制要求】规则必须标注来源文档URL',
    '- 引用格式：`规则内容 [来源: 文档标题](URL)`',
    '- 永远不要虚构PCD名称、GUID、协议、规范章节或提交规则',
    '- 如果上下文未涵盖问题的部分，明确说明，不要虚构',
    '- **禁止**以"基于："源列表章节结尾；进行内联引用',
    '',
    '## Accuracy guarantee rules',
    '- **强制溯源**：所有【强制要求】必须有明确的文档引用',
    '- **不确定性标记**：当上下文信息不足时，必须声明"上下文中未找到明确规范"',
    '- **禁止推断**：不要基于部分信息推断完整规则，必须明确标注"需查阅官方规范"',
    '- **关键数据验证**：PCD名称、GUID、字符长度阈值等关键数据必须与上下文完全一致',
    '',
    '## 简洁性规则（提炼式精简）',
    '- **必须保留**：全部【强制要求】、【最佳实践】硬性信息、示例对比（✅/❌）、报错与修复方案、引用溯源',
    '- **必须去除**：重复措辞、冗余过渡句、无信息量的铺垫（如"首先让我解释一下"）、冠词量词堆砌',
    '- **紧凑表达**：用短句子直达要点，不重复强调已说明内容，不用长排比铺陈',
    '- **示例控制**：示例保持必要长度（可复制可用即可），不额外扩写说明文字',
    '- **合并段落**：同一主题的碎片信息合并为一条，删除分隔性废话',
    '- **长度目标**：在完整覆盖所有关键信息的前提下，回答长度通常控制在300-400 tokens',
    '',
    '## Output format examples (Few-shot)',
    '',
    '### Example 1: Commit format question',
    '**Question**: commit格式有什么要求？',
    '',
    '**Answer**:',
    'Commit格式规范通过PatchCheck CI强制拦截不合规提交，确保代码追溯性与历史可维护性。',
    '',
    '#### 【强制要求】',
    '',
    '**1. 标题长度：≤76字符**',
    '- 校验工具：PatchCheck.py会拦截超长标题',
    '```',
    '✅ MdeModulePkg: DxeCore: Fix memory allocation bug in runtime',
    '❌ MdeModulePkg: DxeCore: This is a very long commit message that exceeds the 76 character limit and will be rejected by PatchCheck',
    '```',
    '- 常见报错：`ERROR: Subject line too long (80 chars)`',
    '- 修复方法：精简描述，保留核心信息',
    '',
    '**2. 签名格式：必须包含Signed-off-by**',
    '```',
    'Signed-off-by: Your Name <email@example.com>',
    '```',
    '- 快捷方法：`git commit -s` 自动添加',
    '- 缺失签名会导致PatchCheck CI直接驳回',
    '',
    '**3. 前缀格式：PackageName: ModuleName: summary**',
    '```',
    '✅ ShellPkg: Shell: Add new command support',
    '✅ MdeModulePkg: DxeCore, MemoryAllocationLib: Fix memory leak (多包用逗号分隔)',
    '❌ Fix memory leak in DxeCore (缺少包名前缀)',
    '```',
    '',
    '#### 【最佳实践】',
    '',
    '- 正文每行≤72字符，建议配置编辑器辅助',
    '- 一个commit只做一件事，不混合bug修复、功能新增、重构',
    '- 独立commit应能通过`git bisect`，不引入构建中断',
    '',
    '**校验工具清单**:',
    '- PatchCheck.py：标题长度、签名格式、前缀规范',
    '- Azure CI：自动化检查提交合规性',
    '',
    '**参考文档**: [Commit Message Format](https://www.tianocore.org/tianocore-wiki.github.io/development/contribution-guides/commit_message_format.html)',
    '',
    '---',
    '',
    '### Example 2: Function annotation question',
    '**Question**: 函数注释格式有什么要求？',
    '',
    '**Answer**:',
    'EDK II函数注释强制使用Doxygen兼容格式，通过`@retval`替代`@return`，并强制文件头声明规范引用，确保API文档自动生成与代码可维护性。',
    '',
    '#### 【强制要求】',
    '',
    '**1. 返回值标注：统一使用@retval**',
    '```c',
    '✅ 正确示例:',
    '/**',
    '  分配运行时内存.',
    '',
    '  @param  Size  请求的字节数.',
    '',
    '  @retval NULL   分配失败.',
    '  @retval 其他值  分配的内存指针.',
    '**/',
    'VOID *AllocateRuntimeMemory(IN UINTN Size);',
    '',
    '❌ 错误示例:',
    '/**',
    '  @return 分配的内存指针.',
    '**/',
    '// 使用@return不符合EDK II规范',
    '```',
    '',
    '**2. 文件头：强制包含@par Specification Reference**',
    '```c',
    '/**',
    '  @file',
    '  UEFI运行时服务实现.',
    '',
    '  @par Specification Reference:',
    '  - UEFI Specification 2.9, Section 7.1',
    '**/',
    '```',
    '',
    '**3. 无参函数：必须写(VOID)**',
    '```c',
    '✅ VOID InitializeRuntimeServices(VOID);',
    '❌ VOID InitializeRuntimeServices();  // 空参数列表不合规',
    '```',
    '',
    '**4. 参数修饰符顺序：IN > IN OUT > OUT > OPTIONAL**',
    '```c',
    '✅ 正确顺序:',
    'EFI_STATUS EFIAPI OpenProtocol(',
    '  IN  EFI_HANDLE  Handle,',
    '  IN  EFI_GUID    *Protocol,',
    '  OUT VOID        **Interface OPTIONAL',
    ');',
    '```',
    '',
    '#### 【最佳实践】',
    '',
    '- 函数原型与实现分离时，注释放在头文件原型处',
    '- 复杂参数需用`@param`说明用途和约束',
    '',
    '**校验工具清单**:',
    '- Uncrustify：自动格式化注释与参数对齐',
    '',
    '**参考文档**: [EDK II Coding Standards](https://edk2-docs.gitbook.io/edk-ii-coding-standards-specification/)',
    '',
    '---',
    '',
    'Follow these examples for structured, actionable answers that meet all transformation rules.',
  ].join('\n');

  const messages = [{ role: 'system', content: system }];
  for (const h of (history || [])) {
    if (h && h.role && h.content) {
      messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content).slice(0, 4000) });
    }
  }
  messages.push({ role: 'user', content: `Context:\n${context}\n\nQuestion: ${question}` });
  return messages;
}

function llmConfig() {
  return {
    apiKey: process.env.LLM_API_KEY,
    baseUrl: process.env.LLM_BASE_URL,
    model: process.env.LLM_MODEL,
  };
}

/**
 * Stream LLM chat completions (OpenAI-compatible SSE).
 * Calls onDelta(text) for each content chunk; resolves on completion.
 */
function llmStream(messages, { onDelta, timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const { apiKey, baseUrl, model } = llmConfig();
    if (!apiKey || !baseUrl || !model) {
      reject(new Error('LLM not configured. Set LLM_API_KEY / LLM_BASE_URL / LLM_MODEL.'));
      return;
    }
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const u = new URL(url);
    const payload = { model, messages, temperature: 0, stream: true };

    const protocol = u.protocol === 'https:' ? https : http;
    const req = protocol.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(process.env.LLM_EXTRA_HEADER
          ? { 'x-api-key': process.env.LLM_EXTRA_HEADER } : {}),
        // A browser-like User-Agent is required: opencode.ai/zen encodes
        // Cloudflare bot protection that 1010-blocks default library agents.
        'User-Agent': process.env.LLM_USER_AGENT ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'text/event-stream',
      },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => reject(new Error(`LLM API error ${res.statusCode}: ${data.substring(0, 500)}`)));
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const delta = j.choices && j.choices[0] && j.choices[0].delta;
            if (delta && delta.content) onDelta(delta.content);
          } catch { /* ignore malformed chunk */ }
        }
      });
      res.on('end', () => resolve());
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(JSON.stringify(payload));
    req.end();
  });
}

async function llmAnswer(question, results, history) {
  const { apiKey, baseUrl, model } = llmConfig();
  if (!apiKey || !baseUrl || !model) {
    return { error: 'LLM not configured. Set LLM_API_KEY / LLM_BASE_URL / LLM_MODEL.' };
  }
  const messages = buildMessages(question, results, history);

  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const resp = await httpJson(url, {
    method: 'POST',
    payload: { model, messages, temperature: 0 },
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': process.env.LLM_USER_AGENT ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    },
    timeoutMs: 180000,
  });

  if (resp.status < 200 || resp.status >= 300) {
    return { error: `LLM API error ${resp.status}: ${JSON.stringify(resp.body).substring(0, 500)}` };
  }
  const content = resp.body && resp.body.choices && resp.body.choices[0] && resp.body.choices[0].message
    ? resp.body.choices[0].message.content : '';
  return { answer: content, model };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(WEB_DIR, rel));
  if (!file.startsWith(WEB_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleAsk(req, res) {
  const ip = clientIp(req);
  const bucket = rateLimit(ip, ASK_LIMIT);
  if (bucket.count > ASK_LIMIT) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `请求过于频繁（${ASK_LIMIT} 次/分钟）。请稍后再试。` }));
    return;
  }

  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    try {
      const parsed = JSON.parse(body || '{}');
      const question = (parsed.question || '').trim();
      const history = Array.isArray(parsed.history) ? parsed.history.slice(-10) : [];
      if (!question) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing question' }));
        return;
      }

      const daemonUrl = await getHealthyDaemonUrl();
      if (!daemonUrl) {
        const st = readDaemonState();
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Daemon 未就绪：${(st && st.message) || '无法启动知识库服务，请检查 daemon 日志'}` }));
        return;
      }
      const url = daemonUrl;

      // SSE response headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // Check cache first
      sendSSE(res, 'phase', { step: 'cache', text: '检查缓存…', progress: 10 });
      let results = getCachedContext(question);
      let fromCache = false;
      
      if (results) {
        fromCache = true;
        sendSSE(res, 'phase', { step: 'cache_hit', text: '从缓存加载结果…', progress: 30 });
      } else {
        // 1) search knowledge base (before streaming text, results arrive as one event)
        sendSSE(res, 'phase', { step: 'search', text: '正在检索知识库…', progress: 20 });
        let searchResp;
        try {
          const searchQuery = expandChineseQuery(question);
          searchResp = await httpJson(`${url}/search?query=${encodeURIComponent(searchQuery)}&top_k=25`, { timeoutMs: 120000 });
        } catch (e) {
          sendSSE(res, 'error', { error: `检索失败：${e.message}` });
          res.end();
          return;
        }
        results = (searchResp.body && searchResp.body.results) || [];
        
        // 1.5) Rerank results using BGE-reranker
        if (results.length > 10) {
          sendSSE(res, 'phase', { step: 'rerank', text: '重排序文档…', progress: 25 });
          try {
            results = await rerankDocuments(question, results);
          } catch (e) {
            console.error(`Rerank error: ${e.message}`);
            // Continue with original results if reranking fails
          }
        }
        
        // Cache the results
        setCachedContext(question, results);
        sendSSE(res, 'phase', { step: 'cache_stored', text: '结果已缓存', progress: 30 });
      }
      sendSSE(res, 'results', { results: results.slice(0, 10), daemon: url, from_cache: fromCache });

      // 2) stream LLM answer
      sendSSE(res, 'phase', { step: 'llm_init', text: '初始化LLM…', progress: 40 });
      const { apiKey, baseUrl, model } = llmConfig();
      if (!apiKey || !baseUrl || !model) {
        sendSSE(res, 'error', { error: 'LLM not configured. Set LLM_API_KEY / LLM_BASE_URL / LLM_MODEL.' });
        res.end();
        return;
      }
      sendSSE(res, 'phase', { step: 'llm_build', text: '构建提示词…', progress: 50, model });
      
      const messages = buildMessages(question, results, history);
      sendSSE(res, 'phase', { step: 'llm', text: '正在生成回答…', progress: 60, model });
      
      let tokenCount = 0;
      try {
        await llmStream(messages, {
          onDelta: (text) => {
            tokenCount++;
            // Report progress every 50 tokens
            if (tokenCount % 50 === 0) {
              sendSSE(res, 'phase', { 
                step: 'llm_stream', 
                text: `生成中 (${tokenCount} tokens)…`, 
                progress: Math.min(60 + Math.floor(tokenCount / 10), 90),
                model 
              });
            }
            sendSSE(res, 'delta', { text });
          },
          timeoutMs: 180000,
        });
      } catch (e) {
        sendSSE(res, 'error', { error: e.message });
        res.end();
        return;
      }
      sendSSE(res, 'phase', { step: 'llm_done', text: '回答完成', progress: 100, model, tokens: tokenCount });
      sendSSE(res, 'done', { model, tokens: tokenCount, from_cache: fromCache });
      res.end();
    } catch (e) {
      // try to send error as SSE if headers already sent
      if (res.headersSent) {
        sendSSE(res, 'error', { error: e.message });
        res.end();
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
  });
}

async function handleStatus(req, res) {
  const bucket = rateLimit(clientIp(req), STATUS_LIMIT);
  if (bucket.count > STATUS_LIMIT) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '请求过于频繁' }));
    return;
  }
  const url = getDaemonUrl() ? normalizeDaemonUrl(getDaemonUrl()) : null;
  let daemon = null;
  if (url) {
    try {
      daemon = await httpJson(`${url}/health`, { timeoutMs: 5000 });
    } catch {
      daemon = { status: 0, body: { error: 'unreachable' } };
    }
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    service: 'edk2-agent-web',
    web_ready: true,
    daemon_url: url,
    daemon_health: daemon ? daemon.body : null,
    llm_configured: !!(process.env.LLM_API_KEY && process.env.LLM_BASE_URL && process.env.LLM_MODEL),
    kb_dir: getKbDir(),
    model_dir: getModelPath(getKbDir()),
  }));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }
    const urlPath = req.url.split('?')[0];
    if (urlPath === '/api/ask' && req.method === 'POST') { await handleAsk(req, res); return; }
    if (urlPath === '/api/status' && req.method === 'GET') { await handleStatus(req, res); return; }
    if (urlPath === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    serveStatic(req, res);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Internal error: ${e.message}`);
  }
});

const port = parseInt(process.env.PORT || '8080', 10);
const host = process.env.HOST || '0.0.0.0';
server.listen(port, host, () => {
  console.log(`Edk2Agent Web Q&A listening on http://${host}:${port}`);
  console.log(`KB dir: ${getKbDir()}`);
  console.log(`LLM configured: ${!!(process.env.LLM_API_KEY && process.env.LLM_BASE_URL && process.env.LLM_MODEL)}`);
});

module.exports = { server };
