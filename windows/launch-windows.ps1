param(
  [switch]$Status,
  [switch]$Check,
  [switch]$Restart,
  [switch]$Windowless
)

$ErrorActionPreference = 'Continue'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $RepoRoot 'tools\launch.mjs'

$node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $node) {
  $known = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
  )
  $node = $known | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $node) {
  Write-Host 'Node.js 22+ is required: "node" was not found in PATH.' -ForegroundColor Yellow
  exit 1
}

function Get-Candidates {
  $list = New-Object System.Collections.Generic.List[string]
  $local = $env:LOCALAPPDATA
  foreach ($name in @('WorkBuddyAI', 'WorkBuddy', 'workbuddy', '@genieworkbuddy-desktop')) {
    $list.Add((Join-Path $local "Programs\$name")) | Out-Null
    $list.Add((Join-Path $env:ProgramFiles $name)) | Out-Null
    $list.Add((Join-Path ${env:ProgramFiles(x86)} $name)) | Out-Null
  }
  $programs = Join-Path $local 'Programs'
  if (Test-Path $programs) {
    Get-ChildItem $programs -Directory -ErrorAction SilentlyContinue | Where-Object {
      $_.Name -match 'workbuddy|work-buddy'
    } | ForEach-Object { $list.Add($_.FullName) | Out-Null }
  }
  return $list
}

$install = $null
foreach ($candidate in Get-Candidates) {
  if ($candidate -and (Test-Path (Join-Path $candidate 'resources\app.asar'))) { $install = $candidate; break }
}

if (-not $install) {
  Write-Host 'WorkBuddy not found — pass -Root to tools/launch.mjs if it lives elsewhere.' -ForegroundColor Yellow
  exit 1
}

# The launcher does the process handling itself (it knows the exact executable
# name and reports a clear message when another instance is open), so -Restart
# is simply forwarded instead of killing by folder path here.
$nodeArgs = @($Launcher, '--root', $install)
if ($Status) { $nodeArgs += '--status' }
if ($Check) { $nodeArgs += '--check' }
if ($Restart) { $nodeArgs += '--restart' }
if ($Windowless) { $nodeArgs += '--quiet' }

& $node @nodeArgs
exit $LASTEXITCODE
