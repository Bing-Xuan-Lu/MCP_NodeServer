#!/bin/bash
# 動態部署 Skills/commands/ 下所有公開 Skill 到 Claude 與 Gemini
# 排除規則：以 _ 開頭、*_internal.md、*_steps.md
# 新增 Skill 後直接重跑此腳本，無需修改。

CLAUDE_DIR="$HOME/.claude/commands"
GEMINI_DIR="$HOME/.gemini/skills"

echo "Deploying skills to Claude Code & Gemini CLI..."

# 確保目錄存在
mkdir -p "$CLAUDE_DIR"
mkdir -p "$GEMINI_DIR"

count=0

# 遍歷 Skills/commands 目錄下所有 .md 檔案
find Skills/commands -type f -name "*.md" | while read -r file; do
    filename=$(basename "$file")
    
    # 排除規則：
    # 1. 檔名以 _ 開頭 (例如 _skill_template.md)
    # 2. 檔名以 _internal.md 結尾
    # 3. 檔名以 _steps.md 結尾
    if [[ ! "$filename" =~ ^_ ]] && [[ ! "$filename" =~ _internal\.md$ ]] && [[ ! "$filename" =~ _steps\.md$ ]]; then
        # 同步到 Claude
        cp "$file" "$CLAUDE_DIR/$filename"
        # 同步到 Gemini
        cp "$file" "$GEMINI_DIR/$filename"
        
        echo "  deployed $filename"
        ((count++))
    fi
done

echo ""
echo "Done! All public skills deployed to:"
echo "  Claude: $CLAUDE_DIR"
echo "  Gemini: $GEMINI_DIR"
echo "(Excluded: _skill_template.md, *_internal.md, *_steps.md)"
