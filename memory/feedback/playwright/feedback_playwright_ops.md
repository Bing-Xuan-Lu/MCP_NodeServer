---
name: feedback_playwright_ops
description: Playwright MCP 操作規則：快取清除、禁止平行 Agent、卡住停止、禁止 taskkill、動態連結展開、Background Agent 需預授權工具
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

## Background Agent 跑 Playwright 必須預先授權所有 browser_* 工具

Background Agent 執行時無使用者在旁審批 → 遇到未預授權的工具 → **自動靜默拒絕**，不報錯只是跳過。

**Why:** `browser_tabs` 被拒絕，導致整個 UI/UX Agent 改為逐頁 navigate 模式，且若其他 browser_* 也未授權，整個 Agent 實際上什麼都做不了。

**How to apply:**
1. 在 `~/.claude/settings.json` 的 `permissions.allow` 加入所有 `mcp__plugin_playwright_playwright__browser_*` 工具
2. 新機器跑 `.\setup.ps1`（已內建第 6 步自動寫入）
3. 完整清單（22 個）：`browser_navigate`, `browser_take_screenshot`, `browser_snapshot`, `browser_click`, `browser_evaluate`, `browser_tabs`, `browser_fill_form`, `browser_wait_for`, `browser_resize`, `browser_network_requests`, `browser_press_key`, `browser_select_option`, `browser_type`, `browser_navigate_back`, `browser_close`, `browser_console_messages`, `browser_drag`, `browser_file_upload`, `browser_handle_dialog`, `browser_hover`, `browser_install`, `browser_run_code`

---

## 規格書比對必須提取文字，截圖不夠

AxShare 規格書的備註、條件邏輯、業務規則通常在文字 note 面板，截圖拍不到。

**Why:** 只截圖規格書畫面，備註欄的驗收條件（必填/條件判斷/格式限制）完全被忽略，導致 QC 漏掉這些規則。

**How to apply:** 在每個單元的規格書比對步驟，截圖之後額外執行 `browser_evaluate`：

```js
const notes = Array.from(document.querySelectorAll('.note, .annotation, [class*="note"], [class*="spec"], p, li, .text-content'))
  .map(el => el.innerText.trim()).filter(t => t.length > 0);
const body = document.body.innerText.slice(0, 3000);
notes.length > 10 ? notes.join('\n') : body;
```

將提取的文字中帶有「備註」「注意」「說明」「※」「*」、條件判斷（若...則...）、欄位驗證規則（必填/格式/長度）、業務流程說明，逐條記錄到報告的「規格書邏輯備註」欄，再比對網站行為，不符合 = NG。

---

## 動態連結測試必須先展開元素

QC 連結測試不能只用 `a[href]` 選擇器掃靜態 DOM。Vue/React 動態渲染的 `<a>` 在元素未展開前可能沒有 href，會被 `a[href]` 過濾掉。

**Why:** Mega Menu 裡 15 個分類的 `<a>` 完全沒有 href，`a[href]` 選擇器跳過它們造成「全 PASS」假象，但實際點擊無反應。

**How to apply:**
1. 連結測試前先觸發展開所有 dropdown / mega menu / accordion，等 DOM 更新
2. 展開後掃描 `a:not([href])` — 若存在 = NG
3. 展開後逐一實際點擊，驗證是否成功導航
4. mega menu 的每個 Tab 都要切換測試

---

## 規格書與設計稿截圖必須加 fullPage: true

規格書、設計稿頁面、實際網站截圖，一律加 `fullPage: true`。

**Why:** 規格書和設計稿頁面往往比視窗高，不加 fullPage 會漏掉下方的欄位定義、備註說明、業務邏輯。

**How to apply:**

```text
browser_take_screenshot { type: "png", fullPage: true, filename: "spec_page.png" }
```

- 所有規格書頁截圖：`fullPage: true`
- 所有設計稿截圖：`fullPage: true`
- 實際網站 QC 截圖：`fullPage: true`
- 若已截過的圖疑似不完整（內容被截斷），重截一次

---

## Playwright 測試必須走完整操作流程

不可用 `browser_evaluate` 模擬呼叫 JS 函式，必須走完整的使用者操作流程。

**Why:** 模擬呼叫跳過了真實的事件綁定、DOM 狀態、CSS 顯示等條件，無法反映使用者實際體驗，測試結果不可信。

**How to apply:** 測試「購物車結帳」→ 必須先瀏覽商品 → 點加入購物車 → 進購物車頁 → 點結帳按鈕。不可直接 `evaluate goCheckout()`。

---

## 截圖產出後必須逐張驗證內容

產出截圖後，**必須用 Read 工具逐張檢視圖片內容**，確認：
1. 截到的是正確頁面（不是相鄰頁面或錯誤導航）
2. fullPage 有效（底部內容沒有被截斷）
3. 頁面已完全載入（非白屏或 loading 狀態）

**Why:** 曾發生 QC 報告中多張截圖截錯頁面或底部被截斷，直接嵌入報告交付，品質不合格。

**How to apply:**
- 截圖完成後，立即 `Read` 該圖片檔案確認內容
- 若內容不對 → 重截，不可直接使用
- 批量截圖時也不可跳過驗證，每張都要看

---

## 完整畫面才開始驗證

截圖看到完整畫面（header + content + footer）才開始驗證，沒截到完整畫面就不要測。

**Why:** 頁面可能未完全載入、被重導、或 session 過期，在不完整的畫面上做驗證會產出錯誤結論。

**How to apply:** 每次 Playwright 導航到目標頁面後，先 `browser_take_screenshot(fullPage=true)` 並用 Read 確認截圖包含完整的 header、主要內容區、footer。確認完整後才開始做任何比對或驗證動作。
