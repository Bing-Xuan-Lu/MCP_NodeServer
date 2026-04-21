---
name: popup 截圖避免遮擋
description: 截 popup/彈窗時用 browser_interact 的 screenshot action 搭配 hide_selectors 隱藏浮動元素
type: feedback
originSessionId: e363d54b-b7a9-4234-a957-53deb4a84df5
---
截 popup / 彈窗的 fullPage 或元素截圖時，右側浮動客服按鈕、chat widget、fixed banner 常遮擋內容。

**Why:** {project_a} 專案 popup 截圖多次被右側浮動客服按鈕擋到，需反覆重截。

**How to apply:**
- 優先用自家 `browser_interact` 的 `screenshot` action，帶 `hide_selectors`（如 `[".cs-float", ".chat-widget", ".fixed-banner"]`），工具會在截圖前暫時 `visibility:hidden`，截完自動還原。
- 若必須用外部 `mcp__playwright-default2__browser_take_screenshot`，先用 `browser_evaluate` 執行 `document.querySelectorAll('.cs-float').forEach(e=>e.style.visibility='hidden')`，截完再還原。
- 每個專案首次截 popup 時，先 snapshot 一次確認有哪些浮動元素，記在該專案的 memory/feedback。
