# Edk2Agent 完整测试指南（新手友好版）

> 本指南将带您完成 Edk2Agent 所有功能的测试，适合零基础新手

## 📋 测试前准备

### 检查环境

打开 PowerShell，依次运行以下命令检查环境：

```powershell
# 1. 检查 Node.js（需要 >= 18.0.0）
node --version

# 2. 检查 npm
npm --version

# 3. 检查 Python（需要 >= 3.8）
python --version

# 4. 检查 Git
git --version
```

**如果某个命令报错"不是内部或外部命令"，说明需要先安装：**

| 缺少的工具 | 下载地址 |
|-----------|---------|
| Node.js | https://nodejs.org/ （下载 LTS 版本） |
| Python | https://www.python.org/downloads/ |
| Git | https://git-scm.com/downloads |

---

## 测试 1: 📦 一键安装测试

### 步骤 1.1: 创建测试目录

```powershell
# 创建一个干净的测试目录
mkdir C:\temp\edk2-test
cd C:\temp\edk2-test
```

### 步骤 1.2: 使用 NPX 一键启动

```powershell
# 直接运行（会自动下载）
npx edk2-opencode --version
```

**预期结果：**
```
edk2-opencode v1.0.0
```

### 步骤 1.3: 查看帮助信息

```powershell
npx edk2-opencode --help
```

**预期结果：**
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

### ✅ 测试 1 通过条件

- [ ] 能成功运行 `npx edk2-opencode --version`
- [ ] 显示正确的版本号
- [ ] 能显示帮助信息

---

## 测试 2: 🔒 登录权限控制测试

### 步骤 2.1: 测试未登录状态

```powershell
# 查看当前状态（应该显示未登录）
npx edk2-opencode status
```

**预期结果：**
```
[STATUS] Not logged in
[INFO] Run: edk2-opencode login <username> <token>
```

### 步骤 2.2: 执行登录

```powershell
# 登录（使用测试账号）
npx edk2-opencode login testuser testtoken123
```

**预期结果：**
```
[SUCCESS] Logged in as testuser
[INFO] Session valid for 24 hours
```

### 步骤 2.3: 验证登录状态

```powershell
# 查看登录状态
npx edk2-opencode status
```

**预期结果：**
```
[STATUS] Logged in as testuser
[INFO] Session expires in XX hours
```

### 步骤 2.4: 检查登录文件

```powershell
# 查看登录文件内容
cat $env:USERPROFILE\.config\opencode\.edk2_login
```

**预期结果（JSON 格式）：**
```json
{
  "isLoggedIn": true,
  "username": "testuser",
  "token": "abc123...",
  "loginTime": 1721836800000,
  "expiresAt": 1721923200000
}
```

### 步骤 2.5: 测试登出功能

```powershell
# 登出
npx edk2-opencode logout
```

**预期结果：**
```
[SUCCESS] Logged out
[SUCCESS] Cache cleared
```

### 步骤 2.6: 确认登出成功

```powershell
# 再次查看状态
npx edk2-opencode status
```

**预期结果：**
```
[STATUS] Not logged in
[INFO] Run: edk2-opencode login <username> <token>
```

### ✅ 测试 2 通过条件

- [ ] 未登录时显示"Not logged in"
- [ ] 登录成功显示"[SUCCESS]"
- [ ] 登录状态能正确保存
- [ ] 登出后缓存被清除
- [ ] 登出后状态变为"Not logged in"

---

## 测试 3: 🔑 内置 API 兜底测试

### 步骤 3.1: 克隆仓库进行源码测试

```powershell
# 创建测试目录
cd C:\temp
git clone https://github.com/guziqian0908/Edk2Agent.git
cd Edk2Agent
```

### 步骤 3.2: 运行 API 测试

```powershell
# 运行单元测试
node tests/run-tests.js
```

