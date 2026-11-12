---
id: driver-binding-version
title: Driver Binding Protocol 的 Version 字段
topic: driver-binding
canonical: EFI_DRIVER_BINDING_PROTOCOL.Version
aliases:
  - driver binding version
  - uefi driver binding version
  - Driver Binding Protocol Version
  - Driver Binding 的 Version
  - Driver Binding 版本
  - 驱动绑定 version
  - 驱动绑定版本
  - 驱动绑定 Version 字段
  - ConnectController 优先级
  - ConnectController priority
  - driver connection precedence
sense: >-
  EFI_DRIVER_BINDING_PROTOCOL 的 Version 字段（UINT32）。
  ConnectController() 按该字段从高到低排列驱动，再依次调用 Supported()/Start()。
  数值越大优先级越高；新版本驱动必须增大 Version。
  0x0–0x0F 与 0xFFFFFFF0–0xFFFFFFFF 留给 OEM/平台驱动，0x10–0xFFFFFFEF 留给 IHV 驱动。
distinguishes_from:
  - id: driver-supported-efi-version
    canonical: EFI_DRIVER_SUPPORTED_EFI_VERSION_PROTOCOL
    name: Driver Supported EFI Version Protocol
    aliases:
      - Driver Supported EFI Version Protocol
      - Driver Supported EFI Version
      - EFI_DRIVER_SUPPORTED_EFI_VERSION_PROTOCOL
      - FirmwareVersion
    source_paths:
      - source: tianocore-docs
        repo: edk2-UefiDriverWritersGuide
        file: edk2-UefiDriverWritersGuide/16_driver_supported_efi_version_protocol/README.md
      - source: tianocore-docs
        repo: edk2-UefiDriverWritersGuide
        file: edk2-UefiDriverWritersGuide/16_driver_supported_efi_version_protocol/161_driver_supported_efi_version_protocol_implemen.md
      - source: tianocore-docs
        repo: edk2-UefiDriverWritersGuide
        file: edk2-UefiDriverWritersGuide/7_driver_entry_point/73_adding_the_driver_supported_efi_version_protoco.md
source_paths:
  - source: tianocore-docs
    repo: edk2-UefiDriverWritersGuide
    file: edk2-UefiDriverWritersGuide/9_driver_binding_protocol/91_driver_binding_protocol_implementations.md
    url: https://tianocore-docs.github.io/edk2-UefiDriverWritersGuide/draft/9_driver_binding_protocol/91_driver_binding_protocol_implementations.html
  - source: tianocore-docs
    repo: edk2-UefiDriverWritersGuide
    file: edk2-UefiDriverWritersGuide/3_foundation/314_uefi_driver_model_connection_process/3141_connectcontroller.md
    url: https://tianocore-docs.github.io/edk2-UefiDriverWritersGuide/draft/3_foundation/314_uefi_driver_model_connection_process/3141_connectcontroller.html
  - source: tianocore-docs
    repo: edk2-UefiDriverWritersGuide
    file: edk2-UefiDriverWritersGuide/3_foundation/314_uefi_driver_model_connection_process/3142_loading_uefi_option_rom_drivers.md
    url: https://tianocore-docs.github.io/edk2-UefiDriverWritersGuide/draft/3_foundation/314_uefi_driver_model_connection_process/3142_loading_uefi_option_rom_drivers.html
---

「driver binding version」指的是 Driver Binding Protocol 结构里的 `Version` 字段，用来决定 `ConnectController()` 尝试连接驱动的优先级，不是 Driver Supported EFI Version Protocol 所声明的 UEFI 规范版本。

定义见 Driver Writer's Guide 9.1；连接过程见 3.14.1；选项 ROM 上不同 Version 如何抢到控制器见 3.14.2。证据只引用这些原文，不引用本页。
