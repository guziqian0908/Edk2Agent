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
 *   LLM_MAX_TOKENS    max answer tokens (default 1600; lower = faster; one pass covers most answers, continuation handles the rest)
 *   LLM_TOTAL_BUDGET_MS  hard cap for the whole generate+retry loop (default 120 s)
 *   LLM_FIRST_TOKEN_TIMEOUT_MS per-attempt first-token deadline (default 60 s)
 *   ENABLE_RERANK     set 'false' to skip the BGE rerank stage entirely (default on)
 *   RERANK_TIMEOUT_MS rerank HTTP timeout (default 60000 ms)
 *   RERANK_CANDIDATES candidates scored by the reranker (default 16)
 *   RERANK_SNIPPET_CHARS per-candidate text sent to the reranker (default 800)
 *   ANSWER_CACHE_MAX    answer-cache LRU entries (default 300)
 *   ANSWER_CACHE_TTL_MS answer-cache TTL ms (default 30 min)
 *   RERANK_ADAPTIVE_SKIP set 'false' to disable confidence-based rerank skip
 *                         (default on: skip cross-encoder when retrieval already
 *                         pinned an authoritative #1 chunk)
 *   SEMANTIC_CACHE     set 'false' to disable semantic (embedding) answer cache
 *   SEMANTIC_CACHE_THRESHOLD cosine similarity to reuse a cached answer (0.93)
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

// ---- answer cache: short-circuits the WHOLE pipeline on repeat questions ----
// The dominant cost (LLM generation, ~64% of p50) is paid even when the
// search/rerank stages are already cached. So the final answer is cached too
// and, on a hit, replayed to the client as SSE deltas — the same event
// sequence the real LLM stream produces, so the frontend needs no changes.
//
// Safety rules:
//   * Only answers generated from a SELF-CONTAINED turn are stored (no
//     history and no prevResults): such an answer depends solely on the
//     question + retrieved docs, so replaying it under any later history is
//     still correct for that exact question text.
//   * Keyed by (model, normalized question) — switching models invalidates.
//   * TTL (default 30 min) bounds staleness against KB updates; LRU caps
//     memory. Client can force a fresh generation with {"fresh":true}.
const answerCache = new Map();
const ANSWER_CACHE_MAX = parseInt(process.env.ANSWER_CACHE_MAX || '300', 10);
const ANSWER_CACHE_TTL_MS = parseInt(
  process.env.ANSWER_CACHE_TTL_MS || String(30 * 60 * 1000), 10);

function answerCacheKey(question, model) {
  return `${model || '?'}|${normalizeQuery(question)}`;
}

function getCachedAnswer(question, model) {
  const key = answerCacheKey(question, model);
  const hit = answerCache.get(key);
  if (hit && (Date.now() - hit.timestamp) < ANSWER_CACHE_TTL_MS) {
    hit.hitCount = (hit.hitCount || 0) + 1;
    return hit;
  }
  answerCache.delete(key);
  return null;
}

function setCachedAnswer(question, model, data) {
  const key = answerCacheKey(question, model);
  if (answerCache.size >= ANSWER_CACHE_MAX) {
    const oldestKey = answerCache.keys().next().value;
    answerCache.delete(oldestKey);
  }
  answerCache.set(key, { ...data, timestamp: Date.now(), hitCount: 0 });
}

// Semantic answer cache (doc P1 / 3): on top of the exact (model+normalized
// question) cache, a near-paraphrase query whose bge-m3 embedding is within
// SEMANTIC_CACHE_THRESHOLD cosine of a stored question reuses the stored answer.
// Zero hardware — it reuses the daemon's local /embed endpoint. The KB is a
// static doc corpus, so staleness risk is low; the threshold (0.93) is kept
// strict and the feature is fully disableable (SEMANTIC_CACHE=false).
const SEMANTIC_CACHE = process.env.SEMANTIC_CACHE !== 'false';
const SEMANTIC_CACHE_THRESHOLD = parseFloat(
  process.env.SEMANTIC_CACHE_THRESHOLD || '0.93');

// Embed a query via the daemon's /embed endpoint (bge-m3, L2-normalized).
// Returns null on any failure so callers degrade to exact match / live gen.
async function embedQuery(text, daemonUrl) {
  try {
    const u = normalizeDaemonUrl(daemonUrl || getDaemonUrl() || '');
    if (!u) return null;
    const r = await httpJson(
      `${u}/embed?query=${encodeURIComponent(String(text || '').slice(0, 300))}`,
      { timeoutMs: 20000 });
    if (r.status >= 200 && r.status < 300 && Array.isArray(r.body.embedding)) {
      return r.body.embedding;
    }
  } catch { /* daemon/embed unavailable -> degrade */ }
  return null;
}

// Look up a semantic (paraphrase) cache hit. Returns
// { cached, similarity } or null. Embeddings from bge-m3 with
// normalize_embeddings=True are unit vectors, so cosine == dot product.
async function getSemanticCachedAnswer(question, model, daemonUrl) {
  if (!SEMANTIC_CACHE) return null;
  const vec = await embedQuery(question, daemonUrl);
  if (!vec || !vec.length) return null;
  let best = null;
  let bestSim = SEMANTIC_CACHE_THRESHOLD;
  const now = Date.now();
  for (const hit of answerCache.values()) {
    if (hit.model && hit.model !== model) continue;
    if (now - hit.timestamp >= ANSWER_CACHE_TTL_MS) continue;
    const e = hit.queryEmbedding;
    if (!Array.isArray(e) || e.length !== vec.length) continue;
    let dot = 0;
    for (let i = 0; i < e.length; i++) dot += e[i] * vec[i];
    if (dot > bestSim) { bestSim = dot; best = hit; }
  }
  if (best) return { cached: best, similarity: bestSim };
  return null;
}

// Store an answer for exact-match reuse and, in the background, attach the
// query embedding so the semantic cache can match future paraphrases. The
// embedding is computed asynchronously so it never delays the final `done`
// event; embedding failure is non-fatal (exact-match reuse still works).
function storeAnswerCache(question, model, data, daemonUrl) {
  const key = answerCacheKey(question, model);
  if (answerCache.size >= ANSWER_CACHE_MAX) {
    const oldestKey = answerCache.keys().next().value;
    answerCache.delete(oldestKey);
  }
  const entry = { ...data, queryEmbedding: null, timestamp: Date.now(), hitCount: 0 };
  answerCache.set(key, entry);
  if (SEMANTIC_CACHE && daemonUrl) {
    embedQuery(question, daemonUrl)
      .then((embedding) => { if (embedding) entry.queryEmbedding = embedding; })
      .catch(() => {});
  }
  return entry;
}

// Replay a cached answer as the same SSE stream a live LLM call emits:
// phase(cache_hit) -> results -> phase(llm) -> delta* -> phase(llm_done) -> done.
function replayCachedAnswer(res, cached, semantic = false) {
  sendSSE(res, 'phase', {
    step: 'cache_hit',
    text: semantic ? '命中语义缓存（近义问法），直接返回…' : '命中历史回答，直接返回…',
    progress: 10,
    semantic,
  });
  sendSSE(res, 'results', { results: (cached.results || []).slice(0, 10), daemon: null, from_cache: true, semantic });
  sendSSE(res, 'phase', { step: 'llm', text: '正在生成回答…', progress: 60, model: cached.model, semantic });
  const answer = cached.answer || '';
  const CHUNK = 64;
  for (let i = 0; i < answer.length; i += CHUNK) {
    sendSSE(res, 'delta', { text: answer.slice(i, i + CHUNK) });
  }
  sendSSE(res, 'phase', { step: 'llm_done', text: '回答完成', progress: 100, model: cached.model, tokens: cached.tokens || 0, from_cache: true, semantic });
  sendSSE(res, 'done', { model: cached.model, tokens: cached.tokens || 0, from_cache: true, semantic });
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
      snippet: String(d.snippet || d.content || '').slice(0, RERANK_SNIPPET_CHARS),
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
      timeout: RERANK_TIMEOUT_MS,
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

// Adaptive rerank skip (doc P0 / 1a): when the fused retrieval order has already
// pinned an authoritative spec/docs chunk as the clear #1 with a strong
// query-signal match, the cross-encoder rerank cannot improve the answer — the
// LLM context is built from the fused order regardless of rerank — and only
// costs CPU plus delays the final on-screen source-list ordering. Skip it.
//
// Conservative by design: a vague query (few metadata signals) or a non-
// authoritative #1 (e.g. a commit subject outranking the spec chapter) still
// goes through the full rerank. Gated by RERANK_ADAPTIVE_SKIP.
const RERANK_ADAPTIVE_SKIP = process.env.RERANK_ADAPTIVE_SKIP !== 'false';
function shouldSkipRerank(query, results) {
  if (!RERANK_ADAPTIVE_SKIP || !ENABLE_RERANK) return false;
  if (!Array.isArray(results) || results.length <= 10) return false;
  const top = results[0];
  if (!isAuthoritativeDocs(top)) return false;
  const signals = metadataSignals(query);
  if (signals.identifiers.length + signals.words.length < PRUNE_MIN_SIGNALS) {
    return false; // too vague for a confident skip
  }
  const meta = [top.title, top.section, top.file, top.url]
    .filter(Boolean).join(' ').toLowerCase();
  let hits = 0;
  for (const id of signals.identifiers) if (meta.includes(id.toLowerCase())) hits += 2;
  for (const w of signals.words) if (meta.includes(w)) hits += 1;
  return hits >= 1;
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

// ---- LLM generation budget (env-tunable; defaults balance exhaustiveness and latency) ----
const LLM_MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS || '3000', 10);
const LLM_RETRY_MAX_TOKENS = parseInt(process.env.LLM_RETRY_MAX_TOKENS || '2000', 10);
const LLM_STREAM_TIMEOUT_MS = parseInt(process.env.LLM_STREAM_TIMEOUT_MS || '180000', 10);
// Hard cap for the WHOLE generate+retry loop. The upstream can stream an
// empty response until its timeout fires, so without this a single flaky
// request could otherwise burn 3 attempts x LLM_STREAM_TIMEOUT_MS (~360s)
// and blow up P99. Each attempt's timeout is also clamped to the remaining
// budget.
const LLM_TOTAL_BUDGET_MS = parseInt(process.env.LLM_TOTAL_BUDGET_MS || '120000', 10);
// Per-attempt deadline for the FIRST token: guards against an upstream that
// keeps the connection open during a very long prefill and never sends a
// token. Default 60s (generous: current prefill is ~26s with the full prompt).
const LLM_FIRST_TOKEN_TIMEOUT_MS = parseInt(
  process.env.LLM_FIRST_TOKEN_TIMEOUT_MS || '60000', 10);

// ---- rerank control (env-tunable) ----
// The BGE cross-encoder on CPU costs ~14-19s per request and sits directly in
// front of the first LLM token. ENABLE_RERANK=false skips it entirely (the
// fused dense-first + docs merge order is used instead); RERANK_TIMEOUT_MS
// bounds a hung rerank service (falls back to the retrieval order). Skipping
// is a latency-vs-ordering trade-off, so it is opt-in.
const ENABLE_RERANK = process.env.ENABLE_RERANK !== 'false';
const RERANK_TIMEOUT_MS = parseInt(process.env.RERANK_TIMEOUT_MS || '60000', 10);
// L2b — Retrieval coverage gate (CRAG-style). When the top reranked (or, if
// rerank is off, the top retrieved) chunk's relevance score is below threshold,
// the retrieval is treated as "insufficient": we surface a low-coverage hint so
// the LLM triggers its honest-refusal rule (L1 rule 2) instead of guessing. Env-
// tunable; disabled by setting RERANK_COVERAGE_GATE=false.
const RERANK_COVERAGE_GATE = process.env.RERANK_COVERAGE_GATE !== 'false';
const RERANK_COVERAGE_TOPN = parseInt(process.env.RERANK_COVERAGE_TOPN || '5', 10);
const RERANK_COVERAGE_THRESHOLD = parseFloat(
  process.env.RERANK_COVERAGE_THRESHOLD || '0.35');
// Rerank cost control: the single-threaded CPU cross-encoder takes ~1s per
// (query, snippet) pair at 1024-token max_length, so the payload size is the
// main latency lever. RERANK_CANDIDATES caps how many candidates get scored;
// RERANK_SNIPPET_CHARS caps each candidate's text. Both were reduced from the
// original 20 / 1200 after measuring 17-18s rerank on 20 pairs (~46% of total
// request time). Keep them env-tunable so operators can trade cost vs. the
// reranker seeing more of each chunk.
const RERANK_CANDIDATES = parseInt(process.env.RERANK_CANDIDATES || '16', 10);
const RERANK_SNIPPET_CHARS = parseInt(process.env.RERANK_SNIPPET_CHARS || '800', 10);

// ---- rate limiting (per client IP, in-memory) ----
const ASK_LIMIT = parseInt(process.env.RATE_LIMIT_ASK || '10', 10);      // /api/ask per window
const STATUS_LIMIT = parseInt(process.env.RATE_LIMIT_STATUS || '60', 10); // /api/status per window
const RATE_WINDOW_MS = 60 * 1000;
const rateBuckets = new Map();

// ---- multi-turn context (recency-decayed previous-turn results) ----
const MAX_PREV_TURNS = parseInt(process.env.MAX_PREV_TURNS || '3', 10);   // how many
// previous turns carry their retrieval results into the prompt
const PREV_DECAY = parseFloat(process.env.PREV_DECAY || '0.5');           // weight of
// turn n = PREV_DECAY^(n-1)  (1.0, 0.5, 0.25, ...)

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

// Whether a retrieved chunk comes from an authoritative doc source (spec /
// guide / tianocore-docs repo) rather than commit/PR noise. Module-level so it
// can be reused by both pruneByMetadata and the adaptive-rerank-skip check.
function isAuthoritativeDocs(r) {
  const src = String(r.source_display || r.source || r.repo || '').toLowerCase();
  const file = String(r.file || '').toLowerCase();
  if (/(edk2-commits|edk2-prs|commit_|pr_)/.test(file)) return false;
  return src.includes('tianocore-docs') || src.includes('tianocore-doc') ||
         src.includes('spec') || src.includes('guide') ||
         /^edk2-/.test(file);
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

// Query routing (doc 2a): turn the intent label into a retrieval/rerank
// strategy, not just a prompt hint. Three tiers:
//   simple   - short factual/enumerative, single concept -> small recall +
//              rerank skipped (fast path, ~hundreds of ms)
//   standard - default hybrid retrieval + adaptive rerank (current behavior)
//   complex  - comparison / multi-hop / reasoning -> wider recall + rerank
//              forced on (quality over latency)
// Conservative: only clearly-simple or clearly-complex queries leave the
// standard tier, so recall is never silently shrunk for ambiguous questions.
function routeQuery(question) {
  const q = String(question || '').trim();
  if (!q) return 'standard';

  // Complex: explicit comparison / multi-hop / reasoning signals.
  if (/(比较|区别|差异|对比|compare|difference|vs\.?| versus |各自|分别.*和|和.*分别|为什么|原理|工作机制|底层|根因|root\s*cause|如何.*实现)/i.test(q)) {
    return 'complex';
  }
  // Multiple sub-questions (>=2 question marks) imply multi-part reasoning.
  if ((q.match(/[?？]/g) || []).length >= 2) return 'complex';

  const cls = classifyQuestion(q);
  const short = q.length <= 22; // a single focused lookup

  // Simple factual / enumerative, short and without how-to/error framing.
  if (short && (cls === 'what' || cls === 'format' || cls === 'list' || cls === 'example')) {
    return 'simple';
  }
  // Short, an EDK2 identifier but no actionable verb -> direct lookup.
  if (short && cls !== 'howto' && cls !== 'error' && cls !== 'general') {
    return 'simple';
  }
  // Very short and dominated by a single EDK2 identifier (e.g. "PcdLib 是什么").
  const ids = (q.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) || []);
  if (short && ids.length <= 2 && cls !== 'howto' && cls !== 'error') {
    return 'simple';
  }
  return 'standard';
}

// Chit-chat / meta routing (doc 2b): questions that are NOT knowledge-base
// queries (greetings, thanks, "what can you do") bypass retrieval AND the LLM
// entirely and get a fixed, instant answer. Deliberately conservative: it only
// fires when the text is short AND contains no EDK2 technical signal, so a real
// question like "你好，PCD 是什么" still goes through the full pipeline.
const CHITCHAT_ANSWER =
  '我是 EDK2 / TianoCore 固件开发问答助手，基于本地知识库（EDK II 规范、编码标准、' +
  '贡献流程等）回答。请直接提出你的 EDK2 技术问题，例如：PCD 有哪些类型？INF 文件怎么写？' +
  '如何提交补丁？如何编写 UEFI 驱动？';

function isChitChat(question) {
  const q = String(question || '').trim().toLowerCase();
  if (q.length > 24) return false;
  // Any EDK2 technical term -> treat as a real question, never chit-chat.
  if (/[a-z]{2,}/.test(q) && /(edk|uefi|pcd|inf|dsc|dec|fdf|sm[mn]|driver|protocol|module|boot|dxe|pei|guid|build|commit|patch|spec|hii|tianocore|固件|编码|命名|规范|驱动|协议|模块|启动|提交|补丁)/.test(q)) {
    return false;
  }
  return /^(你好|您好|hi|hello|hey|嗨|在吗|在么|早上好|下午好|晚上好|谢谢|感谢|多谢|再见|拜拜|bye|你是谁|你是?什么|你叫什么|你能?做什么|你能?帮我|怎么用你|如何使用你|介绍下?你|介绍一下你)/i.test(q)
    || /^(谢谢|感谢|多谢|再见|拜拜)/i.test(q);
}

// Daemon results carry a numeric _pid that uniquely identifies a chunk even
// when url/file/title are all empty (common for tianocore-docs spec pages).
// Use it as a dedup fallback so multiple same-source spec chunks survive
// aggregation instead of all collapsing onto the empty-string key.
function chunkKey(r) {
  return r.url || r.file || r.title || r.section || (r._pid != null ? String(r._pid) : '') || '';
}

// Stable citation id for a retrieved chunk. Rerank can reorder the display
// while the LLM is already streaming, so the LLM must cite by an id that is
// independent of position: a short sha1 of the chunk identity. Deterministic
// across turns (the client sends the same identity fields back as prevResults).
function stableCid(r) {
  const base = chunkKey(r) || ('content:' + String(r.content || r.snippet || '').slice(0, 200));
  return 'c' + crypto.createHash('sha1').update(base).digest('hex').slice(0, 8);
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

function sanitizePrevResults(raw) {
  // Client-supplied previous-turn results: whitelist string fields only so a
  // compromised/malformed payload can never inject objects into the prompt.
  // Two accepted shapes:
  //   1) multi-turn:  [{ turn: 1, results: [result, ...] }, { turn: 2, ... }]
  //   2) legacy flat: [result, result, ...]  (treated as the single most
  //                    recent turn, turn = 1)
  if (!Array.isArray(raw)) return [];
  const isMultiTurn = raw.length > 0 && raw.every((x) =>
    x && typeof x === 'object' && Array.isArray(x.results));
  if (!isMultiTurn) {
    const items = sanitizeResultList(raw);
    return items.length ? [{ turn: 1, results: items }] : [];
  }
  const out = [];
  for (const t of raw.slice(0, MAX_PREV_TURNS)) {
    if (!t || typeof t !== 'object' || !Array.isArray(t.results)) continue;
    const turn = Number.isFinite(t.turn) ? Math.max(1, Math.floor(t.turn)) : 1;
    const items = sanitizeResultList(t.results);
    if (items.length) out.push({ turn, results: items });
  }
  return out;
}

function sanitizeResultList(raw) {
  const out = [];
  for (const r of raw.slice(0, 10)) {
    if (!r || typeof r !== 'object') continue;
    const item = {};
    for (const k of ['source', 'source_display', 'title', 'url', 'file', 'section', 'type', 'cid']) {
      if (typeof r[k] === 'string') item[k] = r[k].slice(0, 500);
    }
    const content = typeof r.content === 'string' ? r.content : (typeof r.snippet === 'string' ? r.snippet : '');
    if (content) item.content = content.slice(0, 8000);
    if (!item.title && !item.file && !item.content) continue;
    out.push(item);
  }
  return out;
}

// L2b — Retrieval coverage estimate (CRAG-style). Uses the top reranked score
// when rerank ran, otherwise the retrieval score. Returns whether the top
// evidence is too weakly relevant to answer confidently.
function retrievalCoverage(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return { maxScore: 0, low: RERANK_COVERAGE_GATE };
  }
  const top = results.slice(0, RERANK_COVERAGE_TOPN);
  let maxScore = 0;
  for (const r of top) {
    const s = (typeof r.rerank_score === 'number') ? r.rerank_score : (r.score || 0);
    if (s > maxScore) maxScore = s;
  }
  return { maxScore, low: RERANK_COVERAGE_GATE && maxScore < RERANK_COVERAGE_THRESHOLD };
}

// L2c — Citation verification (structural, model cannot bypass). Every
// `[cXXXXXXXX]` used in the answer must exist in this turn's retrieval set.
// Returns the fabricated/unknown ids so the caller can flag them.
function validateCitations(answer, results) {
  const valid = new Set(
    (results || []).map(r => String(r.cid || '').toLowerCase()).filter(Boolean));
  const used = new Set();
  const re = /\[c([0-9a-f]{8})\]/gi;
  let m;
  while ((m = re.exec(answer || '')) !== null) used.add('c' + m[1].toLowerCase());
  const invalid = [...used].filter(c => !valid.has(c));
  return { invalid, used: [...used] };
}

// Strip reasoning/thinking artifacts that some models leak into the answer
// stream (e.g. DeepSeek's `reasoning_content` or `<no_analysis>` / `<think>`
// markers). The final answer must contain ONLY the user-facing response.
function stripReasoning(text) {
  if (!text) return text;
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .replace(/<no_analysis>/gi, '')
    .replace(/<noanalysis>/gi, '')
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, '');
}

function buildMessages(question, results, history, prevResults, opts = {}) {
  const ctx = aggregateContextEnhanced(results);
  // prevResults is now a multi-turn list: [{ turn, results }]. Each previous
  // turn's entries are deduplicated against the current ones AND against every
  // closer turn, so the same chunk is never presented twice and no turn can
  // hoard the budget.
  const seenKeys = new Set(ctx.map(r => chunkKey(r)));
  const prevTurns = (prevResults || []).slice()
    .sort((a, b) => (a.turn || 1) - (b.turn || 1)); // closest turn first
  const prevEntries = [];
  for (const t of prevTurns) {
    const turn = Math.max(1, Math.floor(t.turn || 1));
    const entries = aggregateContextEnhanced(t.results || []);
    for (const p of entries) {
      const key = chunkKey(p);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      prevEntries.push({ ...p, prev: true, prevTurn: turn });
    }
  }

  // Cap the total context budget: PDF dumps and 6000-char spec chunks can
  // otherwise push the prompt past the model context window, which makes the
  // flash model return an empty stream. Current-turn entries win the budget;
  // previous turns share the remainder weighted by recency (turn 1 = closest,
  // weight PREV_DECAY^(turn-1)), so the most recent turn's retrieved material
  // is always the most represented and older turns fade out.
  const MAX_CTX_CHARS = opts.maxCtxChars || 12000;
  const CUR_BUDGET = prevEntries.length ? Math.round(MAX_CTX_CHARS * 0.7) : MAX_CTX_CHARS;
  let ctxChars = 0;
  const ctxCapped = [];
  for (const r of ctx) {
    const entryChars = 40 + (r.title || '').length + (r.section || '').length + (r.body || '').length;
    if (ctxChars + entryChars > CUR_BUDGET && ctxCapped.length > 0) break;
    ctxCapped.push(r);
    ctxChars += entryChars;
  }
  // Previous turns: group by distance, allocate each turn a share of the
  // remaining budget proportional to its decayed weight.
  const prevBudget = MAX_CTX_CHARS - ctxChars;
  const byTurn = new Map();
  for (const r of prevEntries) {
    if (!byTurn.has(r.prevTurn)) byTurn.set(r.prevTurn, []);
    byTurn.get(r.prevTurn).push(r);
  }
  const turns = [...byTurn.keys()].sort((a, b) => a - b);
  const weightSum = turns.reduce((s, n) => s + Math.pow(PREV_DECAY, n - 1), 0);
  for (const n of turns) {
    const share = Math.round(prevBudget * (Math.pow(PREV_DECAY, n - 1) / weightSum));
    let used = 0;
    for (const r of byTurn.get(n)) {
      const entryChars = 40 + (r.title || '').length + (r.section || '').length + (r.body || '').length;
      if (used + entryChars > share && used > 0) break;
      ctxCapped.push(r);
      ctxChars += entryChars;
      used += entryChars;
    }
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
  
  const context = ctxCapped.map((r) => {
    const ref = localRef(r);
    const tag = r.prev
      ? (r.prevTurn === 1 ? '[上一轮检索] ' : '[前' + r.prevTurn + '轮检索] ')
      : '';
    const cid = r.cid || stableCid(r);
    return (
      `[${cid}] ${tag}${r.title}\n` +
      (r.type ? `Type: ${r.type}\n` : '') +
      (r.source ? `Source: ${r.source}\n` : '') +
      (ref ? `Local: ${ref}\n` : '') +
      (r.section ? `Section: ${r.section}\n` : '') +
      `Content:\n${r.body}\n`
    );
  }).join('\n');

  const system = [
    // PREFIX-CACHE INVARIANT (DeepSeek Context Caching on Disk, automatic):
    // The content below the intent guidance is large and constant; it is kept
    // FIRST so it forms a stable prompt prefix reused across every request
    // (~thousands of tokens => cache hits). Do NOT insert per-request variable
    // content here. The variable RAG context + question go last (user message).
    'You are an EDK2/TianoCore firmware development expert. Answer strictly from the retrieved EDK2/TianoCore context provided below.',
    intentGuidance,
    '',
    '# 核心原则',
    '- 只依据下方【检索上下文】作答；上下文没有的信息不得断言，也不要用自身记忆补全。',
    '- 每条事实陈述后都标注其来源稳定编号 [cXXXXXXXX]（条目开头即是）。只允许引用真实存在的编号，禁止编造或用 [1][2] 这类位置序号。',
    '- 上下文不足以回答时，明确写"根据当前资料无法确认 XXX"，并说明还缺哪类信息；禁止猜测、补全、给"可能/大概"式虚构。',
    '- 不同上下文相互矛盾时，分别列出各方观点与出处（带编号），不要自行捏合出折中答案。',
    '- 依据薄弱时用"（依据较弱）"标注，不伪装成确定结论。',
    '',
    '# 输出纪律（必须遵守）',
    '- 直接输出最终回答，第一句就进入正题。禁止输出任何"过程性 / 元叙述"内容：不要写"分析上下文""回答结构""输出语言""开始撰写""现在撰写""以下是完整答复"等说明你将如何作答的话，也不要复述用户的问题，不要写"好的""当然"之类客套开场。',
    '- 若回答被截断需要续写，从中断处直接续写正文，不要加"现在撰写""接上次未完成部分"等任何前缀或说明。',
    '',
    '# 怎样才算"有价值、可参考"的回答',
    '- 直接回答用户问题，不要客套铺垫、不要自我重复。',
    '- 覆盖度优先：在切题前提下，把上下文里与问题相关的依据**讲全**——相关的枚举值 / 字段 / 参数要逐一列出并标注 [cXXXX]；不要为了简短而省略对工程师有用的关键细节。',
    '- 配置 / 规范 / PCD / INF / DEC / DSC 类：给出关键字段与约束，并附**最小可参考的片段或真实写法**（如 DEC/DSC/INF 的 section 写法、C 代码中的访问宏），让工程师能照着落地。',
    '- 故障 / 报错类：先描述可复现现象（只描述现象，不虚构报错码），再给按可能性排序的根因排查清单与可观测手段（build log / map / UEFI Shell / SCT 等）。',
    '- 概念 / 机制类：先用一句话点出本质，再画清关系模型（从属、数据流、调用关系），必要时列关键步骤。',
    '- 有规范原文 shall/must 依据的结论标【强制要求】；社区经验或推导结论标【最佳实践】，并注明"由多条文档综合推导，原文无直接表述"。',
    '- 语言紧凑、不注水：用最少的废话把事情说清楚，但信息密度要高——该列的全列、该给片段的给片段，不堆砌与问题无关的内容。',
    '',
    '# 引用与参考来源',
    '每个上下文条目开头为稳定编号 [cXXXXXXXX]（小写 c + 8 位十六进制）。在相关论断后附对应编号，例如：`PcdDebugPrintErrorLevel 控制调试输出级别[c1a2b3c4]`。',
    '回答末尾必须附 `## 参考来源`，逐条列出用到的文档：`- 文档标题 - 章节（本地：文件路径 > 章节）`，从条目里的 `Local:` 行取定位。只写本地定位，禁止拼造网址。',
    '',
    '# 多轮衔接',
    '标记为【上一轮检索】的条目用于衔接上一轮；用户用代词追问时优先引用这些条目，仍用稳定编号。不要编造上一轮检索中没有的内容。',
    '',
    '# 示例（示范深度与引用写法）',
    '问：PCD 有哪几种类型，分别在 DEC / DSC / INF 与 C 代码里怎么写？',
    '答：EDK2 的 PCD 有 5 种类型[c1a2b3c4]：FixedPcd（FIXED_AT_BUILD）、PatchPcd（PATCHABLE_IN_MODULE）、FeaturePcd（FEATURE_FLAG）、DynamicPcd（DYNAMIC）、DynamicExPcd（DYNAMIC_EX）[c1a2b3c4]。',
    '**DEC（声明）**：在 [PcdsFixedAtBuild]/[PcdsDynamic]/[PcdsDynamicEx]/[PcdsFeatureFlag]/[PcdsPatchableInModule] 中声明，格式 `TokenSpaceGuid.PcdCName|默认值|数据类型|Token`[c1a2b3c4]。',
    '**DSC（平台赋值）**：在对应 section 中赋值，如 `[PcdsFixedAtBuild] gEfiMdePkgTokenSpaceGuid.PcdDebugPrintErrorLevel|0x80000000`[c1a2b3c4]。',
    '**INF（模块引用）**：在 [PcdsXxx] section 写 `TokenSpaceGuid.PcdCName`；一个 PCD 只能属于一种类型，INF 中不得混用 section 类型[c1a2b3c4]。',
    '**C 代码（访问）**：`FixedPcdGet32(PcdX)`、`PatchPcdGet32(PcdX)`、`FeaturePcdGet(PcdX)`、`PcdGet32(PcdX)`、`PcdExGet32(PcdX)`；不同类型用不同宏，混用会报错[c1a2b3c4]。',
    '## 参考来源',
    '- EDK II Platform Configuration Database (PCD) - PCD Types（本地：… > PCD Types）',
    '（示例中的 [c1a2b3c4] 为占位，实际必须用上下文里真实存在的编号。）',
  ].join('\n');

  const messages = [{ role: 'system', content: system }];
  for (const h of (history || [])) {
    if (h && h.role && h.content) {
      messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content).slice(0, 4000) });
    }
  }
  let userContent = `RAG 参考上下文：\n${context}\n\n原始问题：${question}`;
  // L2b: when retrieval relevance is low, nudge the model toward its honest-
  // refusal rule instead of guessing (L1 rule 2). Kept out of the system prompt
  // so it only fires on weak-retrieval turns and preserves the stable prefix cache.
  if (opts.lowCoverage) {
    userContent += '\n\n（注意：本次检索到的资料相关度偏低，若上方上下文不足以回答，请严格按证据约束诚实说明"根据当前资料无法确认 XXX"并指明缺哪类信息，禁止猜测或补全。）';
  }
  messages.push({ role: 'user', content: userContent });
  messages.prevCount = ctxCapped.filter(r => r.prev).length;
  messages.ctxCount = ctxCapped.length;
  messages.ctxChars = ctxChars;
  messages.systemChars = system.length;
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
function llmStream(messages, { onDelta, timeoutMs = LLM_STREAM_TIMEOUT_MS, maxTokens = LLM_MAX_TOKENS, firstTokenMs = 0, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const { apiKey, baseUrl, model } = llmConfig();
    if (!apiKey || !baseUrl || !model) {
      reject(new Error('LLM not configured. Set LLM_API_KEY / LLM_BASE_URL / LLM_MODEL.'));
      return;
    }
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const u = new URL(url);
    // stream_options.include_usage lets us observe DeepSeek's automatic prefix
    // cache (prompt_cache_hit_tokens) so we can confirm the stable system
    // prompt prefix is actually being reused across requests.
    const payload = {
      model, messages, temperature: 0, stream: true, max_tokens: maxTokens,
      // Disable the model's private chain-of-thought ("reasoning_content") so it
      // answers directly in `content`. Reasoning models otherwise stream their
      // planning ("分析上下文/开始撰写/…") to the user. `none` keeps factual,
      // cited RAG answers short and on-point.
      reasoning_effort: 'none',
      stream_options: { include_usage: true },
    };

    const protocol = u.protocol === 'https:' ? https : http;
    // The socket `timeout` option does NOT fire while the upstream sits in
    // prefill (it may keep the connection idle and never send a byte until
    // the first token). A separate first-token deadline aborts such hung
    // prefill so a single attempt cannot burn the whole generation budget.
    let firstTokenTimer = null;
    const clearFirstToken = () => {
      if (firstTokenTimer) { clearTimeout(firstTokenTimer); firstTokenTimer = null; }
    };
    const _t0 = Date.now();
    let _firstToken = true;
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
      agent: false,
      ...(signal ? { signal } : {}),
    }, (res) => {
      console.error(`[LLMDBG] response status=${res.statusCode} after ${Date.now() - _t0}ms`);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => reject(new Error(`LLM API error ${res.statusCode}: ${data.substring(0, 500)}`)));
        return;
      }
        let buf = '';
        let rawChunks = [];
        let finishReason = null;
        let usage = null;
        res.setEncoding('utf8');
        let _firstChunk = true;
        res.on('data', (chunk) => {
          if (_firstChunk) { _firstChunk = false; console.error(`[LLMDBG] first data chunk after ${Date.now() - _t0}ms`); }
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
              const choice = j.choices && j.choices[0];
              if (choice) {
                // Capture finish_reason from the final chunk
                if (choice.finish_reason) {
                  finishReason = choice.finish_reason;
                }
                const delta = choice.delta;
                // Use `content` as the answer. Some reasoning models stream the
                // final answer in `reasoning_content` while `content` is empty; in
                // that case fall back to `reasoning_content` but strip thinking
                // markers so the model's private planning ("分析上下文/开始撰写…")
                // never reaches the user.
                const piece = delta && (delta.content || delta.reasoning_content);
                if (piece) {
                  if (_firstToken) { _firstToken = false; console.error(`[LLMDBG] first content token after ${Date.now() - _t0}ms`); }
                  clearFirstToken();
                  onDelta(stripReasoning(piece));
                }
              }
              // DeepSeek returns cumulative token usage (incl. prefix-cache
              // hits) on the final streamed chunk when include_usage is set.
              if (j.usage) usage = j.usage;
            } catch { /* ignore malformed chunk */ }
          }
        });
        res.on('end', () => {
          clearFirstToken();
          resolve({ finishReason, usage });
        });
      res.on('error', (e) => { clearFirstToken(); reject(e); });
    });
    req.on('error', (e) => { clearFirstToken(); reject(e); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (firstTokenMs > 0) {
      firstTokenTimer = setTimeout(() => {
        req.destroy(new Error(`LLM no first token within ${firstTokenMs}ms`));
      }, firstTokenMs);
    }
    console.error(`[LLMDBG] SEND ${url} payloadChars=${JSON.stringify(payload).length}`);
    req.write(JSON.stringify(payload));
    req.end();
  });
}

