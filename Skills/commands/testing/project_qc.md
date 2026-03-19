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

── Phase A0（邏輯稽核員先行）────────────────────────
邏輯稽核員  Phase A0  Schema-Driven 欄位映射 → 產出 field_map.md

── 並行階段（A0 完成後，前後台同時出發）──────────────
UI/UX 稽核員  Phase B  全站互動探索(B0) + 全欄位驗證(B1-B3)
           Phase C  設計稿視覺比對 + 規格書截圖比對
           Phase F  RWD 三斷點掃描

邏輯稽核員  Phase A  全欄位 CRUD 邏輯測試（依 field_map 逐欄位）
           Phase D  規格書功能文字比對（讀 spec_index.md）

── 順序階段（遞棒協作）────────────────────────────
Phase E-0  UI/UX 稽核員爬站建測試矩陣 → 使用者確認
Phase E    業務流程端對端遞棒測試（含商品組合/圖片/影片/支付/會員/訂單）

── 最終彙整 ──────────────────────────────────────
Phase G    產出 reports/{project}_校稿單_{日期}.md

確認後開始？
```

> 等使用者確認後繼續。

---

### 步驟 1：先跑 Phase A0，再並行派遣

**Phase A0 必須先完成**（後續所有測試依賴 field_map.md）：
1. 派邏輯稽核員執行 Phase A0（Schema 映射）
2. 等 `reports/field_map.md` 產出
3. 再同時啟動兩個 Agent 並行（`run_in_background: true`）

---

**UI/UX 稽核員 Prompt（傳給 Agent 1）**：

```text
你是前台視覺測試員，Playwright 是你的獨佔工具，邏輯稽核員不會使用它，請放心操作。

專案資訊：
- 測試網址：{測試網址}
- 測試模組：{模組清單}
- 設計稿路徑：{設計稿路徑 或 "無"}
- 規格書快照：{規格書來源 或 "無"}

[Phase B] 全站互動探索 + 全欄位前台驗證
等邏輯稽核員產出 reports/field_map.md 後再開始（確保有欄位映射依據）。

B0. 全站互動元素探索（每個頁面都做）
  對前台和後台的每一個頁面，執行完整互動掃描：

  a. 頁面進入後截圖初始狀態
  b. browser_evaluate 蒐集頁面所有互動元素：
     ```js
     // 可點擊元素
     document.querySelectorAll('a, button, [onclick], [role="button"], input[type="submit"], .btn, [data-toggle], [data-bs-toggle]')
     // 表單元素
     document.querySelectorAll('input, select, textarea, [contenteditable]')
     // 滑動/展開元素
     document.querySelectorAll('[data-toggle="collapse"], .accordion, .carousel, .slider, .swiper, .tab-pane, .nav-tabs a, .owl-carousel')
     // Hover 效果元素
     document.querySelectorAll('[class*="hover"], [class*="dropdown"], .mega-menu, nav li')
     // POPUP / Modal 觸發器
     document.querySelectorAll('[data-toggle="modal"], [data-bs-toggle="modal"], [class*="popup"], [class*="lightbox"], .fancybox')
     ```
  c. 產出互動元素清單並逐一測試：

  **點擊測試**：
  - 每個連結 <a> → 點擊 → 驗目標頁面載入（非 404/500）→ 返回
  - 每個按鈕 → 點擊 → 截圖結果（是否有反應、是否報錯）
  - 下拉選單 → 點擊 → 驗展開 → 點每個選項
  - Modal 觸發 → 點擊 → 驗 Modal 開啟 → 截圖 → 關閉

  **⚠️ 動態渲染連結驗證（踩坑規則）**：
  - `a[href]` 選擇器會漏掉 Vue (`v-bind:href`) / React 等框架動態渲染的連結
  - 必須先**觸發展開** dropdown / mega menu / POPUP，等 DOM 更新後再蒐集連結
  - 展開後掃描 `a:not([href])` → 若存在 = **NG**（連結缺 href，點擊無反應）
  - 展開後逐一點擊內部連結 → 驗是否成功導航到目標頁面
  - Mega Menu 的每個 Tab/Panel 都要切換並測試（不只測 active panel）

  **表單互動測試**：
  - 每個 input → 輸入測試值 → 驗是否有即時驗證/格式提示
  - 每個 select → 展開 → 驗選項數量 → 選擇每個選項
  - 每個 textarea → 輸入 → 驗字數限制提示
  - 搜尋框 → 輸入關鍵字 → 驗搜尋結果/自動完成

  **滑動/輪播測試**：
  - Carousel/Slider → 點左右箭頭 → 驗切換 → 截圖每張
  - Tab → 點每個 Tab → 驗內容切換
  - Accordion → 逐一展開 → 驗內容顯示

  **Hover 測試**：
  - 導覽選單 hover → 驗子選單展開
  - 商品卡片 hover → 驗快速預覽/按鈕出現
  - 圖片 hover → 驗放大/overlay 效果

  **POPUP/Lightbox 測試**：
  - 圖片點擊 → 驗 Lightbox 開啟 → 可左右切換 → 關閉
  - 影片縮圖點擊 → 驗影片播放器開啟
  - 通知/Cookie 同意 → 驗出現時機 → 點關閉

  **捲動測試**：
  - 頁面捲到底 → 驗 lazy-load 圖片載入
  - 固定導覽列 → 捲動後是否 sticky
  - 回到頂部按鈕 → 捲動後出現 → 點擊 → 回頂

  記錄格式：
  | 頁面 | 元素 | 互動類型 | 預期行為 | 實際結果 | 截圖 |

  無反應、報錯、404、JS error → 標記 NG

