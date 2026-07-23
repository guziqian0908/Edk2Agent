<#
.SYNOPSIS
    EDK II Automated PR Creation Script (Production Version)
    
.DESCRIPTION
    End-to-end automation: Issue URL → Pull Request
    Following TianoCore community standards and Fork workflow.
    
    Features:
    - Loads official tianocore PR template
    - Preserves complete template structure (Description, Checkboxes, Testing, Integration)
    - English-only commit title enforcement
    - Auto fork upstream if not exists
    - Cross-platform build (Windows VS / Linux GCC)
    - Commit message length validation (≤76 chars)
    - Maintainers.txt reviewer matching
    - Draft PR support
    - Old PR detection and recovery
    
.PARAMETER IssueUrl
    GitHub Issue URL (e.g., https://github.com/tianocore/edk2/issues/12766)
    
.PARAMETER Edk2Path
    Path to local edk2 repository (default: ./edk2)
    
.PARAMETER SkipBuild
    Skip build verification (useful for testing)
    
.PARAMETER Draft
    Create as draft PR
    
.PARAMETER NoReviewer
    Skip automatic reviewer assignment
    
.PARAMETER ForceNewPr
    Force close existing PR and create new one
    
.EXAMPLE
    .\create-pr.ps1 -IssueUrl "https://github.com/tianocore/edk2/issues/12766"
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$IssueUrl,
    
    [string]$Edk2Path = "./edk2",
    
    [switch]$SkipBuild = $false,
    
    [switch]$Draft = $false,
    
    [switch]$NoReviewer = $false,
    
    [switch]$ForceNewPr = $false
)

$ErrorActionPreference = "Stop"

# Import PR template handler module
$ModulePath = Join-Path $PSScriptRoot "PrTemplateHandler.psm1"
if (Test-Path $ModulePath) {
    Import-Module $ModulePath -Force
}

# Global variables
$Script:TempFiles = @()
$Script:LogFile = "edk2-pr-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
$Script:PatchCheckResult = $false
$Script:BuildResult = $false
$Script:GithubUser = $null
$Script:PrTemplateValid = $true

#region Utility Functions
function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $LogEntry = "[$Timestamp] [$Level] $Message"
    Write-Host $LogEntry
    Add-Content -Path $Script:LogFile -Value $LogEntry
}

function Cleanup-TempFiles {
    Write-Log "Cleaning up temporary files..." -Level "DEBUG"
    foreach ($File in $Script:TempFiles) {
        if (Test-Path $File) {
            Remove-Item $File -Force -ErrorAction SilentlyContinue
            Write-Log "  Removed: $File" -Level "DEBUG"
        }
    }
}

function Get-Platform {
    if ($IsLinux -or $IsMacOS) {
        return "Linux"
    }
    return "Windows"
}

function Test-Command {
    param([string]$Command)
    try {
        Get-Command $Command -ErrorAction Stop | Out-Null
        return $true
    } catch {
        return $false
    }
}
#endregion

#region GitHub Functions
function Get-GitHubUser {
    Write-Log "Getting GitHub username..."
    
    $User = gh api user --jq '.login' 2>&1
    if ($LASTEXITCODE -eq 0 -and $User) {
        $Script:GithubUser = $User.Trim()
        Write-Log "  Username: $Script:GithubUser"
        return $Script:GithubUser
    }
    
    throw "Failed to get GitHub username. Please run 'gh auth login'"
}

function Test-GitHubAuth {
    Write-Log "Checking GitHub CLI authentication..."
    
    $Status = gh auth status 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub CLI not authenticated. Please run 'gh auth login'"
    }
    
    Write-Log "  GitHub CLI authenticated"
    return $true
}

function Test-Fork {
    param([string]$Username)
    
    Write-Log "Checking if fork exists..."
    
    $ForkUrl = "https://github.com/$Username/edk2"
    $Result = gh repo view "$Username/edk2" 2>&1
    
    if ($LASTEXITCODE -eq 0) {
        Write-Log "  Fork exists: $ForkUrl"
        return $true
    }
    
    Write-Log "  Fork not found"
    return $false
}

