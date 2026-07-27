# Edk2Agent - EDK2专属OpenCode定制工具

基于OpenCode定制的EDK2开发专属Agent工具，内置EDK2开发所需的全部Skills、MCP服务和RAG知识库。

## 核心特性

- **📦 一键安装**: `npx edk2-opencode` 快速启动，无需手动配置
- **🔐 GitHub Token认证**: 使用GitHub Personal Access Token验证登录
- **🔑 用户自配API**: 用户配置自己的LLM API Key使用
- **📚 RAG知识库**: 预构建EDK2文档向量库，支持离线检索
- **⚡ 内存缓存**: 高频查询缓存，降低响应延迟
- **🤖 自动化工作流**: EDK2 PR创建、更新全自动化

## 快速开始

### 方式 1: NPX 一键启动（公网）

```bash
# 直接运行（自动下载依赖）
npx edk2-opencode

# 或全局安装后使用
npm install -g edk2-opencode
edk2-opencode
```

### 方式 2: 内网私有 npm 安装

**管理员发布**：
```bash
# 1. 配置内网 registry
npm config set registry http://your-internal-registry:4873

# 2. 登录（如需认证）
npm adduser --registry http://your-internal-registry:4873

# 3. 发布
npm run publish:internal

# 或指定 registry
NPM_REGISTRY=http://your-internal-registry:4873 npm run publish:internal
```

**用户安装**：
```bash
# 1. 配置内网 registry
npm config set registry http://your-internal-registry:4873

# 2. 安装
npm install -g edk2-opencode

# 3. 运行
edk2-opencode
```

### 方式 3: 源码安装

```bash
# 克隆仓库
git clone https://github.com/guziqian0908/Edk2Agent.git
cd Edk2Agent

# 安装依赖
npm install

# 安装Python依赖（用于RAG服务）
cd rag-service
pip install -r requirements.txt
cd ..
```

### 登录系统

**重要**: 必须使用GitHub Personal Access Token登录才能使用Skills和MCP服务。

#### 创建GitHub Token

1. 访问 https://github.com/settings/tokens
2. 点击 **"Generate new token (classic)"**
3. 勾选权限：
   - `repo` - 仓库访问权限
   - `read:user` - 用户信息读取权限
4. 点击 **"Generate token"** 并复制生成的Token

#### 登录命令

```bash
# 登录（使用你的GitHub用户名和Token）
edk2-opencode login <你的GitHub用户名> <你的GitHub Token>

# 查看状态
edk2-opencode status

# 登出（清空缓存）
edk2-opencode logout
```

#### 登录验证说明

- 系统会验证Token是否有效
- Token所属用户必须与输入的用户名匹配
- 登录信息保存在本地 `~/.config/opencode/.edk2_login`
- Session有效期24小时

### 初始化知识库

首次使用需要初始化RAG知识库：

```bash
# 初始化（下载并索引EDK2文档）
edk2-opencode --init

# 更新知识库
edk2-opencode --update-kb
```

## 目录结构

```
Edk2Agent/
├── package.json              # npm包配置
├── bin/
│   └── edk2-opencode.js      # CLI入口脚本
├── lib/                      # 核心库
├── scripts/
│   ├── postinstall.js        # 安装后脚本
│   └── prepack.js            # 打包脚本
├── rag-service/              # RAG知识库服务
│   ├── rag_service/
│   │   ├── config.py
│   │   ├── document_fetcher.py
│   │   ├── vector_store.py
│   │   ├── mcp_server.py
│   │   └── cache.py          # 内存缓存模块
│   ├── run_server.py
│   ├── update_knowledge_base.py
│   └── requirements.txt
├── prebuilt-vectors/         # 预构建向量库
├── .opencode/
│   ├── skills/
│   │   ├── edk2-pr-workflow/ # PR自动化Skill
│   │   └── ovmf-build/       # OVMF编译Skill
│   ├── plugins/
│   │   ├── edk2-auth-guard.js # 登录权限控制
│   │   └── edk2-api-provider.js # API配置与缓存
│   └── commands/
│       ├── login.md
│       ├── logout.md
│       └── status.md
├── opencode.json             # OpenCode配置
├── AGENTS.md                 # Agent指令
└── README.md
```

