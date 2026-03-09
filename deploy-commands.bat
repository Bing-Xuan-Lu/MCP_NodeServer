@echo off
:: Deploy skills to Claude Code and Gemini CLI
:: Exclude files starting with _ or ending with _internal.md / _steps.md

set CLAUDE_DIR=%USERPROFILE%\.claude\commands
set GEMINI_DIR=%USERPROFILE%\.gemini\skills

echo Deploying skills to Claude Code and Gemini CLI...

:: Ensure directories exist
if not exist "%CLAUDE_DIR%" mkdir "%CLAUDE_DIR%"
if not exist "%GEMINI_DIR%" mkdir "%GEMINI_DIR%"

set count=0
for /r "Skills\commands" %%F in (*.md) do (
  echo %%~nxF | findstr /I /B "_" > nul
  if errorlevel 1 (
    echo %%~nxF | findstr /I /E /C:"_internal.md" /C:"_steps.md" > nul
    if errorlevel 1 (
      :: Copy to Claude
      copy /Y "%%F" "%CLAUDE_DIR%\%%~nxF" > nul
      :: Copy to Gemini
      copy /Y "%%F" "%GEMINI_DIR%\%%~nxF" > nul
      
      echo   deployed %%~nxF
      set /a count+=1
    )
  )
)

echo.
echo Done! %count% public skills deployed to:
echo   Claude: %CLAUDE_DIR%
echo   Gemini: %GEMINI_DIR%
echo (Excluded: _skill_template.md, *_internal.md, *_steps.md)
