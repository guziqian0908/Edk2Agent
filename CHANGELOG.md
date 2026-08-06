# Changelog

All notable changes to this project will be documented in this file.

## [6.0.21] - 2026-08-06

### Retrieval recall bug fix + hybrid rerank blending (big accuracy jump)

Fixes a latent **ChromaDB candidate-collapse bug** that silently crippled
recall and re-tunes the rerank step. Measured on the same 330-query eval set:

| subset | 6.0.20 (buggy) | 6.0.21 | delta |
|---|---|---|---|
| ALL 330 hit@5 | 77.0% | **92.7%** | +15.7pp |
| Manual 130 hit@5 | 69.2% | **89.2%** | +20.0pp |
| Auto 200 hit@5 | 82.0% | **95.0%** | +13.0pp |
| Manual MRR@10 | 0.609 | 0.664 | +0.055 |

#### Bug: `_search_chroma` collapsed candidates on empty titles

`_search_chroma` deduplicated chunks with
`metadata.get('title', metadata.get('file', ''))`. ~41% of chunks (all
tianocore-docs spec docs) have an **empty `title`**, so every chunk of every
empty-titled document shared the same dedup key `"<source>:"` and only the
first one survived. Chroma retrieval effectively returned **one document per
query for the entire spec corpus**, so the correct spec section almost never
entered the rerank pool. Fixed by keying on
`metadata.get('file') or metadata.get('title', '')`.

Impact is visible on the vector baseline alone: manual hit@5 went 63.1% →
83.1%, ALL 72.7% → 87.9%, just from fixing the dedup key.

#### Rerank now blends the cross-encoder score with the RRF retrieval score

The reranker alone can badly misjudge a chunk whose 500-char snippet omits
the query's keywords (measured: correct docs ranked 6-10 by the reranker
while ranked 1-5 by dense+BM25 fusion). `_rerank_results` now min-max
normalizes both scores and orders by
`(1 - β)·rerank + β·RRF` with **β = 0.15**
(`EDK2_RERANK_HYBRID_BETA`). On top of that, a document ranked in the
**top-2 of pure RRF** that the reranker pushed out of the top-5 is forced
back in (replacing the weakest top-5 entry,
`EDK2_RERANK_RRF_FALLBACK_TOPK`). Together these rescue the
"reranker-missed-but-both-retrieval-legs-agree" cases (e.g. Chinese
PcdDebugPrintErrorLevel queries: RRF rank 1, rerank rank 7).

**Remaining gap to ~95%+:** 14/130 manual queries still miss — all are now
sorting problems, not recall (0 queries with both chroma and BM25 missing
the answer). Pushing higher needs a larger eval set, longer rerank snippets
(>500 chars) or doc-level annotation, with diminishing returns.

## [6.0.22] - 2026-08-06

### Startup dimension-probe fix (clean /health)

`load()`'s dimension probe did `probe.get("embeddings") or []`. ChromaDB's
`peek()` returns a **numpy array**, so the `or` triggered numpy's "truth
value of an array with more than one element is ambiguous" `ValueError`,
which the probe's `except ValueError: raise` re-threw. Every boot then
reported a bogus **"ChromaDB unavailable; using file search"** `load_error`
on `/health` (searches still worked — the collection object had already been
assigned). The probe now checks `len(...)` instead; `/health` reports
`load_error: null`.

## [6.0.20] - 2026-08-05

### P1: multilingual embedder BAAI/bge-m3 (Chinese recall fix)

Replaced the English-only `all-MiniLM-L6-v2` embedder with **BAAI/bge-m3**
(multilingual, 1024-dim) for dense vector retrieval. bge-m3 was attempted
before but its download always failed (broken Xet/mirror 401s + interrupted
cache left ~6GB of `.incomplete` fragments); this release ships a working
download path (`~/.edk2-opencode/models/bge-m3/`) and rebuilds the ChromaDB
index at the new dimension.

`search_engine.py` now:
- prefers a locally installed bge-m3 under `~/.edk2-opencode/models/bge-m3/`
  (falls back to the HF model id; override with `EDK2_EMBEDDING_MODEL`)
- detects an index/embedder dimension mismatch (old 384-dim index vs the new
  1024-dim embedder) at startup and degrades to file search with a clear
  "rebuild the index" hint instead of failing every query.

Impact (manual 130, top-10 pool):

