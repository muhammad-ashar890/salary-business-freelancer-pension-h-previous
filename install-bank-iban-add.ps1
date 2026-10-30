# Installs the Bank IBAN add fix (commit 6aaded0) into the TaxRocket project.
#
# This copies every file the fix needs (both electron-connect files and the test
# script), keeps a backup of the old ones, checks the new code is really in place,
# then runs the test.
#
# Run it from anywhere:
#   powershell -ExecutionPolicy Bypass -File .\install-bank-iban-add.ps1
#
# The ZIP root is the project root, so the files sit next to electron-connect\ and
# scripts\ as soon as it is expanded here. If you expanded it somewhere else, pass
# the project path:
#   powershell -ExecutionPolicy Bypass -File .\install-bank-iban-add.ps1 -ProjectPath "C:\path\to\project"

param(
  [string]$ProjectPath = "C:\Users\User\Downloads\tr-pension-merge-branch-20261026"
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot

function Stop-With($message) {
  Write-Host ""
  Write-Host "STOPPED: $message" -ForegroundColor Red
  exit 1
}

Write-Host "Project : $ProjectPath"
Write-Host "Pack    : $here"
Write-Host ""

if (-not (Test-Path (Join-Path $ProjectPath "electron-connect"))) {
  Stop-With "no electron-connect folder in $ProjectPath. Pass the real project path with -ProjectPath."
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = Join-Path $ProjectPath "backup-before-bank-iban-fix-$stamp"
New-Item -ItemType Directory -Path (Join-Path $backup "electron-connect") -Force | Out-Null

$files = @(
  @{ From = "electron-connect\iris-wealth-driver.js"; To = "electron-connect\iris-wealth-driver.js" },
  @{ From = "electron-connect\job-report.js";        To = "electron-connect\job-report.js" },
  @{ From = "scripts\verify-bank-iban-add.cjs";      To = "scripts\verify-bank-iban-add.cjs" }
)

foreach ($file in $files) {
  $source = Join-Path $here $file.From
  if (-not (Test-Path $source)) {
    Stop-With "$($file.From) is not in the pack. Expand the whole ZIP first, do not copy single files out of it."
  }
  $target = Join-Path $ProjectPath $file.To
  if (Test-Path $target) {
    $keep = Join-Path $backup $file.To
    New-Item -ItemType Directory -Path (Split-Path $keep) -Force | Out-Null
    Copy-Item $target $keep -Force
    Write-Host "backed up : $($file.To)"
  }
  New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
  Copy-Item $source $target -Force
  Write-Host "installed : $($file.To)"
}

Write-Host ""
Write-Host "Backup of the old files: $backup"
Write-Host ""

$driver = Get-Content (Join-Path $ProjectPath "electron-connect\iris-wealth-driver.js") -Raw
$report = Get-Content (Join-Path $ProjectPath "electron-connect\job-report.js") -Raw
$hasFallback = $driver.Contains("bank_row_already_present")
$hasIbanLookup = $driver.Contains("aria-label")
$hasOldWords = $report.Contains("IRIS did not let the agent add this row")

Write-Host "Check 1: driver re-uses a row IRIS already holds : $hasFallback"
Write-Host "Check 2: driver finds the IBAN box by its label    : $hasIbanLookup"
Write-Host "Check 3: old message removed from job-report      : $(-not $hasOldWords)"
Write-Host ""

if (-not $hasFallback -or -not $hasIbanLookup -or $hasOldWords) {
  Stop-With "the installed files are not the new ones. Close the agent, then run this again from a full expand of the ZIP."
}

Write-Host "Running the test..." -ForegroundColor Cyan
Push-Location $ProjectPath
try {
  node --test (Join-Path $ProjectPath "scripts\verify-bank-iban-add.cjs")
} finally {
  Pop-Location
}
