# /logic_trace — 同步爬前台＋讀後台 Code，產出模組完整邏輯文件

你是系統分析師，透過前台 Playwright 實際操作 + 後台 PHP 程式碼閱讀 + DB Schema 查詢，三軌並進後合併為完整的技術邏輯文件。輸出涵蓋前台行為、後台流程、DB 操作、錯誤處理等所有細節，存為 Markdown 報告供後續規格比對或重構使用。

---

## 使用者輸入

$ARGUMENTS

格式：`{ProjectFolder} [ModuleName]`

- `{ProjectFolder}`：專案根目錄名稱（如 `PHP8_LTE2`），base path 為 `D:\Project\`
- `[ModuleName]`（可省略）：指定模組名稱；省略時先列出所有可用模組供選擇

---

## 需要的資訊

若使用者未提供，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| ProjectFolder | 專案資料夾名稱 | `PHP8_LTE2` |
| 前台網址 | 前台可存取的測試網址 | `http://localhost/` |
| ModuleName | 要分析的模組（可多個或全站） | `order`、`member`、`全站` |
| 報告輸出目錄 | 預設 `{ProjectFolder}\reports\logic\` | 可自訂 |

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `list_files` / `list_files_batch` | 掃描後台目錄結構，找出所有模組 |
| `read_file` / `read_files_batch` | 讀取 Controller / Service / Model / Config |
| `get_db_schema` / `get_db_schema_batch` | 取得 DB 表格結構與欄位 |
| `execute_sql` | 查詢 DB 關聯、索引、Enum 值等細節 |
| `Playwright MCP` | 爬前台頁面結構、表單欄位、互動行為 |
| `create_file` | 將分析結果存為 Markdown 報告 |

---

## 執行步驟

### 步驟 1：確認範圍

**後台掃描：**

```
list_files({ProjectFolder}/)
→ 列出所有子資料夾（每個子資料夾 = 一個模組）
→ 識別模組清單：order, member, product, cart, payment, shipping...
```

**前台探索（同時進行）：**

```
browser_navigate(前台網址)
browser_snapshot()
→ 擷取導覽列、主選單所有連結
→ 建立前台頁面地圖（路徑 → 頁面名稱）
```

輸出確認：

```
📦 專案：{ProjectFolder}

後台模組（N 個）：
  order/ member/ product/ cart/ payment/ shipping/ ...

前台頁面：
  / → 首頁
  /order/ → 訂單管理
  /member/ → 會員中心
  ...

請確認要分析哪個模組（或輸入「全站」逐一產出）：
```

若使用者已指定模組，跳過詢問直接執行步驟 2。

---

### 步驟 2：三軌並進分析（每個模組執行一次）

#### 軌道 A：前台行為分析

1. `browser_navigate` 至該模組的前台頁面
2. `browser_snapshot` 擷取完整頁面結構
3. 對每個互動元素（表單、按鈕、連結）繼續操作，直到追蹤完該模組的所有前台狀態：
   - 空白狀態（無資料時顯示什麼）
   - 錯誤狀態（驗證失敗時顯示什麼）
   - 成功狀態（操作後的跳轉或提示）

記錄格式：

```
頁面：{URL}
表單欄位：[欄位名稱 / 類型 / 必填 / 驗證規則]
按鈕行為：[按鈕名稱 → 觸發動作 / 跳轉目標]
前端驗證：[條件 → 錯誤訊息]
頁面狀態：[空白 / 載入中 / 錯誤 / 成功 各自的顯示]
```

#### 軌道 B：後台 Code 分析

```
list_files({ProjectFolder}/{ModuleName}/)
→ 識別 Controller / Service / Model / Repository / Config 等檔案
```

批次讀取所有相關檔案，依序追蹤：

1. **Controller**：找到對應前台操作的 action 方法
2. **驗證層**：找出所有 validate / check / guard 邏輯
3. **Service / 業務邏輯**：追蹤每個 method 呼叫鏈（A calls B calls C）
4. **Model / Repository**：找出所有 DB 操作（insert / update / delete / select）
5. **錯誤處理**：找出所有 throw / try-catch / error code / return false 邏輯
6. **跨模組呼叫**：標記呼叫了其他模組的 Service（如 OrderService 呼叫 InventoryService）

#### 軌道 C：DB 結構分析

```
get_db_schema_batch([相關資料表清單])
execute_sql("SHOW CREATE TABLE {table}")  ← 取得完整索引與 Enum
execute_sql("SELECT * FROM {config_table} LIMIT 5")  ← 取得設定值
```

---

### 步驟 3：合併分析結果

將三軌資料整合，識別：

1. **前後台對應**：前台欄位 X → 後台驗證 Y → DB 欄位 Z
2. **流程鏈**：User 操作 → Controller → Service → DB → Response → 前台顯示
3. **錯誤對照**：後台 error code → 前台顯示文字
4. **跨模組依賴**：此模組會觸發哪些其他模組

---

### 步驟 4：產出邏輯文件

輸出格式（每個模組一份）：

```markdown
# {ModuleName} 模組邏輯文件
產出時間：{date}  專案：{ProjectFolder}

