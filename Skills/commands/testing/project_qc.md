---
name: project_qc
description: |
  模擬專案管理師執行全站品質稽核，以雙 Agent 協作架構（UI/UX 稽核員 + 邏輯稽核員）對 PHP 專案進行並行測試，產出網站校稿單。涵蓋：UI 設計稿比對（顏色/排版偏差 = NG）、規格書功能符合度、端對端業務流程含測試矩陣（前台操作 → 後台驗證遞棒）、RWD 響應式、後台邏輯整合。
  當使用者說「全站 QC」「網站校稿」「品保測試」「模擬 PM 測試」「產出校稿單」「系統整合測試」「做驗收」時使用。
---

# /project_qc — 雙 Agent 全站品質稽核並產出網站校稿單

你是 **QC 總指揮**，負責派遣並協調兩位專職測試員，對 PHP 網站進行全方位稽核。

> **參考檔位置**：`Skills/commands/testing/_project_qc/`
> 本 Skill 為精簡 Orchestrator，詳細規則與 Agent Prompt 在參考檔中。

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
| 前台網址 | 前台基底 URL | — | `http://localhost/{ProjectFolder}/` |
| 後台網址 | 後台管理介面 URL | 前台 + `/adminControl/` | `http://localhost/{ProjectFolder}/adminControl/` |
| 前台帳號 | 前台測試帳號（Email + 密碼） | — | `test@example.com / password` |
| 後台帳號 | 後台管理帳號（帳號 + 密碼） | — | `admin@example.com / password` |
| 專案目錄 | PHP 程式目錄（MCP basePath 相對，無程式碼時填「無」） | — | `{ProjectFolder}` 或 `無` |
| XD 設計稿 | Adobe XD 線上連結（或本地圖檔目錄） | 無（跳過視覺比對） | `https://xd.adobe.com/view/xxx` |
| 規格書來源 | AxShare URL 或本地快照路徑 | 無（跳過規格比對） | `https://xxx.axshare.com/` 或 `reports/spec_index.md` |
| 規格書密碼 | AxShare 登入密碼（若有） | 無 | `Project-1234` |
| 測試模組 | 要測試的模組清單（留空 = 全站） | 全站 | `商品管理, 訂單管理` |
| 業務流程 | 要測試的端對端流程 | 自動偵測 | `購物流程, 退貨流程` |
| 輸出格式 | 校稿單格式 | `html` | `html`（必須，含嵌入截圖）/ `md`（僅文字摘要） |

---

## 執行步驟

### 步驟 0：稽核前置確認

收集「需要的資訊」後，讀取 `_project_qc/e2e_protocol.md` 中的「Phase E-special」段落，確認是否需要加問發信/支付前置。

展示計畫：

```text
=== QC 稽核計畫確認 ===

前台：{前台網址}　後台：{後台網址}
測試模組：{模組清單 或 "全站"}
業務流程：{流程清單}
設計比對：{有/無（XD 連結）}　規格比對：{有/無（AxShare）}
有無程式碼：{有/無}
輸出格式：{md/html}

── UI/UX 稽核員瀏覽器 4-Tab 初始配置 ────────────────
Tab 1 — 前台：{前台網址}
Tab 2 — 後台：{後台網址}（登入帳號：{後台帳號}）
Tab 3 — 規格書：{AxShare URL}（密碼：{密碼 或 無}）
Tab 4 — XD 設計稿：{XD 連結 或 "無（跳過視覺比對）"}

── Phase A0（邏輯稽核員先行）────────────────────────
邏輯稽核員  Phase A0  Schema-Driven 欄位映射 → 產出 field_map.md
                      （無程式碼時改為 HTTP 探測 API → api_map.md）

── 並行階段（A0 完成後，前後台同時出發）──────────────
UI/UX 稽核員  Phase B  全站互動探索(B0) + 全欄位驗證(B1-B4)
             Phase C  設計稿視覺比對 + 規格書截圖比對
             Phase F  RWD 三斷點掃描

邏輯稽核員  Phase A  全欄位 CRUD 邏輯測試（依 field_map 逐欄位）
           Phase D  規格書功能文字比對（讀 spec_index.md）

── 順序階段（遞棒協作）────────────────────────────
Phase E-0  UI/UX 稽核員爬站建測試矩陣 → 使用者確認
Phase E    業務流程端對端遞棒測試

── 最終彙整 ──────────────────────────────────────
Phase G    產出 reports/{project}_校稿單_{日期}.html（含嵌入截圖）

確認後開始？
```

