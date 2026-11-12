# First-batch path verification

All `source_paths.file` values were checked against the live GitHub repos (HTTP 200 on
`/contents/{path}`) and, for the driver-binding Version case, against the
raw Markdown content. Published GitBook URLs use a `/draft/` prefix; that
prefix is **not** part of the repository or KB `file` path.

| Page id | `canonical` / sense | `source_paths.file` | Evidence |
| --- | --- | --- | --- |
| driver-binding-version | Driver Binding Protocol 的 Version 字段，决定 ConnectController 连接优先级 | `edk2-UefiDriverWritersGuide/9_driver_binding_protocol/91_driver_binding_protocol_implementations.md` | Raw MD: Version field must be initialized; higher Version values used first; 0x0–0x0F and 0xFFFFFFF0–0xFFFFFFFF reserved for OEM, 0x10–0xFFFFFFEF for IHV. |
| driver-binding-version | same | `edk2-UefiDriverWritersGuide/3_foundation/314_uefi_driver_model_connection_process/3141_connectcontroller.md` | Raw MD: ConnectController builds an ordered list of driver handles from highest to lowest priority, then connects in that order. The Version *field name* is defined in 9.1; 3141 is the connection-process page this field feeds. |
| driver-binding-version | same | `edk2-UefiDriverWritersGuide/3_foundation/314_uefi_driver_model_connection_process/3142_loading_uefi_option_rom_drivers.md` | Raw MD: worked example with UEFI driver Version 0x10 / 0x11 / 0x12 deciding which option-ROM driver manages which adapter. |
| driver-binding-version | distinguishes_from only | `edk2-UefiDriverWritersGuide/16_driver_supported_efi_version_protocol/README.md` | Contents API 200. This is EFI_DRIVER_SUPPORTED_EFI_VERSION_PROTOCOL, not the Driver Binding Version field. |
| boot-services | EFI_BOOT_SERVICES | `UEFI_2.11/source/07_Services_Boot_Services.rst` | UEFI-Specification-Release `source/` listing. |
| boot-services | same | `edk2-UefiDriverWritersGuide/5_uefi_services/README.md` | Driver Writers Guide tree. |
| runtime-services | EFI_RUNTIME_SERVICES | `UEFI_2.11/source/08_Services_Runtime_Services.rst` | UEFI-Specification-Release `source/` listing. |
| runtime-services | same | `edk2-UefiDriverWritersGuide/5_uefi_services/53_services_that_uefi_drivers_should_not_use/5313_setvirtualaddressmap.md` | Driver Writers Guide tree. |
| runtime-services | same | `edk2-UefiDriverWritersGuide/7_driver_entry_point/711_runtime_drivers.md` | Driver Writers Guide tree. |
| event-tpl | EFI_TPL | `edk2-UefiDriverWritersGuide/3_foundation/38_events_and_task_priority_levels/381_defining_priority.md` | Driver Writers Guide tree. |
| event-tpl | same | `edk2-UefiDriverWritersGuide/5_uefi_services/51_services_that_uefi_drivers_commonly_use/514_task_priority_leveltpl_services.md` | Driver Writers Guide tree. |
| event-tpl | same | `edk2-UefiDriverWritersGuide/5_uefi_services/51_services_that_uefi_drivers_commonly_use/515_event_services.md` | Driver Writers Guide tree. |
| hob | EFI_HOB_HANDOFF_INFO_TABLE | `PI_1.10/source/V3_HOB_Design_Discussion.rst` | PI-Specification-Release `source/` listing. |
| hob | same | `PI_1.10/source/V3_HOB_Code_Definitions.rst` | PI-Specification-Release `source/` listing. |
| hob | same | `PI_1.10/source/V1_PEI_to_DXE_Handoff.rst` | PI-Specification-Release `source/` listing. |
| ppi | PEIM-to-PEIM Interface | `PI_1.10/source/V1_Architectural_PPIs.rst` | PI-Specification-Release `source/` listing. |
| ppi | same | `PI_1.10/source/V1_Additional_PPIs.rst` | PI-Specification-Release `source/` listing. |
| ppi | same | `PI_1.10/source/V1_PEI_Services_Table.rst` | PI-Specification-Release `source/` listing. |
| secure-boot | UEFI Secure Boot | `Understanding_UEFI_Secure_Boot_Chain/secure_boot_chain_in_uefi/uefi_secure_boot.md` | Contents tree. |
| secure-boot | same | `Understanding_UEFI_Secure_Boot_Chain/introduction-to-the-secure-boot-chain.md` | Contents tree. |
| secure-boot | same | `UEFI_2.11/source/32_Secure_Boot_and_Driver_Signing.rst` | UEFI-Specification-Release `source/` listing. |
| secure-boot | distinguishes_from only | `edk2-TrustedBootChain/3_TCG_Trusted_Boot_Chain_in_EDKII.md` | Trusted Boot Chain tree. Measured boot is not Secure Boot. |
