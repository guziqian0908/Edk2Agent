"""
WeKnora-style RAG Engine for TianoCore Wiki

Inspired by Tencent WeKnora (https://github.com/Tencent/WeKnora)
Provides semantic search, document chunking, and vector indexing capabilities.
"""

import json
import re
import logging
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass, field
from collections import defaultdict
import hashlib

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class Chunk:
    text: str
    metadata: Dict[str, Any] = field(default_factory=dict)
    chunk_id: str = ""
    embedding: Optional[List[float]] = None
    
    def to_dict(self) -> Dict:
        return {
            "chunk_id": self.chunk_id,
            "text": self.text,
            "metadata": self.metadata,
            "embedding": self.embedding
        }
    
    @classmethod
    def from_dict(cls, data: Dict) -> "Chunk":
        return cls(
            chunk_id=data.get("chunk_id", ""),
            text=data.get("text", ""),
            metadata=data.get("metadata", {}),
            embedding=data.get("embedding")
        )


@dataclass
class ChunkingConfig:
    chunk_size: int = 1024
    chunk_overlap: int = 200
    separators: List[str] = field(default_factory=lambda: ["\n\n", "\n", ".", " "])
    enable_multimodal: bool = False


class TextChunker:
    """Split documents into chunks for vector indexing"""
    
    def __init__(self, config: ChunkingConfig = None):
        self.config = config or ChunkingConfig()
    
    def chunk_text(self, text: str, metadata: Dict[str, Any] = None) -> List[Chunk]:
        """Split text into overlapping chunks"""
        if not text:
            return []
        
        metadata = metadata or {}
        chunks = []
        
        paragraphs = text.split("\n\n")
        current_chunk = ""
        chunk_index = 0
        
        for para in paragraphs:
            para = para.strip()
            if not para:
                continue
            
            if len(current_chunk) + len(para) + 2 <= self.config.chunk_size:
                current_chunk = current_chunk + "\n\n" + para if current_chunk else para
            else:
                if current_chunk:
                    chunk = self._create_chunk(current_chunk, metadata, chunk_index)
                    chunks.append(chunk)
                    chunk_index += 1
                
                current_chunk = para
        
        if current_chunk:
            chunk = self._create_chunk(current_chunk, metadata, chunk_index)
            chunks.append(chunk)
        
        return chunks
    
    def _create_chunk(self, text: str, metadata: Dict[str, Any], index: int) -> Chunk:
        chunk_id = self._generate_chunk_id(text, metadata.get("path", ""), index)
        chunk_metadata = metadata.copy()
        chunk_metadata["chunk_index"] = index
        return Chunk(text=text, metadata=chunk_metadata, chunk_id=chunk_id)
    
    def _generate_chunk_id(self, text: str, path: str, index: int) -> str:
        unique_str = f"{path}:{index}:{text[:50]}"
        return hashlib.md5(unique_str.encode()).hexdigest()[:12]


class SimpleEmbedding:
    """Simple TF-IDF based embedding for semantic similarity
    
    For production, consider using:
    - sentence-transformers (https://www.sbert.net/)
    - OpenAI embeddings
    - Local embedding models via Ollama
    """
    
    def __init__(self):
        self.vocab = {}
        self.idf = {}
        self.doc_count = 0
    
    def fit(self, documents: List[str]):
        """Build vocabulary and IDF from documents"""
        word_counts = defaultdict(int)
        doc_freq = defaultdict(int)
        
        for doc in documents:
            words = self._tokenize(doc)
            seen_words = set(words)
            
            for word in seen_words:
                doc_freq[word] += 1
            
            for word in words:
                word_counts[word] += 1
        
        self.vocab = {word: idx for idx, word in enumerate(word_counts.keys())}
        self.doc_count = len(documents)
        
        for word, freq in doc_freq.items():
            self.idf[word] = 1.0 + (self.doc_count / (freq + 1))
        
        logger.info(f"Built vocabulary with {len(self.vocab)} words from {self.doc_count} documents")
    
    def encode(self, text: str) -> List[float]:
        """Encode text to TF-IDF vector"""
        words = self._tokenize(text)
        word_freq = defaultdict(int)
        
        for word in words:
            word_freq[word] += 1
        
        total_words = len(words)
        vector = [0.0] * len(self.vocab)
        
        for word, freq in word_freq.items():
            if word in self.vocab:
                tf = freq / total_words if total_words > 0 else 0
                idf = self.idf.get(word, 1.0)
                idx = self.vocab[word]
                vector[idx] = tf * idf
        
        return vector
    
    def _tokenize(self, text: str) -> List[str]:
        """Simple tokenization"""
        text = text.lower()
        text = re.sub(r'[^\w\s]', ' ', text)
        words = text.split()
        return [w for w in words if len(w) > 1]
    
    def similarity(self, vec1: List[float], vec2: List[float]) -> float:
        """Cosine similarity between two vectors"""
        if not vec1 or not vec2:
            return 0.0
        
        dot_product = sum(a * b for a, b in zip(vec1, vec2))
        norm1 = sum(a * a for a in vec1) ** 0.5
        norm2 = sum(b * b for b in vec2) ** 0.5
        
        if norm1 == 0 or norm2 == 0:
            return 0.0
        
        return dot_product / (norm1 * norm2)


