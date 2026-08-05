#!/usr/bin/env python
"""Compare one query under the old vs current retrieval pipeline.

Shows, side by side, how a single question was answered before reranking
(6.0.11 and earlier: hybrid vector+BM25, no reranker, no confidence) and how
it is answered today (hybrid + cross-encoder rerank + confidence labels).
This makes the accuracy difference of a single answer visible.

For queries that exist in the eval set, also prints where the expected
document landed in each version.

Run:
    python edk2-kb/eval/compare_query.py --query "PcdDebugPrintErrorLevel"
    python edk2-kb/eval/compare_query.py \
        --query "UEFI boot flow PEI DXE" --query "SetVariable attributes NV"
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from search_engine import SearchEngine  # noqa: E402

EVAL_FILE = Path(__file__).resolve().parent / "edk2_eval_set.json"
TOP_K = 5


def ident(r):
    return r.get("title") or r.get("file") or "?"


def short(i, r):
    s = r.get("rerank_score")
    tag = f"rr={s:.2f} {r.get('confidence')}" if s is not None else \
          f"score={r.get('score', 0):.2f} (unrated)"
    sec = f"  [{r.get('section')}]" if r.get("section") else ""
    return f"  #{i} {tag:<22} {ident(r)}{sec}"


def hit_rank(results, expected_set):
    for i, r in enumerate(results):
        if (r.get("source"), r.get("file") or r.get("title")) in expected_set:
            return i + 1
    return None


def find_expected(entries, query):
    q = query.strip().lower()
    for e in entries:
        if e["query"].strip().lower() == q:
            return {(x["source"], x["file_or_title"]) for x in e["expected"]}
    for e in entries:
        if e["query"].strip().lower() in q or q in e["query"].strip().lower():
            return {(x["source"], x["file_or_title"]) for x in e["expected"]}
    return None


def show_diff(old, new):
    old_pos = {}
    for i, r in enumerate(old):
        old_pos.setdefault(ident(r), i + 1)
    new_pos = {}
    for i, r in enumerate(new):
        new_pos.setdefault(ident(r), i + 1)

    print("  --- ranking changes (old -> new) ---")
    for i, r in enumerate(new):
        prev = old_pos.get(ident(r))
        if prev is None:
            print(f"    #{i+1} NEW          {ident(r)[:70]}")
        elif prev == i + 1:
            print(f"    #{i+1} KEPT (was #{prev}) {ident(r)[:60]}")
        elif prev > i + 1:
            print(f"    #{i+1} UP from #{prev}   {ident(r)[:60]}")
        else:
            print(f"    #{i+1} DOWN from #{prev} {ident(r)[:60]}")
    for i, r in enumerate(old):
        if ident(r) not in new_pos:
            print(f"    REMOVED      {ident(r)[:70]}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", action="append", required=True)
    ap.add_argument("--data-dir", default=None)
    ap.add_argument("--top-k", type=int, default=TOP_K)
    ap.add_argument("--eval-file", default=str(EVAL_FILE))
    args = ap.parse_args()

    entries = json.loads(Path(args.eval_file).read_text(encoding="utf-8"))
    engine = SearchEngine(
        data_dir=Path(args.data_dir) if args.data_dir else None,
        preload=True)
    engine.ensure_ready(timeout=300)

    for q in args.query:
        old = engine.search(q, args.top_k, None, rerank=False)
        new = engine.search(q, args.top_k, None, rerank=True)
        expected = find_expected(entries, q)

        print("=" * 76)
        print(f"QUERY: {q}")
        if expected:
            exp_docs = [f[1].split("\\")[-1] for f in expected]
            print("  expected:", "; ".join(exp_docs))
        print()

        print(f"OLD  (hybrid, no rerank, <=6.0.11)  top{args.top_k}")
        for i, r in enumerate(old):
            print(short(i + 1, r))
        h = hit_rank(old, expected) if expected else None
        if h:
            print(f"  >> expected doc at rank {h}")
        elif expected:
            print("  >> expected doc MISSED")

        print()
        print(f"NOW  (hybrid + rerank, current)  top{args.top_k}")
        for i, r in enumerate(new):
            print(short(i + 1, r))
        h = hit_rank(new, expected) if expected else None
        if h:
            print(f"  >> expected doc at rank {h}")
        elif expected:
            print("  >> expected doc MISSED")

        print()
        show_diff(old, new)
        print()


if __name__ == "__main__":
    main()
