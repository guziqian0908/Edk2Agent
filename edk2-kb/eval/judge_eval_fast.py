#!/usr/bin/env python3
"""Fast incremental LLM-as-judge evaluation with progress saving."""
import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from search_engine import SearchEngine
from judge_eval import AnthropicProvider, format_context

RESULTS_FILE = Path(__file__).resolve().parent / "judge_results_incremental.json"

def load_existing_results():
    if RESULTS_FILE.exists():
        return json.loads(RESULTS_FILE.read_text(encoding="utf-8"))
    return []

def save_results(results):
    RESULTS_FILE.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=None)
    ap.add_argument("--eval-file", required=True)
    ap.add_argument("--top-k", type=int, default=15)
    ap.add_argument("--max-chars", type=int, default=16000)
    ap.add_argument("--api-key", required=True)
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--model", required=True)
    args = ap.parse_args()

    entries = json.loads(Path(args.eval_file).read_text(encoding="utf-8"))
    engine = SearchEngine(data_dir=Path(args.data_dir) if args.data_dir else None, preload=True)
    engine.ensure_ready(timeout=300)
    provider = AnthropicProvider(args.api_key, args.base_url, args.model)

    existing = load_existing_results()
    processed_queries = {r["query"] for r in existing}
    
    print(f"Resuming: {len(existing)} questions already done")
    
    for i, e in enumerate(entries):
        q = e["query"]
        if q in processed_queries:
            continue
        
        print(f"\n[{len(existing)+1}/{len(entries)}] {q[:60]}...")
        
        results = engine.search(q, args.top_k, None, rerank=False)
        context = format_context(results, args.max_chars)
        
        try:
            resp = provider.generate_answer(q, context)
            time.sleep(2)
            judged = provider.judge(q, context, resp.answer)
            time.sleep(2)
        except Exception as ex:
            print(f"  ERROR: {ex}")
            continue
        
        existing.append({
            "query": q,
            "expected": [f.get("file_or_title", "") for f in e["expected"]],
            "top_doc": results[0].get("title") or results[0].get("file") if results else None,
            "context_chars": len(context),
            "answer": resp.answer,
            "judge": judged,
        })
        
        save_results(existing)
        print(f"  score={judged.get('score')} rationale={judged.get('rationale', '')[:60]}")
    
    print(f"\n=== Summary ===")
    scores = [r["judge"].get("score", 0) for r in existing]
    if scores:
        print(f"Mean score: {sum(scores)/len(scores):.2f}")
        print(f"Score distribution:")
        for s in sorted(set(scores)):
            print(f"  Score {s}: {scores.count(s)} questions")

if __name__ == "__main__":
    main()
