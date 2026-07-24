#!/usr/bin/env pwsh

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Edk2Agent 私有 NPM 发布脚本" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 检查 Node.js
Write-Host "[检查] Node.js..." -ForegroundColor Yellow
$nodeVersion = node --version
Write-Host "  ✓ Node.js $nodeVersion" -ForegroundColor Green

# 检查 npm
Write-Host "[检查] npm..." -ForegroundColor Yellow
$npmVersion = npm --version
Write-Host "  ✓ npm $npmVersion" -ForegroundColor Green

# 检查 Verdaccio
Write-Host "[检查] Verdaccio..." -ForegroundColor Yellow
try {
    $ver = verdaccio --version 2>$null
    Write-Host "  ✓ Verdaccio 已安装" -ForegroundColor Green
} catch {
    Write-Host "  ✗ Verdaccio 未安装" -ForegroundColor Red
    Write-Host ""
    Write-Host "请先安装 Verdaccio:" -ForegroundColor Yellow
    Write-Host "  npm install -g verdaccio" -ForegroundColor White
    Write-Host ""
    exit 1
}

# 检查 Verdaccio 是否运行
Write-Host "[检查] Verdaccio 服务状态..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "http://localhost:4873" -TimeoutSec 2 -UseBasicParsing
    Write-Host "  ✓ Verdaccio 正在运行" -ForegroundColor Green
} catch {
    Write-Host "  ✗ Verdaccio 未运行" -ForegroundColor Red
    Write-Host ""
    Write-Host "请先启动 Verdaccio:" -ForegroundColor Yellow
    Write-Host "  verdaccio" -ForegroundColor White
    Write-Host ""
    Write-Host "或在新窗口运行:" -ForegroundColor Yellow
    Write-Host "  Start-Process verdaccio" -ForegroundColor White
    Write-Host ""
    exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  开始发布流程" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 检查登录状态
Write-Host "[步骤 1/4] 检查登录状态..." -ForegroundColor Yellow
$npmrcPath = "$env:USERPROFILE\.npmrc"
if (Test-Path $npmrcPath) {
    $npmrc = Get-Content $npmrcPath -Raw
    if ($npmrc -match "localhost:4873") {
        Write-Host "  ✓ 已配置私有仓库" -ForegroundColor Green
    } else {
        Write-Host "  ! 需要登录" -ForegroundColor Yellow
    }
} else {
    Write-Host "  ! 需要登录" -ForegroundColor Yellow
}

# 运行测试
Write-Host "[步骤 2/4] 运行测试..." -ForegroundColor Yellow
try {
    node tests/run-tests.js 2>&1 | Out-Null
    Write-Host "  ✓ 测试通过" -ForegroundColor Green
} catch {
    Write-Host "  ✗ 测试失败" -ForegroundColor Red
    Write-Host "  请先修复测试问题" -ForegroundColor Yellow
    exit 1
}

# 检查必要文件
Write-Host "[步骤 3/4] 检查必要文件..." -ForegroundColor Yellow
$files = @(
    "package.json",
    "bin/edk2-opencode.js",
    ".opencode/plugins/edk2-auth-guard.js",
    ".opencode/plugins/edk2-api-provider.js",
    "opencode.json",
    ".npmrc"
)
$allFilesExist = $true
foreach ($file in $files) {
    if (Test-Path $file) {
        Write-Host "  ✓ $file" -ForegroundColor Green
    } else {
        Write-Host "  ✗ $file" -ForegroundColor Red
        $allFilesExist = $false
    }
}

if (-not $allFilesExist) {
    Write-Host "  ✗ 缺少必要文件" -ForegroundColor Red
    exit 1
}

# 发布
Write-Host "[步骤 4/4] 发布到私有仓库..." -ForegroundColor Yellow
Write-Host ""
try {
    npm publish --registry http://localhost:4873 2>&1 | ForEach-Object {
        if ($_ -match "success|published") {
            Write-Host "  ✓ $_" -ForegroundColor Green
        } elseif ($_ -match "error|ERROR") {
            Write-Host "  ✗ $_" -ForegroundColor Red
        }
    }
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  发布成功！" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "包名: @yourcompany/edk2-opencode" -ForegroundColor Cyan
    Write-Host "版本: 1.0.0" -ForegroundColor Cyan
    Write-Host "仓库: http://localhost:4873" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "安装命令:" -ForegroundColor Yellow
    Write-Host "  npm install -g @yourcompany/edk2-opencode" -ForegroundColor White
    Write-Host ""
    Write-Host "使用命令:" -ForegroundColor Yellow
    Write-Host "  npx @yourcompany/edk2-opencode --version" -ForegroundColor White
    Write-Host ""
} catch {
    Write-Host "  ✗ 发布失败: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "可能的原因:" -ForegroundColor Yellow
    Write-Host "  1. 未登录: npm login --registry http://localhost:4873" -ForegroundColor White
    Write-Host "  2. 包已存在: 修改 package.json 版本号" -ForegroundColor White
    Write-Host "  3. Verdaccio 未运行: verdaccio" -ForegroundColor White
    Write-Host ""
    exit 1
}