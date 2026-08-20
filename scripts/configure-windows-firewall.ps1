[CmdletBinding()]
param(
    [switch]$Remove
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ruleName = 'Codex Phone Dashboard LAN'
$nodeProgram = (Get-Command node -ErrorAction Stop).Source

if ($Remove) {
    $existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if ($null -ne $existingRule) {
        $existingRule | Remove-NetFirewallRule
        Write-Output "Removed firewall rule: $ruleName"
    }
    else {
        Write-Output "Firewall rule is already absent: $ruleName"
    }
    exit 0
}

if (-not (Test-Path -LiteralPath $nodeProgram -PathType Leaf)) {
    throw "Node executable not found: $nodeProgram"
}

$networkCandidates = @(Get-NetIPConfiguration |
    Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
    ForEach-Object {
        $adapter = $_
        @($adapter.IPv4Address.IPAddress) | ForEach-Object {
            [pscustomobject]@{ Address = $_; InterfaceAlias = $adapter.InterfaceAlias }
        }
    } |
    Where-Object { $_.Address -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' })

$selectedNetwork = $networkCandidates |
    Sort-Object @{ Expression = { if ($_.InterfaceAlias -match 'Wi-?Fi|WLAN|Wireless') { 0 } else { 1 } } }, InterfaceAlias |
    Select-Object -First 1
$wifiAddress = if ($selectedNetwork) { $selectedNetwork.Address } else { $null }

if ([string]::IsNullOrWhiteSpace($wifiAddress)) {
    throw 'No active private-network IPv4 address was found.'
}

$existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($null -ne $existingRule) {
    $existingPort = $existingRule | Get-NetFirewallPortFilter
    $existingAddress = $existingRule | Get-NetFirewallAddressFilter
    $existingApplication = $existingRule | Get-NetFirewallApplicationFilter
    $matches = $existingRule.Enabled -eq 'True' -and
        $existingRule.Direction -eq 'Inbound' -and
        $existingRule.Action -eq 'Allow' -and
        $existingPort.Protocol -eq 'TCP' -and
        [string]$existingPort.LocalPort -eq '43117' -and
        [string]$existingAddress.LocalAddress -eq $wifiAddress -and
        [string]$existingAddress.RemoteAddress -eq 'LocalSubnet' -and
        [string]$existingApplication.Program -eq $nodeProgram
    if ($matches) {
        Write-Output "Firewall rule already matches the required private-LAN scope: $ruleName"
        exit 0
    }
    $existingRule | Remove-NetFirewallRule
}

New-NetFirewallRule `
    -DisplayName $ruleName `
    -Description 'Allow Codex Phone Dashboard on TCP 43117 from the local subnet only.' `
    -Direction Inbound `
    -Action Allow `
    -Enabled True `
    -Profile Any `
    -Program $nodeProgram `
    -Protocol TCP `
    -LocalAddress $wifiAddress `
    -LocalPort 43117 `
    -RemoteAddress LocalSubnet | Out-Null

$rule = Get-NetFirewallRule -DisplayName $ruleName
$port = $rule | Get-NetFirewallPortFilter
$address = $rule | Get-NetFirewallAddressFilter
$application = $rule | Get-NetFirewallApplicationFilter

[pscustomobject]@{
    DisplayName   = $rule.DisplayName
    Enabled       = $rule.Enabled
    Direction     = $rule.Direction
    Action        = $rule.Action
    Profile       = $rule.Profile
    Program       = $application.Program
    Protocol      = $port.Protocol
    LocalPort     = $port.LocalPort
    LocalAddress  = $address.LocalAddress
    RemoteAddress = $address.RemoteAddress
} | Format-List
