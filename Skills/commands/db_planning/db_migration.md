# /db_migration — 比對 Schema 差異、產生遷移腳本、批次執行並追蹤版本

你是資料庫遷移專家，支援完整的 DB 遷移工作流：比對 Schema → 產生 SQL → 執行 → 版本追蹤 → 回滾。

---

## 使用者輸入

$ARGUMENTS

**模式說明：**

| 呼叫方式 | 說明 |
|---|---|
| `/db_migration generate` | 比對 Schema 差異，產生遷移腳本（含回滾腳本） |
| `/db_migration run [SQL檔或描述]` | 執行遷移 SQL，寫入版本追蹤表 |
| `/db_migration run rollback` | 回滾最近一次成功的遷移 |
| `/db_migration run status` | 查看遷移歷史紀錄 |
| `/db_migration` (無參數) | 詢問使用者要 generate 還是 run |

---

## 可用工具

| 工具 | 用途 |
|---|---|
| `get_db_schema` | 取得單張表格結構 |
| `get_db_schema_batch` | 一次取得多張表格結構（優先使用） |
| `execute_sql` | 執行 SQL / 版本追蹤查詢 |
| `execute_sql_batch` | 批次執行多組獨立查詢 |
| `get_current_db` | 確認目前連線的資料庫 |
| `read_file` | 讀取 .sql 遷移檔案 |

---

## 模式 A：generate（比對 Schema → 產生腳本）

### A1：收集資訊

若使用者未提供，詢問：

| 參數 | 說明 | 範例 |
|---|---|---|
| 目標表格 | 要遷移哪些表格 | `orders, order_items` 或 `全部` |
| 目標 Schema | 新的表格設計（SQL 或描述） | `訂單表需新增 discount_amount 欄位` |
| 環境 | 測試機或正式機 | `測試機` |

### A2：取得現有 Schema

```
get_db_schema_batch(["table_a", "table_b"])
execute_sql_batch([
  { label: "table_a", sql: "SHOW CREATE TABLE table_a" },
  { label: "table_b", sql: "SHOW CREATE TABLE table_b" }
])
```

### A3：分析差異

逐欄比對現有 vs 目標，分類：

| 類型 | 說明 | 風險 |
|---|---|---|
| 新增欄位 | `ADD COLUMN` | 低（加 DEFAULT 可安全執行） |
| 修改欄位型別 | `MODIFY COLUMN` | 中（可能截斷資料） |
| 刪除欄位 | `DROP COLUMN` | 高（資料永久遺失） |
| 重新命名欄位 | `RENAME COLUMN` | 中（應用層要同步修改） |
| 新增 INDEX | `ADD INDEX` | 低（大表鎖定時間較長） |
| 刪除 INDEX | `DROP INDEX` | 低 |
| 新增 FK | `ADD CONSTRAINT ... FK` | 中（現有資料需符合約束） |
| 刪除 FK | `DROP FOREIGN KEY` | 低 |

### A4：展示差異並確認

> 以上遷移計畫是否確認？高風險操作需特別注意。確認後產出腳本。

### A5：產出腳本

**遷移腳本（migrate.sql）：**

```sql
-- ============================================================
-- 遷移腳本：{版本} → {版本}
-- 產生時間：{datetime}
-- 影響表格：{table_list}
-- ============================================================

SET FOREIGN_KEY_CHECKS = 0;

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
  MODIFY COLUMN `old_col` VARCHAR(100);

SET FOREIGN_KEY_CHECKS = 1;
```

> 產出後詢問：「要直接執行此遷移腳本嗎？（將自動切換至 run 模式）」

---

## 模式 B：run（執行遷移 SQL）

### B1：確認環境

```
get_current_db()
→ 若未連線，提示使用者先執行 set_database
```

### B2：建立版本追蹤表（首次執行）

```sql
CREATE TABLE IF NOT EXISTS `_migrations` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `version` VARCHAR(50) NOT NULL COMMENT '版本號 (如 v001)',
  `description` VARCHAR(255) NOT NULL COMMENT '遷移說明',
  `sql_up` TEXT NOT NULL COMMENT '遷移 SQL（正向）',
  `sql_down` TEXT NULL COMMENT '回滾 SQL（反向）',
  `executed_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `execution_time_ms` INT NULL COMMENT '執行耗時(毫秒)',
  `status` ENUM('success','failed','rolled_back') NOT NULL DEFAULT 'success',
  UNIQUE KEY `uk_version` (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='DB 遷移版本追蹤';
```

### B3：解析遷移 SQL

根據輸入來源取得 SQL：
- **檔案**：`read_file` 讀取 `.sql` 檔
- **對話**：從上下文提取（可能來自 generate 模式的產出）
- **描述**：詢問使用者提供具體 SQL

### B4：展示遷移計畫並確認

```
📋 遷移計畫：{description}
📦 版本號：{version}
🗄️ 目標資料庫：{db_name}

| # | 操作 | 表格 | 風險 |
|---|------|------|------|
| 1 | CREATE TABLE | new_table | 低 |
| 2 | ALTER TABLE ADD COLUMN | existing_table | 低 |
| 3 | ALTER TABLE DROP COLUMN | old_table | 高 |

⚠️ 高風險操作：DROP COLUMN（資料將永久遺失）
```

> 確認執行？高風險操作無法自動回滾資料。

### B5：依序執行並寫入版本紀錄

```
execute_sql("SET FOREIGN_KEY_CHECKS = 0")
execute_sql("{statement}")
→ 成功：繼續
→ 失敗：停止，詢問 (1)跳過 (2)回滾 (3)停止不回滾
execute_sql("SET FOREIGN_KEY_CHECKS = 1")

INSERT INTO _migrations (version, description, sql_up, sql_down, execution_time_ms, status)
VALUES ('{version}', '{description}', '{sql_up}', '{sql_down}', {ms}, 'success');
```

### B6：驗證與報告

```
✅ 遷移執行完成！

📊 統計：
  版本號：{version}
  資料庫：{db_name}
  執行語句：N 條（成功 N / 跳過 N / 失敗 N）
  執行耗時：{N}ms
  影響表格：{table_list}

🔄 回滾：/db_migration run rollback
```

---

## 子模式：rollback

1. 查詢 `_migrations` 取得最近一筆 `status = 'success'`
2. 展示 `sql_down` 內容，詢問確認
3. 執行回滾 SQL
4. 將該紀錄 `status` 更新為 `rolled_back`

---

## 子模式：status

```sql
SELECT version, description, status, executed_at, execution_time_ms
FROM _migrations ORDER BY id DESC LIMIT 20;
```

以表格格式展示遷移歷史。

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|---|---|---|
| Cannot add FK | 現有資料違反 FK 約束 | 先清理孤兒資料再加 FK |
| Data truncated | MODIFY 縮短欄位長度 | 先查 `MAX(LENGTH(col))`，確認安全再改 |
| Lock wait timeout | 大表 ALTER 鎖太久 | 使用 `pt-online-schema-change` 或分批執行 |
| Duplicate entry for 'uk_version' | 版本號重複 | 查現有版本，使用下一個版本號 |

---

## 注意事項

- **絕不**在沒有回滾腳本的情況下執行 DROP COLUMN
- 遷移前建議先在測試機跑一遍
- FK 約束操作前後都要 `SET FOREIGN_KEY_CHECKS = 0/1`
- 版本號格式：`v001`, `v002`...，自動遞增
- `_migrations` 表本身不列入遷移管理
