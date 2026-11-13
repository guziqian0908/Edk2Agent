'use strict';

/**
 * Relational query expansion (P0) and directory-neighbor fallback (P2).
 *
 * P0 upgrades the translation call: the same JSON also carries 2–3 related
 * English queries so a literal translation is not the only way into the
 * corpus. "Driver Binding Version" and "ConnectController priority" do not
 * share surface words; the extra queries are the bridge. They are not a
 * hardcoded synonym list — the model writes them, and this module only
 * parses, drops paraphrases, and caps the lane count.
 *
 * P2 does not search by directory name and does not rebuild the index.
 * Sibling chapters are read from SUMMARY.md (a chunk already in the pool,
 * or the repo's SUMMARY.md on disk) grouped by the link's parent directory.
 * GitBook indents are too flat to recover 3.14.1 vs 3.14.2, but those
 * pages share a directory. Content is taken from a chunk already retrieved,
 * otherwise from the markdown file next to that SUMMARY. 9.1 is a sibling
 * of 9.2, not of 3.14.1; that cross-chapter gap stays on the P0 lane.
 *
 * RELATIONAL_QUERY_EXPANSION=false turns both off.
 */

const fs = require('fs');
const path = require('path');
const { isNoiseChunk } = require('./retrieval-routing');

const RELATIONAL_QUERY_CAP = 3;
const RELATIONAL_HITS_PER_QUERY = 4;
const RELATIONAL_SOURCE = 'tianocore-docs';
const NEIGHBOR_CAP = 4;
const NEIGHBOR_SEEDS = 3;
const NEIGHBOR_PER_SEED = 2;
const NEIGHBOR_TEXT_CHARS = 6000;

const REL_STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with', 'is',
  'are', 'was', 'were', 'be', 'been', 'what', 'how', 'can', 'does', 'do', 'did',
  'used', 'use', 'using', 'when', 'where', 'which', 'that', 'this', 'from',
  'into', 'about', 'uefi', 'edk', 'edk2', 'efi', 'its', 'their', 'than', 'then',
  'not', 'you', 'your',
]);

const ANALYZE_SYSTEM_TRANSLATE =
  'You are a translation engine. Translate the user question from Chinese into concise, technically accurate English suitable for searching EDK2/TianoCore documentation. Keep EDK2 terms (INF, DSC, DEC, FDF, PCD, SMM, HII, protocol, GUID...) as-is. Output ONLY the English translation, no explanation, no quotes.';

const ANALYZE_SYSTEM_DECOMPOSE =
  'You are a query analysis engine for an EDK2/TianoCore documentation knowledge base. The user question may contain several sub-questions. Do BOTH: ' +
  '1) Translate the WHOLE question into concise, technically accurate English for document retrieval, keeping EDK2 terms (INF, DSC, DEC, FDF, PCD, SMM, HII, protocol, GUID...) as-is. ' +
  '2) Decompose the question into 2-4 independent English retrieval sub-queries, each focused on ONE sub-question or comparison dimension, keeping EDK2 terms as-is. If the question is a single point, return an empty list. ' +
  'Output ONLY strict JSON, no markdown fences, no explanation: {"translation": "...", "sub_queries": ["...", "..."]}';

const ANALYZE_SYSTEM_PARAPHRASE =
  'You are a query analysis engine for an EDK2/TianoCore documentation knowledge base. Do BOTH: ' +
  '1) Translate the user question into concise, technically accurate English for document retrieval, keeping EDK2 terms (INF, DSC, DEC, FDF, PCD, SMM, HII, protocol, GUID...) as-is. ' +
  '2) Write 2-3 ALTERNATIVE English rephrasings of the SAME question (different wording or angle, same meaning), keeping EDK2 terms as-is. ' +
  'Output ONLY strict JSON, no markdown fences, no explanation: {"translation": "...", "sub_queries": ["...", "..."]}';

const RELATED_CLAUSE =
  '3) Write 2 or 3 ADDITIONAL English search queries that retrieve chapters a literal translation would miss because they use different words for the same idea. Each query is a short noun phrase. Cover different facets: the protocol, struct, or field itself; the function or boot/runtime process that uses it; and the scenario where that field changes ordering or behavior. These are related concepts, not paraphrases of the translation and not copies of sub_queries. Do not invent GUIDs or PCD names. Use the example only when the question is actually about that gap: the Driver Binding Protocol Version field is consumed by ConnectController driver-connection priority, which is a different chapter from the Driver Supported EFI Version Protocol. ';