class VectorStore:
    """Simple in-memory vector store for document chunks"""
    
    def __init__(self, embedding_model: SimpleEmbedding = None):
        self.embedding_model = embedding_model or SimpleEmbedding()
        self.chunks: List[Chunk] = []
        self.chunk_index: Dict[str, Chunk] = {}
    
    def add_chunks(self, chunks: List[Chunk]):
        """Add chunks to the vector store"""
        documents = [c.text for c in chunks]
        
        if not self.embedding_model.vocab:
            self.embedding_model.fit(documents)
        
        for chunk in chunks:
            chunk.embedding = self.embedding_model.encode(chunk.text)
            self.chunks.append(chunk)
            self.chunk_index[chunk.chunk_id] = chunk
        
        logger.info(f"Added {len(chunks)} chunks to vector store")
    
    def search(self, query: str, top_k: int = 5, threshold: float = 0.0) -> List[Tuple[Chunk, float]]:
        """Search for similar chunks"""
        query_embedding = self.embedding_model.encode(query)
        
        results = []
        for chunk in self.chunks:
            if chunk.embedding:
                score = self.embedding_model.similarity(query_embedding, chunk.embedding)
                if score >= threshold:
                    results.append((chunk, score))
        
        results.sort(key=lambda x: x[1], reverse=True)
        return results[:top_k]
    
    def get_chunk(self, chunk_id: str) -> Optional[Chunk]:
        """Get chunk by ID"""
        return self.chunk_index.get(chunk_id)
    
    def get_stats(self) -> Dict[str, Any]:
        """Get vector store statistics"""
        return {
            "total_chunks": len(self.chunks),
            "vocab_size": len(self.embedding_model.vocab),
            "sources": len(set(c.metadata.get("source", "unknown") for c in self.chunks))
        }


class HybridSearchEngine:
    """Combine keyword and semantic search"""
    
    def __init__(self, vector_store: VectorStore):
        self.vector_store = vector_store
    
    def search(
        self,
        query: str,
        top_k: int = 10,
        vector_threshold: float = 0.3,
        keyword_threshold: float = 0.1,
        alpha: float = 0.7
    ) -> List[Dict[str, Any]]:
        """Hybrid search combining vector similarity and keyword matching
        
        Args:
            query: Search query
            top_k: Maximum results to return
            vector_threshold: Minimum similarity score for vector results
            keyword_threshold: Minimum keyword match ratio
            alpha: Weight for vector search (1-alpha for keyword)
        
        Returns:
            List of results with combined scores
        """
        vector_results = self._vector_search(query, top_k * 2, vector_threshold)
        keyword_results = self._keyword_search(query, top_k * 2, keyword_threshold)
        
        combined = {}
        
        for chunk, score in vector_results:
            combined[chunk.chunk_id] = {
                "chunk": chunk,
                "vector_score": score,
                "keyword_score": 0.0,
                "combined_score": alpha * score
            }
        
        for chunk, score in keyword_results:
            if chunk.chunk_id in combined:
                combined[chunk.chunk_id]["keyword_score"] = score
                combined[chunk.chunk_id]["combined_score"] += (1 - alpha) * score
            else:
                combined[chunk.chunk_id] = {
                    "chunk": chunk,
                    "vector_score": 0.0,
                    "keyword_score": score,
                    "combined_score": (1 - alpha) * score
                }
        
        results = sorted(combined.values(), key=lambda x: x["combined_score"], reverse=True)
        return results[:top_k]
    
    def _vector_search(self, query: str, top_k: int, threshold: float) -> List[Tuple[Chunk, float]]:
        """Semantic search using embeddings"""
        return self.vector_store.search(query, top_k, threshold)
    
    def _keyword_search(self, query: str, top_k: int, threshold: float) -> List[Tuple[Chunk, float]]:
        """Simple keyword matching"""
        query_words = set(self._tokenize(query))
        if not query_words:
            return []
        
        results = []
        for chunk in self.vector_store.chunks:
            chunk_words = set(self._tokenize(chunk.text))
            if not chunk_words:
                continue
            
            common = query_words & chunk_words
            if common:
                score = len(common) / len(query_words)
                if score >= threshold:
                    results.append((chunk, score))
        
        results.sort(key=lambda x: x[1], reverse=True)
        return results[:top_k]
    
    def _tokenize(self, text: str) -> List[str]:
        """Simple tokenization for keyword matching"""
        text = text.lower()
        text = re.sub(r'[^\w\s]', ' ', text)
        return [w for w in text.split() if len(w) > 1]