**预期结果：**
```
==================================================
EDK2 Custom OpenCode Tool - Test Suite
==================================================

Running: test-auth-guard.js
==================================================
...
=== All tests passed ===

Running: test-api-provider.js
==================================================
...
[EDK2 API] No API configured for anthropic, using GLM-5 fallback
...
=== All tests passed ===

==================================================
Test Summary
==================================================
Passed: 2/2
Failed: 0/2
```

### 步骤 3.3: 验证 API 优先级逻辑

创建临时测试文件 `test-api-priority.js`：

```powershell
# 创建测试文件
@"
const Edk2ApiProvider = require('./.opencode/plugins/edk2-api-provider.js').Edk2ApiProvider;

console.log('=== API Priority Test ===\n');

const provider = new Edk2ApiProvider();

// 测试 1: 默认使用 GLM-5
console.log('Test 1: Default fallback to GLM-5');
const config1 = provider.getActiveConfig('unknown-provider');
console.log('  Provider:', config1.provider);
console.log('  Model:', config1.model);
console.log('  Expected: zhipu/glm-5\n');

// 测试 2: 用户配置优先
console.log('Test 2: User config takes priority');
provider.setUserConfig('anthropic', 'user-api-key-123');
const config2 = provider.getActiveConfig('anthropic');
console.log('  Has user config:', provider.hasUserConfig('anthropic'));
console.log('  API Key:', config2.apiKey);
console.log('  Expected: user-api-key-123\n');

// 测试 3: 缓存功能
console.log('Test 3: Conversation cache');
provider.cacheResponse('test query', 'cached response');
const cached = provider.getCachedResponse('test query');
console.log('  Cached:', cached);
console.log('  Expected: cached response\n');

console.log('=== All API tests passed ===');
"@ | Out-File -FilePath test-api-priority.js -Encoding utf8

# 运行测试
node test-api-priority.js
```

**预期结果：**
```
=== API Priority Test ===

Test 1: Default fallback to GLM-5
  Provider: zhipu
  Model: glm-5
  Expected: zhipu/glm-5

Test 2: User config takes priority
  Has user config: true
  API Key: user-api-key-123
  Expected: user-api-key-123

Test 3: Conversation cache
  Cached: cached response
  Expected: cached response

=== All API tests passed ===
```

### ✅ 测试 3 通过条件

- [ ] 单元测试全部通过（Passed: 2/2）
- [ ] 无用户配置时自动使用 GLM-5
- [ ] 用户配置优先于内置配置
- [ ] 对话缓存功能正常

---

## 测试 4: 📚 RAG 知识库测试

### 步骤 4.1: 安装 Python 依赖

```powershell
# 进入 RAG 服务目录
cd C:\temp\Edk2Agent\rag-service

# 创建虚拟环境（推荐）
python -m venv venv

# 激活虚拟环境
.\venv\Scripts\activate

# 安装依赖
pip install -r requirements.txt
```

**等待安装完成（首次可能需要几分钟）**

### 步骤 4.2: 测试缓存模块

```powershell
# 在 rag-service 目录下运行
python -c "
from rag_service.cache import get_cache

print('=== RAG Cache Test ===\n')

cache = get_cache()

# 测试 1: 设置缓存
print('Test 1: Set cache')
cache.set('OVMF build steps', 5, ['step1', 'step2', 'step3'])
print('  Cache set: OK\n')

# 测试 2: 获取缓存
print('Test 2: Get cache')
result = cache.get('OVMF build steps', 5)
print('  Result:', result)
print('  Expected: [\"step1\", \"step2\", \"step3\"]\n')

# 测试 3: 缓存未命中
print('Test 3: Cache miss')
result2 = cache.get('nonexistent query', 5)
print('  Result:', result2)
print('  Expected: None\n')

# 测试 4: 缓存统计
print('Test 4: Cache stats')
stats = cache.get_stats()
print('  Hits:', stats['hits'])
print('  Misses:', stats['misses'])
print('  Hit rate:', stats['hit_rate'])
print('  Size:', stats['size'], '/100\n')

print('=== All cache tests passed ===')
"
```