function withRelatedQueries(base) {
  const schema = '{"translation":"...","sub_queries":["..."],"related_queries":["...","..."]}';
  return base.replace(
    /Output ONLY strict JSON[\s\S]*$/,
    RELATED_CLAUSE + 'Output ONLY strict JSON, no markdown fences, no explanation: ' + schema,
  );
}

const ANALYZE_SYSTEM_TRANSLATE_RELATED =
  'You are a query analysis engine for an EDK2/TianoCore documentation knowledge base. Do BOTH: ' +
  '1) Translate the user question into concise, technically accurate English for document retrieval, keeping EDK2 terms (INF, DSC, DEC, FDF, PCD, SMM, HII, protocol, GUID...) as-is. If the question is already English, return it unchanged as the translation. ' +
  '2) Write 2 or 3 ADDITIONAL English search queries that retrieve chapters a literal translation would miss because they use different words for the same idea. Each query is a short noun phrase. Cover different facets: the protocol, struct, or field itself; the function or boot/runtime process that uses it; and the scenario where that field changes ordering or behavior. These are related concepts, not paraphrases of the translation. Do not invent GUIDs or PCD names. Use the example only when the question is actually about that gap: the Driver Binding Protocol Version field is consumed by ConnectController driver-connection priority, which is a different chapter from the Driver Supported EFI Version Protocol. ' +
  'Output ONLY strict JSON, no markdown fences, no explanation: {"translation":"...","sub_queries":[],"related_queries":["...","..."]}';

function relationalExpansionEnabled(env = process.env) {
  const v = env && Object.prototype.hasOwnProperty.call(env, 'RELATIONAL_QUERY_EXPANSION')
    ? env.RELATIONAL_QUERY_EXPANSION
    : undefined;
  if (v == null || v === '') return true;
  return !/^(0|false|off|no)$/i.test(String(v).trim());
}

function buildAnalysisSystemPrompt(opts = {}) {
  const relational = !!opts.relational;
  if (!relational) {
    if (opts.decompose) return ANALYZE_SYSTEM_DECOMPOSE;
    if (opts.paraphrase) return ANALYZE_SYSTEM_PARAPHRASE;
    return ANALYZE_SYSTEM_TRANSLATE;
  }
  if (opts.decompose) return withRelatedQueries(ANALYZE_SYSTEM_DECOMPOSE);
  if (opts.paraphrase) return withRelatedQueries(ANALYZE_SYSTEM_PARAPHRASE);
  return ANALYZE_SYSTEM_TRANSLATE_RELATED;
}

function contentTokens(s) {
  return [...new Set(
    String(s || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !REL_STOP.has(t)),
  )];
}

function jaccardTokens(a, b) {
  const A = new Set(contentTokens(a));
  const B = new Set(contentTokens(b));
  if (!A.size || !B.size) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  const union = A.size + B.size - inter;
  return union ? inter / union : 1;
}

// A related query that only restates the translation is a paraphrase, which
// the simple tier already runs. Keep a query when it adds a real token the
// translation does not have (ConnectController, precedence, protocol, ...).
function isNearCopy(candidate, translation) {
  const a = contentTokens(candidate);
  const b = new Set(contentTokens(translation));
  if (a.length < 2) return true;
  const added = a.filter((t) => !b.has(t));
  if (added.some((t) => t.length >= 6)) return false;
  if (added.length === 0) return true;
  return jaccardTokens(candidate, translation) >= 0.72;
}

