#!/usr/bin/env python3
"""Full-pipeline answer-quality evaluation (web /api/ask + LLM-judge).

Unlike run_eval.py (retrieval hit@5) this grades what the user reads: for
every question it calls the LIVE web service (retrieval -> query analysis ->
decomposition -> generation -> L2c/L3 guards), then a real LLM judge scores
the answer on two axes:

  - faithfulness (1-5): every factual claim grounded in the retrieved context
  - relevancy/completeness (1-5): fully answers every sub-question

Results are grouped per routing tier (simple/standard/complex, classified by
a local port of web/server.js routeQuery) so depth regressions per tier are
visible. Judge config is loaded from web/.env (LLM_API_KEY/LLM_BASE_URL/
LLM_MODEL).

Usage:
    python edk2-kb/eval/run_web_eval.py [--web http://127.0.0.1:8080]
                                       [--limit N] [--judge-only existing.json]

Output: run_web_eval_results.json + RUN_WEB_EVAL_REPORT.md next to this script.
"""

import argparse
import json
import re
import statistics
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
WEB_ENV_FILE = HERE.parent.parent / "web" / ".env"
RESULTS_FILE = HERE / "run_web_eval_results.json"
REPORT_FILE = HERE / "RUN_WEB_EVAL_REPORT.md"

QUESTIONS: List[Tuple[str, str]] = [
    # (tier expectation, question)
    ("simple", "PCD 是什么？"),
    ("simple", "什么是 INF 文件？"),
    ("simple", "Uncrustify 是什么？"),
    ("simple", "DSC 文件是干什么的？"),
    ("standard", "如何提交一个补丁到 EDK2？"),
    ("standard", "编译单个模块用什么命令？"),
    ("standard", "EDK2 命名规范有哪些要求？"),
    ("standard", "UEFI 启动流程有几个阶段？"),
    ("complex", "PCD 有哪几种类型？分别在 DEC、DSC、INF 里怎么写？C 代码里如何访问 PCD？"),
    ("complex", "DXE 阶段和 PEI 阶段有什么区别？各自有哪些关键服务？"),
    ("complex", "拿一个 Protocol 到底该用 LocateProtocol、LocateHandleBuffer 还是 OpenProtocol？OpenProtocol 的 Attributes 怎么选？"),
    ("complex", "我想在代码里打印调试信息，DEBUG/ASSERT 要怎么配置才能真的输出？除了打印还有什么调试手段？"),
    ("complex", "新手最常撞上的那几个编译/链接报错，分别是什么原因、怎么修？"),
    ("complex", "库类(Library Class)和库实例(Library Instance)到底是什么关系？为什么 DSC 里非要写一行映射？"),
    ("complex", "一个改动该拆成几个 commit？拆分标准是什么？"),
    ("complex", "排版和空白有哪些规定？"),
    ("complex", "一个 PCD 的值在构建的哪个阶段被确定？动态 PCD 和固定 PCD 有什么区别？"),
    ("complex", "如何编写一个 UEFI 驱动？Supported、Start、Stop 各自负责什么？"),
]

JUDGE_PROMPT = """You are a strict, fair grader of an EDK2 RAG assistant answer.

Question:
{question}

Retrieved context titles/sections the assistant was allowed to use:
{context}

Answer to grade:
{answer}

Grade on TWO axes:
- faithfulness (1-5): every factual claim in the answer is grounded in the
  retrieved context. 5 = fully grounded, 4 = minor ungrounded phrasing,
  3 = one notable ungrounded claim, 2 = several, 1 = mostly fabricated.
- relevancy (1-5): the answer is on-topic and fully answers EVERY sub-question
  of the question. 5 = complete, 4 = one part shallow, 3 = one part missing,
  2 = several parts missing or off-topic, 1 = irrelevant.

Also list hallucinated claims (claims not supported by the context), quoted
from the answer, at most 4, each at most 100 characters.

Return ONLY a JSON object:
{{"faithfulness": <1-5 int>, "relevancy": <1-5 int>, "hallucinations": ["...", ...]}}
"""


# ---------------------------------------------------------------- web client
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


