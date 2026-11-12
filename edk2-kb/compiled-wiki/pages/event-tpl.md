---
id: event-tpl
title: Event 与 Task Priority Level
topic: event-tpl
canonical: EFI_TPL
aliases:
  - task priority level
  - RaiseTPL
  - RestoreTPL
  - TPL
sense: >-
  UEFI 事件回调的任务优先级。RaiseTPL 抬高当前优先级，RestoreTPL 恢复
distinguishes_from:
  - id: boot-services
    canonical: EFI_BOOT_SERVICES
    aliases:
      - boot services
    source_paths:
      - source: uefi-specs
        repo: UEFI_2.11
        file: UEFI_2.11/source/07_Services_Boot_Services.rst
source_paths:
  - source: tianocore-docs
    repo: edk2-UefiDriverWritersGuide
    file: edk2-UefiDriverWritersGuide/3_foundation/38_events_and_task_priority_levels/381_defining_priority.md
  - source: tianocore-docs
    repo: edk2-UefiDriverWritersGuide
    file: edk2-UefiDriverWritersGuide/5_uefi_services/51_services_that_uefi_drivers_commonly_use/514_task_priority_leveltpl_services.md
  - source: tianocore-docs
    repo: edk2-UefiDriverWritersGuide
    file: edk2-UefiDriverWritersGuide/5_uefi_services/51_services_that_uefi_drivers_commonly_use/515_event_services.md
---

TPL 决定事件回调能不能打断当前代码。更高的优先级先运行，RestoreTPL 回到原来的级别。
