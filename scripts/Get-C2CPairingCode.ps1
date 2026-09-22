[CmdletBinding()]
param(
    [string]$LocalSetup = (Join-Path (Split-Path $PSScriptRoot -Parent) "LOCAL_SETUP.md"),
    [switch]$SkipDoctor,
    [switch]$CopyToClipboard
)

$ErrorActionPreference = "Stop"

$reader = Join-Path $PSScriptRoot "Read-C2CLocalSetup.ps1"
$config = & $reader -Path $LocalSetup
$cli = Join-Path $config.C2CCheckout "bin\c2c.js"

if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
    throw "C2C CLI not found: $cli"
}
if (-not (Test-Path -LiteralPath $config.WorkspaceRoot -PathType Container)) {
    throw "Workspace not found: $($config.WorkspaceRoot)"
}

if (-not $SkipDoctor) {
    $doctorOutput = & node $cli doctor -w $config.WorkspaceRoot --json 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "C2C doctor could not repair the connection:`n$($doctorOutput -join [Environment]::NewLine)"
    }
}

$pairOutput = & node $cli pair -w $config.WorkspaceRoot --json 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "Could not generate a pairing code:`n$($pairOutput -join [Environment]::NewLine)"
}

try {
    $pairing = ($pairOutput -join [Environment]::NewLine) | ConvertFrom-Json
} catch {
    throw "C2C returned an unexpected response. Run the command without this helper to diagnose it."
}

if (-not $pairing.ok -or [string]::IsNullOrWhiteSpace($pairing.pairingCode)) {
    throw "C2C did not return a pairing code."
}

if ($CopyToClipboard) {
    Set-Clipboard -Value $pairing.pairingCode
}

# Intentionally print only the short-lived code. Never save it to LOCAL_SETUP.md.
$pairing.pairingCode
