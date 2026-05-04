---
name: css_legacy_override
description: |
  改 CSS 蓋 legacy `!important` 規則時，自動掃 legacy 檔內所有 @media 區塊，提示哪些斷點需要對應反制，避免「桌機改了破手機 popup/active 行為」類跨斷點 regression。涵蓋：legacy CSS 檔索引、@media 區塊全收集、目標選擇器跨斷點對照、反制建議產出。
  當使用者說「改 CSS」「蓋掉 legacy 樣式」「改 v3 page CSS」「override !important」、或編輯位於頁面層 CSS 而專案另有 legacy global CSS 時使用。
---

# /css_legacy_override — Legacy CSS 覆寫前的 @media 反制檢查

你是 CSS 跨斷點 regression 守門員。當使用者要在「頁面層 CSS」（如 `{module}/page/*.css`）寫覆寫規則去蓋掉「全域 legacy CSS」（如 `screen.prefixer.css`、`reset.css`、UI framework 主檔）的 `!important` 時，先掃 legacy CSS 中該選擇器在所有 `@media` 區塊的所有出現點，告訴使用者：「桌機那條被你蓋了，但 ≤768 / ≤480 / hover 等斷點還有同名規則，要不要一起反制？」避免典型踩坑：桌機改完通過驗收，手機 popup / active / focus 全爛。

---

## 使用者輸入

$ARGUMENTS

格式：`{要改的目標 CSS 檔} [選擇器]`

- `{要改的目標 CSS 檔}`：你正要寫覆寫規則的 CSS 檔（如 `module_a/page/foo.css`）
- `[選擇器]`（可選）：要覆寫的具體 CSS 選擇器（如 `.popup .btn-active`）；省略時走互動模式逐條問

---

## 需要的資訊

若使用者未提供，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| 目標 CSS 檔 | 要寫新覆寫規則的檔案 | `module_a/page/foo.css` |
| Legacy CSS 檔 | 被覆寫的 legacy 全域 CSS（可多個） | `assets/css/screen.prefixer.css` |
| 選擇器 | 要蓋掉的 CSS selector | `.popup .btn-active` |
| 預期適用斷點 | 桌機 / 平板 / 手機 / 全部 | `全部`（最常見） |

> **Legacy CSS 預設值**：若使用者沒指定，預設掃 `assets/css/*.css`、`{module}/css/*.css`、`vendor/**/screen*.css`、`vendor/**/reset*.css`，找最大的全域檔當 legacy 候選。

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `Glob` | 找 legacy CSS 候選檔 |
| `Grep` | 在 legacy CSS 中搜選擇器，含 `multiline` 抓 `@media` 區塊邊界 |
| `read_file` | 讀 legacy CSS 完整內容（小檔）做精準 @media block 切分 |
| `apply_diff` | 確認後寫入反制規則到目標 CSS |

---

## 執行步驟

### 步驟 0：前置確認

確認使用者提供（或可推斷）：
- 目標 CSS 檔（要寫覆寫的檔）
- 至少一個 legacy CSS 檔（或同意走預設掃描）
- 至少一個選擇器（或同意進互動模式）

未齊全 → 主動詢問，列出推測的 legacy 候選給使用者選。

---

### 步驟 1：定位 legacy CSS

```text
若使用者已指定 → 直接用
否則：
  Glob: assets/css/*.css, {module}/css/*.css, vendor/**/screen*.css, vendor/**/reset*.css
  → 列出 5 大候選（按檔案大小排序），請使用者勾選實際的 legacy 檔
```

> **判斷依據**：legacy 檔通常有「大量 `!important`」「大量 `@media` 巢狀」「跨多個 module 共用」三特徵之一。

---

### 步驟 2：掃選擇器在 legacy 的所有出現點

對使用者給的選擇器，做兩階段搜尋：

```text
2a. Grep（粗篩）：
    pattern: 選擇器的關鍵 class 名稱（escape 過的）
    path:    legacy CSS 檔
    output_mode: content, -n: true, -C: 3

2b. read_file（精切）：若 grep 命中 → 讀整個 legacy CSS（≤200KB 全讀）
    切分所有 @media block：
      - `@media (max-width: 768px)` → mobile-tablet
      - `@media (max-width: 480px)` → mobile
      - `@media (min-width: 1200px)` → desktop-wide
      - `@media (hover: hover)` / `:hover` 規則 → hover 行為
      - 沒包在 @media 的 → base（桌機優先）

2c. 對每個 @media block，重新比對選擇器是否出現
    → 收集所有命中的 (媒體條件, 行號, 完整規則片段)
```

