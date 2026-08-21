#!/usr/bin/env python3
"""
EDK2 Search Engine - Dual Source Support
Reusable, thread-safe search engine with lazy ChromaDB loading.

Used by both the MCP daemon (mcp_server.py) and the CLI (embedded_search.py).
The index and vector model are loaded once and kept in memory, so repeated
searches do not pay per-request model loading costs.
"""

import hashlib
import json
import os
import re
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_DATA_DIR = BASE_DIR / "data"

# ------------------------------------------------------------------ #
# Structured latency tracing (JSON lines). Written to a shared trace
# file so the supervisor (which runs the MCP server with stdout/stderr
# = DEVNULL) still captures the timings; also mirrored to stderr for
# direct (non-supervised) runs. Kept dependency-free and synchronous
# so the per-stage instrumentation overhead stays negligible (two
# monotonic() reads + one file append per stage).
# ------------------------------------------------------------------ #
DEFAULT_TRACE_FILE = Path.home() / ".edk2-opencode" / "kb" / "trace.jsonl"
TRACE_FILE = Path(os.environ.get("EDK2_TRACE_FILE", str(DEFAULT_TRACE_FILE)))
_TRACE_LOCK = threading.Lock()

def trace_new_id() -> str:
    return uuid.uuid4().hex[:16]


def trace_query_hash(query: str) -> str:
    q = " ".join((query or "").strip().lower().split())
    return hashlib.sha1(q.encode("utf-8", "ignore")).hexdigest()[:12]


