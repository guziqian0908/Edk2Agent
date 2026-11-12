---
id: secure-boot
title: UEFI Secure Boot
topic: secure-boot
canonical: UEFI Secure Boot
aliases:
  - secure boot
  - UEFI Secure Boot
sense: >-
  用 PK、KEK、db、dbx 验证启动镜像签名的 UEFI Secure Boot
distinguishes_from:
  - id: trusted-boot
    canonical: TCG Trusted Boot
    aliases:
      - trusted boot
      - measured boot
    source_paths:
      - source: tianocore-docs
        repo: edk2-TrustedBootChain
        file: edk2-TrustedBootChain/3_TCG_Trusted_Boot_Chain_in_EDKII.md
source_paths:
  - source: tianocore-docs
    repo: Understanding_UEFI_Secure_Boot_Chain
    file: Understanding_UEFI_Secure_Boot_Chain/secure_boot_chain_in_uefi/uefi_secure_boot.md
  - source: tianocore-docs
    repo: Understanding_UEFI_Secure_Boot_Chain
    file: Understanding_UEFI_Secure_Boot_Chain/introduction-to-the-secure-boot-chain.md
  - source: uefi-specs
    repo: UEFI_2.11
    file: UEFI_2.11/source/32_Secure_Boot_and_Driver_Signing.rst
---

Secure Boot 检查镜像签名是否落在允许的数据库里。度量启动把启动过程记入 PCR，那是另一条链。
