# Edk2Agent 本地测试流程

> 完整的本地验证流程，确保所有功能正常工作

## 前置条件检查

```bash
# 检查 Node.js 版本
node --version  # 需要 >= 18.0.0

# 检查 Python 版本
python --version  # 需要 >= 3.8

# 检查 Git
git --version
```

---

## 测试 1: 基础功能验证

### 1.1 运行单元测试

```bash
cd D:\project-review-test\Edk2Agent

# 运行所有测试
node tests/run-tests.js
```

**预期输出:**

```
==================================================
EDK2 Custom OpenCode Tool - Test Suite
==================================================

Running: tests/test-auth-guard.js
==================================================

=== EDK2 Auth Guard Tests ===

✓ testInitialState passed
✓ testLoginLogout passed
✓ testSessionExpiry passed
✓ testCacheClearOnLogout passed
✓ testPluginHook passed

=== All tests passed ===

Running: tests/test-api-provider.js
==================================================

=== EDK2 API Provider Tests ===

✓ testInitialSetup passed
✓ testSetUserConfig passed
✓ testApiPriority passed
✓ testDefaultModel passed
✓ testConversationCache passed
✓ testLogApiStatus passed
✓ testConfigHook passed

=== All tests passed ===

==================================================
Test Summary
==================================================
Passed: 2/2
Failed: 0/2
```

---

## 测试 2: CLI 命令测试

### 2.1 测试帮助命令

```bash
# 显示版本
node bin/edk2-opencode.js --version
# 预期输出: edk2-opencode v1.0.0

# 显示帮助
node bin/edk2-opencode.js --help
```

**预期输出:**

```
╔════════════════════════════════════════════════════════════╗
║         EDK2-OpenCode - EDK2 Development Assistant          ║
╠════════════════════════════════════════════════════════════╣
║  Version: 1.0.0                                              ║
║  Skills:  edk2-pr-workflow, ovmf-build                        ║
║  MCP:     edk2-rag (RAG knowledge base)                       ║
║  API:     Built-in GLM-5 fallback                             ║
╚════════════════════════════════════════════════════════════╝

Quick Start:
  1. Login:     edk2-opencode login <username> <token>
  2. Start:     edk2-opencode
  3. Initialize: edk2-opencode --init
```

### 2.2 测试登录系统

```bash
# 登录
node bin/edk2-opencode.js login testuser testtoken123
# 预期输出: [SUCCESS] Logged in as testuser
#           [INFO] Session valid for 24 hours

# 查看状态
node bin/edk2-opencode.js status
# 预期输出: [STATUS] Logged in as testuser
#           [INFO] Session expires in XX hours

# 登出
node bin/edk2-opencode.js logout
# 预期输出: [SUCCESS] Logged out
#           [SUCCESS] Cache cleared

# 确认登出
node bin/edk2-opencode.js status
# 预期输出: [STATUS] Not logged in
```

### 2.3 检查登录状态文件

```bash
# Windows
type %USERPROFILE%\.config\opencode\.edk2_login

# Linux/macOS
cat ~/.config/opencode/.edk2_login
```

**预期内容（登录后）:**

```json
{
  "isLoggedIn": true,
  "username": "testuser",
  "token": "1234567890abcdef",
  "loginTime": 1721836800000,
  "expiresAt": 1721923200000
}
```

---

## 测试 3: RAG 服务测试

### 3.1 安装 Python 依赖

```bash
cd rag-service

# 创建虚拟环境（推荐）
python -m venv venv

# 激活虚拟环境
# Windows
.\venv\Scripts\activate
# Linux/macOS
source venv/bin/activate

# 安装依赖
pip install -r requirements.txt
```

### 3.2 测试 RAG 配置

```bash
# 检查配置文件
cat config.json
```

**预期内容:**

```json
{
  "persist_directory": "./chroma_db",
  "data_directory": "./data",
  "embedding_model": "all-MiniLM-L6-v2",
  "chunk_size": 1024,
  "chunk_overlap": 200,
  "top_k_results": 5,
  "cache_enabled": true,
  "cache_ttl_seconds": 3600
}
```

### 3.3 测试文档抓取（可选，需要网络）