// Non-streaming single LLM completion. Used to translate a Chinese question
// into an English retrieval query (cross-lingual vector recall is weak, so a
// faithful English query ranks the authoritative spec chapters far better),
// and as a final non-streaming fallback when the streaming answer path keeps
// returning empty streams. Falls back to the input text on any failure so
// search never breaks.
async function llmComplete(messages, { timeoutMs = 60000, maxTokens = 300, signal = null } = {}) {
  const _t0 = Date.now();
  console.error(`[LCMPLDBG] start timeout=${timeoutMs} msgs=${messages.length}`);
  return new Promise((resolve) => {
    const { apiKey, baseUrl, model } = llmConfig();
    if (!apiKey || !baseUrl || !model) return resolve('');
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const u = new URL(url);
    const payload = { model, messages, temperature: 0, max_tokens: maxTokens, reasoning_effort: 'none' };
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
      ...(signal ? { signal } : {}),
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) { console.error(`[LCMPLDBG] end status=${res.statusCode} after ${Date.now() - _t0}ms`); return resolve(''); }
         try {
           const j = JSON.parse(data);
           const msg = j.choices && j.choices[0] && j.choices[0].message;
            // Prefer `content`; fall back to `reasoning_content` (thinking stripped
            // by stripReasoning) for reasoning models that answer there.
            const text = (msg && (msg.content || msg.reasoning_content)) || '';
           console.error(`[LCMPLDBG] end OK after ${Date.now() - _t0}ms chars=${typeof text === 'string' ? text.length : 0}`);
            resolve(typeof text === 'string' ? stripReasoning(text).trim() : '');
         } catch { console.error(`[LCMPLDBG] end parse-fail after ${Date.now() - _t0}ms`); resolve(''); }
      });
    });
    req.on('error', () => { console.error(`[LCMPLDBG] error after ${Date.now() - _t0}ms`); resolve(''); });
    req.on('timeout', () => { console.error(`[LCMPLDBG] TIMEOUT after ${Date.now() - _t0}ms`); req.destroy(); resolve(''); });
    req.write(JSON.stringify(payload));
    req.end();
  });
}

