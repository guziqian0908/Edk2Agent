#start-mcp.ps1
# EDK2 RAG MCP 公网服务启动脚本
#
# 启动：
#   1) EDK2 知识库 MCP 服务（固定端口 18765，绑定 0.0.0.0）
#   2) cloudflared 快速隧道，把 /mcp 暴露到公网
#   3) 打印公网 MCP URL + 给用户的 opencode 安装片段
#
# 用法：
#   .\start-mcp.ps1                 # 默认（服务 + 隧道 + 说明）
#   .\start-mcp.ps1 -Port 18765     # 自定义端口
#   .\start-mcp.ps1 -TunnelOnly     # 只管理隧道（服务已运行）
#
# 前置：知识库已初始化（npx edk2-opencode --init-edk2-wiki）
#       cloudflared 位于 $env:CLOUDFLARED 或 C:\Users\<你>\cloudflared\cloudflared.exe
#
# 注意：trycloudflare 隧道地址是临时的，重启本脚本会生成新地址，
#       届时需要把新 URL 重新发给用户更新 opencode 配置。

param(
  [int]$Port = 18765,
  [switch]$TunnelOnly,
  [string]$CloudflaredPath = $env:CLOUDFLARED
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$KbCandidates = @(
  "$env:USERPROFILE\.edk2-opencode\kb",
  "C:\Users\$env:USERNAME\.edk2-opencode\kb",
  "C:\Users\25703\.edk2-opencode\kb",
  "$RepoRoot\edk2-kb"
)
$KbDir = $KbCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

$LogDir = "$env:TEMP\edk2-mcp"
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════════╗"
Write-Host "║   EDK2 RAG MCP 公网服务（知识库在本机，用户免下载）           ║"
Write-Host "╚══════════════════════════════════════════════════════════════╝"
Write-Host ""

# ---------- 1. 确保 cloudflared ----------
if (-not $CloudflaredPath) {
  $candidates = @(
    "$HOME\cloudflared\cloudflared.exe",
    "C:\Users\$env:USERNAME\cloudflared\cloudflared.exe",
    "C:\Users\25703\cloudflared\cloudflared.exe",
    "$env:ProgramFiles\cloudflared\cloudflared.exe",
    "$env:LOCALAPPDATA\cloudflared\cloudflared.exe"
  )
  $CloudflaredPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $CloudflaredPath -or -not (Test-Path $CloudflaredPath)) {
  Write-Warn "未找到 cloudflared.exe。请先安装，或在命令中指定 -CloudflaredPath。"
  Write-Warn "下载: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
}
Write-Step "使用 cloudflared: $CloudflaredPath"

# ---------- 2. 启动 MCP 服务 ----------
if (-not $TunnelOnly) {
  Write-Step "启动 EDK2 知识库 MCP 服务（0.0.0.0:$Port）..."
  $env:EDK2_KB_HOST = '0.0.0.0'
  $env:EDK2_KB_PORT = "$Port"

  # 若已健康则复用
  $stateFile = Join-Path $KbDir 'daemon.json'
  $healthy = $false
  if (Test-Path $stateFile) {
    try {
      $st = Get-Content $stateFile -Raw | ConvertFrom-Json
      $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
      $healthy = $true
      Write-OK "MCP 服务已在运行: $($st.url)"
    } catch { $healthy = $false }
  }
  if (-not $healthy) {
    & node (Join-Path $RepoRoot 'bin\edk2-opencode.js') daemon start
    if ($LASTEXITCODE -ne 0) { Write-Warn "daemon start 返回非零退出码，继续检查健康..." }
  }

  # 等待就绪
  $ready = $false
  for ($i = 0; $i -lt 120; $i++) {
    try {
      $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
      if ($h.ready) { $ready = $true; break }
    } catch {}
    Start-Sleep -Seconds 5
  }
  if (-not $ready) {
    Write-Warn "MCP 服务 60 秒内未就绪。请检查日志: $KbDir\logs\mcp-supervisor.log"
    exit 1
  }
  Write-OK "MCP 服务就绪：索引 $($h.indexed_documents) 份文档"
} else {
  Write-Step "TunnelOnly 模式：跳过 MCP 服务启动"
}

# ---------- 3. 启动 cloudflared 隧道 ----------
$tunnelLog = Join-Path $LogDir 'cf-tunnel.log'
$tunnelPidFile = Join-Path $LogDir 'cf-tunnel.pid'
$urlFile = Join-Path $LogDir 'mcp-url.txt'

# 已有存活隧道则复用（PID 文件 + 端口探测）
$existingPid = $null
if (Test-Path $tunnelPidFile) {
  try { $existingPid = [int](Get-Content $tunnelPidFile) } catch {}
}
$alreadyPublic = $false
$publicUrl = $null
if ($existingPid -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
  if (Test-Path $urlFile) {
    $publicUrl = (Get-Content $urlFile -Raw).Trim()
    if ($publicUrl -and (Test-Path "$LogDir\cf-tunnel-healthy")) {
      Write-OK "复用现有隧道: $publicUrl"
      $alreadyPublic = $true
    }
  }
}

if (-not $alreadyPublic) {
  Write-Step "启动 cloudflared 隧道（指向 127.0.0.1:$Port）..."
  $tunnelOut = Join-Path $LogDir 'cf-tunnel.out.log'
  $tunnelErr = Join-Path $LogDir 'cf-tunnel.err.log'
  foreach ($f in @($tunnelLog, $tunnelOut, $tunnelErr)) { if (Test-Path $f) { Remove-Item $f -Force } }
  $proc = Start-Process -FilePath $CloudflaredPath `
    -ArgumentList @('tunnel', '--url', "http://127.0.0.1:$Port", '--no-autoupdate') `
    -WindowStyle Hidden -RedirectStandardOutput $tunnelOut -RedirectStandardError $tunnelErr -PassThru
  Set-Content -Path $tunnelPidFile -Value $proc.Id

  # 从日志解析公网 URL（cloudflared 日志输出到 stderr）
  $publicUrl = $null
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    $logText = ''
    foreach ($f in @($tunnelOut, $tunnelErr)) {
      if (Test-Path $f) { $logText += Get-Content $f -Raw -ErrorAction SilentlyContinue }
    }
    if ($logText -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
      $publicUrl = $Matches[0]
      break
    }
    if (-not (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) {
      Write-Warn "cloudflared 提前退出，查看日志: $tunnelErr"
      exit 1
    }
  }
  if (-not $publicUrl) {
    Write-Warn "未能解析隧道地址，查看日志: $tunnelLog"
    exit 1
  }
  Set-Content -Path $urlFile -Value $publicUrl
  Set-Content -Path "$LogDir\cf-tunnel-healthy" -Value (Get-Date -Format o)
  $alreadyPublic = $true
  Write-OK "隧道已建立: $publicUrl"
}

$mcpUrl = "$publicUrl/mcp"
Set-Content -Path (Join-Path $LogDir 'mcp-endpoint.txt') -Value $mcpUrl

# ---------- 4. 验证公网 MCP 端点 ----------
Write-Step "验证公网 MCP 端点..."
try {
  $init = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"start-script","version":"1.0"}}}'
  $resp = Invoke-WebRequest -Uri $mcpUrl -Method POST -Body $init `
    -ContentType 'application/json' -Headers @{ Accept = 'application/json, text/event-stream' } `
    -TimeoutSec 30 -UseBasicParsing
  if ($resp.StatusCode -eq 200) {
    Write-OK "公网 MCP 端点可用（HTTP 200）"
  }
} catch {
  Write-Warn "公网 MCP 端点验证失败: $($_.Exception.Message)（隧道可能仍在预热，稍后重试）"
}

# ---------- 5. 输出给用户的安装片段 ----------
Write-Host ""
Write-Host "──────────────────────────────────────────────────────────────"
Write-Host "  服务已就绪！把下面配置发给用户即可。"
Write-Host "──────────────────────────────────────────────────────────────"
Write-Host ""
Write-Host "  公网 MCP URL:"
Write-Host "    $mcpUrl"
Write-Host ""
Write-Host "  用户在 opencode.json 中配置："
Write-Host ""
Write-Host "  {"
Write-Host '    "$schema": "https://opencode.ai/config.json",'
Write-Host '    "mcp": {'
Write-Host '      "edk2-kb": {'
Write-Host '        "type": "remote",'
Write-Host ('        "url": "' + $mcpUrl + '",')
Write-Host '        "enabled": true'
Write-Host '      }'
Write-Host '    }'
Write-Host "  }"
Write-Host ""
Write-Host "  用户只需配置这一个 MCP，无需下载任何 EDK2 资料。"
Write-Host "  保存后重启 opencode 生效。重启本脚本会更换隧道地址。"
Write-Host ""
