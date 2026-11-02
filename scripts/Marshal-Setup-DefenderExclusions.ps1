# Marshal-owned path
# Marshal-Setup-DefenderExclusions.ps1
# Configures Windows Defender exclusions for faster builds and dev workflow.
# Must be run from an elevated (admin) PowerShell.
$ErrorActionPreference = 'Stop'

# Check for admin
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "This script must be run as Administrator."
}

$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path

# Detect pnpm store location (may be customized via pnpm config)
$pnpmStore = $null
try { $pnpmStore = (pnpm store path 2>$null) } catch {}

# ── Folder exclusions ──────────────────────────────────────
$folders = @(
    $repoRoot                                                        # This repo clone
    (Join-Path $env:LOCALAPPDATA "pnpm")                             # pnpm global bin
    (Join-Path $env:LOCALAPPDATA "npm-cache")                        # npm cache
    (Join-Path $env:APPDATA "npm")                                   # npm global
    (Join-Path $env:LOCALAPPDATA "electron-builder")                 # Electron zips, NSIS, winCodeSign
    (Join-Path $env:LOCALAPPDATA "electron")                         # Electron cache
    (Join-Path $env:APPDATA "Code")                                  # VS Code extensions & workspace storage
    (Join-Path $env:USERPROFILE ".vscode")                           # VS Code user config
    $env:TEMP                                                        # Temp (builds, NSIS, signing)
)
if ($pnpmStore) { $folders += $pnpmStore }                           # pnpm content-addressable store

$existing = (Get-MpPreference).ExclusionPath
if (-not $existing) { $existing = @() }

foreach ($folder in $folders) {
    if ($existing -contains $folder) {
        Write-Host "  Already excluded: $folder"
    } elseif (-not (Test-Path $folder)) {
        Write-Host "  Skipped (does not exist): $folder"
    } else {
        Add-MpPreference -ExclusionPath $folder
        Write-Host "  Excluding folder: $folder"
    }
}

# ── Process exclusions ─────────────────────────────────────
$processes = @(
    "node.exe"          # Core build toolchain (pnpm, vite, vitest, electron-builder)
    "electron.exe"      # Electron dev mode & E2E tests
    "Code.exe"          # VS Code
    "app-builder.exe"   # electron-builder native helper (asar, signing)
    "makensis.exe"      # NSIS installer compiler
    "signtool.exe"      # Code signing
    "pnpm.exe"          # Package management
    "playwright.exe"    # E2E test runner
    "chrome.exe"        # Browser tests
    "chromium.exe"      # Browser tests
    "git.exe"           # Git
    "csc.exe"           # .NET C# compiler (node-runner)
    "dotnet.exe"        # .NET SDK
)

$existingProcs = (Get-MpPreference).ExclusionProcess
if (-not $existingProcs) { $existingProcs = @() }

foreach ($proc in $processes) {
    if ($existingProcs -contains $proc) {
        Write-Host "  Already excluded: $proc"
    } else {
        Add-MpPreference -ExclusionProcess $proc
        Write-Host "  Excluding process: $proc"
    }
}

Write-Host ""
Write-Host "Done. Windows Defender exclusions configured for dev workflow."
