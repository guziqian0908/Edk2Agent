"""
Test suite for EDK2 RAG Service
"""

import pytest
import tempfile
import shutil
from pathlib import Path
import json
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))

from rag_service.config import Config
from rag_service.document_fetcher import DocumentFetcher, Document


class TestConfig:
    def test_default_config(self):
        config = Config()
        
        assert config.persist_directory == "./chroma_db"
        assert config.embedding_model == "sentence-transformers/all-MiniLM-L6-v2"
        assert config.chunk_size == 1024
        assert config.chunk_overlap == 200
        assert config.top_k_results == 5
        assert config.mcp_server_host == "localhost"
        assert config.mcp_server_port == 8080
    
    def test_config_to_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = Path(tmpdir) / "test_config.json"
            
            config = Config(persist_directory="./test_db")
            config.to_file(str(config_path))
            
            assert config_path.exists()
            
            loaded_config = Config.from_file(str(config_path))
            assert loaded_config.persist_directory == "./test_db"
    
    def test_config_paths(self):
        config = Config(
            data_directory="./test_data",
            wiki_output_dir="wiki",
            docs_output_dir="docs"
        )
        
        assert config.wiki_full_path == "./test_data/wiki"
        assert config.docs_full_path == "./test_data/docs"


class TestDocument:
    def test_document_creation(self):
        doc = Document(
            doc_id="test-1",
            title="Test Document",
            content="This is test content",
            source="test-source"
        )
        
        assert doc.doc_id == "test-1"
        assert doc.title == "Test Document"
        assert doc.content == "This is test content"
        assert doc.source == "test-source"
        assert doc.metadata == {}
    
    def test_document_to_dict(self):
        doc = Document(
            doc_id="test-2",
            title="Test",
            content="Content",
            source="source",
            url="http://example.com",
            metadata={"key": "value"}
        )
        
        doc_dict = doc.to_dict()
        
        assert doc_dict["doc_id"] == "test-2"
        assert doc_dict["title"] == "Test"
        assert doc_dict["url"] == "http://example.com"
        assert doc_dict["metadata"]["key"] == "value"
    
    def test_document_from_dict(self):
        data = {
            "doc_id": "test-3",
            "title": "Test",
            "content": "Content",
            "source": "source",
            "url": "http://example.com",
            "metadata": {"key": "value"}
        }
        
        doc = Document.from_dict(data)
        
        assert doc.doc_id == "test-3"
        assert doc.title == "Test"
        assert doc.url == "http://example.com"
        assert doc.metadata["key"] == "value"


