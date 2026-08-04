#!/usr/bin/env python
"""Evaluate EDK2 KB retrieval accuracy across 4 retrieval baselines.

Baselines compared (top_k=10 per query):
    vector         - ChromaDB dense vector search only
    bm25           - SQLite FTS5 BM25 keyword search only
    hybrid         - vector + bm25 fused with RRF (no reranker)
    hybrid+rerank  - hybrid fused then reordered by the cross-encoder
                     reranker (this is what search_kb() does today)

Metrics reported per baseline and per subset (auto / manual):
    hit@5  - fraction of queries whose expected doc is in the top 5
    MRR@10 - mean reciprocal rank over the top 10 (0 if missed)

Also writes an ``RESULTS.md`` comparison report next to this script and
prints a few per-query examples where the reranker changed the ranking.

Run:
    python edk2-kb/eval/run_eval.py --data-dir <kb>/data [--top-k 10]
"""
import argparse
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from search_engine import SearchEngine  # noqa: E402

EVAL_FILE = Path(__file__).resolve().parent / "edk2_eval_set.json"
REPORT_FILE = Path(__file__).resolve().parent / "RESULTS.md"

BASELINES = ["vector", "bm25", "hybrid", "hybrid+rerank"]


def doc_key(r):
    return (r.get("source"), r.get("file") or r.get("title"))


def hit_rank(ranked, expected_set):
    for i, r in enumerate(ranked):
        if doc_key(r) in expected_set:
            return i + 1
    return None


def run_entry(engine, entry, top_k):
    expected = {(e["source"], e["file_or_title"])
                for e in entry["expected"]}
    q = entry["query"]
    out = {"expected": expected}
    out["vector"] = engine._search_chroma(q, top_k, None)
    out["bm25"] = engine._search_bm25(q, top_k, None)
    out["hybrid"] = engine.search(q, top_k, None, rerank=False)
    out["hybrid+rerank"] = engine.search(q, top_k, None, rerank=True)
    return out


def summarize(results, top_k):
    agg = {b: {"hit5": [], "mrr": []} for b in BASELINES}
    for r in results:
        for b in BASELINES:
            rank = hit_rank(r[b], r["expected"])
            agg[b]["hit5"].append(rank is not None and rank <= 5)
            agg[b]["mrr"].append(1.0 / rank if rank else 0.0)
    return {
        b: {
            "hit5": round(100.0 * statistics.mean(agg[b]["hit5"]), 1),
            "mrr": round(statistics.mean(agg[b]["mrr"]), 3),
        }
        for b in BASELINES
    }


def fmt(metrics, b):
    m = metrics[b]
    return f"{m['hit5']:>5.1f}%   {m['mrr']:.3f}"


def markdown_table(metrics):
    lines = ["| baseline | hit@5 | MRR@10 |",
             "|---|---|---|"]
    for b in BASELINES:
        m = metrics[b]
        lines.append(f"| {b} | {m['hit5']}% | {m['mrr']} |")
    return "\n".join(lines)


def rerank_examples(entries, results, n=5):
    """Find manual queries where reranking improved the hit rank."""
    shown = 0
    for entry, r in zip(entries, results):
        if not entry["query"]:
            continue
        h = hit_rank(r["hybrid"], r["expected"])
        hr = hit_rank(r["hybrid+rerank"], r["expected"])
        if hr is not None and (h is None or hr < h):
            print(f"  IMPROVED: '{entry['query'][:60]}'")
            print(f"    hybrid rank={h}  hybrid+rerank rank={hr}")
            for i, res in enumerate(r["hybrid+rerank"][:3]):
                print(f"      [{i+1}] {res.get('title') or res.get('file') or '?'}")
            shown += 1
            if shown >= n:
                return


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=None,
                    help="KB data dir (default: engine default)")
    ap.add_argument("--top-k", type=int, default=10)
    ap.add_argument("--eval-file", default=str(EVAL_FILE))
    args = ap.parse_args()

    entries = json.loads(Path(args.eval_file).read_text(encoding="utf-8"))
    print(f"evaluating {len(entries)} queries (top_k={args.top_k}) ...")

    engine = SearchEngine(
        data_dir=Path(args.data_dir) if args.data_dir else None,
        preload=True)
    engine.ensure_ready(timeout=300)

    results = [run_entry(engine, e, args.top_k) for e in entries]

    all_m = summarize(results, args.top_k)
    auto_m = summarize(results[:len(results) - 20], args.top_k)
    manual_m = summarize(results[-20:], args.top_k)

    print()
    print("=" * 58)
    print("ALL 220 queries")
    print("=" * 58)
    for b in BASELINES:
        print(f"  {b:<14} hit@5 {fmt(all_m, b)}")
    print()
    print("MANUAL 20 labeled questions")
    print("=" * 58)
    for b in BASELINES:
        print(f"  {b:<14} hit@5 {fmt(manual_m, b)}")
    print()
    print("AUTO 200 title questions")
    print("=" * 58)
    for b in BASELINES:
        print(f"  {b:<14} hit@5 {fmt(auto_m, b)}")
    print()
    print("Where the reranker improved over hybrid:")
    rerank_examples(entries, results)

    report = (
        "# EDK2 KB Retrieval Evaluation\n\n"
        f"Date: 2026-08-04  Queries: {len(entries)}  top_k: {args.top_k}\n\n"
        "## All queries\n\n" + markdown_table(all_m) +
        "\n\n## Manual labeled questions\n\n" + markdown_table(manual_m) +
        "\n\n## Auto title questions\n\n" + markdown_table(auto_m) +
        "\n"
    )
    REPORT_FILE.write_text(report, encoding="utf-8")
    print()
    print("report written to", REPORT_FILE)


if __name__ == "__main__":
    main()
