#!/usr/bin/env python3
"""
Fetch TianoCore Wiki Content

Downloads and indexes EDK II documentation from TianoCore wiki.
"""

import json
import os
import re
import time
import argparse
from pathlib import Path
from urllib.parse import urljoin, urlparse
import urllib.request
import urllib.error


BASE_URL = "https://www.tianocore.org/tianocore-wiki.github.io/"


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
    # Remove .html extension and leading slash
    if path.endswith('.html'):
        path = path[:-5]
    if path.startswith('/'):
        path = path[1:]
    return path


def fetch_all_pages(output_dir: str = None):
    """Fetch all wiki pages"""
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
        
        # Extract content
        content = extract_content(html)
        path = get_page_path(url)
        
        if path and content["content"]:
            pages[path] = content
            print(f"  Saved: {path} ({len(content['content'])} chars)")
        
        # Find more links
        links = parse_html_links(html, url)
        for link in links:
            if link not in visited and link not in to_visit:
                if 'tianocore.org' in link or link.startswith('/'):
                    to_visit.append(link)
        
        # Be nice to the server
        time.sleep(0.5)
    
    # Save index
    index_file = output_dir / "wiki_index.json"
    with open(index_file, "w", encoding="utf-8") as f:
        json.dump({"pages": pages, "total": len(pages)}, f, indent=2)
    
    print(f"\nFetched {len(pages)} pages")
    print(f"Saved to: {index_file}")
    
    return pages


def fetch_sample_pages(output_dir: str = None):
    """Fetch a sample of important pages for demo"""
    if output_dir is None:
        output_dir = Path(__file__).parent / "knowledge"
    else:
        output_dir = Path(output_dir)
    
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Important pages to fetch
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
            pages[path] = content
            print(f"  Saved: {path}")
        
        time.sleep(0.5)
    
    # Save index
    index_file = output_dir / "wiki_index.json"
    with open(index_file, "w", encoding="utf-8") as f:
        json.dump({"pages": pages, "total": len(pages)}, f, indent=2)
    
    print(f"\nFetched {len(pages)} pages")
    print(f"Saved to: {index_file}")
    
    return pages


def main():
    parser = argparse.ArgumentParser(description="Fetch TianoCore Wiki Content")
    parser.add_argument("--output", "-o", help="Output directory")
    parser.add_argument("--sample", action="store_true", help="Fetch sample pages only")
    args = parser.parse_args()
    
    if args.sample:
        fetch_sample_pages(args.output)
    else:
        fetch_all_pages(args.output)


if __name__ == "__main__":
    main()