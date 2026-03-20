---
name: feedback_playwright_ops
description: Playwright MCP 操作規則：快取清除、禁止平行 Agent、卡住停止、禁止 taskkill、動態連結展開
type: feedback
---

## 快取清除（JS/CSS 修改後）

Docker 環境修改 JS/CSS 後，Playwright 瀏覽器快取不會自動更新。

**Why:** `main.js` 已更新但 `forgetPassword` 函式不存在，浪費多輪才發現是快取問題。

**How to apply:** 修改 JS/CSS 後，用 CDP 清快取再重載：
```javascript
const client = await page.context().newCDPSession(page);
await client.send('Network.clearBrowserCache');
await page.reload({ waitUntil: 'networkidle' });
```
單純 `page.reload()` 或 `?_cb=1` query string 不夠，必須用 `Network.clearBrowserCache`。

---

## 禁止平行 Agent 操作 Playwright

Playwright MCP 只有單一 browser context，多個 Agent 共用同一個 page。

**Why:** 嘗試 6 個平行 Agent 爬取規格書，Agent 互相搶 `browser_navigate`、某 Agent 執行 `browser_close` 導致全部報錯 `Target page closed`，92 頁完全失敗。

**How to apply:**
- 任何需要 Playwright 的任務，禁止用平行 Agent
- 需要爬大量頁面：用單一 Agent 序列處理，或用 `browser_run_code` 批次腳本
- 可以平行的場景：一個 Agent 用 Playwright，其他 Agent 只做檔案讀寫/搜尋（不碰 browser）

---

## 卡住時直接停止

Playwright MCP 若卡住（browser launch failure、timeout），直接停止，不重試。

**Why:** 重試通常無效，Chrome 可能已開啟佔用 user-data-dir，重試只浪費 token。

**How to apply:** 遇到啟動失敗或超時 → 立即告知「Playwright 卡住，請手動重啟」→ 改用 curl/send_http_request 繼續驗證。

---

## 禁止 taskkill chrome

不要使用 `taskkill //F //IM chrome.exe` 關閉 Chrome。

**Why:** 使用者可能有其他 Chrome 視窗在使用，強制關閉會影響正在進行的工作。

**How to apply:** Playwright 啟動失敗時，提醒使用者**手動**關閉 Chrome，等確認後再重試。

---

## 動態連結測試必須先展開元素

QC 連結測試不能只用 `a[href]` 選擇器掃靜態 DOM。Vue/React 動態渲染的 `<a>` 在元素未展開前可能沒有 href，會被 `a[href]` 過濾掉。

**Why:** Mega Menu 裡 15 個分類的 `<a>` 完全沒有 href，`a[href]` 選擇器跳過它們造成「全 PASS」假象，但實際點擊無反應。

**How to apply:**
1. 連結測試前先觸發展開所有 dropdown / mega menu / accordion，等 DOM 更新
2. 展開後掃描 `a:not([href])` — 若存在 = NG
3. 展開後逐一實際點擊，驗證是否成功導航
4. mega menu 的每個 Tab 都要切換測試
