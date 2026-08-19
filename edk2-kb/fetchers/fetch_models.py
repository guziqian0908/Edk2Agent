#!/usr/bin/env python3
"""Download the local models required by the EDK2 KB runtime.

The runtime loads models with local_files_only=True (fully offline), so the
files must exist on disk before the daemon starts. This script mirrors the
exact paths search_engine.py and rerank_server.py expect:

    ~/.edk2-opencode/models/bge-m3
    ~/.edk2-opencode/models/bge-reranker-v2-m3

Override the base directory with EDK2_MODELS_DIR. Re-running is a no-op when
the models are already present (use --force to redownload).

Usage:
    python fetchers/fetch_models.py
    python fetchers/fetch_models.py --force
"""

import argparse
import os
import sys
from pathlib import Path

MODELS_BASE = Path(os.environ.get(
    "EDK2_MODELS_DIR", str(Path.home() / ".edk2-opencode" / "models")))

REPOS = {
    "bge-m3": "BAAI/bge-m3",
    "bge-reranker-v2-m3": "BAAI/bge-reranker-v2-m3",
}


def ensure(repo_id, target, force):
    if target.exists() and not force:
        files = sum(1 for p in target.rglob("*") if p.is_file())
        print(f"[skip] {repo_id}: {files} files already present "
              f"at {target} (use --force to redownload)")
        return
    from huggingface_hub import snapshot_download
    print(f"[download] {repo_id} -> {target} ...")
    snapshot_download(repo_id=repo_id, local_dir=str(target))
    print(f"[ok] {repo_id} -> {target}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true",
                    help="redownload even if already present")
    args = ap.parse_args()

    MODELS_BASE.mkdir(parents=True, exist_ok=True)
    for name, repo_id in REPOS.items():
        try:
            ensure(repo_id, MODELS_BASE / name, args.force)
        except Exception as e:
            print(f"ERROR downloading {repo_id}: {e}", file=sys.stderr)
            sys.exit(1)
    print(f"Models ready under {MODELS_BASE}")


if __name__ == "__main__":
    main()