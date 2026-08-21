# Edk2Agent Web 问答服务

轻量型局域网问答网页：客户通过浏览器输入 EDK2 / UEFI 问题，服务自动检索本地知识库，并（可选）调用 LLM 生成整理好的回答，返回网页展示。

## 架构

```
客户浏览器（局域网任意机器）
   │ http://<服务器IP>:8080
   ▼
web/server.js（Node HTTP 服务，固定端口 8080）
   ├─ ① POST /api/ask → 转发 daemon /search 检索知识库（Top5 + 置信度 + citation）
   ├─ ② 调 LLM API（OpenAI 兼容）→ 基于检索结果生成回答
   └─ ③ 返回 LLM 回答 + 检索列表到网页
   ▼
daemon（edk2-kb/mcp_server.py，检索服务）
   ▼
SearchEngine（向量 + FTS + RRF + 重排 + 置信度 + citation）
```

## 启动

### 1. 前置条件

- 已初始化知识库（`npx edk2-opencode --init-edk2-wiki`）
- 本地模型已下载（`~/.edk2-opencode/models/bge-m3`、`bge-reranker-v2-m3`）
- Node.js ≥ 18

### 2. 启动 Web 服务

```powershell
# 进入仓库 web 目录
cd edk2-opencode-v3\web

# （可选）配置 LLM——不配置时网页只显示检索结果列表
$env:LLM_API_KEY = "你的API Key"
$env:LLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4"   # OpenAI 兼容接口
$env:LLM_MODEL    = "glm-4-flash"

# 启动（默认监听 0.0.0.0:8080，局域网可访问）
node server.js
```

首次提问时，若 daemon 未运行，服务会自动拉起 daemon（`npx edk2-opencode daemon start`）。

### 3. 访问

- 本机：浏览器打开 `http://127.0.0.1:8080`
- 局域网其他机器：`http://<服务器IP>:8080`（如 `http://192.168.1.50:8080`）

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `8080` | Web 服务端口 |
| `HOST` | `0.0.0.0` | Web 服务绑定地址（默认所有网卡） |
| `KB_HOST` | `127.0.0.1` | daemon 绑定地址（设 `0.0.0.0` 时 daemon 也对外监听，供其他机器直连 /search） |
| `KB_DATA_DIR` | `~/.edk2-opencode/kb` | 知识库数据目录 |
| `LLM_API_KEY` | — | LLM API Key（不配置则只显示检索结果） |
| `LLM_BASE_URL` | — | OpenAI 兼容接口地址（如智谱/DeepSeek/vLLM） |
| `LLM_MODEL` | — | 模型名（如 `glm-4-flash`） |
| `LLM_MAX_TOKENS` | `3000` | standard 档单次回答最大 token 数 |
| `LLM_MAX_TOKENS_SIMPLE` | `1600` | simple 档（单点/短问题）最大 token 数 |
| `LLM_MAX_TOKENS_COMPLEX` | `6000` | complex 档（多子问题/对比）最大 token 数 |
| `LLM_CTX_CHARS_COMPLEX` | `16000` | complex 档首次生成的检索上下文字符预算 |
| `LLM_REASONING_EFFORT` | `none` | 上游推理强度（`none`/`low`/`medium`；提高可让复杂问题分解更充分，但更慢） |
| `RERANK_CANDIDATES_COMPLEX` | `24` | complex 档送入重排器的候选数 |
| `RERANK_SNIPPET_CHARS_COMPLEX` | `1200` | complex 档每个候选送入重排器的文本长度 |
| `RERANK_SPAWN_COOLDOWN_MS` | `300000` | 重排服务自动拉起冷却时间（毫秒） |
| `L3_FAITHFULNESS_CHECK` | 开 | 设为 `false` 关闭 complex 档生成后忠实度校验（LLM-judge） |

## 接口

| 接口 | 说明 |
|------|------|
| `GET /` | 问答页面 |
| `POST /api/ask` | 提问：`{"question":"..."}` → `{question, results, llm:{answer, model}, daemon}` |
| `GET /api/status` | 服务状态（daemon 健康、LLM 配置、KB 目录） |
| `GET /healthz` | 本服务存活检查 |

## 安全提示

- daemon 无鉴权。`KB_HOST=0.0.0.0` 时，局域网内任何知道端口者均可调用 `/search`（只读检索）。敏感环境请仅在可信内网部署，或后续在 web 服务加 token 校验。
- LLM API Key 保存在服务器环境变量中，不会下发到浏览器。

## 公网 MCP 服务（供 opencode 用户使用）

知识库 RAG 可以作为一个独立 MCP 服务，运行在本机并暴露到公网。
**用户只需在 opencode 里配置一个 remote MCP，无需下载任何 EDK2 资料。**

```powershell
# 一键启动：MCP 服务（固定端口 18765）+ cloudflared 公网隧道
.\start-mcp.ps1

# 服务已运行，只管理隧道
.\start-mcp.ps1 -TunnelOnly

# 自定义端口
.\start-mcp.ps1 -Port 18000
```

脚本会打印给用户的 opencode 配置片段：

```json
{
  "mcp": {
    "edk2-kb": {
      "type": "remote",
      "url": "https://<公网地址>.trycloudflare.com/mcp",
      "enabled": true
    }
  }
}
```

> 注意：trycloudflare 隧道地址是临时的，重启 `start-mcp.ps1` 会更换地址，
> 需要把新 URL 重新发给用户。完整用户安装说明见 `MCP安装指南.md`。

## 验证

```powershell
# 服务存活
curl http://127.0.0.1:8080/healthz

# 提问（检索 + LLM 回答）
curl -X POST http://127.0.0.1:8080/api/ask -H "Content-Type: application/json" `
  -d '{"question":"PcdDebugPrintErrorLevel"}'

# 状态
curl http://127.0.0.1:8080/api/status
```

## Phase 2 说明（2026-08-21）

- **切分 v2（需重建知识库生效）**：规则句粒度（spec/规范 markdown 1200 字符）、
  表格/代码块保护、词法主题间隙边界（语义感知的无模型代理）、重叠 0（句尾锚定，
  无重复文本）、`section_level` 层级元数据、commit/PR `date` 时间戳（旧 commit 检索降权）。
  重建命令（先在 Python 环境装依赖 `pip install -r edk2-kb/requirements.txt`）：
  ```powershell
  npx edk2-opencode --init-edk2-wiki
  ```
- **词表收敛**：中文扩展规则单一事实源 `edk2-kb/expansion_rules.json`，
  web 与 daemon 共同加载（daemon 仅对含中文的查询生效，英文查询行为不变）。
- **简单问题扩写兜底**：短中文问题自动生成 2-3 个英文改写，按"主题锚定 +
  检索增益"双重校验，无增益的改写直接废弃（不用余弦阈值）。
- **评测工具**：
  - `python edk2-kb/eval/tier_monitor.py`：按 simple/standard/complex 档位
    聚合 trace.jsonl 的延迟/长度/引用/忠实度回归监控；
  - `python edk2-kb/eval/run_web_eval.py`：全链路 LLM-judge 评测
    （faithfulness + relevancy 双轴评分，按档位分组，输出报告）。
