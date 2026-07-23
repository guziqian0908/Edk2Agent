---
name: edk2-pr-workflow
description: Production-grade EDK II PR automation. Two core capabilities: 1) Create PR from Issue, 2) Update PR from review comments. Loads official template, enforces English titles, validates PatchCheck.
---

# EDK II Automated PR Workflow Skill (Production)

End-to-end automation for creating and updating EDK II Pull Requests, following TianoCore community standards.

## Two Core Capabilities

### 1. Create PR from Issue

```powershell
.\create-pr.ps1 -IssueUrl "https://github.com/tianocore/edk2/issues/12766"
```

**Workflow:**
```
Issue URL → Parse Issue → Fork Check → Branch Create → Fix Apply → Build → Commit → PatchCheck → Push → Create PR
```

### 2. Update PR from Review Comments

```powershell
.\update-pr.ps1 -PrUrl "https://github.com/tianocore/edk2/pull/12841"
```

**Workflow:**
```
PR URL → Fetch PR Info → Get Comments → Analyze Feedback → Apply Fixes → Build → Amend Commit → Force Push
```

## Key Features

- **Official PR Template**: Loads and preserves tianocore/edk2 PR template structure
- **Template Preservation**: Only removes `<_..._>` placeholders, keeps all sections
- **English-Only Titles**: Automatic rejection of non-English commit titles
- **BOM-Free Commits**: Uses UTF-8 without BOM to avoid PatchCheck failures
- **Format Validation**: Auto-trims package names, ensures correct title format
- **DCO Compliance**: Signed-off-by in commit ONLY, not duplicated in PR body
- **Auto Fork**: Automatically forks upstream if user doesn't have one
- **Cross-Platform Build**: Supports Windows (VS) and Linux (GCC)
- **Commit Validation**: Title length ≤76 chars, PatchCheck verification
- **Maintainer Matching**: Auto-finds reviewers from Maintainers.txt
- **Old PR Recovery**: Detects invalid template, offers rebuild workflow

## Workflow Overview

```
Issue URL → Prerequisites → Fork Check → Issue Parse → Branch Create → Fix Apply → Build → Commit → PatchCheck → Push → Create PR (Template) → Add Reviewers
```

## Official PR Template Structure

The skill loads and preserves the official tianocore PR template:

```markdown
# Description

- [ ] Breaking change?
- [ ] Impacts security?
- [ ] Includes tests?

## How This Was Tested

## Integration Instructions

Fixes: https://github.com/tianocore/edk2/issues/{number}
```

### Template Processing

1. **Load Template**: Fetches official template from repository
2. **Remove Placeholders**: Deletes all `<_..._>` placeholder lines
3. **Preserve Structure**: Keeps all section headers and checkboxes
4. **Fill Sections**:
   - Description: Commit message content
   - How This Was Tested: Auto-generated build info
   - Integration Instructions: "N/A" (default)
5. **Add Fixes Link**: Single link at bottom only

### Important: Signed-off-by Placement

- **In Commit**: ✅ Required (DCO compliance)
- **In PR Body**: ❌ NOT included (avides duplication)

Example commit:
```
EmulatorPkg: Fix transposed ConOut row/column in PlatformBmLib

The ConOutRow and ConOutColumn settings...

Fixes: https://github.com/tianocore/edk2/issues/12766
Signed-off-by: Your Name <your.email@example.com>
```

Example PR body:
```markdown
# Description

EmulatorPkg: Fix transposed ConOut row/column in PlatformBmLib

The ConOutRow and ConOutColumn settings...

- [ ] Breaking change?
- [ ] Impacts security?
- [ ] Includes tests?

## How This Was Tested

Built on Windows with VS2022 toolchain.

**Package:** EmulatorPkg
**Toolchain:** VS2022
**Architecture:** X64

## Integration Instructions

N/A

Fixes: https://github.com/tianocore/edk2/issues/12766
```

## Usage

### Basic Usage

```powershell
.\create-pr.ps1 -IssueUrl "https://github.com/tianocore/edk2/issues/12766"
```

### Skip Build (Testing)

```powershell
.\create-pr.ps1 -IssueUrl "https://github.com/tianocore/edk2/issues/12766" -SkipBuild
```

