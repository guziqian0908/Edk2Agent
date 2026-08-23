# Web Pipeline LLM-Judge Evaluation

questions=18 mean_faithfulness=4.25 mean_relevancy=4.72

## Tier Gates
| tier | n | faith | gate | relev | gate | status |
|---|---|---|---|---|---|---|
| simple | 8 | 4.5 | >=4.5 | 4.62 | >=4.5 | PASS |
| standard | 2 | 4.5 | >=3.8 | 5 | >=4.4 | PASS |
| complex | 8 | 3.94 | >=3.8 | 4.75 | >=4.2 | PASS |

## Gate: PASS (per-tier)

| tier | n | faith | relev | warn_l3 | warn_l2c |
|---|---|---|---|---|---|
| simple | 8 | 4.5 | 4.62 | 0 | 0 |
| standard | 2 | 4.5 | 5 | 0 | 0 |
| complex | 8 | 3.94 | 4.75 | 6 | 0 |

## Worst answers
- **排版和空白有哪些规定？** (tier=simple) faith=4 relev=2 halluc=[]
- **PCD 有哪几种类型？分别在 DEC、DSC、INF 里怎么写？C 代码里如何访问 PCD？** (tier=complex) faith=4 relev=3 halluc=['DEC 中按访问方法分节声明，例如 `[PcdsFixedAtBuild]`、`[PcdsPatchableInModule]`、`[PcdsDynamic]`、`[PcdsDynamicEx]`、`[PcdsFeatureFlag]`。', '一个 FeatureFlag PCD 不得在 DEC 中同时列于其他访问方法节，否则构建必须报错', '二进制 INF（无 `[Sources]` 节）只能包含 `[PcdEx]` 和 `[PatchPcd]` 节，若含其他类型 PCD 则构建必须报错', '动态 PCD 数据库：构建系统根据 FDF、DSC 及其中列出的 INF 文件生成 `PeiPcdDataBase.raw` 和 `DxePcdDataBase.raw` 外部二进制数据库文件', '具体访问宏的写法在当前上下文中未提供，无法确认各访问方法的 C 代码宏名称。', '当前上下文未提供 DEC、DSC、INF 中 PCD 条目的具体字段格式']
- **编译单个模块用什么命令？** (tier=simple) faith=3 relev=5 halluc=['构建后生成的 HelloWorld.efi 位于 DEBUG 目录下', '同时会生成中间文件、AutoGen.h、AutoGen.c 和 Module.map 等文件']
- **库类(Library Class)和库实例(Library Instance)到底是什么关系？为什么 DSC 里非要写一行映射？** (tier=complex) faith=3 relev=5 halluc=['原文第 4 条被截断，但按前三条递推逻辑应为 [LibraryClasses.Common]）【综合推导：由 cd4151ad9 前三条递推，原文无直接表述】', '根据当前资料无法确认具体的校验工具名称。资料仅说明构建系统解析 DSC 文件时收集库类到库实例的映射，以及解析 INF 文件时收集库类列表，但未提及独立的校验工具。若需校验，可依赖 EDK II 构建系统（build 命令）在解析阶段对上述规则进行检查（依据较弱）。', '一个 PCD 条目在 DSC 或 FDF 的每个节中只能列出一次[c03c8b43b]', '若需校验，可依赖 EDK II 构建系统（build 命令）在解析阶段对上述规则进行检查（依据较弱）']
- **DSC 文件是干什么的？** (tier=simple) faith=4 relev=5 halluc=['DSC 文件不指定编译后二进制如何放入 UEFI/PI 合规镜像——这是 FDF 文件的职责', '根据当前资料无法确认具体的 DSC 校验工具名称', 'DSC 文件不指定编译后二进制如何放入 UEFI/PI 合规镜像——这是 FDF 文件的职责[c4d98a1d2]']