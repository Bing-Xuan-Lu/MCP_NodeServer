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
Write-Host "[1/6] npm install..."
npm install
if ($LASTEXITCODE -ne 0) { Write-Host "FAIL"; exit 1 }
Write-Host "OK."
Write-Host ""

# ---- 2. uipro-cli ----
Write-Host "[2/6] Installing uipro-cli..."
npm install -g uipro-cli
if ($LASTEXITCODE -eq 0) { uipro init --ai claude }
Write-Host "OK."
Write-Host ""

# ---- 3. Python Docker container ----
Write-Host "[3/6] Starting Python Docker container..."
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
Write-Host "[4/8] Deploying Skills..."
& "$PSScriptRoot\deploy-commands.bat"
Write-Host ""

# ---- 5. Global CLAUDE.md ----
Write-Host "[5/8] Syncing global CLAUDE.md..."
$claudeDir = "$env:USERPROFILE\.claude"
if (-not (Test-Path $claudeDir)) { New-Item -ItemType Directory -Path $claudeDir | Out-Null }
Copy-Item "$PSScriptRoot\docs\global-claude.md" "$claudeDir\CLAUDE.md" -Force
Write-Host "OK: synced to $claudeDir\CLAUDE.md"
Write-Host ""

# ---- 6. Deploy Hooks + risk-tiers.json ----
Write-Host "[6/8] Deploying Hooks and risk-tiers.json..."
node "$PSScriptRoot\setup-hooks.js"
if ($LASTEXITCODE -ne 0) { Write-Host "WARN: Hook setup had errors, check output above." }
Write-Host "OK."
Write-Host ""

# ---- 7. Playwright MCP Permissions ----
Write-Host "[7/8] Setting up Playwright MCP permissions in settings.json..."
$settingsPath = "$claudeDir\settings.json"

# Playwright 工具名稱（不含前綴）
$toolNames = @(
    "browser_navigate", "browser_take_screenshot", "browser_snapshot",
    "browser_click", "browser_evaluate", "browser_tabs",
    "browser_fill_form", "browser_wait_for", "browser_resize",
    "browser_network_requests", "browser_press_key", "browser_select_option",
    "browser_type", "browser_navigate_back", "browser_close",
    "browser_console_messages", "browser_drag", "browser_file_upload",
    "browser_handle_dialog", "browser_hover", "browser_install",
    "browser_run_code"
)

if (Test-Path $settingsPath) {
    $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
} else {
    $settings = [PSCustomObject]@{ permissions = [PSCustomObject]@{ allow = @() } }
}

if (-not ($settings.PSObject.Properties.Name -contains "permissions")) {
    $settings | Add-Member -MemberType NoteProperty -Name "permissions" -Value ([PSCustomObject]@{ allow = @() })
}
if (-not ($settings.permissions.PSObject.Properties.Name -contains "allow")) {
    $settings.permissions | Add-Member -MemberType NoteProperty -Name "allow" -Value @()
}

$existing = $settings.permissions.allow

# 自動偵測 Playwright MCP 前綴：掃描已有權限找 pattern
# 格式：mcp__{serverName}__browser_*
# 常見：mcp__playwright__ (手動設定) 或 mcp__plugin_playwright_playwright__ (VSCode 外掛)
$detectedPrefix = ""
foreach ($perm in $existing) {
    if ($perm -match "^(mcp__[a-zA-Z0-9_]+__)browser_navigate$") {
        $detectedPrefix = $Matches[1]
        break
    }
}

if (-not $detectedPrefix) {
    # 沒有現有權限可偵測，預設使用最常見的命名
    $detectedPrefix = "mcp__playwright__"
    Write-Host "    No existing Playwright permissions found, using default prefix: $detectedPrefix"
} else {
    Write-Host "    Detected Playwright prefix: $detectedPrefix"
}

$added = 0
foreach ($tool in $toolNames) {
    $perm = "${detectedPrefix}${tool}"
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
Write-Host "[8/8] Done."
Write-Host ""
Write-Host "============================================"
Write-Host " Setup complete!"
Write-Host "============================================"
Write-Host ""
Write-Host " What was configured:"
Write-Host "   hooks/     -> ~/.claude/hooks/  (7 hooks: session, pre-compact, write-guard, llm-judge, user-prompt-guard, skill-router)"
Write-Host "   skill-keywords.json -> ~/.claude/hooks/  (skill routing rules)"
Write-Host "   risk-tiers.json -> ~/.claude/  (path risk classification)"
Write-Host "   settings.json -> hooks registered (UserPromptSubmit x2, PostToolUse, PreToolUse, SessionStart, PreCompact)"
Write-Host "   settings.json -> Playwright permissions added"
Write-Host "   Skills -> ~/.claude/commands/"
Write-Host ""
Write-Host "Restart Claude Code to apply all changes."
Read-Host "Press Enter to exit"