```bash
# 抓取文档（首次测试）
python run_server.py --fetch-docs

# 预期输出:
# [INFO] Fetching EDK2 documents...
# [INFO] Cloning TianoCore Wiki...
# [INFO] Cloning TianoCore Docs...
# [INFO] Total documents: XXX
```

### 3.4 测试向量索引构建

```bash
# 构建索引
python run_server.py --build-index

# 预期输出:
# [INFO] Building vector index...
# [INFO] Adding XXX documents to vector store...
# [INFO] Added XXX nodes to index
# [INFO] Vector index built successfully
```

### 3.5 测试缓存模块

```bash
cd rag-service

python -c "
from rag_service.cache import get_cache

cache = get_cache()

# 测试缓存设置
cache.set('test query', 5, ['result1', 'result2'])
print('Cache set: OK')

# 测试缓存获取
result = cache.get('test query', 5)
print(f'Cache get: {result}')

# 测试缓存统计
stats = cache.get_stats()
print(f'Cache stats: {stats}')

# 清除缓存
cache.clear()
print('Cache cleared: OK')
"
```

**预期输出:**

```
Cache set: OK
Cache get: ['result1', 'result2']
Cache stats: {'hits': 0, 'misses': 1, 'evictions': 0, 'size': 1, 'max_size': 100, 'hit_rate': '0.0%'}
Cache cleared: OK
```

### 3.6 运行 RAG 单元测试

```bash
cd rag-service

# 运行所有测试
pytest tests/ -v

# 预期输出:
# ======== test session starts ========
# tests/test_rag_service.py::TestConfig::test_default_config PASSED
# tests/test_rag_service.py::TestConfig::test_config_from_dict PASSED
# tests/test_rag_service.py::TestCache::test_cache_set_get PASSED
# tests/test_rag_service.py::TestCache::test_cache_miss PASSED
# tests/test_rag_service.py::TestCache::test_cache_stats PASSED
# ======== 5 passed ========
```

### 3.7 测试 MCP 服务器（基础）

```bash
# 查看 RAG 统计（不启动服务器）
python run_server.py --stats

# 预期输出:
# === RAG Service Statistics ===
#   document_count: XXX
#   index_built: True/False
#   cache: {...}
```

---

## 测试 4: 权限拦截测试

### 4.1 准备测试脚本

创建 `test-auth-interception.js`:

```javascript
const Edk2AuthGuard = require('./.opencode/plugins/edk2-auth-guard.js');

async function testInterception() {
  console.log('=== Testing Auth Interception ===\n');
  
  const guard = new Edk2AuthGuard(process.cwd());
  await guard.init();
  
  // 测试 1: 未登录时应拦截 Skill
  console.log('Test 1: Should block skill when not logged in');
  const shouldBlock1 = guard.shouldBlockAccess('skill');
  console.log(`  Result: ${shouldBlock1 ? 'BLOCKED ✓' : 'NOT BLOCKED ✗'}`);
  
  // 测试 2: 未登录时应拦截 Task
  console.log('Test 2: Should block task when not logged in');
  const shouldBlock2 = guard.shouldBlockAccess('task');
  console.log(`  Result: ${shouldBlock2 ? 'BLOCKED ✓' : 'NOT BLOCKED ✗'}`);
  
  // 测试 3: 未登录时应拦截 MCP
  console.log('Test 3: Should block mcp when not logged in');
  const shouldBlock3 = guard.shouldBlockAccess('mcp');
  console.log(`  Result: ${shouldBlock3 ? 'BLOCKED ✓' : 'NOT BLOCKED ✗'}`);
  
  // 测试 4: 登录后不应拦截
  console.log('Test 4: Should NOT block after login');
  await guard.login('testuser', 'testtoken');
  const shouldBlock4 = guard.shouldBlockAccess('skill');
  console.log(`  Result: ${shouldBlock4 ? 'BLOCKED ✗' : 'ALLOWED ✓'}`);
  
  // 测试 5: 登出后应再次拦截
  console.log('Test 5: Should block after logout');
  await guard.logout();
  const shouldBlock5 = guard.shouldBlockAccess('skill');
  console.log(`  Result: ${shouldBlock5 ? 'BLOCKED ✓' : 'NOT BLOCKED ✗'}`);
  
  console.log('\n=== All tests completed ===');
}

testInterception();
```

