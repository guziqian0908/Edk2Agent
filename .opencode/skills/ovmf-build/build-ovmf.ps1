<#
.SYNOPSIS
    Build OVMF (Open Virtual Machine Firmware) for QEMU

.DESCRIPTION
    This script automates the complete OVMF build process including:
    - Checking prerequisites (VS, NASM, Python)
    - Cloning EDK2 repository
    - Setting up build environment
    - Building OvmfPkgX64

.PARAMETER Edk2Path
    Path to EDK2 repository. Default: .\edk2

.PARAMETER Toolchain
    Visual Studio toolchain. Default: VS2022
    Options: VS2022, VS2019, VS2017

.PARAMETER Arch
    Target architecture. Default: X64

.PARAMETER CloneEdk2
    Clone EDK2 repository if not exists

.EXAMPLE
    .\build-ovmf.ps1
    Build OVMF with default settings

.EXAMPLE
    .\build-ovmf.ps1 -Toolchain VS2019 -CloneEdk2
    Build with VS2019 and clone EDK2
#>

param(
    [string]$Edk2Path = ".\edk2",
    [string]$Toolchain = "VS2022",
    [string]$Arch = "X64",
    [switch]$CloneEdk2,
    [switch]$BuildEmulatorPkg
)

$ErrorActionPreference = "Stop"

function Write-Step($message) {
    Write-Host "`n[STEP] $message" -ForegroundColor Cyan
}

function Write-Success($message) {
    Write-Host "[OK] $message" -ForegroundColor Green
}

function Write-Error-Exit($message) {
    Write-Host "[ERROR] $message" -ForegroundColor Red
    exit 1
}

function Check-Command($cmd) {
    try {
        Get-Command $cmd -ErrorAction Stop | Out-Null
        return $true
    } catch {
        return $false
    }
}

# Check prerequisites
Write-Step "Checking prerequisites..."

if (-not (Check-Command "python")) {
    Write-Error-Exit "Python not found. Please install Python 3.8+"
}
Write-Success "Python found: $(python --version)"

if (-not (Check-Command "nasm")) {
    Write-Error-Exit "NASM not found. Install with: choco install nasm"
}
Write-Success "NASM found: $(nasm --version)"

if (-not (Check-Command "git")) {
    Write-Error-Exit "Git not found. Please install Git"
}
Write-Success "Git found"

# Check Visual Studio
$vsWherePath = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vsWherePath)) {
    Write-Error-Exit "Visual Studio Installer not found. Please install Visual Studio 2019/2022"
}

$vsPath = & $vsWherePath -latest -property installationPath 2>$null
if (-not $vsPath) {
    Write-Error-Exit "Visual Studio not found"
}
Write-Success "Visual Studio found: $vsPath"

# Clone EDK2 if needed
if ($CloneEdk2 -or -not (Test-Path $Edk2Path)) {
    Write-Step "Cloning EDK2 repository..."
    
    if (Test-Path $Edk2Path) {
        Write-Host "EDK2 directory exists, updating..."
        Push-Location $Edk2Path
        git pull
        Pop-Location
    } else {
        git clone --depth 1 https://github.com/tianocore/edk2.git $Edk2Path
    }
    
    Push-Location $Edk2Path
    git submodule update --init
    Pop-Location
    
    Write-Success "EDK2 repository ready"
}

$Edk2Path = (Resolve-Path $Edk2Path).Path

# Setup build environment
Write-Step "Setting up build environment..."

$vcvarsPath = ""
$vsVersion = $Toolchain -replace "VS", ""

switch ($Toolchain) {
    "VS2022" {
        $vcvarsPath = "${env:ProgramFiles}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
        if (-not (Test-Path $vcvarsPath)) {
            $vcvarsPath = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
        }
    }
    "VS2019" {
        $vcvarsPath = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
    }
    default {
        Write-Error-Exit "Unsupported toolchain: $Toolchain"
    }
}

if (-not (Test-Path $vcvarsPath)) {
    Write-Error-Exit "vcvars64.bat not found at: $vcvarsPath"
}

# Run edksetup
Push-Location $Edk2Path

Write-Step "Running edksetup.bat..."
cmd /c "edksetup.bat" 2>&1 | Out-Null

# Build
if ($BuildEmulatorPkg) {
    Write-Step "Building EmulatorPkg..."
    $buildCmd = "build -p EmulatorPkg\EmulatorPkg.dsc -t $Toolchain -a $Arch"
} else {
    Write-Step "Building OvmfPkgX64..."
    $buildCmd = "build -p OvmfPkg\OvmfPkgX64.dsc -t $Toolchain -a $Arch"
}

Write-Host "Executing: $buildCmd"

$buildProcess = Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$vcvarsPath && $buildCmd`"" -NoNewWindow -Wait -PassThru

if ($buildProcess.ExitCode -ne 0) {
    Write-Error-Exit "Build failed with exit code: $($buildProcess.ExitCode)"
}

Pop-Location

# Check output
if ($BuildEmulatorPkg) {
    $outputPath = "$Edk2Path\Build\EmulatorX64\DEBUG_$Toolchain\X64\WinHost.exe"
} else {
    $outputPath = "$Edk2Path\Build\OvmfX64\DEBUG_$Toolchain\FV\OVMF.fd"
}

if (Test-Path $outputPath) {
    Write-Success "Build successful!"
    Write-Host "`nOutput files:" -ForegroundColor Yellow
    Get-ChildItem "$Edk2Path\Build\*\DEBUG_$Toolchain" -Recurse -Include "*.fd","*.exe" | ForEach-Object {
        Write-Host "  $($_.FullName)"
    }
} else {
    Write-Error-Exit "Build output not found at: $outputPath"
}

Write-Host "`n[SUCCESS] OVMF build completed!" -ForegroundColor Green