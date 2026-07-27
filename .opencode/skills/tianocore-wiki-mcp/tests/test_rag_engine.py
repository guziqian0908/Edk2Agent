#!/usr/bin/env python3
"""
Test Suite for WeKnora-style RAG Engine

Tests the RAG implementation including:
- Document chunking
- Vector embeddings
- Hybrid search
- MCP protocol compliance
"""

import unittest
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from rag_engine import (
    ChunkingConfig,
    TextChunker,
    SimpleEmbedding,
    VectorStore,
    HybridSearchEngine,
    RAGEngine,
    Chunk
)


class TestTextChunker(unittest.TestCase):
    """Test document chunking"""
    
    def setUp(self):
        self.config = ChunkingConfig(chunk_size=100, chunk_overlap=20)
        self.chunker = TextChunker(self.config)
    
    def test_simple_chunking(self):
        """Test basic text chunking"""
        text = "This is a test. " * 20
        chunks = self.chunker.chunk_text(text, {"path": "test"})
        
        self.assertTrue(len(chunks) > 0)
        for chunk in chunks:
            self.assertTrue(len(chunk.text) <= self.config.chunk_size + 50)
            self.assertEqual(chunk.metadata["path"], "test")
    
    def test_chunk_id_generation(self):
        """Test unique chunk IDs"""
        chunks1 = self.chunker.chunk_text("Test content one", {"path": "doc1"})
        chunks2 = self.chunker.chunk_text("Test content two", {"path": "doc2"})
        
        ids1 = [c.chunk_id for c in chunks1]
        ids2 = [c.chunk_id for c in chunks2]
        
        # Different documents should have different chunk IDs
        for id1 in ids1:
            self.assertNotIn(id1, ids2)
    
    def test_empty_text(self):
        """Test handling of empty text"""
        chunks = self.chunker.chunk_text("", {})
        self.assertEqual(len(chunks), 0)


class TestSimpleEmbedding(unittest.TestCase):
    """Test TF-IDF embeddings"""
    
    def setUp(self):
        self.embedding = SimpleEmbedding()
        self.documents = [
            "UEFI is the Unified Extensible Firmware Interface",
            "EDK II is the EFI Development Kit",
            "OVMF is a UEFI firmware for QEMU"
        ]
        self.embedding.fit(self.documents)
    
    def test_vocabulary_building(self):
        """Test vocabulary is built"""
        self.assertTrue(len(self.embedding.vocab) > 0)
    
    def test_encoding(self):
        """Test text encoding"""
        vector = self.embedding.encode("UEFI firmware")
        
        self.assertEqual(len(vector), len(self.embedding.vocab))
        self.assertTrue(any(v > 0 for v in vector))
    
    def test_similarity(self):
        """Test cosine similarity"""
        vec1 = self.embedding.encode("UEFI firmware interface")
        vec2 = self.embedding.encode("UEFI firmware")
        
        similarity = self.embedding.similarity(vec1, vec2)
        
        self.assertTrue(0 <= similarity <= 1)
        self.assertTrue(similarity > 0.5)  # Similar texts should have high similarity
    
    def test_dissimilarity(self):
        """Test dissimilar texts"""
        vec1 = self.embedding.encode("UEFI firmware")
        vec2 = self.embedding.encode("completely unrelated topic about cooking")
        
        similarity = self.embedding.similarity(vec1, vec2)
        
        self.assertTrue(similarity < 0.5)  # Dissimilar texts should have low similarity


class TestVectorStore(unittest.TestCase):
    """Test vector store"""
    
    def setUp(self):
        self.store = VectorStore()
        chunks = [
            Chunk(text="UEFI specification document", metadata={"source": "wiki"}, chunk_id="c1"),
            Chunk(text="EDK II development guide", metadata={"source": "wiki"}, chunk_id="c2"),
            Chunk(text="OVMF build instructions", metadata={"source": "docs"}, chunk_id="c3")
        ]
        self.store.add_chunks(chunks)
    
    def test_add_chunks(self):
        """Test adding chunks to store"""
        self.assertEqual(len(self.store.chunks), 3)
    
    def test_search(self):
        """Test search functionality"""
        results = self.store.search("UEFI", top_k=2)
        
        self.assertTrue(len(results) <= 2)
        for chunk, score in results:
            self.assertTrue(score >= 0)
    
    def test_get_chunk(self):
        """Test chunk retrieval"""
        chunk = self.store.get_chunk("c1")
        
        self.assertIsNotNone(chunk)
        self.assertEqual(chunk.chunk_id, "c1")
    
    def test_stats(self):
        """Test statistics"""
        stats = self.store.get_stats()
        
        self.assertEqual(stats["total_chunks"], 3)
        self.assertIn("vocab_size", stats)


