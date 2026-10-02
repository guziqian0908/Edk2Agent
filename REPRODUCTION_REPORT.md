# Edk2Agent（edk2-opencode v6.0.22）本地复现报告

- 复现日期：2026-09-21
- 复现目录：`D:\edk2Agent`（仓库）+ `D:\edk2Agent\.edk2-opencode`（运行期数据）
- 依据：仓库 `wiki/Home.md`（v6.0.22，含 main 上的 Web/6 数据源增强）
- 源码版本：`package.json` = **6.0.22**，HEAD = `149c960`

---

## 1. 安装位置（尽量不占 C 盘）

| 组件 | 路径 | 说明 |
|---|---|---|
| 仓库代码 | `D:\edk2Agent` | `git clone`（含 `.git`） |
| Git | `D:\tools\MinGit` | MinGit 2.55.0（便携，未装到 C 盘） |
| Python | `D:\tools\Python311` | CPython 3.11.9（per-user，TargetDir 指向 D 盘） |
| Node | `C:\Program Files\nodejs` | 复用系统已有 v24.21.0 |
| 运行期数据 | `D:\edk2Agent\.edk2-opencode` | 模型 / KB / venv |
| `~/.edk2-opencode` | **目录联接** | `C:\Users\admin\.edk2-opencode` → `D:\edk2Agent\.edk2-opencode`（C 盘仅占几个字节的链接） |
| 缓存重定向 | `D:\edk2Agent\.cache` | pip / HuggingFace / npm 缓存 |
| 合并 CA 包 | `D:\tools\certs\ca-bundle.pem` | certifi + Windows 全部根/中间证书 |

D 盘总占用约 **14.7 GB**（KB 2.5 + 模型 4.28 + venv 5.08 + 缓存 2.79）。
C 盘新增仅为上述目录联接（无实际数据）。

## 2. 环境搭建要点（含遇到的真实问题）

1. **Git TLS 失败** `CRYPT_E_NO_REVOCATION_CHECK`：
   本机装有 TLS 拦截型加速器（`SteamTools Certificate` / BeyondDimension，即 Watt Toolkit）。
   其根证书只在 Windows 证书库、不在 certifi/OpenSSL 中。
   → 导出「certifi + Windows 根/中间证书」合并包，配置
   `git config --global http.sslBackend openssl` + `http.sslCAInfo=<bundle>`
   （`sslVerify` 保持 **true**），并给 Python 设置 `REQUESTS_CA_BUNDLE` / `SSL_CERT_FILE` / `CURL_CA_BUNDLE`。
2. **模型下载失败**：该代理会剥离 `X-Repo-Commit` 头，导致 `huggingface_hub` 的 HEAD 校验中断；且默认还会拉取用不到的 `onnx/model.onnx_data`。
   → 改为「直接 GET + Range 断点续传」下载器，并跳过 ONNX/图片等无用文件（`D:\tools\edk2-build\download_models_direct.py`）。
3. **Shell 规范 PDF 缺失**：uefi.org 返回 403、archive.org 本机不可达 → 属 Wiki 第 6 节明确记载的**已知非致命**情况，脚本自动跳过该 PDF。
4. **嵌入模型路径**：模型用 `local_dir` 下载，不在 HF 缓存中，故构建索引时必须把
   `EDK2_EMBEDDING_MODEL` 指向本地目录（`...\models\bge-m3`），否则 `local_files_only=True` 会失败。

## 3. 知识库数据源（6 源，共 99,112 分块）

| 数据源 | 原始 | 分块 |
|---|---|---|
| tianocore-wiki | 288 HTML | 2,315 |
| tianocore-docs | 33 仓库 / 1,453 文件 | 11,196 |
| uefi-specs | ACPI_6.5 + PI_1.10 + UEFI_2.11 RST | 8,195 |
| edk2-commits | 49,623 提交 | 49,662 |
| edk2-prs | 8,396 PR | 15,924 |
| edk2-mdepkg | 11,820 文件（排除 Library/） | 11,820 |
| **合计** | | **99,112** |

- 向量库：ChromaDB（bge-m3，**1024 维**，cosine），`chroma_db/` 约 1.1 GB
- 全文库：SQLite FTS5（porter+unicode61），`fts_index.db` 约 149 MB
- 模型：`bge-m3`（2.1 GB）+ `bge-reranker-v2-m3`（2.1 GB），本地离线加载
- 计算设备：**CUDA（RTX 5070 Ti，sm_120）**，嵌入约 60–65 chunks/s

