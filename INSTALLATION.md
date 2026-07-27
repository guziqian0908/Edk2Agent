# Edk2Agent 安装指南

## 方式 1: 直接克隆使用（推荐）

### 步骤 1: 安装前置依赖

确保已安装：
- **Node.js** >= 18.0.0 - [下载地址](https://nodejs.org/)
- **Git** - [下载地址](https://git-scm.com/downloads)
- **Python** >= 3.8（可选，用于 RAG 功能）- [下载地址](https://www.python.org/)

### 步骤 2: 克隆仓库

```bash
# 克隆仓库
git clone https://github.com/guziqian0908/Edk2Agent.git
cd Edk2Agent
```

### 步骤 3: 运行测试

```bash
# 运行单元测试验证安装
node tests/run-tests.js
```

### 步骤 4: 登录使用

```bash
# 登录（使用你的 GitHub 用户名和 Token）
node bin/edk2-opencode.js login <username> <token>

# 查看状态
node bin/edk2-opencode.js status

# 启动（需要已安装 OpenCode）
node bin/edk2-opencode.js
```

---

## 方式 2: 通过 NPX 从 GitHub 安装

```bash
# 直接从 GitHub 运行
npx guziqian0908/Edk2Agent

# 或显示版本
npx guziqian0908/Edk2Agent --version

# 登录
npx guziqian0908/Edk2Agent login <username> <token>
```

---

## 方式 3: 本地全局安装

```bash
# 克隆并进入目录
git clone https://github.com/guziqian0908/Edk2Agent.git
cd Edk2Agent

# 全局链接（创建全局命令）
npm link

# 现在可以在任何地方使用
edk2-opencode --version
edk2-opencode login <username> <token>
edk2-opencode
```

---

## 方式 4: 下载 ZIP 包使用

适合不想使用 Git 的用户：

1. 访问 https://github.com/guziqian0908/Edk2Agent
2. 点击绿色按钮 **Code** → **Download ZIP**
3. 解压到任意目录
4. 打开命令行，进入解压目录
5. 运行测试和使用

```bash
# 进入解压目录
cd Edk2Agent-main

# 运行测试
node tests/run-tests.js

# 使用
node bin/edk2-opencode.js --version
```

---

## 完整使用流程示例

```bash
# 1. 克隆仓库
git clone https://github.com/guziqian0908/Edk2Agent.git
cd Edk2Agent

# 2. 运行测试（验证安装）
node tests/run-tests.js

# 3. 查看帮助
node bin/edk2-opencode.js --help

# 4. 登录
node bin/edk2-opencode.js login myusername mytoken

# 5. 查看状态
node bin/edk2-opencode.js status

# 6. （可选）初始化 RAG 知识库
cd rag-service
pip install -r requirements.txt
python run_server.py --fetch-docs --build-index
cd ..

# 7. 启动使用
node bin/edk2-opencode.js
```

---

## 常见问题

### Q1: 没有安装 OpenCode 怎么办？

需要先安装 OpenCode：

```bash
npm install -g @opencode-ai/opencode
```

如果包名不对，请访问 https://opencode.ai 查看正确的安装方式。

### Q2: Python 依赖安装失败？

```bash
cd rag-service

# 使用虚拟环境
python -m venv venv

# 激活虚拟环境
# Windows:
.\venv\Scripts\activate
# Linux/macOS:
source venv/bin/activate

# 安装依赖
pip install -r requirements.txt
```

### Q3: 登录 Token 从哪里获取？

1. 登录 GitHub
2. 访问 Settings → Developer settings → Personal access tokens
3. 生成新 Token（需要的权限：repo, user）
4. 使用 Token 登录

### Q4: 如何更新到最新版本？

```bash
cd Edk2Agent

# 拉取最新代码
git pull origin main

# 重新测试
node tests/run-tests.js
```

---

## 最小化使用（无需 Python）

如果只需要基本功能（Skills 和登录控制），不需要安装 Python：

```bash
# 1. 克隆
git clone https://github.com/guziqian0908/Edk2Agent.git
cd Edk2Agent

# 2. 测试
node tests/run-tests.js

# 3. 登录
node bin/edk2-opencode.js login <username> <token>

# 4. 使用
node bin/edk2-opencode.js
```

---

## 系统要求

| 组件 | 要求 | 说明 |
|------|------|------|
| Node.js | >= 18.0.0 | 必须 |
| Git | 最新版 | 必须（用于克隆） |
| Python | >= 3.8 | 可选（RAG 功能） |
| OpenCode | 最新版 | 可选（完整功能） |

---

## 快速验证脚本

创建 `verify-installation.js`：

```javascript
const { execSync } = require('child_process');

console.log('=== Edk2Agent Installation Verification ===\n');

// Check Node.js
console.log('[1/4] Node.js version:');
console.log('  ' + process.version);

// Check tests
console.log('\n[2/4] Running tests...');
try {
    execSync('node tests/run-tests.js', { stdio: 'inherit' });
    console.log('  ✓ Tests passed');
} catch (e) {
    console.log('  ✗ Tests failed');
}

// Check files
console.log('\n[3/4] Checking required files...');
const fs = require('fs');
const files = [
    'bin/edk2-opencode.js',
    '.opencode/plugins/edk2-auth-guard.js',
    '.opencode/plugins/edk2-api-provider.js',
    'opencode.json'
];
files.forEach(f => {
    if (fs.existsSync(f)) {
        console.log('  ✓ ' + f);
    } else {
        console.log('  ✗ ' + f);
    }
});

// Test CLI
console.log('\n[4/4] Testing CLI...');
try {
    const version = execSync('node bin/edk2-opencode.js --version').toString();
    console.log('  ' + version.trim());
} catch (e) {
    console.log('  ✗ CLI failed');
}

console.log('\n=== Verification Complete ===');
```

运行验证：

```bash
node verify-installation.js
```

---

## 下一步

安装完成后，请阅读：
- [README.md](README.md) - 完整功能说明
- [TESTING.md](TESTING.md) - 测试指南
- [AGENTS.md](AGENTS.md) - Agent 使用说明

