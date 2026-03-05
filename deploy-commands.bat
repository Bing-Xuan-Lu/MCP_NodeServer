@echo off
:: 動態部署 Skills/commands/ 下所有公開 Skill
:: 排除規則：以 _ 開頭、*_internal.md、*_steps.md
:: 新增 Skill 後直接重跑此腳本，無需修改。

echo Deploying Claude Code slash commands...
if not exist "%USERPROFILE%\.claude\commands" mkdir "%USERPROFILE%\.claude\commands"

set count=0
for /r "Skills\commands" %%F in (*.md) do (
  echo %%~nxF | findstr /I /B "_" > nul
  if errorlevel 1 (
    echo %%~nxF | findstr /I /E "_internal.md" "_steps.md" > nul
    if errorlevel 1 (
      copy /Y "%%F" "%USERPROFILE%\.claude\commands\%%~nxF" > nul
      echo   copied %%~nxF
      set /a count+=1
    )
  )
)

echo.
echo Done! All public skills deployed to %USERPROFILE%\.claude\commands\
echo (Excluded: _skill_template.md, *_internal.md, *_steps.md)
