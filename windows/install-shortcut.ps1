param(
  [switch]$NoDesktop,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $PSScriptRoot 'launch-windows.ps1'
$Name = 'WorkBuddy RTL'

$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$targets = @((Join-Path $startMenu "$Name.lnk"))
if (-not $NoDesktop) { $targets += (Join-Path $desktop "$Name.lnk") }

if ($Remove) {
  foreach ($target in $targets) { Remove-Item $target -Force -ErrorAction SilentlyContinue }
  Write-Host "Removed: $($targets -join ', ')"
  exit 0
}

$icon = "$env:SystemRoot\System32\shell32.dll,0"
$install = $null
foreach ($candidate in @(
    (Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddyAI'),
    (Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy'),
    (Join-Path $env:LOCALAPPDATA 'Programs\@genieworkbuddy-desktop'),
    (Join-Path $env:ProgramFiles 'WorkBuddyAI')
  )) {
  if ($candidate -and (Test-Path (Join-Path $candidate 'resources\app.asar'))) { $install = $candidate; break }
}
if ($install) {
  $exe = Get-ChildItem $install -Filter '*.exe' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'workbuddy' } |
    Sort-Object Length -Descending | Select-Object -First 1
  if ($exe) { $icon = $exe.FullName + ',0' }
}

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
# -Ensure: clicking the shortcut always leaves WorkBuddy running *with* the
# layer. If WorkBuddy is already open without it, that instance is replaced;
# if it is already patched, the launcher raises the window instead.
# -NoProfile keeps the hidden run from loading the user's profile scripts, which
# are a common source of slow starts and of output nobody ever sees.
$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Launcher`" -Windowless -Ensure"

$shell = New-Object -ComObject WScript.Shell
foreach ($target in $targets) {
  $dir = Split-Path -Parent $target
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $shortcut = $shell.CreateShortcut($target)
  $shortcut.TargetPath = $powershell
  $shortcut.Arguments = $arguments
  $shortcut.WorkingDirectory = $RepoRoot
  $shortcut.IconLocation = $icon
  $shortcut.Description = 'WorkBuddy with Persian font and RTL support'
  $shortcut.Save()
  Write-Host "Created: $target"
}
Write-Host 'Launch WorkBuddy through this shortcut so the patch survives updates.'
