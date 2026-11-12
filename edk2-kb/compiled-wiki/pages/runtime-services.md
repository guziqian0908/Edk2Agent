---
id: runtime-services
title: UEFI Runtime Services
topic: boot-runtime
canonical: EFI_RUNTIME_SERVICES
aliases:
  - runtime services
  - UEFI Runtime Services
  - EFI_RUNTIME_SERVICES
sense: >-
  ExitBootServices 之后仍然可用的 Runtime Services，包括变量、时间与虚拟地址映射
distinguishes_from:
  - id: boot-services
    canonical: EFI_BOOT_SERVICES
    aliases:
      - boot services
      - UEFI Boot Services
    source_paths:
      - source: uefi-specs
        repo: UEFI_2.11
        file: UEFI_2.11/source/07_Services_Boot_Services.rst
source_paths:
  - source: uefi-specs
    repo: UEFI_2.11
    file: UEFI_2.11/source/08_Services_Runtime_Services.rst
  - source: tianocore-docs
    repo: edk2-UefiDriverWritersGuide
    file: edk2-UefiDriverWritersGuide/5_uefi_services/53_services_that_uefi_drivers_should_not_use/5313_setvirtualaddressmap.md
  - source: tianocore-docs
    repo: edk2-UefiDriverWritersGuide
    file: edk2-UefiDriverWritersGuide/7_driver_entry_point/711_runtime_drivers.md
---

Runtime Services 在 ExitBootServices 之后仍然存在。SetVirtualAddressMap 把运行时指针改到操作系统给出的虚拟地址。