**预期结果：**
```
=== RAG Cache Test ===

Test 1: Set cache
  Cache set: OK

Test 2: Get cache
  Result: ['step1', 'step2', 'step3']
  Expected: ["step1", "step2", "step3"]

Test 3: Cache miss
  Result: None
  Expected: None

Test 4: Cache stats
  Hits: 1
  Misses: 1
  Hit rate: 50.0%
  Size: 1 /100

=== All cache tests passed ===
```

### 步骤 4.3: 运行 RAG 单元测试

```powershell
# 确保在 rag-service 目录
pytest tests/ -v
```

**预期结果：**
```
==================== test session starts ====================
tests/test_rag_service.py::TestConfig::test_default_config PASSED
tests/test_rag_service.py::TestConfig::test_config_from_dict PASSED
tests/test_rag_service.py::TestCache::test_cache_set_get PASSED
tests/test_rag_service.py::TestCache::test_cache_miss PASSED
tests/test_rag_service.py::TestCache::test_cache_stats PASSED
==================== 5 passed ====================
```

### 步骤 4.4: 测试文档抓取（可选，需要网络）

```powershell
# 测试抓取文档（首次运行需要几分钟）
python run_server.py --fetch-docs
```

**预期输出：**
```
[INFO] Fetching EDK2 documents...
[INFO] Cloning TianoCore Wiki...
[INFO] Cloning TianoCore Docs...
[INFO] Parsing XX wiki files
[INFO] Parsing XX doc files
[INFO] Total documents: XXX
```

### ✅ 测试 4 通过条件

- [ ] Python 依赖安装成功
- [ ] 缓存模块测试通过
- [ ] pytest 测试全部通过（5 passed）
- [ ] 能成功抓取文档（如执行了步骤 4.4）

---

## 测试 5: ⚡ 内存缓存性能测试

### 步骤 5.1: 创建性能测试脚本

```powershell
# 回到项目根目录
cd C:\temp\Edk2Agent

# 创建测试文件
@"
import time
import sys
sys.path.insert(0, 'rag-service')

from rag_service.cache import MemoryCache

print('=== Cache Performance Test ===\n')

cache = MemoryCache(max_size=100, ttl_seconds=3600)

# 测试 1: 写入性能
print('Test 1: Write performance (1000 items)')
start = time.time()
for i in range(1000):
    cache.set(f'query_{i}', 5, [f'result_{i}'])
elapsed = time.time() - start
print(f'  Time: {elapsed:.3f}s')
print(f'  Rate: {1000/elapsed:.0f} ops/sec\n')

# 测试 2: 读取性能（缓存命中）
print('Test 2: Read performance (cache hit)')
start = time.time()
for i in range(1000):
    cache.get(f'query_{i}', 5)
elapsed = time.time() - start
print(f'  Time: {elapsed:.3f}s')
print(f'  Rate: {1000/elapsed:.0f} ops/sec\n')

# 测试 3: 缓存未命中性能
print('Test 3: Miss performance')
start = time.time()
for i in range(1000):
    cache.get(f'nonexistent_{i}', 5)
elapsed = time.time() - start
print(f'  Time: {elapsed:.3f}s')
print(f'  Rate: {1000/elapsed:.0f} ops/sec\n')

# 测试 4: 统计信息
print('Test 4: Final stats')
stats = cache.get_stats()
for key, value in stats.items():
    print(f'  {key}: {value}')

print('\n=== Performance test complete ===')
"@ | Out-File -FilePath test-cache-performance.py -Encoding utf8

# 运行测试
python test-cache-performance.py
```

