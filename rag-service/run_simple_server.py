#!/usr/bin/env python3
"""
Simple HTTP RAG Server for EDK2 documentation
Provides basic search functionality without heavy dependencies
"""

import json
import logging
import os
from http.server import HTTPServer, BaseHTTPRequestHandler
import sys

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Pre-built EDK2 documentation data
EDK2_DOCS = [
    {
        "title": "Building OVMF",
        "content": "To build OVMF, you need to: 1. Install build tools (Visual Studio on Windows, GCC on Linux). 2. Clone EDK2 repository. 3. Run edksetup.bat/sh. 4. Build with: build -p OvmfPkg/OvmfPkgX64.dsc -t VS2022 -a X64",
        "source": "tianocore-wiki",
        "url": "https://github.com/tianocore/tianocore.github.io/wiki/Building-OVMF"
    },
    {
        "title": "UEFI Driver Development",
        "content": "UEFI drivers follow the EFI Driver Model. Key concepts: Driver Binding Protocol, Component Name Protocol, Supported EFI version. Drivers are built as PE32+ binaries.",
        "source": "tianocore-docs",
        "url": "https://github.com/tianocore/docs/blob/master/driver_development.md"
    },
    {
        "title": "EmulatorPkg Build",
        "content": "EmulatorPkg provides a Windows UEFI emulator (WinHost.exe). Build command: build -p EmulatorPkg/EmulatorPkg.dsc -t VS2022 -a X64. Output: Build/EmulatorX64/DEBUG_VS2022/X64/WinHost.exe",
        "source": "tianocore-wiki",
        "url": "https://github.com/tianocore/tianocore.github.io/wiki/EmulatorPkg"
    },
    {
        "title": "EDK2 Build System",
        "content": "EDK2 uses a custom build system. Key files: DSC (Platform Description), INF (Module Definition), DEC (Package Declaration). Build command: build -p <DSC file> -t <ToolChain> -a <Arch>",
        "source": "tianocore-docs",
        "url": "https://github.com/tianocore/docs/blob/master/build_system.md"
    },
    {
        "title": "PCD Configuration",
        "content": "Platform Configuration Database (PCD) allows dynamic configuration. Types: PcdsFixedAtBuild, PcdsPatchableInModule, PcdsDynamic, PcdsDynamicEx. Use PcdGet32/PcdSet32 to access values.",
        "source": "tianocore-docs",
        "url": "https://github.com/tianocore/docs/blob/master/pcd.md"
    }
]


class SimpleRAGHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        logger.info(f"[HTTP] {format % args}")
    
    def _send_json(self, data, status=200):
        response = json.dumps(data, ensure_ascii=False, indent=2)
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(response.encode('utf-8'))
    
    def do_OPTIONS(self):
        self._send_json({})
    
    def do_GET(self):
        if self.path == '/health':
            self._send_json({'status': 'ok', 'service': 'edk2-rag'})
        elif self.path == '/tools':
            self._send_json({'tools': [
                {'name': 'search_edk2_docs', 'description': 'Search EDK2 documentation', 'inputSchema': {'type': 'object', 'properties': {'query': {'type': 'string'}}}}]})
        elif self.path == '/sources':
            self._send_json({'sources': [{'name': 'tianocore-wiki', 'url': 'https://github.com/tianocore/tianocore.github.io/wiki'}]})
        elif self.path == '/stats':
            self._send_json({'documents': len(EDK2_DOCS), 'status': 'running'})
        else:
            self._send_json({'error': 'Not found'}, 404)
    
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode('utf-8') if length > 0 else '{}'
        
        try:
            data = json.loads(body)
        except:
            self._send_json({'error': 'Invalid JSON'}, 400)
            return
        
        if self.path == '/search':
            self._handle_search(data)
        elif self.path == '/mcp':
            self._handle_mcp(data)
        else:
            self._send_json({'error': 'Not found'}, 404)
    
    def _handle_search(self, data):
        query = data.get('query', '').lower()
        top_k = data.get('top_k', 5)
        
        if not query:
            self._send_json({'error': 'Missing query'}, 400)
            return
        
        results = []
        for doc in EDK2_DOCS:
            score = 0
            query_words = query.split()
            for word in query_words:
                if word in doc['title'].lower() or word in doc['content'].lower():
                    score += 1
            if score > 0:
                results.append({**doc, 'score': score / len(query_words)})
        
        results.sort(key=lambda x: x['score'], reverse=True)
        self._send_json({'query': query, 'total_results': len(results[:top_k]), 'results': results[:top_k]})
    
    def _handle_mcp(self, data):
        method = data.get('method', '')
        params = data.get('params', {})
        req_id = data.get('id')
        
        if method == 'initialize':
            result = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'edk2-rag', 'version': '1.0.0'}}
        elif method == 'tools/list':
            result = {'tools': [{'name': 'search_edk2_docs', 'description': 'Search EDK2 docs', 'inputSchema': {'type': 'object', 'properties': {'query': {'type': 'string'}}}}]}
        elif method == 'tools/call':
            args = params.get('arguments', {})
            query = args.get('query', '')
            results = []
            for doc in EDK2_DOCS:
                if query.lower() in doc['title'].lower() or query.lower() in doc['content'].lower():
                    results.append(doc)
            result = {'content': [{'type': 'text', 'text': json.dumps(results[:5])}]}
        else:
            self._send_json({'jsonrpc': '2.0', 'error': {'code': -32601, 'message': 'Method not found'}, 'id': req_id}, 400)
            return
        
        self._send_json({'jsonrpc': '2.0', 'result': result, 'id': req_id})


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--port', type=int, default=8080)
    args = parser.parse_args()
    
    server = HTTPServer((args.host, args.port), SimpleRAGHandler)
    logger.info(f"EDK2 RAG HTTP Server started on {args.host}:{args.port}")
    logger.info("Endpoints: /health, /tools, /sources, /search, /mcp")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down...")
        server.shutdown()


if __name__ == '__main__':
    main()