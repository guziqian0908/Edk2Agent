"""Label pipeline for LambdaMART: build (query, chunk, features, label) rows.

For every question in the eval set (+ optional LLM-synthesized questions) it
retrieves a candidate pool with the SAME engine the runtime uses, computes
the shared feature vector (rank_lib.extract_features), and asks an LLM judge
to grade each (query, chunk) pair on a 3-point relevance scale:

    2 = the chunk directly answers the question (or is the expected doc)
    1 = partially relevant background
    0 = irrelevant

Expected docs from the eval set are forced to label 2 when they appear in
the pool. Output is a JSONL file grouped by query id, ready for
train_ranker.py.

Usage:
    python edk2-kb/eval/label_pipeline.py \
        --data-dir <kb>/data --eval-file edk2-kb/eval/edk2_eval_set.json \
        --out edk2-kb/rank/ltr_labels.jsonl [--limit N] [--synthetic N]

LLM config is loaded from web/.env (same as run_web_eval.py).
"""

import argparse
import json
import re
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
KB_ROOT = HERE.parent
sys.path.insert(0, str(KB_ROOT))
sys.path.insert(0, str(KB_ROOT / "rank"))

from rank_lib import extract_features, FEATURE_NAMES  # noqa: E402
from search_engine import SearchEngine  # noqa: E402

WEB_ENV_FILE = KB_ROOT.parent / "web" / ".env"
DEFAULT_EVAL = HERE / "edk2_eval_set.json"
DEFAULT_OUT = KB_ROOT / "rank" / "ltr_labels.jsonl"

JUDGE_PROMPT = """You are a relevance grader for an EDK2/TianoCore document retrieval system.

Question:
{question}

Document chunk (title / section / snippet):
{chunk}

How relevant is this chunk for answering the question?
2 = directly answers it (contains the specific rules, fields, or steps asked for)
1 = partially relevant background (same topic, but not the answer itself)
0 = irrelevant or noise (different topic, commit log noise, boilerplate)

Return ONLY a JSON object: {{"label": <0|1|2 int>, "reason": "<<=10 words>"}}
"""


def load_env() -> Dict[str, str]:
    env: Dict[str, str] = {}
    try:
        for line in WEB_ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", line)
            if m:
                env[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    except OSError:
        pass
    return env


def llm_judge(env: Dict[str, str], question: str, chunk: str) -> Optional[int]:
    model = env.get("JUDGE_MODEL") or env.get("LLM_MODEL", "")
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "system",
                      "content": JUDGE_PROMPT.format(question=question,
                                                     chunk=chunk[:1200])}],
        "temperature": 0, "max_tokens": 60, "reasoning_effort": "none",
    }).encode("utf-8")
    url = env["LLM_BASE_URL"].rstrip("/") + "/chat/completions"
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + env["LLM_API_KEY"]})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            j = json.loads(r.read().decode("utf-8"))
        msg = j["choices"][0]["message"]
        text = (msg.get("content") or msg.get("reasoning_content") or "")
        m = re.search(r"\{.*\}", text, re.S)
        if not m:
            return None
        d = json.loads(m.group(0))
        return int(d.get("label", -1)) if d.get("label") in (0, 1, 2) else None
    except Exception as e:
        print(f"  judge error: {e}", file=sys.stderr)
        return None


def load_eval_queries(eval_file: Path) -> List[Tuple[str, List[str]]]:
    """Return [(query, [expected file_or_title, ...]), ...]."""
    data = json.loads(eval_file.read_text(encoding="utf-8"))
    out: List[Tuple[str, List[str]]] = []
    for entry in data:
        q = entry.get("query", "").strip()
        if not q:
            continue
        refs = [e.get("file_or_title", "") for e in entry.get("expected", [])]
        out.append((q, [r for r in refs if r]))
    return out