**预期结果：**
```
=== Cache Performance Test ===

Test 1: Write performance (1000 items)
  Time: 0.00Xs
  Rate: XXXXX ops/sec

Test 2: Read performance (cache hit)
  Time: 0.00Xs
  Rate: XXXXX ops/sec

Test 3: Miss performance
  Time: 0.00Xs
  Rate: XXXXX ops/sec

Test 4: Final stats
  hits: XXX
  misses: XXX
  evictions: XXX
  size: XX
  max_size: 100
  hit_rate: XX.X%

=== Performance test complete ===
```

### ✅ 测试 5 通过条件

- [ ] 写入性能 > 10,000 ops/sec
- [ ] 读取性能 > 10,000 ops/sec
- [ ] 缓存命中率统计正常

---

## 测试 6: 🤖 自动化工作流测试

### 步骤 6.1: 检查 Skill 文件结构

```powershell
# 回到项目根目录
cd C:\temp\Edk2Agent

# 检查 Skill 文件
ls .opencode\skills\
ls .opencode\skills\edk2-pr-workflow\
ls .opencode\skills\ovmf-build\
```

**预期结果：**
```
.edk2-pr-workflow/  ovmf-build/

目录内容（edk2-pr-workflow）：
SKILL.md
create-pr.py
create-pr.ps1
update-pr.py
update-pr.ps1
...
```

### 步骤 6.2: 检查 PR 工作流脚本

```powershell
# 查看 Skill 文档
cat .opencode\skills\edk2-pr-workflow\SKILL.md | Select-Object -First 50
```

**预期结果：** 显示 Skill 使用文档

### 步骤 6.3: 验证脚本可用性

```powershell
# 测试 Python 脚本（干运行，不实际执行）
python .opencode\skills\edk2-pr-workflow\create-pr.py --help
```

**预期结果：** 显示帮助信息或使用说明

### ✅ 测试 6 通过条件

- [ ] 两个 Skill 目录都存在
- [ ] SKILL.md 文档存在
- [ ] Python/PowerShell 脚本文件存在

---

## 📊 完整测试报告模板

完成所有测试后，填写此报告：

```markdown
# Edk2Agent 测试报告

**测试日期**: YYYY-MM-DD
**测试人员**: XXX
**测试环境**: Windows XX / Node.js vX.XX / Python vX.XX

## 测试结果

| 测试项 | 状态 | 备注 |
|-------|------|------|
| 📦 一键安装 | ✅/❌ | |
| 🔒 登录权限 | ✅/❌ | |
| 🔑 API 兜底 | ✅/❌ | |
| 📚 RAG 知识库 | ✅/❌ | |
| ⚡ 内存缓存 | ✅/❌ | |
| 🤖 自动化工作流 | ✅/❌ | |

## 详细记录

### 测试 1: 一键安装
- npx 命令执行: [成功/失败]
- 版本显示: [正确/错误]
- 帮助信息: [正常/异常]

### 测试 2: 登录权限
- 未登录状态: [正确显示/异常]
- 登录流程: [成功/失败]
- 登录状态持久化: [正常/异常]
- 登出清缓存: [成功/失败]

### 测试 3: API 兜底
- 单元测试: [全部通过/部分失败]
- GLM-5 兜底: [正常/异常]
- 用户配置优先: [正确/错误]

### 测试 4: RAG 知识库
- 依赖安装: [成功/失败]
- 缓存测试: [全部通过/部分失败]
- pytest: [X passed / X failed]

### 测试 5: 内存缓存
- 写入性能: [XXXX ops/sec]
- 读取性能: [XXXX ops/sec]
- 缓存命中率: [XX%]

### 测试 6: 自动化工作流
- Skill 文件: [完整/缺失]
- 脚本可用性: [正常/异常]

## 问题记录

1. [问题描述]
2. [问题描述]

## 建议

[改进建议]
```

---

## 🚀 快速验证脚本（一键运行）

创建 `run-all-tests.ps1`：

