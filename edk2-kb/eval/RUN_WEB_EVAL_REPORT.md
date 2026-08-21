# Web Pipeline LLM-Judge Evaluation

questions=9 mean_faithfulness=4.44 mean_relevancy=4.22

| tier | n | faith | relev | warn_l3 | warn_l2c |
|---|---|---|---|---|---|
| simple | 7 | 4.43 | 4.71 | 0 | 1 |
| standard | 1 | 4 | 3 | 0 | 0 |
| complex | 1 | 5 | 2 | 0 | 0 |

## Worst answers
- **如何提交一个补丁到 EDK2？** (tier=standard) faith=4 relev=3 halluc=['多轮修订时的补充建议（依据较弱）', '可在补丁提交信息之外用 git notes edit 记录变更说明', 'notes 是临时的，不会进入上游 master 的提交信息']
- **PCD 有哪几种类型？分别在 DEC、DSC、INF 里怎么写？C 代码里如何访问 PCD？** (tier=complex) faith=5 relev=2 halluc=[]
- **EDK2 命名规范有哪些要求？** (tier=simple) faith=5 relev=3 halluc=[]
- **PCD 是什么？** (tier=simple) faith=4 relev=5 halluc=['PCD 共有五种访问方法（access methods）', 'PCD 条目由 Token Space GUID、句点 . 和 PCD 的 C 名称组成', '平台集成者必须查看声明该 PCD 的 DEC 文件', 'DSC 中 PCD 段的写法模板如下']
- **什么是 INF 文件？** (tier=simple) faith=4 relev=5 halluc=['INF 文件是构建系统解析的最小可独立编译单元的描述文件', 'INF 文件路径必须使用正斜杠 `/` 指定所有目录路径【强制要求】']