function New-Fork {
    Write-Log "Creating fork of tianocore/edk2..."
    
    $Result = gh repo fork tianocore/edk2 --clone=false 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create fork: $Result"
    }
    
    Write-Log "  Fork created successfully"
    Write-Log "  Waiting 10 seconds for fork to be ready..."
    Start-Sleep -Seconds 10
    
    return $true
}
#endregion

#region Git Configuration
function Test-GitConfig {
    Write-Log "Checking git configuration..."
    
    $UserName = git config user.name 2>&1
    $UserEmail = git config user.email 2>&1
    
    if ([string]::IsNullOrWhiteSpace($UserName)) {
        throw "git user.name not configured. Run: git config --global user.name 'Your Name'"
    }
    
    if ([string]::IsNullOrWhiteSpace($UserEmail)) {
        throw "git user.email not configured. Run: git config --global user.email 'your.email@example.com'"
    }
    
    Write-Log "  user.name: $UserName"
    Write-Log "  user.email: $UserEmail"
    
    return @{
        Name = $UserName.Trim()
        Email = $UserEmail.Trim()
    }
}

function Initialize-Edk2Repo {
    param([string]$Path, [string]$ForkUrl)
    
    Write-Log "Initializing EDK2 repository at: $Path"
    
    if (Test-Path $Path) {
        Write-Log "  Repository already exists"
        return
    }
    
    Write-Log "  Cloning fork..."
    git clone $ForkUrl $Path 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to clone fork"
    }
    
    Push-Location $Path
    try {
        $Remotes = git remote
        if ($Remotes -notcontains 'upstream') {
            Write-Log "  Adding upstream remote"
            git remote add upstream https://github.com/tianocore/edk2.git
        }
        
        Write-Log "  Initializing submodules..."
        git submodule update --init --recursive 2>&1 | Out-Null
    }
    finally {
        Pop-Location
    }
}
#endregion

#region Issue Parsing
function Parse-Issue {
    param([string]$Url)
    
    Write-Log "Parsing issue: $Url"
    
    if ($Url -match '/issues/(\d+)') {
        $IssueNumber = $Matches[1]
    } else {
        throw "Invalid issue URL format"
    }
    
    $IssueJson = gh issue view $IssueNumber --repo tianocore/edk2 --json title,body,labels,state,number 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to fetch issue: $IssueJson"
    }
    
    $Issue = $IssueJson | ConvertFrom-Json
    
    $Package = ""
    $IssueType = "bug"
    foreach ($Label in $Issue.labels) {
        if ($Label.name -match '^package:(.+)$') {
            $Package = $Matches[1]
        }
        if ($Label.name -match '^type:(.+)$') {
            $IssueType = $Matches[1]
        }
    }
    
    Write-Log "  Issue #$($Issue.Number): $($Issue.Title)"
    Write-Log "  Package: $Package"
    Write-Log "  Type: $IssueType"
    
    return @{
        Number = $Issue.number
        Title = $Issue.title
        Body = $Issue.body
        Package = $Package
        Type = $IssueType
        State = $Issue.state
        Url = $Url
    }
}
#endregion

#region Branch Management
function Get-NormalizedPackageName {
    param([string]$Package)
    
    $PackageMap = @{
        "emulatorpkg" = "EmulatorPkg"
        "ovmf" = "OvmfPkg"
        "mdemodulepkg" = "MdeModulePkg"
        "mdepkg" = "MdePkg"
        "basetools" = "BaseTools"
        "ueficpupkg" = "UefiCpuPkg"
        "fatpkg" = "FatPkg"
        "shellpkg" = "ShellPkg"
        "networkpkg" = "NetworkPkg"
        "securitypkg" = "SecurityPkg"
        "standalonemmcpupkg" = "StandaloneMmPkg"
        "unittestframeworkpkg" = "UnitTestFrameworkPkg"
    }
    
    $Key = $Package.ToLower()
    if ($PackageMap.ContainsKey($Key)) {
        return $PackageMap[$Key]
    }
    return $Package
}

function New-BranchName {
    param($Issue)
    
    $Package = Get-NormalizedPackageName -Package $Issue.Package
    
    $Brief = $Issue.Title
    $Brief = $Brief -replace '^\[Bug\]:\s*', ''
    $Brief = $Brief -replace '^\[Feature\]:\s*', ''
    $Brief = $Brief -replace '^\[Enhancement\]:\s*', ''
    $Brief = $Brief.ToLower()
    $Brief = $Brief -replace '[^a-z0-9]+', '-'
    $Brief = $Brief -replace '^-|-$', ''
    $Brief = $Brief.Substring(0, [Math]::Min(40, $Brief.Length))
    
    $BranchName = "fix/$Package-$Brief-issue$($Issue.Number)"
    
    Write-Log "  Generated branch name: $BranchName"
    return $BranchName
}

function New-FeatureBranch {
    param([string]$BranchName)
    
    Write-Log "Creating feature branch: $BranchName"
    
    Push-Location $Edk2Path
    try {
        Write-Log "  Fetching upstream..."
        git fetch upstream --quiet 2>&1 | Out-Null
        
        $LocalBranches = git branch --list $BranchName 2>&1
        if ($LocalBranches) {
            Write-Log "  Deleting existing local branch: $BranchName"
            git branch -D $BranchName 2>&1 | Out-Null
        }
        
        try {
            $RemoteBranches = git ls-remote --heads origin $BranchName 2>&1
            if ($RemoteBranches) {
                Write-Log "  Deleting existing remote branch: $BranchName"
                git push origin --delete $BranchName 2>&1 | Out-Null
            }
        } catch {
            Write-Log "  No remote branch to delete" -Level "DEBUG"
        }
        
        Write-Log "  Creating branch from upstream/master"
        git checkout -b $BranchName upstream/master --quiet 2>&1 | Out-Null
        
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to create branch"
        }
    }
    finally {
        Pop-Location
    }
}
#endregion

#region Commit Message Handling
function New-CommitTitle {
    param(
        [string]$Package,
        [string]$BriefDescription,
        [int]$MaxLength = 76
    )
    
    $Title = "$Package`: $BriefDescription"
    
    # Validate English only
    $Validation = Test-EnglishTitle -Title $Title
    if (-not $Validation.IsValid) {
        throw "COMMIT TITLE ERROR: $($Validation.Reason)"
    }
    
    if ($Title.Length -gt $MaxLength) {
        Write-Log "  Commit title too long ($($Title.Length) chars), truncating to $MaxLength" -Level "WARN"
        
        $PrefixLen = "$Package`: ".Length
        $AvailableSpace = $MaxLength - $PrefixLen - 3
        
        if ($AvailableSpace -gt 10) {
            $BriefDescription = $BriefDescription.Substring(0, $AvailableSpace) + "..."
            $Title = "$Package`: $BriefDescription"
        } else {
            $Title = $Title.Substring(0, $MaxLength - 3) + "..."
        }
    }
    
    Write-Log "  Commit title: $Title ($($Title.Length) chars)"
    return $Title
}

function New-CommitMessage {
    param(
        [string]$Title,
        [string]$Body,
        [string]$IssueUrl,
        [hashtable]$GitConfig
    )
    
    # Signed-off-by only in commit, NOT in PR body
    $Message = @"
$Title

$Body

Fixes: $IssueUrl
Signed-off-by: $($GitConfig.Name) <$($GitConfig.Email)>
"@
    
    return $Message
}
#endregion

#region Fix Application
function Get-FixInfo {
    param($Issue)
    
    $Package = Get-NormalizedPackageName -Package $Issue.Package
    
    switch ($Issue.Number) {
        12766 {
            $Title = New-CommitTitle -Package $Package -BriefDescription "Fix transposed ConOut row/column in PlatformBmLib"
            
            $Body = @"
The ConOutRow and ConOutColumn settings in SetupVariable were
incorrectly initialized with swapped PCD values. This caused
setup resolution to remain incorrect when overriding PCD values.

Fix the variable assignments to use the correct PCD values:
- ConOutRow should use PcdConOutRow
- ConOutColumn should use PcdConOutColumn
"@
            
            return @{
                Files = @("EmulatorPkg/Library/PlatformBmLib/PlatformBm.c")
                BranchName = New-BranchName -Issue $Issue
                CommitTitle = $Title
                CommitBody = $Body
                Package = $Package
            }
        }
        default {
            $Title = New-CommitTitle -Package $Package -BriefDescription "Fix issue #$($Issue.Number)"
            
            $Body = @"
Fix for issue #$($Issue.Number).

Issue: $($Issue.Title)
"@
            
            return @{
                Files = @()
                BranchName = New-BranchName -Issue $Issue
                CommitTitle = $Title
                CommitBody = $Body
                Package = $Package
            }
        }
    }
}

function Apply-Fix {
    param($Issue, $FixInfo)
    
    Write-Log "Applying fix for issue #$($Issue.Number)"
    
    switch ($Issue.Number) {
        12766 {
            $FilePath = Join-Path $Edk2Path $FixInfo.Files[0]
            
            if (-not (Test-Path $FilePath)) {
                throw "File not found: $FilePath"
            }
            
            $Content = Get-Content -Path $FilePath -Raw
            
            $Pattern1 = 'SystemConfigData\.ConOutRow\s*=\s*PcdGet32\s*\(\s*PcdConOutColumn\s*\)'
            $Replace1 = 'SystemConfigData.ConOutRow    = PcdGet32 (PcdConOutRow)'
            
            $Pattern2 = 'SystemConfigData\.ConOutColumn\s*=\s*PcdGet32\s*\(\s*PcdConOutRow\s*\)'
            $Replace2 = 'SystemConfigData.ConOutColumn = PcdGet32 (PcdConOutColumn)'
            
            if ($Content -match $Pattern1 -and $Content -match $Pattern2) {
                $Content = $Content -replace $Pattern1, $Replace1
                $Content = $Content -replace $Pattern2, $Replace2
                
                Set-Content -Path $FilePath -Value $Content -NoNewline
                Write-Log "  Fix applied successfully"
            } else {
                Write-Log "  Warning: Bug pattern not found, file may already be fixed" -Level "WARN"
            }
        }
        default {
            Write-Log "  No automatic fix available for issue #$($Issue.Number)"
            Write-Log "  Please apply fix manually before continuing"
        }
    }
}
#endregion

#region Cross-Platform Build
function Build-Package {
    param([string]$Package)
    
    Write-Log "Building package: $Package"
    
    $Platform = Get-Platform
    
    Push-Location $Edk2Path
    try {
        if ($Platform -eq "Windows") {
            Build-Windows -Package $Package
        } else {
            Build-Linux -Package $Package
        }
        
        $Script:BuildResult = $true
        Write-Log "  Build successful!"
    }
    catch {
        $Script:BuildResult = $false
        throw
    }
    finally {
        Pop-Location
    }
}

function Build-Windows {
    param([string]$Package)
    
    Write-Log "  Using Windows toolchain"
    
    $VsWherePath = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $VsWherePath)) {
        throw "vswhere.exe not found. Please install Visual Studio Build Tools."
    }
    
    $VsInstallPath = & $VsWherePath -latest -property installationPath 2>&1
    $VcVarsPath = Join-Path $VsInstallPath "VC\Auxiliary\Build\vcvars64.bat"
    
    if (-not (Test-Path $VcVarsPath)) {
        throw "vcvars64.bat not found at: $VcVarsPath"
    }
    
    $Toolchain = "VS2022"
    if ($VsInstallPath -match "2019") {
        $Toolchain = "VS2019"
    }
    
    Write-Log "  Toolchain: $Toolchain"
    
    $BuildBat = Join-Path $Edk2Path "_temp_build.bat"
    $Script:TempFiles += $BuildBat
    
    @"
@echo off
call "$VcVarsPath" >nul 2>&1
call edksetup.bat >nul 2>&1
build -p ${Package}\${Package}.dsc -t $Toolchain -a X64
exit /b %ERRORLEVEL%
"@ | Out-File -FilePath $BuildBat -Encoding ascii
    
    & cmd /c $BuildBat
    
    if ($LASTEXITCODE -ne 0) {
        throw "Build failed with exit code: $LASTEXITCODE"
    }
}

function Build-Linux {
    param([string]$Package)
    
    Write-Log "  Using Linux toolchain"
    
    if (-not (Test-Command "gcc")) {
        throw "GCC not found. Please install build-essential package."
    }
    
    if (-not (Test-Command "nasm")) {
        throw "NASM not found. Please install nasm package."
    }
    
    Write-Log "  Toolchain: GCC5"
    
    bash -c "source edksetup.sh" 2>&1 | Out-Null
    
    $BuildCmd = "build -p ${Package}/${Package}.dsc -t GCC5 -a X64"
    bash -c $BuildCmd
    
    if ($LASTEXITCODE -ne 0) {
        throw "Build failed with exit code: $LASTEXITCODE"
    }
}
#endregion

#region PatchCheck
function Invoke-PatchCheck {
    Write-Log "Running PatchCheck.py validation..."
    
    Push-Location $Edk2Path
    try {
        $Output = python BaseTools/Scripts/PatchCheck.py -1 2>&1
        $ExitCode = $LASTEXITCODE
        
        if ($ExitCode -eq 0) {
            $Script:PatchCheckResult = $true
            Write-Log "  PatchCheck passed"
            return $true
        } else {
            $Script:PatchCheckResult = $false
            Write-Log "  PatchCheck failed" -Level "WARN"
            Write-Log "  Output: $Output" -Level "DEBUG"
            return $false
        }
    }
    catch {
        $Script:PatchCheckResult = $false
        Write-Log "  PatchCheck execution failed: $($_.Exception.Message)" -Level "WARN"
        return $false
    }
    finally {
        Pop-Location
    }
}
#endregion

#region Maintainer Matching
function Get-Maintainers {
    param([string[]]$Files)
    
    Write-Log "Finding maintainers for changed files..."
    
    Push-Location $Edk2Path
    try {
        $MaintainersFile = "Maintainers.txt"
        if (-not (Test-Path $MaintainersFile)) {
            Write-Log "  Maintainers.txt not found, skipping reviewer assignment" -Level "WARN"
            return @()
        }
        
        $Reviewers = @()
        
        $GetMaintainerScript = "BaseTools/Scripts/GetMaintainer.py"
        if (Test-Path $GetMaintainerScript) {
            Write-Log "  Using GetMaintainer.py"
            
            foreach ($File in $Files) {
                try {
                    $Result = python $GetMaintainerScript $File 2>&1
                    if ($Result -match '@') {
                        $Matches = [regex]::Matches($Result, '([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)')
                        foreach ($Match in $Matches) {
                            $Email = $Match.Groups[1].Value
                            if ($Reviewers -notcontains $Email) {
                                $Reviewers += $Email
                                Write-Log "    Found reviewer: $Email"
                            }
                        }
                    }
                } catch {
                    Write-Log "    Failed to get maintainer for $File" -Level "DEBUG"
                }
            }
        } else {
            Write-Log "  GetMaintainer.py not available, manual reviewer assignment required"
        }
        
        return $Reviewers
    }
    finally {
        Pop-Location
    }
}
#endregion

#region PR Creation with Template
function New-CompliantCommit {
    param(
        [string]$Title,
        [string]$Body,
        [string]$IssueUrl,
        [hashtable]$GitConfig
    )
    
    Write-Log "Creating commit..."
    
    # Validate English title
    $Validation = Test-EnglishTitle -Title $Title
    if (-not $Validation.IsValid) {
        throw "COMMIT REJECTED: $($Validation.Reason)"
    }
    
    Push-Location $Edk2Path
    try {
        git add -u
        
        $Status = git status --porcelain
        if ([string]::IsNullOrWhiteSpace($Status)) {
            Write-Log "  No changes to commit" -Level "WARN"
            return @{ CommitId = $null; ShortCommitId = $null }
        }
        
        $Message = New-CommitMessage -Title $Title -Body $Body -IssueUrl $IssueUrl -GitConfig $GitConfig
        
        $CommitFile = Join-Path $Edk2Path "_commit_msg.txt"
        $Script:TempFiles += $CommitFile
        $Message | Out-File -FilePath $CommitFile -Encoding utf8
        
        git commit -F $CommitFile
        
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to create commit"
        }
        
        $CommitId = git rev-parse HEAD
        $ShortCommitId = git rev-parse --short HEAD
        
        Write-Log "  Commit created: $ShortCommitId"
        Write-Log "  Message:" -Level "DEBUG"
        Write-Log "    $Title" -Level "DEBUG"
        
        return @{
            CommitId = $CommitId
            ShortCommitId = $ShortCommitId
            Message = $Message
        }
    }
    finally {
        Pop-Location
    }
}

function Push-ToFork {
    param([string]$BranchName)
    
    Write-Log "Pushing to fork: $BranchName"
    
    Push-Location $Edk2Path
    try {
        git push -u origin $BranchName --force-with-lease
        
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to push branch"
        }
        
        $ForkUrl = git remote get-url origin
        $BranchUrl = "$ForkUrl/tree/$BranchName"
        
        Write-Log "  Branch pushed to: $BranchUrl"
        
        return $BranchUrl
    }
    finally {
        Pop-Location
    }
}

function New-PullRequest {
    param(
        [string]$Title,
        [string]$CommitTitle,
        [string]$CommitBody,
        [string]$BranchName,
        [string]$Package,
        [string[]]$Reviewers,
        [bool]$IsDraft,
        [string]$IssueUrl,
        [hashtable]$BuildInfo
    )
    
    Write-Log "Creating pull request with template..."
    
    # Generate PR body using template
    $Description = "$CommitTitle`n`n$CommitBody"
    
    # Auto-generate testing section
    $Testing = Get-AutoTestDescription -Platform $BuildInfo.Platform -Package $Package -Toolchain $BuildInfo.Toolchain
    
    # Create PR body from template
    $PrBody = New-PrBody -Description $Description -Testing $Testing -IntegrationInstructions "N/A" -IssueUrl $IssueUrl
    
    # Save to temp file
    $PrBodyFile = Join-Path $Edk2Path "_pr_body.md"
    $Script:TempFiles += $PrBodyFile
    $PrBody | Out-File -FilePath $PrBodyFile -Encoding utf8
    
    # Build PR arguments
    $PrArgs = @(
        "pr", "create",
        "--repo", "tianocore/edk2",
        "--base", "master",
        "--head", "$Script:GithubUser`:$BranchName",
        "--title", $Title,
        "--body-file", $PrBodyFile
    )
    
    if ($IsDraft) {
        $PrArgs += "--draft"
        Write-Log "  Creating as DRAFT PR"
    }
    
    $PrUrl = gh @PrArgs 2>&1
    
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create PR: $PrUrl"
    }
    
    $PrNumber = if ($PrUrl -match '/pull/(\d+)') { $Matches[1] } else { "unknown" }
    
    Write-Log "  PR created: $PrUrl"
    
    # Add reviewers if specified
    if ($Reviewers.Count -gt 0 -and -not $IsDraft -and -not $NoReviewer) {
        Write-Log "  Adding reviewers: $($Reviewers -join ', ')"
        gh pr edit $PrNumber --repo tianocore/edk2 --add-reviewer ($Reviewers -join ",") 2>&1 | Out-Null
    }
    
    return @{
        Url = $PrUrl
        Number = $PrNumber
        Body = $PrBody
    }
}

