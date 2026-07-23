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
        │   ├── create-pr.ps1    # Windows PowerShell
        │   ├── create-pr.sh     # Linux Bash
        │   └── ...
        └── ovmf-build
            └── SKILL.md
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