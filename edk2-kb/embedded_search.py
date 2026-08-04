#!/usr/bin/env python3
"""
EDK2 Embedded Search Engine - CLI interface

Direct-call CLI wrapper around SearchEngine (see search_engine.py).
Kept for compatibility; the MCP daemon (mcp_server.py) is the primary
interface and shares the same engine implementation.
"""

import json
import sys
from pathlib import Path
from typing import Optional

from search_engine import SearchEngine


def main() -> None:
    """CLI interface for embedded search"""
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'No command provided'}))
        sys.exit(1)

    command = sys.argv[1]
    searcher = SearchEngine(preload=False)

    if command == 'search':
        if len(sys.argv) < 3:
            print(json.dumps({'error': 'Missing query'}))
            sys.exit(1)

        query = sys.argv[2]
        top_k = int(sys.argv[3]) if len(sys.argv) > 3 else 5
        source_filter = sys.argv[4] if len(sys.argv) > 4 else None

        results = searcher.search(query, top_k, source_filter)
        print(json.dumps({'results': results}, ensure_ascii=False))

    elif command == 'status':
        status = searcher.status()
        print(json.dumps(status, ensure_ascii=False))

    else:
        print(json.dumps({'error': f'Unknown command: {command}'}))
        sys.exit(1)


if __name__ == "__main__":
    main()
