---
id: ppi
title: PPI（PEIM-to-PEIM Interface）
topic: ppi-hob
canonical: PPI (PEIM-to-PEIM Interface)
aliases:
  - PPI
  - PEIM-to-PEIM Interface
  - PEIM to PEIM Interface
  - PeiServicesInstallPpi
  - PeiServicesLocatePpi
  - EFI_PEI_PPI_DESCRIPTOR
  - 安装 PPI
  - 查找 PPI
sense: >-
  PPI 是 PEI 阶段 PEIM 之间按 GUID 发布和查找的服务接口。
  通过 PeiServicesInstallPpi() 安装、PeiServicesLocatePpi() 定位，存在于 PPI 数据库中，
  主要服务于 PEI 阶段模块间的接口调用，而不是向 DXE 移交只读数据。
distinguishes_from:
  - id: hob
    canonical: HOB (Hand-Off Block)
    name: HOB（Hand-Off Block）
    aliases:
      - HOB
      - Hand-Off Block
      - HOB list
    source_paths:
      - source: tianocore-docs
        repo: edk2-ModuleWriteGuide
        file: edk2-ModuleWriteGuide/7_pre-efi_initialization_modules/76_communicate_with_dxe_modules.md
      - source: tianocore-docs
        repo: edk2-ModuleWriteGuide
        file: edk2-ModuleWriteGuide/8_dxe_drivers_non-uefi_drivers/85_communication_with_peims.md
source_paths:
  - source: tianocore-docs
    repo: edk2-ModuleWriteGuide
    file: edk2-ModuleWriteGuide/7_pre-efi_initialization_modules/75_communicate_between_peim_modules.md
    url: https://tianocore-docs.github.io/edk2-ModuleWriteGuide/draft/7_pre-efi_initialization_modules/75_communicate_between_peim_modules.html
---

PPI 是 PEI 阶段的按 GUID 服务接口（InstallPpi / LocatePpi）。同一章还对比了 HOB 和动态 PCD：HOB 主要用于向 DXE 做单向移交，不要把 PPI 和 HOB 当成同一种机制。证据只引用原文。
