#!/usr/bin/env python3
"""
EDK2 Search Engine - Dual Source Support
Reusable, thread-safe search engine with lazy ChromaDB loading.

Used by both the MCP daemon (mcp_server.py) and the CLI (embedded_search.py).
The index and vector model are loaded once and kept in memory, so repeated
searches do not pay per-request model loading costs.
"""

import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_DATA_DIR = BASE_DIR / "data"

SOURCE_DISPLAY = {
    'tianocore-wiki': 'TianoCore Wiki (官网)',
    'tianocore-docs': 'tianocore-docs (仓库)',
}

# Embedding model used for retrieval. all-MiniLM-L6-v2 is small (~74MB) and
# fast to load; BAAI/bge-m3 (~2.2GB) historically failed to download and
# blocked daemon startup. Override via EDK2_EMBEDDING_MODEL / DEVICE.
EMBEDDING_MODEL = os.environ.get(
    "EDK2_EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
EMBEDDING_DEVICE = os.environ.get("EDK2_EMBEDDING_DEVICE", "cpu")

# Reranker (cross-encoder) used to reorder the initial retrieval candidates.
# small default keeps startup fast. local_files_only=True below guarantees
# search never blocks on a model download (a missing/corrupt model simply
# skips reranking). Override via EDK2_RERANKER_MODEL.
RERANKER_MODEL = os.environ.get(
    "EDK2_RERANKER_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2")

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
}


def rewrite_query(query: str) -> str:
    """Expand EDK2 technical terms for better retrieval.
    
    Args:
        query: Original user query
    
    Returns:
        Query with expanded technical terms
    """
    expanded = query
    for term, expansion in TERM_EXPANSIONS.items():
        # Match term as standalone word (case-sensitive)
        import re
        pattern = r'\b' + term + r'\b'
        if re.search(pattern, query):
            expanded = re.sub(pattern, expansion, expanded)
    
    return expanded


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
        self._documents: List[Dict[str, Any]] = []
        self._collection = None
        self._client = None

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
                self._ready = True
                return
            try:
                import chromadb
                from chromadb.utils import embedding_functions
                
                # Use the same embedding model used during indexing
                embedding_func = embedding_functions.SentenceTransformerEmbeddingFunction(
                    model_name=EMBEDDING_MODEL,
                    device=EMBEDDING_DEVICE,
                    normalize_embeddings=True
                )
                
                self._client = chromadb.PersistentClient(
                    path=str(self.chroma_dir))
                self._collection = self._client.get_or_create_collection(
                    "edk2_docs",
                    embedding_function=embedding_func
                )
            except ImportError:
                self._load_documents_index()
            except Exception as e:
                # If the embedding model fails to load, degrade gracefully to
                # the document-file fallback instead of blocking startup.
                self._load_documents_index()
                self._load_error = f"ChromaDB unavailable ({e}); using file search"
            self._ready = True

    def is_ready(self) -> bool:
        with self._lock:
            return self._ready

    @property
    def load_error(self) -> Optional[str]:
        with self._lock:
            return self._load_error

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
               source_filter: Optional[str] = None) -> List[Dict[str, Any]]:
        """Search the knowledge base.

        Args:
            query: Search query text.
            top_k: Maximum number of results to return.
            source_filter: Optional source restriction, one of
                'tianocore-wiki', 'tianocore-docs', or None for all.
        """
        # Rewrite query to expand technical terms
        expanded_query = rewrite_query(query)
        
        self.load()
        if self._collection is not None:
            # Retrieve more candidates for reranking
            candidates = self._search_chroma(expanded_query, top_k * 4, source_filter)
            
            # Rerank if we have enough candidates
            if len(candidates) > top_k:
                return self._rerank_results(query, candidates, top_k)
            return candidates[:top_k]
        return self._search_files(expanded_query, top_k, source_filter)
    
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
        try:
            from sentence_transformers import CrossEncoder
            
            # Load reranker model (lazy, only when needed). local_files_only
            # prevents any network download here: a missing or incomplete
            # cached model raises immediately and we fall back to the raw
            # candidates instead of blocking the request.
            if not hasattr(self, '_reranker'):
                self._reranker = CrossEncoder(
                    RERANKER_MODEL,
                    max_length=512,
                    local_files_only=True,
                )
            
            # Prepare query-document pairs
            pairs = [(query, c['snippet']) for c in candidates]
            
            # Score with cross-encoder
            scores = self._reranker.predict(pairs)
            
            # Sort by reranker score
            scored_results = list(zip(candidates, scores))
            scored_results.sort(key=lambda x: x[1], reverse=True)
            
            # Return top_k with updated scores
            results = []
            for candidate, score in scored_results[:top_k]:
                candidate['rerank_score'] = float(score)
                results.append(candidate)
            
            return results
            
        except Exception as e:
            # If reranking fails, return original candidates
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

                    source_key = f"{source}:{metadata.get('title', metadata.get('file', ''))}"
                    if source_key in seen_sources:
                        continue
                    seen_sources.add(source_key)

                    documents.append({
                        'score': round(
                            1.0 - results['distances'][0][i], 4
                        ) if results.get('distances') else 0.5,
                        'source': source,
                        'source_display': self._format_source(source),
                        'title': metadata.get('title',
                                              metadata.get('file', 'Unknown')),
                        'url': metadata.get('url', ''),
                        'file': metadata.get('file', ''),
                        'snippet': doc[:500],
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
                        'snippet': self._extract_snippet(
                            content, query_terms)[:500],
                    })
            except Exception:
                continue

        results.sort(key=lambda x: x['score'], reverse=True)
        return results[:top_k]

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
