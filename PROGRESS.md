# EDK2-Agent 复现与优化 · 进度记录（交接文档）

> 最后更新：2026-09-22
> 机器重启后，**先读本文档**即可无缝继续。
> 一句话现状：**项目已完整复现并可运行；检索已优化；云端与本地 LLM 均已跑通。**

---

## 0. 当前状态速览（重启前）

| 项 | 状态 |
|---|---|
| 仓库代码 | `D:\edk2Agent`，v6.0.22，HEAD `149c960` |
| 知识库分块 | `documents.json` = **101,378** 块（见下表） |
| 向量索引 ChromaDB | **33,526** 条（去噪：commits/prs 不嵌入）✅ |
| 全文索引 FTS5 | **101,378** 行 ✅（刚重建） |
| 模型 | bge-m3 + bge-reranker-v2-m3（D 盘，各 ~2.1GB）✅ |
| daemon | **已停止**（明天用命令启动） |
| Web 服务 | 可能在 8080 运行（重启后消失） |
| 云端 LLM ② | ✅ 已跑通（DeepSeek 官方 `deepseek-flash`，`web/.env`） |
| 本地 LLM ③ | ✅ 已完成（Ollama + qwen2.5:14b，`web/.env.ollama` 一键切换） |
| Wiki 补全 ④ | ✅ 已入库（2266 块），已改名为独立来源，**待重跑评测** |

### 分块来源明细（101,378）
```
edk2-commits        49,662   （仅 FTS/BM25，未嵌入向量）
edk2-prs            15,924   （仅 FTS/BM25，未嵌入向量）
edk2-mdepkg         11,820
tianocore-docs      11,196
uefi-specs           8,195
tianocore-wiki       2,315   （爬虫抓到的官网页面）
tianocore-wiki-git   2,266   （本次 Wiki 补全的新页，独立来源）
TOTAL              101,378
```

---

## 1. 关键路径

| 用途 | 路径 |
|---|---|
| 仓库代码 | `D:\edk2Agent` |
| 运行期数据（KB/模型/venv） | `D:\edk2Agent\.edk2-opencode` |
| C 盘链接 | `C:\Users\admin\.edk2-opencode` → 目录联接（Junction）指向上面 |
| Git / Python | `D:\tools\MinGit` / `D:\tools\Python311` |
| venv python | `D:\edk2Agent\.edk2-opencode\kb\venv\Scripts\python.exe` |
| 模型 | `D:\edk2Agent\.edk2-opencode\models\{bge-m3,bge-reranker-v2-m3}` |
| KB 数据 | `D:\edk2Agent\.edk2-opencode\kb\data` |
| 复现脚本 | `D:\tools\edk2-build\`（见第 5 节） |
| 复现报告 | `D:\edk2Agent\REPRODUCTION_REPORT.md` |
| 合并 CA 包 | `D:\tools\certs\ca-bundle.pem` |
| Web 配置（含 Key） | `D:\edk2Agent\web\.env` |

### 已持久化的用户环境变量
```
EDK2_KB_DATA        = D:\edk2Agent\.edk2-opencode\kb\data
EDK2_MODELS_DIR     = D:\edk2Agent\.edk2-opencode\models
EDK2_EMBEDDING_MODEL= D:\edk2Agent\.edk2-opencode\models\bge-m3
EDK2_EMBEDDING_DEVICE = cuda
EDK2_RERANKER_DEVICE  = cuda
PIP_CACHE_DIR / HF_HOME / HF_HUB_DISABLE_XET / REQUESTS_CA_BUNDLE / SSL_CERT_FILE / CURL_CA_BUNDLE
```

---

## 2. 明天继续的第一步（重要，按顺序）

### 步骤 1：恢复环境
```powershell
. 'D:\tools\edk2-build\env.ps1'      # 一键设置 PATH + 环境变量
Set-Location 'D:\edk2Agent'
$py = 'D:\edk2Agent\.edk2-opencode\kb\venv\Scripts\python.exe'
```

### 步骤 2：给"Wiki 补全来源"降权，然后重跑评测（决定是否保留）
背景：直接把这 2266 块并入 `tianocore-wiki` 会让 **manual 命中率从 86.9% 掉到 82.3%**（auto 反而 93.0%→94.5%）。
已把它们的来源改名为 `tianocore-wiki-git`（`documents.json` + FTS 已生效），下一步是**用来源加权给它们降权**再评测：
```powershell
$env:EDK2_SOURCE_WEIGHTS = 'tianocore-wiki-git:0.4,edk2-commits:0.6,edk2-prs:0.6'
& $py 'edk2-kb/eval/run_eval.py' --data-dir 'D:\edk2Agent\.edk2-opencode\kb\data'
```
判断标准（关注 `hybrid+rerank` 行）：
- 若 manual 回到 ~86%+ 且 auto 保持 ~94% → 保留 Wiki 补全（两全）。
- 若仍掉 → 执行「回退 Wiki 补全」（见第 6 节备选方案）。

评测一次约 10–15 分钟（GPU）。

### 步骤 3：继续本地 LLM（③）
```powershell
# 续传 Ollama 便携包（用镜像；GitHub 直连不稳定）
curl.exe -L --ssl-no-revoke -C - --retry 8 --retry-all-errors -o 'D:\tools\_dl\ollama-windows-amd64.zip' `
  'https://gh-proxy.com/https://github.com/ollama/ollama/releases/download/v0.34.2/ollama-windows-amd64.zip'
# 校验 sha256 应为 8f3fd071a2a2f9497b562f43502c77c2b701a99d1ee5dfda28da8c786373063b
Expand-Archive 'D:\tools\_dl\ollama-windows-amd64.zip' -DestinationPath 'D:\tools\Ollama' -Force
$env:OLLAMA_MODELS='D:\edk2Agent\.edk2-opencode\ollama-models'
Start-Process 'D:\tools\Ollama\ollama.exe' -ArgumentList 'serve' -WindowStyle Hidden
& 'D:\tools\Ollama\ollama.exe' pull qwen2.5:14b      # 约 9GB
# 然后把 web/.env 切到本地：
#   LLM_BASE_URL=http://127.0.0.1:11434/v1
#   LLM_MODEL=qwen2.5:14b
#   LLM_API_KEY=ollama
```

