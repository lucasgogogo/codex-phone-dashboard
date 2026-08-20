[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$startupScript = Join-Path $projectRoot 'scripts\configure-startup-task.ps1'
$supportRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'CodexPhoneDashboard'))
$authStatePath = [System.IO.Path]::GetFullPath((Join-Path $supportRoot 'auth-state.json'))
if (-not $authStatePath.StartsWith($supportRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Authentication state path is outside the expected support directory.'
}

$installedTask = Get-ScheduledTask -TaskName 'Codex Phone Dashboard' -ErrorAction SilentlyContinue
if (-not $installedTask) {
  throw 'Reset requires the installed background task. Foreground npm start mode is diagnostic-only.'
}

& $startupScript -Action Stop | Out-Null
$remainingServers = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and $_.CommandLine.IndexOf((Join-Path $projectRoot 'src-node\server.js'), [System.StringComparison]::OrdinalIgnoreCase) -ge 0
})
if ($remainingServers.Count -gt 0) { throw 'The Dashboard server is still running; authorization was not changed.' }
$oldAuthHash = if (Test-Path -LiteralPath $authStatePath -PathType Leaf) { (Get-FileHash -LiteralPath $authStatePath -Algorithm SHA256).Hash } else { $null }
if (Test-Path -LiteralPath $authStatePath -PathType Leaf) {
  Remove-Item -LiteralPath $authStatePath -Force
}
$newStatus = & $startupScript -Action Start
if (-not (Test-Path -LiteralPath $authStatePath -PathType Leaf)) { throw 'The replacement authorization state was not created.' }
$newAuthHash = (Get-FileHash -LiteralPath $authStatePath -Algorithm SHA256).Hash
if ($oldAuthHash -and $oldAuthHash -eq $newAuthHash) { throw 'Authorization state did not rotate.' }
$newStatus
