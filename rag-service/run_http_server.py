#!/usr/bin/env python3
"""
HTTP MCP Server for RAG Service
Centralized RAG service for EDK2 documentation retrieval
"""

import json
import logging
import argparse
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Dict, Any
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from rag_service.config import Config
from rag_service.vector_store import VectorStore

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class RAGHandler(BaseHTTPRequestHandler):
    vector_store = None
    config = None
    
    def log_message(self, format, *args):
        logger.info(f"[HTTP] {format % args}")
    
    def _send_json_response(self, data: Dict, status_code: int = 200):
        response = json.dumps(data, ensure_ascii=False)
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        self.wfile.write(response.encode('utf-8'))
    
    def do_OPTIONS(self):
        self._send_json_response({})
    
    def do_GET(self):
        if self.path == '/health':
            self._send_json_response({'status': 'ok', 'service': 'edk2-rag'})
        elif self.path == '/tools':
            self._handle_tools_list()
        elif self.path == '/sources':
            self._handle_list_sources()
        elif self.path == '/stats':
            self._handle_stats()
        else:
            self._send_json_response({'error': 'Not found'}, 404)
    
    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8')
        
        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self._send_json_response({'error': 'Invalid JSON'}, 400)
            return
        
        if self.path == '/search':
            self._handle_search(data)
        elif self.path == '/mcp':
            self._handle_mcp_request(data)
        else:
            self._send_json_response({'error': 'Not found'}, 404)
    
    def _handle_tools_list(self):
        tools = [
            {
                "name": "search_edk2_docs",
                "description": "Search EDK2 documentation using keywords",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search query"},
                        "top_k": {"type": "integer", "default": 5, "description": "Number of results"}
                    },
                    "required": ["query"]
                }
            },
            {
                "name": "list_edk2_sources",
                "description": "List available EDK2 documentation sources",
                "inputSchema": {"type": "object", "properties": {}}
            }
        ]
        self._send_json_response({'tools': tools})
    
    def _handle_search(self, data: Dict):
        query = data.get('query', '')
        top_k = data.get('top_k', 5)
        
        if not query:
            self._send_json_response({'error': 'Missing query parameter'}, 400)
            return
        
        if not self.vector_store:
            self._send_json_response({'error': 'Vector store not initialized'}, 500)
            return
        
        try:
            results = self.vector_store.similarity_search(query, top_k)
            formatted = []
            for r in results:
                formatted.append({
                    'title': r.get('metadata', {}).get('title', 'Unknown'),
                    'score': r.get('score', 0),
                    'content': r.get('content', ''),
                    'source': r.get('metadata', {}).get('source', ''),
                    'url': r.get('metadata', {}).get('url', '')
                })
            self._send_json_response({
                'query': query,
                'total_results': len(formatted),
                'results': formatted
            })
        except Exception as e:
            logger.error(f"Search error: {e}")
            self._send_json_response({'error': str(e)}, 500)
    
    def _handle_list_sources(self):
        sources = [
            {
                'name': 'tianocore-wiki',
                'description': 'TianoCore Wiki - EDK II development documentation',
                'url': 'https://github.com/tianocore/tianocore.github.io/wiki'
            },
            {
                'name': 'tianocore-docs',
                'description': 'TianoCore Documentation Repository',
                'url': 'https://github.com/tianocore/docs'
            }
        ]
        doc_count = self.vector_store.get_document_count() if self.vector_store else 0
        self._send_json_response({'sources': sources, 'total_documents': doc_count})
    
    def _handle_stats(self):
        stats = {
            'documents': self.vector_store.get_document_count() if self.vector_store else 0,
            'status': 'running'
        }
        self._send_json_response(stats)
    
    def _handle_mcp_request(self, data: Dict):
        method = data.get('method', '')
        params = data.get('params', {})
        request_id = data.get('id')
        
        if method == 'initialize':
            result = {
                'protocolVersion': '2024-11-05',
                'capabilities': {'tools': {}},
                'serverInfo': {'name': 'edk2-rag-http', 'version': '1.0.0'}
            }
        elif method == 'tools/list':
            result = {'tools': [
                {
                    'name': 'search_edk2_docs',
                    'description': 'Search EDK2 documentation',
                    'inputSchema': {
                        'type': 'object',
                        'properties': {
                            'query': {'type': 'string'},
                            'top_k': {'type': 'integer', 'default': 5}
                        },
                        'required': ['query']
                    }
                }
            ]}
        elif method == 'tools/call':
            tool_name = params.get('name', '')
            args = params.get('arguments', {})
            
            if tool_name == 'search_edk2_docs':
                query = args.get('query', '')
                top_k = args.get('top_k', 5)
                
                if self.vector_store and query:
                    results = self.vector_store.similarity_search(query, top_k)
                    formatted = [{'title': r.get('metadata', {}).get('title', ''),
                                  'score': r.get('score', 0),
                                  'content': r.get('content', '')} for r in results]
                    result = {'content': [{'type': 'text', 'text': json.dumps(formatted)}]}
                else:
                    result = {'content': [{'type': 'text', 'text': 'No results'}]}
            else:
                result = {'error': f'Unknown tool: {tool_name}'}
        else:
            self._send_json_response({
                'jsonrpc': '2.0',
                'error': {'code': -32601, 'message': f'Method not found: {method}'},
                'id': request_id
            }, 400)
            return
        
        self._send_json_response({'jsonrpc': '2.0', 'result': result, 'id': request_id})


def main():
    parser = argparse.ArgumentParser(description='EDK2 RAG HTTP Server')
    parser.add_argument('--host', default='0.0.0.0', help='Server host')
    parser.add_argument('--port', type=int, default=8080, help='Server port')
    parser.add_argument('--config', default='config.json', help='Config file path')
    args = parser.parse_args()
    
    config = Config.from_file(args.config) if os.path.exists(args.config) else Config()
    
    logger.info("Initializing vector store...")
    vector_store = VectorStore(config)
    
    RAGHandler.vector_store = vector_store
    RAGHandler.config = config
    
    server = HTTPServer((args.host, args.port), RAGHandler)
    
    logger.info(f"EDK2 RAG HTTP Server started on {args.host}:{args.port}")
    logger.info(f"Endpoints:")
    logger.info(f"  GET  /health   - Health check")
    logger.info(f"  GET  /tools    - List tools")
    logger.info(f"  GET  /sources  - List sources")
    logger.info(f"  POST /search   - Search documents")
    logger.info(f"  POST /mcp      - MCP protocol endpoint")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down...")
        server.shutdown()


if __name__ == '__main__':
    main()