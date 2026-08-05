#!/usr/bin/env python
"""Build the EDK2 KB evaluation set.

Produces ``edk2_eval_set.json``: a list of ``{query, expected: [{source,
file_or_title}]}`` entries. Two subsets are combined:

- *auto*: document-title queries. For every doc the title (or file basename)
  is used as the query and the doc itself as the expected answer. A fixed
  random seed keeps the sample reproducible. These measure retrieval recall
  on exact-title style questions.
- *manual*: hand-labeled real EDK2 questions. Each maps to the spec section
  or wiki page that actually answers it. These measure answer accuracy on
  the questions users actually ask.

Run:
    python edk2-kb/eval/build_eval_set.py --data-dir <kb>/data

Output is written next to this script unless --out is given.
"""
import argparse
import json
import random
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from search_engine import SearchEngine  # noqa: E402

from manual_extended import EXTENDED_MANUAL  # noqa: E402

WIKI_SUFFIX_RE = re.compile(r"\s*-\s*TianoCore\s+EDK\s+II\s+Documentation\s*$")
NOISE_RE = re.compile(r"(README|SUMMARY|FIGURES|glossary|references)", re.I)

# Manual labels: real EDK2 questions -> the document that answers them.
# identifier is the metadata `file` for tianocore-docs, the `title` for
# tianocore-wiki.
MANUAL = [
    {"query": "How do I configure DebugLib to control debug message output level",
     "expected": [{"source": "tianocore-docs",
                   "file_or_title": r"edk2-UefiDriverWritersGuide\31_testing_and_debugging_uefi_drivers\314_debugging_code_statements\3141_configuring_debuglib_with_edk_ii.md"}]},
    {"query": "PcdDebugPrintErrorLevel controls which debug messages are printed",
     "expected": [{"source": "tianocore-docs",
                   "file_or_title": r"edk2-UefiDriverWritersGuide\31_testing_and_debugging_uefi_drivers\314_debugging_code_statements\3141_configuring_debuglib_with_edk_ii.md"}]},
    {"query": "SetVariable with NV attributes must not trust pointers from flash",
     "expected": [{"source": "tianocore-docs",
                   "file_or_title": r"EDK_II_Secure_Coding_Guide\secure_coding_guidelines_general.md"}]},
    {"query": "What is the control flow from power-on to OS boot in UEFI",
     "expected": [{"source": "tianocore-wiki",
                   "file_or_title": "UEFI Pi FAQ - TianoCore EDK II Documentation"}]},
    {"query": "INF file [Pcds] section syntax and entry formats",
     "expected": [{"source": "tianocore-docs",
                   "file_or_title": r"edk2-InfSpecification\3_edk_ii_inf_file_format\38_pcd_sections.md"}]},
    {"query": "DSC file [Components] section module types and processing",
     "expected": [{"source": "tianocore-docs",
                   "file_or_title": r"edk2-DscSpecification\3_edk_ii_dsc_file_format\310_[components]_sections.md"}]},
    {"query": "edk2 build command line options -a -p -b and usage",
     "expected": [{"source": "tianocore-docs",
                   "file_or_title": r"edk2-BuildSpecification\appendix_d_buildexe_command\d4_usage.md"}]},
    {"query": "FDF file [FD] section flash device layout",
     "expected": [{"source": "tianocore-docs",
                   "file_or_title": r"edk2-FdfSpecification\3_edk_ii_fdf_file_format\35_[fd]_sections.md"}]},
    {"query": "SMM communication buffer checking TOCTOU issue",
     "expected": [{"source": "tianocore-docs",
                   "file_or_title": r"SecurityAdvisory\smmcore_comm_buffer_check_has_toctou_issue.md"}]},
    {"query": "How to enable stack canary stack check in EDK2",
     "expected": [{"source": "tianocore-docs",
                   "file_or_title": r"ATBB-Mitigate_Buffer_Overflow_in_UEFI\stack_canaries\enable_stack_check_in_edkii.md"}]},
    {"query": "Capsule update image generation during the build",
     "expected": [{"source": "tianocore-docs",
                   "file_or_title": r"edk2-BuildSpecification\11_post-build_imagegen_stage_-_other\113_capsules.md"}]},
    {"query": "Boot failure related to TPM measurements",
     "expected": [{"source": "tianocore-docs",
                   "file_or_title": r"SecurityAdvisory\boot_failure_related_to_tpm_measurements.md"}]},
    {"query": "Buffer overflow in variable reclaim during SetVariable",
     "expected": [{"source": "tianocore-docs",
                   "file_or_title": r"SecurityAdvisory\buffer_overflow_in_variable_reclaim.md"}]},
    {"query": "Adding strings and forms to a driver HII page",
     "expected": [{"source": "tianocore-docs",
                   "file_or_title": r"UEFI_Driver_HII_Win_Lab_Guide\uefi_driver_wizard__adding_hii\1_adding_strings_and_forms_to_setup_hii_for_user_c.md"}]},
    {"query": "How to build OVMF firmware",
     "expected": [{"source": "tianocore-wiki",
                   "file_or_title": "How to Build OVMF - TianoCore EDK II Documentation"}]},
    {"query": "How to debug OVMF with QEMU using gdb",
     "expected": [{"source": "tianocore-wiki",
                   "file_or_title": "How to Debug OVMF with QEMU Using Gdb - TianoCore EDK II Documentation"}]},
    {"query": "Serial output for EDK2 debug messages and PCDs to configure DebugLib",
     "expected": [{"source": "tianocore-wiki",
                   "file_or_title": "EDK II Debugging - TianoCore EDK II Documentation"}]},
    {"query": "Modify PCD setting to allow HTTP connections for boot",
     "expected": [{"source": "tianocore-docs",
                   "file_or_title": r"EDKIIHttpBootGettingStartedGuide\enable_http_boot_for_your_system\modify_pcd_setting_to_allow_http_connections.md"}]},
    {"query": "Introduction to the UEFI secure boot chain",
     "expected": [{"source": "tianocore-docs",
                   "file_or_title": r"Understanding_UEFI_Secure_Boot_Chain\introduction-to-the-secure-boot-chain.md"}]},
    {"query": "EDK2 C coding standards identifier naming conventions",
     "expected": [{"source": "tianocore-docs",
                   "file_or_title": r"edk2-CCodingStandardsSpecification\4_naming_conventions\44_identifiers.md"}]},
]

