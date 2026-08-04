#!/usr/bin/env python3
"""
EDK2 Knowledge Base daemon supervisor (watchdog)

A long-lived, singleton supervisor that owns the MCP server process:

  * Single instance        - if a healthy server is already running (state
                             file + /health probe), this process exits
                             immediately instead of starting a second one.
  * Auto-restart on crash  - if the MCP server dies unexpectedly it is
                             respawned with exponential backoff.
  * Graceful stop          - SIGTERM/SIGINT or the presence of a stop-flag
                             file shuts the child down cleanly.

The Node CLI (lib/daemon.js) talks to this process via daemon.json / health
checks, so multiple OpenCode instances share the same knowledge base daemon.
"""

import argparse
import ctypes
import os
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path


def log(msg: str, log_file: Path) -> None:
    line = f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    try:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    print(line, flush=True)


def _pid_alive(pid: int) -> bool:
    """Cross-platform liveness check for a PID."""
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            handle = ctypes.windll.kernel32.OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not handle:
                return False
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _acquire_lock(lock_file: Path, log_file: Path) -> bool:
    """Atomically acquire the singleton lock (O_CREAT|O_EXCL).

    Returns True if this process owns the lock, False if another watchdog
    already owns it (its PID is alive). Stale locks are reclaimed.
    """
    try:
        fd = os.open(lock_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return True
    except FileExistsError:
        try:
            pid = int(lock_file.read_text().strip())
            if _pid_alive(pid):
                log(f"Another supervisor (pid={pid}) already owns the daemon; "
                    f"exiting", log_file)
                return False
            log(f"Reclaiming stale lock from dead pid={pid}", log_file)
            lock_file.unlink(missing_ok=True)
        except (ValueError, OSError):
            lock_file.unlink(missing_ok=True)
        try:
            fd = os.open(lock_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            return True
        except FileExistsError:
            return False
    except OSError:
        return False


def _health_ok(state_file: Path, timeout: float = 1.0) -> bool:
    """Check whether an existing daemon is alive via /health."""
    try:
        import json
        with open(state_file, "r", encoding="utf-8") as f:
            state = json.load(f)
        url = state.get("url")
        if not url:
            return False
        # urllib GET /health with short timeout
        import urllib.request
        req = urllib.request.Request(f"{url}/health", headers={"User-Agent": "edk2-watchdog"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="EDK2 KB daemon supervisor")
    parser.add_argument("--state-file", type=str, required=True)
    parser.add_argument("--server-script", type=str, required=True)
    parser.add_argument("--pid-file", type=str, required=True)
    parser.add_argument("--log-file", type=str, required=True)
    parser.add_argument("--stop-flag", type=str, required=True)
    parser.add_argument("--lock-file", type=str, required=True)
    parser.add_argument("--data-dir", type=str, default=None)
    parser.add_argument("--host", type=str, default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()

    state_file = Path(args.state_file).resolve()
    pid_file = Path(args.pid_file).resolve()
    log_file = Path(args.log_file).resolve()
    stop_flag = Path(args.stop_flag).resolve()
    lock_file = Path(args.lock_file).resolve()
    server_script = str(Path(args.server_script).resolve())
    server_cwd = str(Path(server_script).parent)

    # Single instance: if a healthy daemon already exists, do not double-start.
    if _health_ok(state_file):
        log("Another healthy daemon is already running - exiting", log_file)
        sys.exit(0)

    # Atomic singleton lock guards against concurrent-start races where two
    # supervisors could both pass the health check before either server writes
    # its state.
    if not _acquire_lock(lock_file, log_file):
        sys.exit(0)

    # Stop-flag based graceful stop.
    stop_requested = False

    def handle_signal(signum, frame):
        nonlocal stop_requested
        stop_requested = True
        log(f"Received signal {signum}, stopping...", log_file)

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    pid_file.parent.mkdir(parents=True, exist_ok=True)
    pid_file.write_text(str(os.getpid()), encoding="utf-8")

    env = os.environ.copy()
    env["EDK2_WATCHDOG_PID"] = str(os.getpid())

    server_cmd = [
        sys.executable, server_script,
        "--host", args.host,
        "--port", str(args.port),
    ]
    if args.data_dir:
        server_cmd += ["--data-dir", args.data_dir]
    server_cmd += ["--state-file", str(state_file)]

    attempt = 0
    child = None

    log(f"Supervisor started (pid={os.getpid()})", log_file)
    try:
        while not stop_requested:
            if stop_flag.exists():
                log("Stop flag detected, stopping...", log_file)
                break

            log(f"Starting MCP server (attempt {attempt + 1})...", log_file)
            child = subprocess.Popen(
                server_cmd, env=env,
                cwd=server_cwd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

            # Wait for the child to exit (it runs forever unless killed).
            while child.poll() is None:
                if stop_requested or stop_flag.exists():
                    log("Stopping MCP server...", log_file)
                    child.terminate()
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        child.kill()
                    break
                time.sleep(0.25)

            if stop_requested or stop_flag.exists():
                break

            code = child.returncode
            attempt += 1
            delay = min(30, 1 * (2 ** (attempt - 1)))
            log(f"MCP server exited unexpectedly (code={code}); "
                f"restarting in {delay}s", log_file)
            time.sleep(delay)
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
        try:
            pid_file.unlink(missing_ok=True)
        except Exception:
            pass
        try:
            state_file.unlink(missing_ok=True)
        except Exception:
            pass
        try:
            lock_file.unlink(missing_ok=True)
        except Exception:
            pass
        log("Supervisor exited", log_file)


if __name__ == "__main__":
    main()
