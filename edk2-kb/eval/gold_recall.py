#!/usr/bin/env python3
"""Gold source / section recall for recorded retrieval lists.

Scores file hit@k and section hit@k against ``gold_source_chapters.json``.
question.txt items 27, 28 and 29 (PPI/HOB, Boot/Runtime, TPL) use the RST
``file`` values in ``kb_file_map_q27_q35.md`` (source ``uefi-specs``). PDF
filenames are never gold files. ``pi_boot_flow.md`` is not gold for items
27 or 28.

This module does not import the search engine, open the vector index, start
the web server, or call an LLM. Pass a recorded retrieval/citation list.

Usage:
    python edk2-kb/eval/gold_recall.py --retrievals recorded.json
    python edk2-kb/eval/run_web_eval.py --gold-recall --retrievals recorded.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

HERE = Path(__file__).resolve().parent
GOLD_JSON = HERE / "gold_source_chapters.json"
FILE_MAP = HERE / "kb_file_map_q27_q35.md"

# question.txt is 1-based. qtest ids in the gold JSON are 0-based, so
# question 27 is qtest-Q26.
MAPPED_QUESTION_NOS = (27, 28, 29)
# These question.txt numbers are the near-alias slice called out for the
# question set (PPI/HOB, Boot/Runtime, TPL, Event types, Secure Boot).
NEAR_ALIAS_QUESTION_NOS = (27, 28, 29, 31, 35)
# Wiki boot-flow page is not an original spec. Drop it only for the two
# questions whose R line appended it beside a PDF section.
DROP_WIKI_BOOT_FLOW_NOS = (27, 28)
WIKI_BOOT_FLOW = "development/design-architecture/pi_boot_flow.md"
BANNED_PDF_BASES = {
    "uefi_spec_final_2.11.pdf",
    "pi_spec_1_8_a_final_2024.03.05.pdf",
}
GENERIC_BASES = {
    "readme.md", "readme.html",
    "index.md", "index.html",
    "summary.md", "summary.html",
    "overview.md", "overview.html",
}
KS = (5, 10)

_HEADING_RE = re.compile(r"^##\s+Q(\d+)\b")
_BULLET_RE = re.compile(r"^-\s+`([^`]+)`\s*(.*)$")
_NUM_RE = re.compile(
    r"(?i)(?<![a-z0-9])(?:"
    r"chapter\s+\d+"
    r"|[ivxlcdm]+-\d+(?:\.\d+)*"
    r"|\d+(?:\.\d+)+"
    r")(?![\d.])"
)
_RANGE_RE = re.compile(r"^(\d+)\.(\d+)\s*-\s*(\d+)\.(\d+)$")
_WS_RE = re.compile(r"\s+")


def load_gold_document(path: Optional[Path] = None) -> Dict[str, Any]:
    path = Path(path) if path else GOLD_JSON
    return json.loads(path.read_text(encoding="utf-8"))


def parse_kb_file_map(text: str) -> Dict[int, List[Dict[str, Any]]]:
    """Pull ``## Qn`` bullets whose first backtick span is a repository file."""
    current: Optional[int] = None
    out: Dict[int, List[Dict[str, Any]]] = {}
    for raw in text.splitlines():
        line = raw.strip()
        heading = _HEADING_RE.match(line)
        if heading:
            current = int(heading.group(1))
            out.setdefault(current, [])
            continue
        if current is None or line.startswith("可选"):
            continue
        bullet = _BULLET_RE.match(line)
        if not bullet:
            continue
        file_ = bullet.group(1).strip()
        title = re.sub(r"^[—–\-:]\s*", "", bullet.group(2).strip())
        out[current].append({
            "source": "uefi-specs" if file_.lower().endswith(".rst")
            else "tianocore-docs",
            "file": file_,
            "title": title,
        })
    return out


