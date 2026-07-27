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

### 内网私有 npm 安装

适用于内网环境，需先配置私有 npm 仓库。

#### 管理员：发布到私有仓库

**步骤 1：部署 Verdaccio（如未部署）**
```bash
# 安装 Verdaccio
npm install -g verdaccio

# 启动服务（默认端口 4873）
verdaccio

# 后台运行（推荐）
Start-Process -FilePath "verdaccio" -WindowStyle Hidden  # Windows
nohup verdaccio &                                        # Linux
```

**步骤 2：发布包**
```bash
# 克隆项目
git clone https://github.com/guziqian0908/Edk2Agent.git
cd Edk2Agent

# 配置私有 registry
npm config set registry http://192.168.122.116:4873

# 登录（首次需认证）
npm adduser --registry http://192.168.122.116:4873
# 输入用户名、密码、邮箱

# 发布
npm publish --registry http://192.168.122.116:4873

# 或使用脚本
NPM_REGISTRY=http://192.168.122.116:4873 npm run publish:internal
```

**步骤 3：验证发布**
```bash
# 查看包信息
npm view edk2-opencode --registry http://192.168.122.116:4873

# 访问 Web UI
# 浏览器打开: http://192.168.122.116:4873
```

#### 用户：从私有仓库安装

**步骤 1：配置 registry**
```bash
# 设置私有 registry
npm config set registry http://192.168.122.116:4873

# 或创建 .npmrc 文件
echo "registry=http://192.168.122.116:4873" > ~/.npmrc
```

**步骤 2：安装**
```bash
# 全局安装
npm install -g edk2-opencode

# 验证安装
edk2-opencode --version
```

**步骤 3：配置 API**
```bash
# 选择一种 API 配置
export ANTHROPIC_API_KEY="sk-ant-xxx"    # Anthropic
# 或
export OPENAI_API_KEY="sk-xxx"           # OpenAI
# 或
export ZHIPU_API_KEY="xxx"               # 智谱

# Windows PowerShell
$env:ANTHROPIC_API_KEY="sk-ant-xxx"
```

**步骤 4：登录**
```bash
# 创建 GitHub Token: https://github.com/settings/tokens
# 勾选权限: repo, read:user

# 登录
edk2-opencode login <你的GitHub用户名> <你的GitHub Token>

# 验证登录
edk2-opencode status
```

**步骤 5：启动使用**
```bash
# 启动
edk2-opencode

# 或查看帮助
edk2-opencode --help
```

#### 内网安装注意事项

| 项目 | 说明 |
|------|------|
| Registry 地址 | http://192.168.122.116:4873 |
| 端口 | 4873 |
| 认证 | 首次使用需 `npm adduser` 注册 |
| 依赖 | `opencode-ai` 会自动从公网下载 |
| 离线 | 若完全离线，需提前缓存 `opencode-ai` |

#### 完全离线环境

如果内网完全无法访问公网，需要预先缓存依赖：

```bash
# 在有网环境预下载
git clone https://github.com/guziqian0908/Edk2Agent.git
cd Edk2Agent
npm install

# 打包 node_modules
tar -czf node_modules.tar.gz node_modules/

# 拷贝到离线环境后解压
tar -xzf node_modules.tar.gz
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

### 初始化知识库（服务端操作）

知识库已部署在服务器，用户无需初始化。服务端管理员操作：

```bash
# 初始化（下载并索引EDK2文档）
cd rag-service
python update_knowledge_base.py

# 强制更新
python update_knowledge_base.py --force
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

### 架构说明

采用**集中式服务架构**，用户无需本地部署 RAG 服务。

```
用户电脑                        服务器
    │                              │
    │  HTTP请求                    │
    │  ─────────────────────────>  │
    │                              │  向量数据库
    │  返回检索结果                │  chroma_db/
    │  <─────────────────────────  │
    │                              │
```

| 项目 | 说明 |
|------|------|
| 服务地址 | `http://192.168.122.116:8080` |
| 运行位置 | 服务器集中部署 |
| 用户无需 | 安装Python、下载文档、构建向量库 |

### 服务端部署（管理员）

**启动 RAG 服务**：
```bash
# 方式1：使用启动脚本
node scripts/start-rag-server.js

# 方式2：直接使用Python
cd rag-service
python run_http_server.py --host 0.0.0.0 --port 8080
```

**初始化知识库**（首次部署）：
```bash
cd rag-service
python update_knowledge_base.py
```

**服务端点**：
| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/tools` | GET | 工具列表 |
| `/sources` | GET | 文档来源 |
| `/search` | POST | 检索文档 |
| `/mcp` | POST | MCP协议端点 |

### 功能特性

- **双文档源**: tianocore-wiki + tianocore-docs
- **集中式部署**: 用户无需本地配置
- **内存缓存**: 高频查询直接返回缓存结果
- **增量更新**: 服务端手动刷新最新文档

### MCP工具列表

| 工具 | 描述 | 参数 |
|------|------|------|
| `search_edk2_docs` | 检索EDK2文档 | `query` (必需), `top_k` (可选) |
| `list_edk2_sources` | 列出文档来源 | 无 |

### 检索示例

```bash
# 在OpenCode会话中
opencode> 查询OVMF编译方法
opencode> 查询UEFI驱动开发指南
opencode> 如何配置EmulatorPkg控制台分辨率
```

### 检索结果格式

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