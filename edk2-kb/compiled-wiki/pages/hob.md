---
id: hob
title: HOB（Hand-Off Block）
topic: ppi-hob
canonical: HOB (Hand-Off Block)
aliases:
  - HOB
  - Hand-Off Block
  - Hand Off Block
  - HOB list
  - BuildGuidHob
  - GetFirstGuidHob
  - GetNextGuidHob
  - 移交块
  - 交给 DXE 的 HOB
sense: >-
  HOB 是 PEI 构建、在 DXE 中只读消费的单向移交数据块。
  PEIM 用 HobLib（如 BuildGuidHob）写入；DXE 驱动遍历 HOB list，不得修改。
  它传递 PEI 结束时的系统状态（例如已发现内存），不是 PEI 阶段的 PPI 服务接口。
distinguishes_from:
  - id: ppi
    canonical: PPI (PEIM-to-PEIM Interface)
    name: PPI（PEIM-to-PEIM Interface）
    aliases:
      - PPI
      - PEIM-to-PEIM Interface
      - PeiServicesInstallPpi
    source_paths:
      - source: tianocore-docs
        repo: edk2-ModuleWriteGuide
        file: edk2-ModuleWriteGuide/7_pre-efi_initialization_modules/75_communicate_between_peim_modules.md
source_paths:
  - source: tianocore-docs
    repo: edk2-ModuleWriteGuide
    file: edk2-ModuleWriteGuide/7_pre-efi_initialization_modules/76_communicate_with_dxe_modules.md
    url: https://tianocore-docs.github.io/edk2-ModuleWriteGuide/draft/7_pre-efi_initialization_modules/76_communicate_with_dxe_modules.html
  - source: tianocore-docs
    repo: edk2-ModuleWriteGuide
    file: edk2-ModuleWriteGuide/8_dxe_drivers_non-uefi_drivers/85_communication_with_peims.md
    url: https://tianocore-docs.github.io/edk2-ModuleWriteGuide/draft/8_dxe_drivers_non-uefi_drivers/85_communication_with_peims.html
---

HOB 是 PEI → DXE 的单向、DXE 只读移交结构。PEIM 之间按 GUID 找服务应走 PPI，而不是 HOB。证据只引用原文。
