# Changelog

All notable changes to this project will be documented in this file.

## [6.0.9] - 2026-08-04

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