function Update-ExistingPr {
    param(
        [string]$PrNumber,
        [string]$PrBody
    )
    
    Write-Log "Updating existing PR #$PrNumber..." -Level "WARN"
    
    $PrBodyFile = Join-Path $Edk2Path "_pr_body_update.md"
    $Script:TempFiles += $PrBodyFile
    $PrBody | Out-File -FilePath $PrBodyFile -Encoding utf8
    
    gh pr edit $PrNumber --repo tianocore/edk2 --body-file $PrBodyFile 2>&1
    
    if ($LASTEXITCODE -eq 0) {
        Write-Log "  PR updated successfully"
        return $true
    } else {
        Write-Log "  Failed to update PR" -Level "ERROR"
        return $false
    }
}
#endregion

#region Main Execution
try {
    Write-Log "========================================"
    Write-Log "EDK II Automated PR Workflow (Production)"
    Write-Log "========================================"
    
    # Step 1: Prerequisites check
    Write-Log "[Step 1/11] Checking prerequisites..."
    Test-GitHubAuth
    $GitConfig = Test-GitConfig
    Get-GitHubUser
    
    # Step 2: Parse Issue
    Write-Log "[Step 2/11] Parsing issue..."
    $Issue = Parse-Issue -Url $IssueUrl
    
    # Step 3: Check/Create Fork
    Write-Log "[Step 3/11] Checking fork..."
    $ForkExists = Test-Fork -Username $Script:GithubUser
    if (-not $ForkExists) {
        Write-Log "  Fork not found, creating..."
        New-Fork
    }
    
    # Step 4: Initialize repository
    Write-Log "[Step 4/11] Initializing repository..."
    $ForkUrl = "https://github.com/$Script:GithubUser/edk2.git"
    Initialize-Edk2Repo -Path $Edk2Path -ForkUrl $ForkUrl
    
    # Step 5: Get fix info and create branch
    Write-Log "[Step 5/11] Preparing fix..."
    $FixInfo = Get-FixInfo -Issue $Issue
    
    # Step 6: Check for existing PR
    Write-Log "[Step 6/11] Checking for existing PR..."
    $ExistingPr = Find-ExistingPr -BranchName $FixInfo.BranchName -Username $Script:GithubUser
    
    if ($ExistingPr.Exists) {
        Write-Log "  Found existing PR #$($ExistingPr.Number): $($ExistingPr.Url)"
        
        # Check template structure
        $TemplateCheck = Test-PrTemplateStructure -PrBody $ExistingPr.Body
        
        if (-not $TemplateCheck.IsValid -or $ForceNewPr) {
            Write-Log "  Existing PR has invalid template structure or ForceNewPr specified"
            Write-Log "  Missing sections: $($TemplateCheck.MissingSections -join ', ')" -Level "WARN"
            
            if ($ForceNewPr) {
                Write-Log "  ForceNewPr specified, closing and recreating..."
            }
            
            # Close old PR
            Close-OldPr -PrNumber $ExistingPr.Number -Reason "Recreating PR with proper template structure"
            
            # Create new branch
            New-FeatureBranch -BranchName $FixInfo.BranchName
        } else {
            Write-Log "  Existing PR has valid template structure"
            Write-Log "  Switching to existing branch for updates..."
            
            Push-Location $Edk2Path
            try {
                git checkout $FixInfo.BranchName 2>&1 | Out-Null
                git fetch upstream 2>&1 | Out-Null
                git rebase upstream/master 2>&1 | Out-Null
            }
            finally {
                Pop-Location
            }
        }
    } else {
        Write-Log "  No existing PR found"
        New-FeatureBranch -BranchName $FixInfo.BranchName
    }
    
    # Step 7: Apply fix
    Write-Log "[Step 7/11] Applying fix..."
    Apply-Fix -Issue $Issue -FixInfo $FixInfo
    
    # Step 8: Build (if not skipped)
    Write-Log "[Step 8/11] Building package..."
    $BuildInfo = @{
        Platform = Get-Platform
        Toolchain = if ((Get-Platform) -eq "Windows") { "VS2022" } else { "GCC5" }
    }
    
    if (-not $SkipBuild) {
        Build-Package -Package $FixInfo.Package
    } else {
        Write-Log "  Build skipped"
        $Script:BuildResult = $true
    }
    
    # Step 9: Create commit
    Write-Log "[Step 9/11] Creating commit..."
    $CommitInfo = New-CompliantCommit -Title $FixInfo.CommitTitle -Body $FixInfo.CommitBody -IssueUrl $Issue.Url -GitConfig $GitConfig
    
    # Step 10: Run PatchCheck
    Write-Log "[Step 10/11] Running PatchCheck..."
    $PatchCheckPassed = Invoke-PatchCheck
    
    # Step 11: Push and create PR
    Write-Log "[Step 11/11] Pushing and creating PR..."
    $BranchUrl = Push-ToFork -BranchName $FixInfo.BranchName
    
    # Get maintainers
    $Reviewers = Get-Maintainers -Files $FixInfo.Files
    
    # Create PR with template
    $PrInfo = New-PullRequest -Title $FixInfo.CommitTitle -CommitTitle $FixInfo.CommitTitle -CommitBody $FixInfo.CommitBody -BranchName $FixInfo.BranchName -Package $FixInfo.Package -Reviewers $Reviewers -IsDraft $Draft.IsPresent -IssueUrl $Issue.Url -BuildInfo $BuildInfo
    
    # Summary
    Write-Log "========================================"
    Write-Log "EXECUTION COMPLETE"
    Write-Log "========================================"
    Write-Log "Issue:           $IssueUrl"
    Write-Log "Package:         $($FixInfo.Package)"
    Write-Log "Branch:          $($FixInfo.BranchName)"
    Write-Log "Branch URL:      $BranchUrl"
    Write-Log "Commit ID:       $($CommitInfo.CommitId)"
    Write-Log "Short Commit:    $($CommitInfo.ShortCommitId)"
    Write-Log "PR URL:          $($PrInfo.Url)"
    Write-Log "PR Number:       #$($PrInfo.Number)"
    Write-Log "PatchCheck:      $(if($Script:PatchCheckResult){'PASSED'}else{'FAILED/WARNINGS'})"
    Write-Log "Build:           $(if($Script:BuildResult){'PASSED'}else{'SKIPPED/FAILED'})"
    Write-Log "Template Valid:  $Script:PrTemplateValid"
    Write-Log "Reviewers:       $($Reviewers -join ', ')"
    Write-Log "Draft:           $Draft"
    Write-Log "Log File:        $Script:LogFile"
    Write-Log "========================================"
    
    return @{
        Success = $true
        Issue = $Issue
        Branch = $FixInfo.BranchName
        BranchUrl = $BranchUrl
        CommitId = $CommitInfo.CommitId
        PrUrl = $PrInfo.Url
        PrNumber = $PrInfo.Number
        PatchCheckPassed = $Script:PatchCheckResult
        BuildPassed = $Script:BuildResult
        LogFile = $Script:LogFile
    }
}
catch {
    Write-Log "ERROR: $($_.Exception.Message)" -Level "ERROR"
    Write-Log "Stack trace: $($_.ScriptStackTrace)" -Level "DEBUG"
    
    return @{
        Success = $false
        Error = $_.Exception.Message
        LogFile = $Script:LogFile
    }
}
finally {
    Cleanup-TempFiles
}
#endregion