class TestDocumentFetcher:
    def test_fetcher_initialization(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config = Config(
                data_directory=tmpdir,
                persist_directory=str(Path(tmpdir) / "chroma")
            )
            
            fetcher = DocumentFetcher(config)
            
            assert fetcher.config == config
            assert fetcher.documents == []
    
    def test_save_and_load_documents(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config = Config(
                data_directory=tmpdir,
                persist_directory=str(Path(tmpdir) / "chroma")
            )
            
            fetcher = DocumentFetcher(config)
            
            doc1 = Document(
                doc_id="test-1",
                title="Doc 1",
                content="Content 1",
                source="test"
            )
            doc2 = Document(
                doc_id="test-2",
                title="Doc 2",
                content="Content 2",
                source="test"
            )
            
            fetcher.documents = [doc1, doc2]
            
            output_path = str(Path(tmpdir) / "documents.json")
            fetcher.save_documents(output_path)
            
            assert Path(output_path).exists()
            
            loaded_docs = fetcher.load_documents(output_path)
            
            assert len(loaded_docs) == 2
            assert loaded_docs[0].doc_id == "test-1"
            assert loaded_docs[1].doc_id == "test-2"


@pytest.mark.integration
class TestVectorStore:
    def test_vector_store_initialization(self):
        pytest.importorskip("llama_index")
        
        with tempfile.TemporaryDirectory() as tmpdir:
            config = Config(
                persist_directory=tmpdir,
                embedding_model="sentence-transformers/all-MiniLM-L6-v2"
            )
            
            from rag_service.vector_store import VectorStore
            
            vector_store = VectorStore(config)
            
            assert vector_store.config == config
            assert vector_store.chroma_client is not None
    
    def test_add_documents_to_vector_store(self):
        pytest.importorskip("llama_index")
        
        with tempfile.TemporaryDirectory() as tmpdir:
            config = Config(
                persist_directory=tmpdir,
                embedding_model="sentence-transformers/all-MiniLM-L6-v2",
                chunk_size=512,
                chunk_overlap=50
            )
            
            from rag_service.vector_store import VectorStore
            
            vector_store = VectorStore(config)
            
            doc = Document(
                doc_id="test-doc",
                title="Test Document",
                content="This is a test document for EDK2 development. "
                       "It contains information about UEFI firmware.",
                source="test"
            )
            
            node_count = vector_store.add_documents([doc])
            
            assert node_count > 0
            assert vector_store.get_document_count() > 0
    
    def test_similarity_search(self):
        pytest.importorskip("llama_index")
        
        with tempfile.TemporaryDirectory() as tmpdir:
            config = Config(
                persist_directory=tmpdir,
                embedding_model="sentence-transformers/all-MiniLM-L6-v2",
                chunk_size=512,
                chunk_overlap=50,
                top_k_results=3
            )
            
            from rag_service.vector_store import VectorStore
            
            vector_store = VectorStore(config)
            
            docs = [
                Document(
                    doc_id="doc-1",
                    title="UEFI Overview",
                    content="UEFI (Unified Extensible Firmware Interface) is a specification "
                           "defining a software interface between an operating system and platform firmware.",
                    source="test",
                    metadata={"topic": "uefi"}
                ),
                Document(
                    doc_id="doc-2",
                    title="EDK2 Introduction",
                    content="EDK II is a modern, feature-rich, cross-platform firmware development "
                           "environment for the UEFI and UEFI Platform Initialization specifications.",
                    source="test",
                    metadata={"topic": "edk2"}
                )
            ]
            
            vector_store.add_documents(docs)
            
            results = vector_store.similarity_search("What is UEFI?")
            
            assert len(results) > 0
            assert "score" in results[0]
            assert "content" in results[0]


@pytest.mark.integration
class TestMCPServer:
    def test_server_initialization(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config = Config(
                persist_directory=tmpdir,
                embedding_model="sentence-transformers/all-MiniLM-L6-v2"
            )
            
            class MockVectorStore:
                def __init__(self):
                    self.config = config
                
                def similarity_search(self, query, top_k=5):
                    return [
                        {
                            "score": 0.9,
                            "content": "Test result",
                            "metadata": {"title": "Test", "source": "test"}
                        }
                    ]
                
                def get_document_count(self):
                    return 10
            
            from rag_service.mcp_server import MCPServer
            
            server = MCPServer(config, MockVectorStore())
            
            assert server.config == config
            assert "search_edk2_docs" in server._tools
    
    def test_handle_initialize_request(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config = Config(persist_directory=tmpdir)
            
            class MockVectorStore:
                def get_document_count(self):
                    return 0
            
            from rag_service.mcp_server import MCPServer
            
            server = MCPServer(config, MockVectorStore())
            
            request_data = json.dumps({
                "jsonrpc": "2.0",
                "method": "initialize",
                "id": 1
            })
            
            response_data = server.handle_request(request_data)
            response = json.loads(response_data)
            
            assert response["jsonrpc"] == "2.0"
            assert "result" in response
            assert response["result"]["serverInfo"]["name"] == "edk2-rag-mcp"
    
    def test_handle_tools_list_request(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config = Config(persist_directory=tmpdir)
            
            class MockVectorStore:
                def get_document_count(self):
                    return 0
            
            from rag_service.mcp_server import MCPServer
            
            server = MCPServer(config, MockVectorStore())
            
            request_data = json.dumps({
                "jsonrpc": "2.0",
                "method": "tools/list",
                "id": 2
            })
            
            response_data = server.handle_request(request_data)
            response = json.loads(response_data)
            
            assert "result" in response
            assert "tools" in response["result"]
            
            tool_names = [t["name"] for t in response["result"]["tools"]]
            assert "search_edk2_docs" in tool_names
    
    def test_handle_tools_call_search(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config = Config(persist_directory=tmpdir)
            
            class MockVectorStore:
                def similarity_search(self, query, top_k=5):
                    return [
                        {
                            "score": 0.95,
                            "content": "UEFI is a firmware interface specification.",
                            "metadata": {
                                "title": "UEFI Overview",
                                "source": "tianocore-wiki",
                                "url": "https://example.com"
                            }
                        }
                    ]
            
            from rag_service.mcp_server import MCPServer
            
            server = MCPServer(config, MockVectorStore())
            
            request_data = json.dumps({
                "jsonrpc": "2.0",
                "method": "tools/call",
                "params": {
                    "name": "search_edk2_docs",
                    "arguments": {
                        "query": "What is UEFI?",
                        "top_k": 3
                    }
                },
                "id": 3
            })
            
            response_data = server.handle_request(request_data)
            response = json.loads(response_data)
            
            assert "result" in response
            assert "content" in response["result"]
    
    def test_handle_invalid_method(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config = Config(persist_directory=tmpdir)
            
            class MockVectorStore:
                pass
            
            from rag_service.mcp_server import MCPServer
            
            server = MCPServer(config, MockVectorStore())
            
            request_data = json.dumps({
                "jsonrpc": "2.0",
                "method": "invalid/method",
                "id": 4
            })
            
            response_data = server.handle_request(request_data)
            response = json.loads(response_data)
            
            assert "error" in response
            assert response["error"]["code"] == -32601


if __name__ == "__main__":
    pytest.main([__file__, "-v"])