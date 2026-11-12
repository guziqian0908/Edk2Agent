---
id: event-tpl
title: Event 与 TPL
topic: event-tpl
canonical: UEFI Events and TPL
aliases:
  - Event 和 TPL
  - Events and TPL
  - Events and task priority levels
  - UEFI Event
  - CreateEvent
  - SignalEvent
  - WaitForEvent
  - TPL
  - Task Priority Level
  - RaiseTPL
  - RestoreTPL
  - TPL_NOTIFY
  - TPL_CALLBACK
  - 任务优先级
  - 事件和 TPL
sense: >-
  Event 是可等待或可通知的对象（Wait、Signal、Timer、Exit Boot Services、
  Set Virtual Address Map 等）。每个事件都有通知函数、通知上下文和 TPL。
  TPL（TPL_APPLICATION / TPL_CALLBACK / TPL_NOTIFY / TPL_HIGH_LEVEL）既决定通知函数
  的执行优先级，也用于构造锁；它不是事件类型本身。
source_paths:
  - source: tianocore-docs
    repo: edk2-UefiDriverWritersGuide
    file: edk2-UefiDriverWritersGuide/3_foundation/38_events_and_task_priority_levels/README.8.md
    url: https://tianocore-docs.github.io/edk2-UefiDriverWritersGuide/draft/3_foundation/38_events_and_task_priority_levels/README.8.html
  - source: tianocore-docs
    repo: edk2-UefiDriverWritersGuide
    file: edk2-UefiDriverWritersGuide/3_foundation/38_events_and_task_priority_levels/381_defining_priority.md
    url: https://tianocore-docs.github.io/edk2-UefiDriverWritersGuide/draft/3_foundation/38_events_and_task_priority_levels/381_defining_priority.html
  - source: tianocore-docs
    repo: edk2-UefiDriverWritersGuide
    file: edk2-UefiDriverWritersGuide/5_uefi_services/51_services_that_uefi_drivers_commonly_use/515_event_services.md
    url: https://tianocore-docs.github.io/edk2-UefiDriverWritersGuide/draft/5_uefi_services/51_services_that_uefi_drivers_commonly_use/515_event_services.html
  - source: tianocore-docs
    repo: edk2-UefiDriverWritersGuide
    file: edk2-UefiDriverWritersGuide/5_uefi_services/51_services_that_uefi_drivers_commonly_use/514_task_priority_leveltpl_services.md
    url: https://tianocore-docs.github.io/edk2-UefiDriverWritersGuide/draft/5_uefi_services/51_services_that_uefi_drivers_commonly_use/514_task_priority_leveltpl_services.html
---

Event 是通知对象，TPL 是通知函数运行的优先级（也用于加锁）。创建/等待事件走 Event Services，提升/恢复优先级走 RaiseTPL/RestoreTPL。证据只引用原文。
