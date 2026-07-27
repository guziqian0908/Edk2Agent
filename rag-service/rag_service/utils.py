"""
Utility functions for RAG Service
"""

import hashlib
import re
from typing import List


def generate_doc_id(content: str, source: str) -> str:
    content_hash = hashlib.md5(content.encode()).hexdigest()[:8]
    return f"{source}-{content_hash}"


def clean_text(text: str) -> str:
    text = re.sub(r'\s+', ' ', text)
    text = text.strip()
    return text


def chunk_text(text: str, chunk_size: int = 1024, overlap: int = 200) -> List[str]:
    if len(text) <= chunk_size:
        return [text]
    
    chunks = []
    start = 0
    
    while start < len(text):
        end = start + chunk_size
        
        if end < len(text):
            last_space = text.rfind(' ', start, end)
            if last_space > start:
                end = last_space
        
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        
        start = end - overlap
        if start >= len(text):
            break
    
    return chunks


def extract_title(content: str) -> str:
    lines = content.split('\n')
    for line in lines[:10]:
        if line.startswith('# '):
            return line[2:].strip()
        if line.startswith('## '):
            return line[3:].strip()
    return "Untitled"