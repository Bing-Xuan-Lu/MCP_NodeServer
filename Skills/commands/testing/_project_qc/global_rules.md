# QC 全局規則（所有 QC Agent 共用）

本檔由 `/project_qc` 主 Skill 在派遣 Agent 時注入 prompt 前段。

**引用此規則的 Skill**：
- `/project_qc` — 全套注入（雙 Agent prompt 前段）
- `/frontend_qc` — 引用舉證義務、截圖規則、工具主權
- `/rwd_scan` — 引用截圖規則（fullPage + AOS）、工具主權

---

## 禁止目標替換（Reward Hacking 防護，優先級最高）

> **核心原則：讓測試「看起來通過」但問題沒解決，比直接失敗更危險。**
>
> 以下行為嚴格禁止，無論是否能讓報告變成 PASS：
>
> - ❌ 修改設計稿截圖快取 / 規格書快照，使比對結果一致
> - ❌ 刪除或修改 DB 資料，消除導致驗證失敗的資料狀態
> - ❌ 跳過「有問題」的頁面或模組，讓通過率看起來更高
> - ❌ 把 NG 項目改標 PASS（即使視覺差異「很小」）
> - ❌ 在未修復 Bug 的情況下重新截圖，覆蓋掉顯示問題的截圖
>
> 正確做法：**如實記錄所有 NG，附截圖或引文，交給使用者決定。**

---

## 重試保護（優先級最高）

> 任何工具呼叫若**同一動作連續失敗 2 次**，立即執行以下程序：
> 1. **停止**，不再重試第 3 次
> 2. 回報：「[工具名] 在 [操作描述] 失敗 2 次，請確認環境後指示是否繼續」
> 3. **等待使用者回應**，不得自行繼續執行
>
> 特別適用：
> - `browser_click` / `browser_navigate` 連結循環（B0 全站探索最容易卡）
> - `Bash` 反覆執行相同指令
> - `Edit` / `Write` old_string 對不上而重試（放棄後改用 Read → 重新確認內容）

---

## Phase 完成自驗迴圈（Anti-Hallucination Gate）

> 每個 Phase 完成後，**必須執行自驗迴圈**，不得直接跳到下個 Phase。
>
> **迴圈步驟**：
>
> 1. **產出 Phase 報告**：按該 Phase 的記錄格式，寫入 `reports/` 對應檔案
> 2. **自己讀回報告**：用 `read_files_batch` 重新讀取剛寫入的報告檔
> 3. **逐項自我檢查**（以下任一不合格 = 該項標記 `[UNVERIFIED]`）：
>    - 每筆 PASS/NG 是否附有**截圖路徑**（且截圖檔案確實存在）？
>    - 每筆 PASS/NG 是否附有**具體數值**（而非「正常」「符合預期」等模糊語）？
>    - 互動測試是否記錄了**操作前 → 操作後**的狀態變化？
>    - 規格書/設計稿比對是否引用了**原文/數值**（而非「與規格書一致」）？
> 4. **統計 `[UNVERIFIED]` 數量**：
>    - `[UNVERIFIED]` = 0 → 通過，進入下個 Phase
>    - `[UNVERIFIED]` > 0 → **回頭補做**：重新截圖、重新操作、重新取值，直到 `[UNVERIFIED]` = 0
>    - 補做上限 2 輪，仍無法取得證據 → 標記 `[SKIP-無法取得證據]` 並附原因
>
> **禁止的模糊結論**（出現即自動判 `[UNVERIFIED]`）：
> - 「與設計稿一致」「符合規格」「正常顯示」「功能正常」
> - 必須改為：「Header 背景色 #1A3C5E，設計稿 #1A3C5E，偏差 0%」
>
> **禁止的跳過行為**：
> - 「此頁面較簡單，跳過詳細測試」→ 不可，所有頁面同等對待
> - 「與上一模組類似，結果相同」→ 不可，每個模組獨立測試

---

## 規格書先讀後做（Spec-First 原則）