def trace_emit(trace_id: Optional[str], stage: str, duration_ms: float,
               query_hash: str, status: str = "ok", **extra: Any) -> None:
    record = {
        "trace_id": trace_id or trace_new_id(),
        "stage": stage,
        "duration_ms": round(float(duration_ms), 2),
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "query_hash": query_hash,
        "status": status,
    }
    for k, v in extra.items():
        record[k] = v
    line = json.dumps(record, ensure_ascii=False)
    try:
        with _TRACE_LOCK:
            TRACE_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(TRACE_FILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except Exception:
        pass
    try:
        sys.stderr.write(line + "\n")
        sys.stderr.flush()
    except Exception:
        pass

SOURCE_DISPLAY = {
    'tianocore-wiki': 'TianoCore Wiki (官网)',
    'tianocore-docs': 'tianocore-docs (仓库)',
}

# Embedding model used for retrieval. BAAI/bge-m3 (~2.3GB) is the default:
# it is multilingual (much better Chinese recall than the English-only
# all-MiniLM-L6-v2) and its 1024-dim vectors align with the bge-reranker
# scores. Prefer a locally installed copy under
# ~/.edk2-opencode/models/bge-m3; override via EDK2_EMBEDDING_MODEL / DEVICE.
def _default_embedding_model() -> str:
    local = Path.home() / ".edk2-opencode" / "models" / "bge-m3"
    if local.exists():
        return str(local)
    return "BAAI/bge-m3"


EMBEDDING_MODEL = os.environ.get(
    "EDK2_EMBEDDING_MODEL") or _default_embedding_model()
EMBEDDING_DEVICE = os.environ.get("EDK2_EMBEDDING_DEVICE", "cpu")

def _default_reranker_model() -> str:
    # Prefer a locally installed model directory under the user KB area so a
    # downloaded bge-reranker-v2-m3 works without needing the HF cache
    # (~/.edk2-opencode/models/bge-reranker-v2-m3/). Falls back to the HF
    # model id for environments where the model is cached by huggingface_hub.
    local = Path.home() / ".edk2-opencode" / "models" / "bge-reranker-v2-m3"
    if local.exists():
        return str(local)
    return "BAAI/bge-reranker-v2-m3"


# Reranker (cross-encoder) used to reorder the initial retrieval candidates.
# bge-reranker-v2-m3 (multilingual, ~2.2GB) is the default: it is much more
# sensitive to EDK2 terms and to non-English queries than the old
# ms-marco-MiniLM-L-6-v2. Switch back with EDK2_RERANKER_MODEL=
# cross-encoder/ms-marco-MiniLM-L-6-v2 (or any other local cached model).
# local_files_only=True below guarantees search never blocks on a model
# download (a missing/corrupt model simply skips reranking).
RERANKER_MODEL = os.environ.get(
    "EDK2_RERANKER_MODEL") or _default_reranker_model()
RERANKER_DEVICE = os.environ.get("EDK2_RERANKER_DEVICE", "cpu")
# bge-reranker-v2-m3 supports long passages (up to 8192 tokens); ms-marco
# MiniLM caps at 512. 1024 is a safe middle ground; tune via env var.
RERANKER_MAX_LENGTH = int(os.environ.get("EDK2_RERANKER_MAX_LENGTH", "1024"))

# Hybrid rerank: the final ordering blends the cross-encoder score with the
# reciprocal-rank-fusion (RRF) score from dense+BM25 retrieval. The reranker
# alone can badly misjudge a chunk whose 500-char snippet omits the query's
# keywords, so keeping a small RRF weight protects high-confidence retrieval
# hits. 0.15 was tuned on the manual eval set (109 -> 116 hit@5).
RERANK_HYBRID_BETA = float(os.environ.get("EDK2_RERANK_HYBRID_BETA", "0.15"))

# RRF fallback: if a document ranks in the top-N of the pure RRF list but the
# reranker pushed it out of the top-5, force it back in (replacing the weakest
# top-5 entry). Rescues queries where the reranker misses but both retrieval
# legs agree (e.g. Chinese PCD queries, rrf_rank=1 but rerank_rank=7).
RERANK_RRF_FALLBACK_TOPK = int(
    os.environ.get("EDK2_RERANK_RRF_FALLBACK_TOPK", "2"))

# Keyword (BM25/FTS5) boost applied in reciprocal-rank fusion. EDK2 docs are
# full of exact identifiers, commit rules, and spec keywords that the dense
# embeddings blur, so BM25 hits are weighted higher than dense hits by default.
# Set EDK2_BM25_WEIGHT=1 to equalize the two retrieval legs.
BM25_WEIGHT = float(os.environ.get("EDK2_BM25_WEIGHT", "1.5"))

# Hard cap on the candidate set handed to the reranker: retrieval keeps at
# most this many candidates, so the expensive cross-encoder work is bounded
# and both the JSON payload and the HTTP transfer stay small.
MAX_CANDIDATES = int(os.environ.get("EDK2_MAX_CANDIDATES", "200"))


def _minmax(values):
    lo, hi = min(values), max(values)
    if hi - lo < 1e-9:
        return [0.5] * len(values)
    return [(v - lo) / (hi - lo) for v in values]


def _doc_key(item):
    return (item.get('source'), item.get('file') or item.get('title'))

# Confidence thresholds are model-specific. bge rerankers emit a sigmoid
# relevance in [0, 1]; ms-marco emits unbounded logits (observed: >4 strong,
# 2-4 relevant, 0-2 weak, <0 unrelated). Thresholds are tuned to the
# observed score distributions in eval/RESULTS.md.
_RERANK_SCALES = {
    "bge": {"high": 0.5, "medium": 0.2, "low": 0.05},
    "msmarco": {"high": 4.0, "medium": 2.0, "low": 0.0},
}


def _rerank_scale(model: Optional[str]) -> dict:
    m = (model or "").lower()
    if "bge" in m:
        return _RERANK_SCALES["bge"]
    return _RERANK_SCALES["msmarco"]

# EDK2 Technical term expansion for better retrieval
TERM_EXPANSIONS = {
    'PCD': 'Platform Configuration Database PCD',
    'DSC': 'Platform Description DSC',
    'DEC': 'Package Declaration DEC',
    'INF': 'Module Information INF',
    'FDF': 'Flash Description FDF',
    'HII': 'Human Interface Infrastructure HII',
    'DXE': 'Driver Execution Environment DXE',
    'PEI': 'Pre-EFI Initialization PEI',
    'SMM': 'System Management Mode SMM',
    'UEFI': 'Unified Extensible Firmware Interface UEFI',
    'GUID': 'Globally Unique Identifier GUID',
    'FV': 'Firmware Volume FV',
    'FD': 'Firmware Device FD',
    'PPI': 'PEIM-to-PEIM Interface PPI',
    'GOP': 'Graphics Output Protocol GOP',
    'SCT': 'Self Certification Test SCT',
    'Depex': 'Depex dependency expression',
    'Depex]': 'Depex dependency expression',
    'Uncrustify': 'Uncrustify code formatting',
    'MODULE_TYPE': 'MODULE_TYPE module type',
    'ENTRY_POINT': 'ENTRY_POINT entry point',
    'Supported': 'Supported() Supported Driver Binding Protocol',
    'Start': 'Start() Start Driver Binding Protocol',
    'Stop': 'Stop() Stop Driver Binding Protocol',
    'PcdGet': 'PcdGet PCD access function',
    'PatchCheck': 'PatchCheck PatchCheck.py patch format',
    'AutoGen': 'AutoGen AutoGen.c AutoGen.h',
    'NumberOfChildren': 'NumberOfChildren ChildHandleBuffer Stop',
    'RemainingDevicePath': 'RemainingDevicePath RemainingDevicePath',
}

# Chinese -> English keyword hints for retrieval.  Query text that is mostly
# Chinese carries no ASCII tokens the vector/BM25 legs can match, so each
# detected Chinese technical term appends English keywords to the rewritten
# query. Ordered longest-first so compound phrases win over single chars.
CJK_KEYWORD_MAP = {
    '编译/链接': 'build compile link error',
    '编译': 'build compile',
    '链接': 'link',
    '报错': 'build error error message',
    '报错怎么修': 'common build module breaks build error fix',
    '怎么修': 'how to fix build error',
    '会跑哪些检查': 'EDK II Continuous Integration CI check plugin',
    '谁来': 'maintainer reviewer code review',
    '合进': 'merge master maintainer process pull request',
    '提上去': 'pull request submit',
    '格式化': 'format formatting uncrustify',
    '命名规范': 'naming convention identifier quick reference',
    '命名': 'naming identifier',
    '硬性要求': 'hard requirements rules quick reference',
    '只编译': 'build only specific module target',
    '怎么选': 'select choose module type',
    '分别怎么写': 'syntax how to write',
    '怎么写': 'how to write syntax',
    '职责边界': 'responsibility boundary driver binding supported start stop',
    '返回码': 'return status EFI_STATUS error code',
    '按什么顺序': 'order sequence start stop',
    '顺序': 'order sequence',
    '怎么用': 'usage how to use',
    '自己写的那个': 'own module',
    '告诉构建系统': 'entry point build system',
    '流程控制': 'flow control statement goto',
    '依赖': 'dependency expression depex',
    '驱动': 'driver',
    '库实例': 'library instance',
    '库类': 'library class',
    '模块类型': 'module type MODULE_TYPE',
    '模块': 'module',
    '平台': 'platform',
    '协议': 'protocol',
    '入口函数': 'entry point ENTRY_POINT',
    '入口': 'entry point',
    '函数': 'function',
    '注释': 'comment',
    '调试': 'debug',
    '打印': 'print debug message',
    '签名': 'signature Signed-off-by commit',
    '提交信息': 'commit message',
    '提交': 'commit',
    '拆分': 'partition commit partitioning',
    '贡献': 'contribute contribution',
    '评审': 'code review reviewer',
    '合入': 'merge Mergify',
    '合并': 'merge',
    '目录': 'directory',
    '标识符': 'identifier',
    '变量': 'variable',
    '结构体': 'structure struct typedef',
    '枚举': 'enum',
    '断言': 'assert ASSERT',
    '加载': 'load',
    '卸载': 'unload',
    '子句柄': 'child handle',
    '父协议': 'parent protocol',
    '打开': 'open protocol OpenProtocol',
    '关闭': 'close CloseProtocol',
    '属性': 'attribute',
    '构造函数': 'constructor',
    '入口点': 'entry point',
    '类型': 'type',
    '段': 'section',
    '镜像': 'flash image FD FV',
    '目录名': 'directory name Ia32',
    '大小写': 'case sensitive',
}


def _cjk_keywords(query: str) -> List[str]:
    """Collect English keyword hints from Chinese technical terms in query."""
    hints: List[str] = []
    for term, kw in CJK_KEYWORD_MAP.items():
        if term in query and kw not in hints:
            hints.append(kw)
    return hints


def rewrite_query(query: str) -> str:
    """Expand EDK2 technical terms for better retrieval.

    Two expansions are applied:
      1. English EDK2 identifiers / acronyms -> verbose phrase (TERM_EXPANSIONS)
      2. Chinese technical terms -> English keyword hints (CJK_KEYWORD_MAP).
         Hints are always appended: retrieval legs are English-tokenized, so a
         Chinese query that carries no ASCII tokens cannot match anything, and
         the hints only add candidate diversity for the reranker to sort.

    Args:
        query: Original user query

    Returns:
        Query with expanded technical terms
    """
    expanded = query
    for term, expansion in TERM_EXPANSIONS.items():
        # Match term as standalone word (case-sensitive)
        pattern = r'\b' + re.escape(term) + r'\b'
        if re.search(pattern, query):
            expanded = re.sub(pattern, expansion, expanded)

    hints = _cjk_keywords(query)
    if hints:
        expanded = expanded + ' ' + ' '.join(hints)

    return expanded


# FTS5 keyword search (SQLite, stdlib) fused with the vector index at query
# time. unicode61 splits EDK2 identifiers like EFI_CPU_ARCH_PROTOCOL into
# [efi, cpu, arch, protocol] tokens, so precise terms still match.
_FTS_STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "with",
    "is", "are", "was", "were", "be", "been", "being", "this", "that",
    "these", "those", "from", "by", "as", "at", "it", "its", "into", "via",
}


