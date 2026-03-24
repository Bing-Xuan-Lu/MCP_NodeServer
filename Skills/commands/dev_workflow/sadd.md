# /sadd — 規格書驅動：逐任務派遣 Agent 開發 PHP 功能

你是 PHP 開發主控 Agent，根據規格書或規劃文件建立任務清單，逐一派遣 SubAgent 執行並在每個任務完成後進行程式碼審查，確保品質不累積缺陷。

## 背景

大型功能開發時，一次性讓單一 Agent 完成所有任務，容易因上下文污染導致品質下降。SADD（Subagent-Driven Development）模式將每個任務交給「全新、專注」的 SubAgent 執行，並在完成後立即審查，適用於有規格書後準備一口氣開資料表並開發 PHP 功能的場景。

---

## 使用者輸入

$ARGUMENTS

提供規格書路徑，或直接描述要開發的功能範圍。

---

## 可用工具

### 專案結構與程式碼

| 工具 | 用途 |
| ---- | ---- |
| `list_files` / `list_files_batch` | 掃描專案目錄、確認模組結構 |
| `get_folder_contents` | 取得完整目錄樹狀結構 |
| `read_file` / `read_files_batch` | 讀取規格書、現有模組程式碼、設定檔 |
| `create_file` | 建立新模組檔案（Controller / Model / View） |
| `apply_diff` | 對既有檔案進行局部修改 |

### 資料庫

| 工具 | 用途 |
| ---- | ---- |
| `get_db_schema` / `get_db_schema_batch` | 確認資料表欄位與外鍵關係 |
| `execute_sql` / `execute_sql_batch` | 驗證資料寫入、查詢測試資料 |

### 驗證

| 工具 | 用途 |
| ---- | ---- |
| `run_php_script` | 語法驗證（`php -l`）、執行測試腳本 |
| `run_php_test` | 執行整合測試 |
| `send_http_request` | 驗證 API 端點回應 |
| `tail_log` | 查看 PHP error log |

### 文件規格書（依格式選用）

| 工具 | 用途 |
| ---- | ---- |
| `read_word_file` / `read_word_files_batch` | 讀取 .docx 規格書 |
| `read_pdf_file` / `read_pdf_files_batch` | 讀取 PDF 規格書 |

---

## 執行步驟

### 步驟 0：確認 DDD 架構規範

開始前輸出本模組的架構規範，確認與使用者對齊：

#### 分層目錄結構（Clean Architecture 四層）

```text
{ModuleName}/
├── Domain/              ← 業務規則（最內層，無外部依賴）
│   ├── Entity/          ← 業務物件（Order.php）
│   ├── ValueObject/     ← 值物件（Money.php）
│   └── DomainService/   ← 純業務邏輯（無 DB 依賴）
├── Application/         ← 用例協調層
│   ├── UseCase/         ← 一個動作一個 UseCase（CreateOrder.php）
│   └── DTO/             ← 輸入/輸出邊界
├── Infrastructure/      ← 外部依賴實作
│   ├── Repository/      ← DB 操作（實作 Domain Interface）
│   └── ExternalApi/     ← 第三方 API
└── Presentation/        ← 對外接口（最外層）
    ├── Controller/      ← HTTP 請求處理（薄層）
    └── Request/         ← 輸入驗證
```

依賴方向（單向）：Presentation → Application → Domain
Infrastructure 反向依賴 Domain 定義的 Interface（依賴反轉原則）。

#### 命名規範

| 用途 | 好的命名 | 避免 |
|------|----------|------|
| 資料存取 | `OrderRepository` | `OrderDAO.php` |
| 業務用例 | `CreateOrder`, `CancelOrder` | `OrderService.php`（太模糊） |
| 計算邏輯 | `OrderCalculator` | `utils.php` |

避免通用目錄：`utils/`、`helpers/`、`misc/`、`common/`

#### 程式碼品質規則

| 規則 | 門檻 |
|------|------|
| 函式過長 | ≤ 50 行 |
| 類別過長 | ≤ 200 行 |
| 巢狀深度 | ≤ 3 層 |
| 邏輯重複 | 出現 2 次即提取 |

使用 Early Return 減少巢狀；開發前先 `composer search` 確認是否有現成套件。

> 確認規範後，詢問使用者：「架構規範確認，開始載入規格書？」

---

### 步驟 1：載入規格書與建立任務清單

讀取規格書或需求說明：

```text
Read {spec_path}
→ 解析：需要建立的資料表、功能模組、相依關係
→ 詢問使用者確認任務範圍
```

以 TodoWrite 建立完整任務清單，**每個任務必須是「可 demo 的變化」**：

**任務粒度原則（Demo-able Change）**：
- 每個任務完成後，使用者必須能在**瀏覽器或終端機**中看到一個具體變化
- 「寫完一個 PHP class」❌ → 「後台商品列表頁能顯示資料」✅
- 「建立 Repository」❌ → 「新增商品後 DB 有記錄且列表頁出現」✅
- 「完成 API 端點」❌ → 「前台點擊加入購物車後，購物車數字 +1」✅

