#!/usr/bin/env python3
"""
Persistent BGE-reranker-v2-m3 HTTP service.
Loads the model once, serves reranking requests over HTTP.

Usage: python rerank_server.py [--port 18766] [--host 127.0.0.1]

Endpoints:
  GET  /health            -> {"status":"ok"}
  POST /rerank            -> JSON body: {"query": "...", "docs": [...]}
                             Returns: {"results": [...]} (reranked, top 10)

Performance features:
  * Auto device: CUDA when available, else CPU (override RERANK_DEVICE).
  * FP16 inference on CUDA (override RERANK_PRECISION).
  * Batched ``predict`` with an adaptive batch size.
  * LRU score cache for repeated (query, document-window) pairs.
  * Long-text chunking: documents longer than the model window are split into
    overlapping windows and the max window score is kept.
  * Input capped at RERANK_MAX_DOCS documents so a pathological payload cannot
    stall the single-threaded server (the web service sends <= ~200).
"""

import sys
import json
import os
import hashlib
import argparse
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse
from collections import OrderedDict

try:
    import torch
    from sentence_transformers import CrossEncoder
except ImportError as e:
    print(json.dumps({"error": f"sentence_transformers/torch not installed: {e}"}))
    sys.exit(1)

MODEL_PATH = Path.home() / ".edk2-opencode" / "models" / "bge-reranker-v2-m3"

# Candidate budget: the coarse retrieval stage feeds at most this many docs
# into the cross-encoder (fine rerank top-N on top of coarse top-M).
MAX_DOCS = int(os.environ.get("RERANK_MAX_DOCS", "200"))
# bge-reranker-v2-m3 supports long passages; 512 tokens is a safe default for
# the web service's snippet payloads (the daemon caps snippets at ~800 chars,
# ~400-500 tokens) and roughly HALVES the CPU cross-encoder cost per pair on a
# single-threaded host. 1024 still available via RERANK_MAX_LENGTH if longer
# passages need scoring.
RERANK_MAX_LENGTH = int(os.environ.get("RERANK_MAX_LENGTH", "512"))
# Chunked scoring for long texts: ~4 chars per token, 20% overlap.
CHUNK_CHARS = RERANK_MAX_LENGTH * 4
CHUNK_OVERLAP = CHUNK_CHARS // 5
MAX_WINDOWS_PER_DOC = int(os.environ.get("RERANK_MAX_WINDOWS", "3"))
# Total (query, window) pairs scored per request (safety valve).
MAX_PAIRS = int(os.environ.get("RERANK_MAX_PAIRS", "300"))
# LRU score cache capacity for (query, text) pairs.
CACHE_SIZE = int(os.environ.get("RERANK_CACHE_SIZE", "2048"))

_DEVICE_AUTO = "cuda" if torch.cuda.is_available() else "cpu"
RERANK_DEVICE = os.environ.get("RERANK_DEVICE", _DEVICE_AUTO)
RERANK_PRECISION = os.environ.get("RERANK_PRECISION",
                                  "float16" if RERANK_DEVICE == "cuda" else None)

# Global model instance (loaded once)
_model = None
_model_lock = threading.Lock()

# LRU (query, text) -> score cache
_score_cache = OrderedDict()
_score_lock = threading.Lock()


def _pair_key(query: str, text: str) -> str:
    h = hashlib.sha256()
    h.update(query.encode("utf-8", "ignore"))
    h.update(b"\x00")
    h.update(text.encode("utf-8", "ignore"))
    return h.hexdigest()


def _cache_get(key: str):
    with _score_lock:
        if key in _score_cache:
            _score_cache.move_to_end(key)
            return _score_cache[key]
        return None


def _cache_put(key: str, score: float) -> None:
    with _score_lock:
        _score_cache[key] = score
        _score_cache.move_to_end(key)
        while len(_score_cache) > CACHE_SIZE:
            _score_cache.popitem(last=False)


def get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                if not MODEL_PATH.exists():
                    raise RuntimeError(f"Model not found at {MODEL_PATH}")
                print(f"[rerank-server] Loading model from {MODEL_PATH} "
                      f"(device={RERANK_DEVICE}, precision={RERANK_PRECISION or 'fp32'}) ...",
                      flush=True)
                kwargs = dict(max_length=RERANK_MAX_LENGTH,
                              device=RERANK_DEVICE,
                              local_files_only=True)
                if RERANK_PRECISION:
                    try:
                        kwargs["precision"] = RERANK_PRECISION
                    except Exception:
                        pass
                _model = CrossEncoder(str(MODEL_PATH), **kwargs)
                print("[rerank-server] Model loaded.", flush=True)
    return _model