### Create Draft PR

```powershell
.\create-pr.ps1 -IssueUrl "https://github.com/tianocore/edk2/issues/12766" -Draft
```

### Force New PR (Close Old)

```powershell
.\create-pr.ps1 -IssueUrl "https://github.com/tianocore/edk2/issues/12766" -ForceNewPr
```

## English-Only Title Enforcement

The skill automatically rejects commits with non-English titles:

```
COMMIT REJECTED: Title contains Chinese characters. Commit title must be in English for PatchCheck compliance.
```

**Valid Examples:**
- `EmulatorPkg: Fix transposed ConOut row/column in PlatformBmLib`
- `OvmfPkg: Correct memory alignment in QemuBootOrder`
- `MdeModulePkg: Update device path handling`

**Invalid Examples (Rejected):**
- `EmulatorPkg: 修复控制台参数错误` (Chinese characters)
- `OvmfPkg: 修正内存对齐问题` (Chinese characters)

## Old PR Recovery

If an existing PR has invalid template structure:

1. **Detect**: Validates PR body against template requirements
2. **Report**: Lists missing sections
3. **Close**: Optionally closes old PR with comment
4. **Recreate**: Creates new PR with proper template

```
[Step 6/11] Checking for existing PR...
  Found existing PR #XXXXX
  Existing PR has invalid template structure
  Missing sections: # Description, ## How This Was Tested
  Closing old PR...
  PR #XXXXX closed successfully
  Creating new branch...
```

## Commit Message Standards

### Title Format

```
{Package}: {Brief description}
```

### Title Constraints

- **Length**: ≤76 characters
- **Language**: English only (non-ASCII rejected)
- **Format**: `{Package}: {Description}`
- **NO BOM**: Commit message files must be UTF-8 without BOM (PatchCheck requirement)
- **NO extra spaces**: Package name must be trimmed, no space before colon

### Format Validation

The skill automatically enforces these rules to prevent PatchCheck failures:

1. **Package name trimming**: Removes trailing whitespace from package names
2. **BOM-free encoding**: Uses UTF-8 without BOM for commit message files
3. **English-only check**: Rejects non-ASCII characters in titles

**Common Pitfall:**
PowerShell's `Out-File -Encoding utf8` adds BOM in PowerShell 5.1, causing PatchCheck failures.
This skill uses `[System.IO.File]::WriteAllText()` with UTF-8 encoding (no BOM) instead.

### Full Format

```
EmulatorPkg: Fix transposed ConOut row/column in PlatformBmLib

The ConOutRow and ConOutColumn settings in SetupVariable were
incorrectly initialized with swapped PCD values. This caused
setup resolution to remain incorrect when overriding PCD values.

Fix the variable assignments to use the correct PCD values:
- ConOutRow should use PcdConOutRow
- ConOutColumn should use PcdConOutColumn

Fixes: https://github.com/tianocore/edk2/issues/12766
Signed-off-by: John Doe <john@example.com>
```

## Branch Naming

**Pattern:** `fix/{Package}-{brief-description}-issue{number}`

Examples:
- `fix/EmulatorPkg-transposed-console-args-issue12766`
- `fix/OvmfPkg-memory-alignment-error-issue12345`

## Output Summary

```
========================================
EXECUTION COMPLETE
========================================
Issue:           https://github.com/tianocore/edk2/issues/12766
Package:         EmulatorPkg
Branch:          fix/EmulatorPkg-...-issue12766
Branch URL:      https://github.com/{user}/edk2/tree/fix/...
Commit ID:       abc123def456...
Short Commit:    abc123d
PR URL:          https://github.com/tianocore/edk2/pull/XXXXX
PR Number:       #XXXXX
PatchCheck:      PASSED
Build:           PASSED
Template Valid:  True
Reviewers:       reviewer@example.com
Draft:           False
Log File:        edk2-pr-20260722-133000.log
========================================
```

## Cross-Platform Support

### Windows

- Uses Visual Studio 2019/2022
- Auto-detects via vswhere
- Toolchain: VS2022/VS2019

### Linux

