---
name: axshare_diff
description: "比對 AxShare 規格書與實作的差異。當使用者說「比對規格」「校閱模組」「規格有沒有改」時使用。"
---

# /axshare_diff — AxShare 規格書 vs 測試網站差異比對（支援全站 / 單一單元 / 日期註記掃描 / 模組校閱）

你是 QA 分析師，負責比對 Axure 規格書與測試網站之間的功能差異。
使用 Playwright 擷取頁面內容（規格書和測試網站都用 browser_snapshot），產出完整差異報告、針對單一模組做深度分析、或掃描規格書上特定日期的新增註記並整合到既有報告。

---

## 使用者輸入

$ARGUMENTS

---

## 規格書來源優先順序（重要）

> **一律先找本地索引檔，找到就用，不開 Playwright。**
>
> 1. **優先**：讀取專案目錄下的本地索引（由 `/axshare_spec_index` 產生）：
>    - `spec/axshare_spec_reference_backend.md` — 後台（開發時預設讀這份）
>    - `spec/axshare_spec_reference_frontend.md` — 前台
>    - 舊版單檔 `spec/axshare_spec_reference.md` 也相容
> 2. **次選**：使用者提供的其他本地索引檔路徑
> 3. **最後才用 Playwright**：只有在沒有任何本地索引時，才透過 Playwright 開 AxShare
>
> 本地索引不需 Playwright，無 output too large 問題，速度快 10 倍。

---

## 需要的資訊

若使用者未提供以下資訊，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| 規格書來源 | 本地索引檔路徑（優先）或 AxShare 網址 | `{ProjectFolder}/spec/axshare_spec_reference_backend.md` 或 `https://xxx.axshare.com` |
| 測試網站網址 | 測試網站的基礎 URL | `http://localhost/project/adminControl` |
| 比對頁面 | 要比對的頁面清單 | `list, add, detail, update` |
| 登入資訊 | 測試帳號密碼（後台需登入） | `admin / password` |
| 執行模式 | 全站報告 或 單一單元分析 | `全站` 或 `單一:現貨商品管理` |
| 現有報告檔 | (單一單元/註記掃描模式) 要整合結果的報告檔路徑 | `axshare_diff_report_20260302.md` |
| 目標日期 | (註記掃描模式) 要搜尋的日期標記 | `20260304` |
| 掃描範圍 | (註記掃描模式) 全站或指定模組 | `全站` 或 `訂單管理,會員中心` |

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
| `read_file` / `read_files_batch` | 讀取本地 spec 索引或匯出 HTML |
| `send_http_request` | 直接 GET 測試網站頁面取得 HTML 內容 |
| `create_file` | 儲存差異報告（`reports/axshare_diff_*.md`） |

---

## 執行步驟

### 步驟 0：確認執行模式

先判斷使用者要的是哪種分析：

| 模式 | 適用情境 | 輸出方式 |
|------|---------|---------|
| **全站報告** | 首次比對、全面盤點 | 產出獨立的完整差異報告 |
| **單一單元分析** | 針對特定模組深度比對 | 整合進現有 `axshare_diff_report_*.md` 報告檔 |
| **日期註記掃描** | 規格書有版本更新，需找出所有帶日期標記的新增/修改內容 | 整合進現有報告檔 |
| **模組校閱** | 複雜模組（多子頁面）逐頁全面比對 | 產出獨立的 `spec/{module}_diff_report.md` |

**單一單元模式**額外需要：
1. 現有報告檔路徑（要整合結果的目標檔案）
2. 該模組對應的 DB 表名 / Model 類別（用於 DB 影響評估）
3. 該模組在報告中的 TODO 章節位置

**日期註記掃描模式**額外需要：
1. 現有報告檔路徑（要整合結果的目標檔案）
2. 目標日期標記（如 `20260304`）
3. 掃描範圍（全站或指定模組清單）

**模組校閱模式**額外需要：
1. 目標模組名稱（如「訂單」「會員」）
2. 模組在 `adminControl/` 下的目錄結構（主目錄 + 所有子目錄）
3. 對應的規格書頁面群（從本地索引檔篩選出該模組的所有頁面）

若使用者未明確指定模式，從 `$ARGUMENTS` 判斷：
- 提到「掃描」「註記」「annotation」或日期格式（如 `20260304`）→ 日期註記掃描模式
- 提到「校閱」「全面校閱」「模組校閱」「audit」→ 模組校閱模式
- 提到具體模組名稱 + 「比對」→ 單一單元模式
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

#### 模式 L — 本地索引檔（預設，優先使用）

> **這是預設模式。** 先嘗試讀取本地索引檔，有就用，跳過所有 Playwright 步驟。

```
1. 依比對內容決定讀哪份索引：
   - 後台比對（預設）→ read_file `{ProjectFolder}/spec/axshare_spec_reference_backend.md`
   - 前台比對 → read_file `{ProjectFolder}/spec/axshare_spec_reference_frontend.md`
   - 舊版單檔 → read_file `{ProjectFolder}/spec/axshare_spec_reference.md`（向下相容）
2. 若檔案存在且內容非空：
   - 直接從 Markdown 解析出各頁面的欄位/按鈕/邏輯
   - **跨頁引用展開**（見下方規則）
   - 跳過步驟 1 其餘模式，直接進入步驟 2
3. 若檔案不存在 → 提示使用者先執行 `/axshare_spec_index`，
   或改用下方模式 A/B/C 作為 fallback
```

> **⚠️ 跨頁引用自動展開**
>
> 讀取目標模組的規格書頁面後，檢查每頁的「**跨頁引用**」區塊（由 `/axshare_spec_index` 產生）。若有引用其他頁面：
>
> 1. 從索引中找到被引用頁面的內容
> 2. 將被引用頁面**自動加入本次掃描範圍**（即使它不在使用者指定的模組內）
> 3. 在報告中標記這些頁面為「📎 跨頁引用」，與主要掃描頁面區分
>
> **展開規則**：
> - 只展開一層（被引用頁面若再引用第三層，不繼續展開，僅提示）
> - 若被引用頁面在另一份索引檔（如後台引用前台），需讀取該份索引
> - 若索引檔無「跨頁引用」區塊（舊版索引），改用全文搜尋關鍵字：「參照」「詳見」「見」「連結」「同 XX 頁面」
>
> **為什麼重要**：規格書常把共用邏輯（如狀態機、計算規則）定義在某個頁面，其他頁面只寫「詳見 XX」。若不展開，會漏掉這些關鍵規格。

#### 模式 A / B / C — Playwright fallback（僅在無本地索引時使用）

讀取 `_axshare_diff/spec_fetch_modes.md`，依模式 A（AxShare 網址）/ B（本地匯出 HTML）/ C（手動描述）執行擷取流程，並依該檔規定的「規格摘要輸出格式」整理結果。

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

### 步驟 A：日期註記掃描模式

> 全站報告和單一單元模式跳過此段，直接到步驟 6。
> 日期註記掃描模式跳過步驟 1-5c，從這裡開始。

讀取 `d:\Develop\MCP_NodeServer\Skills\commands\spec\_axshare_diff\date_scan_steps.md`，依 A1–A5 步驟執行。

---

### 步驟 B：模組校閱模式

> 全站報告、單一單元、日期註記掃描模式跳過此段，直接到步驟 6。
> 模組校閱模式跳過步驟 1-5c 和步驟 A，從這裡開始。

讀取 `d:\Develop\MCP_NodeServer\Skills\commands\spec\_axshare_diff\module_review_steps.md`，依 B1–B6 步驟執行。

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

讀取 `d:\Develop\MCP_NodeServer\Skills\commands\spec\_axshare_diff\notes.md` 確認各模式規則與後續清理步驟。
