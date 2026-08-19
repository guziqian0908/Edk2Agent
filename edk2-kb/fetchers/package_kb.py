#!/usr/bin/env python3
"""Package the built EDK2 knowledge base for distribution.

Runtime package (default) contains only what the daemon needs to serve
queries, extracted into `<kb dir>/data/`:

    chroma_db/           vector index (~1.9 GB)
    fts_index.db         FTS5 index
    processed/           chunk text files + documents.json

--with-sources additionally bundles the raw source trees (wiki, docs repos,
specs, commits, prs, mdepkg) so a recipient can run incremental rebuilds.

GitHub allows at most 2 GB per release asset, so the tar.gz is split into
parts of at most PART_SIZE bytes and a JSON manifest with per-part SHA-256 is
written next to them. Recipients install with install_kb.ps1 / install_kb.sh.

Usage:
    python package_kb.py                       # runtime package
    python package_kb.py --with-sources        # include raw sources
    python package_kb.py --out out_dir
"""

import argparse
import hashlib
import json
import os
import sys
import tarfile
import time
from pathlib import Path

DEFAULT_KB_DATA = str(Path.home() / ".edk2-opencode" / "kb" / "data")
PART_SIZE = 1_800_000_000  # 1.8 GB < GitHub's 2 GB asset limit

RUNTIME_DIRS = ["chroma_db", "processed"]
RUNTIME_FILES = ["fts_index.db"]
SOURCE_DIRS = ["uefi-specs", "tianocore-wiki", "tianocore-docs",
               "edk2-commits", "edk2-prs", "edk2-mdepkg"]


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build_file_list(kb_data, with_sources):
    entries = []
    for name in RUNTIME_DIRS:
        p = kb_data / name
        if p.is_dir():
            entries.append(p)
    for name in RUNTIME_FILES:
        p = kb_data / name
        if p.is_file():
            entries.append(p)
    if with_sources:
        for name in SOURCE_DIRS:
            p = kb_data / name
            if p.exists():
                entries.append(p)
    if not entries:
        sys.exit(f"ERROR: nothing to package under {kb_data}")
    return entries


def make_tar(kb_data, entries, archive, name):
    total_files = 0
    for e in entries:
        total_files += (sum(1 for _ in e.rglob("*")) if e.is_dir() else 1)
    done = 0
    t0 = time.time()
    with tarfile.open(archive, "w:gz", compresslevel=6) as tar:
        for e in entries:
            arcname = str(Path("data") / e.name)
            tar.add(e, arcname=arcname, recursive=True,
                    filter=lambda m: m)  # keep full data; no filtering
            if e.is_dir():
                done += sum(1 for _ in e.rglob("*"))
            else:
                done += 1
            pct = done / total_files * 100
            print(f"\r  {done}/{total_files} files ({pct:.0f}%) "
                  f"{time.time() - t0:.0f}s", end="", flush=True)
    print()
    return archive


def split_parts(archive, out, prefix, part_size):
    parts = []
    idx = 1
    with open(archive, "rb") as src:
        while True:
            chunk = src.read(part_size)
            if not chunk:
                break
            part_file = out / f"{prefix}.tar.gz.part-{idx:02d}"
            part_file.write_bytes(chunk)
            parts.append({
                "file": part_file.name,
                "sha256": hashlib.sha256(chunk).hexdigest(),
            })
            idx += 1
    return parts


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--kb-data", default=os.environ.get("EDK2_KB_DATA",
                                                        DEFAULT_KB_DATA),
                    help="KB data dir to package")
    ap.add_argument("--out", default=str(Path.home() / ".edk2-opencode" /
                                         "releases"),
                    help="where to write the package (default: "
                         "~/.edk2-opencode/releases)")
    ap.add_argument("--with-sources", action="store_true",
                    help="include raw source trees (bigger package)")
    ap.add_argument("--part-size", type=int, default=PART_SIZE)
    ap.add_argument("--keep-full", action="store_true",
                    help="keep the unsplit tar.gz after splitting")
    args = ap.parse_args()

    kb_data = Path(args.kb_data)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    prefix = "kb-full" if args.with_sources else "kb-runtime"

    print(f"Packaging {kb_data} -> {out}/{prefix}.tar.gz")
    entries = build_file_list(kb_data, args.with_sources)
    for e in entries:
        sz = sum(f.stat().st_size for f in e.rglob("*")) if e.is_dir() \
            else e.stat().st_size
        print(f"  {e.name}: {sz / 1e6:.1f} MB")

    archive = out / f"{prefix}.tar.gz"
    if archive.exists():
        archive.unlink()
    make_tar(kb_data, entries, archive, prefix)

    parts = split_parts(archive, out, prefix, args.part_size)
    total = archive.stat().st_size
    print(f"tar.gz: {total / 1e9:.2f} GB -> {len(parts)} part(s)")

    doc_count = 0
    dj = kb_data / "processed" / "documents.json"
    if dj.exists():
        try:
            with open(dj, encoding="utf-8-sig") as f:
                doc_count = len(json.load(f))
        except Exception:
            doc_count = -1

    manifest = {
        "package": prefix,
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "archive_name": f"{prefix}.tar.gz",
        "total_bytes": total,
        "total_sha256": sha256_file(archive),
        "doc_count": doc_count,
        "parts": parts,
    }
    (out / f"{prefix}.manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")

    if not args.keep_full:
        archive.unlink()
        print("(removed unsplit tar.gz; use --keep-full to retain)")

    print(f"\nManifest: {out / (prefix + '.manifest.json')}")
    print("Publish with something like:")
    print(f"  gh release create {prefix} {out / (prefix + '.*')} --title "
          f"'KB {prefix} package' --notes 'doc_count={doc_count}'")


if __name__ == "__main__":
    main()