// Race a streaming call against a non-streaming call for the SAME prompt.
//
// Streaming gives the best UX (tokens arrive live). The non-streaming path is a
// reliable safety net for the upstream's intermittent "empty stream" failure
// mode: it returns HTTP 200 + a finish_reason with ZERO deltas, which otherwise
// burns the whole first-token budget and triggers the multi-call retry /
// continuation storm (observed: a single question taking 130s instead of ~30s).
//
// Strategy (grace timer):
//   * Start the streaming call immediately (best UX, and the common path).
//   * If the stream emits its first token within FIRST_TOKEN_GRACE_MS, it is
//     healthy -> cancel any pending non-streaming call and use the stream.
//   * If no first token arrives within the grace window (the stream is almost
//     certainly in the broken mode, since a healthy prefill yields a token in
//     ~1-2s), start the non-streaming call. When it returns content we use it
//     (~2s) and abort the dead stream.
// This keeps a healthy request on pure streaming (no extra cost, no false
// fallback) while rescuing the broken mode in ~grace+2s instead of ~27s.
async function raceLlmOnce(messages, { onDelta, timeoutMs, firstTokenMs, maxTokens, signal, firstTokenGraceMs = 6000 } = {}) {
  return new Promise((resolveRace) => {
    let streamText = '';
    let streamFirstToken = false;
    let streamUsage = null;
    let done = false;
    let completeController = null;
    let completeText = '';
    const finish = (result) => { if (!done) { done = true; resolveRace(result); } };

    const startComplete = () => {
      if (completeController || done) return;
      completeController = new AbortController();
      llmComplete(messages, {
        timeoutMs: Math.min(timeoutMs, 60000), maxTokens,
        signal: completeController.signal,
      }).then((t) => {
        completeText = (t || '').toString();
        if (completeText.length > 0 && !streamFirstToken && !done) {
          if (signal) try { signal.abort(); } catch { /* stop dead stream */ }
          onDelta(completeText); // deliver as a single delta
          finish({ text: completeText, usage: null, via: 'complete', finishReason: 'stop' });
        }
      }).catch(() => { /* ignore, fall back to stream result */ });
    };

    const graceTimer = setTimeout(() => {
      if (!streamFirstToken && !done) startComplete();
    }, firstTokenGraceMs);

    const cancelComplete = () => {
      if (completeController) { try { completeController.abort(); } catch { /* noop */ } completeController = null; }
    };

    llmStream(messages, {
      onDelta: (t) => {
        if (!streamFirstToken) {
          streamFirstToken = true;
          clearTimeout(graceTimer);
          cancelComplete(); // healthy: drop the non-streaming safety net
        }
        streamText += t;
        onDelta(t);
      },
      timeoutMs, firstTokenMs, maxTokens, signal,
    }).then((r) => {
      clearTimeout(graceTimer);
      cancelComplete();
      finish({ text: streamText, usage: r.usage, via: 'stream', finishReason: r.finishReason });
    }).catch((e) => {
      clearTimeout(graceTimer);
      // Stream failed outright: use the non-streaming result if we have one,
      // else start it now and wait briefly for it.
      if (completeText.length > 0) {
        if (signal) try { signal.abort(); } catch { /* noop */ }
        finish({ text: completeText, usage: null, via: 'complete', finishReason: 'stop' });
        return;
      }
      startComplete();
      const waitStart = Date.now();
      const wait = setInterval(() => {
        if (completeText.length > 0 || Date.now() - waitStart > 60000) {
          clearInterval(wait);
          if (signal) try { signal.abort(); } catch { /* noop */ }
          if (completeText.length > 0) finish({ text: completeText, usage: null, via: 'complete', finishReason: 'stop' });
          else finish({ text: streamText, usage: null, via: 'stream', finishReason: 'error', error: e.message });
        }
      }, 200);
    });
  });
}

