---
name: tianocore-wiki-mcp
description: MCP service for TianoCore EDK II documentation. Fetches EDK II development knowledge from local wiki cache and tianocore-docs repository. Use when user asks about EDK II development, UEFI/PI specifications, or TianoCore documentation.
---

# TianoCore Wiki MCP Service

Provides EDK II development documentation through MCP (Model Context Protocol) for AI assistants.

## Data Sources

This MCP service integrates documentation from two sources:

1. **TianoCore Wiki** (`tianocore-wiki`)
   - URL: https://www.tianocore.org/tianocore-wiki.github.io/
   - Content: Development guides, tutorials, platform documentation, contribution guides

2. **TianoCore Docs Repository** (`tianocore-docs`)
   - URL: https://github.com/tianocore-docs
   - Content: UEFI/PI specifications, DEC file specs, UEFI Shell specs
   - Repositories: edk2-DecSpecification, edk2-UefiSpecification, edk2-PISpecification, edk2-UEFI-Shell-Specification

## Overview

This MCP service provides access to TianoCore EDK II documentation, allowing OpenCode to:
- Search EDK II documentation from multiple sources
- Retrieve specific documentation pages
- Get development guides, tutorials, and specifications
- Filter results by source (wiki or docs)

## Features

- **Local Knowledge Base**: Pre-fetched wiki and docs content for fast access
- **Search Functionality**: Full-text search across all documentation with source filtering
- **Page Retrieval**: Get specific pages by path
- **Category Browsing**: Browse by topic (Getting Started, Development, Platforms, etc.)
- **Source Identification**: Results include source tag (`tianocore-wiki` or `tianocore-docs`)

## Usage

### Start MCP Server

```bash
python mcp_server.py
```

### Available Tools

1. **search_wiki**: Search EDK II documentation from all sources
   - Query: Search term
   - Limit: Max results (default: 10)
   - Source: Filter by source (optional: `tianocore-wiki` or `tianocore-docs`)
   - Returns: Matching pages with snippets and source tag

2. **get_wiki_page**: Get full content of a documentation page
   - Path: Page path (e.g., "development/tutorials-howto/getting_started_with_edk_ii" or "docs/edk2-UefiSpecification/README")
   - Returns: Full page content

3. **list_categories**: List available documentation categories
   - Returns: List of categories and subcategories

4. **list_sources**: List available documentation sources
   - Returns: Available sources with descriptions and URLs

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

### TianoCore Wiki Content
- Getting Started guides
- Development tutorials
- Platform documentation (OVMF, EmulatorPkg, etc.)
- API references
- Contribution guides

### TianoCore Docs Content
- UEFI Specification documents
- PI Specification documents
- DEC file format specification
- UEFI Shell specification

## Updating Knowledge Base

To update the documentation content:

```bash
# Fetch both wiki and docs (default)
python fetch_wiki.py --output knowledge/

# Fetch only wiki (skip docs)
python fetch_wiki.py --output knowledge/ --no-docs

# Fetch sample pages for testing
python fetch_wiki.py --sample --output knowledge/
```

## Testing

The MCP service includes a comprehensive test suite to verify dual-source functionality.

### Run Tests

```bash
# Run all tests
python tests/test_mcp_service.py

# Run specific test class
python -m unittest tests.test_mcp_service.TestSearchFunctionality

# Run with verbosity
python tests/test_mcp_service.py -v
```

### Test Categories

| Category | Description |
|----------|-------------|
| Knowledge Base Init | Verify knowledge base loading and structure |
| Search Functionality | Test search with dual-source support |
| Page Retrieval | Test individual page retrieval |
| Category Browse | Test category listing |
| Boundary Conditions | Test edge cases and error handling |
| MCP Protocol | Test MCP protocol compliance |
| HTML Parsing | Test HTML parsing utilities |
| Markdown Parsing | Test Markdown parsing utilities |

### Test Prerequisites

Initialize knowledge base before testing:

```bash
python fetch_wiki.py --sample
```

For detailed test documentation, see [tests/TEST_CASES.md](tests/TEST_CASES.md).

## References

- [TianoCore Wiki](https://www.tianocore.org/tianocore-wiki.github.io/)
- [TianoCore Docs Repository](https://github.com/tianocore-docs)
- [EDK II Repository](https://github.com/tianocore/edk2)
- [MCP Protocol](https://modelcontextprotocol.io/)