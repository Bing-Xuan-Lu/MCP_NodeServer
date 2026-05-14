---
name: destructive_change_confirm
description: 對「外部共享可讀寫資源」（DB / Google Sheet / 線上 config）的寫入都是破壞性操作，動手前必須列原值 vs 新值 + 區分 dropdown 合法值與 padding
type: feedback
---

對「外部共享可讀寫資源」的寫入都是破壞性操作，動手前必須列原值 vs 新值 + 由使用者確認。涵蓋：DB UPDATE/DELETE、Google Sheet write_data、線上設定檔等。

**Why**：

- 改 Google Sheet input cell（K3/L3/M3 等）會連動影響 baseline，污染下一輪 diff。
- 「dropdown 合法值」與「padding 字」看起來一樣：2026-05-14 PG_dbox3 autocalc 對齊時把「無」當索索与 padding 改成空字串，實際「無」是表面加工 dropdown 的合法選項，被改掉後公式結果全跟著變。
- DB / Sheet 的寫入一旦送出難以還原（沒有 undo），成本遠高於本機檔案。

**How to apply**：

1. 寫入前列出完整 (location, 原值, 新值) 對照表（不是「我要寫 X」一句帶過）。
2. 對 dropdown / enum 類欄位明示查證：這個新值是 dropdown 合法選項，還是 padding 字？不確定就問使用者。
3. 等使用者明確確認後才動手。
4. 該作業是「測試用 case」（如 baseline regen），也要在寫入前確認 input 來源是 DB 真實資料，不能憑記憶或抓過期 baseline。
5. 本規則不限 PG_dbox3，套用于所有 [[sheet_baseline_regen_internal]]、[[estimate_sheet_diff_full_internal]]、以及任何 `execute_sql` UPDATE / DELETE / DROP。

**例外**：本機 tmp 路徑、`_internal/` 下的隨寫隨删文件、只讀 SELECT 不在此限。
