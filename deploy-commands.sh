#!/bin/bash
# Deploy skills to Claude Code & Gemini CLI
# Exclude: starts with _, ends with _internal.md / _steps.md
# Also removes stale files no longer in source

CLAUDE_DIR="$HOME/.claude/commands"
GEMINI_DIR="$HOME/.gemini/skills"

echo "Deploying skills to Claude Code & Gemini CLI..."

mkdir -p "$CLAUDE_DIR"
mkdir -p "$GEMINI_DIR"

# ---- Step 1: Build valid skills list ----
VALID_LIST=$(mktemp)

find Skills/commands -type f -name "*.md" | while read -r file; do
  filename=$(basename "$file")
  if [[ ! "$filename" =~ ^_ ]] && [[ ! "$filename" =~ _internal\.md$ ]] && [[ ! "$filename" =~ _steps\.md$ ]]; then
    echo "$filename" >> "$VALID_LIST"
  fi
done

# ---- Step 2: Remove stale files from Claude dir ----
stale=0
for f in "$CLAUDE_DIR"/*.md; do
  [ -f "$f" ] || continue
  filename=$(basename "$f")
  if ! grep -qxF "$filename" "$VALID_LIST" 2>/dev/null; then
    rm "$f"
    echo "  removed stale: $filename"
    ((stale++))
  fi
done

# ---- Step 3: Remove stale files from Gemini dir ----
for f in "$GEMINI_DIR"/*.md; do
  [ -f "$f" ] || continue
  filename=$(basename "$f")
  if ! grep -qxF "$filename" "$VALID_LIST" 2>/dev/null; then
    rm "$f"
  fi
done

# ---- Step 4: Deploy valid skills ----
count=0
find Skills/commands -type f -name "*.md" | while read -r file; do
  filename=$(basename "$file")
  if [[ ! "$filename" =~ ^_ ]] && [[ ! "$filename" =~ _internal\.md$ ]] && [[ ! "$filename" =~ _steps\.md$ ]]; then
    cp "$file" "$CLAUDE_DIR/$filename"
    cp "$file" "$GEMINI_DIR/$filename"
    echo "  deployed $filename"
    ((count++))
  fi
done

rm -f "$VALID_LIST"

echo ""
echo "Done! Skills deployed ($stale stale files removed)."
echo "  Claude: $CLAUDE_DIR"
echo "  Gemini: $GEMINI_DIR"
echo "(Excluded: _skill_template.md, *_internal.md, *_steps.md)"