B1. 後台全欄位表單測試
  依 field_map 逐模組操作後台 add.php：
  - 每個表單欄位填入測試值（含邊界：空值/超長/特殊字元）
  - file input：用 browser_evaluate 注入 File 物件或用 browser_fill_form
  - 截圖已填好的完整表單 → 送出
  - 截圖結果頁（成功/錯誤提示）
  - list.php 確認新資料出現在列表中，截圖

B2. 前台資料對應驗證（核心：後台新增 → 前台看得到）
  後台新增一筆完整測試資料後，到前台驗證每個欄位：
  - text 欄位：browser_snapshot 比對文字值是否與後台輸入一致
  - param 欄位：
    * 價格 → 前台顯示金額一致（含千分位/幣值符號格式）
    * 狀態=上架 → 前台可見；狀態=下架 → 前台不可見
    * 排序 → 前台列表順序符合
    * 庫存=0 → 前台顯示「缺貨」或禁止加購
  - file 欄位：browser_evaluate 檢查 <img> src 有值且圖片載入成功
    （檢查 naturalWidth > 0，若為 0 = 圖片 broken → NG）
  - media 欄位：browser_evaluate 檢查 <video>/<iframe> 元素存在且 src 有效
  - relation 欄位：前台分類/標籤是否正確顯示

B3. 參數變更傳播測試（後台改 → 前台即時反映）
  依 reports/param_test_plan.md（邏輯稽核員產出）逐一測試：
  1. 在後台 update.php 修改參數值（如改價格 100→200）
  2. 到前台同一頁面重新載入
  3. 驗證前台顯示已更新（截圖標記差異）
  4. 若未更新 → NG（可能有快取問題）

  必測參數（若模組有的話）：
  - 價格/金額 → 前台售價
  - 上架狀態 → 前台顯隱
  - 排序值 → 前台列表順序
  - 庫存數量 → 前台庫存顯示/可購買狀態
  - 縮圖/主圖 → 前台圖片更新
  - 標題/描述 → 前台文字更新

