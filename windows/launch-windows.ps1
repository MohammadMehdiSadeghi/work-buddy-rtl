param(
  [switch]$Status,
  [switch]$Check,
  [switch]$Restart,
  [switch]$Ensure,
  [switch]$Windowless
)

$ErrorActionPreference = 'Continue'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $RepoRoot 'tools\launch.mjs'
$LogFile = Join-Path $env:TEMP 'workbuddy-rtl.log'

# The shortcut runs this hidden, so a failure has to leave a trace somewhere a
# person can find: same file the launcher writes to, same path --status prints.
function Fail([string]$message) {
  try { Add-Content -Path $LogFile -Value ("{0}  ERROR {1}" -f (Get-Date -Format o), $message) } catch {}
  Write-Host $message -ForegroundColor Yellow
  exit 1
}

$node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $node) {
  $known = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
    "$env:APPDATA\npm\node.exe"
  )
  # WorkBuddy ships its own Node runtime and does not add it to the persistent
  # PATH, so on a machine without a separate Node install the shortcut used to
  # die here — invisibly, because it runs windowless. Look for the bundled copy.
  $bundledRoot = Join-Path $env:USERPROFILE '.workbuddy-ai\binaries\node\versions'
  if (Test-Path $bundledRoot) {
    $known += Get-ChildItem $bundledRoot -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName 'node.exe' }
  }
  $node = $known | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $node) {
  Fail 'Node.js 22+ is required: "node" was not found in PATH, and WorkBuddy ships no bundled runtime.'
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
  Fail 'WorkBuddy not found — pass -Root to tools/launch.mjs if it lives elsewhere.'
}

# The launcher does the process handling itself (it knows the exact executable
# name and reports a clear message when another instance is open), so -Restart
# is simply forwarded instead of killing by folder path here.
$nodeArgs = @($Launcher, '--root', $install)
if ($Status) { $nodeArgs += '--status' }
if ($Check) { $nodeArgs += '--check' }
if ($Restart) { $nodeArgs += '--restart' }
if ($Ensure) { $nodeArgs += '--ensure' }
if ($Windowless) { $nodeArgs += '--quiet' }

& $node @nodeArgs
exit $LASTEXITCODE
