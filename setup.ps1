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

Write-Host ""
Write-Host "Setup complete! Restart Claude Code to apply changes."
Read-Host "Press Enter to exit"
