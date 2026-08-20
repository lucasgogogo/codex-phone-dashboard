Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serverPath = Join-Path $projectRoot 'src-node\server.js'
$runtimeInfoPath = Join-Path $env:LOCALAPPDATA 'CodexPhoneDashboard\runtime-info.json'
$nodePath = (Get-Command node -ErrorAction Stop).Source

if (Test-Path -LiteralPath $runtimeInfoPath) {
  try {
    $runtime = Get-Content -LiteralPath $runtimeInfoPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $existing = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$runtime.processId) -ErrorAction SilentlyContinue
    if ($existing -and $existing.CommandLine -like ('*' + $serverPath + '*')) { exit 0 }
  } catch {}
}

Start-Process -FilePath $nodePath -ArgumentList ('"' + $serverPath + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden | Out-Null
