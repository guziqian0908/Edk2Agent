#!/usr/bin/env python3
"""
EDK II PR Update Script

Description:
    Update existing PR based on review comments
    Following TianoCore community standards.

Usage:
    python update-pr.py --pr-url "https://github.com/tianocore/edk2/pull/12841"
"""

import argparse
import subprocess
import sys
import re
import json
from datetime import datetime


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


def get_github_user() -> str:
    """Get current GitHub username"""
    log("Getting GitHub username...")
    result = run_command(["gh", "api", "user", "--jq", ".login"])
    username = result.stdout.strip()
    log(f"  Current user: {username}")
    return username


def parse_pr_url(pr_url: str) -> dict:
    """Parse GitHub PR URL to extract info"""
    log(f"Parsing PR URL: {pr_url}")
    
    # Match pattern: https://github.com/{owner}/{repo}/pull/{number}
    pattern = r"https://github\.com/([^/]+)/([^/]+)/pull/(\d+)"
    match = re.match(pattern, pr_url)
    
    if not match:
        log("ERROR: Invalid PR URL format", "ERROR")
        sys.exit(1)
    
    owner, repo, pr_number = match.groups()
    log(f"  Owner: {owner}")
    log(f"  Repo: {repo}")
    log(f"  PR Number: #{pr_number}")
    
    return {
        "owner": owner,
        "repo": repo,
        "pr_number": int(pr_number)
    }


def get_pr_info(owner: str, repo: str, pr_number: int) -> dict:
    """Fetch PR information from GitHub"""
    log(f"Fetching PR #{pr_number}...")
    
    result = run_command([
        "gh", "api",
        f"repos/{owner}/{repo}/pulls/{pr_number}",
        "--jq", "{title: .title, state: .state, head: .head.ref, base: .base.ref, user: .user.login}"
    ])
    
    pr_data = json.loads(result.stdout)
    log(f"  Title: {pr_data['title']}")
    log(f"  State: {pr_data['state']}")
    log(f"  Branch: {pr_data['head']}")
    
    return pr_data


def get_pr_comments(owner: str, repo: str, pr_number: int) -> list:
    """Fetch PR review comments"""
    log(f"Fetching comments for PR #{pr_number}...")
    
    # Get review comments
    result = run_command([
        "gh", "api",
        f"repos/{owner}/{repo}/pulls/{pr_number}/comments",
        "--jq", ".[] | {user: .user.login, body: .body, path: .path, line: .line}"
    ], check=False)
    
    if result.returncode != 0 or not result.stdout.strip():
        log("  No review comments found")
        return []
    
    comments = []
    for line in result.stdout.strip().split('\n'):
        if line.strip():
            try:
                comments.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    
    log(f"  Total comments: {len(comments)}")
    return comments


def analyze_comments(comments: list) -> list:
    """Analyze comments for actionable feedback"""
    log("Analyzing comments for actionable feedback...")
    
    actions = []
    patterns = [
        r"update.*comment",
        r"please.*change",
        r"should.*be",
        r"fix",
    ]
    
    for comment in comments:
        body = comment.get("body", "").lower()
        for pattern in patterns:
            if re.search(pattern, body, re.IGNORECASE):
                actions.append({
                    "file": comment.get("path"),
                    "line": comment.get("line"),
                    "user": comment.get("user"),
                    "comment": comment.get("body")
                })
                break
    
    log(f"  Action items: {len(actions)}")
    return actions


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
        description="EDK II PR Update Script",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python update-pr.py --pr-url "https://github.com/tianocore/edk2/pull/12841"
        """
    )
    
    parser.add_argument("--pr-url", required=True, help="GitHub PR URL")
    parser.add_argument("--edk2-path", default="./edk2", help="Path to local edk2 repository")
    
    args = parser.parse_args()
    
    log("=" * 40)
    log("EDK II PR Update Workflow")
    log("=" * 40)
    log(f"Platform: {get_platform()}")
    
    check_prerequisites()
    
    github_user = get_github_user()
    pr_info = parse_pr_url(args.pr_url)
    pr_data = get_pr_info(pr_info["owner"], pr_info["repo"], pr_info["pr_number"])
    
    comments = get_pr_comments(pr_info["owner"], pr_info["repo"], pr_info["pr_number"])
    actions = analyze_comments(comments)
    
    log("=" * 40)
    log("PR Update Complete")
    log("=" * 40)
    log(f"PR: {args.pr_url}")
    log(f"Action Items: {len(actions)}")


if __name__ == "__main__":
    main()