---
name: bug_trace
description: |
  追蹤 Bug 根因：從症狀描述出發，先對照規格書確認預期行為，再自動跨層定位問題（頁面→API→Model→DB），產出根因分析報告。
  涵蓋：規格書預期行為對照、前台/後台 Bug 追蹤、SQL 資料驗證、函式呼叫鏈追蹤、修復建議產出。
  當使用者說「這個功能壞了」「幫我查 Bug」「為什麼 X 不正常」「trace 一下」時使用。
---

# /bug_trace — 從症狀追蹤 Bug 根因並產出分析報告

你是 Bug 追蹤專家。給定症狀描述，你會先查規格書確認預期行為，再沿呼叫鏈逐層追蹤，定位根因並產出結構化報告。

---

## 使用者輸入

$ARGUMENTS

格式：自然語言描述症狀。範例：
- `/bug_trace 後台新增分類儲存失敗，SQL Error`
- `/bug_trace 前台部落格相關商品重複顯示 11 次`
- `/bug_trace FAQ 上下移動按鈕點了沒反應`

---

## 需要的資訊

若使用者未提供，從 $ARGUMENTS 推斷。仍不明確才詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| 症狀 | 什麼功能、什麼行為不正常 | `新增分類儲存失敗` |
| 位置 | 前台/後台、哪個頁面或模組 | `後台 > 現貨分類管理` |
| 嚴重度 | P1~P3（可選，不影響追蹤） | `P1` |

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `Grep` | 在規格書中搜尋功能說明段落 |
| `Read` | 讀取規格書段落、codemap 或特定檔案片段 |
| `class_method_lookup` | 直接取得 class+method 原始碼（**優先使用**） |
| `find_usages` | 不確定在哪個檔案時 AST 精確搜尋引用位置 |
| `execute_sql` | 驗證 DB 資料是否正常 |
| `get_db_schema` | 查表結構（欄位/型別/預設值） |
| `run_php_script` | 執行 PHP 片段驗證行為 |
| `send_http_request` | 呼叫 API 端點驗證回傳 |

---

## 執行步驟

### 步驟 1：症狀解析與定位入口

從症狀描述判斷入口層：

| 症狀關鍵字 | 入口層 | 起始動作 |
|-----------|--------|---------|
| 儲存失敗/SQL Error | Model | 查 class 的 add()/update() |
| 頁面空白/500 | 頁面 PHP | 查入口檔案頂部 include 鏈 |
| 列表顯示異常 | Model + DB | 查 getAll() SQL + 資料 |
| AJAX 回傳錯誤 | API 端點 | **先走步驟 2.5 AJAX gate** |
| **按了沒反應 / UI 沒更新** | API 端點 | **先走步驟 2.5 AJAX gate**（最常見：後端 fatal 噴 HTML，jQuery dataType:'json' 靜默不執行 success） |
| **backend 已生效但前端沒變** | API 端點 | **先走步驟 2.5 AJAX gate** |
| 排序/移動無效 | Model + DB | 若按鈕點了沒反應 → 先走步驟 2.5 AJAX gate |
| 前台顯示不正確 | 前台 PHP + DB | 查前台頁面 + 對應查詢 |

---

### 步驟 2：規格書對照（查預期行為）

在追蹤程式碼之前，先從規格書確認該功能的預期行為。

**規格書位置（依專案慣例，若不存在則跳過此步驟）：**

| 範圍 | 規格書路徑 |
|------|-----------|
| 後台 | `spec/backend/axshare_spec_reference_backend.md` |
| 前台 | `spec/frontend/axshare_spec_reference_frontend.md` |
| 訂單流程 | `spec/order_flow.md` |

**搜尋策略：**

1. 用 Grep 搜尋規格書，搜尋詞按優先順序嘗試：
   - URL path 片段（如 `order/ready_pending`）
   - 中文頁面名稱（如 `現貨訂單待處理`）
   - 模組名稱（如 `ready_pending`）
2. 找到 `###` 標題後，用 Read(offset, limit) 讀取該段落到下一個 `---` 分隔線為止
3. 從段落中提取以下欄位（有則記錄，無則標記「規格書未記載」）：
   - **功能說明** — 該頁面/模組的功能描述
   - **列表欄位** — 列表頁應顯示哪些欄位
   - **按鈕/操作** — 有哪些按鈕和對應行為
   - **可編輯欄位** — 新增/編輯表單應有的欄位
   - **修正/更新記錄** — 帶日期標註的變更（如 `20260304修正`、`20260309修正更新`）

**注意：** 修正/更新記錄特別重要 — 近期的修正可能正是 Bug 的來源或相關上下文。

若規格書檔案不存在，輸出 `（規格書未找到，跳過對照步驟）` 並直接進入步驟 2.5。

---

