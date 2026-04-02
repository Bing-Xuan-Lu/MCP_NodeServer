@echo off
chcp 65001 > nul
:: Deploy skills via Node.js (whitelist-based)
node "%~dp0deploy-commands.js"