### 步骤 4：端到端评测集（可选但推荐）
收集你真实会问的 20–50 个 EDK2 问题 → 跑 `python edk2-kb/eval/run_web_eval.py`（faithfulness + relevancy 门控）。

---

## 3. 已完成的里程碑

1. **环境**：Git 2.55 / Python 3.11.9 装到 D 盘；Node 复用；C 盘零数据占用（Junction）。
2. **代码**：`git clone` 到 `D:\edk2Agent`，v6.0.22；`npm install` 完成。
3. **依赖**：torch 2.11.0+cu128、chromadb 1.5.9、sentence-transformers 6.1.0、fastmcp、PyMuPDF。
4. **模型**：bge-m3 + bge-reranker-v2-m3（4.2GB，CUDA 可用，RTX 5070 Ti）。
5. **6 大数据源**：Wiki 288 页、tianocore-docs 33 仓库、UEFI 规范 3 套、提交 49,623、PR 8,396、MdePkg 11,820 文件。
6. **索引**：ChromaDB（1024 维）+ FTS5（porter+unicode61）。
7. **daemon**：动态端口、`/health`、`/search`、`/embed`、MCP `/mcp`（`search_kb` 等 3 个工具）全部验证通过。
8. **Web**：`/healthz`、`/api/status`、`/api/ask`（含引用、忠实度校验、C' 修订）验证通过。
9. **云端 LLM**：接 DeepSeek 官方，`deepseek-flash`，已生成带引用的真实回答。
10. **检索优化**：见第 4 节，全局 Hit@5 86.7% → 90.6%。

---

## 4. 检索优化改动（当前已生效）

### 代码改动（可用环境变量回退）
- `edk2-kb/search_engine.py`：
  - `EDK2_CHROMA_MULT=10`（稠密召回深度，原 6）
  - `EDK2_WINDOW_MULT=5`（送重排候选窗口，原 3）
  - `EDK2_TITLE_BOOST=0.35`（查询词与 文件名/标题/章节 的词法加权）
  - `EDK2_SOURCE_WEIGHTS`（来源加权，默认空）
  - 新增 `tianocore-wiki-git` 的显示名；词法加权跳过 `repo=tianocore-wiki.github.io`
