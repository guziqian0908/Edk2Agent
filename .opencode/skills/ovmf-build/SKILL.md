---
name: ovmf-build
description: Use when building and running OVMF (UEFI firmware for QEMU) or EmulatorPkg (Windows UEFI emulator). Installs QEMU, clones EDK2, builds OvmfPkgX64/EmulatorPkg, and runs it. Trigger when user asks about OVMF, EDK2, UEFI firmware, building QEMU virtual firmware, or WinHost emulator.
---

# OVMF and EmulatorPkg Build and Run Skill

This skill handles the complete workflow for building and running OVMF (Open Virtual Machine Firmware) using EDK2 and QEMU, as well as EmulatorPkg (Windows UEFI emulator) using WinHost.exe.

**Cross-Platform Support:** Windows and Linux

## Quick Start (Automated Scripts)

This skill includes automated build scripts for convenience:

### Windows (PowerShell)

```powershell
# Build OVMF (clones EDK2 if needed)
.\build-ovmf.ps1 -CloneEdk2

# Build EmulatorPkg
.\build-ovmf.ps1 -BuildEmulatorPkg -CloneEdk2

# Run QEMU with OVMF
.\run-qemu.ps1
```

### Cross-Platform (Python)

```bash
# Build OVMF
python build-ovmf.py --clone

# Build EmulatorPkg (Windows only)
python build-ovmf.py --clone --emulator

# Run QEMU
python run-qemu.py
```

### Available Scripts

| Script | Platform | Description |
|--------|----------|-------------|
| `build-ovmf.ps1` | Windows | PowerShell build script |
| `build-ovmf.py` | All | Python cross-platform build script |
| `run-qemu.ps1` | Windows | PowerShell QEMU launcher |
| `run-qemu.py` | All | Python cross-platform QEMU launcher |

## Prerequisites Check

Before starting, verify the following tools are available:

