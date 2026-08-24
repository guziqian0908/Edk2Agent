#!/usr/bin/env python3
"""Add the EDK2 MdePkg source tree (excluding Library/) to the knowledge base.

Incremental add: existing documents are untouched. New MdePkg chunks are
appended to processed/*.txt and documents.json (their pids start after the
existing doc count), the FTS5 index is rebuilt in full (fast), and only the
new chunks are embedded and upserted into ChromaDB with the same local
bge-m3 embedding function the runtime SearchEngine uses.

Usage:
    python fetchers/add_mdepkg.py
    python fetchers/add_mdepkg.py --embed --batch 50

--embed runs the (slow) ChromaDB embedding+upsert phase; without it only the
text files, documents.json and the FTS5 index are updated.
"""

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

KB_DATA = Path(os.environ.get(
    "EDK2_KB_DATA", str(Path.home() / ".edk2-opencode" / "kb" / "data")))
SRC = KB_DATA / "edk2-mdepkg" / "MdePkg"
PROCESSED = KB_DATA / "processed"
FTS_DB = KB_DATA / "fts_index.db"
CHROMA_DIR = KB_DATA / "chroma_db"
BGE_M3 = Path(os.environ.get(
    "EDK2_MODELS_DIR",
    str(Path.home() / ".edk2-opencode" / "models"))) / "bge-m3"

DOC_INDEX = PROCESSED / "documents.json"
SOURCE = "edk2-mdepkg"
REPO = "tianocore/edk2"
REPO_URL = "https://github.com/tianocore/edk2"

EXTS = {".c", ".h", ".inf", ".dec", ".dsc", ".uni", ".inc",
        ".asl", ".asm", ".nasm", ".vfr", ".fdf", ".yaml", ".s"}

CHUNK_SIZE = 800
OVERLAP = 100
MIN_CHUNK_SIZE = 200


def chunk_text(text, chunk_size=CHUNK_SIZE, overlap=OVERLAP):
    if len(text) <= chunk_size:
        return [{"text": text, "position": f"0-{len(text)}"}]
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + chunk_size, len(text))
        if end < len(text):
            search_start = max(start, end - 150)
            last_period = text.rfind(".", search_start, end)
            last_newline = text.rfind("\n", search_start, end)
            break_point = max(last_period, last_newline)
            if break_point > start + MIN_CHUNK_SIZE:
                end = break_point + 1
        chunk_content = text[start:end].strip()
        if len(chunk_content) >= MIN_CHUNK_SIZE:
            chunks.append({"text": chunk_content,
                           "position": f"{start}-{end}"})
        next_start = end - overlap
        if next_start <= start:
            next_start = start + chunk_size
        start = next_start
    return chunks if chunks else [{"text": text, "position": f"0-{len(text)}"}]


def run(cmd, cwd=None):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                       errors="replace")
    if r.returncode != 0:
        raise RuntimeError(f"command failed: {' '.join(cmd)}\n"
                          f"{r.stderr[-2000:]}")
    return r


def ensure_src():
    """Sparse-clone the MdePkg subtree from tianocore/edk2 if missing."""
    if SRC.exists():
        return
    clone = KB_DATA / "edk2-mdepkg"
    print(f"MdePkg source not found at {SRC} - "
          f"sparse-cloning {REPO_URL} ...")
    clone.mkdir(parents=True, exist_ok=True)
    try:
        if not (clone / ".git").exists():
            run(["git", "init"], cwd=clone)
            run(["git", "remote", "add", "origin", REPO_URL], cwd=clone)
            run(["git", "fetch", "--depth", "1",
                 "--filter=blob:none", "origin", "master"], cwd=clone)
        if not (clone / ".git" / "info" / "sparse-checkout").exists():
            run(["git", "sparse-checkout", "init", "--cone"], cwd=clone)
        run(["git", "sparse-checkout", "set", "MdePkg"], cwd=clone)
        run(["git", "checkout", "FETCH_HEAD"], cwd=clone)
    except RuntimeError as e:
        print(f"ERROR: sparse clone failed: {e}", file=sys.stderr)
        sys.exit(1)
    if not SRC.exists():
        print(f"ERROR: {SRC} still missing after clone", file=sys.stderr)
        sys.exit(1)
    print(f"[ok] MdePkg source ready at {SRC}")


