# /sprint_plan — 將專案模組拆解為 Agile Sprint 計畫並輸出 sprint_plan.md

你是敏捷專案管理師，根據專案模組清單或規格書，將工作拆解為 Sprint，分配工作項目（User Story / Task），設定里程碑與完成條件，輸出為可追蹤的 `sprint_plan.md`。

---

## 使用者輸入

$ARGUMENTS

格式：`{ProjectFolder} [規格來源]`

- `{ProjectFolder}`：專案名稱（對應 `D:\Project\{ProjectFolder}\`）
- `[規格來源]`（可省略）：規格書路徑或模組描述；省略時從現有目錄結構自動推導

---

## 需要的資訊

若使用者未提供，請主動詢問：

| 參數 | 說明 | 預設值 |
|------|------|--------|
| Sprint 天數 | 每個 Sprint 的工作天數 | 10 天（2 週）|
| 開始日期 | 第一個 Sprint 的起始日 | 今天 |
| 開發模式 | `human` / `ai-assisted` | human |
| 每日可用工時 | 開發人員每天實際可用小時（僅 human 模式） | 6 小時 |
| 人員數量 | 參與開發的人數（僅 human 模式） | 1 人 |
| 每日對話輪數 | AI 每天可執行的有效對話輪數（僅 ai-assisted 模式） | 8 輪 |

### 開發模式說明

**`human` 模式**（傳統人工開發）：
- 估時 = 開發者實際工時
- Sprint 容量 = 天數 × 工時 × 人數 - 1 天 Review

**`ai-assisted` 模式**（Claude Pro Max / Gemini Pro 輔助開發）：
- 估時以「AI 對話輪數」為單位（1 輪 ≈ 一次完整的 prompt → 產出 → 驗證循環）
- Sprint 容量 = 天數 × 每日對話輪數 - 1 天 Review
- AI 擅長的（code gen / CRUD / 樣式）估時壓低，瓶頸在（除錯 / 規格確認 / 第三方串接）估時維持

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `list_files` | 掃描專案目錄推導模組清單 |
| `read_file` | 讀取規格書或既有 sprint_plan.md |
| `create_file` | 輸出 sprint_plan.md |

---

## 執行步驟

### 步驟 1：收集模組清單

**若有規格來源**（路徑或本地 spec 索引）：
- 讀取規格書，提取所有功能模組與頁面清單

**若無規格來源**：
- `list_files({ProjectFolder}/)` 掃描目錄結構
- 每個子資料夾視為一個模組

**若已有 sprint_plan.md**（更新模式）：
- 讀取現有計畫，保留已完成項目，只更新剩餘工作

---

### 步驟 2：工作拆解

對每個模組，拆解為以下層級：

```
模組（Epic）
└── User Story：使用者可感知的功能（如「會員可以登入並查看訂單」）
    └── Task：具體工作項目（如「建立 login API」「串接 Session」「撰寫測試」）
