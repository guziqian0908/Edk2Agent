#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Strict hit@5 evaluation of retrieval configurations (offline, no daemon).

Loads the live data dir directly, runs each of the 25 eval questions under
several configurations, and reports hit@5 against the reference files R from
qa.json. Matching is STRICT on the file basename (plus .md<->.html variant),
NOT fuzzy directory-prefix matching -- the earlier compare_configs.py used a
ref_dir fuzzy fallback that inflated scores (40/62 vs the true 24/62).

Usage:  python strict_eval.py [--top_k 5]
"""
import argparse
import json
import re
import sys
from pathlib import Path

KB_ROOT = r"D:\project-review-test\edk2-opencode-v3\edk2-kb"
sys.path.insert(0, KB_ROOT)
QA_JSON = r"C:\Users\25703\AppData\Local\Temp\qtest\qa.json"
DATA_DIR = r"C:\Users\25703\.edk2-opencode\kb\data"

_REF_TOKEN = re.compile(r"([A-Za-z0-9_\-\s.]+\.(?:md|html|pdf))")


def ref_basename(ref: str):
    m = _REF_TOKEN.search(ref)
    if not m:
        return None
    name = m.group(1).strip().lower()
    variants = {name}
    if name.endswith(".md"):
        variants.add(name[:-3] + ".html")
    if name.endswith(".html"):
        variants.add(name[:-5] + ".md")
    return variants


def strict_hit(result, ref: str) -> bool:
    variants = ref_basename(ref)
    if not variants:
        return False
    cands = []
    for k in ("file", "title", "url"):
        v = result.get(k)
        if v:
            cands.append(str(v).replace("\\", "/").lower())
    blob = " ".join(cands)
    return any(v in blob for v in variants)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top_k", type=int, default=5)
    ap.add_argument("--out", default=r"D:\project-review-test\strict_eval.json")
    args = ap.parse_args()

    from search_engine import SearchEngine
    qa = json.load(open(QA_JSON, encoding="utf-8-sig"))
    engine = SearchEngine(data_dir=DATA_DIR, preload=False)
    engine.load()
    print(f"engine ready: chroma={engine._collection is not None} "
          f"fts={engine._fts_available}")

    configs = [
        ("baseline (rerank off, rewrite off)", dict(rerank=False, rewrite=False)),
        ("rewrite only (rerank off)", dict(rerank=False, rewrite=True)),
        ("rerank only (rewrite off)", dict(rerank=True, rewrite=False)),
        ("rerank + rewrite", dict(rerank=True, rewrite=True)),
    ]
    out = {}
    for cfg_name, cfg in configs:
        total = hits = 0
        per_q = []
        for item in qa:
            refs = [r for r in item["r"].split(";") if r.strip()]
            top = engine.search(item["q"], args.top_k,
                                rerank=cfg["rerank"], rewrite=cfg["rewrite"])
            h = sum(1 for r in refs if any(strict_hit(x, r) for x in top))
            total += len(refs); hits += h
            per_q.append({"q": item["q"][:28], "refs": len(refs), "hits": h,
                          "top_files": [x.get("file") or x.get("title")
                                        for x in top][:3]})
        out[cfg_name] = {"hits": hits, "refs_total": total, "per_q": per_q}
        print(f"[{cfg_name}] strict hit {hits}/{total}")

    print("\n=== Per-question hit matrix (strict) ===")
    for i, item in enumerate(qa):
        row = f"Q{i}: refs={len(item['r'].split(';'))}"
        for cfg_name, _cfg in configs:
            row += f" | {cfg_name.split('(')[0].strip()}={out[cfg_name]['per_q'][i]['hits']}"
        print(row)

    json.dump(out, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
