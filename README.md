# Edk2Agent - EDK2专属OpenCode定制工具

基于OpenCode定制的EDK2开发专属Agent工具，内置EDK2开发所需的全部Skills和MCP服务。

## 核心特性

- **🔒 登录权限控制**: 未登录状态下禁用所有Skill和MCP服务
- **🔑 内置API兜底**: 提供内置API Token，无需配置即可使用
- **📚 RAG知识库**: 内置EDK2文档语义检索功能
- **🤖 自动化工作流**: EDK2 PR创建、更新全自动化

## 目录结构

```
Edk2Agent/
├── opencode.json              # OpenCode配置文件
├── AGENTS.md                  # Agent指令文档
├── README.md
├── rag-service/               # RAG知识库服务
│   ├── rag_service/
│   ├── tests/
│   └── README.md
└── .opencode/
    ├── skills/
    │   ├── edk2-pr-workflow/  # PR自动化Skill
    │   └── ovmf-build/        # OVMF编译Skill
    ├── plugins/
    │   ├── edk2-auth-guard.js # 登录权限控制插件
    │   └── edk2-api-provider.js # API配置插件
    └── commands/
        ├── login.md           # 登录命令
        ├── logout.md          # 登出命令
        └── status.md          # 状态查询命令
```

## 快速开始

### 1. 安装

```bash
# 克隆仓库
git clone https://github.com/guziqian0908/Edk2Agent.git
cd Edk2Agent

# 安装OpenCode（如未安装）
npm install -g @opencode-ai/opencode

# 安装RAG服务依赖（可选，用于知识库功能）
cd rag-service
pip install -r requirements.txt
cd ..
```

### 2. 登录

**重要**: 必须先登录才能使用Skills和MCP服务。

```bash
# 登录命令
opencode login <username> <token>

# 或在OpenCode会话中使用
/login <username> <token>
```

### 3. 使用

登录成功后，所有Skill和MCP服务自动启用：

```bash
# 启动OpenCode
opencode

# 使用Skills
opencode> /skill edk2-pr-workflow
opencode> /skill ovmf-build

# 查询EDK2文档
opencode> 查询OVMF编译方法
```

## 登录系统

### 登录状态持久化

登录信息保存在 `~/.config/opencode/.edk2_login`，有效期24小时。

```bash
# 登录
opencode login myuser mytoken123

# 查看状态
opencode status

# 登出
opencode logout
```

### 权限控制

| 状态 | Skills | MCP服务 | API |
|------|--------|---------|-----|
| 未登录 | 禁用 | 禁用 | 使用内置API |
| 已登录 | 启用 | 启用 | 用户配置优先 |

## API配置

### 双API优先级机制

系统支持两层API配置：

1. **用户自定义API** (优先级最高)
2. **内置默认API** (兜底机制)

### 配置方式

**方式1: 环境变量**

```bash
# 用户自定义API（优先）
export ANTHROPIC_API_KEY="your-api-key"
export OPENAI_API_KEY="your-openai-key"

# 内置API（系统预置，无需配置）
# 由环境变量 EDK2_BUILTIN_ANTHROPIC_KEY 提供
```

**方式2: opencode.json配置**

```json
{
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "your-api-key"
      }
    }
  }
}
```

### API状态日志

启动时会显示当前生效的API配置：

```
[EDK2 API] API Provider Status:
  - anthropic: User configured (key: sk-ant-...)
  - openai: Built-in available
```

## Skills

### 1. edk2-pr-workflow

Production-grade EDK II PR automation.

**功能：**
- 从 Issue 自动创建 PR
- 从 PR Review Comments 自动更新代码
- 加载官方 PR 模板
- 英文标题验证
- PatchCheck 合规验证
- **跨平台支持：Python 脚本（推荐）**

**使用 - Python（推荐，跨平台）：**
```bash
# 创建 PR
python create-pr.py --issue-url "https://github.com/tianocore/edk2/issues/12766"

# 更新 PR
python update-pr.py --pr-url "https://github.com/tianocore/edk2/pull/12841"
```

**使用 - Windows PowerShell：**
```powershell
# 创建 PR
.\create-pr.ps1 -IssueUrl "https://github.com/tianocore/edk2/issues/12766"

# 更新 PR
.\update-pr.ps1 -PrUrl "https://github.com/tianocore/edk2/pull/12841"
```

**使用 - Linux Bash：**
```bash
# 创建 PR
chmod +x create-pr.sh
./create-pr.sh --issue-url "https://github.com/tianocore/edk2/issues/12766"

# 更新 PR
./update-pr.sh --pr-url "https://github.com/tianocore/edk2/pull/12841"
```

### 2. ovmf-build

OVMF 和 EmulatorPkg 编译运行工具。

**功能：**
- 自动安装 QEMU
- 克隆 EDK2 仓库
- 编译 OvmfPkgX64 / EmulatorPkg
- 运行虚拟固件
- **跨平台支持：Windows + Linux**

## MCP服务

### edk2-rag (RAG知识库)

基于语义检索的EDK2文档查询服务。

**功能：**
- 自动抓取 tianocore-wiki 和 tianocore-docs
- 向量化索引和语义搜索
- MCP标准API接口

**使用：**
```bash
# 启动RAG服务
cd rag-service
python run_server.py --fetch-docs --build-index

# 在OpenCode中查询
opencode> 查询OVMF编译步骤
opencode> 查询UEFI驱动开发指南
```

**详细文档**: [rag-service/README.md](rag-service/README.md)

## 命令列表

| 命令 | 说明 | 参数 |
|------|------|------|
| `/login` | 登录以启用Skills/MCP | `<username> <token>` |
| `/logout` | 登出并禁用保护功能 | 无 |
| `/status` | 查看登录和API状态 | 无 |

## 安装（详细）

### 方法 1：OpenCode 命令安装（推荐）

```bash
opencode skills install guziqian0908/Edk2Agent
```

### 方法 2：手动克隆

```powershell
git clone https://github.com/guziqian0908/Edk2Agent.git
# 将 .opencode/skills 目录复制到项目根目录
```

## 前置要求

### Python（推荐，跨平台）
- **Python 3.6+**
- **GitHub CLI** - `gh auth login` 登录
- **Git** - 版本控制

### Windows
- **Visual Studio** - VS2019/VS2022 工具链
- **Python 3.x** - EDK2 编译依赖
- **NASM** - 汇编编译器

### Linux
- **GCC** - C 编译器工具链
- **Python 3.x** - EDK2 编译依赖
- **NASM** - 汇编编译器
- **build-essential** - 编译工具

```bash
# Ubuntu/Debian 安装依赖
sudo apt-get install -y gcc nasm build-essential python3 git

# 安装 GitHub CLI
# 参考: https://github.com/cli/cli/blob/trunk/docs/install_linux.md
```

## 许可证

MIT License

## 作者

Gu Ziqian (guziqian0908)