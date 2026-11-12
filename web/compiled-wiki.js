'use strict';

/**
 * Deterministic compiled-wiki matcher.
 *
 * Contract: edk2-kb/compiled-wiki/SCHEMA.md. Pages live in pages/*.md.
 * The body is a short 导读 and is never returned, indexed, or searched.
 * COMPILED_WIKI=false|0|off|no disables matching. An empty or missing
 * directory is the same as disabled and does not throw.
 */

const fs = require('fs');
const path = require('path');

const GENERIC_SINGLE = new Set(['version', 'boot', 'event']);
const OFFICIAL_ACRONYM = new Set(['ppi', 'hob', 'tpl']);

function compiledWikiEnabled(env = process.env) {
  const v = env && Object.prototype.hasOwnProperty.call(env, 'COMPILED_WIKI')
    ? env.COMPILED_WIKI
    : undefined;
  if (v == null || String(v).trim() === '') return true;
  return !/^(false|0|off|no)$/i.test(String(v).trim());
}

function defaultCompiledWikiDir() {
  return path.join(__dirname, '..', 'edk2-kb', 'compiled-wiki');
}

function normalizePhrase(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[_]+/g, ' ')
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function acceptableAlias(norm) {
  if (!norm) return false;
  const tokens = norm.split(' ').filter(Boolean);
  if (tokens.length >= 2) return true;
  if (tokens.length === 1 && OFFICIAL_ACRONYM.has(tokens[0])) return true;
  if (tokens.length === 1 && GENERIC_SINGLE.has(tokens[0])) return false;
  if (/[\u3400-\u9fff]/.test(norm) && norm.length >= 2) return true;
  return tokens.length === 1 && tokens[0].length >= 4;
}

function phraseHit(queryNorm, aliasNorm) {
  if (!queryNorm || !aliasNorm) return false;
  return ` ${queryNorm} `.includes(` ${aliasNorm} `);
}

function stripComment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote && line[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '#' && (i === 0 || line[i - 1] === ' ')) return line.slice(0, i).replace(/\s+$/, '');
  }
  return line.replace(/\s+$/, '');
}