- `edk2-kb/mcp_server.py`：
  - `EDK2_DAEMON_RERANK=1`（MCP/`/search` 走重排，返回 `rerank_score`+`confidence`）

### 评测结果汇总（`hybrid+rerank` Hit@5）
| 配置 | 全局330 | manual130 | auto200 |
|---|---|---|---|
| 初始 6 源 | 86.7% | 83.8% | 88.5% |
| 去噪（commits/prs 不嵌入） | 87.0% | 83.8% | 89.0% |
| **+ 召回加深 + 标题加权** | **90.6%** | **86.9%** | 93.0% |
| 再 + Wiki合并进 wiki 来源 | 89.7% | 82.3% | 94.5% |
| Wiki 改独立来源（**待评测**） | ? | ? | ? |

> 结论：召回加深+标题加权是最大增益（+3.9）。Wiki 补全对"标题类"问题有益（auto +1.5），
> 但会挤掉人工标注的自然语言问题（manual −4.6），正在用来源降权调和。

---

## 5. 复现脚本清单（`D:\tools\edk2-build\`）

| 脚本 | 作用 |
|---|---|
| `env.ps1` | 环境变量/PATH/CA（其它脚本都会 dot-source 它） |
| `01_install_deps.ps1` | 建 venv + 装依赖（含 CUDA torch） |
| `02a/02b/02c` | 抓 UEFI 规范 / 提交历史 / PR |
| `03b/03c/03d` | init_kb 分块 / 建向量索引 / 加 MdePkg |
| `download_models_direct.py` | 断点续传下载模型（绕过代理 HEAD 问题） |
| `04_verify_daemon.ps1` | 启动 daemon + 验证 |
| `05_eval.ps1` / `12_eval_boost.ps1` | 330 条评测 |
| `06_web.ps1` | 启动 Web 服务 |
| `08_eval_2src.ps1` | 2 源（wiki+docs）对照评测 |
| `13_wiki_git.ps1` / `14_wiki_embed.ps1` | Wiki 补全（分块+FTS / 嵌入） |
| `relabel_wikigit.py` | 把补全页改名为 `tianocore-wiki-git` 并重建 FTS |
| `analyze_misses.py` | 失败归因分析 |

---

## 6. 备选方案 / 注意事项

### 若要回退 Wiki 补全（恢复到 90.6% 配置）
```powershell
$py = 'D:\edk2Agent\.edk2-opencode\kb\venv\Scripts\python.exe'
& $py -c "import json;from pathlib import Path;p=Path(r'D:\edk2Agent\.edk2-opencode\kb\data\processed\documents.json');d=json.loads(p.read_text(encoding='utf-8'));keep=[x for x in d if x.get('source')!='tianocore-wiki-git'];p.write_text(json.dumps(keep,indent=2,ensure_ascii=False),encoding='utf-8');print(len(d),'->',len(keep))"
# 删掉 processed/wikigit_*.txt，然后重建 FTS（auth: 先 stop daemon）
& $py -c "import sys;sys.path.insert(0,r'D:\edk2Agent\edk2-kb\fetchers');from init_kb import build_fts_index;build_fts_index()"
```
（`tianocore-wiki-git` 未进向量库，所以只需重建 FTS。）

### 必须知道的坑
1. **本机装了 TLS 拦截加速器（SteamTools/Watt Toolkit）**：其根证书只在 Windows 证书库。
   已用 `D:\tools\certs\ca-bundle.pem`（certifi+Windows）解决；Git 走 openssl 后端，
   `git config --global http.sslCAInfo` 指向该包（`sslVerify` 保持 true）。
2. **GitHub 直连不稳定**：大文件用镜像 `https://gh-proxy.com/https://github.com/...` 续传。
3. **FTS 锁**：daemon 运行时持有 `fts_index.db`；重建 FTS 前必须 `node bin/edk2-opencode.js daemon stop`。
4. **显存**：daemon（bge-m3+reranker）约占 5–8GB；跑嵌入/评测前最好先停 daemon，避免 CUDA OOM。
5. **云端 LLM Key**：见 `web/.env`（DeepSeek 官方 Key，**可用**，该文件已被
   `.gitignore` 忽略、不会入库）；
   先前那个 OpenCode Zen 的 Key **无额度**（402/403），已弃用。
