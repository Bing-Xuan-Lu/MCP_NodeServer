@echo off
chcp 65001 > nul
:: 將本目錄加入使用者 PATH，讓 python / pip 指令在 CMD/PowerShell 可用
set TARGET=%~dp0
set TARGET=%TARGET:~0,-1%
powershell -Command "[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';%TARGET%', 'User')"
echo 已將 %TARGET% 加入使用者 PATH
echo 請重新開啟 CMD 或 PowerShell 讓設定生效
pause