## 登录系统详解

### 登录流程

```
用户输入Token → 调用GitHub API验证 → 验证用户名匹配 → 保存登录状态
```

### 登录状态持久化

登录信息保存在 `~/.config/opencode/.edk2_login`，有效期24小时。

```bash
# 登录
edk2-opencode login guziqian0908 ghp_xxxx

# 查看状态
edk2-opencode status
# 输出:
# [STATUS] Logged in as guziqian0908
# [AUTH]   Method: github
# [TIME]   Session expires in 24 hours
#
# Features enabled:
#   ✓ edk2-pr-workflow skill
#   ✓ ovmf-build skill
#   ✓ edk2-rag MCP service

# 登出（清空缓存）
edk2-opencode logout
# 输出:
# [SUCCESS] Logged out
```

### 权限控制

| 状态 | Skills | MCP服务 | 说明 |
|------|--------|---------|------|
| 未登录 | 禁用 | 禁用 | 需要GitHub Token登录 |
| 已登录 | 启用 | 启用 | 完整功能可用 |

### 安全说明

- Token仅用于验证，**不存储明文**
- 存储的是SHA256哈希后的前16位
- 登录信息仅保存在用户本地

## API配置

**重要**: 本工具需要配置LLM API Key才能正常使用。请选择以下任一方式配置。

### 方式1: 环境变量配置（推荐）

```bash
# Anthropic Claude（推荐）
export ANTHROPIC_API_KEY="sk-ant-xxx"

# 或 OpenAI GPT
export OPENAI_API_KEY="sk-xxx"

# 或 智谱 GLM
export ZHIPU_API_KEY="xxx"
```

Windows PowerShell:
```powershell
$env:ANTHROPIC_API_KEY="sk-ant-xxx"
```

### 方式2: opencode.json配置

在项目根目录创建或修改 `opencode.json`：

```json
{
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "sk-ant-xxx"
      }
    }
  }
}
```

### API获取地址

| 提供商 | 获取地址 | 推荐模型 |
|--------|----------|----------|
| Anthropic | https://console.anthropic.com | claude-sonnet-4-6 |
| OpenAI | https://platform.openai.com | gpt-4 |
| 智谱 | https://open.bigmodel.cn | glm-5 |

### API优先级

```
环境变量配置 > opencode.json配置
```

### 对话缓存机制

为减少API请求频次，系统内置对话缓存：

```javascript
// 缓存配置
const CACHE_CONFIG = {
  maxSize: 100,        // 最大缓存条目数
  ttlHours: 1,         // 缓存有效期（小时）
  enabled: true        // 默认启用
};
```

缓存命中日志：
```
[EDK2 CACHE] Cache hit
[EDK2 CACHE] Response cached
```

## RAG知识库

### 功能特性

- **双文档源**: tianocore-wiki + tianocore-docs
- **预构建向量库**: 开箱即用，无需首次索引
- **内存缓存**: 高频查询直接返回缓存结果
- **增量更新**: 支持手动刷新最新文档

### MCP工具列表

| 工具 | 描述 | 参数 |
|------|------|------|
| `search_edk2_docs` | 检索EDK2文档 | `query` (必需), `top_k` (可选) |
| `get_edk2_doc_by_id` | 按ID获取文档 | `doc_id` (必需) |
| `list_edk2_sources` | 列出文档来源 | 无 |
| `get_rag_stats` | 获取服务统计 | 无 |

### 检索示例

```bash
# 在OpenCode会话中
opencode> 查询OVMF编译方法
opencode> 查询UEFI驱动开发指南
opencode> 如何配置EmulatorPkg控制台分辨率
```

### 检索结果来源标注

每个检索结果自动标注文档来源：

```json
{
  "results": [{
    "title": "Building OVMF",
    "score": 0.92,
    "content": "...",
    "source": "tianocore-wiki",
    "url": "https://github.com/tianocore/tianocore.github.io/wiki/Building-OVMF"
  }]
}
```

### 内存缓存

```python
# 缓存配置
cache_config = {
    "max_size": 100,         # 最大缓存条目
    "ttl_seconds": 3600,     # 有效期（秒）
    "enabled": True
}
```

