[CmdletBinding(DefaultParameterSetName = 'Validate')]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')]
  [string]$Version,

  [Parameter(Mandatory = $true, ParameterSetName = 'Validate')]
  [switch]$ValidateOnly,

  [Parameter(Mandatory = $true, ParameterSetName = 'Publish')]
  [switch]$Publish,

  [Parameter(Mandatory = $true, ParameterSetName = 'Publish')]
  [string]$NotesFile,

  [Parameter(ParameterSetName = 'Publish')]
  [string]$Title = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Repository = 'lucasgogogo/codex-phone-dashboard'
$tagName = if ($Version.StartsWith('v', [System.StringComparison]::OrdinalIgnoreCase)) { $Version } else { "v$Version" }
$packageVersion = $tagName.Substring(1)

function Resolve-Program {
  param([string]$Name, [string[]]$FallbackPaths = @())

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  foreach ($candidate in $FallbackPaths) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  throw "$Name is required but was not found."
}

function Invoke-Native {
  param(
    [string]$Name,
    [string]$Program,
    [string[]]$Arguments,
    [switch]$AllowFailure
  )

  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $lines = @(& $Program @Arguments 2>&1 | ForEach-Object { $_.ToString() })
    $nativeExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  $text = ($lines -join [Environment]::NewLine).Trim()
  if (-not $AllowFailure -and $nativeExit -ne 0) {
    throw "$Name failed with exit code $nativeExit.$([Environment]::NewLine)$text"
  }
  [pscustomobject]@{ ExitCode = $nativeExit; Output = $text }
}

function Get-ReleaseState {
  param([string]$GhPath, [string]$Tag)

  $result = Invoke-Native -Name 'release lookup' -Program $GhPath -Arguments @(
    'release', 'view', $Tag, '--repo', $Repository,
    '--json', 'tagName,name,isDraft,isPrerelease,targetCommitish,url'
  ) -AllowFailure
  if ($result.ExitCode -eq 0) {
    return [pscustomobject]@{ Exists = $true; Data = ($result.Output | ConvertFrom-Json) }
  }
  if ($result.Output -match '(?i)^release not found$|HTTP 404') {
    return [pscustomobject]@{ Exists = $false; Data = $null }
  }
  throw "Release lookup failed and did not return a confirmed not-found response.$([Environment]::NewLine)$($result.Output)"
}

function Get-RemoteTagCommit {
  param([string]$GitPath, [string]$Tag)

  $result = Invoke-Native -Name 'remote tag check' -Program $GitPath -Arguments @(
    'ls-remote', '--exit-code', 'origin', "refs/tags/$Tag", "refs/tags/$Tag^{}"
  ) -AllowFailure
  if ($result.ExitCode -ne 0) { throw "Remote tag '$Tag' does not exist." }
  $rows = @($result.Output -split "`r?`n" | Where-Object { $_ })
  $peeledRow = $rows | Where-Object { $_ -match [regex]::Escape("refs/tags/$Tag^{}") } | Select-Object -First 1
  $selectedRow = if ($peeledRow) { $peeledRow } else { $rows | Select-Object -First 1 }
  ($selectedRow -split '\s+')[0]
}

function Get-LatestReleaseTag {
  param([string]$GhPath)

  $result = Invoke-Native -Name 'latest Release lookup' -Program $GhPath -Arguments @(
    'release', 'view', '--repo', $Repository, '--json', 'tagName'
  )
  ($result.Output | ConvertFrom-Json).tagName
}

$gitPath = Resolve-Program -Name 'git'
$ghPath = Resolve-Program -Name 'gh' -FallbackPaths @(
  (Join-Path $env:LOCALAPPDATA 'Programs\GitHub CLI\bin\gh.exe')
)
$currentPowerShell = (Get-Process -Id $PID).Path

