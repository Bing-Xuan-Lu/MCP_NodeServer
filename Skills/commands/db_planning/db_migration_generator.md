# /db_migration_generator — 比對 Schema 差異並產生 MySQL 遷移腳本

你是資料庫遷移專家，比對現有 DB Schema 與目標 Schema 的差異，產生安全的 ALTER TABLE 遷移腳本（含回滾腳本），並標出資料遺失風險。

---

## 使用者輸入

$ARGUMENTS

---

## 需要的資訊

若使用者未提供，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| 目標表格 | 要遷移哪些表格 | `orders, order_items` 或 `全部` |
| 目標 Schema | 新的表格設計（SQL 或描述） | `訂單表需新增 discount_amount 欄位` |
| 環境 | 測試機或正式機 | `測試機` |

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `get_db_schema` | 取得單張表格結構 |
| `get_db_schema_batch` | 一次取得多張表格結構（多表遷移時優先使用） |
| `execute_sql` | 執行 SHOW CREATE TABLE / 遷移 SQL |
| `execute_sql_batch` | 一次取多張表的 SHOW CREATE TABLE |

---

## 執行步驟

### 步驟 1：取得現有 Schema

```
# 多表遷移時一次取回所有結構
get_db_schema_batch(["table_a", "table_b"])

# 同時取多張表的完整定義
execute_sql_batch([
  { label: "table_a", sql: "SHOW CREATE TABLE table_a" },
  { label: "table_b", sql: "SHOW CREATE TABLE table_b" }
])
```

---

### 步驟 2：分析差異

逐欄比對現有 vs 目標，分類：

| 類型 | 說明 | 風險 |
|------|------|------|
| 新增欄位 | `ADD COLUMN` | 低（加 DEFAULT 可安全執行） |
| 修改欄位型別 | `MODIFY COLUMN` | 中（可能截斷資料） |
| 刪除欄位 | `DROP COLUMN` | 高（資料永久遺失） |
| 重新命名欄位 | `RENAME COLUMN` | 中（應用層要同步修改） |
| 新增 INDEX | `ADD INDEX` | 低（大表鎖定時間較長） |
| 刪除 INDEX | `DROP INDEX` | 低 |
| 新增 FK | `ADD CONSTRAINT ... FK` | 中（現有資料需符合約束） |
| 刪除 FK | `DROP FOREIGN KEY` | 低 |

---

### 步驟 3：展示差異清單並確認

列出所有差異與風險評估後詢問：

> 以上遷移計畫是否確認？高風險操作需特別注意。確認後產出腳本。

---

### 步驟 4：產出遷移腳本

**遷移腳本（migrate.sql）：**

```sql
-- ============================================================
-- 遷移腳本：{版本} → {版本}
-- 產生時間：{datetime}
-- 影響表格：{table_list}
-- ============================================================

SET FOREIGN_KEY_CHECKS = 0;

-- [表格名稱]
ALTER TABLE `table_name`
  ADD COLUMN `new_col` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '說明' AFTER `existing_col`,
  MODIFY COLUMN `old_col` INT NOT NULL DEFAULT 0,
  ADD INDEX `idx_new_col` (`new_col`);

SET FOREIGN_KEY_CHECKS = 1;
```

**回滾腳本（rollback.sql）：**

```sql
-- ============================================================
-- 回滾腳本（還原至遷移前狀態）
-- ============================================================

SET FOREIGN_KEY_CHECKS = 0;

ALTER TABLE `table_name`
  DROP COLUMN `new_col`,
  MODIFY COLUMN `old_col` VARCHAR(100);  -- 還原原型別

SET FOREIGN_KEY_CHECKS = 1;
```

---

### 步驟 5：執行遷移（可選）

若使用者要求直接執行：

```
execute_sql("SET FOREIGN_KEY_CHECKS = 0; ...")
→ 成功 = 回報影響行數
→ 失敗 = 停止！展示錯誤並提供回滾指引
```

---

### 步驟 6：產出報告

```
✅ 遷移腳本產出完成！

📊 統計：
  影響表格：N 張
  新增欄位：N 個
  修改欄位：N 個
  刪除欄位：N 個（⚠️ 高風險）
  索引變更：N 個

📝 腳本：
  migrate.sql（N 行）
  rollback.sql（N 行）

⚠️ 需人工確認：
  - DROP COLUMN 操作前請確認應用層已無使用
  - 大表 ALTER 建議離峰時段執行（預估 N 秒）
  - 執行前請備份：mysqldump -u root -p db_name > backup.sql
```

---

## 輸出

- 遷移腳本 SQL（可直接執行）
- 回滾腳本 SQL（緊急還原用）
- 風險評估清單

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| Cannot add FK | 現有資料違反 FK 約束 | 先清理孤兒資料再加 FK |
| Data truncated | MODIFY 縮短欄位長度 | 先查 `MAX(LENGTH(col))`，確認安全再改 |
| Lock wait timeout | 大表 ALTER 鎖太久 | 使用 `pt-online-schema-change` 或分批執行 |

---

## 注意事項

- **絕不**在沒有回滾腳本的情況下執行 DROP COLUMN
- 遷移前建議先在測試機跑一遍
- FK 約束操作前後都要 `SET FOREIGN_KEY_CHECKS = 0/1`
- 回滾腳本的 MODIFY COLUMN 要還原「原本的型別」，不是目標型別
