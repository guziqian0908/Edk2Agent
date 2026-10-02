#!/usr/bin/env python3
"""Complete the TianoCore wiki coverage from its official mdBook source.

The HTML crawler in init_kb.py reaches ~288 of the ~376 pages (the site is slow
and BFS silently skips orphan pages). This script reads the markdown source
(tianocore/tianocore-wiki.github.io), keeps only pages NOT already present in
the KB, chunks them with the same structured chunker, and appends them under
the existing `tianocore-wiki` source with the site's canonical title
("<h1> - TianoCore EDK II Documentation") so citations and title matching stay
consistent. The FTS5 index is rebuilt in full and only the new chunks are
embedded into ChromaDB (mirrors fetchers/add_mdepkg.py).

Usage:
    python fetchers/add_wiki_git.py
    python fetchers/add_wiki_git.py --embed --batch 50
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from init_kb import chunk_text_structured, _is_valid_content  # noqa: E402

KB_DATA = Path(os.environ.get(
    "EDK2_KB_DATA", str(Path.home() / ".edk2-opencode" / "kb" / "data")))
SRC = KB_DATA / "tianocore-wiki-git"
PROCESSED = KB_DATA / "processed"
FTS_DB = KB_DATA / "fts_index.db"
CHROMA_DIR = KB_DATA / "chroma_db"
BGE_M3 = Path(os.environ.get(
    "EDK2_MODELS_DIR",
    str(Path.home() / ".edk2-opencode" / "models"))) / "bge-m3"
DOC_INDEX = PROCESSED / "documents.json"

SOURCE = "tianocore-wiki"
TITLE_SUFFIX = " - TianoCore EDK II Documentation"
SITE = "https://www.tianocore.org/tianocore-wiki.github.io/"

CHUNK_SIZE = 1200
SKIP_NAMES = {"SUMMARY.md", "README.md"}

FTS_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
    pid UNINDEXED, source UNINDEXED, title, url UNINDEXED, file UNINDEXED,
    repo UNINDEXED, section, body, tokenize = 'porter unicode61')
"""


def h1_title(text: str, fallback: str) -> str:
    for line in text.splitlines():
        m = re.match(r"^#\s+(.+?)\s*$", line)
        if m:
            return m.group(1).strip()
    return fallback


def process():
    with open(DOC_INDEX, "r", encoding="utf-8") as f:
        documents = json.load(f)
    existing = len(documents)
    existing_titles = {d.get("title") for d in documents
                       if d.get("source") == SOURCE}

    files = [p for p in sorted(SRC.rglob("*.md"))
             if p.name not in SKIP_NAMES and "node_modules" not in p.parts]
    print(f"wiki-git markdown files: {len(files)}; "
          f"existing wiki titles: {len(existing_titles)}")

    new_docs = []
    added = 0
    skipped = 0
    for p in files:
        rel = p.relative_to(SRC).as_posix()
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        canonical = h1_title(text, p.stem) + TITLE_SUFFIX
        if canonical in existing_titles:
            skipped += 1
            continue
        if not _is_valid_content(text, min_len=150):
            skipped += 1
            continue
        url = SITE + rel[:-3] + ".html" if rel.endswith(".md") else SITE + rel
        chunks = chunk_text_structured(text, chunk_size=CHUNK_SIZE, overlap=0)
        if not chunks:
            skipped += 1
            continue
        existing_titles.add(canonical)
        for idx, chunk in enumerate(chunks):
            n = existing + len(new_docs)
            out = PROCESSED / f"wikigit_{n}.txt"
            out.write_text(
                f"Title: {canonical}\nURL: {url}\nSource: {SOURCE}\n"
                f"File: {rel}\nRepo: tianocore-wiki.github.io\n"
                f"Chunk: {idx + 1}/{len(chunks)}\n"
                f"Section: {chunk.get('section', '')}\n"
                f"Position: {chunk.get('position', '')}\n\n{chunk['text']}",
                encoding="utf-8")
            new_docs.append({
                "path": str(out), "source": SOURCE, "title": canonical,
                "url": url, "file": rel, "repo": "tianocore-wiki.github.io",
                "section": chunk.get("section", ""),
                "section_level": chunk.get("section_level", 0),
                "chunk_idx": idx, "total_chunks": len(chunks),
            })
        added += 1

    documents.extend(new_docs)
    with open(DOC_INDEX, "w", encoding="utf-8") as f:
        json.dump(documents, f, indent=2, ensure_ascii=False)
    print(f"added {added} pages -> {len(new_docs)} chunks "
          f"(skipped {skipped} already present/empty); total docs "
          f"{len(documents)}")
    return documents, existing