def load_kb_file_map(path: Optional[Path] = None) -> Dict[int, List[Dict[str, Any]]]:
    path = Path(path) if path else FILE_MAP
    return parse_kb_file_map(path.read_text(encoding="utf-8"))


def _norm_space(text: str) -> str:
    text = text.lower().replace("（", "(").replace("）", ")")
    text = text.replace("`", "")
    text = text.replace("\\", "/")
    return _WS_RE.sub(" ", text).strip()


def _loose(text: str) -> str:
    text = _norm_space(text)
    text = text.replace("-", " ").replace("_", " ")
    text = text.replace("(", " ").replace(")", " ")
    return _WS_RE.sub(" ", text).strip()


def section_groups_from_title(title: str) -> List[List[str]]:
    """Split a map title into section groups. Aliases inside one group are OR."""
    if not title or not title.strip():
        return []
    groups: List[List[str]] = []
    for chunk in title.split("、"):
        aliases = [a.strip() for a in re.findall(r"`([^`]+)`", chunk) if a.strip()]
        plain = re.sub(r"`[^`]+`", " ", chunk)
        paren_bits = re.findall(r"[（(]([^）)]+)[）)]", plain)
        # Drop parenthetical notes, but keep empty "()" on function names
        # such as ExitBootServices() / RaiseTPL().
        plain = re.sub(r"[（(][^）)]+[）)]", " ", plain)
        plain = _WS_RE.sub(" ", plain).strip(" —-")
        phrases: List[str] = []
        if plain:
            phrases.append(plain)
        for bit in paren_bits + aliases:
            bit = bit.strip()
            if not bit or re.fullmatch(r"对应\s*[\d.]+", bit):
                continue
            if bit not in phrases:
                phrases.append(bit)
        cleaned: List[str] = []
        for phrase in phrases:
            stem = re.sub(r"\s*概述\s*$", "", phrase).strip()
            if stem and stem not in cleaned:
                cleaned.append(stem)
            if stem.endswith("表"):
                without = stem[:-1].strip()
                if without and without not in cleaned:
                    cleaned.append(without)
        if cleaned:
            groups.append(cleaned)
    return groups


def section_groups_from_chapter(chapter: Any) -> List[List[str]]:
    if chapter is None:
        return []
    text = str(chapter).strip()
    if not text:
        return []
    if re.fullmatch(r"[\(（']?\s*whole page\s*[\)）']?", text, re.I):
        return [["__WHOLE_PAGE__"]]
    groups: List[List[str]] = []
    for part in re.split(r"\s+\+\s+|、", text):
        part = part.strip().strip("'\"")
        if re.fullmatch(r"[（(].*[）)]", part):
            part = part[1:-1].strip()
        if part:
            groups.append([part])
    return groups


def _basename(path: str) -> str:
    path = path.split("?", 1)[0].split("#", 1)[0].rstrip("/")
    return path.split("/")[-1]


def _is_banned_pdf(file_: str) -> bool:
    return _basename(file_.replace("\\", "/")).lower() in BANNED_PDF_BASES


def _is_wiki_boot_flow(file_: str) -> bool:
    norm = file_.replace("\\", "/").lower().lstrip("./")
    return norm == WIKI_BOOT_FLOW or norm.endswith("/" + WIKI_BOOT_FLOW)


def _gold_entry(source: str, file_: str, chapter: Any = None,
                from_map: bool = False, title: str = "") -> Dict[str, Any]:
    if from_map:
        groups = section_groups_from_title(title or str(chapter or ""))
    else:
        groups = section_groups_from_chapter(chapter)
    return {
        "source": source,
        "file": file_.replace("\\", "/"),
        "chapter": chapter if chapter is not None else title,
        "section_groups": groups,
        "from_map": from_map,
    }


