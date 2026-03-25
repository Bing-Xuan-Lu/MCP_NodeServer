---
name: deploy-commands .bat/.sh 同步規則
description: 每次修改 deploy-commands.bat 後必須同步更新 deploy-commands.sh（邏輯完全一致）
type: feedback
---

修改 `deploy-commands.bat` 後，**必須同步更新 `deploy-commands.sh`**，兩者邏輯永遠保持一致。

**Why:** 使用者在不同環境（Windows/Unix）都可能執行部署，.sh 若落後 .bat 會導致冷儲存 Skill 意外被部署（2026-03-25 曾發生 _cold 排除邏輯只在 .bat 有，.sh 漏掉）。

**How to apply:** 任何修改 .bat 的任務完成後，立刻對照檢查 .sh 是否同步：
- 排除條件（`_cold`、`_internal`、`_steps` 等）
- 目標目錄（CLAUDE_DIR、GEMINI_DIR）
- 結尾說明訊息
