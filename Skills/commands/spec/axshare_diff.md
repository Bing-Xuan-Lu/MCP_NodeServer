# /axshare_diff — AxShare 規格書 vs 測試網站差異比對

你是 QA 分析師，負責比對 Axure 規格書與測試網站之間的功能差異。
使用 Playwright 擷取頁面內容（規格書和測試網站都用 browser_snapshot），產出完整差異報告。

---

## 使用者輸入

$ARGUMENTS

---

## 需要的資訊

若使用者未提供以下資訊，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| 規格書來源 | AxShare 網址或本地 Axure 匯出 HTML 目錄 | `https://xxx.axshare.com` 或 `D:\specs\export\` |
| 測試網站網址 | 測試網站的基礎 URL | `http://localhost/project/adminControl` |
| 比對頁面 | 要比對的頁面清單 | `list, add, detail, update` |
| 登入資訊 | 測試帳號密碼（後台需登入） | `admin / password` |

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `browser_navigate` | 開啟規格書/測試網站頁面 |
| `browser_snapshot` | 擷取頁面 accessibility tree（欄位、按鈕、文字） |
| `browser_click` | 點擊規格書導航連結、展開選單 |
| `browser_fill_form` | 填寫登入表單 |
| `browser_evaluate` | 從頁面提取結構化資料（連結清單等） |
| `list_files` | 掃描本地 Axure 匯出目錄（模式 B） |
| `read_file` | 讀取本地 HTML 檔案（模式 B） |

---

## 執行步驟

### 步驟 0：確認規格書來源

詢問使用者提供規格書的方式：

- **A. AxShare 網址** — 用 Playwright `browser_navigate` + `browser_snapshot` 擷取
- **B. 本地匯出 HTML** — 用 `list_files` + `read_file` 讀取 Axure 匯出檔案
- **C. 手動描述** — 使用者逐頁列出欄位/按鈕/流程

> AxShare 是 SPA 架構，必須使用 Playwright 才能取得完整內容。
> `send_http_request` 只會取得空殼 HTML，禁止使用。

---

### 步驟 1：擷取規格書內容

#### 模式 A — AxShare 網址（Playwright）

```
1. browser_navigate(url: "{AxShare 網址}")
2. browser_snapshot() → 取得首頁結構，找到頁面導航清單
3. 對每個目標頁面：
   - browser_click(導航連結) 或 browser_navigate(直連 URL)
   - 等待頁面載入完成
   - browser_snapshot() → 取得 accessibility tree
   - 從 snapshot 解析：文字標籤、表單元件、按鈕、表格結構
```

#### 模式 B — 本地匯出 HTML

```
1. list_files("{匯出目錄}")
2. 對每個目標頁面找到對應 .html 檔案
3. read_file 讀取並解析 Axure 匯出格式
```

#### 模式 C — 手動描述

```
使用者按格式描述每頁的欄位/按鈕/流程，直接解析為結構化格式。
```

**每個頁面產出「規格摘要」：**

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

---

### 步驟 2：登入測試網站

後台頁面通常需要登入。詢問使用者登入資訊後：

```
1. browser_navigate(url: "{登入網址}")
2. browser_snapshot() → 確認登入表單結構
3. browser_fill_form(欄位填入帳號密碼)
4. browser_click(登入按鈕)
5. browser_snapshot() → 確認登入成功（看到後台頁面而非登入頁）
```

> Playwright 會自動維持 Cookie/Session，登入後所有後續頁面都可存取。

---

### 步驟 3：擷取測試網站內容

對每個目標頁面：

```
1. browser_navigate(url: "{測試網站}/{page}.php")
2. browser_snapshot() → 取得 accessibility tree
3. 從 snapshot 解析：
   - 表單欄位（input/select/textarea 的 name、type、required）
   - 對應的 label 文字
   - 按鈕（文字和類型）
   - 表格欄位（th 標頭）
   - 頁面標題
```

**每個頁面產出「實作摘要」（格式同規格摘要）。**

---

### 步驟 4：逐頁比對

將規格摘要和實作摘要逐項對齊比對。

比對維度：

| 比對項目 | 檢查內容 |
|---------|---------|
| 頁面存在性 | URL 是否可存取 |
| 欄位存在性 | 規格列出的欄位是否有對應 input |
| 欄位類型 | input type 是否一致 |
| 必填屬性 | 是否有 required |
| 按鈕存在性 | 頁面是否有對應按鈕 |
| 流程完整性 | CRUD 是否都有實作 |
| 文字一致性 | 標籤文字是否相符 |

結果分類：
- ✅ **一致** — 規格與實作相符
- ⚠️ **差異** — 有實作但與規格不同
- ❌ **缺少** — 規格有但未實作
- ➕ **多出** — 實作有但規格未定義

---

### 步驟 5：產出差異報告

產出三種格式：

**格式一：總覽表格**

| # | 頁面 | 規格項目 | 測試網站 | 狀態 | 說明 |
|---|------|---------|---------|------|------|
| 1 | list | 搜尋：日期範圍 | 有 | ✅ 一致 | |
| 2 | list | 匯出 Excel 按鈕 | 無 | ❌ 缺少 | 規格有但未實作 |

**格式二：逐頁比對** — 每個頁面的規格 vs 實作詳細對照

**格式三：待辦清單** — 缺少/差異項目的優先排序 TODO

---

### 步驟 6：統計摘要

```
比對頁面數：N 頁
總比對項目：M 項

| 狀態 | 數量 | 比例 |
|------|------|------|
| ✅ 一致 | X | X/M% |
| ⚠️ 差異 | Y | Y/M% |
| ❌ 缺少 | Z | Z/M% |
| ➕ 多出 | W | W/M% |

規格完成度：(X+Y)/M%
規格吻合度：X/M%
```

---

## 注意事項

- 不讀取 PHP 原始碼，只比對「規格書畫面」vs「網站渲染結果」
- 先完成兩端擷取再比對，不要邊抓邊猜
- 以規格書為基準，「缺少」= 規格有但實作沒有
- AxShare 是 SPA，必須用 Playwright 擷取，禁止用 `send_http_request`
- 後台頁面必須先登入再抓取，不要拿登入頁內容當比對資料
- 此 Skill 僅做分析報告，不修改任何程式碼
- 三種報告格式都要產出
