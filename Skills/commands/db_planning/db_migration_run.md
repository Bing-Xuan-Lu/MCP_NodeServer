# /db_migration_run — 批次執行 DB 遷移腳本並追蹤版本

你是資料庫遷移執行專家，負責依序執行 ALTER TABLE / CREATE TABLE 等遷移 SQL，追蹤已執行的版本，並提供回滾能力。與 `/db_migration_generator`（產生 SQL）互補。

---

## 背景

`/db_migration_generator` 負責比對 Schema 差異並產出遷移 SQL，但缺少「批次執行 + 版本紀錄」機制。本 Skill 填補這個缺口：建立 migration 版本追蹤表、依序執行遷移、紀錄每次執行結果，並支援回滾。

---

## 使用者輸入

$ARGUMENTS

格式：`[SQL 檔案路徑或遷移描述]`

範例：
- `/db_migration_run migrate.sql` — 執行指定 SQL 檔案
- `/db_migration_run 新增訂單相關表格` — 描述遷移目標，從對話或檔案中找出 SQL
- `/db_migration_run rollback` — 回滾最近一次遷移
- `/db_migration_run status` — 查看已執行的遷移紀錄

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `execute_sql` | 執行遷移 SQL 與版本追蹤查詢 |
| `execute_sql_batch` | 批次執行多組獨立查詢（不因單條失敗中斷） |
| `get_db_schema` | 查看單張表結構 |
| `get_db_schema_batch` | 遷移後一次驗證多張表結構 |
| `get_current_db` | 確認目前連線的資料庫 |
| `read_file` | 讀取 SQL 遷移檔案 |

---

## 執行步驟

### 步驟 1：確認環境

1. 呼叫 `get_current_db()` 確認已連線資料庫
2. 若未連線，請使用者先執行 `set_database`
3. 確認遷移目標（SQL 檔案 / 對話中的 SQL / 描述）

---

### 步驟 2：建立版本追蹤表（首次執行）

檢查 `_migrations` 表是否存在，不存在則建立：

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

---

### 步驟 3：解析遷移 SQL

根據輸入來源取得 SQL：

- **檔案**：`read_file` 讀取 `.sql` 檔
- **對話**：從對話上下文中提取 SQL（可能來自 `/db_migration_generator` 的產出）
- **描述**：詢問使用者提供具體 SQL

將 SQL 拆解為獨立語句（以 `;` 分隔），識別：
- `CREATE TABLE` — 新建表
- `ALTER TABLE ... ADD` — 新增欄位/索引
- `ALTER TABLE ... MODIFY` — 修改欄位
- `ALTER TABLE ... DROP` — 刪除欄位（高風險）
- `DROP TABLE` — 刪除表（極高風險）

---

### 步驟 4：風險評估與確認

展示即將執行的遷移計畫：

```
📋 遷移計畫：{description}
📦 版本號：{version}
🗄️ 目標資料庫：{db_name}

| # | 操作 | 表格 | 風險 |
|---|------|------|------|
| 1 | CREATE TABLE | new_table | 低 |
| 2 | ALTER TABLE ADD COLUMN | existing_table | 低 |
| 3 | ALTER TABLE DROP COLUMN | old_table | 高 |

⚠️ 高風險操作：
  - DROP COLUMN `old_col` on `old_table`（資料將永久遺失）

回滾 SQL：
  [展示回滾腳本]
```

> 確認執行？高風險操作無法自動回滾資料。

---

### 步驟 5：依序執行遷移

逐條執行 SQL 語句，記錄結果：

```
execute_sql("SET FOREIGN_KEY_CHECKS = 0")
execute_sql("{statement_1}")
→ 成功：記錄並繼續
→ 失敗：立即停止，展示錯誤，詢問是否回滾已執行的部分
execute_sql("{statement_2}")
...
execute_sql("SET FOREIGN_KEY_CHECKS = 1")
```

**失敗處理**：
- 記錄失敗的語句和錯誤訊息
- 詢問使用者：(1) 跳過此語句繼續 (2) 回滾已執行部分 (3) 停止不回滾
- 最多重試 1 次（僅限 Lock wait timeout 等暫時性錯誤）

---

### 步驟 6：寫入版本紀錄

執行成功後，將遷移資訊寫入 `_migrations`：

```sql
INSERT INTO `_migrations` (version, description, sql_up, sql_down, execution_time_ms, status)
VALUES ('{version}', '{description}', '{sql_up}', '{sql_down}', {ms}, 'success');
```

---

### 步驟 7：驗證與報告

用 `get_db_schema_batch` 一次驗證所有受影響的表結構，產出報告：

```
✅ 遷移執行完成！

📊 統計：
  版本號：{version}
  資料庫：{db_name}
  執行語句：N 條（成功 N / 跳過 N / 失敗 N）
  執行耗時：{N}ms
  影響表格：{table_list}

📝 變更明細：
  - {table_1}：新增欄位 col_a, col_b
  - {table_2}：CREATE TABLE（新建）

🔄 回滾指令：
  /db_migration_run rollback
```

---

## 子模式：rollback

當使用者輸入 `/db_migration_run rollback` 時：

1. 查詢 `_migrations` 取得最近一筆 `status = 'success'` 的紀錄
2. 展示該版本的 `sql_down` 內容，詢問確認
3. 執行回滾 SQL
4. 將該紀錄的 `status` 更新為 `rolled_back`
5. 報告回滾結果

---

## 子模式：status

當使用者輸入 `/db_migration_run status` 時：

```sql
SELECT version, description, status, executed_at, execution_time_ms
FROM _migrations ORDER BY id DESC LIMIT 20;
```

以表格格式展示遷移歷史。

---

## 輸出

- 遷移版本紀錄寫入 `_migrations` 表
- Schema 變更已套用到目標資料庫
- 執行報告（含回滾指引）

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| Duplicate entry for key 'uk_version' | 版本號重複 | 查詢現有版本，使用下一個版本號 |
| Cannot add FK constraint | 現有資料違反約束 | 先清理孤兒資料 |
| Lock wait timeout | 大表 ALTER 鎖定 | 離峰時段執行，或用 pt-online-schema-change |
| Table already exists | CREATE TABLE 重複執行 | 加 IF NOT EXISTS 或檢查 _migrations 紀錄 |

---

## 注意事項

- 版本號格式：`v001`, `v002`...，自動遞增，從 `_migrations` 查最大值 +1
- 每次遷移必須有回滾 SQL（`sql_down`），若無法產生回滾（如 DROP 後資料已失），明確告知使用者
- `_migrations` 表本身不列入遷移管理（自動建立，不追蹤）
- 執行前一定先用 `get_db_schema` 確認現有結構，避免重複 ALTER
- 與 `/db_migration_generator` 搭配使用：先用 generator 產出 SQL，再用本 Skill 執行
