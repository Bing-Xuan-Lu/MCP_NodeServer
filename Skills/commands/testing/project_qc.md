---
name: project_qc
description: |
  模擬專案管理師執行全站品質稽核，以雙 Agent 協作架構（UI/UX 稽核員 + 邏輯稽核員）對 PHP 專案進行並行測試，產出網站校稿單。涵蓋：UI 設計稿比對（顏色/排版偏差 = NG）、規格書功能符合度、端對端業務流程含測試矩陣（前台操作 → 後台驗證遞棒）、RWD 響應式、後台邏輯整合。
  當使用者說「全站 QC」「網站校稿」「品保測試」「模擬 PM 測試」「產出校稿單」「系統整合測試」「做驗收」時使用。
---

# /project_qc — 雙 Agent 全站品質稽核並產出網站校稿單

你是 **QC 總指揮**，負責派遣並協調兩位專職測試員，對 PHP 網站進行全方位稽核。

## 工具主權劃分（防衝突設計）

**UI/UX 稽核員（Playwright 獨佔）**
工具：Playwright MCP、`create_file`
職責：所有頁面的視覺稽核（前台購物頁＋後台管理介面皆包含）、UI 行為、RWD、E2E 操作

**邏輯稽核員（MCP 工具，完全不用 Playwright）**
工具：`run_php_test`、`execute_sql`、`execute_sql_batch`、`send_http_request`、`send_http_requests_batch`、`get_db_schema_batch`、`read_files_batch`、`create_file`
職責：邏輯測試、DB 驗證、規格書文字比對

> Playwright 不共用：UI/UX 稽核員獨佔瀏覽器 session，邏輯稽核員所有工作透過 MCP 工具完成，兩者不衝突。

**QC 判斷標準（不可降級）**：

- 顏色/字型/排版與設計稿不符 → **NG**（零容忍，非「小問題」）
- 規格書描述的功能缺失或行為偏差 → **NG**
- 前台操作後 DB 數值不正確 → **NG**
- 業務流程中斷（無法下單、後台未收到訂單等）→ **NG**

---

## 使用者輸入

$ARGUMENTS

- `re-check`（可選）— 只複驗上次校稿單的 NG 項目（版次遞增）
- `[模組名稱]`（可選）— 只針對特定模組稽核

---

## 需要的資訊

若使用者未提供以下資訊，請主動詢問：

| 參數 | 說明 | 預設值 | 範例 |
|------|------|--------|------|
| 測試網址 | 前台/後台基底 URL | — | `http://localhost/{ProjectFolder}/` |
| 專案目錄 | PHP 程式目錄（MCP basePath 相對） | — | `{ProjectFolder}` |
| 設計稿路徑 | 設計稿圖檔（PNG/JPG/PDF）目錄 | 無（跳過視覺比對） | `D:\Design\{project}\` |
| 規格書來源 | AxShare URL 或本地快照路徑 | 無（跳過規格比對） | `reports/spec_index.md` |
| 測試模組 | 要測試的模組清單（留空 = 全站） | 全站 | `商品管理, 訂單管理` |
| 業務流程 | 要測試的端對端流程 | 自動偵測 | `購物流程, 退貨流程` |
| 輸出格式 | 校稿單格式 | `md` | `md` / `html` |

---

## 執行步驟

### 步驟 0：稽核前置確認

收集「需要的資訊」後，展示計畫：

```text
=== QC 稽核計畫確認 ===

測試對象：{測試網址}
測試模組：{模組清單 或 "全站"}
業務流程：{流程清單}
設計比對：{有/無}　規格比對：{有/無}
輸出格式：{md/html}

── 並行階段（前後台同時出發，Playwright 歸前台獨用）──
UI/UX 稽核員  Phase B  UI 行為測試（Smoke + CRUD + 截圖）
           Phase C  設計稿視覺比對 + 規格書截圖比對
           Phase F  RWD 三斷點掃描

邏輯稽核員  Phase A  PHP CRUD 邏輯整合測試（無 Playwright）
           Phase D  規格書功能文字比對（讀 spec_index.md）

── 順序階段（遞棒協作）────────────────────────────
Phase E-0  UI/UX 稽核員爬站建測試矩陣 → 使用者確認
Phase E    業務流程端對端遞棒測試

── 最終彙整 ──────────────────────────────────────
Phase G    產出 reports/{project}_校稿單_{日期}.md

