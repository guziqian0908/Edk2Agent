# Build the EDK2 knowledge base from scratch on Windows.
# Downloads raw sources + models, then runs init_kb.py and add_mdepkg.py.
#
# Usage (from the repo root):
#   powershell -ExecutionPolicy Bypass -File setup_kb.ps1
#   powershell -ExecutionPolicy Bypass -File setup_kb.ps1 -SkipEmbed
#
# -SkipEmbed   skip the slow ChromaDB embedding phase (run add_mdepkg.py
#              --embed later yourself)
# -DataDir     where KB data lives (default: ~/.edk2-opencode/kb/data,
#              matching the runtime daemon)
# -ModelsDir   where models live (default: ~/.edk2-opencode/models)
param(
    [switch]$SkipEmbed,
    [string]$DataDir = "",
    [string]$ModelsDir = ""
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $DataDir) { $DataDir = Join-Path $HOME ".edk2-opencode\kb\data" }
if (-not $ModelsDir) { $ModelsDir = Join-Path $HOME ".edk2-opencode\models" }
$env:EDK2_KB_DATA = $DataDir
$env:EDK2_MODELS_DIR = $ModelsDir

function RunStep($name, $cmd) {
    Write-Host "`n=== $name ===" -ForegroundColor Cyan
    & $cmd
    if ($LASTEXITCODE -ne 0) { throw "step failed: $name" }
}

Write-Host "Data dir : $DataDir" -ForegroundColor Gray
Write-Host "Models   : $ModelsDir" -ForegroundColor Gray

RunStep "install python deps" { python -m pip install -r edk2-kb/requirements.txt }
RunStep "download local models (bge-m3 + bge-reranker-v2-m3)" { python edk2-kb/fetchers/fetch_models.py }
RunStep "fetch UEFI spec sources" { python edk2-kb/fetchers/fetch_specs.py }
RunStep "fetch tianocore/edk2 commit history" { python edk2-kb/fetchers/fetch_commits.py }
RunStep "fetch tianocore/edk2 pull requests" { python edk2-kb/fetchers/fetch_prs.py }
RunStep "build KB (wiki + tianocore-docs + specs/prs/commits)" { python edk2-kb/fetchers/init_kb.py }
RunStep "add MdePkg (chunking + FTS5)" { python edk2-kb/fetchers/add_mdepkg.py }
if (-not $SkipEmbed) {
    RunStep "embed MdePkg into ChromaDB (slow)" { python edk2-kb/fetchers/add_mdepkg.py --embed }
} else {
    Write-Host "`nSkipped embedding. Run later:" -ForegroundColor Yellow
    Write-Host "  python edk2-kb/fetchers/add_mdepkg.py --embed" -ForegroundColor Yellow
}

Write-Host "`nKB build complete. Start the daemon with:" -ForegroundColor Green
Write-Host "  node bin/edk2-opencode.js daemon start" -ForegroundColor Green