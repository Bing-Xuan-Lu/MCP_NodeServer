# MCP Server Improvements Backlog

> 從各專案對話中收集的改進機會，回到 MCP 專案時用 `/retro backlog` 逐條消化。

---

- [x] [bug] execute_sql_batch 查詢結果不回傳 row data，只顯示「✅ 成功」 ← PG_dbox3 (2026-04-14) ✅ 已修：SELECT 改用 formatRows 輸出、DML 顯示影響列數 (2026-04-14)
- [x] [增強] execute_sql/execute_sql_batch DML 失敗時應回傳具體 MySQL error code + sqlState ← PG_dbox3 (2026-04-14) ✅ 已修：錯誤訊息加入 [ER_CODE] (SQLSTATE) (2026-04-14)