def build_fts(documents):
    print("Rebuilding FTS5 index...")
    FTS_DB.unlink(missing_ok=True)
    conn = sqlite3.connect(str(FTS_DB))
    conn.execute(FTS_SCHEMA)
    rows = []
    for i, doc in enumerate(documents):
        try:
            content = Path(doc["path"]).read_text(encoding="utf-8",
                                                  errors="ignore")
            body = content.split("\n\n", 1)[1] if "\n\n" in content else content
            if body.strip():
                rows.append((i, doc.get("source", "unknown"),
                             doc.get("title", ""), doc.get("url", ""),
                             doc.get("file", ""), doc.get("repo", ""),
                             doc.get("section", ""), body))
        except Exception:
            continue
    conn.execute("BEGIN")
    conn.executemany(
        "INSERT INTO docs (pid, source, title, url, file, repo, section, body) "
        "VALUES (?,?,?,?,?,?,?,?)", rows)
    conn.commit()
    conn.execute("INSERT INTO docs(docs) VALUES('optimize')")
    conn.commit()
    conn.close()
    print(f"FTS5 indexed {len(rows)} documents")


def embed_upsert(documents, existing, batch_size):
    import chromadb
    from chromadb.utils import embedding_functions
    device = os.environ.get("EDK2_EMBEDDING_DEVICE", "cpu")
    ef = embedding_functions.SentenceTransformerEmbeddingFunction(
        model_name=str(BGE_M3), device=device, normalize_embeddings=True,
        local_files_only=True)
    client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    collection = client.get_or_create_collection("edk2_docs",
                                                 embedding_function=ef)
    print(f"Existing chroma count: {collection.count()}")
    ids_existing = set(collection.get(include=[], limit=200000)["ids"])
    # Honour the dense-skip list used when the index was built (commits/PRs are
    # intentionally BM25-only), then embed any remaining document whose id is
    # missing. Scanning all documents makes --embed idempotent and safe to run
    # as a separate invocation from the chunk/FTS pass.
    skip = {s.strip().lower()
            for s in os.environ.get("EDK2_EMBEDDING_SKIP_SOURCES", "").split(",")
            if s.strip()}
    pending = [(i, d) for i, d in enumerate(documents)
               if f"doc_{i}" not in ids_existing
               and (d.get("source", "").lower() not in skip)]
    if skip:
        print(f"EDK2_EMBEDDING_SKIP_SOURCES={sorted(skip)} (excluded)")
    print(f"Docs to embed: {len(pending)}")
    t0 = time.time()
    done = 0
    for i in range(0, len(pending), batch_size):
        batch = pending[i:i + batch_size]
        texts, metas, ids = [], [], []
        for ti, doc in batch:
            try:
                texts.append(Path(doc["path"]).read_text(encoding="utf-8"))
            except Exception:
                continue
            ids.append(f"doc_{ti}")
            metas.append({k: doc.get(k, "") for k in
                          ("source", "title", "url", "file", "repo",
                           "section", "chunk_idx", "total_chunks")})
        if texts:
            collection.upsert(ids=ids, documents=texts, metadatas=metas)
            done += len(texts)
        if done % 500 < batch_size:
            el = time.time() - t0
            print(f"  {done}/{len(pending)} ({el:.0f}s, "
                  f"{done/el if el else 0:.1f}/s)")
    print(f"Embedded {done} chunks in {time.time()-t0:.0f}s; "
          f"chroma count now {collection.count()}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--embed", action="store_true")
    ap.add_argument("--skip-fts", action="store_true")
    ap.add_argument("--batch", type=int, default=50)
    args = ap.parse_args()
    documents, existing = process()
    if not args.skip_fts:
        build_fts(documents)
    if args.embed:
        embed_upsert(documents, existing, args.batch)
    else:
        print("SKIP --embed (run with --embed to upsert into ChromaDB)")


if __name__ == "__main__":
    main()
