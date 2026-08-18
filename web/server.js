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
const crypto = require('crypto');
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

// ---- structured latency tracing (one JSON line per stage) ----
function newTraceId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

// Deterministic short fingerprint of the (normalized) question, used to group
// traces across requests of the same question. FNV-1a 32-bit, hex.
function queryHash(q) {
  const s = normalizeQuery(String(q || ''));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Emit one JSON trace line per stage: {trace_id, stage, duration_ms,
// timestamp, query_hash, status}. Any extra keys are appended as-is.
// The line goes to stdout (visible in the terminal running server.js)
// AND is appended to the shared trace.jsonl that the KB daemon also
// writes to, so the full web->MCP chain can be inspected in one file.
function traceFilePath() {
  return process.env.EDK2_TRACE_FILE || path.join(DEFAULT_KB_DIR, 'trace.jsonl');
}

function emitTrace({ traceId, stage, durationMs, queryHash, status = 'ok', ...extra } = {}) {
  const rec = {
    trace_id: traceId,
    stage,
    duration_ms: Math.round(durationMs * 100) / 100,
    timestamp: new Date().toISOString(),
    query_hash: queryHash,
    status,
    ...extra,
  };
  const line = JSON.stringify(rec);
  console.log(line);
  try {
    fs.appendFileSync(traceFilePath(), line + '\n');
  } catch { /* never break the request because of trace logging */ }
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

// ---- LLM generation budget (env-tunable; defaults keep exhaustive answers) ----
const LLM_MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS || '8000', 10);
const LLM_RETRY_MAX_TOKENS = parseInt(process.env.LLM_RETRY_MAX_TOKENS || '3000', 10);
const LLM_STREAM_TIMEOUT_MS = parseInt(process.env.LLM_STREAM_TIMEOUT_MS || '180000', 10);

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

// General title-shell expansion: detect blocks that are just section headers
// (short content for a section that has subsections) and expand them by reading
// the full section from the source file on disk.
const SHELL_CONTENT_THRESHOLD = 500; // blocks shorter than this are suspect
const MAX_SHELL_EXPANSIONS = 5; // limit file I/O

function expandTitleShells(results) {
  const kbDir = getKbDir();
  const reposDir = path.join(kbDir, 'data', 'tianocore-docs', 'repos');
  let expansions = 0;

  for (let i = 0; i < results.length && expansions < MAX_SHELL_EXPANSIONS; i++) {
    const r = results[i];
    const section = r.section || '';
    const content = r.content || '';
    const file = r.file || '';

    // Skip if already expanded
    if (section.includes('完整内容')) continue;

    // Detect title shell: section contains ">" (hierarchical) and content is short
    // and file is from a known docs repo (edk2-*)
    const isShell = section.includes('>') &&
                    content.length < SHELL_CONTENT_THRESHOLD &&
                    /^edk2-/i.test(file);

    if (!isShell) continue;

    // Map daemon file path to actual file on disk
    // daemon: "edk2-CCodingStandardsSpecification\5_source_files\52_spacing.md"
    // disk:   {reposDir}/edk2-CCodingStandardsSpecification/5_source_files/52_spacing.md
    const filePath = path.join(reposDir, ...file.split(/[\\\/]/));

    if (!fs.existsSync(filePath)) continue;

    try {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const lines = fileContent.split('\n');

      // Extract the last part of the section (the actual heading)
      // e.g., "5.2 Spacing > 5.2.2 Horizontal Spacing" → "5.2.2 Horizontal Spacing"
      const parts = section.split('>').map(s => s.trim());
      const targetHeading = parts[parts.length - 1];

      // Find the heading line in the file
      const headingIdx = lines.findIndex(l => {
        const cleaned = l.replace(/^#+\s*/, '').trim();
        return cleaned === targetHeading || cleaned.startsWith(targetHeading + ' ');
      });

      if (headingIdx < 0) continue;

      // Determine heading level
      const headingLine = lines[headingIdx];
      const headingMatch = headingLine.match(/^(#+)/);
      const headingLevel = headingMatch ? headingMatch[1].length : 1;

      // Find section end: next heading of same or higher level
      let endIdx = lines.length;
      for (let j = headingIdx + 1; j < lines.length; j++) {
        const m = lines[j].match(/^(#+)/);
        if (m && m[1].length <= headingLevel) {
          endIdx = j;
          break;
        }
      }

      // Extract full section content
      const fullSection = lines.slice(headingIdx, endIdx).join('\n').trim();

      // Only expand if significantly more content
      if (fullSection.length > content.length * 1.5 && fullSection.length > 200) {
        results[i] = {
          ...r,
          content: fullSection,
          section: section + ' (完整内容)',
          score: Math.max(r.score || 0, 0.9)
        };
        expansions++;
      }
    } catch (e) {
      // Skip on error
    }
  }

  return results;
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
  { w: 1.0, re: /命名|命名规范|命名规则|变量命名|函数命名|文件名|标识符|前缀|coding.*naming/, terms: 'naming conventions identifiers Hungarian prefix gVariable mVariable pPointer CamelCase EACH_WORD_IS_DISTINCT EDK II coding standards 4.4 Identifiers function data type macro names' },
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

// Metadata filtering for retrieval precision. Hybrid retrieval solves the
// "semantically close but wrong symbol" problem only partially: dense vectors
// can still rank a chunk from an unrelated spec chapter above the exact one.
// These helpers re-check each candidate against its *document metadata*
// (title/file/section/url) using the query's precise tokens — explicit EDK2
// identifiers/GUIDs/PCD names and the distinctive expansion keywords. A
// candidate whose metadata shares none of those signals is treated as
// "obviously irrelevant" and pruned (subject to generous floors so vague
// questions, or edge metadata spellings, never lose recall).
const PRUNE_FLOOR = 10;   // always keep at least this many top results
const PRUNE_TOP = 3;      // never drop these highest-ranked results
const PRUNE_MIN_SIGNALS = 3; // skip filtering when the query is too vague

const PRUNE_STOPWORDS = new Set([
  'the','a','an','and','or','of','to','in','for','on','with','is','are','was',
  'were','be','been','edk','ii','edkii','coding','standard','standards','spec',
  'specification','document','documentation','docs','file','format','type',
  'use','using','how','what','which','can','does','do','you','your','please',
]);

function metadataSignals(query) {
  const identifiers = new Set();
  const words = new Set();
  // Exact EDK2 identifiers / acronyms in the raw query matter most: their
  // expanded form keeps symbol-level precision that keyword fuzzy matching
  // would blur (e.g. EFI_DRIVER_BINDING_PROTOCOL, PcdDebugPrintErrorLevel).
  const idRe = /[A-Z][A-Z0-9_]{2,}/g;
  let m;
  while ((m = idRe.exec(query)) !== null) {
    identifiers.add(m[0]);
  }
  // Distinctive words from the expansion (see KB_EXPANSION_RULES above).
  const expansion = expandChineseQuery(query);
  for (const t of expansion.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3 && !PRUNE_STOPWORDS.has(t)) words.add(t);
  }
  // Also hoist CamelCase identifiers that only appear inside the expansion
  // (e.g. FixedPcdGet, EACH_WORD_IS_DISTINCT) into the exact-identifier set.
  for (const t of expansion.split(/\s+/)) {
    if (/^[A-Z][A-Za-z0-9]{4,}$/.test(t)) identifiers.add(t);
  }
  return { identifiers: [...identifiers], words: [...words] };
}

function pruneByMetadata(query, results) {
  if (!Array.isArray(results) || results.length <= PRUNE_FLOOR) return results;
  const signals = metadataSignals(query);
  const exactHits = signals.identifiers.length;
  if (signals.words.length + exactHits < PRUNE_MIN_SIGNALS) return results;

  const metaOf = (r) =>
    [r.title, r.section, r.file, r.url].filter(Boolean).join(' ').toLowerCase();

  // Authoritative docs chunks (tianocore-docs repos / specs / guides, i.e.
  // anything that is NOT commit/PR noise) are kept unconditionally: they were
  // deliberately pulled in by the dual-source docs query, and a generic
  // wording ("排版和空白有哪些规定？") must not let a metadata-signal miss
  // (e.g. rule sub-chunks like "5.2.1.1 There shall be only one statement on
  // a line" carry no "spacing/formatting" token in their heading) drop them.
  const isAuthoritativeDocs = (r) => {
    const src = String(r.source_display || r.source || r.repo || '').toLowerCase();
    const file = String(r.file || '').toLowerCase();
    if (/(edk2-commits|edk2-prs|commit_|pr_)/.test(file)) return false;
    return src.includes('tianocore-docs') || src.includes('tianocore-doc') ||
           src.includes('spec') || src.includes('guide') ||
           /^edk2-/.test(file);
  };

  const scored = results.map((r) => {
    const meta = metaOf(r);
    let hits = 0;
    for (const id of signals.identifiers) {
      if (meta.includes(id.toLowerCase())) hits += 2;
    }
    for (const w of signals.words) {
      if (meta.includes(w)) hits += 1;
    }
    return { r, hits };
  });

  const keep = new Set();
  // 1) Never drop the top-ranked candidates.
  for (let i = 0; i < Math.min(PRUNE_TOP, results.length); i++) keep.add(i);
  // 2) Keep every authoritative docs chunk regardless of metadata signals.
  scored.forEach((s, i) => { if (isAuthoritativeDocs(s.r)) keep.add(i); });
  // 3) Keep everything with at least one metadata signal hit.
  scored.forEach((s, i) => { if (s.hits > 0) keep.add(i); });
  // 4) Floor: refill from the original ranking so vague/edge cases keep recall.
  for (let i = 0; i < results.length && keep.size < PRUNE_FLOOR; i++) keep.add(i);

  return results.filter((_, i) => keep.has(i));
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

// Local reference for a retrieved chunk. All retrieval is served from the
// local offline knowledge base, so citations point at the on-disk document
// (file path + section) instead of a web URL: `file > section`.
function localRef(r) {
  const file = String(r.file || '');
  const title = String(r.title || '');
  const section = String(r.section || '');
  const base = file || title || '本地文档';
  return section ? `${base} > ${section}` : base;
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
  // Cap the total context budget: PDF dumps and 6000-char spec chunks can
  // otherwise push the prompt past the model context window, which makes the
  // flash model return an empty stream. Entries arrive in priority order, so
  // only the lowest-priority tail is dropped.
  const MAX_CTX_CHARS = 34000;
  let ctxChars = 0;
  const ctxCapped = [];
  for (const r of ctx) {
    const entryChars = 40 + (r.title || '').length + (r.section || '').length + (r.body || '').length;
    if (ctxChars + entryChars > MAX_CTX_CHARS && ctxCapped.length > 0) break;
    ctxCapped.push(r);
    ctxChars += entryChars;
  }
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
  
  const context = ctxCapped.map((r, i) => {
    const ref = localRef(r);
    return (
      `[${i + 1}] ${r.title}\n` +
      (r.type ? `Type: ${r.type}\n` : '') +
      (r.source ? `Source: ${r.source}\n` : '') +
      (ref ? `Local: ${ref}\n` : '') +
      (r.section ? `Section: ${r.section}\n` : '') +
      `Content:\n${r.body}\n`
    );
  }).join('\n');

  const system = [
    'You are an EDK2/TianoCore firmware development expert. You answer strictly and exhaustively from the retrieved EDK2/TianoCore documentation context.',
    intentGuidance,
    '',
    '## !! 完整性强制令 (COMPLETENESS MANDATE) !!',
    '',
    '这是最高优先级规则，覆盖下面所有风格指引：',
    '',
    '**当上下文文档中包含以下任何内容时，你必须在回答中完整枚举，禁止省略或概括：**',
    '- 具体的规则条目（如命名规则的每一条）',
    '- 具体的枚举值（如 MODULE_TYPE 的所有取值、PCD 的所有类型）',
    '- 具体的 API/函数名和参数签名',
    '- 具体的错误码和报错信息文本',
    '- 具体的格式模式（如 CamelCase 的具体格式示例 `EachWordIsDistinct`、宏格式 `EACH_WORD_UPPER`）',
    '- 具体的前缀/后缀规则（如匈牙利命名的 g/m/p 前缀）',
    '- 具体的步骤列表或检查清单',
    '',
    '**判断标准：如果标准答案中列出了某个具体值/模式/规则，而你的回答中没有，就是不合格。**',
    '宁可回答长一些、详尽一些，也绝不能遗漏上下文中的具体技术细节。',
    '',
    '## 输出范式：柔性要素，禁止刚性填空',
    '',
    '输出遵循**柔性要素范式**组织：每类问题只启用与其匹配的要素；**没有对应参考素材就直接舍弃该要素，禁止编造内容来填满章节**。禁止输出过程日志或自检勾选内容。',
    '',
    '1. **定义与关系模型**：绝大多数问题保留。开篇一句话点出本质；梳理概念之间的从属、数据流、调用关系；有多个概念时画清关系模型。',
    '',
    '2. **现象 / 根因排查清单**：**仅故障异常类问题启用**。先给可复现的外部现象（**只描述现象，禁止虚构报错码或错误文本**），再按可能性排序列出根因排查清单。**非故障问题直接删除本章节，禁止编造排查项。**',
    '',
    '3. **约束规则**：配置、驱动、规范类问题启用；纯概念科普可精简。**启用时它是回答的主体**：逐条列出上下文中的具体规则、模式、枚举值、API 签名，每条保留引用标记 `[n]`（对应 RAG 参考上下文中序号）。',
    '   - 对枚举类型（如 MODULE_TYPE）：必须列出所有取值及其含义。',
    '   - 对流程/机制：按顺序完整描述每个步骤。',
    '   - **消除无条件绝对化表述**：关键规则补上 `【触发前置条件】仅当XXX满足，才会发生该行为，否则不生效。`',
    '   - **晦涩规则双轨表达**：复杂构建/驱动规则保留 `[n]` 引用后，另起一行附"通俗解读"，说明实际开发场景含义。',
    '   - 事实性信息（章节号、签名、阈值）与上下文完全一致，禁止虚构。',
    '',
    '4. **工程要点（【强制要求】/【最佳实践】）**：技术类问题优先保留。',
    '   - **仅当 RAG 上下文有 shall/must 等规范原文依据时才标【强制要求】**；社区经验、commit 案例、逻辑推导一律归【最佳实践】。',
    '   - 综合多条文档推导出的结论加注释：`注：该结论由多条文档综合推导，原始文档无直接对应表述`，**禁止放入【强制要求】**。',
    '',
    '5. **✅/❌ 正误示例**：INF/DEC/DSC/FDF 配置、PCD 配置、Protocol/库类定义、DriverBinding 函数逻辑等场景按需补充极简核心片段（仅关键行，不写完整大文件）；**概念类问题无合适示例可省略**。',
    '',
    '6. **可观测排查验证手段**：**仅故障异常类问题输出**（构建产物 As-Built INF / map / build log、UEFI Shell 命令、SCT 测试等）；只描述现象，禁止虚构错误码。',
    '',
    '### 结尾统一放参考来源',
    '- 回答末尾附 `## 参考来源`，逐条列出本地文档定位：`- 文档标题 - 章节`（附 `Local:` 行给出的 `文件路径 > 章节`）。',
    '- 每个文档条目里 `Local:` 开头的行就是该条目的本地定位，从中取文档标题与章节。',
    '- 参考来源只写本地定位，禁止拼造任何网址。',
    '',
    '## 强制优化任务（全部执行，不可跳过）',
    '',
    '1. **信息分层校验**：仅 RAG 存在 shall/must 原文依据才可标【强制要求】；社区经验/commit 案例/逻辑推导归【最佳实践】；综合推导结论加 `注：该结论由多条文档综合推导…` 注释并禁止放入强制项。',
    '2. **补全触发前置条件**：消除无条件绝对化表述；关键规则补 `【触发前置条件】仅当XXX满足，才会发生该行为，否则不生效。`',
    '3. **晦涩规则双轨表达**：复杂构建/驱动规则保留引用标记 `[n]`，附加通俗解读说明实际开发场景含义。',
    '4. **API 与实操建议校验**：核对 API、宏、元数据段名拼写，杜绝笔误；推导得到的实操建议加注"建议/工程推断"提醒；与参考上下文矛盾的错误建议直接删除。',
    '5. **按需增加极简示例**：INF/DEC/DSC/FDF 配置、PCD 配置、Protocol/库类定义、DriverBinding 函数逻辑等场景优先补充 ✅/❌ 核心片段示例（仅关键行）；无合适示例的场景不得硬造。',
    '6. **故障类补充可观测排查手段**：仅故障异常类问题给出构建产物（As-Built INF / map / build log）、UEFI Shell 命令、SCT 测试等手段；**只描述现象，禁止虚构错误码**。',
    '7. **来源区分**：原文结论带引用标记 `[n]`；素材信息不足时如实说明"上下文未覆盖该点"，绝不编造规范条文或报错码。',
    '',
    '## 输出自检（模型内部完成后在心里校验，禁止打印过程）',
    '- 只启用与问题类型匹配的要素，未匹配章节直接舍弃；无素材时不编造填充。',
    '- 无绝对化表述，关键规则带触发前置条件。',
    '- 【强制要求】全部有规范原文依据，工程推论不混入强制。',
    '- 复杂规则配通俗解读。',
    '- 配置/代码类题目已补正误示例（概念题不强求）。',
    '- 故障问题提供可观测排查手段。',
    '- API、标识符无笔误，实操建议与参考上下文无冲突。',
    '- 推导内容有注释，无虚构报错、规范条文。',
    '',
    '## 措辞红线',
    '- 措辞用固件专业表述：**必须、禁止、红线、强制**。',
    '- 上下文信息不足时明确声明，绝不虚构。',
    '- 关键数据必须与上下文完全一致。',
    '',
    '## 长度与密度',
    '- **完整性优先于简洁性**。回答可以长，但不能遗漏上下文中的具体技术细节。',
    '- 去除无信息量的铺垫句，但具体规则/枚举/模式必须完整保留。',
    '',
    '## Output format examples (Few-shot)',
    '',
    '### Example 1: 模块/包/平台关系',
    '**Question**: EDK2中模块（Module）、包（Package）和平台（Platform）是什么关系？',
    '',
    '**答案：**',
    '',
    '**定义与关系模型**',
    'EDK2 用三级构建单元组织源码：Module（编译单元）位于 Package（接口与头文件集合）之内，最终由 Platform（DSC+FDF）决定哪些模块进入固件。',
    '',
    '**约束规则**',
    '- Module 是"1个 INF + 一组.c/.h源码"的编译单元，INF 关键段见 [1]。',
    '- Package 的标识物是 DEC：`[Defines]` 声明包名与 GUID；`[Includes]` 导出公共头文件根目录；`[LibraryClasses]` 声明库类头文件；`[Guids/Ppis/Protocols]` 声明 GUID 值；`[Pcds]` 声明 PCD（默认值、数据类型、Token 号），见 [1]。',
    '- Platform 由 DSC + FDF 描述：DSC 设输出目录/架构/BUILD_TARGETS、`[Components]` 列出编译模块、`[LibraryClasses]` 选具体实例、`[Pcds*]` 配置 PCD 值；FDF 描述 FD/FV 布局，见 [1]。',
    '- build 工具解析 DSC + 各 DEC + 各 INF，生成顶层 makefile 和每个模块的 makefile + AutoGen.c/AutoGen.h。一次 build 只有 active platform 的 DSC 生效，见 [1]。',
    '- `【触发前置条件】仅当模块被平台 DSC 的 [Components] 引用时，build 才会为其生成 makefile 与 AutoGen.*。`',
    '',
    '**工程要点**',
    '**【最佳实践】** 新增功能先按 Module→Package→Platform 三层各自落位，接口放包、实现放模块，避免越层依赖。',
    '- ✅ 库类声明在 DEC `[LibraryClasses]`，具体库实例在 DSC 选择 / ❌ 把库类实现直接写进 DEC。',
    '',
    '## 参考来源',
    '- EDK II Module Write Guide - 1.1 Overview + 2.1 Package（本地：edk2-ModuleWriteGuide > 2.1 Package）',
    '',
    '---',
    '',
    '### Example 2: 命名规范（穷举式）',
    '**Question**: EDK II 有哪些命名规范？',
    '',
    '**答案：**',
    '',
    '**定义与关系模型**',
    'EDK II 用三类标识符格式区分代码角色：变量/函数（CamelCase）、宏/typedef（全大写下划线）、全局/模块/指针变量（g/m/p 前缀）。',
    '',
    '**约束规则**',
    '**标识符格式**',
    '- 变量/函数/枚举/结构体成员：`EachWordIsDistinctEvenAcronymsLikeAcpi`，每个单词首字母大写，必须大小写混合，全大写或全小写都不允许。',
    '- 缩略词不要整个大写：`MyPciAddress` 而非 `MyPCIAddress`。',
    '- 功能宏/#define/typedef：`EACH_WORD_IS_DISTINCT_EVEN_ACRONYMS_LIKE_ACPI`，全大写加下划线。禁止用 `_t` 后缀表示类型。',
    '',
    '**匈牙利前缀（仅三个例外）**',
    '`【触发前置条件】仅当变量是全局变量或模块变量（指针可选）时，才允许使用对应前缀；其余场景加前缀即违规。`',
    '- 全局变量必须加 `g` 前缀：`gThisIsAGlobalVariableName`。',
    '- 模块变量必须加 `m` 前缀：`mThisIsAModuleVariableName`。',
    '- 指针变量可加 `p` 前缀（可选）。',
    '- 匈牙利命名法在其他情况禁止使用。',
    '',
    '**其他约束**',
    '- 名字长度不限，建议 10~30 字符，不依赖超过 31 字符的区分度。',
    '- 文件名不能以数字开头，每个头文件名必须唯一。',
    '- 禁止使用 C 关键字或标准头文件中已声明的符号作为内部符号。',
    '- 外部符号名不得以下划线开头。',
    '- 新建全局实体不要再用 `EFI_` 前缀；`DXE_` 和 `PEI_` 前缀分别保留给 DXE 和 PEI 驱动。',
    '- 只能使用标准缩写和行业缩略词，非标准的必须在文件头注释里定义。',
    '- 禁止函数名或类型名重载。',
    '',
    '**工程要点**',
    '**【强制要求】** 全局/模块变量必须带 g/m 前缀（规范原文依据）。',
    '**【最佳实践】** 局部变量可保持简洁，避免无意义前缀。',
    '- ✅ `gCpuFrequency` / ❌ `CpuFrequency`（全局变量漏加 g 前缀）',
    '- ✅ `MY_GLOBAL_MACRO` / ❌ `MyGlobalMacro`（宏写成驼峰）',
    '',
    '## 参考来源',
    '- EDK II C Coding Standards - 4.4 Identifiers（本地：edk2-CCodingStandardsSpecification > 4.4 Identifiers）',
    '',
    '---',
    '',
    '### Example 3: DXE 协议找不到（故障类）',
    '**Question**: EDK2 驱动在 DXE 阶段注册了协议但其他模块找不到该协议，可能的原因有哪些？',
    '',
    '**答案：**',
    '',
    '**定义与关系模型**',
    '协议 = 接口结构体（函数指针 + 数据成员）+ GUID；生产者安装到 handle 数据库，消费者通过 Boot Services 检索 [1]。',
    '',
    '**现象 / 根因排查清单**',
    '**可复现现象**：`LocateProtocol()`/`OpenProtocol()` 返回非成功状态或拿到空接口指针；协议数据库调试输出中无该 GUID 条目 [1]。',
    '',
    '按可能性排序的排查清单，逐项加 `【触发前置条件】`：',
    '- **GUID 不一致**：【触发前置条件】仅当产生与消费两端 GUID 字节完全相同时才命中；查 DEC、INF `[Protocols]`、代码三方是否一致。',
    '- **时序倒置（消费者先于生产者执行）**：【触发前置条件】仅当消费者执行早于生产者入口点；非 UEFI Driver Model 驱动在 DXE 早期执行，常因依赖未就绪失败 [3]。',
    '- **安装失败但未检查返回值**：【触发前置条件】仅当忽略 `InstallMultipleProtocolInterfaces()` 等的返回值时才出现"表面注册、实际没有"。[1]',
    '- **把 UEFI Application 当作注册者**：【触发前置条件】仅当安装协议的是 UEFI Application；其入口点返回后即被卸载，协议随之消失 [7]。',
    '',
    '**约束规则**',
    '- 协议安装服务：`InstallProtocolInterface()`、`ReInstallProtocolInterface()`、`InstallMultipleProtocolInterfaces()`；检索服务：`LocateProtocol()`、`HandleProtocol()`、`OpenProtocol()` [1]。',
    '- **通俗解读**：`LocateProtocol()` 全局找第一个实例，`HandleProtocol()` 只在指定 handle 上找；Service Driver 生成的服务句柄没有 Device Path [6]。',
    '',
    '**工程要点**',
    '**【强制要求】** DXE 驱动必须设计为不依赖尚不可用的服务，能推迟的工作推迟到服务可用后再做 [3]。',
    '**【最佳实践】** 用 `LocateProtocol()` 前先校验 `EFI_ERROR(Status)`，避免空指针解引用。',
    '- ✅ `Status = gBS->LocateProtocol(&gEfiSampleProtocolGuid, NULL, (VOID**)&SampleProtocol); if (EFI_ERROR(Status)) return Status;`',
    '- ❌ 不检查返回值直接调用 `SampleProtocol->SampleProtocolApi()`。',
    '',
    '**可观测排查手段**（仅故障类启用）',
    '- 构建产物：确认驱动 .efi 进了 FV（检查 FD/FV 布局与 Dak/As-Built INF），并确认其 `.depex` 正确。',
    '- UEFI Shell：用 `dh` 查看 handle 数据库、`drivers`/`devices` 检查驱动是否加载。',
    '- 固件调试输出：DxeCore 协议数据库日志中检索该 GUID 条目是否存在。',
    '',
    '## 参考来源',
    '- edk2-ModuleWriteGuide > 5.4 Communication between UEFI Drivers（本地：ModuleWriteGuide\\5_uefi_drivers\\54_communication_between_uefi_drivers.md）',
    '',
    '---',
    '',
    'Follow these examples: apply the flexible element paradigm — only include sections that match the question type (fault questions get 现象/根因排查清单 + 可观测排查手段, config/code questions get ✅/❌ examples, concept questions can be brief), ENUMERATE ALL specific rules/values/patterns from context with [n] markers, always close with a ## 参考来源 block, and never print the self-check checklist.',
  ].join('\n');

  const messages = [{ role: 'system', content: system }];
  for (const h of (history || [])) {
    if (h && h.role && h.content) {
      messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content).slice(0, 4000) });
    }
  }
  messages.push({ role: 'user', content: `RAG 参考上下文：\n${context}\n\n原始问题：${question}` });
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
function llmStream(messages, { onDelta, timeoutMs = LLM_STREAM_TIMEOUT_MS, maxTokens = LLM_MAX_TOKENS } = {}) {
  return new Promise((resolve, reject) => {
    const { apiKey, baseUrl, model } = llmConfig();
    if (!apiKey || !baseUrl || !model) {
      reject(new Error('LLM not configured. Set LLM_API_KEY / LLM_BASE_URL / LLM_MODEL.'));
      return;
    }
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const u = new URL(url);
    const payload = { model, messages, temperature: 0, stream: true, max_tokens: maxTokens };

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
      let rawChunks = [];
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        rawChunks.push(chunk);
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
      res.on('end', () => {
        resolve();
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(JSON.stringify(payload));
    req.end();
  });
}

// Non-streaming single LLM completion. Used to translate a Chinese question
// into an English retrieval query (cross-lingual vector recall is weak, so a
// faithful English query ranks the authoritative spec chapters far better).
// Falls back to the input text on any failure so search never breaks.
async function llmComplete(messages, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const { apiKey, baseUrl, model } = llmConfig();
    if (!apiKey || !baseUrl || !model) return resolve('');
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const u = new URL(url);
    const payload = { model, messages, temperature: 0, max_tokens: 300 };
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
        'User-Agent': process.env.LLM_USER_AGENT ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'application/json',
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return resolve('');
        try {
          const j = JSON.parse(data);
          const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          resolve(typeof text === 'string' ? text.trim() : '');
        } catch { resolve(''); }
      });
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.write(JSON.stringify(payload));
    req.end();
  });
}

// Cache for question -> English translation (LRU, 200 entries, 30 min TTL).
const translationCache = new Map();
const TRANSLATION_TTL_MS = 30 * 60 * 1000;

async function translateToEnglish(question) {
  const key = normalizeQuery(question);
  const hit = translationCache.get(key);
  if (hit && (Date.now() - hit.timestamp) < TRANSLATION_TTL_MS) return hit.text;
  const text = await llmComplete([
    {
      role: 'system',
      content: 'You are a translation engine. Translate the user question from Chinese into concise, technically accurate English suitable for searching EDK2/TianoCore documentation. Keep EDK2 terms (INF, DSC, DEC, FDF, PCD, SMM, HII, protocol, GUID...) as-is. Output ONLY the English translation, no explanation, no quotes.',
    },
    { role: 'user', content: question },
  ]);
  const result = text || question;
  translationCache.set(key, { text: result, timestamp: Date.now() });
  return result;
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
  const chunks = [];
  let received = 0;
  req.on('data', (c) => {
    chunks.push(c);
    received += c.length;
    if (received > 1e6) req.destroy();
  });
  req.on('end', async () => {
    const traceId = newTraceId();
    const startedAt = Date.now();
    let qh = '';
    const finishTotal = (status, extra = {}) => {
      emitTrace({
        traceId, stage: 'http_total', durationMs: Date.now() - startedAt,
        queryHash: qh, status, ...extra,
      });
    };
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
        finishTotal('error', { error: 'missing_question' });
        return;
      }
      qh = queryHash(question);
      emitTrace({ traceId, stage: 'http_start', durationMs: 0, queryHash: qh, status: 'start' });

      const daemonUrl = await getHealthyDaemonUrl();
      if (!daemonUrl) {
        const st = readDaemonState();
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Daemon 未就绪：${(st && st.message) || '无法启动知识库服务，请检查 daemon 日志'}` }));
        finishTotal('error', { error: 'daemon_unavailable' });
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
          // Cross-lingual vector recall is weak: Chinese queries ("排版/空白")
          // rank unrelated Summary/README chunks above the actual English spec
          // chapters. Translate the question into a faithful English retrieval
          // query first (falls back to the original + keyword expansion on
          // translation failure).
          sendSSE(res, 'phase', { step: 'translate', text: '翻译检索查询…', progress: 15 });
          const translateStart = Date.now();
          const translated = await translateToEnglish(question);
          emitTrace({
            traceId, stage: 'llm_translate', durationMs: Date.now() - translateStart,
            queryHash: qh, status: 'ok',
          });
          // Hybrid retrieval query: the faithful English translation provides
          // cross-lingual semantic recall (Chinese "排版/空白" -> English
          // "formatting/whitespace"), while the original keyword-expansion
          // terms keep precise EDK2 anchors (LNK2001, error 4000, PCD...) that
          // pure translation dilutes. Merge, dedup, cap length.
          const translatedQ = (translated && translated !== question) ? translated : '';
          const expanded = expandChineseQuery(question);
          const seen = new Set(translatedQ.toLowerCase().split(/\s+/).filter(Boolean));
          const tail = expanded.split(/\s+/).filter(t => {
            const l = t.toLowerCase();
            if (seen.has(l)) return false;
            seen.add(l);
            return true;
          });
          const searchQuery = [translatedQ, tail.join(' ')].filter(Boolean).join(' ').slice(0, 500);
          // Parallel dual-source retrieval. The knowledge base is dominated by
          // tianocore/edk2 commit records (36k+ chunks): for build/error/commit
          // topics their "Fix ... build error" subjects outrank the real spec
          // docs, so the target chapter (e.g. ModuleWriteGuide 3.7.7) can fall
          // out of top_k. Run a second query restricted to the authoritative
          // tianocore-docs source and merge it back in below.
          const searchStart = Date.now();
          const mainPromise = httpJson(`${url}/search?query=${encodeURIComponent(searchQuery)}&top_k=35`, { timeoutMs: 120000, headers: { 'X-Trace-Id': traceId } });
          // Daemon clamps top_k to 20 and cross-lingual vector recall is weak:
          // a vague Chinese query ("排版/空白") ranks many unrelated Summary/
          // README chunks above the actual CCoding spec chapters. For coding-
          // style topics fire two focused English docs queries (chapter locator
          // + concrete rule phrases) so 5.2.1/5.2.2/5.2.3 sub-chunks survive.
          const isStyleTopic = /spacing|formatting|indentation|排版|空白|缩进|风格|style|vertical|horizontal|coding.?standard|编码规范/i.test(searchQuery);
          const docsFocusQueries = isStyleTopic
            ? [
                'C Coding Standards 5.2 Spacing Vertical Spacing blank lines Horizontal Spacing indentation File Heading section rules',
                'vertical spacing blank lines make code more readable group logically related sections one statement on a line open brace predicate expression alignment continuation line',
                'Formatting: General Rules Formatting: Vertical spacing Formatting: Horizontal spacing Formatting: Predicate Expressions 5.2.2 Horizontal Spacing 5.2.3 File Heading Predicate Expressions quick reference source_files',
                '5.2.2.1 space one or more spaces long 5.2.2.2 binary operators space',
                '5.2.2.3 unary operators 5.2.2.4 multi-line function calls line up',
                '5.2.2.5 commas semicolons 5.2.2.6 open parenthesis 5.2.2.7 open brace',
                '5.2.2.8 structure member 5.2.2.9 array subscripts 5.2.2.10 parentheses precedence 5.2.2.11 align continuation',
              ]
            : [];
          const docsPromise = httpJson(`${url}/search?query=${encodeURIComponent(searchQuery)}&top_k=20&source=tianocore-docs`, { timeoutMs: 120000, headers: { 'X-Trace-Id': traceId } })
            .catch(() => null);
          const docsFocusPromises = docsFocusQueries.map(fq =>
            httpJson(`${url}/search?query=${encodeURIComponent(fq)}&top_k=20&source=tianocore-docs`, { timeoutMs: 120000, headers: { 'X-Trace-Id': traceId } }).catch(() => null));
          const [mainResp, docsResp, ...docsFocusResps] = await Promise.all([mainPromise, docsPromise, ...docsFocusPromises]);
          emitTrace({
            traceId, stage: 'mcp_search', durationMs: Date.now() - searchStart,
            queryHash: qh, status: 'ok', calls: 2 + docsFocusQueries.length,
          });
          searchResp = mainResp;
          const docsResults = (docsResp && docsResp.body && docsResp.body.results) || [];
          const docsFocusResults = docsFocusResps.flatMap(r => (r && r.body && r.body.results) || []);
          // Merge all docs-source responses, dedup by chunk key.
          const docsCombined = [...docsResults];
          {
            const seen = new Set(docsResults.map(r => chunkKey(r)));
            for (const r of docsFocusResults) {
              const k = chunkKey(r);
              if (!seen.has(k)) { seen.add(k); docsCombined.push(r); }
            }
          }
          if (docsCombined.length > 0) {
            // Merge: docs-source chunks are authoritative for spec questions,
            // so keep every unique docs chunk that the broad query missed,
            // interleaved by their docs rank after the broad top-3.
            const broad = (searchResp.body && searchResp.body.results) || [];
            const seen = new Set(broad.map(r => chunkKey(r)));
            const merged = broad.slice(0, 3);
            const docSeen = new Set(merged.map(r => chunkKey(r)));
            const docsOnly = docsCombined.filter(r => {
              const k = chunkKey(r);
              if (seen.has(k) || docSeen.has(k)) return false;
              docSeen.add(k);
              return true;
            });
            merged.push(...docsOnly.slice(0, 15));
            for (const r of broad.slice(3)) {
              const k = chunkKey(r);
              if (merged.length >= 35) break;
              if (!docSeen.has(k)) { docSeen.add(k); merged.push(r); }
            }
            searchResp = { body: { results: merged } };
          }

          // General title-shell expansion: detect blocks that are just section headers
          // (short content for a section that has subsections) and expand them by
          // reading the full section from the source file on disk.
          if (searchResp.body && searchResp.body.results) {
            searchResp.body.results = expandTitleShells(searchResp.body.results);
          }

        } catch (e) {
          sendSSE(res, 'error', { error: `检索失败：${e.message}` });
          res.end();
          finishTotal('error', { error: `search: ${e.message}` });
          return;
        }
        results = (searchResp.body && searchResp.body.results) || [];
        
        // Metadata-based precision filter: prune candidates whose document
        // metadata (title/file/section/url) shares none of the query's exact
        // identifiers or distinctive expansion keywords. This counters the
        // "semantically close but wrong symbol" failures of pure vector search
        // BEFORE the expensive rerank stage sees them.
        results = pruneByMetadata(question, results);
        
        // 1.5) Rerank results using BGE-reranker. Use a HYBRID approach:
        // GUARANTEE top 3 from vector search survive (the reranker often
        // demotes key chunks like "4.4 Hungarian Prefixes" from #1 to #8).
        // Then fill remaining slots from rerank order.
        if (results.length > 10) {
          sendSSE(res, 'phase', { step: 'rerank', text: '重排序文档…', progress: 25 });
          let rerankStart = Date.now();
          try {
            const rerankQuery = expandChineseQuery(question);
            // GUARANTEE: keep the top vector hits AND the top tianocore-docs
            // chunk for the query. The BGE reranker often ranks generic commit
            // subjects ("Fix ICC build error") above the authoritative spec
            // chapter (e.g. ModuleWriteGuide 3.7.7), so without this guarantee
            // the docs block gets pushed past the merge limit.
            const vectorTop3 = results.slice(0, 3);
            // Prefer the spec/guide chapter that the query most plausibly maps
            // to: explicit file-name markers (building/debugging/build/…) first,
            // else the highest-scored docs-source chunk. Avoid picking a
            // tianocore-wiki "Lab Setup" page just because it sorts first.
            const isDocs = r => {
              const src = String(r.source_display || r.source || '').toLowerCase();
              const file = String(r.file || '').toLowerCase();
              return (src.includes('tianocore-docs') || src.includes('guide') || src.includes('spec')) &&
                     !/edk2-commits|edk2-prs|commit_|pr_/.test(file);
            };
            const marker = /(building|debug|debugging|module|package|dsc|inf|pcd|depex|driver|boot|build|source|spec|error|break|spacing|formatting|indentation|naming|style|source_file|header|comment)/i;
            const docsCands = results.filter(isDocs);
            // Score docs candidates: tianocore-docs spec repos (edk2-*) and
            // module/package/build chapters win over lab tutorials and PDFs.
            // SUMMARY.md / README.md index files lose to real chapter content.
            const docsScore = r => {
              const file = String(r.file || '');
              const text = (file + ' ' + String(r.title || '') + ' ' + String(r.section || '')).toLowerCase();
              let s = 0;
              if (/^edk2-|specification|guideline/i.test(file)) s += 60;
              if (marker.test(file + ' ' + String(r.title || ''))) s += 30;
              if (/\bmodule\b|_module|package|driver|build|compile|error|spacing|formatting|indentation/i.test(text)) s += 20;
              if (/\/(summary|readme|README)\.|SUMMARY\.md$/i.test(file)) s -= 50;
              if (/\.pdf$/i.test(file)) s -= 40;
              if (/lab|tutorial|getting.started|udk20|udk21/i.test(file)) s -= 30;
              return s;
            };
            docsCands.sort((a, b) => docsScore(b) - docsScore(a));
            // Keep the top docs-source chunks (not just one): for "spec
            // chapter catalog" questions the authoritative answer often spans
            // several chapters (5.2.1 Vertical / 5.2.2 Horizontal / 5.2.3
            // File Heading) which the reranker would otherwise crowd out.
            const docsTop3 = docsCands.slice(0, 5);
            const guarded = [];
            const guardSeen = new Set();
            for (const r of [...vectorTop3, ...docsTop3]) {
              if (!r) continue;
              const key = (r.file || '') + '|' + (r.section || '') + '|' + (r.title || '');
              if (!guardSeen.has(key)) { guardSeen.add(key); guarded.push(r); }
            }
            const reranked = await rerankDocuments(rerankQuery, results);
            emitTrace({
              traceId, stage: 'rerank', durationMs: Date.now() - rerankStart,
              queryHash: qh, status: 'ok', docs: results.length,
            });
            
            // Build merged list: start with guaranteed top hits
            const seen = new Set();
            const merged = [...guarded];
            for (const r of guarded) {
              const key = (r.file || '') + '|' + (r.section || '') + '|' + (r.title || '');
              seen.add(key);
            }
            // Fill remaining slots from rerank order
            for (const r of reranked) {
              if (merged.length >= 15) break;
              const key = (r.file || '') + '|' + (r.section || '') + '|' + (r.title || '');
              if (!seen.has(key) && key !== '||') {
                seen.add(key);
                merged.push(r);
              }
            }
            results = merged;
          } catch (e) {
            emitTrace({
              traceId, stage: 'rerank', durationMs: Date.now() - rerankStart,
              queryHash: qh, status: 'error', error: e.message,
            });
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
        finishTotal('error', { error: 'llm_not_configured' });
        return;
      }
      sendSSE(res, 'phase', { step: 'llm_build', text: '构建提示词…', progress: 50, model });
      
      const messages = buildMessages(question, results, history);
      sendSSE(res, 'phase', { step: 'llm', text: '正在生成回答…', progress: 60, model });
      
      const llmStart = Date.now();
      let tokenCount = 0;
      try {
        // The upstream LLM intermittently returns an empty stream (200 + [DONE]
        // with zero deltas) or drops the connection before any content. Retry
        // only while nothing has been streamed yet, so a partially-rendered
        // answer is never duplicated to the client. Later attempts use a
        // progressively smaller max_tokens budget so a flaky upstream still
        // yields SOME bounded answer instead of failing the whole request.
        const attemptCaps = [
          LLM_MAX_TOKENS,
          LLM_RETRY_MAX_TOKENS,
          Math.min(LLM_RETRY_MAX_TOKENS, 1500),
        ];
        for (let attempt = 1; attempt <= 3; attempt++) {
          let chars = 0;
          try {
            await llmStream(messages, {
              onDelta: (text) => {
                chars += text.length;
                tokenCount++;
                sendSSE(res, 'delta', { text });
              },
              timeoutMs: attempt === 1 ? LLM_STREAM_TIMEOUT_MS : Math.max(60000, LLM_STREAM_TIMEOUT_MS / 2),
              maxTokens: attemptCaps[attempt - 1],
            });
          } catch (e) {
            if (attempt < 3 && chars === 0) {
              sendSSE(res, 'phase', { step: 'llm_retry', text: '生成中断，正在重试…', progress: 70, model });
              await new Promise(r => setTimeout(r, 1000));
              continue;
            }
            emitTrace({
              traceId, stage: 'llm_generate', durationMs: Date.now() - llmStart,
              queryHash: qh, status: 'error', error: e.message, tokens: tokenCount,
            });
            sendSSE(res, 'error', { error: e.message });
            res.end();
            finishTotal('error', { error: e.message });
            return;
          }
          if (chars > 0) break;
          emitTrace({
            traceId, stage: 'llm_empty_retry', durationMs: Date.now() - llmStart,
            queryHash: qh, status: 'empty', attempt, maxTokens: attemptCaps[attempt - 1],
          });
          if (attempt < 3) {
            sendSSE(res, 'phase', { step: 'llm_retry', text: '生成结果为空，正在重试…', progress: 70, model });
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      } catch (e) {
        emitTrace({
          traceId, stage: 'llm_generate', durationMs: Date.now() - llmStart,
          queryHash: qh, status: 'error', error: e.message, tokens: tokenCount,
        });
        sendSSE(res, 'error', { error: e.message });
        res.end();
        finishTotal('error', { error: e.message });
        return;
      }
      if (tokenCount === 0) {
        emitTrace({
          traceId, stage: 'llm_generate', durationMs: Date.now() - llmStart,
          queryHash: qh, status: 'empty', tokens: 0,
        });
        sendSSE(res, 'error', { error: 'LLM 生成多次为空，请稍后重试。' });
        res.end();
        finishTotal('error', { error: 'empty_generation' });
        return;
      }
      emitTrace({
        traceId, stage: 'llm_generate', durationMs: Date.now() - llmStart,
        queryHash: qh, status: 'ok', tokens: tokenCount,
      });
      sendSSE(res, 'phase', { step: 'llm_done', text: '回答完成', progress: 100, model, tokens: tokenCount });
      sendSSE(res, 'done', { model, tokens: tokenCount, from_cache: fromCache });
      res.end();
      finishTotal('ok', { tokens: tokenCount, from_cache: fromCache });
    } catch (e) {
      // try to send error as SSE if headers already sent
      if (res.headersSent) {
        sendSSE(res, 'error', { error: e.message });
        res.end();
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
      finishTotal('error', { error: e.message });
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
