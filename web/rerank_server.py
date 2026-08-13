#!/usr/bin/env python3
"""
Persistent BGE-reranker-v2-m3 HTTP service.
Loads the model once, serves reranking requests over HTTP.

Usage: python rerank_server.py [--port 18766] [--host 127.0.0.1]

Endpoints:
  GET  /health            -> {"status":"ok"}
  POST /rerank            -> JSON body: {"query": "...", "docs": [...]}
                             Returns: {"results": [...]} (reranked, top 10)
"""

import sys
import json
import argparse
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

try:
    from sentence_transformers import CrossEncoder
except ImportError as e:
    print(json.dumps({"error": f"sentence_transformers not installed: {e}"}))
    sys.exit(1)

MODEL_PATH = Path.home() / ".edk2-opencode" / "models" / "bge-reranker-v2-m3"

# Global model instance (loaded once)
_model = None
_model_lock = threading.Lock()

def get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                if not MODEL_PATH.exists():
                    raise RuntimeError(f"Model not found at {MODEL_PATH}")
                print(f"[rerank-server] Loading model from {MODEL_PATH} ...", flush=True)
                _model = CrossEncoder(str(MODEL_PATH), max_length=512)
                print("[rerank-server] Model loaded.", flush=True)
    return _model

def build_pairs(query, docs):
    pairs = []
    for doc in docs:
        text = ""
        if doc.get("title"):
            text += doc["title"] + " "
        if doc.get("section"):
            text += doc["section"] + " "
        if doc.get("snippet"):
            text += doc["snippet"]
        elif doc.get("content"):
            text += doc["content"]
        pairs.append([query, text[:1000]])
    return pairs

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
            model = get_model()
            pairs = build_pairs(query, docs)
            scores = model.predict(pairs)
            for i, score in enumerate(scores):
                docs[i]["rerank_score"] = float(score)
            docs.sort(key=lambda x: x.get("rerank_score", 0), reverse=True)
            self._send_json(200, {"results": docs[:10]})
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