6. **`EDK2_EMBEDDING_MODEL` 必须指向本地目录**（模型是 local_dir 下载，不在 HF 缓存，
   而 `local_files_only=True` 只查 HF 缓存）。
7. **索引一致性**：Chroma 的 id 是 `doc_{documents.json 下标}`，改动 `documents.json` 后
   务必保证 FTS/chroma 与之对齐，否则会错位检索。

---

## 7. 常用命令

```powershell
. 'D:\tools\edk2-build\env.ps1'; Set-Location 'D:\edk2Agent'

# daemon
node bin/edk2-opencode.js daemon start|stop|restart|status|logs
node bin/edk2-opencode.js --search "PcdDebugPrintErrorLevel"

# Web（另一个窗口，常驻）
powershell -File 'D:\tools\edk2-build\06_web.ps1'   # 监听 0.0.0.0:8080，局域网可访问

# 评测
& 'D:\edk2Agent\.edk2-opencode\kb\venv\Scripts\python.exe' 'edk2-kb/eval/run_eval.py' `
  --data-dir 'D:\edk2Agent\.edk2-opencode\kb\data'
```

- Web UI：`http://127.0.0.1:8080`（局域网 `http://<本机IP>:8080`）
- daemon 端口以 `D:\edk2Agent\.edk2-opencode\kb\daemon.json` 为准（动态端口）。

---

## 8. 仓库改动清单（`git -C D:\edk2Agent status`）

```
 M edk2-kb/eval/RESULTS.md        # 评测脚本自动重写
 M edk2-kb/mcp_server.py          # EDK2_DAEMON_RERANK
 M edk2-kb/search_engine.py       # 召回深度/标题加权/来源加权
?? edk2-kb/fetchers/add_wiki_git.py   # Wiki 补全脚本（新增）
?? PROGRESS.md / REPRODUCTION_REPORT.md
?? .cache/ , package-lock.json
```

---

## 9. 更新（2026-09-22 续做）

### 9.1 Wiki 补全的最终结论（重要）

已把补全页改名为独立来源 `tianocore-wiki-git` 并测试降权，结果：

| 配置 | 全局330 | manual130 | auto200 | 说明 |
|---|---|---|---|---|
| 不含 Wiki 补全 | **90.6%** | **86.9%** | 93.0% | 当前更优 |
| 含 Wiki 补全 | 89.7% | 82.3% | **94.5%** | 覆盖更广 |
| 含补全 + 降权 0.4 | 89.7% | 82.3% | 94.5% | 降权**无效** |

**原因（已定位）**：损害不是来自 wiki 分块本身被排到前面，而是
**BM25 的语料统计量（IDF）在新增 2,266 行后整体改变**，导致若干"主文档"的
BM25 名次漂移。因为受影响的是 `tianocore-docs` 的候选而不是 wiki 候选，
所以"给 wiki 来源降权"无法修复（实测确认）。

**当前决定：保留 Wiki 补全**（尊重"做 Wiki 补全"的需求），代价是：
- 收益：覆盖多 232 页（标题覆盖 267→499），长尾页面问得到；auto 93.0%→94.5%。
- 代价：人工标注自然语言问题 86.9%→82.3%（130 题里约 6 题）。

**如需回退**（恢复 90.6/86.9/93.0）：见第 6 节「回退 Wiki 补全」（删 `tianocore-wiki-git`
分块 → 重建 FTS）。因为补全页**未进向量库**（仅 FTS），回退只需重建 FTS，不需要重嵌入。

### 9.2 环境重启后的确认
- Junction、`D:\tools\{MinGit,Python311}`、venv、模型、`documents.json`(101,378)、
  FTS(101,378)、chroma(33,526) 均完好（都在磁盘上，重启不影响）。
- 重启后需手动启动：daemon / Web（见第 7 节）。

### 9.3 本地 LLM（已完成）
- Ollama 0.34.2 便携版已解压到 `D:\tools\Ollama`（校验 SHA-256 通过）。
- 模型目录：`OLLAMA_MODELS=D:\edk2Agent\.edk2-opencode\ollama-models`（已持久化为用户环境变量）。
- 已拉取并验证 **qwen2.5:14b（9.0 GB）**，OpenAI 兼容端点 `http://127.0.0.1:11434/v1` 正常返回。
- 启动：`D:\tools\Ollama\ollama.exe serve`（已在运行，监听 11434）。

