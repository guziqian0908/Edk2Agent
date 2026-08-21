# Web Pipeline LLM-Judge Evaluation

questions=18 mean_faithfulness=4.28 mean_relevancy=4.61

## Gate: FAIL (faithfulness>=4.6, relevancy>=4.4)

| tier | n | faith | relev | warn_l3 | warn_l2c |
|---|---|---|---|---|---|
| simple | 8 | 4.62 | 4.5 | 0 | 0 |
| standard | 2 | 4 | 4.5 | 0 | 1 |
| complex | 8 | 4 | 4.75 | 8 | 0 |

## Worst answers
- **PCD 有哪几种类型？分别在 DEC、DSC、INF 里怎么写？C 代码里如何访问 PCD？** (tier=complex) faith=3 relev=3 halluc=['DEC 中可用的 section 类型对应各访问方法，例如 `[PcdsFixedAtBuild]`、`[PcdsPatchableInModule]`、`[PcdsDynamic]`、`[PcdsDynamicEx]`、`[PcdsFeatureFlag]`（依据较弱，上下文未逐条列出 DEC s', 'INF 中 PCD 的 section 类型与访问方法对应，例如 `[Pcd]`（通用）、`[PcdEx]`、`[PatchPcd]` 等（依据较弱，上下文未给出 INF section 完整清单，仅从规则反推）。', 'PCD 值来源依次为：命令行、FDF 文件、DSC 的 INF 作用域 section、DSC 全局 PCD section、INF 文件 PCD section 的默认值、DEC 文件默认值']
- **排版和空白有哪些规定？** (tier=simple) faith=5 relev=2 halluc=[]
- **新手最常撞上的那几个编译/链接报错，分别是什么原因、怎么修？** (tier=standard) faith=4 relev=4 halluc=['该条目未给出具体生成命令，依据较弱', '若需构建 IA32 的 UEFI 交叉编译器，可使用 BaseTools/gcc 下的 mingw-gcc-build.py 脚本']
- **Uncrustify 是什么？** (tier=simple) faith=4 relev=5 halluc=[]
- **DSC 文件是干什么的？** (tier=simple) faith=4 relev=5 halluc=['DSC 中列出的 INF 文件必须包含 MdePkg/MdePkg.dec 包才能正确构建（即使模块不含 C 文件）']