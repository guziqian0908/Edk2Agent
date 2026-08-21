#!/usr/bin/env python3
"""Per-tier regression monitor over the shared trace file (trace.jsonl).

Aggregates request-level metrics per routing tier (simple / standard /
complex / unknown), so every pipeline change can be checked for regressions
without a manual eval run:

  - requests, avg/max http_total latency, avg/max llm_generate latency
  - avg generated tokens (delta count) per tier — the "complex questions
    must stay detailed" guard
  - citation_check invalid rate, faithfulness_check unsupported rate
  - empty-generation and truncation counts

Usage:
    python edk2-kb/eval/tier_monitor.py [--trace <path>] [--days N] [--json out.json]
"""

import argparse
import json
import statistics
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List

DEFAULT_TRACE = Path.home() / ".edk2-opencode" / "kb" / "trace.jsonl"


def _parse_ts(ts: str):
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None


def _mean(xs: List[float]) -> float:
    return round(statistics.mean(xs), 1) if xs else 0.0


def _max(xs: List[float]) -> float:
    return round(max(xs), 0) if xs else 0.0


def load_rows(path: Path, days: int):
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    rows = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        dt = _parse_ts(rec.get("timestamp", ""))
        if dt is None or dt < cutoff:
            continue
        rows.append(rec)
    return rows


def aggregate(rows: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    tier_of = {}
    for rec in rows:
        if rec.get("stage") == "route" and rec.get("query_hash"):
            tier_of[rec["query_hash"]] = rec.get("tier", "standard")

    agg = defaultdict(lambda: {
        "reqs": 0, "total_ms": [], "gen_ms": [], "tokens": [],
        "cite_checks": 0, "cite_invalid": 0,
        "faith_checks": 0, "faith_unsupported": 0,
        "empty": 0, "trunc": 0,
    })
    for rec in rows:
        tier = tier_of.get(rec.get("query_hash") or "", "unknown")
        a = agg[tier]
        st = rec.get("stage")
        if st == "http_total" and rec.get("status") == "ok":
            a["reqs"] += 1
            a["total_ms"].append(rec.get("duration_ms", 0))
        elif st == "llm_generate":
            if rec.get("status") == "ok":
                a["gen_ms"].append(rec.get("duration_ms", 0))
                a["tokens"].append(rec.get("tokens", 0))
            elif rec.get("status") == "empty":
                a["empty"] += 1
        elif st == "citation_check":
            a["cite_checks"] += 1
            if rec.get("status") == "invalid":
                a["cite_invalid"] += 1
        elif st == "faithfulness_check":
            a["faith_checks"] += 1
            if rec.get("status") == "unsupported":
                a["faith_unsupported"] += 1
        elif st == "llm_truncated":
            a["trunc"] += 1
    return dict(agg)


def render(agg: Dict[str, Dict[str, Any]]) -> str:
    lines = [
        "# Per-Tier Regression Monitor",
        "",
        "| tier | reqs | avg total (s) | max total (s) | avg gen (s) | "
        "avg tokens | cite invalid | faith unsupported | empty | trunc |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for tier in ("simple", "standard", "complex", "unknown"):
        a = agg.get(tier)
        if not a or a["reqs"] == 0:
            continue
        cite_rate = (f"{a['cite_invalid']}/{a['cite_checks']}"
                     if a["cite_checks"] else "-")
        faith_rate = (f"{a['faith_unsupported']}/{a['faith_checks']}"
                      if a["faith_checks"] else "-")
        lines.append(
            f"| {tier} | {a['reqs']} | {_mean(a['total_ms'])/1000:.1f} | "
            f"{_max(a['total_ms'])/1000:.0f} | {_mean(a['gen_ms'])/1000:.1f} | "
            f"{_mean(a['tokens'])} | {cite_rate} | {faith_rate} | "
            f"{a['empty']} | {a['trunc']} |")
    lines.append("")
    lines.append("## Guards")
    lines.append("- 复杂问题详略：complex 档 avg tokens 若跌破 800，说明详略分级退化。")
    lines.append("- 引用纪律：citation invalid / checks 比率升高说明证据绑定弱化。")
    lines.append("- 幻觉出口：faith unsupported / checks 比率升高说明生成偏离检索上下文。")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--trace", default=str(DEFAULT_TRACE))
    ap.add_argument("--days", type=int, default=7,
                    help="only consider trace lines newer than N days")
    ap.add_argument("--json", default="",
                    help="optional path to dump the aggregated JSON")
    args = ap.parse_args()

    path = Path(args.trace)
    if not path.exists():
        print(f"trace file not found: {path}")
        sys.exit(1)
    rows = load_rows(path, args.days)
    if not rows:
        print("no trace lines in window")
        sys.exit(0)
    agg = aggregate(rows)
    print(render(agg))
    if args.json:
        out = {tier: {k: (v if not isinstance(v, list) else v)
                      for k, v in a.items()} for tier, a in agg.items()}
        Path(args.json).write_text(json.dumps(out, indent=2, ensure_ascii=False),
                                   encoding="utf-8")
        print(f"\naggregated JSON -> {args.json}")


if __name__ == "__main__":
    main()
