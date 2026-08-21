"""Shared feature extraction + LambdaMART inference for EDK2 retrieval ranking.

Used by BOTH the labeling pipeline (label_pipeline.py), the trainer
(train_ranker.py) and the runtime hook in search_engine.py, so training and
inference can never drift.

Feature list (order matters — the trainer serializes the names):
  0  retrieval_score   dense-first fusion score (0..1-ish)
  1  rerank_score      cross-encoder score if available, else retrieval_score
  2  authoritative     1 when the chunk comes from spec/guide/tianocore-docs
  3  doc_type_priority spec=3 guide=2 docs=1 webpage/commit/pr=0
  4  section_depth     number of '>' levels in the section path (+1)
  5  title_overlap     share of query tokens present in title/section
  6  content_overlap   share of query tokens present in the chunk body
  7  age_years         chunk age in years (0 = unknown)
  8  snippet_len       log10(1 + snippet length)
"""

import json
import math
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

FEATURE_NAMES = [
    "retrieval_score", "rerank_score", "authoritative", "doc_type_priority",
    "section_depth", "title_overlap", "content_overlap", "age_years",
    "snippet_len",
]

_DOC_TYPE_PRIORITY = {
    "spec": 3, "guide": 2, "docs": 1, "webpage": 0,
}
_SOURCE_PRIORITY = {
    "tianocore-docs": 2, "uefi-specs": 3, "tianocore-wiki": 1,
    "edk2-commits": 0, "edk2-prs": 0, "edk2-mdepkg": 1,
}
_STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "with",
    "is", "are", "how", "what", "which", "does", "can", "use", "using",
    "edk", "ii", "file", "format", "type",
}


def _tokens(text: str) -> List[str]:
    return [w.lower() for w in re.split(r"[\s\W_]+", text or "")
            if len(w) >= 2 and w.lower() not in _STOPWORDS]


def _query_terms(query: str) -> List[str]:
    return list(dict.fromkeys(_tokens(query)))[:24]


def _overlap(terms: List[str], text: str) -> float:
    if not terms:
        return 0.0
    text_terms = set(_tokens(text[:2000]))
    hits = sum(1 for t in terms if t in text_terms)
    return round(hits / len(terms), 4)


def _doc_type(item: Dict[str, Any]) -> str:
    src = str(item.get("source_display", "") + " " +
              item.get("source", "")).lower()
    file = str(item.get("file", "")).lower()
    if "spec" in src or "specification" in file or "spec" in file:
        return "spec"
    if "guide" in src or "guide" in file:
        return "guide"
    if src.startswith("tianocore-wiki"):
        return "webpage"
    if src.startswith("tianocore-docs") or src.startswith("uefi-specs"):
        return "docs"
    return "docs"


def extract_features(query: str, item: Dict[str, Any]) -> List[float]:
    """Compute the numeric feature vector for one (query, chunk) pair."""
    terms = _query_terms(query)
    src = str(item.get("source", "") or "").lower()
    file = str(item.get("file", "") or "").lower()
    is_authoritative = 1.0 if (
        src.startswith("tianocore-docs") or src.startswith("uefi-specs") or
        (item.get("type") in ("spec", "guide")) or
        file.startswith("edk2-") or
        "specification" in file or "spec" in file
    ) else 0.0
    section = str(item.get("section", "") or "")
    depth = min(float(section.count(">") + 1), 8.0)
    title_text = f"{item.get('title', '')} {section}"
    body = item.get("snippet", "") or item.get("content", "") or ""
    age = 0.0
    try:
        year = int(str(item.get("date", "") or "")[:4])
        import datetime
        age = max(0.0, float(datetime.date.today().year - year))
    except (ValueError, TypeError):
        age = 0.0
    score = float(item.get("score", 0.0) or 0.0)
    rscore = item.get("rerank_score")
    rscore = float(rscore) if isinstance(rscore, (int, float)) else score
    return [
        round(score, 4),
        round(rscore, 4),
        is_authoritative,
        float(_DOC_TYPE_PRIORITY.get(_doc_type(item), 1)),
        depth,
        _overlap(terms, title_text),
        _overlap(terms, body),
        age,
        round(math.log10(1.0 + len(body)), 4),
    ]


def rank_candidates(query: str, items: List[Dict[str, Any]],
                    model: Any) -> List[Dict[str, Any]]:
    """Reorder ``items`` by the LambdaMART model score (descending)."""
    feats = [extract_features(query, it) for it in items]
    scores = list(model.predict(feats))
    pairs = sorted(zip(items, scores),
                   key=lambda p: p[1], reverse=True)
    for it, s in pairs:
        it["ltr_score"] = round(float(s), 4)
    return [p[0] for p in pairs]


def load_model(model_path: str) -> Any:
    """Load a trained ranker.txt (lightgbm Booster)."""
    import lightgbm as lgb  # local import: only needed when LTR is enabled
    return lgb.Booster(model_file=model_path)
