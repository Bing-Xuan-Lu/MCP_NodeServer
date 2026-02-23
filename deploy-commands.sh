#!/bin/bash
echo "Deploying Claude Code slash commands..."

mkdir -p ~/.claude/commands

cp -f Skills/commands/php_upgrade.md        ~/.claude/commands/php_upgrade.md
cp -f Skills/commands/php_crud_generator.md ~/.claude/commands/php_crud_generator.md
cp -f Skills/commands/bookmark_organizer.md ~/.claude/commands/bookmark_organizer.md

echo "Done! Available commands: /php_upgrade  /php_crud_generator  /bookmark_organizer"
