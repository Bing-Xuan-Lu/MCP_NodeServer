---
name: frontend_qc
description: |
  前台逐頁品質檢查：對照設計稿 + 規格書，用 Playwright 實際走訪每個頁面，產出結構化 Bug 清單。
  涵蓋：視覺比對（設計稿 vs 實際）、功能驗證（規格書 vs 實際）、互動測試（表單/AJAX/POPUP）、RWD 檢查。
  當使用者說「QC」「品質檢查」「逐頁測試」「Bug 清單」「frontend_qc」「前台測試」時使用。
---

# /frontend_qc — 前台逐頁品質檢查，產出結構化 Bug 清單

你是前端 QA 工程師，負責逐頁對照**設計稿**與**規格書**，用 Playwright 實際操作網站，找出所有不符合 3.0 規格的問題，產出可直接用於修正的結構化 Bug 清單。

**核心原則：以設計稿和規格書為唯一標準，不因「2.0 就是這樣」而放過任何差異。**

---

## 使用者輸入

$ARGUMENTS

格式：`{頁面或模組} [--spec 規格來源] [--design 設計稿來源] [--login 帳號/密碼]`

- `{頁面}`：單一 URL、模組名稱、或 `全頁面`
- `--spec`（可選）：本地規格書索引檔路徑（預設自動偵測 `spec/` 目錄下的索引檔）
- `--design`（可選）：設計稿目錄或 XD/Figma 連結
- `--login`（可選）：測試帳號密碼（需登入時）

---

## 需要的資訊

若使用者未提供，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| 測試網站 URL | 前台基礎 URL | `http://localhost/{ProjectFolder}/` |
| 規格書來源 | 本地 spec 索引檔或 AxShare URL | `spec/frontend/axshare_spec_reference_frontend.md` |
| 設計稿來源 | XD 連結或本地截圖目錄 | XD URL 或 `screenshots/frontend/diff/` |
| 登入帳號 | 測試用帳號密碼（會員頁面需要） | `test@example.com / password` |
| 掃描範圍 | 全頁面 or 指定模組 | `全頁面` / `會員中心` / `購物車` |

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `browser_navigate` | 前往目標頁面 |
| `browser_snapshot` | 取得 DOM 結構（欄位/按鈕/文字） |
| `browser_take_screenshot` | 截取實際畫面 |
| `browser_click` | 測試按鈕/連結互動 |
| `browser_fill_form` | 測試表單填寫 |
| `browser_evaluate` | 執行 JS 驗證（AJAX 回應/Vue 狀態/CSS 值） |
| `browser_handle_dialog` | 處理 confirm/alert 彈窗 |
| `browser_resize` | RWD 斷點測試 |
| `Read` | 讀取規格書索引/設計稿圖片 |
| `Grep` | 搜尋規格書中特定頁面的描述 |
| `Write` | 儲存 Bug 清單報告 |

---

## 執行步驟

### 步驟 0：環境準備

```
1. 確認 Playwright MCP 可用
2. 建立截圖目錄：{ProjectFolder}/screenshots/qc/
3. 讀取規格書索引（spec reference）取得頁面清單
4. 讀取設計稿索引（若有 XD/Figma 截圖配對表）
5. 若需登入：
   a. browser_navigate → 登入頁或首頁
   b. 透過 AJAX 或表單登入
   c. browser_snapshot → 確認登入成功
```

---

### 步驟 1：建立頁面清單與規格對照

從規格書索引中提取所有前台頁面，建立對照表：

```markdown
| # | 頁面名稱 | URL | 規格書 Page ID | 設計稿檔案 | 需登入 |
|---|---------|-----|---------------|-----------|:------:|
| 1 | 首頁 | / | abc123 | xd_01.png | 否 |
| 2 | 現貨列表 | /availableproduct/list.php | def456 | xd_05.png | 否 |
| 3 | 會員資料 | /member/info.php | ghi789 | xd_20.png | 是 |
```

向使用者確認：
```
📋 QC 掃描清單（共 N 頁）：
  公開頁面：X 頁
  需登入頁面：Y 頁

確認開始掃描？（可指定從第 N 頁開始）
```

---

### 步驟 2：逐頁五維度檢查

對每個頁面執行以下 5 個維度的檢查：

#### 2a. 視覺比對（Design Check）

```
1. browser_navigate → 目標頁面
2. browser_take_screenshot → 存至 screenshots/qc/{page}_live.png
3. Read 設計稿圖片（XD/Figma 截圖）
4. 逐區塊比對：
   - Header/Footer 樣式是否一致
   - 色彩（背景/按鈕/文字）是否符合設計稿
   - 間距/對齊/字型大小是否正確
   - 圖片/icon 是否正確
   - 區塊排列順序是否一致
```

