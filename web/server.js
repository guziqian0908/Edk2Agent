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
    
    // Trim payload before sending: the reranker only needs title/section/
    // snippet. Sending full content blobs makes the HTTP request large, which
    // can abort the single-threaded rerank server or hit its read timeout.
    const slim = (docs || []).map((d) => ({
      title: d.title || '',
      section: d.section || '',
      snippet: String(d.snippet || d.content || '').slice(0, 1200),
      score: d.score || 0,
      source: d.source || '',
      url: d.url || '',
    }));
    // Call the persistent rerank HTTP service
    const body = JSON.stringify({ query, docs: slim });
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
      timeout: 60000,
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
//
// Each rule carries a relevance weight (0..1). A query may match several
// topics; the expanded query appends the highest-relevance terms first so
// hybrid retrieval (dense vector + BM25) weights the intended topic above
// incidental keyword matches (e.g. "模块" appearing in both "module" and
// "driver model" context).
const KB_EXPANSION_RULES = [
  // 元数据文件 / 构建体系
  { w: 1.0, re: /inf|dsc|dec|fdf|元数据|inf文件|dsc文件|dec文件|fdf文件|包配置|平台配置|模块关系|包关系/, terms: 'INF DSC DEC FDF file format EDK II module package platform build AutoGen' },
  { w: 1.0, re: /模块.{0,10}(包|平台)|包.{0,10}(模块|平台)|平台.{0,10}模块|module.*package.*platform|package和module/, terms: 'module package platform relationship EDK II build hierarchy Module Package Platform' },
  // 命名规范 / 编码风格
  { w: 1.0, re: /命名|命名规范|命名规则|变量命名|函数命名|文件名|标识符|前缀|coding.*naming/, terms: 'naming conventions identifiers Hungarian prefix EDK II coding standards naming rules' },
  { w: 0.9, re: /编码规范|代码风格|代码格式|排版|缩进|空白|格式要求|coding|style|formatting|spacing/, terms: 'coding standards code style formatting spacing indentation EDK II coding standards specification' },
  // MODULE_TYPE / 模块开发
  { w: 1.0, re: /MODULE_TYPE|模块类型|模块型|入口函数|入口点|ENTRY_POINT|entry point/, terms: 'MODULE_TYPE module type ENTRY_POINT entry point SEC PEI_CORE PEIM DXE_CORE DXE_DRIVER UEFI_DRIVER UEFI_APPLICATION BASE' },
  // 库类 / 库实例
  { w: 1.0, re: /库类|库实例|library class|library instance|库绑定|库映射/, terms: 'library class library instance INF DSC binding LIBRARY_CLASS constructor' },
  // PCD
  { w: 1.0, re: /pcd|固定值|动态配置|编译期|FeatureFlag|FixedAtBuild|PatchableInModule/, terms: 'PCD types PcdsFeatureFlag PcdsFixedAtBuild PcdsPatchableInModule PcdsDynamic PcdsDynamicEx PcdLib FixedPcdGet' },
  // Depex / 依赖表达式
  { w: 1.0, re: /depex|依赖表达式|依赖表达式|派发顺序|依赖协议|depex段/, terms: '[Depex] dependency expression dispatch order Protocol PPI TRUE AND OR NOT' },
  // 单模块编译
  { w: 1.0, re: /只编译|单个模块|build.{0,10}(-m|-p)|编译参数|AutoGen|编译单个/, terms: 'build command -p -m -a -b -t AutoGen.c AutoGen.h module build output Build' },
  // 编译报错
  { w: 0.9, re: /报错|编译错误|链接错误|unresolved|error 4000|LNK2001|C4013|字母大小写|case mismatch/, terms: 'build error LNK2001 unresolved external symbol error 4000 Guid not found library class not found case mismatch' },
  // DEBUG / ASSERT
  { w: 1.0, re: /调试信息|打印|DEBUG|ASSERT|CpuDeadLoop|调试.*配置|PcdDebug/, terms: 'DEBUG ASSERT DebugLib PcdDebugPrintErrorLevel PcdDebugPropertyMask CpuDeadLoop debug output' },
  // UEFI Driver Model
  { w: 1.0, re: /driver binding|DriverBinding|驱动绑定|Supported|Start\(\)|Stop\(\)|驱动模型/, terms: 'UEFI Driver Model Driver Binding Protocol Supported Start Stop EFI_DRIVER_BINDING_PROTOCOL' },
  // Protocol 获取方式
  { w: 1.0, re: /LocateProtocol|LocateHandleBuffer|OpenProtocol|协议.{0,10}(获取|拿)|拿.*协议|协议属性|Attributes/, terms: 'LocateProtocol LocateHandleBuffer OpenProtocol CloseProtocol EFI_OPEN_PROTOCOL_BY_DRIVER handle database' },
  // 贡献流程 / CI / PR
  { w: 1.0, re: /贡献|提补丁|上游|提交.*(流程|步骤)|contribution|onboarding|collaborator/, terms: 'EDK II contribution process git rebase PatchCheck Uncrustify Stuart CI pull request fork' },
  { w: 1.0, re: /commit message|提交信息|提交格式|签名行|Signed-off-by|提交标题/, terms: 'commit message format Signed-off-by PatchCheck multi-package Global summary line length' },
  { w: 0.9, re: /拆分|拆成.*(commit|提交)|commit.{0,10}拆|git bisect|提交拆分/, terms: 'commit partitioning git bisect commit granularity separate commits' },
  { w: 1.0, re: /Uncrustify|格式化|自动格式化|uncrustify|zachflower/, terms: 'Uncrustify uncrustify.cfg UncrustifyCheck stuart_ci_build format document' },
  { w: 0.9, re: /CI|流水线|Azure|Mergify|评审|reviewer|maintainer|合并|合入|push.*标签/, terms: 'EDK II CI Azure Pipelines Mergify PatchCheck review maintainer push label' },
  // 编码规范：类型 / 函数 / 控制流
  { w: 1.0, re: /int|char|标准C|UINTN|EFI_STATUS|数据类型|EFIAPI|VOLATILE|typedef/, terms: 'UEFI data types INTN UINTN EFI_STATUS EFIAPI VOID CHAR16 EFI_GUID typedef' },
  { w: 0.9, re: /函数.{0,4}(排版|头|注释)|文件头|@retval|Doxygen|@file|@param/, terms: 'function definition layout function heading Doxygen @retval @param @file file heading' },
  { w: 0.9, re: /goto|ASSERT.*规则|流程控制|if.*else|switch.*case|注释.{0,4}禁忌/, terms: 'flow control goto ASSERT switch case comment prohibitions EDK II coding standards' },
  // 启动流程
  { w: 1.0, re: /启动流程|启动阶段|SEC|PEI|DXE|BDS|TSL|上电|引导流程|PI.*架构/, terms: 'PI boot flow SEC PEI DXE BDS TSL RT AL phase UEFI boot sequence' },
  { w: 1.0, re: /PEIM.{0,10}(调用|通信)|PPI|HOB|PEI.{0,10}(服务|内存)|横向/, terms: 'PEI PPI PEIM InstallPpi LocatePpi HOB Hand-Off Block PEI Services' },
  // UEFI 服务
  { w: 1.0, re: /Boot Services|Runtime Services|ExitBootServices|启动服务|运行时服务|内存图|MapKey/, terms: 'Boot Services Runtime Services ExitBootServices MapKey GetMemoryMap EFI runtime' },
  { w: 1.0, re: /TPL|任务优先级|RaiseTPL|RestoreTPL|中断.{0,4}优先级|NotifyTpl/, terms: 'TPL Task Priority Level RaiseTPL RestoreTPL TPL_APPLICATION TPL_CALLBACK TPL_NOTIFY TPL_HIGH_LEVEL' },
  { w: 1.0, re: /AllocatePages|AllocatePool|内存类型|EfiBootServicesData|EfiRuntimeServicesData|FreePages|FreePool/, terms: 'AllocatePages AllocatePool memory type EfiBootServicesData EfiRuntimeServicesData FreePages FreePool' },
  { w: 1.0, re: /事件|Event|EVT_TIMER|SetTimer|EVT_NOTIFY|CreateEvent|等待.*事件|异步/, terms: 'UEFI event CreateEvent SetTimer EVT_TIMER EVT_NOTIFY_SIGNAL WaitForEvent CloseEvent' },
  { w: 1.0, re: /(UEFI|EFI).{0,6}变量|变量服务|GetVariable|SetVariable|NVRAM|NV\+BS|BootOrder|读写变量|变量存储|变量存取|非易失变量/, terms: 'UEFI variable GetVariable SetVariable EFI_VARIABLE_NON_VOLATILE BOOTSERVICE_ACCESS RUNTIME_ACCESS NVRAM' },
  // SMM / MM
  { w: 1.0, re: /SMM|MMRAM|MM_STANDALONE|DXE_SMM|MmStandalone|standalone mm|management mode|管理模式/, terms: 'SMM MM Standalone MmStandalone DXE_SMM_DRIVER MMRAM Management Mode CommBuffer' },
  // HII / VFR
  { w: 1.0, re: /HII|VFR|设置界面|BIOS Setup|Form Browser|formset|varstore|人性化/, terms: 'HII Human Interface Infrastructure VFR formset form varstore IFR Form Browser' },
  // Secure Boot
  { w: 1.0, re: /Secure Boot|安全启动|PK|KEK|dbx|签名验证|可信启动|Trusted Boot|Measured Boot/, terms: 'UEFI Secure Boot PK KEK db dbx Trusted Boot Measured Boot TPM PCR verified boot' },
  // 基础保留项
  { w: 0.8, re: /提交|commit|签off|签名|贡献/, terms: 'commit requirements commit message format commit signature Signed-off-by code contribution' },
  { w: 0.8, re: /驱动|driver|uefi驱动|驱动开发/, terms: 'UEFI driver driver model driver binding DriverBinding Protocol' },
  { w: 0.8, re: /构建|build|编译|edk2编译|编译环境/, terms: 'build toolchain GCC VS ICC compilation build process' },
  { w: 0.8, re: /工具链|toolchain|编译器|编译工具/, terms: 'toolchain GCC Visual Studio ICC compiler build tools' },
  { w: 0.8, re: /安全|security|安全编码|安全规范/, terms: 'security secure coding security guide security review' },
  { w: 0.8, re: /审查|review|代码审查|代码review/, terms: 'code review review process review guidelines' },
  { w: 0.8, re: /文档|document|注释|comment/, terms: 'documentation comments Doxygen documenting code' },
  { w: 0.8, re: /启动|boot|引导|uefi启动/, terms: 'boot flow boot sequence UEFI boot PI specification' },
  { w: 0.8, re: /测试|test|单元测试|单元测试/, terms: 'unit test testing test framework validation' },
  { w: 0.8, re: /调试|debug|调试方法|调试工具/, terms: 'debug debugging debug tools GDB WinDbg' },
  { w: 0.8, re: /漏洞|vulnerability|缓冲区|溢出/, terms: 'vulnerability buffer overflow security mitigation DEP ASLR' },
  { w: 0.8, re: /许可|license|开源协议|bsd/, terms: 'license BSD open source licensing contribution agreement' },
];

