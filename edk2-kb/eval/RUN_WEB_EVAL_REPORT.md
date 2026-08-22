# Web Pipeline LLM-Judge Evaluation

questions=18 mean_faithfulness=4.22 mean_relevancy=4.78

## Gate: FAIL (faithfulness>=4.6, relevancy>=4.4)

| tier | n | faith | relev | warn_l3 | warn_l2c |
|---|---|---|---|---|---|
| simple | 8 | 4.25 | 4.62 | 0 | 0 |
| standard | 2 | 4.5 | 5 | 0 | 1 |
| complex | 8 | 4.12 | 4.88 | 7 | 0 |

## Worst answers
- **排版和空白有哪些规定？** (tier=simple) faith=4 relev=3 halluc=['当前资料未提供更多关于排版的具体规定', '建议查阅 EDK II C Coding Standards Specification 的 3.2 Formatting 章节']
- **编译单个模块用什么命令？** (tier=simple) faith=3 relev=5 halluc=['构建后生成的 HelloWorld.efi 位于 DEBUG 目录下', '同时会生成 AutoGen.h、AutoGen.c 和 Module.map 等中间文件']
- **EDK2 命名规范有哪些要求？** (tier=simple) faith=4 relev=4 halluc=[]
- **PCD 有哪几种类型？分别在 DEC、DSC、INF 里怎么写？C 代码里如何访问 PCD？** (tier=complex) faith=4 relev=4 halluc=['PCD 值来源依次为：命令行、FDF 文件、DSC 的 INF 作用域 section、DSC 的全局 PCD section、INF 文件 PCD section 中的默认值、DEC 文件的默认值', 'BINARY INF 的访问方法赋值优先于源码 INF']
- **什么是 INF 文件？** (tier=simple) faith=4 relev=5 halluc=['INF 文件是模块的必需组成部分', '描述模块的属性、如何编码、提供什么、依赖什么、架构相关项、特性等']