def _camel_split(word: str) -> List[str]:
    """Split camelCase / PascalCase identifiers into sub-words.

    PcdDebugPrintErrorLevel -> [Pcd, Debug, Print, Error, Level]
    (snake_case identifiers are already split on '_' by the caller.)
    """
    return re.findall(r'[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+', word)


# FTS5 query shaping. Prefix wildcards ('token*') force a range scan per term
# and, once OR-joined across many terms, turn the whole 70k-row corpus into a
# scan -- measured at 85-180s for verbose merged queries. Instead the strict
# query uses exact tokens (fast inverted-index lookups), groups the content
# words into "topics" of up to _FTS_TOPIC_SIZE words (OR within a topic, since
# they are paraphrases/alternatives), and returns each topic as an independent
# sub-query so the caller can run them separately with their own LIMIT
# (multi-topic -> several cheap sub-queries, merged top-k each).
_FTS_MAX_TERMS = int(os.environ.get("EDK2_FTS_MAX_TERMS", "12"))
_FTS_TOPIC_SIZE = int(os.environ.get("EDK2_FTS_TOPIC_SIZE", "3"))


def _fts_query_exprs(query: str, relaxed: bool = False) -> List[str]:
    """Build one or more FTS5 MATCH expressions for a query.

    FTS5's unicode61 tokenizer does NOT split camelCase identifiers
    (PcdDebugPrintErrorLevel -> one token 'pcddebugprinterrorlevel') but DOES
    split snake_case on '_'. To catch both, each whitespace-delimited word
    becomes an OR of its exact whole-word form and (when it has >=2 camel
    sub-words) an AND of the exact sub-words. Common English words are dropped
    so a long natural-language query does not require every trivial token to
    match. The term list is capped at _FTS_MAX_TERMS (the query is
    relevance-ordered by the caller: translation first, then weighted keyword
    expansions, so the most specific terms come first).

    Strict mode returns the topic sub-queries (words within a topic are
    OR-joined). Short queries (<= _FTS_TOPIC_SIZE words) collapse into a single
    AND-ed expression. relaxed=True restores the legacy broad OR-join with
    prefix wildcards, used only as a zero-hit fallback so a very verbose
    query still returns candidates for the reranker.

    Non-ASCII words (Chinese, full-width punctuation) are dropped entirely:
    the FTS5 index is tokenized in English, so a Chinese character appended
    with AND would silently kill every query that contains one.
    """
    words = [w for w in re.split(r'[\s\W]+', query) if w]
    clauses: List[str] = []
    for w in words:
        wl = w.lower()
        if wl in _FTS_STOPWORDS or len(wl) < 2:
            continue
        if not re.search(r'[a-z]', wl):
            continue
        suffix = '*' if relaxed else ''
        inner = [wl + suffix]
        subs = [p.lower() for p in _camel_split(w)
                if len(p) >= 2 and p.lower() not in _FTS_STOPWORDS]
        if len(subs) >= 2:
            inner.append('(' + ' AND '.join(s + suffix for s in subs) + ')')
        clauses.append('(' + ' OR '.join(inner) + ')')
    if not clauses:
        return []
    clauses = clauses[:_FTS_MAX_TERMS]
    if relaxed:
        return [' OR '.join(clauses)]
    if len(clauses) <= _FTS_TOPIC_SIZE:
        return [' AND '.join(clauses)]
    return [
        ' OR '.join(clauses[i:i + _FTS_TOPIC_SIZE])
        for i in range(0, len(clauses), _FTS_TOPIC_SIZE)
    ]


def _fts_query_expr(query: str, relaxed: bool = False) -> str:
    """Single-string view of _fts_query_exprs (all topics AND-ed)."""
    exprs = _fts_query_exprs(query, relaxed=relaxed)
    if not exprs:
        return ""
    if len(exprs) == 1:
        return exprs[0]
    return ' AND '.join('(' + e + ')' for e in exprs)


def _fts_tokens(query: str) -> List[str]:
    """Tokenize a query like FTS5 unicode61 does, expanding camelCase ids."""
    tokens: List[str] = []
    for word in re.split(r'[\s\W_]+', query):
        for part in _camel_split(word):
            p = part.lower()
            if len(p) >= 2 and p not in _FTS_STOPWORDS:
                tokens.append(p)
    return tokens


