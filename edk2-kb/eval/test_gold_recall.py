#!/usr/bin/env python3
"""Gold-recall tests. No LLM, no knowledge-base index, no web server."""

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import gold_recall  # noqa: E402

GOLD_SHA256 = "6f5eeb28fb1882b3b45343103ed20e833821a0dcb4e023ceebc0f6da22e103d0"
MAP_SHA256 = "f4190dc61aeb5ab83547739194b4aaf158ee1106ce636b94ab303c6152301894"
BANNED_PDFS = {
    "UEFI_Spec_Final_2.11.pdf",
    "PI_Spec_1_8_A_final_2024.03.05.pdf",
}
Q27_FILES = [
    "PI_1.10/source/V1_Overview.rst",
    "PI_1.10/source/V1_PEIMs.rst",
    "PI_1.10/source/V1_PEI_Services_Table.rst",
    "PI_1.10/source/V1_Services_PEI.rst",
]
Q28_FILES = [
    "UEFI_2.11/source/07_Services_Boot_Services.rst",
    "UEFI_2.11/source/08_Services_Runtime_Services.rst",
    "UEFI_2.11/source/02_Overview.rst",
]
Q29_FILES = ["UEFI_2.11/source/07_Services_Boot_Services.rst"]
Q35_FILES = [
    "Understanding_UEFI_Secure_Boot_Chain/overview.md",
    "Understanding_UEFI_Secure_Boot_Chain/introduction-to-the-secure-boot-chain.md",
    "Understanding_UEFI_Secure_Boot_Chain/secure_boot_chain_in_uefi/uefi_secure_boot.md",
]
DRIVER_GOLD = [
    "edk2-UefiDriverWritersGuide/9_driver_binding_protocol/91_driver_binding_protocol_implementations.md",
    "edk2-UefiDriverWritersGuide/3_foundation/314_uefi_driver_model_connection_process/3141_connectcontroller.md",
    "edk2-UefiDriverWritersGuide/3_foundation/314_uefi_driver_model_connection_process/3142_loading_uefi_option_rom_drivers.md",
]
DRIVER_CONFUSERS = [
    "edk2-UefiDriverWritersGuide/16_driver_supported_efi_version_protocol/README.md",
    "edk2-UefiDriverWritersGuide/16_driver_supported_efi_version_protocol/161_driver_supported_efi_version_protocol_implemen.md",
    "edk2-UefiDriverWritersGuide/7_driver_entry_point/73_adding_the_driver_supported_efi_version_protoco.md",
]
BOOT_FLOW = "development/design-architecture/pi_boot_flow.md"
PPI_EXTRA = "edk2-ModuleWriteGuide/7_pre-efi_initialization_modules/75_communicate_between_peim_modules.md"


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _item(eval_set, question_no):
    return next(item for item in eval_set["question_txt"]
                if item["question_no"] == question_no)


def _files(item):
    return [entry["file"] for entry in item["expected"]]


class GoldSetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = gold_recall.load_gold_document()
        cls.file_map = gold_recall.load_kb_file_map()
        cls.eval_set = gold_recall.build_eval_set(cls.doc, cls.file_map)

    def test_official_bytes_unchanged(self):
        self.assertEqual(_sha256(gold_recall.GOLD_JSON), GOLD_SHA256)
        self.assertEqual(_sha256(gold_recall.FILE_MAP), MAP_SHA256)
        self.assertEqual(gold_recall.FILE_MAP.stat().st_size, 2691)
        self.assertEqual(self.doc["schema"], "edk2-gold-source-chapters/v1")

    def test_counts(self):
        self.assertEqual(len(self.doc["question_txt"]), 35)
        self.assertEqual(len(self.doc["disambiguation"]), 7)
        self.assertEqual(
            sum(len(group["queries"]) for group in self.doc["disambiguation"]),
            15)
        self.assertEqual(len(self.eval_set["disambiguation"]), 15)

    def test_question_numbers_match_topics(self):
        self.assertIn("PPI", _item(self.eval_set, 27)["query"])
        self.assertIn("HOB", _item(self.eval_set, 27)["query"])
        self.assertIn("Boot Services", _item(self.eval_set, 28)["query"])
        self.assertIn("TPL", _item(self.eval_set, 29)["query"])
        self.assertIn("Secure Boot", _item(self.eval_set, 35)["query"])
        self.assertEqual(_item(self.eval_set, 27)["id"], "qtest-Q26")
        self.assertEqual(_item(self.eval_set, 31)["id"], "qtest-Q30")
        self.assertEqual(_item(self.eval_set, 35)["id"], "qtest-Q34")

    def test_mapped_rst_replaces_pdf_and_wiki(self):
        q27 = _item(self.eval_set, 27)
        q28 = _item(self.eval_set, 28)
        q29 = _item(self.eval_set, 29)
        q35 = _item(self.eval_set, 35)
        self.assertEqual(_files(q27), Q27_FILES)
        self.assertEqual(_files(q28), Q28_FILES)
        self.assertEqual(_files(q29), Q29_FILES)
        self.assertEqual(_files(q35), Q35_FILES)
        for item in (q27, q28, q29):
            for entry in item["expected"]:
                self.assertEqual(entry["source"], "uefi-specs")
                self.assertTrue(entry["from_map"])
                self.assertTrue(entry["file"].endswith(".rst"))
        for item in self.eval_set["question_txt"]:
            for file_ in _files(item):
                self.assertNotIn(Path(file_).name, BANNED_PDFS)
        for item in (q27, q28):
            self.assertNotIn(BOOT_FLOW, _files(item))
        # The boot-flow question itself still cites the wiki page.
        self.assertIn(BOOT_FLOW, _files(_item(self.eval_set, 26)))

    def test_q35_intro_is_gold_not_confounder(self):
        q35 = _item(self.eval_set, 35)
        self.assertEqual(q35["confounders"], [])
        self.assertIn(
            "Understanding_UEFI_Secure_Boot_Chain/introduction-to-the-secure-boot-chain.md",
            _files(q35))
        guard = [
            item for item in self.eval_set["disambiguation"]
            if item["id"] == "disambig-secure-boot-vs-boot-guard"
        ]
        self.assertEqual(len(guard), 2)
        conf = guard[0]["distinguishes_from"]
        self.assertEqual(conf, [
            "Understanding_UEFI_Secure_Boot_Chain/secure_boot_chain_in_uefi/intel_boot_guard.md",
        ])
        self.assertNotIn(
            "Understanding_UEFI_Secure_Boot_Chain/introduction-to-the-secure-boot-chain.md",
            conf)
        self.assertNotIn(
            "Understanding_UEFI_Secure_Boot_Chain/overview.md", conf)

    def test_near_alias_tags(self):
        tagged = [item["question_no"] for item in self.eval_set["question_txt"]
                  if "near-alias" in item["tags"]]
        self.assertEqual(tagged, [27, 28, 29, 31, 35])

    def test_pdf_only_question_is_unmapped_not_invented(self):
        memory = _item(self.eval_set, 30)
        self.assertEqual(memory["id"], "qtest-Q29")
        self.assertTrue(memory["unmapped"])
        self.assertEqual(memory["expected"], [])
        self.assertEqual(self.eval_set["unmapped"], ["qtest-Q29"])
        # Events keeps the markdown R path; the PDF is not gold and no RST is invented.
        events = _item(self.eval_set, 31)
        self.assertEqual(_files(events), [
            "edk2-ModuleWriteGuide/8_dxe_drivers_non-uefi_drivers/87_handler_for_evtsignal_exit_boot_services.md",
        ])
        blob = json.dumps(self.eval_set["question_txt"])
        self.assertNotIn("uefi-specs/", blob.lower().replace("uefi_2.11/source", "UEFI_KEEP"))
        # The only uefi-specs paths are the mapped ones.
        specs = [file_ for item in self.eval_set["question_txt"]
                 for file_ in _files(item) if file_.endswith(".rst")]
        self.assertEqual(sorted(specs), sorted(Q27_FILES + Q28_FILES + Q29_FILES))

    def test_additions_are_extra(self):
        q27 = _item(self.eval_set, 27)
        self.assertNotIn(PPI_EXTRA, _files(q27))
        with_extra = gold_recall.build_eval_set(
            self.doc, self.file_map, include_additions=True)
        files = _files(_item(with_extra, 27))
        self.assertEqual(files[:4], Q27_FILES)
        self.assertIn(PPI_EXTRA, files)

    def test_driver_binding_paths(self):
        rows = [item for item in self.eval_set["disambiguation"]
                if item["id"] == "disambig-driver-binding-version"]
        self.assertEqual(len(rows), 3)
        self.assertEqual(_files(rows[0]), DRIVER_GOLD)
        self.assertEqual(rows[0]["distinguishes_from"], DRIVER_CONFUSERS)
        self.assertIn("uefi driver binding version 可以用来做什么",
                      [item["query"] for item in rows])

    def test_map_section_phrases_drop_pdf_numbers(self):
        groups = {entry["file"]: entry["section_groups"]
                  for entry in _item(self.eval_set, 28)["expected"]}
        boot = groups["UEFI_2.11/source/07_Services_Boot_Services.rst"]
        flat = [phrase for group in boot for phrase in group]
        self.assertIn("ExitBootServices()", flat)
        self.assertIn("efi-boot-services-exitbootservices", flat)
        self.assertNotIn("7.4.6", " ".join(flat))
        overview = groups["UEFI_2.11/source/02_Overview.rst"]
        self.assertEqual(overview, [["Runtime Services"]])
        tpl = _item(self.eval_set, 29)["expected"][0]["section_groups"]
        titles = [group[0] for group in tpl]
        self.assertEqual(titles, ["RaiseTPL()", "RestoreTPL()", "TPL Restrictions 表"])


class ScoringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.eval_set = gold_recall.build_eval_set()

    def _score(self, retrievals, include_additions=False):
        return gold_recall.evaluate(
            retrievals, include_additions=include_additions)

    def test_file_and_section_hit_at_5_and_10(self):
        gold = ("edk2-ModuleWriteGuide/1_the_basics_of_edk_ii/11_overview.md")
        other = ("edk2-ModuleWriteGuide/2_an_edk_ii_package/21_introduction.md")
        filler = {"file": "edk2-DecSpecification/2_dec_file_overview/210_pcd_usage.md",
                  "section": "2.10 PCD Usage"}
        retrievals = {
            "qtest-Q0": [filler] * 5 + [
                {"file": gold, "section": "1.1.1 Module, Package and Platform"},
                {"file": other.replace("/", "\\"),
                 "section": "2.1.3 Package Declaration File"},
            ]
        }
        result = self._score(retrievals)
        row = result["question_txt"]["per_item"][0]
        self.assertEqual(row["id"], "qtest-Q0")
        self.assertEqual(row["per_k"][5]["file_hits"], 0)
        self.assertEqual(row["per_k"][10]["file_hits"], 2)
        self.assertEqual(row["per_k"][5]["section_hits"], 0)
        self.assertEqual(row["per_k"][10]["section_hits"], 2)
        metrics = result["question_txt"]["metrics"]
        self.assertEqual(metrics["n"], 1)
        self.assertEqual(metrics["file_hit@5"], 0)
        self.assertEqual(metrics["file_hit@10"], 1)

    def test_section_number_boundary(self):
        target = "edk2-ModuleWriteGuide/1_the_basics_of_edk_ii/11_overview.md"
        hit = gold_recall.file_matches(target, {
            "file": target,
            "section": "1.1 Overview",
        })
        self.assertTrue(hit)
        item = _item(self.eval_set, 1)
        scored = gold_recall.score_item(item, [{
            "file": target,
            "section": "1.1 Overview",
        }])
        # 1.1 is not 1.1.1 or 1.1.4.
        self.assertEqual(scored["per_k"][5]["file_hits"], 1)
        self.assertEqual(scored["per_k"][5]["section_hits"], 0)
        scored = gold_recall.score_item(item, [{
            "citation": target + " > 1.1.4 Build Infrastructure",
        }])
        self.assertEqual(scored["per_k"][5]["section_hits"], 1)

    def test_wiki_url_and_prefix(self):
        gold = "development/contribution-guides/edk_ii_development_process.md"
        url = ("https://www.tianocore.org/tianocore-wiki.github.io/"
               "development/contribution-guides/edk_ii_development_process.html")
        self.assertTrue(gold_recall.file_matches(gold, {"url": url, "file": ""}))
        self.assertTrue(gold_recall.file_matches(gold, {
            "file": "tianocore-wiki.github.io/" + gold,
            "section": "EDK II Developer Onboarding",
        }))
        # A different wiki page is not a hit.
        self.assertFalse(gold_recall.file_matches(gold, {
            "url": "https://www.tianocore.org/tianocore-wiki.github.io/reference/faqs-glossaries/pcd.html",
        }))

    def test_readme_parent_distinguishes_pages(self):
        boot_readme = "edk2-UefiDriverWritersGuide/5_uefi_services/README.md"
        version_readme = DRIVER_CONFUSERS[0]
        self.assertTrue(gold_recall.file_matches(
            boot_readme, {"file": boot_readme}))
        self.assertFalse(gold_recall.file_matches(
            boot_readme, {"file": version_readme}))
        self.assertFalse(gold_recall.file_matches(
            version_readme, {"file": "SomePkg/README.md", "section": "readme"}))

    def test_q27_rst_hit_pdf_and_wiki_miss(self):
        q27 = _item(self.eval_set, 27)
        rst = {
            "file": "PI_1.10/source/V1_Overview.rst",
            "section": "PEIM-to-PEIM Interfaces (PPIs)",
            "source": "uefi-specs",
        }
        pdf = {"file": "PI_Spec_1_8_A_final_2024.03.05.pdf",
               "section": "I-6.7 PEIM-to-PEIM Interfaces (PPIs)"}
        wiki = {"file": BOOT_FLOW, "section": "PEI Phase"}
        number_only = {"file": "PI_1.10/source/V1_Overview.rst",
                       "section": "I-6.7"}
        scored = gold_recall.score_item(q27, [pdf, wiki, number_only, rst])
        self.assertEqual(scored["per_k"][5]["file_hits"], 1)
        self.assertEqual(scored["per_k"][5]["section_hits"], 1)
        scored = gold_recall.score_item(q27, [number_only])
        self.assertEqual(scored["per_k"][5]["file_hits"], 1)
        self.assertEqual(scored["per_k"][5]["section_hits"], 0)
        self.assertFalse(scored["per_k"][5]["false_positive"])

    def test_q28_function_name_not_pdf_number(self):
        q28 = _item(self.eval_set, 28)
        only_number = {
            "file": "UEFI_2.11/source/07_Services_Boot_Services.rst",
            "section": "7.4.6",
        }
        named = {
            "file": "UEFI_2.11/source/07_Services_Boot_Services.rst",
            "section": "ExitBootServices()",
        }
        anchor = {
            "source_paths": {"file": "UEFI_2.11/source/07_Services_Boot_Services.rst"},
            "section": "efi-boot-services-exitbootservices",
        }
        self.assertEqual(
            gold_recall.score_item(q28, [only_number])["per_k"][5]["section_hits"],
            0)
        self.assertEqual(
            gold_recall.score_item(q28, [named])["per_k"][5]["section_hits"], 1)
        self.assertEqual(
            gold_recall.score_item(q28, [anchor])["per_k"][5]["section_hits"], 1)
        overview_number = {
            "file": "UEFI_2.11/source/02_Overview.rst",
            "section": "2.2.2",
        }
        overview_title = {
            "file": "UEFI_2.11/source/02_Overview.rst",
            "section": "Runtime Services",
        }
        self.assertEqual(
            gold_recall.score_item(q28, [overview_number])["per_k"][5]["section_hits"],
            0)
        self.assertEqual(
            gold_recall.score_item(q28, [overview_title])["per_k"][5]["file_hits"],
            1)
        self.assertGreaterEqual(
            gold_recall.score_item(q28, [overview_title])["per_k"][5]["section_hits"],
            1)

    def test_q29_tpl_sections_share_one_file(self):
        q29 = _item(self.eval_set, 29)
        hits = [
            {"file": "UEFI_2.11/source/07_Services_Boot_Services.rst",
             "section": "RaiseTPL()"},
            {"file": "UEFI_2.11/source/07_Services_Boot_Services.rst",
             "section": "RestoreTPL()"},
            {"file": Q29_FILES[0], "section": "TPL Restrictions"},
        ]
        scored = gold_recall.score_item(q29, hits)
        self.assertEqual(scored["gold_files"], 1)
        self.assertEqual(scored["section_atoms"], 3)
        self.assertEqual(scored["per_k"][5]["file_hits"], 1)
        self.assertEqual(scored["per_k"][5]["section_hits"], 3)
        pdf = {"file": "UEFI_Spec_Final_2.11.pdf", "section": "7.1.8 RaiseTPL()"}
        self.assertEqual(
            gold_recall.score_item(q29, [pdf])["per_k"][5]["file_hits"], 0)

    def test_q35_intro_is_a_hit_and_not_a_false_recall(self):
        q35 = _item(self.eval_set, 35)
        intro = {
            "file": "Understanding_UEFI_Secure_Boot_Chain/introduction-to-the-secure-boot-chain.md",
            "section": "Measured Boot",
        }
        guard = {
            "file": "Understanding_UEFI_Secure_Boot_Chain/secure_boot_chain_in_uefi/intel_boot_guard.md",
        }
        other_overview = {"file": "SomeOtherGuide/overview.md"}
        scored = gold_recall.score_item(q35, [intro, guard, other_overview])
        self.assertEqual(scored["per_k"][5]["file_hits"], 1)
        self.assertFalse(scored["per_k"][5]["false_positive"])
        self.assertFalse(gold_recall.file_matches(Q35_FILES[0], other_overview))

    def test_driver_binding_confounder_is_false_recall(self):
        query = "uefi driver binding version 可以用来做什么"
        wrong_first = {
            query: [
                {"file": DRIVER_CONFUSERS[0], "section": "16.1"},
                {"file": DRIVER_CONFUSERS[1]},
                {"file": DRIVER_GOLD[0], "section": "9.1"},
                {"file": DRIVER_GOLD[1], "section": "3.14.1 ConnectController"},
                {"file": DRIVER_GOLD[2], "section": "3.14.2"},
            ]
        }
        result = self._score(wrong_first)
        row = result["disambiguation"]["per_item"][0]
        self.assertEqual(row["query"], query)
        self.assertEqual(row["per_k"][5]["file_hits"], 3)
        self.assertTrue(row["per_k"][5]["false_positive"])
        self.assertTrue(row["top1_false_positive"])
        self.assertEqual(row["per_k"][5]["section_hits"], 3)
        metrics = result["disambiguation"]["metrics"]
        self.assertEqual(metrics["false_recall@5"], 1)
        self.assertEqual(metrics["file_hit@5"], 1)
        # Confounders alone are not a success, including at rank 1.
        only_wrong = {query: [
            {"file": path} for path in DRIVER_CONFUSERS
        ]}
        missed = self._score(only_wrong)["disambiguation"]["per_item"][0]
        self.assertEqual(missed["per_k"][5]["file_hits"], 0)
        self.assertTrue(missed["top1_false_positive"])
        # Gold beyond rank 5 still counts at hit@10, and the top confounder
        # remains a false recall at both cutoffs.
        buried = {query: (
            [{"file": DRIVER_CONFUSERS[2]}]
            + [{"file": "edk2-UefiDriverWritersGuide/9_driver_binding_protocol/92_driver_binding_protocol_template.md"}] * 5
            + [{"file": path, "section": "9.1"} for path in DRIVER_GOLD]
        )}
        buried_row = self._score(buried)["disambiguation"]["per_item"][0]
        self.assertEqual(buried_row["per_k"][5]["file_hits"], 0)
        self.assertEqual(buried_row["per_k"][10]["file_hits"], 3)
        self.assertTrue(buried_row["per_k"][5]["false_positive"])

    def test_boot_guard_confounder_does_not_apply_to_q35(self):
        intro = "Understanding_UEFI_Secure_Boot_Chain/introduction-to-the-secure-boot-chain.md"
        guard = "Understanding_UEFI_Secure_Boot_Chain/secure_boot_chain_in_uefi/intel_boot_guard.md"
        secure = "Understanding_UEFI_Secure_Boot_Chain/secure_boot_chain_in_uefi/uefi_secure_boot.md"
        result = self._score({
            "qtest-Q34": [{"file": intro}],
            "UEFI Secure Boot 和 Intel Boot Guard 有什么区别": [
                {"file": intro},
                {"file": guard},
            ],
            "Secure Boot 和 Boot Guard 是一回事吗": [{"file": secure}],
        })
        q35 = next(row for row in result["question_txt"]["per_item"]
                   if row["id"] == "qtest-Q34")
        self.assertEqual(q35["per_k"][5]["file_hits"], 1)
        self.assertFalse(q35["per_k"][5]["false_positive"])
        guard_rows = [row for row in result["disambiguation"]["per_item"]
                      if row["id"] == "disambig-secure-boot-vs-boot-guard"]
        self.assertEqual(len(guard_rows), 2)
        by_query = {row["query"]: row for row in guard_rows}
        intro_row = by_query["UEFI Secure Boot 和 Intel Boot Guard 有什么区别"]
        self.assertEqual(intro_row["per_k"][5]["file_hits"], 0)
        self.assertTrue(intro_row["per_k"][5]["false_positive"])
        secure_row = by_query["Secure Boot 和 Boot Guard 是一回事吗"]
        self.assertEqual(secure_row["per_k"][5]["file_hits"], 1)
        self.assertFalse(secure_row["per_k"][5]["false_positive"])

    def test_additions_do_not_replace_rst(self):
        recorded = {"qtest-Q26": [{"file": PPI_EXTRA, "section": "7.5"}]}
        default = self._score(recorded)
        row = next(item for item in default["question_txt"]["per_item"]
                   if item["id"] == "qtest-Q26")
        self.assertEqual(row["per_k"][5]["file_hits"], 0)
        self.assertEqual(row["gold_file_list"], Q27_FILES)
        extra = self._score(recorded, include_additions=True)
        row = next(item for item in extra["question_txt"]["per_item"]
                   if item["id"] == "qtest-Q26")
        self.assertEqual(row["per_k"][5]["file_hits"], 1)
        self.assertEqual(row["gold_file_list"][:4], Q27_FILES)
        self.assertIn(PPI_EXTRA, row["gold_file_list"])

    def test_report_splits_overall_and_near_alias(self):
        result = self._score({
            "qtest-Q0": [{
                "file": "edk2-ModuleWriteGuide/1_the_basics_of_edk_ii/11_overview.md",
                "section": "1.1.1 Module, Package and Platform",
            }],
            "qtest-Q26": [{
                "file": Q27_FILES[0],
                "section": "PEIM-to-PEIM Interfaces (PPIs)",
            }],
        })
        text = gold_recall.render_report(result)
        self.assertIn("question.txt overall", text)
        self.assertIn("near-alias question.txt", text)
        self.assertIn("false_recall", text)
        self.assertIn("qtest-Q29", text)
        self.assertEqual(result["question_txt"]["metrics"]["n"], 2)
        self.assertEqual(result["near_alias"]["metrics"]["n"], 1)
        self.assertLess(
            result["near_alias"]["metrics"]["file_hit@5"],
            result["question_txt"]["metrics"]["file_hit@5"])

    def test_missing_questions_are_not_silently_perfect(self):
        result = self._score({"qtest-Q0": []}, )
        self.assertEqual(result["question_txt"]["metrics"]["n"], 1)
        full = gold_recall.evaluate({"qtest-Q0": []}, missing_as_empty=True)
        self.assertGreater(full["question_txt"]["metrics"]["n"], 30)
        self.assertEqual(full["question_txt"]["metrics"]["file_hit@5"], 0)


