# 金标 source / 章节（给 run_web_eval 接入）

`gold_source_chapters.json` 分三块：

- `question_txt`：从仓库根目录 `question.txt` 的 `R:` 拆出的 35 题金标（路径 + 章节）。`r_raw` 是原文。
- `disambiguation`：近义协议误召回用例。每条有 `queries`、`expected`、`confounders`（命中算假阳性），以及对应的 `compiled_wiki_id`。其中 **driver binding version** 和 **Secure Boot vs Boot Guard** 不在 `question.txt` 里。
- `suggested_additions_for_question_txt`：Q26/Q27/Q28/Q30 已核对的 tianocore-docs 增补路径，默认仍以 `R:` 为准。

注意：

- `run_web_eval.py` 现在 18 题只做 LLM-judge；`qtest_eval_set.json` 的 expected 还是 `qtest-Q0` 占位。
- `source: spec` 的 `file` 暂用 PDF 文件名，接入时请映射到知识库实际 `file`。
- Q34（Secure Boot vs Measured Boot）的对比写在 `introduction-to-the-secure-boot-chain.md`，没有单独的 Measured Boot 页，不要把该页当 confounder 降权。

## 如何跑金标召回

默认打分读 `gold_source_chapters.json` 的 `expected`（来自 `question.txt` 的 `R:`）。`kb_file_map_q27_q35.md` 覆盖 question.txt 第 27、28、29 题：金标 `source` 为 `uefi-specs`，`file` 为 `PI_1.10/source/*.rst` 或 `UEFI_2.11/source/*.rst`。这三题不用 PDF 文件名，也不把 `development/design-architecture/pi_boot_flow.md` 算进金标。第 35 题的三条 tianocore-docs 路径直接当金标；`introduction-to-the-secure-boot-chain.md` 和 `overview.md` 不是 confounder。`intel_boot_guard.md` 只在 Secure Boot vs Boot Guard 消歧题里算假阳性。

其余仍写着 `UEFI_Spec_Final_2.11.pdf` / `PI_Spec_1_8_A_final_2024.03.05.pdf` 的题，没有核对过的 RST 对照，不发明路径，也不把 PDF 文件名当成命中。`suggested_additions_for_question_txt` 默认不计入，加上 `--include-additions` 才作为额外金标，不替换已有条目。

不需要 16G 索引、Web 服务或 LLM。准备一份已记录的检索/引用列表（按题目 `id` 或 `query` 对应 `file` + `section`），然后：

```bash
python edk2-kb/eval/run_web_eval.py --gold-recall --retrievals recorded.json
```

等价入口：`python edk2-kb/eval/gold_recall.py --retrievals recorded.json`。

报告分三块：question.txt 总体、近义子集（第 27、28、29、31、35 题）、消歧集（7 组 15 问，命中 `confounders` 记为 false recall，不算金标命中）。指标至少包括 file hit@5、hit@10，以及 R 或映射表写了章节时的 section hit。`--missing-as-empty` 把检索文件里没出现的题记为未命中；默认只统计文件里有的题。

原先 18 题的 LLM-judge 路径不变：不加 `--gold-recall` 时仍走 `/api/ask` 和评判模型。

```bash
python edk2-kb/eval/test_gold_recall.py
```