def process():
    ensure_src()

    with open(DOC_INDEX, "r", encoding="utf-8") as f:
        documents = json.load(f)

    existing = len(documents)

    mdepkg_count = sum(1 for doc in documents
                       if doc.get("source") == SOURCE)
    if mdepkg_count:
        print(f"MdePkg already processed ({existing} docs total, "
              f"{mdepkg_count} mdepkg) - skipping chunking")
        return documents, existing - mdepkg_count
    files = [p for p in SRC.rglob("*")
             if p.is_file() and p.suffix.lower() in EXTS
             and "Library" not in p.relative_to(SRC).parts]

    print(f"Existing documents: {existing}")
    print(f"Files to process (excl Library): {len(files)}")

    new_docs = []
    processed_files = 0
    t0 = time.time()
    for p in sorted(files):
        rel = p.relative_to(SRC).as_posix()
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except Exception as e:
            print(f"  skip {rel}: {e}")
            continue
        if len(text) <= 100:
            continue
        chunks = chunk_text(text)
        url = f"{REPO_URL}/blob/master/{rel}"
        for idx, chunk in enumerate(chunks):
            n = len(documents) + len(new_docs)
            doc_file = PROCESSED / f"mdepkg_{n}.txt"
            doc_file.write_text(
                f"File: {rel}\n"
                f"Repo: {REPO}\n"
                f"Source: {SOURCE}\n"
                f"Title: {rel}\n"
                f"URL: {url}\n"
                f"Chunk: {idx + 1}/{len(chunks)}\n"
                f"Section: \n"
                f"Position: {chunk.get('position', '')}\n\n"
                f"{chunk['text']}",
                encoding="utf-8")
            new_docs.append({
                "path": str(doc_file),
                "source": SOURCE,
                "title": rel,
                "url": url,
                "file": rel,
                "repo": REPO,
                "section": "",
                "chunk_idx": idx,
                "total_chunks": len(chunks),
            })
        processed_files += 1
        if processed_files % 100 == 0:
            print(f"  {processed_files} files, {len(new_docs)} chunks "
                  f"({time.time() - t0:.0f}s)")

    documents.extend(new_docs)
    with open(DOC_INDEX, "w", encoding="utf-8") as f:
        json.dump(documents, f, indent=2, ensure_ascii=False)

    print(f"Processed {processed_files} files -> {len(new_docs)} new chunks "
          f"({time.time() - t0:.0f}s)")
    return documents, existing


FTS_SCHEMA = """
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


def build_fts(documents):
    print("Rebuilding FTS5 index...")
    try:
        FTS_DB.unlink()
    except FileNotFoundError:
        pass
    conn = sqlite3.connect(str(FTS_DB))
    conn.execute(FTS_SCHEMA)
    rows = []
    for i, doc in enumerate(documents):
        try:
            with open(doc["path"], "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
            body = content.split("\n\n", 1)[1] if "\n\n" in content else content
            if not body.strip():
                continue
            rows.append((i, doc.get("source", "unknown"),
                         doc.get("title", ""), doc.get("url", ""),
                         doc.get("file", ""), doc.get("repo", ""),
                         doc.get("section", ""), body))
        except Exception:
            continue
    conn.execute("BEGIN")
    conn.executemany(
        "INSERT INTO docs (pid, source, title, url, file, repo, section, body) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)
    conn.commit()
    conn.execute("INSERT INTO docs(docs) VALUES('optimize')")
    conn.commit()
    conn.close()
    print(f"FTS5 indexed {len(rows)} documents")


def embed_upsert(documents, existing, batch_size):
    print("Embedding new MdePkg chunks with bge-m3...")
    import chromadb
    from chromadb.utils import embedding_functions

    device = os.environ.get("EDK2_EMBEDDING_DEVICE", "cpu")
    ef = embedding_functions.SentenceTransformerEmbeddingFunction(
        model_name=str(BGE_M3), device=device,
        normalize_embeddings=True, local_files_only=True)
    client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    collection = client.get_or_create_collection(
        "edk2_docs", embedding_function=ef)
    old_count = collection.count()
    print(f"Existing chroma count: {old_count}")

    existing_ids = set(collection.get(
        include=[], limit=200000)["ids"])
    print(f"Existing chroma ids: {len(existing_ids)}")

    new_docs = documents[existing:]
    pending = [(existing + idx, doc) for idx, doc in enumerate(new_docs)
               if f"doc_{existing + idx}" not in existing_ids]
    print(f"Docs to embed: {len(pending)} (resumed)")
    t0 = time.time()
    done = 0
    for i in range(0, len(pending), batch_size):
        batch = pending[i:i + batch_size]
        texts, metas, ids = [], [], []
        for true_idx, doc in batch:
            try:
                with open(doc["path"], "r", encoding="utf-8") as f:
                    body = f.read()
                texts.append(body)
                ids.append(f"doc_{true_idx}")
                metas.append({
                    "source": doc.get("source", SOURCE),
                    "title": doc.get("title", ""),
                    "url": doc.get("url", ""),
                    "file": doc.get("file", ""),
                    "repo": doc.get("repo", ""),
                    "section": doc.get("section", ""),
                    "chunk_idx": doc.get("chunk_idx", 0),
                    "total_chunks": doc.get("total_chunks", 1),
                })
            except Exception:
                continue
        if texts:
            collection.upsert(ids=ids, documents=texts, metadatas=metas)
            done += len(texts)
        if done % 500 < batch_size:
            elapsed = time.time() - t0
            rate = done / elapsed if elapsed else 0
            print(f"  {done}/{len(pending)} chunks ({elapsed:.0f}s, "
                  f"{rate:.1f}/s)")

    new_count = collection.count()
    print(f"Embedded {done} chunks in {time.time() - t0:.0f}s")
    print(f"Chroma count now: {new_count} (was {old_count})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--embed", action="store_true")
    ap.add_argument("--skip-fts", action="store_true",
                    help="Skip the FTS5 rebuild (e.g. daemon holds the DB)")
    ap.add_argument("--batch", type=int, default=50)
    args = ap.parse_args()

    documents, existing = process()
    if not args.skip_fts:
        build_fts(documents)
    if args.embed:
        embed_upsert(documents, existing, args.batch)
    else:
        print("SKIP --embed phase (run with --embed to upsert into ChromaDB)")


if __name__ == "__main__":
    main()
