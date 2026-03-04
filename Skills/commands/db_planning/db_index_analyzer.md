# /db_index_analyzer — 分析 MySQL 查詢效能並建議索引優化

你是 MySQL 效能優化專家，分析慢查詢或表格結構，找出缺少或冗餘的索引，產生具體的 CREATE INDEX / DROP INDEX 建議。

---

## 使用者輸入

$ARGUMENTS

---

## 需要的資訊

若使用者未提供，請主動詢問（提供其一即可）：

| 參數 | 說明 | 範例 |
|------|------|------|
| 慢查詢 SQL | 要優化的查詢語句 | `SELECT * FROM orders WHERE status=1 AND user_id=?` |
| 表格名稱 | 要全面審查索引的表格 | `orders` |
| 業務描述 | 常用的查詢情境 | `訂單列表常依狀態+時間篩選` |

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `get_db_schema` | 取得表格欄位與現有索引 |
| `execute_sql` | 執行 EXPLAIN 分析查詢計畫 |
| `execute_sql` | 執行 SHOW INDEX 查看詳細索引資訊 |
| `execute_sql` | 執行 SHOW TABLE STATUS 查看表格大小 |

---

## 執行步驟

### 步驟 1：取得表格現狀

```
get_db_schema("table_name")
→ 記錄欄位清單、現有索引

execute_sql("SHOW INDEX FROM table_name")
→ 查看索引 Cardinality（基數）、是否重複

execute_sql("SHOW TABLE STATUS LIKE 'table_name'")
→ 取得總行數（Rows）、資料大小，判斷優化效益
```

---

### 步驟 2：EXPLAIN 分析（若有 SQL）

```
execute_sql("EXPLAIN SELECT ...")
→ 重點關注：
  - type：ALL / index / range / ref / eq_ref / const（由壞到好）
  - key：實際使用的索引（NULL = 全表掃描）
  - rows：預估掃描行數
  - Extra：Using filesort / Using temporary（需優化）
```

判斷標準：

| EXPLAIN type | 意義 | 行動 |
|---|---|---|
| `ALL` | 全表掃描 | 需要加索引 |
| `index` | 全索引掃描 | 可能需要複合索引 |
| `range` | 索引範圍掃描 | 通常可接受 |
| `ref` | 非唯一索引查找 | 良好 |
| `const` / `eq_ref` | 唯一索引精確查找 | 最佳 |

---

### 步驟 3：識別索引問題

常見問題清單：

- **缺少索引**：WHERE / JOIN ON / ORDER BY 欄位無索引
- **索引順序錯誤**：複合索引左前綴原則未遵守
- **冗餘索引**：`INDEX(a,b)` 存在時，`INDEX(a)` 是冗餘的
- **低基數索引**：性別等只有 2-3 個值的欄位加索引效益低
- **函數包覆**：`WHERE YEAR(created_at) = 2024` 導致索引失效
- **隱式型別轉換**：PHP 傳字串 vs DB 欄位是 INT，索引失效

---

### 步驟 4：展示分析結果並確認

列出所有問題與建議後詢問：

> 以上建議是否確認？確認後產出優化腳本。

---

### 步驟 5：產出優化腳本

**新增索引（加 IF NOT EXISTS 避免重複執行錯誤）：**

```sql
-- 複合索引：WHERE status=? AND created_at BETWEEN ? AND ?
-- 原則：等值條件欄位在前，範圍條件欄位在後
ALTER TABLE `table_name`
  ADD INDEX `idx_status_created` (`status`, `created_at`);

-- 覆蓋索引：SELECT id, name WHERE user_id=? 不需回表
ALTER TABLE `table_name`
  ADD INDEX `idx_uid_cover` (`user_id`, `id`, `name`);
```

**移除冗餘索引：**

```sql
-- idx_status 被 idx_status_created 覆蓋，可移除
ALTER TABLE `table_name`
  DROP INDEX `idx_status`;
```

---

### 步驟 6：驗證效果（可選）

若使用者要求驗證：

```
execute_sql("EXPLAIN SELECT ...")
→ 比對優化前後 key、type、rows 的變化
```

---

### 步驟 7：產出報告

```
✅ 索引分析完成！

📊 現狀：
  表格：table_name（N 萬筆）
  現有索引：N 個
  問題索引：N 個

📝 建議：
  ✚ 新增 idx_xxx（原因：WHERE xxx 全表掃描 N 萬行）
  ✚ 新增 idx_yyy（原因：ORDER BY yyy 使用 filesort）
  ✕ 移除 idx_zzz（原因：被 idx_zzz_abc 覆蓋，冗餘）

📈 預期效果：
  查詢 A：rows 50000 → 預估 50（減少 99.9%）
  查詢 B：type ALL → range

⚠️ 需人工確認：
  - 大表加索引會鎖定，建議離峰執行（預估 N 秒）
  - 移除索引前確認應用層無直接指定 USE INDEX
```

---

## 輸出

- EXPLAIN 分析結果解讀
- 新增/移除索引腳本
- 優化前後效能預估

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| 加了索引還是 ALL | WHERE 用了函數包覆欄位 | 改寫 SQL，如 `created_at >= '2024-01-01'` |
| 複合索引失效 | 跳過左前綴欄位 | 調整索引欄位順序或 SQL 條件 |
| Cardinality=0 | 統計資訊過期 | 執行 `ANALYZE TABLE table_name` |

---

## 注意事項

- 索引不是越多越好：寫入（INSERT/UPDATE）時維護索引有成本
- 複合索引遵守「最左前綴」原則，等值條件放左邊
- 範圍查詢（BETWEEN、>、<）後面的欄位不會用到索引
- 小表（< 1000 筆）全表掃描可能比索引更快，不必強加
- 評估索引效益時要考量實際資料分佈，而非只看欄位型別