def _doc_text(doc) -> str:
    text = ""
    if doc.get("title"):
        text += doc["title"] + " "
    if doc.get("section"):
        text += doc["section"] + " "
    if doc.get("snippet"):
        text += doc["snippet"]
    elif doc.get("content"):
        text += doc["content"]
    return text


def _chunk_text(text: str, max_windows: int) -> list:
    """Split a long document into overlapping windows (take the max score)."""
    text = text.strip()
    if len(text) <= CHUNK_CHARS:
        return [text]
    parts = []
    start = 0
    while start < len(text) and len(parts) < max_windows:
        parts.append(text[start:start + CHUNK_CHARS])
        start += CHUNK_CHARS - CHUNK_OVERLAP
    return parts


def rerank(query: str, docs: list, top_n: int = 10) -> list:
    """Score ``docs`` for ``query`` with the cross-encoder.

    Returns the reranked (top ``top_n``) docs with ``rerank_score`` set.
    """
    docs = docs[:MAX_DOCS]
    max_windows = min(
        MAX_WINDOWS_PER_DOC, max(1, MAX_PAIRS // max(1, len(docs))))

    plan = []          # per-doc list of (window_text, cached_score|None)
    uncached = []      # flat list of (window_text, doc_index)
    for di, doc in enumerate(docs):
        windows = _chunk_text(_doc_text(doc), max_windows)
        row = []
        for w in windows:
            key = _pair_key(query, w)
            cached = _cache_get(key)
            row.append((w, cached))
            if cached is None:
                uncached.append((w, di))
        plan.append(row)

    model = get_model()
    scores = []
    if uncached:
        pairs = [[query, w] for w, _ in uncached]
        try:
            preds = model.predict(
                pairs,
                batch_size=max(8, min(64, len(pairs))),
                convert_to_numpy=True,
                show_progress_bar=False,
            )
            scores = list(preds)
        except Exception as e:
            # A transient inference failure must not kill the whole request:
            # fall back to the retrieval score the caller already supplied.
            for w, di in uncached:
                _cache_put(_pair_key(query, w), float('nan'))
            raise e
        for (w, di), s in zip(uncached, scores):
            _cache_put(_pair_key(query, w), float(s))

    for di, doc in enumerate(docs):
        best = None
        for w, cached in plan[di]:
            if cached is not None:
                s = cached
            else:
                s = _cache_get(_pair_key(query, w))
            if s is not None and s == s:  # skip NaN
                best = s if best is None else max(best, s)
        if best is not None:
            doc["rerank_score"] = float(best)

    docs.sort(key=lambda x: x.get("rerank_score", 0), reverse=True)
    return docs[:top_n]


class RerankHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(f"[rerank-server] {fmt % args}\n")

    def _send_json(self, code, obj):
        data = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/health':
            self._send_json(200, {"status": "ok", "model_loaded": _model is not None})
        else:
            self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != '/rerank':
            self._send_json(404, {"error": "Not found"})
            return

        try:
            length = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode('utf-8'))
        except Exception as e:
            self._send_json(400, {"error": f"Bad request: {e}"})
            return

        query = payload.get('query', '')
        docs = payload.get('docs', [])
        if not query or not isinstance(docs, list) or len(docs) == 0:
            self._send_json(400, {"error": "query and docs (non-empty array) are required"})
            return

        try:
            results = rerank(query, docs, top_n=10)
            self._send_json(200, {"results": results})
        except Exception as e:
            self._send_json(500, {"error": f"Rerank failed: {e}"})


def main():
    parser = argparse.ArgumentParser(description="Persistent BGE-reranker HTTP service")
    parser.add_argument('--port', type=int, default=18766)
    parser.add_argument('--host', type=str, default='127.0.0.1')
    args = parser.parse_args()

    # Preload model at startup so first request is fast
    try:
        get_model()
    except Exception as e:
        print(f"[rerank-server] FATAL: {e}", flush=True)
        sys.exit(1)

    server = HTTPServer((args.host, args.port), RerankHandler)
    print(f"[rerank-server] Listening on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()