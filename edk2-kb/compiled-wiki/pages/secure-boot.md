---
id: secure-boot
title: UEFI Secure Boot
topic: secure-boot
canonical: UEFI Secure Boot
aliases:
  - Secure Boot
  - UEFI Secure Boot
  - 安全启动
  - 安全引导
  - 签名数据库
  - image security database
  - authenticated variable
  - PK KEK db dbx
sense: >-
  UEFI Secure Boot 按规范校验第三方固件代码（如 OS 引导程序）以及镜像安全数据库的更新。
  启动时用已注册的安全数据库验证镜像；运行时用已认证变量流程验证对数据库的更新。
  它假定平台固件自身是可信的，策略由 PK / KEK / db / dbx 等管理。
distinguishes_from:
  - id: intel-boot-guard
    canonical: Intel Boot Guard
    name: Intel Boot Guard
    aliases:
      - Intel Boot Guard
      - Boot Guard
    source_paths:
      - source: tianocore-docs
        repo: Understanding_UEFI_Secure_Boot_Chain
        file: Understanding_UEFI_Secure_Boot_Chain/secure_boot_chain_in_uefi/intel_boot_guard.md
source_paths:
  - source: tianocore-docs
    repo: Understanding_UEFI_Secure_Boot_Chain
    file: Understanding_UEFI_Secure_Boot_Chain/secure_boot_chain_in_uefi/uefi_secure_boot.md
    url: https://tianocore-docs.github.io/Understanding_UEFI_Secure_Boot_Chain/draft/secure_boot_chain_in_uefi/uefi_secure_boot.html
---

UEFI Secure Boot 校验的是第三方启动镜像和安全数据库（已认证变量）更新，不要和 Intel Boot Guard 等平台固件真实性机制混成同一件事。证据只引用原文。