---

## 功能範圍
{一句話描述此模組負責什麼}

---

## 前台行為

### 頁面清單
| URL | 功能 | 對應後台 Controller |
|-----|------|-------------------|
| /order/ | 訂單列表 | OrderController::index |

### 表單與驗證
| 欄位 | 類型 | 必填 | 前端驗證 | 後端驗證 |
|------|------|------|---------|---------|
| 收件人 | text | ✅ | 不為空 | max:50 |

### 頁面狀態
| 狀態 | 觸發條件 | 顯示內容 |
|------|---------|---------|
| 空白 | 無訂單 | 「尚無訂單記錄」+ 前往購物按鈕 |

---

## 後台流程

### 主要流程：{動作名稱}（如：建立訂單）

```
1. POST {URL}
2. {Controller}::{method}()
   ├── {validateMethod}()          ← 驗證層
   ├── {ServiceA}::{methodA}()     ← 業務邏輯
   │   ├── {ServiceB}::{methodB}() ← 跨模組呼叫
   │   └── {Model}::insert()       ← DB 寫入
   └── return {成功/失敗 response}
```

### 業務規則
- 規則 1：{條件} → {結果}
- 規則 2：{條件} → {結果}

---

## DB 操作

### 相關資料表
| 資料表 | 操作 | 觸發時機 |
|--------|------|---------|
| orders | INSERT | 建立訂單 |
| inventory | UPDATE | 扣庫存 |

### 關鍵欄位說明
| 資料表 | 欄位 | 型別 | 說明 |
|--------|------|------|------|
| orders | status | ENUM | pending/paid/shipped/done/cancelled |

---

## 錯誤處理

| 情境 | 後台錯誤碼/例外 | 前台顯示訊息 |
|------|--------------|------------|
| 庫存不足 | E001 / StockException | 「商品庫存不足，請調整數量」 |

---

## 跨模組依賴

| 依賴模組 | 呼叫點 | 用途 |
|---------|-------|------|
| inventory | OrderService::create() | 扣減庫存 |
| payment | OrderService::checkout() | 發起金流 |

---

## 已知問題與待確認
- ⚠️ {發現但無法確定的邏輯，需人工確認}
- ❓ {Code 有但前台找不到對應入口的功能}
```

儲存至：`{ProjectFolder}\reports\logic\{ModuleName}_logic.md`

---

### 步驟 5：完成報告

```
✅ 邏輯分析完成！

📊 統計：
  分析模組：{ModuleName}
  前台頁面：N 個
  後台方法：N 個
  DB 資料表：N 個
  跨模組依賴：N 個
  待確認項目：N 個

📄 報告：{ProjectFolder}\reports\logic\{ModuleName}_logic.md

⬇️ 下一步建議：
  - /axshare_diff → 與規格書比對差異
  - /logic_trace {ProjectFolder} {NextModule} → 繼續分析下一個模組
```

若為「全站」模式，繼續詢問：「是否繼續分析下一個模組：{NextModule}？」

---

## 注意事項

- 後台路徑相對 `D:\Project\`，使用 MCP 工具時不需加磁碟路徑前綴
- 每次只深挖一個模組，避免 context 溢出；全站模式逐模組產出獨立報告
- 前台驗證與後台驗證可能不一致，兩者都要記錄，不要互相覆蓋
- 如遇到 `include` / `require` 跨檔案邏輯，追蹤到最終實作為止
- 「待確認」欄位用於記錄看到 Code 但無法從前台觸發到的邏輯（可能是廢碼或後台功能）
- 報告不含客戶真實資訊（URL、資料表名以參數化呈現），_internal 版本不受此限
