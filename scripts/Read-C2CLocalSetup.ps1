[CmdletBinding()]
param(
    [string]$Path = (Join-Path (Split-Path $PSScriptRoot -Parent) "LOCAL_SETUP.md"),
    [switch]$AsJson
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "LOCAL_SETUP.md not found: $Path. Copy LOCAL_SETUP.example.md first and fill it in."
}

$fields = [ordered]@{
    C2CCheckout     = "C2C checkout"
    InstalledSkill  = "Installed Skill"
    WorkspaceName   = "Workspace name"
    WorkspaceRoot   = "Workspace root"
    GitRepository   = "Git repository"
    GitBranch       = "Git branch"
    ConnectionMode  = "Connection mode"
    CloudflareZone  = "Cloudflare zone"
    FixedHostname   = "Fixed hostname"
    McpUrl          = "MCP URL"
    AppName         = "App/connector name"
    ProjectName     = "Project name"
    ConversationMode = "Conversation mode"
}

$content = Get-Content -LiteralPath $Path -Raw
$result = [ordered]@{}

foreach ($entry in $fields.GetEnumerator()) {
    $label = [regex]::Escape($entry.Value)
    $match = [regex]::Match($content, "(?m)^-\s+${label}:\s+`?([^`\r\n]+)`?\s*$")
    if (-not $match.Success) {
        throw "Missing field '$($entry.Value)' in $Path."
    }

    $value = $match.Groups[1].Value.Trim().Trim('`')
    if ([string]::IsNullOrWhiteSpace($value) -or $value -match '^<.+>$' -or $value -match '<[^>]+>') {
        throw "Field '$($entry.Value)' still contains a placeholder in $Path."
    }
    $result[$entry.Key] = $value
}

$config = [pscustomobject]$result
if ($AsJson) {
    $config | ConvertTo-Json
} else {
    $config
}