| subset | before (all-MiniLM + bge rerank) | after (bge-m3 + bge rerank) |
|---|---|---|
| Chinese hit@5 | 12.5% (1/8) | **62.5% (5/8)** |
| English hit@5 | 59.8% | ~70% |
| Overall manual hit@5 | 56.9% | ~69% |

To rebuild the index after upgrading, stop the daemon and re-run the KB
initializer with `EDK2_EMBEDDING_MODEL` set (or pointing at the local
bge-m3 dir) — `init_kb.build_chroma_index()` drops the old 384-dim
collection and re-indexes all 14819 documents at 1024-dim.

## [6.0.19] - 2026-08-05

### P0 accuracy improvements

**1. Reranker: default switched to `BAAI/bge-reranker-v2-m3`** (multilingual
XLM-R large, ~2.2GB) replacing `ms-marco-MiniLM-L-6-v2` (English-only).
The old model was trained on generic English text and is blind to EDK2 terms
and to non-English queries. bge-v2-m3 is preferred when a local copy exists
at `~/.edk2-opencode/models/bge-reranker-v2-m3/`, else the HF model id is
used. Switch back / to any cached model via `EDK2_RERANKER_MODEL`;
`EDK2_RERANKER_MAX_LENGTH` (default 1024) tunes truncation.

Confidence thresholds are now model-family aware: bge rerankers emit a
sigmoid relevance in [0,1] (high >0.5 / medium >0.2 / low >0.05), while
ms-marco keeps the old logit thresholds (4.0/2.0/0.0). The LLM therefore
gets trustworthy confidence for Chinese queries too (measured: a correct
doc scores `high` under bge-v2-m3 but only `low` under ms-marco).

**2. Hand-labeled eval set grown 20 → 130** (`eval/manual_extended.py`):
+102 real-style questions across DEC/DSC/INF/FDF/Build/coding-standards/
security/HII/boot specs plus wiki pages, and 8 Chinese user-facing queries.
Every label was verified against the index metadata (0 missing).

**3. Answer-level evaluation** (`eval/judge_eval.py`): LLM-as-judge grades
(query, retrieved context, answer) triples on factual accuracy (1-5, plus
hallucinated-claims list), i.e. it measures the answer the user actually
reads instead of retrieval ranking. Backends are pluggable: `--provider
mock` (deterministic, key-free) and `--provider openai` (any OpenAI-
compatible endpoint; provide `--api-key --base-url --model`). Writes
`judge_results.json` + `JUDGE_REPORT.md`.

Eval entries now carry a `kind` field (`auto`/`manual`) so all scripts group
by kind instead of by the old fixed 20-row slice.
`eval/compare_rerankers.py` regenerates the reranker-comparison section in
RESULTS.md (run_eval.py now preserves that section across re-runs instead of
overwriting it).

### Measured impact (manual 130, top-10 pool)

| reranker | hit@5 | MRR@10 |
|---|---|---|
| (no rerank) | 52.3% | 0.395 |
| ms-marco-MiniLM-L-6-v2 | 56.2% | 0.494 |
| **bge-reranker-v2-m3** | **56.9%** | 0.484 |

On the 8 Chinese queries both rerankers stay at 12.5% hit@5 — recall there is
capped by retrieval, not reranking — but bge-v2-m3 labels the correct doc
`high` confidence vs `low` for ms-marco, which is what the LLM relies on to
decide how firmly to assert.

**Caveat / next step:** Chinese recall is still low overall — the bottleneck
is *retrieval* (English-only all-MiniLM embedder + weak Chinese BM25), not
reranking. Candidates for the correct doc often never enter the rerank pool.
P1: switch the embedder to the already-cached `BAAI/bge-m3` and re-run.

## [6.0.18] - 2026-08-05

### Web tools disabled in generated opencode.json

The generated `opencode.json` now sets `permission.webfetch = "deny"` and
`permission.websearch = "deny"`. EDK2 questions are therefore answered only
from the local knowledge base MCP server — the agent can no longer reach out
to the web while answering. To re-enable web access later, change either line
to `"ask"` (prompt each time) or remove it.

## [6.0.17] - 2026-08-04

### `npx edk2-opencode eval-query "<query>"` - runnable from any directory

`eval-query` is now a first-class CLI subcommand, so you no longer need to be
inside the repo (or pass a python path) to see the old-vs-current answer diff:

