#!/usr/bin/env python3
"""
EDK2 Knowledge Base Initializer - Enhanced Version
Full site crawling with incremental update support
"""

import os
import re
import sys
import json
import time
import shutil
import subprocess
import hashlib
import argparse
from pathlib import Path
from urllib.parse import urljoin, urlparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from typing import Dict, List, Set, Tuple, Optional

import requests
from bs4 import BeautifulSoup
from tqdm import tqdm

BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "data"
WIKI_DIR = DATA_DIR / "tianocore-wiki"
DOCS_DIR = DATA_DIR / "tianocore-docs"
CHROMA_DIR = DATA_DIR / "chroma_db"
PROCESSED_DIR = DATA_DIR / "processed"

WIKI_BASE_URL = "https://www.tianocore.org/tianocore-wiki.github.io/"
DOCS_REPO_URL = "https://github.com/tianocore-docs/Docs.git"

TIANOCORE_DOCS_REPOS = [
    "ATBB-Memory_Protection_in_UEFI_BIOS",
    "ATBB-Mitigate_Buffer_Overflow_in_UEFI",
    "Docs",
    "EDK_II_Secure_Code_Review_Guide",
    "EDK_II_Secure_Coding_Guide",
    "EDKIIHttpBootGettingStartedGuide",
    "EDKIIHttpsBootGettingStartedGuide",
    "SecurityAdvisory",
    "ThirdPartySecurityAdvisories",
    "Training",
    "UEFI_Driver_HII_Linux_Lab_Guide",
    "UEFI_Driver_HII_Win_Lab_Guide",
    "Understanding_UEFI_Secure_Boot_Chain",
    "edk2-BuildSpecification",
    "edk2-CCodingStandardsSpecification",
    "edk2-DecSpecification",
    "edk2-DscSpecification",
    "edk2-FdfSpecification",
    "edk2-GettingStartedGuideforStandaloneMMonX86Systems",
    "edk2-IdfSpecification",
    "edk2-InfSpecification",
    "edk2-MetaDataExpressionSyntaxSpecification",
    "edk2-MinimumPlatformSpecification",
    "edk2-ModuleWriteGuide",
    "edk2-PcdSpecification",
    "edk2-PythonDevelopmentProcessSpecification",
    "edk2-TemplateSpecification",
    "edk2-TrustedBootChain",
    "edk2-UefiDriverWritersGuide",
    "edk2-UniSpecification",
    "edk2-VfrSpecification",
    "publish-gitbook-docs",
    "tianocore-docs.github.io",
]

META_FILE = WIKI_DIR / "metadata.json"
DOCS_META_FILE = DOCS_DIR / "metadata.json"

# Text-bearing file types we index from the tianocore-docs repos. Binary-only
# formats (png/jpg/css/js/zip/fonts) are skipped, as are chm help archives.
TEXT_EXTENSIONS = {'.md', '.txt', '.html', '.htm', '.pdf'}

# Directories that only hold build scaffolding or template files with no
# document content (Jinja/GitBook layouts, generated sites, node deps).
SKIP_DIR_PARTS = ('_layouts', '_includes', '_site', 'node_modules', '.git')

# File names that are licensing/process boilerplate rather than content.
_SKIP_NAME_PATTERNS = re.compile(
    r'^(license|licence|contribut|notice|copying|copyright|readme|authors'
    r'|maintainers|changelog|release_notes|code_of_conduct|security)\b',
    re.IGNORECASE,
)

# Doxygen API pages are indexed but carry heavy per-page chrome; cap chunking
# noise by treating them like any other html once main content is extracted.
_DOXYGEN_CONTENT_SELECTORS = ('div.contents', 'div.textblock')

session = requests.Session()
session.headers.update({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
})

def log(msg: str, level: str = "INFO"):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] [{level}] {msg}")

