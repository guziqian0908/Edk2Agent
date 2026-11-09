'use strict';

/**
 * Similar-question answer cache.
 *
 * Repeating a question (or a near-duplicate) should skip retrieval and the
 * LLM. Three tiers, cheapest first:
 *
 *   1. exact    — same model + case/whitespace-normalized question text.
 *   2. lexical  — punctuation, spacing, polite edges ("请问…呢"), and a few
 *                 high-frequency Chinese paraphrases ("怎么"/"如何",
 *                 "哪几种"/"哪些", "是什么"/"什么是"). No embedding model and
 *                 no daemon: this tier
 *                 runs before the knowledge-base service is touched.
 *                 A hit also requires the Latin identifiers (PCD, INF,
 *                 Depex, …) to be identical, so "INF 怎么写" does not reuse
 *                 "DEC 怎么写".
 *   3. semantic — caller compares a bge-m3 embedding (daemon /embed) with
 *                 stored vectors. Cosine threshold defaults to 0.93.
 *                 Embeddings are attached after the answer is stored, so
 *                 this tier can miss for a moment; exact and lexical do not
 *                 wait on it.
 *
 * Invalidation:
 *   - TTL (ANSWER_CACHE_TTL_MS, default 30 min) bounds staleness after a
 *     knowledge-base update. The map is in-process: restarting the web
 *     server drops it immediately.
 *   - LRU (ANSWER_CACHE_MAX, default 300) caps memory.
 *   - The ask API {"fresh":true} skips lookup; the newly generated answer
 *     replaces the previous entry for that question.
 *
 * What is stored is decided by the caller. Follow-up turns ("详细说说",
 * "上面那个", "它和 PCD 的区别") are not meaningful alone — use
 * isFollowUpQuestion() and do not store or replay those. The web UI sends
 * localStorage history on every request, so an empty history is NOT required
 * for a standalone technical question to be cached.
 */

const SYNONYM_GROUPS = [
  ['什么是', '是什么', '何为', '啥是'],
  ['如何', '怎么', '怎样', '怎么样'],
  ['哪些', '哪几种', '有几种'],
  ['区别', '差异', '不同点'],
];

function envInt(name, fallback) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function envFloat(name, fallback) {
  const v = parseFloat(process.env[name] || '');
  return Number.isFinite(v) ? v : fallback;
}

