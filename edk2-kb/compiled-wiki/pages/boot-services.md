---
id: boot-services
title: Boot Services
topic: boot-runtime
canonical: UEFI Boot Services
aliases:
  - Boot Services
  - UEFI Boot Services
  - gBS
  - ExitBootServices
  - Exit Boot Services
  - 启动服务
  - 引导服务
sense: >-
  Boot Services 只在调用 ExitBootServices() 之前可用，包括内存分配、协议/句柄数据库、
  ConnectController、事件创建、以及 RaiseTPL/RestoreTPL 等。
  一旦所有权交给操作系统，Boot Services 被关闭，不能再调用。
distinguishes_from:
  - id: runtime-services
    canonical: UEFI Runtime Services
    name: Runtime Services / Runtime Driver
    aliases:
      - Runtime Services
      - UEFI Runtime Services
      - Runtime Driver
      - gRT
    source_paths:
      - source: tianocore-docs
        repo: edk2-UefiDriverWritersGuide
        file: edk2-UefiDriverWritersGuide/7_driver_entry_point/711_runtime_drivers.md
      - source: tianocore-docs
        repo: edk2-UefiDriverWritersGuide
        file: edk2-UefiDriverWritersGuide/8_dxe_drivers_non-uefi_drivers/88_dxe_runtime_driver.md
source_paths:
  - source: tianocore-docs
    repo: edk2-UefiDriverWritersGuide
    file: edk2-UefiDriverWritersGuide/5_uefi_services/README.md
    url: https://tianocore-docs.github.io/edk2-UefiDriverWritersGuide/draft/5_uefi_services/
  - source: tianocore-docs
    repo: edk2-UefiDriverWritersGuide
    file: edk2-UefiDriverWritersGuide/7_driver_entry_point/77_adding_the_exit_boot_services_feature.md
    url: https://tianocore-docs.github.io/edk2-UefiDriverWritersGuide/draft/7_driver_entry_point/77_adding_the_exit_boot_services_feature.html
---

Boot Services 在 `ExitBootServices()` 之后不可用。变量、时间、复位、SetVirtualAddressMap、UpdateCapsule 等属于 Runtime Services，不要和 Boot Services 混为一谈。证据只引用原文。
