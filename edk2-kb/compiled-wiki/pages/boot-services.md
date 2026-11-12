---
id: boot-services
title: UEFI Boot Services
topic: boot-runtime
canonical: EFI_BOOT_SERVICES
aliases:
  - boot services
  - UEFI Boot Services
  - EFI_BOOT_SERVICES
sense: >-
  UEFI 启动阶段可用的 Boot Services 表，ExitBootServices 之后不再可用
distinguishes_from:
  - id: runtime-services
    canonical: EFI_RUNTIME_SERVICES
    aliases:
      - runtime services
      - UEFI Runtime Services
    source_paths:
      - source: uefi-specs
        repo: UEFI_2.11
        file: UEFI_2.11/source/08_Services_Runtime_Services.rst
source_paths:
  - source: uefi-specs
    repo: UEFI_2.11
    file: UEFI_2.11/source/07_Services_Boot_Services.rst
  - source: tianocore-docs
    repo: edk2-UefiDriverWritersGuide
    file: edk2-UefiDriverWritersGuide/5_uefi_services/README.md
---

Boot Services 只在操作系统接手之前可用。ExitBootServices 成功之后，固件不再提供这张表。
