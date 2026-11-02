param(
  [Parameter(Mandatory=$true)][string]$Worktree,
  [Parameter(Mandatory=$true)][int]$Port,
  [int]$Cycles = 30,
  [string]$Label = "fixed"
)
# Build a worktree, launch an isolated mock instance, and run a same-session soak.
$ErrorActionPreference = "Continue"
$files = "C:\Users\omerm\.marshal\marshal-sessions\7df12095-d1b9-4aa3-af15-74580c4bb962\files"

Write-Host "=== [$Label] building $Worktree ==="
Push-Location $Worktree
$env:MARSHAL_E2E = ""
$sw = [System.Diagnostics.Stopwatch]::StartNew()
node node_modules\vite\bin\vite.js build 2>&1 | Select-Object -Last 3 | Out-Host
$sw.Stop()
if ($LASTEXITCODE -ne 0) { Write-Host "BUILD FAILED (exit $LASTEXITCODE)"; Pop-Location; exit 1 }
Write-Host "build OK: $([math]::Round($sw.Elapsed.TotalSeconds,1))s"
Pop-Location

$udd = Join-Path $env:TEMP "m-verify-udd-$Port"
$log = Join-Path $env:TEMP "m-verify-$Port.log"
if (Test-Path $udd) { Remove-Item $udd -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $udd -Force | Out-Null
$env:MARSHAL_E2E = "1"; $env:ELECTRON_ENABLE_LOGGING = "1"
$p = Start-Process -FilePath (Join-Path $Worktree "node_modules\electron\dist\electron.exe") `
  -ArgumentList @(".","--no-sandbox","--remote-debugging-port=$Port","--user-data-dir=$udd") `
  -WorkingDirectory $Worktree -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err" -WindowStyle Minimized
$p.Id | Out-File (Join-Path $env:TEMP "m-verify-$Port.pid")
Write-Host "launched PID $($p.Id) on port $Port"
Start-Sleep -Seconds 8

Push-Location $files
$env:PORT = "$Port"
$env:CYCLES = "$Cycles"; $env:MODE = "soak"; $env:SAME_SESSION = "1"; $env:OUT = "verify-$Label.json"
node soak.mjs 2>&1 | Select-String "cycle 1:|cycle $Cycles`:|heapMB_first|heapMB_last|Slope|cycles"
Pop-Location

Write-Host "=== [$Label] killing instance ==="
try { Stop-Process -Id $p.Id -Force } catch {}
