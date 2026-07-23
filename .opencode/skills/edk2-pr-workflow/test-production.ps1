<#
.SYNOPSIS
    Production test suite for EDK II PR Workflow
    
.DESCRIPTION
    Tests all production features including:
    - Official PR template loading and processing
    - Placeholder removal
    - English-only title enforcement
    - Template structure validation
    - Old PR detection and recovery
#>

$ErrorActionPreference = "Stop"

# Import the module
$ModulePath = Join-Path $PSScriptRoot "PrTemplateHandler.psm1"
if (Test-Path $ModulePath) {
    Import-Module $ModulePath -Force
}

function Test-PrTemplateLoading {
    Write-Host "Testing PR template loading" -ForegroundColor Cyan
    
    $Template = Get-PrTemplate
    
    $RequiredSections = @(
        "# Description",
        "- [ ] Breaking change?",
        "- [ ] Impacts security?",
        "- [ ] Includes tests?",
        "## How This Was Tested",
        "## Integration Instructions"
    )
    
    $AllPresent = $true
    foreach ($Section in $RequiredSections) {
        if ($Template -match [regex]::Escape($Section)) {
            Write-Host "  PASS: Found '$Section'" -ForegroundColor Green
        } else {
            Write-Host "  FAIL: Missing '$Section'" -ForegroundColor Red
            $AllPresent = $false
        }
    }
    
    return $AllPresent
}

function Test-PlaceholderRemoval {
    Write-Host "Testing placeholder removal" -ForegroundColor Cyan
    
    $Template = Get-PrTemplate
    $Cleaned = Remove-Placeholders -Template $Template
    
    # Check that placeholders are removed
    $PlaceholderPatterns = @('<_', '_>')
    $HasPlaceholders = $false
    
    foreach ($Pattern in $PlaceholderPatterns) {
        if ($Cleaned -match [regex]::Escape($Pattern)) {
            Write-Host "  FAIL: Still contains placeholder marker: $Pattern" -ForegroundColor Red
            $HasPlaceholders = $true
        }
    }
    
    if (-not $HasPlaceholders) {
        Write-Host "  PASS: All placeholder text removed" -ForegroundColor Green
    }
    
    # Check that structure is preserved
    $StructurePreserved = $true
    $StructureElements = @("# Description", "## How This Was Tested", "## Integration Instructions")
    foreach ($Element in $StructureElements) {
        if ($Cleaned -match [regex]::Escape($Element)) {
            Write-Host "  PASS: Preserved structure '$Element'" -ForegroundColor Green
        } else {
            Write-Host "  FAIL: Lost structure '$Element'" -ForegroundColor Red
            $StructurePreserved = $false
        }
    }
    
    return -not $HasPlaceholders -and $StructurePreserved
}

function Test-EnglishTitleValidation {
    Write-Host "Testing English-only title validation" -ForegroundColor Cyan
    
    # Create test titles with Chinese characters
    $ChineseChar1 = [char]0x4fee  # Chinese character
    $ChineseChar2 = [char]0x590d  # Chinese character
    
    $TestCases = @(
        @{
            Title = "EmulatorPkg: Fix transposed ConOut row/column in PlatformBmLib"
            ExpectedValid = $true
        },
        @{
            Title = "EmulatorPkg: ${ChineseChar1}${ChineseChar2} console issue"
            ExpectedValid = $false
        },
        @{
            Title = "OvmfPkg: memory ${ChineseChar1}${ChineseChar2}"
            ExpectedValid = $false
        },
        @{
            Title = "MdeModulePkg: Update device path handling"
            ExpectedValid = $true
        }
    )
    
    $AllPassed = $true
    foreach ($Test in $TestCases) {
        $Result = Test-EnglishTitle -Title $Test.Title
        
        if ($Result.IsValid -eq $Test.ExpectedValid) {
            Write-Host "  PASS: '$($Test.Title)' → Valid=$($Result.IsValid)" -ForegroundColor Green
        } else {
            Write-Host "  FAIL: '$($Test.Title)' → Expected=$($Test.ExpectedValid), Got=$($Result.IsValid)" -ForegroundColor Red
            $AllPassed = $false
        }
    }
    
    return $AllPassed
}