function parseScalar(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function indentOf(line) {
  const m = /^( *)/.exec(line);
  return m ? m[1].length : 0;
}

/**
 * Indentation YAML subset: maps, lists of maps, and > / | block scalars.
 * Enough for the compiled-wiki frontmatter. Not a general YAML loader.
 */
function parseYaml(text) {
  const lines = String(text || '').replace(/\t/g, '  ').split(/\r?\n/);
  const parsed = parseNode(lines, 0, 0);
  return parsed.value == null ? {} : parsed.value;
}

function nextContent(lines, index) {
  let i = index;
  while (i < lines.length) {
    const raw = stripComment(lines[i]);
    if (raw.trim()) return { index: i, raw, indent: indentOf(raw), text: raw.trim() };
    i += 1;
  }
  return null;
}

function parseNode(lines, index, minIndent) {
  const head = nextContent(lines, index);
  if (!head || head.indent < minIndent) return { value: null, index };
  if (head.text.startsWith('- ')) return parseList(lines, index, head.indent);
  return parseMap(lines, index, head.indent);
}

function parseMap(lines, index, indent) {
  const obj = {};
  let i = index;
  while (i < lines.length) {
    const item = nextContent(lines, i);
    if (!item || item.indent < indent) break;
    if (item.indent > indent) break;
    if (item.text.startsWith('- ')) break;
    const colon = item.text.indexOf(':');
    if (colon <= 0) break;
    const key = item.text.slice(0, colon).trim();
    const rest = item.text.slice(colon + 1).trim();
    if (rest === '>' || rest === '>-' || rest === '>+' || rest === '|' || rest === '|-' || rest === '|+') {
      const block = parseBlockScalar(lines, item.index + 1, item.indent, rest);
      obj[key] = block.value;
      i = block.index;
      continue;
    }
    if (!rest) {
      const nested = parseNode(lines, item.index + 1, item.indent + 1);
      obj[key] = nested.value == null ? '' : nested.value;
      i = nested.index;
      continue;
    }
    obj[key] = parseScalar(rest);
    i = item.index + 1;
  }
  return { value: obj, index: i };
}

function parseList(lines, index, indent) {
  const arr = [];
  let i = index;
  while (i < lines.length) {
    const item = nextContent(lines, i);
    if (!item || item.indent < indent) break;
    if (item.indent > indent) break;
    if (!item.text.startsWith('- ')) break;
    const rest = item.text.slice(2).trim();
    if (!rest) {
      const nested = parseNode(lines, item.index + 1, item.indent + 1);
      if (nested.value != null) arr.push(nested.value);
      i = nested.index;
      continue;
    }
    if (rest.includes(':') && !rest.startsWith('"') && !rest.startsWith("'")) {
      const colon = rest.indexOf(':');
      const key = rest.slice(0, colon).trim();
      const inline = rest.slice(colon + 1).trim();
      const obj = {};
      if (!inline) {
        const nested = parseNode(lines, item.index + 1, item.indent + 2);
        obj[key] = nested.value == null ? '' : nested.value;
        i = nested.index;
      } else if (inline === '>' || inline === '>-' || inline === '|' || inline === '|-') {
        const block = parseBlockScalar(lines, item.index + 1, item.indent, inline);
        obj[key] = block.value;
        i = block.index;
      } else {
        obj[key] = parseScalar(inline);
        i = item.index + 1;
      }
      while (i < lines.length) {
        const cont = nextContent(lines, i);
        if (!cont || cont.indent <= item.indent) break;
        if (cont.text.startsWith('- ')) break;
        const ccolon = cont.text.indexOf(':');
        if (ccolon <= 0) break;
        const ck = cont.text.slice(0, ccolon).trim();
        const cv = cont.text.slice(ccolon + 1).trim();
        if (cv === '>' || cv === '>-' || cv === '>+' || cv === '|' || cv === '|-' || cv === '|+') {
          const block = parseBlockScalar(lines, cont.index + 1, cont.indent, cv);
          obj[ck] = block.value;
          i = block.index;
          continue;
        }
        if (!cv) {
          const nested = parseNode(lines, cont.index + 1, cont.indent + 1);
          obj[ck] = nested.value == null ? '' : nested.value;
          i = nested.index;
          continue;
        }
        obj[ck] = parseScalar(cv);
        i = cont.index + 1;
      }
      arr.push(obj);
      continue;
    }
    arr.push(parseScalar(rest));
    i = item.index + 1;
  }
  return { value: arr, index: i };
}

function parseBlockScalar(lines, index, parentIndent, style) {
  const folded = style.startsWith('>');
  const strip = style.endsWith('-');
  const parts = [];
  let i = index;
  let blockIndent = null;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      parts.push('');
      i += 1;
      continue;
    }
    const ind = indentOf(line);
    if (blockIndent == null) blockIndent = ind;
    if (ind < blockIndent || ind <= parentIndent) break;
    parts.push(line.slice(blockIndent));
    i += 1;
  }
  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  let value;
  if (folded) {
    const chunks = [];
    let buf = [];
    for (const p of parts) {
      if (p === '') {
        if (buf.length) chunks.push(buf.join(' '));
        buf = [];
      } else buf.push(p.trim());
    }
    if (buf.length) chunks.push(buf.join(' '));
    value = chunks.join('\n');
  } else {
    value = parts.join('\n');
  }
  if (!strip) value += '\n';
  return { value: value.trim(), index: i };
}

function asStringList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

function asPathList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (typeof item === 'string' && item.trim()) {
      out.push({ source: '', repo: '', file: item.trim(), url: '' });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const file = String(item.file || '').trim();
    if (!file) continue;
    out.push({
      source: String(item.source || '').trim(),
      repo: String(item.repo || '').trim(),
      file,
      url: String(item.url || '').trim(),
    });
  }
  return out;
}

function asDistinguishes(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const sourcePaths = asPathList(item.source_paths).map((p) => ({
      source: p.source,
      repo: p.repo,
      file: p.file,
    }));
    const entry = {
      id: String(item.id || '').trim(),
      canonical: String(item.canonical || '').trim(),
      aliases: asStringList(item.aliases),
      source_paths: sourcePaths,
    };
    if (entry.id || entry.canonical || entry.aliases.length || entry.source_paths.length) out.push(entry);
  }
  return out;
}