class RAGEngine:
    """Main RAG engine combining all components"""
    
    def __init__(self, config: ChunkingConfig = None):
        self.config = config or ChunkingConfig()
        self.chunker = TextChunker(self.config)
        self.vector_store = VectorStore()
        self.search_engine = HybridSearchEngine(self.vector_store)
        self.documents: Dict[str, Dict[str, Any]] = {}
    
    def add_document(self, doc_id: str, content: str, metadata: Dict[str, Any] = None):
        """Add a document to the RAG system"""
        metadata = metadata or {}
        metadata["doc_id"] = doc_id
        
        self.documents[doc_id] = {
            "content": content,
            "metadata": metadata
        }
        
        chunks = self.chunker.chunk_text(content, metadata)
        self.vector_store.add_chunks(chunks)
        
        logger.info(f"Added document {doc_id} with {len(chunks)} chunks")
    
    def search(self, query: str, top_k: int = 5, **kwargs) -> List[Dict[str, Any]]:
        """Search the RAG system"""
        results = self.search_engine.search(query, top_k, **kwargs)
        
        formatted = []
        for result in results:
            chunk = result["chunk"]
            formatted.append({
                "chunk_id": chunk.chunk_id,
                "text": chunk.text[:500] + "..." if len(chunk.text) > 500 else chunk.text,
                "full_text": chunk.text,
                "metadata": chunk.metadata,
                "scores": {
                    "vector": result["vector_score"],
                    "keyword": result["keyword_score"],
                    "combined": result["combined_score"]
                }
            })
        
        return formatted
    
    def get_document(self, doc_id: str) -> Optional[Dict[str, Any]]:
        """Get original document"""
        return self.documents.get(doc_id)
    
    def get_stats(self) -> Dict[str, Any]:
        """Get RAG engine statistics"""
        return {
            "documents": len(self.documents),
            **self.vector_store.get_stats()
        }
    
    def save(self, path: Path):
        """Save RAG engine state to disk"""
        data = {
            "config": {
                "chunk_size": self.config.chunk_size,
                "chunk_overlap": self.config.chunk_overlap
            },
            "documents": self.documents,
            "chunks": [c.to_dict() for c in self.vector_store.chunks]
        }
        
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        
        logger.info(f"Saved RAG engine to {path}")
    
    @classmethod
    def load(cls, path: Path) -> "RAGEngine":
        """Load RAG engine state from disk"""
        if not path.exists():
            return None
        
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        
        config = ChunkingConfig(
            chunk_size=data["config"]["chunk_size"],
            chunk_overlap=data["config"]["chunk_overlap"]
        )
        
        engine = cls(config)
        engine.documents = data["documents"]
        
        chunks = [Chunk.from_dict(c) for c in data["chunks"]]
        engine.vector_store.add_chunks(chunks)
        
        logger.info(f"Loaded RAG engine from {path}")
        return engine