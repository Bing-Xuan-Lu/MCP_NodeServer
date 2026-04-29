# 規格書擷取 fallback 模式（A/B/C）

由 `/axshare_diff` 步驟 1 引用。**僅在無本地索引（模式 L 失敗）時才使用。**

---

## 模式 A — AxShare 網址（Playwright fallback）

> **AxShare 架構提醒**：AxShare 頁面使用多層 iframe（導航在 sidebar iframe、內容在 content iframe），`browser_click` 無法直接穿透 iframe。**必須先用 `browser_evaluate` 抽取所有頁面 URL，再以 `browser_navigate` 直連**，不依賴點擊 nav。

```
1. browser_navigate(url: "{AxShare 網址}")
2. browser_snapshot() → 確認頁面載入，取得頂層結構

3. 抽取導航連結（優先方式）：
   browser_evaluate(script: 讀取 _axshare_spec_index/extract_iframe_script.md 的「全站模式 nav 連結抽取」段落)
   → 取得頁面清單 [{ text, href }, ...]

4. 若 browser_evaluate 無法取得（cross-origin 限制）：
   - 從 browser_snapshot 的 accessibility tree 找 nav 區塊
   - 手動整理頁面 URL 清單（AxShare URL 格式通常是 #p=page_name）

5. 對每個目標頁面：
   - browser_navigate(url: "{頁面直連 URL}")  ← 直連，不 click nav
   - browser_snapshot() → 取得 accessibility tree（已包含 content iframe 內容）
   - 從 snapshot 解析：文字標籤、表單元件、按鈕、表格結構
```

---

## 模式 B — 本地匯出 HTML（HTTP server + Playwright）

> **重要**: Playwright MCP 封鎖 `file://` 協定，必須先啟動 HTTP server。

```
1. list_files("{匯出目錄}") → 找到目標 .html 檔案清單
2. 啟動本地 HTTP server（背景執行）：
   cd "{匯出目錄}" && python -m http.server {port} &
   - 建議 port: 8099（避免與專案衝突）
   - 用 curl 確認 server 啟動成功
3. 對每個目標頁面：
   - browser_navigate(url: "http://localhost:{port}/{page}.html")
     （中文檔名需 URL encode，如 新增_5.html → %E6%96%B0%E5%A2%9E_5.html）
   - browser_snapshot() → 取得 accessibility tree
   - browser_take_screenshot(fullPage: true) → 完整頁面截圖
   - 從 snapshot 解析：文字標籤、表單元件、按鈕、表格結構
```

> 本地 HTML 透過 HTTP server + Playwright 開啟，可正確渲染 JavaScript 互動元件（Axure 匯出含 JS）。
> HTTP server 在分析完成後會自動隨 session 結束。

---

## 模式 C — 手動描述

```
使用者按格式描述每頁的欄位/按鈕/流程，直接解析為結構化格式。
```

---

## 規格摘要輸出格式（A/B/C 共用）

```
規格摘要：{page_name}

欄位清單：
  | # | 欄位名稱 | 類型 | 必填 | 備註 |
  |---|---------|------|------|------|
  | 1 | 日期 | 日期選擇器 | 是 | 預設今天 |

按鈕清單：[儲存, 取消, 返回列表]

特殊邏輯：
  - 日期預設值為今天
  - 附件限制 5MB
```
