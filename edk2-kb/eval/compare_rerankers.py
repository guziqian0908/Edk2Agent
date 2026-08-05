#!/usr/bin/env python
"""Compare rerankers on the manual eval set and append results to RESULTS.md.

Runs hybrid (no rerank) + hybrid+rerank per reranker, plus a Chinese/English
sub-breakdown, then appends a ``## Reranker comparison`` section to
RESULTS.md (run_eval.py preserves that section across re-runs).

Run:
    python edk2-kb/eval/compare_rerankers.py --data-dir <kb>/data
"""
import argparse
import json
import os
import statistics
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
EVAL_FILE = HERE / "edk2_eval_set.json"
REPORT_FILE = HERE / "RESULTS.md"


def _default_bge_path() -> str:
    local = Path.home() / ".edk2-opencode" / "models" / "bge-reranker-v2-m3"
    return str(local) if local.exists() else "BAAI/bge-reranker-v2-m3"


MODELS = [
    "cross-encoder/ms-marco-MiniLM-L-6-v2",
    _default_bge_path(),
]
BGE_MODEL = MODELS[1]


def doc_key(r):
    return (r.get("source"), r.get("file") or r.get("title"))


def hit_rank(ranked, expected_set):
    for i, r in enumerate(ranked):
        if doc_key(r) in expected_set:
            return i + 1
    return None


def is_chinese(q):
    return any("\u4e00" <= c <= "\u9fff" for c in q)


def run_one(args) -> None:
    from search_engine import SearchEngine, RERANKER_MODEL

    engine = SearchEngine(data_dir=Path(args.data_dir), preload=True)
    engine.ensure_ready(timeout=300)
    entries = json.loads(EVAL_FILE.read_text(encoding="utf-8"))
    man = [e for e in entries if e.get("kind") == "manual"]

    agg = {"hybrid": {"hit5": [], "mrr": []}, "rerank": {"hit5": [], "mrr": []}}
    zh_hit = []
    en_hit = []
    for e in man:
        expected = {(x["source"], x["file_or_title"]) for x in e["expected"]}
        hybrid_rank = hit_rank(
            engine.search(e["query"], 10, None, rerank=False), expected)
        rerank_rank = hit_rank(
            engine.search(e["query"], 10, None, rerank=True), expected)
        agg["hybrid"]["hit5"].append(hybrid_rank is not None and hybrid_rank <= 5)
        agg["hybrid"]["mrr"].append(1.0 / hybrid_rank if hybrid_rank else 0.0)
        agg["rerank"]["hit5"].append(rerank_rank is not None and rerank_rank <= 5)
        agg["rerank"]["mrr"].append(1.0 / rerank_rank if rerank_rank else 0.0)
        hit = rerank_rank is not None and rerank_rank <= 5
        (zh_hit if is_chinese(e["query"]) else en_hit).append(hit)

    def m(bucket, key):
        return round(100.0 * statistics.mean(agg[bucket][key]), 1)

    print(json.dumps({
        "model": RERANKER_MODEL,
        "hybrid_hit5": m("hybrid", "hit5"),
        "hybrid_mrr": round(statistics.mean(agg["hybrid"]["mrr"]), 3),
        "rerank_hit5": m("rerank", "hit5"),
        "rerank_mrr": round(statistics.mean(agg["rerank"]["mrr"]), 3),
        "zh_n": len(zh_hit),
        "zh_hit5": round(100.0 * statistics.mean(zh_hit), 1) if zh_hit else 0.0,
        "en_n": len(en_hit),
        "en_hit5": round(100.0 * statistics.mean(en_hit), 1) if en_hit else 0.0,
    }))


def measure(model: str, data_dir: str):
    env = dict(os.environ, EDK2_RERANKER_MODEL=model)
    out = subprocess.run(
        [sys.executable, str(HERE / "compare_rerankers.py"),
         "--measure-only", "--model", model, "--data-dir", data_dir],
        env=env, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=None)
    ap.add_argument("--measure-only", action="store_true")
    ap.add_argument("--model", default=None)
    args = ap.parse_args()

    if args.measure_only:
        run_one(args)
        return

    results = [measure(m, args.data_dir) for m in MODELS]
    rerank = {r["model"]: r for r in results}
    no = results[0]

    lines = [
        "## Reranker comparison",
        "",
        "Manual set ({} labeled), hit@5 / MRR@10 for hybrid and hybrid+rerank:"
        .format(no["en_n"] + no["zh_n"]),
        "",
        "| reranker | hybrid hit@5 | hybrid MRR | +rerank hit@5 | +rerank MRR |",
        "|---|---|---|---|---|",
        "| (no rerank) | {h}% | {m} | -- | -- |"
        .format(h=no["hybrid_hit5"], m=no["hybrid_mrr"]),
    ]
    for model in MODELS:
        r = rerank[model]
        name = "ms-marco-MiniLM-L-6-v2" if "ms-marco" in model else \
            "**bge-reranker-v2-m3**"
        lines.append(
            "| {name} | {h}% | {hm} | {rh}% | {rm} |"
            .format(name=name, h=r["hybrid_hit5"], hm=r["hybrid_mrr"],
                    rh=r["rerank_hit5"], rm=r["rerank_mrr"]))
    b = rerank[BGE_MODEL]
    m = rerank[MODELS[0]]
    lines += [
        "",
        "Chinese subset ({} queries, top-10 pool): rerank hit@5 {}% "
        "(bge-v2-m3) vs {}% (ms-marco). English-only subset: {}% (bge) vs "
        "{}% (ms-marco)."
        .format(b["zh_n"], b["zh_hit5"], m["zh_hit5"],
                b["en_hit5"], m["en_hit5"]),
        "",
        "bge-v2-m3 is the default because its sigmoid scores map faithfully "
        "to confidence on non-English queries (a correct Chinese doc scores "
        "`high` under bge vs `low` under ms-marco), which is what the LLM "
        "relies on to decide how firmly to assert.",
        "",
        "These numbers assume the bge-m3 embedder (see the Embedder "
        "comparison section). With the old English-only all-MiniLM-L6-v2 "
        "embedder, Chinese recall is much lower because the correct doc "
        "often never enters the rerank pool.",
    ]

    section = "\n".join(lines) + "\n"
    marker = "## Reranker comparison"
    if REPORT_FILE.exists() and marker in REPORT_FILE.read_text(encoding="utf-8"):
        text = REPORT_FILE.read_text(encoding="utf-8")
        REPORT_FILE.write_text(text[:text.index(marker)] + section,
                               encoding="utf-8")
    else:
        with REPORT_FILE.open("a", encoding="utf-8") as fh:
            fh.write("\n" + section)
    print(section)


if __name__ == "__main__":
    main()
