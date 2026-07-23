# Edk2Agent

EDK II Issue 自动生成PR自动化Skill工具集，为 OpenCode 提供 EDK II 开发自动化支持。

## Skills

### 1. edk2-pr-workflow

Production-grade EDK II PR automation.

**功能：**
- 从 Issue 自动创建 PR
- 从 PR Review Comments 自动更新代码
- 加载官方 PR 模板
- 英文标题验证
- PatchCheck 合规验证

**使用：**
```powershell
# 创建 PR
.\create-pr.ps1 -IssueUrl "https://github.com/tianocore/edk2/issues/12766"

# 更新 PR
.\update-pr.ps1 -PrUrl "https://github.com/tianocore/edk2/pull/12841"
```

### 2. ovmf-build

OVMF 和 EmulatorPkg 编译运行工具。

**功能：**
- 自动安装 QEMU
- 克隆 EDK2 仓库
- 编译 OvmfPkgX64 / EmulatorPkg
- 运行虚拟固件

## 安装

### 方法 1：克隆仓库

```powershell
# 克隆到 OpenCode skills 目录
git clone https://github.com/guziqian0908/Edk2Agent.git
# 将 skills 目录内容复制到 ~/.config/opencode/skills/ 或项目的 .opencode/skills/
```

### 方法 2：手动配置

在项目的 `.opencode/` 目录下创建 `opencode.json`：

```json
{
  "skills": [
    {
      "name": "edk2-pr-workflow",
      "description": "Production-grade EDK II PR automation.",
      "location": "https://github.com/guziqian0908/Edk2Agent/raw/main/skills/edk2-pr-workflow/SKILL.md"
    },
    {
      "name": "ovmf-build",
      "description": "OVMF and EmulatorPkg build and run.",
      "location": "https://github.com/guziqian0908/Edk2Agent/raw/main/skills/ovmf-build/SKILL.md"
    }
  ]
}
```

## 前置要求

- **GitHub CLI** - `gh auth login` 登录
- **Visual Studio** - VS2019/VS2022 工具链
- **Python 3.x** - EDK2 编译依赖
- **NASM** - 汇编编译器
- **Git** - 版本控制

## 许可证

MIT License

## 作者

Gu Ziqian (guziqian0908)