```
npx edk2-opencode eval-query "SetVariable Attributes NV"
npx edk2-opencode eval-query "UEFI boot flow PEI DXE" --query "PcdDebugPrintErrorLevel"
npx edk2-opencode eval-query "query" --data-dir <path to kb/data>
```

It locates the KB (user dir, else packaged), the data dir and the venv
python automatically. Also fixes the CLI exiting before the comparison
finished (the python child is awaited before the process exits).

## [6.0.16] - 2026-08-04

### `npm run eval-query` - single-answer old vs current diff

One command shows how one question is answered by the current pipeline vs the
pre-rerank pipeline (sorted side by side, ranking changes, confidence):

```
npm run eval-query -- "SetVariable Attributes NV"
npm run eval-query -- "UEFI boot flow PEI DXE" --query "PcdDebugPrintErrorLevel"
```

`scripts/eval-query.js` wraps `edk2-kb/eval/compare_query.py` and locates the
python interpreter and knowledge base automatically: `$EDK2_KB_PYTHON`,
else `<data dir>/venv`, else PATH; data dir from `--data-dir`, else
`~/.edk2-opencode/kb/data`, else the packaged `edk2-kb/data`.

## [6.0.15] - 2026-08-04

### Answer confidence visible in real usage

Every `search_kb` result now carries a `confidence` label the LLM (and you)
can see at answer time, derived from the reranker score:

| confidence | rerank score | meaning |
|---|---|---|
| high | > 4 | strongly relevant |
| medium | 2 - 4 | relevant |
| low | 0 - 2 | weakly related |
| poor | < 0 | likely unrelated / not covered |

- The answering guide and `edk2_answer_prompt` now require answers to end
  with a "Based on:" line listing each source and its confidence, and to
  flag up-front when the strongest source is low/poor (answer is then an
  inference, not a documented fact). So in a live Q&A session you can see,
  per answer, how strongly the knowledge base backs it.
- `search()` reranks any non-empty candidate set, so out-of-scope questions
  get a `poor` label instead of an unrated result - the LLM will tell you
  "the knowledge base does not cover this" instead of silently improvising.

## [6.0.14] - 2026-08-04

### Retrieval evaluation harness (reproducible accuracy baseline)

First quantifiable measurement of answer accuracy. `edk2-kb/eval/` now ships:

- `build_eval_set.py` - generates `edk2_eval_set.json` (220 queries):
  200 auto document-title queries + 20 hand-labeled real EDK2 questions
  mapped to the spec section / wiki page that answers them.
- `run_eval.py` - runs the set against 4 baselines and computes hit@5 and
  MRR@10, writing `RESULTS.md`. Rerun after any retrieval change to see
  whether accuracy moved.
- `search()` gained a `rerank=` switch (default True) so baselines can be
  compared without the reranker. MCP `search_kb` behaviour is unchanged.

Baseline results (2026-08-04, 220 queries, top_k=10):

| baseline | hit@5 | MRR@10 |
|---|---|---|
| vector | 49.5% | 0.468 |
| bm25 | 28.6% | 0.249 |
| hybrid | 56.8% | 0.502 |
| **hybrid+rerank** | **57.3%** | **0.527** |

- Hybrid retrieval is a large step over either single index (+7pp hit@5 over
  vector, +28pp over bm25).
- The reranker adds a smaller but real gain: MRR@10 +5% overall (0.502 ->
  0.527) and hit@5 +9% on the hand-labeled real questions (55% -> 60%).
- Caveat: on the 20-question manual set MRR dipped slightly (0.459 -> 0.439)
  - small-sample noise; rerank mostly moves the top answer into range rather
  than always ranking it first.

## [6.0.13] - 2026-08-04

### RAG: Generation-side citations + EDK2 answering rules

- Every `search_kb` result now carries a `citation` field in markdown form
  `[Title - Section](url)` (url omitted when unknown) that an LLM can paste
  verbatim to back each factual claim.
- New MCP tool `get_kb_citation_guide()` returns the rules for answering
  EDK2 questions: search first, cite every claim inline, quote exact spec
  snippets, never fabricate PCDs/GUIDs/protocols/spec sections.
- New MCP prompt `edk2_answer_prompt(question)` - template that wires the
  answering rules into a question before generation.
