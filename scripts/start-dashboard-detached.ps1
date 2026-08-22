Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serverPath = Join-Path $projectRoot 'src-node\server.js'
$runtimeInfoDir = Join-Path $env:LOCALAPPDATA 'CodexPhoneDashboard'
$lifecycleLogPath = Join-Path $runtimeInfoDir 'service-events.log'
$nodePath = (Get-Command node -ErrorAction Stop).Source
$maxLogLines = 100

function Write-LifecycleEvent {
  param([string]$Event)

  try {
    New-Item -ItemType Directory -Path $runtimeInfoDir -Force | Out-Null
    $timestamp = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    $allowedLine = '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z (launcher_started|server_started|existing_server_detected|server_exit code=-?\d+|restart_wait_seconds=5)$'
    [string[]]$history = if (Test-Path -LiteralPath $lifecycleLogPath) {
      @(Get-Content -LiteralPath $lifecycleLogPath -Encoding ASCII | Where-Object { $_ -match $allowedLine })
    } else { @() }
    [string[]]$lines = @($history) + @(($timestamp + ' ' + $Event))
    $lines = @($lines | Select-Object -Last $maxLogLines)
    $content = ($lines -join [Environment]::NewLine) + [Environment]::NewLine
    [System.IO.File]::WriteAllText($lifecycleLogPath, $content, [System.Text.Encoding]::ASCII)
  } catch {}
}

Write-LifecycleEvent 'launcher_started'
while ($true) {
  $existingServers = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($serverPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  if ($existingServers.Count -gt 0) {
    Write-LifecycleEvent 'existing_server_detected'
    Start-Sleep -Seconds 5
    continue
  }

  Write-LifecycleEvent 'server_started'
  $nodeExitCode = 1
  Push-Location -LiteralPath $projectRoot
  try {
    & $nodePath $serverPath
    $nodeExitCode = if ($null -eq $LASTEXITCODE) { 1 } else { [int]$LASTEXITCODE }
  } catch {
    $nodeExitCode = 1
  } finally {
    Pop-Location
  }
  Write-LifecycleEvent ('server_exit code=' + $nodeExitCode)
  Write-LifecycleEvent 'restart_wait_seconds=5'
  Start-Sleep -Seconds 5
}