def synth_questions(env: Dict[str, str], n: int) -> List[str]:
    """LLM-synthesized EDK2 questions for wider label coverage."""
    payload = json.dumps({
        "model": env.get("LLM_MODEL", ""),
        "messages": [{
            "role": "system",
            "content": ("You are an EDK2 firmware engineer. Write "
                        f"{n} realistic, specific EDK2/TianoCore questions "
                        "a developer would ask, one per line, mixing "
                        "definitions, how-to, comparisons and errors. "
                        "Output ONLY the questions, no numbering, no "
                        "explanation.")
        }],
        "temperature": 0.7, "max_tokens": 800,
    }).encode("utf-8")
    url = env["LLM_BASE_URL"].rstrip("/") + "/chat/completions"
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + env["LLM_API_KEY"]})
    with urllib.request.urlopen(req, timeout=120) as r:
        j = json.loads(r.read().decode("utf-8"))
    msg = j["choices"][0]["message"]
    text = (msg.get("content") or msg.get("reasoning_content") or "")
    return [ln.strip(" -*#\t") for ln in text.splitlines()
            if len(ln.strip()) > 10][:n]


def doc_key(item: Dict[str, Any]) -> str:
    return (item.get("file") or item.get("title") or item.get("url")
            or item.get("section") or "")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data-dir", required=True,
                    help="knowledge base data dir (e.g. ~/.edk2-opencode/kb/data)")
    ap.add_argument("--eval-file", default=str(DEFAULT_EVAL))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--synthetic", type=int, default=0,
                    help="add N LLM-synthesized questions")
    ap.add_argument("--pool", type=int, default=8,
                    help="candidate pool size per query")
    args = ap.parse_args()

    env = load_env()
    if not (env.get("LLM_API_KEY") and env.get("LLM_BASE_URL")
            and env.get("LLM_MODEL")):
        print("LLM config missing in web/.env — cannot judge.")
        sys.exit(1)

    engine = SearchEngine(data_dir=Path(args.data_dir), preload=True)
    engine.ensure_ready(timeout=1800)

    queries = load_eval_queries(Path(args.eval_file))
    if args.synthetic:
        queries += [(q, []) for q in synth_questions(env, args.synthetic)]
    if args.limit:
        queries = queries[:args.limit]

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    rows: List[Dict[str, Any]] = []
    qid = 0
    for question, expected in queries:
        qid += 1
        try:
            pool = engine.search(question, top_k=args.pool, rerank=False,
                                 rewrite=True, dedup=False)
        except Exception as e:
            print(f"[{qid}] search error for {question!r}: {e}", file=sys.stderr)
            continue
        seen = set()
        exp_set = {e.lower() for e in expected}
        for rank, item in enumerate(pool):
            key = doc_key(item)
            if not key or key in seen:
                continue
            seen.add(key)
            matched_exp = any(e in key.lower() or e in
                              str(item.get("title", "")).lower()
                              for e in exp_set)
            chunk = (f"title: {item.get('title', '')}\n"
                     f"section: {item.get('section', '')}\n"
                     f"snippet: {item.get('snippet', '')}")
            label = 2 if matched_exp else \
                (llm_judge(env, question, chunk) if len(seen) <= args.pool
                 else 0)
            if label is None:
                label = 0
            rows.append({
                "qid": qid,
                "query": question,
                "doc": key,
                "label": label,
                "features": extract_features(question, item),
            })
        print(f"[{qid}/{len(queries)}] {question[:40]} "
              f"pool={len(seen)} labeled={sum(1 for r in rows if r['qid'] == qid)}")
        time.sleep(0.3)

    with open(out_path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    pos = sum(1 for r in rows if r["label"] == 2)
    print(f"\nwrote {len(rows)} rows ({pos} positive) -> {out_path}")
    print(f"feature names: {FEATURE_NAMES}")
    if len(rows) < 300:
        print("NOTE: fewer than 300 labeled rows — LambdaMART training may "
              "not generalize; consider more queries or a larger pool.")


if __name__ == "__main__":
    main()