def load_metadata() -> Dict:
    """Load existing metadata for incremental update"""
    if META_FILE.exists():
        with open(META_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {
        'pages': {},
        'last_update': None,
        'total_pages': 0
    }

def save_metadata(meta: Dict):
    """Save metadata"""
    META_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(META_FILE, 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)

def get_page_hash(content: str) -> str:
    """Calculate page content hash"""
    return hashlib.sha256(content.encode('utf-8')).hexdigest()

def fetch_page(url: str) -> Tuple[Optional[str], Optional[Dict], List[str]]:
    """Fetch a single wiki page"""
    try:
        response = session.get(url, timeout=30)
        response.raise_for_status()
        
        soup = BeautifulSoup(response.text, 'lxml')
        
        relative_path = urlparse(url).path.lstrip('/')
        if not relative_path:
            relative_path = 'index.html'
        elif not relative_path.endswith('.html'):
            relative_path += '.html'
        
        links = []
        for link in soup.find_all('a', href=True):
            href = link['href']
            
            if href.startswith(('http://', 'https://')):
                if not href.startswith(WIKI_BASE_URL):
                    continue
                full_url = href
            elif href.startswith(('#', 'mailto:', '.')):
                continue
            else:
                full_url = urljoin(url, href)
            
            if full_url.startswith(WIKI_BASE_URL):
                anchor_pos = full_url.find('#')
                if anchor_pos > 0:
                    full_url = full_url[:anchor_pos]
                links.append(full_url)
        
        for tag in soup.find_all(['link', 'script', 'img']):
            src = tag.get('href') or tag.get('src')
            if src and not src.startswith(('http://', 'https://', 'data:')):
                asset_url = urljoin(url, src)
                asset_path = WIKI_DIR / src.lstrip('/')
                try:
                    asset_resp = session.get(asset_url, timeout=10)
                    if asset_resp.status_code == 200:
                        asset_path.parent.mkdir(parents=True, exist_ok=True)
                        asset_path.write_bytes(asset_resp.content)
                except:
                    pass
        
        return response.text, {
            'url': url,
            'path': relative_path,
            'title': soup.title.string if soup.title else url,
            'hash': get_page_hash(response.text),
            'fetched_at': datetime.now().isoformat()
        }, links
        
    except Exception as e:
        log(f"Failed to fetch {url}: {e}", "ERROR")
        return None, None, []

def crawl_wiki_full(max_workers: int = 10) -> Dict:
    """Full site crawl"""
    log("Starting full wiki crawl...")
    
    WIKI_DIR.mkdir(parents=True, exist_ok=True)
    
    meta = {'pages': {}, 'last_update': None, 'total_pages': 0}
    
    visited: Set[str] = set()
    to_visit: List[str] = [WIKI_BASE_URL]
    pages_data = []
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        pbar = tqdm(desc="Crawling pages", unit="pages")
        
        while to_visit:
            batch = to_visit[:50]
            to_visit = to_visit[50:]
            
            batch_to_visit = []
            for url in batch:
                if url not in visited:
                    batch_to_visit.append(url)
                    visited.add(url)
            
            if not batch_to_visit:
                continue
            
            futures = {executor.submit(fetch_page, url): url for url in batch_to_visit}
            
            for future in as_completed(futures):
                content, page_info, links = future.result()
                
                if content and page_info:
                    page_file = WIKI_DIR / page_info['path']
                    page_file.parent.mkdir(parents=True, exist_ok=True)
                    page_file.write_text(content, encoding='utf-8')
                    
                    pages_data.append(page_info)
                    meta['pages'][page_info['url']] = {
                        'path': page_info['path'],
                        'title': page_info['title'],
                        'hash': page_info['hash'],
                        'fetched_at': page_info['fetched_at']
                    }
                    
                    for link in links:
                        if link not in visited:
                            to_visit.append(link)
                    
                    pbar.update(1)
        
        pbar.close()
    
    meta['last_update'] = datetime.now().isoformat()
    meta['total_pages'] = len(pages_data)
    save_metadata(meta)
    
    log(f"Full crawl complete: {len(pages_data)} pages")
    return meta

def crawl_wiki_incremental(max_workers: int = 10) -> Dict:
    """Incremental update - only fetch changed/new pages"""
    log("Starting incremental wiki update...")
    
    WIKI_DIR.mkdir(parents=True, exist_ok=True)
    
    old_meta = load_metadata()
    new_meta = {'pages': {}, 'last_update': None, 'total_pages': 0}
    
    visited: Set[str] = set()
    to_visit: List[str] = [WIKI_BASE_URL]
    
    updated_count = 0
    new_count = 0
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        pbar = tqdm(desc="Checking pages", unit="pages")
        
        while to_visit:
            batch = to_visit[:50]
            to_visit = to_visit[50:]
            
            batch_to_visit = []
            for url in batch:
                if url not in visited:
                    batch_to_visit.append(url)
                    visited.add(url)
            
            if not batch_to_visit:
                continue
            
            futures = {executor.submit(fetch_page, url): url for url in batch_to_visit}
            
            for future in as_completed(futures):
                content, page_info, links = future.result()
                
                if content and page_info:
                    old_page = old_meta.get('pages', {}).get(page_info['url'])
                    
                    needs_update = False
                    if old_page is None:
                        needs_update = True
                        new_count += 1
                    elif old_page.get('hash') != page_info['hash']:
                        needs_update = True
                        updated_count += 1
                    
                    if needs_update:
                        page_file = WIKI_DIR / page_info['path']
                        page_file.parent.mkdir(parents=True, exist_ok=True)
                        page_file.write_text(content, encoding='utf-8')
                    
                    new_meta['pages'][page_info['url']] = {
                        'path': page_info['path'],
                        'title': page_info['title'],
                        'hash': page_info['hash'],
                        'fetched_at': page_info['fetched_at']
                    }
                    
                    for link in links:
                        if link not in visited:
                            to_visit.append(link)
                    
                    pbar.update(1)
        
        pbar.close()
    
    for url, page_info in old_meta.get('pages', {}).items():
        if url not in new_meta['pages']:
            new_meta['pages'][url] = page_info
    
    new_meta['last_update'] = datetime.now().isoformat()
    new_meta['total_pages'] = len(new_meta['pages'])
    save_metadata(new_meta)
    
    log(f"Incremental update complete: {new_count} new, {updated_count} updated")
    return new_meta

def clone_tianocore_docs() -> Dict:
    """Clone or update all tianocore-docs repositories"""
    log("Cloning/updating tianocore-docs repositories...")
    
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    REPOS_DIR = DOCS_DIR / "repos"
    REPOS_DIR.mkdir(parents=True, exist_ok=True)
    
    meta = {'commits': {}, 'files': [], 'last_update': None}
    
    repo_dirs = sorted([d for d in REPOS_DIR.iterdir() if d.is_dir()])
    if not repo_dirs:
        log("No repos found under repos/, cloning all tianocore-docs repos...")
        for repo_name in TIANOCORE_DOCS_REPOS:
            repo_dir = REPOS_DIR / repo_name
            log(f"Cloning {repo_name}...")
            try:
                subprocess.run(
                    ['git', 'clone', '--depth', '1', '--single-branch',
                     f"https://github.com/tianocore-docs/{repo_name}.git",
                     str(repo_dir)],
                    capture_output=True,
                    text=True,
                    timeout=300
                )
                result = subprocess.run(
                    ['git', 'rev-parse', 'HEAD'],
                    cwd=repo_dir,
                    capture_output=True,
                    text=True,
                    timeout=10
                )
                meta['commits'][repo_name] = result.stdout.strip()
            except Exception as e:
                log(f"Git clone failed for {repo_name}: {e}", "ERROR")
        repo_dirs = sorted([d for d in REPOS_DIR.iterdir() if d.is_dir()])
    
    for repo_dir in repo_dirs:
        repo_name = repo_dir.name
        if (repo_dir / ".git").exists():
            log(f"Updating {repo_name}...")
            try:
                subprocess.run(
                    ['git', 'fetch', '--depth=1'],
                    cwd=repo_dir,
                    capture_output=True,
                    text=True,
                    timeout=60
                )
                subprocess.run(
                    ['git', 'reset', '--hard', 'origin/main'],
                    cwd=repo_dir,
                    capture_output=True,
                    text=True,
                    timeout=60
                )
                result = subprocess.run(
                    ['git', 'rev-parse', 'HEAD'],
                    cwd=repo_dir,
                    capture_output=True,
                    text=True,
                    timeout=10
                )
                meta['commits'][repo_name] = result.stdout.strip()
            except Exception as e:
                log(f"Git update failed for {repo_name}: {e}", "WARNING")
        else:
            log(f"Cloning {repo_name}...")
            try:
                subprocess.run(
                    ['git', 'clone', '--depth', '1', '--single-branch',
                     f"https://github.com/tianocore-docs/{repo_name}.git",
                     str(repo_dir)],
                    capture_output=True,
                    text=True,
                    timeout=300
                )
                result = subprocess.run(
                    ['git', 'rev-parse', 'HEAD'],
                    cwd=repo_dir,
                    capture_output=True,
                    text=True,
                    timeout=10
                )
                meta['commits'][repo_name] = result.stdout.strip()
            except Exception as e:
                log(f"Git clone failed for {repo_name}: {e}", "ERROR")
    
    text_files: List[Path] = []
    skipped = 0
    for candidate in sorted(REPOS_DIR.rglob('*')):
        if not candidate.is_file():
            continue
        if any(part in SKIP_DIR_PARTS for part in candidate.parts):
            continue
        if candidate.suffix.lower() not in TEXT_EXTENSIONS:
            continue
        if candidate.suffix.lower() in ('.txt',):
            stem_lower = candidate.stem.lower()
            if _SKIP_NAME_PATTERNS.match(stem_lower):
                skipped += 1
                continue
        text_files.append(candidate)

    log(f"Found {len(text_files)} text-bearing files across "
        f"{len(repo_dirs)} repos "
        f"({len([f for f in text_files if f.suffix.lower() == '.md'])} markdown, "
        f"{len([f for f in text_files if f.suffix.lower() == '.pdf'])} pdf, "
        f"{len([f for f in text_files if f.suffix.lower() in ('.html', '.htm')])} html, "
        f"{len([f for f in text_files if f.suffix.lower() == '.txt'])} txt); "
        f"skipped {skipped} boilerplate text files")

    meta['files'] = [str(f.relative_to(REPOS_DIR)) for f in text_files]
    meta['last_update'] = datetime.now().isoformat()
    
    with open(DOCS_META_FILE, 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)
    
    return meta

def extract_html_content(html_path: Path) -> str:
    """Extract clean text from HTML, removing navigation and noise.
    
    Args:
        html_path: Path to HTML file
    
    Returns:
        Clean text content with structure preserved
    """
    try:
        with open(html_path, 'r', encoding='utf-8', errors='ignore') as f:
            soup = BeautifulSoup(f.read(), 'html.parser')
        
        # Remove noise elements
        for tag in soup(['nav', 'footer', 'aside', 'script', 'style', 
                         'header', 'iframe', 'noscript', 'form']):
            tag.decompose()
        
        # Try to find main content area (Doxygen pages use div.contents /
        # div.textblock instead of the semantic tags above).
        main_content = (soup.find('main') or
                        soup.find('article') or
                        soup.find('div', class_='content') or
                        soup.find('div', class_='documentation') or
                        soup.select_one('div.contents') or
                        soup.select_one('div.textblock') or
                        soup.body)
        
        if not main_content:
            return ""
        
        # Extract structured content
        content_parts = []
        
        # Extract headings and their associated content
        for heading in main_content.find_all(['h1', 'h2', 'h3', 'h4']):
            heading_text = heading.get_text(strip=True)
            if heading_text:
                level = int(heading.name[1])
                prefix = "#" * level
                content_parts.append(f"\n{prefix} {heading_text}")
                
                # Get paragraphs under this heading, stopping at the next heading.
                # NOTE: use unfiltered find_next_siblings() so the h1-h4 break
                # condition can actually fire. A filtered call only ever returns
                # p/pre/ul/ol/table nodes, making the break unreachable and
                # turning extraction into O(N^2) duplicate text.
                for sibling in heading.find_next_siblings():
                    if sibling.name in ['h1', 'h2', 'h3', 'h4']:
                        break
                    if sibling.name not in ['p', 'pre', 'ul', 'ol', 'table']:
                        continue
                    
                    text = sibling.get_text(separator='\n', strip=True)
                    if text and len(text) > 10:
                        content_parts.append(text)
        
        # If no structure found, fall back to plain text
        if not content_parts:
            content_parts = [main_content.get_text(separator='\n', strip=True)]
        
        return '\n'.join(content_parts)
    
    except Exception as e:
        return ""


def extract_pdf_content(pdf_path: Path) -> str:
    """Extract text from a PDF using PyMuPDF.

    Pages are separated by a blank line so downstream chunking keeps page
    boundaries visible. Returns an empty string on any failure.
    """
    try:
        import pymupdf
    except ImportError:
        log("PyMuPDF not available, skipping PDF", "ERROR")
        return ""

    try:
        pages_text = []
        with pymupdf.open(pdf_path) as doc:
            for page in doc:
                text = page.get_text().strip()
                if text:
                    pages_text.append(text)
        return '\n\n'.join(pages_text)
    except Exception as e:
        log(f"Failed to extract PDF {pdf_path.name}: {e}", "WARNING")
        return ""


_MARKDOWN_HEADING_RE = re.compile(r'^(#{1,6})\s+(.*)$')
_HEADING_LEVELS = ('h1', 'h2', 'h3', 'h4', 'h5', 'h6')


def _is_valid_content(content: str, min_len: int = 100) -> bool:
    """Return True when the extracted text is a real document, not a stub.

    Filters out placeholder/boilerplate fragments from Doxygen or mdbook
    (e.g. '{{ book.title }}', bare templates) and near-empty extractions.
    """
    if not content or len(content) < min_len:
        return False
    stripped = content.strip()
    if not stripped:
        return False
    # Placeholder tokens that indicate a template, not real content.
    template_markers = ('{{ book.title }}', '{{#summary', 'Page content goes here',
                        'TEASER', 'This page is intentionally blank')
    if any(m in stripped for m in template_markers) and len(stripped) < 1200:
        return False
    return True

def chunk_text(text: str, chunk_size: int = 2000, overlap: int = 0) -> List[Dict]:
    """Split text into chunks (fallback when no heading structure exists).

    Breaks at paragraph/sentence boundaries; ``overlap`` is 0 by default —
    duplicated text between chunks is avoided (0~5% sentence-anchored overlap
    can be re-enabled by passing a small positive value).
    """
    if len(text) <= chunk_size:
        return [{'text': text, 'position': f"0-{len(text)}"}]

    chunks = []
    start = 0
    min_chunk_size = 300  # Minimum chunk size

    while start < len(text):
        end = min(start + chunk_size, len(text))

        # Try to break at paragraph/newline boundary (look back 250 chars)
        if end < len(text):
            search_start = max(start, end - 250)
            last_period = text.rfind('.', search_start, end)
            last_newline = text.rfind('\n', search_start, end)
            break_point = max(last_period, last_newline)

            if break_point > start + min_chunk_size:
                end = break_point + 1

        chunk_content = text[start:end].strip()

        # Only add chunks that are meaningful size
        if len(chunk_content) >= min_chunk_size:
            chunks.append({
                'text': chunk_content,
                'position': f"{start}-{end}"
            })

        # Move start with overlap, but ensure progress
        next_start = end - overlap
        if next_start <= start:
            next_start = start + chunk_size
        start = next_start

    return chunks if chunks else [{'text': text, 'position': f"0-{len(text)}"}]


_FENCE_RE = re.compile(r'^\s*(```|~~~)')
_TABLE_LINE_RE = re.compile(r'^\s*\|.*\|\s*$')
_RULE_SENTENCE_RE = re.compile(
    r'^\s*(shall|must|may|should)\b|^\s*There\s+(shall|must)\b',
    re.IGNORECASE)


def _find_break(lines: List[str], start: int, end: int, min_len: int) -> int:
    """Pick a safe split point inside ``lines[start:end]``.

    Prefers (in order): a rule-sentence start (shall/must/...), a paragraph
    break, a sentence-ending line, the largest lexical-gap boundary (topic
    shift proxy: adjacent lines share few terms). Never cuts inside a fenced
    code block or a markdown table — those always stay whole.
    """
    # Mark forbidden regions: inside ``` fences and inside tables.
    in_fence = False
    candidates = []  # (priority, index) index = line start
    for i in range(start, end):
        line = lines[i]
        if _FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if _TABLE_LINE_RE.match(line):
            continue
        if i <= start + min_len:
            continue
        prio = 0
        stripped = line.strip()
        if _RULE_SENTENCE_RE.match(stripped):
            prio = 4                      # strongest: a new normative rule
        elif not stripped and i + 1 < end and lines[i + 1].strip():
            prio = 3                      # paragraph break
        elif stripped.endswith(('.', ';', ':')):
            prio = 2                      # sentence end
        else:
            prio = 1                      # lexical-gap candidate
        candidates.append((prio, i))
    if not candidates:
        return end
    candidates.sort(key=lambda c: (-c[0], c[1]))
    # Lexical gap among priority-1 candidates: pick the one whose term sets
    # (current vs next line) overlap least — a cheap topic-shift detector
    # (NLP-free semantic boundary proxy, zero model cost).
    p1 = [i for p, i in candidates if p == 1]
    if p1 and len(p1) > 1:
        def terms(line: str) -> set:
            return {w.lower() for w in re.split(r'[\s\W_]+', line) if len(w) > 2}
        best, best_gap = p1[0], -1.0
        for i in p1:
            prev_win = ' '.join(lines[max(start, i - 2):i])
            next_win = ' '.join(lines[i:min(end, i + 2)])
            a, b = terms(prev_win), terms(next_win)
            if not a or not b:
                continue
            gap = 1.0 - (len(a & b) / min(len(a), len(b)))
            if gap > best_gap:
                best, best_gap = i, gap
        # Only trust a strong gap over the first sentence-end candidate.
        if best_gap >= 0.75:
            return best
    return candidates[0][1]


def _split_long_text(text: str, chunk_size: int = 2000,
                     overlap: int = 0, min_chunk_size: int = 300) -> List[str]:
    """Split an over-long section body at safe boundaries.

    Splits land at rule-sentence starts / paragraph breaks / sentence ends /
    lexical-gap (topic-shift) boundaries, never inside code fences or tables.
    ``overlap`` is sentence-anchored: 0 by default (chunks start at the next
    boundary — section paths are prefixed, so continuity does not rely on
    duplicated text; a value >0 keeps that many trailing characters).
    """
    if len(text) <= chunk_size:
        return [text]
    lines = text.split('\n')
    parts: List[str] = []
    start = 0
    total = len(lines)
    while start < total:
        remain = sum(len(l) + 1 for l in lines[start:])
        if remain <= chunk_size:
            parts.append('\n'.join(lines[start:]).strip())
            break
        # End candidate: prefer a boundary near chunk_size; fall back hard-cut.
        limit = start + 1
        acc = 0
        while limit < total and acc < chunk_size:
            acc += len(lines[limit]) + 1
            limit += 1
        end = _find_break(lines, start, min(limit, total), min_chunk_size)
        part = '\n'.join(lines[start:end]).strip()
        if len(part) >= min_chunk_size:
            parts.append(part)
        start = end
    return [p for p in parts if p] or [text]


def chunk_text_structured(text: str, chunk_size: int = 2000,
                          overlap: int = 0) -> List[Dict]:
    """Split text into chunks that respect the markdown heading hierarchy.

    Each chunk keeps its section path (the chain of headings that contains
    it) so retrieval retains document context. Over-long sections are split
    at safe boundaries (rule sentences / paragraphs / sentence ends / topic
    gaps; never inside code fences or tables) and each sub-chunk is prefixed
    with its section path, dramatically improving relevance for structured
    EDK2 docs. ``overlap`` is sentence-anchored (0 = no duplicated text).

    Returns:
        List of dicts with 'text', 'position', 'section' and 'section_level'
        keys.
    """
    lines = text.split('\n')
    if not lines:
        return []

    chunks: List[Dict] = []
    heading_stack: List[Tuple[int, str]] = []
    current_lines: List[str] = []

    def section_path() -> str:
        return ' > '.join(title for _, title in heading_stack)

    def section_level() -> int:
        return heading_stack[-1][0] if heading_stack else 0

    def flush() -> None:
        nonlocal current_lines
        if not current_lines:
            return
        body = '\n'.join(current_lines).strip()
        current_lines = []
        if not body:
            return
        section = section_path()
        level = section_level()
        if len(body) <= chunk_size or not section:
            # Short section, or no heading context: keep as a single chunk.
            if section:
                body = f"Section: {section}\n{body}"
            chunks.append({'text': body, 'position': f"0-{len(body)}",
                           'section': section, 'section_level': level})
            return
        # Long section: split at safe boundaries, prefix the section path.
        for i, sub in enumerate(_split_long_text(body, chunk_size, overlap)):
            sub_body = f"Section: {section}\n{sub}"
            chunks.append({'text': sub_body, 'position': f"{i}:{len(sub)}",
                           'section': section, 'section_level': level})

    for line in lines:
        m = _MARKDOWN_HEADING_RE.match(line.strip())
        if m:
            flush()
            level = len(m.group(1))
            title = m.group(2).strip()
            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()
            heading_stack.append((level, title))
            current_lines.append(line)
        else:
            current_lines.append(line)
    flush()

    return chunks if chunks else chunk_text(text, chunk_size, overlap)


_RST_UNDERLINE_CHARS = '=-~^"`+*:'

def rst_to_markdown_headings(text: str) -> str:
    """Convert reStructuredText section headings to markdown ``#`` headings.

    RST titles are written as a bare line followed by an underline of a single
    punctuation character (``=`` for h1, ``-`` h2, ``~`` h3, ``^`` h4, ...).
    ``chunk_text_structured`` only understands markdown headings, so convert
    them so spec chapters keep their section path during chunking. Directive
    lines (``.. foo::``) and blank leading space are dropped as boilerplate.
    """
    lines = text.split('\n')
    out: List[str] = []
    for i, line in enumerate(lines):
        # An underline is a run (>=2) of one punctuation char.
        if re.fullmatch(r'([=\-~^"`+*:])\1+', line):
            if i > 0:
                title = lines[i - 1].strip()
                if title and not title.startswith('.. ') and not title.startswith('#'):
                    out[-1] = '#' * 4 + ' ' + title
            continue
        if line.lstrip().startswith('.. '):
            continue
        out.append(line)
    return '\n'.join(out)


def process_documents() -> int:
    """Process all documents for indexing"""
    log("Processing documents...")
    
    # 清理旧的已处理文件，避免累积
    if PROCESSED_DIR.exists():
        log("Cleaning old processed files...")
        import shutil
        shutil.rmtree(PROCESSED_DIR)
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    
    documents = []
    
    wiki_meta = load_metadata()
    log(f"Processing {len(wiki_meta.get('pages', {}))} wiki pages...")
    
    for url, info in tqdm(wiki_meta.get('pages', {}).items(), desc="Processing wiki"):
        page_path = WIKI_DIR / info.get('path', '')
        if not page_path.exists():
            continue
        
        # Skip the mdbook merged print page: it duplicates every chapter and
        # can expand to gigabytes of text, hanging processing for hours.
        if Path(info.get('path', '')).name == 'print.html':
            log(f"Skipping merged print page: {info.get('path')}")
            continue
        
        try:
            # Use improved HTML extraction
            content = extract_html_content(page_path)
            
            if _is_valid_content(content):
                # Chunk the document for better retrieval, keeping section
                # headings so each chunk retains its document context.
                # Sentence-anchored overlap=0: no duplicated text between
                # chunks (the Section: prefix carries the context instead).
                chunks = chunk_text_structured(content, chunk_size=2000,
                                               overlap=0)

                for chunk_idx, chunk in enumerate(chunks):
                    doc_file = PROCESSED_DIR / f"wiki_{len(documents)}.txt"
                    with open(doc_file, 'w', encoding='utf-8') as f:
                        f.write(f"Title: {info.get('title', 'Unknown')}\n")
                        f.write(f"URL: {url}\n")
                        f.write(f"Source: tianocore-wiki\n")
                        f.write(f"Chunk: {chunk_idx+1}/{len(chunks)}\n")
                        f.write(f"Section: {chunk.get('section', '')}\n")
                        f.write(f"Position: {chunk.get('position', '')}\n\n")
                        f.write(chunk['text'])

                    documents.append({
                        'path': str(doc_file),
                        'source': 'tianocore-wiki',
                        'title': info.get('title', 'Unknown'),
                        'url': url,
                        'section': chunk.get('section', ''),
                        'section_level': chunk.get('section_level', 0),
                        'chunk_idx': chunk_idx,
                        'total_chunks': len(chunks)
                    })
        except Exception as e:
            continue
    
    docs_meta_file = DOCS_DIR / "metadata.json"
    if docs_meta_file.exists():
        with open(docs_meta_file, 'r', encoding='utf-8') as f:
            docs_meta = json.load(f)
        
        repos_dir = DOCS_DIR / "repos"
        log(f"Processing {len(docs_meta.get('files', []))} docs files...")
        
        for rel_path in tqdm(docs_meta.get('files', []), desc="Processing docs"):
            doc_file = repos_dir / rel_path
            if not doc_file.exists():
                continue

            suffix = doc_file.suffix.lower()

            try:
                if suffix == '.pdf':
                    content = extract_pdf_content(doc_file)
                elif suffix in ('.html', '.htm'):
                    content = extract_html_content(doc_file)
                else:
                    with open(doc_file, 'r', encoding='utf-8', errors='ignore') as f:
                        content = f.read()

                if _is_valid_content(content, min_len=150):
                    repo_name = rel_path.split(os.sep)[0] if os.sep in rel_path else "docs"

                    # Chunk the document for better retrieval, keeping section
                    # headings so each chunk retains its document context.
                    # Spec/guide markdown repos get rule-level granularity
                    # (1200 chars): most chapters are dense with shall/must
                    # rules, and smaller chunks keep one or two rules per
                    # vector instead of a blended topic. PDFs keep 2000
                    # (page-extracted text is less structured).
                    cs = 1200 if suffix != '.pdf' else 2000
                    chunks = chunk_text_structured(content, chunk_size=cs,
                                                   overlap=0)

                    for chunk_idx, chunk in enumerate(chunks):
                        out_file = PROCESSED_DIR / f"docs_{len(documents)}.txt"
                        with open(out_file, 'w', encoding='utf-8') as f:
                            f.write(f"File: {rel_path}\n")
                            f.write(f"Repo: {repo_name}\n")
                            f.write(f"Source: tianocore-docs\n")
                            f.write(f"Chunk: {chunk_idx+1}/{len(chunks)}\n")
                            f.write(f"Section: {chunk.get('section', '')}\n")
                            f.write(f"Position: {chunk.get('position', '')}\n\n")
                            f.write(chunk['text'])

                        documents.append({
                            'path': str(out_file),
                            'source': 'tianocore-docs',
                            'repo': repo_name,
                            'file': rel_path,
                            'section': chunk.get('section', ''),
                            'section_level': chunk.get('section_level', 0),
                            'chunk_idx': chunk_idx,
                            'total_chunks': len(chunks)
                        })
            except Exception:
                continue
    
    # ------------------------------------------------------------------ #
    # uefi.org spec sources (official UEFI Forum RST releases + PDF specs)
    # ------------------------------------------------------------------ #
    specs_dir = DATA_DIR / "uefi-specs"
    if specs_dir.exists():
        # RST sources: official UEFI Forum release repositories keep their
        # chapters as .rst files under <version>/source/.
        spec_files = sorted(specs_dir.glob('*/source/*.rst'))
        log(f"Processing {len(spec_files)} uefi.org spec RST files...")
        for rst_file in tqdm(spec_files, desc="Processing uefi-specs"):
            version = rst_file.parts[-3]
            try:
                with open(rst_file, 'r', encoding='utf-8', errors='ignore') as f:
                    content = rst_to_markdown_headings(f.read())

                if _is_valid_content(content, min_len=150):
                    chunks = chunk_text_structured(content, chunk_size=1200,
                                                   overlap=0)
                    rel_path = f"{version}/source/{rst_file.name}"
                    for chunk_idx, chunk in enumerate(chunks):
                        out_file = PROCESSED_DIR / f"spec_{len(documents)}.txt"
                        with open(out_file, 'w', encoding='utf-8') as f:
                            f.write(f"Title: {version} - {rst_file.stem}\n")
                            f.write(f"File: {rel_path}\n")
                            f.write(f"Repo: {version}\n")
                            f.write(f"Source: uefi-specs\n")
                            f.write(f"Chunk: {chunk_idx+1}/{len(chunks)}\n")
                            f.write(f"Section: {chunk.get('section', '')}\n")
                            f.write(f"Position: {chunk.get('position', '')}\n\n")
                            f.write(chunk['text'])

                        documents.append({
                            'path': str(out_file),
                            'source': 'uefi-specs',
                            'repo': version,
                            'file': rel_path,
                            'section': chunk.get('section', ''),
                            'section_level': chunk.get('section_level', 0),
                            'chunk_idx': chunk_idx,
                            'total_chunks': len(chunks)
                        })
            except Exception:
                continue

        # PDF spec files: a few UEFI specs (e.g. UEFI Shell) only ship as a
        # single PDF placed at <version>/source/*.pdf. Extract per-page text
        # so they participate in retrieval like the RST releases.
        pdf_files = sorted(specs_dir.glob('*/source/*.pdf'))
        log(f"Processing {len(pdf_files)} uefi.org spec PDF files...")
        for pdf_file in tqdm(pdf_files, desc="Processing uefi-specs PDF"):
            version = pdf_file.parts[-3]
            try:
                content = extract_pdf_content(pdf_file)
                if not _is_valid_content(content, min_len=150):
                    log(f"Skipping empty PDF: {pdf_file.name}", "WARNING")
                    continue
                chunks = chunk_text_structured(content, chunk_size=2000,
                                               overlap=0)
                rel_path = f"{version}/source/{pdf_file.name}"
                for chunk_idx, chunk in enumerate(chunks):
                    out_file = PROCESSED_DIR / f"spec_{len(documents)}.txt"
                    with open(out_file, 'w', encoding='utf-8') as f:
                        f.write(f"Title: {version} - {pdf_file.stem}\n")
                        f.write(f"File: {rel_path}\n")
                        f.write(f"Repo: {version}\n")
                        f.write(f"Source: uefi-specs\n")
                        f.write(f"Chunk: {chunk_idx+1}/{len(chunks)}\n")
                        f.write(f"Section: {chunk.get('section', '')}\n")
                        f.write(f"Position: {chunk.get('position', '')}\n\n")
                        f.write(chunk['text'])

                    documents.append({
                        'path': str(out_file),
                        'source': 'uefi-specs',
                        'repo': version,
                        'file': rel_path,
                        'section': chunk.get('section', ''),
                        'section_level': chunk.get('section_level', 0),
                        'chunk_idx': chunk_idx,
                        'total_chunks': len(chunks)
                    })
            except Exception as e:
                log(f"Failed to process PDF {pdf_file.name}: {e}", "WARNING")

    # ------------------------------------------------------------------ #
    # tianocore/edk2 pull request data (GitHub API JSONL)
    # ------------------------------------------------------------------ #
    prs_file = DATA_DIR / "edk2-prs" / "prs.jsonl"
    if prs_file.exists():
        log("Processing tianocore/edk2 pull requests...")
        with open(prs_file, 'r', encoding='utf-8') as f:
            pr_lines = [l for l in f if l.strip()]
        for line in tqdm(pr_lines, desc="Processing edk2-prs"):
            try:
                pr = json.loads(line)
                number = pr.get('number', '')
                title = pr.get('title', '')
                text = (f"PR #{number}: {title}\n"
                        f"State: {pr.get('state', '')}\n"
                        f"URL: {pr.get('html_url', '')}\n"
                        f"Opened: {pr.get('created_at', '')}\n"
                        f"Closed: {pr.get('closed_at', '')}\n"
                        f"Merged: {pr.get('merged_at', '')}\n"
                        f"Author: {pr.get('user', '')}\n"
                        f"Base: {pr.get('base', '')} <- Head: {pr.get('head', '')}\n"
                        f"Description:\n{pr.get('body', '') or ''}")
                if not _is_valid_content(text, min_len=150):
                    continue
                chunks = chunk_text_structured(text, chunk_size=2000,
                                               overlap=0)
                for chunk_idx, chunk in enumerate(chunks):
                    out_file = PROCESSED_DIR / f"pr_{len(documents)}.txt"
                    with open(out_file, 'w', encoding='utf-8') as f:
                        f.write(f"Title: PR #{number}: {title}\n")
                        f.write(f"URL: {pr.get('html_url', '')}\n")
                        f.write(f"File: PR#{number}\n")
                        f.write(f"Repo: tianocore/edk2\n")
                        f.write(f"Source: edk2-prs\n")
                        f.write(f"Chunk: {chunk_idx+1}/{len(chunks)}\n\n")
                        f.write(chunk['text'])

                    documents.append({
                        'path': str(out_file),
                        'source': 'edk2-prs',
                        'repo': 'tianocore/edk2',
                        'file': f"PR#{number}",
                        'url': pr.get('html_url', ''),
                        'section': f"PR {number}",
                        'date': pr.get('created_at', ''),
                        'chunk_idx': chunk_idx,
                        'total_chunks': len(chunks)
                    })
            except Exception:
                continue

    # ------------------------------------------------------------------ #
    # tianocore/edk2 commit log (git log export)
    # ------------------------------------------------------------------ #
    commits_file = DATA_DIR / "edk2-commits" / "commits.txt"
    if commits_file.exists():
        log("Processing tianocore/edk2 commit log...")
        blocks = []
        with open(commits_file, 'r', encoding='utf-8', errors='ignore') as f:
            current = []
            for line in f:
                if line.strip() == '---END-COMMIT---':
                    if current:
                        blocks.append('\n'.join(current))
                        current = []
                else:
                    current.append(line.rstrip('\n'))
            if current:
                blocks.append('\n'.join(current))

        log(f"Parsed {len(blocks)} commit entries...")
        for block in tqdm(blocks, desc="Processing edk2-commits"):
            try:
                commit_hash = author = date = subject = body = ''
                body_parts = []
                in_body = False
                for line in block.split('\n'):
                    if line.startswith('COMMIT: '):
                        commit_hash = line[len('COMMIT: '):]
                    elif line.startswith('AUTHOR: '):
                        author = line[len('AUTHOR: '):]
                    elif line.startswith('DATE: '):
                        date = line[len('DATE: '):]
                    elif line.startswith('SUBJECT: '):
                        subject = line[len('SUBJECT: '):]
                    elif line == 'BODY:':
                        in_body = True
                    elif in_body:
                        body_parts.append(line)
                body = '\n'.join(body_parts).strip()

                text = (f"Commit {commit_hash} by {author} on {date}\n"
                        f"Subject: {subject}\n"
                        f"URL: https://github.com/tianocore/edk2/commit/{commit_hash}\n\n"
                        f"{body}")
                if not subject or not _is_valid_content(text, min_len=150):
                    continue
                chunks = chunk_text_structured(text, chunk_size=2000,
                                               overlap=0)
                for chunk_idx, chunk in enumerate(chunks):
                    out_file = PROCESSED_DIR / f"commit_{len(documents)}.txt"
                    with open(out_file, 'w', encoding='utf-8') as f:
                        f.write(f"Title: {subject}\n")
                        f.write(f"URL: https://github.com/tianocore/edk2/commit/{commit_hash}\n")
                        f.write(f"File: {commit_hash}\n")
                        f.write(f"Repo: tianocore/edk2\n")
                        f.write(f"Source: edk2-commits\n")
                        f.write(f"Chunk: {chunk_idx+1}/{len(chunks)}\n\n")
                        f.write(chunk['text'])

                    documents.append({
                        'path': str(out_file),
                        'source': 'edk2-commits',
                        'repo': 'tianocore/edk2',
                        'file': commit_hash,
                        'url': f"https://github.com/tianocore/edk2/commit/{commit_hash}",
                        'section': subject,
                        'date': date,
                        'chunk_idx': chunk_idx,
                        'total_chunks': len(chunks)
                    })
            except Exception:
                continue

    doc_index = PROCESSED_DIR / 'documents.json'
    with open(doc_index, 'w', encoding='utf-8') as f:
        json.dump(documents, f, indent=2, ensure_ascii=False)
    
    log(f"Processed {len(documents)} total documents")
    return len(documents)

def build_chroma_index() -> int:
    """Build ChromaDB vector index with the configured embedding model"""
    log("Building ChromaDB vector index...")
    
    CHROMA_DIR.mkdir(parents=True, exist_ok=True)
    
    try:
        import chromadb
        from chromadb.utils import embedding_functions
    except ImportError:
        log("ChromaDB not available, skipping index build", "ERROR")
        return 0
    
    # Embedding model + device (override via env vars). all-MiniLM-L6-v2 is the
    # default: it is small (~74MB), fast to load and does not block startup.
    model_name = os.environ.get("EDK2_EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
    device = os.environ.get("EDK2_EMBEDDING_DEVICE", "cpu")
    log(f"Loading embedding model {model_name} (device={device})...")
    try:
        embedding_func = embedding_functions.SentenceTransformerEmbeddingFunction(
            model_name=model_name,
            device=device,
            normalize_embeddings=True,
            local_files_only=True
        )
    except Exception as e:
        log(f"Failed to load {model_name}, using default: {e}", "WARNING")
        embedding_func = None
    
    client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    
    # Delete existing collection if exists (to use new embedding)
    try:
        client.delete_collection("edk2_docs")
        log("Deleted old collection for fresh start")
    except:
        pass
    
    collection = client.get_or_create_collection(
        "edk2_docs",
        embedding_function=embedding_func,
        metadata={"hnsw:space": "cosine"}
    )
    
    doc_index = PROCESSED_DIR / 'documents.json'
    if not doc_index.exists():
        log("No processed documents found", "ERROR")
        return 0
    
    with open(doc_index, 'r', encoding='utf-8') as f:
        documents = json.load(f)
    
    log(f"Indexing {len(documents)} documents...")
    
    # Smaller batches keep peak memory bounded (large embedding models like
    # bge-m3 can exhaust RAM during upsert). Default 50; lower it to ~8-16 on
    # memory-constrained machines via EDK2_EMBEDDING_BATCH.
    batch_size = int(os.environ.get("EDK2_EMBEDDING_BATCH", "50"))
    indexed = 0
    
    for i in tqdm(range(0, len(documents), batch_size), desc="Building index"):
        batch = documents[i:i+batch_size]
        
        ids = []
        texts = []
        metadatas = []
        
        for j, doc in enumerate(batch):
            try:
                with open(doc['path'], 'r', encoding='utf-8') as f:
                    texts.append(f.read())
                ids.append(f"doc_{i+j}")
                metadatas.append({
                    'source': doc.get('source', 'unknown'),
                    'title': doc.get('title', ''),
                    'url': doc.get('url', ''),
                    'file': doc.get('file', ''),
                    'repo': doc.get('repo', ''),
                    'section': doc.get('section', ''),
                    'chunk_idx': doc.get('chunk_idx', 0),
                    'total_chunks': doc.get('total_chunks', 1),
                    'date': doc.get('date', ''),
                    'section_level': int(doc.get('section_level', 0) or 0)
                })
            except Exception:
                continue
        
        if texts:
            collection.upsert(
                ids=ids,
                documents=texts,
                metadatas=metadatas
            )
            indexed += len(texts)
    
    log(f"Indexed {indexed} documents into ChromaDB")
    return indexed


FTS_DB = DATA_DIR / "fts_index.db"

_FTS_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
    pid UNINDEXED,
    source UNINDEXED,
    title,
    url UNINDEXED,
    file UNINDEXED,
    repo UNINDEXED,
    section,
    body,
    tokenize = 'porter unicode61'
)
"""


def build_fts_index() -> int:
    """Build a SQLite FTS5 (BM25) keyword index alongside the vector index.

    The vector and keyword indexes are fused at query time with reciprocal
    rank fusion, which dramatically improves retrieval of EDK2 identifiers
    (GUIDs, PCD names, API names) that dense embeddings handle poorly.
    """
    import sqlite3

    doc_index = PROCESSED_DIR / 'documents.json'
    if not doc_index.exists():
        log("No processed documents found, skipping FTS index", "ERROR")
        return 0

    with open(doc_index, 'r', encoding='utf-8') as f:
        documents = json.load(f)

    log(f"Building FTS5 keyword index for {len(documents)} documents...")

    fts_path = FTS_DB
    try:
        fts_path.unlink()
    except FileNotFoundError:
        pass

    conn = sqlite3.connect(str(fts_path))
    conn.execute(_FTS_SCHEMA)

    rows = []
    for i, doc in enumerate(documents):
        try:
            with open(doc['path'], 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
            # Strip the metadata header block written by process_documents.
            body = content.split('\n\n', 1)[1] if '\n\n' in content else content
            if not body.strip():
                continue
            rows.append((
                i,                                  # pid == chroma id doc_i
                doc.get('source', 'unknown'),
                doc.get('title', ''),
                doc.get('url', ''),
                doc.get('file', ''),
                doc.get('repo', ''),
                doc.get('section', ''),
                body,
            ))
        except Exception:
            continue

    conn.execute("BEGIN")
    conn.executemany(
        "INSERT INTO docs (pid, source, title, url, file, repo, section, body) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)
    conn.commit()
    conn.execute(
        "INSERT INTO docs(docs) VALUES('optimize')")
    conn.commit()
    conn.close()

    log(f"Indexed {len(rows)} documents into FTS5 keyword index")
    return len(rows)

def main():
    parser = argparse.ArgumentParser(description='EDK2 Knowledge Base Initializer')
    parser.add_argument('--update', action='store_true', help='Incremental update mode')
    parser.add_argument('--workers', type=int, default=10, help='Number of parallel workers')
    parser.add_argument('--skip-wiki', action='store_true', help='Skip wiki crawling')
    parser.add_argument('--skip-docs', action='store_true', help='Skip docs cloning')
    parser.add_argument('--skip-index', action='store_true', help='Skip index building')
    args = parser.parse_args()
    
    log("=" * 60)
    log("EDK2 Knowledge Base Initialization")
    log("=" * 60)
    log(f"Mode: {'Incremental Update' if args.update else 'Full Initialization'}")
    log("")
    
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    
    if not args.skip_wiki:
        log("")
        log("=" * 60)
        log("Step 1: Crawling TianoCore Wiki")
        log("=" * 60)
        if args.update:
            crawl_wiki_incremental(args.workers)
        else:
            crawl_wiki_full(args.workers)
    
    if not args.skip_docs:
        log("")
        log("=" * 60)
        log("Step 2: Cloning tianocore-docs")
        log("=" * 60)
        clone_tianocore_docs()
    
    log("")
    log("=" * 60)
    log("Step 3: Processing Documents")
    log("=" * 60)
    process_documents()
    
    if not args.skip_index:
        log("")
        log("=" * 60)
        log("Step 4: Building Vector Index")
        log("=" * 60)
        build_chroma_index()

    log("")
    log("=" * 60)
    log("Step 5: Building Keyword Index")
    log("=" * 60)
    build_fts_index()

    log("")
    log("=" * 60)
    log("SUCCESS: Knowledge base initialized!")
    log("=" * 60)
    log("")
    log("Data directory: " + str(DATA_DIR))
    log("Run: npx edk2-opencode")

if __name__ == "__main__":
    main()