**切换 Web 使用本地模型（离线）：**
```powershell
Copy-Item D:\edk2Agent\web\.env.ollama D:\edk2Agent\web\.env -Force
# 然后重启 Web 服务（见 9.5）
```
**切回云端 DeepSeek：** 恢复 `web/.env` 的 `LLM_BASE_URL=https://api.deepseek.com/v1`
与 `LLM_MODEL=deepseek-flash`（Key 见文件内）。

> 说明：`web/.env` 默认保留**云端 DeepSeek**（回答质量更高）；`web/.env.ollama` 是
> 一键切换用的离线配置，两者都已验证可用。

### 9.4 最终索引/服务状态（2026-09-22）
- `documents.json` 101,378；FTS5 101,378 行；Chroma 33,526（去噪：commits/prs 仅 BM25）。
- daemon：运行中，动态端口写于 `kb\daemon.json`（当前 49476）。
- Web：`http://0.0.0.0:8080`，`/healthz` OK，`llm_configured=true`。
- Ollama：`http://127.0.0.1:11434`，qwen2.5:14b 就绪。

### 9.5 重启后如何把服务全部拉起来
```powershell
. 'D:\tools\edk2-build\env.ps1'; Set-Location 'D:\edk2Agent'
$py = 'D:\edk2Agent\.edk2-opencode\kb\venv\Scripts\python.exe'
$env:EDK2_EMBEDDING_MODEL = 'D:\edk2Agent\.edk2-opencode\models\bge-m3'
$env:EDK2_EMBEDDING_DEVICE='cuda'; $env:EDK2_RERANKER_DEVICE='cuda'

# 1) 本地 LLM（可选）
D:\tools\Ollama\ollama.exe serve
# 2) KB daemon
node bin/edk2-opencode.js daemon start
# 3) Web（建议用独立进程，避免会话重启被杀）
$env:RERANK_PY='D:\edk2Agent\.edk2-opencode\kb\venv\Scripts\python.exe'
$env:KB_DATA_DIR='D:\edk2Agent\.edk2-opencode\kb'; $env:PORT='8080'; $env:HOST='0.0.0.0'
Start-Process node -ArgumentList 'server.js' -WorkingDirectory 'D:\edk2Agent\web' -WindowStyle Hidden
```

---

## 10. 用户问题集评测与调优（2026-10-01）

### 10.1 问题集
`D:\edk2Agent\question.txt`，35 题，Q/A/R 三段式（问题 / 参考答案 / 参考出处）。
评测脚本：`D:\tools\edk2-build\eval_custom.py`（读该文件 → 调 Web `/api/ask` →
用 `deepseek-v4-pro` 对照参考答案打 correctness/completeness → 检查检索是否命中 R 的文档）。
报告：`D:\tools\edk2-build\custom_eval_report.md`、`...\custom_eval_results.json`。

### 10.2 基线结果（调优前）
- mean **correctness = 3.43/5**，mean **completeness = 3.09/5**
- 参考答案文档召回率（Web 实际返回结果）≈ **48%**（36/75，非 PDF）
- 覆盖：84 个参考路径中 73 个在库里（87%）→ **不是缺数据，是召回/排序问题**

**归因**：英文语料 + 中文提问。同一问题改用英文关键词查 daemon，参考答案文档立刻
进前几名（如 `44_identifiers.md`、`52_spacing.md`、`1832_start_and_stop.md`），
中文原句则进不了 top15。最差的是 UEFI 驱动模型 / PEI-PPI-HOB / Boot-Runtime Services /
Event / Secure Boot 等**规范类**问题（这些散落在 `uefi-specs` 与 wiki，而原有的
`DOCS_FOCUS_TOPICS` 只查 `tianocore-docs`）。

另外发现答案里的**具体数字/规则出错**（行宽答成 80 实际 120；漏 PK/KEK/db/dbx），
根因都是没检索到正确文档、模型用自身记忆补空。

### 10.3 已实施的调优（`web/server.js` + `web/.env`）
1. `DOCS_FOCUS_TOPICS` 从 4 个主题扩展到 **18 个**（命名规范、函数排版/注释、
   流程控制/ASSERT、模块类型/库类、驱动绑定、句柄/协议服务、构建/调试/报错、
   贡献流程/commit/Uncrustify/CI、启动流程/PEI/HOB、Boot-Runtime Services、
   TPL/Event、内存分配、变量服务、SMM/MM、HII/VFR、Secure Boot）。