function expandChineseQuery(q) {
  const lower = q.toLowerCase();
  const hits = [];
  for (const rule of KB_EXPANSION_RULES) {
    // Rules carry mixed-case English tokens (PEI/DXE/SMM/...) while the
    // query is lower-cased here; apply /i so mixed-case user input still
    // triggers the right topic. Avoid /g|/y (stateful) rules.
    const re = rule.re.flags.includes('i')
      ? rule.re
      : new RegExp(rule.re.source, rule.re.flags + 'i');
    if (re.test(lower)) hits.push(rule);
  }
  // Sort by weight desc, keep order stable for equal weights.
  hits.sort((a, b) => b.w - a.w);
  // De-duplicate terms while preserving order. Cap to avoid an oversized query.
  const seen = new Set();
  const parts = [];
  for (const rule of hits) {
    for (const t of rule.terms.split(' ')) {
      const low = t.toLowerCase();
      if (!seen.has(low)) { seen.add(low); parts.push(t); }
    }
    if (parts.length >= 40) break;
  }
  const expansion = parts.join(' ');
  return expansion ? `${q} ${expansion}` : q;
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

// Daemon results carry a numeric _pid that uniquely identifies a chunk even
// when url/file/title are all empty (common for tianocore-docs spec pages).
// Use it as a dedup fallback so multiple same-source spec chunks survive
// aggregation instead of all collapsing onto the empty-string key.
function chunkKey(r) {
  return r.url || r.file || r.title || r.section || (r._pid != null ? String(r._pid) : '') || '';
}

// tianocore-docs chunks come from gitbook-synced repos whose git URL is not
// stored by the daemon (url is empty). Map the repo directory name to the
// public gitbook site so the LLM can emit real reference links instead of
// local file paths.
const DOCS_REPO_GITBOOK = {
  'edk2-CCodingStandardsSpecification': 'edk-ii-c-coding-standards-specification',
  'edk2-ModuleWriteGuide': 'edk-ii-module-writers-guide',
  'edk2-UefiDriverWritersGuide': 'edk-ii-uefi-driver-writers-guide',
  'EDK_II_Secure_Coding_Guide': 'edk-ii-secure-coding-guide',
  'edk2-IdfSpecification': 'edk-ii-inf-file-format-specification',
  'edk2-UniSpecification': 'edk-ii-unicode-collation',
  'edk2-DscSpecification': 'edk-ii-dsc-file-format-specification',
  'edk2-DecSpecification': 'edk-ii-dec-file-format-specification',
  'edk2-FdfSpecification': 'edk-ii-fdf-file-format-specification',
  'edk2-BuildSpecification': 'edk-ii-build-specification',
  'edk2-MinimumPlatformSpecification': 'edk-ii-minimum-platform-specification',
  'edk2-InfSpecification': 'edk-ii-inf-file-format-specification',
};

function docUrl(r) {
  if (r.url) return r.url;
  const file = String(r.file || '');
  const repo = (file.split(/[\\/]/)[0] || '').trim();
  const slug = DOCS_REPO_GITBOOK[repo];
  if (!slug) return '';
  // Best-effort section path: keep it to the gitbook root unless a stable
  // slug path can be derived; a correct root link beats a broken deep link.
  return `https://edk2-docs.gitbook.io/${slug}/`;
}

// Strip the per-chunk metadata header (Title/URL/Source/Chunk/Position/File/
// Repo) that the embedder prepends to each stored chunk. It is useful for
// retrieval but is noise for the LLM and pushes it toward quoting raw
// fragments or emitting local file paths as citations; the real section
// heading and body are enough (the caller injects a usable URL separately).
function cleanChunk(block) {
  const lines = String(block || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^(Title|URL|Source|Chunk|Position|File|Repo|Filename|Path):\s*/i.test(line)) continue;
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
    const key = chunkKey(r);
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
    const key = chunkKey(r);
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
      const key = chunkKey(r);
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
    const key = chunkKey(r);
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
  
  const context = ctx.map((r, i) => {
    const u = docUrl(r);
    return (
      `[${i + 1}] ${r.title}\n` +
      (r.type ? `Type: ${r.type}\n` : '') +
      (r.source ? `Source: ${r.source}\n` : '') +
      (u ? `URL: ${u}\n` : '') +
      (r.section ? `Section: ${r.section}\n` : '') +
      `Content:\n${r.body}\n`
    );
  }).join('\n');

  const system = [
    'You are an EDK2/TianoCore firmware development expert. You answer from the retrieved EDK2/TianoCore documentation context, and you explain like a senior firmware architect teaching a colleague: you first establish what a thing IS and how it fits, then you walk through the mechanism, then you surface the engineering rules that actually bite in practice.',
    intentGuidance,
    '',
    '## 回答结构（专家讲解式，按需取舍层级）',
    '',
    '### 1. 先定义，再建立关系模型',
    '- 开篇一句话点出**本质**（这个概念解决什么问题、在体系中的位置），不要直接列知识点。',
    '- 概念之间有关联时，先画清关系模型（层次、包含、依赖），例如：',
    '  - 模块是构建最小单元（源码+INF）；包是模块的容器，必有DEC；平台是特殊的包，必有DSC+FDF。',
    '  - 或直接给出项目内实际的目录/引用关系（PkgA → PkgB 的 DEC 引用）。',
    '',
    '### 2. 串讲机制，而非罗列事实',
    '- 讲清楚**流程/机制如何运转**：如 build 如何从 DSC+DEC+INF 解析依赖并生成 AutoGen/makefile；派发顺序如何由 [Depex] 决定；UEFI 驱动如何经 Supported→Start 被设备唤醒。',
    '- 机制串讲里自然带出术语定义、关键 API/数据结构、时序关系，替代"文档A说X、文档B说Y"的平铺。',
    '- 事实性信息（章节号、签名、阈值）保持精确，来自上下文中的章节/URL，禁止虚构。',
    '',
    '### 3. 工程要点小节（承接机制，不喧宾夺主）',
    '- 用 `**【强制要求】**`（CI/评审会驳回）与 `**【最佳实践】**`（评审建议）两级标注硬性约束。',
    '- 高频、会报错的点前置；示例用 ✅ 正确 / ❌ 违规 成对展示，可直接复制使用。',
    '- 编译/CI/PR 场景按需给出常见报错、根因、修复。',
    '',
    '### 4. 结尾统一放参考来源',
    '- 正文保持流畅，**不做内联引用**（引用会打断阅读流）。',
    '- 回答末尾附 `## 参考来源`，逐条列出：`- [文档标题 - 章节](URL)`。',
    '- 每个文档条目里 `URL:` 开头的行就是该文档的参考链接，直接把它作为 markdown 链接填入参考来源。',
    '- 文档条目没有 `URL:` 行时才写"（本地文档）"，绝不把文件路径当链接。',
    '',
    '## 措辞与改写红线',
    '- 措辞用固件专业表述：**必须、禁止、红线、强制、不合规**；避免"推荐、尽量、一般"这类模糊词，除非它确实只是最佳实践。',
    '- 禁止照搬参考文档段落顺序，禁止单纯摘抄加直译；必须重新归纳、分层、补工程实操解读。',
    '- 上下文信息不足时明确声明，绝不虚构 PCD 名称、GUID、协议、章节号或提交规则。',
    '- 关键数据（PCD 名、GUID、长度阈值）必须与上下文完全一致。',
    '',
    '## 长度与密度',
    '- 覆盖完整、言之有物优先；通常 500-900 tokens，机制规整时可更长，不做硬性截断。',
    '- 去除冗余过渡句、无信息量铺垫（如"首先让我解释一下"）、重复措辞；一个主题的碎片信息合并为一条。',
    '- 专项细节（INF/DSC/PCD/Depex 覆盖与优先级、Driver Binding Supported/Start/Stop 边界、Commit 拆分 bisect 约束、@retval/@par Specification/`(VOID)`/IN OUT 参数顺序）只在问题相关时展开，不强行堆砌。',
    '',
    '## Output format examples (Few-shot)',
    '',
    '### Example 1: 模块/包/平台关系',
    '**Question**: EDK2中模块（Module）、包（Package）和平台（Platform）是什么关系？',
    '',
    '**Answer**:',
    'EDK2 用三级构建单元组织源码：**模块**是可编译的最小产出，**包**是模块的容器并统一对外声明接口与宏，**平台**则是特殊的包，额外描述固件映像的组成——三级结构让"通用组件"与"具体产品"解耦，同一批模块可被不同平台以不同方式组合。',
    '',
    '**一级：模块（Module）**',
    '每个模块是"1个INF + 一组.c/.h源码"的编译单元。INF 的关键作用是**声明这个模块需要什么、提供什么**：`[Defines]` 给出 MODULE_TYPE（DXE_DRIVER/UEFI_APPLICATION…）与 ENTRY_POINT；`[Sources]` 列出参与编译的 C 文件；`[Packages]` 声明依赖哪些包的 DEC；`[LibraryClasses]` 声明要用哪个库类。构建时 build 会解析 INF 生成对应 AutoGen.c/AutoGen.h。',
    '',
    '**二级：包（Package）**',
    '包是模块的**聚合容器与公共接口中心**，标识物是根目录的 DEC 文件：`[Defines]` 声明包名与 GUID；`[Includes]` 导出公开头文件路径（模块靠这里找到协议头文件）；`[Protocols/Ppis/Guid/Pcds]` 统一发布包内定义的所有 GUID/PCD。**模块不能直接用未在 [Packages] 引用的库或头**，这种引用关系在 DEC 里闭环。',
    '',
    '**三级：平台（Platform）**',
    '平台是**特殊的包**，由 DSC + FDF 共同描述：DSC 的 `[LibraryClasses]`/`[Pcds]`/`[Components]` 决定"编进固件的模块及它们的库实例选择与 PCD 值"，FDF 描述"固件映像布局"（FV 怎么排、模块塞进哪个分区、加载顺序）。build 以平台为入口：解析 DSC 汇总模块清单与依赖，为每个模块生成 makefile/AutoGen，再按 FDF 组装出 FD 映像。',
    '',
    '**工程要点**',
    '- **【强制要求】** INF 里 `[Packages]` 必须列出模块实际用到的每个包的 DEC；漏声明会导致 failed to find required library 或头文件找不到的编译错误。',
    '- **【最佳实践】** 一个库类的选择（某 INF 的 [LibraryClasses]）放在 DSC 而不是 INF 里做，便于平台级替换实现（如同一个类在 DXE 用内存实现、在 SMM 用MMRAM实现）。',
    '',
    '## 参考来源',
    '- [EDK II Build Specification](https://edk2-docs.gitbook.io/edk-ii-build-specification/)',
    '',
    '---',
    '',
    '### Example 2: 命名规范问题',
    '**Question**: EDK II 有哪些命名规范？',
    '',
    '**Answer**:',
    'EDK II 命名规范统一了 变量→函数→文件→目录 四层标识符的书写，核心是一条贯穿原则：**用不低于单词可读性的统一风格保证源码的可检索性与无歧义**——任何标识符从命名上就能判断其用途、作用域与所有权。',
    '',
    '**标识符（变量/函数）**',
    '采用 **Camel Case**，函数名通常以动词开头（`GetMemoryAttributes`），变量名以名词性短语为主。类型别名（typedef）以模块/主题作词根前缀（如 `EFI_STATUS`、`EFI_GUID`），避免与普通变量命名冲突。',
    '',
    '**源文件与目录**',
    '目录名使用主题名，模块目录内按 INF 名. 规范命名；`*.inf`、`*.dec`、`*.dsc`、`*.fdf` 等元数据文件与源码文件命名遵循同级一致性，`Uni` 资源、`Vfr` 界面文件、`Cfg` 配置脚本等都有约定后缀。',
    '',
    '**变量作用域前缀**',
    '模块级全局变量与局部变量严格区分书写：全局状态常量倾向用模块名缩写做前缀，函数内临时变量短小直白；指短短的存在即一个对象（Handle）仍用清晰名。命名红线是**不缩写到不可读、不塞入不相关含义**，这与注释规范同源，目的都在可维护性。',
    '',
    '**工程要点**',
    '- **【强制要求】** 新代码遵循统一命名，CI 的 Uncrustify 检查格式统一性时，命名风格不一致会被评审直接指出。',
    '- **【最佳实践】** 从上游模块复制代码时保留原始命名，重建前缀改名会破坏 diff 可读与 git 追溯。',
    '',
    '## 参考来源',
    '- [EDK II Coding Standards Specification - Naming Conventions](https://edk2-docs.gitbook.io/edk-ii-coding-standards-specification/)',
    '',
    '---',
    '',
    'Follow these examples: define first, build the relationship model, walk through the mechanism, then the engineering rules that matter — always with a ## 参考来源 block at the end.',
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

  const chunks = [];
  let received = 0;
  req.on('data', (c) => {
    chunks.push(c);
    received += c.length;
    if (received > 1e6) req.destroy();
  });
  req.on('end', async () => {
    try {
      // Buffer.concat + single decode preserves multi-byte UTF-8 characters
      // even when they are split across TCP chunks; naive string concat
      // decodes each Buffer fragment independently and corrupts CJK text.
      const body = Buffer.concat(chunks).toString('utf8');
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
        
        // 1.5) Rerank results using BGE-reranker. Rerank against the same
        // expanded query used for retrieval: the raw Chinese question alone
        // makes the reranker match generic "EDK II"-titled wiki pages and
        // push the section-level spec hits (e.g. "4.4 Identifiers") out.
        if (results.length > 10) {
          sendSSE(res, 'phase', { step: 'rerank', text: '重排序文档…', progress: 25 });
          try {
            const rerankQuery = expandChineseQuery(question);
            results = await rerankDocuments(rerankQuery, results);
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
