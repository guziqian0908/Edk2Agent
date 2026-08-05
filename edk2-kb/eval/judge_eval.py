#!/usr/bin/env python
"""Answer-level evaluation with an LLM-as-a-judge.

Measures how well the *final answer* (not just retrieval ranking) answers a
question, by asking an LLM to grade (query, retrieved context, answer)
triples on factual accuracy.

Unlike ``run_eval.py`` (retrieval metrics hit@5/MRR), this scores the end
result a user actually reads: given the KB context the pipeline returned,
does the answer get the facts right, cite them, and avoid hallucination?

Backends
--------
The LLM backend is pluggable via ``--provider``:

- ``mock`` (default): deterministic placeholder. Lets you run the whole
  pipeline end-to-end without an API key. Answer = top retrieved snippet;
  judge score = keyword overlap heuristic.
- ``openai``: any OpenAI-compatible ``/chat/completions`` endpoint
  (OpenAI, ZhipuAI/GLM, DeepSeek, vLLM, ...). Provide ``--api-key``,
  ``--base-url``, ``--model``.

Run:
    python edk2-kb/eval/judge_eval.py \
        --data-dir <kb>/data --subset manual --provider openai \
        --api-key <KEY> --base-url https://open.bigmodel.cn/api/paas/v4 \
        --model glm-4-plus

Output: ``judge_results.json`` + ``JUDGE_REPORT.md`` next to this script.
"""
import argparse
import json
import statistics
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from search_engine import SearchEngine  # noqa: E402

EVAL_FILE = Path(__file__).resolve().parent / "edk2_eval_set.json"
RESULTS_FILE = Path(__file__).resolve().parent / "judge_results.json"
REPORT_FILE = Path(__file__).resolve().parent / "JUDGE_REPORT.md"

JUDGE_PROMPT = """You are a strict, fair grader of EDK2 answers.

Question:
{question}

Reference context the answerer was allowed to use (KB retrieval):
{context}

Answer to grade:
{answer}

Grade the answer on factual accuracy ONLY (not style), using this rubric:
5 = fully accurate, every claim grounded in the context, no hallucination
4 = accurate with minor omissions
3 = partly accurate; contains a notable error or a significant omission
2 = mostly wrong or contains a clear hallucination not in the context
1 = answer is fabricated/irrelevant or refuses while the context answers it

Return ONLY a JSON object:
{{"score": <1-5 int>, "rationale": "<1-2 sentences>", "hallucinations": ["<claim not supported by context>", ...]}}
"""


# ----------------------------------------------------------------- LLM API
@dataclass
class LLMResponse:
    answer: str
    meta: Dict[str, Any] = field(default_factory=dict)


class LLMProvider:
    """Base class. Subclasses implement generate_answer and judge."""

    def generate_answer(self, question: str, context: str) -> LLMResponse:
        raise NotImplementedError

    def judge(self, question: str, context: str, answer: str) -> Dict[str, Any]:
        raise NotImplementedError


class MockProvider(LLMProvider):
    """Deterministic stand-in so the pipeline runs without an API key."""

    def generate_answer(self, question: str, context: str) -> LLMResponse:
        # Pretend the answer is the top retrieved chunk (worst-case baseline).
        snippet = context.strip().splitlines()[0] if context.strip() else \
            "The knowledge base returned no context for this question."
        return LLMResponse(answer=f"Based on the knowledge base: {snippet}",
                           meta={"provider": "mock"})

    def judge(self, question: str, context: str, answer: str) -> Dict[str, Any]:
        q = question.lower()
        tokens = {t for t in q.replace("-", " ").split() if len(t) > 2}
        hits = sum(1 for t in tokens if t in context.lower())
        ratio = hits / max(1, len(tokens))
        if ratio >= 0.5:
            score = 5
        elif ratio >= 0.25:
            score = 3
        else:
            score = 2
        return {"score": score, "rationale": "mock heuristic",
                "hallucinations": []}


class OpenAICompatibleProvider(LLMProvider):
    """Generic OpenAI-compatible chat completions backend.

    Works for OpenAI, ZhipuAI (GLM), DeepSeek, Moonshot, vLLM, etc. All of
    them expose POST {base_url}/chat/completions with a Bearer token.
    """

    def __init__(self, api_key: str, base_url: str, model: str):
        import requests  # venv already installs requests
        self._r = requests
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.session = requests.Session()

    def _chat(self, messages: List[Dict[str, str]],
              temperature: float) -> str:
        resp = self.session.post(
            f"{self.base_url}/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}",
                     "Content-Type": "application/json"},
            json={"model": self.model, "messages": messages,
                  "temperature": temperature},
            timeout=120,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]

    def generate_answer(self, question: str, context: str) -> LLMResponse:
        sys_msg = (
            "You are an EDK2 firmware expert. Answer the user's EDK2 question "
            "using ONLY the knowledge-base context provided below. Cite sources "
            "inline. If the context does not cover the question, say so and give "
            "the closest guidance; never invent PCDs, GUIDs, protocols or spec "
            "sections."
        )
        content = f"Context:\n{context}\n\nQuestion: {question}"
        text = self._chat([{"role": "system", "content": sys_msg},
                           {"role": "user", "content": content}],
                          temperature=0.0)
        return LLMResponse(answer=text,
                           meta={"provider": "openai", "model": self.model})

    def judge(self, question: str, context: str, answer: str) -> Dict[str, Any]:
        user = JUDGE_PROMPT.format(question=question, context=context,
                                   answer=answer)
        text = self._chat([{"role": "user", "content": user}], temperature=0.0)
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end == -1:
            return {"score": 0, "rationale": "judge returned non-JSON",
                    "hallucinations": [], "raw": text}
        try:
            parsed = json.loads(text[start:end + 1])
            parsed.setdefault("hallucinations", [])
            return parsed
        except json.JSONDecodeError:
            return {"score": 0, "rationale": "judge returned invalid JSON",
                    "hallucinations": [], "raw": text}