Push-Location $projectRoot
try {
  $repositoryRoot = (Invoke-Native -Name 'repository root' -Program $gitPath -Arguments @('rev-parse', '--show-toplevel')).Output
  if ([System.IO.Path]::GetFullPath($repositoryRoot) -ne $projectRoot) {
    throw 'Run this script from the Codex Phone Dashboard repository.'
  }

  $originUrl = (Invoke-Native -Name 'origin URL check' -Program $gitPath -Arguments @('remote', 'get-url', 'origin')).Output
  if ($originUrl -notmatch '^(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)') {
    throw "Git origin is not a supported GitHub URL: $originUrl"
  }
  $originRepository = $originUrl -replace '^https://github\.com/', '' -replace '^git@github\.com:', '' -replace '^ssh://git@github\.com/', ''
  $originRepository = $originRepository.TrimEnd('/')
  if ($originRepository.EndsWith('.git', [System.StringComparison]::OrdinalIgnoreCase)) {
    $originRepository = $originRepository.Substring(0, $originRepository.Length - 4)
  }
  if (-not $originRepository.Equals($Repository, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Git origin '$originRepository' does not match Release repository '$Repository'."
  }

  $branch = (Invoke-Native -Name 'branch check' -Program $gitPath -Arguments @('branch', '--show-current')).Output
  if ($branch -ne 'main') { throw "Release must run from main; current branch is '$branch'." }

  $workingTree = (Invoke-Native -Name 'working tree check' -Program $gitPath -Arguments @('status', '--short')).Output
  if ($workingTree) { throw 'Release requires a clean working tree.' }

  Invoke-Native -Name 'remote tag refresh' -Program $gitPath -Arguments @('fetch', '--quiet', 'origin', '--tags') | Out-Null
  $headCommit = (Invoke-Native -Name 'HEAD check' -Program $gitPath -Arguments @('rev-parse', 'HEAD')).Output
  $remoteMainResult = Invoke-Native -Name 'live origin/main check' -Program $gitPath -Arguments @(
    'ls-remote', '--exit-code', 'origin', 'refs/heads/main'
  )
  $originCommit = ($remoteMainResult.Output -split '\s+')[0]
  if ($headCommit -ne $originCommit) { throw 'Local main must exactly match the live origin/main commit.' }

  $manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $remoteTagCommit = Get-RemoteTagCommit -GitPath $gitPath -Tag $tagName

  Invoke-Native -Name 'public package validation' -Program $currentPowerShell -Arguments @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    (Join-Path $projectRoot 'scripts\validate-public-package.ps1'), '-SkipScreenshots'
  ) | Out-Null
  Invoke-Native -Name 'GitHub authentication' -Program $ghPath -Arguments @('auth', 'status', '--hostname', 'github.com') | Out-Null

  $releaseState = Get-ReleaseState -GhPath $ghPath -Tag $tagName
  if ($ValidateOnly) {
    if ($releaseState.Exists) {
      if ($releaseState.Data.tagName -ne $tagName) { throw 'Published Release tag does not match the requested tag.' }
      if ($releaseState.Data.isDraft -or $releaseState.Data.isPrerelease) { throw 'Published Release must be final, not draft or prerelease.' }
      Write-Output "VALIDATED existing Release $tagName at commit $remoteTagCommit and $($releaseState.Data.url)"
    } else {
      if ($manifest.version -ne $packageVersion) {
        throw "package.json version '$($manifest.version)' does not match tag '$tagName'."
      }
      if ($remoteTagCommit -ne $headCommit) { throw "Unpublished tag '$tagName' does not resolve to current main." }
      Write-Output "VALIDATED $tagName is ready for publication; no Release exists yet."
    }
    exit 0
  }

  if ($releaseState.Exists) { throw "Release '$tagName' already exists; refusing to publish a duplicate." }
  if ($manifest.version -ne $packageVersion) {
    throw "package.json version '$($manifest.version)' does not match tag '$tagName'."
  }
  if ($remoteTagCommit -ne $headCommit) { throw "Remote tag '$tagName' does not resolve to current main." }
  $resolvedNotes = [System.IO.Path]::GetFullPath($NotesFile)
  if (-not (Test-Path -LiteralPath $resolvedNotes -PathType Leaf)) { throw "Release notes file not found: $resolvedNotes" }
  if (-not $Title) { $Title = "Codex Phone Dashboard $tagName" }

  Invoke-Native -Name 'Release publication' -Program $ghPath -Arguments @(
    'release', 'create', $tagName, '--repo', $Repository, '--verify-tag', '--latest',
    '--title', $Title, '--notes-file', $resolvedNotes
  ) | Out-Null

  $publishedState = Get-ReleaseState -GhPath $ghPath -Tag $tagName
  if (-not $publishedState.Exists -or $publishedState.Data.isDraft -or $publishedState.Data.isPrerelease) {
    throw 'Release creation returned without a verifiable final Release.'
  }
  if ($publishedState.Data.tagName -ne $tagName -or $publishedState.Data.name -ne $Title) {
    throw 'Published Release tag or title does not match the requested values.'
  }
  if ($publishedState.Data.targetCommitish -notin @($branch, $headCommit)) {
    throw 'Published Release target does not match the validated main commit.'
  }
  $publishedTagCommit = Get-RemoteTagCommit -GitPath $gitPath -Tag $tagName
  if ($publishedTagCommit -ne $headCommit) { throw 'Published Release tag no longer resolves to the validated main commit.' }
  $latestTag = Get-LatestReleaseTag -GhPath $ghPath
  if ($latestTag -ne $tagName) { throw "Published Release '$tagName' is not the Latest Release." }
  Write-Output "PUBLISHED $tagName at $($publishedState.Data.url)"
} finally {
  Pop-Location
}