- Uses GCC5 toolchain
- Requires: gcc, nasm, build-essential
- Runs edksetup.sh

## Error Handling

### Non-English Title

```
COMMIT REJECTED: Title contains Chinese characters. Commit title must be in English for PatchCheck compliance.
```

### Title Too Long

```
Commit title too long (142 chars), truncating to 76
Truncated: EmulatorPkg: This is a very long commit title that exceeds the 76 charact... (76 chars)
```

### Invalid Template Detected

```
Existing PR has invalid template structure
Missing sections: # Description, ## How This Was Tested
```

## Files

| File | Purpose |
|------|---------|
| `create-pr.ps1` | Main automation script |
| `PrTemplateHandler.psm1` | PR template processing module |
| `test-production.ps1` | Production test suite |
| `SKILL.md` | This documentation |

## Test Results

```
========================================
Test Summary
========================================
  TemplateLoading : PASS
  PlaceholderRemoval : PASS
  EnglishTitleValidation : PASS
  PrBodyGeneration : PASS
  TemplateStructureValidation : PASS
  AutoTestDescription : PASS
  TitleLengthValidation : PASS

Total: 7/7 tests passed
========================================
```

## Constraints

1. **Fork Workflow** - Never commits to upstream directly
2. **Fixes Tag** - Uses `Fixes:` for GitHub auto-linking
3. **Title Length** - ≤76 characters, auto-truncated
4. **English Only** - Non-English titles rejected
5. **Signed-off-by** - In commit ONLY, not in PR body
6. **Template Structure** - Preserved, placeholders removed

## PR Update Workflow

### Reading PR Comments

```powershell
.\update-pr.ps1 -PrUrl "https://github.com/tianocore/edk2/pull/12841"
```

### Update Workflow Steps

1. **Fetch PR Info** - Gets PR number, branch, fork owner
2. **Get Comments** - Fetches review comments and issue comments
3. **Analyze Feedback** - Detects actionable review feedback
4. **Checkout Branch** - Checks out PR branch from fork
5. **Apply Fixes** - Modifies code based on comments
6. **Build** - Verifies changes compile
7. **Amend Commit** - Updates commit with fixes
8. **Force Push** - Updates existing PR

### Comment Analysis

The script detects:
- `update.*comment` - Requests to add/update comments
- `please.*change` - Requests for code changes
- `should.*be` - Suggestions for improvements
- `fix` - Bug fix requests

### Example: lgao4's Comment on PR #12841

**Comment:** "Please update the comments to describe the value from PCD"

**Action:**
```c
// BEFORE:
SystemConfigData.ConOutRow = PcdGet32 (PcdConOutRow);

// AFTER:
// Read ConOutRow value from PCD
SystemConfigData.ConOutRow = PcdGet32 (PcdConOutRow);
```

### Update Output

```
========================================
PR UPDATE COMPLETE
========================================
PR:              https://github.com/tianocore/edk2/pull/12841
PR Number:       #12841
Branch:          fix/emulator-conout-transpose-12766
Action Items:    1
Commit ID:       abc123def456...
Short Commit:    abc123d
Log File:        edk2-pr-update-20260722.log
========================================
```

## Files

| File | Purpose |
|------|---------|
| `create-pr.ps1` | Create new PR from Issue |
| `update-pr.ps1` | Update existing PR from comments |
| `PrTemplateHandler.psm1` | PR template processing module |
| `test-production.ps1` | Production test suite |
| `SKILL.md` | This documentation |

## Test Results

```
========================================
Test Summary
========================================
  TemplateLoading : PASS
  PlaceholderRemoval : PASS
  EnglishTitleValidation : PASS
  PrBodyGeneration : PASS
  TemplateStructureValidation : PASS
  AutoTestDescription : PASS
  TitleLengthValidation : PASS

Total: 7/7 tests passed
========================================
```

## References

- [EDK II Development Process](https://www.tianocore.org/tianocore-wiki.github.io/development/contribution-guides/edk_ii_development_process.html)
- [PR Template](https://github.com/tianocore/edk2/blob/master/.github/pull_request_template.md)
- [Maintainers.txt](https://github.com/tianocore/edk2/blob/master/Maintainers.txt)