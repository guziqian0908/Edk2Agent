#!/usr/bin/env python3
"""
TianoCore Wiki MCP Server - WeKnora-style RAG

MCP server providing semantic search access to EDK II documentation.
Based on WeKnora RAG architecture (https://github.com/Tencent/WeKnora)

Features:
- Hybrid search (vector + keyword)
- Document chunking
- Semantic similarity
- Knowledge base management

Data Sources:
- TianoCore Wiki (https://www.tianocore.org/tianocore-wiki.github.io/)
- TianoCore Docs (https://github.com/tianocore-docs)
"""

import json
import os
import sys
import asyncio
import argparse
from pathlib import Path
from typing import Optional, List, Dict, Any
import logging

from rag_engine import RAGEngine, ChunkingConfig

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

KNOWLEDGE_DIR = Path(__file__).parent / "knowledge"
RAG_STATE_FILE = KNOWLEDGE_DIR / "rag_state.json"


class TianoCoreWikiMCPServer:
    """MCP Server for TianoCore Wiki with WeKnora-style RAG"""
    
    def __init__(self):
        self.rag_engine: Optional[RAGEngine] = None
        self._initialize_rag()
    
    def _initialize_rag(self):
        """Initialize RAG engine"""
        if RAG_STATE_FILE.exists():
            logger.info(f"Loading RAG state from {RAG_STATE_FILE}")
            self.rag_engine = RAGEngine.load(RAG_STATE_FILE)
        
        if not self.rag_engine:
            logger.info("Creating new RAG engine")
            config = ChunkingConfig(chunk_size=1024, chunk_overlap=200)
            self.rag_engine = RAGEngine(config)
            
            if KNOWLEDGE_DIR.exists():
                self._load_knowledge_base()
    
    def _load_knowledge_base(self):
        """Load documents from knowledge base"""
        wiki_index = KNOWLEDGE_DIR / "wiki_index.json"
        
        if not wiki_index.exists():
            logger.warning(f"Knowledge base not found at {wiki_index}")
            return
        
        with open(wiki_index, "r", encoding="utf-8") as f:
            kb_data = json.load(f)
        
        pages = kb_data.get("pages", {})
        
        for path, page_data in pages.items():
            content = page_data.get("content", "")
            title = page_data.get("title", path)
            source = page_data.get("source", "tianocore-wiki")
            
            if content:
                self.rag_engine.add_document(
                    doc_id=path,
                    content=f"{title}\n\n{content}",
                    metadata={
                        "path": path,
                        "title": title,
                        "source": source
                    }
                )
        
        logger.info(f"Loaded {len(pages)} pages into RAG engine")
        
        self.rag_engine.save(RAG_STATE_FILE)
    
    def get_tools(self) -> List[Dict[str, Any]]:
        """Get available MCP tools"""
        return [
            {
                "name": "hybrid_search",
                "description": "Hybrid search combining vector similarity and keyword matching for EDK II documentation. Returns relevant chunks with semantic scores.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search query for EDK II documentation"
                        },
                        "top_k": {
                            "type": "integer",
                            "description": "Number of results to return",
                            "default": 10
                        },
                        "vector_threshold": {
                            "type": "number",
                            "description": "Minimum vector similarity score (0.0-1.0)",
                            "default": 0.3
                        },
                        "keyword_threshold": {
                            "type": "number",
                            "description": "Minimum keyword match ratio (0.0-1.0)",
                            "default": 0.1
                        },
                        "source": {
                            "type": "string",
                            "description": "Filter by source: 'tianocore-wiki' or 'tianocore-docs'",
                            "enum": ["tianocore-wiki", "tianocore-docs"]
                        }
                    },
                    "required": ["query"]
                }
            },
            {
                "name": "semantic_search",
                "description": "Pure semantic search using vector embeddings. Best for concept-based queries.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Semantic search query"
                        },
                        "top_k": {
                            "type": "integer",
                            "description": "Number of results",
                            "default": 5
                        },
                        "threshold": {
                            "type": "number",
                            "description": "Minimum similarity threshold",
                            "default": 0.5
                        }
                    },
                    "required": ["query"]
                }
            },
            {
                "name": "get_document",
                "description": "Get full document content by path",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "doc_id": {
                            "type": "string",
                            "description": "Document path (e.g., 'development/tutorials-howto/getting_started_with_edk_ii')"
                        }
                    },
                    "required": ["doc_id"]
                }
            },
            {
                "name": "get_chunk",
                "description": "Get specific document chunk by ID",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "chunk_id": {
                            "type": "string",
                            "description": "Chunk ID from search results"
                        }
                    },
                    "required": ["chunk_id"]
                }
            },
            {
                "name": "list_sources",
                "description": "List available documentation sources",
                "inputSchema": {
                    "type": "object",
                    "properties": {}
                }
            },
            {
                "name": "get_stats",
                "description": "Get RAG engine statistics (documents, chunks, vocabulary)",
                "inputSchema": {
                    "type": "object",
                    "properties": {}
                }
            },
            {
                "name": "list_categories",
                "description": "List documentation categories",
                "inputSchema": {
                    "type": "object",
                    "properties": {}
                }
            }
        ]
    
    async def handle_request(self, request: dict) -> dict:
        """Handle MCP request"""
        method = request.get("method")
        params = request.get("params", {})
        
        if method == "initialize":
            return {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {},
                    "resources": {}
                },
                "serverInfo": {
                    "name": "tianocore-wiki-rag",
                    "version": "2.0.0",
                    "description": "TianoCore Wiki MCP Server with WeKnora-style RAG"
                }
            }
        
        elif method == "tools/list":
            return {"tools": self.get_tools()}
        
        elif method == "tools/call":
            return self._handle_tool_call(params)
        
        elif method == "resources/list":
            return {
                "resources": [
                    {
                        "uri": "tianocore://documents",
                        "name": "TianoCore Documents",
                        "description": "All indexed EDK II documentation",
                        "mimeType": "application/json"
                    }
                ]
            }
        
        return {"error": f"Unknown method: {method}"}
    
    def _handle_tool_call(self, params: dict) -> dict:
        """Handle tool execution"""
        tool_name = params.get("name")
        arguments = params.get("arguments", {})
        
        try:
            if tool_name == "hybrid_search":
                return self._tool_hybrid_search(arguments)
            
            elif tool_name == "semantic_search":
                return self._tool_semantic_search(arguments)
            
            elif tool_name == "get_document":
                return self._tool_get_document(arguments)
            
            elif tool_name == "get_chunk":
                return self._tool_get_chunk(arguments)
            
            elif tool_name == "list_sources":
                return self._tool_list_sources(arguments)
            
            elif tool_name == "get_stats":
                return self._tool_get_stats(arguments)
            
            elif tool_name == "list_categories":
                return self._tool_list_categories(arguments)
            
            else:
                return {"error": f"Unknown tool: {tool_name}"}
        
        except Exception as e:
            logger.error(f"Tool execution error: {e}")
            return {"error": str(e)}
    
    def _tool_hybrid_search(self, args: dict) -> dict:
        """Hybrid search tool"""
        query = args.get("query", "")
        top_k = args.get("top_k", 10)
        vector_threshold = args.get("vector_threshold", 0.3)
        keyword_threshold = args.get("keyword_threshold", 0.1)
        source = args.get("source")
        
        if not query:
            return {"error": "Missing required parameter: query"}
        
        results = self.rag_engine.search(
            query,
            top_k=top_k,
            vector_threshold=vector_threshold,
            keyword_threshold=keyword_threshold
        )
        
        if source:
            results = [r for r in results if r["metadata"].get("source") == source]
        
        formatted = []
        for result in results:
            formatted.append({
                "chunk_id": result["chunk_id"],
                "title": result["metadata"].get("title", "Unknown"),
                "snippet": result["text"],
                "source": result["metadata"].get("source", "unknown"),
                "path": result["metadata"].get("path", ""),
                "scores": result["scores"]
            })
        
        return {
            "content": [{
                "type": "text",
                "text": json.dumps({
                    "query": query,
                    "total_results": len(formatted),
                    "results": formatted
                }, indent=2, ensure_ascii=False)
            }]
        }
    
    def _tool_semantic_search(self, args: dict) -> dict:
        """Semantic search tool"""
        query = args.get("query", "")
        top_k = args.get("top_k", 5)
        threshold = args.get("threshold", 0.5)
        
        if not query:
            return {"error": "Missing required parameter: query"}
        
        results = self.rag_engine.vector_store.search(query, top_k, threshold)
        
        formatted = []
        for chunk, score in results:
            formatted.append({
                "chunk_id": chunk.chunk_id,
                "text": chunk.text[:500] + "..." if len(chunk.text) > 500 else chunk.text,
                "metadata": chunk.metadata,
                "score": score
            })
        
        return {
            "content": [{
                "type": "text",
                "text": json.dumps({
                    "query": query,
                    "total_results": len(formatted),
                    "threshold": threshold,
                    "results": formatted
                }, indent=2, ensure_ascii=False)
            }]
        }
    
    def _tool_get_document(self, args: dict) -> dict:
        """Get document tool"""
        doc_id = args.get("doc_id", "")
        
        if not doc_id:
            return {"error": "Missing required parameter: doc_id"}
        
        doc = self.rag_engine.get_document(doc_id)
        
        if doc:
            return {
                "content": [{
                    "type": "text",
                    "text": doc["content"]
                }]
            }
        
        return {
            "content": [{
                "type": "text",
                "text": f"Document not found: {doc_id}"
            }]
        }
    
    def _tool_get_chunk(self, args: dict) -> dict:
        """Get chunk tool"""
        chunk_id = args.get("chunk_id", "")
        
        if not chunk_id:
            return {"error": "Missing required parameter: chunk_id"}
        
        chunk = self.rag_engine.vector_store.get_chunk(chunk_id)
        
        if chunk:
            return {
                "content": [{
                    "type": "text",
                    "text": json.dumps(chunk.to_dict(), indent=2, ensure_ascii=False)
                }]
            }
        
        return {
            "content": [{
                "type": "text",
                "text": f"Chunk not found: {chunk_id}"
            }]
        }
    
    def _tool_list_sources(self, args: dict) -> dict:
        """List sources tool"""
        sources = {
            "tianocore-wiki": {
                "description": "TianoCore Wiki - Official EDK II development documentation",
                "url": "https://www.tianocore.org/tianocore-wiki.github.io/",
                "content_type": "HTML pages",
                "categories": ["Getting Started", "Development", "Platforms", "Specifications", "Community"]
            },
            "tianocore-docs": {
                "description": "TianoCore Docs Repository - UEFI/PI specifications",
                "url": "https://github.com/tianocore-docs",
                "content_type": "Markdown files",
                "repositories": [
                    "edk2-DecSpecification",
                    "edk2-UefiSpecification",
                    "edk2-PISpecification",
                    "edk2-UEFI-Shell-Specification"
                ]
            }
        }
        
        return {
            "content": [{
                "type": "text",
                "text": json.dumps(sources, indent=2, ensure_ascii=False)
            }]
        }
    
    def _tool_get_stats(self, args: dict) -> dict:
        """Get statistics tool"""
        stats = self.rag_engine.get_stats()
        
        return {
            "content": [{
                "type": "text",
                "text": json.dumps({
                    "rag_engine": stats,
                    "server": {
                        "name": "tianocore-wiki-rag",
                        "version": "2.0.0",
                        "backend": "WeKnora-style RAG"
                    }
                }, indent=2, ensure_ascii=False)
            }]
        }
    
    def _tool_list_categories(self, args: dict) -> dict:
        """List categories tool"""
        categories = {
            "Getting Started": [
                "development/tutorials-howto/getting_started_with_edk_ii"
            ],
            "Development": [
                "development/contribution-guides/how_to_contribute",
                "development/tutorials-howto"
            ],
            "Platforms": [
                "platforms-packages/platform-ports/ovmf",
                "platforms-packages/platform-ports/emulator_pkg"
            ],
            "Specifications": [
                "reference/specs-standards/uefi",
                "reference/specs-standards/pi"
            ],
            "Community": [
                "community/support-onboarding/reporting_issues",
                "governance/charter-policies/inclusive_language_guidelines"
            ]
        }
        
        return {
            "content": [{
                "type": "text",
                "text": json.dumps(categories, indent=2, ensure_ascii=False)
            }]
        }
    
    async def run_server(self):
        """Run the MCP server"""
        logger.info("TianoCore Wiki MCP Server (WeKnora-style RAG) starting...")
        logger.info(f"Knowledge directory: {KNOWLEDGE_DIR}")
        logger.info(f"RAG state file: {RAG_STATE_FILE}")
        
        stats = self.rag_engine.get_stats()
        logger.info(f"Loaded {stats['documents']} documents, {stats['total_chunks']} chunks")
        
        while True:
            try:
                line = sys.stdin.readline()
                if not line:
                    break
                
                request = json.loads(line.strip())
                response = await self.handle_request(request)
                
                sys.stdout.write(json.dumps(response) + "\n")
                sys.stdout.flush()
            except json.JSONDecodeError as e:
                logger.error(f"JSON decode error: {e}")
            except Exception as e:
                logger.error(f"Server error: {e}")


def main():
    parser = argparse.ArgumentParser(description="TianoCore Wiki MCP Server with WeKnora-style RAG")
    parser.add_argument("--fetch", action="store_true", help="Fetch wiki content first")
    parser.add_argument("--rebuild-index", action="store_true", help="Rebuild RAG index")
    parser.add_argument("--stats", action="store_true", help="Show RAG engine statistics")
    args = parser.parse_args()
    
    if args.fetch:
        from fetch_wiki import fetch_all_pages
        fetch_all_pages()
    elif args.rebuild_index:
        if RAG_STATE_FILE.exists():
            RAG_STATE_FILE.unlink()
        logger.info("RAG index will be rebuilt on next start")
    elif args.stats:
        server = TianoCoreWikiMCPServer()
        stats = server.rag_engine.get_stats()
        print(json.dumps(stats, indent=2))
    else:
        server = TianoCoreWikiMCPServer()
        asyncio.run(server.run_server())


if __name__ == "__main__":
    main()