[Phase C] 視覺比對（若無設計稿且無規格書則跳過）
設計稿比對：對每頁截圖（Desktop），逐項比對：
  - 主色/輔色（偏差 > ±5% = NG）
  - 排版結構、Column 位置、間距
  - 按鈕/標籤/Badge 樣式
  - 表格欄位順序與寬度
  - 文字字型與大小
規格書截圖比對：截取規格書頁面 vs 實作頁面並排

[Phase F] RWD 三斷點掃描
依專案規格書定義的斷點截圖，偵測溢出/截斷/重疊 → 標記 NG

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

[Phase A0] Schema-Driven 欄位映射（最優先）
為每個模組建立完整欄位映射表，後續所有測試以此為依據：

1. get_db_schema_batch → 讀取所有相關資料表的欄位定義
2. read_files_batch → 讀取後台 add.php / update.php / list.php 原始碼
3. 產出 reports/field_map.md，格式如下：

  ## {模組名稱}（{table_name}）

  | # | DB 欄位 | 類型 | 後台表單 | 後台列表 | 前台顯示 | 欄位分類 |
  |---|--------|------|---------|---------|---------|---------|
  | 1 | title  | VARCHAR(200) | ✅ add/update input | ✅ list 第2欄 | ✅ 商品標題 | text |
  | 2 | price  | DECIMAL(10,2) | ✅ add/update input | ✅ list 第3欄 | ✅ 售價 | param |
  | 3 | image  | VARCHAR(500) | ✅ file input | ❌ | ✅ 商品圖 | file |
  | 4 | video_url | VARCHAR(500) | ✅ input | ❌ | ✅ 影片 | media |
  | 5 | status | TINYINT | ✅ select | ✅ 狀態欄 | ⚠️ 影響顯隱 | param |
  | 6 | sort_order | INT | ✅ input | ❌ | ⚠️ 影響排序 | param |

  欄位分類規則：
  - text：純文字/數值，後台輸入→前台顯示
  - param：影響前台行為的參數（價格/狀態/排序/庫存/上架開關）
  - file：圖片/文件上傳（VARCHAR 存路徑）
  - media：影片/音訊（URL 或嵌入碼）
  - relation：外鍵/關聯（如 category_id）
  - system：系統欄位（add_time/edit_time/add_ip），不需測試

  覆蓋率統計：
  - DB 欄位總數（排除 system）：N
  - 後台可操作欄位數：N
  - 前台可見欄位數：N
  - 未覆蓋欄位：列出

[Phase A] 全欄位 CRUD 邏輯測試（依 field_map 逐欄位）
針對 field_map 中每個非 system 欄位：

1. 文字欄位（text）：
   - send_http_request POST → 新增（含邊界值：空字串/最大長度/特殊字元）
   - execute_sql → 驗 DB 值完全一致
   - send_http_request POST → 更新為不同值
   - execute_sql → 驗 DB 已更新

2. 檔案欄位（file）：
   - send_http_request POST multipart/form-data → 上傳測試圖片
   - execute_sql → 驗 DB 存的路徑非空
   - send_http_request GET → 驗該路徑可存取（HTTP 200）
   - 重複上傳 → 驗舊檔是否被覆蓋或保留

3. 媒體欄位（media）：
   - send_http_request POST → 填入測試 URL
   - execute_sql → 驗 DB 值
   - （前台驗證交給 UI/UX 稽核員）

4. 參數欄位（param）：
   - 記錄到 reports/param_test_plan.md，Phase E-param 再驗前台效果

5. 關聯欄位（relation）：
   - execute_sql → 驗外鍵指向的目標存在
   - 測試指向不存在 ID 時的行為

記錄格式（逐欄位）：
  | 模組 | 欄位 | 操作 | 輸入值 | DB 值 | 結果 |

