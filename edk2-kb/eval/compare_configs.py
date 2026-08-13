#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Compare retrieval configs on the 25-question eval set (offline).

Loads the live data dir directly (no daemon needed), runs each query under
several configurations, and reports hit@5 against the references R from
qa.json. Focused on the failure modes identified:
  * rerank on vs off  (daemon currently hardcodes rerank=False)
  * term expansion / Chinese keyword mapping

Usage:  python compare_configs.py
"""
import json
import os
import re
import sys
import time
from pathlib import Path

KB_ROOT = r"D:\project-review-test\edk2-opencode-v3\edk2-kb"
sys.path.insert(0, KB_ROOT)

QA_JSON = r"C:\Users\25703\AppData\Local\Temp\qtest\qa.json"
DATA_DIR = r"C:\Users\25703\.edk2-opencode\kb\data"


def norm_path(s: str) -> str:
    s = s.replace("\\", "/").strip().lower()
    s = re.sub(r"^\s*'|'\s*$", "", s)
    return s


def is_hit(result, ref: str) -> bool:
    """Check whether a search result matches one reference (R) entry."""
    ref = norm_path(ref)
    cands = []
    for k in ("file", "title", "url", "repo"):
        v = result.get(k)
        if v:
            cands.append(norm_path(str(v)))
    blob = " ".join(cands)
    ref_base = ref.split("/")[-1]
    if ref_base in blob:
        return True
    # wiki html urls: reference may be x.md while url is x.html
    if ref.endswith(".md"):
        ref_html = ref[:-3] + ".html"
        if ref_html in blob:
            return True
    # fuzzy: match repo/dir prefix minus file
    ref_dir = ref.rsplit("/", 1)[0]
    if ref_dir and len(ref_dir) > 12 and ref_dir in blob:
        return True
    return False


def main():
    with open(QA_JSON, "r", encoding="utf-8-sig") as f:
        qa = json.load(f)

    from search_engine import SearchEngine

    refs_total = 0
    for item in qa:
        refs_total += len(item["r"].split(";")) if ";" in item["r"] else 1

    configs = [
        ("baseline (rerank off, rewrite off)", dict(rerank=False, rewrite=False)),
        ("rewrite only (rerank off)", dict(rerank=False, rewrite=True)),
        ("rerank only (rewrite off)", dict(rerank=True, rewrite=False)),
        ("rerank + rewrite", dict(rerank=True, rewrite=True)),
    ]

    # Build one engine, reuse across configs.
    engine = SearchEngine(data_dir=DATA_DIR, preload=False)
    engine.load()
    print(f"engine ready: chroma={engine._collection is not None} "
          f"fts={engine._fts_available}")

    results_by_cfg = {}
    for cfg_name, cfg in configs:
        t0 = time.time()
        total_hits = 0
        per_q = []
        for item in qa:
            q = item["q"]
            top = engine.search(q, top_k=5,
                                rerank=cfg["rerank"], rewrite=cfg["rewrite"])
            refs = item["r"].split(";")
            hits = sum(1 for r in refs if any(is_hit(x, r) for x in top))
            total_hits += hits
            per_q.append({
                "q": q[:28],
                "refs": len(refs),
                "hits": hits,
                "top_files": [x.get("file") or x.get("title") for x in top][:3],
            })
        dt = time.time() - t0
        results_by_cfg[cfg_name] = {
            "total_hits": total_hits,
            "refs_total": refs_total,
            "per_q": per_q,
            "seconds": round(dt, 1),
        }
        print(f"[{cfg_name}] hit {total_hits}/{refs_total} in {dt:.1f}s")

    # Detailed per-question diff for the failing set
    fail_ids = {4, 6, 11, 13, 19, 22}  # 0-indexed? use q numbers
    print("\n=== Per-question hit matrix (q#: refs hits) ===")
    for i, item in enumerate(qa):
        row = f"Q{i}: refs={len(item['r'].split(';'))}"
        for cfg_name, cfg in configs:
            hits = results_by_cfg[cfg_name]["per_q"][i]["hits"]
            row += f" | {cfg_name.split('(')[0].strip()}={hits}"
        print(row)

    with open(r"D:\project-review-test\config_compare.json", "w",
              encoding="utf-8") as f:
        json.dump(results_by_cfg, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
