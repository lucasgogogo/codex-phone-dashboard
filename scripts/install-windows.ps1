[CmdletBinding()]
param(
  [switch]$SkipFirewall,
  [switch]$SkipStartup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$node = Get-Command node -ErrorAction Stop
$npm = Get-Command npm -ErrorAction Stop
$major = [int]((& $node.Source --version).TrimStart('v').Split('.')[0])
if ($major -lt 20) { throw 'Node.js 20 or newer is required.' }

Push-Location $projectRoot
try {
  & $npm.Source install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE." }
  & $npm.Source test
  if ($LASTEXITCODE -ne 0) { throw "npm test failed with exit code $LASTEXITCODE." }
} finally {
  Pop-Location
}

if (-not $SkipFirewall) {
  & (Join-Path $PSScriptRoot 'configure-windows-firewall.ps1')
}
if (-not $SkipStartup) {
  & (Join-Path $PSScriptRoot 'configure-startup-task.ps1') -Action Install
} else {
  Write-Output 'Startup installation skipped. Run npm start from the project folder for foreground mode.'
}