function normalizeQuery(q) {
  return String(q || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// Strip whitespace and punctuation, then fold a few paraphrases so
// "PCD 有哪些类型?" and "PCD有哪几种类型" share one key.
function normalizeForSimilarity(q) {
  const stripped = String(q || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[?？!！。．，,、；;：:“”‘’"'（）()【】\[\]《》<>~～`·…—\-_/\\]+/g, '');
  return foldSynonyms(stripped);
}

function foldSynonyms(s) {
  const phrases = [];
  for (const group of SYNONYM_GROUPS) {
    const canon = group[0];
    for (const alt of group) phrases.push({ alt, canon, len: alt.length });
  }
  phrases.sort((a, b) => b.len - a.len);
  let out = '';
  for (let i = 0; i < s.length;) {
    const prev = i > 0 ? s[i - 1] : '';
    // "不是什么" contains "是什么"; folding it would invent a different question.
    let matched = null;
    if (prev !== '不' && prev !== '非') {
      for (const p of phrases) {
        if (s.startsWith(p.alt, i)) { matched = p; break; }
      }
    }
    if (matched) {
      out += matched.canon;
      i += matched.len;
    } else {
      out += s[i];
      i += 1;
    }
  }
  return out;
}

// Polite wrappers only. Stripped from both ends after synonym folding so
// "请问什么是 PCD 呢" matches "什么是 PCD", while "不是什么是 PCD" does not
// (generic token-containment would treat that pair as the same question).
const EDGE_WRAPPERS = ['请问一下', '请问', '麻烦', '请教', '一下', '吗', '呢', '呀', '啊'];

function stripWrappers(norm) {
  let s = norm;
  let changed = true;
  while (changed && s.length) {
    changed = false;
    for (const w of EDGE_WRAPPERS) {
      if (s.startsWith(w) && s.length - w.length >= 4) {
        s = s.slice(w.length);
        changed = true;
      }
      if (s.endsWith(w) && s.length - w.length >= 4) {
        s = s.slice(0, -w.length);
        changed = true;
      }
    }
  }
  return s;
}

function indexQuestion(question) {
  const norm = normalizeForSimilarity(question);
  const tokens = new Set();
  const ids = new Set();
  const words = norm.match(/[a-z][a-z0-9_]*/g) || [];
  for (const w of words) {
    tokens.add('w:' + w);
    if (w.length >= 2) ids.add(w);
  }
  const cjkRuns = norm.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) tokens.add('b:' + run.slice(i, i + 2));
  }
  return { norm, tokens, ids };
}

function sameIds(a, b) {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function intersectionSize(a, b) {
  let n = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) n += 1;
  return n;
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  const inter = intersectionSize(a, b);
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

/**
 * 0 when the questions must not share an answer, otherwise a similarity in
 * (0, 1]. Identifier mismatch (inf vs dec, pcd vs depex) forces 0.
 * Equality is tested after stripping polite edges. Token Jaccard is the only
 * other accept path — subset containment is intentionally not enough.
 */
function lexicalScore(left, right, cfg) {
  if (!left.norm || !right.norm) return 0;
  if (!sameIds(left.ids, right.ids)) return 0;
  const a = stripWrappers(left.norm);
  const b = stripWrappers(right.norm);
  if (a && a === b) return 1;
  if (a.length < 4 || b.length < 4) return 0;
  const jac = jaccard(left.tokens, right.tokens);
  if (jac >= cfg.jaccard) return jac;
  return 0;
}

function isFollowUpQuestion(question) {
  const s = String(question || '').trim();
  if (!s) return true;
  const compact = s.replace(/[\s?？!！。．]+/g, '');
  if (/^(继续|接着|然后呢|还有呢|还有吗|详细说说|展开说说|再说一下|再说说|补充一下|这个呢|那个呢|为什么呢|然后|好的|嗯|哦)$/.test(compact)) {
    return true;
  }
  if (/^(再)?(详细|展开|继续|补充)(一点|一下|说说|讲讲)?$/.test(compact)) return true;
  if (/^(tell me more|continue|elaborate|what about|go on)\b/i.test(s)) return true;
  if (/(上面|上述|刚才说|上一个问题|前面说的|继续说|详细说说|展开讲讲)/.test(s)) return true;
  if (/^(它|他们|它们)(的|和|与|跟|呢)?/.test(compact) && compact.length <= 24) return true;
  if (/^(这个|那个)(呢|啊)?$/.test(compact)) return true;
  if (/^(为什么|为何|怎么|如何)[呢啊呀]?$/.test(compact)) return true;
  if (compact.length <= 3 && !/[A-Za-z0-9]{2,}/.test(compact)) return true;
  return false;
}

function createAnswerCache(opts = {}) {
  const cfg = {
    max: opts.max != null ? opts.max : envInt('ANSWER_CACHE_MAX', 300),
    ttlMs: opts.ttlMs != null ? opts.ttlMs : envInt('ANSWER_CACHE_TTL_MS', 30 * 60 * 1000),
    jaccard: opts.jaccard != null ? opts.jaccard : envFloat('SIMILAR_CACHE_JACCARD', 0.72),
    lexicalEnabled: opts.lexicalEnabled != null
      ? opts.lexicalEnabled
      : process.env.SIMILAR_CACHE !== 'false',
    semanticThreshold: opts.semanticThreshold != null
      ? opts.semanticThreshold
      : envFloat('SEMANTIC_CACHE_THRESHOLD', 0.93),
    now: opts.now || Date.now,
  };
  const map = new Map();
  const loose = new Map();

  function strictKey(question, model) {
    return `${model || '?'}|${normalizeQuery(question)}`;
  }

  function looseKey(question, model) {
    return `${model || '?'}|${normalizeForSimilarity(question)}`;
  }

  function drop(key) {
    const entry = map.get(key);
    if (!entry) return;
    map.delete(key);
    if (loose.get(entry._loose) === key) loose.delete(entry._loose);
  }

  function live(key) {
    const entry = map.get(key);
    if (!entry) return null;
    if (cfg.now() - entry.timestamp >= cfg.ttlMs) {
      drop(key);
      return null;
    }
    return entry;
  }

  function touch(key, entry) {
    map.delete(key);
    map.set(key, entry);
    entry.hitCount = (entry.hitCount || 0) + 1;
    return entry;
  }

  function remember(entry) {
    const indexed = indexQuestion(entry.question);
    entry._norm = indexed.norm;
    entry._tokens = indexed.tokens;
    entry._ids = indexed.ids;
    entry._loose = `${entry.model || '?'}|${indexed.norm}`;
    entry._indexed = indexed;
  }

  return {
    cfg,
    get size() { return map.size; },

    store(question, model, data) {
      const key = strictKey(question, model);
      if (!map.has(key) && map.size >= cfg.max) {
        const oldest = map.keys().next().value;
        drop(oldest);
      }
      const entry = {
        ...data,
        question,
        model: model || '?',
        queryEmbedding: null,
        timestamp: cfg.now(),
        hitCount: 0,
      };
      remember(entry);
      map.delete(key);
      map.set(key, entry);
      loose.set(entry._loose, key);
      return entry;
    },

    attachEmbedding(entry, vec) {
      if (entry && Array.isArray(vec) && vec.length) entry.queryEmbedding = vec;
    },

    getExact(question, model) {
      const key = strictKey(question, model);
      const entry = live(key);
      if (!entry) return null;
      return touch(key, entry);
    },

    /**
     * Near-duplicate lookup. Does not call the network.
     * Returns { entry, similarity } or null.
     */
    getLexical(question, model) {
      if (!cfg.lexicalEnabled) return null;
      const indexed = indexQuestion(question);
      const lk = `${model || '?'}|${indexed.norm}`;
      const looseHitKey = loose.get(lk);
      if (looseHitKey) {
        const entry = live(looseHitKey);
        if (entry && entry.model === (model || '?')) {
          return { entry: touch(looseHitKey, entry), similarity: 1 };
        }
      }
      const probe = { norm: indexed.norm, tokens: indexed.tokens, ids: indexed.ids };
      let best = null;
      let bestKey = null;
      let bestScore = 0;
      for (const [key, entry] of map) {
        if (entry.model !== (model || '?')) continue;
        if (cfg.now() - entry.timestamp >= cfg.ttlMs) {
          drop(key);
          continue;
        }
        const score = lexicalScore(
          probe,
          { norm: entry._norm, tokens: entry._tokens, ids: entry._ids },
          cfg,
        );
        if (score > bestScore) {
          bestScore = score;
          best = entry;
          bestKey = key;
        }
      }
      if (!best) return null;
      return { entry: touch(bestKey, best), similarity: bestScore };
    },

    /**
     * Embedding lookup. `vec` is a unit vector (bge-m3 normalize_embeddings),
     * so cosine similarity is the dot product. Returns { entry, similarity }
     * or null. Similarity must be strictly above semanticThreshold.
     */
    bestSemantic(vec, model) {
      if (!Array.isArray(vec) || !vec.length) return null;
      const modelKey = model || '?';
      let best = null;
      let bestKey = null;
      let bestSim = cfg.semanticThreshold;
      const now = cfg.now();
      for (const [key, entry] of map) {
        if (entry.model !== modelKey) continue;
        if (now - entry.timestamp >= cfg.ttlMs) {
          drop(key);
          continue;
        }
        const e = entry.queryEmbedding;
        if (!Array.isArray(e) || e.length !== vec.length) continue;
        let dot = 0;
        for (let i = 0; i < e.length; i++) dot += e[i] * vec[i];
        if (dot > bestSim) {
          bestSim = dot;
          best = entry;
          bestKey = key;
        }
      }
      if (!best) return null;
      return { entry: touch(bestKey, best), similarity: bestSim };
    },
  };
}

module.exports = {
  createAnswerCache,
  isFollowUpQuestion,
  normalizeForSimilarity,
  normalizeQuery,
  indexQuestion,
  lexicalScore,
};
