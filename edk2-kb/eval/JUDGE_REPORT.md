# EDK2 KB Answer-Level Evaluation (LLM-as-judge)

provider=mock  queries=122  top_k=5

| metric | value |
|---|---|
| mean factual score (1-5) | 4.98 |
| answers scoring 4+ | 99.2% |
| answers with hallucinated claims | 0 |

## Worst answers

- **SetVariable with NV attributes must not trust pointers from flash**  score=3  (top: edk2-FdfSpecification\2_fdf_design_discussion\25_[fv]_sections.md)
- **How do I configure DebugLib to control debug message output level**  score=5  (top: edk2-UefiDriverWritersGuide\31_testing_and_debugging_uefi_drivers\314_debugging_code_statements\3141_configuring_debuglib_with_edk_ii.md)
- **PcdDebugPrintErrorLevel controls which debug messages are printed**  score=5  (top: EDK II Debugging - TianoCore EDK II Documentation)
- **What is the control flow from power-on to OS boot in UEFI**  score=5  (top: UEFI Pi FAQ - TianoCore EDK II Documentation)
- **INF file [Pcds] section syntax and entry formats**  score=5  (top: edk2-InfSpecification\2_inf_overview\214_pcd_sections.md)