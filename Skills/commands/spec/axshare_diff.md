# /axshare_diff — AxShare 規格書 vs 測試網站差異比對（支援全站 / 單一單元）

你是 QA 分析師，負責比對 Axure 規格書與測試網站之間的功能差異。
使用 Playwright 擷取頁面內容（規格書和測試網站都用 browser_snapshot），產出完整差異報告或針對單一模組做深度分析。

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
| 執行模式 | 全站報告 或 單一單元分析 | `全站` 或 `單一:現貨商品管理` |
| 現有報告檔 | (單一單元模式) 要整合結果的報告檔路徑 | `axshare_diff_report_20260302.md` |

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

---

## 執行步驟

### 步驟 0：確認執行模式

先判斷使用者要的是哪種分析：

| 模式 | 適用情境 | 輸出方式 |
|------|---------|---------|
| **全站報告** | 首次比對、全面盤點 | 產出獨立的完整差異報告 |
| **單一單元分析** | 針對特定模組深度比對 | 整合進現有 `axshare_diff_report_*.md` 報告檔 |

**單一單元模式**額外需要：
1. 現有報告檔路徑（要整合結果的目標檔案）
2. 該模組對應的 DB 表名 / Model 類別（用於 DB 影響評估）
3. 該模組在報告中的 TODO 章節位置

若使用者未明確指定模式，從 `$ARGUMENTS` 判斷：
- 提到具體模組名稱（如「現貨商品管理」）→ 單一單元模式
- 提到「全站」「全部」或未指定 → 全站報告模式

---

### 步驟 0b：確認規格書來源

詢問使用者提供規格書的方式：

- **A. AxShare 網址** — 用 Playwright `browser_navigate` + `browser_snapshot` 擷取
- **B. 本地匯出 HTML** — 啟動本地 HTTP server + Playwright 開啟擷取
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

#### 模式 B — 本地匯出 HTML（HTTP server + Playwright）

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
   - browser_take_screenshot(fullPage: true) → 完整頁面截圖（含 JS 渲染後的視覺效果）
   - 從 snapshot 解析：文字標籤、表單元件、按鈕、表格結構
```

> 本地 HTML 透過 HTTP server + Playwright 開啟，可正確渲染 JavaScript 互動元件（Axure 匯出含 JS）。
> HTTP server 在分析完成後會自動隨 session 結束。

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

### 步驟 5b：DB 影響評估（僅單一單元模式）

> 全站報告模式跳過此步驟。

單一單元模式需評估規格差異對資料庫的影響：

```
1. 用 Agent(Explore) 讀取相關資料：
   - database/*.dbml 中該模組的表定義（所有欄位）
   - cls/model/{module}.class.php 的 add/update 方法（實際使用的欄位）
   - adminControl/{module}/add.php 表單結構（與 Playwright 擷取交叉驗證）

2. 將規格書「缺少」的欄位逐一判斷：
   a. 現有表已有此欄位但表單未顯示 → 僅需 UI 修改
   b. 現有表已有其他欄位可對應 → 複用現有欄位
   c. 現有表確實沒有此欄位 → 需 ALTER TABLE ADD COLUMN
   d. 需要全新的表結構 → 需 CREATE TABLE

3. 產出 DB 影響評估：
   - 是否需新建 Table（結論 + 理由）
   - 需新增的欄位列表（表名 / 欄位名 / 類型 / 說明）
   - 現有可複用的欄位
   - ALTER TABLE SQL 彙總
```

---

### 步驟 5c：整合進現有報告（僅單一單元模式）

> 全站報告模式跳過此步驟，直接到步驟 6。

將分析結果整合進使用者指定的現有報告檔：

```
1. Read 現有報告檔，定位該模組的 TODO 章節
2. 用 Edit 更新該章節：
   - 加入 Axure 比對完成標記和日期
   - 用結構化子區塊取代原有的待辦項目：
     · 各子模組的欄位差異
     · DB 加欄位清單（含 ALTER TABLE SQL）
     · UI 微調項目
     · 比對統計表
   - 保留原有的「開發者備註」內容

3. 更新報告中的其他關聯區塊：
   - 「新功能建表統計」→ 加入該模組的結論摘要
   - 「資料表影響統計」→ 修正該模組的影響等級
   - 「主要發現」→ 更新該模組的發現描述
   - 報告時間戳 → 加入本次比對日期

4. 不另外產出獨立報告，所有結果都寫入現有報告檔
```

**整合格式範例**（TODO 章節內）：

```markdown
### {模組名稱} (程式碼確認 + Axure 規格比對完成)

> **Axure 規格比對**: {日期} 使用 `/axshare_diff` B 模式比對完成
> **結論: {是否需新建 Table}**

#### {子模組 1}
- [ ] 待辦項目...

#### {子模組 2}
- [ ] 待辦項目...

#### ALTER TABLE 彙總 (共 N 表 M 欄位)
\```sql
ALTER TABLE ... ADD COLUMN ...
\```

#### Axure 比對統計
| 狀態 | 數量 | 比例 |
|------|:---:|------|
| 一致 | X | X% |
| ...  | ...| ... |
```

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

### 通用規則
- 先完成兩端擷取再比對，不要邊抓邊猜
- 以規格書為基準，「缺少」= 規格有但實作沒有
- AxShare 是 SPA，必須用 Playwright 擷取，禁止用 `send_http_request`
- 後台頁面必須先登入再抓取，不要拿登入頁內容當比對資料
- 模式 B 禁止用 `file://`，必須啟動 HTTP server 後用 `http://localhost` 存取
- 此 Skill 僅做分析報告，不修改任何程式碼（ALTER TABLE SQL 只列出不執行）

### 全站報告模式
- 不讀取 PHP 原始碼，只比對「規格書畫面」vs「網站渲染結果」
- 三種報告格式都要產出（總覽表格 / 逐頁比對 / 待辦清單）

### 單一單元模式
- **可以**讀取 DB schema (DBML) 和 Model 類別，用於 DB 影響評估
- **不另外產出獨立報告**，所有結果直接整合進現有報告檔
- 整合時保留原有的「開發者備註」，不刪除不覆蓋
- 更新報告後必須同步更新「統計摘要」和「時間戳」區塊
- 比對統計表嵌入 TODO 章節內，不放在報告末尾
