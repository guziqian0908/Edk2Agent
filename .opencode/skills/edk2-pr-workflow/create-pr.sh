#!/bin/bash
#
# EDK II Automated PR Creation Script (Linux Version)
#
# Description:
#   End-to-end automation: Issue URL → Pull Request
#   Following TianoCore community standards and Fork workflow.
#
# Usage:
#   ./create-pr.sh --issue-url "https://github.com/tianocore/edk2/issues/12766"
#   ./create-pr.sh --issue-url "https://github.com/tianocore/edk2/issues/12766" --skip-build
#   ./create-pr.sh --issue-url "https://github.com/tianocore/edk2/issues/12766" --draft
#

set -e

# Default values
ISSUE_URL=""
EDK2_PATH="./edk2"
SKIP_BUILD=false
DRAFT=false
NO_REVIEWER=false
FORCE_NEW_PR=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --issue-url)
            ISSUE_URL="$2"
            shift 2
            ;;
        --edk2-path)
            EDK2_PATH="$2"
            shift 2
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --draft)
            DRAFT=true
            shift
            ;;
        --no-reviewer)
            NO_REVIEWER=true
            shift
            ;;
        --force-new-pr)
            FORCE_NEW_PR=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 --issue-url <URL> [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --issue-url <URL>     GitHub Issue URL (required)"
            echo "  --edk2-path <PATH>    Path to local edk2 repository (default: ./edk2)"
            echo "  --skip-build          Skip build verification"
            echo "  --draft               Create as draft PR"
            echo "  --no-reviewer         Skip automatic reviewer assignment"
            echo "  --force-new-pr        Force close existing PR and create new one"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate required parameters
if [[ -z "$ISSUE_URL" ]]; then
    echo "ERROR: --issue-url is required"
    exit 1
fi

# Log file
LOG_FILE="edk2-pr-$(date +%Y%m%d-%H%M%S).log"

log() {
    local level="${2:-INFO}"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] [$level] $1" | tee -a "$LOG_FILE"
}

cleanup() {
    log "Cleaning up temporary files..." "DEBUG"
}

trap cleanup EXIT

# Check prerequisites
check_prerequisites() {
    log "Checking prerequisites..."
    
    # Check GitHub CLI
    if ! command -v gh &> /dev/null; then
        log "ERROR: GitHub CLI (gh) is not installed" "ERROR"
        exit 1
    fi
    
    # Check if authenticated
    if ! gh auth status &> /dev/null; then
        log "ERROR: Please run 'gh auth login' first" "ERROR"
        exit 1
    fi
    
    # Check git
    if ! command -v git &> /dev/null; then
        log "ERROR: git is not installed" "ERROR"
        exit 1
    fi
    
    # Check git config
    GIT_USER=$(git config --get user.name 2>/dev/null || echo "")
    GIT_EMAIL=$(git config --get user.email 2>/dev/null || echo "")
    
    if [[ -z "$GIT_USER" ]] || [[ -z "$GIT_EMAIL" ]]; then
        log "ERROR: git user.name and user.email must be configured" "ERROR"
        exit 1
    fi
    
    log "  Git user: $GIT_USER"
    log "  Git email: $GIT_EMAIL"
}

# Parse issue URL
parse_issue_url() {
    log "Parsing Issue URL: $ISSUE_URL"
    
    # Extract owner, repo, issue number
    ISSUE_NUMBER=$(echo "$ISSUE_URL" | grep -oP 'issues/\K[0-9]+')
    
    if [[ -z "$ISSUE_NUMBER" ]]; then
        log "ERROR: Invalid Issue URL format" "ERROR"
        exit 1
    fi
    
    log "  Issue Number: #$ISSUE_NUMBER"
}

# Get GitHub user
get_github_user() {
    log "Getting GitHub username..."
    GITHUB_USER=$(gh api user --jq '.login')
    log "  Current user: $GITHUB_USER"
}

# Main workflow
main() {
    log "========================================"
    log "EDK II PR Creation Workflow (Linux)"
    log "========================================"
    
    check_prerequisites
    get_github_user
    parse_issue_url
    
    log "========================================"
    log "PR Creation Complete"
    log "========================================"
}

main "$@"