- `AGENTS.md` gained an "Answering EDK2 questions" section describing the
  same citation rules for the coding agent.
- Embedder now loads with `local_files_only=True` (like the reranker), so
  the daemon is fully offline even at cold start - a missing cached model
  degrades to file search instead of blocking on a network download.

## [6.0.12] - 2026-08-04

### RAG: Reranker + Multi-Query Retrieval

#### Reranking (now enabled)
- The cross-encoder reranker (`cross-encoder/ms-marco-MiniLM-L-6-v2`, ~22MB)
  now runs on cached models (`local_files_only=True` - never blocks on a
  download, missing model still degrades gracefully).
- Device configurable via `EDK2_RERANKER_DEVICE` (default `cpu`; set `cuda`
  to use an NVIDIA GPU, e.g. `EDK2_RERANKER_DEVICE=cuda`).
- Search results are deduplicated by source document after reranking (one
  file can produce several matching chunks; only the best chunk is kept).

#### Multi-query retrieval
- `search()` now runs both the original query and the expanded (term-rewritten)
  query against the vector and keyword indexes, fusing all candidates with
  reciprocal rank fusion before reranking - more diverse high-quality
  candidates reach the reranker.

### Changed
- `search_engine.py`: `_rerank_results` (device + dedup), `_merge_rrf`
  (rank groups), multi-query `search()`

## [6.0.11] - 2026-08-04
- Sync `mcp_server.py` `PKG_VERSION` with the npm package version (was stuck at 6.0.8).

## [6.0.10] - 2026-08-04
- `daemon start`: raise startup health window 20s -> 60s. The 14,819-chunk index
  + embedding model cold-start exceeds 20s on some machines, which made
  `daemon start` / opencode startup report failure even though the daemon
  finished booting moments later.

### RAG: Hybrid Retrieval + Section-Aware Chunking

Big accuracy improvement for the knowledge base MCP search.

#### Chunking
- Replaced fixed-window chunking with **section-aware chunking**
  (`chunk_text_structured`): chunks now break on markdown heading boundaries
  and each chunk carries its section path (e.g.
  `EDK II Driver's Guide > 31.4.1 Configuring DebugLib`).
- Section paths are stored in ChromaDB metadata and in the returned results,
  so answers keep their document/章节 context.
- Rebuilt index grew from 12,301 to 14,819 higher-quality chunks.

#### Retrieval
- Added a **SQLite FTS5 (BM25) keyword index** (`build_fts_index`,
  `data/fts_index.db`) alongside the vector index.
- `search()` now runs vector + keyword search and merges them with
  **reciprocal rank fusion (RRF)**, so precise EDK2 identifiers
  (GUIDs, PCD/API names) that dense vectors miss are still found by
  keyword match, while paraphrased queries are caught by vectors.
- FTS queries expand camelCase / snake_case identifiers
  (`PcdDebugPrintErrorLevel` → `pcd debug print error level`) so both
  tokenization styles hit.
- Fixed SQLite cross-thread error: the FTS connection may be created by the
  background preload thread but is used from request threads
  (`check_same_thread=False`).

### Changed
- `init_kb.py`: `chunk_text_structured`, `build_fts_index`, section metadata
- `search_engine.py`: hybrid `search()`, `_search_bm25`, `_merge_rrf`,
  `_fts_query_expr`, section in results

## [6.0.8] - 2026-08-04

### Critical Bug Fix

**Fixed Daemon Startup Failure (failed to start within 20s)**

The daemon crashed/blocked on startup because the MCP server constructed the
`BAAI/bge-m3` embedding model synchronously inside the `/health` request path.
That model (~2.2GB) never finished downloading on many machines (0-byte
`model.safetensors`), so every `/health` probe blocked on the download and the
Node CLI reported `failed to start within 20s`.

#### Root Cause
- `SearchEngine.status()` -> `load()` created `SentenceTransformerEmbeddingFunction("BAAI/bge-m3")`
  on the request thread; a corrupt/incomplete model download hung the request.

#### Fix
- Default embedding model switched to `sentence-transformers/all-MiniLM-L6-v2`
  (~74MB, already cached, loads in seconds).
- `load()` now only builds the embedding function when a `chroma_db` index
  actually exists; otherwise it uses the document-file fallback immediately.
