# Download and install a pre-built EDK2 knowledge base package from a
# GitHub Release (the package produced by package_kb.py), so a recipient can
# use the KB immediately without rebuilding embeddings.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install_kb.ps1
#   powershell -ExecutionPolicy Bypass -File install_kb.ps1 -Prefix kb-full
#   powershell -ExecutionPolicy Bypass -File install_kb.ps1 -Overwrite
#
# Params:
#   -Repo       GitHub repo (default: guziqian0908/Edk2Agent)
#   -Prefix     package prefix: kb-runtime (default) or kb-full
#   -Tag        release tag or 'latest' (default: latest)
#   -Dest       where to extract, defaults to ~/.edk2-opencode/kb
#   -RepoDir    path to the cloned repo (only needed to fetch the local
#               embedding models afterwards)
#   -Overwrite  remove an existing data dir before extracting
param(
    [string]$Repo = "guziqian0908/Edk2Agent",
    [string]$Prefix = "kb-runtime",
    [string]$Tag = "latest",
    [string]$Dest = "",
    [string]$RepoDir = "",
    [switch]$Overwrite
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if (-not $Dest) { $Dest = Join-Path $HOME ".edk2-opencode\kb" }
$dataDir = Join-Path $Dest "data"
$base = "https://github.com/$Repo/releases/$Tag/download"
$work = Join-Path $env:TEMP "edk2-kb-install"
New-Item -ItemType Directory -Path $work -Force | Out-Null

Write-Host "Downloading $Prefix package from $Repo (tag: $Tag)" -ForegroundColor Cyan
Write-Host "  -> $base" -ForegroundColor Gray

# 1. manifest
$manifestUrl = "$base/$Prefix.manifest.json"
$manifestFile = Join-Path $work "$Prefix.manifest.json"
curl.exe -sSL -o $manifestFile $manifestUrl
if (-not (Test-Path $manifestFile)) { throw "failed to download $manifestUrl" }
$manifest = Get-Content $manifestFile -Raw | ConvertFrom-Json
Write-Host "package: $($manifest.archive_name), docs: $($manifest.doc_count), parts: $($manifest.parts.Count)" -ForegroundColor Gray

# 2. download + verify parts
$full = Join-Path $work $manifest.archive_name
Remove-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
$partFiles = @()
foreach ($part in $manifest.parts) {
    $pf = Join-Path $work $part.file
    Write-Host "  downloading $($part.file) ..." -ForegroundColor Gray
    curl.exe -sSL -o $pf "$base/$($part.file)"
    if (-not (Test-Path $pf)) { throw "failed to download $($part.file)" }
    $sum = (Get-FileHash -LiteralPath $pf -Algorithm SHA256).Hash.ToLower()
    if ($sum -ne $part.sha256) {
        throw "SHA-256 mismatch for $($part.file): $sum"
    }
    $partFiles += $pf
}
Write-Host "All parts verified." -ForegroundColor Green

# 3. reassemble (copy /b part1+part2+... full)
if ($partFiles.Count -eq 1) {
    Copy-Item -LiteralPath $partFiles[0] -Destination $full
} else {
    $cmd = "/c copy /b " + (($partFiles | ForEach-Object { '"' + $_ + '"' }) -join "+") + " " + '"' + $full + '"'
    cmd.exe $cmd | Out-Null
    if (-not (Test-Path $full)) { throw "failed to reassemble $($manifest.archive_name)" }
}
$fullSum = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLower()
if ($fullSum -ne $manifest.total_sha256) {
    throw "SHA-256 mismatch for reassembled archive"
}
Write-Host "Archive verified: $full" -ForegroundColor Green

# 4. extract
if (Test-Path $dataDir) {
    if ($Overwrite) {
        Write-Host "Removing existing $dataDir" -ForegroundColor Yellow
        Remove-Item -LiteralPath $dataDir -Recurse -Force
    } else {
        throw "data dir already exists: $dataDir (re-run with -Overwrite to replace)"
    }
}
New-Item -ItemType Directory -Path $Dest -Force | Out-Null
Write-Host "Extracting into $Dest ..." -ForegroundColor Cyan
tar.exe -xzf $full -C $Dest
if (-not (Test-Path $dataDir)) { throw "extraction failed: no data dir created" }

# 5. optional: fetch local embedding models from the cloned repo
if ($RepoDir) {
    Write-Host "Fetching local embedding models ..." -ForegroundColor Cyan
    & python (Join-Path $RepoDir "edk2-kb\fetchers\fetch_models.py")
    if ($LASTEXITCODE -ne 0) { throw "fetch_models.py failed" }
} else {
    Write-Host "NOTE: models (~/.edk2-opencode/models) still required - run:" -ForegroundColor Yellow
    Write-Host "  python <repo>/edk2-kb/fetchers/fetch_models.py" -ForegroundColor Yellow
}

Write-Host "`nKB installed at $dataDir" -ForegroundColor Green
Write-Host "Start the daemon with: node <repo>/bin/edk2-opencode.js daemon start" -ForegroundColor Green
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue