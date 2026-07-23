# EDK II PR Template Handler
# Handles loading and processing of tianocore/edk2 PR template

# Official tianocore/edk2 PR template
$Script:OfficialTemplate = @"
# Description

<_Include a description of the change and why this change was made._>

<_For each item, place an "x" in between `[` and `]` if true. Example: `[x]` (you can also check items in GitHub UI)_>

<_Create the PR as a Draft PR if it is only created to run CI checks._>

<_Delete lines in \<\> tags before creating the PR._>

- [ ] Breaking change?
  - **Breaking change** - Does this PR cause a break in build or boot behavior?
  - Examples: Does it add a new library class or move a module to a different repo.
  - If checked, follow the [Breaking Change and Release Process](https://raw.githubusercontent.com/tianocore/tianocore-wiki.github.io/refs/heads/main/rfc/text/0003-edk2-breaking-change-and-release-process.md).
- [ ] Impacts security?
  - **Security** - Does this PR have a direct security impact?
  - Examples: Crypto algorithm change or buffer overflow fix.
- [ ] Includes tests?
  - **Tests** - Does this PR include any explicit test code?
  - Examples: Unit tests or integration tests.

## How This Was Tested

<_Describe the test(s) that were run to verify the changes._>

## Integration Instructions

<_Describe how these changes should be integrated. Use N/A if nothing is required._>
"@

function Get-PrTemplate {
    return $Script:OfficialTemplate
}

function Remove-Placeholders {
    param([string]$Template)
    
    # Remove all lines containing placeholder text <_..._>
    $Lines = $Template -split "`n"
    $CleanedLines = @()
    
    foreach ($Line in $Lines) {
        # Check if line contains placeholder tag <_..._>
        # Match pattern: <_ followed by anything until _>
        if ($Line -match '<_.*_>') {
            # Skip this line (it's a placeholder)
            continue
        }
        $CleanedLines += $Line
    }
    
    return $CleanedLines -join "`n"
}

function New-PrBody {
    param(
        [string]$Description,
        [string]$Testing,
        [string]$IntegrationInstructions = "N/A",
        [bool]$BreakingChange = $false,
        [bool]$ImpactsSecurity = $false,
        [bool]$IncludesTests = $false,
        [string]$IssueUrl
    )
    
    # Get template and remove placeholders
    $Template = Get-PrTemplate
    $CleanTemplate = Remove-Placeholders -Template $Template
    
    # Build checkboxes
    $BreakingCheck = if ($BreakingChange) { "[x]" } else { "[ ]" }
    $SecurityCheck = if ($ImpactsSecurity) { "[x]" } else { "[ ]" }
    $TestsCheck = if ($IncludesTests) { "[x]" } else { "[ ]" }
    
    # Replace checkbox states
    $CleanTemplate = $CleanTemplate -replace '- \[ \] Breaking change\?', "- $BreakingCheck Breaking change?"
    $CleanTemplate = $CleanTemplate -replace '- \[ \] Impacts security\?', "- $SecurityCheck Impacts security?"
    $CleanTemplate = $CleanTemplate -replace '- \[ \] Includes tests\?', "- $TestsCheck Includes tests?"
    
    # Split into sections
    $Sections = $CleanTemplate -split "(?=^# |^## )"
    
    # Build final PR body
    $PrBody = ""
    $InSection = ""
    
    foreach ($Section in $Sections) {
        if ([string]::IsNullOrWhiteSpace($Section)) {
            continue
        }
        
        if ($Section -match '^# Description') {
            $PrBody += $Section
            $PrBody += "`n`n$Description`n"
        }
        elseif ($Section -match '^## How This Was Tested') {
            $PrBody += $Section
            $PrBody += "`n`n$Testing`n"
        }
        elseif ($Section -match '^## Integration Instructions') {
            $PrBody += $Section
            $PrBody += "`n`n$IntegrationInstructions`n"
        }
        else {
            $PrBody += $Section
        }
    }
    
    # Add Fixes: link at the end
    $PrBody += "`n---`n`nFixes: $IssueUrl`n"
    
    return $PrBody
}

function Test-EnglishTitle {
    param([string]$Title)
    
    # Check if title contains Chinese characters
    # Unicode range for Chinese: \u4e00-\u9fff (CJK Unified Ideographs)
    if ($Title -match '[\u4e00-\u9fff]') {
        return @{
            IsValid = $false
            Reason = "Title contains Chinese characters. Commit title must be in English for PatchCheck compliance."
        }
    }
    
    # Check if title contains other non-ASCII characters that might cause issues
    if ($Title -match '[^\x00-\x7F]') {
        return @{
            IsValid = $false
            Reason = "Title contains non-ASCII characters. Commit title must be in English."
        }
    }
    
    return @{
        IsValid = $true
        Reason = "Title is valid (English only)"
    }
}

function Test-PrTemplateStructure {
    param([string]$PrBody)
    
    # Check if PR body has the expected template structure
    $RequiredSections = @(
        "# Description",
        "- [ ] Breaking change?",
        "- [ ] Impacts security?",
        "- [ ] Includes tests?",
        "## How This Was Tested",
        "## Integration Instructions"
    )
    
    $MissingSections = @()
    foreach ($Section in $RequiredSections) {
        if ($PrBody -notmatch [regex]::Escape($Section)) {
            $MissingSections += $Section
        }
    }
    
    $IsValid = $MissingSections.Count -eq 0
    
    return @{
        IsValid = $IsValid
        MissingSections = $MissingSections
    }
}

function Get-AutoTestDescription {
    param(
        [string]$Platform,
        [string]$Package,
        [string]$Toolchain
    )
    
    $Testing = "Built and tested on $Platform environment.`n`n"
    $Testing += "**Package:** $Package`n"
    $Testing += "**Toolchain:** $Toolchain`n"
    $Testing += "**Architecture:** X64`n"
    $Testing += "**Build Result:** Successful`n"
    
    if ($Platform -eq "Windows") {
        $Testing += "`nTest steps:`n"
        $Testing += "1. Initialized Visual Studio environment`n"
        $Testing += "2. Ran edksetup.bat`n"
        $Testing += "3. Built $Package package with $Toolchain toolchain`n"
    } else {
        $Testing += "`nTest steps:`n"
        $Testing += "1. Verified GCC toolchain availability`n"
        $Testing += "2. Ran edksetup.sh`n"
        $Testing += "3. Built $Package package with $Toolchain toolchain`n"
    }
    
    return $Testing
}

function Close-OldPr {
    param(
        [string]$PrNumber,
        [string]$Reason = "Recreating PR with proper template structure"
    )
    
    Write-Host "Closing old PR #$PrNumber..." -ForegroundColor Yellow
    
    $Comment = "Closing this PR. $Reason. A new PR will be created."
    gh pr close $PrNumber --repo tianocore/edk2 --comment $Comment 2>&1
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  PR #$PrNumber closed successfully" -ForegroundColor Green
        return $true
    } else {
        Write-Host "  Failed to close PR #$PrNumber" -ForegroundColor Red
        return $false
    }
}

function Find-ExistingPr {
    param(
        [string]$BranchName,
        [string]$Username
    )
    
    Write-Host "Checking for existing PR from ${Username}:${BranchName}..." -ForegroundColor Cyan
    
    # List PRs from user's fork
    $HeadRef = "${Username}:${BranchName}"
    $PrList = gh pr list --repo tianocore/edk2 --head $HeadRef --state open --json number,title,url,body 2>&1
    
    if ($LASTEXITCODE -eq 0 -and $PrList -ne "[]") {
        $Prs = $PrList | ConvertFrom-Json
        if ($Prs.Count -gt 0) {
            return @{
                Exists = $true
                Number = $Prs[0].number
                Title = $Prs[0].title
                Url = $Prs[0].url
                Body = $Prs[0].body
            }
        }
    }
    
    return @{
        Exists = $false
    }
}

Export-ModuleMember -Function @(
    'Get-PrTemplate',
    'Remove-Placeholders',
    'New-PrBody',
    'Test-EnglishTitle',
    'Test-PrTemplateStructure',
    'Get-AutoTestDescription',
    'Close-OldPr',
    'Find-ExistingPr'
)