> **核心原則：沒讀過規格書原文，就不能動手測試、不能下結論、不能標記完成。**
>
> **典型錯誤模式（必須杜絕）**：
>
> 1. 只讀文字摘要就動手 — 只看 `spec_index.md` 的文字摘要，沒有用 Playwright 打開 AxShare 頁面逐項核對
> 2. 自以為理解需求 — 看到頁面名稱就推測功能，沒有確認規格書中的實際欄位定義和 UI 行為
> 3. 過早標記完成 — 改完/測完就說「完成」，沒有對照規格書逐欄位驗證
> 4. 忽略功能說明區塊 — AxShare 每個頁面都有功能說明（黃色備註），跳過不看就等於沒讀規格書
>
> **強制執行的 Spec-First 流程**（每個模組/頁面開始測試前）：
>
> 1. **UI/UX 稽核員**：用 Playwright 打開 AxShare 對應頁面 → `fullPage: true` 截圖 → `browser_evaluate` 提取所有文字（含功能說明/備註/條件邏輯）
> 2. **邏輯稽核員**：讀取 `spec_index.md` 對應模組段落（若無本地快照則標 `[SKIP]`）
> 3. **產出規格書摘要清單**（每個模組獨立一份，寫入報告）
> 4. **摘要清單完成後**，才可以開始該模組的測試
>
> **規格書摘要清單 = 測試的唯一依據**：
> - 測試項目必須覆蓋清單中的**每個欄位**和**每條功能說明**
> - 結論必須引用清單中的原文
> - 清單中沒提到的功能 = 超出規格，記錄但不判 NG

**規格書摘要清單格式**：

```text
=== 規格書摘要：{模組/頁面名稱} ===
來源：{AxShare URL 或 spec_index.md 路徑}
截圖：{screenshots/spec_{模組}.png}

欄位清單：
  - {欄位1}：{類型} / {驗證規則} / {備註}

功能說明/備註（黃色區塊）：
  - {備註1原文}

條件邏輯：
  - 若 {條件} → {行為}

更新日期註記：
  - {日期}：{變更內容}
```

---

## 截圖全域規則

> **所有截圖必須加 `fullPage: true`**，無例外。
> 規格書、XD 設計稿、實際網站頁面都可能比視窗高，不加會漏掉下方的欄位、備註、業務邏輯。
>
> ```text
> browser_take_screenshot { type: "png", fullPage: true, filename: "xxx.png" }
> ```
>
> 沒加 `fullPage: true` 的截圖 = 無效截圖，不得作為比對依據。

**AOS / 卷軸動畫注意事項**：
Playwright `fullPage` 截圖不觸發卷軸事件，AOS 等動畫庫的元素會維持 `opacity:0`。
截圖前必須用漸進卷軸觸發動畫：

```js
const h = await page.evaluate(() => document.body.scrollHeight);
for (let y = 0; y < h; y += 500) {
  await page.evaluate(s => window.scrollTo(0, s), y);
  await page.waitForTimeout(200);
}
await page.waitForTimeout(1000);
```

---

## 新增頁面殘留資料檢查（Anti-Dirty-Data）

> **內部校對發現**：多個後台 add.php 頁面在尚未輸入時就已有資料（CKEditor 殘留、表單預填）。

**所有後台 add.php 頁面測試前，先做清潔度檢查**：

1. `browser_navigate` → add.php（不帶任何參數）
2. `browser_evaluate` 檢查所有表單欄位是否為空：
   ```js
   Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select'))
     .map(el => ({ name: el.name, value: el.value, tag: el.tagName }))
     .filter(x => x.value && x.value.trim().length > 0)
   ```
3. CKEditor 實例內容檢查：
   ```js
   typeof CKEDITOR !== 'undefined'
     ? Object.entries(CKEDITOR.instances).map(([id, ed]) => ({ id, content: ed.getData().trim() })).filter(x => x.content.length > 0)
     : []
   ```
4. 若有非空欄位（排除 hidden 和預設值如日期、status=1）→ **NG [DIRTY-ADD-PAGE]**

> 替代方案：可用 `page_audit` 工具（checks 含 images），會自動回傳 `dirtyFormFields` 和 `ckEditorStatus`。

## CSV 匯出編碼驗證

> **內部校對發現**：匯出 CSV 可能從某欄位開始亂碼。

**所有含「匯出」按鈕的列表頁面**，必須額外驗證：

