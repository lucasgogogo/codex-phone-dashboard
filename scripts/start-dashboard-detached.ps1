Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serverPath = Join-Path $projectRoot 'src-node\server.js'
$runtimeInfoPath = Join-Path $env:LOCALAPPDATA 'CodexPhoneDashboard\runtime-info.json'
$nodePath = (Get-Command node -ErrorAction Stop).Source

$existingServers = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and $_.CommandLine.IndexOf($serverPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
})
if ($existingServers.Count -gt 0) { exit 0 }

Start-Process -FilePath $nodePath -ArgumentList ('"' + $serverPath + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden | Out-Null
