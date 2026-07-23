# TianoCore Wiki MCP Service Test Documentation

## Overview

This document describes the test suite for the TianoCore Wiki MCP service, which supports dual-source documentation retrieval from TianoCore Wiki and tianocore-docs repository.

## Test Categories

### 1. Knowledge Base Initialization Tests

Test knowledge base loading and structure.

| Test Case | Description | Expected Result |
|-----------|-------------|-----------------|
| `test_knowledge_base_exists` | Verify knowledge base file exists | Returns valid dict with "pages" key |
| `test_knowledge_base_has_pages` | Verify knowledge base has indexed pages | Pages count > 0 |
| `test_knowledge_base_has_dual_sources` | Verify dual sources are indexed | Contains tianocore-wiki pages |
| `test_page_structure` | Verify page fields | Each page has title, content, source |

### 2. Search Functionality Tests

Test search with dual-source support.

| Test Case | Description | Expected Result |
|-----------|-------------|-----------------|
| `test_search_returns_results` | Basic search returns results | Results list not empty |
| `test_search_results_have_source_field` | Results include source field | All results have "source" |
| `test_search_filter_by_wiki_source` | Filter by tianocore-wiki | Only wiki results returned |
| `test_search_filter_by_docs_source` | Filter by tianocore-docs | Only docs results returned |
| `test_search_results_structure` | Verify result fields | Has path, title, snippet, source |
| `test_search_limit_parameter` | Verify limit works | Results <= limit |

### 3. Page Retrieval Tests

Test individual page retrieval.

| Test Case | Description | Expected Result |
|-----------|-------------|-----------------|
| `test_get_existing_page` | Get existing page | Returns page dict with content |
| `test_get_nonexistent_page` | Get non-existent page | Returns None |
| `test_page_content_not_empty` | Page content not empty | Content length > 0 |

### 4. Category Browse Tests

Test category listing functionality.

| Test Case | Description | Expected Result |
|-----------|-------------|-----------------|
| `test_list_categories_returns_dict` | Returns dictionary | Result is dict |
| `test_categories_not_empty` | Categories exist | Category count > 0 |
| `test_categories_have_expected_keys` | Has expected categories | Contains Getting Started, Development, etc. |

### 5. Boundary Condition Tests

Test edge cases and error handling.

| Test Case | Description | Expected Result |
|-----------|-------------|-----------------|
| `test_search_empty_query` | Search with empty string | Returns list (may be empty) |
| `test_search_no_results` | Search non-matching term | Returns empty list |
| `test_search_long_query` | Search very long query | Returns list (no crash) |
| `test_search_special_characters` | Search special chars | Returns list (no crash) |
| `test_search_case_insensitive` | Case insensitive search | Same results for upper/lower |
| `test_search_multi_keyword` | Multiple keywords | Returns list |
| `test_search_invalid_source` | Invalid source filter | Returns empty list |

### 6. MCP Protocol Tests

Test MCP protocol compliance.

| Test Case | Description | Expected Result |
|-----------|-------------|-----------------|
| `test_tools_list_request` | List available tools | Returns 4 tools |
| `test_search_wiki_tool_call` | Call search_wiki tool | Returns content array |
| `test_list_sources_tool_call` | Call list_sources tool | Returns source info |
| `test_unknown_method` | Handle unknown method | Returns error dict |

### 7. HTML Parsing Tests

Test HTML parsing utilities.

| Test Case | Description | Expected Result |
|-----------|-------------|-----------------|
| `test_html_to_text_removes_tags` | Remove HTML tags | No < or > in output |
| `test_html_to_text_removes_scripts` | Remove script tags | No script content |
| `test_extract_content_returns_dict` | Extract content | Returns title and content |
| `test_get_page_path_extracts_path` | Extract URL path | Returns clean path |

### 8. Markdown Parsing Tests

Test Markdown parsing utilities.

| Test Case | Description | Expected Result |
|-----------|-------------|-----------------|
| `test_parse_markdown_extracts_title` | Extract title from # heading | Returns correct title |
| `test_parse_markdown_handles_missing_file` | Handle missing file | Returns None |
| `test_parse_markdown_removes_code_blocks` | Remove code blocks | No ``` in output |

## Running Tests

### Run All Tests

```bash
cd .opencode/skills/tianocore-wiki-mcp
python tests/test_mcp_service.py
```

### Run Specific Test Class

```bash
python -m unittest tests.test_mcp_service.TestSearchFunctionality
```

### Run Single Test

```bash
python -m unittest tests.test_mcp_service.TestSearchFunctionality.test_search_returns_results
```

### Run with Verbosity

```bash
python tests/test_mcp_service.py -v
```

## Test Prerequisites

Before running tests:

1. Initialize knowledge base:
   ```bash
   python fetch_wiki.py --sample
   ```

2. Ensure dependencies available:
   - Python 3.7+
   - No external packages required (uses stdlib)

## Test Output Format

```
test_knowledge_base_exists ... ok
test_knowledge_base_has_pages ... ok
test_knowledge_base_has_dual_sources ... ok
...
----------------------------------------------------------------------
Ran X tests in Y.YYYs

OK
```

## Verification Checklist

- [ ] All tests pass (OK status)
- [ ] Knowledge base contains both sources
- [ ] Search returns results with source field
- [ ] Source filtering works correctly
- [ ] Boundary tests handle edge cases
- [ ] MCP protocol tests pass