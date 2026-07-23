#!/usr/bin/env python3
"""
TianoCore Wiki MCP Service Test Suite

Tests for dual-source documentation retrieval (tianocore-wiki + tianocore-docs).
"""

import json
import os
import sys
import tempfile
import shutil
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from fetch_wiki import (
    fetch_url,
    html_to_text,
    extract_content,
    get_page_path,
    parse_markdown_file,
    process_docs_repository,
    clone_docs_repo,
)
from mcp_server import (
    load_knowledge_base,
    search_wiki,
    get_wiki_page,
    list_categories,
    handle_request,
)


class TestKnowledgeBaseInit(unittest.TestCase):
    """Test knowledge base initialization"""
    
    def test_knowledge_base_exists(self):
        """Test that knowledge base file exists"""
        kb = load_knowledge_base()
        self.assertIsInstance(kb, dict)
        self.assertIn("pages", kb)
    
    def test_knowledge_base_has_pages(self):
        """Test that knowledge base has indexed pages"""
        kb = load_knowledge_base()
        pages = kb.get("pages", {})
        self.assertGreater(len(pages), 0, "Knowledge base should have at least one page")
    
    def test_knowledge_base_has_dual_sources(self):
        """Test that knowledge base contains both wiki and docs sources"""
        kb = load_knowledge_base()
        pages = kb.get("pages", {})
        
        sources = set()
        for page_data in pages.values():
            source = page_data.get("source", "tianocore-wiki")
            sources.add(source)
        
        self.assertIn("tianocore-wiki", sources, "Should contain tianocore-wiki pages")
    
    def test_page_structure(self):
        """Test that indexed pages have required fields"""
        kb = load_knowledge_base()
        pages = kb.get("pages", {})
        
        for path, content in list(pages.items())[:5]:
            self.assertIn("title", content, f"Page {path} should have title")
            self.assertIn("content", content, f"Page {path} should have content")
            self.assertIn("source", content, f"Page {path} should have source")
            self.assertTrue(len(content["content"]) > 0, f"Page {path} should have non-empty content")


class TestSearchFunctionality(unittest.TestCase):
    """Test search functionality with dual sources"""
    
    def test_search_returns_results(self):
        """Test that search returns results"""
        results = search_wiki("UEFI", limit=5)
        self.assertIsInstance(results, list)
        self.assertGreater(len(results), 0, "Should return results for 'UEFI'")
    
    def test_search_results_have_source_field(self):
        """Test that search results include source field"""
        results = search_wiki("EDK", limit=5)
        for result in results:
            self.assertIn("source", result, "Result should have source field")
    
    def test_search_filter_by_wiki_source(self):
        """Test filtering search by tianocore-wiki source"""
        results = search_wiki("EDK", limit=10, source="tianocore-wiki")
        for result in results:
            self.assertEqual(result["source"], "tianocore-wiki")
    
    def test_search_filter_by_docs_source(self):
        """Test filtering search by tianocore-docs source"""
        results = search_wiki("specification", limit=10, source="tianocore-docs")
        for result in results:
            self.assertEqual(result["source"], "tianocore-docs")
    
    def test_search_results_structure(self):
        """Test that search results have required fields"""
        results = search_wiki("OVMF", limit=3)
        for result in results:
            self.assertIn("path", result)
            self.assertIn("title", result)
            self.assertIn("snippet", result)
            self.assertIn("source", result)
    
    def test_search_limit_parameter(self):
        """Test that limit parameter works"""
        results = search_wiki("UEFI", limit=3)
        self.assertLessEqual(len(results), 3)


class TestPageRetrieval(unittest.TestCase):
    """Test page retrieval functionality"""
    
    def test_get_existing_page(self):
        """Test getting an existing page"""
        kb = load_knowledge_base()
        pages = kb.get("pages", {})
        
        if pages:
            first_path = list(pages.keys())[0]
            page = get_wiki_page(first_path)
            self.assertIsNotNone(page)
            self.assertIn("content", page)
    
    def test_get_nonexistent_page(self):
        """Test getting a non-existent page returns None"""
        page = get_wiki_page("nonexistent/path/that/does/not/exist")
        self.assertIsNone(page)
    
    def test_page_content_not_empty(self):
        """Test that retrieved page content is not empty"""
        kb = load_knowledge_base()
        pages = kb.get("pages", {})
        
        for path in list(pages.keys())[:3]:
            page = get_wiki_page(path)
            if page:
                self.assertTrue(len(page.get("content", "")) > 0)


class TestCategoryBrowse(unittest.TestCase):
    """Test category browsing functionality"""
    
    def test_list_categories_returns_dict(self):
        """Test that list_categories returns a dictionary"""
        categories = list_categories()
        self.assertIsInstance(categories, dict)
    
    def test_categories_not_empty(self):
        """Test that categories are not empty"""
        categories = list_categories()
        self.assertGreater(len(categories), 0)
    
    def test_categories_have_expected_keys(self):
        """Test that categories have expected keys"""
        categories = list_categories()
        expected_keys = ["Getting Started", "Development", "Platforms", "Specifications"]
        for key in expected_keys:
            self.assertIn(key, categories)