確認後開始？
```

> 等使用者確認後繼續。

---

### 步驟 1：並行派遣兩位測試員

確認後，**同時啟動**兩個 Agent（`run_in_background: true`）。

---

**UI/UX 稽核員 Prompt（傳給 Agent 1）**：

```text
你是前台視覺測試員，Playwright 是你的獨佔工具，邏輯稽核員不會使用它，請放心操作。

專案資訊：
- 測試網址：{測試網址}
- 測試模組：{模組清單}
- 設計稿路徑：{設計稿路徑 或 "無"}
- 規格書快照：{規格書來源 或 "無"}

[Phase B] UI 行為測試
1. browser_navigate 各模組頁面，截圖初始狀態
2. 偵測 PHP 錯誤（500/Notice/Warning）、JS 錯誤
3. 執行 CRUD 表單操作，截圖每個步驟
4. 功能無法執行、報錯 → 標記 NG

[Phase C] 視覺比對（若無設計稿且無規格書則跳過）
設計稿比對：對每頁截圖（Desktop 1440px），逐項比對：
  - 主色/輔色（偏差 > ±5% = NG）
  - 排版結構、Column 位置、間距
  - 按鈕/標籤/Badge 樣式
  - 表格欄位順序與寬度
  - 文字字型與大小
規格書截圖比對：截取規格書頁面 vs 實作頁面並排

[Phase F] RWD 三斷點掃描
375px、768px、1440px 各截圖，偵測溢出/截斷/重疊 → 標記 NG

完成後將結果寫入 reports/uiux_qc.md。
```

---

**邏輯稽核員 Prompt（傳給 Agent 2）**：

```text
你是後台邏輯測試員，你完全不使用 Playwright，所有測試透過 MCP 工具完成。

專案資訊：
- 測試網址：{測試網址}
- 專案目錄：{專案目錄}
- 規格書快照：{規格書來源 或 "無"}
- 測試模組：{模組清單}

[Phase A] PHP CRUD 邏輯整合測試
針對每個模組：
1. run_php_test → 新增、讀取、更新、刪除
2. execute_sql → 驗 DB 狀態（SELECT only，禁止修改 DB）
3. send_http_request → 驗 API 回傳值與 HTTP 狀態碼
記錄 PASS/FAIL 與錯誤訊息

[Phase D] 規格書功能文字比對（若無規格書則跳過）
直接讀取 spec_index.md（不開瀏覽器）：
1. read_files_batch 讀取規格書快照
2. 逐模組比對功能清單：欄位、按鈕、流程說明
3. 找出規格有但網站無、行為不符、文字不一致
所有偏差 = NG

完成後將結果寫入 reports/logic_qc.md。
```

---

### 步驟 2：等待兩位測試員完成

等待 `reports/uiux_qc.md` 與 `reports/logic_qc.md` 都生成後繼續。

---

### 步驟 3（Phase E-0）：UI/UX 稽核員建立業務流程測試矩陣

> **解決組合爆炸問題：先發現維度，再規劃代表性案例，不窮舉**

派遣UI/UX 稽核員（使用 Playwright）探索網站，產出測試矩陣：

```text
UI/UX 稽核員探索任務：
  1. 爬取商品/服務頁面，發現組合維度：
     - 規格維度（顏色/尺寸/款式/材質...）
     - 數量邊界（最小購買量、庫存上限）
     - 可用優惠類型（折扣碼/紅利點數/滿額折/限時活動...）
     - 付款方式（信用卡/ATM/超商...）
     - 特殊條件（會員等級/地區限制/商品組合...）
  2. 用等價分割法與邊界值分析，選出代表性案例：
     每個維度取「正常值 + 邊界值 + 異常值」各 1 個
     不同維度的組合取最高風險的前 N 組（N ≤ 10）

矩陣範例（電商）：
  案例 | 商品規格 | 數量 | 優惠 | 付款 | 驗證重點
  T01  | 單規格   | 1    | 無   | 信用卡 | 基本流程
  T02  | 多規格   | 最大量 | 無  | ATM  | 庫存上限 + 規格對應
  T03  | 任意     | 1    | 折扣碼+點數疊加 | 任意 | 金額計算
  T04  | 任意     | 1    | 過期優惠碼 | 任意 | 異常阻擋
  T05  | 庫存=0   | 1    | 無   | 任意 | 無法下單提示
  ...（依實際維度調整）

