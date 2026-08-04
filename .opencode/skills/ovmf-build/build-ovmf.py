#!/usr/bin/env python3
"""
OVMF Build Script - Cross-platform EDK2 OVMF builder

This script automates building OVMF (Open Virtual Machine Firmware) 
for QEMU virtual machines.

Usage:
    python build-ovmf.py [--edk2-path PATH] [--toolchain TOOLCHAIN] [--clone]

Example:
    python build-ovmf.py --clone --toolchain VS2022
    python build-ovmf.py --toolchain GCC5 --arch X64
"""

import argparse
import os
import sys
import subprocess
import shutil
from pathlib import Path


class Colors:
    CYAN = '\033[96m'
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    RESET = '\033[0m'


def log_step(message):
    print(f"\n{Colors.CYAN}[STEP]{Colors.RESET} {message}")


def log_success(message):
    print(f"{Colors.GREEN}[OK]{Colors.RESET} {message}")


def log_error(message):
    print(f"{Colors.RED}[ERROR]{Colors.RESET} {message}")


def run_command(cmd, cwd=None, check=True):
    """Run a shell command and return the result"""
    try:
        result = subprocess.run(
            cmd,
            shell=True,
            cwd=cwd,
            capture_output=True,
            text=True,
            check=check
        )
        return result.returncode == 0, result.stdout, result.stderr
    except subprocess.CalledProcessError as e:
        return False, e.stdout, e.stderr


def check_command(cmd):
    """Check if a command is available"""
    return shutil.which(cmd) is not None


def check_prerequisites():
    """Check build prerequisites"""
    log_step("Checking prerequisites...")
    
    issues = []
    
    # Check Python
    log_success(f"Python: {sys.version.split()[0]}")
    
    # Check Git
    if check_command("git"):
        log_success("Git found")
    else:
        issues.append("Git not found")
    
    # Platform-specific checks
    if sys.platform == "win32":
        # Check NASM
        if check_command("nasm"):
            result = run_command("nasm --version", check=False)
            log_success("NASM found")
        else:
            issues.append("NASM not found. Install with: choco install nasm")
        
        # Check Visual Studio
        vswhere = Path(os.environ.get("ProgramFiles(x86)", "")) / "Microsoft Visual Studio" / "Installer" / "vswhere.exe"
        if vswhere.exists():
            log_success("Visual Studio found")
        else:
            issues.append("Visual Studio not found")
    
    else:  # Linux/macOS
        # Check GCC
        if check_command("gcc"):
            log_success("GCC found")
        else:
            issues.append("GCC not found. Install with: sudo apt install build-essential")
        
        # Check NASM
        if check_command("nasm"):
            log_success("NASM found")
        else:
            issues.append("NASM not found. Install with: sudo apt install nasm")
    
    if issues:
        for issue in issues:
            log_error(issue)
        return False
    
    return True


def clone_edk2(edk2_path, clone=False):
    """Clone or update EDK2 repository"""
    log_step("Setting up EDK2 repository...")
    
    edk2_path = Path(edk2_path)
    
    if edk2_path.exists():
        log_success(f"EDK2 directory exists: {edk2_path}")
        if clone:
            log_step("Updating EDK2...")
            run_command("git pull", cwd=edk2_path)
            run_command("git submodule update --init", cwd=edk2_path)
    else:
        if clone:
            log_step("Cloning EDK2...")
            run_command(f"git clone --depth 1 https://github.com/tianocore/edk2.git {edk2_path}")
            run_command("git submodule update --init", cwd=edk2_path)
        else:
            log_error(f"EDK2 not found at {edk2_path}. Use --clone to download.")
            return False
    
    log_success("EDK2 repository ready")
    return True