### 4.2 运行拦截测试

```bash
node test-auth-interception.js
```

**预期输出:**

```
=== Testing Auth Interception ===

Test 1: Should block skill when not logged in
  Result: BLOCKED ✓
Test 2: Should block task when not logged in
  Result: BLOCKED ✓
Test 3: Should block mcp when not logged in
  Result: BLOCKED ✓
Test 4: Should NOT block after login
  Result: ALLOWED ✓
Test 5: Should block after logout
  Result: BLOCKED ✓

=== All tests completed ===
```

---

## 测试 5: API 优先级测试

### 5.1 准备测试脚本

创建 `test-api-priority.js`:

```javascript
const Edk2ApiProvider = require('./.opencode/plugins/edk2-api-provider.js');

function testApiPriority() {
  console.log('=== Testing API Priority ===\n');
  
  const provider = new Edk2ApiProvider();
  
  // 测试 1: 用户 API 优先
  console.log('Test 1: User API has highest priority');
  provider.setUserConfig('anthropic', 'user-key-123', null, 'claude-sonnet-4-6');
  const config1 = provider.getActiveConfig('anthropic');
  console.log(`  Result: ${config1.apiKey === 'user-key-123' ? 'USER API ✓' : 'WRONG API ✗'}`);
  
  // 测试 2: 无用户配置时使用内置
  console.log('Test 2: Use built-in when no user config');
  const config2 = provider.getActiveConfig('openai');
  console.log(`  Result: ${config2.provider ? 'BUILT-IN ✓' : 'NO CONFIG ✗'}`);
  
  // 测试 3: 缓存功能
  console.log('Test 3: Conversation cache');
  provider.cacheResponse('test prompt', 'test response');
  const cached = provider.getCachedResponse('test prompt');
  console.log(`  Result: ${cached === 'test response' ? 'CACHED ✓' : 'NOT CACHED ✗'}`);
  
  // 测试 4: 统计信息
  console.log('Test 4: Stats tracking');
  provider.incrementRequestCount();
  provider.incrementCacheHitCount();
  const stats = provider.getStats();
  console.log(`  Result: total=${stats.totalRequests}, hits=${stats.cacheHits}`);
  
  console.log('\n=== All tests completed ===');
}

testApiPriority();
```

### 5.2 运行优先级测试

```bash
node test-api-priority.js
```

**预期输出:**

```
=== Testing API Priority ===

Test 1: User API has highest priority
  Result: USER API ✓
Test 2: Use built-in when no user config
  Result: BUILT-IN ✓
Test 3: Conversation cache
  Result: CACHED ✓
Test 4: Stats tracking
  Result: total=1, hits=1

=== All tests completed ===
```

---

## 测试 6: 完整集成测试

### 6.1 创建集成测试脚本

创建 `test-integration.sh` (Linux/macOS) 或 `test-integration.ps1` (Windows):

**Windows PowerShell 版本:**