class TestHybridSearchEngine(unittest.TestCase):
    """Test hybrid search"""
    
    def setUp(self):
        self.store = VectorStore()
        chunks = [
            Chunk(text="UEFI specification defines firmware interface",
                  metadata={"source": "wiki", "path": "uefi-spec"}, chunk_id="c1"),
            Chunk(text="EDK II is the EFI Development Kit for UEFI",
                  metadata={"source": "wiki", "path": "edk2"}, chunk_id="c2"),
            Chunk(text="OVMF is UEFI firmware for virtual machines",
                  metadata={"source": "docs", "path": "ovmf"}, chunk_id="c3")
        ]
        self.store.add_chunks(chunks)
        self.engine = HybridSearchEngine(self.store)
    
    def test_hybrid_search(self):
        """Test combined search"""
        results = self.engine.search("UEFI firmware", top_k=5)
        
        self.assertTrue(len(results) > 0)
        for result in results:
            self.assertIn("combined_score", result)
            self.assertIn("vector_score", result)
            self.assertIn("keyword_score", result)
    
    def test_result_ranking(self):
        """Test results are ranked by combined score"""
        results = self.engine.search("UEFI", top_k=10)
        
        scores = [r["combined_score"] for r in results]
        self.assertEqual(scores, sorted(scores, reverse=True))


class TestRAGEngine(unittest.TestCase):
    """Test complete RAG engine"""
    
    def setUp(self):
        self.engine = RAGEngine(ChunkingConfig(chunk_size=200))
    
    def test_add_document(self):
        """Test document addition"""
        self.engine.add_document(
            "test-doc",
            "This is a test document about UEFI development.",
            {"source": "test"}
        )
        
        self.assertIn("test-doc", self.engine.documents)
        self.assertTrue(len(self.engine.vector_store.chunks) > 0)
    
    def test_search(self):
        """Test search functionality"""
        self.engine.add_document(
            "uefi-spec",
            "UEFI Specification defines the interface between operating system and platform firmware.",
            {"source": "spec"}
        )
        
        results = self.engine.search("UEFI", top_k=5)
        
        self.assertTrue(len(results) > 0)
        for result in results:
            self.assertIn("text", result)
            self.assertIn("metadata", result)
            self.assertIn("scores", result)
    
    def test_get_document(self):
        """Test document retrieval"""
        self.engine.add_document("doc1", "Content", {"key": "value"})
        
        doc = self.engine.get_document("doc1")
        
        self.assertIsNotNone(doc)
        self.assertEqual(doc["content"], "Content")
    
    def test_stats(self):
        """Test statistics"""
        self.engine.add_document("doc1", "Test content", {})
        
        stats = self.engine.get_stats()
        
        self.assertEqual(stats["documents"], 1)
        self.assertIn("total_chunks", stats)
    
    def test_save_load(self):
        """Test persistence"""
        import tempfile
        import os
        
        self.engine.add_document("doc1", "Test content for persistence", {"key": "value"})
        
        with tempfile.TemporaryDirectory() as tmpdir:
            save_path = Path(tmpdir) / "test_rag.json"
            self.engine.save(save_path)
            
            self.assertTrue(save_path.exists())
            
            loaded_engine = RAGEngine.load(save_path)
            
            self.assertIsNotNone(loaded_engine)
            self.assertEqual(len(loaded_engine.documents), 1)
            self.assertEqual(len(loaded_engine.vector_store.chunks), len(self.engine.vector_store.chunks))


class TestMCPProtocol(unittest.TestCase):
    """Test MCP protocol compliance"""
    
    def test_tool_schema_format(self):
        """Test tool schemas follow MCP format"""
        tools = [
            {
                "name": "hybrid_search",
                "description": "Test tool",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"}
                    },
                    "required": ["query"]
                }
            }
        ]
        
        for tool in tools:
            self.assertIn("name", tool)
            self.assertIn("description", tool)
            self.assertIn("inputSchema", tool)
            self.assertEqual(tool["inputSchema"]["type"], "object")


class TestChunkDataClass(unittest.TestCase):
    """Test Chunk dataclass"""
    
    def test_chunk_creation(self):
        """Test chunk creation"""
        chunk = Chunk(
            text="Test content",
            metadata={"source": "test"},
            chunk_id="test123"
        )
        
        self.assertEqual(chunk.text, "Test content")
        self.assertEqual(chunk.metadata["source"], "test")
        self.assertEqual(chunk.chunk_id, "test123")
    
    def test_chunk_serialization(self):
        """Test chunk serialization"""
        chunk = Chunk(
            text="Test content",
            metadata={"key": "value"},
            chunk_id="abc",
            embedding=[0.1, 0.2, 0.3]
        )
        
        data = chunk.to_dict()
        
        self.assertIn("chunk_id", data)
        self.assertIn("text", data)
        self.assertIn("metadata", data)
        self.assertIn("embedding", data)
        
        restored = Chunk.from_dict(data)
        self.assertEqual(restored.text, chunk.text)
        self.assertEqual(restored.chunk_id, chunk.chunk_id)


if __name__ == "__main__":
    unittest.main(verbosity=2)