def _confidence(rerank_score: Optional[float],
                model: Optional[str] = None) -> str:
    """Map a reranker score to a coarse confidence label.

    Thresholds depend on the reranker family (see ``_rerank_scale``): bge
    rerankers output sigmoid relevance in [0, 1]; ms-marco outputs unbounded
    logits.
    """
    if rerank_score is None:
        return "unrated"
    s = _rerank_scale(model)
    if rerank_score > s["high"]:
        return "high"
    if rerank_score > s["medium"]:
        return "medium"
    if rerank_score > s["low"]:
        return "low"
    return "poor"


def _doc_type(r: Dict[str, Any]) -> str:
    """Classify a result so the LLM/web UI can distinguish authoritative spec
    documents from guides, advisories, or wiki web pages."""
    source = r.get('source', '')
    if source == 'tianocore-wiki':
        return 'webpage'
    if source == 'tianocore-docs':
        f = (r.get('file') or r.get('title') or '').lower()
        repo = (r.get('repo') or '').lower()
        blob = f + ' ' + repo
        if 'specification' in blob or '-spec' in blob or 'spec' in repo:
            return 'spec'
        if 'advisory' in blob or 'security' in repo:
            return 'advisory'
        if 'training' in blob or 'guide' in blob or 'lab' in blob:
            return 'guide'
        return 'docs'
    return source or 'docs'


def _add_citation(results: List[Dict[str, Any]],
                  model: Optional[str] = None) -> List[Dict[str, Any]]:
    """Attach a ready-to-cite markdown reference to each result.

    Format: ``[Title - Section](url)`` (url omitted when unknown). The LLM
    can paste this verbatim to back every factual claim. Also tags each
    result with a ``confidence`` label derived from its reranker score and a
    ``type`` label (spec/guide/advisory/webpage) so structured answers can
    weight authoritative spec documents higher.
    """
    for r in results:
        parts = [p for p in (r.get('title') or r.get('file') or '',
                             r.get('section') or '') if p]
        cite = ' - '.join(parts)
        url = r.get('url')
        if url and cite:
            r['citation'] = f"[{cite}]({url})"
        elif cite:
            r['citation'] = cite
        else:
            r['citation'] = url or ''
        r['confidence'] = _confidence(r.get('rerank_score'), model)
        r['type'] = _doc_type(r)
    return results