輸出 reports/test_matrix.md，請使用者確認矩陣後繼續。
```

> **展示矩陣並等使用者確認**（可新增/刪除/修改案例）後繼續 Phase E。

---

### 步驟 4（Phase E）：業務流程端對端遞棒測試

依確認後的測試矩陣，每個案例執行遞棒協議：

**遞棒協議**：

```text
UI/UX 稽核員（Playwright）：
  依矩陣案例執行使用者操作（下單/申請/送出表單）
  截圖每個關鍵節點
  操作完成後建立 reports/handoff.json：
  {
    "case": "T03",
    "flow": "購物流程",
    "action": "前台下單完成",
    "payload": {
      "order_id": "前台顯示的訂單編號",
      "expected_amount": 計算值,
      "product_id": ...,
      "sku_id": ...,
      "quantity": ...,
      "discount_applied": "折扣碼名稱或點數金額"
    }
  }

邏輯稽核員（讀取 handoff.json，不開瀏覽器）：
  execute_sql → 驗 DB 對應資料：
    - 訂單是否存在（orders 表）
    - 金額是否與 expected_amount 一致
    - 庫存是否正確扣減
    - 優惠/點數是否正確計算
    - 後台管理頁面可用 send_http_request 驗 API 回傳
  結果追加至 reports/e2e_results.md
```

依序執行所有矩陣案例（T01 → T02 → ... → TN），每個案例完成後再跑下一個。

---

### 步驟 4.5（Phase E-special）：特殊功能測試前置確認

> 若業務流程涉及**發信**或**支付**，在進入 Phase E 前需先完成以下前置確認，否則自動跳過該部分。

#### 發信功能測試前置

在步驟 0 詢問資訊時加問：

```text
是否有發信功能需要測試？（如：下單確認信、密碼重設信）
若有，請確認以下任一條件已滿足：
  1. 已設定測試 SMTP（如 Mailtrap、MailHog），請提供 SMTP Inbox 查看方式
  2. 系統有 mail_log 資料表記錄寄信（提供表名）
  3. 可接受僅驗證「觸發點正常、無 PHP 錯誤」，不驗收信件內容
```

發信測試策略（依可用方式選擇）：

| 方式 | 驗證方法 |
| ---- | -------- |
| Mailtrap/MailHog | `send_http_request` GET Mailtrap API 取得收件箱；或 Playwright 開 MailHog Web UI 截圖 |
| mail_log 資料表 | `execute_sql` SELECT 最新一筆，比對 to/subject/status |
| 僅驗觸發點 | `tail_log` 確認無 PHP Fatal，HTTP 狀態碼 200，無 JS 錯誤 |

handoff.json 補充欄位：

```text
"email": {
  "expected_to": "buyer@example.com",
  "expected_subject": "訂單確認",
  "verify_method": "mail_log | mailtrap | trigger_only"
}
```

---

#### 支付功能測試前置

在步驟 0 詢問資訊時加問：

```text
是否有支付功能需要測試？
若有，請工程師先完成以下設定，完成後告知再繼續：

  □ 支付閘道已切換為「沙盒/測試模式」（Sandbox Key）
  □ Webhook callback URL 已設定為測試環境網址
  □ 測試信用卡號已備妥（各家閘道的測試卡號）
  □ 若需等待 callback，請告知最長等待時間（秒）
```

> 工程師確認設定完畢前，支付流程測試暫緩，其他 Phase 照常執行。

**支付測試策略**：

```text
UI/UX 稽核員：
  1. 選測試商品，操作結帳頁至付款確認
  2. 輸入測試卡號，截圖付款畫面
  3. 送出後等待跳轉（最長等待時間 = 工程師指定秒數）
  4. 截圖付款結果頁（成功/失敗）
  5. 寫入 handoff.json：order_id + payment_status（前台顯示值）

邏輯稽核員（收到 handoff.json 後）：
  execute_sql：
    - 驗 orders.payment_status 是否更新
    - 驗 payment_logs 最新一筆 callback 原始資料（若有此表）
    - 驗庫存是否扣減（若支付後才扣）
```

**Webhook Callback 等待機制**：

```text
若支付需等 callback 才更新 DB：
  1. UI/UX 稽核員付款後，先截圖「付款中/等待確認」頁面
  2. 邏輯稽核員輪詢 DB（每 5 秒 execute_sql 查 payment_status，最多等 60 秒）
  3. 60 秒內 callback 未到達 → 標記 [PENDING]，通知使用者確認 Webhook 設定
  4. Callback 到達後 → 補跑驗證，更新 handoff.json 與 e2e_results.md
