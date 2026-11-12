---
id: ppi
title: PEIM-to-PEIM Interface
topic: ppi-hob
canonical: PEIM-to-PEIM Interface
aliases:
  - PEIM-to-PEIM Interface
  - PEIM to PEIM
  - PPI
sense: >-
  PEI 模块之间发布和定位的接口，通过 PEI Services 安装与查找
distinguishes_from:
  - id: hob
    canonical: EFI_HOB_HANDOFF_INFO_TABLE
    aliases:
      - hand-off block
      - HOB
    source_paths:
      - source: uefi-specs
        repo: PI_1.10
        file: PI_1.10/source/V3_HOB_Design_Discussion.rst
source_paths:
  - source: uefi-specs
    repo: PI_1.10
    file: PI_1.10/source/V1_Architectural_PPIs.rst
  - source: uefi-specs
    repo: PI_1.10
    file: PI_1.10/source/V1_Additional_PPIs.rst
  - source: uefi-specs
    repo: PI_1.10
    file: PI_1.10/source/V1_PEI_Services_Table.rst
---

PPI 是 PEI 模块之间的调用接口。InstallPpi 和 LocatePpi 走 PEI Services，不把数据交给 DXE。