2. 新增主题级 `source` 字段：规范类主题查 `all`（覆盖 `uefi-specs` 与 wiki），
   代码规范类仍查 `tianocore-docs`。
3. 复杂档检索广度 `mainTopK` 22→**30**，标准档 18→22，简单档 12→15。
4. `web/.env`：`LLM_CTX_CHARS_COMPLEX` 16000→**22000**，`LLM_MAX_TOKENS_COMPLEX`
   6000→**8000**。

### 10.4 复测与三轮对比（同一问题集）

| 轮次 | 关键改动 | correctness | completeness | 召回题数 |
|---|---|---|---|---|
| 基线 | — | 3.43 | 3.09 | 28/35 |
| 二轮 | 18 个聚焦主题 + 数据源支持 + topK/上下文加大 | 3.49 | 3.26 | 29/35 |
| 三轮 | + **分档路由修正**（综合性问题→complex） | 3.60 | **3.46** | **30/35** |
| 四轮 | + 贡献/commit/Uncrustify 主题改查 wiki | 3.57 | 3.43 | 30/35 |
| 五轮 | + **修复样板文件污染并全量重建索引** | **3.71** | 3.31 | 29/35 |

**最终（五轮）相对基线：正确性 3.43→3.71（+8.2%），完整性 3.09→3.31（+7.1%）。**
（v3~v5 的差异部分属于评委单票±0.1 方差；正确性上升趋势稳定，且五轮最高。）

观察：移除样板文件主要提升**正确性**（模型不再引用过时的 `Contributed-under` 等），
代价是可用文本略减少使完整性小幅回落。若要继续提升完整性，下一步应针对
"参考文档未被检索到"的题做**逐主题聚焦查询/数据源路由**，或改用更强的生成模型。

**三轮的关键发现**：很多题被路由到 simple/standard 档，`dedup=true` 只保留每篇文档
一个片段，导致"参考文档已检索到、但取到的是无关小节"，回答退化为"无法确认"。
把"有哪些/分别/规定/规则/流程/怎么/如何/为什么"等综合题提升为 complex 档
（`dedup=false` 多片段 + 更深召回 + 更大上下文）后，两项指标明显提升。

**四轮的关键发现**：`commit message`/`Uncrustify` 的参考文档在 **wiki**（`tianocore-wiki`），
而聚焦查询默认查 `tianocore-docs` → 查不到；改用 `source=tianocore-wiki` 后，
`Commit Message Format`/`Commit Signature Format`/`EDK II Code Formatting` 立即进入前列。
（用 `all` 反而会被 commit/PR 记录挤掉。）

报告归档：`custom_eval_report_v2.md` / `_v3.md` / `_v4`（待生成）；
逐题明细 `custom_eval_results.json`。

### 10.5 第四轮后的单点诊断 → 发现真实数据 bug（2026-10-01）

对最弱题「commit message」做单点诊断（`diag_one.py`），发现检索到的上下文被
**`CONTRIBUTIONS.txt` 样板文件污染**：模型据此引用了**已过时的**
`Contributed-under: TianoCore Contribution Agreement 1.0`，而正确的
Wiki `Commit Message Format` 页只排在第 8 位 → 被评审判为错误。

根因是 `edk2-kb/fetchers/init_kb.py` 的 `_SKIP_NAME_PATTERNS` 正则写错：
`^(...|contribut|...)\b` 的 `\b` 使 `contributions` **匹配不上**（`contribut` 后接
`i` 不是词边界），导致 CONTRIBUTIONS.txt / CONTRIBUTING.txt 等流程样板文件进入知识库。

**修复**：去掉 `\b` 改用前缀匹配（`LICENSE/NOTICE/README/CONTRIBUTIONS...` 一并跳过），
然后**清空 ChromaDB + FTS 全量重建**（脚本 `D:\tools\edk2-build\19_rebuild_clean.ps1`），
重建时保留 `EDK2_EMBEDDING_SKIP_SOURCES='edk2-commits,edk2-prs,tianocore-wiki-git'`
（即 wiki 补全页仍仅 BM25）。重建后重跑问题集评测。