**Windows:**
1. **Chocolatey** - Third-party Windows package manager (not included with Windows, requires separate installation from https://chocolatey.org)
2. **Visual Studio Build Tools** - C compiler toolchain
3. **Python 3.x** - Required for EDK2 build
4. **NASM** - Assembly compiler

**Linux:**
1. **gcc** - C compiler toolchain
2. **nasm** - Assembly compiler
3. **build-essential** - Build tools
4. **python3** - Required for EDK2 build
5. **qemu-system-x86** - QEMU emulator

## Workflow Steps

## Windows Workflow

### Step 1: Install QEMU

Check if QEMU is installed:

```powershell
qemu-system-x86_64 --version
```

If not installed, use Chocolatey (requires admin):

```powershell
choco install qemu -y
```

QEMU installs to `C:\Program Files\qemu\` by default.

---

## Linux Workflow

### Step 1: Install QEMU (Linux)

```bash
# Ubuntu/Debian
sudo apt-get install -y qemu-system-x86

# Fedora
sudo dnf install -y qemu-system-x86

# Arch Linux
sudo pacman -S qemu-system-x86
```

### Step 2: Install Build Dependencies (Linux)

```bash
# Ubuntu/Debian
sudo apt-get install -y gcc nasm build-essential python3

# Fedora
sudo dnf install -y gcc nasm make python3

# Arch Linux
sudo pacman -S gcc nasm make python
```

### Step 3: Clone EDK2 (Linux)

```bash
git clone --depth 1 https://github.com/tianocore/edk2.git
cd edk2
git submodule update --init
```

### Step 4: Setup Build Environment (Linux)

```bash
cd edk2
source edksetup.sh
```

### Step 5: Build OvmfPkgX64 (Linux)

```bash
build -p OvmfPkg/OvmfPkgX64.dsc -t GCC5 -a X64
```

### Step 6: Output Files (Linux)

After successful build, output files are located at:

```
Build/OvmfX64/DEBUG_GCC5/FV/OVMF.fd
Build/OvmfX64/DEBUG_GCC5/FV/OVMF_CODE.fd
Build/OvmfX64/DEBUG_GCC5/FV/OVMF_VARS.fd
```

### Step 7: Run with QEMU (Linux)

```bash
# Method 1: Single firmware file
qemu-system-x86_64 -bios Build/OvmfX64/DEBUG_GCC5/FV/OVMF.fd -m 512M

# Method 2: Split firmware (CODE + VARS)
qemu-system-x86_64 -pflash Build/OvmfX64/DEBUG_GCC5/FV/OVMF_CODE.fd \
                   -pflash Build/OvmfX64/DEBUG_GCC5/FV/OVMF_VARS.fd \
                   -m 512M
```

---

## Windows Workflow

### Step 2: Clone EDK2

Clone the EDK2 repository:

```powershell
git clone --depth 1 https://github.com/tianocore/edk2.git
git submodule update --init
```

### Step 3: Setup Build Environment

1. Initialize Visual Studio environment:

```powershell
# For VS Build Tools (adjust path as needed)
cmd /c '"C:\Program Files (x86)\Microsoft Visual Studio\{VS_VERSION}\BuildTools\VC\Auxiliary\Build\vcvars64.bat"'
```

2. Run EDK2 setup:

```powershell
cd edk2
edksetup.bat
```

### Step 4: Build OvmfPkgX64

Build command:

```powershell
build -p OvmfPkg\OvmfPkgX64.dsc -t VS2022 -a X64
```

For older VS versions, use appropriate toolchain tag:
- VS2022: Visual Studio 2022
- VS2019: Visual Studio 2019
- VS2017: Visual Studio 2017

### Step 5: Output Files

After successful build, output files are located at:

```
Build/OvmfX64/DEBUG_VS2022/FV/OVMF.fd
Build/OvmfX64/DEBUG_VS2022/FV/OVMF_CODE.fd
Build/OvmfX64/DEBUG_VS2022/FV/OVMF_VARS.fd
```

### Step 6: Run with QEMU

Start QEMU with OVMF firmware:

```powershell
# Method 1: Single firmware file
Start-Process "C:\Program Files\qemu\qemu-system-x86_64.exe" -ArgumentList "-bios", "Build/OvmfX64/DEBUG_VS2022/FV/OVMF.fd", "-m", "512M"

# Method 2: Split firmware (CODE + VARS)
Start-Process "C:\Program Files\qemu\qemu-system-x86_64.exe" -ArgumentList "-pflash", "Build/OvmfX64/DEBUG_VS2022/FV/OVMF_CODE.fd", "-pflash", "Build/OvmfX64/DEBUG_VS2022/FV/OVMF_VARS.fd", "-m", "512M"
```

## Common Issues

### Issue: NASM not found

Install NASM:

```powershell
choco install nasm -y
```

Add to PATH if needed: `C:\Users\{user}\AppData\Local\bin\NASM`

### Issue: Python not found

Install Python and ensure it's in PATH. Set PYTHON_PATH environment variable:

```powershell
set PYTHON_PATH=C:\Python311
```

### Issue: Build fails with toolchain error

Verify Visual Studio installation and use correct toolchain tag. Check vcvarsall.bat location:

```powershell
dir "C:\Program Files (x86)\Microsoft Visual Studio\" /s /b | findstr vcvarsall.bat
```

### Issue: QEMU window doesn't open

Run QEMU without `-nographic` flag for GUI output. For headless/serial output:

```powershell
qemu-system-x86_64.exe -bios OVMF.fd -nographic -serial mon:stdio
```

## File Paths Reference

| Item | Path |
|------|------|
| QEMU executable | `C:\Program Files\qemu\qemu-system-x86_64.exe` |
| EDK2 source | `{workspace}/edk2/` |
| Build output | `{workspace}/edk2/Build/OvmfX64/DEBUG_VS{version}/FV/` |
| VS vcvarsall | `C:\Program Files (x86)\Microsoft Visual Studio\{version}\BuildTools\VC\Auxiliary\Build\vcvarsall.bat` |

---

## EmulatorPkg (Windows UEFI Emulator)

EmulatorPkg provides a native Windows UEFI emulator (WinHost.exe) for development and testing without QEMU.

### Build EmulatorPkg

Build command:

```powershell
build -p EmulatorPkg\EmulatorPkg.dsc -t VS2022 -a X64
```

### Output Files

After successful build, output files are located at:

```
Build/EmulatorX64/DEBUG_VS2022/X64/WinHost.exe
Build/EmulatorX64/DEBUG_VS2026/FV/FV_RECOVERY.fd
```

### Run WinHost

WinHost.exe must be run from the X64 directory to find the firmware file:

```powershell
cd Build/EmulatorX64/DEBUG_VS2022/X64
./WinHost.exe
```

Or from PowerShell:

```powershell
Push-Location
Set-Location "Build/EmulatorX64/DEBUG_VS2022/X64"
./WinHost.exe
Pop-Location
```

### PCD Configuration

Console resolution can be configured via PCD in `EmulatorPkg.dsc`:

```ini
[PcdsDynamicHii.common.DEFAULT]
  gEfiMdeModulePkgTokenSpaceGuid.PcdConOutColumn|L"Setup"|gEmuSystemConfigGuid|0x0|80
  gEfiMdeModulePkgTokenSpaceGuid.PcdConOutRow|L"Setup"|gEmuSystemConfigGuid|0x4|25
```

### WinHost Shortcuts

- **F2** - Enter Setup
- **F7** - Enter Boot Manager Menu
- **Enter** - Boot directly

### Common Issues for EmulatorPkg

#### Issue: WinHost fails to find FV_RECOVERY.fd

WinHost expects firmware at `../FV/FV_RECOVERY.fd` relative to its working directory. Always run from the X64 directory.

#### Issue: WinHost window doesn't appear

Check if the process is running:

```powershell
Get-Process WinHost -ErrorAction SilentlyContinue
```

#### Issue: Build fails with VS toolchain not found

Ensure Visual Studio environment is initialized before building:

```powershell
cmd /c '"C:\Program Files (x86)\Microsoft Visual Studio\{VS_VERSION}\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" x86_amd64'
```