function splitFrontmatter(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  if (!src.startsWith('---')) return null;
  const end = src.indexOf('\n---', 3);
  if (end < 0) return null;
  return src.slice(src.indexOf('\n') + 1, end);
}

function pageFromMarkdown(text, filename) {
  const yaml = splitFrontmatter(text);
  if (yaml == null) return null;
  let data;
  try {
    data = parseYaml(yaml);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const id = String(data.id || '').trim();
  const canonical = String(data.canonical || '').trim();
  const sense = String(data.sense || '').trim();
  const aliases = asStringList(data.aliases);
  const sourcePaths = asPathList(data.source_paths);
  if (!id || !canonical || !sense || !aliases.length || !sourcePaths.length) return null;
  return {
    id,
    title: String(data.title || '').trim(),
    topic: String(data.topic || '').trim(),
    canonical,
    aliases,
    sense,
    distinguishes_from: asDistinguishes(data.distinguishes_from),
    source_paths: sourcePaths,
    fileName: filename || '',
  };
}

function loadCompiledWiki(dir) {
  const root = dir || defaultCompiledWikiDir();
  const pagesDir = path.join(root, 'pages');
  let names;
  try {
    names = fs.readdirSync(pagesDir);
  } catch {
    return [];
  }
  const pages = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(pagesDir, name), 'utf8');
    } catch {
      continue;
    }
    const page = pageFromMarkdown(text, name);
    if (page) pages.push(page);
  }
  pages.sort((a, b) => a.id.localeCompare(b.id));
  return pages;
}

function sourceFileSet(match) {
  const files = [];
  for (const p of (match && match.source_paths) || []) {
    const file = String(p.file || '').replace(/\\/g, '/').trim();
    if (file && !files.includes(file)) files.push(file);
  }
  return files.sort();
}

function downrankFiles(match) {
  const files = [];
  for (const d of (match && match.distinguishes_from) || []) {
    for (const p of d.source_paths || []) {
      const file = String(p.file || '').replace(/\\/g, '/').trim();
      if (file && !files.includes(file)) files.push(file);
    }
  }
  return files;
}

function sourcePathAnchors(match) {
  return sourceFileSet(match).map((f) => f.toLowerCase());
}

function matchCompiledWiki(question, pages, opts = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const extra = opts && opts.extraText ? String(opts.extraText) : '';
  const queryNorm = normalizePhrase([question, extra].filter(Boolean).join('\n'));
  if (!queryNorm || !list.length) return null;
  const hits = [];
  for (const page of list) {
    if (!page || !page.id || !page.canonical || !page.sense) continue;
    if (!Array.isArray(page.source_paths) || !page.source_paths.length) continue;
    const names = [...(page.aliases || [])];
    if (page.canonical) names.push(page.canonical);
    let best = '';
    for (const raw of names) {
      const alias = normalizePhrase(raw);
      if (!acceptableAlias(alias)) continue;
      if (!phraseHit(queryNorm, alias)) continue;
      if (alias.length > best.length) best = alias;
    }
    if (best) hits.push({ page, alias: best, length: best.length });
  }
  if (!hits.length) return null;
  const longest = hits.reduce((m, h) => Math.max(m, h.length), 0);
  const winners = hits.filter((h) => h.length === longest);
  if (winners.length !== 1) return null;
  const page = winners[0].page;
  return {
    id: page.id,
    title: page.title,
    topic: page.topic,
    canonical: page.canonical,
    sense: page.sense,
    aliases: page.aliases.slice(),
    matchedAlias: winners[0].alias,
    source_paths: page.source_paths.map((p) => ({
      source: p.source,
      repo: p.repo,
      file: p.file,
      url: p.url || '',
    })),
    distinguishes_from: page.distinguishes_from.map((d) => ({
      id: d.id,
      canonical: d.canonical,
      aliases: d.aliases.slice(),
      source_paths: d.source_paths.map((p) => ({
        source: p.source,
        repo: p.repo,
        file: p.file,
      })),
    })),
  };
}