class SearchEngine:
    """Thread-safe EDK2 knowledge base search engine.

    ChromaDB is loaded lazily (first access or background pre-warm) and held
    in memory for the lifetime of the process.
    """

    def __init__(self, data_dir: Optional[Path] = None, preload: bool = False):
        self.data_dir = Path(data_dir) if data_dir else DEFAULT_DATA_DIR
        self.chroma_dir = self.data_dir / "chroma_db"
        self.processed_dir = self.data_dir / "processed"

        self._lock = threading.RLock()
        self._ready = False
        self._load_error: Optional[str] = None
        self._rerank_error: Optional[str] = None
        self._documents: List[Dict[str, Any]] = []
        self._collection = None
        self._client = None
        self._fts_conn = None
        self._fts_available = False

        if preload:
            self.start_preload()

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #

    def start_preload(self) -> None:
        """Load the index in a background thread (daemon startup)."""
        threading.Thread(target=self._safe_load, daemon=True,
                         name="kb-preload").start()

    def _safe_load(self) -> None:
        try:
            self.load()
        except Exception as e:  # pragma: no cover - defensive
            with self._lock:
                self._load_error = str(e)

    def load(self) -> None:
        """Load the ChromaDB index. Idempotent and thread-safe.

        The embedding model is only constructed when a ChromaDB index
        actually exists. Without an index the lightweight document-file
        fallback is used, so /health never blocks on a (possibly failing)
        model download/load.
        """
        with self._lock:
            if self._ready:
                return
            if not self.chroma_dir.exists():
                self._load_documents_index()
                self._connect_fts()
                self._ready = True
                return
            try:
                import chromadb
                from chromadb.utils import embedding_functions
                
                # Use the same embedding model used during indexing.
                # local_files_only keeps the daemon fully offline: a missing
                # cached model raises immediately and we fall back to file
                # search instead of blocking on a network download.
                embedding_func = embedding_functions.SentenceTransformerEmbeddingFunction(
                    model_name=EMBEDDING_MODEL,
                    device=EMBEDDING_DEVICE,
                    normalize_embeddings=True,
                    local_files_only=True
                )
                
                self._client = chromadb.PersistentClient(
                    path=str(self.chroma_dir))
                self._collection = self._client.get_or_create_collection(
                    "edk2_docs",
                    embedding_function=embedding_func
                )
                # Detect an index/embedder dimension mismatch (e.g. the index
                # was built with the old 384-dim all-MiniLM but the embedder
                # now emits 1024-dim bge-m3 vectors) and degrade gracefully to
                # file search with a clear error instead of failing every query.
                try:
                    probe = self._collection.peek(limit=1)
                    embs = probe.get("embeddings")
                    if embs is None:
                        embs = []
                    if len(embs) and embs[0] is not None:
                        idx_dim = len(embs[0])
                        emb_dim = len(embedding_func(["x"])[0])
                        if idx_dim != emb_dim:
                            raise ValueError(
                                f"index dim {idx_dim} != embedder dim "
                                f"{emb_dim}; rebuild the index with "
                                f"EDK2_EMBEDDING_MODEL={EMBEDDING_MODEL}")
                except ValueError as e:
                    raise e
                except Exception:
                    pass
                # Also load the document index so BM25 results can return the
                # full chunk text (FTS stores only a short snippet).
                self._load_documents_index()
            except ImportError:
                self._load_documents_index()
            except Exception as e:
                # If the embedding model fails to load, degrade gracefully to
                # the document-file fallback instead of blocking startup.
                self._load_documents_index()
                self._load_error = f"ChromaDB unavailable ({e}); using file search"
            self._connect_fts()
            self._ready = True

    def is_ready(self) -> bool:
        with self._lock:
            return self._ready

    @property
    def load_error(self) -> Optional[str]:
        with self._lock:
            return self._load_error

    # Cached embedding function (lazy; mirrors the model used at index time so
    # query embeddings stay consistent with the stored document vectors).
    _embedding_func = None

    def _get_embedding_func(self):
        if SearchEngine._embedding_func is None:
            from chromadb.utils import embedding_functions
            SearchEngine._embedding_func = (
                embedding_functions.SentenceTransformerEmbeddingFunction(
                    model_name=EMBEDDING_MODEL,
                    device=EMBEDDING_DEVICE,
                    normalize_embeddings=True,
                    local_files_only=True,
                ))
        return SearchEngine._embedding_func

    def embed_query(self, text: str) -> List[float]:
        """Return the normalized dense embedding of ``text`` (bge-m3, 1024-dim).

        Used by the web service for semantic answer-cache lookups. Raises if the
        embedding model is unavailable so the caller can degrade gracefully to
        the exact-match cache / live generation.
        """
        ef = self._get_embedding_func()
        vec = ef([text])
        row = vec[0]
        try:
            return [float(x) for x in row]
        except TypeError:
            # numpy row: convert element-wise.
            return [float(x) for x in row.tolist()]

    def ensure_ready(self, timeout: float = 120.0) -> None:
        """Block until the index is loaded (or timeout)."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.is_ready():
                return
            time.sleep(0.1)
        raise TimeoutError(
            f"Knowledge base index load timed out after {timeout}s: "
            f"{self._load_error or 'unknown error'}")

    # ------------------------------------------------------------------ #
    # Search
    # ------------------------------------------------------------------ #

    def search(self, query: str, top_k: int = 5,
               source_filter: Optional[str] = None,
               rerank: bool = True,
               rewrite: bool = True,
               dedup: bool = True,
               trace_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """Search the knowledge base with hybrid retrieval.

        Dense vector search (ChromaDB) and keyword BM25 search (SQLite FTS5)
        are both run and merged with reciprocal rank fusion, so precise EDK2
        identifiers (GUIDs, PCD/API names) that vectors miss are still found
        via the keyword index, while paraphrased queries are caught by the
        vector index.

        Args:
            query: Search query text.
            top_k: Maximum number of results to return.
            source_filter: Optional source restriction, one of
                'tianocore-wiki', 'tianocore-docs', or None for all.
            rerank: When True (default), reorder candidates with the
                cross-encoder reranker. Set False to compare baselines.
            rewrite: When True (default), expand technical terms (and, for
                Chinese-dominated queries, append English keyword hints)
                before retrieval. Set False to compare baselines.
            dedup: When True (default), collapse to the single best chunk per
                document. When False, keep multiple chunks per document
                (distinct sections survive), so enumerative multi-section
                questions can collect several chapters of one doc.
            trace_id: Correlation id propagated from the caller (web service
                X-Trace-Id header); a fresh one is generated when omitted.
        """
        trace_id = trace_id or trace_new_id()
        qh = trace_query_hash(query)

        # Rewrite query to expand technical terms
        _t = time.monotonic()
        expanded_query = rewrite_query(query) if rewrite else query
        trace_emit(trace_id, "query_rewrite",
                   (time.monotonic() - _t) * 1000, qh,
                   status="ok", rewritten=bool(rewrite))

        self.load()
        if self._collection is not None:
            # Multi-query retrieval: run both the original and the expanded
            # query so each index contributes more diverse candidates.
            queries = list(dict.fromkeys([query, expanded_query]))
            groups: List[List[Dict[str, Any]]] = []
            chroma_cands = min(top_k * 6, MAX_CANDIDATES)
            bm25_cands = min(top_k * 3, MAX_CANDIDATES)
            _chroma_ms = 0.0
            _bm25_ms = 0.0
            _t = time.monotonic()
            for q in queries:
                _t0 = time.monotonic()
                groups.append(self._search_chroma(q, chroma_cands, source_filter))
                _chroma_ms += (time.monotonic() - _t0) * 1000
                _t0 = time.monotonic()
                groups.append(self._search_bm25(q, bm25_cands, source_filter))
                _bm25_ms += (time.monotonic() - _t0) * 1000
            # Fusion: dense-first (chroma) ordering with BM25 supplements.
            # Pure reciprocal-rank fusion over both legs was measured to LOSE
            # reference hits on Chinese queries (24/62 vs 30/62 for chroma
            # alone): the BM25 noise candidates dilute the high-quality dense
            # ranks. So dense results keep priority and BM25 only fills in
            # documents the dense leg missed (exact EDK2 identifiers, PCD/GUID
            # names the embeddings blur), never displacing dense hits.
            candidates = self._fuse_dense_first(
                groups, min(top_k * 3, MAX_CANDIDATES), dedup=dedup)
            # BM25 candidates currently carry only pid+score; read their full
            # chunk text now, for the surviving set only (deferred 回表).
            self._attach_content(candidates)
            _retrieval_ms = (time.monotonic() - _t) * 1000
            trace_emit(trace_id, "chroma_vector", _chroma_ms, qh,
                       status="ok", queries=len(queries))
            trace_emit(trace_id, "bm25_fts", _bm25_ms, qh,
                       status="ok", queries=len(queries))
            trace_emit(trace_id, "hybrid_retrieval", _retrieval_ms, qh,
                       status="ok", candidates=len(candidates))

            # Rerank any non-empty candidate list, so even out-of-scope
            # queries get a rerank_score/confidence label that tells the LLM
            # the knowledge base does not cover them.
            if rerank and candidates:
                _t = time.monotonic()
                reranked = self._rerank_results(query, candidates, top_k)
                trace_emit(trace_id, "rerank",
                           (time.monotonic() - _t) * 1000, qh,
                           status="error" if self._rerank_error else "ok",
                           top_k=top_k)
                return _add_citation(reranked, RERANKER_MODEL)
            # No-rerank path: by default collapse chunks that belong to the
            # same document (first/highest chunk wins) so the LLM/web UI does
            # not see the same page repeated across chunks. With dedup=False
            # distinct sections of one document survive (multi-section
            # enumerative questions).
            results: List[Dict[str, Any]] = []
            seen = set()
            for c in candidates:
                if c is None:
                    continue
                if dedup:
                    k = _doc_key(c)
                else:
                    k = (_doc_key(c)[0], _doc_key(c)[1], c.get('section') or '')
                if k in seen:
                    continue
                seen.add(k)
                results.append(c)
                if len(results) >= top_k:
                    break
            return _add_citation(results, RERANKER_MODEL)
        _t = time.monotonic()
        results = self._search_files(expanded_query, top_k, source_filter)
        trace_emit(trace_id, "file_search",
                   (time.monotonic() - _t) * 1000, qh,
                   status="ok", results=len(results))
        return _add_citation(results, RERANKER_MODEL)
    
    def _rerank_results(self, query: str, candidates: List[Dict], 
                        top_k: int) -> List[Dict]:
        """Rerank search results using cross-encoder.

        Args:
            query: Original query (not expanded)
            candidates: Initial search results
            top_k: Number of results to return
        
        Returns:
            Reranked top_k results
        """
        self._rerank_error = None
        try:
            from sentence_transformers import CrossEncoder
            
            # Load reranker model (lazy, only when needed). local_files_only
            # prevents any network download here: a missing or incomplete
            # cached model raises immediately and we fall back to the raw
            # candidates instead of blocking the request.
            if not hasattr(self, '_reranker'):
                self._reranker = CrossEncoder(
                    RERANKER_MODEL,
                    max_length=RERANKER_MAX_LENGTH,
                    device=RERANKER_DEVICE,
                    local_files_only=True,
                )
            
            # Prepare query-document pairs
            pairs = [(query, c['snippet']) for c in candidates]
            
            # Score with cross-encoder
            rer_scores = self._reranker.predict(pairs)
            rer_scores = list(rer_scores)
            rrf_vals = [float(c.get('rrf', 0.0)) for c in candidates]

            # Blend the cross-encoder score with the RRF retrieval score:
            # min-max normalize each to [0, 1] so the weights are comparable
            # across reranker score scales (bge sigmoid vs ms-marco logits).
            rer_n = _minmax(rer_scores)
            rrf_n = _minmax(rrf_vals)
            fused = [
                (1.0 - RERANK_HYBRID_BETA) * a + RERANK_HYBRID_BETA * b
                for a, b in zip(rer_n, rrf_n)
            ]

            # Sort by fused score, keep the raw rerank score for confidence.
            scored = list(zip(candidates, fused, rer_scores))
            scored.sort(key=lambda x: x[1], reverse=True)

            # Deduplicate by source document (a single file may have several
            # matching chunks), keeping the highest-scoring chunk per doc.
            results = []
            seen_docs = set()
            fused_by_doc = {}
            for candidate, fscore, rscore in scored:
                doc_key = _doc_key(candidate)
                fused_by_doc.setdefault(doc_key, fscore)
                if doc_key in seen_docs:
                    continue
                seen_docs.add(doc_key)
                candidate['rerank_score'] = float(rscore)
                candidate.pop('rrf', None)
                results.append(candidate)
                if len(results) >= top_k:
                    break

            # RRF fallback: if a top-N RRF document was pushed out of the
            # top-5 by the reranker, force it back in (replace the weakest
            # top-5 entry). Both retrieval legs agreeing is a strong signal
            # the reranker is wrong (typically a bad 500-char snippet).
            if len(results) >= 5 and RERANK_RRF_FALLBACK_TOPK > 0:
                rrf_order = sorted(
                    range(len(candidates)),
                    key=lambda i: rrf_n[i], reverse=True
                )[:RERANK_RRF_FALLBACK_TOPK]
                top5 = results[:5]
                top5_keys = {_doc_key(c) for c in top5}
                rest = results[5:]
                for idx in rrf_order:
                    candidate = candidates[idx]
                    dk = _doc_key(candidate)
                    if dk in top5_keys:
                        continue
                    rest = [x for x in rest if _doc_key(x) != dk]
                    weakest = min(
                        range(5),
                        key=lambda i: fused_by_doc.get(_doc_key(top5[i]), 0.0),
                    )
                    weak_dk = _doc_key(top5[weakest])
                    top5[weakest] = candidate
                    candidate.pop('rrf', None)
                    top5_keys.discard(weak_dk)
                    top5_keys.add(dk)
                results = top5 + rest

            return results
            
        except Exception as e:
            # If reranking fails, return original candidates
            self._rerank_error = str(e)
            return candidates[:top_k]

    def _search_chroma(self, query: str, top_k: int,
                       source_filter: Optional[str]) -> List[Dict[str, Any]]:
        try:
            where_filter = None
            if source_filter:
                where_filter = {"source": source_filter}

            results = self._collection.query(
                query_texts=[query],
                n_results=top_k * 2 if not source_filter else top_k,
                where=where_filter,
            )

            documents: List[Dict[str, Any]] = []
            if results and results.get('documents'):
                seen_sources = set()

                for i, doc in enumerate(results['documents'][0]):
                    metadata = (results['metadatas'][0][i]
                                if results.get('metadatas') else {})
                    source = metadata.get('source', 'unknown')

                    if source_filter and source != source_filter:
                        continue

                    source_key = f"{source}:{metadata.get('file') or metadata.get('title', '')}:{metadata.get('section', '')}"
                    if source_key in seen_sources:
                        continue
                    seen_sources.add(source_key)

                    pid = None
                    try:
                        cid = results['ids'][0][i]
                        if cid.startswith('doc_'):
                            pid = int(cid[4:])
                    except (KeyError, IndexError, TypeError, ValueError):
                        pass

                    documents.append({
                        '_pid': pid,
                        'score': round(
                            1.0 - results['distances'][0][i], 4
                        ) if results.get('distances') else 0.5,
                        'source': source,
                        'source_display': self._format_source(source),
                        'title': metadata.get('title',
                                              metadata.get('file', 'Unknown')),
                        'url': metadata.get('url', ''),
                        'file': metadata.get('file', ''),
                        'section': metadata.get('section', ''),
                        'snippet': doc[:800],
                        'content': doc,
                    })

                    if len(documents) >= top_k:
                        break

            return documents
        except Exception:
            return self._search_files(query, top_k, source_filter)

    def _search_files(self, query: str, top_k: int,
                      source_filter: Optional[str]) -> List[Dict[str, Any]]:
        results: List[Dict[str, Any]] = []
        query_lower = query.lower()
        query_terms = set(query_lower.split())

        for doc in self._documents:
            if source_filter and doc.get('source') != source_filter:
                continue

            doc_path = doc.get('path', '')
            if not os.path.exists(doc_path):
                continue

            try:
                with open(doc_path, 'r', encoding='utf-8') as f:
                    content = f.read().lower()

                score = sum(1 for term in query_terms if term in content)
                if score > 0:
                    results.append({
                        'score': score,
                        'source': doc.get('source', 'unknown'),
                        'source_display': self._format_source(
                            doc.get('source', 'unknown')),
                        'title': doc.get('title', doc.get('file', 'Unknown')),
                        'url': doc.get('url', ''),
                        'file': doc.get('file', ''),
                        'section': doc.get('section', ''),
                        'snippet': self._extract_snippet(
                            content, query_terms)[:500],
                    })
            except Exception:
                continue

        results.sort(key=lambda x: x['score'], reverse=True)
        return results[:top_k]

    # ------------------------------------------------------------------ #
    # Hybrid retrieval (vector + FTS5 keyword + RRF)
    # ------------------------------------------------------------------ #

    def _connect_fts(self) -> None:
        """Open the SQLite FTS5 keyword index (best-effort)."""
        if self._fts_conn is not None:
            return
        fts_db = self.data_dir / "fts_index.db"
        if not fts_db.exists():
            return
        try:
            import sqlite3
            # The connection may be created by the background preload thread
            # but used from request threads, so disable the same-thread check.
            self._fts_conn = sqlite3.connect(
                str(fts_db), check_same_thread=False)
            self._fts_available = True
        except Exception:
            self._fts_conn = None
            self._fts_available = False

    def _search_bm25(self, query: str, top_k: int,
                     source_filter: Optional[str]) -> List[Dict[str, Any]]:
        """Keyword search against the SQLite FTS5 index (BM25 ranking).

        Only ``pid`` + BM25 score are selected here -- no ``snippet()`` call
        and no per-row file read (avoiding the "go back to the table" cost that
        used to read the full chunk file for every raw hit). A multi-topic
        query is split into independent sub-queries (``_fts_query_exprs``), each
        limited to top_k, and the merged pid set is deduplicated keeping the
        best score per pid. The whole chunk content is attached later, after
        dense+BM25 fusion (``_attach_content``), so only the candidates that
        survive fusion pay for disk I/O. A zero-hit result falls back to the
        legacy prefix-wildcard OR query so verbose queries still surface
        candidates for the reranker.
        """
        if not self._fts_available or self._fts_conn is None:
            return []
        import sqlite3
        exprs = _fts_query_exprs(query)
        if not exprs:
            return []

        def _fetch(expr: str, limit: int) -> List[Any]:
            sql = "SELECT pid, bm25(docs) FROM docs WHERE docs MATCH ?"
            params: List[Any] = [expr]
            if source_filter:
                sql += " AND source = ?"
                params.append(source_filter)
            sql += " ORDER BY bm25(docs) LIMIT ?"
            params.append(limit)
            try:
                return self._fts_conn.execute(sql, params).fetchall()
            except sqlite3.Error:
                return []

        best: Dict[int, float] = {}
        for expr in exprs:
            for pid, rank in _fetch(expr, top_k):
                # bm25() is negative; smaller (more negative) = better.
                best[pid] = min(best.get(pid, 0.0), float(rank))

        if not best:
            relaxed_expr = _fts_query_expr(query, relaxed=True)
            if relaxed_expr:
                for pid, rank in _fetch(relaxed_expr, top_k):
                    best[pid] = min(best.get(pid, 0.0), float(rank))

        ordered = sorted(best.items(), key=lambda kv: kv[1])[:top_k]
        results: List[Dict[str, Any]] = []
        for pid, rank in ordered:
            meta = (self._documents[pid]
                    if 0 <= pid < len(self._documents) else {})
            results.append({
                '_pid': pid,
                'score': round(-float(rank), 4),
                'source': meta.get('source', 'unknown'),
                'source_display': self._format_source(
                    meta.get('source', 'unknown')),
                'title': meta.get('title') or meta.get('file') or 'Unknown',
                'url': meta.get('url', ''),
                'file': meta.get('file', ''),
                'section': meta.get('section', ''),
                'snippet': '',
                'content': '',
                '_rrf_weight': BM25_WEIGHT,
            })
        return results

    def _attach_content(self, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Attach full chunk text for candidates that do not carry it yet.

        BM25 hits are now cheap pid+score rows; the full text file is read only
        here, for the fused candidate set that actually survives retrieval, so
        a verbose query never pays to read files the reranker would discard.
        """
        for it in items:
            if it is None or it.get('content'):
                continue
            snip = it.get('snippet') or ''
            pid = it.get('_pid')
            full_text = snip
            try:
                if pid is not None and 0 <= pid < len(self._documents):
                    p = self._documents[pid].get('path', '')
                    if p and os.path.exists(p):
                        with open(p, 'r', encoding='utf-8',
                                  errors='replace') as f:
                            full_text = f.read()
            except Exception:
                pass
            it['content'] = full_text
            it['snippet'] = full_text[:800]
        return items

    def _merge_rrf(self, ranked_groups: List[List[Dict[str, Any]]],
                   limit: int, keep_rrf: bool = False) -> List[Dict[str, Any]]:
        """Fuse several ranked lists with reciprocal rank fusion.

        Each list contributes an independent rank space (k + rank), so
        results from the original vs expanded query keep their own ordering.

        When keep_rrf is True the per-item RRF score is retained (under the
        'rrf' key) so the reranker can blend it with the cross-encoder score.

        A BM25 item tagged with ``_rrf_weight`` (added by ``_search_bm25``)
        contributes scaled rank mass, so keyword hits carry more RRF weight
        than dense hits: exact EDK2 identifiers/commit rules are not drowned
        out by the dense embeddings. Byte-identical boilerplate files shipped
        in many repos (CONTRIBUTIONS.txt etc.) are collapsed to a single
        representative.
        """
        k = 60
        merged: Dict[str, Dict[str, Any]] = {}

        def key_of(item: Dict[str, Any]) -> str:
            pid = item.get('_pid')
            if pid is not None:
                return f"{item.get('source', '?')}:{pid}"
            return (f"{item.get('source')}|{item.get('title')}|"
                    f"{item.get('section')}")

        # Near-duplicate collapse: the tianocore-docs repos each ship the same
        # boilerplate files (CONTRIBUTIONS.txt, README.md, LICENSE.txt). Keeping
        # one representative per filename avoids flooding the top results with
        # 28 byte-identical copies of the same content, while the highest-RRF
        # copy still ranks for that file name.
        by_name = {}  # file basename -> first-seen item for the group

        def collapse_key(item: Dict[str, Any]) -> Optional[str]:
            f = item.get('file') or ''
            name = os.path.basename(f.replace('\\', '/')).lower()
            if name in ('contributions.txt', 'license.txt', 'licenses.txt',
                        'readme.md', 'readme.rst', 'copying', 'authors',
                        'codeowners', 'maintainers.txt', '.gitignore'):
                return name
            return None

        for group in ranked_groups:
            for rank, item in enumerate(group):
                key = key_of(item)
                weight = float(item.get('_rrf_weight', 1.0) or 1.0)
                ck = collapse_key(item)
                if ck is not None:
                    if ck not in by_name:
                        by_name[ck] = (key, weight)
                    else:
                        # Boost the first representative slightly and skip the
                        # duplicates entirely (they add no information).
                        continue
                entry = merged.setdefault(key, dict(item, rrf=0.0))
                entry['rrf'] += weight / (k + rank + 1)

        ranked = sorted(merged.values(), key=lambda x: x['rrf'], reverse=True)
        for item in ranked:
            if not keep_rrf:
                item.pop('rrf', None)
            item.pop('_pid', None)
        return ranked[:limit]

    def _fuse_dense_first(self,
                          ranked_groups: List[List[Dict[str, Any]]],
                          limit: int,
                          dedup: bool = True) -> List[Dict[str, Any]]:
        """Fuse dense + BM25 results, dense-first.

        The groups list alternates [chroma_q1, bm25_q1, chroma_q2, bm25_q2, ...]
        for each retrieval query. Dense (chroma) candidates are kept in their
        original ranked order and de-duplicated by document; BM25 candidates
        are then appended only if their document was not already produced by
        the dense leg. This preserves the dense ordering for semantic hits
        while still surfacing exact keyword hits (EDK2 identifiers, PCD/GUID
        names) the embeddings miss -- without the noise-dilution that pure RRF
        fusion caused on Chinese queries.

        With dedup=False the dedup key widens to (doc, section) so several
        sections of the same document can coexist in the candidate window.
        """
        chroma_groups = ranked_groups[0::2]
        bm25_groups = ranked_groups[1::2]

        def key_of(item: Dict[str, Any]):
            dk = _doc_key(item)
            if dedup:
                return dk
            return (dk[0], dk[1], item.get('section') or '')

        # Merge all dense groups and sort by retrieval score, so the best
        # dense hit from any query variant (original vs expanded) wins rather
        # than whichever query ran first. score is the Chroma distance which
        # is LOWER = closer, so ascending order.
        chroma_items = [it for g in chroma_groups for it in g if it is not None]
        chroma_items.sort(key=lambda it: float(it.get('score', -1e9)),
                          reverse=True)

        out: List[Dict[str, Any]] = []
        seen: set = set()

        for item in chroma_items:
            k = key_of(item)
            if k in seen:
                continue
            seen.add(k)
            out.append(item)
            if len(out) >= limit:
                return out

        for group in bm25_groups:
            for item in group:
                if item is None:
                    continue
                k = key_of(item)
                if k in seen:
                    continue
                seen.add(k)
                out.append(item)
                if len(out) >= limit:
                    break
        return out


    # ------------------------------------------------------------------ #
    # Status
    # ------------------------------------------------------------------ #

    def status(self) -> Dict[str, Any]:
        self.load()
        wiki_meta = self.data_dir / "tianocore-wiki" / "metadata.json"
        docs_meta = self.data_dir / "tianocore-docs" / "metadata.json"

        wiki_pages = 0
        docs_files = 0

        if wiki_meta.exists():
            try:
                with open(wiki_meta, 'r', encoding='utf-8') as f:
                    wiki_pages = json.load(f).get('total_pages', 0)
            except Exception:
                pass

        if docs_meta.exists():
            try:
                with open(docs_meta, 'r', encoding='utf-8') as f:
                    docs_files = len(json.load(f).get('files', []))
            except Exception:
                pass

        try:
            indexed = (self._collection.count()
                       if self._collection is not None
                       else len(self._documents))
        except Exception:
            indexed = len(self._documents)

        return {
            'initialized': True,
            'ready': self.is_ready(),
            'chroma_available': self._collection is not None,
            'indexed_documents': indexed,
            'data_sources': {
                'tianocore-wiki': {
                    'pages': wiki_pages,
                    'status': 'downloaded' if wiki_pages > 0
                    else 'not_downloaded',
                },
                'tianocore-docs': {
                    'files': docs_files,
                    'status': 'cloned' if docs_files > 0 else 'not_cloned',
                },
            },
            'data_dir': str(self.data_dir),
            'offline_mode': True,
        }

    # ------------------------------------------------------------------ #
    # Helpers
    # ------------------------------------------------------------------ #

    def _load_documents_index(self) -> None:
        doc_index = self.processed_dir / 'documents.json'
        if doc_index.exists():
            with open(doc_index, 'r', encoding='utf-8') as f:
                self._documents = json.load(f)

    def _format_source(self, source: str) -> str:
        return SOURCE_DISPLAY.get(source, source)

    def _extract_snippet(self, content: str, terms: set) -> str:
        lines = content.split('\n')
        relevant_lines = []
        for line in lines:
            if any(term in line.lower() for term in terms):
                relevant_lines.append(line.strip())
                if len(relevant_lines) >= 5:
                    break
        return '\n'.join(relevant_lines) if relevant_lines else content[:500]
