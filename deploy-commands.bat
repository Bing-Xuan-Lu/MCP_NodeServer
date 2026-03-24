@echo off
chcp 65001 > nul
:: Deploy skills to Claude Code and Gemini CLI
:: Exclude: starts with _, ends with _internal.md / _steps.md
:: Also removes stale files no longer in source

set CLAUDE_DIR=%USERPROFILE%\.claude\commands
set GEMINI_DIR=%USERPROFILE%\.gemini\skills

echo Deploying skills to Claude Code and Gemini CLI...

if not exist "%CLAUDE_DIR%" mkdir "%CLAUDE_DIR%"
if not exist "%GEMINI_DIR%" mkdir "%GEMINI_DIR%"

:: ---- Step 1: Build valid skills list ----
set VALID_LIST=%TEMP%\mcp_valid_skills.txt
if exist "%VALID_LIST%" del "%VALID_LIST%"

for /r "Skills\commands" %%F in (*.md) do (
  echo %%~dpF | findstr /I /C:"_archived" > nul
  if errorlevel 1 (
    echo %%~nxF | findstr /I /B "_" > nul
    if errorlevel 1 (
      echo %%~nxF | findstr /I /E /C:"_internal.md" /C:"_steps.md" > nul
      if errorlevel 1 (
        echo %%~nxF >> "%VALID_LIST%"
      )
    )
  )
)

:: ---- Step 2: Remove stale files from Claude dir ----
set stale=0
for %%F in ("%CLAUDE_DIR%\*.md") do (
  findstr /I /X /C:"%%~nxF" "%VALID_LIST%" > nul 2>&1
  if errorlevel 1 (
    del "%%F"
    echo   removed stale: %%~nxF
    set /a stale+=1
  )
)

:: ---- Step 3: Remove stale files from Gemini dir ----
for %%F in ("%GEMINI_DIR%\*.md") do (
  findstr /I /X /C:"%%~nxF" "%VALID_LIST%" > nul 2>&1
  if errorlevel 1 (
    del "%%F"
  )
)

:: ---- Step 4: Deploy valid skills ----
set count=0
for /r "Skills\commands" %%F in (*.md) do (
  echo %%~dpF | findstr /I /C:"_archived" > nul
  if errorlevel 1 (
    echo %%~nxF | findstr /I /B "_" > nul
    if errorlevel 1 (
      echo %%~nxF | findstr /I /E /C:"_internal.md" /C:"_steps.md" > nul
      if errorlevel 1 (
        copy /Y "%%F" "%CLAUDE_DIR%\%%~nxF" > nul
        copy /Y "%%F" "%GEMINI_DIR%\%%~nxF" > nul
        echo   deployed %%~nxF
        set /a count+=1
      )
    )
  )
)

if exist "%VALID_LIST%" del "%VALID_LIST%"

echo.
echo Done! %count% skills deployed, %stale% stale files removed.
echo   Claude: %CLAUDE_DIR%
echo   Gemini: %GEMINI_DIR%
echo (Excluded: _skill_template.md, *_internal.md, *_steps.md, _archived/)