def _extend_unique(expected: List[Dict[str, Any]],
                   extras: Sequence[Dict[str, Any]]) -> None:
    seen = {item["file"].replace("\\", "/").lower() for item in expected}
    for extra in extras:
        file_ = str(extra.get("file") or "").replace("\\", "/")
        if not file_ or _is_banned_pdf(file_):
            continue
        key = file_.lower()
        if key in seen:
            continue
        seen.add(key)
        expected.append(_gold_entry(
            str(extra.get("source") or "tianocore-docs"),
            file_,
            extra.get("chapter"),
            from_map=False,
        ))


def build_eval_set(document: Optional[Dict[str, Any]] = None,
                   file_map: Optional[Dict[int, List[Dict[str, Any]]]] = None,
                   include_additions: bool = False) -> Dict[str, Any]:
    """Effective gold items. PDF names are removed. Q27–Q29 come from the map."""
    document = document if document is not None else load_gold_document()
    file_map = file_map if file_map is not None else load_kb_file_map()
    additions = document.get("suggested_additions_for_question_txt") or {}

    question_items: List[Dict[str, Any]] = []
    unmapped: List[str] = []
    for index, raw in enumerate(document["question_txt"]):
        question_no = index + 1
        expected: List[Dict[str, Any]] = []
        if question_no in MAPPED_QUESTION_NOS:
            mapped = file_map.get(question_no) or []
            if not mapped:
                raise ValueError(
                    f"kb file map has no files for question.txt Q{question_no}")
            for entry in mapped:
                if _is_banned_pdf(entry["file"]) or _is_wiki_boot_flow(entry["file"]):
                    continue
                expected.append(_gold_entry(
                    entry["source"], entry["file"], entry.get("title"),
                    from_map=True, title=entry.get("title") or ""))
        else:
            for entry in raw.get("expected") or []:
                file_ = str(entry.get("file") or "")
                if not file_ or _is_banned_pdf(file_):
                    continue
                if question_no in DROP_WIKI_BOOT_FLOW_NOS and _is_wiki_boot_flow(file_):
                    continue
                expected.append(_gold_entry(
                    str(entry.get("source") or ""),
                    file_,
                    entry.get("chapter"),
                    from_map=False,
                ))
        if include_additions:
            _extend_unique(expected, additions.get(raw["id"]) or [])
        item = {
            "id": raw["id"],
            "question_no": question_no,
            "query": raw.get("query") or "",
            "kind": "question-txt",
            "tags": ["near-alias"] if question_no in NEAR_ALIAS_QUESTION_NOS else [],
            "expected": expected,
            "confounders": [],
            "distinguishes_from": [],
            "unmapped": not expected,
        }
        if item["unmapped"]:
            unmapped.append(raw["id"])
        question_items.append(item)

    disambiguation: List[Dict[str, Any]] = []
    for group in document.get("disambiguation") or []:
        expected = []
        for entry in group.get("expected") or []:
            file_ = str(entry.get("file") or "")
            if not file_ or _is_banned_pdf(file_):
                continue
            expected.append(_gold_entry(
                str(entry.get("source") or "tianocore-docs"),
                file_,
                entry.get("chapter"),
                from_map=False,
            ))
        confounders = []
        for entry in group.get("confounders") or []:
            file_ = str(entry.get("file") or "").replace("\\", "/")
            if not file_:
                continue
            confounders.append({
                "source": str(entry.get("source") or "tianocore-docs"),
                "file": file_,
                "canonical": entry.get("canonical") or "",
            })
        related = group.get("related_question_txt") or []
        if isinstance(related, str):
            related = [related]
        for query in group.get("queries") or []:
            disambiguation.append({
                "id": group["id"],
                "question_no": None,
                "query": query,
                "kind": "disambiguation",
                "tags": ["near-alias", "disambiguation"],
                "compiled_wiki_id": group.get("compiled_wiki_id"),
                "related_question_txt": related,
                "expected": expected,
                "confounders": confounders,
                "distinguishes_from": [c["file"] for c in confounders],
                "unmapped": not expected,
            })
    return {
        "question_txt": question_items,
        "disambiguation": disambiguation,
        "unmapped": unmapped,
    }


