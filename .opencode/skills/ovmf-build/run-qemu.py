#!/usr/bin/env python3
"""
Run QEMU with OVMF firmware

This script launches QEMU with OVMF UEFI firmware for virtual machine testing.

Usage:
    python run-qemu.py [--ovmf PATH] [--memory SIZE] [--cdrom ISO] [--disk IMG]

Example:
    python run-qemu.py --ovmf ./edk2/Build/OvmfX64/DEBUG_VS2022/FV/OVMF.fd
    python run-qemu.py --cdrom ./test.iso --memory 1024
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
    GRAY = '\033[90m'
    RESET = '\033[0m'


def log_info(message):
    print(f"{Colors.CYAN}[INFO]{Colors.RESET} {message}")


def log_success(message):
    print(f"{Colors.GREEN}[OK]{Colors.RESET} {message}")


def log_error(message):
    print(f"{Colors.RED}[ERROR]{Colors.RESET} {message}")


def log_warn(message):
    print(f"{Colors.YELLOW}[WARN]{Colors.RESET} {message}")


def find_qemu():
    """Find QEMU executable"""
    candidates = [
        "qemu-system-x86_64",
        "qemu-system-x86_64.exe",
        "/usr/bin/qemu-system-x86_64",
    ]
    
    # Windows specific paths
    if sys.platform == "win32":
        program_files = os.environ.get("ProgramFiles", "C:\\Program Files")
        candidates.append(f"{program_files}\\qemu\\qemu-system-x86_64.exe")
        candidates.append(f"{program_files}\\qemu\\qemu-system-x86_64w.exe")
    
    for candidate in candidates:
        if shutil.which(candidate):
            return candidate
        if Path(candidate).exists():
            return candidate
    
    return None


def find_ovmf():
    """Find OVMF firmware file"""
    search_paths = [
        "./edk2/Build/OvmfX64/DEBUG_VS2022/FV/OVMF.fd",
        "./edk2/Build/OvmfX64/DEBUG_VS2019/FV/OVMF.fd",
        "./edk2/Build/OvmfX64/DEBUG_GCC5/FV/OVMF.fd",
        "./Build/OvmfX64/DEBUG_VS2022/FV/OVMF.fd",
        "./Build/OvmfX64/DEBUG_GCC5/FV/OVMF.fd",
        "./OVMF.fd",
        "/usr/share/OVMF/OVMF.fd",
        "/usr/share/ovmf/OVMF.fd",
    ]
    
    for path in search_paths:
        if Path(path).exists():
            return str(Path(path).resolve())
    
    return None


def list_ovmf_files():
    """List available OVMF files"""
    log_info("Searching for OVMF files...")
    
    edk2_path = Path("./edk2")
    if edk2_path.exists():
        ovmf_files = list(edk2_path.rglob("OVMF.fd"))
        if ovmf_files:
            print(f"\n{Colors.GREEN}Found OVMF files:{Colors.RESET}")
            for f in ovmf_files:
                print(f"  {f}")
        else:
            log_warn("No OVMF.fd files found. Build first with: python build-ovmf.py")
    else:
        log_warn("EDK2 directory not found. Clone with: git clone https://github.com/tianocore/edk2")


def main():
    parser = argparse.ArgumentParser(description="Run QEMU with OVMF")
    parser.add_argument("--ovmf", help="Path to OVMF.fd file")
    parser.add_argument("--memory", default="512M", help="Memory size (default: 512M)")
    parser.add_argument("--cdrom", help="Path to ISO file")
    parser.add_argument("--disk", help="Path to disk image")
    parser.add_argument("--headless", action="store_true", help="Run without GUI")
    parser.add_argument("--list-ovmf", action="store_true", help="List available OVMF files")
    
    args = parser.parse_args()
    
    # List OVMF if requested
    if args.list_ovmf:
        list_ovmf_files()
        return
    
    # Find QEMU
    qemu = find_qemu()
    if not qemu:
        log_error("QEMU not found.")
        if sys.platform == "win32":
            print("Install with: choco install qemu")
        else:
            print("Install with: sudo apt install qemu-system-x86")
        sys.exit(1)
    
    log_success(f"QEMU found: {qemu}")
    
    # Find OVMF
    ovmf_path = args.ovmf or find_ovmf()
    if not ovmf_path:
        log_error("OVMF not found. Build first with: python build-ovmf.py")
        print("Or specify path with: --ovmf path/to/OVMF.fd")
        sys.exit(1)
    
    if not Path(ovmf_path).exists():
        log_error(f"OVMF file not found: {ovmf_path}")
        sys.exit(1)
    
    log_success(f"Using OVMF: {ovmf_path}")
    
    # Build QEMU command
    cmd = [qemu, "-bios", ovmf_path, "-m", args.memory]
    
    # Add CD-ROM
    if args.cdrom:
        if Path(args.cdrom).exists():
            cmd.extend(["-cdrom", args.cdrom])
            log_success(f"CD-ROM: {args.cdrom}")
        else:
            log_warn(f"CD-ROM file not found: {args.cdrom}")
    
    # Add disk
    if args.disk:
        if Path(args.disk).exists():
            cmd.extend(["-hda", args.disk])
            log_success(f"Disk: {args.disk}")
        else:
            log_warn(f"Disk file not found: {args.disk}")
    
    # Headless mode
    if args.headless:
        cmd.extend(["-nographic", "-serial", "mon:stdio"])
        log_success("Running in headless mode")
    
    # Run QEMU
    print(f"\n{Colors.CYAN}[STARTING]{Colors.RESET} QEMU with OVMF...")
    print(f"{Colors.GRAY}Command: {' '.join(cmd)}{Colors.RESET}")
    print(f"\n{Colors.YELLOW}Press Ctrl+A then X to exit{Colors.RESET}\n")
    
    try:
        subprocess.run(cmd)
    except KeyboardInterrupt:
        print("\nExiting...")


if __name__ == "__main__":
    main()