---

### 步驟 3：產出對照表並等使用者確認反制策略

```text
🎯 選擇器：.popup .btn-active

🔍 Legacy CSS（assets/css/screen.prefixer.css）中找到 4 處：

| # | 媒體條件                      | 行號  | 規則摘要                          | 你的覆寫會蓋掉嗎 |
|---|-------------------------------|-------|-----------------------------------|------------------|
| 1 | (base，無 @media)             | 1234  | color: #333 !important            | ✅ 會            |
| 2 | @media (max-width: 768px)     | 4567  | display: block !important         | ❌ 不會（要反制） |
| 3 | @media (max-width: 480px)     | 5012  | font-size: 14px !important        | ❌ 不會（要反制） |
| 4 | @media (hover: hover)         | 5678  | background: #f00 !important       | ❌ 不會（要反制） |

⚠️ 你只覆寫 base 規則 → 桌機 OK，但平板/手機/hover 會繼續吃 legacy 規則，常導致：
  - 桌機驗收通過、手機 popup 跑版
  - 滑鼠 hover 變色錯誤
  - active state 沒效果

📋 建議反制策略（請選一）：
  A. 只蓋 base（最小改動，明確不管 RWD）
  B. 全部斷點都對應反制（4 條規則一起寫）
  C. 只蓋 base + mobile（≤768），其他保留 legacy
  D. 我來指定要蓋哪幾條（互動）
```

等使用者選 A/B/C/D 後繼續。

---

### 步驟 4：產生反制 CSS 並 apply_diff

依使用者選的策略，組裝 CSS 區塊：

```css
/* === Override legacy: assets/css/screen.prefixer.css === */
/* base */
.popup .btn-active {
  color: #yourcolor !important;
}
/* @media (max-width: 768px) - 反制 legacy line 4567 */
@media (max-width: 768px) {
  .popup .btn-active {
    display: flex !important;  /* 蓋 legacy 的 block */
  }
}
/* @media (max-width: 480px) - 反制 legacy line 5012 */
@media (max-width: 480px) {
  .popup .btn-active {
    font-size: 16px !important;  /* 蓋 legacy 的 14px */
  }
}
```

> **每條反制規則上方加註解**：標明它對應 legacy 的哪一行，未來除錯可秒查。

確認後 `apply_diff` 寫入目標 CSS 檔。

---

### 步驟 5：產出報告

```text
✅ Legacy CSS 反制完成！

📊 統計：
  選擇器：1 個
  Legacy 命中點：4 處
  本次反制：N 條（A/B/C 策略對應 1/4/2）
  保留 legacy：N 條（已標註於報告，未來改可參考）

📝 寫入位置：
  - {module}/page/foo.css（已 apply_diff）

⚠️ 建議下一步：
  - 跑 /design_diff --rwd 三斷點驗收
  - 或 /rwd_scan 確認手機/平板無 regression
```

---

## 輸出

- 目標 CSS 檔已寫入反制規則（apply_diff 完成）
- 每條反制規則含註解標示對應 legacy 行號
- 報告列出本次蓋掉的 / 保留的 legacy 規則對照

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| 反制後手機仍吃 legacy | legacy 用了更高 specificity（如 `body.foo .popup .btn-active`） | 用 `css_specificity_check` 比對，反制規則需匹配或更高 specificity |
| 蓋了 base 但 hover 失效 | legacy 在 `@media (hover: hover)` 內定義 hover 樣式 | 步驟 3 的 hover 行為需獨立反制 |
| 反制後桌機壞掉 | 反制規則寫在 @media 外，覆寫範圍超出預期 | 反制規則必須包在對應 @media 內 |

---

## 注意事項

- **只在「目標檔已存在 legacy override 場景」時觸發**：若是 greenfield 專案無 legacy CSS，本 skill 無用
- **不主動修改 legacy CSS**：只在頁面層加反制，legacy 檔保持唯讀（避免動到全站共用）
- **`!important` 是必要之惡**：legacy 用 `!important` → 反制必須也用 `!important`，但鼓勵在報告中提示「未來重構時改隔離命名空間」
- **與 Hook L2.10 `css_inspect_gate` 配合**：寫 `!important` 前 hook 會強制先跑 inspect 工具，本 skill 自動完成這一步
- **與 `/design_diff --rwd` 配合**：本 skill 寫完後建議跑 `/design_diff --rwd` 或 `/rwd_scan` 端到端驗收
- **不寫客戶實際模組名/路徑**：範例一律 `{module}` / `{ProjectFolder}` / `screen.prefixer.css` 等通用佔位符
