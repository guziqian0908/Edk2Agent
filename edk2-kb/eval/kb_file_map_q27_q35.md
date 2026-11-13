# question.txt Q27–Q29、Q35：R 到知识库 `file` 的对照

`question.txt` 的 R 章节内容可以落到原文，但 **PDF 文件名不能直接当金标 `file`**。`init_kb.py` 摄入的是 RST：`file` 为 `{version}/source/{rst}`，`source` 为 `uefi-specs`。当前知识库版本是 `UEFI_2.11` 和 `PI_1.10`，不是 `UEFI_Spec_Final_2.11.pdf` / `PI_Spec_1_8_A_final_2024.03.05.pdf`。RST 源里通常没有 7.4.6、I-6.7 这种 PDF 章节号（构建时才编号），但对得上函数名和节标题。

`tianocore-wiki` 的 `development/design-architecture/pi_boot_flow.md`（Q27、Q28 的 R 后半段）**不是原文规格**，不要纳入 source 金标，也不要写入编译 Wiki 的 `source_paths`。

## Q27 PPI 和 HOB

R 写的是 PI 1.8 A PDF：I-6.7 PEIM-to-PEIM Interfaces、I-7.2 PEI Services Table、I-8.2 PPI Services、I-8.4 HOB Services。

请用（已在 PI 1.10 RST 里核对标题）：

- `PI_1.10/source/V1_Overview.rst` — PEIM-to-PEIM Interfaces (PPIs)
- `PI_1.10/source/V1_PEIMs.rst` — PEIM-to-PEIM Communication
- `PI_1.10/source/V1_PEI_Services_Table.rst` — PEI Services Table
- `PI_1.10/source/V1_Services_PEI.rst` — PPI Services、HOB Services

可选增补（tianocore-docs，已核对）：Module Write Guide 7.5 / 7.6 / 8.5。

## Q28 Boot / Runtime

R：UEFI 2.11 PDF 7.4.6 ExitBootServices()、8.1 Runtime Services Rules and Restrictions、2.2.2 Runtime Services。

请用：

- `UEFI_2.11/source/07_Services_Boot_Services.rst` — ExitBootServices()（`efi-boot-services-exitbootservices`）
- `UEFI_2.11/source/08_Services_Runtime_Services.rst` — Runtime Services Rules and Restrictions
- `UEFI_2.11/source/02_Overview.rst` — Runtime Services 概述（对应 2.2.2）

可选增补：Driver Writers Guide 第 5 章、7.7、7.11、8.8。

## Q29 TPL

R：UEFI 2.11 PDF 7.1.8 RaiseTPL()、7.1.9 RestoreTPL()、7.1 节 TPL 限制表。

请用：

- `UEFI_2.11/source/07_Services_Boot_Services.rst` — RaiseTPL()、RestoreTPL()、TPL Restrictions 表

可选增补：Driver Writers Guide 3.8、3.8.1、5.1.4。

## Q35 Secure Boot vs Trusted Boot (Measured Boot)

R 三条 tianocore-docs 路径都能打开，可直接当金标 `file`：

- `Understanding_UEFI_Secure_Boot_Chain/overview.md`（Integrity Models）
- `Understanding_UEFI_Secure_Boot_Chain/introduction-to-the-secure-boot-chain.md`（Trusted Boot / Measured Boot 对比原文在此）
- `Understanding_UEFI_Secure_Boot_Chain/secure_boot_chain_in_uefi/uefi_secure_boot.md`（PK/KEK/db/dbx）

没有单独的 Measured Boot 页，不要把 intro/overview 当 confounder 降权。Boot Guard 才有独立路径 `.../intel_boot_guard.md`，那是另一道消歧题。
