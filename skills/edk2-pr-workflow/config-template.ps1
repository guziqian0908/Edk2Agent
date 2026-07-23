# EDK II PR Workflow Configuration Template
# Copy this to edk2-pr-config.ps1 and customize

# GitHub Configuration
$env:GITHUB_USER = "your-github-username"  # Your GitHub username
$GitUserName = "Your Name"                   # Your full name for commits
$GitUserEmail = "your.email@example.com"     # Your email for commits

# EDK2 Configuration
$Edk2RepoUrl = "https://github.com/tianocore/edk2.git"
$Edk2UpstreamRemote = "upstream"
$Edk2ForkRemote = "origin"

# Build Configuration
$DefaultToolchain = "VS2022"  # VS2022, VS2019, VS2017
$DefaultArch = "X64"          # X64, IA32, ARM, AARCH64

# PR Configuration
$DefaultPrBase = "master"
$PrBodyTemplate = @"
## Description

{description}

## Problem

{problem}

## Solution

{solution}

## Testing

{testing}

## Related Issue

Fixes {issue_url}
"@

# Package to DSC mapping
$PackageDscMap = @{
    "EmulatorPkg" = "EmulatorPkg/EmulatorPkg.dsc"
    "OvmfPkg" = "OvmfPkg/OvmfPkgX64.dsc"
    "MdeModulePkg" = "MdeModulePkg/MdeModulePkg.dsc"
    "MdePkg" = "MdePkg/MdePkg.dsc"
    "UefiCpuPkg" = "UefiCpuPkg/UefiCpuPkg.dsc"
    "ShellPkg" = "ShellPkg/ShellPkg.dsc"
    "NetworkPkg" = "NetworkPkg/NetworkPkg.dsc"
    "SecurityPkg" = "SecurityPkg/SecurityPkg.dsc"
    "FatPkg" = "FatPkg/FatPkg.dsc"
}

# Branch naming convention
# {type}/{package}-{description}-issue{number}
$BranchNameTemplate = "{type}/{package}-{description}-issue{number}"

# Commit message format
# {Package}: {Brief description}
# {Detailed description}
# Fixes: {issue_url}
# Signed-off-by: {name} <{email}>
$CommitTitleTemplate = "{Package}: {BriefDescription}"

# Function to initialize git config
function Initialize-GitConfig {
    git config --global user.name $GitUserName
    git config --global user.email $GitUserEmail
    Write-Host "Git config set to: $GitUserName <$GitUserEmail>"
}

# Function to verify prerequisites
function Test-Prerequisites {
    $Errors = @()
    
    # Check gh CLI
    try {
        $GhVersion = gh --version
        Write-Host "gh CLI: OK"
    } catch {
        $Errors += "gh CLI not found. Install from: https://cli.github.com/"
    }
    
    # Check gh auth
    try {
        gh auth status 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "gh auth: OK"
        } else {
            $Errors += "gh not authenticated. Run: gh auth login"
        }
    } catch {
        $Errors += "gh auth check failed"
    }
    
    # Check git
    try {
        $GitVersion = git --version
        Write-Host "git: OK"
    } catch {
        $Errors += "git not found"
    }
    
    # Check Python
    try {
        $PythonVersion = python --version
        Write-Host "Python: OK"
    } catch {
        $Errors += "Python not found"
    }
    
    # Check git config
    $GitName = git config user.name
    $GitEmail = git config user.email
    if (-not $GitName -or -not $GitEmail) {
        $Errors += "Git user.name and user.email not configured"
    } else {
        Write-Host "Git config: OK ($GitName <$GitEmail>)"
    }
    
    if ($Errors.Count -gt 0) {
        Write-Host "`nErrors found:" -ForegroundColor Red
        foreach ($Error in $Errors) {
            Write-Host "  - $Error" -ForegroundColor Red
        }
        return $false
    }
    
    Write-Host "`nAll prerequisites met!" -ForegroundColor Green
    return $true
}

# Export functions
Export-ModuleMember -Function Initialize-GitConfig, Test-Prerequisites