#!/usr/bin/env python3
"""
EDK2 Knowledge Base MCP Server (HTTP daemon)

Serves the EDK2 knowledge base over the Model Context Protocol so that
OpenCode (or any MCP client) can query it as a remote server.

Design goals (fixes for the legacy v3.x problems):
  * No fixed port          -> binds to an OS-assigned port (port 0); the real
                              endpoint is written to daemon.json so multiple
                              daemons can never collide.
  * Low latency            -> the ChromaDB index is loaded once (background
                              pre-warm) and kept in memory; searches never
                              re-load the model.
  * Fast startup           -> the port is bound and /health responds before
                              the index is loaded; index loads lazily.
  * Crash recovery         -> daemon_runner.py supervises this process and
                              respawns it if it dies unexpectedly.
  * Stable retrieval       -> ChromaDB only, no WeKnora.

Endpoints:
  /mcp                     MCP protocol endpoint (Streamable HTTP)
  /health                  liveness + readiness + index stats
  /search                  convenience JSON endpoint used by the CLI --search
"""

import argparse
import asyncio
import json
import os
import socket
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse

from search_engine import SearchEngine

HERE = Path(__file__).resolve().parent
DEFAULT_STATE_FILE = HERE / "daemon.json"

PKG_VERSION = "6.0.22"

CITATION_GUIDE = """# EDK2 Knowledge Base Answering Guide

Follow these rules whenever you answer an EDK2 question using the knowledge base.

## 1. Search first
Call `search_kb()` with a concrete technical query before answering any EDK2
question: functions, PCDs, boot flow, INF/DSC/DEC syntax, protocols, library
classes, build behavior, tools, or specifications.

## 2. Cite every claim
Base each factual claim on a search result and reference it inline using the
result's `citation` field (markdown form). Example:

    Per the INF specification, PCDs are declared in `[Pcds]` sections.
    - [EDK II INF Specification - 3.8 PCD Sections](https://...)

Never invent section names or URLs.

## 3. Quote exact snippets
When the question is about a specific API, PCD, or structure, quote the exact
`section` snippet from the result instead of paraphrasing.

## 4. Never fabricate
If search results do not cover the answer, say so explicitly ("The knowledge
base does not cover this"), give the closest guidance found, and suggest
checking the EDK2 source or the TianoCore docs. Never make up PCD names,
GUIDs, protocols, or spec sections.

## 5. Output format
- Concise, specification-accurate answer
- Inline reference per claim
- Code / PCD / protocol names in backticks
- For PCD or INF keyword questions, give the exact INF `[Pcds]` or DSC
  `[Pcds*]` syntax from the results

## 6. Confidence reporting
Results are ordered by hybrid retrieval (vector + BM25 fused with reciprocal
rank fusion). The `confidence` label is `unrated` unless the optional reranker
step runs; treat the result order as the relevance signal instead.

End your answer with a one-line "Based on:" note that lists the sources you
used and their confidence, e.g.:

    Based on: [EDK II INF Specification - 3.8 PCD Sections](url) (medium)

If the strongest available source is `low` or `poor`, state up front that the
knowledge base covers this poorly and mark the answer as an inference rather
than a documented fact.
"""