def build_ovmf(edk2_path, toolchain, arch):
    """Build OVMF"""
    log_step(f"Building OVMF with {toolchain} for {arch}...")
    
    edk2_path = Path(edk2_path)
    
    # Setup environment
    if sys.platform == "win32":
        # Find vcvars64.bat
        vcvars_paths = [
            Path(os.environ.get("ProgramFiles", "")) / "Microsoft Visual Studio" / "2022" / "BuildTools" / "VC" / "Auxiliary" / "Build" / "vcvars64.bat",
            Path(os.environ.get("ProgramFiles(x86)", "")) / "Microsoft Visual Studio" / "2019" / "BuildTools" / "VC" / "Auxiliary" / "Build" / "vcvars64.bat",
        ]
        
        vcvars = None
        for p in vcvars_paths:
            if p.exists():
                vcvars = p
                break
        
        if not vcvars:
            log_error("vcvars64.bat not found. Please install Visual Studio Build Tools.")
            return False
        
        # Run edksetup and build
        setup_cmd = f'call "{vcvars}" && edksetup.bat && build -p OvmfPkg\\OvmfPkgX64.dsc -t {toolchain} -a {arch}'
        
    else:  # Linux/macOS
        setup_cmd = f'source edksetup.sh && build -p OvmfPkg/OvmfPkgX64.dsc -t {toolchain} -a {arch}'
    
    log_step("Running build...")
    success, stdout, stderr = run_command(setup_cmd, cwd=edk2_path, check=False)
    
    if not success:
        log_error(f"Build failed: {stderr}")
        return False
    
    # Check output
    output_dir = edk2_path / "Build" / "OvmfX64" / f"DEBUG_{toolchain}" / "FV"
    
    if output_dir.exists():
        log_success("Build successful!")
        print(f"\n{Colors.YELLOW}Output files:{Colors.RESET}")
        for f in output_dir.glob("*.fd"):
            print(f"  {f}")
        return True
    else:
        log_error(f"Build output not found at {output_dir}")
        return False


def build_emulator(edk2_path, toolchain, arch):
    """Build EmulatorPkg"""
    log_step(f"Building EmulatorPkg with {toolchain} for {arch}...")
    
    edk2_path = Path(edk2_path)
    
    if sys.platform != "win32":
        log_error("EmulatorPkg is only supported on Windows")
        return False
    
    # Find vcvars64.bat
    vcvars_paths = [
        Path(os.environ.get("ProgramFiles", "")) / "Microsoft Visual Studio" / "2022" / "BuildTools" / "VC" / "Auxiliary" / "Build" / "vcvars64.bat",
        Path(os.environ.get("ProgramFiles(x86)", "")) / "Microsoft Visual Studio" / "2019" / "BuildTools" / "VC" / "Auxiliary" / "Build" / "vcvars64.bat",
    ]
    
    vcvars = None
    for p in vcvars_paths:
        if p.exists():
            vcvars = p
            break
    
    if not vcvars:
        log_error("vcvars64.bat not found")
        return False
    
    setup_cmd = f'call "{vcvars}" && edksetup.bat && build -p EmulatorPkg\\EmulatorPkg.dsc -t {toolchain} -a {arch}'
    
    log_step("Running build...")
    success, stdout, stderr = run_command(setup_cmd, cwd=edk2_path, check=False)
    
    if not success:
        log_error(f"Build failed: {stderr}")
        return False
    
    # Check output
    output_dir = edk2_path / "Build" / "EmulatorX64" / f"DEBUG_{toolchain}" / "X64"
    
    if output_dir.exists():
        log_success("Build successful!")
        print(f"\n{Colors.YELLOW}Output files:{Colors.RESET}")
        winhost = output_dir / "WinHost.exe"
        if winhost.exists():
            print(f"  {winhost}")
        return True
    else:
        log_error(f"Build output not found at {output_dir}")
        return False


def main():
    parser = argparse.ArgumentParser(description="Build OVMF/EmulatorPkg")
    parser.add_argument("--edk2-path", default="./edk2", help="Path to EDK2 repository")
    parser.add_argument("--toolchain", default="VS2022" if sys.platform == "win32" else "GCC5",
                       help="Toolchain (VS2022, VS2019, GCC5)")
    parser.add_argument("--arch", default="X64", help="Target architecture")
    parser.add_argument("--clone", action="store_true", help="Clone EDK2 if not exists")
    parser.add_argument("--emulator", action="store_true", help="Build EmulatorPkg instead of OVMF")
    
    args = parser.parse_args()
    
    print(f"{Colors.CYAN}{'='*50}{Colors.RESET}")
    print(f"{Colors.CYAN}  OVMF Build Script{Colors.RESET}")
    print(f"{Colors.CYAN}{'='*50}{Colors.RESET}")
    
    if not check_prerequisites():
        sys.exit(1)
    
    if not clone_edk2(args.edk2_path, args.clone):
        sys.exit(1)
    
    if args.emulator:
        if not build_emulator(args.edk2_path, args.toolchain, args.arch):
            sys.exit(1)
    else:
        if not build_ovmf(args.edk2_path, args.toolchain, args.arch):
            sys.exit(1)
    
    print(f"\n{Colors.GREEN}[SUCCESS] Build completed!{Colors.RESET}")


if __name__ == "__main__":
    main()