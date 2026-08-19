#!/usr/bin/env python3
"""Fetch the full tianocore/edk2 commit history into
`<DATA_DIR>/edk2-commits/commits.txt`.

Uses a blobless clone (--filter=blob:none --no-checkout) so the whole history
from 2006 to today downloads without the source blobs. commits.txt is then
regenerated from `git log --all` in exactly the format init_kb.py parses
(COMMIT:/AUTHOR:/DATE:/SUBJECT:/BODY: blocks separated by ---END-COMMIT---).

First run downloads a few hundred MB and takes minutes; re-runs only fetch new
objects and regenerate the text file. Use --depth for a quick shallow test.

Usage:
    python fetchers/fetch_commits.py
    python fetchers/fetch_commits.py --depth 1000
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
KB_DATA = Path(os.environ.get("EDK2_KB_DATA", str(BASE_DIR / "data")))

REPO_URL = "https://github.com/tianocore/edk2"
LOG_FORMAT = ("COMMIT: %H%nAUTHOR: %an <%ae>%nDATE: %aI%nSUBJECT: %s%n"
              "BODY:%n%b%n---END-COMMIT---%n")


def run(cmd, cwd=None):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                       errors="replace")
    if r.returncode != 0:
        raise RuntimeError(f"command failed: {' '.join(cmd)}\n"
                          f"{r.stderr[-4000:]}")
    return r


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repo-dir", default=None,
                    help="where to keep the edk2 clone "
                         "(default: <DATA_DIR>/edk2-commits/edk2)")
    ap.add_argument("--out", default=None,
                    help="output commits.txt path (default: "
                         "<DATA_DIR>/edk2-commits/commits.txt)")
    ap.add_argument("--depth", type=int, default=None,
                    help="shallow history depth (full history by default)")
    ap.add_argument("--no-clone", action="store_true",
                    help="only regenerate commits.txt from an existing clone")
    ap.add_argument("--ref", default="--all",
                    help="git log revision range (default: --all)")
    args = ap.parse_args()

    target = Path(args.repo_dir) if args.repo_dir \
        else KB_DATA / "edk2-commits" / "edk2"
    out = Path(args.out) if args.out \
        else KB_DATA / "edk2-commits" / "commits.txt"
    out.parent.mkdir(parents=True, exist_ok=True)

    if not target.exists():
        if args.no_clone:
            sys.exit(f"ERROR: --no-clone but clone dir not found: {target}")
        clone_cmd = ["git", "clone", "--filter=blob:none", "--no-checkout",
                     REPO_URL, str(target)]
        if args.depth:
            clone_cmd.insert(1, "--depth")
            clone_cmd.insert(2, str(args.depth))
        print(f"[clone] {REPO_URL} (blobless) -> {target}")
        run(clone_cmd)
    else:
        if not args.no_clone:
            print("[fetch] updating existing clone")
            run(["git", "fetch", "--all", "--prune"], cwd=target)

    print(f"[log] writing {out}")
    r = run(["git", "log", args.ref, f"--format={LOG_FORMAT}"], cwd=target)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(r.stdout)
    n = len(r.stdout.split("---END-COMMIT---")) - 1
    print(f"[ok] {n} commits written -> {out} "
          f"({out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()