def _cors(headers: dict) -> dict:
    """CORS headers so the web UI (different origin) can call /search."""
    h = dict(headers)
    h["Access-Control-Allow-Origin"] = "*"
    h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    h["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    return h


def build_fastmcp(engine: SearchEngine) -> FastMCP:
    mcp = FastMCP("edk2-kb")

    @mcp.tool()
    def search_kb(query: str, top_k: int = 5,
                  source: str = "all") -> List[Dict[str, Any]]:
        """Search the EDK2 knowledge base.

        Args:
            query: The search query text.
            top_k: Maximum number of results (1-20).
            source: Restrict results to a data source: "all" (default),
                "tianocore-wiki" or "tianocore-docs".
        """
        top_k = max(1, min(int(top_k), 20))
        src = None if source in ("", "all", "both") else source
        return engine.search(query, top_k, src, rerank=False)

    @mcp.tool()
    def get_kb_status() -> Dict[str, Any]:
        """Get the knowledge base status: readiness, index size and the
        availability of each data source."""
        return engine.status()

    @mcp.tool()
    def get_kb_citation_guide() -> str:
        """Get the rules for answering EDK2 questions from the knowledge
        base: when to call search_kb, how to cite results inline, and the
        expected answer format. Read this before answering EDK2 questions."""
        return CITATION_GUIDE

    @mcp.prompt()
    def edk2_answer_prompt(question: str) -> str:
        """Template for answering an EDK2 question from the knowledge base:
        search first, merge multiple documents, cite every claim, and prefer
        authoritative spec documents over partial snippets."""
        return f"""Answer the following EDK2 question using the edk2-kb knowledge base.

Follow the answering guide (call get_kb_citation_guide for the full rules):

1. Search broadly first: call search_kb() with top_k=10 and the concrete
   technical terms in the question, plus at least one keyword/BM25 variant
   (exact EDK2 identifiers, spec section names, PCD/protocol names). Search
   again for each distinct sub-topic before composing the final answer.

2. Merge MULTIPLE documents: when the question spans several aspects (e.g.
   code style + commit rules + sign-off), integrate every relevant result —
   coding standards, commit/contribution docs, and spec sections. Do not
   stop after the first hit. Prefer results with `type: "spec"` (authoritative
   EDK2 specifications) over partial snippets; treat `webpage` results as
   supplemental.

3. Layered structured output: organize the answer by full dimension/rule set.
   For "what are the requirements" questions, enumerate every requirement in
   a layered structure (format rules, commit message format, sign-off /
   contribution agreement, pre-submission checks, tooling), quoting the exact
   spec rule text for each. Do not omit any rule found in the context just
   because its source snippet looks truncated — state the rule and cite the
   document that defines it.

4. Cite every claim inline with its `citation` field and mark each source's
   `type` (spec / guide / advisory / webpage) so the reader knows what is
   authoritative and what is explanatory.

5. If the required detail is genuinely absent from the knowledge base, say
   so explicitly instead of guessing. Never invent PCD names, GUIDs,
   protocols, spec sections, or commit rules.

6. End with a "Based on:" line listing each source used and its `type` and
   `confidence` label (high/medium/low/poor).

Question: {question}
"""

    @mcp.custom_route("/health", methods=["GET"])
    async def health(request: Request) -> JSONResponse:
        status = engine.status()
        return JSONResponse(_cors({
            "status": "ok",
            "service": "edk2-kb",
            "ready": status["ready"],
            "load_error": engine.load_error,
            "indexed_documents": status["indexed_documents"],
            "data_sources": status["data_sources"],
        }))

    @mcp.custom_route("/search", methods=["GET", "POST"])
    async def search(request: Request) -> JSONResponse:
        if request.method == "POST":
            try:
                body = await request.json()
            except Exception:
                body = {}
            query = body.get("query", "")
            top_k = body.get("top_k", 5)
            source = body.get("source", "all")
        else:
            query = request.query_params.get("query", "")
            try:
                top_k = int(request.query_params.get("top_k", 5))
            except (TypeError, ValueError):
                top_k = 5
            source = request.query_params.get("source", "all")

        if not query or not query.strip():
            return JSONResponse(_cors({"error": "Missing query parameter"}), 400)
        try:
            top_k = max(1, min(int(top_k), 20))
        except (TypeError, ValueError):
            top_k = 5

        src = None if source in ("", "all", "both") else source
        results = engine.search(query.strip(), top_k, src, rerank=False)
        return JSONResponse(_cors({"results": results}))

    return mcp


class _StateWriter:
    """Thread-safe state file writer so the server and its background
    readiness thread never clobber each other."""

    def __init__(self, state_file: Path):
        self.state_file = Path(state_file)
        self._lock = threading.Lock()
        self._data: Dict[str, Any] = {}

    def update(self, **kwargs) -> None:
        with self._lock:
            self._data.update(kwargs)
            self._write()

    def _write(self) -> None:
        try:
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.state_file.with_suffix(".json.tmp")
            tmp.write_text(
                json.dumps(self._data, indent=2, ensure_ascii=False),
                encoding="utf-8")
            os.replace(tmp, self.state_file)
        except Exception:
            pass


def _watch_ready(engine: SearchEngine, writer: _StateWriter) -> None:
    """Background thread: mark the daemon ready once the index is loaded."""
    try:
        engine.ensure_ready(timeout=1800)
        status = engine.status()
        writer.update(
            ready=True,
            indexed_documents=status["indexed_documents"],
            chroma_available=status["chroma_available"],
        )
    except Exception as e:
        writer.update(ready=False, load_error=str(e))


def _state_file_for(args) -> Path:
    if args.state_file:
        return Path(args.state_file)
    if args.data_dir:
        return Path(args.data_dir) / "daemon.json"
    return DEFAULT_STATE_FILE


def main() -> None:
    parser = argparse.ArgumentParser(description="EDK2 Knowledge Base MCP Server")
    parser.add_argument("--data-dir", type=str, default=None,
                        help="Knowledge base root directory (contains data/)")
    parser.add_argument("--state-file", type=str, default=None,
                        help="Path to daemon.json state file")
    parser.add_argument("--host", type=str, default="127.0.0.1",
                        help="Bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=0,
                        help="Port to bind (0 = OS-assigned dynamic port)")
    args = parser.parse_args()

    kb_root = Path(args.data_dir) if args.data_dir else HERE
    state_file = _state_file_for(args)

    engine = SearchEngine(data_dir=kb_root / "data", preload=True)
    mcp = build_fastmcp(engine)

    # Pre-bind an OS-assigned port so we know the real endpoint before the
    # event loop starts -> no fixed port, no port conflicts.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((args.host, args.port))
    host, port = sock.getsockname()

    writer = _StateWriter(state_file)
    writer.update(
        pid=os.getpid(),
        watchdog_pid=int(os.environ.get("EDK2_WATCHDOG_PID", "0")),
        port=port,
        host=host,
        url=f"http://{host}:{port}",
        status="running",
        ready=False,
        version=PKG_VERSION,
        kb_dir=str(kb_root),
        started_at=datetime.now(timezone.utc).isoformat(),
    )

    threading.Thread(target=_watch_ready, args=(engine, writer),
                     daemon=True, name="kb-ready-watcher").start()

    try:
        asyncio.run(mcp.run_http_async(
            transport="http",
            host=host,
            port=port,
            path="/mcp",
            sockets=[sock],
            show_banner=False,
            log_level="warning",
        ))
    finally:
        try:
            sock.close()
        except Exception:
            pass
        try:
            state_file.unlink(missing_ok=True)
        except Exception:
            pass


if __name__ == "__main__":
    main()