function normalizeRelatedQueries(queries, opts = {}) {
  if (opts.enabled === false) return [];
  const translation = opts.translation || '';
  const cap = opts.max != null ? opts.max : RELATIONAL_QUERY_CAP;
  const transNorm = String(translation).toLowerCase().replace(/\s+/g, ' ').trim();
  const out = [];
  const seen = new Set();
  for (const raw of queries || []) {
    if (out.length >= cap) break;
    if (typeof raw !== 'string') continue;
    const q = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!q) continue;
    const key = q.toLowerCase();
    if (seen.has(key) || (transNorm && key === transNorm)) continue;
    const latin = q.match(/[A-Za-z]/g);
    if (!latin || latin.length < 8) continue;
    if (isNearCopy(q, translation)) continue;
    if (out.some((prev) => jaccardTokens(q, prev) >= 0.6)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

function relatedQueriesForSearch(analysis, env) {
  if (!relationalExpansionEnabled(env)) return [];
  return normalizeRelatedQueries(analysis && analysis.relatedQueries, {
    translation: analysis && analysis.translation,
    enabled: true,
  });
}

function parseAnalysisPayload(text, question, opts = {}) {
  const structured = !!opts.structured;
  const plainOk = opts.plainOk !== undefined ? !!opts.plainOk : !structured;
  const data = {
    translation: String(question || ''),
    subQueries: [],
    relatedQueries: [],
  };
  const raw = String(text || '').trim();
  if (!raw) return data;
  let jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const lo = jsonText.indexOf('{');
  const hi = jsonText.lastIndexOf('}');
  if (lo >= 0 && hi > lo) jsonText = jsonText.slice(lo, hi + 1);
  try {
    const j = JSON.parse(jsonText);
    if (typeof j.translation === 'string' && j.translation.trim()) {
      data.translation = j.translation.trim().slice(0, 300);
    }
    if (Array.isArray(j.sub_queries)) {
      data.subQueries = j.sub_queries
        .filter((s) => typeof s === 'string' && s.trim())
        .map((s) => s.trim().slice(0, 200))
        .slice(0, 4);
    }
    if (Array.isArray(j.related_queries)) {
      data.relatedQueries = j.related_queries
        .filter((s) => typeof s === 'string' && s.trim())
        .map((s) => s.trim().slice(0, 200));
    }
  } catch {
    if (plainOk && !/[{}]/.test(jsonText)) data.translation = raw.slice(0, 300);
  }
  return data;
}

function selectRelationalHits(results, limit = RELATIONAL_HITS_PER_QUERY) {
  const n = limit == null ? RELATIONAL_HITS_PER_QUERY : limit;
  const docs = [];
  const noise = [];
  for (const r of results || []) {
    if (!r) continue;
    if (isNoiseChunk(r)) noise.push(r);
    else docs.push(r);
  }
  const out = docs.slice(0, n);
  for (const r of noise) {
    if (out.length >= n) break;
    out.push(r);
  }
  return out;
}

function normalizeDocPath(file) {
  return String(file || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '');
}

function isDocsRepo(seg) {
  return /^edk2-/i.test(seg || '');
}

function repoOf(file) {
  const parts = normalizeDocPath(file).split('/').filter(Boolean);
  if (parts.length < 2) return '';
  return isDocsRepo(parts[0]) ? parts[0] : '';
}

function relOf(file) {
  const p = normalizeDocPath(file);
  const repo = repoOf(p);
  if (repo && p.toLowerCase().startsWith(repo.toLowerCase() + '/')) {
    return p.slice(repo.length + 1);
  }
  return p;
}

function parentDir(file) {
  const p = normalizeDocPath(file);
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : '';
}

function isIndexFile(file) {
  const base = normalizeDocPath(file).split('/').pop() || '';
  return /^(summary|readme)(\.[^.]*)?\.md$/i.test(base);
}

function sameDoc(a, b) {
  const na = normalizeDocPath(a).toLowerCase();
  const nb = normalizeDocPath(b).toLowerCase();
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.endsWith('/' + nb) || nb.endsWith('/' + na)) return true;
  const ra = relOf(na);
  const rb = relOf(nb);
  return !!ra && ra === rb && ra.includes('/');
}

function parseSummaryOutline(markdown) {
  const items = [];
  const seen = new Set();
  const re = /^[ \t]*\*\s+\[([^\]]+)\]\(([^)]+)\)/gm;
  let m;
  const text = String(markdown || '');
  while ((m = re.exec(text)) !== null) {
    let href = m[2].trim().split('#')[0].split('?')[0].trim();
    try { href = decodeURIComponent(href); } catch { /* keep raw */ }
    href = normalizeDocPath(href);
    if (!href || href.includes('..') || /^[a-z]+:/i.test(href)) continue;
    const key = href.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const base = href.split('/').pop();
    items.push({
      title: m[1].trim(),
      href,
      dir: parentDir(href),
      base,
    });
  }
  return items;
}

function findOutlineNode(outline, seedFile) {
  const rel = relOf(seedFile).toLowerCase();
  const full = normalizeDocPath(seedFile).toLowerCase();
  const base = (rel.split('/').pop() || '');
  let baseHits = [];
  for (const it of outline || []) {
    const href = it.href.toLowerCase();
    if (
      href === rel || href === full ||
      full.endsWith('/' + href) || rel.endsWith('/' + href) ||
      (rel && href.endsWith('/' + rel))
    ) {
      return it;
    }
    if (base && it.base.toLowerCase() === base) baseHits.push(it);
  }
  return baseHits.length === 1 ? baseHits[0] : null;
}

function summaryCoversSeed(text, seedFile) {
  if (!text || !seedFile) return false;
  return !!findOutlineNode(parseSummaryOutline(text), seedFile);
}

