# MCP NodeServer Setup Script
# Prerequisites: Node.js 18+, Docker Desktop, Git

$ErrorActionPreference = "Stop"

Write-Host "============================================"
Write-Host " MCP NodeServer Setup"
Write-Host "============================================"
Write-Host ""

# ---- Prerequisites ----
Write-Host "Checking prerequisites..."

node --version | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "FAIL: Node.js not found. Install from https://nodejs.org/"
    exit 1
}

$dockerOk = $true
docker info 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "WARN: Docker Desktop not running. Step 3 will be skipped."
    $dockerOk = $false
}

Write-Host "OK."
Write-Host ""

# ---- 1. npm install ----
Write-Host "[1/5] npm install..."
npm install
if ($LASTEXITCODE -ne 0) { Write-Host "FAIL"; exit 1 }
Write-Host "OK."
Write-Host ""

# ---- 2. uipro-cli ----
Write-Host "[2/5] Installing uipro-cli..."
npm install -g uipro-cli
if ($LASTEXITCODE -eq 0) { uipro init --ai claude }
Write-Host "OK."
Write-Host ""

# ---- 3. Python Docker container ----
Write-Host "[3/5] Starting Python Docker container..."
if ($dockerOk) {
    Push-Location "$PSScriptRoot\python"
    docker compose up -d
    Pop-Location
    Write-Host "OK."
} else {
    Write-Host "SKIP."
}
Write-Host ""

# ---- 4. Deploy Skills ----
Write-Host "[4/5] Deploying Skills..."
& "$PSScriptRoot\deploy-commands.bat"
Write-Host ""

# ---- 5. Global CLAUDE.md ----
Write-Host "[5/5] Syncing global CLAUDE.md..."
$claudeDir = "$env:USERPROFILE\.claude"
if (-not (Test-Path $claudeDir)) { New-Item -ItemType Directory -Path $claudeDir | Out-Null }
Copy-Item "$PSScriptRoot\docs\global-claude.md" "$claudeDir\CLAUDE.md" -Force
Write-Host "OK: synced to $claudeDir\CLAUDE.md"

# ---- 6. Playwright MCP Permissions ----
Write-Host ""
Write-Host "[6/6] Setting up Playwright MCP permissions in settings.json..."
$settingsPath = "$claudeDir\settings.json"

$playwrightPerms = @(
    "mcp__plugin_playwright_playwright__browser_navigate",
    "mcp__plugin_playwright_playwright__browser_take_screenshot",
    "mcp__plugin_playwright_playwright__browser_snapshot",
    "mcp__plugin_playwright_playwright__browser_click",
    "mcp__plugin_playwright_playwright__browser_evaluate",
    "mcp__plugin_playwright_playwright__browser_tabs",
    "mcp__plugin_playwright_playwright__browser_fill_form",
    "mcp__plugin_playwright_playwright__browser_wait_for",
    "mcp__plugin_playwright_playwright__browser_resize",
    "mcp__plugin_playwright_playwright__browser_network_requests",
    "mcp__plugin_playwright_playwright__browser_press_key",
    "mcp__plugin_playwright_playwright__browser_select_option",
    "mcp__plugin_playwright_playwright__browser_type",
    "mcp__plugin_playwright_playwright__browser_navigate_back",
    "mcp__plugin_playwright_playwright__browser_close",
    "mcp__plugin_playwright_playwright__browser_console_messages",
    "mcp__plugin_playwright_playwright__browser_drag",
    "mcp__plugin_playwright_playwright__browser_file_upload",
    "mcp__plugin_playwright_playwright__browser_handle_dialog",
    "mcp__plugin_playwright_playwright__browser_hover",
    "mcp__plugin_playwright_playwright__browser_install",
    "mcp__plugin_playwright_playwright__browser_run_code"
)

if (Test-Path $settingsPath) {
    $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
} else {
    $settings = [PSCustomObject]@{ permissions = [PSCustomObject]@{ allow = @() } }
}

if (-not $settings.permissions) {
    $settings | Add-Member -MemberType NoteProperty -Name "permissions" -Value ([PSCustomObject]@{ allow = @() })
}
if (-not $settings.permissions.allow) {
    $settings.permissions | Add-Member -MemberType NoteProperty -Name "allow" -Value @()
}

$existing = $settings.permissions.allow
$added = 0
foreach ($perm in $playwrightPerms) {
    if ($existing -notcontains $perm) {
        $existing += $perm
        $added++
    }
}
$settings.permissions.allow = $existing
$settings | ConvertTo-Json -Depth 10 | Set-Content $settingsPath -Encoding UTF8
Write-Host "OK: added $added Playwright permissions to $settingsPath"
Write-Host "    (Why: Background agents need pre-approved permissions or they auto-reject tool calls)"

Write-Host ""
Write-Host "Setup complete! Restart Claude Code to apply changes."
Read-Host "Press Enter to exit"
