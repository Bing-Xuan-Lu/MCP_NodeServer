---
name: form_fullfield_roundtrip_test
description: |
  大表單「全欄位 sentinel 注入 → submit → DB 驗證 → 回填驗證 → 清理」自動測試。涵蓋：主表 + 多個子表的每個欄位都填可辨識的哨兵值，驗證 insert 後 DB 寫入完整、edit 頁回填無遺漏，專抓「資料遺失」「首列丟失」「預設項目沒存」類 bug。
  當使用者說「驗整張表」「全欄位測試」「測表單有沒有漏存」「roundtrip 測試」，或遇到大表單（50+ 欄位、含子表 repeater）需驗證資料完整性時使用。
---

# /form_fullfield_roundtrip_test — 大表單全欄位 roundtrip 測試

你是表單完整性測試工程師。目標不是測功能能不能跑，而是**抓資料遺失**——特別是子表 repeater 首列丟失、預設項目未寫入 DB、欄位 name 對不上等 bug。

---

## 使用者輸入

$ARGUMENTS

---

## 需要的資訊

| 參數 | 說明 | 範例 |
| --- | --- | --- |
| 模組 | 要測試的模組路徑 | `{ProjectFolder}/{PhpFolder}/adminControl/{module}` |
| 新增頁 URL | 表單提交目標 | `http://localhost/{module}/insert.php` |
| 編輯頁 URL | 驗證回填的頁面 | `http://localhost/{module}/update.php?id={id}` |
| 主表 | 資料寫入的主資料表名稱 | `tbl_{module}` |
| 子表清單 | 所有 repeater 對應的子表名稱 | `tbl_{module}_item, tbl_{module}_fee` |

---

## 核心原則

### 哨兵值設計（Sentinel Injection）

每個欄位注入**可追蹤**的測試值，確保可以從 DB 反查回來。

| 欄位類型 | Sentinel 模板 | 範例 |
| --- | --- | --- |
| text / textarea | `T_{field_name}` | `T_project_title`, `T_memo` |
| number / money | `123`（或欄位順序 `100 + idx`） | `123`, `101`, `102` |
| date | `2026-04-20`（固定易辨） | `2026-04-20` |
| select / radio | 第一個非空 option | （從 DOM 取） |
| checkbox | 全勾 | `checked` |
| file | sentinel.txt（1 byte） | 上傳空檔 |

**哨兵可反查**：所有寫入的 row 都能用 `WHERE col LIKE 'T_%' OR col = 123` 找回來，方便清理。

### 子表 repeater 特別處理

子表最常發生「首列丟失」「預設項目沒存」bug。必須：
1. **至少填 2 列**（首列 + 新增列各一），驗證兩列都要進 DB
2. 若有「預設項目」（載入頁時已有 N 筆），必須驗證這 N 筆全部寫入，不只新增的
3. 每列每欄都填 sentinel，不留空

---

## 執行步驟

### 步驟 1：環境確認

1. 讀取模組 `insert.php` / `update.php` / `ajax/addOrder.php`（依專案命名），用 `symbol_index` / `class_method_lookup` 找欄位定義
2. `get_db_schema_batch` 取主表 + 所有子表結構
3. 比對表單欄位 ↔ DB 欄位，若有落差 **先停下來問使用者**（不要猜）

### 步驟 2：Playwright 填表

1. `browser_navigate` 到新增頁
2. `browser_snapshot` 取得完整 form 結構
3. 逐欄注入 sentinel（用 `browser_interact` 或 `browser_fill_form`）
4. 子表 repeater：
   - 找出已有列（預設項目）→ 全填 sentinel
   - 點「新增列」→ 再填一列 sentinel
5. 提交 → 記錄 redirect 後的 `id`

### 步驟 3：DB 驗證（最關鍵）

用 `execute_sql_batch` 一次查主表 + 所有子表：

```sql
-- 主表
SELECT * FROM tbl_{module} WHERE id = {new_id};
-- 每個子表
SELECT * FROM tbl_{module}_item WHERE {module}_id = {new_id};
SELECT * FROM tbl_{module}_fee WHERE {module}_id = {new_id};
```

**逐欄檢查**：
- 主表：每個 sentinel 欄位都要等於注入值
- 子表：筆數必須 = 頁面實際填的列數（預設項目 N + 新增 M = N+M 筆）
- 若子表筆數對不上 → **標記「資料遺失」bug，不是測試失敗**

### 步驟 4：回填驗證

1. `browser_navigate` 到 edit 頁 `update.php?id={new_id}`
2. `browser_snapshot` 抓回填值
3. 逐欄比對「注入值 ↔ 回填值」，任何不一致都是 bug

### 步驟 5：清理

```sql
DELETE FROM tbl_{module}_item WHERE {module}_id = {new_id};
DELETE FROM tbl_{module}_fee WHERE {module}_id = {new_id};
DELETE FROM tbl_{module} WHERE id = {new_id};
```

清理必須用明確 `id`，**不要**用 `WHERE col LIKE 'T_%'`（會誤刪正式資料）。

---

## 校稿單格式

```
📋 Roundtrip Test Report — {module}
━━━━━━━━━━━━━━━━━━━━━━━━━━━

測試 ID：{new_id}
欄位總數：{main_fields} 主表 + {sub_fields} 子表欄位
填寫列數：{rows_per_subtable}

✅ 通過項目：{count}
⚠️ 資料遺失：{count}
  - {subtable}.{field}：頁面填 {rows} 列，DB 寫入 {actual} 列
  - {field}：預設值未寫入 DB
❌ 回填錯誤：{count}
  - {field}：注入 "{A}"，回填 "{B}"

清理結果：✅ 已刪除 {n} 筆
```

---

## 不做什麼

- ❌ 不測功能流程（登入/權限/商業邏輯）→ 用 `/verify` 或 `/php_crud_test`
- ❌ 不測 UI/UX → 用 `/frontend_qc` 或 `/rwd_scan`
- ❌ 不測效能 → 用 `/web_performance`
- ❌ 不在正式環境跑 → sentinel 值會留痕，只在 dev/staging

---

## 可用工具

- Playwright：`browser_navigate`, `browser_snapshot`, `browser_fill_form`, `browser_interact`
- DB：`get_db_schema_batch`, `execute_sql_batch`（一次查多表）
- 程式碼：`symbol_index`, `class_method_lookup`, `read_file`
- PHP 除錯：`run_php_code`（快速查欄位對應邏輯）、`tail_log`
