---
id: driver-binding-version
title: Driver Binding Protocol 的 Version 字段
topic: driver-binding
canonical: EFI_DRIVER_BINDING_PROTOCOL.Version
aliases:
  - driver binding version
  - Driver Binding Protocol Version
sense: >-
  Driver Binding Protocol 的 Version 字段，决定 ConnectController 连接优先级
distinguishes_from:
  - id: driver-supported-efi-version
    canonical: EFI_DRIVER_SUPPORTED_EFI_VERSION_PROTOCOL
    aliases:
      - Driver Supported EFI Version
      - Driver Supported EFI Version Protocol
    source_paths:
      - source: tianocore-docs
        repo: edk2-UefiDriverWritersGuide
        file: edk2-UefiDriverWritersGuide/16_driver_supported_efi_version_protocol/README.md
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

Version 字段必须初始化。数值越高的驱动，ConnectController 越先尝试连接。0x10 到 0xFFFFFFEF 留给 IHV，两端区间留给 OEM。连接顺序和 option ROM 示例分别在 3141 与 3142。