```

---

### 步驟 5（Phase G）：彙整產出網站校稿單

讀取 `uiux_qc.md`、`logic_qc.md`、`test_matrix.md`、`e2e_results.md`，
合併輸出至 `reports/{project}_校稿單_{YYYY-MM-DD}.md`：

```markdown
# {ProjectName} 網站校稿單

**稽核日期**：{日期}　**版次**：v1
**UI/UX 稽核員**：UI/UX Agent（Playwright 獨佔）
**邏輯稽核員**：Logic Agent（MCP 工具）

## 整體結論

| 項目 | 負責人 | 結果 | NG 數量 |
|------|--------|------|---------|
| A 後台邏輯 | 邏輯稽核員 | PASS/FAIL | N |
| B UI 行為 | UI/UX 稽核員 | PASS/FAIL | N |
| C 視覺比對 | UI/UX 稽核員 | PASS/FAIL | N |
| D 規格書比對 | 邏輯稽核員 | PASS/FAIL | N |
| E 業務流程（N 個案例） | 雙操作員 | PASS/FAIL | N |
| F RWD | UI/UX 稽核員 | PASS/FAIL | N |
| **總計** | — | **PASS/FAIL** | **N** |

> ⚠️ 所有 NG 修正後，執行 `/project_qc re-check` 進行複驗

---

## Phase A — 後台邏輯

| 模組 | 操作 | 結果 | 問題描述 |
|------|------|------|---------|

## Phase B — UI 行為

| 模組 | 頁面 | 結果 | 問題描述 | 截圖路徑 |
|------|------|------|---------|---------|

## Phase C — 視覺比對

| 頁面 | 差異項目 | 設計稿值 | 實際值 | NG |
|------|---------|---------|-------|-----|

## Phase D — 規格書比對

| 模組 | 規格書描述 | 實際行為 | NG |
|------|-----------|---------|-----|

## Phase E — 業務流程測試矩陣結果

| 案例 | 流程 | 測試條件 | 前台結果 | 後台 DB 驗證 | NG |
|------|------|---------|---------|------------|-----|

## Phase F — RWD

| 頁面 | 斷點 | 問題 |
|------|------|------|

---

## NG 修正清單

- [ ] [A-01] 後台：（說明 + 檔案:行號）
- [ ] [C-01] 前台：（說明 + 截圖路徑）
- [ ] [E-T03] 遞棒：（流程 + DB 查詢結果）
```

---

### 步驟 6：迭代複驗（re-check 模式）

當輸入 `/project_qc re-check` 或 `/project_qc [模組名稱]`：

```text
讀取最新版校稿單，找出所有未勾選（NG）的項目
→ 依 Phase 分配給對應操作員重跑：
  UI/UX 稽核員：重跑 B/C/F 中仍 NG 的模組（Playwright）
  邏輯稽核員：重跑 A/D 中仍 NG 的模組（MCP 工具）
  遞棒流程：重跑 E 中仍 NG 的矩陣案例
→ 對比前次結果，標記「已修正 ✅」或「仍 NG ❌」
→ 輸出更新校稿單（版次遞增：v1 → v2）
```

---

## 輸出

- `reports/test_matrix.md` — 業務流程測試矩陣（使用者確認後執行）
- `reports/uiux_qc.md` — UI/UX 稽核員原始報告
- `reports/logic_qc.md` — 邏輯稽核員原始報告
- `reports/e2e_results.md` — 遞棒業務流程測試結果
- `reports/{project}_校稿單_{YYYY-MM-DD}.md` — 最終彙整校稿單
- `reports/screenshots/` — 所有 NG 截圖（UI/UX 稽核員產出）

---

## 注意事項

- **Playwright 獨佔**：UI/UX 稽核員是唯一使用 Playwright 的 Agent，邏輯稽核員不碰瀏覽器，兩者完全無衝突
- Phase D 規格比對：邏輯稽核員讀 spec_index.md 文字比對，不需截圖（截圖比對由UI/UX 稽核員在 Phase C 完成）
- **測試矩陣（E-0）必須使用者確認後才執行 Phase E**，避免跑不必要的組合
- 矩陣案例數量建議 ≤ 10 個，用等價分割法取代窮舉
- 遞棒協議：前台寫 `handoff.json`，後台讀取後驗 DB，禁止跨越職責範圍
- 業務流程測試前確認使用**測試環境**，避免污染正式資料
- DB 驗證只用 SELECT，QC 過程禁止修改 DB
- re-check 模式只測 NG 項目，不重跑已 PASS 的模組
