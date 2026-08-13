#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Diagnose why failing queries miss their reference docs."""
import sys
sys.path.insert(0, r"D:\project-review-test\edk2-opencode-v3\edk2-kb")
from search_engine import SearchEngine, rewrite_query, _fts_query_expr

e = SearchEngine(data_dir=r"C:\Users\25703\.edk2-opencode\kb\data", preload=False)
e.load()

QUERIES = {
    "Q4": " [Depex] 是干什么用的？为什么我 INF 里写了 TRUE，驱动还是没在我期望的时机跑起来？",
    "Q6": " 新手最常撞上的那几个编译/链接报错，分别是什么原因、怎么修？",
    "Q13": " Uncrustify 是什么？怎么在本地把代码格式化成 CI 认可的样子？",
    "Q22": " Start() 里应该按什么顺序做事？",
    "Q23": " Stop() 里要做什么？NumberOfChildren 和 ChildHandleBuffer 怎么用？",
    "Q11": " commit message 到底该怎么写？签名行有什么讲究？",
}

for label, q in QUERIES.items():
    q = q.strip()
    print("=" * 80)
    print(f"{label}: {q[:40]}...")
    print(f"  rewritten: {rewrite_query(q)}")
    print(f"  FTS expr:  {_fts_query_expr(q)[:160]}")
    top = e.search(q, top_k=8, rerank=False)
    print("  top-8 (rerank off):")
    for x in top[:8]:
        print(f"    [{x['source']}] {x.get('file') or x.get('title')} | score={x.get('score')}")
    # BM25-only probe with the English keyword
    print("  BM25-only probe for likely keywords:")
    for kw in ("depex", "dependency expression", "build error", "uncrustify",
               "start()", "stop()", "commit message", "compile"):
        rows = e._search_bm25(kw, 3, None)
        if rows:
            for r in rows[:2]:
                print(f"    '{kw}' -> [{r['source']}] {r.get('file') or r.get('title')}")
