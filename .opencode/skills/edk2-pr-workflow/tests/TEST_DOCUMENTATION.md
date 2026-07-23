# EDK II PR Workflow Test Documentation

This document describes all test cases for the cross-platform PR automation functionality.

## Test Environment

| Platform | Script | Command |
|----------|--------|---------|
| Windows | `tests/windows/run_tests.bat` | `run_tests.bat` |
| Linux | `tests/linux/run_tests.sh` | `./run_tests.sh` |
| All Platforms | `tests/test_pr_workflow.py` | `python test_pr_workflow.py` |

## Running Tests

```bash
# Python (Cross-Platform)
cd .opencode/skills/edk2-pr-workflow/tests
python test_pr_workflow.py

# Windows
tests\windows\run_tests.bat

# Linux
chmod +x tests/linux/run_tests.sh
./tests/linux/run_tests.sh
```

---

## Test Case 1: Commit Title Format Validation

### Purpose
Verify commit title follows EDK II naming conventions.

### Test Scenarios

| ID | Scenario | Input | Expected | Criteria |
|----|----------|-------|----------|----------|
| 1.1 | No extra space before colon | `"EmulatorPkg : Fix"` | FAIL | Contains space before `:` |
| 1.2 | No extra space after colon | `"EmulatorPkg:  Fix"` | FAIL | Double space after `:` |
| 1.3 | Valid format | `"EmulatorPkg: Fix bug"` | PASS | Single space after `:` |
| 1.4 | No UTF-8 BOM | `"\ufeffEmulatorPkg: Fix"` | FAIL | Starts with BOM |
| 1.5 | Title length ≤76 chars | Title > 76 chars | FAIL | Exceeds limit |

### Execution Steps
1. Provide commit title string
2. Check format with regex: `^[A-Za-z]+:\s\S`
3. Verify no leading BOM bytes
4. Count character length

### Pass Criteria
- Title format matches `Package: Description`
- No UTF-8 BOM present
- Length ≤ 76 characters

---

## Test Case 2: Complete PR Generation Flow

### Purpose
Verify automatic generation of Signed-off-by and Fixes tags.

### Test Scenarios

| ID | Scenario | Input | Expected | Criteria |
|----|----------|-------|----------|----------|
| 2.1 | Signed-off-by format | `"Signed-off-by: Name <email>"` | PASS | Matches DCO format |
| 2.2 | Signed-off-by missing email | `"Signed-off-by: Name"` | FAIL | Missing `<email>` |
| 2.3 | Fixes tag format | `"Fixes: https://github.com/.../issues/123"` | PASS | Valid GitHub URL |
| 2.4 | Fixes in PR body | PR body contains `"Fixes:"` | FAIL | Should only be in commit |

### Execution Steps
1. Generate commit message with template
2. Verify Signed-off-by line exists
3. Check Fixes: tag format
4. Ensure PR body has no duplicate Fixes tag

### Pass Criteria
- Commit contains properly formatted Signed-off-by
- Commit contains Fixes: tag linking to Issue
- PR body does NOT contain Signed-off-by or Fixes tags

---

## Test Case 3: Windows/Linux Cross-Platform Adaptation

### Purpose
Verify single Python script works on all platforms.

### Test Scenarios

| ID | Scenario | Platform | Expected | Criteria |
|----|----------|----------|----------|----------|
| 3.1 | Path handling Windows | Windows | `Path("C:\\edk2")` works | pathlib resolves |
| 3.2 | Path handling Linux | Linux | `Path("/home/edk2")` works | pathlib resolves |
| 3.3 | Platform detection | All | Correct OS detected | `sys.platform` valid |
| 3.4 | Python universal | All | `.py` runs on all | Same code works |

### Execution Steps
1. Run test script on Windows
2. Run test script on Linux
3. Compare output consistency
4. Verify path resolution

### Pass Criteria
- Same test passes on Windows and Linux
- pathlib handles both path formats
- Platform detection works correctly

---

## Test Case 4: Blank Line Boundary Validation

### Purpose
Verify blank line between title and body is pure (no trailing whitespace).

### Test Scenarios

| ID | Scenario | Input | Expected | Criteria |
|----|----------|-------|----------|----------|
| 4.1 | Pure blank line | `""` (empty) | PASS | Line is exactly empty |
| 4.2 | Blank line with spaces | `"   "` | FAIL | Contains whitespace |
| 4.3 | Blank line with tab | `"\t"` | FAIL | Contains tab |
| 4.4 | Blank line with mixed | `" \t "` | FAIL | Contains whitespace |

### Execution Steps
1. Split commit message by lines
2. Check line after title (index 1)
3. Verify line equals empty string `""`
4. Reject if line has trailing whitespace

### Pass Criteria
- Blank line must be exactly `""` (zero length)
- No spaces, tabs, or other characters

---

## Test Case 5: Upstream Sync Validation

### Purpose
Verify sync uses rebase instead of merge.

### Test Scenarios

| ID | Scenario | Input | Expected | Criteria |
|----|----------|-------|----------|----------|
| 5.1 | Use rebase command | `git rebase upstream/main` | PASS | Rebase used |
| 5.2 | Avoid merge command | `git merge upstream/main` | FAIL | Should use rebase |
| 5.3 | No merge commit created | Check commit history | PASS | No "Merge branch" |

### Execution Steps
1. Sync with upstream repository
2. Check git log for merge commits
3. Verify linear history
4. Ensure single-parent commits only

### Pass Criteria
- History shows linear commits (no merge)
- All commits have single parent
- Commit messages follow Package: format

---

## Test Results Summary

```
========================================
Test Summary
========================================
  TestCommitTitleFormat: PASS
  TestPRGeneration: PASS
  TestCrossPlatform: PASS
  TestBlankLineBoundary: PASS
  TestUpstreamSync: PASS

Total: 5/5 tests passed
========================================
```

## Troubleshooting

### Python Not Found
- Install Python 3.6+
- Add to PATH

### Import Errors
- Run from tests directory
- Check Python version

### Permission Denied (Linux)
- Run `chmod +x run_tests.sh`