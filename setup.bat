@echo off
chcp 65001 > nul
:: MCP NodeServer 環境初始化腳本
:: 前置條件：Node.js 18+、Docker Desktop、Git

echo ============================================
echo  MCP NodeServer 環境初始化
echo ============================================
echo.

:: ---- 前置條件檢查 ----
echo 檢查前置條件...
node --version > nul 2>&1
if errorlevel 1 (
  echo FAIL: 未安裝 Node.js，請先安裝 https://nodejs.org/
  pause & exit /b 1
)
docker info > nul 2>&1
if errorlevel 1 (
  echo WARN: Docker Desktop 未啟動，步驟 3 將略過
  set DOCKER_OK=0
) else (
  set DOCKER_OK=1
)
echo OK.
echo.

:: ---- 1. npm install ----
echo [1/4] npm install...
call npm install
if errorlevel 1 ( echo FAIL & pause & exit /b 1 )
echo OK.

:: ---- 2. uipro-cli ----
echo.
echo [2/4] 安裝 uipro-cli...
call npm install -g uipro-cli
if not errorlevel 1 ( call uipro init --ai claude )
echo OK.

:: ---- 3. Python Docker 容器 ----
echo.
echo [3/4] 啟動 Python Docker 容器...
if "%DOCKER_OK%"=="1" (
  cd /d "%~dp0python"
  docker compose up -d
  cd /d "%~dp0"
  echo OK.
) else (
  echo SKIP.
)

:: ---- 4. 部署 Skills ----
echo.
echo [4/4] 部署 Skills...
call "%~dp0deploy-commands.bat"

echo.
echo 初始化完成！請重啟 Claude Code 讓設定生效。
pause
