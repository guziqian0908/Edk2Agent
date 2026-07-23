# Edk2Agent

EDK II Issue 自动生成PR自动化Skill工具集，为 OpenCode 提供 EDK II 开发自动化支持。

**跨平台支持：Windows、Linux、macOS（Python）**

## 目录结构

```
Edk2Agent/
├── README.md
└── .opencode
    └── skills
        ├── edk2-pr-workflow
        │   ├── SKILL.md
        │   ├── create-pr.py     # Python (推荐)
        │   ├── update-pr.py     # Python (推荐)
        │   └── ...
        ├── ovmf-build
        │   └── SKILL.md
        └── tianocore-wiki-mcp   # 新增
            ├── SKILL.md
            ├── mcp_server.py
            ├── fetch_wiki.py
            └── knowledge/
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

**使用：**
```bash
# Python（推荐，跨平台）
python create-pr.py --issue-url "https://github.com/tianocore/edk2/issues/12766"
python update-pr.py --pr-url "https://github.com/tianocore/edk2/pull/12841"
```

### 2. ovmf-build

OVMF 和 EmulatorPkg 编译运行工具。

**功能：**
- 自动安装 QEMU
- 克隆 EDK2 仓库
- 编译 OvmfPkgX64 / EmulatorPkg
- 运行虚拟固件
- **跨平台支持：Windows + Linux**

### 3. tianocore-wiki-mcp (新增)

TianoCore EDK II 文档 MCP 服务。

**功能：**
- 提供 EDK II 开发文档知识库
- 通过 MCP 协议让 AI 访问文档
- 支持文档搜索和页面获取
- 无需反复访问网站检索内容

**使用：**
```bash
# 初始化知识库
python .opencode/skills/tianocore-wiki-mcp/fetch_wiki.py --sample

# 启动 MCP 服务
python .opencode/skills/tianocore-wiki-mcp/mcp_server.py
```

**MCP 配置：**
```json
{
  "mcpServers": {
    "tianocore-wiki": {
      "command": "python",
      "args": [".opencode/skills/tianocore-wiki-mcp/mcp_server.py"]
    }
  }
}
```

## 安装

### 方法 1：OpenCode 命令安装（推荐）

```bash
opencode skills install guziqian0908/Edk2Agent
```

### 方法 2：手动克隆

```bash
git clone https://github.com/guziqian0908/Edk2Agent.git
# 将 .opencode/skills 目录复制到项目根目录
```

## 前置要求

### 通用要求
- **Python 3.6+** - 跨平台脚本支持
- **GitHub CLI** - `gh auth login` 登录
- **Git** - 版本控制

### Windows 额外要求
- **Visual Studio** - VS2019/VS2022 工具链
- **NASM** - 汇编编译器

### Linux 额外要求
- **GCC** - C 编译器工具链
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