### 步驟 2.5：AJAX Gate（必做且不可省略）

**觸發條件（任一即必做）：**
- 症狀涉及「AJAX / 按鈕點了沒反應 / 前端沒更新但 backend 有變 / UI 沒重渲染」
- 程式碼中發現 `$.ajax({...})` / `fetch()` / `XMLHttpRequest` 介於使用者操作與資料變更之間

**必做動作（用 `send_http_request` 或 `run_php_code` curl 取 raw body）：**

```text
1. 取得實際 endpoint URL 與 POST payload（從程式碼或 Network 面板）
2. send_http_request 呼叫該 endpoint，**取原始 200 body 文字**（不是解析後的 JSON）
3. 檢查 body 第一個字元：
   ▸ `{` 或 `[` 開頭 → 合法 JSON → 進前端追（reactivity / 事件綁定）
   ▸ `<` 開頭 / 含 `<b>Fatal error</b>` / `<br />Warning` / `Notice:` → 根因在後端
   ▸ HTTP 狀態 != 200 → 根因在後端（路由 / 權限 / 例外）
```

**判定後的動作分支：**

| body 樣態 | 根因方向 | 後續步驟 |
|----------|---------|---------|
| 合法 JSON 且 `result=1` | 前端問題 | 進步驟 3 追前端（Vue reactivity / DOM / 事件綁定） |
| HTML / Fatal / Warning | 後端問題 | 進步驟 3 但**只追後端 PHP**，禁止改前端 |
| 非 200 | 後端問題 | 進步驟 3 追路由 / include / 權限 |
| 空 body | 後端問題 | 進步驟 3 追 die() / exit() / output buffer |

**🚫 禁止行為（拿到 raw body 之前一律禁止）：**
- 修改任何前端檔案（footer.php / *.js / *.vue）
- 改 Vue method / 事件綁定 / reactivity 寫法
- 跑 Playwright 測互動（會被靜默失敗誤導）

**為什麼這條是鐵律：** `dataType:'json'` + 後端非 200 / 非 JSON = jQuery `success` callback 靜默不執行，前端看起來「按了沒反應」，但根因在後端 fatal 把 HTML 噴進回應。先讀 raw body 一次就破案，跳過此步常導致 20+ 輪繞遠路。

---

### 步驟 3：呼叫鏈追蹤（最多 4 層；AJAX gate 已定向時 1-2 層即可）

**追蹤層數動態調整：**
- 步驟 2.5 AJAX gate 已定向到「後端 fatal」→ 直接 1 層（讀 endpoint PHP）即可，不要為了「嚴謹」多追 Vue / 前端
- 步驟 2.5 已定向到「前端問題」→ 略過後端 Model/SQL 層
- 一般症狀（無 AJAX gate 定向）→ 沿原本 4 層追蹤

若專案有 codemap（`docs/CODEMAPS/backend.md`），先讀 codemap 定位函式行號。
若無 codemap，用 `class_method_lookup` 或 `find_usages` 定位。

從入口層開始，沿呼叫鏈逐層追蹤：

```
層 1：頁面入口（admin/{module}/add_.php → $class->add($_POST)）
層 2：Model 方法（class->add() → SQL INSERT）
層 3：SQL 語句（INSERT 欄位是否完整、WHERE 是否正確）
層 4：DB 資料（實際資料是否符合預期）
```

每層只讀需要的片段（用 class_method_lookup 一次到位，不要 Grep → Read 兩步），禁止讀整個檔案。

若某層確認正常，標記 PASS 並繼續下一層。
若某層發現異常，標記為疑似根因，繼續驗證。

**與規格書交叉比對：** 追蹤每層時，將程式碼實際行為與步驟 2 提取的預期行為比對。特別注意：
- 列表 SQL 的 SELECT 欄位是否涵蓋規格書要求的所有欄位
- 表單欄位是否與規格書的「可編輯欄位」一致
- 按鈕操作是否符合規格書描述的行為

---

### 步驟 4：DB 資料驗證

根據追蹤到的 SQL，直接查 DB 驗證：

- `get_db_schema`：確認表結構（NOT NULL / DEFAULT / FK）
- `execute_sql`：查實際資料（如 order_num 是否有重複/間隙）

典型驗證查詢：
- 排序問題：`SELECT id, order_num FROM {table} ORDER BY order_num` → 看有無重複/間隙
- 儲存失敗：`DESCRIBE {table}` → 看 NOT NULL 欄位是否都有對應表單欄位
- 重複顯示：直接跑嫌疑 SQL 看結果筆數

---

### 步驟 5：根因判定與修復建議

彙整所有層的追蹤結果，判定根因類型：

| 根因類型 | 典型原因 | 修法方向 |
|---------|---------|---------|
| SQL 缺欄位 | INSERT 漏掉 NOT NULL 欄位 | 補欄位到 SQL + 表單 |
| SQL 重複 | JOIN/子查詢造成 row multiplication | 加 GROUP BY 或改 JOIN |
| 資料不一致 | order_num 重複/間隙 | reindex SQL |
| 邏輯錯誤 | 條件判斷反轉/變數未定義 | 修正條件 |
| 前後端不一致 | 表單 name 與 PHP 變數不對應 | 對齊命名 |
| 規格不符 | 程式碼行為與規格書描述不一致 | 依規格書修正實作 |
| **跨層映射不一致** | UI 顯示欄位 ↔ 後端變數 ↔ DB 欄位 名稱/型別錯位 | 補 mapping 表並對齊 |

---

### 步驟 5.5：跨層 mapping audit（可選；當症狀涉及欄位錯位、顯示空白、資料對不上時必做）

當症狀是「某欄位顯示異常」「資料對不到表」「印出來的值跟 DB 不一致」時，光追呼叫鏈不夠 — 真正缺的是**三層對照表**：

```
UI/Template 顯示位置  ←→  後端變數/PHP key  ←→  DB 欄位/Sheet cell
```

操作方式：

1. **找出症狀欄位的三個座標**
   - UI 端：template 的位置（檔名 + 行號 + 顯示用變數名）
   - 後端端：傳入 template 的變數來源（class::method 名稱 + key 名）
   - 資料端：DB 欄位 / Sheet cell / 設定檔 key
2. **逐層比對名稱與型別**
   - 變數名是否一致（常見 typo：`paper_prep` vs `papper_prep`）
   - 型別是否一致（DB int vs PHP string vs UI 格式化字串）
3. **產出 mapping 表**附在報告

範例：

| 項目 | UI（template） | 後端（class::method） | 資料端（DB/Sheet） | 差異 |
|------|---------------|---------------------|------------------|------|
| 紙板費 | `estimate_print.php:380` `$d['paper_prep']` | `PricingService::calc()` expose `$d['paper_prep']` | `tbl_order_custom.paper_cost` | ⚠️ key 不同名 |
| 印刷顏色 | 顯示文字 | `$cart['print_color']` | `cart.colorlist` | ⚠️ template 用 `print_color`，cart 用 `colorlist` |

→ 直接定位「欄位錯位」這類 bug，不用一路追到 SQL。

---

### 步驟 6：產出報告

```markdown
## Bug 追蹤報告

**症狀：** {一句話描述}
**嚴重度：** {P1/P2/P3}

---

### 規格書預期行為

- **頁面**：{頁面名稱}（{規格書來源}）
- **列表欄位**：{規格書描述的欄位清單}
- **按鈕/操作**：{規格書描述的按鈕與行為}
- **功能說明**：
  - {逐條列出}
- **修正/更新**：
  - {逐條列出帶日期標註}

> 若規格書未找到，此區塊顯示「規格書未找到，無法對照」

### 現況 vs 規格差異

| 項目 | 規格書 | 現況 | 差異 |
|------|--------|------|------|
| {欄位/功能} | {規格描述} | {程式碼實際行為} | ✅ 一致 / ⚠️ 不一致 |
| ... | ... | ... | ... |

---

### 追蹤路徑

| 層 | 檔案/位置 | 結果 |
|----|----------|------|
| 頁面入口 | {file} | {PASS/FAIL} |
| Model | {class}::{method} L{line} | {PASS/FAIL} |
| SQL | {SQL 片段} | {PASS/FAIL} |
| DB 資料 | {驗證結果} | {PASS/FAIL} |

### 根因

**{根因類型}：** {一句話描述根本原因}
- 位置：{file}:{line}
- 證據：{具體數據或程式碼片段}

### 修復建議

1. {具體修法}
2. {若有 DB 修復}

### 影響範圍

- {列出可能受影響的其他頁面/功能}
```

---

## 注意事項

- 每層追蹤限 1 次 tool call（用 class_method_lookup 一次到位，不要 Grep → Read 兩步）
- 總 tool call 目標 ≤ 8 次（規格書 1-2 + 定位 1 + 追蹤 3 層 + DB 驗證 1 + 確認 1）
- **AJAX 類 bug 經 gate 定向後，1 個 send_http_request + 1 個檔案讀取常常就破案**，不要為了「層數嚴謹」硬追到 4 層
- **不修程式碼，只產出分析報告**。修復由使用者決定觸發
- **AJAX gate 未通過前禁止修改任何前端檔案**（footer.php / *.js / *.vue / 事件綁定 / Vue method）
- DB 驗證用 SELECT 唯讀查詢，禁止 UPDATE/DELETE
- 若 4 層追蹤後仍無法判定根因，明確告知「需要更多資訊」而非猜測
- 規格書不存在時不報錯，跳過對照步驟繼續追蹤
