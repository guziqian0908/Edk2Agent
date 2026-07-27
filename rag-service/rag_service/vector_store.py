"""
Vector Store for RAG Service
Using LlamaIndex + ChromaDB for vector storage and retrieval
"""

import os
import logging
from typing import List, Dict, Optional, Any
from pathlib import Path
import json

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

try:
    from llama_index.core import VectorStoreIndex, Document as LlamaDocument, Settings
    from llama_index.core.node_parser import SimpleNodeParser
    from llama_index.embeddings.huggingface import HuggingFaceEmbedding
    from llama_index.vector_stores.chroma import ChromaVectorStore
    from llama_index.core.storage.storage_context import StorageContext
    import chromadb
    LLAMAINDEX_AVAILABLE = True
except ImportError:
    LLAMAINDEX_AVAILABLE = False
    logger.warning("LlamaIndex not installed. Install with: pip install llama-index llama-index-vector-stores-chroma chromadb")


class VectorStore:
    def __init__(self, config):
        self.config = config
        self.index: Optional[Any] = None
        self.vector_store: Optional[Any] = None
        self.chroma_client: Optional[Any] = None
        self.embed_model: Optional[Any] = None
        
        if not LLAMAINDEX_AVAILABLE:
            raise ImportError(
                "LlamaIndex is required for vector storage. "
                "Install with: pip install llama-index llama-index-vector-stores-chroma chromadb"
            )
        
        self._initialize()
    
    def _initialize(self):
        logger.info("Initializing vector store...")
        
        self.embed_model = HuggingFaceEmbedding(
            model_name=self.config.embedding_model
        )
        
        Settings.embed_model = self.embed_model
        Settings.chunk_size = self.config.chunk_size
        Settings.chunk_overlap = self.config.chunk_overlap
        
        persist_dir = Path(self.config.persist_directory)
        persist_dir.mkdir(parents=True, exist_ok=True)
        
        self.chroma_client = chromadb.PersistentClient(path=str(persist_dir))
        
        chroma_collection = self.chroma_client.get_or_create_collection("edk2_docs")
        
        self.vector_store = ChromaVectorStore(chroma_collection=chroma_collection)
        
        storage_context = StorageContext.from_defaults(
            vector_store=self.vector_store
        )
        
        self.storage_context = storage_context
        
        logger.info("Vector store initialized successfully")
    
    def add_documents(self, documents: List[Any]) -> int:
        from .document_fetcher import Document
        
        llama_docs = []
        
        for doc in documents:
            if isinstance(doc, Document):
                llama_doc = LlamaDocument(
                    doc_id=doc.doc_id,
                    text=doc.content,
                    metadata={
                        "title": doc.title,
                        "source": doc.source,
                        "url": doc.url,
                        **doc.metadata
                    }
                )
                llama_docs.append(llama_doc)
            elif isinstance(doc, LlamaDocument):
                llama_docs.append(doc)
        
        if not llama_docs:
            logger.warning("No documents to add")
            return 0
        
        logger.info(f"Adding {len(llama_docs)} documents to vector store...")
        
        parser = SimpleNodeParser.from_defaults(
            chunk_size=self.config.chunk_size,
            chunk_overlap=self.config.chunk_overlap
        )
        nodes = parser.get_nodes_from_documents(llama_docs)
        
        if self.index is None:
            self.index = VectorStoreIndex(
                nodes,
                storage_context=self.storage_context,
                embed_model=self.embed_model
            )
        else:
            self.index.insert_nodes(nodes)
        
        logger.info(f"Successfully added {len(nodes)} nodes to vector store")
        
        return len(nodes)
    
    def query(self, query_text: str, top_k: Optional[int] = None) -> List[Dict]:
        if self.index is None:
            logger.error("Index not initialized. Add documents first.")
            return []
        
        top_k = top_k or self.config.top_k_results
        
        query_engine = self.index.as_query_engine(
            similarity_top_k=top_k
        )
        
        response = query_engine.query(query_text)
        
        results = []
        for node in response.source_nodes:
            result = {
                "score": node.score,
                "content": node.node.text,
                "metadata": node.node.metadata,
                "node_id": node.node.node_id
            }
            results.append(result)
        
        return results
    
    def similarity_search(self, query_text: str, top_k: Optional[int] = None) -> List[Dict]:
        return self.query(query_text, top_k)
    
    def delete_document(self, doc_id: str) -> bool:
        try:
            if self.index is None:
                return False
            
            self.index.delete_nodes([doc_id])
            logger.info(f"Deleted document: {doc_id}")
            return True
        except Exception as e:
            logger.error(f"Error deleting document {doc_id}: {e}")
            return False
    
    def get_document_count(self) -> int:
        if self.chroma_client is None:
            return 0
        
        collection = self.chroma_client.get_collection("edk2_docs")
        return collection.count()
    
    def clear_all(self) -> bool:
        try:
            if self.chroma_client is None:
                return False
            
            self.chroma_client.delete_collection("edk2_docs")
            
            chroma_collection = self.chroma_client.create_collection("edk2_docs")
            self.vector_store = ChromaVectorStore(chroma_collection=chroma_collection)
            self.index = None
            
            logger.info("Cleared all documents from vector store")
            return True
        except Exception as e:
            logger.error(f"Error clearing vector store: {e}")
            return False
    
    def persist(self):
        if self.index is not None:
            self.index.storage_context.persist()
            logger.info("Vector store persisted successfully")
    
    def save_index(self, path: str):
        self.persist()
        logger.info(f"Index saved to {path}")