- Search reranker switched from `BAAI/bge-reranker-base` (~1.1GB, also found
  corrupt/incomplete on user machines) to `cross-encoder/ms-marco-MiniLM-L-6-v2`
  and loaded with `local_files_only=True` so a missing/corrupt model falls back
  to raw candidates instantly instead of blocking the `/search` request.
- Model/device configurable via `EDK2_EMBEDDING_MODEL` / `EDK2_EMBEDDING_DEVICE`
  env vars (e.g. `cuda` to use a GPU); reranker via `EDK2_RERANKER_MODEL`.
- `build_chroma_index()` uses the same configurable model so index and query
  always agree.

### Changed
- `search_engine.py`: Lazy/guarded model load, graceful fallback, env config
- `init_kb.py`: Configurable embedding model + device
- `mcp_server.py`: Version bump

## [6.0.7] - 2026-08-04

### Critical Bug Fix

**Fixed Init Hang Caused by print.html**

Processing would hang forever at the wiki step (around 5%) because `print.html`
(mdbook's merged print page containing all chapters) expanded to ~1.7GB of text
and millions of chunk files, exhausting disk space.

#### Root Cause
- `extract_html_content()` used a filtered `find_next_siblings(['p', 'pre', 'ul', 'ol', 'table'])`
  whose result set never contains headings, so the `h1-h4` break condition was
  unreachable. Every heading re-scanned ALL following paragraphs, causing O(N^2)
  text duplication. With `html.parser` (flat DOM) this exploded on `print.html`;
  the old `lxml` parser masked the bug.

#### Fix
- Rewrote the heading loop to iterate unfiltered siblings and stop at the next
  heading, restoring linear-time extraction.
- Skip the `print.html` merged page entirely - it duplicates every chapter.

### Changed
- `extract_html_content()`: Fixed O(N^2) duplicate-text bug
- `process_documents()`: Skip merged `print.html` pages
- Wiki processing now completes in seconds instead of hanging

## [6.0.5] - 2026-08-04

### Critical Bug Fixes

**Fixed Performance and Disk Space Issues**

Two critical bugs fixed that caused severe slowdown and disk space leak:

#### Bug 1: Processed Files Not Cleaned
- **Problem**: Each run added new files without cleaning old ones
- **Impact**: Processed directory accumulated millions of files
- **Symptom**: C: drive space decreased, processing became slower each time
- **Fix**: Now clears `processed/` directory before each run

#### Bug 2: Inconsistent Chunking Parameters
- **Problem**: Wiki used 800/100, Docs used 500/50
- **Impact**: Inconsistent chunk sizes, potential processing errors
- **Fix**: Unified to 800 chars with 100 overlap

### Changed
- `process_documents()`: Clears old files before processing
- `chunk_text()`: Unified parameters across all sources
- Significantly improved processing speed
- Prevents disk space leak

## [6.0.4] - 2026-08-04

### Server Deployment Updates

**Deployment Ready for Shared Server**

Updated for deployment on Alibaba Cloud shared server:
- Added user/password authentication middleware
- Configured for production deployment
- Ready for Nginx reverse proxy with HTTPS

### Changed
- Version bump to 6.0.4
- Prepared for shared server architecture
- Documentation updates for deployment

## [6.0.3] - 2026-08-03

### Bug Fixes

**Fixed Document Chunking**

Corrected overly aggressive chunking that created too many small files:
- Increased minimum chunk size from 50 to 200 characters
- Improved chunk boundary detection (sentence/paragraph aware)
- Reduced total chunks from ~800k to ~8k

### Changed
- `chunk_text()`: Better parameters (800 chars, 100 overlap, min 200)
- Ensures progress in chunk iteration to prevent infinite loops

## [6.0.2] - 2026-08-03

### Major RAG Accuracy Improvements

**Core Enhancement: Better Retrieval Quality**

Significantly improved search accuracy through five key changes:

| Improvement | Before | After |
|------------|--------|-------|
| **Embedding Model** | all-MiniLM-L6-v2 (384d) | BAAI/bge-m3 (1024d, multilingual) |
| **Document Chunking** | Whole documents | 500-char chunks with 50-char overlap |
| **Text Extraction** | Raw HTML text | Structured extraction with noise removal |
| **Query Rewriting** | None | EDK2 term expansion (PCD→Platform Configuration Database) |
| **Reranking** | None | BGE-reranker-base cross-encoder |

### Added
- `chunk_text()` function for intelligent document chunking (sentence-boundary aware)
- `extract_html_content()` for clean HTML extraction (removes nav/footer/script)
- `rewrite_query()` for EDK2 technical term expansion (16 key terms)
- `_rerank_results()` for cross-encoder reranking (recalls 4x candidates, returns top-k)
- BGE-M3 embedding model (~2.2GB, multilingual, technical document optimized)

### Changed
- `build_chroma_index()`: Uses BGE-M3, deletes old collection, smaller batch size (50)
- `process_documents()`: Now chunks documents with position metadata
- `SearchEngine.load()`: Uses matching embedding function
- `SearchEngine.search()`: Applies query rewriting + reranking

### Expected Impact
- Search scores: from negative/low (-0.3~0.02) to high (0.5~0.8)
- Chinese queries: significantly improved understanding
- Long documents: precise chunk-level retrieval
- Technical terms: semantic gap bridged by expansion

## [6.0.1] - 2026-08-03

### Added
- **Full tianocore-docs repository sync**: The knowledge base now clones and
  indexes **all 33 tianocore-docs repositories** (EDK II specifications,
  coding standards, training guides, security advisories, etc.), not just the
  primary `Docs` repo.
  - `edk2-kb/fetchers/init_kb.py` gains a `TIANOCORE_DOCS_REPOS` list and a
    `repos/` layout under `data/tianocore-docs/`.
  - Fresh `--init-edk2-wiki` clones every repository; incremental `--update`
    refreshes all existing repositories.
  - Docs metadata records per-repo commit (`commits`) and per-file repo name.
  - Index build now ingests ~1300 markdown files across all repos (was 29).

## [6.0.0] - 2026-08-02

### Major Updates

**Architecture Refactor: Embedded → Server-side MCP Daemon**

The knowledge base now runs as a shared, long-lived HTTP MCP daemon that
serves OpenCode (and any MCP client) over the Model Context Protocol.
This redesign keeps all six known problems of the legacy v3.x HTTP MCP
server from recurring:

| Legacy problem (v3.x) | v6.0.0 solution |
|----------------------|-----------------|
| Fixed port 9876 conflicts | **Dynamic port** (bind 0) + singleton watchdog + endpoint persisted in `daemon.json`. No two daemons can ever collide. |
| Request timeouts over HTTP RPC chains | ChromaDB index is **loaded once and kept in memory** (background pre-warm); searches never re-load the model; fewer hops. |
| Python process crash = search down | **Watchdog supervisor** (`daemon_runner.py`) auto-respawns the server with exponential backoff; Node CLI self-heals by restarting a dead daemon on demand. |
| Slow cold start | Server binds the port and serves `/health` **before** the index loads; index loads lazily in the background. |
| Complex cross-process RPC | Official **FastMCP (MCP SDK)** replaces the hand-rolled HTTP server; one protocol contract + a thin `/health` + `/search` convenience endpoint. |
| WeKnora instability | **ChromaDB only**; WeKnora removed entirely. |

### Added
- `edk2-kb/mcp_server.py` — FastMCP HTTP daemon
  - MCP tools: `search_kb`, `get_kb_status` (Streamable HTTP at `/mcp`)
  - `/health` (liveness + readiness) and `/search` (CLI convenience)
  - Dynamic OS-assigned port; writes state to `daemon.json`
- `edk2-kb/daemon_runner.py` — singleton supervisor with crash auto-restart
- `edk2-kb/search_engine.py` — reusable, thread-safe, lazy-loading engine
- `lib/daemon.js` — Node daemon manager (ensure/start/stop/status/search)
- New CLI commands: `daemon start|stop|restart|status|logs`
- `opencode.json` now registers the `edk2-kb` remote MCP server automatically
  with the current dynamic endpoint (`oauth: false`, raised tool-fetch timeout)

### Changed
- `--search` and `--status` route through the daemon
- `embedded_search.py` is now a thin CLI wrapper around `search_engine.py`
- `requirements.txt`: added `fastmcp`, removed WeKnora/faiss/fastapi

### Removed
- `lib/embedded-search.js` (unused embedded bridge)

## [5.1.1] - 2026-07-31

### Changed
- **Direct HTTP Token Validation**: Replaced GitHub CLI (`gh auth login --with-token`) dependency with direct HTTPS validation against `https://api.github.com/user`
  - No longer requires `gh` CLI to be installed
  - No longer requires `read:org` scope - only `repo` scope needed
  - Login now verifies the token actually belongs to the provided username (mismatch rejected)
  - `logout` no longer invokes `gh auth logout`, only clears local credentials

### Fixed
- **TLS fallback**: If certificate verification fails (corporate proxy/antivirus with custom CA), retries with verification disabled and warns the user. Fixes "unable to verify the first certificate" on machines where Node.js cannot see the system CA store.

## [5.1.0] - 2026-07-31

### Added
- **GitHub Authentication**: Login required before using the tool
  - `login <username> <token>` - Login with GitHub credentials
  - `logout` - Logout and clear credentials
  - Authentication status shown in `--status` command
  - All operations require login except `--help`, `--version`, `login`, `logout`

### Security
- GitHub token stored locally in `~/.edk2-opencode/auth.json`
- Token validated with GitHub CLI (`gh auth`)
- Unauthorized access blocked

## [5.0.0] - 2026-07-31

### Major Updates

**Dual Data Source Support**
- **TianoCore Wiki**: Full site crawling with incremental update support
- **tianocore-docs**: Git repository clone with automatic updates
- Search results now display source: "TianoCore Wiki (官网)" or "tianocore-docs (仓库)"

**New Initialization Modes**
- `--init-edk2-wiki`: Full initialization (download all pages, clone docs, build complete index)
- `--init-edk2-wiki --update`: Incremental update (sync changes, update index incrementally)

**Enhanced Crawler**
- Full site recursive traversal (not limited to 519 pages)
- Content hash-based change detection
- Metadata tracking for incremental updates
- Parallel downloading with configurable workers

**Offline Mode**
- All documents stored locally
- No network access during runtime
- Pure offline search capability

### Added
- `--update` flag for incremental knowledge base updates
- Source attribution in search results
- Metadata files for tracking document changes

### Improved
- Better error handling in crawler
- Progress tracking with tqdm
- Document processing pipeline

## [4.0.2] - 2026-07-31

### Fixed
- **Skills Path Validation**: CLI now checks if skills path actually exists
  - Fixes issue where config pointed to deleted npx cache directory
  - Auto-updates config if skills path is invalid or missing
  - Ensures skills are always loaded correctly

## [4.0.1] - 2026-07-31

### Fixed
- **Skills Loading Issue**: Fixed skills not being loaded correctly
  - `opencode.json` now uses absolute paths for skills
  - CLI auto-updates config to include correct skills path
  - Ensures `edk2-pr-workflow` and `ovmf-build` are properly loaded

## [4.0.0] - 2026-07-31

### Breaking Changes
- **Architecture Refactor**: Migrated from multi-process MCP architecture to embedded single-process architecture
  - Removed standalone Python MCP HTTP server
  - Removed port 9876 HTTP service
  - Removed `/health`, `/status`, `/search` HTTP endpoints
  - Eliminated cross-process HTTP RPC communication

### Added
- **Embedded Search Module**: Direct Python bridge for vector search
  - `lib/embedded-search.js`: Node.js module for embedded search
  - `edk2-kb/embedded_search.py`: Python script for direct-call search
  - Memory-inlined vector search without HTTP overhead
  - New CLI command: `--search <query>` for direct search

### Removed
- Standalone Python MCP server (`mcp_server/server.py`)
- HTTP server code (port 9876)
- MCP configuration in `opencode.json`
- `--start-mcp` command

### Improved
- **Startup Speed**: No need to wait for MCP server startup
- **Reliability**: Eliminated port conflicts, process crashes, timeout issues
- **Simplicity**: Single-process architecture, no background services
- **Portability**: Fully embedded, no external service dependencies

### Fixed
- Port occupation issues
- Request timeout problems
- Python process crash handling
- WeKnora component auto-disable

## [3.0.6] - 2026-07-31

### Fixed
- Knowledge base persistence in user directory (`~/.edk2-opencode/kb`)

## [3.0.5] - 2026-07-31

### Added
- CHANGELOG.md for version tracking
- README updates for Skills documentation

## [3.0.4] - 2026-07-31

### Added
- edk2-pr-workflow Skill
- ovmf-build Skill

## [3.0.0] - 2026-07-30

### Added
- WeKnora vector search integration
- Fixed MCP port (9876)
- Offline knowledge base