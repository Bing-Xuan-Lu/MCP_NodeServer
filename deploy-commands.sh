#!/bin/bash
# 動態部署 Skills/commands/ 下所有公開 Skill
# 排除規則：以 _ 開頭、*_internal.md、*_steps.md
# 新增 Skill 後直接重跑此腳本，無需修改。

echo "Deploying Claude Code slash commands..."
mkdir -p ~/.claude/commands

count=0
find Skills/commands -name "*.md" \
  ! -name "_*" \
  ! -name "*_internal.md" \
  ! -name "*_steps.md" \
| while read -r file; do
  cp -f "$file" "$HOME/.claude/commands/$(basename "$file")"
  echo "  ✓ $(basename "$file")"
  count=$((count + 1))
done

echo ""
echo "Done! All public skills deployed to ~/.claude/commands/"
echo "(Excluded: _skill_template.md, *_internal.md, *_steps.md)"