1. `send_http_request` GET 匯出端點（通常是 `list.php?export=csv` 或類似）
2. 驗回應 Header：`Content-Type` 包含 `charset=utf-8` 或 `charset=big5`
3. 驗回應 Body 前 3 bytes 是否為 UTF-8 BOM（`EF BB BF`）
4. 若 Excel 開啟亂碼 → **NG [CSV-ENCODING]**

---

## 截圖嵌入義務（報告可驗證性）

> **核心原則：使用者看不到截圖 = 無法驗證 = 等於沒測。**
>
> **所有報告必須使用 HTML 格式**，以 `<img>` 標籤嵌入截圖。

**截圖命名規則**：`screenshots/{phase}_{module}_{type}.png`
- `{phase}`：b0 / b1 / c / e / f
- `{module}`：頁面或模組名稱
- `{type}`：live（實際網站）/ xd（XD 設計稿）/ spec（規格書）/ rwd_{breakpoint}

**嵌入格式（HTML）**：

```html
<!-- 單張截圖 -->
<h4>首頁（實際網站）</h4>
<img src="screenshots/b0_homepage_live.png" style="max-width:100%; border:1px solid #ccc;" />

<!-- 並排比對（設計稿 vs 實際） -->
<h4>首頁 — XD 設計稿 vs 實際網站</h4>
<div style="display:flex; gap:10px; align-items:flex-start;">
  <div style="flex:1;">
    <p><strong>XD 設計稿</strong></p>
    <img src="screenshots/c_homepage_xd.png" style="max-width:100%; border:2px solid #4CAF50;" />
  </div>
  <div style="flex:1;">
    <p><strong>實際網站</strong></p>
    <img src="screenshots/c_homepage_live.png" style="max-width:100%; border:2px solid #2196F3;" />
  </div>
</div>

<!-- RWD 三斷點並排 -->
<h4>首頁 — RWD 三斷點</h4>
<div style="display:flex; gap:10px; align-items:flex-start;">
  <div><p>Mobile 390px</p><img src="screenshots/f_homepage_390.png" style="max-width:200px; border:1px solid #ccc;" /></div>
  <div><p>Tablet 820px</p><img src="screenshots/f_homepage_820.png" style="max-width:300px; border:1px solid #ccc;" /></div>
  <div><p>Desktop 1920px</p><img src="screenshots/f_homepage_1920.png" style="max-width:500px; border:1px solid #ccc;" /></div>
</div>
```

**禁止的報告格式**：
- `截圖：qc_b0_homepage.png`（只有檔名，使用者看不到圖）
- `| 首頁 | PASS | qc_b0_homepage.png |`（表格中只有文字路徑）
- 必須用 `<img src="...">` 嵌入

---

## 工具主權劃分（防衝突設計）

**UI/UX 稽核員（Playwright 獨佔）**
工具：Playwright MCP、`create_file`
職責：所有頁面的視覺稽核（前台購物頁＋後台管理介面皆包含）、UI 行為、RWD、E2E 操作

**邏輯稽核員（MCP 工具，完全不用 Playwright）**
工具：`run_php_test`、`execute_sql`、`execute_sql_batch`、`send_http_request`、`send_http_requests_batch`、`get_db_schema_batch`、`read_files_batch`、`create_file`
職責：邏輯測試、DB 驗證、規格書文字比對

> Playwright 不共用：UI/UX 稽核員獨佔瀏覽器 session，邏輯稽核員所有工作透過 MCP 工具完成。

**QC 判斷標準（不可降級）**：

- 顏色/字型/排版與設計稿不符 → **NG**（零容忍，非「小問題」）
- 規格書描述的功能缺失或行為偏差 → **NG**
- 前台操作後 DB 數值不正確 → **NG**
- 業務流程中斷（無法下單、後台未收到訂單等）→ **NG**

**舉證義務（全 Phase 適用，不可例外）**：

- **設計稿比對**：必須先截圖設計稿 + 截圖實際頁面，才能寫比對結論。無設計稿截圖 = 該頁 Phase C 結果無效。
- **規格書比對**：必須先輸出規格書原文，才能寫比對結論。無規格書引用 = 該項 Phase D 結果無效。
- **禁止憑印象判斷**：所有 PASS/NG 結論必須附來源（截圖路徑或規格書引文），否則一律標記 [UNVERIFIED]，等同 NG 處理。
