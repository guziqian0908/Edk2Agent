#!/usr/bin/env pwsh

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Edk2Agent 私有 NPM 一键部署" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 步骤 1: 安装 Verdaccio
Write-Host "[步骤 1/5] 安装 Verdaccio..." -ForegroundColor Yellow
try {
    $ver = verdaccio --version 2>$null
    Write-Host "  ✓ Verdaccio 已安装 ($ver)" -ForegroundColor Green
} catch {
    Write-Host "  正在安装..." -ForegroundColor Yellow
    npm install -g verdaccio
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ✓ 安装成功" -ForegroundColor Green
    } else {
        Write-Host "  ✗ 安装失败" -ForegroundColor Red
        exit 1
    }
}

# 步骤 2: 启动 Verdaccio
Write-Host "[步骤 2/5] 启动 Verdaccio 服务..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "http://localhost:4873" -TimeoutSec 2 -UseBasicParsing
    Write-Host "  ✓ Verdaccio 已在运行" -ForegroundColor Green
} catch {
    Write-Host "  正在启动..." -ForegroundColor Yellow
    Start-Process verdaccio -WindowStyle Hidden
    Start-Sleep -Seconds 5
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:4873" -TimeoutSec 2 -UseBasicParsing
        Write-Host "  ✓ 启动成功" -ForegroundColor Green
    } catch {
        Write-Host "  ✗ 启动失败" -ForegroundColor Red
        Write-Host "  请手动运行: verdaccio" -ForegroundColor Yellow
        exit 1
    }
}

# 步骤 3: 配置项目
Write-Host "[步骤 3/5] 配置项目..." -ForegroundColor Yellow

# 创建 .npmrc
"@yourcompany:registry=http://localhost:4873
registry=http://localhost:4873" | Out-File -FilePath .npmrc -Encoding utf8 -Force
Write-Host "  ✓ 创建 .npmrc" -ForegroundColor Green

# 更新 package.json
$pkg = Get-Content package.json | ConvertFrom-Json
$pkg.name = "@yourcompany/edk2-opencode"
$pkg | ConvertTo-Json -Depth 10 | Set-Content package.json
Write-Host "  ✓ 更新 package.json" -ForegroundColor Green

# 步骤 4: 添加用户
Write-Host "[步骤 4/5] 配置用户..." -ForegroundColor Yellow
Write-Host ""
Write-Host "  请输入用户信息（用于发布包）:" -ForegroundColor White
Write-Host ""

$npmrcPath = "$env:USERPROFILE\.npmrc"
if (-not (Test-Path $npmrcPath) -or -not ((Get-Content $npmrcPath -Raw) -match "localhost:4873")) {
    Write-Host "  提示: 用户名和密码可以随意设置，如 admin/admin123" -ForegroundColor Gray
    Write-Host ""
    npm adduser --registry http://localhost:4873
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ✓ 用户配置成功" -ForegroundColor Green
    } else {
        Write-Host "  ✗ 用户配置失败" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "  ✓ 用户已配置" -ForegroundColor Green
}

# 步骤 5: 发布
Write-Host ""
Write-Host "[步骤 5/5] 发布包..." -ForegroundColor Yellow
Write-Host ""

npm publish --registry http://localhost:4873
if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  部署成功！" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "私有仓库地址: http://localhost:4873" -ForegroundColor Cyan
    Write-Host "Web 界面:     http://localhost:4873" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "包信息:" -ForegroundColor Yellow
    Write-Host "  名称: @yourcompany/edk2-opencode" -ForegroundColor White
    Write-Host "  版本: 1.0.0" -ForegroundColor White
    Write-Host ""
    Write-Host "安装方式:" -ForegroundColor Yellow
    Write-Host "  npm install -g @yourcompany/edk2-opencode --registry http://localhost:4873" -ForegroundColor White
    Write-Host ""
    Write-Host "使用方式:" -ForegroundColor Yellow
    Write-Host "  npx @yourcompany/edk2-opencode --version" -ForegroundColor White
    Write-Host "  npx @yourcompany/edk2-opencode login <username> <token>" -ForegroundColor White
    Write-Host ""
    Write-Host "其他用户安装:" -ForegroundColor Yellow
    Write-Host "  1. 配置 registry: npm set @yourcompany:registry http://<服务器IP>:4873" -ForegroundColor White
    Write-Host "  2. 安装: npm install -g @yourcompany/edk2-opencode" -ForegroundColor White
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "  发布失败" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "请检查:" -ForegroundColor Yellow
    Write-Host "  1. Verdaccio 是否运行: 访问 http://localhost:4873" -ForegroundColor White
    Write-Host "  2. 用户是否登录: npm login --registry http://localhost:4873" -ForegroundColor White
    Write-Host "  3. 查看错误信息" -ForegroundColor White
    Write-Host ""
    exit 1
}