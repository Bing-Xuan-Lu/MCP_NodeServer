@echo off
echo Deploying Claude Code slash commands...

if not exist "%USERPROFILE%\.claude\commands" mkdir "%USERPROFILE%\.claude\commands"

copy /Y "Skills\commands\php_upgrade.md"        "%USERPROFILE%\.claude\commands\php_upgrade.md"
copy /Y "Skills\commands\php_crud_generator.md" "%USERPROFILE%\.claude\commands\php_crud_generator.md"
copy /Y "Skills\commands\bookmark_organizer.md" "%USERPROFILE%\.claude\commands\bookmark_organizer.md"
copy /Y "Skills\commands\dotnet_to_php.md"      "%USERPROFILE%\.claude\commands\dotnet_to_php.md"
copy /Y "Skills\commands\php_net_to_php_test.md"           "%USERPROFILE%\.claude\commands\php_net_to_php_test.md"

echo Done! Available commands: /php_upgrade  /php_crud_generator  /bookmark_organizer  /dotnet_to_php  /php_net_to_php_test