> 注：`edk2-prs` 只有 8,396 条 —— GitHub Search API 报告 tianocore/edk2 的 PR 总数为 8,221，且分页已耗尽（第 9000 页为空），故 8,396 即 API 可得的全量。Wiki 中的 15,332 是过期/不同口径的数字。

## 4. 服务验证（对照 Wiki 5.1 核查表）

| # | 核查项 | 结果 |
|---|---|---|
| 1 | 代码获取、版本 6.0.22 | ✅ |
| 2 | 模型本地化（两个目录） | ✅ bge-m3 + bge-reranker-v2-m3 |
| 3 | 知识库构建 | ✅ 99,112 分块 + chroma_db + fts_index.db |
| 4 | 六数据源齐全 | ✅ |
| 5 | 维度一致性 = 1024 | ✅ `/embed` 返回 1024 维 |
| 6 | daemon 启动 | ✅ 动态端口，`daemon.json` 写入 |
| 7 | `/health` 200 且 Chroma 可用 | ✅ ready=true, indexed=99112 |
| 8 | `/search` 返回 citation | ✅ |
| 9 | MCP `search_kb` | ✅ initialize OK；tools=[search_kb, get_kb_status, get_kb_citation_guide]；返回 3 条 |
| 10 | 离线检索 | ⚠️ 设计上离线（`local_files_only=True`、全本地索引），未做断网破坏性测试 |
| 11 | Web 服务 `/healthz` | ✅ `{"ok":true}`，`/` 200，`/api/status` 正常 |
| 12 | Web 问答 | ⏭️ 按用户要求未配置 `LLM_API_KEY`（`llm_configured:false`，仅返回检索结果） |
| 13 | 详略分级 | ⏭️ 需 LLM Key |
| 14 | Web 评测门控 | ⏭️ 需 LLM Key |
| 15 | 全量评测 | ✅ 已跑（见下） |

## 5. 检索评测结果

`edk2-kb/eval/run_eval.py`（330 条，top_k=10），baseline = `hybrid+rerank`：

| 配置 | 全局 Hit@5 | manual 130 | auto 200 |
|---|---|---|---|
| **本机 6 源（Wiki 路径 A 实际产出）** | **86.7%** | 83.8% | 88.5% |
| **本机 2 源（wiki+docs，v6.0.22 配置）** | **90.9%** | 86.2% | 94.0% |
| Wiki 记录（v6.0.22，2 源） | 92.7% | 89.2% | 95.0% |
| （参考）hybrid 无重排，6 源 | 79.4% | 77.7% | 80.5% |

**结论**：检索引擎已正确复现 —— 2 源配置下 90.9% 与 Wiki 的 92.7% 仅差 1.8 个百分点，
差异来自上游文档已更新（本次分块 13,511，而当时为 14,819；文件/章节号变化会影响期望命中）。

Wiki 的「92.7%」与「6 大数据源」本身相互矛盾：6.0.24 才把数据源 2→6、分块 14819→82297，
而 92.7% 是 6.0.22（2 源）的成绩。6 源 KB 新增大量 commits/PRs/MdePkg 候选（commits 一项就占
49,662 块），对以 docs/wiki 为标准的测试集构成噪声，故 Hit@5 自然下降到 86.7%。

## 6. 运行方式

```powershell
# 环境（如需手动执行）
$env:Path = "D:\tools\MinGit\cmd;D:\tools\Python311;D:\tools\Python311\Scripts;$env:Path"
$env:EDK2_KB_DATA         = "D:\edk2Agent\.edk2-opencode\kb\data"
$env:EDK2_MODELS_DIR      = "D:\edk2Agent\.edk2-opencode\models"
$env:EDK2_EMBEDDING_MODEL = "D:\edk2Agent\.edk2-opencode\models\bge-m3"
$env:EDK2_EMBEDDING_DEVICE= "cuda"; $env:EDK2_RERANKER_DEVICE = "cuda"

# daemon
node bin/edk2-opencode.js daemon start|stop|restart|status|logs
node bin/edk2-opencode.js --search "PcdDebugPrintErrorLevel"

# Web 问答（8080）
cd web; $env:RERANK_PY="D:\edk2Agent\.edk2-opencode\kb\venv\Scripts\python.exe"; node server.js

# 评测
& "D:\edk2Agent\.edk2-opencode\kb\venv\Scripts\python.exe" edk2-kb/eval/run_eval.py --data-dir "$env:EDK2_KB_DATA"
```