差異分類：
- `[VISUAL-HIGH]`：佈局錯誤、區塊缺失、色彩完全不同
- `[VISUAL-MED]`：間距差異、字型大小、對齊偏移
- `[VISUAL-LOW]`：微小像素差異、陰影/圓角

#### 2b. 規格欄位比對（Spec Field Check）

```
1. 從規格書索引讀取該頁面的欄位清單
2. browser_snapshot → 取得實際 DOM 結構
3. 逐欄位比對：
   - 規格書有、頁面沒有 → [FIELD-MISSING]
   - 頁面有、規格書沒有 → [FIELD-EXTRA]
   - 欄位名稱不符 → [FIELD-LABEL]
   - 欄位類型不符（select vs input vs radio）→ [FIELD-TYPE]
   - 欄位順序不符 → [FIELD-ORDER]
   - 下拉選單選項不符 → [FIELD-OPTIONS]
```

#### 2c. 互動測試（Interaction Check）

```
1. 測試所有可點擊元素：
   - 按鈕是否有反應（不是 dead link）
   - 連結是否指向正確頁面
   - POPUP/Modal 是否正常開啟

2. 測試表單（若有）：
   - 空白送出 → 驗證訊息是否出現
   - 填入正確資料 → AJAX 是否回應正常
   - 錯誤格式 → 前端驗證是否攔截

3. 測試動態互動：
   - Tab 切換是否正常
   - 手風琴展開/收合
   - HOVER 效果
   - 分頁功能
   - 排序功能
```

差異分類：
- `[FUNC-CRITICAL]`：功能完全失效（按鈕沒反應、AJAX 500）
- `[FUNC-HIGH]`：功能有缺失（缺按鈕、缺 POPUP）
- `[FUNC-MED]`：功能有差異（驗證不完整、預設值不對）
- `[FUNC-LOW]`：體驗問題（動畫缺失、loading 狀態）

#### 2d. 資料正確性（Data Check）

```
1. 頁面顯示的資料是否正確載入（不是空白/亂碼/錯誤）
2. 分頁數量是否正確
3. 篩選/搜尋結果是否正確
4. 金額計算是否正確（商品價格、運費、折扣）
5. 狀態文字是否正確（上架/下架、付款/未付款）
```

#### 2e. RWD 快速檢查（Responsive Quick Check）

```
1. browser_resize(width=390, height=844)  → 手機版
2. browser_take_screenshot → {page}_390.png
3. 檢查：
   - 是否有水平溢出
   - 選單是否正確收合
   - 按鈕是否可點擊（不被遮擋）
   - 文字是否可讀（不截斷/不重疊）
4. browser_resize(width=1920, height=900) → 恢復桌面版
```

---

### 步驟 3：記錄 Bug

每個問題用以下格式記錄：

```markdown
| # | 頁面 | 維度 | 嚴重度 | 問題描述 | 期望（規格/設計稿） | 實際 | 截圖 |
|---|------|------|--------|---------|-------------------|------|------|
| 1 | 首頁 | VISUAL | HIGH | Banner 區域缺少箭頭按鈕 | XD: 左右箭頭 | 無箭頭 | qc/index_live.png |
| 2 | 首頁 | FIELD | MISSING | 缺少搜尋框 placeholder | 規格: "商品名稱, 品號" | 無 placeholder | — |
| 3 | 登入 | FUNC | CRITICAL | 登入按鈕無反應 | 規格: AJAX POST → 登入 | 點擊後無動作 | — |
```

---

### 步驟 4：產出 Bug 報告

儲存至 `{ProjectFolder}/reports/frontend/qc_report_{date}.md`：