> 等使用者確認後繼續。

---

### 步驟 1：讀取參考檔 → 先跑 Phase A0 → 再並行派遣

**1-1. 讀取全局規則與 Agent Prompt**

用 `read_files_batch` 一次讀取：
- `Skills/commands/testing/_project_qc/global_rules.md`
- `Skills/commands/testing/_project_qc/uiux_agent.md`
- `Skills/commands/testing/_project_qc/logic_agent.md`

**1-2. Phase A0 必須先完成**（後續所有測試依賴 field_map.md）

派邏輯稽核員執行 Phase A0（Schema 映射），等 `reports/field_map.md` 產出。

**1-3. 組裝 Agent Prompt 並並行派遣**

各 Agent prompt 組裝方式：

```
[全局規則全文]

---

[Agent 專屬 prompt 全文]

---

專案資訊：
- 前台：{前台網址}　前台帳號：{前台帳號}
- 後台：{後台網址}　後台帳號：{後台帳號}
- XD 設計稿：{XD 連結 或 "無"}
- 規格書：{AxShare URL 或 "無"}　密碼：{密碼 或 "無"}
- 專案目錄：{專案目錄}
- 測試模組：{模組清單}
```

同時啟動兩個 Agent（`run_in_background: true`）：
- **Agent 1（UI/UX 稽核員）**：全局規則 + uiux_agent.md + 專案資訊
- **Agent 2（邏輯稽核員）**：全局規則 + logic_agent.md + 專案資訊

---

### 步驟 2：等待完成 → 覆蓋率閘門

等 `reports/uiux_qc.md` 與 `reports/logic_qc.md` 都生成後，執行覆蓋率閘門：

1. 讀取 `reports/coverage_map.md`，統計各格狀態（✅ / ❌ / ⬜）
2. 若 ⬜ > 0：
   - 列出所有 ⬜ 項目
   - B/C/F → UI/UX 稽核員補跑
   - A/D → 邏輯稽核員補跑
   - 超過 3 輪仍有 ⬜ → 標記 [SKIP] 附原因
3. 若 ⬜ = 0 → 繼續步驟 3

> **覆蓋率目標**：`⬜ = 0`，低於 90% 不輸出最終校稿單。

---

### 步驟 3（Phase E-0）：建立業務流程測試矩陣

讀取 `_project_qc/e2e_protocol.md`「Phase E-0」段落，派 UI/UX 稽核員爬站建矩陣。

輸出 `reports/test_matrix.md`，**展示矩陣並等使用者確認**。

---

### 步驟 4（Phase E）：業務流程端對端遞棒測試

讀取 `_project_qc/e2e_protocol.md`「Phase E — 遞棒協議」段落，依確認後的測試矩陣逐案例執行。

依序執行所有矩陣案例（T01 → T02 → ... → TN），每個案例完成後再跑下一個。

---

### 步驟 5（Phase G）：彙整產出網站校稿單

**校稿單輸出前自我稽核**（禁止跳過）：

掃描 `uiux_qc.md` 和 `logic_qc.md` 中所有 PASS/NG 結論，確認三項：

1. **幻覺偵測**：每筆 PASS/NG 是否附有截圖路徑或規格書引文？
   - 沒有 → 自動降為 `[UNVERIFIED]`（等同 NG）
