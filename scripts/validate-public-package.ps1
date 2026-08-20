[CmdletBinding()]
param(
  [string]$SkillValidatorPath = '',
  [switch]$SkipScreenshots
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$checks = [System.Collections.Generic.List[object]]::new()

function Invoke-CheckedNative {
  param([string]$Name, [string]$Program, [string[]]$Arguments)
  & $Program @Arguments
  $nativeExit = $LASTEXITCODE
  $checks.Add([pscustomobject]@{ Check = $Name; ExitCode = $nativeExit })
  if ($nativeExit -ne 0) { throw "$Name failed with exit code $nativeExit." }
}

Push-Location $projectRoot
try {
  $nodePath = (Get-Command node -ErrorAction Stop).Source
  $npmPath = (Get-Command npm -ErrorAction Stop).Source
  Invoke-CheckedNative -Name 'app-js-syntax' -Program $nodePath -Arguments @('--check', 'web/app.js')
  Invoke-CheckedNative -Name 'server-js-syntax' -Program $nodePath -Arguments @('--check', 'src-node/server.js')
  $powerShellFiles = @(
    'scripts/install-windows.ps1', 'scripts/configure-startup-task.ps1',
    'scripts/configure-windows-firewall.ps1', 'scripts/start-dashboard-detached.ps1',
    'scripts/validate-public-package.ps1'
  )
  foreach ($powerShellFile in $powerShellFiles) {
    $tokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $projectRoot $powerShellFile), [ref]$tokens, [ref]$parseErrors) | Out-Null
    if ($parseErrors.Count -gt 0) { throw "$powerShellFile has PowerShell syntax errors." }
  }
  $checks.Add([pscustomobject]@{ Check = 'powershell-syntax'; ExitCode = 0 })
  Invoke-CheckedNative -Name 'node-tests' -Program $npmPath -Arguments @('test')
  if (-not $SkipScreenshots) {
    Invoke-CheckedNative -Name 'readme-screenshots' -Program $npmPath -Arguments @('run', 'screenshots')
  }

  $bashCandidates = @(
    'C:\Program Files\Git\bin\bash.exe',
    'C:\Program Files\Git\usr\bin\bash.exe',
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\bin\bash.exe'),
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\usr\bin\bash.exe')
  )
  $rows = @(foreach ($candidate in $bashCandidates) {
    [pscustomobject]@{ Path = $candidate; Exists = Test-Path -LiteralPath $candidate -PathType Leaf }
  })
  $bashPath = $rows | Where-Object Exists | Select-Object -First 1 -ExpandProperty Path
  if ($bashPath) {
    Invoke-CheckedNative -Name 'mac-install-shell-syntax' -Program $bashPath -Arguments @('-n', 'scripts/install-macos.sh')
    Invoke-CheckedNative -Name 'mac-startup-shell-syntax' -Program $bashPath -Arguments @('-n', 'scripts/configure-startup-macos.sh')
  } else {
    $checks.Add([pscustomobject]@{ Check = 'mac-shell-syntax'; ExitCode = 'not-available-on-host' })
  }

  if ($SkillValidatorPath) {
    $pythonPath = (Get-Command python -ErrorAction Stop).Source
    Invoke-CheckedNative -Name 'skill-quick-validate' -Program $pythonPath -Arguments @($SkillValidatorPath, 'skills/codex-phone-dashboard')
  }

  $publicFiles = @(
    '.gitignore', 'LICENSE', 'README.md', 'README.zh-CN.md', 'THIRD_PARTY_NOTICES.md', 'config.example.json', 'package.json', 'package-lock.json',
    'web/index.html', 'web/app.js', 'web/styles.css', 'src-node/server.js', 'src-node/snapshot-service.js',
    'src-node/app-server-client.js', 'src-node/rollout-observer.js', 'src-node/runtime-info.js',
    'src-node/remote-rollout-observer.js', 'scripts/install-windows.ps1',
    'scripts/configure-startup-task.ps1', 'scripts/configure-windows-firewall.ps1', 'scripts/start-dashboard-detached.ps1',
    'scripts/install-macos.sh', 'scripts/configure-startup-macos.sh', 'scripts/capture-readme-screenshots.mjs',
    'scripts/validate-public-package.ps1',
    'skills/codex-phone-dashboard/SKILL.md', 'skills/codex-phone-dashboard/agents/openai.yaml',
    'skills/codex-phone-dashboard/references/troubleshooting.md', 'tests-node/dashboard.test.js',
    'web/assets/progress-mascot.gif',
    'assets/readme/phone/dashboard-en-connected-danger-12.png',
    'assets/readme/phone/dashboard-en-connected-healthy-95.png',
    'assets/readme/phone/dashboard-en-connected-warning-42.png',
    'assets/readme/phone/dashboard-en-disconnected.png',
    'assets/readme/phone/dashboard-zh-connected-danger-12.png',
    'assets/readme/phone/dashboard-zh-connected-healthy-95.png',
    'assets/readme/phone/dashboard-zh-connected-warning-42.png',
    'assets/readme/phone/dashboard-zh-disconnected.png'
  )
  $actualPublicFiles = @(Get-ChildItem -LiteralPath $projectRoot -Recurse -File | ForEach-Object {
    $_.FullName.Substring($projectRoot.Length + 1).Replace([System.IO.Path]::DirectorySeparatorChar, '/')
  } | Where-Object {
    -not $_.StartsWith('node_modules/', [System.StringComparison]::OrdinalIgnoreCase) -and
    $_ -ne 'config.local.json'
  })
  $unexpectedFiles = @($actualPublicFiles | Where-Object { $_ -notin $publicFiles })
  if ($unexpectedFiles.Count -gt 0) { throw "Unexpected public files: $($unexpectedFiles -join ', ')" }

  $privateForbidden = @(
    ('CODEX_PHONE_' + 'COMPANY_SSH_HOST'), ('CODEX_PHONE_' + 'COMPANY_CODEX_BIN'),
    ('CODEX_PHONE_' + 'COMPANY_LABEL'), ('REVIEW_' + 'GIF_NAME')
  )
  $attributionTerms = @(
    ('Barry' + 'Barrywu'), ('ZEC' + 'TRIX'), ('NOTE' + '4'), ('codex-' + 'zec' + 'trix-' + 'dashboard')
  )
  $attributionFiles = @('README.md', 'README.zh-CN.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md')
  $findings = [System.Collections.Generic.List[string]]::new()
  foreach ($relativePath in $publicFiles) {
    $absolutePath = Join-Path $projectRoot $relativePath
    if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) { throw "Missing public file: $relativePath" }
    $extension = [System.IO.Path]::GetExtension($absolutePath)
    if ($extension -in @('.gif', '.png')) { continue }
    $content = Get-Content -LiteralPath $absolutePath -Raw -Encoding UTF8
    foreach ($term in $privateForbidden) {
      if ($content.IndexOf($term, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $findings.Add("$relativePath contains forbidden marker: $term")
      }
    }
    if ($relativePath -notin $attributionFiles) {
      foreach ($term in $attributionTerms) {
        if ($content.IndexOf($term, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
          $findings.Add("$relativePath contains attribution marker outside approved notices: $term")
        }
      }
    }
  }
  if ($findings.Count -gt 0) { throw ($findings -join [Environment]::NewLine) }
  $checks.Add([pscustomobject]@{ Check = 'public-privacy-scan'; ExitCode = 0 })

  $licenseText = Get-Content -LiteralPath (Join-Path $projectRoot 'LICENSE') -Raw -Encoding UTF8
  $noticeText = Get-Content -LiteralPath (Join-Path $projectRoot 'THIRD_PARTY_NOTICES.md') -Raw -Encoding UTF8
  $upstreamOwner = 'Barry Barry ' + 'Wu'
  $upstreamRepo = 'Barry' + 'Barrywu/' + 'codex-' + 'zec' + 'trix-' + 'dashboard'
  if ($licenseText.IndexOf($upstreamOwner, [System.StringComparison]::Ordinal) -lt 0) { throw 'LICENSE is missing the upstream copyright holder.' }
  if ($licenseText.IndexOf('lucasgogogo (modifications and additions)', [System.StringComparison]::Ordinal) -lt 0) { throw 'LICENSE is missing the modifications copyright holder.' }
  if ($noticeText.IndexOf($upstreamRepo, [System.StringComparison]::Ordinal) -lt 0) { throw 'THIRD_PARTY_NOTICES.md is missing the upstream repository.' }
  if ($noticeText.IndexOf('The upstream MIT notice follows unchanged:', [System.StringComparison]::Ordinal) -lt 0) { throw 'THIRD_PARTY_NOTICES.md is missing the full-license marker.' }
  $checks.Add([pscustomobject]@{ Check = 'third-party-attribution'; ExitCode = 0 })

  foreach ($readmePath in @('README.md', 'README.zh-CN.md')) {
    $readmeAbsolute = Join-Path $projectRoot $readmePath
    $readmeDirectory = Split-Path -Parent $readmeAbsolute
    $readmeText = Get-Content -LiteralPath $readmeAbsolute -Raw -Encoding UTF8
    foreach ($match in [regex]::Matches($readmeText, '\]\((?<target>\./[^)#]+)(?:#[^)]+)?\)')) {
      $target = $match.Groups['target'].Value.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
      $resolvedTarget = [System.IO.Path]::GetFullPath((Join-Path $readmeDirectory $target))
      if (-not (Test-Path -LiteralPath $resolvedTarget)) { throw "$readmePath has a broken local link: $target" }
    }
  }
  $screenshotCount = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'assets\readme\phone') -Filter '*.png' -File).Count
  if ($screenshotCount -ne 8) { throw "Expected 8 README screenshots, found $screenshotCount." }
  $checks.Add([pscustomobject]@{ Check = 'readme-links-and-images'; ExitCode = 0 })

} finally {
  Pop-Location
}

$checks | Format-Table -AutoSize
