---
name: feedback_playwright_screenshot
description: Playwright 截圖存放位置規範，不可放根目錄
type: feedback
---

Playwright 截圖（`browser_take_screenshot` 等工具）必須存到 `/screenshot/` 子資料夾，不可放專案根目錄。

**Why:** 截圖是測試用暫存物，根目錄被大量 png 污染會影響 git status 閱讀性，也容易誤 commit。

**How to apply:** 凡是呼叫 Playwright 截圖工具，路徑一律指定為 `screenshot/filename.png`（相對於專案根）。`/screenshot/` 已加入 `.gitignore`，不進版控。