> 这是迄今对「答案正确性」影响最直接的一处修复：错误的样板文本会直接把模型
> 引向过时结论，且因为该文件"看起来权威"（官方 CONTRIBUTIONS），模型会照抄。

**注意（第一次重建未生效）**：用 `init_kb.py --skip-docs` 时，`process_documents`
读取的是**旧的** `tianocore-docs/metadata.json`（仍列着 CONTRIBUTIONS.txt），
所以必须先重新生成文档清单。已用 `D:\tools\edk2-build\fix_docs_meta.py` 按新过滤器
重算：**docs 文件 1453 → 1423（跳过 66 个样板 .txt）**，随后全量重建
（脚本 `20_final_rebuild.ps1`，含恢复 wiki 补全分块）：
- documents 87,292 → **87,252**（+MdePkg 11,820 → 99,072；+wiki-git 2,266 → **101,338**）
- Chroma 向量 **33,486**；FTS **101,338**
- 验证：`CONTRIBUTIONS.txt` 已不在库中；聚焦查询把 `Commit Message Format` /
  `Commit Signature Format` / `Commit Partitioning` 排到最前。

---

## 11. 评委双票 与 LTR 学习排序（2026-10-01）

### 11.1 评委双票（降低单票噪声）
脚本 `D:\tools\edk2-build\rescore_custom.py N`：对已存答案用 N 次评判取均值（不重新生成）。
结果：

| 指标 | 单票 | 双票均值 |
|---|---|---|
| correctness | 3.71 | **3.67** |
| completeness | 3.31 | **3.30** |

差异仅 0.04 → 单票评分本身很稳定，**前面的调优收益真实可信**，不是评委噪声。
报告：`custom_eval_report_votes.md`、`custom_eval_results_votes.json`。

### 11.2 LTR（LambdaMART 学习排序）
- 依赖 `lightgbm` 已安装（4.7.0）。
- 特征（`edk2-kb/rank/rank_lib.py`，训练/推理共用，防漂移）：retrieval_score、
  rerank_score、authoritative、doc_type_priority、section_depth、title_overlap、
  content_overlap、age_years、snippet_len。
- 标签：`edk2-kb/eval/label_pipeline.py` 用 LLM 对 (query, chunk) 打 0/1/2 分，
  评测集里的期望文档强制为 2。
- 训练：`edk2-kb/rank/train_ranker.py`（≥300 行且 ≥30 查询才训练）→ `rank/ranker.txt`。
- 启用：环境变量 `EDK2_LTR_MODEL=edk2-kb/rank/ranker.txt`，重启 daemon；
  `search_engine.search()` 在交叉编码器重排**之前**用 LTR 重排融合候选。

**执行记录**：
1. `label_pipeline.py --limit 80 --pool 8` → **379 行 / 80 查询（146 正样本）**。
2. `train_ranker.py` 训练成功 → `rank/ranker.txt`（200 棵树），`rank/ranker_meta.json`：
   特征增益前五 = `content_overlap`(510) > `retrieval_score`(325) > `title_overlap`(91)
   > `snippet_len`(68) > `doc_type_priority`(28.5)；`rerank_score`/`age_years` 增益为 0。
3. `run_eval.py` 在 **LTR 关 / 开** 下各跑一次（330 条），对比 Hit@5/MRR（见 11.3）。

**兼容性修复（本机环境）**：
- `train_ranker.py`：lightgbm ≥4.x 不再接受纯 Python list，改为 `numpy.asarray`；
  另 `positive_ratio` 需 `float()` 转换（numpy 类型不可 JSON 序列化）。

### 11.3 LTR 开/关对比（330 条）
运行脚本 `D:\tools\edk2-build\22_ltr_eval.ps1`（daemon 需先 stop）。

| 配置 | 全局 Hit@5 | manual130 | auto200 | 全局 MRR |
|---|---|---|---|---|
| LTR 关 | 87.9% | 80.0% | **93.0%** | 0.801 |
| LTR 开 | 87.9% | **80.8%** | 92.5% | **0.803** |