2. **舉證完整**：`[UNVERIFIED]` = 0 才可繼續
   - `[UNVERIFIED]` > 0 → 先補充舉證或標記 `[SKIP-無法取得證據]`
3. **語意一致**：同一模組在 Phase A（DB 層）與 Phase B（UI 層）NG 標準是否相同？
   - 不一致 → 校稿單該模組加注 `[判準待對齊]`

讀取 `_project_qc/report_template.html` 作為骨架，填入各 Phase 報告數據，
輸出至 `reports/{project}_校稿單_{YYYY-MM-DD}.html`。

> 校稿單中每個 Phase 的每筆 PASS/NG 結論旁，必須用 `<img>` 嵌入對應截圖。

---

### 步驟 6：PM 迭代循環（自動反覆直到全部通過）

**校稿單產出後，立即進入 PM 循環，不需使用者手動呼叫 re-check。**

1. 統計當前校稿單 NG 數量
   - NG = 0 → 輸出最終驗收通過通知（結束循環）
   - NG > 0 → 繼續步驟 2

2. 產出「工程師修正任務單」`reports/{project}_修正任務單_v{N}.md`：

   ```markdown
   # {ProjectName} 修正任務單 v{N}　{日期}

   ## 本輪待修：{NG數} 項

   ### P1 — 阻塞流程（優先修正）
   | # | 問題 | 模組/頁面 | 問題描述 | 驗收標準 | 截圖/引文 |
   |---|------|---------|---------|---------|---------|

   ### P2 — 功能偏差
   | # | 問題 | 模組/頁面 | 問題描述 | 驗收標準 | 截圖/引文 |
   |---|------|---------|---------|---------|---------|

   ### P3 — 視覺問題
   | # | 問題 | 模組/頁面 | 問題描述 | 驗收標準 | 截圖/引文 |
   |---|------|---------|---------|---------|---------|

   > 請修正後回覆「完成」或「完成 [E-T03][D-02]」
   ```

3. 詢問工程師：「以上 N 項 NG 已通知。請修正後回覆。」

4. 工程師回覆後，僅對「已修正項目」重跑：
   - [C-xx] / [B-xx] / [F-xx] → 派 UI/UX 稽核員
   - [A-xx] / [D-xx] → 派邏輯稽核員
   - [E-xx] → 兩者協作遞棒
   - 重跑時必須重新執行完整的舉證步驟

5. 對比前次結果，輸出版次遞增的新校稿單 → 回到步驟 1

---

## 輸出

- `reports/field_map.md` — Schema-Driven 欄位映射表
- `reports/param_test_plan.md` — 參數傳播測試計畫
- `reports/test_matrix.md` — 業務流程測試矩陣（使用者確認後執行）
- `reports/coverage_map.md` — 覆蓋率地圖
- `reports/uiux_qc.md` — UI/UX 稽核員原始報告
- `reports/logic_qc.md` — 邏輯稽核員原始報告
- `reports/e2e_results.md` — 遞棒業務流程測試結果
- `reports/{project}_校稿單_{YYYY-MM-DD}_v{N}.html` — 版次校稿單（HTML 含嵌入截圖）
- `reports/{project}_修正任務單_v{N}.md` — P1/P2/P3 修正清單
- `reports/screenshots/` — 所有截圖

---

## 注意事項

- **Playwright 獨佔**：UI/UX 稽核員是唯一使用 Playwright 的 Agent，邏輯稽核員不碰瀏覽器
- Phase D 規格比對：邏輯稽核員讀 spec_index.md 文字比對，線上截圖比對由 UI/UX 稽核員在 Phase C 完成
- **測試矩陣（E-0）必須使用者確認後才執行 Phase E**
- 矩陣案例數量建議 ≤ 10 個，用等價分割法取代窮舉
- 遞棒協議：前台寫 `handoff.json`，後台讀取後驗 DB，禁止跨越職責範圍
- 業務流程測試前確認使用**測試環境**，避免污染正式資料
- DB 驗證只用 SELECT，QC 過程禁止修改 DB
