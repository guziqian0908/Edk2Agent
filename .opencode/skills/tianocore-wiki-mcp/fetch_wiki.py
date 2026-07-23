#!/usr/bin/env python3
"""
Fetch TianoCore Wiki and Docs Content

Downloads and indexes EDK II documentation from:
1. TianoCore wiki (https://www.tianocore.org/tianocore-wiki.github.io/)
2. TianoCore docs repository (https://github.com/tianocore-docs)
"""

import json
import os
import re
import time
import argparse
import subprocess
import shutil
from pathlib import Path
from urllib.parse import urljoin, urlparse
import urllib.request
import urllib.error


BASE_URL = "https://www.tianocore.org/tianocore-wiki.github.io/"
DOCS_REPO_URL = "https://github.com/tianocore-docs"
DOCS_REPO_DIR = "tianocore-docs"


def fetch_url(url: str) -> str:
    """Fetch content from URL"""
    try:
        req = urllib.request.Request(
            url,
            headers={'User-Agent': 'Mozilla/5.0 (compatible; Edk2Agent/1.0)'}
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.read().decode('utf-8')
    except urllib.error.URLError as e:
        print(f"Error fetching {url}: {e}")
        return ""


def parse_html_links(html: str, base_url: str) -> list:
    """Extract links from HTML"""
    links = []
    pattern = r'href=["\']([^"\']+)["\']'
    for match in re.finditer(pattern, html):
        href = match.group(1)
        if href.endswith('.html') and not href.startswith('http'):
            full_url = urljoin(base_url, href)
            links.append(full_url)
    return links


def html_to_text(html: str) -> str:
    """Convert HTML to plain text"""
    # Remove script and style
    html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<style[^>]*>.*?</style>', '', html, flags=re.DOTALL | re.IGNORECASE)
    # Remove HTML tags
    text = re.sub(r'<[^>]+>', ' ', html)
    # Clean up whitespace
    text = re.sub(r'\s+', ' ', text)
    text = text.strip()
    return text


def extract_content(html: str) -> dict:
    """Extract title and content from HTML"""
    # Extract title
    title_match = re.search(r'<title[^>]*>([^<]+)</title>', html, re.IGNORECASE)
    title = title_match.group(1).strip() if title_match else ""
    
    # Remove title from title tag
    if " - " in title:
        title = title.split(" - ")[0]
    
    # Try to extract main content
    content_match = re.search(r'<main[^>]*>(.*?)</main>', html, re.DOTALL | re.IGNORECASE)
    if content_match:
        content = html_to_text(content_match.group(1))
    else:
        # Fallback: extract body
        body_match = re.search(r'<body[^>]*>(.*?)</body>', html, re.DOTALL | re.IGNORECASE)
        content = html_to_text(body_match.group(1)) if body_match else ""
    
    return {"title": title, "content": content}


def get_page_path(url: str) -> str:
    """Extract path from URL"""
    parsed = urlparse(url)
    path = parsed.path
    if path.endswith('.html'):
        path = path[:-5]
    if path.startswith('/'):
        path = path[1:]
    return path


def clone_docs_repo(output_dir: Path) -> Path:
    """Clone or update tianocore-docs repositories"""
    docs_dir = output_dir / DOCS_REPO_DIR
    
    if docs_dir.exists():
        print(f"Updating existing docs directory: {docs_dir}")
    else:
        print(f"Cloning tianocore-docs repositories to: {docs_dir}")
        docs_dir.mkdir(parents=True, exist_ok=True)
    
    repos = [
        "edk2-DecSpecification",
        "edk2-UefiSpecification",
        "edk2-PISpecification",
        "edk2-UEFI-Shell-Specification",
    ]
    
    for repo in repos:
        repo_url = f"{DOCS_REPO_URL}/{repo}"
        repo_path = docs_dir / repo
        
        if repo_path.exists():
            print(f"  Updating {repo}...")
            try:
                subprocess.run(
                    ["git", "pull"],
                    cwd=repo_path,
                    capture_output=True,
                    check=True
                )
            except subprocess.CalledProcessError as e:
                print(f"    Warning: Failed to update {repo}: {e}")
        else:
            print(f"  Cloning {repo}...")
            try:
                subprocess.run(
                    ["git", "clone", "--depth", "1", repo_url, str(repo_path)],
                    capture_output=True,
                    check=True
                )
            except subprocess.CalledProcessError as e:
                print(f"    Warning: Failed to clone {repo}: {e}")
    
    return docs_dir


def parse_markdown_file(file_path: Path) -> dict:
    """Parse a Markdown file and extract title and content"""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except (IOError, UnicodeDecodeError) as e:
        return None
    
    lines = content.split('\n')
    title = ""
    
    for line in lines[:20]:
        if line.startswith('# '):
            title = line[2:].strip()
            break
    
    if not title:
        title = file_path.stem.replace('_', ' ').replace('-', ' ')
    
    text_content = re.sub(r'```[\s\S]*?```', '', content)
    text_content = re.sub(r'`[^`]+`', '', text_content)
    text_content = re.sub(r'!\[([^\]]*)\]\([^\)]+\)', '', text_content)
    text_content = re.sub(r'\[([^\]]+)\]\([^\)]+\)', r'\1', text_content)
    text_content = re.sub(r'#+ ', '', text_content)
    text_content = re.sub(r'\*+([^*]+)\*+', r'\1', text_content)
    text_content = re.sub(r'\s+', ' ', text_content).strip()
    
    return {
        "title": title,
        "content": text_content,
        "source": "tianocore-docs",
        "file_path": str(file_path)
    }


def process_docs_repository(docs_dir: Path) -> dict:
    """Process all Markdown files in tianocore-docs repositories"""
    docs_pages = {}
    
    if not docs_dir.exists():
        return docs_pages
    
    for repo_dir in docs_dir.iterdir():
        if not repo_dir.is_dir():
            continue
        
        print(f"Processing repository: {repo_dir.name}")
        
        for md_file in repo_dir.rglob("*.md"):
            if '.git' in str(md_file):
                continue
            
            page_data = parse_markdown_file(md_file)
            if page_data and page_data["content"]:
                rel_path = md_file.relative_to(docs_dir)
                page_key = f"docs/{rel_path.with_suffix('')}"
                page_key = page_key.replace('\\', '/')
                
                docs_pages[page_key] = page_data
                print(f"  Added: {page_key}")
    
    return docs_pages


def fetch_all_pages(output_dir: str = None, include_docs: bool = True):
    """Fetch all wiki pages and docs"""
    if output_dir is None:
        output_dir = Path(__file__).parent / "knowledge"
    else:
        output_dir = Path(output_dir)
    
    output_dir.mkdir(parents=True, exist_ok=True)
    
    pages = {}
    visited = set()
    to_visit = [BASE_URL]
    
    print(f"Fetching wiki content from {BASE_URL}")
    print(f"Output directory: {output_dir}")
    
    while to_visit:
        url = to_visit.pop(0)
        
        if url in visited:
            continue
        visited.add(url)
        
        print(f"Fetching: {url}")
        html = fetch_url(url)
        
        if not html:
            continue
        
        content = extract_content(html)
        path = get_page_path(url)
        
        if path and content["content"]:
            content["source"] = "tianocore-wiki"
            pages[path] = content
            print(f"  Saved: {path} ({len(content['content'])} chars)")
        
        links = parse_html_links(html, url)
        for link in links:
            if link not in visited and link not in to_visit:
                if 'tianocore.org' in link or link.startswith('/'):
                    to_visit.append(link)
        
        time.sleep(0.5)
    
    print(f"\nFetched {len(pages)} wiki pages")
    
    if include_docs:
        print("\n" + "="*50)
        print("Processing tianocore-docs repository...")
        print("="*50)
        
        docs_dir = clone_docs_repo(output_dir)
        docs_pages = process_docs_repository(docs_dir)
        
        for page_key, page_data in docs_pages.items():
            pages[page_key] = page_data
        
        print(f"\nAdded {len(docs_pages)} docs pages")
    
    index_file = output_dir / "wiki_index.json"
    with open(index_file, "w", encoding="utf-8") as f:
        json.dump({"pages": pages, "total": len(pages)}, f, indent=2)
    
    print(f"\nTotal: {len(pages)} pages")
    print(f"Saved to: {index_file}")
    
    return pages


def fetch_sample_pages(output_dir: str = None, include_docs: bool = True):
    """Fetch a sample of important pages for demo"""
    if output_dir is None:
        output_dir = Path(__file__).parent / "knowledge"
    else:
        output_dir = Path(output_dir)
    
    output_dir.mkdir(parents=True, exist_ok=True)
    
    important_pages = [
        "",
        "development/tutorials-howto/getting_started_with_edk_ii.html",
        "development/contribution-guides/how_to_contribute.html",
        "platforms-packages/platform-ports/ovmf.html",
        "platforms-packages/platform-ports/emulator_pkg.html",
        "reference/specs-standards/uefi.html",
        "reference/specs-standards/pi.html",
        "community/support-onboarding/reporting_issues.html",
        "security/processes/reporting_security_issues.html",
    ]
    
    pages = {}
    
    print(f"Fetching sample wiki content from {BASE_URL}")
    print(f"Output directory: {output_dir}")
    
    for page_path in important_pages:
        url = BASE_URL + page_path
        print(f"Fetching: {url}")
        
        html = fetch_url(url)
        if not html:
            continue
        
        content = extract_content(html)
        path = get_page_path(url)
        
        if path and content["content"]:
            content["source"] = "tianocore-wiki"
            pages[path] = content
            print(f"  Saved: {path}")
        
        time.sleep(0.5)
    
    print(f"\nFetched {len(pages)} wiki pages")
    
    if include_docs:
        print("\n" + "="*50)
        print("Processing tianocore-docs repository...")
        print("="*50)
        
        docs_dir = clone_docs_repo(output_dir)
        docs_pages = process_docs_repository(docs_dir)
        
        for page_key, page_data in docs_pages.items():
            pages[page_key] = page_data
        
        print(f"\nAdded {len(docs_pages)} docs pages")
    
    index_file = output_dir / "wiki_index.json"
    with open(index_file, "w", encoding="utf-8") as f:
        json.dump({"pages": pages, "total": len(pages)}, f, indent=2)
    
    print(f"\nTotal: {len(pages)} pages")
    print(f"Saved to: {index_file}")
    
    return pages


def main():
    parser = argparse.ArgumentParser(description="Fetch TianoCore Wiki and Docs Content")
    parser.add_argument("--output", "-o", help="Output directory")
    parser.add_argument("--sample", action="store_true", help="Fetch sample pages only")
    parser.add_argument("--no-docs", action="store_true", help="Skip tianocore-docs repository")
    args = parser.parse_args()
    
    include_docs = not args.no_docs
    
    if args.sample:
        fetch_sample_pages(args.output, include_docs=include_docs)
    else:
        fetch_all_pages(args.output, include_docs=include_docs)


if __name__ == "__main__":
    main()