"""
MCP Server for RAG Service
Provides Model Context Protocol API for EDK2 documentation retrieval
"""

import json
import logging
from typing import Dict, List, Optional, Any
from dataclasses import dataclass
import threading
import socket

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class MCPRequest:
    jsonrpc: str = "2.0"
    method: str = ""
    params: Dict = None
    id: Optional[int] = None
    
    @classmethod
    def from_dict(cls, data: Dict) -> "MCPRequest":
        return cls(
            jsonrpc=data.get("jsonrpc", "2.0"),
            method=data.get("method", ""),
            params=data.get("params", {}),
            id=data.get("id")
        )


@dataclass
class MCPResponse:
    jsonrpc: str = "2.0"
    result: Any = None
    error: Optional[Dict] = None
    id: Optional[int] = None
    
    def to_dict(self) -> Dict:
        data = {"jsonrpc": self.jsonrpc}
        if self.error:
            data["error"] = self.error
        else:
            data["result"] = self.result
        if self.id is not None:
            data["id"] = self.id
        return data


class MCPServer:
    def __init__(self, config, vector_store):
        self.config = config
        self.vector_store = vector_store
        self.running = False
        self.server_socket = None
        self._tools = self._register_tools()
    
    def _register_tools(self) -> Dict:
        return {
            "search_edk2_docs": {
                "name": "search_edk2_docs",
                "description": "Search EDK2 documentation using keywords. Returns relevant documentation snippets with context.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search query for EDK2 documentation"
                        },
                        "top_k": {
                            "type": "integer",
                            "description": "Number of results to return",
                            "default": 5
                        }
                    },
                    "required": ["query"]
                }
            },
            "get_edk2_doc_by_id": {
                "name": "get_edk2_doc_by_id",
                "description": "Retrieve a specific document by its ID from the vector store",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "doc_id": {
                            "type": "string",
                            "description": "Document ID to retrieve"
                        }
                    },
                    "required": ["doc_id"]
                }
            },
            "list_edk2_sources": {
                "name": "list_edk2_sources",
                "description": "List available EDK2 documentation sources in the knowledge base",
                "inputSchema": {
                    "type": "object",
                    "properties": {}
                }
            }
        }
    
    def handle_request(self, request_data: str) -> str:
        try:
            data = json.loads(request_data)
            request = MCPRequest.from_dict(data)
            
            if request.method == "initialize":
                response = self._handle_initialize(request)
            elif request.method == "tools/list":
                response = self._handle_tools_list(request)
            elif request.method == "tools/call":
                response = self._handle_tools_call(request)
            elif request.method == "resources/list":
                response = self._handle_resources_list(request)
            else:
                response = MCPResponse(
                    error={"code": -32601, "message": f"Method not found: {request.method}"},
                    id=request.id
                )
            
            return json.dumps(response.to_dict())
            
        except json.JSONDecodeError as e:
            error_response = MCPResponse(
                error={"code": -32700, "message": f"Parse error: {str(e)}"}
            )
            return json.dumps(error_response.to_dict())
        except Exception as e:
            logger.error(f"Error handling request: {e}")
            error_response = MCPResponse(
                error={"code": -32603, "message": f"Internal error: {str(e)}"}
            )
            return json.dumps(error_response.to_dict())
    
    def _handle_initialize(self, request: MCPRequest) -> MCPResponse:
        return MCPResponse(
            result={
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {},
                    "resources": {}
                },
                "serverInfo": {
                    "name": "edk2-rag-mcp",
                    "version": "0.1.0"
                }
            },
            id=request.id
        )
    
    def _handle_tools_list(self, request: MCPRequest) -> MCPResponse:
        tools = list(self._tools.values())
        return MCPResponse(
            result={"tools": tools},
            id=request.id
        )
    
    def _handle_tools_call(self, request: MCPRequest) -> MCPResponse:
        params = request.params or {}
        tool_name = params.get("name", "")
        arguments = params.get("arguments", {})
        
        if tool_name == "search_edk2_docs":
            return self._tool_search_docs(request, arguments)
        elif tool_name == "get_edk2_doc_by_id":
            return self._tool_get_doc_by_id(request, arguments)
        elif tool_name == "list_edk2_sources":
            return self._tool_list_sources(request, arguments)
        else:
            return MCPResponse(
                error={"code": -32602, "message": f"Unknown tool: {tool_name}"},
                id=request.id
            )
    
    def _tool_search_docs(self, request: MCPRequest, arguments: Dict) -> MCPResponse:
        query = arguments.get("query", "")
        top_k = arguments.get("top_k", self.config.top_k_results)
        
        if not query:
            return MCPResponse(
                error={"code": -32602, "message": "Missing required parameter: query"},
                id=request.id
            )
        
        try:
            results = self.vector_store.similarity_search(query, top_k)
            
            formatted_results = []
            for result in results:
                formatted_results.append({
                    "title": result.get("metadata", {}).get("title", "Unknown"),
                    "score": result.get("score", 0),
                    "content": result.get("content", ""),
                    "source": result.get("metadata", {}).get("source", ""),
                    "url": result.get("metadata", {}).get("url", "")
                })
            
            return MCPResponse(
                result={
                    "content": [{
                        "type": "text",
                        "text": json.dumps({
                            "query": query,
                            "total_results": len(formatted_results),
                            "results": formatted_results
                        }, indent=2)
                    }]
                },
                id=request.id
            )
        except Exception as e:
            logger.error(f"Search error: {e}")
            return MCPResponse(
                error={"code": -32603, "message": f"Search failed: {str(e)}"},
                id=request.id
            )
    
    def _tool_get_doc_by_id(self, request: MCPRequest, arguments: Dict) -> MCPResponse:
        doc_id = arguments.get("doc_id", "")
        
        if not doc_id:
            return MCPResponse(
                error={"code": -32602, "message": "Missing required parameter: doc_id"},
                id=request.id
            )
        
        return MCPResponse(
            result={
                "content": [{
                    "type": "text",
                    "text": json.dumps({
                        "doc_id": doc_id,
                        "message": "Document retrieval by ID is not yet implemented. Use search_edk2_docs instead."
                    })
                }]
            },
            id=request.id
        )
    
    def _tool_list_sources(self, request: MCPRequest, arguments: Dict) -> MCPResponse:
        sources = [
            {
                "name": "tianocore-wiki",
                "description": "TianoCore Wiki - EDK II development documentation",
                "url": self.config.tianocore_wiki_url
            },
            {
                "name": "tianocore-docs",
                "description": "TianoCore Documentation Repository",
                "url": self.config.tianocore_docs_repo
            }
        ]
        
        return MCPResponse(
            result={
                "content": [{
                    "type": "text",
                    "text": json.dumps({
                        "sources": sources,
                        "total_documents": self.vector_store.get_document_count()
                    }, indent=2)
                }]
            },
            id=request.id
        )
    
    def _handle_resources_list(self, request: MCPRequest) -> MCPResponse:
        resources = [
            {
                "uri": "edk2://documents",
                "name": "EDK2 Documents",
                "description": "All indexed EDK2 documentation",
                "mimeType": "application/json"
            }
        ]
        
        return MCPResponse(
            result={"resources": resources},
            id=request.id
        )
    
    def start_socket_server(self, host: str = None, port: int = None):
        host = host or self.config.mcp_server_host
        port = port or self.config.mcp_server_port
        
        self.server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server_socket.bind((host, port))
        self.server_socket.listen(5)
        
        self.running = True
        
        logger.info(f"MCP Server started on {host}:{port}")
        print(f"EDK2 RAG MCP Server running on {host}:{port}")
        print("Available tools:")
        for tool_name, tool_info in self._tools.items():
            print(f"  - {tool_name}: {tool_info['description']}")
        print("\nPress Ctrl+C to stop")
        
        while self.running:
            try:
                client_socket, address = self.server_socket.accept()
                logger.info(f"Connection from {address}")
                
                client_thread = threading.Thread(
                    target=self._handle_client,
                    args=(client_socket,)
                )
                client_thread.daemon = True
                client_thread.start()
                
            except Exception as e:
                if self.running:
                    logger.error(f"Server error: {e}")
    
    def _handle_client(self, client_socket):
        try:
            buffer = ""
            while True:
                data = client_socket.recv(4096)
                if not data:
                    break
                
                buffer += data.decode('utf-8')
                
                while '\n' in buffer:
                    line, buffer = buffer.split('\n', 1)
                    if line.strip():
                        response = self.handle_request(line)
                        client_socket.send((response + '\n').encode('utf-8'))
                        
        except Exception as e:
            logger.error(f"Client handling error: {e}")
        finally:
            client_socket.close()
    
    def stop(self):
        self.running = False
        if self.server_socket:
            self.server_socket.close()
        logger.info("MCP Server stopped")
    
    def get_tools_description(self) -> str:
        desc = "EDK2 RAG MCP Server Tools:\n\n"
        for tool_name, tool_info in self._tools.items():
            desc += f"**{tool_name}**\n"
            desc += f"  {tool_info['description']}\n"
            desc += f"  Parameters: {json.dumps(tool_info['inputSchema'], indent=4)}\n\n"
        return desc