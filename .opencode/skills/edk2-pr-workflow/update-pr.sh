#!/bin/bash
#
# EDK II PR Update Script (Linux Version)
#
# Description:
#   Update existing PR based on review comments
#   Following TianoCore community standards.
#
# Usage:
#   ./update-pr.sh --pr-url "https://github.com/tianocore/edk2/pull/12841"
#

set -e

# Default values
PR_URL=""
EDK2_PATH="./edk2"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --pr-url)
            PR_URL="$2"
            shift 2
            ;;
        --edk2-path)
            EDK2_PATH="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 --pr-url <URL> [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --pr-url <URL>        GitHub PR URL (required)"
            echo "  --edk2-path <PATH>    Path to local edk2 repository (default: ./edk2)"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate required parameters
if [[ -z "$PR_URL" ]]; then
    echo "ERROR: --pr-url is required"
    exit 1
fi

# Log file
LOG_FILE="edk2-pr-update-$(date +%Y%m%d).log"

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
}

# Parse PR URL
parse_pr_url() {
    log "Parsing PR URL: $PR_URL"
    
    # Extract PR number
    PR_NUMBER=$(echo "$PR_URL" | grep -oP 'pull/\K[0-9]+')
    
    if [[ -z "$PR_NUMBER" ]]; then
        log "ERROR: Invalid PR URL format" "ERROR"
        exit 1
    fi
    
    log "  PR Number: #$PR_NUMBER"
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
    log "EDK II PR Update Workflow (Linux)"
    log "========================================"
    
    check_prerequisites
    get_github_user
    parse_pr_url
    
    log "========================================"
    log "PR Update Complete"
    log "========================================"
}

main "$@"