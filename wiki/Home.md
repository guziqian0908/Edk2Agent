# Edk2Agent（edk2-opencode）Wiki

> 本文档面向"仅凭本 Wiki 即可从零复现环境搭建、知识库构建、服务部署与功能验证"的 AI 工程师与验收人员。所有命令、路径、指标均与 **v6.0.22**（`package.json` 版本号）严格对应，可直接对照执行。知识库已从最初的双数据源扩展为 **6 大数据源（82297 个分块）**，并提供三条搭建路径（`setup_kb` 一键重建 / `install_kb` 预构建包 / `--init-edk2-wiki` 原始终端命令）。

---

## 目录

1. [项目整体架构说明](#1-项目整体架构说明)
   - [1.1 项目定位与开发属性](#11-项目定位与开发属性)
   - [1.2 完整过程总览（端到端）](#12-完整过程总览端到端)
   - [1.3 RAG 三层架构](#13-rag-三层架构)
   - [1.4 迭代演进 v6.0.5 → v6.0.22](#14-迭代演进-v605--v6022)
2. [全流程环境搭建](#2-全流程环境搭建)
   - [2.1 系统要求](#21-系统要求)
   - [2.2 前置环境依赖清单（先装基础工具）](#22-前置环境依赖清单先装基础工具)
   - [2.3 获取代码与安装](#23-获取代码与安装)
   - [2.4 模型本地化下载（离线加载）](#24-模型本地化下载离线加载)
   - [2.5 初始化知识库](#25-初始化知识库)
   - [2.6 daemon 守护进程管理](#26-daemon-守护进程管理)
   - [2.7 环境变量汇总](#27-环境变量汇总)
   - [2.8 目录与数据布局](#28-目录与数据布局)
3. [知识库构建完整规范](#3-知识库构建完整规范)
   - [3.1 输入文件类型清单](#31-输入文件类型清单)
   - [3.2 数据源清单](#32-数据源清单)
   - [3.3 文档处理与分块规则](#33-文档处理与分块规则)
   - [3.4 向量索引构建（ChromaDB）](#34-向量索引构建chromadb)
   - [3.5 全文索引构建（FTS5）](#35-全文索引构建fts5)
   - [3.6 混合检索与融合（RRF + β）](#36-混合检索与融合rrf--)
   - [3.7 一致性约束（维度与模型匹配）](#37-一致性约束维度与模型匹配)
4. [功能与验证体系](#4-功能与验证体系)
   - [4.1 检索质量分层与置信度](#41-检索质量分层与置信度)
   - [4.2 citation 引用与回答规范](#42-citation-引用与回答规范)
   - [4.3 服务端点与 MCP 工具](#43-服务端点与-mcp-工具)
   - [4.4 eval-query 命令与解读（含实操示例）](#44-eval-query-命令与解读含实操示例)
   - [4.5 评测框架与指标体系](#45-评测框架与指标体系)
   - [4.6 当前评测结果（验收基准）](#46-当前评测结果验收基准)
5. [任务验收判定规则](#5-任务验收判定规则)
   - [5.1 AI 复现路径核查表](#51-ai-复现路径核查表)
   - [5.2 硬性验收指标](#52-硬性验收指标)
   - [5.3 关键 bug 修复验证点](#53-关键-bug-修复验证点)
6. [故障排查与常见问题](#6-故障排查与常见问题)
7. [Web 回答服务部署与验证](#7-web-回答服务部署与验证)
   - [7.1 架构概述](#71-架构概述)
   - [7.2 环境配置](#72-环境配置)
   - [7.3 启动与验证](#73-启动与验证)
   - [7.4 详略分级与查询分解](#74-详略分级与查询分解)
   - [7.5 批评-修订循环（C'）](#75-批评-修订循环c)
   - [7.6 评测门控](#76-评测门控)
   - [7.7 学习排序（LTR）流水线](#77-学习排序ltr流水线)
   - [7.8 查询扩展规则](#78-查询扩展规则)
   - [7.9 分档监控](#79-分档监控)

---

## 1. 项目整体架构说明

### 1.1 项目定位与开发属性

- **仓库**：**`Edk2Agent`**（GitHub，`guziqian0908/Edk2Agent`），npm 包名 **`edk2-opencode`**，版本 **v6.0.22**（以 `package.json` 为准；`README.md` 头部历史遗留标记为 v6.0.1、postinstall 标记为 v6.0.0，均不影响功能）。
- **定位**：面向 EDK II / UEFI 技术问答的**自研 RAG 检索服务端**。它不包含 LLM，是一个"纯检索引擎服务"，LLM（如 Claude / opencode）作为 **MCP 客户端**调用其 `/mcp` 端点获取检索结果后组织回答。
- **开发属性**：混合检索（向量 + 全文）、重排（交叉编码器）、置信度分级、评测框架的**逻辑全部自主开发**。底层仅依赖开源组件：
  - **ChromaDB** —— 向量数据库（持久化）。
  - **bge-m3**（Embedding）与 **bge-reranker-v2-m3**（重排）—— 开源模型（本地化加载）。
  - **SQLite FTS5** —— 全文检索。
  - **WeKnora 已全部移除**，无任何 WeKnora 相关依赖与代码。

### 1.2 完整过程总览（端到端）

以下从"输入资料"到"验证通过"的完整链路，供快速理解本项目全貌：

```
① 输入资料收集（6 大数据源）
   ├─ TianoCore Wiki   → 288 个 HTML（全站离线副本）
   ├─ tianocore-docs   → 1797 个文本文件（33 个规范仓库）
   ├─ uefi-specs       → 185 个 RST + 1 个 Shell PDF（4 部官方规范）
   ├─ edk2-commits     → 36434 个提交（2006 至今完整 git log）
   ├─ edk2-prs         → ~8000+ 个 Pull Request（GitHub API，数量随时间增长）
   └─ edk2-mdepkg      → MdePkg 源码（1982 个文件，排除 Library/）
            │
② 清洗与分块（edk2-kb/fetchers/init_kb.py + add_mdepkg.py）
   ├─ HTML→Markdown 文本（html2text / BeautifulSoup+lxml）
   ├─ 跳过超大 print.html；丢弃 <100 字符噪音段
   └─ 按标题层级切块 → 82297 个 .txt（chunk_size=800, overlap=100）
            │
③ 建索引（双路）
   ├─ 向量：ChromaDB（bge-m3 1024 维, cosine, batch=50）
   └─ 全文：SQLite FTS5（porter + unicode61, BM25）
            │
④ 部署服务（daemon_runner.py watchdog → mcp_server.py）
   ├─ 动态端口 + daemon.json + 单例锁
   └─ /mcp /health /search /stats /shutdown
            │
⑤ 检索链路（search_engine.py, LLM 为 MCP 客户端）
   ├─ 向量召回 + FTS 召回 → RRF + β 融合 → bge-reranker-v2-m3 重排
   ├─ 置信度分级（high/medium/low/poor）
   └─ citation 组装 → 返回 LLM 组织回答
            │
⑥ 验证与评测（edk2-kb/eval/）
   ├─ eval-query：单条新旧对比（快速迭代）
   └─ run_eval.py：330 条全量评测 → Hit@5 / MRR
```

**开源 vs 自研的边界**：

| 组件 | 是否自研 | 说明 |
|------|----------|------|
| 混合检索逻辑（向量+FTS+RRF+β 融合） | ✅ 自研 | 融合权重、保底策略自主设计 |
| 交叉编码器重排流程 | ✅ 自研 | 重排调度与阈值标定自主实现 |
| 置信度分级 | ✅ 自研 | `_RERANK_SCALES` 双打分域标定 |
| 评测框架（330 条数据集 / run_eval / judge / eval-query） | ✅ 自研 | 测试集、指标计算、对比工具全部自主 |
| MCP 协议封装与 daemon 守护 | ✅ 自研 | 端点、工具、进程锁自主实现 |
| 底层向量库 | 开源 | **ChromaDB** |
| 嵌入/重排模型 | 开源 | **bge-m3** / **bge-reranker-v2-m3** |
| 全文检索引擎 | 开源 | SQLite **FTS5** |
| 旧 RAG 框架 | 已移除 | **WeKnora 全部移除** |

### 1.3 RAG 三层架构

```
┌─────────────────────────────────────────────────────────┐
│  客户端层：opencode / Claude 等 LLM（MCP 客户端）          │
│  通过 stdin/stdio 或 Streamable HTTP 连接 daemon          │
└──────────────────────────┬──────────────────────────────┘
                           │ MCP 协议
┌──────────────────────────▼──────────────────────────────┐
│  daemon 守护进程层（edk2-kb/daemon_runner.py watchdog）   │
│  · 单例看门狗：监视 mcp_server.py 子进程，崩溃自动拉起      │
│  · 动态端口绑定（0.0.0.0:0），端口写入用户目录 daemon.json  │
│  · 进程锁：opencode-edk2-agent.lock 防止多实例              │
└──────────────────────────┬──────────────────────────────┘
                           │ 内部调用
┌──────────────────────────▼──────────────────────────────┐
│  MCP 协议层（edk2-kb/mcp_server.py，Streamable HTTP）     │
│  端点：/mcp /health /search /stats /shutdown              │
│  工具：search_kb / get_kb_status / get_kb_citation_guide  │
│  Prompt：edk2_kb_search_instruction                      │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│  RAG 检索引擎层（edk2-kb/search_engine.py）               │
│  1) 向量检索  ChromaDB（bge-m3, cosine）                  │
│  2) 全文检索  FTS5（porter + unicode61）                  │
│  3) 融合      RRF（Reciprocal Rank Fusion）+ β 加权       │
│  4) 重排      交叉编码器 bge-reranker-v2-m3               │
│  5) 置信度    阈值分级（high/medium/low/poor）            │
│  6) citation  引用格式化与溯源                             │
└──────────────────────────────────────────────────────────┘
```

**一次查询的完整链路**：LLM → MCP `search_kb` → `SearchEngine.search()` → Chroma（向量 topN）+ FTS（全文 topN）→ RRF 融合 + β 加权 → 交叉编码器重排 → 置信度分级 + citation 组装 → 返回给 LLM 组织回答。

### 1.4 迭代演进 v6.0.5 → v6.0.22（+ Web 回答服务增强）

| 版本 | 目标 | 主要改动 | 收益 |
|------|------|----------|------|
| **6.0.5** | 分块参数统一 | chunk 清理、分块参数统一 | 消除分块行为不一致 |
| **6.0.7** | 构建性能 | 修复 `print.html`（1.7GB 单文件）O(N²) 处理 | 大规模文档处理不再挂起 |
| **6.0.8** | 模型加载 | 模型下载挂起修复、默认换小模型、`local_files_only=True` | 离线可用、启动稳定 |
| **6.0.10** | 健康与混合检索 | 健康窗口 20s→60s；`hybrid(FTS5+RRF)`；section-aware 分块 | 首启更稳，检索召回更准 |
| **6.0.12** | 重排 | 交叉编码器重排 + 多查询扩展 | top5 命中率显著提升 |
| **6.0.13** | 回答规范 | citation / 回答规则写入 prompt | 回答可溯源 |
| **6.0.14** | 评测基线 | 评测框架落地，330×4 基线 | **基线 Hit@5 = 57.3%** |
| **6.0.15** | 置信度 | confidence 四级（high/medium/low/poor） | 可判断检索好坏 |
| **6.0.16/17** | 评测工具 | `eval-query` 命令 | 单条查询对比可用 |
| **6.0.18** | 安全 | 默认禁用 webfetch / websearch | 纯离线、防外泄 |
| **6.0.19** | 多语（P0） | reranker 多语支持；130 条标注纳入 judge | 中文检索可用 |
| **6.0.20** | 多语（P1） | embedder 多语（bge-m3，1024 维全量重建） | 中文 Hit@5 12.5%→62.5% |
| **6.0.21** | 精确度 | 去重 bug 修复 + β 融合 + RRF top2 保底 | 全局 Hit@5 →92.7% |
| **6.0.22** | 健康修复 | 维度 probe 修复（`numpy` `or` 布尔歧义） | `/health` 不再误报 ChromaDB unavailable |
| **6.0.23*** | Web 回答服务层增强（已合入 `main`） | ① **完整性强制令**：prompt 要求完整枚举所有规则/枚举值/API 签名，禁止省略概括；② **混合重排**：检索 `top_k` 25→35，rerank 后保顶 3 防关键块被挤出，再按重排序回填至 15；③ **元数据过滤** `pruneByMetadata`：检索结果在重排前置前被剪除标题/章节/文件无任何查询信号者（保底 floor=10、信号 <3 跳过）；④ **引用本地化**：参考来源由 gitbook 外链改为 `文件路径 > 章节` 本地定位，禁止拼造网址；⑤ **多轮对话**：`web/index.html` 携带 `prevResults`（上一轮检索结果）与历史，追问时跳过重复检索 | 枚举类问题完整性显著提升；关键命中块（如 4.4 Identifiers）不再被 reranker 挤出 top 3；明显无关知识块被前置过滤；回答参考来源全部指向本地文档，可离线追溯；多轮追问上下文连续 |
| **6.0.24*** | 知识库扩容与一键重建 | ① **数据源 2→6**：新增 `uefi-specs`（UEFI/ACPI/PI/Shell 官方规范）、`edk2-commits`（完整提交历史）、`edk2-prs`（全部 PR）、`edk2-mdepkg`（MdePkg 源码）；② **`setup_kb.ps1/.sh` 一键重建**：`fetch_models.py`（本地模型）→ `fetch_specs.py` → `fetch_commits.py` → `fetch_prs.py` → `init_kb.py` → `add_mdepkg.py`；③ **`package_kb.py` + `install_kb.ps1/.sh` 预构建包**：kb-runtime / kb-full 分片（≤1.8GB）+ SHA-256 清单，免重建嵌入；④ 分块数 14819 → **82297** | 覆盖真实 EDK2 开发活动（代码/PR/提交/规范），问答域从纯文档扩展到工程实践 |

> 版本发布节奏：tags `v6.0.4` ~ `v6.0.22` 已全部推送到 GitHub，`main` 分支 HEAD 即 v6.0.22。`6.0.23*`（Web 回答服务）与 `6.0.24*`（数据源扩容 + 一键重建）为 main 分支上的未发版增强，改动集中在 `web/server.js`（LLM 回答编排层）、`edk2-kb/fetchers/` 与仓库根目录的 `setup_kb.*` / `install_kb.*` / `package_kb.py`。

---

## 2. 全流程环境搭建

### 2.1 系统要求

| 项目 | 要求 |
|------|------|
| 操作系统 | Windows / Linux / macOS（本文以 Windows PowerShell 为例） |
| Node.js | ≥ 18（推荐 20+） |
| Python | ≥ 3.8，< 3.13（推荐 3.10/3.11）；需 `venv` + `pip` |
| Git | ≥ 2.20（克隆与版本管理必需） |
| 磁盘 | 仓库 + 依赖 ~1GB；知识库约 4GB（82297 个分块文件 + chroma_db 1.9GB）；模型约 4.5GB；合计建议预留 ≥ 15GB（`kb-full` 含原始源树再加 ~2GB） |
| 内存 | ≥ 8GB（bge-m3 与 reranker 同时加载） |
| 网络 | 首次构建知识库需联网抓取官方文档 + 下载模型；运行期可完全离线 |

### 2.2 前置环境依赖清单（先装基础工具）

> ⚠️ **必须在执行任何 `git`/`npm`/`python` 命令前完成**。AI 若直接运行 `git clone` / `npm install` 会因工具未安装而报"命令不存在"，流程中断。先逐条安装并验证：

| # | 工具 | 版本要求 | 安装方式（Windows） | 验证命令（通过标准） |
|---|------|----------|---------------------|------------------------|
| 1 | **Git** | ≥ 2.20 | 下载安装包：https://git-scm.com/download/win（一路 Next，含 Git Bash） | `git --version` → 输出 `git version 2.x.x` |
| 2 | **Node.js**（含 npm） | ≥ 18，推荐 20 LTS | 下载安装包：https://nodejs.org/（LTS 版） | `node -v` → `v20.x.x`；`npm -v` → `10.x.x` |
| 3 | **Python** | ≥ 3.8 且 < 3.13 | 下载安装包：https://www.python.org/downloads/（安装时勾选 *Add to PATH*） | `python --version` → `Python 3.10.x`；`pip --version` → `pip 23.x` |
| 4 | **pip + venv**（Python 自带模块） | 随 Python 安装 | 无需单独安装 | `python -m venv --help` → 正常输出帮助 |
| 5 | **huggingface_hub**（下载模型用） | 最新 | `pip install -U huggingface_hub` | `huggingface-cli --version` → 输出版本号 |

**Windows 特别说明**：若 `git`/`node`/`python` 安装后终端仍提示"命令不存在"，先**关闭并重开终端**（PATH 刷新），或在 PowerShell 执行 `$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')` 刷新环境变量后再验证。

### 2.3 获取代码与安装

```powershell
# 1) 克隆仓库（GitHub 仓库名 Edk2Agent）
git clone https://github.com/guziqian0908/Edk2Agent.git
cd Edk2Agent

# 2) 确认版本
node -p "require('./package.json').version"   # 期望 6.0.22

# 3) 安装 npm 依赖（postinstall 会执行脚本，校验环境）
npm install
```

> 若 `npm install` 因网络较慢失败，可先配置镜像：`npm config set registry https://registry.npmmirror.com` 后重试。

### 2.4 模型本地化下载（离线加载）

> 运行期 `local_files_only=True`，因此**模型必须预先下载到本机**，路径为
> `~/.edk2-opencode/models/`（Windows 下即 `%USERPROFILE%\.edk2-opencode\models\`）。

需要两个模型目录：

| 模型 | 用途 | 目录 | 主要文件 |
|------|------|------|----------|
| `BAAI/bge-m3` | 嵌入（Embedding，1024 维，多语） | `models\bge-m3\` | `pytorch_model.bin`, `config.json`, `sentencepiece.bpe.model`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`, `modules.json`, `1_Pooling\config.json`, `2_Dense\config.json`, `2_Dense\pytorch_model.bin` |
| `BAAI/bge-reranker-v2-m3` | 重排（交叉编码器，多语） | `models\bge-reranker-v2-m3\` | `pytorch_model.bin`, `config.json`, `sentencepiece.bpe.model`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json` |

**下载方法（任选其一）：**

```powershell
# 方法 A：仓库自带脚本一键下载（推荐，幂等：已存在则跳过，--force 重下）
python edk2-kb/fetchers/fetch_models.py

# 方法 B：huggingface-cli（网络直连可用时）
pip install -U huggingface_hub
huggingface-cli download BAAI/bge-m3 --local-dir "$env:USERPROFILE\.edk2-opencode\models\bge-m3"
huggingface-cli download BAAI/bge-reranker-v2-m3 --local-dir "$env:USERPROFILE\.edk2-opencode\models\bge-reranker-v2-m3"

# 方法 C：镜像源 + 关闭 Xet（国内网络 / 镜像不支持 Xet 时）
$env:HF_ENDPOINT = "https://hf-mirror.com"
$env:HF_HUB_DISABLE_XET = "1"
huggingface-cli download BAAI/bge-m3 --local-dir "$env:USERPROFILE\.edk2-opencode\models\bge-m3"
```

> 模型目录可通过环境变量 `EDK2_MODELS_DIR` 覆盖（默认 `~/.edk2-opencode/models`），`fetch_models.py` 同样遵守该变量。

> **坑点提示**：`bge-m3` 的 `pytorch_model.bin` 约 2.27GB，部分网络下 `huggingface-cli` 会卡在 Xet 协议上，务必设置 `HF_HUB_DISABLE_XET=1`；若仍失败可对 `hf-mirror.com/BAAI/bge-m3/resolve/main/pytorch_model.bin` 用支持断点续传的下载器（如 aria2 / wget）手动拉取。

### 2.5 初始化知识库

**三条路径（任选其一）：**

**路径 A：一键重建（`setup_kb`，推荐，覆盖全部 6 个数据源）**

```powershell
# Windows（仓库根目录）
powershell -ExecutionPolicy Bypass -File setup_kb.ps1
# 指定非默认路径（如 D 盘）：
powershell -ExecutionPolicy Bypass -File setup_kb.ps1 -DataDir "D:\kb\data" -ModelsDir "D:\models"
# 跳过慢速嵌入阶段（稍后补）：
powershell -ExecutionPolicy Bypass -File setup_kb.ps1 -SkipEmbed

# Linux / macOS
bash setup_kb.sh            # 或 bash setup_kb.sh --skip-embed
```

> **Windows 注意**：`setup_kb.ps1` 会自动在 `~/.edk2-opencode/kb/venv` 创建 Python 虚拟环境，所有 `pip install` 和脚本调用均在 venv 内执行，不污染系统 Python。

一键脚本依次执行（每步产出见下方流程）：

| 步骤 | 脚本 | 产出 |
|------|------|------|
| Python 依赖 | `pip install -r edk2-kb/requirements.txt` | 依赖 |
| 本地模型 | `edk2-kb/fetchers/fetch_models.py` | `models/bge-m3` + `models/bge-reranker-v2-m3` |
| UEFI 规范 | `edk2-kb/fetchers/fetch_specs.py` | `uefi-specs/{ACPI_6.5,PI_1.10,UEFI_2.11}/source/*.rst` + Shell PDF |
| 提交历史 | `edk2-kb/fetchers/fetch_commits.py` | `edk2-commits/commits.txt`（2006 至今，blobless 克隆） |
| PR 数据 | `edk2-kb/fetchers/fetch_prs.py` | `edk2-prs/prs.jsonl`（GitHub API，断点续传） |
| Wiki+docs 建库 | `edk2-kb/fetchers/init_kb.py` | wiki 全站 + 33 个 docs 仓库 + 上述数据的分块与索引 |
| MdePkg 源码 | `edk2-kb/fetchers/add_mdepkg.py`（缺失时自动稀疏克隆） | `edk2-mdepkg/` 分块 + FTS5 |

**路径 B：预构建包（`install_kb`，免重建嵌入，秒级可用）**

发布方用 `package_kb.py` 打包到 GitHub Release（`kb-runtime` 仅运行期数据 / `kb-full` 含原始源树，按 1.8GB 分片 + SHA-256 清单）；使用方下载校验解压：

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File install_kb.ps1
# 可选参数：-Prefix kb-full -Tag vX.Y.Z -Overwrite -RepoDir <克隆仓库路径>
# Linux / macOS
bash install_kb.sh
```

运行期包仅含 `chroma_db/` + `fts_index.db` + `processed/`（约 2.2GB），解压到 `~/.edk2-opencode/kb/` 即用；模型仍需 `fetch_models.py` 补（约 1GB）。

**路径 C：原始终端命令（`--init-edk2-wiki`，仅 wiki+docs 两数据源，旧路径）**

```powershell
# 1) 先设环境变量，指向本地 bge-m3
$env:EDK2_EMBEDDING_MODEL = "$env:USERPROFILE\.edk2-opencode\models\bge-m3"

# 2) 首次构建知识库
npx edk2-opencode --init-edk2-wiki

# 3) 后续增量更新
npx edk2-opencode --update
```

**关键前提（三条路径通用）**：`init_kb.py` 默认嵌入模型是 `all-MiniLM-L6-v2`（384 维），而查询引擎默认是 `bge-m3`（1024 维）。**为保证检索质量（验收目标 92.7%），构建索引时必须显式指定 `EDK2_EMBEDDING_MODEL` 指向本地 bge-m3**，否则会出现维度不匹配（384 vs 1024）导致向量检索降级。`setup_kb` 不依赖该前提（`add_mdepkg.py --embed` 固定用 bge-m3）；仅路径 C 需要手动设置。

路径 A/B 产出布局与流程（`init_kb.py` 内部）：

```
1. 在用户数据目录创建 Python venv（~/.edk2-opencode/kb/venv）或复用全局依赖
2. pip install 依赖（chromadb / sentence-transformers / FlagEmbedding / beautifulsoup4 / html2text / lxml 等）
3. 抓取数据源 → 清洗 HTML → 分块 → 写入 processed txt
4. 构建 ChromaDB 向量索引 + FTS5 全文索引
```

> 提示：`--skip-fts`（`add_mdepkg.py --skip-fts`）：daemon 运行时持有 `fts_index.db` 锁，需先 `daemon stop` 再重建；`fetch_prs.py` 无需认证（公共仓库），设置 `GITHUB_TOKEN` 可把限速从 60 提高到 5000 次/小时；各 fetch 脚本支持 `EDK2_KB_DATA` / `EDK2_MODELS_DIR` 覆盖默认路径。

### 2.6 daemon 守护进程管理

```powershell
# 启动 daemon（后台单例看门狗，自动拉起 mcp_server.py 子进程）
npx edk2-opencode daemon start

# 查看状态（端口 / 进程 / 健康）
npx edk2-opencode daemon status

# 查看日志（跟踪 /health、搜索请求等）
npx edk2-opencode daemon logs

# 重启 / 停止
npx edk2-opencode daemon restart
npx edk2-opencode daemon stop

# 不启动 daemon 的直连搜索（一次性 CLI 查询）
npx edk2-opencode --search "PcdDebugPrintErrorLevel"
```

**端口与进程锁机制**：daemon 绑定动态端口（`0.0.0.0:0`），实际端口写入 `~/.edk2-opencode/kb/daemon.json`；`opencode-edk2-agent.lock` 保证单实例。因此**端口冲突问题被设计性规避**（无需手工改端口），重启后端口可能变化，一律以 `daemon.json` 为准。

### 2.7 环境变量汇总

| 变量 | 默认 | 说明 |
|------|------|------|
| `EDK2_EMBEDDING_MODEL` | `BAAI/bge-m3`（init_kb + search_engine 均默认） | 嵌入模型；**构建索引和运行时查询必须匹配** |
| `EDK2_RERANKER_MODEL` | `BAAI/bge-reranker-v2-m3` | 重排模型（本地化） |
| `EDK2_KB_DATA` | `~/.edk2-opencode/kb/data` | 知识库数据目录（**所有** fetch_*/init_kb/add_mdepkg/package_kb 均遵守） |
| `EDK2_MODELS_DIR` | `~/.edk2-opencode/models` | 模型目录（fetch_models/add_mdepkg/**search_engine** 均遵守） |
| `GITHUB_TOKEN` | — | fetch_prs.py 的 GitHub API 令牌（无 token 限速 60/h，设后 5000/h） |
| `EDK2_EMBEDDING_DEVICE` | `cpu` | 嵌入设备（init_kb + add_mdepkg 均遵守，有 GPU 可设 `cuda`） |
| `EDK2_EMBEDDING_BATCH` | `50` | 嵌入批量（init_kb） |
| `HF_ENDPOINT` | — | 下载镜像（如 `https://hf-mirror.com`） |
| `HF_HUB_DISABLE_XET` | — | 设为 `1` 绕过 Xet 协议下载 |
| `local_files_only` | `True` | 模型只从本地加载（内置） |

### 2.8 目录与数据布局

```
~/.edk2-opencode/
├── models/
│   ├── bge-m3/                       # 嵌入模型（本地）
│   └── bge-reranker-v2-m3/           # 重排模型（本地）
└── kb/
    ├── daemon.json                   # 当前端口 / PID
    ├── venv/                         # Python 虚拟环境
    ├── fetchers/                     # 构建脚本副本
    └── data/
        ├── tianocore-wiki/           # 数据源①：288 个 HTML 页面
        ├── tianocore-docs/           # 数据源②：33 个规范仓库（1797 文本文件）
        ├── uefi-specs/               # 数据源③：ACPI_6.5/PI_1.10/UEFI_2.11 RST + Shell PDF
        ├── edk2-commits/             # 数据源④：commits.txt（36434 提交）
        ├── edk2-prs/                 # 数据源⑤：prs.jsonl（~8000+ PR）
        ├── edk2-mdepkg/              # 数据源⑥：MdePkg 源码（1982 文件）
        ├── processed/                # 处理后分块：82297 个 txt + documents.json
        ├── chroma_db/                # ChromaDB 持久化向量索引
        └── fts_index.db              # SQLite FTS5 全文索引
```

---

## 3. 知识库构建完整规范

### 3.1 输入文件类型清单

知识库构建链路中的文件类型分为三类：**原始资料 → 中间产物 → 检索索引**。

| 阶段 | 类型 | 数量 | 位置 | 说明 |
|------|------|------|------|------|
| **原始资料** | `.html` | 288 个 | `data/tianocore-wiki/` | TianoCore Wiki 全站离线副本（附 `.css`/`.js`/`.png`/`.svg` 等站点静态资源，不参与建索引） |
| **原始资料** | `.md`/`.txt`/`.html`/`.pdf` | 1797 个 | `data/tianocore-docs/repos/` | 33 个 tianocore-docs 规范仓库的文档 |
| **原始资料** | `.rst`/`.pdf` | 185 + 1 个 | `data/uefi-specs/` | ACPI_6.5 / PI_1.10 / UEFI_2.11 的 RST 源 + UEFI_Shell_2_2 PDF |
| **原始资料** | `commits.txt` | 36434 提交 | `data/edk2-commits/` | tianocore/edk2 完整提交历史（2006 至今） |
| **原始资料** | `prs.jsonl` | 15332 PR | `data/edk2-prs/` | tianocore/edk2 全部 Pull Request |
| **原始资料** | `.c`/`.h`/`.inf` 等 | 1982 个 | `data/edk2-mdepkg/MdePkg/` | MdePkg 源码（排除 `Library/`） |
| **中间产物** | `.txt` | 82297 个 | `data/processed/` | 清洗 + 分块后的独立文本块（每块一个文件，带 6 个元数据字段） |
| **检索索引** | `chroma_db/` | 1 套 | `data/chroma_db/` | ChromaDB 持久化向量索引（bge-m3，1024 维） |
| **检索索引** | `fts_index.db` | 1 个 | `data/fts_index.db` | SQLite FTS5 全文索引（BM25） |
| **其他** | `.json` | 若干 | `data/` 及各目录 | 站点元数据（metadata.json）、documents.json、来源信息等辅助文件，不参与检索 |

> 即：**输入 = HTML + Markdown/RST/源码/提交/PR 六类原始资料**，统一处理为 `.txt` 分块后写入向量库与全文库。

### 3.2 数据源清单

| 数据源 | 存储目录 | 原始文件 | 说明 |
|--------|----------|----------|------|
| TianoCore Wiki（UEFI/EDK2 用户手册站点） | `data/tianocore-wiki/` | 288 个 HTML | 全站离线副本，`print.html` 单页可超 1.7GB（O(N²) 修复点） |
| TianoCore Docs 仓库（edk2 规范/指南） | `data/tianocore-docs/` | 1797 个文本文件 | 33 个规范仓库（edk2-Specifications 系列、Edk2Workspace、UefiDriverWritersGuide、ModuleWriteGuide 等） |
| UEFI 官方规范 | `data/uefi-specs/` | 185 个 RST + 1 个 PDF | ACPI_6.5 / PI_1.10 / UEFI_2.11（Git 克隆）+ UEFI_Shell_2_2 PDF（`fetch_specs.py` 拉取，多 URL 回退） |
| EDK2 提交历史 | `data/edk2-commits/` | 36434 个提交 | `commits.txt`：2006 年至今完整 `git log --all`（blobless 克隆） |
| EDK2 Pull Request | `data/edk2-prs/` | 15332 个 PR | `prs.jsonl`：GitHub API 分页拉取，user/base/head 扁平化，断点续传 |
| MdePkg 源码 | `data/edk2-mdepkg/` | 1982 个文件 | tianocore/edk2 的 MdePkg 子树（稀疏克隆），排除 `Library/` |

### 3.3 文档处理与分块规则

- **清洗**：BeautifulSoup + lxml 解析 HTML；html2text 转 Markdown 文本；**跳过 `print.html`（超大聚合页）**；丢弃长度过短（< 100 字符）的噪音段。
- **分块**：`chunk_text_structured`，默认 **chunk_size = 800、overlap = 100、最小块 200 字符**；按 Markdown 标题层级（`#`/`##`/`###`）切块，保留 **section 路径**（如 `31.4.1 Configuring DebugLib with EDK II > 31.4.1.3 DebugLib Platform Configuration Database Settings`），超长块调用 `_split_long_text` 二次切分。
- **输出**：每个分块写入 `data/processed/` 下一个独立 txt，元数据字段包含：

| 字段 | 含义 |
|------|------|
| `Title` | 文档标题 |
| `URL` | 原始来源 URL（用于 citation） |
| `Source` | 来源仓库/站点 |
| `Chunk` | 分块序号 |
| `Section` | 章节路径 |
| `Position` | 块内位置 |

### 3.4 向量索引构建（ChromaDB）

- 用 `build_chroma_index` 批量写入，**batch size = 50**；`PersistentClient` 持久化到 `data/chroma_db/`。
- 距离度量 **cosine**；分块 ID 形如 `doc_{i}`；metadata 挂载上述 6 个字段。
- **维度一致性**：v6.0.20 起嵌入升级为 bge-m3（1024 维），**必须全量重建索引**（旧 384 维索引不可复用）。

### 3.5 全文索引构建（FTS5）

- SQLite FTS5，分词器 **`porter` + `unicode61`**（英文词干 + Unicode 支持），持久化到 `data/fts_index.db`。
- 用于 BM25 全文召回，与向量召回在融合阶段合并。

### 3.6 混合检索与融合（RRF + β）

```
score = β · Chroma cosine 归一化得分 + (1 − β) · RRF 融合分
       + 重排后交叉编码器得分（bge-reranker-v2-m3）
```

- **RRF（Reciprocal Rank Fusion）**：按排名倒数求和，融合向量与全文两个召回列表。
- **β 加权**（v6.0.21 引入）：在 RRF 基础上对两类召回来源加权平衡。
- **RRF top2 保底**（v6.0.21）：保证双路召回中排名第 2 的结果也不被丢弃。

### 3.7 一致性约束（维度与模型匹配）

1. **构建与查询默认同一嵌入模型**：`init_kb.py` 和 `search_engine.py` 均默认 `BAAI/bge-m3`（1024 维），无需额外设置即可匹配。
2. 若显式设 `EDK2_EMBEDDING_MODEL` 为其他模型（如 `all-MiniLM-L6-v2` 384 维），则**构建和查询必须同时设同一值**，否则维度不匹配 → 向量检索失败。**必须全量重建**。
3. `search_engine.py` 读取 `EDK2_MODELS_DIR` 定位本地模型目录（与 `fetch_models.py` / `add_mdepkg.py` 一致），不再硬编码 `~/.edk2-opencode/models`。
4. 重排器缺失（reranker 目录不存在 / 加载失败）时检索退化为"无重排"模式（等价 v6.0.11 前效果）。

---

## 4. 功能与验证体系

### 4.1 检索质量分层与置信度

检索返回每个候选的 `confidence`，共四级，用于判断"检索结果到底靠不靠谱"：

| 级别 | 语义 | 阈值（bge-m3 打分域） |
|------|------|------------------------|
| `high` | 高置信，可直接作答 | bge 得分 > 0.5（ms-marco 域 > 4） |
| `medium` | 中等置信，可参考作答 | > 0.2（ms-marco 域 > 2） |
| `low` | 低置信，谨慎引用 | > 0.05 |
| `poor` | 不可信，应声明未检索到 | ≤ 0.05（或 0） |

> 阈值见 `search_engine.py` 的 `_RERANK_SCALES`（高分域 / 低分域两套标定）。LLM 拿到 `poor` 结果时应如实告诉用户"未找到相关文档"，而不是编造。

### 4.2 citation 引用与回答规范

- 每个回答必须携带 **citation**，格式：`[Title - Section](URL)`。
- 回答首行固定 `Based on <n> result(s).` 说明依据的检索结果数量。
- 多来源时逐条列出 citation，不得混用来源；不得引用超出检索返回范围的内容。
- 该规范固化在 MCP prompt（`edk2_kb_search_instruction`）中，由 LLM 侧执行。

### 4.3 服务端点与 MCP 工具

**RAG daemon 端点**（`edk2-kb/mcp_server.py`，动态端口写入 `daemon.json`）：

| 端点/工具 | 说明 |
|-----------|------|
| `GET /health` | 健康检查（含 ChromaDB 可用性、索引状态、进程 PID）；健康判定窗口 60s |
| `GET /search?query=...` | 直接 HTTP 检索（用于人工验证，返回结果 + confidence + citation） |
| `GET /stats` | 索引统计（分块数、维度、模型信息） |
| `POST /mcp` | Streamable HTTP 的 MCP 协议入口 |
| `search_kb(query, top_k)` | MCP 工具：检索知识库 |
| `get_kb_status()` | MCP 工具：返回索引/服务状态 |
| `get_kb_citation_guide()` | MCP 工具：返回 citation 格式指引 |
| `POST /shutdown` | 优雅停机 |

**Web 回答服务端点**（`web/server.js`，默认 `http://0.0.0.0:8080`，LLM 编排层）：

| 端点 | 说明 |
|------|------|
| `POST /api/ask` | 提问 → daemon `/search`（top_k=35 + 按需 docs 定向查询）→ LLM 回答；支持 `history`（多轮）与 `prevResults`（上一轮检索上下文） |
| `GET /api/status` | 转发 daemon `/health` + LLM 配置状态 |
| `GET /healthz` | Web 服务存活探针 |

**Web 服务环境变量**：`LLM_BASE_URL`（如 `https://open.bigmodel.cn/api/paas/v4`）、`LLM_API_KEY`、`LLM_MODEL`、`LLM_MAX_TOKENS`（默认 8000）、`PORT`（默认 8080）、`HOST`（默认 0.0.0.0）、`RATE_LIMIT_ASK`（默认 10 次/窗口）。前端 `web/index.html` 会把最近 10 轮历史存入 `localStorage`，并在追问时携带上一轮 `prevResults` 实现同主题多轮对话。

### 4.4 eval-query 命令与解读（含实操示例）

对**单条查询**做"旧版（无重排）vs 新版（当前）"的 top5 对比，用于快速迭代验证。

```powershell
# 用法
node scripts/eval-query.js --data-dir "$env:USERPROFILE\.edk2-opencode\kb\data" --query "PcdDebugPrintErrorLevel"

# 或直接调用底层脚本（需在 venv 内）
& "$env:USERPROFILE\.edk2-opencode\kb\venv\Scripts\python.exe" edk2-kb/eval/compare_query.py --data-dir "$env:USERPROFILE\.edk2-opencode\kb\data" --query "PcdDebugPrintErrorLevel"
```

**实测输出（v6.0.22，查询 `PcdDebugPrintErrorLevel`，期望文档 `3141_configuring_debuglib_with_edk_ii.md`）：**

```
============================================================================
QUERY: PcdDebugPrintErrorLevel
  expected: 3141_configuring_debuglib_with_edk_ii.md

OLD  (hybrid, no rerank, <=6.0.11)  top5
  #1 score=0.67 (unrated)   ...\3141_configuring_debuglib_with_edk_ii.md  [31.4.1 ... > 31.4.1.3 DebugLib Platform Configuration Database Settings]
  #2 score=0.63 (unrated)   EDK II Debugging - TianoCore EDK II Documentation  [EDK II Debugging > PCDs to configure DebugLib]
  #3 score=0.58 (unrated)   edk2-InfSpecification\...\38_pcd_sections.md  [@AsBuilt]
  #4 score=0.63 (unrated)   edk2-BuildSpecification\...\136_global_pcd_section.md  [13.6 Global PCD Section > ...]
  #5 score=0.58 (unrated)   edk2-ModuleWriteGuide\...\32_creating_a_module.md  [VALID_ARCHITECTURES = IA32 X64 ...]
  >> expected doc at rank 1

NOW  (hybrid + rerank, current)  top5
  #1 rr=0.98 high  edk2-BuildSpecification\...\136_global_pcd_section.md
  #2 rr=0.97 high  edk2-InfSpecification\...\38_pcd_sections.md
  #3 rr=0.93 high  edk2-ModuleWriteGuide\...\32_creating_a_module.md
  #4 rr=0.99 high  edk2-InfSpecification\...\appendix_e_sample_binary_inf_files.md
  #5 score=0.63 (unrated) EDK II Debugging - TianoCore EDK II Documentation
  >> expected doc MISSED

  --- ranking changes (old -> new) ---
    #1 UP from #4   edk2-BuildSpecification\...\136_global_pcd_sect
    #2 UP from #3   edk2-InfSpecification\...\38_pcd_sectio
    #3 UP from #5   edk2-ModuleWriteGuide\...\32_creating_a_mod
    #4 NEW          edk2-InfSpecification\...\appendix_e_sample_binary_inf_files.md
    #5 DOWN from #2 EDK II Debugging - TianoCore EDK II Documentation
    REMOVED         edk2-UefiDriverWritersGuide\...\314_...
```

**输出解读**：
- `OLD` 段：无重排时代，命中期望文档在 rank 1（score=0.67，无置信度标注）。
- `NOW` 段：重排后 top5 全部获得 `rr`（交叉编码器得分）+ `high` 置信度标注，检索质量可解释性大幅提升；但同时该查询的**期望文档被挤出 top5**（`>> expected doc MISSED`）。
- 这**正是评测框架的价值**：单条查询可能因重排变化出现"旧好新差"，因此**验收以 330 条全量集上的聚合指标（Hit@5 / MRR）为准，不以单条断言**。任何重排/融合/去重改动都必须重跑全量评测（见 4.5）。
- `ranking changes` 段逐条标注 `UP/DOWN/NEW/REMOVED`，便于定位行为变化来源。

### 4.5 评测框架与指标体系

位于 `edk2-kb/eval/`：

| 文件 | 作用 |
|------|------|
| `edk2_eval_set.json` | 测试集定义：**330 条**（manual 130 条 + auto 200 条），每条含 query、expected doc、分级标注（含 8 条中文题，manual 内） |
| `run_eval.py` | 全量评测：对每条 query 检索 top5，判定 Hit@5 / MRR，输出逐条与汇总 |
| `compare_query.py` | 单条新旧对比（4.4 的底层实现） |
| `judge_eval.py` | 用 judge 对 130 条标注质量做校验（人工标注入库前校验） |
| `RESULTS.md` | 历史评测结果归档（各版本对比表） |

**测试集数据结构**（`edk2_eval_set.json`，每条约 3 个字段）：

```json
[
  {
    "query": "b1 stage configuration",
    "expected": [
      { "source": "tianocore-docs",
        "file_or_title": "edk2-MinimumPlatformSpecification\\appendix_b_global_configuration\\b1_stage_configuration.md" }
    ],
    "kind": "auto"
  },
  {
    "query": "3151 connecting pci root bridges",
    "expected": [
      { "source": "tianocore-docs",
        "file_or_title": "edk2-UefiDriverWritersGuide\\3_foundation\\315_platform_initialization\\3151_connecting_pci_ro..." }
    ],
    "kind": "auto"
  },
  ...
]
```

| 字段 | 含义 |
|------|------|
| `query` | 提问语句 |
| `expected[]` | 期望命中的文档（`source`：来源标识；`file_or_title`：相对路径/标题），可多个 |
| `kind` | 来源类型：`auto`（自动从文档生成，200 条）/ `manual`（人工标注，130 条，含 8 条中文） |

**已验证的问题集合**（已解决的检索质量问题，均固化在测试集或文档中）：

| 问题类别 | 说明 | 相关版本 |
|----------|------|----------|
| 中文检索失效 | 旧版 embedder 对中文召回差，中文 Hit@5 仅 12.5% | 6.0.19/6.0.20 |
| 大文档处理挂起 | `print.html` 1.7GB 单页 O(N²) 处理 | 6.0.7 |
| ChromaDB 空 title 去重塌缩 | 41% chunk title 为空致每次仅返回 1 文档 | 6.0.21 |
| `/health` 误报 | numpy `or` 布尔歧义致 ChromaDB unavailable 误报 | 6.0.22 |
| 单条查询退化 | 重排后个别查询期望文档跌出 top5（聚合指标掩盖） | 评测框架持续跟踪 |

**指标定义**：
- **Hit@5**：期望文档出现在 top5 中即命中，命中数 ÷ 总条数。
- **MRR（Mean Reciprocal Rank）**：命中位置的倒数均值。

**运行全量评测**：

```powershell
& "$env:USERPROFILE\.edk2-opencode\kb\venv\Scripts\python.exe" edk2-kb/eval/run_eval.py --data-dir "$env:USERPROFILE\.edk2-opencode\kb\data"
```

### 4.6 当前评测结果（验收基准）

| 指标 | 6.0.14（基线） | 6.0.22（当前） | 目标 |
|------|----------------|----------------|------|
| 全局 Hit@5（全量 330 条） | **57.3%** | **92.7%** | ≥ 85% |
| 中文 Hit@5 | **12.5%** | **62.5%** | ≥ 60% |
| manual 130 条 Hit@5 | — | **89.2%**（修复后 116/130） | ≥ 85% |
| auto 200 条 Hit@5 | — | **95.0%**（190/200） | ≥ 90% |

> 全量 330 条、分语种、manual/auto 分组的逐条明细均可在 `RESULTS.md` 及各次评测输出中复现；任何实现变更后必须重跑并更新该文件。

---

## 5. 任务验收判定规则

### 5.1 AI 复现路径核查表

验收人员（或 AI 工程师）应按下表逐项核验，全部通过即视为"仅凭 Wiki 可复现"：

| # | 核查项 | 通过标准 |
|---|--------|----------|
| 1 | 代码获取 | `git clone` 成功，`package.json` 版本 = 6.0.22 |
| 2 | 模型本地化 | `~/.edk2-opencode/models/bge-m3/` 与 `bge-reranker-v2-m3/` 存在且可被加载（`fetch_models.py` 可一键补） |
| 3 | 知识库构建（任一路径） | `setup_kb.ps1` / `setup_kb.sh` 完整跑通，或 `install_kb.ps1` / `install_kb.sh` 解压成功；`processed/` 有约 82297 个 txt；`chroma_db/`、`fts_index.db` 生成 |
| 4 | 六数据源齐全 | `tianocore-wiki/`（288 HTML）、`tianocore-docs/`（33 仓库）、`uefi-specs/`、`edk2-commits/`（commits.txt）、`edk2-prs/`（prs.jsonl）、`edk2-mdepkg/`（MdePkg）均存在 |
| 5 | 维度一致性 | 索引维度 = 1024（bge-m3）；`get_kb_status` 报告维度正确 |
| 6 | daemon 启动 | `daemon start` 成功，`daemon status` 显示健康，`daemon.json` 有端口 |
| 7 | 服务健康 | `GET /health` 返回 200，ChromaDB 状态可用（无 v6.0.22 前的误报 bug） |
| 8 | HTTP 检索 | `GET /search?query=PcdDebugPrintErrorLevel` 返回带 confidence + citation 的结果 |
| 9 | MCP 检索 | 任意 LLM 客户端经 MCP 调 `search_kb` 可拿到结果 |
| 10 | 离线验证 | 断网后检索仍正常（`local_files_only=True`、默认禁 webfetch/websearch） |
| 11 | Web 服务启动 | `cd web && node server.js` 启动成功，`/healthz` 返回 200 |
| 12 | Web 问答 | `POST /api/ask` 返回带引用的回答（需配置 LLM_API_KEY） |
| 13 | Web 详略分级 | simple/standard/complex 三档路由正确（`done` 事件含 `tier` 字段） |
| 14 | Web 评测门控 | `python edk2-kb/eval/run_web_eval.py --gate` 分档 PASS |
| 15 | 全量评测 | 重跑 330 条达到第 5.2 节指标 |

### 5.2 硬性验收指标

- 全局 Hit@5：**92.7%**（全量 330 条）。
- 中文 Hit@5：**≥ 62.5%**（基线 12.5% → v6.0.22 实测 62.5%）。
- manual 130 条：**89.2%**（116/130，≥ 85%）。
- auto 200 条：**95.0%**（190/200，≥ 90%）。

### 5.3 关键 bug 修复验证点

| Bug | 现象 | 修复 | 验证方法 |
|-----|------|------|----------|
| **ChromaDB 空 title 去重塌缩** | `tianocore-docs` 约 41% 的 chunk 的 title 字段为空，Chroma 按 title 去重导致**每次查询只返回 1 个文档** | `_search_chroma` 去重逻辑修复 | `/stats` 或检索多主题查询时返回 ≥5 条不同文档 |
| **numpy `or` 布尔歧义导致 /health 误报** | `numpy` 数组 `or` 触发多元素真值歧义异常 → `/health` 误报 ChromaDB unavailable | 用 `len()` 替代布尔 `or` 判断 | 启动后 `/health` 稳定返回 ChromaDB 可用 |

---

## 6. 故障排查与常见问题

| 现象 | 原因 | 解决 |
|------|------|------|
| `EBUSY` / 文件占用（Windows） | daemon 进程占用 npx/venv 文件 | **先 `npx edk2-opencode daemon stop`** 释放锁，再执行构建/更新命令 |
| `fts_index.db` 被占用 / FTS 重建失败 | daemon 运行时持有 FTS 数据库锁 | 先 `daemon stop`，或 `add_mdepkg.py --skip-fts` 跳过 FTS 重建 |
| 检索质量很差（Hit@5 明显低于验收值） | 索引用了 384 维默认模型，或 reranker 缺失 | 设 `EDK2_EMBEDDING_MODEL` 指向本地 bge-m3 后**全量重建**；补齐 reranker 模型目录 |
| `/health` 报 ChromaDB unavailable 但检索正常 | 旧版本 numpy `or` 歧义 bug | 升级到 v6.0.22（用 `len()` 修复） |
| 模型加载失败 / 卡住 | 模型未本地化 / 网络受限 Xet | `HF_HUB_DISABLE_XET=1`、`hf-mirror.com` 镜像，或 `fetch_models.py` 一键下载 |
| daemon 端口找不到 | 动态端口每次可能变化 | 以 `~/.edk2-opencode/kb/daemon.json` 为准，不要硬编码端口 |
| 多实例冲突 | 多个 daemon 同时启动 | 单例锁 `opencode-edk2-agent.lock` 保证唯一；删除残留锁文件后重启 |
| Shell 规范（UEFI_Shell_2_2 PDF）缺失 | uefi.org 对脚本 UA 返回 403；web.archive.org 可能不可达 | `fetch_specs.py` 已内置多 URL 回退，全部失败时仅跳过该 PDF（警告非致命）；可手动把 PDF 放到 `uefi-specs/Shell_2.2/source/` 后重跑 `init_kb.py` |
| TianoCore Wiki 页面数偏少（< 全站约 380 页） | 站点极慢（searchindex.js ~9.86MB），爬虫 BFS 超时静默跳过孤儿页 | 属已知限制；缺失多为孤立技术页。如需全量，可改用 git 源仓库 `tianocore/tianocore-wiki.github.io`（mdBook 源，375 个 .md）作为数据源 |
| docs 仓库没有更新 | 上游 33 个仓库默认分支均为 `main`，更新路径需 `git fetch --depth=1` + `reset --hard origin/main` | 重跑 `init_kb.py --update`（见 `clone_tianocore_docs`）；确认本地 `origin/main` 已拉到最新 |
| `init_kb.py` 数据写入仓库目录而非 `EDK2_KB_DATA` | 旧版 `init_kb.py` 硬编码 `BASE_DIR/"data"`（已修复为读取 `EDK2_KB_DATA`） | 升级到最新代码；或手动设 `EDK2_KB_DATA` 后重跑 |
| `add_mdepkg.py` sparse clone 失败（`origin/main` not found） | edk2 默认分支是 `master`，旧版写死 `main`（已修复） | 升级到最新代码；或手动 `git fetch origin master` |
| `mcp_server.py` 报 `ModuleNotFoundError: No module named 'fastmcp'` | `requirements.txt` 未声明 `fastmcp` 依赖（已修复） | `pip install fastmcp>=2.0.0` 或升级到最新 `requirements.txt` 重装 |
| PR 拉取极慢（2+ 小时） | 无 `GITHUB_TOKEN` 时 GitHub API 限速 60 次/小时 | 设置 `GITHUB_TOKEN` 环境变量（5000 次/小时）；脚本启动时会警告 |
| `search_engine.py` 找不到模型（路径不匹配） | 旧版硬编码 `~/.edk2-opencode/models`，不读 `EDK2_MODELS_DIR`（已修复） | 升级到最新代码；或确保模型在默认路径 |

---

## 7. Web 回答服务部署与验证

> 本节覆盖 `web/server.js` 实现的 LLM 问答编排层，包括详略分级、查询分解、C' 批评-修订、评测门控、LTR 流水线等 Phase 0-4 增强。完整环境变量与接口说明见 `web/README.md`。

### 7.1 架构概述

```
浏览器（局域网任意机器）
   │ http://<服务器IP>:8080
   ▼
web/server.js（Node HTTP 服务，端口 8080）
   ├─ POST /api/ask → 检索 + LLM 回答
   │   ├─ ① 查询分解（analyzeQuery）→ 简单直查 / 复杂拆子问题
   │   ├─ ② daemon /search 检索（Top5-15，按档位调整）
   │   ├─ ③ LLM 生成回答（详略分级：simple/standard/complex）
   │   ├─ ④ L3 忠实度校验（LLM-judge 标记未支撑断言）
   │   ├─ ⑤ C' 批评-修订（改写未支撑语句，answer_revision 替换）
   │   └─ ⑥ 流式返回（SSE delta + citation_warn + faithfulness_warn）
   ├─ GET /api/status → daemon 健康 + LLM 配置
   └─ GET /healthz → 存活探针
```

**核心组件**：

| 组件 | 文件 | 作用 |
|------|------|------|
| 详略分级 | `server.js` routeQuery() | 按问题复杂度分 simple/standard/complex 三档 |
| 查询分解 | `server.js` analyzeQuery() | 复杂多子问题拆分为独立子查询 |
| L3 忠实度 | `server.js` L3 block | 生成后 LLM-judge 标记未被上下文支撑的断言 |
| C' 修订 | `server.js` L3_REVISION | 单轮改写未支撑语句，answer_revision SSE 替换 |
| 扩展规则 | `edk2-kb/expansion_rules.json` | 中英文查询扩展（43 条规则，web+daemon 共享） |
| LTR | `edk2-kb/rank/` | LambdaMART 学习排序（9 特征，需打标+训练） |
| 评测 | `edk2-kb/eval/run_web_eval.py` | 全链路 faithfulness+relevancy 评测 + 门控 |

### 7.2 环境配置

**1. 复制模板**：
```powershell
cd web
cp .env.example .env   # Windows: Copy-Item .env.example .env
```

**2. 填写 LLM 配置**（至少填 API Key 才有 LLM 回答，否则只显示检索结果）：
```bash
LLM_API_KEY=sk-your-api-key-here
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-v4-flash
```

**3. 可选调优**（均有合理默认值）：
```bash
# 评测用更强评委模型（降低打分方差）
JUDGE_MODEL=deepseek-chat

# 关闭忠实度校验（调试用）
# L3_FAITHFULNESS_CHECK=false
# L3_REVISION=false
```

### 7.3 启动与验证

```powershell
# 进入 web 目录
cd web

# 启动（首次提问时自动拉起 daemon）
node server.js

# 验证
curl http://127.0.0.1:8080/healthz                    # 存活
curl http://127.0.0.1:8080/api/status                   # 状态
curl -X POST http://127.0.0.1:8080/api/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"PCD 是什么？"}'                       # 提问
```

**局域网访问**：其他机器打开 `http://<服务器IP>:8080`。

### 7.4 详略分级与查询分解

服务端自动按问题复杂度分档，不同档位使用不同的 token 预算、检索上下文量和重排策略：

| 档位 | 判定条件 | max_tokens | 检索上下文 | 重排候选 |
|------|----------|------------|-----------|---------|
| **simple** | 单关键词/短定义（≤22 字符或 What/格式类） | 1600 | 6000 字符 | 12 |
| **standard** | 操作指南/中等问题 | 3000 | 10000 字符 | 15 |
| **complex** | 多子问题/对比/列举（≥2 个子查询或 >44 字符） | 6000 | 16000 字符 | 24 |

**查询分解**（`analyzeQuery`）：复杂问题自动拆分为独立子查询，每个子查询独立检索后合并去重。

### 7.5 批评-修订循环（C'）

L3 忠实度校验标记未被检索上下文支撑的断言后，C' 单轮修订：
1. 将标记的断言列表 + 当前回答 + 检索上下文送入 LLM
2. LLM 仅改写未支撑语句（删除无依据的数字/路径/版本），其余逐字保留
3. 修订后回答通过 `answer_revision` SSE 事件替换前端展示
4. 修订后重新验证 citation（L2c 复检）

**为什么是单轮**：实测两轮迭代为负优化（复检评委过标导致答案膨胀 faith 4.1→4.2, relev 4.6→4.5）。

### 7.6 评测门控

```powershell
# 全量评测（18 题 × 双票评委）
python edk2-kb/eval/run_web_eval.py

# 门控模式（分档判定，退出码供 CI）
python edk2-kb/eval/run_web_eval.py --gate

# 全局门控模式（单一阈值 4.6/4.4）
python edk2-kb/eval/run_web_eval.py --gate --gate-mode global
```

**分档门控阈值**（按实测能力标定）：

| 档位 | faithfulness | relevancy | 说明 |
|------|-------------|-----------|------|
| simple | ≥ 4.5 | ≥ 4.5 | 单点问题，接近完全支撑 |
| standard | ≥ 3.8 | ≥ 4.4 | 操作指南类 |
| complex | ≥ 3.8 | ≥ 4.2 | 多子问题综合，结构性缺口 |

**当前结果**（2026-08-21，deepseek-chat 双票评委）：

| 档位 | faith | relev | 判定 |
|------|-------|-------|------|
| simple | 4.50 | 4.62 | ✅ PASS |
| standard | 4.50 | 5.00 | ✅ PASS |
| complex | 3.94 | 4.75 | ✅ PASS |

### 7.7 学习排序（LTR）流水线

LambdaMART 学习排序，9 特征（向量得分、RRF 分、FTS BM25 分、标题/来源匹配、重排得分等）。

```powershell
# 1. 打标（LLM-judge 对 (query, chunk) 打 0/1/2 相关度）
python edk2-kb/eval/label_pipeline.py \
  --data-dir "$env:USERPROFILE\.edk2-opencode\kb\data" \
  --synthetic 30 --out edk2-kb/rank/ltr_labels.jsonl

# 2. 训练（需 ≥300 行标签 / ≥30 查询）
python edk2-kb/rank/train_ranker.py --labels edk2-kb/rank/ltr_labels.jsonl

# 3. 启用（daemon 环境变量）
$env:EDK2_LTR_MODEL = "edk2-kb/rank/ranker.txt"
npx edk2-opencode daemon restart
```

> 标签不足时自动退化为 BGE cross-encoder 精排（当前状态）。

### 7.8 查询扩展规则

`edk2-kb/expansion_rules.json` 是中英文查询扩展的单一事实源（43 条规则），web 与 daemon 共同加载。

- **中文查询**：自动扩展同义词/英文术语（如 PCD → Platform Configuration Database）
- **英文查询**：无扩展（行为不变）
- **简单问题**：短中文问题自动生成 2-3 个英文改写，按"主题锚定 + 检索增益"双重校验

### 7.9 分档监控

```powershell
# 按 simple/standard/complex 档位聚合 trace.jsonl
python edk2-kb/eval/tier_monitor.py
```

输出各档位的延迟、回答长度、引用数、忠实度均值，用于回归检测。

---

*Wiki 版本：v6.0.22（含 main 上 Web 服务 + Phase 0-4 + C' 修订 + 分档门控增强） · 最后更新：2026-08-23 · 内容与 `D:\project-review-test\edk2-opencode-v3\` 源码逐命令核对*