**结论：LTR 无实质增益**（差异在单票/样本噪声内；且"无重排"路径反而从 83.0% 降到
79.1%，说明在当前标签量下 LTR 重排不如 dense-first 融合）。原因：训练标签仅
**379 行 / 80 查询**，而 BGE 交叉编码器精排已很强 —— 与项目注释一致
（"标签不足时自动退化为 BGE cross-encoder 精排"）。

→ **决定：保持 LTR 默认关闭**（不设置 `EDK2_LTR_MODEL`）。若日后把标签扩到
数千行/数百查询，再重训评估。

> 附带发现：当前索引（含 wiki 补全，仅 BM25）的 retrieval manual=80.0%，
> 低于未做 wiki 补全时的 86.9% —— 与第 9.1 节记录的"覆盖 vs 精度"权衡一致。

---

## 12. 统一研究目标与指标体系（替代"阶段目标/上位目标"）

### 12.1 单一目标（North Star）
> **让 EDK2 问答助手对任意 EDK2 问题，给出「正确、完整、可溯源」的回答。**

不再分"复现阶段 / 检索阶段 / 生成阶段"等阶段目标；复现、检索、生成、数据治理
都是**同一个目标的贡献项**，任何改动都只问一句：**它让 Q 变好了吗？**

### 12.2 单一主指标 + 守卫指标
- **主指标 Q**（在固定的用户问题集 `question.txt` 上，双票评委）：
  `Q_correctness`（事实正确性，对照参考答案）、`Q_completeness`（要点覆盖率）。
- **守卫指标**：平均延迟（秒）、引用有效率（citation_warn 比例）、
  忠实度告警数（faithfulness_warn）。
- **当前基线（双票）**：`Q = 3.67 / 3.30`（正确性/完整性）。

### 12.3 损失归因维度（不是阶段目标，是同一目标的诊断切面）
每轮评测后，按"谁贡献了最多损失"排序，只改**贡献最大的一项**并复测 Q：

| 维度 | 诊断方法 | 测量结果（当前） |
|---|---|---|
| 数据质量/噪声 | 库里是否有会误导模型的样板/过时文本 | 已修 `CONTRIBUTIONS.txt`（曾直接导致结论错误） |
| 覆盖缺口 | 参考答案路径是否在库中 | 87%（84 路径中 73 在库） |
| 检索召回 | 参考文档是否进入 top-k | ~48%（主瓶颈之一） |
| 排序 | 参考文档在候选中的名次 | LTR 无增益，BGE 精排最优 |
| 路由/分档 | 档位是否与问题复杂度匹配 | 已修（综合题→complex），+0.2 correctness |
| 生成/提示 | 上下文正确时是否仍答错/遗漏 | 剩余主要损失来源 |

### 12.4 与既有工作的映射（同一目标的贡献项）
- 复现（环境/6 数据源/索引/daemon/Web/LLM）＝ 让 Q **可测量** 的前提；
- 检索优化（召回深度、标题加权、来源加权、聚焦主题、分档路由）＝ 提升 Q 的**输入质量**；
- 数据治理（样板过滤）＝ 消除 Q 的**负向输入**；
- 评委双票 = 降低 Q 的**测量噪声**（已确认单票≈双票，±0.04）；
- LTR = 尝试提升 Q 的**排序项**，实测无增益 → 关闭（负结果，已记录）。

### 12.5 下一步（仍指向同一目标，按损失贡献排序）
1. **生成端**：当前用 `deepseek-flash` 生成；换 `deepseek-v4-pro` 生成可望减少细节遗漏
   （是当前最大剩余损失，因为上下文正确时仍会答漏）。
2. **检索召回**：为仍缺口的 4–6 题继续加"逐主题聚焦查询 + 数据源路由"。
3. **覆盖**：把 PDF 版规范（UEFI 2.11 / PI）与 wiki 全量页补齐并统一命名映射。
4. 每次只动一项，复测 Q（双票）与守卫指标，记录到本节。

> 运行期加载：`EDK2_LTR_MODEL` 在 `search_engine.py` **导入时**读取，故每个进程需
> 重新设置环境变量；daemon 的工作目录是 `edk2-kb/`，因此**务必用绝对路径**
> （`D:\edk2Agent\edk2-kb\rank\ranker.txt`）。

> 注意：`label_pipeline.py` 直接用进程内 `SearchEngine`，运行前需 `daemon stop`
> （与 daemon 竞争同一 ChromaDB 文件）。
