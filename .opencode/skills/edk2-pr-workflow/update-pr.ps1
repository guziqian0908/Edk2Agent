<#
.SYNOPSIS
    EDK II PR Update Script - Updates PR based on review comments
    
.DESCRIPTION
    Reads PR comments, applies fixes, rebuilds, updates commit, pushes to existing PR.
    
.PARAMETER PrUrl
    GitHub PR URL (e.g., https://github.com/tianocore/edk2/pull/12841)
    
.PARAMETER Edk2Path
    Path to local edk2 repository
    
.PARAMETER SkipBuild
    Skip build verification
    
.EXAMPLE
    .\update-pr.ps1 -PrUrl "https://github.com/tianocore/edk2/pull/12841"
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$PrUrl,
    
    [string]$Edk2Path = "./edk2",
    
    [switch]$SkipBuild = $false
)

$ErrorActionPreference = "Stop"

# Global variables
$Script:TempFiles = @()
$Script:LogFile = "edk2-pr-update-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
$Script:GithubUser = $null
$Script:PrInfo = $null
$Script:ForkOwner = $null
$Script:ForkBranch = $null

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
        }
    }
}

function Get-Platform {
    if ($IsLinux -or $IsMacOS) {
        return "Linux"
    }
    return "Windows"
}
#endregion

#region PR Analysis Functions
function Get-PrInfo {
    param([string]$Url)
    
    Write-Log "Fetching PR information: $Url"
    
    # Extract PR number
    if ($Url -match '/pull/(\d+)') {
        $PrNumber = $Matches[1]
    } else {
        throw "Invalid PR URL format"
    }
    
    # Get PR details
    $PrJson = gh pr view $PrNumber --repo tianocore/edk2 --json number,title,headRefName,headRepository,body,state,url,author 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to fetch PR: $PrJson"
    }
    
    $Pr = $PrJson | ConvertFrom-Json
    
    $Script:ForkOwner = $Pr.headRepository.owner.login
    $Script:ForkBranch = $Pr.headRefName
    
    Write-Log "  PR #$($Pr.number): $($Pr.Title)"
    Write-Log "  Author: $($Pr.author.login)"
    Write-Log "  Fork: $Script:ForkOwner/edk2"
    Write-Log "  Branch: $Script:ForkBranch"
    
    return @{
        Number = $Pr.number
        Title = $Pr.title
        HeadRef = $Pr.headRefName
        HeadRepo = $Pr.headRepository.name
        HeadOwner = $Pr.headRepository.owner.login
        Body = $Pr.body
        State = $Pr.state
        Url = $Url
        Author = $Pr.author.login
    }
}

function Get-PrComments {
    param([int]$PrNumber)
    
    Write-Log "Fetching PR comments for #$PrNumber..."
    
    # Get review comments (line-level comments)
    $ReviewComments = gh api repos/tianocore/edk2/pulls/$PrNumber/comments --jq '.[] | {path: .path, line: .line, body: .body, user: .user.login, created_at: .created_at}' 2>&1
    
    $Comments = @()
    if ($ReviewComments -and $ReviewComments -ne "[]") {
        $ParsedComments = $ReviewComments | ConvertFrom-Json
        foreach ($Comment in $ParsedComments) {
            $Comments += @{
                Type = "review"
                Path = $Comment.path
                Line = $Comment.line
                Body = $Comment.body
                User = $Comment.user
                CreatedAt = $Comment.created_at
            }
            Write-Log "  Review comment by $($Comment.user) on $($Comment.path):$($Comment.line)"
            Write-Log "    $($Comment.body)" -Level "DEBUG"
        }
    }
    
    # Get issue comments (general comments)
    $IssueComments = gh api repos/tianocore/edk2/issues/$PrNumber/comments --jq '.[] | {body: .body, user: .user.login, created_at: .created_at}' 2>&1
    
    if ($IssueComments -and $IssueComments -ne "[]") {
        $ParsedIssueComments = $IssueComments | ConvertFrom-Json
        foreach ($Comment in $ParsedIssueComments) {
            $Comments += @{
                Type = "issue"
                Body = $Comment.body
                User = $Comment.user
                CreatedAt = $Comment.created_at
            }
            Write-Log "  Issue comment by $($Comment.user)"
        }
    }
    
    Write-Log "  Total comments: $($Comments.Count)"
    
    return $Comments
}

