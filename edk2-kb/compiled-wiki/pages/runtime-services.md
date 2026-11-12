---
id: runtime-services
title: Runtime Services 与 Runtime Driver
topic: boot-runtime
canonical: UEFI Runtime Services
aliases:
  - Runtime Services
  - UEFI Runtime Services
  - Runtime Driver
  - DXE Runtime Driver
  - gRT
  - SetVirtualAddressMap
  - 运行时服务
  - 运行时驱动
sense: >-
  Runtime Services 在 ExitBootServices() 之后仍然可用（Get/SetVariable、时间、复位、
  SetVirtualAddressMap、UpdateCapsule 等）。Runtime Driver 必须能在预启动和启动后环境执行，
  通常要注册 Exit Boot Services 与 Set Virtual Address Map 事件，且之后不得再调用 Boot Services。
distinguishes_from:
  - id: boot-services
    canonical: UEFI Boot Services
    name: Boot Services
    aliases:
      - Boot Services
      - UEFI Boot Services
      - gBS
      - ExitBootServices
    source_paths:
      - source: tianocore-docs
        repo: edk2-UefiDriverWritersGuide
        file: edk2-UefiDriverWritersGuide/7_driver_entry_point/77_adding_the_exit_boot_services_feature.md
source_paths:
  - source: tianocore-docs
    repo: edk2-UefiDriverWritersGuide
    file: edk2-UefiDriverWritersGuide/7_driver_entry_point/711_runtime_drivers.md
    url: https://tianocore-docs.github.io/edk2-UefiDriverWritersGuide/draft/7_driver_entry_point/711_runtime_drivers.html
  - source: tianocore-docs
    repo: edk2-UefiDriverWritersGuide
    file: edk2-UefiDriverWritersGuide/8_dxe_drivers_non-uefi_drivers/88_dxe_runtime_driver.md
    url: https://tianocore-docs.github.io/edk2-UefiDriverWritersGuide/draft/8_dxe_drivers_non-uefi_drivers/88_dxe_runtime_driver.html
  - source: tianocore-docs
    repo: edk2-UefiDriverWritersGuide
    file: edk2-UefiDriverWritersGuide/5_uefi_services/README.md
    url: https://tianocore-docs.github.io/edk2-UefiDriverWritersGuide/draft/5_uefi_services/
---

Runtime Services / Runtime Driver 活过 `ExitBootServices()`。Boot Services（包括 CreateEvent、ConnectController、普通内存分配）在此之后不能再用。证据只引用原文。