[Phase D] 規格書功能文字比對（若無規格書則跳過）
直接讀取 spec_index.md（不開瀏覽器）：
1. read_files_batch 讀取規格書快照
2. 比對 field_map 中每個欄位：規格書有定義但 DB/後台缺少 → NG
3. 找出行為不符、文字不一致
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

讀取 `field_map.md`、`uiux_qc.md`、`logic_qc.md`、`test_matrix.md`、`e2e_results.md`，
合併輸出至 `reports/{project}_校稿單_{YYYY-MM-DD}.md`：

```markdown
# {ProjectName} 網站校稿單

**稽核日期**：{日期}　**版次**：v1
**UI/UX 稽核員**：UI/UX Agent（Playwright 獨佔）
**邏輯稽核員**：Logic Agent（MCP 工具）

## 整體結論

| 項目 | 負責人 | 結果 | NG 數量 |
|------|--------|------|---------|
| A0 欄位映射覆蓋率 | 邏輯稽核員 | {N}% | — |
| A 全欄位 CRUD | 邏輯稽核員 | PASS/FAIL | N |
| B0 全站互動探索 | UI/UX 稽核員 | PASS/FAIL | N |
| B1 後台表單 | UI/UX 稽核員 | PASS/FAIL | N |
| B2 後台→前台對應 | UI/UX 稽核員 | PASS/FAIL | N |
| B3 參數傳播 | UI/UX 稽核員 | PASS/FAIL | N |
| C 視覺比對 | UI/UX 稽核員 | PASS/FAIL | N |
| D 規格書比對 | 邏輯稽核員 | PASS/FAIL | N |
| E 業務流程（N 案例） | 雙操作員 | PASS/FAIL | N |
| F RWD | UI/UX 稽核員 | PASS/FAIL | N |
| **總計** | — | **PASS/FAIL** | **N** |

> ⚠️ 所有 NG 修正後，執行 `/project_qc re-check` 進行複驗

---

## Phase A0 — 欄位映射覆蓋率

| 模組 | DB 欄位 | 後台可操作 | 前台可見 | 未覆蓋 | 覆蓋率 |
|------|--------|-----------|---------|-------|--------|

## Phase A — 全欄位 CRUD

| 模組 | 欄位 | 類型 | 新增 | 讀取 | 更新 | 刪除 | 結果 |
|------|------|------|:----:|:----:|:----:|:----:|------|

## Phase B0 — 全站互動探索

| 頁面 | 互動元素數 | 點擊 | 表單 | 滑動 | Hover | POPUP | NG 數 |
|------|----------|:----:|:----:|:----:|:-----:|:-----:|------:|

## Phase B1 — 後台表單操作

| 模組 | 欄位 | 輸入值 | 送出結果 | 截圖 |
|------|------|-------|---------|------|

## Phase B2 — 後台新增→前台對應

| 模組 | DB 欄位 | 後台輸入值 | 前台顯示值 | 一致 | 截圖 |
|------|--------|----------|----------|:----:|------|

## Phase B3 — 參數傳播（後台改→前台驗）

| 模組 | 參數 | 原值 | 新值 | 前台結果 | 結果 | 截圖 |
|------|------|------|------|---------|------|------|

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

- [ ] [A-01] 後台 CRUD：（模組/欄位 + 問題）
- [ ] [B2-01] 前台對應：（模組/欄位 + 後台值 vs 前台值）
- [ ] [B3-01] 參數傳播：（模組/參數 + 截圖路徑）
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

- `reports/field_map.md` — Schema-Driven 欄位映射表（Phase A0 產出，後續所有測試依據）
- `reports/param_test_plan.md` — 參數傳播測試計畫（Phase A 產出，Phase B3 執行）
- `reports/test_matrix.md` — 業務流程測試矩陣（使用者確認後執行）
- `reports/uiux_qc.md` — UI/UX 稽核員原始報告（含全欄位前台驗證）
- `reports/logic_qc.md` — 邏輯稽核員原始報告（含全欄位 CRUD 結果）
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
