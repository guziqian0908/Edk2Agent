<#
.SYNOPSIS
    Run QEMU with OVMF firmware

.DESCRIPTION
    This script runs QEMU with OVMF firmware for UEFI virtual machine testing.

.PARAMETER OvmfPath
    Path to OVMF.fd file

.PARAMETER Memory
    Memory size in MB. Default: 512

.PARAMETER Cdrom
    Path to ISO file to attach as CD-ROM

.PARAMETER Disk
    Path to disk image file

.PARAMETER Headless
    Run without GUI (serial console only)

.EXAMPLE
    .\run-qemu.ps1 -OvmfPath ".\edk2\Build\OvmfX64\DEBUG_VS2022\FV\OVMF.fd"
    Run QEMU with OVMF

.EXAMPLE
    .\run-qemu.ps1 -Cdrom ".\test.iso" -Memory 1024
    Run with ISO and 1GB RAM
#>

param(
    [string]$OvmfPath,
    [string]$Memory = "512M",
    [string]$Cdrom,
    [string]$Disk,
    [switch]$Headless,
    [switch]$ListOvmf
)

$ErrorActionPreference = "Stop"

function Find-Qemu {
    $qemuPaths = @(
        "${env:ProgramFiles}\qemu\qemu-system-x86_64.exe",
        "${env:ProgramFiles}\qemu\qemu-system-x86_64w.exe",
        "qemu-system-x86_64"
    )
    
    foreach ($path in $qemuPaths) {
        if (Get-Command $path -ErrorAction SilentlyContinue) {
            return $path
        }
    }
    
    Write-Host "[ERROR] QEMU not found. Install with: choco install qemu" -ForegroundColor Red
    exit 1
}

function Find-Ovmf {
    $searchPaths = @(
        ".\edk2\Build\OvmfX64\DEBUG_VS2022\FV\OVMF.fd",
        ".\edk2\Build\OvmfX64\DEBUG_VS2019\FV\OVMF.fd",
        ".\Build\OvmfX64\DEBUG_VS2022\FV\OVMF.fd",
        ".\OVMF.fd"
    )
    
    foreach ($path in $searchPaths) {
        if (Test-Path $path) {
            return (Resolve-Path $path).Path
        }
    }
    
    return $null
}

# List OVMF files if requested
if ($ListOvmf) {
    Write-Host "Searching for OVMF files..." -ForegroundColor Cyan
    
    $edk2Path = ".\edk2"
    if (Test-Path $edk2Path) {
        $ovmfFiles = Get-ChildItem -Path $edk2Path -Recurse -Filter "OVMF.fd" -ErrorAction SilentlyContinue
        if ($ovmfFiles) {
            Write-Host "`nFound OVMF files:" -ForegroundColor Green
            $ovmfFiles | ForEach-Object { Write-Host "  $($_.FullName)" }
        } else {
            Write-Host "No OVMF.fd files found. Build first with: .\build-ovmf.ps1" -ForegroundColor Yellow
        }
    } else {
        Write-Host "EDK2 directory not found. Clone with: git clone https://github.com/tianocore/edk2" -ForegroundColor Yellow
    }
    exit 0
}

# Find QEMU
$qemu = Find-Qemu
Write-Host "[OK] QEMU found: $qemu" -ForegroundColor Green

# Find OVMF
if (-not $OvmfPath) {
    $OvmfPath = Find-Ovmf
    if (-not $OvmfPath) {
        Write-Host "[ERROR] OVMF not found. Build first with: .\build-ovmf.ps1" -ForegroundColor Red
        Write-Host "Or specify path with: -OvmfPath path\to\OVMF.fd" -ForegroundColor Yellow
        exit 1
    }
    Write-Host "[OK] Using OVMF: $OvmfPath" -ForegroundColor Green
} elseif (-not (Test-Path $OvmfPath)) {
    Write-Host "[ERROR] OVMF file not found: $OvmfPath" -ForegroundColor Red
    exit 1
}

# Build QEMU arguments
$qemuArgs = @(
    "-bios", $OvmfPath,
    "-m", $Memory,
    "-enable-kvm"  # Works on Linux, ignored on Windows
)

# Remove -enable-kvm for Windows
if ($IsWindows -or $env:OS -eq "Windows_NT") {
    $qemuArgs = @(
        "-bios", $OvmfPath,
        "-m", $Memory
    )
}

# Add CD-ROM if specified
if ($Cdrom) {
    if (Test-Path $Cdrom) {
        $qemuArgs += @("-cdrom", (Resolve-Path $Cdrom).Path)
        Write-Host "[OK] CD-ROM: $Cdrom" -ForegroundColor Green
    } else {
        Write-Host "[WARN] CD-ROM file not found: $Cdrom" -ForegroundColor Yellow
    }
}

# Add disk if specified
if ($Disk) {
    if (Test-Path $Disk) {
        $qemuArgs += @("-hda", (Resolve-Path $Disk).Path)
        Write-Host "[OK] Disk: $Disk" -ForegroundColor Green
    } else {
        Write-Host "[WARN] Disk file not found: $Disk" -ForegroundColor Yellow
    }
}

# Headless mode
if ($Headless) {
    $qemuArgs += @("-nographic", "-serial", "mon:stdio")
    Write-Host "[OK] Running in headless mode" -ForegroundColor Green
}

# Run QEMU
Write-Host "`n[STARTING] QEMU with OVMF..." -ForegroundColor Cyan
Write-Host "Command: $qemu $qemuArgs" -ForegroundColor Gray
Write-Host "`nPress Ctrl+A then X to exit`n" -ForegroundColor Yellow

& $qemu $qemuArgs