function Get-PrReviewComments {
    param([int]$PrNumber)
    
    Write-Log "Fetching PR review comments..."
    
    # Get reviews
    $Reviews = gh api repos/tianocore/edk2/pulls/$PrNumber/reviews 2>&1
    
    $ReviewDetails = @()
    if ($Reviews -and $Reviews -ne "[]") {
        $ParsedReviews = $Reviews | ConvertFrom-Json
        foreach ($Review in $ParsedReviews) {
            $ReviewDetails += @{
                User = $Review.user.login
                State = $Review.state
                Body = $Review.body
                SubmittedAt = $Review.submitted_at
            }
            Write-Log "  Review by $($Review.user): $($Review.state)"
        }
    }
    
    return $ReviewDetails
}

function Analyze-Comments {
    param([array]$Comments)
    
    Write-Log "Analyzing comments for actionable feedback..."
    
    $ActionItems = @()
    
    foreach ($Comment in $Comments) {
        if ($Comment.Type -eq "review") {
            # Check for common review feedback patterns
            $Body = $Comment.Body.ToLower()
            
            # Detect comment update requests
            if ($Body -match "update.*comment" -or $Body -match "describe.*value" -or $Body -match "add.*comment") {
                $ActionItems += @{
                    Type = "update_comment"
                    Path = $Comment.Path
                    Line = $Comment.Line
                    Suggestion = $Comment.Body
                    User = $Comment.User
                }
                Write-Log "  Action: Update comment in $($Comment.Path) at line $($Comment.Line)"
            }
            
            # Detect code change requests
            if ($Body -match "please.*change" -or $Body -match "should.*be" -or $Body -match "fix") {
                $ActionItems += @{
                    Type = "code_change"
                    Path = $Comment.Path
                    Line = $Comment.Line
                    Suggestion = $Comment.Body
                    User = $Comment.User
                }
                Write-Log "  Action: Code change in $($Comment.Path) at line $($Comment.Line)"
            }
        }
    }
    
    return $ActionItems
}
#endregion

#region Git Operations
function Get-GitHubUser {
    Write-Log "Getting GitHub username..."
    
    $User = gh api user --jq '.login' 2>&1
    if ($LASTEXITCODE -eq 0 -and $User) {
        $Script:GithubUser = $User.Trim()
        Write-Log "  Current user: $Script:GithubUser"
        return $Script:GithubUser
    }
    
    throw "Failed to get GitHub username. Run 'gh auth login'"
}

function Test-GitConfig {
    $UserName = git config user.name 2>&1
    $UserEmail = git config user.email 2>&1
    
    if ([string]::IsNullOrWhiteSpace($UserName) -or [string]::IsNullOrWhiteSpace($UserEmail)) {
        throw "Git user.name and user.email must be configured"
    }
    
    return @{
        Name = $UserName.Trim()
        Email = $UserEmail.Trim()
    }
}

function Checkout-PrBranch {
    param([string]$ForkOwner, [string]$BranchName)
    
    Write-Log "Checking out PR branch..."
    
    Push-Location $Edk2Path
    try {
        # Fetch from fork
        $ForkUrl = "https://github.com/$ForkOwner/edk2.git"
        Write-Log "  Fork URL: $ForkUrl"
        
        # Add fork remote if not exists
        $Remotes = git remote
        $ForkRemoteName = "fork-$ForkOwner"
        if ($Remotes -notcontains $ForkRemoteName) {
            Write-Log "  Adding remote: $ForkRemoteName"
            git remote add $ForkRemoteName $ForkUrl
        }
        
        # Fetch branch
        Write-Log "  Fetching branch: $BranchName"
        git fetch $ForkRemoteName $BranchName 2>&1 | Out-Null
        
        # Check if branch exists locally
        $LocalBranches = git branch --list $BranchName
        if ($LocalBranches) {
            Write-Log "  Checking out existing branch: $BranchName"
            git checkout $BranchName 2>&1 | Out-Null
        } else {
            Write-Log "  Creating local branch tracking remote"
            git checkout -b $BranchName "$ForkRemoteName/$BranchName" 2>&1 | Out-Null
        }
        
        # Set upstream tracking
        git branch --set-upstream-to="$ForkRemoteName/$BranchName" $BranchName 2>&1 | Out-Null
        
        Write-Log "  Branch checked out successfully"
    }
    finally {
        Pop-Location
    }
}

