---
name: tianocore-wiki-mcp
description: MCP service for TianoCore EDK II documentation. Fetches EDK II development knowledge from local wiki cache. Use when user asks about EDK II development, UEFI specifications, or TianoCore documentation.
---

# TianoCore Wiki MCP Service

Provides EDK II development documentation through MCP (Model Context Protocol) for AI assistants.

## Overview

This MCP service provides access to TianoCore EDK II documentation, allowing OpenCode to:
- Search EDK II documentation
- Retrieve specific wiki pages
- Get development guides and tutorials

## Features

- **Local Knowledge Base**: Pre-fetched wiki content for fast access
- **Search Functionality**: Full-text search across all documentation
- **Page Retrieval**: Get specific pages by path
- **Category Browsing**: Browse by topic (Getting Started, Development, Platforms, etc.)

## Usage

### Start MCP Server

```bash
python mcp_server.py
```

### Available Tools

1. **search_wiki**: Search EDK II documentation
   - Query: Search term
   - Returns: Matching pages with snippets

2. **get_wiki_page**: Get full content of a wiki page
   - Path: Page path (e.g., "development/tutorials-howto/getting_started_with_edk_ii")
   - Returns: Full page content

3. **list_categories**: List available documentation categories
   - Returns: List of categories and subcategories

## Configuration

### OpenCode MCP Configuration

Add to your OpenCode MCP configuration:

```json
{
  "mcpServers": {
    "tianocore-wiki": {
      "command": "python",
      "args": [".opencode/skills/tianocore-wiki-mcp/mcp_server.py"]
    }
  }
}
```

## Knowledge Base

The knowledge base is stored in `knowledge/` directory and includes:
- Getting Started guides
- Development tutorials
- Platform documentation
- API references
- Contribution guides

## Updating Knowledge Base

To update the wiki content:

```bash
python fetch_wiki.py --output knowledge/
```

## References

- [TianoCore Wiki](https://www.tianocore.org/tianocore-wiki.github.io/)
- [EDK II Repository](https://github.com/tianocore/edk2)
- [MCP Protocol](https://modelcontextprotocol.io/)