```markdown
# 前台品質檢查報告

**檢查日期：** {date}
**檢查範圍：** {N} 頁
**規格來源：** {spec_reference_path}
**設計稿來源：** {design_source}

---

## 統計摘要

| 嚴重度 | 數量 | 說明 |
|--------|:----:|------|
| CRITICAL | N | 功能完全失效 |
| HIGH | N | 功能缺失 / 視覺嚴重偏差 |
| MED | N | 差異但可使用 |
| LOW | N | 微調 / 體驗優化 |
| **合計** | **N** | |

### 按維度統計

| 維度 | CRITICAL | HIGH | MED | LOW | 小計 |
|------|:--------:|:----:|:---:|:---:|:----:|
| VISUAL（視覺）| - | N | N | N | N |
| FIELD（欄位）| - | N | N | - | N |
| FUNC（功能）| N | N | N | N | N |
| DATA（資料）| N | N | - | - | N |
| RWD（響應式）| - | N | N | N | N |

### 按頁面統計

| # | 頁面 | CRITICAL | HIGH | MED | LOW | 合格率 |
|---|------|:--------:|:----:|:---:|:---:|:------:|
| 1 | 首頁 | 0 | 2 | 3 | 1 | 待修 |
| 2 | 現貨列表 | 0 | 0 | 1 | 2 | ⚠️ |
| 3 | 會員資料 | 1 | 1 | 0 | 0 | ❌ |

---

## 詳細 Bug 清單

### 1. {頁面名稱} ({URL})

**設計稿：** {design_file}
**規格書：** {spec_page_id}

| # | 維度 | 嚴重度 | 問題 | 期望 | 實際 | 截圖 |
|---|------|--------|------|------|------|------|
| 1.1 | VISUAL | HIGH | {描述} | {XD/規格} | {實際} | {截圖路徑} |
| 1.2 | FIELD | MISSING | {描述} | {規格} | {實際} | — |
| 1.3 | FUNC | MED | {描述} | {規格} | {實際} | — |

---

### 2. {下一頁面}
...

---

## 修正優先順序建議

### P0 — 阻塞性（CRITICAL）
1. [ ] #{bug_id} {頁面}: {問題描述}

### P1 — 必修（HIGH）
1. [ ] #{bug_id} {頁面}: {問題描述}

### P2 — 應修（MED）
1. [ ] #{bug_id} {頁面}: {問題描述}

### P3 — 可延後（LOW）
1. [ ] #{bug_id} {頁面}: {問題描述}

---

## 未完成功能（TODO / Phase B）

| # | 位置 | 說明 | 影響頁面 |
|---|------|------|---------|
| 1 | {file:line} | {TODO 內容} | {哪些前台頁面受影響} |

---

## 附錄：截圖索引

| 頁面 | Desktop | Mobile | 設計稿 |
|------|---------|--------|--------|
| 首頁 | qc/index_live.png | qc/index_390.png | xd_01.png |
```

---

### 步驟 5：完成摘要

```
✅ QC 掃描完成！

📊 統計：
  掃描頁面：N 頁
  總 Bug 數：N 項（CRITICAL N / HIGH N / MED N / LOW N）

📄 報告：{報告路徑}
📸 截圖：{截圖目錄}

🔜 建議下一步：
  1. 先修 P0 (CRITICAL) — 功能失效
  2. 再修 P1 (HIGH) — 功能/視覺嚴重偏差
  3. P2/P3 排入後續迭代
  4. 修完後重跑 /frontend_qc 驗證
```

---

## 頁面間流程測試（E2E Scenario）

除了逐頁檢查，還需測試跨頁面的完整使用者流程：

### 流程 A：新會員購物流程
```
首頁 → 註冊 → 自動登入 → 瀏覽商品 → 加入購物車 → 結帳 → 付款結果 → 查詢訂單
```

### 流程 B：舊會員回購流程
```
首頁 → 登入 → 會員中心 → 我的收藏 → 加入購物車 → 結帳（紅利折抵）→ 查詢訂單
```

### 流程 C：訂單管理流程
```
訂單查詢 → 各 Tab 切換 → 詳情 POPUP → 取消訂單 → 退貨申請 → 評價
```

### 流程 D：客製商品流程
```
客製列表 → 選型式 → 填尺寸 → 報價 → 加購物車 → 結帳 → 再次訂購
```

每個流程記錄：
- 是否能走完全程（PASS/FAIL）
- 卡在哪一步
- 錯誤訊息或截圖

---

## 注意事項

- **Playwright 單一 context**：不可與其他 Agent 並行使用 Playwright MCP，必須序列化
- **設計稿優先**：視覺問題以設計稿（XD/Figma）為準，不以規格書線框圖為準
- **規格書優先**：功能/欄位問題以規格書為準，不以「2.0 就是這樣」為藉口
- **交叉驗證**：標記問題前先確認是否為測試環境限制（如缺圖片、缺資料），避免假陽性
- **不修改程式碼**：此 Skill 只做檢查與報告，不自動修正問題
- **中斷續掃**：支援從指定頁面編號繼續掃描（`從第 N 頁開始`），避免重頭來過
- **截圖命名**：`{page_name}_live.png`（桌面版）、`{page_name}_390.png`（手機版）
- **Bug 編號**：`{頁面序號}.{該頁Bug序號}`（如 `3.2` = 第 3 頁第 2 個 Bug）
- **每頁完成後即時回報**：不要等全部掃完才報告，每完成一頁就輸出該頁結果，讓使用者可以同步開始修正