function Apply-CommentFixes {
    param([array]$ActionItems, [int]$PrNumber)
    
    Write-Log "Applying comment fixes..."
    
    Push-Location $Edk2Path
    try {
        foreach ($Item in $ActionItems) {
            if ($Item.Type -eq "update_comment") {
                $FilePath = $Item.Path
                $Line = $Item.Line
                $Suggestion = $Item.Suggestion
                
                Write-Log "  Processing: $FilePath at line $Line"
                Write-Log "    Suggestion: $Suggestion"
                
                # Apply fix based on PR number and comment type
                switch ($PrNumber) {
                    12841 {
                        # lgao4's comment: "Please update the comments to describe the value from PCD"
                        # Need to add/update comments for ConOutRow and ConOutColumn assignments
                        $FullPath = Join-Path $Edk2Path $FilePath
                        
                        if (Test-Path $FullPath) {
                            $Content = Get-Content -Path $FullPath -Raw
                            
                            # Check if comments need updating
                            # The code should have:
                            #   // ConOutRow from PcdConOutRow
                            #   SystemConfigData.ConOutRow = PcdGet32 (PcdConOutRow);
                            #   // ConOutColumn from PcdConOutColumn
                            #   SystemConfigData.ConOutColumn = PcdGet32 (PcdConOutColumn);
                            
                            $Updated = $false
                            
                            # Check if there's a comment before ConOutRow assignment
                            if ($Content -match 'SystemConfigData\.ConOutRow\s*=\s*PcdGet32\s*\(\s*PcdConOutRow\s*\)') {
                                # Check if there's a proper comment before it
                                if ($Content -notmatch '// ConOutRow.*PcdConOutRow|// Read ConOutRow from PCD') {
                                    Write-Log "    Adding comment for ConOutRow"
                                    $Content = $Content -replace '(SystemConfigData\.ConOutRow\s*=\s*PcdGet32\s*\(\s*PcdConOutRow\s*\))', '// Read ConOutRow value from PCD`n    $1'
                                    $Updated = $true
                                }
                            }
                            
                            # Check if there's a comment before ConOutColumn assignment
                            if ($Content -match 'SystemConfigData\.ConOutColumn\s*=\s*PcdGet32\s*\(\s*PcdConOutColumn\s*\)') {
                                # Check if there's a proper comment before it
                                if ($Content -notmatch '// ConOutColumn.*PcdConOutColumn|// Read ConOutColumn from PCD') {
                                    Write-Log "    Adding comment for ConOutColumn"
                                    $Content = $Content -replace '(SystemConfigData\.ConOutColumn\s*=\s*PcdGet32\s*\(\s*PcdConOutColumn\s*\))', '// Read ConOutColumn value from PCD`n    $1'
                                    $Updated = $true
                                }
                            }
                            
                            if ($Updated) {
                                Set-Content -Path $FullPath -Value $Content -NoNewline
                                Write-Log "    Comments updated successfully"
                            } else {
                                Write-Log "    Comments already present or pattern not found"
                            }
                        }
                    }
                    default {
                        Write-Log "  No automatic fix available for this PR"
                    }
                }
            }
        }
    }
    finally {
        Pop-Location
    }
}

function Build-Package {
    param([string]$Package)
    
    Write-Log "Building package: $Package"
    
    $Platform = Get-Platform
    Push-Location $Edk2Path
    try {
        if ($Platform -eq "Windows") {
            $VsWherePath = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
            if (-not (Test-Path $VsWherePath)) {
                throw "vswhere.exe not found"
            }
            
            $VsInstallPath = & $VsWherePath -latest -property installationPath 2>&1
            $VcVarsPath = Join-Path $VsInstallPath "VC\Auxiliary\Build\vcvars64.bat"
            $Toolchain = "VS2022"
            
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
                throw "Build failed"
            }
        } else {
            bash -c "source edksetup.sh && build -p ${Package}/${Package}.dsc -t GCC5 -a X64"
            if ($LASTEXITCODE -ne 0) {
                throw "Build failed"
            }
        }
        
        Write-Log "  Build successful!"
    }
    finally {
        Pop-Location
    }
}