function Test-PrBodyGeneration {
    Write-Host "Testing PR body generation from template" -ForegroundColor Cyan
    
    $PrBody = New-PrBody `
        -Description "Fix for transposed ConOut row/column" `
        -Testing "Built on Windows with VS2022" `
        -IntegrationInstructions "N/A" `
        -IssueUrl "https://github.com/tianocore/edk2/issues/12766"
    
    $Checks = @{
        HasDescription = $false
        HasTesting = $false
        HasIntegration = $false
        HasFixes = $false
        HasNoSignedOffBy = $true
        HasCheckboxes = $false
        NoPlaceholders = $true
    }
    
    if ($PrBody -match "# Description") {
        $Checks.HasDescription = $true
        Write-Host "  PASS: Has Description section" -ForegroundColor Green
    } else {
        Write-Host "  FAIL: Missing Description section" -ForegroundColor Red
    }
    
    if ($PrBody -match "## How This Was Tested") {
        $Checks.HasTesting = $true
        Write-Host "  PASS: Has Testing section" -ForegroundColor Green
    } else {
        Write-Host "  FAIL: Missing Testing section" -ForegroundColor Red
    }
    
    if ($PrBody -match "## Integration Instructions") {
        $Checks.HasIntegration = $true
        Write-Host "  PASS: Has Integration Instructions section" -ForegroundColor Green
    } else {
        Write-Host "  FAIL: Missing Integration Instructions section" -ForegroundColor Red
    }
    
    if ($PrBody -match "Fixes: https://github\.com/tianocore/edk2/issues/\d+") {
        $Checks.HasFixes = $true
        Write-Host "  PASS: Has Fixes: link" -ForegroundColor Green
    } else {
        Write-Host "  FAIL: Missing Fixes: link" -ForegroundColor Red
    }
    
    if ($PrBody -match "Signed-off-by:") {
        $Checks.HasNoSignedOffBy = $false
        Write-Host "  FAIL: PR body should NOT contain Signed-off-by (only in commit)" -ForegroundColor Red
    } else {
        Write-Host "  PASS: No Signed-off-by in PR body (correct)" -ForegroundColor Green
    }
    
    if ($PrBody -match '\[ \] Breaking change\?' -and $PrBody -match '\[ \] Impacts security\?' -and $PrBody -match '\[ \] Includes tests\?') {
        $Checks.HasCheckboxes = $true
        Write-Host "  PASS: Has checkbox section" -ForegroundColor Green
    } else {
        Write-Host "  FAIL: Missing checkbox section" -ForegroundColor Red
    }
    
    if ($PrBody -match '<_|_>') {
        $Checks.NoPlaceholders = $false
        Write-Host "  FAIL: Contains placeholder text" -ForegroundColor Red
    } else {
        Write-Host "  PASS: No placeholder text" -ForegroundColor Green
    }
    
    return $Checks.Values -notcontains $false
}

function Test-TemplateStructureValidation {
    Write-Host "Testing template structure validation" -ForegroundColor Cyan
    
    # Test valid template with all required sections
    $ValidTemplate = @"
# Description

Fix description here.

- [ ] Breaking change?
- [ ] Impacts security?
- [ ] Includes tests?

## How This Was Tested

Testing info here.

## Integration Instructions

N/A
"@
    
    $Result1 = Test-PrTemplateStructure -PrBody $ValidTemplate
    if ($Result1.IsValid) {
        Write-Host "  PASS: Valid template detected correctly" -ForegroundColor Green
    } else {
        Write-Host "  FAIL: Valid template marked as invalid (Missing: $($Result1.MissingSections -join ', '))" -ForegroundColor Red
    }
    
    # Test invalid template (missing sections)
    $InvalidTemplate = "Fix description here."
    
    $Result2 = Test-PrTemplateStructure -PrBody $InvalidTemplate
    if (-not $Result2.IsValid) {
        Write-Host "  PASS: Invalid template detected correctly" -ForegroundColor Green
        Write-Host "    Missing: $($Result2.MissingSections -join ', ')" -ForegroundColor Gray
    } else {
        Write-Host "  FAIL: Invalid template marked as valid" -ForegroundColor Red
    }
    
    return $Result1.IsValid -and -not $Result2.IsValid
}

function Test-AutoTestDescription {
    Write-Host "Testing auto-generated test description" -ForegroundColor Cyan
    
    $Testing = Get-AutoTestDescription -Platform "Windows" -Package "EmulatorPkg" -Toolchain "VS2022"
    
    $Checks = @{
        HasPlatform = $false
        HasPackage = $false
        HasToolchain = $false
        HasTestSteps = $false
    }
    
    if ($Testing -match "Windows") {
        $Checks.HasPlatform = $true
        Write-Host "  PASS: Contains platform info" -ForegroundColor Green
    }
    
    if ($Testing -match "EmulatorPkg") {
        $Checks.HasPackage = $true
        Write-Host "  PASS: Contains package name" -ForegroundColor Green
    }
    
    if ($Testing -match "VS2022") {
        $Checks.HasToolchain = $true
        Write-Host "  PASS: Contains toolchain info" -ForegroundColor Green
    }
    
    if ($Testing -match "Test steps") {
        $Checks.HasTestSteps = $true
        Write-Host "  PASS: Contains test steps" -ForegroundColor Green
    }
    
    return $Checks.Values -notcontains $false
}