class CliTests(unittest.TestCase):
    def test_gold_recall_cli_does_not_need_llm_or_index(self):
        recorded = {
            "qtest-Q26": [{
                "file": Q27_FILES[3],
                "section": "PPI Services",
            }],
            "uefi driver binding version 可以用来做什么": [
                {"file": DRIVER_CONFUSERS[0]},
                {"file": DRIVER_GOLD[0], "section": "9.1"},
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "recorded.json"
            path.write_text(json.dumps(recorded), encoding="utf-8")
            env = dict(**{k: v for k, v in __import__("os").environ.items()
                          if k not in ("LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL")})
            proc = subprocess.run(
                [sys.executable, str(HERE / "run_web_eval.py"),
                 "--gold-recall", "--retrievals", str(path)],
                cwd=str(HERE.parent.parent),
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
            )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("file_hit@5", proc.stdout)
        self.assertIn("file_hit@10", proc.stdout)
        self.assertIn("section_hit@5", proc.stdout)
        self.assertIn("near-alias", proc.stdout)
        self.assertIn("false_recall@5", proc.stdout)
        self.assertNotIn("LLM config missing", proc.stdout + proc.stderr)
        self.assertNotIn("search_engine", proc.stderr)

    def test_module_does_not_import_runtime_clients(self):
        source = (HERE / "gold_recall.py").read_text(encoding="utf-8")
        self.assertNotIn("import urllib", source)
        self.assertNotIn("search_engine", source)
        self.assertNotIn("chromadb", source)
        self.assertNotIn("search_engine", sys.modules)


if __name__ == "__main__":
    unittest.main()