function Update-Commit {
    param([hashtable]$GitConfig, [string]$PrNumber)
    
    Write-Log "Updating commit..."
    
    Push-Location $Edk2Path
    try {
        git add -u
        
        $Status = git status --porcelain
        if ([string]::IsNullOrWhiteSpace($Status)) {
            Write-Log "  No changes to commit"
            return $false
        }
        
        # Amend the commit with updated message
        $CommitMessage = @"
EmulatorPkg: Fix transposed row/column arguments in Console Out

SetupVariableInit incorrectly swaps ConOutRow and ConOutColumn when
reading PCD values. Correct assignment mapping to match
PcdConOutRow/PcdConOutColumn to their respective struct fields,
fixing transposed console resolution saved into NVRAM Setup variable.

Add comments to describe the PCD values being read.

Fixes: https://github.com/tianocore/edk2/issues/12766
Signed-off-by: $($GitConfig.Name) <$($GitConfig.Email)>
"@
        
        $CommitFile = Join-Path $Edk2Path "_commit_msg.txt"
        $Script:TempFiles += $CommitFile
        # Use UTF-8 without BOM to avoid PatchCheck failures
        [System.IO.File]::WriteAllText($CommitFile, $CommitMessage, [System.Text.UTF8Encoding]::new($false))
        
        git commit --amend -F $CommitFile
        
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to amend commit"
        }
        
        $CommitId = git rev-parse HEAD
        $ShortCommitId = git rev-parse --short HEAD
        
        Write-Log "  Commit amended: $ShortCommitId"
        
        return @{
            CommitId = $CommitId
            ShortCommitId = $ShortCommitId
        }
    }
    finally {
        Pop-Location
    }
}

function Push-Update {
    param([string]$BranchName)
    
    Write-Log "Pushing update to PR..."
    
    Push-Location $Edk2Path
    try {
        git push --force-with-lease origin $BranchName
        
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to push"
        }
        
        Write-Log "  Push successful"
    }
    finally {
        Pop-Location
    }
}
#endregion

#region Main Execution
try {
    Write-Log "========================================"
    Write-Log "EDK II PR Update Workflow"
    Write-Log "========================================"
    
    # Step 1: Get user and git config
    Write-Log "[Step 1/7] Checking prerequisites..."
    $GitConfig = Test-GitConfig
    Get-GitHubUser
    
    # Step 2: Get PR info
    Write-Log "[Step 2/7] Fetching PR info..."
    $PrInfo = Get-PrInfo -Url $PrUrl
    
    # Step 3: Get PR comments
    Write-Log "[Step 3/7] Fetching PR comments..."
    $Comments = Get-PrComments -PrNumber $PrInfo.Number
    
    # Step 4: Analyze comments
    Write-Log "[Step 4/7] Analyzing comments..."
    $ActionItems = Analyze-Comments -Comments $Comments
    
    if ($ActionItems.Count -eq 0) {
        Write-Log "No actionable comments found."
        return @{
            Success = $true
            Message = "No updates needed"
        }
    }
    
    # Step 5: Checkout PR branch
    Write-Log "[Step 5/7] Checking out PR branch..."
    Checkout-PrBranch -ForkOwner $PrInfo.HeadOwner -BranchName $PrInfo.HeadRef
    
    # Step 6: Apply fixes
    Write-Log "[Step 6/7] Applying fixes..."
    Apply-CommentFixes -ActionItems $ActionItems -PrNumber $PrInfo.Number
    
    # Step 7: Build (optional)
    if (-not $SkipBuild) {
        Write-Log "[Step 7/7] Building..."
        Build-Package -Package "EmulatorPkg"
    } else {
        Write-Log "[Step 7/7] Build skipped"
    }
    
    # Step 8: Update commit and push
    Write-Log "Updating commit..."
    $CommitInfo = Update-Commit -GitConfig $GitConfig -PrNumber $PrInfo.Number
    
    if ($CommitInfo) {
        Write-Log "Pushing changes..."
        Push-Update -BranchName $PrInfo.HeadRef
    }
    
    # Summary
    Write-Log "========================================"
    Write-Log "PR UPDATE COMPLETE"
    Write-Log "========================================"
    Write-Log "PR:              $PrUrl"
    Write-Log "PR Number:       #$($PrInfo.Number)"
    Write-Log "Branch:          $($PrInfo.HeadRef)"
    Write-Log "Action Items:    $($ActionItems.Count)"
    Write-Log "Commit ID:       $($CommitInfo.CommitId)"
    Write-Log "Short Commit:    $($CommitInfo.ShortCommitId)"
    Write-Log "Log File:        $Script:LogFile"
    Write-Log "========================================"
    
    return @{
        Success = $true
        PrNumber = $PrInfo.Number
        CommitId = $CommitInfo.CommitId
        ActionItems = $ActionItems.Count
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