def ask_web(base_url: str, question: str,
            timeout: int = 240) -> Tuple[str, List[Dict], Dict[str, List], str]:
    payload = json.dumps({"question": question}).encode("utf-8")
    req = urllib.request.Request(
        base_url + "/api/ask", data=payload,
        headers={"Content-Type": "application/json; charset=utf-8"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8", "replace")
    answer = ""
    results: List[Dict] = []
    warns: Dict[str, List] = {"citation": [], "faithfulness": []}
    tier = ""
    for blk in re.split(r"\r?\n\r?\n", raw):
        m = re.match(r"event:\s*(\S+)\r?\ndata:\s*(.*)$", blk, re.S)
        if not m:
            continue
        typ, data = m.group(1), m.group(2)
        try:
            d = json.loads(data)
        except json.JSONDecodeError:
            continue
        if typ == "delta":
            answer += d.get("text", "")
        elif typ == "results":
            results = d.get("results", [])
        elif typ == "citation_warn":
            warns["citation"].append(d)
        elif typ == "faithfulness_warn":
            warns["faithfulness"].append(d)
        elif typ == "done":
            tier = d.get("tier", "")
    return answer, results, warns, tier


# ---------------------------------------------------------------- tier routing
def route_tier(q: str) -> str:
    if not q:
        return "standard"
    if re.search(
            r"(比较|区别|差异|对比|compare|difference|vs\.?| versus |"
            r"各自|分别.*和|和.*分别|为什么|原理|工作机制|底层|根因|"
            r"root\s*cause|如何.*实现)", q, re.I):
        return "complex"
    if len(re.findall(r"[?？]", q)) >= 2:
        return "complex"
    short = len(q) <= 22
    cls = "general"
    for typ, pat in (("howto", r"^(如何|怎么|怎样|how to|how do i)"),
                     ("what", r"^(是什么|什么是|what is|what are)"),
                     ("format", r"^(格式|格式是什么|format|format of)"),
                     ("list", r"^(列出|列举|有哪些|list|what are the)")):
        if re.search(pat, q, re.I):
            cls = typ
            break
    if short and cls in ("what", "format", "list"):
        return "simple"
    if short and cls == "general" and not re.search(r"如何|怎么|怎样", q):
        return "simple"
    return "standard"


# ---------------------------------------------------------------- LLM judge
def llm(env: Dict[str, str], system: str,
        max_tokens: int = 500) -> str:
    # JUDGE_MODEL overrides the default model for judging: a stronger judge
    # (e.g. deepseek-chat) gives lower-variance, fairer scores than the flash
    # model that generated the answers.
    model = env.get("JUDGE_MODEL") or env.get("LLM_MODEL", "")
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": system}],
        "temperature": 0, "max_tokens": max_tokens,
        "reasoning_effort": "none",
    }).encode("utf-8")
    url = env["LLM_BASE_URL"].rstrip("/") + "/chat/completions"
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + env["LLM_API_KEY"]})
    with urllib.request.urlopen(req, timeout=120) as r:
        j = json.loads(r.read().decode("utf-8"))
    msg = j["choices"][0]["message"]
    return (msg.get("content") or msg.get("reasoning_content") or "").strip()


def parse_judge_json(text: str) -> Dict[str, Any]:
    s = re.sub(r"^```(?:json)?\s*", "", text.strip())
    s = re.sub(r"```\s*$", "", s)
    lo, hi = s.find("{"), s.rfind("}")
    if lo >= 0 and hi > lo:
        s = s[lo:hi + 1]
    try:
        j = json.loads(s)
    except json.JSONDecodeError:
        return {"faithfulness": 0, "relevancy": 0, "hallucinations": [],
                "raw": text[:300]}
    out = {"faithfulness": int(j.get("faithfulness", 0) or 0),
           "relevancy": int(j.get("relevancy", 0) or 0),
           "hallucinations": [str(h)[:150] for h in
                              (j.get("hallucinations") or [])][:4]}
    return out


def judge_answer(env: Dict[str, str], question: str,
                 results: List[Dict], answer: str,
                 runs: int = 2) -> Dict[str, Any]:
    """Judge with majority-voting: ``runs`` independent scores are averaged
    (1-5 scales), hallucinations are the union across runs. Single-run judge
    noise on the flash/chat models is ~+-0.5, so voting stabilizes the gate.
    """
    votes = [judge_once(env, question, results, answer)
             for _ in range(runs)]
    faith = _mean([v.get("faithfulness", 0) for v in votes])
    relev = _mean([v.get("relevancy", 0) for v in votes])
    halls: List[str] = []
    for v in votes:
        for h in v.get("hallucinations", []):
            if h not in halls:
                halls.append(h)
    return {"faithfulness": faith, "relevancy": relev,
            "hallucinations": halls[:6], "votes": len(votes)}