def _iter_fields(item: Any) -> Iterable[Tuple[str, str]]:
    if isinstance(item, str):
        yield "citation", item
        return
    if not isinstance(item, dict):
        return
    for key in ("file", "path", "url", "title", "citation", "ref",
                "section", "heading", "chapter"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            yield key, value
    source_paths = item.get("source_paths", item.get("source_path"))
    if isinstance(source_paths, dict):
        source_paths = [source_paths]
    if isinstance(source_paths, list):
        for entry in source_paths:
            if isinstance(entry, str) and entry.strip():
                yield "file", entry
            elif isinstance(entry, dict):
                file_ = entry.get("file")
                if isinstance(file_, str) and file_.strip():
                    yield "file", file_


def _candidate_paths(item: Any) -> List[str]:
    paths: List[str] = []
    for kind, value in _iter_fields(item):
        if kind in ("section", "heading", "chapter"):
            continue
        text = value.replace("\\", "/")
        left = re.split(r"\s+>\s+|\s+-\s+", text, maxsplit=1)[0]
        paths.append(left)
        paths.append(text)
    return paths


def _path_variants(gold_file: str) -> List[str]:
    gold = gold_file.replace("\\", "/").lstrip("./").lower()
    variants = [gold]
    if gold.endswith(".md"):
        variants.append(gold[:-3] + ".html")
    elif gold.endswith(".html"):
        variants.append(gold[:-5] + ".md")
    return variants


def _bounded_suffix(blob: str, gold: str) -> bool:
    if blob == gold:
        return True
    return blob.endswith("/" + gold)


def file_matches(gold_file: str, item: Any) -> bool:
    """True when a retrieved citation refers to this gold ``file``.

    Full relative-path suffix (``.md``/``.html``) is enough. A bare basename
    matches only when it is not a generic page name (``README.md``,
    ``overview.md``, …); those need the parent directory as well, so two
    different README pages do not count as each other.
    """
    variants = _path_variants(gold_file)
    base_variants = [_basename(v) for v in variants]
    generic = base_variants[0] in GENERIC_BASES
    parts = variants[0].split("/")
    parent = parts[-2] if len(parts) >= 2 else ""
    for raw in _candidate_paths(item):
        blob = raw.lower()
        blob = re.sub(r"^[a-z][a-z0-9+.-]*://", "", blob)
        blob = blob.split("?", 1)[0].split("#", 1)[0]
        blob = re.sub(r"^[^/\s]*tianocore\.org/", "", blob)
        for gold in variants:
            if _bounded_suffix(blob, gold):
                return True
        tokens = re.findall(
            r"[a-z0-9_.@\-\[\]]+(?:/[a-z0-9_.@\-\[\]]+)*", blob)
        for token in tokens:
            base = token.split("/")[-1]
            if base not in base_variants:
                continue
            if not generic:
                return True
            if parent and parent in token.split("/"):
                return True
    return False


def section_text(item: Any) -> str:
    if isinstance(item, str):
        parts = re.split(r"\s+>\s+|\s+-\s+", item.replace("\\", "/"), maxsplit=1)
        return parts[1] if len(parts) == 2 else ""
    if not isinstance(item, dict):
        return ""
    chunks: List[str] = []
    for key in ("section", "heading", "chapter"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            chunks.append(value)
    for key in ("citation", "ref"):
        value = item.get(key)
        if not isinstance(value, str) or not value.strip():
            continue
        parts = re.split(r"\s+>\s+|\s+-\s+", value, maxsplit=1)
        chunks.append(parts[1] if len(parts) == 2 else value)
    return "\n".join(chunks)


def _phrase_in(phrase: str, text: str) -> bool:
    if phrase == "__WHOLE_PAGE__":
        return True
    needle = _loose(phrase)
    hay = _loose(text)
    if needle.endswith("表"):
        needle = needle[:-1].strip()
    if len(needle) < 4 or not hay:
        return False
    compact_needle = needle.replace(" ", "")
    compact_hay = hay.replace(" ", "")
    return needle in hay or compact_needle in compact_hay


def _number_in(number: str, text: str) -> bool:
    pattern = re.escape(number.lower())
    return re.search(rf"(?<![\w.]){pattern}(?![\d.])", text.lower()) is not None


def _range_in(alias: str, text: str) -> bool:
    match = _RANGE_RE.fullmatch(alias.strip())
    if not match:
        return False
    major_a, minor_a, major_b, minor_b = (int(g) for g in match.groups())
    if major_a != major_b or minor_b < minor_a:
        return False
    for minor in range(minor_a, minor_b + 1):
        if _number_in(f"{major_a}.{minor}", text):
            return True
    return False


def group_matches(aliases: Sequence[str], text: str, phrase_only: bool) -> bool:
    """Section group hits when any alias matches.

    Mapped RST gold is phrase-only: PDF section numbers such as ``7.4.6`` or
    ``I-6.7`` are assigned at PDF build time and are not a hit by themselves.
    """
    if any(alias == "__WHOLE_PAGE__" for alias in aliases):
        return True
    if not text:
        return False
    for alias in aliases:
        if _phrase_in(alias, text):
            return True
        if phrase_only:
            continue
        if _range_in(alias, text):
            return True
        for number in _NUM_RE.findall(alias):
            if _number_in(number, text):
                return True
    return False


def _matches_any(entries: Sequence[Dict[str, Any]], item: Any) -> bool:
    return any(file_matches(entry["file"], item) for entry in entries)


def score_item(item: Dict[str, Any], retrieved: Sequence[Any],
               ks: Sequence[int] = KS) -> Dict[str, Any]:
    retrieved = list(retrieved or [])
    gold = item.get("expected") or []
    confounders = item.get("confounders") or []
    limit = max(ks) if ks else 0
    window = retrieved[:limit]
    file_ranks: List[List[int]] = [[] for _ in gold]
    section_ranks: Dict[Tuple[int, int], List[int]] = {}
    false_ranks: List[int] = []
    for rank, hit in enumerate(window):
        # A confounder is a false recall even when it shares a generic basename
        # with some other page. It is not a gold hit.
        if confounders and _matches_any(confounders, hit):
            false_ranks.append(rank)
            continue
        sec = section_text(hit)
        for index, entry in enumerate(gold):
            if not file_matches(entry["file"], hit):
                continue
            file_ranks[index].append(rank)
            for section_index, group in enumerate(entry.get("section_groups") or []):
                if group_matches(group, sec, phrase_only=bool(entry.get("from_map"))):
                    section_ranks.setdefault((index, section_index), []).append(rank)
    section_total = sum(len(entry.get("section_groups") or []) for entry in gold)
    per_k = {}
    for k in ks:
        file_hits = sum(1 for ranks in file_ranks if any(r < k for r in ranks))
        section_hits = sum(
            1 for ranks in section_ranks.values() if any(r < k for r in ranks))
        per_k[k] = {
            "file_hits": file_hits,
            "section_hits": section_hits,
            "false_positive": any(r < k for r in false_ranks),
        }
    return {
        "id": item.get("id"),
        "query": item.get("query"),
        "kind": item.get("kind"),
        "question_no": item.get("question_no"),
        "tags": list(item.get("tags") or []),
        "gold_files": len(gold),
        "gold_file_list": [entry["file"] for entry in gold],
        "section_atoms": section_total,
        "has_confounders": bool(confounders),
        "distinguishes_from": list(item.get("distinguishes_from") or []),
        "top1_false_positive": bool(false_ranks) and false_ranks[0] == 0,
        "per_k": per_k,
        "unmapped": bool(item.get("unmapped")),
    }


def _norm_query(text: str) -> str:
    return _WS_RE.sub(" ", str(text or "").strip().lower())


def index_retrievals(data: Any) -> Dict[str, List[Any]]:
    """Index a recorded retrieval file by id and by query text.

    Accepted shapes:
    - ``{"rows": [{"question"|"query", "results"}]}`` (run_web_eval output)
    - ``[{"id", "query", "results"|"retrieved"|"citations"}]``
    - ``{id or query: [hits]}``
    - ``{id: {query: [hits]}}``
    """
    if isinstance(data, dict) and isinstance(data.get("rows"), list):
        data = data["rows"]
    elif isinstance(data, dict) and isinstance(data.get("items"), list):
        data = data["items"]

    out: Dict[str, List[Any]] = {}

    def _store(id_: str, query: str, records: Any) -> None:
        records = list(records or [])
        if id_:
            out.setdefault("id:" + id_, records)
        if query:
            out["query:" + _norm_query(query)] = records
            if id_:
                out[f"idq:{id_}:{_norm_query(query)}"] = records

    if isinstance(data, list):
        for row in data:
            if not isinstance(row, dict):
                continue
            records = (row.get("results") or row.get("retrieved")
                       or row.get("citations") or [])
            _store(str(row.get("id") or ""),
                   str(row.get("query") or row.get("question") or ""),
                   records)
        return out
    if isinstance(data, dict):
        for key, value in data.items():
            if key in ("schema", "notes"):
                continue
            if isinstance(value, list):
                _store(str(key), str(key), value)
            elif isinstance(value, dict):
                nested = (value.get("results") or value.get("retrieved")
                          or value.get("citations"))
                if isinstance(nested, list):
                    _store(str(key), str(value.get("query") or value.get("question") or ""),
                           nested)
                else:
                    for query, records in value.items():
                        if isinstance(records, list):
                            _store(str(key), str(query), records)
        return out
    raise ValueError("retrieval file must be a JSON object or list")


def lookup_retrievals(index: Dict[str, List[Any]], item: Dict[str, Any]) -> Optional[List[Any]]:
    id_ = str(item.get("id") or "")
    query = _norm_query(item.get("query") or "")
    if id_ and query:
        specific = index.get(f"idq:{id_}:{query}")
        if specific is not None:
            return specific
    if query and ("query:" + query) in index:
        return index["query:" + query]
    if id_ and ("id:" + id_) in index:
        return index["id:" + id_]
    return None


def _aggregate(rows: Sequence[Dict[str, Any]], ks: Sequence[int]) -> Dict[str, Any]:
    scored = [row for row in rows if not row.get("unmapped") and row.get("gold_files")]
    metrics: Dict[str, Any] = {"n": len(scored), "queries": len(rows)}
    for k in ks:
        files = hits = sections = section_hits = 0
        false_n = false_hits = top1 = 0
        query_hits = 0
        for row in scored:
            files += row["gold_files"]
            hits += row["per_k"][k]["file_hits"]
            sections += row["section_atoms"]
            section_hits += row["per_k"][k]["section_hits"]
            if row["gold_files"] and row["per_k"][k]["file_hits"] > 0:
                query_hits += 1
            if row["has_confounders"]:
                false_n += 1
                if row["per_k"][k]["false_positive"]:
                    false_hits += 1
                if k == ks[0] and row["top1_false_positive"]:
                    top1 += 1
        metrics[f"file_hit@{k}"] = (hits / files) if files else None
        metrics[f"file_hits@{k}"] = hits
        metrics[f"file_total@{k}"] = files
        metrics[f"section_hit@{k}"] = (section_hits / sections) if sections else None
        metrics[f"section_hits@{k}"] = section_hits
        metrics[f"section_total@{k}"] = sections
        metrics[f"query_hit@{k}"] = (query_hits / len(scored)) if scored else None
        metrics[f"false_recall@{k}"] = (false_hits / false_n) if false_n else None
        metrics[f"false_recall_n@{k}"] = false_n
        if k == ks[0]:
            metrics["top1_false_recall"] = (top1 / false_n) if false_n else None
    return metrics


def score_set(items: Sequence[Dict[str, Any]],
              retrieval_index: Dict[str, List[Any]],
              missing_as_empty: bool,
              ks: Sequence[int] = KS) -> List[Dict[str, Any]]:
    rows = []
    for item in items:
        found = lookup_retrievals(retrieval_index, item)
        if found is None and not missing_as_empty:
            continue
        row = score_item(item, found or [], ks)
        row["recorded"] = found is not None
        rows.append(row)
    return rows


def evaluate(retrievals: Any, include_additions: bool = False,
             missing_as_empty: bool = False,
             ks: Sequence[int] = KS,
             document: Optional[Dict[str, Any]] = None,
             file_map: Optional[Dict[int, List[Dict[str, Any]]]] = None
             ) -> Dict[str, Any]:
    eval_set = build_eval_set(document, file_map, include_additions)
    index = index_retrievals(retrievals)
    question_rows = score_set(
        eval_set["question_txt"], index, missing_as_empty, ks)
    near_rows = [row for row in question_rows if "near-alias" in row["tags"]]
    disambig_rows = score_set(
        eval_set["disambiguation"], index, missing_as_empty, ks)
    return {
        "question_txt": {
            "metrics": _aggregate(question_rows, ks),
            "per_item": question_rows,
        },
        "near_alias": {
            "metrics": _aggregate(near_rows, ks),
            "per_item": near_rows,
        },
        "disambiguation": {
            "metrics": _aggregate(disambig_rows, ks),
            "per_item": disambig_rows,
        },
        "unmapped": list(eval_set["unmapped"]),
        "include_additions": include_additions,
    }


def _fmt_rate(value: Optional[float]) -> str:
    if value is None:
        return "n/a"
    return f"{100.0 * value:.1f}%"


def _block(title: str, metrics: Dict[str, Any], ks: Sequence[int]) -> List[str]:
    lines = [f"## {title}", ""]
    lines.append(f"scored={metrics.get('n', 0)} queries={metrics.get('queries', 0)}")
    for k in ks:
        lines.append(
            f"file_hit@{k} {_fmt_rate(metrics.get(f'file_hit@{k}'))} "
            f"({metrics.get(f'file_hits@{k}', 0)}/{metrics.get(f'file_total@{k}', 0)})"
            f"  section_hit@{k} {_fmt_rate(metrics.get(f'section_hit@{k}'))} "
            f"({metrics.get(f'section_hits@{k}', 0)}/{metrics.get(f'section_total@{k}', 0)})"
            f"  query_hit@{k} {_fmt_rate(metrics.get(f'query_hit@{k}'))}"
        )
    for k in ks:
        lines.append(
            f"false_recall@{k} {_fmt_rate(metrics.get(f'false_recall@{k}'))} "
            f"(confounder in top {k}; not a gold hit; "
            f"n={metrics.get(f'false_recall_n@{k}', 0)})"
        )
    lines.append(
        "top1_false_recall "
        f"{_fmt_rate(metrics.get('top1_false_recall'))} "
        "(rank-1 hit is a confounder / distinguishes_from path)"
    )
    lines.append("")
    return lines


def render_report(result: Dict[str, Any], ks: Sequence[int] = KS) -> str:
    lines = ["# Gold source / section recall", ""]
    if result.get("include_additions"):
        lines.append("suggested_additions: included as extra gold (not a replacement)")
    else:
        lines.append("suggested_additions: off (default scoring)")
    unmapped = result.get("unmapped") or []
    if unmapped:
        lines.append(
            "unmapped spec (PDF name is not a gold file, no verified RST map): "
            + ", ".join(unmapped)
        )
    lines.append("")
    lines.extend(_block("question.txt overall", result["question_txt"]["metrics"], ks))
    lines.extend(_block(
        "near-alias question.txt (Q27 PPI/HOB, Q28 Boot/Runtime, Q29 TPL, "
        "Q31 Events, Q35 Secure Boot)",
        result["near_alias"]["metrics"], ks))
    lines.extend(_block(
        "disambiguation near-alias (confounder = false recall)",
        result["disambiguation"]["metrics"], ks))
    misses = []
    for block in ("question_txt", "disambiguation"):
        for row in result[block]["per_item"]:
            if row.get("unmapped") or not row.get("gold_files"):
                continue
            hit5 = row["per_k"].get(5, {}).get("file_hits", 0)
            if hit5 < row["gold_files"] or row["per_k"].get(5, {}).get("false_positive"):
                label = row["id"]
                if row.get("question_no"):
                    label = f"Q{row['question_no']} {label}"
                misses.append(
                    f"- {label}: file_hit@5 {hit5}/{row['gold_files']}"
                    f" section {row['per_k'].get(5, {}).get('section_hits', 0)}"
                    f"/{row['section_atoms']}"
                    + (" false_recall@5" if row["per_k"].get(5, {}).get("false_positive")
                       else "")
                )
    if misses:
        lines.append("## Gaps at hit@5")
        lines.append("")
        lines.extend(misses)
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def gold_recall_note_for_judge_rows(rows: Sequence[Dict[str, Any]]) -> str:
    """Additive note for the LLM-judge report. Does not call the network."""
    queries = {_norm_query(r.get("question") or r.get("query") or "")
               for r in rows}
    try:
        eval_set = build_eval_set()
    except OSError:
        return ""
    gold_queries = {_norm_query(item["query"])
                    for item in eval_set["question_txt"] + eval_set["disambiguation"]}
    overlap = queries & gold_queries
    if not overlap:
        return (
            "\n## Gold source recall\n\n"
            "The 18 judge questions do not overlap the gold set, so this run "
            "does not change judge scores. Score a recorded retrieval list with "
            "`python edk2-kb/eval/run_web_eval.py --gold-recall "
            "--retrievals recorded.json`.\n"
        )
    result = evaluate(list(rows), missing_as_empty=False)
    return "\n" + render_report(result)


def run_gold_recall(argv: Optional[Sequence[str]] = None,
                    args: Optional[argparse.Namespace] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--retrievals", required=False, default="",
                        help="JSON file of recorded retrieval/citation lists")
    parser.add_argument("--gold", default=str(GOLD_JSON),
                        help="gold_source_chapters.json path")
    parser.add_argument("--file-map", default=str(FILE_MAP),
                        help="kb_file_map_q27_q35.md path")
    parser.add_argument("--include-additions", action="store_true",
                        help="count suggested_additions as extra gold")
    parser.add_argument("--missing-as-empty", action="store_true",
                        help="questions absent from the retrieval file score as misses")
    parser.add_argument("--json-out", default="",
                        help="optional path for the metrics JSON")
    parser.add_argument("--report", default="",
                        help="optional path for the markdown report")
    if args is None:
        args = parser.parse_args(argv)
    if not args.retrievals:
        print("pass --retrievals recorded.json (no live index or LLM is used)",
              file=sys.stderr)
        return 2
    document = load_gold_document(Path(args.gold))
    file_map = load_kb_file_map(Path(args.file_map))
    retrievals = json.loads(Path(args.retrievals).read_text(encoding="utf-8"))
    result = evaluate(
        retrievals,
        include_additions=bool(args.include_additions),
        missing_as_empty=bool(args.missing_as_empty),
        document=document,
        file_map=file_map,
    )
    report = render_report(result)
    sys.stdout.write(report)
    if args.report:
        Path(args.report).write_text(report, encoding="utf-8")
    if args.json_out:
        Path(args.json_out).write_text(
            json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    return 0


def main() -> None:
    sys.exit(run_gold_recall())


if __name__ == "__main__":
    main()
