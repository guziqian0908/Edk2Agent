# EDK2-OpenCode v6.0.1

[![npm version](https://img.shields.io/npm/v/edk2-opencode.svg)](https://www.npmjs.com/package/edk2-opencode)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**EDK2 Knowledge Base MCP Daemon - Dual Data Source**

共享式 EDK2 知识库 MCP 服务，支持 TianoCore Wiki + tianocore-docs 双数据源。
知识库运行在独立 daemon 中，通过 MCP 协议为 OpenCode 提供服务。

## v6.0.0 架构

```
┌─────────────┐   ┌────────────────────────────────────────────────┐
│  OpenCode   │──▶│   edk2-kb MCP Daemon (HTTP, 动态端口)          │
│  (多个实例)  │   │                                                │
│             │   │  watchdog (daemon_runner.py)                   │
│             │   │    └── FastMCP server (mcp_server.py)          │
│             │   │          ├── /mcp     (MCP 协议: search_kb...) │
│             │   │          ├── /health  (存活 + 就绪)             │
│             │   │          └── /search  (CLI 便捷端点)            │
└─────────────┘   │          └── SearchEngine (ChromaDB, 常驻内存)  │
                  └────────────────────────────────────────────────┘
```

| 数据源 | 内容 | 更新方式 |
|--------|------|----------|
| TianoCore Wiki | 官网全部页面 | 全站爬取 + 增量更新 |
| tianocore-docs | 全部 33 个仓库的 Markdown 文档 | Git 克隆（多仓库）+ 拉取更新 |

## 特性

- 🗂️ **双数据源**：TianoCore Wiki 全站 + tianocore-docs 全部 33 个仓库
- 🧠 **MCP 服务**：共享 HTTP daemon，OpenCode 通过 MCP 协议远程检索
- 🔌 **动态端口**：不再固定 9876，多实例永不冲突
- ♻️ **崩溃自愈**：watchdog 自动重启崩溃的 server；CLI 按需自愈
- ⚡ **懒加载 + 预热**：daemon 秒级启动，索引后台加载并常驻内存
- 📦 **完全离线**：运行时无需联网，纯本地检索
- 🔧 **内置 Skills**：edk2-pr-workflow, ovmf-build

## 快速开始

### 1. 安装

```bash
npx edk2-opencode@latest
```

### 2. 初始化知识库

**全量初始化（首次使用）：**
```bash
npx edk2-opencode --init-edk2-wiki
```

**增量更新（后续更新）：**
```bash
npx edk2-opencode --init-edk2-wiki --update
```

预计耗时：
- 全量初始化：10-30 分钟
- 增量更新：5-10 分钟

### 3. 启动

```bash
npx edk2-opencode
```

CLI 会自动启动（或复用）知识库 daemon，并把当前动态端点写入
`opencode.json` 的 `mcp.edk2-kb` 配置，然后启动 OpenCode。

### 4. 手动管理 daemon（可选）

```bash
npx edk2-opencode daemon start     # 启动知识库 daemon
npx edk2-opencode daemon status    # 查看状态
npx edk2-opencode daemon restart   # 重启
npx edk2-opencode daemon stop      # 停止
npx edk2-opencode daemon logs      # 查看 supervisor 日志
```

### 5. 直接搜索（可选）

```bash
npx edk2-opencode --search "PCD"
npx edk2-opencode --search "INF file syntax"
```

### 6. 从零重建知识库（他人下载后使用）

知识库的**数据不在仓库里**，但仓库代码可完整重建（`~/.edk2-opencode/kb/data/`）。
按以下步骤，别人克隆本仓库后即可一键构建：

```bash
# Windows
powershell -ExecutionPolicy Bypass -File setup_kb.ps1
# Linux / macOS
bash setup_kb.sh
```

一键脚本依次完成：

| 步骤 | 脚本 | 产出 |
|------|------|------|
| Python 依赖 | `pip install -r edk2-kb/requirements.txt` | venv/全局依赖 |
| 本地模型 | `edk2-kb/fetchers/fetch_models.py` | `~/.edk2-opencode/models/bge-m3` + `bge-reranker-v2-m3` |
| UEFI 规范 | `edk2-kb/fetchers/fetch_specs.py` | `uefi-specs/{ACPI_6.5,PI_1.10,UEFI_2.11}/source/*.rst` + Shell PDF |
| 提交历史 | `edk2-kb/fetchers/fetch_commits.py` | `edk2-commits/commits.txt`（完整历史，blobless 克隆） |
| PR 数据 | `edk2-kb/fetchers/fetch_prs.py` | `edk2-prs/prs.jsonl`（GitHub API，可断点续传） |
| Wiki + docs 建库 | `edk2-kb/fetchers/init_kb.py` | wiki 全站 + tianocore-docs 33 仓库 + 上述数据的分块与索引 |
| MdePkg 源码 | `edk2-kb/fetchers/add_mdepkg.py`（缺失时自动稀疏克隆） | `edk2-mdepkg/` 分块 + FTS5 |

> 提示：
> - 首次全量嵌入 bge-m3（CPU）较慢，约数小时；可用 `setup_kb.ps1 -SkipEmbed` /
>   `setup_kb.sh --skip-embed` 先跳过，稍后再补 `add_mdepkg.py --embed`。
> - `fetch_prs.py` 无需认证（公共仓库），设置 `GITHUB_TOKEN` 可把限速从 60 提高到 5000 次/小时。
> - `--skip-fts`：daemon 运行时持锁 fts_index.db，需先 `daemon stop` 再重建。
> - 各 fetch 脚本支持 `EDK2_KB_DATA` / `EDK2_MODELS_DIR` 环境变量覆盖默认路径。

### 7. 直接使用预构建知识库（下载即用，免重建嵌入）

不想等待数小时重建时，可发布/安装打包好的知识库（数据不在仓库，但在
GitHub Release 上发布）。打包产物按 1.8GB 分片（GitHub 单文件 ≤2GB 限制），
带 SHA-256 清单：

```bash
# 发布方：把已建好的 KB 打成包（kb-runtime 仅运行期数据；--with-sources 含原始源）
python edk2-kb/fetchers/package_kb.py                # 或 --with-sources
gh release create kb-runtime ~/.edk2-opencode/releases/kb-runtime.* \
    --title "KB runtime package" --notes "..."

# 使用方：下载、校验、解压到 ~/.edk2-opencode/kb/（Windows）
powershell -ExecutionPolicy Bypass -File install_kb.ps1
# Linux / macOS
bash install_kb.sh

# 仍需本地模型（~1GB，只在 ~/.edk2-opencode/models/ 缺省时下载）
python edk2-kb/fetchers/fetch_models.py
# 启动
node bin/edk2-opencode.js daemon start
```

运行期包仅含 `chroma_db/` + `fts_index.db` + `processed/`（约 2.2GB），
解压即用；`kb-full` 还包含原始源树，可用于后续增量重建。

## 命令说明

| 命令 | 说明 |
|------|------|
| `--init-edk2-wiki` | 全量初始化知识库 |
| `--init-edk2-wiki --update` | 增量更新知识库 |
| `--status` | 查看状态（认证 + 知识库 daemon） |
| `--search <query>` | 通过 daemon 搜索知识库 |
| `daemon start\|stop\|restart\|status\|logs` | 管理知识库 MCP daemon |
| `--help` | 显示帮助 |
| `--version` | 显示版本 |

## 检索结果格式

```json
{
  "results": [
    {
      "score": 0.95,
      "source": "tianocore-wiki",
      "source_display": "TianoCore Wiki (官网)",
      "title": "PCD Usage",
      "url": "https://...",
      "snippet": "..."
    },
    {
      "score": 0.89,
      "source": "tianocore-docs",
      "source_display": "tianocore-docs (仓库)",
      "file": "specs/pcd.md",
      "snippet": "..."
    }
  ]
}
```

## 内置 Skills

### edk2-pr-workflow

生产级 EDK II PR 自动化工具，支持：

- 从 Issue 创建 PR
- 从 Review 评论更新代码
- 加载官方 PR 模板
- 英文标题验证
- PatchCheck 合规验证

使用：
```
从 Issue https://github.com/tianocore/edk2/issues/12766 创建一个 PR
```

### ovmf-build

OVMF 和 EmulatorPkg 编译运行工具：

- 自动安装 QEMU
- 克隆 EDK2 仓库
- 编译 OvmfPkgX64 / EmulatorPkg
- 运行虚拟固件

使用：
```
编译 OVMF 固件并在 QEMU 中运行
```

## 数据源

### TianoCore Wiki

- 来源：https://www.tianocore.org/tianocore-wiki.github.io/
- 存储：`~/.edk2-opencode/kb/data/tianocore-wiki/`
- 类型：离线 HTML 缓存

### tianocore-docs

- 来源：https://github.com/tianocore-docs （**全部 33 个仓库**，含 Docs、各 EDK II 规范、Training、SecurityAdvisory 等）
- 存储：`~/.edk2-opencode/kb/data/tianocore-docs/repos/`
- 类型：Git 仓库克隆（多仓库同步）

### ChromaDB 索引

- 存储：`~/.edk2-opencode/kb/data/chroma_db/`
- 类型：向量索引文件（daemon 常驻内存）

## 项目结构

```
edk2-opencode/
├── bin/
│   └── edk2-opencode.js     # CLI 入口（含 daemon 子命令）
├── lib/
│   └── daemon.js            # Node daemon 管理器
├── edk2-kb/
│   ├── mcp_server.py        # FastMCP HTTP daemon
│   ├── daemon_runner.py     # watchdog 守护进程（崩溃自愈）
│   ├── search_engine.py     # 可复用搜索引擎（懒加载 + 线程安全）
│   ├── embedded_search.py   # CLI 兼容包装
│   ├── fetchers/
│   │   └── init_kb.py       # 知识库初始化脚本（含全部 tianocore-docs 仓库）
│   └── requirements.txt     # Python 依赖
├── .opencode/skills/
│   ├── edk2-pr-workflow/    # PR 自动化 Skill
│   └── ovmf-build/          # OVMF 编译 Skill
├── opencode.json            # 配置文件（CLI 运行时写入 mcp 配置）
├── AGENTS.md                # Agent 指令
└── package.json
```

运行期文件（用户目录）：
```
~/.edk2-opencode/
├── auth.json                # GitHub 认证
└── kb/
    ├── data/                # 文档 + ChromaDB 索引
    ├── daemon.json          # daemon 状态（端口/PID/端点）
    ├── daemon.pid           # watchdog PID
    ├── daemon.stop          # 停止标记
    ├── venv/                # Python 虚拟环境
    └── logs/                # supervisor/server 日志
```

## 系统要求

- **Node.js**: >= 18.0.0
- **Python**: >= 3.8
- **操作系统**: Windows / Linux / macOS
- **磁盘空间**: 约 2GB（文档 + 向量索引）

## 架构演进

### v3.x 多进程 HTTP MCP（旧 - 有问题）

```
用户 → OpenCode → HTTP (9876固定端口) → Python MCP Server → ChromaDB/WeKnora
```

问题：端口冲突、请求超时、进程崩溃、启动慢、RPC 复杂、WeKnora 不稳定

### v5.x 嵌入式（中间方案）

```
用户 → OpenCode → Node→Python 每请求子进程 → ChromaDB
```

问题：每次搜索都启动 Python 进程，延迟高；无 MCP 标准协议

### v6.0.0 MCP Daemon（当前）

```
用户 → OpenCode → MCP (HTTP, 动态端口) → FastMCP server → ChromaDB(常驻)
```

优势：动态端口无冲突、索引常驻低延迟、watchdog 崩溃自愈、秒级启动、
标准 MCP 协议、多实例共享单一 daemon、仅 ChromaDB 稳定可靠

## 许可证

MIT License

## 相关链接

- [OpenCode](https://opencode.ai)
- [TianoCore EDK2](https://github.com/tianocore/edk2)
- [TianoCore Wiki](https://www.tianocore.org/tianocore-wiki.github.io/)
- [tianocore-docs](https://github.com/tianocore-docs)
- [FastMCP](https://github.com/jlowin/fastmcp)