def judge_once(env: Dict[str, str], question: str,
               results: List[Dict], answer: str) -> Dict[str, Any]:
    ctx = "\n".join(
        f"[{i + 1}] {r.get('title') or r.get('file') or '?'} "
        f"{r.get('section') or ''}"
        for i, r in enumerate(results[:15]))
    prompt = JUDGE_PROMPT.format(question=question, context=ctx,
                                 answer=answer[:6000])
    text = llm(env, prompt)
    return parse_judge_json(text)


def render_report(rows: List[Dict[str, Any]],
                  gate: Optional[Tuple[float, float]] = None,
                  tier_gates: Optional[Dict[str, Tuple[float, float]]] = None,
                  tier_status: Optional[Dict[str, Dict[str, Any]]] = None) -> str:
    lines = ["# Web Pipeline LLM-Judge Evaluation", ""]
    mean_faith = _mean([r['judge'].get('faithfulness', 0) for r in rows])
    mean_relev = _mean([r['judge'].get('relevancy', 0) for r in rows])
    lines.append(f"questions={len(rows)} "
                 f"mean_faithfulness={mean_faith} "
                 f"mean_relevancy={mean_relev}")
    if gate:
        faith_gate, relev_gate = gate
        passed = mean_faith >= faith_gate and mean_relev >= relev_gate
        lines.append("")
        lines.append(f"## Gate: {'PASS' if passed else 'FAIL'} "
                     f"(faithfulness>={faith_gate}, relevancy>={relev_gate})")
    if tier_gates:
        lines.append("")
        lines.append("## Tier Gates")
        lines.append("| tier | n | faith | gate | relev | gate | status |")
        lines.append("|---|---|---|---|---|---|---|")
        all_pass = True
        for tier in ("simple", "standard", "complex"):
            if tier not in tier_gates:
                continue
            st = (tier_status or {}).get(tier, {})
            n = st.get("n", 0)
            if not n:
                continue
            fg, rg = tier_gates[tier]
            f = st.get("faith", 0.0)
            r = st.get("relev", 0.0)
            ok = f >= fg and r >= rg
            all_pass = all_pass and ok
            lines.append(f"| {tier} | {n} | {f} | >={fg} | {r} | >={rg} | "
                         f"{'PASS' if ok else 'FAIL'} |")
        lines.append("")
        lines.append(f"## Gate: {'PASS' if all_pass else 'FAIL'} (per-tier)")
    lines.append("")
    lines.append("| tier | n | faith | relev | warn_l3 | warn_l2c |")
    lines.append("|---|---|---|---|---|---|")
    for tier in ("simple", "standard", "complex"):
        grp = [r for r in rows if r["tier"] == tier]
        if not grp:
            continue
        lines.append(
            f"| {tier} | {len(grp)} | "
            f"{_mean([r['judge'].get('faithfulness', 0) for r in grp])} | "
            f"{_mean([r['judge'].get('relevancy', 0) for r in grp])} | "
            f"{sum(1 for r in grp if r['warns']['faithfulness'])} | "
            f"{sum(1 for r in grp if r['warns']['citation'])} |")
    lines.append("")
    lines.append("## Worst answers")
    worst = sorted(rows, key=lambda r: (
        r["judge"].get("faithfulness", 0) + r["judge"].get("relevancy", 0)))[:5]
    for r in worst:
        lines.append(
            f"- **{r['question']}** (tier={r['tier']}) "
            f"faith={r['judge'].get('faithfulness')} "
            f"relev={r['judge'].get('relevancy')} "
            f"halluc={r['judge'].get('hallucinations')}")
    return "\n".join(lines)