# Hand-labeled set = the original 20 + the extended set (see manual_extended.py).
MANUAL = MANUAL + EXTENDED_MANUAL


def title_query(title: str) -> str:
    s = WIKI_SUFFIX_RE.sub("", title).strip()
    return s or title


def basename_query(file_: str) -> str:
    stem = Path(file_).stem
    return re.sub(r"[_\-]+", " ", stem).strip()


def build(data_dir, auto_n: int) -> list:
    engine = SearchEngine(data_dir=data_dir, preload=True)
    engine.ensure_ready(timeout=300)
    metas = engine._collection.get(include=["metadatas"])["metadatas"]

    docs = {}
    for m in metas:
        source = m.get("source", "")
        ident = m.get("file") or m.get("title") or ""
        docs[(source, ident)] = m

    # ---- auto subset: title/basename queries -------------------------- #
    auto = []
    for (source, ident), m in docs.items():
        if NOISE_RE.search(ident):
            continue
        if source == "tianocore-wiki":
            query = title_query(m.get("title") or ident)
        else:
            query = basename_query(ident)
        if len(query.split()) < 2:
            continue
        auto.append({"query": query,
                     "expected": [{"source": source,
                                   "file_or_title": ident}]})

    rng = random.Random(42)
    rng.shuffle(auto)
    auto = auto[:auto_n]

    # Tag every entry with its subset so downstream scripts can group by
    # kind instead of by position (manual grew past the old fixed 20).
    for x in auto:
        x["kind"] = "auto"
    for x in MANUAL:
        x.setdefault("kind", "manual")

    # ---- validate manual labels exist --------------------------------- #
    known = set(docs)
    missing = [e for entry in MANUAL for e in entry["expected"]
               if (e["source"], e["file_or_title"]) not in known]
    if missing:
        print("WARNING: manual labels not found in index:")
        for e in missing:
            print("  ", e)

    return auto + MANUAL


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=None,
                    help="KB data dir (default: engine default)")
    ap.add_argument("--out", default=None)
    ap.add_argument("--auto-n", type=int, default=200)
    args = ap.parse_args()

    entries = build(Path(args.data_dir) if args.data_dir else None,
                    args.auto_n)
    out = Path(args.out) if args.out else Path(__file__).resolve().parent / "edk2_eval_set.json"
    out.write_text(json.dumps(entries, indent=2, ensure_ascii=False),
                   encoding="utf-8")
    n_auto = len(entries) - len(MANUAL)
    print(f"wrote {out}")
    print(f"  auto: {n_auto} title queries, manual: {len(MANUAL)} labeled")
    print(f"  total: {len(entries)}")


if __name__ == "__main__":
    main()