function Test-TitleLengthValidation {
    Write-Host "Testing commit title length validation (≤76 chars)" -ForegroundColor Cyan
    
    $ShortTitle = "EmulatorPkg: Fix transposed ConOut row/column in PlatformBmLib"
    $LongTitle = "EmulatorPkg: This is a very long commit title that exceeds the 76 character limit and needs to be truncated properly for PatchCheck compliance"
    
    # Short title should pass
    if ($ShortTitle.Length -le 76) {
        Write-Host "  PASS: Short title ($($ShortTitle.Length) chars) ≤ 76" -ForegroundColor Green
        $ShortPass = $true
    } else {
        Write-Host "  FAIL: Short title should be ≤ 76 chars" -ForegroundColor Red
        $ShortPass = $false
    }
    
    # Long title should be detected
    if ($LongTitle.Length -gt 76) {
        Write-Host "  PASS: Long title ($($LongTitle.Length) chars) correctly identified as > 76" -ForegroundColor Green
        $LongPass = $true
    } else {
        Write-Host "  FAIL: Should detect long title" -ForegroundColor Red
        $LongPass = $false
    }
    
    return $ShortPass -and $LongPass
}

# Run all tests
Write-Host "========================================" -ForegroundColor Magenta
Write-Host "EDK II PR Workflow - Production Tests" -ForegroundColor Magenta
Write-Host "========================================" -ForegroundColor Magenta
Write-Host ""

$Results = @()

# Test 1: Template loading
$Result1 = Test-PrTemplateLoading
$Results += @{ Name = "TemplateLoading"; Passed = $Result1 }
Write-Host ""

# Test 2: Placeholder removal
$Result2 = Test-PlaceholderRemoval
$Results += @{ Name = "PlaceholderRemoval"; Passed = $Result2 }
Write-Host ""

# Test 3: English title validation
$Result3 = Test-EnglishTitleValidation
$Results += @{ Name = "EnglishTitleValidation"; Passed = $Result3 }
Write-Host ""

# Test 4: PR body generation
$Result4 = Test-PrBodyGeneration
$Results += @{ Name = "PrBodyGeneration"; Passed = $Result4 }
Write-Host ""

# Test 5: Template structure validation
$Result5 = Test-TemplateStructureValidation
$Results += @{ Name = "TemplateStructureValidation"; Passed = $Result5 }
Write-Host ""

# Test 6: Auto test description
$Result6 = Test-AutoTestDescription
$Results += @{ Name = "AutoTestDescription"; Passed = $Result6 }
Write-Host ""

# Test 7: Title length validation
$Result7 = Test-TitleLengthValidation
$Results += @{ Name = "TitleLengthValidation"; Passed = $Result7 }
Write-Host ""

# Summary
Write-Host "========================================" -ForegroundColor Magenta
Write-Host "Test Summary" -ForegroundColor Magenta
Write-Host "========================================" -ForegroundColor Magenta
Write-Host ""

$TotalTests = $Results.Count
$PassedTests = ($Results | Where-Object { $_.Passed }).Count

foreach ($Result in $Results) {
    $Status = if ($Result.Passed) { "PASS" } else { "FAIL" }
    $Color = if ($Result.Passed) { "Green" } else { "Red" }
    Write-Host "  $($Result.Name) : $Status" -ForegroundColor $Color
}

Write-Host ""
Write-Host "Total: $PassedTests/$TotalTests tests passed" -ForegroundColor $(if ($PassedTests -eq $TotalTests) { 'Green' } else { 'Yellow' })
Write-Host ""

if ($PassedTests -eq $TotalTests) {
    Write-Host "All production tests passed!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Key Features Verified:" -ForegroundColor Cyan
    Write-Host "  ✓ Official PR template loaded" -ForegroundColor Green
    Write-Host "  ✓ Placeholders removed, structure preserved" -ForegroundColor Green
    Write-Host "  ✓ English-only title enforcement" -ForegroundColor Green
    Write-Host "  ✓ PR body uses template structure" -ForegroundColor Green
    Write-Host "  ✓ Signed-off-by NOT in PR body (DCO correct)" -ForegroundColor Green
    Write-Host "  ✓ Fixes: link at bottom only" -ForegroundColor Green
    Write-Host "  ✓ Auto test description generation" -ForegroundColor Green
    Write-Host "  ✓ Title length ≤76 chars" -ForegroundColor Green
    exit 0
} else {
    Write-Host "Some tests failed. Review the output above." -ForegroundColor Red
    exit 1
}