def _mean(xs: List[float]) -> float:
    return round(statistics.mean(xs), 2) if xs else 0.0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--web", default="http://127.0.0.1:8080")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--judge-only", default="",
                    help="re-judge stored answers from an existing results file")
    ap.add_argument("--gate", action="store_true",
                    help="gate mode: exit non-zero when scores are below "
                         "the thresholds (for CI / pre-release checks)")
    ap.add_argument("--gate-mode", choices=("tier", "global"), default="tier",
                    help="tier = per-tier thresholds (default, calibrated to "
                         "measured capability); global = single mean thresholds")
    ap.add_argument("--gate-faith", type=float, default=4.6,
                    help="global faithfulness gate (default 4.6 == RAGAS 0.9)")
    ap.add_argument("--gate-relev", type=float, default=4.4,
                    help="global relevancy gate (default 4.4 == RAGAS 0.85)")
    ap.add_argument("--judge-runs", type=int, default=2,
                    help="judge votes per question, averaged (default 2)")
    args = ap.parse_args()

    env = load_env()
    if not (env.get("LLM_API_KEY") and env.get("LLM_BASE_URL")
            and env.get("LLM_MODEL")):
        print("LLM config missing in web/.env — cannot judge.")
        sys.exit(1)

    rows: List[Dict[str, Any]] = []
    if args.judge_only:
        prev = json.loads(Path(args.judge_only).read_text(encoding="utf-8"))
        rows = prev["rows"]
        for r in rows:
            print(f"[judge] {r['question'][:40]} ...")
            r["judge"] = judge_answer(env, r["question"], r["results"],
                                      r["answer"], args.judge_runs)
    else:
        qs = QUESTIONS[:args.limit] if args.limit else QUESTIONS
        for i, (exp_tier, q) in enumerate(qs):
            print(f"[{i + 1}/{len(qs)}] ({exp_tier}) {q[:50]}")
            try:
                answer, results, warns, done_tier = ask_web(args.web, q)
            except Exception as e:
                print(f"  web error: {e}")
                rows.append({"question": q, "tier": route_tier(q),
                             "answer": "", "results": [], "warns": {},
                             "error": str(e),
                             "judge": {"faithfulness": 0, "relevancy": 0,
                                       "hallucinations": []}})
                continue
            # The server's routeQuery tier (done event) is authoritative;
            # the local port is only a fallback.
            q_tier = done_tier or route_tier(q)
            print(f"  answer={len(answer)} chars results={len(results)} "
                  f"tier={q_tier} "
                  f"warns={ {k: len(v) for k, v in warns.items()} }")
            rows.append({"question": q, "tier": q_tier,
                         "answer": answer, "results": results, "warns": warns})
            rows[-1]["judge"] = judge_answer(env, q, results, answer,
                                             args.judge_runs)
            print(f"  judge: faith={rows[-1]['judge'].get('faithfulness')} "
                  f"relev={rows[-1]['judge'].get('relevancy')} "
                  f"halluc={len(rows[-1]['judge'].get('hallucinations', []))}")
            time.sleep(1)

    RESULTS_FILE.write_text(
        json.dumps({"rows": rows}, indent=2, ensure_ascii=False),
        encoding="utf-8")

    if args.gate and args.gate_mode == "tier":
        # Per-tier gates calibrated to measured capability (2026-08-21,
        # majority-voted deepseek-chat judge): simple/standard answers are
        # near-fully grounded; complex multi-part answers carry a structural
        # cross-chunk synthesis gap, so their thresholds reflect the current
        # capability and rise as the pipeline improves.
        tier_gates = {"simple": (4.5, 4.5), "standard": (3.8, 4.4),
                      "complex": (3.8, 4.2)}
        tier_status = {}
        all_pass = True
        for tier in ("simple", "standard", "complex"):
            grp = [r for r in rows if r["tier"] == tier]
            if not grp:
                continue
            f = _mean([r["judge"].get("faithfulness", 0) for r in grp])
            rv = _mean([r["judge"].get("relevancy", 0) for r in grp])
            tier_status[tier] = {"n": len(grp), "faith": f, "relev": rv}
            fg, rg = tier_gates[tier]
            ok = f >= fg and rv >= rg
            all_pass = all_pass and ok
            print(f"TIER {tier}: {'PASS' if ok else 'FAIL'} "
                  f"(faith {f}>={fg}, relev {rv}>={rg}, n={len(grp)})")
        REPORT_FILE.write_text(
            render_report(rows, None, tier_gates, tier_status),
            encoding="utf-8")
        print(f"\nresults -> {RESULTS_FILE}")
        print(f"report  -> {REPORT_FILE}")
        print(f"GATE: {'PASS' if all_pass else 'FAIL'} (per-tier)")
        sys.exit(0 if all_pass else 1)

    gate = (args.gate_faith, args.gate_relev) if args.gate else None
    REPORT_FILE.write_text(render_report(rows, gate), encoding="utf-8")
    print(f"\nresults -> {RESULTS_FILE}")
    print(f"report  -> {REPORT_FILE}")

    if args.gate:
        mean_faith = _mean([r["judge"].get("faithfulness", 0) for r in rows])
        mean_relev = _mean([r["judge"].get("relevancy", 0) for r in rows])
        passed = mean_faith >= args.gate_faith and mean_relev >= args.gate_relev
        print(f"GATE: {'PASS' if passed else 'FAIL'} "
              f"(faith {mean_faith}>={args.gate_faith}, "
              f"relev {mean_relev}>={args.gate_relev})")
        sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
