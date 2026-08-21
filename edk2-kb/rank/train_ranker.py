"""Train a LambdaMART ranker (LightGBM) on labeled (query, chunk) rows.

Input: the JSONL produced by eval/label_pipeline.py
       ({"qid", "query", "doc", "label", "features"} rows).

Output: rank/ranker.txt (LightGBM booster) + rank/ranker_meta.json
        (feature names, thresholds used, training stats).

Usage:
    python edk2-kb/rank/train_ranker.py --labels edk2-kb/rank/ltr_labels.jsonl

If the label set is too small (<300 rows or <30 queries) the script refuses
to train and prints the fallback guidance instead (keep the cross-encoder
reranker as the only fine-ranker until more labels exist).
"""

import argparse
import json
import statistics
import sys
from pathlib import Path
from typing import Any, Dict, List

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from rank_lib import FEATURE_NAMES  # noqa: E402

MIN_ROWS = 300
MIN_QUERIES = 30


def load_rows(path: Path) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        if not isinstance(r.get("features"), list):
            continue
        r["label"] = int(r.get("label", 0))
        rows.append(r)
    return rows


def train(rows: List[Dict[str, Any]], out_model: Path, out_meta: Path) -> None:
    try:
        import lightgbm as lgb
    except ImportError:
        print("lightgbm is not installed. Run: pip install lightgbm")
        sys.exit(1)

    groups = [len([1 for r in rows if r["qid"] == qid])
              for qid in sorted({r["qid"] for r in rows})]
    X = [r["features"] for r in rows]
    y = [r["label"] for r in rows]

    train_data = lgb.Dataset(X, label=y, group=groups,
                             feature_name=FEATURE_NAMES)
    params = {
        "objective": "lambdarank",
        "metric": "ndcg",
        "ndcg_eval_at": [3, 5],
        "boosting_type": "gbdt",
        "num_leaves": 31,
        "learning_rate": 0.05,
        "min_data_in_leaf": 20,
        "verbose": -1,
        "label_gain": [0, 1, 3],
    }
    booster = lgb.train(params, train_data, num_boost_round=200)
    booster.save_model(str(out_model))

    gains = booster.feature_importance("gain")
    importance = {FEATURE_NAMES[i]: round(float(gains[i]), 2)
                  for i in range(len(FEATURE_NAMES))}
    out_meta.write_text(json.dumps({
        "feature_names": FEATURE_NAMES,
        "rows": len(rows),
        "queries": len(set(r["qid"] for r in rows)),
        "positive_ratio": round(statistics.mean(y), 3),
        "feature_importance_gain": importance,
    }, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"model -> {out_model}")
    print(f"meta  -> {out_meta}")
    print("top features by gain:",
          sorted(importance.items(), key=lambda kv: -kv[1])[:5])


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--labels", required=True,
                    help="JSONL from eval/label_pipeline.py")
    ap.add_argument("--model", default=str(HERE / "ranker.txt"))
    ap.add_argument("--meta", default=str(HERE / "ranker_meta.json"))
    ap.add_argument("--force", action="store_true",
                    help="train even below the minimum data thresholds")
    args = ap.parse_args()

    labels_path = Path(args.labels)
    if not labels_path.exists():
        print(f"labels file not found: {labels_path}")
        print("run eval/label_pipeline.py first (needs a working knowledge "
              "base + LLM config in web/.env).")
        sys.exit(1)
    rows = load_rows(labels_path)
    n_queries = len({r["qid"] for r in rows})
    print(f"loaded {len(rows)} rows / {n_queries} queries")
    if len(rows) < MIN_ROWS or n_queries < MIN_QUERIES:
        print(f"below training thresholds "
              f"({MIN_ROWS} rows / {MIN_QUERIES} queries).")
        print("fallback guidance: keep the BGE cross-encoder reranker as the "
              "fine ranker; grow the label set with more eval questions or "
              "--synthetic N in label_pipeline.py, then retry.")
        if not args.force:
            sys.exit(2)
        print("--force given: training anyway")
    train(rows, Path(args.model), Path(args.meta))


if __name__ == "__main__":
    main()
