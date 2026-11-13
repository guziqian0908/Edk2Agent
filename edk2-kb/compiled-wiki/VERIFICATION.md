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
| driver-binding-version | distinguishes_from only | `edk2-UefiDriverWritersGuide/16_driver_supported_efi_version_protocol/README.md` | Published ch. 16: protocol publishes the UEFI *Specification* version the driver conforms to, not Driver Binding connection priority. |
| driver-binding-version | distinguishes_from only | `edk2-UefiDriverWritersGuide/16_driver_supported_efi_version_protocol/161_driver_supported_efi_version_protocol_implemen.md` | Implementation of FirmwareVersion / EFI_n_mm_SYSTEM_TABLE_REVISION. |
| driver-binding-version | distinguishes_from only | `edk2-UefiDriverWritersGuide/7_driver_entry_point/73_adding_the_driver_supported_efi_version_protoco.md` | How to install that protocol on ImageHandle. |
| ppi | PEIM-to-PEIM Interface，PEI 阶段按 GUID 安装/查找的服务接口 | `edk2-ModuleWriteGuide/7_pre-efi_initialization_modules/75_communicate_between_peim_modules.md` | §7.5.1 PPI vs §7.5.2 HOB vs PCD; InstallPpi / LocatePpi. File exists (HTTP 200). |
| hob | Hand-Off Block，PEI 向 DXE 单向传递的只读移交数据 | `edk2-ModuleWriteGuide/7_pre-efi_initialization_modules/76_communicate_with_dxe_modules.md` | §7.6.1 HOB handoff to DXE; BuildGuidHob. File exists (HTTP 200). |
| hob | same | `edk2-ModuleWriteGuide/8_dxe_drivers_non-uefi_drivers/85_communication_with_peims.md` | §8.5.1 HOB is a one-way PEI→DXE channel; read-only in DXE. File exists (HTTP 200). |
| boot-services | ExitBootServices 之前可用的 Boot Services | `edk2-UefiDriverWritersGuide/5_uefi_services/README.md` | Chapter table labels each service Boot vs Runtime. File exists (HTTP 200). |
| boot-services | same | `edk2-UefiDriverWritersGuide/7_driver_entry_point/77_adding_the_exit_boot_services_feature.md` | ExitBootServices notification feature. File exists (HTTP 200). |
| runtime-services | ExitBootServices 之后仍可用的 Runtime Services / Runtime Driver | `edk2-UefiDriverWritersGuide/7_driver_entry_point/711_runtime_drivers.md` | After ExitBootServices, boot services are forbidden; runtime services remain. File exists (HTTP 200). |
| runtime-services | same | `edk2-UefiDriverWritersGuide/8_dxe_drivers_non-uefi_drivers/88_dxe_runtime_driver.md` | DXE Runtime Driver chapter. File exists (HTTP 200). |
| event-tpl | UEFI Event 类型及其通知函数所在的 TPL | `edk2-UefiDriverWritersGuide/3_foundation/38_events_and_task_priority_levels/README.8.md` | Event types and TPL_APPLICATION / CALLBACK / NOTIFY / HIGH_LEVEL. File exists (HTTP 200). |
| event-tpl | same | `edk2-UefiDriverWritersGuide/3_foundation/38_events_and_task_priority_levels/381_defining_priority.md` | Defining priority. File exists (HTTP 200). |
| event-tpl | same | `edk2-UefiDriverWritersGuide/5_uefi_services/51_services_that_uefi_drivers_commonly_use/515_event_services.md` | CreateEvent / SignalEvent / ExitBootServices and SetVirtualAddressMap events. File exists (HTTP 200). |
| event-tpl | same | `edk2-UefiDriverWritersGuide/5_uefi_services/51_services_that_uefi_drivers_commonly_use/514_task_priority_leveltpl_services.md` | RaiseTPL / RestoreTPL services. File exists (HTTP 200). |
| secure-boot | UEFI Secure Boot：按签名数据库校验第三方镜像与已认证变量更新 | `Understanding_UEFI_Secure_Boot_Chain/secure_boot_chain_in_uefi/uefi_secure_boot.md` | Image verification + authenticated-variable update of the image security database (PK/KEK/db). File exists (HTTP 200). |
| secure-boot | distinguishes_from only | `Understanding_UEFI_Secure_Boot_Chain/secure_boot_chain_in_uefi/intel_boot_guard.md` | Intel Boot Guard is a platform/firmware authenticity mechanism, not UEFI Secure Boot itself. File exists (HTTP 200). |

No unverified path was kept. UEFI Forum RST paths under `uefi-specs/` were not added in this batch because the exact `UEFI_2.11/source/*.rst` filenames were not opened and confirmed in this pass; they can be appended later without an index rebuild.