**拆分檢驗**：每寫完一個任務的描述，問自己「使用者怎麼 demo 這個？」 — 如果答不出來，任務太底層，需要合併到能 demo 的粒度。

**任務排序按使用者旅程（垂直貫穿）而非技術層（水平切片）**：

1. 第一個可 demo 的端到端切片（DB + 後端 + 前端最小可用）
2. 逐步加粗：增加欄位、增加驗證、增加 UI 細節
3. 邊緣情境：錯誤處理、權限控制、特殊狀態

> 每個任務內部仍然按技術層順序執行（DB → Model → Controller → View），但任務的**定義**以使用者可見的變化為單位。

---

### 步驟 2：判斷執行模式

**循序模式**（預設，任務有前後相依時）

- 使用時機：DB → Model → Controller → Test 這類有順序的任務
- 做法：完成一個 → 審查通過 → 才進下一個

**並行模式**（任務彼此獨立時）

- 使用時機：會員模組和訂單模組沒有相互依賴
- 做法：一次派遣最多 3 個獨立 SubAgent 並行

> 並行模式注意：**實作類 SubAgent 禁止修改相同檔案**，調查/分析類 SubAgent 可以並行。

---

### 步驟 3：循序執行 — 逐任務完成

針對 TodoWrite 中每個任務，依序執行：

**3a. 派遣實作 SubAgent**

```text
Agent (subagent_type=general-purpose):
  任務：{具體任務，如「建立 orders 資料表遷移 SQL」}
  規格參考：{spec 中對應的章節或欄位清單}
  輸出目標：{預期檔案路徑}
  約束條件：
    - 只修改指定範圍，不重構無關程式碼
    - 遇到障礙立即停止回報，不要猜測繼續
    - 遵循 DDD 分層（Domain → Application → Infrastructure）
```

**3b. 派遣審查 SubAgent**

```text
Agent (subagent_type=general-purpose):
  角色：程式碼審查員
  審查範圍：{上一步修改的檔案}
  檢查項目：
    - 是否符合規格需求（對照 spec 確認欄位/邏輯）
    - Clean Architecture 分層是否正確
    - 有無明顯 Bug 或 SQL Injection / XSS 安全問題
    - 函式 ≤ 50 行，類別 ≤ 200 行，巢狀 ≤ 3 層
```

**3c. 處理審查結果**

| 問題等級 | 處理方式 |
|---------|---------|
| 重大（Bug / 功能缺失 / 安全問題） | 立即修正後重新審查 |
| 一般（命名 / 格式 / 小優化） | 記錄，批次處理 |
| 通過 | 標記 TodoWrite 完成，進入下一任務 |

---

### 步驟 4：並行執行 — 獨立模組同步開發

每批次最多 3 個獨立任務同時派遣：

**4a. 確認獨立性**：各任務不修改相同檔案，無相互依賴

**4b. 並行派遣**：在同一訊息中發出多個 Agent tool calls

**4c. 整合審查**：全部完成後統一審查，確認無衝突（同一欄位被兩個模組定義等）

---

### 步驟 5：最終審查與完成報告

所有任務完成後：

1. 執行整體程式碼審查（參考 `/clean_arch` 規範）
2. 確認 DB 遷移與功能模組資料一致
3. 建議下一步行動

```text
✅ SADD 開發完成！

📊 統計：
  任務數：N 個（循序 N 個 ／ 並行 N 個）
  審查發現問題：N 項（已修正 N 項 ／ 記錄 N 項）

📝 完成的功能：
  - {功能 1}（DB 遷移 + Repository + Controller）
  - {功能 2}（UseCase + API 端點）

📁 新增/修改的檔案：
  - {file_path_1}
  - {file_path_2}

⚠️ 需人工確認：
  - （若有）未自動修正的問題或遺留的技術債

🔜 建議下一步：
  - /tdd 補充單元測試
  - /sftp_deploy 部署至測試機
```

---

## 輸出

- 完整功能模組（DB 遷移 + 業務邏輯 + Controller）
- 每個任務的審查記錄與問題清單
- 建議後續步驟（測試、部署）

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| SubAgent 修改超出範圍 | Prompt 太模糊 | 給 SubAgent 具體的「只修改 X 檔案」指令 |
| 並行 SubAgent 互相衝突 | 任務有隱性依賴 | 改為循序執行 |
| 審查被跳過 | 急於進入下一任務 | SADD 核心規則：每任務完成必審查 |
| SubAgent 遇障礙繼續猜測 | Prompt 未明確限制 | 明確寫「遇到障礙停止並回報」 |
| DB 欄位與程式碼不一致 | 各 SubAgent 沒有共享 spec | 每個 SubAgent Prompt 都附上相關 spec 章節 |

---

## 注意事項

- 每個 SubAgent 都是「全新上下文」，Prompt 中必須附上完整背景（規格章節、相依檔案路徑）
- DB 遷移任務必須在所有功能模組之前完成
- 遇到規格不清晰時，停止並詢問使用者，不要讓 SubAgent 自行猜測
- DDD 架構規範已內建於步驟 0，無需另外執行 `/ddd`
- 搭配 `/tdd` 使用：SADD 完成後補充單元測試
- 搭配 `/clean_arch` 使用：最終整體架構審查
