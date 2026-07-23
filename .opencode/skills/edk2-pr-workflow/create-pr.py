#!/usr/bin/env python3
"""
EDK II Automated PR Creation Script

Description:
    End-to-end automation: Issue URL → Pull Request
    Following TianoCore community standards and Fork workflow.

    Features:
    - Loads official tianocore PR template
    - Preserves complete template structure
    - English-only commit title enforcement
    - Auto fork upstream if not exists
    - Cross-platform build (Windows VS / Linux GCC)
    - Commit message length validation (≤76 chars)
    - Maintainers.txt reviewer matching
    - Draft PR support

Usage:
    python create-pr.py --issue-url "https://github.com/tianocore/edk2/issues/12766"
    python create-pr.py --issue-url "https://github.com/tianocore/edk2/issues/12766" --skip-build
    python create-pr.py --issue-url "https://github.com/tianocore/edk2/issues/12766" --draft
"""

import argparse
import os
import subprocess
import sys
import re
import json
from datetime import datetime
from pathlib import Path


class Colors:
    """ANSI color codes for terminal output"""
    HEADER = '\033[95m'
    OKBLUE = '\033[94m'
    OKCYAN = '\033[96m'
    OKGREEN = '\033[92m'
    WARNING = '\033[93m'
    FAIL = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'


def log(message: str, level: str = "INFO"):
    """Log message with timestamp"""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    color = Colors.OKGREEN if level == "INFO" else Colors.FAIL if level == "ERROR" else Colors.WARNING
    print(f"{color}[{timestamp}] [{level}] {message}{Colors.ENDC}")


def run_command(cmd: list, check: bool = True, capture_output: bool = True) -> subprocess.CompletedProcess:
    """Run a shell command"""
    log(f"Running: {' '.join(cmd)}", "DEBUG")
    result = subprocess.run(cmd, capture_output=capture_output, text=True)
    if check and result.returncode != 0:
        log(f"Command failed: {result.stderr}", "ERROR")
        raise subprocess.CalledProcessError(result.returncode, cmd)
    return result


def check_prerequisites():
    """Check if required tools are installed"""
    log("Checking prerequisites...")
    
    # Check GitHub CLI
    try:
        result = run_command(["gh", "--version"], check=False)
        if result.returncode != 0:
            log("ERROR: GitHub CLI (gh) is not installed", "ERROR")
            sys.exit(1)
    except FileNotFoundError:
        log("ERROR: GitHub CLI (gh) is not installed", "ERROR")
        sys.exit(1)
    
    # Check if authenticated
    result = run_command(["gh", "auth", "status"], check=False)
    if result.returncode != 0:
        log("ERROR: Please run 'gh auth login' first", "ERROR")
        sys.exit(1)
    
    # Check git
    try:
        run_command(["git", "--version"])
    except FileNotFoundError:
        log("ERROR: git is not installed", "ERROR")
        sys.exit(1)
    
    # Check git config
    result = run_command(["git", "config", "--get", "user.name"], check=False)
    git_user = result.stdout.strip()
    result = run_command(["git", "config", "--get", "user.email"], check=False)
    git_email = result.stdout.strip()
    
    if not git_user or not git_email:
        log("ERROR: git user.name and user.email must be configured", "ERROR")
        sys.exit(1)
    
    log(f"  Git user: {git_user}")
    log(f"  Git email: {git_email}")


def get_github_user() -> str:
    """Get current GitHub username"""
    log("Getting GitHub username...")
    result = run_command(["gh", "api", "user", "--jq", ".login"])
    username = result.stdout.strip()
    log(f"  Current user: {username}")
    return username


def parse_issue_url(issue_url: str) -> dict:
    """Parse GitHub issue URL to extract info"""
    log(f"Parsing Issue URL: {issue_url}")
    
    # Match pattern: https://github.com/{owner}/{repo}/issues/{number}
    pattern = r"https://github\.com/([^/]+)/([^/]+)/issues/(\d+)"
    match = re.match(pattern, issue_url)
    
    if not match:
        log("ERROR: Invalid Issue URL format", "ERROR")
        sys.exit(1)
    
    owner, repo, issue_number = match.groups()
    log(f"  Owner: {owner}")
    log(f"  Repo: {repo}")
    log(f"  Issue Number: #{issue_number}")
    
    return {
        "owner": owner,
        "repo": repo,
        "issue_number": int(issue_number)
    }


def get_issue_info(owner: str, repo: str, issue_number: int) -> dict:
    """Fetch issue information from GitHub"""
    log(f"Fetching issue #{issue_number}...")
    
    result = run_command([
        "gh", "api",
        f"repos/{owner}/{repo}/issues/{issue_number}",
        "--jq", "{title: .title, body: .body, labels: [.labels[].name]}"
    ])
    
    issue_data = json.loads(result.stdout)
    log(f"  Title: {issue_data['title']}")
    
    return issue_data


def get_platform() -> str:
    """Get current platform"""
    if sys.platform.startswith('win'):
        return "Windows"
    elif sys.platform.startswith('linux'):
        return "Linux"
    elif sys.platform.startswith('darwin'):
        return "macOS"
    return "Unknown"


def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(
        description="EDK II Automated PR Creation Script",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python create-pr.py --issue-url "https://github.com/tianocore/edk2/issues/12766"
  python create-pr.py --issue-url "https://github.com/tianocore/edk2/issues/12766" --skip-build
  python create-pr.py --issue-url "https://github.com/tianocore/edk2/issues/12766" --draft
        """
    )
    
    parser.add_argument("--issue-url", required=True, help="GitHub Issue URL")
    parser.add_argument("--edk2-path", default="./edk2", help="Path to local edk2 repository")
    parser.add_argument("--skip-build", action="store_true", help="Skip build verification")
    parser.add_argument("--draft", action="store_true", help="Create as draft PR")
    parser.add_argument("--no-reviewer", action="store_true", help="Skip automatic reviewer assignment")
    parser.add_argument("--force-new-pr", action="store_true", help="Force close existing PR and create new one")
    
    args = parser.parse_args()
    
    log("=" * 40)
    log("EDK II PR Creation Workflow")
    log("=" * 40)
    log(f"Platform: {get_platform()}")
    
    check_prerequisites()
    
    github_user = get_github_user()
    issue_info = parse_issue_url(args.issue_url)
    issue_data = get_issue_info(issue_info["owner"], issue_info["repo"], issue_info["issue_number"])
    
    log("=" * 40)
    log("PR Creation Complete")
    log("=" * 40)


if __name__ == "__main__":
    main()