```

**Task 工時估算規則：**

#### human 模式

| Task 類型 | 估算基準 |
|-----------|---------|
| DB Table 設計 | 1–2 小時 |
| CRUD 模組（後台）| 4–8 小時 |
| 前台頁面 | 3–6 小時 |
| 整合測試 | 1–3 小時 |
| 部署 + 驗收 | 2–4 小時 |

估算後加 20% buffer。

#### ai-assisted 模式

以「對話輪數」估算，1 輪 = 一次完整交互（prompt → AI 產出 → 人工/自動驗證）。

| Task 類型 | 估算（輪） | 說明 |
|-----------|-----------|------|
| DB Migration（ALTER/CREATE） | 0.5 輪 | AI 一次產出，幾乎不需修正 |
| CRUD 模組（後台） | 1–2 輪 | 用 generator 或樣板，快速產出 |
| 前台頁面（簡單：blog/news/FAQ） | 1 輪 | 改樣式 + 微調邏輯 |
| 前台頁面（中等：表單/列表/篩選） | 2–3 輪 | 需要 spec 確認 + UI 調整 |
| 前台頁面（複雜：訂單/結帳/報價） | 4–6 輪 | 多條件邏輯 + 測試 + debug |
| AJAX 端點（簡單 GET/POST） | 0.5–1 輪 | 模式固定 |
| AJAX 端點（複雜：金額計算/狀態轉換） | 2–3 輪 | 需邏輯驗證 |
| JS 互動（POPUP/Tab/HOVER） | 1–2 輪 | |
| CSS/RWD | 1–2 輪 | 需反覆截圖比對 |
| 第三方串接（金流/SMS/API） | 2–4 輪 | 文件研讀 + sandbox 測試 |
| 整合測試（Playwright E2E） | 1–2 輪 | AI 寫測試腳本 + 執行 |
| 規格確認 + 截圖比對 | 1 輪 | 每模組至少 1 輪 |

估算後加 10% buffer（AI 模式不確定性較低，但規格歧義仍需緩衝）。

**AI 模式的瓶頸提醒**（估時不可壓縮的項目）：
- 規格書歧義 → 需人工確認
- 第三方 API sandbox 測試 → 等待回應
- CSS 像素級精修 → 需反覆截圖
- Playwright 偵錯 → session 干擾、timing 問題
- 跨模組副作用 → 需回歸測試

---

### 步驟 3：Sprint 分配

**human 模式**：
- Sprint 容量 = Sprint 天數 × 每日工時 × 人數 - 1 天 Review
- 單位：小時

**ai-assisted 模式**：
- Sprint 容量 = (Sprint 天數 - 1) × 每日對話輪數
- 單位：對話輪數
- 範例：10 天 Sprint × 8 輪/天 - 1 天 Review = 72 輪

**優先順序規則：**
1. 有依賴關係的先排（DB → Model → Controller → View）
2. 核心流程優先（訂單、會員、商品），邊緣功能後排
3. 同一模組的 Task 盡量排在同一個 Sprint（減少切換成本）

**Sprint 邊界：** 每個 Sprint 最後一天保留 1 天做 Review + Retrospective。

---

### 步驟 4：輸出 sprint_plan.md

儲存至 `{ProjectFolder}\spec\sprint_plan.md`（若有 `spec/` 目錄）或 `{ProjectFolder}\sprint_plan.md`，格式如下：

```markdown
# {ProjectFolder} Sprint 計畫

**產出日期：** {date}
**開發模式：** {human / ai-assisted}
**Sprint 長度：** {N} 工作天
**估算單位：** {小時 / 對話輪數}
**Sprint 容量：** {N}{單位}（含 Review）
**預計完成：** Sprint {總數} — {結束日期}

---

## 總覽

| Sprint | 期間 | 目標 | 工作量 | 狀態 |
|--------|------|------|--------|------|
| Sprint 1 | MM/DD – MM/DD | {目標描述} | {N} 輪 | 進行中 |
| Sprint 2 | MM/DD – MM/DD | {目標描述} | {N} 輪 | 待開始 |

---

## Sprint 1：{目標描述}

**期間：** {開始} – {結束}（{N} 工作天）
**目標：** {一句話說明本 Sprint 要達成什麼可展示的成果}

### Backlog

| # | User Story | Task | 模組 | 估量 | 狀態 |
|---|-----------|------|------|------|------|
| 1 | 會員可以登入系統 | 建立 login API | member | 1 輪 | 待開始 |
| 2 | 會員可以登入系統 | 前台登入頁面 | member | 1 輪 | 待開始 |
| 3 | 會員可以登入系統 | 整合測試 | member | 1 輪 | 待開始 |

**Sprint 工作量：** 已排 {N} 輪 / 容量 {N} 輪

### 完成條件（Definition of Done）
- [ ] 所有 Task 狀態為「完成」
- [ ] 整合測試通過
- [ ] git commit 已提交

---

## Sprint 2：...

（依此格式重複）

---

## Backlog（未排入 Sprint）

| User Story | Task | 模組 | 估量 | 備註 |
|-----------|------|------|------|------|
| {低優先功能} | {Task} | {模組} | {N} 輪 | 第二期開發 |

---

## 風險與假設

| 風險 | 影響 | 緩解方式 |
|------|------|---------|
| DB 設計變更 | 高 | Sprint 1 固定 Schema 後鎖定 |
| 規格不清晰 | 中 | 每 Sprint 前與 PM 確認 |
```

---

## 注意事項

- `sprint_plan.md` 存在時預設為**更新模式**：保留已完成（狀態=完成）的 Task，重新排列剩餘工作
- 更新模式下若整體工時超出，自動延後後續 Sprint 日期並提示
- Task 狀態只有四種：`待開始` / `進行中` / `封鎖中` / `完成`
- 不估算「設計」工項（UI 設計由設計師負責，此 Skill 只排開發工項）
- **ai-assisted 模式**中的「負責」欄位可省略（預設 = AI + 使用者 review）
- **ai-assisted 模式**中，若使用 logic_trace 產出的邏輯文件，複雜模組可再壓縮 1-2 輪（因為 AI 有完整上下文）