def build_provider(args) -> LLMProvider:
    if args.provider == "openai":
        if not args.api_key or not args.base_url or not args.model:
            raise SystemExit(
                "openai provider needs --api-key --base-url --model")
        return OpenAICompatibleProvider(args.api_key, args.base_url, args.model)
    return MockProvider()


# ------------------------------------------------------------- eval driver
def doc_key(r):
    return (r.get("source"), r.get("file") or r.get("title"))


def format_context(results: List[Dict[str, Any]], max_chars: int = 8000) -> str:
    """Render retrieval results as a compact context block for the LLM."""
    blocks = []
    used = 0
    for i, r in enumerate(results):
        title = r.get("title") or r.get("file") or "?"
        chunk = f"[{i + 1}] {title} (confidence: {r.get('confidence', '?')})\n{r.get('snippet', '')}"
        if used + len(chunk) > max_chars:
            break
        blocks.append(chunk)
        used += len(chunk)
    return "\n\n".join(blocks)


def run(engine, entries, provider, top_k, max_chars):
    rows = []
    for e in entries:
        q = e["query"]
        results = engine.search(q, top_k, None, rerank=True)
        context = format_context(results, max_chars)
        resp = provider.generate_answer(q, context)
        judged = provider.judge(q, context, resp.answer)
        rows.append({
            "query": q,
            "expected": [f.get("file_or_title", "") for f in e["expected"]],
            "top_doc": results[0].get("title") or results[0].get("file") if results else None,
            "top_confidence": results[0].get("confidence") if results else None,
            "context_chars": len(context),
            "answer": resp.answer,
            "judge": judged,
        })
    return rows


def subset_entries(entries, subset):
    if subset == "manual":
        return [e for e in entries if e.get("kind") == "manual"]
    return entries  # "all"


def summarize(rows):
    scores = [r["judge"].get("score", 0) for r in rows]
    n = len(scores)
    mean = statistics.mean(scores) if scores else 0.0
    frac5 = 100.0 * sum(1 for s in scores if s >= 4) / n if n else 0.0
    halled = sum(1 for r in rows if r["judge"].get("hallucinations")) 
    return {"count": n, "mean_score": round(mean, 2),
            "pct_score4plus": round(frac5, 1),
            "with_hallucinations": halled}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=None)
    ap.add_argument("--eval-file", default=str(EVAL_FILE))
    ap.add_argument("--subset", default="manual",
                    choices=["manual", "all"])
    ap.add_argument("--top-k", type=int, default=5)
    ap.add_argument("--max-chars", type=int, default=8000)
    ap.add_argument("--provider", default="mock",
                    choices=["mock", "openai"])
    ap.add_argument("--api-key", default=None)
    ap.add_argument("--base-url", default=None)
    ap.add_argument("--model", default=None)
    args = ap.parse_args()

    entries = json.loads(Path(args.eval_file).read_text(encoding="utf-8"))
    entries = subset_entries(entries, args.subset)
    engine = SearchEngine(
        data_dir=Path(args.data_dir) if args.data_dir else None,
        preload=True)
    engine.ensure_ready(timeout=300)
    provider = build_provider(args)

    print(f"judging {len(entries)} queries ({args.subset}) "
          f"provider={args.provider} top_k={args.top_k} ...")
    rows = run(engine, entries, provider, args.top_k, args.max_chars)

    RESULTS_FILE.write_text(json.dumps(rows, indent=2, ensure_ascii=False),
                            encoding="utf-8")
    metrics = summarize(rows)
    print(f"\ncount={metrics['count']}  mean={metrics['mean_score']}  "
          f"4+={metrics['pct_score4plus']}%  halluc={metrics['with_hallucinations']}")

    lines = [
        "# EDK2 KB Answer-Level Evaluation (LLM-as-judge)",
        "",
        f"provider={args.provider}  queries={metrics['count']}  "
        f"top_k={args.top_k}",
        "",
        "| metric | value |",
        "|---|---|",
        f"| mean factual score (1-5) | {metrics['mean_score']} |",
        f"| answers scoring 4+ | {metrics['pct_score4plus']}% |",
        f"| answers with hallucinated claims | {metrics['with_hallucinations']} |",
        "",
        "## Worst answers",
        "",
    ]
    worst = sorted(rows, key=lambda r: r["judge"].get("score", 0))[:5]
    for r in worst:
        lines.append(f"- **{r['query']}**  score={r['judge'].get('score')}  "
                     f"(top: {r['top_doc']})")
    REPORT_FILE.write_text("\n".join(lines), encoding="utf-8")
    print("report written to", REPORT_FILE)


if __name__ == "__main__":
    main()