缓存命中时日志：
```
[INFO] Cache hit for query
```

### 知识库更新

```bash
# 更新知识库（拉取最新文档并重建索引）
python rag-service/update_knowledge_base.py

# 强制更新
python rag-service/update_knowledge_base.py --force
```

## Skills

### 1. edk2-pr-workflow

Production-grade EDK II PR自动化。

**功能：**
- 从 Issue 自动创建 PR
- 从 PR Review Comments 自动更新代码
- 加载官方 PR 模板
- 英文标题验证
- PatchCheck 合规验证
- 跨平台支持（Windows/Linux）

**使用：**
```powershell
# 创建 PR
.\.opencode\skills\edk2-pr-workflow\create-pr.ps1 -IssueUrl "https://github.com/tianocore/edk2/issues/12766"

# 更新 PR
.\.opencode\skills\edk2-pr-workflow\update-pr.ps1 -PrUrl "https://github.com/tianocore/edk2/pull/12841"
```

### 2. ovmf-build

OVMF 和 EmulatorPkg 编译运行工具。

**功能：**
- 自动安装 QEMU
- 克隆 EDK2 仓库
- 编译 OvmfPkgX64 / EmulatorPkg
- 运行虚拟固件
- 跨平台支持（Windows + Linux）

**使用：**
在OpenCode会话中请求：
```
opencode> 帮我编译OVMF
opencode> 如何运行EmulatorPkg
```

## 测试

### 运行测试

```bash
# 运行认证守卫测试
node tests/run-tests.js

# 运行RAG服务测试
cd rag-service
pytest tests/ -v
```

### 测试覆盖率

```
edk2-auth-guard.js
  ✓ login persistence
  ✓ logout clears cache
  ✓ access control
  ✓ session expiration

edk2-api-provider.js
  ✓ api priority
  ✓ cache hit/miss
  ✓ stats tracking

rag-service
  ✓ config loading
  ✓ cache operations
  ✓ vector store
```

## 命令列表

| 命令 | 说明 | 参数 |
|------|------|------|
| `edk2-opencode` | 启动工具 | 无 |
| `edk2-opencode login` | GitHub Token登录 | `<github用户名> <github_token>` |
| `edk2-opencode logout` | 登出清缓存 | 无 |
| `edk2-opencode status` | 查看登录状态 | 无 |
| `edk2-opencode --init` | 初始化RAG | 无 |
| `edk2-opencode --update-kb` | 更新知识库 | 无 |
| `edk2-opencode --version` | 显示版本 | 无 |

## 前置要求

### Node.js
- Node.js >= 18.0.0
- npm >= 9.0.0

### Python（RAG服务）
- Python >= 3.8
- pip

### EDK2开发（Skills）
- **Windows**: Visual Studio 2019/2022, NASM
- **Linux**: GCC, NASM, build-essential

## 跨平台支持

| 平台 | 状态 | 说明 |
|------|------|------|
| Windows | ✅ 完全支持 | VS工具链 |
| Linux | ✅ 完全支持 | GCC工具链 |
| macOS | ⚠️ 部分支持 | RAG服务可用 |

## 性能指标

| 指标 | 数值 |
|------|------|
| NPX启动时间 | < 5秒 |
| RAG检索延迟 | 100-300ms |
| 缓存命中率 | 30-50% |
| 内存占用 | 500MB-1GB |

## 故障排除

### Q: NPX启动失败

```bash
# 清除缓存重试
npx clear-npx-cache
npx edk2-opencode
```

### Q: Python依赖安装失败

```bash
# 使用虚拟环境
cd rag-service
python -m venv venv
source venv/bin/activate  # Linux
.\venv\Scripts\activate   # Windows
pip install -r requirements.txt
```

### Q: 知识库初始化超时

```bash
# 手动分步执行
cd rag-service
python run_server.py --fetch-docs
python run_server.py --build-index
```

### Q: 登录状态丢失

检查配置目录权限：
```bash
ls -la ~/.config/opencode/
```

## 许可证

MIT License

## 作者

Gu Ziqian (guziqian0908)

## 相关链接

- [OpenCode](https://opencode.ai)
- [TianoCore](https://www.tianocore.org)
- [EDK2](https://github.com/tianocore/edk2)