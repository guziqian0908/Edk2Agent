# EDK II PR Workflow Examples

## Example 1: Basic Usage

```powershell
# Create PR for Issue #12766
.\create-pr.ps1 -IssueUrl "https://github.com/tianocore/edk2/issues/12766"
```

## Example 2: Skip Build Verification

```powershell
# Skip build step (useful for testing or when build env not ready)
.\create-pr.ps1 -IssueUrl "https://github.com/tianocore/edk2/issues/12766" -SkipBuild
```

## Example 3: Create Draft PR

```powershell
# Create as draft PR for initial review
.\create-pr.ps1 -IssueUrl "https://github.com/tianocore/edk2/issues/12766" -Draft
```

## Example 4: Specify Custom EDK2 Path

```powershell
# Use custom edk2 repository location
.\create-pr.ps1 -IssueUrl "https://github.com/tianocore/edk2/issues/12766" -Edk2Path "D:\code\edk2"
```

## Full Workflow Demo (Issue #12766)

### Issue Summary
- **Number:** 12766
- **Title:** [Bug]: Row/column arguments in Console Out are transposed
- **Package:** EmulatorPkg
- **File:** `EmulatorPkg/Library/PlatformBmLib/PlatformBm.c`

### Bug Description
The `ConOutRow` and `ConOutColumn` settings of `SetupVariable` are initialized by `PcdConOutRow` and `PcdConOutColumn` incorrectly (transposed).

### Expected Fix
```c
// BEFORE (Bug):
SystemConfigData.ConOutRow    = PcdGet32 (PcdConOutColumn);  // Wrong!
SystemConfigData.ConOutColumn = PcdGet32 (PcdConOutRow);     // Wrong!

// AFTER (Fix):
SystemConfigData.ConOutRow    = PcdGet32 (PcdConOutRow);     // Correct!
SystemConfigData.ConOutColumn = PcdGet32 (PcdConOutColumn);  // Correct!
```

### Branch Name
```
fix/EmulatorPkg-transposed-console-args-issue12766
```

### Commit Message
```
EmulatorPkg: Fix transposed ConOut row/column in PlatformBmLib

The ConOutRow and ConOutColumn settings in SetupVariable were
incorrectly initialized with swapped PCD values. This caused
setup resolution to remain incorrect when overriding PCD values.

Fix the variable assignments to use the correct PCD values:
- ConOutRow should use PcdConOutRow
- ConOutColumn should use PcdConOutColumn

Fixes: https://github.com/tianocore/edk2/issues/12766
Signed-off-by: Your Name <your.email@example.com>
```

### PR Title
```
EmulatorPkg: Fix transposed ConOut row/column in PlatformBmLib
```

### PR Body (Same as Commit Message)
```
EmulatorPkg: Fix transposed ConOut row/column in PlatformBmLib

The ConOutRow and ConOutColumn settings in SetupVariable were
incorrectly initialized with swapped PCD values. This caused
setup resolution to remain incorrect when overriding PCD values.

Fix the variable assignments to use the correct PCD values:
- ConOutRow should use PcdConOutRow
- ConOutColumn should use PcdConOutColumn

Fixes: https://github.com/tianocore/edk2/issues/12766
Signed-off-by: Your Name <your.email@example.com>
```

> **Note:** PR body now directly reuses the complete commit message text, following community standards. No custom Markdown headers or template placeholders.

## Expected Output

```
========================================
EDK II Automated PR Workflow (Enhanced)
========================================
[2026-07-22 13:30:00] [INFO] [Step 1/10] Checking prerequisites...
[2026-07-22 13:30:01] [INFO]   GitHub CLI authenticated
[2026-07-22 13:30:01] [INFO]   user.name: Your Name
[2026-07-22 13:30:01] [INFO]   user.email: your.email@example.com
[2026-07-22 13:30:01] [INFO]   Username: your-username
[2026-07-22 13:30:02] [INFO] [Step 2/10] Parsing issue...
[2026-07-22 13:30:02] [INFO]   Issue #12766: [Bug]: Row/column arguments in Console Out are transposed
[2026-07-22 13:30:02] [INFO]   Package: emulatorpkg
[2026-07-22 13:30:02] [INFO]   Type: bug
[2026-07-22 13:30:03] [INFO] [Step 3/10] Checking fork...
[2026-07-22 13:30:03] [INFO]   Fork exists: https://github.com/your-username/edk2
[2026-07-22 13:30:04] [INFO] [Step 4/10] Initializing repository...
[2026-07-22 13:30:05] [INFO] [Step 5/10] Preparing fix...
[2026-07-22 13:30:05] [INFO]   Generated branch name: fix/EmulatorPkg-...-issue12766
[2026-07-22 13:30:06] [INFO] [Step 6/10] Applying fix...
[2026-07-22 13:30:07] [INFO]   Fix applied successfully
[2026-07-22 13:30:08] [INFO] [Step 7/10] Building package...
[2026-07-22 13:35:42] [INFO]   Build successful!
[2026-07-22 13:35:43] [INFO] [Step 8/10] Creating commit...
[2026-07-22 13:35:44] [INFO]   Commit created: abc123d
[2026-07-22 13:35:45] [INFO] [Step 9/10] Running PatchCheck...
[2026-07-22 13:35:46] [INFO]   PatchCheck passed
[2026-07-22 13:35:47] [INFO] [Step 10/10] Pushing and creating PR...
[2026-07-22 13:35:48] [INFO]   Branch pushed to: https://github.com/your-username/edk2/tree/fix/...
[2026-07-22 13:35:49] [INFO]   PR created: https://github.com/tianocore/edk2/pull/XXXXX
========================================
EXECUTION COMPLETE
========================================
Issue:           https://github.com/tianocore/edk2/issues/12766
Package:         EmulatorPkg
Branch:          fix/EmulatorPkg-...-issue12766
Branch URL:      https://github.com/your-username/edk2/tree/fix/...
Commit ID:       abc123def456...
Short Commit:    abc123d
PR URL:          https://github.com/tianocore/edk2/pull/XXXXX
PR Number:       #XXXXX
PatchCheck:      PASSED
Build:           PASSED
Reviewers:       reviewer@example.com
Draft:           False
Log File:        edk2-pr-20260722-133000.log
========================================
```