function sameFileSet(a, b) {
  const norm = (f) => String(f || '').replace(/\\/g, '/').trim().toLowerCase();
  const left = [...new Set((a || []).map(norm).filter(Boolean))].sort();
  const right = [...new Set((b || []).map(norm).filter(Boolean))].sort();
  if (left.length !== right.length) return false;
  return left.every((f, i) => f === right[i]);
}

function cacheReplayAllowed(entry, match, opts = {}) {
  const enabled = opts.enabled != null ? !!opts.enabled : compiledWikiEnabled(opts.env);
  if (!enabled || !match) return true;
  if (!entry || entry.compiledId == null || entry.compiledFiles == null) return false;
  if (String(entry.compiledId) !== String(match.id)) return false;
  return sameFileSet(entry.compiledFiles, sourceFileSet(match));
}

function stampCacheMeta(data, match, opts = {}) {
  const enabled = opts.enabled != null ? !!opts.enabled : true;
  const out = { ...(data || {}) };
  if (!enabled || !match) return out;
  out.compiledId = match.id;
  out.compiledFiles = sourceFileSet(match);
  return out;
}

function routingText(question, match) {
  if (!match) return String(question || '');
  return [match.canonical, match.sense].filter(Boolean).join('\n');
}

function relationalExpansionHint(match) {
  if (!match) return null;
  const exclude = [];
  for (const d of match.distinguishes_from || []) {
    if (d.canonical) exclude.push(d.canonical);
    for (const a of d.aliases || []) exclude.push(a);
  }
  const subject = [match.canonical, match.sense].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return {
    hinted: true,
    id: match.id,
    canonical: match.canonical,
    sense: match.sense,
    subject,
    source_paths: match.source_paths,
    exclude,
    downrankFiles: downrankFiles(match),
  };
}

function dropExcludedQueries(queries, exclude) {
  const phrases = (exclude || []).map(normalizePhrase).filter((p) => p.length >= 4);
  return (queries || []).filter((q) => {
    const n = normalizePhrase(q);
    if (!n) return false;
    return !phrases.some((p) => phraseHit(n, p));
  });
}

function neighborSeeds(results, match) {
  const list = Array.isArray(results) ? results : [];
  if (!match) return list;
  const files = sourceFileSet(match).map((f) => f.toLowerCase());
  return list.filter((r) => {
    const f = String((r && (r.file || r.url)) || '').replace(/\\/g, '/').toLowerCase();
    if (!f || f.includes('compiled-wiki/')) return false;
    return files.some((p) => f === p || f.endsWith(p) || p.endsWith(f));
  });
}

function applyCompiledQuery(translated, match) {
  if (!match) return translated || '';
  const bits = [match.canonical];
  for (const p of match.source_paths || []) {
    const base = String(p.file || '').split('/').pop().replace(/\.md$/i, '').replace(/[_-]+/g, ' ');
    if (base) bits.push(base);
  }
  if (translated) bits.push(translated);
  let q = bits.join(' ');
  const hint = relationalExpansionHint(match);
  for (const phrase of (hint && hint.exclude) || []) {
    const n = String(phrase || '').trim();
    if (n.length < 8) continue;
    q = q.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
  }
  return q.replace(/[^\x00-\x7F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function considerCachedAnswer(cache, question, model, match, opts = {}) {
  const enabled = opts.enabled != null ? !!opts.enabled : true;
  if (!cache) return null;
  const exact = cache.getExact(question, model);
  if (exact && cacheReplayAllowed(exact, match, { enabled })) {
    return { entry: exact, match: 'exact', similarity: null };
  }
  const lexical = cache.getLexical(question, model);
  if (lexical && cacheReplayAllowed(lexical.entry, match, { enabled })) {
    return { entry: lexical.entry, match: 'lexical', similarity: lexical.similarity };
  }
  return null;
}

module.exports = {
  compiledWikiEnabled,
  defaultCompiledWikiDir,
  normalizePhrase,
  loadCompiledWiki,
  pageFromMarkdown,
  matchCompiledWiki,
  sourceFileSet,
  sourcePathAnchors,
  downrankFiles,
  cacheReplayAllowed,
  stampCacheMeta,
  routingText,
  relationalExpansionHint,
  dropExcludedQueries,
  neighborSeeds,
  applyCompiledQuery,
  considerCachedAnswer,
};
