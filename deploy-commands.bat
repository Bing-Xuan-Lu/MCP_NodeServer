@echo off
echo Deploying Claude Code slash commands...

if not exist "%USERPROFILE%\.claude\commands" mkdir "%USERPROFILE%\.claude\commands"

:: php_dev
copy /Y "Skills\commands\php_dev\php_upgrade.md"           "%USERPROFILE%\.claude\commands\php_upgrade.md"
copy /Y "Skills\commands\php_dev\php_crud_generator.md"    "%USERPROFILE%\.claude\commands\php_crud_generator.md"
copy /Y "Skills\commands\php_dev\php_path_fix.md"          "%USERPROFILE%\.claude\commands\php_path_fix.md"

:: migration
copy /Y "Skills\commands\migration\dotnet_to_php.md"       "%USERPROFILE%\.claude\commands\dotnet_to_php.md"

:: testing
copy /Y "Skills\commands\testing\php_net_to_php_test.md"   "%USERPROFILE%\.claude\commands\php_net_to_php_test.md"
copy /Y "Skills\commands\testing\playwright_ui_test.md"    "%USERPROFILE%\.claude\commands\playwright_ui_test.md"
copy /Y "Skills\commands\testing\web_performance.md"       "%USERPROFILE%\.claude\commands\web_performance.md"

:: spec
copy /Y "Skills\commands\spec\axshare_diff.md"             "%USERPROFILE%\.claude\commands\axshare_diff.md"

:: tooling
copy /Y "Skills\commands\tooling\bookmark_organizer.md"    "%USERPROFILE%\.claude\commands\bookmark_organizer.md"
copy /Y "Skills\commands\tooling\n8n_workflow_update.md"   "%USERPROFILE%\.claude\commands\n8n_workflow_update.md"
copy /Y "Skills\commands\tooling\n8n_workflow_create.md"   "%USERPROFILE%\.claude\commands\n8n_workflow_create.md"
copy /Y "Skills\commands\tooling\n8n_discord_dispatcher.md" "%USERPROFILE%\.claude\commands\n8n_discord_dispatcher.md"
copy /Y "Skills\commands\tooling\learn_claude_skill.md"    "%USERPROFILE%\.claude\commands\learn_claude_skill.md"
copy /Y "Skills\commands\tooling\git_commit.md"            "%USERPROFILE%\.claude\commands\git_commit.md"
copy /Y "Skills\commands\tooling\youtube_organizer.md"     "%USERPROFILE%\.claude\commands\youtube_organizer.md"
copy /Y "Skills\commands\tooling\relocate_directory.md"    "%USERPROFILE%\.claude\commands\relocate_directory.md"

:: dev_workflow
copy /Y "Skills\commands\dev_workflow\directory_reorganize.md"  "%USERPROFILE%\.claude\commands\directory_reorganize.md"
copy /Y "Skills\commands\dev_workflow\git_worktree.md"          "%USERPROFILE%\.claude\commands\git_worktree.md"
copy /Y "Skills\commands\dev_workflow\tdd.md"                   "%USERPROFILE%\.claude\commands\tdd.md"
copy /Y "Skills\commands\dev_workflow\clean_arch.md"            "%USERPROFILE%\.claude\commands\clean_arch.md"
copy /Y "Skills\commands\dev_workflow\docker_relocate.md"       "%USERPROFILE%\.claude\commands\docker_relocate.md"
copy /Y "Skills\commands\dev_workflow\docker_compose_ops.md"    "%USERPROFILE%\.claude\commands\docker_compose_ops.md"

:: content
copy /Y "Skills\commands\content\fetch_article.md"         "%USERPROFILE%\.claude\commands\fetch_article.md"
copy /Y "Skills\commands\content\yt_transcript.md"         "%USERPROFILE%\.claude\commands\yt_transcript.md"

echo Done! All skills deployed to %USERPROFILE%\.claude\commands\