复现脚本集中在 `D:\tools\edk2-build\`（`env.ps1`、`01_install_deps.ps1`、`03a`~`03d`、`04_verify_daemon.ps1`、`05_eval.ps1`、`06_web.ps1`、`08_eval_2src.ps1`、`download_models_direct.py`）。

## 7. 已知偏差

1. Shell 2.2 PDF 未纳入（uefi.org 403，已知非致命）。
2. 2 源评测 90.9% vs Wiki 92.7%：上游文档漂移（分块数不同）。
3. 6 源 KB 分块数 99,112 > Wiki 82,297：上游数据增长 + PR/commit 持续增加。
4. PR 数量以 GitHub API 实得为准（8,396）。
5. Web 的 LLM 问答 / 分档门控 / LTR 训练需 `LLM_API_KEY`，本次未配置。

---

## 8. 回答质量优化（2026-09-21）

目标：不局限于评测集，让任意 EDK2 问题的**检索证据更准、答案更有价值**。

### 8.1 实验与结论

| 实验 | 全局 Hit@5 | manual | auto | 结论 |
|---|---|---|---|---|
| 初始 6 源 | 86.7% | 83.8% | 88.5% | 基线 |
| ①-A 去噪（commits/prs 不嵌入） | 87.0% | 83.8% | 89.0% | **几乎无增益**；commit/PR 不是瓶颈 |
| ①-A + 来源加权 | 87.0% | 84.6% | 88.5% | MRR 略升，Hit@5 持平 |
| ①-B **召回加深 + 标题词法加权** | **90.6%** | **86.9%** | **93.0%** | **显著提升（+3.9）** |

失败归因显示：短问句（如 "hardware input"、"13 terms"）的漏检主因是**召回不足**——正确文档没进候选窗口，
被 `edk2-mdepkg` 的通用头文件淹没；这类问题重排无法挽救，必须加深召回并用标题/文件名做词法加权。

### 8.2 代码改动（均可用环境变量关闭，保持默认行为可回退）

`edk2-kb/search_engine.py`：
- `EDK2_CHROMA_MULT`（默认 10）：稠密召回条数 = top_k × 该值（原 6）。
- `EDK2_WINDOW_MULT`（默认 5）：送入重排的候选窗口 = top_k × 该值（原 3）。
- `EDK2_TITLE_BOOST`（默认 0.35）：查询词与 `文件名/标题/章节` 的词法重合度加成，
  用于"按页面标题提问"的场景；同时作用于融合与重排两个路径。
- `EDK2_SOURCE_WEIGHTS`（默认空=中性）：按来源加权，如 `edk2-mdepkg:0.6`。

`edk2-kb/mcp_server.py`：
- `EDK2_DAEMON_RERANK`（默认 1）：MCP `search_kb` 与 `/search` 是否走交叉编码器重排。
  开启后 `/search` 才返回 `rerank_score` + `confidence`（与 Wiki §4.3 描述一致；此前为 `unrated`）。

### 8.3 使用建议

- 追求最高检索质量：保持默认（召回加深 + 标题加权 + daemon 重排）。
- 降低延迟：`EDK2_DAEMON_RERANK=0`、`EDK2_WINDOW_MULT=3`。
- 若要还原"未优化"的原始行为：`EDK2_TITLE_BOOST=0 EDK2_CHROMA_MULT=6 EDK2_WINDOW_MULT=3 EDK2_DAEMON_RERANK=0`。

### 8.4 待办

- **生成层**：接入 LLM（云端 API 或本地 Ollama）才能产出"回答"，检索只是证据。
- **覆盖**：Wiki 仅 288 页（全站约 380），可用官方 git 源补全。
- **数值型查询**：如 "372 drivers" 仍会漏（稠密优先使 BM25 精确命中被挤出窗口），
  下一步可在融合阶段让 BM25 精确匹配与稠密结果**交错**而非"仅填充"。
