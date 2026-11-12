---
id: hob
title: Hand-Off Block
topic: ppi-hob
canonical: EFI_HOB_HANDOFF_INFO_TABLE
aliases:
  - hand-off block
  - handoff block
  - HOB
sense: >-
  PEI 交给 DXE 的 Hand-Off Block 列表，描述内存和引导状态
distinguishes_from:
  - id: ppi
    canonical: PEIM-to-PEIM Interface
    aliases:
      - PPI
    source_paths:
      - source: uefi-specs
        repo: PI_1.10
        file: PI_1.10/source/V1_Architectural_PPIs.rst
source_paths:
  - source: uefi-specs
    repo: PI_1.10
    file: PI_1.10/source/V3_HOB_Design_Discussion.rst
  - source: uefi-specs
    repo: PI_1.10
    file: PI_1.10/source/V3_HOB_Code_Definitions.rst
  - source: uefi-specs
    repo: PI_1.10
    file: PI_1.10/source/V1_PEI_to_DXE_Handoff.rst
---

HOB 是 PEI 阶段留下、DXE 阶段读取的移交数据。它不是 PEI 模块之间调用的 PPI。
