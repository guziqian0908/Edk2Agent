# EDK2 KB Answer-Level Evaluation (LLM-as-judge)

provider=mock  queries=25  top_k=15

| metric | value |
|---|---|
| mean factual score (1-5) | 3.44 |
| answers scoring 4+ | 40.0% |
| answers with hallucinated claims | 0 |

## Worst answers

- **库类(Library Class)和库实例(Library Instance)到底是什么关系？为什么 DSC 里非要写一行映射？**  score=2  (top: Docs\User_Docs\EDK_II_UserManual_0_7.pdf)
- **新手最常撞上的那几个编译/链接报错，分别是什么原因、怎么修？**  score=2  (top: edk2-UefiDriverWritersGuide\SUMMARY.md)
- **我想在代码里打印调试信息，DEBUG/ASSERT 要怎么配置才能真的输出？除了打印还有什么调试手段？**  score=2  (top: edk2-UefiDriverWritersGuide\19_usb_driver_design_guidelines\194_debug_techniques\1941_debug_message_output.md)
- **拿一个 Protocol 到底该用 LocateProtocol、LocateHandleBuffer 还是 OpenProtocol？OpenProtocol 的 Attributes 怎么选？**  score=2  (top: edk2-ModuleWriteGuide\4_uefi_applications\44_communicating_with_a_uefi_driver.md)
- **一个改动该拆成几个 commit？拆分标准是什么？**  score=2  (top: Commit Partitioning - TianoCore EDK II Documentation)