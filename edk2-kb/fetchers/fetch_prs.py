#!/usr/bin/env python3
"""Fetch all pull requests of tianocore/edk2 into
`<DATA_DIR>/edk2-prs/prs.jsonl`.

Uses the GitHub REST API (public repo, so no auth is required; setting
GITHUB_TOKEN raises the rate limit from 60 to 5000 requests/hour). Fields are
written flattened exactly as init_kb.py parses them: `user`, `base` and `head`
become plain strings (login / branch ref).

Resumable: PR numbers already present in the file are skipped, so an
interrupted run can simply be restarted. Use --limit-pages to only fetch the
first N pages (e.g. a quick connectivity test).

Usage:
    python fetchers/fetch_prs.py
    GITHUB_TOKEN=... python fetchers/fetch_prs.py
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
KB_DATA = Path(os.environ.get("EDK2_KB_DATA", str(BASE_DIR / "data")))
OUT = KB_DATA / "edk2-prs" / "prs.jsonl"

API = "https://api.github.com/repos/tianocore/edk2/pulls"
PER_PAGE = 100


def api_get(url):
    req = urllib.request.Request(url)
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "edk2-opencode-fetch-prs")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        if e.code == 403:
            reset = int(e.headers.get("X-RateLimit-Reset", 0) or 0)
            wait = max(reset - time.time(), 0) + 5
            print(f"[rate-limit] sleeping {wait:.0f}s until reset",
                  file=sys.stderr)
            time.sleep(wait)
            return api_get(url)
        raise


def flatten(pr):
    return {
        "number": pr.get("number"),
        "title": pr.get("title"),
        "state": pr.get("state"),
        "html_url": pr.get("html_url"),
        "created_at": pr.get("created_at"),
        "closed_at": pr.get("closed_at"),
        "merged_at": pr.get("merged_at"),
        "user": (pr.get("user") or {}).get("login", ""),
        "base": (pr.get("base") or {}).get("ref", ""),
        "head": (pr.get("head") or {}).get("ref", ""),
        "body": pr.get("body") or "",
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit-pages", type=int, default=0,
                    help="stop after N pages (default: all)")
    ap.add_argument("--per-page", type=int, default=PER_PAGE)
    args = ap.parse_args()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    seen = set()
    if OUT.exists():
        for line in OUT.read_text(encoding="utf-8",
                                  errors="ignore").splitlines():
            try:
                seen.add(json.loads(line).get("number"))
            except Exception:
                pass
        print(f"Resuming: {len(seen)} PRs already in {OUT}")

    mode = "a" if seen else "w"
    page, written, empty = 1, 0, 0
    with open(OUT, mode, encoding="utf-8") as f:
        while True:
            if args.limit_pages and page > args.limit_pages:
                break
            data = api_get(f"{API}?state=all&per_page={args.per_page}"
                           f"&page={page}")
            if not data:
                empty += 1
                if empty >= 2:
                    break
                page += 1
                continue
            empty = 0
            for pr in data:
                n = pr.get("number")
                if n in seen:
                    continue
                seen.add(n)
                f.write(json.dumps(flatten(pr), ensure_ascii=False) + "\n")
                written += 1
            print(f"  page {page}: fetched {len(data)}, {written} new total")
            page += 1
            if len(data) < args.per_page:
                break
            time.sleep(0.5)
    print(f"[ok] {written} new PRs written -> {OUT}")


if __name__ == "__main__":
    main()