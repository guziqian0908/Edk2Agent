# EDK II Automated PR Workflow Skill

End-to-end automation for creating compliant EDK II Pull Requests from GitHub Issues.

## Features

- **Issue Parsing**: Automatically extract issue details (package, type, description)
- **Fork Workflow**: Proper git workflow using personal fork (never commits to upstream)
- **Code Fix**: Apply bug-specific fixes with pattern matching
- **Build Verification**: Compile affected package to validate fix
- **Commit Standards**: Compliant commit messages per EDK II standards
- **PR Creation**: Clean PR body to avoid tianocore-pr-automation format errors
- **Logging**: Complete execution log for audit trail

## Prerequisites

1. **GitHub CLI (`gh`)** - Authenticated
   ```powershell
   gh auth login
   ```

2. **Git** - Configured with name/email
   ```powershell
   git config --global user.name "Your Name"
   git config --global user.email "your.email@example.com"
   ```

3. **Fork of tianocore/edk2** - Your personal fork

4. **Python 3.x** - For PatchCheck.py

5. **Visual Studio Build Tools** - For compilation

## Quick Start

```powershell
# Navigate to skill directory
cd D:\project-review-test\.opencode\skills\edk2-pr-workflow

# Run for Issue #12766
.\create-pr.ps1 -IssueUrl "https://github.com/tianocore/edk2/issues/12766"
```

## Usage

### Basic Usage

```powershell
.\create-pr.ps1 -IssueUrl "https://github.com/tianocore/edk2/issues/12766"
```

### Skip Build Verification

```powershell
.\create-pr.ps1 -IssueUrl "https://github.com/tianocore/edk2/issues/12766" -SkipBuild
```

### Create Draft PR

```powershell
.\create-pr.ps1 -IssueUrl "https://github.com/tianocore/edk2/issues/12766" -Draft
```

### Custom EDK2 Path

```powershell
.\create-pr.ps1 -IssueUrl "https://github.com/tianocore/edk2/issues/12766" -Edk2Path "D:\code\edk2"
```

## Workflow Steps

1. **Parse Issue** - Extract number, title, package, type from URL
2. **Sync Fork** - Fetch upstream, sync local master
3. **Create Branch** - `fix/{package}-{description}-issue{number}`
4. **Apply Fix** - Pattern-based code modification
5. **Build Verify** - Compile affected package
6. **Create Commit** - Compliant message with Signed-off-by
7. **Run PatchCheck** - Verify commit format
8. **Push to Fork** - Push branch to personal fork
9. **Create PR** - Clean PR body with proper formatting

## Output

```
========================================
EXECUTION COMPLETE
========================================
Issue:        https://github.com/tianocore/edk2/issues/12766
Branch:       fix/EmulatorPkg-transposed-console-args-issue12766
Branch URL:   https://github.com/{user}/edk2/tree/fix/EmulatorPkg-transposed-console-args-issue12766
Commit ID:    abc123def456...
Short Commit: abc123d
PR URL:       https://github.com/tianocore/edk2/pull/XXXXX
PR Number:    #XXXXX
Log File:     edk2-pr-20260722-133000.log
========================================
```

## Commit Format

Follows EDK II standards:

```
{Package}: {Brief description}

{Detailed explanation}

Fixes: https://github.com/tianocore/edk2/issues/{number}
Signed-off-by: {Name} <{email}>
```

Example:
```
EmulatorPkg: Fix transposed ConOut row/column in PlatformBmLib

The ConOutRow and ConOutColumn settings in SetupVariable were
incorrectly initialized with swapped PCD values. This caused
setup resolution to remain incorrect when overriding PCD values.

Fixes: https://github.com/tianocore/edk2/issues/12766
Signed-off-by: John Doe <john@example.com>
```

## PR Body Format

Clean, complete description without template placeholders:

```markdown
## Description

{What was changed}

## Problem

{What was wrong}

## Solution

{How it was fixed}

## Testing

{How it was tested}

## Related Issue

Fixes {issue_url}
```

## Branch Naming

Pattern: `fix/{package}-{brief-description}-issue{number}`

Examples:
- `fix/EmulatorPkg-transposed-console-args-issue12766`
- `fix/OvmfPkg-memory-alignment-issue12345`
- `fix/MdeModulePkg-null-pointer-issue67890`

## Configuration

Copy `config-template.ps1` to `edk2-pr-config.ps1` and customize:

```powershell
$env:GITHUB_USER = "your-username"
$GitUserName = "Your Name"
$GitUserEmail = "your.email@example.com"
```

## Adding New Issue Fixes

Edit `create-pr.ps1` and add to `Get-FixInfo` function:

```powershell
switch ($Issue.Number) {
    12766 {
        # Existing fix...
    }
    12345 {
        return @{
            Files = @("OvmfPkg/SomeFile.c")
            BranchName = "fix/OvmfPkg-some-fix-issue12345"
            CommitTitle = "OvmfPkg: Fix some issue"
            CommitBody = "Description..."
            PrBody = "..."
        }
    }
    default {
        throw "No fix template for issue #$($Issue.Number)"
    }
}
```

## Constraints

1. **Fork Workflow Only** - Never commits to upstream directly
2. **Issue Link Consistency** - Commit must reference exact issue number
3. **PR Body vs Comments** - PR Body is the description (not comments)
4. **Clean Template** - No placeholder text in PR body
5. **Signed-off-by Required** - Always include DCO signature

## Troubleshooting

### gh auth error
```
Run: gh auth login
```

### Branch already exists
```powershell
git branch -D fix/EmulatorPkg-transposed-console-args-issue12766
git push origin --delete fix/EmulatorPkg-transposed-console-args-issue12766
```

### Build fails
Check error logs, fix code, retry

### PatchCheck fails
Fix commit message format, amend:
```powershell
git commit --amend
```

### PR creation fails
Verify:
- `gh auth status`
- Fork exists
- Branch pushed

## Files

| File | Purpose |
|------|---------|
| `SKILL.md` | Skill documentation |
| `create-pr.ps1` | Main automation script |
| `EXAMPLES.md` | Usage examples |
| `config-template.ps1` | Configuration template |
| `README.md` | This file |

## Reference

- [EDK II Development Process](https://www.tianocore.org/tianocore-wiki.github.io/development/contribution-guides/edk_ii_development_process.html)
- [Commit Message Format](https://github.com/tianocore/edk2/blob/master/BaseTools/Scripts/PatchCheck.py)
- [GitHub & PR Tips](https://github.com/tianocore/tianocore.github.io/wiki/GitHub-PR-Tips)