function siblingItems(outline, node) {
  const content = (outline || []).filter((it) => it.dir === node.dir && !isIndexFile(it.href));
  const i = content.findIndex((it) => it.href === node.href);
  if (i < 0) return [];
  const picked = [];
  if (content[i + 1]) picked.push(content[i + 1]);
  if (content[i - 1]) picked.push(content[i - 1]);
  return picked.slice(0, NEIGHBOR_PER_SEED);
}

function joinRepoPath(repo, href, slash) {
  const rel = normalizeDocPath(href);
  let full = rel;
  if (repo && !rel.toLowerCase().startsWith(repo.toLowerCase() + '/')) {
    full = repo + '/' + rel;
  }
  if (slash === '\\') return full.replace(/\//g, '\\');
  return full;
}

function findPoolChunk(pool, file) {
  for (const r of pool || []) {
    if (r && r.file && sameDoc(r.file, file)) return r;
  }
  return null;
}

function planDirectoryNeighbors({ seeds, pool, summaries, max = NEIGHBOR_CAP } = {}) {
  const kept = [];
  const keptFiles = [];
  for (const r of seeds || []) {
    if (!r || isNoiseChunk(r) || isIndexFile(r.file || '') || !r.file) continue;
    if (keptFiles.some((f) => sameDoc(f, r.file))) continue;
    kept.push(r);
    keptFiles.push(r.file);
    if (kept.length >= NEIGHBOR_SEEDS) break;
  }

  const outlineText = new Map();
  for (const s of summaries || []) {
    const repo = s && s.repo ? s.repo : '';
    const text = String((s && s.text) || '');
    if (!text) continue;
    const prev = outlineText.get(repo) || '';
    if (text.length > prev.length) outlineText.set(repo, text);
  }

  const plans = [];
  const planned = keptFiles.map((f) => normalizeDocPath(f).toLowerCase());
  const already = (file) => {
    const n = normalizeDocPath(file).toLowerCase();
    return planned.some((p) => p === n || sameDoc(p, n));
  };
  const mark = (file) => {
    planned.push(normalizeDocPath(file).toLowerCase());
  };

  for (const seed of kept) {
    if (plans.length >= max) break;
    const repo = repoOf(seed.file);
    let outline = [];
    let node = null;
    const own = outlineText.get(repo);
    if (own) {
      outline = parseSummaryOutline(own);
      node = findOutlineNode(outline, seed.file);
    }
    if (!node) {
      for (const [k, t] of outlineText) {
        if (k === repo) continue;
        const o = parseSummaryOutline(t);
        const n = findOutlineNode(o, seed.file);
        if (n) { outline = o; node = n; break; }
      }
    }
    if (node) {
      const slash = String(seed.file).includes('\\') ? '\\' : '/';
      for (const sib of siblingItems(outline, node)) {
        if (plans.length >= max) break;
        const full = joinRepoPath(repo, sib.href, slash);
        if (already(full) || already(sib.href)) continue;
        const chunk = findPoolChunk(pool, full) || findPoolChunk(seeds, full);
        plans.push({
          file: chunk ? chunk.file : full,
          title: sib.title,
          section: sib.title,
          chunk: chunk || null,
        });
        mark(chunk ? chunk.file : full);
      }
    } else {
      const seedDir = parentDir(relOf(seed.file));
      if (!seedDir) continue;
      let n = 0;
      for (const r of pool || []) {
        if (n >= NEIGHBOR_PER_SEED || plans.length >= max) break;
        if (!r || !r.file || isNoiseChunk(r) || isIndexFile(r.file)) continue;
        const otherRepo = repoOf(r.file);
        if (repo && otherRepo && otherRepo !== repo) continue;
        if (parentDir(relOf(r.file)) !== seedDir) continue;
        if (already(r.file)) continue;
        plans.push({
          file: r.file,
          title: r.title || r.section || '',
          section: r.section || r.title || '',
          chunk: r,
        });
        mark(r.file);
        n += 1;
      }
    }
  }
  return plans.slice(0, max);
}

function summaryTextsByRepo(results) {
  const groups = new Map();
  for (const r of results || []) {
    const file = r && r.file;
    if (!file || !/summary\.md$/i.test(normalizeDocPath(file))) continue;
    const text = String(r.content || r.snippet || '');
    if (!text) continue;
    const repo = repoOf(file);
    const list = groups.get(repo) || [];
    list.push(text);
    groups.set(repo, list);
  }
  return groups;
}

// A longer SUMMARY chunk from another part of the book must not hide a
// shorter chunk that actually links the seed. Among chunks that contain the
// seed, keep the longest; otherwise keep the longest leftover.
function bestSummaryText(texts, seedFile) {
  let covering = '';
  let longest = '';
  for (const text of texts || []) {
    if (text.length > longest.length) longest = text;
    if (seedFile && summaryCoversSeed(text, seedFile) && text.length > covering.length) {
      covering = text;
    }
  }
  return covering || longest;
}

function collectSummaryDocuments(results) {
  return [...summaryTextsByRepo(results).entries()].map(([repo, texts]) => ({
    repo,
    text: bestSummaryText(texts, ''),
  }));
}

function insideRoot(root, abs) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(abs);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

function readRepoSummary(reposDir, repo) {
  if (!reposDir || !repo || !isDocsRepo(repo) || repo.includes('..') || repo.includes('/') || repo.includes('\\')) {
    return '';
  }
  const abs = path.resolve(reposDir, repo, 'SUMMARY.md');
  if (!insideRoot(reposDir, abs)) return '';
  try {
    if (!fs.existsSync(abs)) return '';
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

function readDocFile(reposDir, file) {
  if (!reposDir || !file || String(file).includes('..')) return '';
  const parts = normalizeDocPath(file).split('/').filter(Boolean);
  if (!parts.length || !isDocsRepo(parts[0])) return '';
  const abs = path.resolve(reposDir, ...parts);
  if (!insideRoot(reposDir, abs)) return '';
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return '';
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

function fillNeighborPlans(plans, reposDir) {
  const out = [];
  for (const plan of plans || []) {
    if (!plan) continue;
    if (plan.chunk) {
      out.push(plan.chunk);
      continue;
    }
    const text = readDocFile(reposDir, plan.file);
    if (!text) continue;
    const body = text.slice(0, NEIGHBOR_TEXT_CHARS);
    out.push({
      title: plan.title || plan.file,
      section: plan.section || plan.title || '',
      file: plan.file,
      content: body,
      snippet: body.slice(0, 500),
      source: RELATIONAL_SOURCE,
      source_display: RELATIONAL_SOURCE,
      score: 0,
    });
  }
  return out;
}

function expandDirectoryNeighbors({ kept, pool, reposDir, max } = {}) {
  const recalled = summaryTextsByRepo([...(pool || []), ...(kept || [])]);
  const repos = [];
  for (const r of kept || []) {
    if (!r || isNoiseChunk(r) || isIndexFile(r.file || '')) continue;
    const repo = repoOf(r.file);
    if (!repo || repos.includes(repo)) continue;
    repos.push(repo);
    if (repos.length >= NEIGHBOR_SEEDS) break;
  }
  const chosen = new Map();
  for (const repo of repos) {
    const disk = readRepoSummary(reposDir, repo);
    const seedForRepo = (kept || []).find((r) => r && repoOf(r.file) === repo && r.file && !isIndexFile(r.file));
    const have = bestSummaryText(recalled.get(repo), seedForRepo && seedForRepo.file);
    const diskOk = !!(disk && seedForRepo && summaryCoversSeed(disk, seedForRepo.file));
    const haveOk = !!(have && seedForRepo && summaryCoversSeed(have, seedForRepo.file));
    if (diskOk) chosen.set(repo, disk);
    else if (haveOk) chosen.set(repo, have);
    else if (disk) chosen.set(repo, disk);
    else if (have) chosen.set(repo, have);
  }
  for (const [repo, texts] of recalled) {
    if (!chosen.has(repo)) chosen.set(repo, bestSummaryText(texts, ''));
  }
  const summaries = [...chosen.entries()].map(([repo, text]) => ({ repo, text }));
  return fillNeighborPlans(
    planDirectoryNeighbors({ seeds: kept, pool, summaries, max }),
    reposDir,
  );
}

function maybeExpandDirectoryNeighbors(opts, env) {
  if (!relationalExpansionEnabled(env)) return [];
  return expandDirectoryNeighbors(opts || {});
}

module.exports = {
  RELATIONAL_QUERY_CAP,
  RELATIONAL_HITS_PER_QUERY,
  RELATIONAL_SOURCE,
  NEIGHBOR_CAP,
  ANALYZE_SYSTEM_TRANSLATE,
  ANALYZE_SYSTEM_DECOMPOSE,
  ANALYZE_SYSTEM_PARAPHRASE,
  relationalExpansionEnabled,
  buildAnalysisSystemPrompt,
  normalizeRelatedQueries,
  relatedQueriesForSearch,
  parseAnalysisPayload,
  selectRelationalHits,
  parseSummaryOutline,
  planDirectoryNeighbors,
  collectSummaryDocuments,
  readRepoSummary,
  expandDirectoryNeighbors,
  maybeExpandDirectoryNeighbors,
  sameDoc,
  repoOf,
};
