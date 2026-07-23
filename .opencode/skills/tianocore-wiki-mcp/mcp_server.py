#!/usr/bin/env python3
"""
TianoCore Wiki MCP Server

MCP server providing access to EDK II documentation knowledge base.
"""

import json
import os
import sys
import asyncio
from pathlib import Path
from typing import Optional
import argparse


KNOWLEDGE_DIR = Path(__file__).parent / "knowledge"


def load_knowledge_base() -> dict:
    """Load the knowledge base from JSON file"""
    kb_file = KNOWLEDGE_DIR / "wiki_index.json"
    if kb_file.exists():
        with open(kb_file, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"pages": {}, "index": {}}


def search_wiki(query: str, limit: int = 10) -> list:
    """Search wiki pages for query"""
    kb = load_knowledge_base()
    results = []
    query_lower = query.lower()
    
    for path, content in kb.get("pages", {}).items():
        title = content.get("title", "")
        body = content.get("content", "")
        
        if query_lower in title.lower() or query_lower in body.lower():
            snippet = body[:500] + "..." if len(body) > 500 else body
            results.append({
                "path": path,
                "title": title,
                "snippet": snippet
            })
            
            if len(results) >= limit:
                break
    
    return results


def get_wiki_page(path: str) -> Optional[dict]:
    """Get full content of a wiki page"""
    kb = load_knowledge_base()
    return kb.get("pages", {}).get(path)


def list_categories() -> dict:
    """List available documentation categories"""
    return {
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


async def handle_request(request: dict) -> dict:
    """Handle MCP request"""
    method = request.get("method")
    params = request.get("params", {})
    
    if method == "tools/list":
        return {
            "tools": [
                {
                    "name": "search_wiki",
                    "description": "Search EDK II documentation",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "query": {"type": "string", "description": "Search query"},
                            "limit": {"type": "integer", "description": "Max results", "default": 10}
                        },
                        "required": ["query"]
                    }
                },
                {
                    "name": "get_wiki_page",
                    "description": "Get full content of a wiki page",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string", "description": "Page path"}
                        },
                        "required": ["path"]
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
        }
    
    elif method == "tools/call":
        tool_name = params.get("name")
        arguments = params.get("arguments", {})
        
        if tool_name == "search_wiki":
            query = arguments.get("query", "")
            limit = arguments.get("limit", 10)
            results = search_wiki(query, limit)
            return {"content": [{"type": "text", "text": json.dumps(results, indent=2)}]}
        
        elif tool_name == "get_wiki_page":
            path = arguments.get("path", "")
            page = get_wiki_page(path)
            if page:
                return {"content": [{"type": "text", "text": page.get("content", "")}]}
            return {"content": [{"type": "text", "text": f"Page not found: {path}"}]}
        
        elif tool_name == "list_categories":
            categories = list_categories()
            return {"content": [{"type": "text", "text": json.dumps(categories, indent=2)}]}
        
        return {"error": f"Unknown tool: {tool_name}"}
    
    return {"error": f"Unknown method: {method}"}


async def run_server():
    """Run the MCP server"""
    sys.stderr.write("TianoCore Wiki MCP Server starting...\n")
    sys.stderr.write(f"Knowledge base: {KNOWLEDGE_DIR}\n")
    
    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break
            
            request = json.loads(line.strip())
            response = await handle_request(request)
            
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()
        except json.JSONDecodeError as e:
            sys.stderr.write(f"JSON error: {e}\n")
        except Exception as e:
            sys.stderr.write(f"Error: {e}\n")


def main():
    parser = argparse.ArgumentParser(description="TianoCore Wiki MCP Server")
    parser.add_argument("--fetch", action="store_true", help="Fetch wiki content first")
    args = parser.parse_args()
    
    if args.fetch:
        from fetch_wiki import fetch_all_pages
        fetch_all_pages()
    else:
        asyncio.run(run_server())


if __name__ == "__main__":
    main()