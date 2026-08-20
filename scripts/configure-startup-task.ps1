param(
  [ValidateSet('Install', 'Remove', 'Start', 'Stop', 'Restart', 'Status')]
  [string]$Action = 'Status'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$taskName = 'Codex Phone Dashboard'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serverPath = Join-Path $projectRoot 'src-node\server.js'
$launcherPath = Join-Path $projectRoot 'scripts\start-dashboard-detached.ps1'
$runtimeInfoPath = Join-Path $env:LOCALAPPDATA 'CodexPhoneDashboard\runtime-info.json'
$runtimeInfoDir = Split-Path -Parent $runtimeInfoPath
$nodePath = (Get-Command node -ErrorAction Stop).Source
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

function Get-DashboardTask {
  Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}

function Get-DashboardProcesses {
  @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($serverPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  })
}

function Protect-RuntimeDirectory {
  New-Item -ItemType Directory -Path $runtimeInfoDir -Force | Out-Null
  $userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $grants = @(
    ('*' + $userSid + ':(OI)(CI)F'),
    '*S-1-5-18:(OI)(CI)F',
    '*S-1-5-32-544:(OI)(CI)F'
  )
  $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
  & $icacls $runtimeInfoDir '/inheritance:r' '/grant:r' $grants '/Q' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Unable to protect runtime directory (icacls exit $LASTEXITCODE)." }
}

function Get-LiveDashboardRuntime {
  if (-not (Test-Path -LiteralPath $runtimeInfoPath)) { return $null }
  try {
    $runtime = Get-Content -LiteralPath $runtimeInfoPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $process = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$runtime.processId) -ErrorAction SilentlyContinue
    if ($process -and $process.CommandLine -like ('*' + $serverPath + '*')) { return $runtime }
  } catch {}
  return $null
}

function Stop-DashboardProcess {
  $dashboardProcesses = @(Get-DashboardProcesses)
  foreach ($dashboardProcess in $dashboardProcesses) {
    Stop-Process -Id ([int]$dashboardProcess.ProcessId) -Force
  }
  foreach ($dashboardProcess in $dashboardProcesses) {
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
      if (-not (Get-Process -Id ([int]$dashboardProcess.ProcessId) -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 200
    }
  }
  $remaining = @(Get-DashboardProcesses)
  if ($remaining.Count -gt 0) { throw 'Unable to stop the exact Codex Phone Dashboard server process.' }
}

function Show-DashboardStatus {
  $task = Get-DashboardTask
  $info = if ($task) { Get-ScheduledTaskInfo -TaskName $taskName } else { $null }
  $runtime = Get-LiveDashboardRuntime
  $runtimeLive = [bool]$runtime
  [pscustomobject]@{
    Installed = [bool]$task
    State = if (-not $task) { 'NotInstalled' } elseif ($runtimeLive) { 'Running' } else { 'Stopped' }
    SchedulerState = if ($task) { [string]$task.State } else { 'NotInstalled' }
    LastTaskResult = if ($info) { $info.LastTaskResult } else { $null }
    ProcessId = if ($runtimeLive) { $runtime.processId } else { $null }
    PairingCode = if ($runtimeLive -and [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$runtime.pairingExpiresAt) -gt [DateTimeOffset]::Now) { $runtime.pairingCode } else { 'ExpiredOrUnavailable' }
    PairingExpiresAt = if ($runtimeLive) { [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$runtime.pairingExpiresAt).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss') } else { $null }
    Urls = if ($runtimeLive) { @($runtime.urls) -join ', ' } else { $null }
  }
}

function Wait-DashboardReady {
  for ($attempt = 0; $attempt -lt 15; $attempt++) {
    $status = Show-DashboardStatus
    if ($status.ProcessId) { return $status }
    Start-Sleep -Seconds 1
  }
  Show-DashboardStatus
}

switch ($Action) {
  'Install' {
    if (-not (Test-Path -LiteralPath $serverPath) -or -not (Test-Path -LiteralPath $launcherPath)) { throw 'Dashboard entry files are missing.' }
    $existingTask = Get-DashboardTask
    if ($existingTask -and $existingTask.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName }
    Stop-DashboardProcess
    Protect-RuntimeDirectory
    $powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcherPath + '"'
    $taskAction = New-ScheduledTaskAction -Execute $powershellPath -Argument $arguments -WorkingDirectory $projectRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Description 'Private read-only Codex dashboard for a phone on the same Wi-Fi.' -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Wait-DashboardReady
  }
  'Remove' {
    $task = Get-DashboardTask
    if ($task) {
      if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName }
      Stop-DashboardProcess
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    Show-DashboardStatus
  }
  'Start' {
    if (-not (Get-DashboardTask)) { throw 'Dashboard task is not installed.' }
    if (Get-LiveDashboardRuntime) { return Show-DashboardStatus }
    Protect-RuntimeDirectory
    Start-ScheduledTask -TaskName $taskName
    Wait-DashboardReady
  }
  'Stop' {
    $task = Get-DashboardTask
    if ($task -and $task.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName }
    Stop-DashboardProcess
    Start-Sleep -Seconds 1
    Show-DashboardStatus
  }
  'Restart' {
    $task = Get-DashboardTask
    if (-not $task) { throw 'Dashboard task is not installed.' }
    if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName }
    Stop-DashboardProcess
    Protect-RuntimeDirectory
    Start-ScheduledTask -TaskName $taskName
    Wait-DashboardReady
  }
  'Status' { Show-DashboardStatus }
}