// Cache for question -> English translation (LRU, 200 entries, 30 min TTL).
const translationCache = new Map();
const TRANSLATION_TTL_MS = 30 * 60 * 1000;

async function translateToEnglish(question) {
  const key = normalizeQuery(question);
  const hit = translationCache.get(key);
  if (hit && (Date.now() - hit.timestamp) < TRANSLATION_TTL_MS) return hit.text;
  // The corpus is English-only: a question that is already pure ASCII (English
  // phrasing, EDK2 identifiers, error codes) is used verbatim, skipping a full
  // LLM round-trip (~2s) that would only rephrase it.
  if (/^[\x00-\x7F\s]+$/.test(question) && /[a-zA-Z]{3,}/.test(question)) {
    translationCache.set(key, { text: question, timestamp: Date.now() });
    return question;
  }
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

async function llmAnswer(question, results, history, prevResults) {
  const { apiKey, baseUrl, model } = llmConfig();
  if (!apiKey || !baseUrl || !model) {
    return { error: 'LLM not configured. Set LLM_API_KEY / LLM_BASE_URL / LLM_MODEL.' };
  }
  const messages = buildMessages(question, results, history, prevResults);

  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const resp = await httpJson(url, {
    method: 'POST',
    payload: { model, messages, temperature: 0, reasoning_effort: 'none' },
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
  const msg = resp.body && resp.body.choices && resp.body.choices[0] && resp.body.choices[0].message;
  // Prefer `content`; fall back to `reasoning_content` (thinking stripped).
  const content = msg ? (msg.content || msg.reasoning_content) : '';
  return { answer: stripReasoning(content), model };
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
      const prevResults = sanitizePrevResults(parsed.prevResults);
      if (!question) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing question' }));
        finishTotal('error', { error: 'missing_question' });
        return;
      }
      qh = queryHash(question);
      emitTrace({ traceId, stage: 'http_start', durationMs: 0, queryHash: qh, status: 'start' });

      // Answer-cache short-circuit: a repeated (self-contained) question skips
      // the daemon, search, rerank AND the LLM entirely — replayed as SSE.
      const model = llmConfig().model;
      const fresh = parsed.fresh === true;
      // Query routing (doc 2a): decide the retrieval/rerank strategy up front.
      const tier = routeQuery(question);
      emitTrace({ traceId, stage: 'route', durationMs: 0, queryHash: qh, status: 'ok', tier });

      // Chit-chat / meta routing (doc 2b): greetings, thanks, "what can you do"
      // bypass retrieval + the LLM entirely with a fixed instant answer.
      if (!fresh && isChitChat(question)) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const ccStart = Date.now();
        sendSSE(res, 'phase', { step: 'llm', text: '正在回复…', progress: 60, model });
        sendSSE(res, 'delta', { text: CHITCHAT_ANSWER });
        sendSSE(res, 'phase', { step: 'llm_done', text: '回答完成', progress: 100, model });
        sendSSE(res, 'done', { model });
        res.end();
        emitTrace({
          traceId, stage: 'chitchat', durationMs: Date.now() - ccStart,
          queryHash: qh, status: 'ok',
        });
        finishTotal('ok', { chitchat: true });
        return;
      }

      const exactAnswer = !fresh ? getCachedAnswer(question, model) : null;
      if (exactAnswer) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const cacheStart = Date.now();
        replayCachedAnswer(res, exactAnswer, false);
        res.end();
        emitTrace({
          traceId, stage: 'answer_cache', durationMs: Date.now() - cacheStart,
          queryHash: qh, status: 'ok', hit: true, hits: exactAnswer.hitCount,
        });
        finishTotal('ok', { tokens: exactAnswer.tokens || 0, from_cache: true, answer_cache: true });
        return;
      }

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

      // Semantic (paraphrase) cache: only reached on an exact miss. Embedding
      // the incoming query and comparing against stored embeddings is ~tens of
      // ms and lets near-synonym questions reuse a prior generation.
      if (!fresh && SEMANTIC_CACHE) {
        const semHit = await getSemanticCachedAnswer(question, model, url);
        if (semHit) {
          const cacheStart = Date.now();
          replayCachedAnswer(res, semHit.cached, true);
          res.end();
          emitTrace({
            traceId, stage: 'answer_cache', durationMs: Date.now() - cacheStart,
            queryHash: qh, status: 'ok', hit: true, semantic: true,
            similarity: Number(semHit.similarity.toFixed(4)),
            hits: semHit.cached.hitCount,
          });
          finishTotal('ok', {
            tokens: semHit.cached.tokens || 0, from_cache: true,
            answer_cache: true, semantic: true,
          });
          return;
        }
      }
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
          // "formatting/whitespace"), while the keyword-expansion terms keep
          // precise EDK2 anchors (LNK2001, error 4000, PCD...) that pure
          // translation dilutes. Merge, dedup, cap length.
          //
          // Non-ASCII (CJK) tokens are dropped from the tail: the corpus is
          // English-only, so they add no recall AND push the daemon search into
          // a ~3x slower path (verified: same query 1488ms with CJK vs 416ms
          // English-only on the docs source). The English translation + anchors
          // preserve top-20 recall (15-18/20 overlap in probes).
          const translatedQ = (translated && translated !== question) ? translated : '';
          const expanded = expandChineseQuery(question);
          const seen = new Set(translatedQ.toLowerCase().split(/\s+/).filter(Boolean));
          const tail = expanded.split(/\s+/).filter(t => {
            const l = t.toLowerCase();
            if (seen.has(l)) return false;
            if (/[^\x00-\x7F]/.test(t)) return false;
            seen.add(l);
            return true;
          });
          const engQuery = [translatedQ, tail.join(' ')].filter(Boolean).join(' ').slice(0, 300);
          // Main search: if nothing English is available (translation failed and
          // no expansion rule matched), fall back to the raw question so the
          // search still runs. Docs search: English-only; skipped when empty.
          const searchQuery = engQuery || question;
          const docsQuery = engQuery || null;
          // Parallel dual-source retrieval. The knowledge base is dominated by
          // tianocore/edk2 commit records (36k+ chunks): for build/error/commit
          // topics their "Fix ... build error" subjects outrank the real spec
          // docs, so the target chapter (e.g. ModuleWriteGuide 3.7.7) can fall
          // out of top_k. Run a second query restricted to the authoritative
          // tianocore-docs source and merge it back in below.
          const searchStart = Date.now();
          // Routing (2a): shrink recall for simple factual queries (fast path),
          // widen it for complex multi-hop/comparison queries (quality).
          const mainTopK = tier === 'simple' ? 12 : tier === 'complex' ? 22 : 18;
          const mainPromise = httpJson(`${url}/search?query=${encodeURIComponent(searchQuery)}&top_k=${mainTopK}`, { timeoutMs: 120000, headers: { 'X-Trace-Id': traceId } });
          // Daemon clamps top_k to 20 and cross-lingual vector recall is weak:
          // a vague Chinese query ("排版/空白") ranks many unrelated Summary/
          // README chunks above the actual CCoding spec chapters. For coding-
          // style topics fire two focused English docs queries (chapter locator
          // + concrete rule phrases) so 5.2.1/5.2.2/5.2.3 sub-chunks survive.
          // Test the ORIGINAL question + translation + expansion (not just the
          // CJK-free searchQuery) so Chinese style triggers still fire.
          const isStyleTopic = /spacing|formatting|indentation|排版|空白|缩进|风格|style|vertical|horizontal|coding.?standard|编码规范/i.test([question, translatedQ, expanded].join(' '));
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
          const docsPromise = docsQuery
            ? httpJson(`${url}/search?query=${encodeURIComponent(docsQuery)}&top_k=20&source=tianocore-docs`, { timeoutMs: 120000, headers: { 'X-Trace-Id': traceId } })
              .catch(() => null)
            : Promise.resolve(null);
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
        
        // Assign every result a stable citation id (sha1 of the chunk identity)
        // BEFORE any parallel rerank can reorder things, so the LLM cites by an
        // id that stays valid regardless of display order.
        for (const r of results) { r.cid = r.cid || stableCid(r); }
        
        // 1.5) Rerank results using BGE-reranker. Use a HYBRID approach:
        // GUARANTEE top 3 from vector search survive (the reranker often
        // demotes key chunks like "4.4 Hungarian Prefixes" from #1 to #8).
        // Then fill remaining slots from rerank order.
        //
        // Runs IN PARALLEL with the LLM stream (fire-and-forget): the LLM
        // context uses the fused retrieval order with stable [cid] markers, so
        // the first token is no longer blocked by the ~6-9s CPU rerank. When
        // rerank finishes, a second results event reorders the on-screen source
        // list; citations stay correct because they key on stable cids, not
        // positions. Disable via ENABLE_RERANK=false.
        if (results.length > 10 && !ENABLE_RERANK) {
          emitTrace({
            traceId, stage: 'rerank', durationMs: 0, queryHash: qh,
            status: 'skipped', reason: 'ENABLE_RERANK=false',
          });
        } else if (results.length > 10 && tier === 'simple') {
          // Routing (2a): simple factual queries use a small recall and skip the
          // cross-encoder entirely — the LLM context already uses the fused
          // order, so rerank would only cost CPU to reorder the source panel.
          emitTrace({
            traceId, stage: 'rerank', durationMs: 0, queryHash: qh,
            status: 'skipped', reason: 'simple_tier',
          });
        } else if (results.length > 10 && ENABLE_RERANK && tier !== 'complex' && shouldSkipRerank(question, results)) {
          // Adaptive skip (1a): retrieval already pinned an authoritative #1
          // chunk strongly matching the query, so the cross-encoder rerank
          // would only reorder the source panel — the LLM context uses the
          // fused order either way. Save the CPU and keep the fused ordering.
          emitTrace({
            traceId, stage: 'rerank', durationMs: 0, queryHash: qh,
            status: 'skipped', reason: 'adaptive_confidence',
          });
        } else if (results.length > 10 && ENABLE_RERANK) {
          sendSSE(res, 'phase', { step: 'rerank', text: '后台重排序文档…', progress: 25 });
          const rerankStart = Date.now();
          const doRerank = (async () => {
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
            const reranked = await rerankDocuments(rerankQuery, results.slice(0, RERANK_CANDIDATES));
            
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
                r.cid = r.cid || stableCid(r);
                merged.push(r);
              }
            }
            return merged;
          })();
          doRerank.then((merged) => {
            emitTrace({
              traceId, stage: 'rerank', durationMs: Date.now() - rerankStart,
              queryHash: qh, status: 'ok', docs: results.length,
            });
            if (!res.writableEnded && merged && merged.length) {
              sendSSE(res, 'results', { results: merged.slice(0, 15), daemon: url, from_cache: false, reranked: true });
            }
          }).catch((e) => {
            emitTrace({
              traceId, stage: 'rerank', durationMs: Date.now() - rerankStart,
              queryHash: qh, status: 'error', error: e.message,
            });
            // Continue with the fused order already streamed to the client.
          });
        } else if (results.length > 10 && !ENABLE_RERANK) {
          emitTrace({
            traceId, stage: 'rerank', durationMs: 0, queryHash: qh,
            status: 'skipped', reason: 'ENABLE_RERANK=false',
          });
        }
        
        // Cache the results
        setCachedContext(question, results);
        sendSSE(res, 'phase', { step: 'cache_stored', text: '结果已缓存', progress: 30 });
      }
      // Both cache-hit and fresh paths converge here. Ensure a stable cid for
      // every result so the on-screen [cid] anchors always resolve.
      for (const r of results) { r.cid = r.cid || stableCid(r); }
      sendSSE(res, 'results', { results: results.slice(0, 15), daemon: url, from_cache: fromCache });

      // L2b — Retrieval coverage gate. If the top evidence is too weakly
      // relevant, surface a hint so the LLM honestly declines instead of
      // hallucinating (L1 rule 2). Pure-code, no extra retrieval unless L2b's
      // query-rewrite extension is later added.
      const coverage = retrievalCoverage(results);
      if (coverage.low) {
        sendSSE(res, 'phase', { step: 'low_coverage', text: '检索相关度偏低，将如实说明', progress: 35 });
        emitTrace({
          traceId, stage: 'coverage', durationMs: 0, queryHash: qh,
          status: 'low', maxScore: coverage.maxScore, threshold: RERANK_COVERAGE_THRESHOLD,
        });
      }

      // 2) stream LLM answer
      sendSSE(res, 'phase', { step: 'llm_init', text: '初始化LLM…', progress: 40 });
      const { apiKey, baseUrl } = llmConfig();
      if (!apiKey || !baseUrl || !model) {
        sendSSE(res, 'error', { error: 'LLM not configured. Set LLM_API_KEY / LLM_BASE_URL / LLM_MODEL.' });
        res.end();
        finishTotal('error', { error: 'llm_not_configured' });
        return;
      }
      sendSSE(res, 'phase', { step: 'llm_build', text: '构建提示词…', progress: 50, model });
      
      const messages = buildMessages(question, results, history, prevResults, { lowCoverage: coverage.low });
      const inputChars = messages.reduce(
        (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0);
      emitTrace({
        traceId, stage: 'llm_prompt', durationMs: 0, queryHash: qh,
        inputChars, systemChars: messages.systemChars,
        ctxChars: messages.ctxChars, ctxCount: messages.ctxCount,
      });
      emitTrace({
        traceId, stage: 'prev_context', durationMs: 0, queryHash: qh,
        hasPrev: prevResults.length, prevCount: messages.prevCount || 0,
      });
      sendSSE(res, 'phase', { step: 'llm', text: '正在生成回答…', progress: 60, model });
      
      const llmStart = Date.now();
      let tokenCount = 0;
      let fullAnswer = '';
      let firstTokenAt = null;
      let lastUsage = null; // DeepSeek prefix-cache usage from the winning stream
      try {
        // The upstream LLM intermittently returns an empty stream (200 + [DONE]
        // with zero deltas) or drops the connection before any content. Retry
        // only while nothing has been streamed yet, so a partially-rendered
        // answer is never duplicated to the client. Later attempts use a
        // progressively smaller max_tokens budget so a flaky upstream still
        // yields SOME bounded answer instead of failing the whole request.
        // The whole retry loop is additionally capped by LLM_TOTAL_BUDGET_MS so
        // an upstream that streams empty responses until its timeout cannot
        // blow a single query up to 3 attempts x LLM_STREAM_TIMEOUT_MS.
        const attemptCaps = [
          LLM_MAX_TOKENS,
          LLM_RETRY_MAX_TOKENS,
          Math.min(LLM_RETRY_MAX_TOKENS, 1500),
        ];
        // On empty retries the RAG context budget is progressively shrunk as
        // well: a very large input makes prefill slow AND correlates with the
        // upstream's empty-stream failures, so later attempts retry with a
        // tighter context that prefills faster and is far more likely to
        // actually yield content (a shorter answer beats a hard error).
        const attemptCtxCaps = [undefined, 12000, 6000];
        for (let attempt = 1; attempt <= 3; attempt++) {
          const remainingBudget = LLM_TOTAL_BUDGET_MS - (Date.now() - llmStart);
          if (remainingBudget <= 0) break;
          let chars = 0;
          let lastCtxChars = 0;
          try {
            const messages = buildMessages(question, results, history, prevResults,
              Object.assign(
                attemptCtxCaps[attempt - 1] ? { maxCtxChars: attemptCtxCaps[attempt - 1] } : {},
                { lowCoverage: coverage.low }));
            lastCtxChars = messages.ctxChars;
            const inputChars = messages.reduce(
              (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0);
            emitTrace({
              traceId, stage: 'llm_prompt', durationMs: 0, queryHash: qh,
              attempt, inputChars, systemChars: messages.systemChars,
              ctxChars: messages.ctxChars, ctxCount: messages.ctxCount,
            });
            if (attempt === 1) {
              emitTrace({
                traceId, stage: 'prev_context', durationMs: 0, queryHash: qh,
                hasPrev: prevResults.length, prevCount: messages.prevCount || 0,
              });
            }
            const _llmController = new AbortController();
            const streamResult = await raceLlmOnce(messages, {
              onDelta: (text) => {
                if (firstTokenAt === null) {
                  firstTokenAt = Date.now();
                  emitTrace({
                    traceId, stage: 'llm_first_token', durationMs: firstTokenAt - llmStart,
                    queryHash: qh, status: 'ok',
                  });
                }
                chars += text.length;
                tokenCount++;
                fullAnswer += text;
                sendSSE(res, 'delta', { text });
              },
              timeoutMs: Math.min(
                attempt === 1 ? LLM_STREAM_TIMEOUT_MS : Math.max(60000, LLM_STREAM_TIMEOUT_MS / 2),
                remainingBudget),
              firstTokenMs: Math.min(LLM_FIRST_TOKEN_TIMEOUT_MS, remainingBudget),
              maxTokens: attemptCaps[attempt - 1],
              signal: _llmController.signal,
            });
            lastUsage = streamResult.usage; // capture prefix-cache usage (also on success)
            // Check if response was truncated due to max_tokens limit
            // Implement continuation loop: keep asking LLM to continue until complete or max attempts
            let continuationAttempts = 0;
            const MAX_CONTINUATIONS = 3; // Prevent infinite loops
            // Only continue when the STREAMING answer was genuinely truncated with
            // partial content. An empty `length` response is the upstream's broken
            // stream mode; raceLlmOnce already fell back to the reliable
            // non-streaming path there, so re-streaming would just repeat the
            // emptiness (the multi-call storm that made complex questions take 130s).
            let currentResult = { finishReason: streamResult.finishReason, usage: streamResult.usage };
            while (streamResult.via === 'stream' && currentResult.finishReason === 'length' && continuationAttempts < MAX_CONTINUATIONS && fullAnswer.length > 0) {
              continuationAttempts++;
              emitTrace({
                traceId, stage: 'llm_truncated', durationMs: Date.now() - llmStart,
                queryHash: qh, status: 'truncated', tokens: tokenCount,
                finishReason: currentResult.finishReason, continuation: continuationAttempts,
              });
              // Build continuation context: include system prompt, original question context, and partial answer
              // The LLM needs to know what question it's answering to continue coherently
              const lastUserMsg = messages[messages.length - 1];
              const continuationMessages = [
                messages[0], // System prompt
                { 
                  role: 'user', 
                  content: lastUserMsg.content + '\n\n[注意：你之前的回答被截断了，以下是已经开始的部分回答]'
                },
                { role: 'assistant', content: fullAnswer },
                { role: 'user', content: '请从上次中断的地方继续，保持内容的连贯性和完整性。直接从中断处续写正文，不要写"现在撰写""以下是完整答复""接上次未完成部分"等任何前缀或说明。' }
              ];
              currentResult = await llmStream(continuationMessages, {
                onDelta: (text) => {
                  chars += text.length;
                  tokenCount++;
                  fullAnswer += text;
                  sendSSE(res, 'delta', { text });
                },
                timeoutMs: Math.min(LLM_STREAM_TIMEOUT_MS, remainingBudget),
                firstTokenMs: 0,
                maxTokens: attemptCaps[attempt - 1],
              });
            }
            // Log if still truncated after max continuations
            if (currentResult && currentResult.finishReason === 'length') {
              emitTrace({
                traceId, stage: 'llm_truncated', durationMs: Date.now() - llmStart,
                queryHash: qh, status: 'max_continuations_reached', tokens: tokenCount,
                finishReason: currentResult.finishReason, continuations: continuationAttempts,
              });
            }
          } catch (e) {
            if (attempt < 3 && chars === 0 && (Date.now() - llmStart) < LLM_TOTAL_BUDGET_MS) {
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
          // Both the streaming call AND the non-streaming safety net (raceLlmOnce
          // already tried both) returned nothing for this attempt. The upstream is
          // in its empty-output mode for this turn, so retrying streaming is futile
          // and would burn ~27s per attempt. Bail out and let the final non-
          // streaming fallback (or an error) end the request quickly.
          emitTrace({
            traceId, stage: 'llm_empty_retry', durationMs: Date.now() - llmStart,
            queryHash: qh, status: 'empty', attempt, maxTokens: attemptCaps[attempt - 1],
            ctxChars: lastCtxChars,
          });
          break;
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
      // Confirm DeepSeek's automatic prefix cache: the stable system prompt is
      // reused across requests (prompt_cache_hit_tokens / cache_read_input_tokens).
      if (lastUsage) {
        const hit = lastUsage.prompt_cache_hit_tokens
          ?? lastUsage.cache_read_input_tokens ?? 0;
        const miss = lastUsage.prompt_cache_miss_tokens
          ?? lastUsage.cache_creation_input_tokens
          ?? lastUsage.prompt_tokens ?? 0;
        emitTrace({
          traceId, stage: 'llm_prefix_cache', durationMs: 0, queryHash: qh,
          status: hit > 0 ? 'hit' : 'miss',
          prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: miss,
        });
      }
      // Final fallback: the streaming pipeline (POST + SSE) intermittently
      // returns a 200 with zero deltas while the non-streaming pipeline on the
      // same endpoint keeps working (verified: the answer path streams empty
      // for hours while a stream:false request succeeds in ~2s). So when every
      // streaming attempt came back empty, try ONE non-streaming completion
      // with a tight context before giving up. The result is delivered as a
      // single delta.
      if (tokenCount === 0 && (Date.now() - llmStart) < LLM_TOTAL_BUDGET_MS) {
        sendSSE(res, 'phase', { step: 'llm_retry', text: '改用非流式生成…', progress: 75, model });
        const fbMessages = buildMessages(question, results, history, prevResults, { maxCtxChars: 6000, lowCoverage: coverage.low });
        const fbInputChars = fbMessages.reduce(
          (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0);
        emitTrace({
          traceId, stage: 'llm_prompt', durationMs: 0, queryHash: qh,
          attempt: 4, nonStream: true, inputChars: fbInputChars,
          systemChars: fbMessages.systemChars, ctxChars: fbMessages.ctxChars,
          ctxCount: fbMessages.ctxCount,
        });
        const fbStart = Date.now();
        const fbText = await llmComplete(fbMessages, {
          timeoutMs: Math.min(60000, LLM_TOTAL_BUDGET_MS - (Date.now() - llmStart)),
          maxTokens: LLM_RETRY_MAX_TOKENS,
        });
        if (fbText) {
          fullAnswer = fbText;
          tokenCount = Math.max(1, Math.ceil(fbText.length / 4));
          sendSSE(res, 'delta', { text: fbText });
          emitTrace({
            traceId, stage: 'llm_fallback', durationMs: Date.now() - fbStart,
            queryHash: qh, status: 'ok', tokens: tokenCount,
          });
        } else {
          emitTrace({
            traceId, stage: 'llm_fallback', durationMs: Date.now() - fbStart,
            queryHash: qh, status: 'empty',
          });
        }
      }
      if (tokenCount === 0) {
        emitTrace({
          traceId, stage: 'llm_generate', durationMs: Date.now() - llmStart,
          queryHash: qh, status: 'empty', tokens: 0,
        });
        sendSSE(res, 'error', { error: 'LLM 生成多次为空或超出生成预算，请稍后重试。' });
        res.end();
        finishTotal('error', { error: 'empty_generation' });
        return;
      }
      emitTrace({
        traceId, stage: 'llm_generate', durationMs: Date.now() - llmStart,
        queryHash: qh, status: 'ok', tokens: tokenCount,
      });
      // L2c — Post-generation citation verification (structural guard). Flag any
      // `[cXXXXXXXX]` that does not exist in this turn's retrieval set so the
      // client can mark it as unverified; the model cannot forge a valid id.
      const cit = validateCitations(fullAnswer, results);
      if (cit.invalid.length) {
        emitTrace({
          traceId, stage: 'citation_check', durationMs: 0, queryHash: qh,
          status: 'invalid', invalid: cit.invalid, used: cit.used.length,
        });
        sendSSE(res, 'citation_warn', {
          invalid: cit.invalid,
          note: '以下引用编号未出现在本次检索结果中，可能不可靠，请以上下文为准。',
        });
      } else {
        emitTrace({
          traceId, stage: 'citation_check', durationMs: 0, queryHash: qh,
          status: 'ok', used: cit.used.length,
        });
      }
      sendSSE(res, 'phase', { step: 'llm_done', text: '回答完成', progress: 100, model, tokens: tokenCount });
      // Store the completed self-contained answer for future replays.
      const selfContained = !history.length && !prevResults.length && parsed.fresh !== true;
      if (selfContained && fullAnswer) {
        await storeAnswerCache(question, model, {
          answer: fullAnswer,
          results: results.slice(0, 10),
          tokens: tokenCount,
          model,
        }, url);
        emitTrace({
          traceId, stage: 'answer_cache', durationMs: 0, queryHash: qh,
          status: 'ok', hit: false, tokens: tokenCount,
        });
      }
      sendSSE(res, 'done', { model, tokens: tokenCount, from_cache: fromCache, unverifiedCitations: cit.invalid });
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