```powershell
# test-integration.ps1

Write-Host "=== Edk2Agent Integration Test ===" -ForegroundColor Cyan
Write-Host ""

# 步骤 1: 清理环境
Write-Host "[Step 1/6] Cleaning environment..." -ForegroundColor Yellow
Remove-Item -Path "$env:USERPROFILE\.config\opencode\.edk2_login" -ErrorAction SilentlyContinue
Write-Host "  Done" -ForegroundColor Green

# 步骤 2: 运行单元测试
Write-Host "[Step 2/6] Running unit tests..." -ForegroundColor Yellow
node tests/run-tests.js
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Failed" -ForegroundColor Red
    exit 1
}
Write-Host "  Passed" -ForegroundColor Green

# 步骤 3: 测试 CLI
Write-Host "[Step 3/6] Testing CLI commands..." -ForegroundColor Yellow
node bin/edk2-opencode.js --version
node bin/edk2-opencode.js login testuser testtoken
node bin/edk2-opencode.js status
Write-Host "  Done" -ForegroundColor Green

# 步骤 4: 测试 RAG 缓存
Write-Host "[Step 4/6] Testing RAG cache..." -ForegroundColor Yellow
Set-Location rag-service
python -c "from rag_service.cache import get_cache; c=get_cache(); c.set('t','q',[]); print('OK' if c.get('t','q')==[] else 'FAIL')"
Set-Location ..
Write-Host "  Done" -ForegroundColor Green

# 步骤 5: 测试登出
Write-Host "[Step 5/6] Testing logout..." -ForegroundColor Yellow
node bin/edk2-opencode.js logout
node bin/edk2-opencode.js status
Write-Host "  Done" -ForegroundColor Green

# 步骤 6: 验证文件结构
Write-Host "[Step 6/6] Verifying file structure..." -ForegroundColor Yellow
$files = @(
    "package.json",
    "bin/edk2-opencode.js",
    ".opencode/plugins/edk2-auth-guard.js",
    ".opencode/plugins/edk2-api-provider.js",
    "rag-service/run_server.py",
    "rag-service/rag_service/cache.py"
)
foreach ($file in $files) {
    if (Test-Path $file) {
        Write-Host "  ✓ $file" -ForegroundColor Green
    } else {
        Write-Host "  ✗ $file" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "=== Integration Test Complete ===" -ForegroundColor Cyan
```

### 6.2 运行集成测试

```powershell
# Windows
.\test-integration.ps1

# Linux/macOS
chmod +x test-integration.sh
./test-integration.sh
```

**预期输出:**

```
=== Edk2Agent Integration Test ===

[Step 1/6] Cleaning environment...
  Done
[Step 2/6] Running unit tests...
  Passed
[Step 3/6] Testing CLI commands...
  Done
[Step 4/6] Testing RAG cache...
  Done
[Step 5/6] Testing logout...
  Done
[Step 6/6] Verifying file structure...
  ✓ package.json
  ✓ bin/edk2-opencode.js
  ✓ .opencode/plugins/edk2-auth-guard.js
  ✓ .opencode/plugins/edk2-api-provider.js
  ✓ rag-service/run_server.py
  ✓ rag-service/rag_service/cache.py

=== Integration Test Complete ===
```

---

## 测试 7: 端到端测试（可选）

### 7.1 启动 OpenCode（需要 API Key）

```bash
# 设置 API Key（如果需要）
export ANTHROPIC_API_KEY="your-api-key"
# 或
$env:ANTHROPIC_API_KEY="your-api-key"

# 启动
node bin/edk2-opencode.js
```

### 7.2 在 OpenCode 中测试

```
# 测试登录
/login testuser testtoken

# 查看状态
/status

# 测试 Skill（需要登录）
Build OVMF for QEMU

# 测试 RAG 查询
What is EDK2?

# 登出
/logout
```

---

## 快速验证清单

运行以下命令快速验证所有功能：

```bash
# 1. 单元测试
node tests/run-tests.js

# 2. CLI 测试
node bin/edk2-opencode.js login test test
node bin/edk2-opencode.js status
node bin/edk2-opencode.js logout

# 3. RAG 缓存测试
cd rag-service
python -c "from rag_service.cache import get_cache; print('OK')"
cd ..

# 4. 文件检查
ls package.json bin/edk2-opencode.js rag-service/rag_service/cache.py
```

**全部通过则显示:**

```
✓ Unit tests passed
✓ CLI login/logout works
✓ RAG cache module loads
✓ All required files exist
```

---

## 常见问题排查

### Q1: 单元测试失败

```bash
# 重新安装依赖
cd tests
npm install
cd ..

# 单独运行测试调试
node tests/test-auth-guard.js
node tests/test-api-provider.js
```

### Q2: Python 模块导入失败

```bash
# 确保在正确目录
cd rag-service

# 测试导入
python -c "from rag_service import Config; print('OK')"

# 如果失败，安装依赖
pip install -r requirements.txt
```

### Q3: 登录状态异常

```bash
# 清除登录文件
rm ~/.config/opencode/.edk2_login  # Linux/macOS
del %USERPROFILE%\.config\opencode\.edk2_login  # Windows

# 重新登录
node bin/edk2-opencode.js login testuser testtoken
```

---

**测试完成后，所有功能应正常工作！**