class TestBoundaryConditions(unittest.TestCase):
    """Test boundary conditions and edge cases"""
    
    def test_search_empty_query(self):
        """Test search with empty query"""
        results = search_wiki("", limit=5)
        self.assertIsInstance(results, list)
    
    def test_search_no_results(self):
        """Test search with query that has no matches"""
        results = search_wiki("xyzzynonexistentterm12345", limit=5)
        self.assertEqual(len(results), 0)
    
    def test_search_long_query(self):
        """Test search with very long query"""
        long_query = "UEFI " * 100
        results = search_wiki(long_query, limit=5)
        self.assertIsInstance(results, list)
    
    def test_search_special_characters(self):
        """Test search with special characters"""
        results = search_wiki("!@#$%^&*()", limit=5)
        self.assertIsInstance(results, list)
    
    def test_search_case_insensitive(self):
        """Test that search is case insensitive"""
        results_lower = search_wiki("uefi", limit=3)
        results_upper = search_wiki("UEFI", limit=3)
        self.assertGreater(len(results_lower), 0)
        self.assertGreater(len(results_upper), 0)
    
    def test_search_multi_keyword(self):
        """Test search with multiple keywords"""
        results = search_wiki("UEFI PI specification", limit=5)
        self.assertIsInstance(results, list)
    
    def test_search_invalid_source(self):
        """Test search with invalid source filter"""
        results = search_wiki("UEFI", limit=5, source="invalid-source")
        self.assertEqual(len(results), 0)


class TestMCPProtocol(unittest.TestCase):
    """Test MCP protocol handling"""
    
    def test_tools_list_request(self):
        """Test tools/list request"""
        import asyncio
        request = {"method": "tools/list", "params": {}}
        response = asyncio.run(handle_request(request))
        
        self.assertIn("tools", response)
        tool_names = [t["name"] for t in response["tools"]]
        self.assertIn("search_wiki", tool_names)
        self.assertIn("get_wiki_page", tool_names)
        self.assertIn("list_categories", tool_names)
        self.assertIn("list_sources", tool_names)
    
    def test_search_wiki_tool_call(self):
        """Test tools/call for search_wiki"""
        import asyncio
        request = {
            "method": "tools/call",
            "params": {
                "name": "search_wiki",
                "arguments": {"query": "UEFI", "limit": 3}
            }
        }
        response = asyncio.run(handle_request(request))
        
        self.assertIn("content", response)
        self.assertIsInstance(response["content"], list)
    
    def test_list_sources_tool_call(self):
        """Test tools/call for list_sources"""
        import asyncio
        request = {
            "method": "tools/call",
            "params": {
                "name": "list_sources",
                "arguments": {}
            }
        }
        response = asyncio.run(handle_request(request))
        
        self.assertIn("content", response)
        content = json.loads(response["content"][0]["text"])
        self.assertIn("tianocore-wiki", content)
        self.assertIn("tianocore-docs", content)
    
    def test_unknown_method(self):
        """Test handling of unknown method"""
        import asyncio
        request = {"method": "unknown/method", "params": {}}
        response = asyncio.run(handle_request(request))
        
        self.assertIn("error", response)


class TestHTMLParsing(unittest.TestCase):
    """Test HTML parsing functions"""
    
    def test_html_to_text_removes_tags(self):
        """Test that html_to_text removes HTML tags"""
        html = "<html><body><p>Hello World</p></body></html>"
        text = html_to_text(html)
        self.assertNotIn("<", text)
        self.assertNotIn(">", text)
    
    def test_html_to_text_removes_scripts(self):
        """Test that html_to_text removes script tags"""
        html = "<html><script>alert('test')</script><body>Content</body></html>"
        text = html_to_text(html)
        self.assertNotIn("script", text.lower())
        self.assertNotIn("alert", text)
    
    def test_extract_content_returns_dict(self):
        """Test that extract_content returns a dictionary"""
        html = "<html><head><title>Test</title></head><body>Content</body></html>"
        content = extract_content(html)
        self.assertIsInstance(content, dict)
        self.assertIn("title", content)
        self.assertIn("content", content)
    
    def test_get_page_path_extracts_path(self):
        """Test that get_page_path extracts path from URL"""
        url = "https://www.tianocore.org/tianocore-wiki.github.io/test/page.html"
        path = get_page_path(url)
        self.assertEqual(path, "test/page")


class TestMarkdownParsing(unittest.TestCase):
    """Test Markdown parsing functions"""
    
    def test_parse_markdown_extracts_title(self):
        """Test that parse_markdown_file extracts title"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False, encoding='utf-8') as f:
            f.write("# Test Title\n\nSome content here.")
            temp_path = f.name
        
        try:
            result = parse_markdown_file(Path(temp_path))
            self.assertIsNotNone(result)
            self.assertEqual(result["title"], "Test Title")
        finally:
            os.unlink(temp_path)
    
    def test_parse_markdown_handles_missing_file(self):
        """Test that parse_markdown_file handles missing file"""
        result = parse_markdown_file(Path("/nonexistent/path/file.md"))
        self.assertIsNone(result)
    
    def test_parse_markdown_removes_code_blocks(self):
        """Test that parse_markdown_file removes code blocks"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False, encoding='utf-8') as f:
            f.write("# Title\n\n```\ncode block\n```\n\nRegular text.")
            temp_path = f.name
        
        try:
            result = parse_markdown_file(Path(temp_path))
            self.assertIsNotNone(result)
            self.assertNotIn("```", result["content"])
        finally:
            os.unlink(temp_path)


def run_tests():
    """Run all tests"""
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    
    suite.addTests(loader.loadTestsFromTestCase(TestKnowledgeBaseInit))
    suite.addTests(loader.loadTestsFromTestCase(TestSearchFunctionality))
    suite.addTests(loader.loadTestsFromTestCase(TestPageRetrieval))
    suite.addTests(loader.loadTestsFromTestCase(TestCategoryBrowse))
    suite.addTests(loader.loadTestsFromTestCase(TestBoundaryConditions))
    suite.addTests(loader.loadTestsFromTestCase(TestMCPProtocol))
    suite.addTests(loader.loadTestsFromTestCase(TestHTMLParsing))
    suite.addTests(loader.loadTestsFromTestCase(TestMarkdownParsing))
    
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(run_tests())