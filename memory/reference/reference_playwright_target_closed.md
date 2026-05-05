---
name: Playwright Target page closed 復原
description: 外部 Playwright MCP 連線斷掉後 browser_navigate 連續失敗的應對流程
type: reference
originSessionId: ed92627f-222e-424e-a353-3f7465c462b7
---
## 症狀

外部 `@playwright/mcp` 的 `browser_navigate` 回傳 `Target page closed` 後，後續所有 browser_* 操作都會失敗，自動重試無效。

## 根因

Playwright MCP 內部 page 物件已被釋放，但 server 沒自動重建 context。我們無法改外部 MCP 行為。

## 復原步驟（依序執行）

1. `browser_close`（清掉殘破 context）
2. `browser_navigate {url}`（重新開頁）
3. 若仍失敗，停止 Playwright MCP 程序後重新對話

## Hook 已加的提醒

`repetition-detector.js` 對 `browser_navigate` / `browser_wait_for` 的重複門檻已調為 9（一般工具仍是 5）。連續第 9 次同樣呼叫會 BLOCK 並提示先 `browser_close`，避免無限重試。

## 與工具改進的關係

`improvements_backlog.md` #2 原本想要工具自動重建 page。因 Playwright MCP 是外部 server，改以 hint + 文件方式收斂。若日後改用內部包裝層再回頭實作 auto-recover。