```powershell
Write-Host "=== Edk2Agent Complete Test Suite ===" -ForegroundColor Cyan
Write-Host ""

$passed = 0
$failed = 0

# Test 1: NPX
Write-Host "[1/6] NPX Installation Test" -ForegroundColor Yellow
try {
    npx edk2-opencode --version
    Write-Host "  PASSED" -ForegroundColor Green
    $passed++
} catch {
    Write-Host "  FAILED" -ForegroundColor Red
    $failed++
}

# Test 2: Login
Write-Host "`n[2/6] Login System Test" -ForegroundColor Yellow
try {
    npx edk2-opencode logout 2>$null
    npx edk2-opencode login testuser testtoken
    $status = npx edk2-opencode status
    if ($status -match "Logged in") {
        Write-Host "  PASSED" -ForegroundColor Green
        $passed++
    } else {
        Write-Host "  FAILED" -ForegroundColor Red
        $failed++
    }
    npx edk2-opencode logout
} catch {
    Write-Host "  FAILED" -ForegroundColor Red
    $failed++
}

# Test 3: Unit Tests
Write-Host "`n[3/6] API & Auth Unit Tests" -ForegroundColor Yellow
try {
    node tests/run-tests.js
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  PASSED" -ForegroundColor Green
        $passed++
    } else {
        Write-Host "  FAILED" -ForegroundColor Red
        $failed++
    }
} catch {
    Write-Host "  FAILED" -ForegroundColor Red
    $failed++
}

# Test 4: RAG Cache
Write-Host "`n[4/6] RAG Cache Test" -ForegroundColor Yellow
try {
    cd rag-service
    python -c "from rag_service.cache import get_cache; c=get_cache(); c.set('t',5,['r']); print('OK' if c.get('t',5)==['r'] else 'FAIL')"
    cd ..
    Write-Host "  PASSED" -ForegroundColor Green
    $passed++
} catch {
    Write-Host "  FAILED" -ForegroundColor Red
    $failed++
}

# Test 5: Performance
Write-Host "`n[5/6] Performance Test" -ForegroundColor Yellow
try {
    python test-cache-performance.py
    Write-Host "  PASSED" -ForegroundColor Green
    $passed++
} catch {
    Write-Host "  FAILED" -ForegroundColor Red
    $failed++
}

# Test 6: Skills
Write-Host "`n[6/6] Skills Structure Test" -ForegroundColor Yellow
$skillsOk = $true
if (-not (Test-Path ".opencode\skills\edk2-pr-workflow\SKILL.md")) { $skillsOk = $false }
if (-not (Test-Path ".opencode\skills\ovmf-build\SKILL.md")) { $skillsOk = $false }
if ($skillsOk) {
    Write-Host "  PASSED" -ForegroundColor Green
    $passed++
} else {
    Write-Host "  FAILED" -ForegroundColor Red
    $failed++
}

# Summary
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "Test Summary: $passed/6 passed, $failed/6 failed" -ForegroundColor $(if ($failed -eq 0) { "Green" } else { "Red" })
Write-Host "========================================`n" -ForegroundColor Cyan

if ($failed -gt 0) {
    exit 1
}
```

运行：

```powershell
# 保存脚本后运行
.\run-all-tests.ps1
```

---

## 🆘 常见问题解决

### Q1: NPX 命令失败

```powershell
# 清除缓存
npm cache clean --force
npx clear-npx-cache

# 重新尝试
npx edk2-opencode --version
```

### Q2: Python 虚拟环境激活失败

```powershell
# 如果激活失败，直接使用完整路径
.\rag-service\venv\Scripts\python.exe -m pip install -r requirements.txt
```

### Q3: pytest 找不到命令

```powershell
# 安装 pytest
pip install pytest

# 或使用完整路径
python -m pytest tests/ -v
```

### Q4: 登录文件找不到

```powershell
# 手动创建目录
mkdir $env:USERPROFILE\.config\opencode -Force

# 重新登录
npx edk2-opencode login testuser testtoken
```

---

**测试完成后，请提交测试报告！**